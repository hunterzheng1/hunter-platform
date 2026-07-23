import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  AgentProfileIdSchema, AttemptIdSchema, CapabilityProbeReceiptIdSchema, ChangeRevisionIdSchema,
  DeviceBindingIdSchema, DeviceIdSchema, EvidenceIdSchema, ExecutionPlanIdSchema, LeaseOwnerIdSchema,
  OperationIdSchema, ProjectIdSchema, RequirementRevisionIdSchema, RunIdSchema,
  RepositoryIdSchema, RuntimeProviderIdSchema, StepIdSchema, StepRunIdSchema, WorkflowRevisionIdSchema,
  WorkspaceIdSchema, WorkspaceLeaseIdSchema, WorktreeIdSchema, WriterLeaseIdSchema, createProject,
} from "@hunter/domain";
import { createWorkflowRunBinding } from "@hunter/flow-engine";
import { CapabilityProbeReceiptSchema, ExternalOperationReceiptSchema, LeaseSchema, WorkspaceLeaseSchema, WriterLeaseSchema, createExternalOperation, createWorkspacePathBoundary, type RuntimeFact } from "@hunter/runtime-contracts";
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
    expect(order).toEqual(["storage", "migration", "attempts", "leases", "outbox", "probe", "projections", "flow"]);
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
  ])("reconciles a file-backed $name Session through a journaled observe receipt", async ({ name, facts, executionStatus, runStatus, conclusionStatus }) => {
    const fixtureDirectory = mkdtempSync(join(tmpdir(), "hunter-recovery-session-"));
    const path = join(fixtureDirectory, "recovery.sqlite");
    const repositoryPath = join(fixtureDirectory, "repository");
    const workspacePath = join(fixtureDirectory, "worktree");
    mkdirSync(repositoryPath);
    execFileSync("git", ["init", repositoryPath], { windowsHide: true });
    execFileSync("git", ["-C", repositoryPath, "config", "user.email", "hunter@example.invalid"], { windowsHide: true });
    execFileSync("git", ["-C", repositoryPath, "config", "user.name", "Hunter Test"], { windowsHide: true });
    writeFileSync(join(repositoryPath, "README.md"), "recovery fixture\n", "utf8");
    execFileSync("git", ["-C", repositoryPath, "add", "README.md"], { windowsHide: true });
    execFileSync("git", ["-C", repositoryPath, "commit", "-m", "fixture"], { windowsHide: true });
    execFileSync("git", ["-C", repositoryPath, "worktree", "add", "-b", "codex/task14-recovery", workspacePath], { windowsHide: true });
    expect(workspacePath).not.toBe(repositoryPath);
    const gitHead = execFileSync("git", ["-C", workspacePath, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim();
    const now = new Date("2026-07-22T10:00:00.000Z");
    const projectId = ProjectIdSchema.parse("prj_recovery001");
    const runId = RunIdSchema.parse("run_recovery001");
    const attemptId = AttemptIdSchema.parse("att_recovery001");
    const fake = new FakeRuntime({ providerId: RuntimeProviderIdSchema.parse("rtp_recovery001"), implementationVersion: "fake", observedAt: now.toISOString(), sessionObservationFacts: facts as readonly RuntimeFact[] });
    const capability = CapabilityProbeReceiptSchema.parse({ schemaVersion: 2, probeReceiptId: CapabilityProbeReceiptIdSchema.parse("cpr_recovery001"), subject: { kind: "provider", providerId: RuntimeProviderIdSchema.parse("rtp_recovery001"), implementationVersion: "fake" }, platform: "windows", executable: { status: "available" }, loginState: "not_required", productVersion: { observed: "fake-1", supported: ["fake-1"] }, protocol: { kind: "fake", observedVersion: "1", supportedVersions: ["1"], schemaVersion: 1, supportedSchemaVersions: [1], schemaDigest: "b".repeat(64) }, probedAt: "2026-07-22T09:00:00.000Z", validUntil: "2026-07-22T11:00:00.000Z", results: [{ capability: "observe", status: "supported", evidenceId: EvidenceIdSchema.parse("evd_recovery001"), evidence: { source: "local_probe", digest: "a".repeat(64) }, probedAt: "2026-07-22T09:00:00.000Z" }] });
    let database = new DatabaseSync(path);
    let services = createSqliteApplicationServices({ database, externalHandler: fake, installSecret: "session-recovery-tests", allowedHosts: ["hunter-test.localhost"], allowedOrigins: ["app://hunter"], now: () => now, capabilityReceiptFor: () => capability });
    const binding = createWorkflowRunBinding({ runId, projectId, changeRevisionId: ChangeRevisionIdSchema.parse("crv_recovery001"), requirementRevisionIds: [RequirementRevisionIdSchema.parse("rrv_recovery001")], workflowRevisionId: WorkflowRevisionIdSchema.parse("wfr_recovery001"), policySnapshot: { policyVersion: 1, snapshotHash: "b".repeat(64) }, initialBudget: { maxAttempts: 3, maxElapsedMs: 60_000, maxCost: 10, maxTokens: 1_000, maxLoopIterations: 1 }, subjectKind: "change", parentRunId: null, taskId: null, executionPlanId: ExecutionPlanIdSchema.parse("epl_recovery001"), taskGraphFingerprint: "c".repeat(64) });
    const launch = createExternalOperation({ schemaVersion: 1, operationId: OperationIdSchema.parse("opn_recovery001"), projectId, runId, attemptId, operationVersion: 1, operationType: "session.launch", requestedCapabilities: ["launch"], payload: { agentProfileId: AgentProfileIdSchema.parse("apr_recovery001"), workspaceId: "wsp_recovery001" } });
    const repositoryId = RepositoryIdSchema.parse("rep_recovery001");
    const deviceBindingId = DeviceBindingIdSchema.parse("dev_recovery001");
    const workspaceId = WorkspaceIdSchema.parse("wsp_recovery001");
    const worktreeId = WorktreeIdSchema.parse("wtr_recovery001");
    const workspaceLeaseId = WorkspaceLeaseIdSchema.parse("wsl_recovery001");
    const writerLeaseId = WriterLeaseIdSchema.parse("wrl_recovery001");
    const commonLease = {
      schemaVersion: 2 as const,
      projectId,
      repositoryId,
      deviceBindingId,
      canonicalWorkspaceKey: createWorkspacePathBoundary(new Map([[repositoryId, workspacePath]])).canonicalKey(createWorkspacePathBoundary(new Map([[repositoryId, workspacePath]])).verify(repositoryId, workspacePath)),
      gitHead,
      branch: "codex/task14-recovery",
      ownerRunId: runId,
      ownerAttemptId: attemptId,
      ownerId: LeaseOwnerIdSchema.parse("own_recovery001"),
      generation: 1,
      mode: "write" as const,
      acquiredAt: now.toISOString(),
      expiresAt: "2026-07-22T10:30:00.000Z",
      revokedAt: null,
      revocationReason: null,
    };
    const flowEvents = [
      { type: "RunStarted", binding },
      { type: "BudgetConsumed", attempts: 1, elapsedMs: 1_000, cost: 1, tokens: 0, loopIterations: 0, progressFingerprint: null, failureFingerprint: null, noDiff: false, verifierError: false },
      { type: "StepActivated", stepRunId: StepRunIdSchema.parse("spr_recovery001"), stepId: StepIdSchema.parse("stp_recovery001"), attemptId, attemptNumber: 1, fixedContentHash: "d".repeat(64) },
      { type: "AttemptAssigned", attemptId, operationId: launch.operationId, capabilityProbeReceiptId: capability.probeReceiptId, leaseIds: [workspaceLeaseId, writerLeaseId] },
    ];
    services.journal.commitCommand({ commandId: "seed-recovery-session", requestFingerprint: "e".repeat(64), projectId, aggregateId: `run:${runId}`, expectedVersion: 0, actor: { actorId: "test", correlationId: "recovery" }, events: flowEvents.map((flowEvent, index) => ({ eventId: `evt_recovery_${index}`, eventType: "FlowEvent", eventData: { flowEvent }, schemaVersion: 1, occurredAt: now.toISOString() })), operations: [launch], response: {} });
    const project = createProject({
      projectId,
      name: "Recovery Fixture",
      repositoryBindings: [{ repositoryId, role: "primary" }],
      deviceBindings: [{
        deviceBindingId,
        deviceId: DeviceIdSchema.parse("dvc_recovery001"),
        repositoryId,
        localPath: repositoryPath,
        availability: "available",
        lastVerifiedAt: now.toISOString(),
      }],
    });
    services.journal.commitCommand({
      commandId: "seed-recovery-project",
      requestFingerprint: "f".repeat(64),
      projectId,
      aggregateId: `project:${projectId}`,
      expectedVersion: 0,
      actor: { actorId: "test", correlationId: "recovery" },
      events: [{ eventId: "evt_recovery_project", eventType: "ProjectCreated", eventData: { projectId, project }, schemaVersion: 1, occurredAt: now.toISOString() }],
      operations: [],
      response: {},
    });
    await services.leaseService.acquire(WorkspaceLeaseSchema.parse({
      ...commonLease,
      canonicalWorkspaceKey: createWorkspacePathBoundary(new Map([[repositoryId, repositoryPath]])).canonicalKey(createWorkspacePathBoundary(new Map([[repositoryId, repositoryPath]])).verify(repositoryId, repositoryPath)),
      branch: execFileSync("git", ["-C", repositoryPath, "branch", "--show-current"], { encoding: "utf8", windowsHide: true }).trim(),
      kind: "workspace",
      leaseId: workspaceLeaseId,
      scope: { workspaceId },
    }));
    await services.leaseService.acquire(WriterLeaseSchema.parse({
      ...commonLease,
      kind: "writer",
      leaseId: writerLeaseId,
      scope: { workspaceId, worktreeId },
    }));
    expect(await services.operationWorker.runOnce()).toBe("completed");
    const launchReceipt = ExternalOperationReceiptSchema.parse(JSON.parse((database.prepare("SELECT provider_receipt_json FROM side_effect_receipts WHERE operation_id = ?").get(launch.operationId) as { provider_receipt_json: string }).provider_receipt_json));
    const sessionId = launchReceipt.nativeReferences.find((reference) => reference.kind === "session")!.referenceId;
    const controller = LeaseSchema.parse(JSON.parse((database.prepare(
      "SELECT receipt_json FROM lease_records WHERE lease_kind = 'controller'",
    ).get() as { receipt_json: string }).receipt_json));
    if (controller.kind !== "controller") throw new Error("CONTROLLER_LEASE_NOT_ISSUED");
    const controllerLeaseId = controller.leaseId;
    expect(database.prepare(
      "SELECT scope_key FROM lease_records WHERE lease_kind = 'controller'",
    ).get()).toEqual({ scope_key: `${projectId}:${sessionId}` });
    await expect(
      services.leaseService.findActiveController(projectId, sessionId),
    ).resolves.toMatchObject({ kind: "controller", projectId });
    database.close();

    database = new DatabaseSync(path);
    let observedWriterWorktreeId = worktreeId;
    const worktreeBoundary = createWorkspacePathBoundary(new Map([[repositoryId, workspacePath]]));
    const verifiedWorktreePath = worktreeBoundary.verify(repositoryId, workspacePath);
    services = createSqliteApplicationServices({ database, externalHandler: fake, installSecret: "session-recovery-tests", allowedHosts: ["hunter-test.localhost"], allowedOrigins: ["app://hunter"], now: () => now, capabilityReceiptFor: () => capability, leaseRecoveryObservationFor: (lease) => lease.kind === "workspace" ? {} : lease.kind === "writer" ? { worktreeId: observedWriterWorktreeId } : { worktreeId: lease.scope.worktreeId, nativeSessionId: lease.scope.nativeSessionId }, verifiedWorkspacePathForLease: (lease) => lease.kind === "workspace" ? null : verifiedWorktreePath });
    await expect(
      services.leaseService.findActiveController(projectId, sessionId),
    ).resolves.toMatchObject({ kind: "controller", projectId });
    const first = await services.recovery.run();
    expect(first.conclusions).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "session", status: conclusionStatus, reason: expect.stringContaining("session_observation_receipt:") })]));
    expect(first.conclusions).toEqual(expect.arrayContaining([
      expect.objectContaining({ leaseId: workspaceLeaseId, status: "observed" }),
      expect.objectContaining({ leaseId: writerLeaseId, status: "observed" }),
      expect.objectContaining({ leaseId: controllerLeaseId, status: "observed" }),
    ]));
    expect(services.flowStore.loadRun(runId)).toMatchObject({ status: runStatus, steps: [{ executionStatus, verificationStatus: "pending", conclusion: "active" }] });
    expect(services.flowStore.loadRun(runId)!.status).not.toBe("succeeded");
    const version = services.flowStore.loadRun(runId)!.version;
    const second = await services.recovery.run();
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(services.flowStore.loadRun(runId)!.version).toBe(version);
    expect(fake.nativeEffectCount).toBe(2);
    if (name === "alive") {
      const row = database.prepare(
        "SELECT receipt_json FROM lease_records WHERE lease_id = ?",
      ).get(writerLeaseId) as { receipt_json: string };
      const original = JSON.parse(row.receipt_json) as Record<string, unknown>;
      let deniedOperation = 0;
      const expectWriterAttention = async () => {
        const report = await services.recovery.run();
        expect(report.conclusions).toEqual(expect.arrayContaining([
          expect.objectContaining({
            leaseId: writerLeaseId,
            status: "needs_attention",
          }),
        ]));
        const quarantined = JSON.parse((database.prepare(
          "SELECT receipt_json FROM lease_records WHERE lease_id = ?",
        ).get(writerLeaseId) as { receipt_json: string }).receipt_json) as {
          revokedAt: string | null;
        };
        expect(quarantined.revokedAt).not.toBeNull();
        deniedOperation += 1;
        const denied = createExternalOperation({
          schemaVersion: 1,
          operationId: OperationIdSchema.parse(`opn_recoverydenied0${deniedOperation}`),
          projectId,
          runId,
          attemptId,
          operationVersion: 1,
          operationType: "session.launch",
          requestedCapabilities: ["launch"],
          payload: {
            agentProfileId: AgentProfileIdSchema.parse("apr_recovery001"),
            workspaceId,
          },
        });
        services.journal.commitCommand({
          commandId: `recovery-denied:${deniedOperation}`,
          requestFingerprint: denied.fingerprint,
          projectId,
          aggregateId: `recovery-denied:${deniedOperation}`,
          expectedVersion: 0,
          actor: { actorId: "test", correlationId: "recovery-denied" },
          events: [],
          operations: [denied],
          response: {},
        });
        const effectCount = fake.nativeEffectCount;
        await expect(services.operationWorker.runOnce()).resolves.toBe("needs_attention");
        expect(fake.nativeEffectCount).toBe(effectCount);
      };
      observedWriterWorktreeId = WorktreeIdSchema.parse("wtr_recoverywrong");
      await expectWriterAttention();
      database.prepare(
        "UPDATE lease_records SET receipt_json = ? WHERE lease_id = ?",
      ).run(row.receipt_json, writerLeaseId);
      observedWriterWorktreeId = worktreeId;

      for (const mutation of [
        { deviceBindingId: "dev_recoverywrong" },
        { canonicalWorkspaceKey: "win32:c:\\wrong\\path" },
        { gitHead: "b".repeat(40) },
      ]) {
        database.prepare(
          "UPDATE lease_records SET receipt_json = ? WHERE lease_id = ?",
        ).run(JSON.stringify({ ...original, ...mutation }), writerLeaseId);
        await expectWriterAttention();
        database.prepare(
          "UPDATE lease_records SET receipt_json = ? WHERE lease_id = ?",
        ).run(row.receipt_json, writerLeaseId);
      }
    }
    database.close();
  }, 20_000);
});
