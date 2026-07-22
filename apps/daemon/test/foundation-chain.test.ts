import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
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
import { createWorkflowRunBinding } from "@hunter/flow-engine";
import { CapabilityProbeReceiptSchema, ControllerLeaseSchema, WorkspaceLeaseSchema, WriterLeaseSchema, createExternalOperation } from "@hunter/runtime-contracts";
import { SqliteOperationJournal } from "@hunter/storage";
import { FakeRuntime } from "@hunter/testkit";
import { describe, expect, it } from "vitest";

import { createSqliteApplicationServices } from "../src/services/sqlite-application-services.js";
import { DurableEventStream } from "../src/events/durable-event-stream.js";
import { validWorkflowInput } from "../../../packages/domain/src/workflow-test-fixtures.js";

const ids = {
  project: ProjectIdSchema.parse("prj_chain00001"), repository: RepositoryIdSchema.parse("rep_chain00001"),
  requirement: RequirementIdSchema.parse("req_chain00001"), requirementRevision: RequirementRevisionIdSchema.parse("rrv_chain00001"),
  change: ChangeIdSchema.parse("chg_chain00001"), changeRevision: ChangeRevisionIdSchema.parse("crv_chain00001"),
  plan: ExecutionPlanIdSchema.parse("epl_chain00001"), task: TaskIdSchema.parse("tsk_chain00001"),
  workflow: WorkflowRevisionIdSchema.parse("wfr_chain00001"), profile: AgentProfileIdSchema.parse("apr_chain00001"),
  root: RunIdSchema.parse("run_chain00001"), owner: LeaseOwnerIdSchema.parse("own_chain00001"), workspace: WorkspaceIdSchema.parse("wsp_chain00001"),
};

function oneStepWorkflow() {
  const input = validWorkflowInput();
  const step = input.steps[0]!;
  return createWorkflowRevision({ ...input, workflowRevisionId: ids.workflow, steps: [step], entryStepId: step.stepId, routes: [
    { routeId: "rte_chain_pass1", fromStepId: step.stepId, outcome: "passed", priority: 0, toStepId: null },
    { routeId: "rte_chain_fail1", fromStepId: step.stepId, outcome: "failed", priority: 0, toStepId: null },
  ], loops: [] });
}

function persistCatalog(database: DatabaseSync) {
  const project = createProject({ projectId: ids.project, name: "Chain", repositoryBindings: [{ repositoryId: ids.repository, role: "primary" }], deviceBindings: [{ deviceBindingId: DeviceBindingIdSchema.parse("dev_chain00001"), deviceId: DeviceIdSchema.parse("dvc_chain00001"), repositoryId: ids.repository, localPath: "C:/hunter-chain", availability: "available" }] });
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
  return CapabilityProbeReceiptSchema.parse({ schemaVersion: 1, probeReceiptId: CapabilityProbeReceiptIdSchema.parse("cpr_chain00001"), subject: { kind: "provider", providerId: RuntimeProviderIdSchema.parse("rtp_chain00001"), implementationVersion: "fake" }, platform: "windows", observedAt: "2026-07-21T00:00:00.000Z", validUntil: "2026-07-24T00:00:00.000Z", results: [{ capability: "launch", status: "SUPPORTED", evidenceId: EvidenceIdSchema.parse("evd_chain00001"), evidenceHash: "a".repeat(64) }] });
}

