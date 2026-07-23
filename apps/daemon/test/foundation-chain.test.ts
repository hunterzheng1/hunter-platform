import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentProfileIdSchema, AttemptIdSchema, CapabilityProbeReceiptIdSchema, ChangeIdSchema,
  ChangeRevisionIdSchema, ControllerLeaseIdSchema, DeviceBindingIdSchema, DeviceIdSchema,
  EvidenceIdSchema, ExecutionPlanIdSchema, LeaseOwnerIdSchema, NativeSessionIdSchema,
  OperationIdSchema, ProjectIdSchema, RepositoryIdSchema, RequirementIdSchema,
  RequirementRevisionIdSchema, RunIdSchema, RuntimeProviderIdSchema, TaskIdSchema,
  WorkspaceIdSchema, WorkspaceLeaseIdSchema, WorktreeIdSchema, WriterLeaseIdSchema,
  WorkflowRevisionIdSchema, createChangeRevision, createProject, createRequirementRevision,
  createWorkflowRevision, canonicalSha256,
} from "@hunter/domain";
import { createWorkflowRunBinding, type RunBudgetLimit } from "@hunter/flow-engine";
import { CapabilityProbeReceiptSchema, ControllerLeaseSchema, ExternalOperationReceiptSchema, WorkspaceLeaseSchema, WriterLeaseSchema, createExternalOperation, createWorkspacePathBoundary } from "@hunter/runtime-contracts";
import { SqliteOperationJournal } from "@hunter/storage";
import { FakeRuntime } from "@hunter/testkit";
import { describe, expect, it } from "vitest";

import { createSqliteApplicationServices } from "../src/services/sqlite-application-services.js";
import { buildApp } from "../src/app.js";
import { validWorkflowInput } from "../../../packages/domain/src/workflow-test-fixtures.js";

const ids = {
  project: ProjectIdSchema.parse("prj_chain00001"), repository: RepositoryIdSchema.parse("rep_chain00001"),
  requirement: RequirementIdSchema.parse("req_chain00001"), requirementRevision: RequirementRevisionIdSchema.parse("rrv_chain00001"),
  change: ChangeIdSchema.parse("chg_chain00001"), changeRevision: ChangeRevisionIdSchema.parse("crv_chain00001"),
  plan: ExecutionPlanIdSchema.parse("epl_chain00001"), task: TaskIdSchema.parse("tsk_chain00001"),
  workflow: WorkflowRevisionIdSchema.parse("wfr_chain00001"), profile: AgentProfileIdSchema.parse("apr_chain00001"),
  root: RunIdSchema.parse("run_chain00001"), cancelRoot: RunIdSchema.parse("run_cancel0001"), owner: LeaseOwnerIdSchema.parse("own_chain00001"), workspace: WorkspaceIdSchema.parse("wsp_chain00001"),
};

function oneStepWorkflow() {
  const input = validWorkflowInput();
  const step = { ...input.steps[0]!, requiredCapabilities: ["launch" as const], agentProfileSelector: { strategy: "fixed" as const, agentProfileIds: [ids.profile] } };
  return createWorkflowRevision({ ...input, workflowRevisionId: ids.workflow, steps: [step], entryStepId: step.stepId, routes: [
    { routeId: "rte_chain_pass1", fromStepId: step.stepId, outcome: "passed", priority: 0, toStepId: null },
    { routeId: "rte_chain_fail1", fromStepId: step.stepId, outcome: "failed", priority: 0, toStepId: null },
  ], loops: [] });
}

