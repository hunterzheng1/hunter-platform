import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  AgentProfileIdSchema, AttemptIdSchema, CapabilityProbeReceiptIdSchema, ChangeRevisionIdSchema,
  ControllerLeaseIdSchema, EvidenceIdSchema, ExecutionPlanIdSchema, LeaseOwnerIdSchema,
  OperationIdSchema, ProjectIdSchema, RequirementRevisionIdSchema, RunIdSchema,
  RuntimeProviderIdSchema, StepIdSchema, StepRunIdSchema, WorkflowRevisionIdSchema,
} from "@hunter/domain";
import { createWorkflowRunBinding } from "@hunter/flow-engine";
import { CapabilityProbeReceiptSchema, ControllerLeaseSchema, ExternalOperationReceiptSchema, createExternalOperation, type RuntimeFact } from "@hunter/runtime-contracts";
import { FakeRuntime } from "@hunter/testkit";
import { describe, expect, it, vi } from "vitest";

import { createSqliteApplicationServices } from "../src/services/sqlite-application-services.js";
import { StartupRecoveryCoordinator, recoverThenListen } from "../src/startup/startup-recovery-coordinator.js";

function ports(order: string[]) {
  return {
    validateStorage: vi.fn(async () => { order.push("storage"); return []; }),
    reconcileMigration: vi.fn(async () => { order.push("migration"); return []; }),
    reconcileOutbox: vi.fn(async () => { order.push("outbox"); return [{ kind: "operation", status: "indeterminate" as const }]; }),
    enumerateActiveAttempts: vi.fn(async () => { order.push("attempts"); return [{ kind: "attempt", attemptId: "att_recovery001" }]; }),
    probeExternalState: vi.fn(async () => { order.push("probe"); return [{ kind: "session", status: "missing" as const }]; }),
    reconcileLeasesAndWorkspace: vi.fn(async () => { order.push("leases"); return [{ kind: "workspace", status: "drift" as const }]; }),
    validateProjections: vi.fn(async () => { order.push("projections"); return []; }),
    submitRecoveryConclusions: vi.fn(async (facts: readonly unknown[]) => { order.push("flow"); return { receiptId: "recovery-1", facts: facts.length }; }),
  };
}