describe("Foundation chain", () => {
  it("publishes, runs parent/child, journals Fake effects, restarts, replays SSE, and succeeds only after verification", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "hunter-foundation-")), "foundation.sqlite");
    const fake = new FakeRuntime({ providerId: RuntimeProviderIdSchema.parse("rtp_chain00001"), implementationVersion: "fake", observedAt: "2026-07-22T10:00:00.000Z" });
    let database = new DatabaseSync(path);
    const definitions = persistCatalog(database);
    let services = createSqliteApplicationServices({ database, externalHandler: fake, installSecret: "foundation-secret-tests", allowedHosts: ["hunter-test.localhost"], allowedOrigins: ["app://hunter"], capabilityReceiptFor: () => capability(), now: () => new Date("2026-07-22T12:00:00.000Z") });
    const published = services.publishChange.execute({ changeRevisionId: ids.changeRevision, executionPlanId: ids.plan, tasks: [{ taskId: ids.task, title: "Chain", objective: "verify", acceptanceCriteria: ["green"], repositoryIds: [ids.repository], moduleScopes: ["packages"], dependsOn: [], readSet: [], writeSet: ["packages"], access: "write", workflowRevisionId: ids.workflow, defaultAgentProfileId: ids.profile, sessionPolicy: "new", workspacePolicy: { mode: "write", isolation: "worktree", reuse: false } }], expectedVersion: 0, idempotencyKey: "publish-chain-1" }, { actorId: "chain", correlationId: "chain" });
    services.startRun.execute({ runId: ids.root, executionPlanId: ids.plan, workflowRevisionId: ids.workflow, expectedVersion: 0, idempotencyKey: "start-chain-root" }, { actorId: "chain", correlationId: "chain" });
    const fanout = services.flowEngine.handle({ type: "ScheduleTaskFanOut", runId: ids.root, expectedVersion: services.flowStore.loadRun(ids.root)!.version, idempotencyKey: "fanout-chain", actor: { actorId: "chain", correlationId: "chain" } }).response as { children: Array<{ taskId: typeof ids.task; childRunId: ReturnType<typeof RunIdSchema.parse> }> };
    const childRunId = fanout.children[0]!.childRunId;
    const parent = services.flowStore.loadRun(ids.root)!.binding;
    const childBinding = createWorkflowRunBinding({ runId: childRunId, projectId: ids.project, changeRevisionId: ids.changeRevision, requirementRevisionIds: [ids.requirementRevision], workflowRevisionId: ids.workflow, policySnapshot: parent.policySnapshot, initialBudget: parent.initialBudget, subjectKind: "task", parentRunId: ids.root, taskId: ids.task, executionPlanId: ids.plan }, { parent, executionPlan: published.executionPlan, activeTaskIds: [], parentTerminal: false });
    services.flowEngine.handle({ type: "StartRun", binding: childBinding, expectedVersion: 0, idempotencyKey: "start-chain-child", actor: { actorId: "chain", correlationId: "chain" } });

    const common = { schemaVersion: 1 as const, ownerId: ids.owner, generation: 1, acquiredAt: "2026-07-22T10:00:00.000Z", expiresAt: "2027-07-22T10:30:00.000Z" };
    await services.leaseService.acquire(WorkspaceLeaseSchema.parse({ ...common, kind: "workspace", leaseId: WorkspaceLeaseIdSchema.parse("wsl_chain00001"), scope: { workspaceId: ids.workspace, deviceBindingId: DeviceBindingIdSchema.parse("dev_chain00001"), repositoryId: ids.repository, mode: "write", baselineRevision: "a".repeat(40) } }));
    await services.leaseService.acquire(WriterLeaseSchema.parse({ ...common, kind: "writer", leaseId: WriterLeaseIdSchema.parse("wrl_chain00001"), scope: { workspaceId: ids.workspace, worktreeId: WorktreeIdSchema.parse("wtr_chain00001") } }));
    await services.leaseService.acquire(ControllerLeaseSchema.parse({ ...common, kind: "controller", leaseId: ControllerLeaseIdSchema.parse("ctl_chain00001"), scope: { nativeSessionId: NativeSessionIdSchema.parse("ses_chain00001") } }));
    const attemptId = services.flowStore.loadRun(childRunId)!.steps[0]!.attempts[0]!.attemptId;
    expect(definitions.workflow.steps.find(({ stepId }) => stepId === services.flowStore.loadRun(childRunId)!.steps[0]!.stepId)!.permissionPolicy.decision).toBe("allow");
    const operation = (index: number) => createExternalOperation({ schemaVersion: 1, operationId: OperationIdSchema.parse(`opn_chain0000${index}`), projectId: ids.project, runId: childRunId, attemptId: AttemptIdSchema.parse(attemptId), operationVersion: 1, operationType: "session.launch", requestedCapabilities: ["launch"], payload: { agentProfileId: ids.profile, workspaceId: ids.workspace } });
    services.runtimeManager.requestAssignment({ commandId: "assign-chain-1", expectedVersion: services.flowStore.loadRun(childRunId)!.version, operation: operation(1) });
    expect(await services.operationWorker.runOnce()).toBe("completed");
    const oldCursor = services.eventReader.highWaterPosition();
    services.runtimeManager.requestAssignment({ commandId: "assign-chain-2", expectedVersion: services.flowStore.loadRun(childRunId)!.version, operation: operation(2) });
    database.close();

    database = new DatabaseSync(path);
    services = createSqliteApplicationServices({ database, externalHandler: fake, installSecret: "foundation-secret-tests", allowedHosts: ["hunter-test.localhost"], allowedOrigins: ["app://hunter"], capabilityReceiptFor: () => capability(), now: () => new Date("2026-07-22T12:00:00.000Z") });
    await services.recovery.run();
    expect(services.projectionRunner.snapshot("hunter").map(({ entityType }) => entityType).sort()).toEqual(expect.arrayContaining(["ChangeRevision", "ExecutionPlan", "Project", "RequirementRevision", "WorkflowRevision"]));
    expect(await services.operationWorker.runOnce()).toBe("completed");
    const replay = new DurableEventStream(services.eventReader).replay({ headerCursor: String(oldCursor), authorizedProjectIds: [ids.project] });
    expect(replay.status).toBe("ok");
    if (replay.status === "ok") expect(replay.events.length).toBeGreaterThan(0);
    expect(fake.nativeEffectCount).toBe(2);
    expect((database.prepare("SELECT COUNT(*) AS count FROM side_effect_receipts").get() as { count: number }).count).toBe(2);

    const actor = { actorId: "chain", correlationId: "chain" };
    services.flowEngine.handle({ type: "RecordExternalObservation", runId: ids.root, fact: "agent_returned", expectedVersion: services.flowStore.loadRun(ids.root)!.version, idempotencyKey: "root-return-chain", actor });
    services.flowEngine.handle({ type: "RecordVerifierResult", runId: ids.root, outcome: "passed", evidenceFingerprint: "c".repeat(64), expectedVersion: services.flowStore.loadRun(ids.root)!.version, idempotencyKey: "root-verify-chain", actor });
    expect(services.flowStore.loadRun(ids.root)!.status).not.toBe("succeeded");
    services.flowEngine.handle({ type: "RecordExternalObservation", runId: childRunId, fact: "agent_returned", expectedVersion: services.flowStore.loadRun(childRunId)!.version, idempotencyKey: "child-return-chain", actor });
    services.flowEngine.handle({ type: "RecordVerifierResult", runId: childRunId, outcome: "passed", evidenceFingerprint: "d".repeat(64), expectedVersion: services.flowStore.loadRun(childRunId)!.version, idempotencyKey: "child-verify-chain", actor });
    services.flowEngine.handle({ type: "ReconcileTaskChildren", runId: ids.root, expectedVersion: services.flowStore.loadRun(ids.root)!.version, idempotencyKey: "reconcile-chain", actor });
    expect(services.flowStore.loadRun(ids.root)!.status).toBe("succeeded");
    expect(services.flowStore.loadRun(ids.root)!.binding.bindingFingerprint).toBe(parent.bindingFingerprint);
    database.close();
  });
});
