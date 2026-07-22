import {
  ExecutionPlanIdSchema,
  ProjectIdSchema,
  RequirementIdSchema,
  RequirementRevisionIdSchema,
  RouteIdSchema,
  RunIdSchema,
  TaskIdSchema,
  WorkflowRevisionIdSchema,
  canonicalSha256,
  createExecutionPlan,
  createRequirementRevision,
  createWorkflowRevision,
  type WorkflowRevision,
} from "@hunter/domain";
import {
  FlowEngine,
  createWorkflowRunBinding,
  reduceFlowEvents,
  type FlowCommit,
  type FlowStore,
  type RunBudgetLimit,
  type WorkflowRunState,
} from "@hunter/flow-engine";
import { describe, expect, it } from "vitest";

import { loadHunterDefaultPack, type HunterDefaultWorkflowId } from "./load-pack.js";

const ids = {
  project: ProjectIdSchema.parse("prj_packflow01"),
  plan: ExecutionPlanIdSchema.parse("epl_packflow01"),
  rootRun: RunIdSchema.parse("run_packroot01"),
  task: TaskIdSchema.parse("tsk_packtask01"),
  requirement: RequirementRevisionIdSchema.parse("rrv_packflow01"),
};

const runBudget: RunBudgetLimit = {
  maxAttempts: 100,
  maxElapsedMs: 100_000_000,
  maxCost: 100,
  maxTokens: 100_000,
  maxLoopIterations: 20,
};

const actor = {
  actorId: "pack-flow-test",
  correlationId: "pack-flow-test",
  roles: ["change-owner"],
};

class ConsumerFlowStore implements FlowStore {
  readonly states = new Map<string, WorkflowRunState>();
  readonly receipts = new Map<
    string,
    { fingerprint: string; receipt: { commandId: string; response: unknown } }
  >();
  readonly commits: FlowCommit[] = [];

  loadRun(runId: string): WorkflowRunState | null {
    return this.states.get(runId) ?? null;
  }

  activeTaskIds(parentRunId: string) {
    return [...this.states.values()]
      .filter((state) => state.binding.parentRunId === parentRunId)
      .filter((state) => state.binding.subjectKind === "task")
      .filter((state) => !["succeeded", "failed", "canceled"].includes(state.status))
      .map((state) => (state.binding.subjectKind === "task" ? state.binding.taskId : ids.task));
  }

  childRuns(parentRunId: string) {
    return [...this.states.values()].filter((state) => state.binding.parentRunId === parentRunId);
  }

  getReceipt(commandId: string, requestFingerprint: string) {
    const existing = this.receipts.get(commandId);
    if (existing === undefined) return null;
    if (existing.fingerprint !== requestFingerprint) throw new Error("IDEMPOTENCY_KEY_REUSED");
    return existing.receipt;
  }

  commit(input: FlowCommit) {
    const current = this.states.get(input.runId) ?? null;
    if ((current?.version ?? 0) !== input.expectedVersion) throw new Error("EXPECTED_VERSION_CONFLICT");
    const next = reduceFlowEvents(current, input.events);
    const receipt = { commandId: input.commandId, response: input.response };
    this.states.set(input.runId, next);
    this.commits.push(input);
    this.receipts.set(input.commandId, { fingerprint: input.requestFingerprint, receipt });
    return receipt;
  }
}

function workflow(workflowId: HunterDefaultWorkflowId) {
  return loadHunterDefaultPack().workflows.find((candidate) => candidate.workflowId === workflowId)!;
}

function executionPlan(taskWorkflowRevisionId: string) {
  return createExecutionPlan({
    executionPlanId: ids.plan,
    projectId: ids.project,
    changeRevisionId: "crv_packflow01",
    requirementRevisionIds: [ids.requirement],
    tasks: [
      {
        taskId: ids.task,
        title: "Pack consumer Task",
        objective: "Exercise the published workflow",
        acceptanceCriteria: ["FlowEngine reaches the expected conclusion"],
        repositoryIds: ["rep_packflow01"],
        moduleScopes: ["workflow-packs/hunter-default"],
        dependsOn: [],
        readSet: [],
        writeSet: ["workflow-packs/hunter-default"],
        access: "write",
        workflowRevisionId: taskWorkflowRevisionId,
        defaultAgentProfileId: "apr_packflow01",
        sessionPolicy: "new",
        workspacePolicy: { mode: "write", isolation: "worktree", reuse: false },
      },
    ],
    publishedAt: "2026-07-23T00:00:00.000Z",
  });
}

function requirementRevision() {
  return createRequirementRevision({
    requirementId: RequirementIdSchema.parse("req_packflow01"),
    revisionId: ids.requirement,
    projectId: ids.project,
    title: "Workflow pack contract",
    body: "Exercise the default workflow through FlowEngine",
    acceptanceCriteria: ["Published workflow is executable"],
    constraints: [],
    status: "approved",
    approvedAt: "2026-07-23T00:00:00.000Z",
  });
}