describe("StartupRecoveryCoordinator", () => {
  it("executes the mandatory sequence and never turns absence into success", async () => {
    const order: string[] = [];
    const coordinator = new StartupRecoveryCoordinator(ports(order));
    const report = await coordinator.run();
    expect(order).toEqual(["storage", "migration", "outbox", "attempts", "probe", "leases", "projections", "flow"]);
    expect(JSON.stringify(report)).not.toMatch(/succeeded|StepSucceeded|RunSucceeded/u);
    expect(report.conclusions).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "needs_attention" }),
      expect.objectContaining({ status: "indeterminate" }),
    ]));
  });

  it("does not listen until recovery resolves and never listens after recovery failure", async () => {
    const order: string[] = [];
    const listen = vi.fn(async () => { order.push("listen"); });
    await recoverThenListen(new StartupRecoveryCoordinator(ports(order)), async () => ({ listen }));
    expect(order.at(-1)).toBe("listen");

    const failed = ports([]);
    failed.validateStorage.mockRejectedValueOnce(new Error("integrity"));
    const forbiddenListen = vi.fn();
    await expect(recoverThenListen(new StartupRecoveryCoordinator(failed), async () => ({ listen: forbiddenListen }))).rejects.toThrow(/integrity/u);
    expect(forbiddenListen).not.toHaveBeenCalled();
  });

  it("submits replay-stable recovery commands on repeated runs", async () => {
    const recoveryPorts = ports([]);
    const coordinator = new StartupRecoveryCoordinator(recoveryPorts);
    const first = await coordinator.run();
    const second = await coordinator.run();
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(recoveryPorts.submitRecoveryConclusions).toHaveBeenCalledTimes(2);
    expect(recoveryPorts.submitRecoveryConclusions.mock.calls[1]).toEqual(recoveryPorts.submitRecoveryConclusions.mock.calls[0]);
  });

  it.each([
    { name: "alive", facts: [{ kind: "session_observed", state: "running" }] as const, executionStatus: "running", runStatus: "running", conclusionStatus: "observed" },
    { name: "missing", facts: [{ kind: "session_observed", state: "missing" }] as const, executionStatus: "stale", runStatus: "needs_attention", conclusionStatus: "needs_attention" },
    { name: "structured exit", facts: [{ kind: "process_exited", exitCode: 0 }] as const, executionStatus: "returned", runStatus: "running", conclusionStatus: "observed" },
  ])("reconciles a file-backed $name Session through a journaled observe receipt", async ({ facts, executionStatus, runStatus, conclusionStatus }) => {
    const path = join(mkdtempSync(join(tmpdir(), "hunter-recovery-session-")), "recovery.sqlite");
    const now = new Date("2026-07-22T10:00:00.000Z");
    const projectId = ProjectIdSchema.parse("prj_recovery001");
    const runId = RunIdSchema.parse("run_recovery001");
    const attemptId = AttemptIdSchema.parse("att_recovery001");
    const fake = new FakeRuntime({ providerId: RuntimeProviderIdSchema.parse("rtp_recovery001"), implementationVersion: "fake", observedAt: now.toISOString(), sessionObservationFacts: facts as readonly RuntimeFact[] });
    const capability = CapabilityProbeReceiptSchema.parse({ schemaVersion: 1, probeReceiptId: CapabilityProbeReceiptIdSchema.parse("cpr_recovery001"), subject: { kind: "provider", providerId: RuntimeProviderIdSchema.parse("rtp_recovery001"), implementationVersion: "fake" }, platform: "windows", observedAt: "2026-07-22T09:00:00.000Z", validUntil: "2026-07-22T11:00:00.000Z", results: [{ capability: "observe", status: "SUPPORTED", evidenceId: EvidenceIdSchema.parse("evd_recovery001"), evidenceHash: "a".repeat(64) }] });
    let database = new DatabaseSync(path);
    let services = createSqliteApplicationServices({ database, externalHandler: fake, installSecret: "session-recovery-tests", allowedHosts: ["hunter-test.localhost"], allowedOrigins: ["app://hunter"], now: () => now, capabilityReceiptFor: () => capability });
    const binding = createWorkflowRunBinding({ runId, projectId, changeRevisionId: ChangeRevisionIdSchema.parse("crv_recovery001"), requirementRevisionIds: [RequirementRevisionIdSchema.parse("rrv_recovery001")], workflowRevisionId: WorkflowRevisionIdSchema.parse("wfr_recovery001"), policySnapshot: { policyVersion: 1, snapshotHash: "b".repeat(64) }, initialBudget: { maxAttempts: 3, maxElapsedMs: 60_000, maxCost: 10, maxTokens: 1_000, maxLoopIterations: 1 }, subjectKind: "change", parentRunId: null, taskId: null, executionPlanId: ExecutionPlanIdSchema.parse("epl_recovery001"), taskGraphFingerprint: "c".repeat(64) });
    const launch = createExternalOperation({ schemaVersion: 1, operationId: OperationIdSchema.parse("opn_recovery001"), projectId, runId, attemptId, operationVersion: 1, operationType: "session.launch", requestedCapabilities: ["launch"], payload: { agentProfileId: AgentProfileIdSchema.parse("apr_recovery001"), workspaceId: "wsp_recovery001" } });
    const flowEvents = [
      { type: "RunStarted", binding },
      { type: "BudgetConsumed", attempts: 1, elapsedMs: 1_000, cost: 1, tokens: 0, loopIterations: 0, progressFingerprint: null, failureFingerprint: null, noDiff: false, verifierError: false },
      { type: "StepActivated", stepRunId: StepRunIdSchema.parse("spr_recovery001"), stepId: StepIdSchema.parse("stp_recovery001"), attemptId, attemptNumber: 1, fixedContentHash: "d".repeat(64) },
      { type: "AttemptAssigned", attemptId, operationId: launch.operationId, capabilityProbeReceiptId: capability.probeReceiptId, leaseIds: [] },
    ];
    services.journal.commitCommand({ commandId: "seed-recovery-session", requestFingerprint: "e".repeat(64), projectId, aggregateId: `run:${runId}`, expectedVersion: 0, actor: { actorId: "test", correlationId: "recovery" }, events: flowEvents.map((flowEvent, index) => ({ eventId: `evt_recovery_${index}`, eventType: "FlowEvent", eventData: { flowEvent }, schemaVersion: 1, occurredAt: now.toISOString() })), operations: [launch], response: {} });
    expect(await services.operationWorker.runOnce()).toBe("completed");
    const launchReceipt = ExternalOperationReceiptSchema.parse(JSON.parse((database.prepare("SELECT provider_receipt_json FROM side_effect_receipts WHERE operation_id = ?").get(launch.operationId) as { provider_receipt_json: string }).provider_receipt_json));
    const sessionId = launchReceipt.nativeReferences.find((reference) => reference.kind === "session")!.referenceId;
    await services.leaseService.acquire(ControllerLeaseSchema.parse({ schemaVersion: 1, kind: "controller", leaseId: ControllerLeaseIdSchema.parse("ctl_recovery001"), ownerId: LeaseOwnerIdSchema.parse("own_recovery001"), generation: 1, acquiredAt: now.toISOString(), expiresAt: "2026-07-22T10:30:00.000Z", scope: { nativeSessionId: sessionId } }));
    database.close();

    database = new DatabaseSync(path);
    services = createSqliteApplicationServices({ database, externalHandler: fake, installSecret: "session-recovery-tests", allowedHosts: ["hunter-test.localhost"], allowedOrigins: ["app://hunter"], now: () => now, capabilityReceiptFor: () => capability });
    const first = await services.recovery.run();
    expect(first.conclusions).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "session", status: conclusionStatus, reason: expect.stringContaining("session_observation_receipt:") })]));
    expect(services.flowStore.loadRun(runId)).toMatchObject({ status: runStatus, steps: [{ executionStatus, verificationStatus: "pending", conclusion: "active" }] });
    expect(services.flowStore.loadRun(runId)!.status).not.toBe("succeeded");
    const version = services.flowStore.loadRun(runId)!.version;
    const second = await services.recovery.run();
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(services.flowStore.loadRun(runId)!.version).toBe(version);
    expect(fake.nativeEffectCount).toBe(2);
    database.close();
  });
});