function persistCatalog(database: DatabaseSync, localPath: string) {
  const project = createProject({ projectId: ids.project, name: "Chain", repositoryBindings: [{ repositoryId: ids.repository, role: "primary" }], deviceBindings: [{ deviceBindingId: DeviceBindingIdSchema.parse("dev_chain00001"), deviceId: DeviceIdSchema.parse("dvc_chain00001"), repositoryId: ids.repository, localPath, availability: "available" }] });
  const requirement = createRequirementRevision({ requirementId: ids.requirement, revisionId: ids.requirementRevision, projectId: ids.project, title: "Chain", body: "prove chain", acceptanceCriteria: ["verified"], constraints: ["fake only"], status: "approved", approvedAt: "2026-07-22T10:00:00.000Z" });
  const change = createChangeRevision({ changeId: ids.change, revisionId: ids.changeRevision, projectId: ids.project, title: "Chain", goal: "prove", nonGoals: ["real provider"], requirementRevisionIds: [ids.requirementRevision], repositoryIds: [ids.repository], acceptanceCriteria: ["green"], constraints: ["strict"], risks: ["crash"], dependsOnChangeRevisionIds: [], status: "draft" });
  const workflow = oneStepWorkflow();
  new SqliteOperationJournal(database).commitCommand({
    commandId: "foundation-catalog:seed",
    requestFingerprint: canonicalSha256({ project, requirement, change, workflow }),
    projectId: ids.project,
    aggregateId: `project:${ids.project}:foundation-catalog`,
    expectedVersion: 0,
    actor: { actorId: "foundation-fixture", correlationId: "foundation-chain" },
    events: [
      { eventId: "evt_chain_project", eventType: "ProjectCreated", eventData: { projectId: project.projectId, project }, schemaVersion: 1, occurredAt: "2026-07-22T10:00:00.000Z" },
      { eventId: "evt_chain_requirement", eventType: "RequirementRevisionApproved", eventData: { requirementRevisionId: requirement.revisionId, requirementRevision: requirement }, schemaVersion: 1, occurredAt: "2026-07-22T10:00:00.000Z" },
      { eventId: "evt_chain_change", eventType: "ChangeRevisionDefined", eventData: { changeRevisionId: change.revisionId, changeRevision: change }, schemaVersion: 1, occurredAt: "2026-07-22T10:00:00.000Z" },
      { eventId: "evt_chain_workflow", eventType: "WorkflowRevisionPublished", eventData: { workflowRevisionId: workflow.workflowRevisionId, workflowRevision: workflow }, schemaVersion: 1, occurredAt: "2026-07-22T10:00:00.000Z" },
      { eventId: "evt_chain_profile", eventType: "AgentProfileDefined", eventData: { agentProfileId: ids.profile, agentProfile: { agentProfileId: ids.profile, projectId: ids.project, status: "active" } }, schemaVersion: 1, occurredAt: "2026-07-22T10:00:00.000Z" },
      { eventId: "evt_chain_policy", eventType: "ProjectRunPolicyDefined", eventData: { projectId: ids.project, policySnapshot: { snapshotHash: "a".repeat(64), policyVersion: 1 }, budgetLimit: { maxAttempts: 10, maxElapsedMs: 120_000, maxCost: 100, maxTokens: 10_000, maxLoopIterations: 3 } }, schemaVersion: 1, occurredAt: "2026-07-22T10:00:00.000Z" },
    ],
    operations: [],
    response: { seeded: true },
  });
  return { workflow };
}

function capability() {
  return CapabilityProbeReceiptSchema.parse({ schemaVersion: 1, probeReceiptId: CapabilityProbeReceiptIdSchema.parse("cpr_chain00001"), subject: { kind: "provider", providerId: RuntimeProviderIdSchema.parse("rtp_chain00001"), implementationVersion: "fake" }, platform: "windows", observedAt: "2026-07-21T00:00:00.000Z", validUntil: "2026-07-24T00:00:00.000Z", results: [
    { capability: "launch", status: "SUPPORTED", evidenceId: EvidenceIdSchema.parse("evd_chain00001"), evidenceHash: "a".repeat(64) },
    { capability: "observe", status: "SUPPORTED", evidenceId: EvidenceIdSchema.parse("evd_chain00002"), evidenceHash: "b".repeat(64) },
  ] });
}