function terminalChildWorkflow(): WorkflowRevision {
  const source = workflow("hunter.task-delivery");
  const complete = source.steps.find(({ stepId }) => stepId === "stp_task_complete_v1")!;
  return createWorkflowRevision({
    workflowRevisionId: WorkflowRevisionIdSchema.parse("wfr_pack_terminal_child"),
    title: "Pack test terminal child",
    status: "published",
    entryStepId: complete.stepId,
    steps: [complete],
    routes: [
      {
        routeId: RouteIdSchema.parse("rte_pack_child_passed"),
        fromStepId: complete.stepId,
        outcome: "passed",
        priority: 0,
        toStepId: null,
      },
      {
        routeId: RouteIdSchema.parse("rte_pack_child_failed"),
        fromStepId: complete.stepId,
        outcome: "failed",
        priority: 0,
        toStepId: null,
      },
    ],
    loops: [],
    publishedAt: "2026-07-23T00:00:00.000Z",
  });
}

function isolateLoopCost(
  workflowRevision: WorkflowRevision & { readonly workflowId?: unknown },
): WorkflowRevision {
  const { workflowFingerprint, workflowId, ...revision } = workflowRevision;
  void workflowFingerprint;
  void workflowId;
  return createWorkflowRevision({
    ...revision,
    loops: revision.loops.map((loop) => ({
      ...loop,
      maxIterations: 20,
      maxElapsedMs: 100_000_000,
      stagnation: {
        maxSameFailureFingerprint: 20,
        maxNoDiffIterations: 20,
        maxVerifierErrors: 20,
      },
    })),
  });
}

function startRoot(entryWorkflow: WorkflowRevision, taskWorkflow: WorkflowRevision = entryWorkflow) {
  const plan = executionPlan(taskWorkflow.workflowRevisionId);
  const store = new ConsumerFlowStore();
  const revisions = new Map<string, Readonly<WorkflowRevision>>(
    [entryWorkflow, taskWorkflow].map((revision) => [revision.workflowRevisionId, revision]),
  );
  const engine = new FlowEngine(store, {
    getWorkflowRevision: (workflowRevisionId) => revisions.get(workflowRevisionId) ?? null,
    getExecutionPlan: (executionPlanId) => (executionPlanId === plan.executionPlanId ? plan : null),
    getRequirementRevision: (requirementRevisionId) =>
      requirementRevisionId === ids.requirement ? requirementRevision() : null,
  });
  const binding = createWorkflowRunBinding({
    runId: ids.rootRun,
    projectId: ids.project,
    changeRevisionId: plan.changeRevisionId,
    requirementRevisionIds: plan.requirementRevisionIds,
    workflowRevisionId: entryWorkflow.workflowRevisionId,
    policySnapshot: { snapshotHash: "a".repeat(64), policyVersion: 1 },
    initialBudget: runBudget,
    subjectKind: "change",
    parentRunId: null,
    taskId: null,
    executionPlanId: plan.executionPlanId,
    taskGraphFingerprint: plan.taskGraphFingerprint,
  });
  engine.handle({
    type: "StartRun",
    binding,
    expectedVersion: 0,
    idempotencyKey: "start-root",
    actor,
  });
  return { store, engine, plan, binding };
}

function state(store: ConsumerFlowStore, runId = ids.rootRun) {
  return store.loadRun(runId)!;
}

function verifyActive(
  harness: ReturnType<typeof startRoot>,
  runId: ReturnType<typeof RunIdSchema.parse>,
  key: string,
  outcome: "passed" | "failed",
  options: { failureFingerprint?: string; diffFingerprint?: string } = {},
) {
  harness.engine.handle({
    type: "RecordExternalObservation",
    runId,
    fact: "agent_returned",
    expectedVersion: state(harness.store, runId).version,
    idempotencyKey: `${key}-returned`,
    actor,
  });
  const returned = state(harness.store, runId);
  const active = [...returned.steps].reverse().find(({ conclusion }) => conclusion === "active")!;
  return harness.engine.handle({
    type: "RecordVerifierResult",
    runId,
    outcome,
    evidenceFingerprint: canonicalSha256(key),
    failureFingerprint: options.failureFingerprint,
    diffFingerprint: options.diffFingerprint,
    humanReceipt:
      active.stepId === "stp_change_approve_plan_v1"
        ? { contentHash: active.fixedContentHash, actorId: actor.actorId }
        : undefined,
    expectedVersion: returned.version,
    idempotencyKey: `${key}-verified`,
    actor,
  });
}

