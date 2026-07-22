import type { DatabaseSync } from "node:sqlite";

import type { FlowCommandHandler, FlowCommandReceipt } from "@hunter/flow-engine";
import {
  CapabilityProbeReceiptSchema,
  ExternalOperationSchema,
  fingerprintExternalOperation,
  type CapabilityProbeReceipt,
  type ExternalOperation,
  type Lease,
} from "@hunter/runtime-contracts";

export interface AssignmentRequest {
  readonly commandId: string;
  readonly expectedVersion: number;
  readonly operation: ExternalOperation;
  readonly policyDecision: "allow" | "deny" | "require_approval";
  readonly capabilityReceipt: CapabilityProbeReceipt;
  readonly requiredLeaseIds: readonly Lease["leaseId"][];
  readonly now: Date;
}

interface LeaseRow {
  readonly lease_kind: "workspace" | "writer" | "controller";
  readonly expires_at: string;
  readonly owner_id: string;
  readonly receipt_json: string;
}

export class RuntimeManager {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly flowEngine: FlowCommandHandler,
  ) {}

  public requestAssignment(input: AssignmentRequest): FlowCommandReceipt {
    if (input.policyDecision !== "allow") throw new Error("POLICY_NOT_ALLOWED");
    const operation = ExternalOperationSchema.parse(input.operation);
    if (fingerprintExternalOperation(operation) !== operation.fingerprint) {
      throw new Error("OPERATION_FINGERPRINT_MISMATCH");
    }
    const probe = CapabilityProbeReceiptSchema.parse(input.capabilityReceipt);
    const at = input.now.getTime();
    if (at < Date.parse(probe.observedAt) || at > Date.parse(probe.validUntil)) {
      throw new Error("CAPABILITY_RECEIPT_EXPIRED");
    }
    const supported = new Set(
      probe.results.filter(({ status }) => status === "SUPPORTED").map(({ capability }) => capability),
    );
    if (operation.requestedCapabilities.some((capability) => !supported.has(capability))) {
      throw new Error("CAPABILITY_NOT_PROVEN");
    }
    const leaseKinds = new Set<string>();
    const leases: Lease[] = [];
    for (const leaseId of input.requiredLeaseIds) {
      const row = this.database.prepare(
        "SELECT lease_kind, expires_at, owner_id, receipt_json FROM lease_records WHERE lease_id = ?",
      ).get(leaseId) as unknown as LeaseRow | undefined;
      if (row === undefined || Date.parse(row.expires_at) <= at) throw new Error("LEASE_RECEIPT_REQUIRED");
      leaseKinds.add(row.lease_kind);
      leases.push(JSON.parse(row.receipt_json) as Lease);
    }
    if (operation.operationType === "session.launch") {
      if (!["workspace", "writer", "controller"].every((kind) => leaseKinds.has(kind))) {
        throw new Error("LEASE_RECEIPT_REQUIRED");
      }
      const workspaceId = operation.payload.workspaceId;
      if (leases.some((lease) => (lease.kind === "workspace" || lease.kind === "writer") && lease.scope.workspaceId !== workspaceId)) throw new Error("LEASE_SCOPE_MISMATCH");
      if (new Set(leases.map(({ ownerId }) => ownerId)).size !== 1) throw new Error("LEASE_OWNER_MISMATCH");
    }
    if (operation.runId === null || operation.attemptId === null) throw new Error("ASSIGNMENT_RUN_SCOPE_REQUIRED");
    return this.flowEngine.handle({
      type: "AssignAttempt",
      runId: operation.runId,
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.commandId,
      operation,
      capabilityProbeReceiptId: probe.probeReceiptId,
      leaseIds: [...input.requiredLeaseIds],
      actor: { actorId: "runtime-manager", correlationId: input.commandId },
    });
  }
}