function chainApp(services: ReturnType<typeof createSqliteApplicationServices>) {
  return buildApp({
    authenticator: services.authenticator,
    allowedHosts: services.allowedHosts,
    allowedOrigins: services.allowedOrigins,
    eventStream: services.eventStream,
    services: {
      listProjects: async (authorizedProjectIds) => {
        services.projectionRunner.runIncremental();
        const allowed = new Set<string>(authorizedProjectIds);
        return services.projectionRunner.snapshot("hunter").filter(({ entityType, projectId }) => entityType === "Project" && allowed.has(projectId));
      },
      projectForExecutionPlan: (executionPlanId) => {
        const plan = services.repositories.getExecutionPlan(executionPlanId);
        return plan === null ? null : { projectId: plan.projectId, executionPlanId: plan.executionPlanId };
      },
      projectForRun: (runId) => {
        const run = services.flowStore.loadRun(runId);
        return run === null ? null : { projectId: run.binding.projectId, runId: run.binding.runId };
      },
      startRun: async (command, actor) => services.startRun.execute(command, actor),
    },
  });
}

function authenticatedHeaders(services: ReturnType<typeof createSqliteApplicationServices>) {
  const token = services.authenticator.issueSession({ principalId: "chain", authorizedProjectIds: [ids.project], expiresAt: new Date(Date.now() + 60_000), csrf: "chain-csrf" });
  return { host: "hunter-test.localhost", origin: "app://hunter", authorization: `Bearer ${token}`, "x-csrf-token": "chain-csrf", "content-type": "application/json" };
}

