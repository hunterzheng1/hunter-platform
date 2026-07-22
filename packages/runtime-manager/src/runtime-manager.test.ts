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
import { CapabilityProbeReceiptSchema, ControllerLeaseSchema, WorkspaceLeaseSchema, WriterLeaseSchema, createExternalOperation } from "@hunter/runtime-contracts";
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

function manager(database: DatabaseSync, journal: SqliteOperationJournal) {
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
  });
}

function capability() {
  return CapabilityProbeReceiptSchema.parse({
    schemaVersion: 1,
    probeReceiptId: CapabilityProbeReceiptIdSchema.parse("cpr_runtime001"),
    subject: { kind: "provider", providerId: RuntimeProviderIdSchema.parse("rtp_runtime001"), implementationVersion: "1.0.0" },
    platform: "windows",
    observedAt: "2026-07-22T09:00:00.000Z",
    validUntil: "2026-07-22T11:00:00.000Z",
    results: [{ capability: "launch", status: "SUPPORTED", evidenceId: EvidenceIdSchema.parse("evd_runtime001"), evidenceHash: "a".repeat(64) }],
  });
}

async function harness() {
  const database = new DatabaseSync(":memory:");
  const journal = new SqliteOperationJournal(database);
  const leases = new LeaseService(database, () => new Date(now));
  const common = { schemaVersion: 1 as const, ownerId: owner, generation: 1, acquiredAt: "2026-07-22T10:00:00.000Z", expiresAt: "2026-07-22T10:30:00.000Z" };
  const workspace = await leases.acquire(WorkspaceLeaseSchema.parse({ ...common, kind: "workspace", leaseId: WorkspaceLeaseIdSchema.parse("wsl_runtime001"), scope: { workspaceId, deviceBindingId: DeviceBindingIdSchema.parse("dev_runtime001"), repositoryId: RepositoryIdSchema.parse("rep_runtime001"), mode: "write", baselineRevision: "a".repeat(40) } }));
  const writer = await leases.acquire(WriterLeaseSchema.parse({ ...common, kind: "writer", leaseId: WriterLeaseIdSchema.parse("wrl_runtime001"), scope: { workspaceId, worktreeId: WorktreeIdSchema.parse("wtr_runtime001") } }));
  const controller = await leases.acquire(ControllerLeaseSchema.parse({ ...common, kind: "controller", leaseId: ControllerLeaseIdSchema.parse("ctl_runtime001"), scope: { nativeSessionId: NativeSessionIdSchema.parse("ses_runtime001") } }));
  const operation = createExternalOperation({ schemaVersion: 1, operationId: OperationIdSchema.parse("opn_runtime001"), projectId, runId, attemptId, operationVersion: 1, operationType: "session.launch", requestedCapabilities: ["launch"], payload: { agentProfileId: AgentProfileIdSchema.parse("apr_runtime001"), workspaceId } });
  return { database, journal, operation, leaseIds: [workspace.leaseId, writer.leaseId, controller.leaseId] as const };
}

describe("RuntimeManager", () => {
  it("persists assignment authority and survives manager restart", async () => {
    const { database, journal, operation, leaseIds } = await harness();
    const input = { commandId: "assign:1", expectedVersion: 0, operation, policyDecision: "allow" as const, capabilityReceipt: capability(), requiredLeaseIds: leaseIds, now: new Date(now) };
    const first = manager(database, journal).requestAssignment(input);
    expect(manager(database, journal).requestAssignment(input)).toEqual(first);
    const fake = new FakeRuntime({ providerId: RuntimeProviderIdSchema.parse("rtp_runtime001"), implementationVersion: "fake", observedAt: now });
    expect(await new OperationWorker(database, fake, { ownerId: "worker-1", replayPolicy: () => "replay_safe" }).runOnce()).toBe("completed");
    expect(fake.nativeEffectCount).toBe(1);
    database.close();
  });

  it.each(["deny", "require_approval"] as const)("creates no launch operation for %s", async (policyDecision) => {
    const { database, journal, operation, leaseIds } = await harness();
    expect(() => manager(database, journal).requestAssignment({ commandId: `assign:${policyDecision}`, expectedVersion: 0, operation, policyDecision, capabilityReceipt: capability(), requiredLeaseIds: leaseIds, now: new Date(now) })).toThrow(/POLICY_NOT_ALLOWED/u);
    expect((database.prepare("SELECT COUNT(*) AS count FROM outbox").get() as { count: number }).count).toBe(0);
    database.close();
  });

  it("fails closed for missing capability or durable Lease receipts", async () => {
    const { database, journal, operation } = await harness();
    const receipt = capability();
    const unsupported = CapabilityProbeReceiptSchema.parse({
      ...receipt,
      results: receipt.results.map((result) => ({ ...result, status: "NOT_PROVEN" as const })),
    });
    expect(() => manager(database, journal).requestAssignment({ commandId: "assign:no-cap", expectedVersion: 0, operation, policyDecision: "allow", capabilityReceipt: unsupported, requiredLeaseIds: [], now: new Date(now) })).toThrow(/CAPABILITY_NOT_PROVEN/u);
    expect(() => manager(database, journal).requestAssignment({ commandId: "assign:no-lease", expectedVersion: 0, operation, policyDecision: "allow", capabilityReceipt: receipt, requiredLeaseIds: [], now: new Date(now) })).toThrow(/LEASE_RECEIPT_REQUIRED/u);
    database.close();
  });
});