function startTaskChild(harness: ReturnType<typeof startRoot>, taskWorkflow: WorkflowRevision) {
  const scheduled = harness.engine.handle({
    type: "ScheduleTaskFanOut",
    runId: ids.rootRun,
    expectedVersion: state(harness.store).version,
    idempotencyKey: "schedule-task",
    actor,
  }).response as { children: Array<{ childRunId: ReturnType<typeof RunIdSchema.parse>; budget: RunBudgetLimit }> };
  const child = scheduled.children[0]!;
  const binding = createWorkflowRunBinding(
    {
      runId: child.childRunId,
      projectId: ids.project,
      changeRevisionId: harness.plan.changeRevisionId,
      requirementRevisionIds: harness.plan.requirementRevisionIds,
      workflowRevisionId: taskWorkflow.workflowRevisionId,
      policySnapshot: harness.binding.policySnapshot,
      initialBudget: child.budget,
      subjectKind: "task",
      parentRunId: ids.rootRun,
      taskId: ids.task,
      executionPlanId: harness.plan.executionPlanId,
    },
    {
      parent: harness.binding,
      executionPlan: harness.plan,
      activeTaskIds: [],
      parentTerminal: false,
      childBudgetAllocation: child.budget,
    },
  );
  harness.engine.handle({
    type: "StartRun",
    binding,
    expectedVersion: 0,
    idempotencyKey: "start-task",
    actor,
  });
  return binding.runId;
}

