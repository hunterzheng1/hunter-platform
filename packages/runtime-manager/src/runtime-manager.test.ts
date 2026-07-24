import { DatabaseSync } from "node:sqlite";

import {
  AgentProfileIdSchema,
  AttemptIdSchema,
  CapabilityProbeReceiptIdSchema,
  ControllerLeaseIdSchema,
  DeviceBindingIdSchema,
  EvidenceIdSchema,
  LeaseOwnerIdSchema,
  NativeSessionIdSchema,
  OperationIdSchema,
  ProjectIdSchema,
  RepositoryIdSchema,
  RunIdSchema,
  RuntimeProviderIdSchema,
  WorkspaceIdSchema,
  WorkspaceLeaseIdSchema,
  WorktreeIdSchema,
  WriterLeaseIdSchema,
  canonicalSha256,
} from "@hunter/domain";
import { CanonicalWorkspaceKeySchema, CapabilityProbeReceiptSchema, ControllerLeaseSchema, WorkspaceLeaseSchema, WriterLeaseSchema, createExternalOperation, type Lease } from "@hunter/runtime-contracts";
import { SqliteOperationJournal, OperationWorker } from "@hunter/storage";
import { FakeRuntime } from "@hunter/testkit";
import { describe, expect, it } from "vitest";

import { LeaseService } from "./lease-service.js";
import { RuntimeManager } from "./runtime-manager.js";

const now = "2026-07-22T10:01:00.000Z";
const owner = LeaseOwnerIdSchema.parse("own_runtime001");
const projectId = ProjectIdSchema.parse("prj_runtime001");
const runId = RunIdSchema.parse("run_runtime001");
const attemptId = AttemptIdSchema.parse("att_runtime001");
const workspaceId = WorkspaceIdSchema.parse("wsp_runtime001");
const repositoryId = RepositoryIdSchema.parse("rep_runtime001");
const worktreeId = WorktreeIdSchema.parse("wtr_runtime001");

function manager(database: DatabaseSync, journal: SqliteOperationJournal, options: { readonly leaseIds?: readonly Lease["leaseId"][]; readonly capabilityReceipt?: ReturnType<typeof capability>; readonly policyDecision?: "allow" | "deny" | "require_approval" } = {}) {
  return new RuntimeManager(database, {
    handle: (command) => {
      if (command.type !== "AssignAttempt") throw new Error("UNEXPECTED_FLOW_COMMAND");
      const commandId = `${command.type}:${command.idempotencyKey}`;
      const receipt = journal.commitCommand({
        commandId,
        requestFingerprint: canonicalSha256(command),
        projectId: command.operation.projectId,
        aggregateId: `run:${command.runId}`,
        expectedVersion: command.expectedVersion,
        actor: command.actor,
        events: [],
        operations: [command.operation],
        response: { commandId, response: { operationId: command.operation.operationId, status: "scheduled" } },
      });
      return receipt.response as { commandId: string; response: unknown };
    },
  }, { resolve: () => ({
    policyDecision: options.policyDecision ?? "allow",
    capabilityReceipt: options.capabilityReceipt ?? capability(),
    requiredLeaseIds: options.leaseIds ?? [],
    now: new Date(now),
    expected: {
      projectId,
      runId,
      attemptId,
      operationType: "session.launch" as const,
      requestedCapabilities: ["launch"] as const,
      agentProfileId: AgentProfileIdSchema.parse("apr_runtime001"),
      workspaceId,
      repositoryIds: [repositoryId],
    },
  }) });
}

function capability() {
  return CapabilityProbeReceiptSchema.parse({
    schemaVersion: 2,
    probeReceiptId: CapabilityProbeReceiptIdSchema.parse("cpr_runtime001"),
    subject: { kind: "provider", providerId: RuntimeProviderIdSchema.parse("rtp_runtime001"), implementationVersion: "1.0.0" },
    platform: "windows",
    executable: { status: "available" },
    loginState: "not_required",
    productVersion: { observed: "fake-1", supported: ["fake-1"] },
    protocol: { kind: "fake", observedVersion: "1", supportedVersions: ["1"], schemaVersion: 1, supportedSchemaVersions: [1], schemaDigest: "b".repeat(64) },
    probedAt: "2026-07-22T09:00:00.000Z",
    validUntil: "2026-07-22T11:00:00.000Z",
    results: [{ capability: "launch", status: "supported", evidenceId: EvidenceIdSchema.parse("evd_runtime001"), evidence: { source: "local_probe", digest: "a".repeat(64) }, probedAt: "2026-07-22T09:00:00.000Z" }],
  });
}

