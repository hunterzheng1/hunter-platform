import type { DatabaseSync } from "node:sqlite";

import { canonicalSha256 } from "@hunter/domain";
import {
  CapabilityProbeReceiptSchema,
  ExternalOperationSchema,
  fingerprintExternalOperation,
  type CapabilityProbeReceipt,
  type ExternalOperation,
  type Lease,
} from "@hunter/runtime-contracts";
import type { CommandReceipt, SqliteOperationJournal } from "@hunter/storage";

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
}

export class RuntimeManager {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly journal: SqliteOperationJournal,
  ) {}

  public requestAssignment(input: AssignmentRequest): CommandReceipt {
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
    for (const leaseId of input.requiredLeaseIds) {
      const row = this.database.prepare(
        "SELECT lease_kind, expires_at FROM lease_records WHERE lease_id = ?",
      ).get(leaseId) as unknown as LeaseRow | undefined;
      if (row === undefined || Date.parse(row.expires_at) <= at) throw new Error("LEASE_RECEIPT_REQUIRED");
      leaseKinds.add(row.lease_kind);
    }
    if (operation.operationType === "session.launch") {
      if (!["workspace", "writer", "controller"].every((kind) => leaseKinds.has(kind))) {
        throw new Error("LEASE_RECEIPT_REQUIRED");
      }
    }
    const requestFingerprint = canonicalSha256({
      commandId: input.commandId,
      expectedVersion: input.expectedVersion,
      operation,
      policyDecision: input.policyDecision,
      capabilityProbeReceiptId: probe.probeReceiptId,
      requiredLeaseIds: [...input.requiredLeaseIds].sort(),
    });
    return this.journal.commitCommand({
      commandId: input.commandId,
      requestFingerprint,
      projectId: operation.projectId,
      aggregateId: `attempt:${operation.attemptId ?? operation.operationId}`,
      expectedVersion: input.expectedVersion,
      actor: { actorId: "runtime-manager", correlationId: input.commandId },
      events: [{
        eventId: `evt_assignment:${operation.operationId}`,
        eventType: "AttemptAssigned",
        eventData: {
          operationId: operation.operationId,
          capabilityProbeReceiptId: probe.probeReceiptId,
          leaseIds: [...input.requiredLeaseIds],
        },
        schemaVersion: 1,
        occurredAt: input.now.toISOString(),
      }],
      operations: [operation],
      response: { operationId: operation.operationId, status: "scheduled" },
    });
  }
}