describe("Foundation chain", () => {
  it("publishes, runs parent/child, journals Fake effects, restarts, replays SSE, and succeeds only after verification", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "hunter-foundation-")), "foundation.sqlite");
    const workspacePath = mkdtempSync(join(tmpdir(), "hunter-foundation-workspace-"));
    execFileSync("git", ["init", workspacePath], { windowsHide: true });
    writeFileSync(join(workspacePath, "README.md"), "foundation\n", "utf8");
    execFileSync("git", ["-C", workspacePath, "add", "README.md"], { windowsHide: true });
    execFileSync("git", ["-C", workspacePath, "-c", "user.name=Hunter Test", "-c", "user.email=hunter@example.invalid", "commit", "-m", "fixture"], { windowsHide: true });
    const baseline = execFileSync("git", ["-C", workspacePath, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim();
    const fake = new FakeRuntime({ providerId: RuntimeProviderIdSchema.parse("rtp_chain00001"), implementationVersion: "fake", observedAt: "2026-07-22T10:00:00.000Z" });
    let database = new DatabaseSync(path);
    let clock = new Date("2026-07-22T12:00:00.000Z");
    const definitions = persistCatalog(database, workspacePath);
    let services = createSqliteApplicationServices({ database, externalHandler: fake, installSecret: "foundation-secret-tests", allowedHosts: ["hunter-test.localhost"], allowedOrigins: ["app://hunter"], capabilityReceiptFor: () => capability(), now: () => clock });
    const published = services.publishChange.execute({ changeRevisionId: ids.changeRevision, executionPlanId: ids.plan, tasks: [{ taskId: ids.task, title: "Chain", objective: "verify", acceptanceCriteria: ["green"], repositoryIds: [ids.repository], moduleScopes: ["packages"], dependsOn: [], readSet: [], writeSet: ["packages"], access: "write", workflowRevisionId: ids.workflow, defaultAgentProfileId: ids.profile, sessionPolicy: "new", workspacePolicy: { mode: "write", isolation: "worktree", reuse: false } }], expectedVersion: 0, idempotencyKey: "publish-chain-1" }, { actorId: "chain", correlationId: "chain" });
    const firstApp = chainApp(services);
    expect((await firstApp.inject({ method: "POST", url: "/runs", headers: authenticatedHeaders(services), payload: { runId: ids.root, executionPlanId: ids.plan, workflowRevisionId: ids.workflow, expectedVersion: 0, idempotencyKey: "start-chain-root" } })).statusCode).toBe(200);
    await firstApp.close();
    const dispatchCommand = { parentRunId: ids.root, expectedVersion: services.flowStore.loadRun(ids.root)!.version, idempotencyKey: "fanout-chain", actor: { actorId: "chain", correlationId: "chain" } };
    const fanout = services.runCoordinator.dispatch(dispatchCommand);
    expect(services.runCoordinator.dispatch(dispatchCommand)).toEqual(fanout);
    expect(() => services.runCoordinator.dispatch({
      ...dispatchCommand,
      idempotencyKey: "fanout-chain-stale-new-key",
    })).toThrow(/EXPECTED_VERSION_CONFLICT/u);
    const childRunId = fanout.children[0]!.childRunId;
    const parent = services.flowStore.loadRun(ids.root)!.binding;

    let attemptId = services.flowStore.loadRun(childRunId)!.steps[0]!.attempts[0]!.attemptId;
    const worktreeId = WorktreeIdSchema.parse("wtr_chain00001");
    const deviceBindingId = DeviceBindingIdSchema.parse("dev_chain00001");
    const workspaceLeaseId = WorkspaceLeaseIdSchema.parse("wsl_chain00001");
    const writerLeaseId = WriterLeaseIdSchema.parse("wrl_chain00001");
    const boundary = createWorkspacePathBoundary(new Map([[ids.repository, workspacePath]]));
    const common = {
      schemaVersion: 2 as const,
      projectId: ids.project,
      repositoryId: ids.repository,
      deviceBindingId,
      canonicalWorkspaceKey: boundary.canonicalKey(boundary.verify(ids.repository, workspacePath)),
      gitHead: baseline,
      branch: execFileSync("git", ["-C", workspacePath, "branch", "--show-current"], { encoding: "utf8", windowsHide: true }).trim(),
      ownerRunId: childRunId,
      ownerAttemptId: attemptId,
      ownerId: ids.owner,
      generation: 1,
      mode: "write" as const,
      acquiredAt: "2026-07-22T10:00:00.000Z",
      expiresAt: "2027-07-22T10:30:00.000Z",
      revokedAt: null,
      revocationReason: null,
    };
    await services.leaseService.acquire(WorkspaceLeaseSchema.parse({ ...common, kind: "workspace", leaseId: workspaceLeaseId, scope: { workspaceId: ids.workspace } }));
    await services.leaseService.acquire(WriterLeaseSchema.parse({ ...common, kind: "writer", leaseId: writerLeaseId, scope: { workspaceId: ids.workspace, worktreeId } }));
    await services.leaseService.acquire(ControllerLeaseSchema.parse({ ...common, kind: "controller", leaseId: ControllerLeaseIdSchema.parse("ctl_chain00001"), scope: { workspaceId: ids.workspace, worktreeId, nativeSessionId: NativeSessionIdSchema.parse("ses_chain00001") } }));
    expect(definitions.workflow.steps.find(({ stepId }) => stepId === services.flowStore.loadRun(childRunId)!.steps[0]!.stepId)!.permissionPolicy.decision).toBe("allow");
    const operation = (index: number) => createExternalOperation({ schemaVersion: 1, operationId: OperationIdSchema.parse(`opn_chain0000${index}`), projectId: ids.project, runId: childRunId, attemptId: AttemptIdSchema.parse(attemptId), operationVersion: 1, operationType: "session.launch", requestedCapabilities: ["launch"], payload: { agentProfileId: ids.profile, workspaceId: ids.workspace } });
    services.runtimeManager.requestAssignment({ commandId: "assign-chain-1", expectedVersion: services.flowStore.loadRun(childRunId)!.version, operation: operation(1) });
    expect(await services.operationWorker.runOnce()).toBe("completed");
    const oldCursor = services.eventReader.highWaterPosition();
    services.flowEngine.handle({ type: "RecordExecutionFailure", runId: childRunId, errorClass: "transient", expectedVersion: services.flowStore.loadRun(childRunId)!.version, idempotencyKey: "retry-chain", actor: { actorId: "chain", correlationId: "chain" } });
    clock = new Date("2026-07-22T12:00:00.010Z");
    services.flowEngine.handle({ type: "ActivateScheduledRetry", runId: childRunId, expectedVersion: services.flowStore.loadRun(childRunId)!.version, idempotencyKey: "activate-retry-chain", actor: { actorId: "chain", correlationId: "chain" } });
    attemptId = services.flowStore.loadRun(childRunId)!.steps[0]!.attempts.at(-1)!.attemptId;
    await services.leaseService.release({ leaseId: workspaceLeaseId, ownerId: ids.owner, generation: 1 });
    await services.leaseService.release({ leaseId: writerLeaseId, ownerId: ids.owner, generation: 1 });
    const retryWorkspaceLeaseId = WorkspaceLeaseIdSchema.parse("wsl_chainretry01");
    const retryWriterLeaseId = WriterLeaseIdSchema.parse("wrl_chainretry01");
    await services.leaseService.acquire(WorkspaceLeaseSchema.parse({ ...common, ownerAttemptId: attemptId, generation: 2, kind: "workspace", leaseId: retryWorkspaceLeaseId, scope: { workspaceId: ids.workspace } }));
    await services.leaseService.acquire(WriterLeaseSchema.parse({ ...common, ownerAttemptId: attemptId, generation: 2, kind: "writer", leaseId: retryWriterLeaseId, scope: { workspaceId: ids.workspace, worktreeId } }));
    const recoveryLaunch = operation(2);
    services.runtimeManager.requestAssignment({ commandId: "assign-chain-2", expectedVersion: services.flowStore.loadRun(childRunId)!.version, operation: recoveryLaunch });
    expect(await services.operationWorker.runOnce()).toBe("completed");
    const recoveryLaunchReceipt = ExternalOperationReceiptSchema.parse(JSON.parse((database.prepare("SELECT provider_receipt_json FROM side_effect_receipts WHERE operation_id = ?").get(recoveryLaunch.operationId) as { provider_receipt_json: string }).provider_receipt_json));
    const recoverySessionId = recoveryLaunchReceipt.nativeReferences.find((reference) => reference.kind === "session")!.referenceId;
    await expect(
      services.leaseService.findActiveController(ids.project, recoverySessionId),
    ).resolves.toMatchObject({
      kind: "controller",
      ownerAttemptId: attemptId,
      scope: { nativeSessionId: recoverySessionId },
    });
    writeFileSync(join(workspacePath, "unexpected.txt"), "drift\n", "utf8");
    database.close();

    database = new DatabaseSync(path);
    services = createSqliteApplicationServices({
      database,
      externalHandler: fake,
      installSecret: "foundation-secret-tests",
      allowedHosts: ["hunter-test.localhost"],
      allowedOrigins: ["app://hunter"],
      capabilityReceiptFor: () => capability(),
      leaseRecoveryObservationFor: (lease) =>
        lease.kind === "workspace"
          ? null
          : lease.kind === "writer"
            ? { worktreeId: lease.scope.worktreeId }
            : {
                worktreeId: lease.scope.worktreeId,
                nativeSessionId: lease.scope.nativeSessionId,
              },
      verifiedWorkspacePathForLease: (lease) =>
        lease.kind === "workspace"
          ? null
          : boundary.verify(ids.repository, workspacePath),
      now: () => clock,
    });
    const recovery = await services.recovery.run();
    expect(recovery.conclusions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "session", status: "observed", reason: expect.stringContaining("session_observation_receipt:") }),
      expect.objectContaining({ kind: "session", status: "needs_attention", reason: "runtime_assignment_missing" }),
      expect.objectContaining({ kind: "workspace", status: "needs_attention", reason: "workspace_unexpected_writes" }),
    ]));
    expect(services.flowStore.loadRun(childRunId)!.steps[0]!.executionStatus).toBe("returned");
    expect(services.projectionRunner.snapshot("hunter").map(({ entityType }) => entityType).sort()).toEqual(expect.arrayContaining(["ChangeRevision", "ExecutionPlan", "Project", "RequirementRevision", "WorkflowRevision"]));
    expect(await services.operationWorker.runOnce()).toBe("idle");
    const restartedApp = chainApp(services);
    const headers = authenticatedHeaders(services);
    const replay = await restartedApp.inject({ method: "GET", url: `/events?once=1&cursor=${oldCursor}`, headers });
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toContain("id: ");
    const snapshot = await restartedApp.inject({ method: "GET", url: "/events/snapshot", headers });
    expect(snapshot.statusCode).toBe(200);
    expect((snapshot.json() as { entities: Array<{ projectId: string }> }).entities.every(({ projectId }) => projectId === ids.project)).toBe(true);
    await restartedApp.close();
    expect(fake.nativeEffectCount).toBe(3);
    expect((database.prepare("SELECT COUNT(*) AS count FROM side_effect_receipts").get() as { count: number }).count).toBe(3);

    const actor = { actorId: "chain", correlationId: "chain" };
    services.flowEngine.handle({ type: "RecordExternalObservation", runId: ids.root, fact: "session_running", expectedVersion: services.flowStore.loadRun(ids.root)!.version, idempotencyKey: "root-resumed-chain", actor });
    services.flowEngine.handle({ type: "RecordExternalObservation", runId: ids.root, fact: "agent_returned", expectedVersion: services.flowStore.loadRun(ids.root)!.version, idempotencyKey: "root-return-chain", actor });
    services.flowEngine.handle({ type: "RecordVerifierResult", runId: ids.root, outcome: "passed", evidenceFingerprint: "c".repeat(64), expectedVersion: services.flowStore.loadRun(ids.root)!.version, idempotencyKey: "root-verify-chain", actor });
    expect(services.flowStore.loadRun(ids.root)!.status).not.toBe("succeeded");
    services.flowEngine.handle({ type: "RecordVerifierResult", runId: childRunId, outcome: "passed", evidenceFingerprint: "d".repeat(64), expectedVersion: services.flowStore.loadRun(childRunId)!.version, idempotencyKey: "child-verify-chain", actor });
    services.flowEngine.handle({ type: "ReconcileTaskChildren", runId: ids.root, expectedVersion: services.flowStore.loadRun(ids.root)!.version, idempotencyKey: "reconcile-chain", actor });
    expect(services.flowStore.loadRun(ids.root)!.status).toBe("succeeded");
    expect(services.flowStore.loadRun(ids.root)!.binding.bindingFingerprint).toBe(parent.bindingFingerprint);

    services.startRun.execute({ runId: ids.cancelRoot, executionPlanId: ids.plan, workflowRevisionId: ids.workflow, expectedVersion: 0, idempotencyKey: "start-cancel-root" }, actor);
    const cancelFanout = services.flowEngine.handle({ type: "ScheduleTaskFanOut", runId: ids.cancelRoot, expectedVersion: services.flowStore.loadRun(ids.cancelRoot)!.version, idempotencyKey: "fanout-cancel-root", actor }).response as { children: Array<{ taskId: typeof ids.task; childRunId: ReturnType<typeof RunIdSchema.parse>; budget: RunBudgetLimit }> };
    const cancelScheduled = cancelFanout.children[0]!;
    const cancelParent = services.flowStore.loadRun(ids.cancelRoot)!.binding;
    const cancelChild = createWorkflowRunBinding({ runId: cancelScheduled.childRunId, projectId: ids.project, changeRevisionId: ids.changeRevision, requirementRevisionIds: [ids.requirementRevision], workflowRevisionId: ids.workflow, policySnapshot: cancelParent.policySnapshot, initialBudget: cancelScheduled.budget, subjectKind: "task", parentRunId: ids.cancelRoot, taskId: ids.task, executionPlanId: ids.plan }, { parent: cancelParent, executionPlan: published.executionPlan, activeTaskIds: [], parentTerminal: false, childBudgetAllocation: cancelScheduled.budget });
    services.flowEngine.handle({ type: "StartRun", binding: cancelChild, expectedVersion: 0, idempotencyKey: "start-cancel-child", actor });
    const cancelAttemptId = services.flowStore.loadRun(cancelChild.runId)!.steps[0]!.attempts[0]!.attemptId;
    const cancelLaunch = createExternalOperation({ schemaVersion: 1, operationId: "opn_cancelchain01", projectId: ids.project, runId: cancelChild.runId, attemptId: cancelAttemptId, operationVersion: 1, operationType: "session.launch", requestedCapabilities: ["launch"], payload: { agentProfileId: ids.profile, workspaceId: ids.workspace } });
    await expect(services.leaseService.inspect(retryWorkspaceLeaseId)).resolves.toBeNull();
    expect(JSON.parse((database.prepare(
      "SELECT receipt_json FROM lease_records WHERE lease_id = ?",
    ).get(retryWorkspaceLeaseId) as { receipt_json: string }).receipt_json)).toMatchObject({
      revokedAt: expect.any(String),
      revocationReason: "workspace_unexpected_writes",
    });
    await services.leaseService.release({ leaseId: retryWriterLeaseId, ownerId: ids.owner, generation: 2 });
    await services.leaseService.acquire(WorkspaceLeaseSchema.parse({ ...common, ownerRunId: cancelChild.runId, ownerAttemptId: cancelAttemptId, generation: 3, kind: "workspace", leaseId: WorkspaceLeaseIdSchema.parse("wsl_chaincancel01"), scope: { workspaceId: ids.workspace } }));
    await services.leaseService.acquire(WriterLeaseSchema.parse({ ...common, ownerRunId: cancelChild.runId, ownerAttemptId: cancelAttemptId, generation: 3, kind: "writer", leaseId: WriterLeaseIdSchema.parse("wrl_chaincancel01"), scope: { workspaceId: ids.workspace, worktreeId } }));
    services.runtimeManager.requestAssignment({ commandId: "assign-cancel-chain", expectedVersion: services.flowStore.loadRun(cancelChild.runId)!.version, operation: cancelLaunch });
    expect(await services.operationWorker.runOnce()).toBe("completed");
    const launchReceipt = ExternalOperationReceiptSchema.parse(JSON.parse((database.prepare("SELECT provider_receipt_json FROM side_effect_receipts WHERE operation_id = ?").get(cancelLaunch.operationId) as { provider_receipt_json: string }).provider_receipt_json));
    const nativeSessionId = launchReceipt.nativeReferences.find((reference) => reference.kind === "session")!.referenceId;
    await expect(
      services.leaseService.findActiveController(ids.project, nativeSessionId),
    ).resolves.toMatchObject({
      kind: "controller",
      ownerRunId: cancelChild.runId,
      ownerAttemptId: cancelAttemptId,
      scope: { workspaceId: ids.workspace, worktreeId, nativeSessionId },
    });
    services.flowEngine.handle({ type: "CancelRun", runId: ids.cancelRoot, expectedVersion: services.flowStore.loadRun(ids.cancelRoot)!.version, idempotencyKey: "cancel-root-chain", actor });
    await services.reconcileCancellationRequests();
    expect(services.flowStore.loadRun(cancelChild.runId)!.status).toBe("canceled");
    expect(services.flowStore.loadRun(ids.cancelRoot)!.status).toBe("canceled");
    expect(database.prepare("SELECT status FROM outbox WHERE operation_type = 'session.interrupt' ORDER BY created_at DESC LIMIT 1").get()).toEqual({ status: "completed" });
    expect(fake.nativeEffectCount).toBe(5);
    database.close();
  });
});