async function harness() {
  const database = new DatabaseSync(":memory:");
  const journal = new SqliteOperationJournal(database);
  const leases = new LeaseService(database, () => new Date(now));
  const common = {
    schemaVersion: 2 as const,
    projectId,
    repositoryId,
    deviceBindingId: DeviceBindingIdSchema.parse("dev_runtime001"),
    canonicalWorkspaceKey: CanonicalWorkspaceKeySchema.parse("posix:/fixtures/runtime"),
    gitHead: "a".repeat(40),
    branch: "codex/task14-runtime-manager",
    ownerRunId: runId,
    ownerAttemptId: attemptId,
    ownerId: owner,
    generation: 1,
    mode: "write" as const,
    acquiredAt: "2026-07-22T10:00:00.000Z",
    expiresAt: "2026-07-22T10:30:00.000Z",
    revokedAt: null,
    revocationReason: null,
  };
  const workspace = await leases.acquire(WorkspaceLeaseSchema.parse({ ...common, kind: "workspace", leaseId: WorkspaceLeaseIdSchema.parse("wsl_runtime001"), scope: { workspaceId } }));
  const writer = await leases.acquire(WriterLeaseSchema.parse({ ...common, kind: "writer", leaseId: WriterLeaseIdSchema.parse("wrl_runtime001"), scope: { workspaceId, worktreeId } }));
  const controller = await leases.acquire(ControllerLeaseSchema.parse({ ...common, kind: "controller", leaseId: ControllerLeaseIdSchema.parse("ctl_runtime001"), scope: { workspaceId, worktreeId, nativeSessionId: NativeSessionIdSchema.parse("ses_runtime001") } }));
  const operation = createExternalOperation({ schemaVersion: 1, operationId: OperationIdSchema.parse("opn_runtime001"), projectId, runId, attemptId, operationVersion: 1, operationType: "session.launch", requestedCapabilities: ["launch"], payload: { agentProfileId: AgentProfileIdSchema.parse("apr_runtime001"), workspaceId } });
  return { database, journal, operation, leaseIds: [workspace.leaseId, writer.leaseId, controller.leaseId] as const };
}

describe("RuntimeManager", () => {
  it("persists assignment authority and survives manager restart", async () => {
    const { database, journal, operation, leaseIds } = await harness();
    const input = { commandId: "assign:1", expectedVersion: 0, operation };
    const first = manager(database, journal, { leaseIds }).requestAssignment(input);
    expect(manager(database, journal, { leaseIds }).requestAssignment(input)).toEqual(first);
    const fake = new FakeRuntime({ providerId: RuntimeProviderIdSchema.parse("rtp_runtime001"), implementationVersion: "fake", observedAt: now });
    expect(await new OperationWorker(database, fake, { ownerId: "worker-1", replayPolicy: () => "replay_safe" }).runOnce()).toBe("completed");
    expect(fake.nativeEffectCount).toBe(1);
    database.close();
  });

  it.each(["deny", "require_approval"] as const)("creates no launch operation for %s", async (policyDecision) => {
    const { database, journal, operation, leaseIds } = await harness();
    expect(() => manager(database, journal, { policyDecision, leaseIds }).requestAssignment({ commandId: `assign:${policyDecision}`, expectedVersion: 0, operation })).toThrow(/POLICY_NOT_ALLOWED/u);
    expect((database.prepare("SELECT COUNT(*) AS count FROM outbox").get() as { count: number }).count).toBe(0);
    database.close();
  });

  it("fails closed for missing capability or durable Lease receipts", async () => {
    const { database, journal, operation } = await harness();
    const receipt = capability();
    const unsupported = CapabilityProbeReceiptSchema.parse({
      ...receipt,
      results: receipt.results.map((result) => ({ ...result, status: "unknown" as const })),
    });
    expect(() => manager(database, journal, { capabilityReceipt: unsupported }).requestAssignment({ commandId: "assign:no-cap", expectedVersion: 0, operation })).toThrow(/CAPABILITY_NOT_PROVEN/u);
    expect(() => manager(database, journal, { capabilityReceipt: receipt }).requestAssignment({ commandId: "assign:no-lease", expectedVersion: 0, operation })).toThrow(/LEASE_RECEIPT_REQUIRED/u);
    database.close();
  });

  it("rejects caller-authored capability, profile, and workspace drift from server authority", async () => {
    const { database, journal, operation, leaseIds } = await harness();
    const changed = (overrides: Record<string, unknown>) => createExternalOperation({
      schemaVersion: 1,
      operationId: operation.operationId,
      projectId,
      runId,
      attemptId,
      operationVersion: 1,
      operationType: "session.launch",
      requestedCapabilities: ["launch"],
      payload: operation.payload,
      ...overrides,
    });
    expect(() => manager(database, journal, { leaseIds }).requestAssignment({ commandId: "assign:cap-drift", expectedVersion: 0, operation: changed({ requestedCapabilities: ["launch", "observe"] }) })).toThrow(/ASSIGNMENT_AUTHORITY_SCOPE_MISMATCH/u);
    expect(() => manager(database, journal, { leaseIds }).requestAssignment({ commandId: "assign:profile-drift", expectedVersion: 0, operation: changed({ payload: { ...operation.payload, agentProfileId: "apr_runtime002" } }) })).toThrow(/ASSIGNMENT_AGENT_PROFILE_MISMATCH/u);
    expect(() => manager(database, journal, { leaseIds }).requestAssignment({ commandId: "assign:workspace-drift", expectedVersion: 0, operation: changed({ payload: { ...operation.payload, workspaceId: "wsp_runtime002" } }) })).toThrow(/ASSIGNMENT_WORKSPACE_MISMATCH/u);
    database.close();
  });
});