describe("default pack as a FlowEngine consumer", () => {
  it("concludes a Task child after its complete verifier passes", () => {
    const task = workflow("hunter.task-delivery");
    const harness = startRoot(workflow("hunter.change-delivery"), task);
    const taskRunId = startTaskChild(harness, task);

    for (const key of ["context", "implement", "test", "review", "complete"]) {
      verifyActive(harness, taskRunId, key, "passed");
    }

    expect(state(harness.store, taskRunId).status).toBe("succeeded");
  });

  it("concludes a resolved root Change after knowledge ingest passes", () => {
    const root = workflow("hunter.change-delivery");
    const childWorkflow = terminalChildWorkflow();
    const harness = startRoot(root, childWorkflow);
    const taskRunId = startTaskChild(harness, childWorkflow);
    verifyActive(harness, taskRunId, "child-complete", "passed");
    harness.engine.handle({
      type: "ReconcileTaskChildren",
      runId: ids.rootRun,
      expectedVersion: state(harness.store).version,
      idempotencyKey: "accept-task",
      actor,
    });

    for (const key of ["plan", "approve", "dispatch", "integrate", "archive", "ingest"]) {
      verifyActive(harness, ids.rootRun, key, "passed");
    }

    expect(state(harness.store).status).toBe("succeeded");
  });

  it("routes a canceled plan approval to archive without canceling the root Run", () => {
    const harness = startRoot(workflow("hunter.change-delivery"));
    verifyActive(harness, ids.rootRun, "plan", "passed");
    harness.engine.handle({
      type: "RecordExternalObservation",
      runId: ids.rootRun,
      fact: "agent_returned",
      expectedVersion: state(harness.store).version,
      idempotencyKey: "approve-cancel-returned",
      actor,
    });
    const returned = state(harness.store);
    const gate = returned.steps.find(({ conclusion }) => conclusion === "active")!;
    harness.engine.handle({
      type: "RecordVerifierResult",
      runId: ids.rootRun,
      outcome: "canceled",
      evidenceFingerprint: canonicalSha256("approve-canceled"),
      humanReceipt: { contentHash: gate.fixedContentHash, actorId: actor.actorId },
      expectedVersion: returned.version,
      idempotencyKey: "approve-canceled",
      actor,
    });

    const routed = state(harness.store);
    expect(routed.status).toBe("running");
    expect(routed.steps.find(({ stepId }) => stepId === "stp_change_approve_plan_v1")?.conclusion).toBe("canceled");
    expect(routed.steps.find(({ stepId }) => stepId === "stp_change_archive_v1")?.conclusion).toBe("active");
    expect(harness.store.commits.at(-1)!.events).toContainEqual(expect.objectContaining({
      type: "RouteSelected",
      outcome: "canceled",
    }));
    expect(harness.store.commits.at(-1)!.events).not.toContainEqual(expect.objectContaining({
      type: "RunConcluded",
      status: "canceled",
    }));
  });

  it("uses FlowEngine's verifier progress source for the root integration loop", () => {
    const harness = startRoot(workflow("hunter.change-delivery"));
    for (const key of ["plan", "approve", "dispatch"]) verifyActive(harness, ids.rootRun, key, "passed");

    expect(() =>
      verifyActive(harness, ids.rootRun, "integrate-failed", "failed", {
        failureFingerprint: "integration-failure-1",
      }),
    ).not.toThrow();
    expect(harness.store.commits.at(-1)!.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "LoopActivated" }),
        expect.objectContaining({ type: "StepActivated", stepId: "stp_change_dispatch_tasks_v1" }),
      ]),
    );
  });

  it("uses FlowEngine's evidence progress source for the test loop", () => {
    const harness = startRoot(workflow("hunter.task-delivery"));
    for (const key of ["context", "implement"]) verifyActive(harness, ids.rootRun, key, "passed");

    expect(() =>
      verifyActive(harness, ids.rootRun, "test-failed", "failed", {
        failureFingerprint: "test-failure-1",
      }),
    ).not.toThrow();
    expect(harness.store.commits.at(-1)!.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "LoopActivated" }),
        expect.objectContaining({ type: "StepActivated", stepId: "stp_task_implement_v1" }),
      ]),
    );
  });

  it("uses FlowEngine's workspace diff progress source for the review loop", () => {
    const harness = startRoot(workflow("hunter.task-delivery"));
    for (const key of ["context", "implement", "test"]) verifyActive(harness, ids.rootRun, key, "passed");

    expect(() =>
      verifyActive(harness, ids.rootRun, "review-failed", "failed", {
        failureFingerprint: "review-failure-1",
        diffFingerprint: "review-diff-1",
      }),
    ).not.toThrow();
    expect(harness.store.commits.at(-1)!.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "LoopActivated" }),
        expect.objectContaining({ type: "StepActivated", stepId: "stp_task_implement_v1" }),
      ]),
    );
  });

  it("stops the root integration loop on cost before creating a third dispatch Attempt", () => {
    const harness = startRoot(isolateLoopCost(workflow("hunter.change-delivery")));
    for (const key of ["plan", "approve", "dispatch"]) verifyActive(harness, ids.rootRun, key, "passed");
    expect(state(harness.store).status).toBe("running");

    verifyActive(harness, ids.rootRun, "integrate-cost-1", "failed", {
      failureFingerprint: "integration-cost-1",
    });
    expect(state(harness.store).status).toBe("running");
    verifyActive(harness, ids.rootRun, "dispatch-cost-2", "passed");
    verifyActive(harness, ids.rootRun, "integrate-cost-2", "failed", {
      failureFingerprint: "integration-cost-2",
    });

    const concluded = state(harness.store);
    const dispatch = concluded.steps.find(({ stepId }) => stepId === "stp_change_dispatch_tasks_v1")!;
    expect(concluded.status).toBe("needs_attention");
    expect(dispatch.attempts).toHaveLength(2);
    expect(harness.store.commits.at(-1)!.events.some(({ type }) => type === "StepActivated")).toBe(false);
  });

  it("stops the test loop on cost before creating a fourth implementation Attempt", () => {
    const harness = startRoot(isolateLoopCost(workflow("hunter.task-delivery")));
    for (const key of ["context", "implement"]) verifyActive(harness, ids.rootRun, key, "passed");
    expect(state(harness.store).status).toBe("running");

    for (let index = 1; index <= 3; index += 1) {
      verifyActive(harness, ids.rootRun, `test-cost-${index}`, "failed", {
        failureFingerprint: `test-cost-${index}`,
      });
      if (index < 3) expect(state(harness.store).status).toBe("running");
      if (index < 3) verifyActive(harness, ids.rootRun, `implement-after-test-${index}`, "passed");
    }

    const concluded = state(harness.store);
    const implement = concluded.steps.find(({ stepId }) => stepId === "stp_task_implement_v1")!;
    expect(concluded.status).toBe("needs_attention");
    expect(implement.attempts).toHaveLength(3);
    expect(harness.store.commits.at(-1)!.events.some(({ type }) => type === "StepActivated")).toBe(false);
  });

  it("stops the review loop on cost before creating a fourth implementation Attempt", () => {
    const harness = startRoot(isolateLoopCost(workflow("hunter.task-delivery")));
    for (const key of ["context", "implement", "test"]) verifyActive(harness, ids.rootRun, key, "passed");
    expect(state(harness.store).status).toBe("running");

    for (let index = 1; index <= 3; index += 1) {
      verifyActive(harness, ids.rootRun, `review-cost-${index}`, "failed", {
        failureFingerprint: `review-cost-${index}`,
        diffFingerprint: `review-diff-${index}`,
      });
      if (index < 3) expect(state(harness.store).status).toBe("running");
      if (index < 3) {
        verifyActive(harness, ids.rootRun, `implement-after-review-${index}`, "passed");
        verifyActive(harness, ids.rootRun, `test-after-review-${index}`, "passed");
      }
    }

    const concluded = state(harness.store);
    const implement = concluded.steps.find(({ stepId }) => stepId === "stp_task_implement_v1")!;
    expect(concluded.status).toBe("needs_attention");
    expect(implement.attempts).toHaveLength(3);
    expect(harness.store.commits.at(-1)!.events.some(({ type }) => type === "StepActivated")).toBe(false);
  });
});
