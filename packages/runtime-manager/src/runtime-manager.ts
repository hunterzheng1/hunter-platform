import type { DatabaseSync } from "node:sqlite";

import type { AgentProfileId, AtomicCapability, AttemptId, ProjectId, RepositoryId, RunId, WorkspaceId } from "@hunter/domain";
import type { FlowCommandHandler, FlowCommandReceipt } from "@hunter/flow-engine";
import {
  ExternalOperationSchema,
  LeaseSchema,
  decodeCapabilityProbeReceipt,
  fingerprintExternalOperation,
  type CapabilityProbeReceipt,
  type ExternalOperation,
  type Lease,
} from "@hunter/runtime-contracts";

export interface AssignmentRequest {
  readonly commandId: string;
  readonly expectedVersion: number;
  readonly operation: ExternalOperation;
}

export interface RuntimeAssignmentAuthority {
  resolve(operation: ExternalOperation): {
    readonly policyDecision: "allow" | "deny" | "require_approval";
    readonly capabilityReceipt: CapabilityProbeReceipt;
    readonly requiredLeaseIds: readonly Lease["leaseId"][];
    readonly now: Date;
    readonly expected: {
      readonly projectId: ProjectId;
      readonly runId: RunId;
      readonly attemptId: AttemptId;
      readonly operationType: ExternalOperation["operationType"];
      readonly requestedCapabilities: readonly AtomicCapability[];
      readonly agentProfileId?: AgentProfileId | undefined;
      readonly workspaceId?: WorkspaceId | undefined;
      readonly repositoryIds: readonly RepositoryId[];
    };
  };
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
    private readonly authority: RuntimeAssignmentAuthority,
  ) {}

  public requestAssignment(input: AssignmentRequest): FlowCommandReceipt {
    const operation = ExternalOperationSchema.parse(input.operation);
    if (fingerprintExternalOperation(operation) !== operation.fingerprint) {
      throw new Error("OPERATION_FINGERPRINT_MISMATCH");
    }
    const authority = this.authority.resolve(operation);
    const expected = authority.expected;
    const canonicalCapabilities = (items: readonly string[]) => [...items].sort().join("\u0000");
    if (
      operation.projectId !== expected.projectId ||
      operation.runId !== expected.runId ||
      operation.attemptId !== expected.attemptId ||
      operation.operationType !== expected.operationType ||
      canonicalCapabilities(operation.requestedCapabilities) !== canonicalCapabilities(expected.requestedCapabilities)
    ) throw new Error("ASSIGNMENT_AUTHORITY_SCOPE_MISMATCH");
    if (operation.operationType === "session.launch") {
      if (expected.agentProfileId === undefined || operation.payload.agentProfileId !== expected.agentProfileId) throw new Error("ASSIGNMENT_AGENT_PROFILE_MISMATCH");
      if (expected.workspaceId !== undefined && operation.payload.workspaceId !== expected.workspaceId) throw new Error("ASSIGNMENT_WORKSPACE_MISMATCH");
    }
    if (authority.policyDecision !== "allow") throw new Error("POLICY_NOT_ALLOWED");
    const probe = decodeCapabilityProbeReceipt(authority.capabilityReceipt);
    const at = authority.now.getTime();
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
    for (const leaseId of authority.requiredLeaseIds) {
      const row = this.database.prepare(
        "SELECT lease_kind, expires_at, owner_id, receipt_json FROM lease_records WHERE lease_id = ?",
      ).get(leaseId) as unknown as LeaseRow | undefined;
      if (row === undefined || Date.parse(row.expires_at) <= at) throw new Error("LEASE_RECEIPT_REQUIRED");
      leaseKinds.add(row.lease_kind);
      const lease = LeaseSchema.parse(JSON.parse(row.receipt_json));
      if (lease.revokedAt !== null) throw new Error("LEASE_RECEIPT_REQUIRED");
      leases.push(lease);
    }
    if (operation.operationType === "session.launch") {
      if (!["workspace", "writer"].every((kind) => leaseKinds.has(kind))) {
        throw new Error("LEASE_RECEIPT_REQUIRED");
      }
      const workspaceId = operation.payload.workspaceId;
      if (leases.some((lease) => (lease.kind === "workspace" || lease.kind === "writer") && lease.scope.workspaceId !== workspaceId)) throw new Error("LEASE_SCOPE_MISMATCH");
      if (new Set(leases.map(({ ownerId }) => ownerId)).size !== 1) throw new Error("LEASE_OWNER_MISMATCH");
      const workspaceLease = leases.find((lease) => lease.kind === "workspace");
      if (workspaceLease === undefined || !expected.repositoryIds.includes(workspaceLease.repositoryId)) throw new Error("LEASE_REPOSITORY_SCOPE_MISMATCH");
    }
    if (operation.operationType === "session.observe" || operation.operationType === "session.send" || operation.operationType === "session.interrupt") {
      if (operation.operationVersion !== 2) throw new Error("CONTROLLER_LEASE_AUTHORITY_VERSION_REQUIRED");
      const controller = leases.find((lease) => lease.kind === "controller");
      if (
        controller === undefined ||
        controller.scope.nativeSessionId !== operation.payload.nativeSessionId ||
        controller.leaseId !== operation.payload.controllerLeaseId ||
        controller.ownerId !== operation.payload.controllerLeaseOwnerId ||
        controller.generation !== operation.payload.controllerLeaseGeneration
      ) throw new Error("CONTROLLER_LEASE_SCOPE_MISMATCH");
    }
    if (operation.runId === null || operation.attemptId === null) throw new Error("ASSIGNMENT_RUN_SCOPE_REQUIRED");
    return this.flowEngine.handle({
      type: "AssignAttempt",
      runId: operation.runId,
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.commandId,
      operation,
      capabilityProbeReceiptId: probe.probeReceiptId,
      leaseIds: [...authority.requiredLeaseIds],
      actor: { actorId: "runtime-manager", correlationId: input.commandId },
    });
  }
}
