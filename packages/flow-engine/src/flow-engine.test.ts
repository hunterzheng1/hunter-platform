import {
  ExecutionPlanIdSchema,
  OperationIdSchema,
  ProjectIdSchema,
  RequirementIdSchema,
  RequirementRevisionIdSchema,
  RouteIdSchema,
  RunIdSchema,
  StepRunIdSchema,
  TaskIdSchema,
  WorkflowRevisionIdSchema,
  createExecutionPlan,
  createRequirementRevision,
  createWorkflowRevision,
  canonicalSha256,
  type ExecutionPlan,
  type WorkflowRevision,
} from "@hunter/domain";
import { createExternalOperation } from "@hunter/runtime-contracts";
import { describe, expect, it } from "vitest";

import type { FlowCommit, FlowStore } from "./flow-engine.js";
import { FlowEngine } from "./flow-engine.js";
import { reduceFlowEvents, type WorkflowRunState } from "./state.js";
import { createWorkflowRunBinding } from "./run-binding.js";
import { remainingRunBudget } from "./run-budget.js";
import { MAX_EXECUTION_PLAN_TASKS } from "./task-scheduler.js";
import { validWorkflowInput } from "../../domain/src/workflow-test-fixtures.js";

const ids = {
  project: ProjectIdSchema.parse("prj_platform01"),
  plan: ExecutionPlanIdSchema.parse("epl_plan0001"),
  rootRun: RunIdSchema.parse("run_root00001"),
  childRun: RunIdSchema.parse("run_child0001"),
  task: TaskIdSchema.parse("tsk_task0001"),
  workflow: WorkflowRevisionIdSchema.parse("wfr_workflow01"),
  dependency: TaskIdSchema.parse("tsk_dependency01"),
  dependent: TaskIdSchema.parse("tsk_dependency02"),
  compensation: TaskIdSchema.parse("tsk_compensate1"),
};

const requirements = ["rrv_revision01"] as const;
const policySnapshot = { snapshotHash: "a".repeat(64), policyVersion: 1 } as const;
const initialBudget = {
  maxAttempts: 5,
  maxElapsedMs: 60_000,
  maxCost: 100,
  maxTokens: 10_000,
  maxLoopIterations: 3,
} as const;

function requirementRevision(revisionId: string) {
  return createRequirementRevision({
    requirementId: RequirementIdSchema.parse("req_flow00001"),
    revisionId: RequirementRevisionIdSchema.parse(revisionId),
    projectId: ids.project,
    title: "Flow requirement",
    body: "Frozen input",
    acceptanceCriteria: ["verified"],
    constraints: [],
    status: "approved",
    approvedAt: revisionId === "rrv_revision01" ? "2026-07-21T00:00:00.000Z" : "2026-07-22T00:00:00.000Z",
  });
}

function rootBinding() {
  return createWorkflowRunBinding({
    runId: ids.rootRun,
    projectId: ids.project,
    changeRevisionId: "crv_revision01",
    requirementRevisionIds: requirements,
    workflowRevisionId: ids.workflow,
    policySnapshot,
    initialBudget,
    subjectKind: "change",
    parentRunId: null,
    taskId: null,
    executionPlanId: ids.plan,
    taskGraphFingerprint: "b".repeat(64),
  });
}

function executionPlan() {
  return createExecutionPlan({
    executionPlanId: ids.plan,
    projectId: ids.project,
    changeRevisionId: "crv_revision01",
    requirementRevisionIds: requirements,
    tasks: [
      {
        taskId: ids.task,
        title: "Task",
        objective: "Implement",
        acceptanceCriteria: ["verified"],
        repositoryIds: ["rep_primary01"],
        moduleScopes: ["packages/flow-engine"],
        dependsOn: [],
        readSet: [],
        writeSet: ["packages/flow-engine"],
        access: "write",
        workflowRevisionId: ids.workflow,
        defaultAgentProfileId: "apr_profile01",
        sessionPolicy: "new",
        workspacePolicy: { mode: "write", isolation: "worktree", reuse: false },
      },
    ],
    publishedAt: "2026-07-22T01:00:00.000Z",
  });
}

function dependencyPlan(includeCompensation = false) {
  const task = (taskId: typeof ids.task, dependsOn: readonly typeof ids.task[] = []) => ({
    taskId,
    title: taskId,
    objective: "Execute dependency policy",
    acceptanceCriteria: ["verified"],
    repositoryIds: ["rep_primary01"],
    moduleScopes: ["packages/flow-engine"],
    dependsOn,
    readSet: [],
    writeSet: ["packages/flow-engine"],
    access: "write" as const,
    workflowRevisionId: ids.workflow,
    defaultAgentProfileId: "apr_profile01",
    sessionPolicy: "new" as const,
    workspacePolicy: { mode: "write" as const, isolation: "worktree" as const, reuse: false },
  });
  return createExecutionPlan({
    executionPlanId: ids.plan,
    projectId: ids.project,
    changeRevisionId: "crv_revision01",
    requirementRevisionIds: requirements,
    tasks: [task(ids.dependent, [ids.dependency]), ...(includeCompensation ? [task(ids.compensation, [ids.dependency])] : []), task(ids.dependency)],
    publishedAt: "2026-07-22T01:00:00.000Z",
  });
}

describe("WorkflowRunBinding", () => {
  it("deeply freezes a valid root binding and computes its fingerprint", () => {
    const binding = rootBinding();
    expect(binding.subjectKind).toBe("change");
    expect(binding.parentRunId).toBeNull();
    expect(binding.taskId).toBeNull();
    expect(binding.bindingFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.policySnapshot)).toBe(true);
  });

  it.each([
    ["root with parent", { ...rootBinding(), parentRunId: ids.childRun }],
    ["root with Task", { ...rootBinding(), taskId: ids.task }],
    ["root without Requirements", { ...rootBinding(), requirementRevisionIds: [] }],
  ])("rejects %s", (_label, input) => {
    expect(() => createWorkflowRunBinding(input)).toThrow();
  });

  it("validates Task child ownership and exact inherited context", () => {
    const parent = rootBinding();
    const plan = executionPlan();
    const child = createWorkflowRunBinding(
      {
        runId: ids.childRun,
        projectId: parent.projectId,
        changeRevisionId: parent.changeRevisionId,
        requirementRevisionIds: parent.requirementRevisionIds,
        workflowRevisionId: ids.workflow,
        policySnapshot: parent.policySnapshot,
        initialBudget: parent.initialBudget,
        subjectKind: "task",
        parentRunId: parent.runId,
        taskId: ids.task,
        executionPlanId: parent.executionPlanId,
      },
      { parent, executionPlan: plan, activeTaskIds: [], parentTerminal: false, childBudgetAllocation: parent.initialBudget },
    );
    expect(child.subjectKind).toBe("task");
    expect(child.taskId).toBe(ids.task);
  });

  it.each([
    ["orphan child", undefined, executionPlan(), [], ids.task],
    ["Task not in plan", rootBinding(), executionPlan(), [], TaskIdSchema.parse("tsk_unknown01")],
    ["second active child", rootBinding(), executionPlan(), [ids.task], ids.task],
  ])("rejects %s", (_label, parent, plan, activeTaskIds, taskId) => {
    expect(() =>
      createWorkflowRunBinding(
        {
          runId: ids.childRun,
          projectId: ids.project,
          changeRevisionId: "crv_revision01",
          requirementRevisionIds: requirements,
          workflowRevisionId: ids.workflow,
          policySnapshot,
          initialBudget,
          subjectKind: "task",
          parentRunId: ids.rootRun,
          taskId,
          executionPlanId: ids.plan,
        },
        { parent, executionPlan: plan, activeTaskIds, parentTerminal: false },
      ),
    ).toThrow();
  });

  it("rejects child context drift and child start after terminal parent", () => {
    const parent = rootBinding();
    const base = {
      runId: ids.childRun,
      projectId: ids.project,
      changeRevisionId: "crv_revision01",
      requirementRevisionIds: requirements,
      workflowRevisionId: ids.workflow,
      policySnapshot,
      initialBudget,
      subjectKind: "task" as const,
      parentRunId: ids.rootRun,
      taskId: ids.task,
      executionPlanId: ids.plan,
    };
    expect(() =>
      createWorkflowRunBinding(
        { ...base, projectId: ProjectIdSchema.parse("prj_platform02") },
        { parent, executionPlan: executionPlan(), activeTaskIds: [], parentTerminal: false },
      ),
    ).toThrow(/CONTEXT/u);
    expect(() =>
      createWorkflowRunBinding(base, {
        parent,
        executionPlan: executionPlan(),
        activeTaskIds: [],
        parentTerminal: true,
      }),
    ).toThrow(/TERMINAL/u);
  });

  it("rejects subflow with a Task and accepts a parent Step reference", () => {
    const parent = rootBinding();
    const parentStepRunId = StepRunIdSchema.parse("spr_parent0001");
    const base = {
      runId: ids.childRun,
      projectId: parent.projectId,
      changeRevisionId: parent.changeRevisionId,
      requirementRevisionIds: parent.requirementRevisionIds,
      workflowRevisionId: ids.workflow,
      policySnapshot: parent.policySnapshot,
      initialBudget: parent.initialBudget,
      subjectKind: "subflow" as const,
      parentRunId: parent.runId,
      taskId: null,
      executionPlanId: parent.executionPlanId,
      parentStepRunId,
    };
    expect(
      createWorkflowRunBinding(base, {
        parent,
        executionPlan: executionPlan(),
        activeTaskIds: [],
        parentTerminal: false,
        childBudgetAllocation: parent.initialBudget,
      }).subjectKind,
    ).toBe("subflow");
    expect(() =>
      createWorkflowRunBinding(
        { ...base, taskId: ids.task },
        { parent, executionPlan: executionPlan(), activeTaskIds: [], parentTerminal: false },
      ),
    ).toThrow();
  });
});

class TestFlowStore implements FlowStore {
  readonly states = new Map<string, WorkflowRunState>();
  readonly receipts = new Map<string, { fingerprint: string; receipt: { commandId: string; response: unknown } }>();
  readonly commits: FlowCommit[] = [];

  loadRun(runId: string): WorkflowRunState | null {
    return this.states.get(runId) ?? null;
  }

  activeTaskIds(parentRunId: string) {
    return [...this.states.values()]
      .filter((state) => state.binding.parentRunId === parentRunId && state.binding.subjectKind === "task")
      .filter((state) => !["succeeded", "failed", "canceled"].includes(state.status))
      .flatMap((state) => state.binding.subjectKind === "task" ? [state.binding.taskId] : []);
  }

  childRuns(parentRunId: string) {
    return [...this.states.values()].filter((state) => state.binding.parentRunId === parentRunId);
  }

  getReceipt(commandId: string, fingerprint: string) {
    const existing = this.receipts.get(commandId);
    if (existing === undefined) return null;
    if (existing.fingerprint !== fingerprint) throw new Error("IDEMPOTENCY_KEY_REUSED");
    return existing.receipt;
  }

  commit(input: FlowCommit) {
    const existing = this.receipts.get(input.commandId);
    if (existing !== undefined) {
      if (existing.fingerprint !== input.requestFingerprint) throw new Error("IDEMPOTENCY_KEY_REUSED");
      return existing.receipt;
    }
    const current = this.states.get(input.runId) ?? null;
    const version = current?.version ?? 0;
    if (version !== input.expectedVersion) throw new Error("EXPECTED_VERSION_CONFLICT");
    const next = reduceFlowEvents(current, input.events);
    this.commits.push(input);
    this.states.set(input.runId, next);
    const receipt = { commandId: input.commandId, response: input.response };
    this.receipts.set(input.commandId, { fingerprint: input.requestFingerprint, receipt });
    return receipt;
  }
}

function singleStepWorkflow(loop = false): WorkflowRevision {
  const input = validWorkflowInput();
  const implement = input.steps[0]!;
  input.steps = [implement];
  input.entryStepId = implement.stepId;
  input.routes = [
    {
      routeId: RouteIdSchema.parse("rte_single_pass"),
      fromStepId: implement.stepId,
      outcome: "passed",
      priority: 0,
      toStepId: null,
    },
    {
      routeId: RouteIdSchema.parse(loop ? "rte_single_loop" : "rte_single_fail"),
      fromStepId: implement.stepId,
      outcome: "failed",
      priority: 0,
      toStepId: loop ? implement.stepId : null,
    },
  ];
  input.loops = loop
    ? [
        {
          ...validWorkflowInput().loops[0]!,
          routeId: RouteIdSchema.parse("rte_single_loop"),
          fromStepId: implement.stepId,
          toStepId: implement.stepId,
          maxIterations: 2,
        },
      ]
    : [];
  return createWorkflowRevision(input);
}

function humanGateWorkflow(): WorkflowRevision {
  const input = validWorkflowInput();
  const gate = input.steps[3]!;
  input.steps = [gate];
  input.entryStepId = gate.stepId;
  input.routes = [
    { routeId: RouteIdSchema.parse("rte_gate_pass"), fromStepId: gate.stepId, outcome: "passed", priority: 0, toStepId: null },
    { routeId: RouteIdSchema.parse("rte_gate_reject"), fromStepId: gate.stepId, outcome: "rejected", priority: 0, toStepId: null },
  ];
  input.loops = [];
  return createWorkflowRevision(input);
}

function humanGateCanceledWorkflow(): WorkflowRevision {
  const input = validWorkflowInput();
  const archive = input.steps[1]!;
  const gate = input.steps[3]!;
  input.steps = [gate, archive];
  input.entryStepId = gate.stepId;
  input.routes = [
    { routeId: RouteIdSchema.parse("rte_gate_cancel"), fromStepId: gate.stepId, outcome: "canceled", priority: 0, toStepId: archive.stepId },
    { routeId: RouteIdSchema.parse("rte_gate_pass"), fromStepId: gate.stepId, outcome: "passed", priority: 0, toStepId: null },
    { routeId: RouteIdSchema.parse("rte_archive_pass"), fromStepId: archive.stepId, outcome: "passed", priority: 0, toStepId: null },
    { routeId: RouteIdSchema.parse("rte_archive_fail"), fromStepId: archive.stepId, outcome: "failed", priority: 0, toStepId: null },
  ];
  input.loops = [];
  return createWorkflowRevision(input);
}

function subflowOnlyWorkflow(): WorkflowRevision {
  const input = validWorkflowInput();
  const subflow = input.steps[2]!;
  input.steps = [subflow];
  input.entryStepId = subflow.stepId;
  input.routes = [
    { routeId: RouteIdSchema.parse("rte_sub_only_ok"), fromStepId: subflow.stepId, outcome: "passed", priority: 0, toStepId: null },
    { routeId: RouteIdSchema.parse("rte_sub_only_no"), fromStepId: subflow.stepId, outcome: "failed", priority: 0, toStepId: null },
    { routeId: RouteIdSchema.parse("rte_sub_only_x"), fromStepId: subflow.stepId, outcome: "canceled", priority: 0, toStepId: null },
  ];
  input.loops = [];
  return createWorkflowRevision(input);
}

function childAgentWorkflow(): WorkflowRevision {
  const input = validWorkflowInput();
  const agent = input.steps[0]!;
  input.workflowRevisionId = ids.workflow;
  input.steps = [agent];
  input.entryStepId = agent.stepId;
  input.routes = [
    { routeId: RouteIdSchema.parse("rte_child_pass1"), fromStepId: agent.stepId, outcome: "passed", priority: 0, toStepId: null },
    { routeId: RouteIdSchema.parse("rte_child_fail1"), fromStepId: agent.stepId, outcome: "failed", priority: 0, toStepId: null },
  ];
  input.loops = [];
  return createWorkflowRevision(input);
}

function engineHarness(
  workflow = singleStepWorkflow(),
  now: () => Date = () => new Date("2026-07-22T10:00:00.000Z"),
  plan: Readonly<ExecutionPlan> = executionPlan(),
) {
  const store = new TestFlowStore();
  const engine = new FlowEngine(store, {
    getWorkflowRevision: () => workflow,
    getExecutionPlan: () => plan,
    getRequirementRevision: (revisionId: ReturnType<typeof RequirementRevisionIdSchema.parse>) => requirementRevision(revisionId),
  }, now);
  const actor = { actorId: "flow-test", correlationId: "flow-test", roles: ["project-approver"] };
  const { bindingFingerprint: ignoredFingerprint, ...root } = rootBinding();
  void ignoredFingerprint;
  engine.handle({
    type: "StartRun",
    binding: createWorkflowRunBinding({
      ...root,
      workflowRevisionId: workflow.workflowRevisionId,
      taskGraphFingerprint: plan.taskGraphFingerprint,
    }),
    expectedVersion: 0,
    idempotencyKey: "start-flow-0001",
    actor,
  });
  return { store, engine, actor, runId: ids.rootRun };
}

function current(store: TestFlowStore): WorkflowRunState {
  return store.loadRun(ids.rootRun)!;
}

describe("authoritative FlowEngine", () => {
  it("never concludes a root Run before every frozen Task has an explicit disposition", () => {
    const { store, engine, actor, runId } = engineHarness();
    engine.handle({ type: "RecordExternalObservation", runId, fact: "agent_returned", expectedVersion: current(store).version, idempotencyKey: "root-no-fanout-return", actor });
    engine.handle({ type: "RecordVerifierResult", runId, outcome: "passed", evidenceFingerprint: "9".repeat(64), expectedVersion: current(store).version, idempotencyKey: "root-no-fanout-verify", actor });
    expect(current(store).status).toBe("paused");
  });

  it("allows only one durable assignment for an Attempt", () => {
    const { store, engine, actor, runId } = engineHarness();
    const attemptId = current(store).steps[0]!.attempts[0]!.attemptId;
    const operation = (suffix: string) => createExternalOperation({
      schemaVersion: 1,
      operationId: OperationIdSchema.parse(`opn_assignment${suffix}`),
      projectId: ids.project,
      runId,
      attemptId,
      operationVersion: 1,
      operationType: "session.launch",
      requestedCapabilities: ["launch"],
      payload: { agentProfileId: "apr_profile01", workspaceId: "wsp_assign0001" },
    });
    engine.handle({ type: "AssignAttempt", runId, operation: operation("01"), capabilityProbeReceiptId: "cpr_assign0001", leaseIds: ["wsl_assign0001"], expectedVersion: current(store).version, idempotencyKey: "assign-once", actor });
    expect(current(store).steps[0]!.attempts[0]!.assignment).toMatchObject({ operationId: "opn_assignment01" });
    expect(() => engine.handle({ type: "AssignAttempt", runId, operation: operation("02"), capabilityProbeReceiptId: "cpr_assign0001", leaseIds: ["wsl_assign0001"], expectedVersion: current(store).version, idempotencyKey: "assign-twice", actor })).toThrow(/ATTEMPT_ALREADY_ASSIGNED/u);
  });
  it("does not conclude success from Agent return, process exit, terminal idle, or window open", () => {
    const { store, engine, actor, runId } = engineHarness();
    for (const [index, fact] of [
      "process_exited",
      "terminal_idle",
      "native_surface_opened",
      "agent_returned",
    ].entries()) {
      engine.handle({
        type: "RecordExternalObservation",
        runId,
        fact: fact as never,
        expectedVersion: current(store).version,
        idempotencyKey: `observation-${index}`,
        actor,
      });
      expect(current(store).steps[0]?.conclusion).toBe("active");
      expect(current(store).status).toBe("running");
    }
    expect(current(store).steps[0]?.executionStatus).toBe("returned");
    expect(current(store).steps[0]?.verificationStatus).toBe("pending");
  });

  it("records provider-neutral recovery observations without inferring Step success", () => {
    const alive = engineHarness();
    alive.engine.handle({ type: "RecordExternalObservation", runId: alive.runId, fact: "session_running", expectedVersion: current(alive.store).version, idempotencyKey: "recovery-alive", actor: alive.actor });
    alive.engine.handle({ type: "RecordRecoveryFacts", runId: alive.runId, facts: [{ kind: "session", status: "observed", reason: "durable_observe_receipt" }], expectedVersion: current(alive.store).version, idempotencyKey: "recovery-alive-fact", actor: alive.actor });
    expect(current(alive.store)).toMatchObject({ status: "running", steps: [{ executionStatus: "running", conclusion: "active" }] });

    const missing = engineHarness();
    missing.engine.handle({ type: "RecordExternalObservation", runId: missing.runId, fact: "session_missing", expectedVersion: current(missing.store).version, idempotencyKey: "recovery-missing", actor: missing.actor });
    missing.engine.handle({ type: "RecordRecoveryFacts", runId: missing.runId, facts: [{ kind: "session", status: "needs_attention", reason: "durable_observe_missing" }], expectedVersion: current(missing.store).version, idempotencyKey: "recovery-missing-fact", actor: missing.actor });
    expect(current(missing.store)).toMatchObject({ status: "needs_attention", steps: [{ executionStatus: "stale", conclusion: "active" }] });

    const exited = engineHarness();
    exited.engine.handle({ type: "RecordExternalObservation", runId: exited.runId, fact: "structured_process_exit", expectedVersion: current(exited.store).version, idempotencyKey: "recovery-exited", actor: exited.actor });
    expect(current(exited.store)).toMatchObject({ status: "running", steps: [{ executionStatus: "returned", verificationStatus: "pending", conclusion: "active" }] });
  });

  it("allows success only after evidence-based verification", () => {
    const { store, engine, actor, runId } = engineHarness();
    engine.handle({
      type: "RecordExternalObservation",
      runId,
      fact: "agent_returned",
      expectedVersion: current(store).version,
      idempotencyKey: "returned-0001",
      actor,
    });
    engine.handle({
      type: "RecordVerifierResult",
      runId,
      outcome: "passed",
      evidenceFingerprint: "e".repeat(64),
      expectedVersion: current(store).version,
      idempotencyKey: "verify-0001",
      actor,
    });
    expect(current(store).steps[0]).toMatchObject({
      executionStatus: "returned",
      verificationStatus: "passed",
      conclusion: "succeeded",
    });
    expect(current(store).status).toBe("paused");
  });

  it("rejects verification before return and rejects late facts after a terminal conclusion", () => {
    const { store, engine, actor, runId } = engineHarness();
    expect(() =>
      engine.handle({
        type: "RecordVerifierResult",
        runId,
        outcome: "passed",
        evidenceFingerprint: "e".repeat(64),
        expectedVersion: current(store).version,
        idempotencyKey: "verify-too-early",
        actor,
      }),
    ).toThrow(/EXECUTION_NOT_RETURNED/u);

    engine.handle({
      type: "RecordExternalObservation",
      runId,
      fact: "agent_returned",
      expectedVersion: current(store).version,
      idempotencyKey: "returned-terminal",
      actor,
    });
    engine.handle({
      type: "RecordVerifierResult",
      runId,
      outcome: "passed",
      evidenceFingerprint: "e".repeat(64),
      expectedVersion: current(store).version,
      idempotencyKey: "verify-terminal",
      actor,
    });
    const terminal = current(store);
    expect(() =>
      engine.handle({
        type: "RecordExternalObservation",
        runId,
        fact: "agent_returned",
        expectedVersion: terminal.version,
        idempotencyKey: "late-return",
        actor,
      }),
    ).toThrow(/ACTIVE_STEP_NOT_FOUND/u);
    expect(current(store)).toEqual(terminal);
  });

  it("activates a declared Loop with a new Attempt and monotonic persistent budget", () => {
    const { store, engine, actor, runId } = engineHarness(singleStepWorkflow(true));
    const initialAttempt = current(store).steps[0]!.attempts[0]!.attemptId;
    engine.handle({
      type: "RecordExternalObservation",
      runId,
      fact: "agent_returned",
      expectedVersion: current(store).version,
      idempotencyKey: "loop-return-1",
      actor,
    });
    engine.handle({
      type: "RecordVerifierResult",
      runId,
      outcome: "failed",
      evidenceFingerprint: "f".repeat(64),
      failureFingerprint: "failure-one",
      diffFingerprint: "diff-one",
      expectedVersion: current(store).version,
      idempotencyKey: "loop-fail-1",
      actor,
    });
    const looped = current(store);
    expect(looped.steps[0]!.attempts).toHaveLength(2);
    expect(looped.steps[0]!.attempts[1]!.attemptId).not.toBe(initialAttempt);
    expect(looped.budgetUsage).toMatchObject({ attempts: 2, loopIterations: 1 });
    expect(looped.steps[0]).toMatchObject({
      executionStatus: "assigned",
      verificationStatus: "pending",
      conclusion: "active",
    });
  });

  it("keeps exactly one active Step across a multi-step Loop back-edge", () => {
    const input = validWorkflowInput();
    const implement = input.steps[0]!;
    const test = input.steps[1]!;
    input.steps = [implement, test];
    input.entryStepId = implement.stepId;
    input.routes = [
      {
        routeId: RouteIdSchema.parse("rte_multi_impl_pass"),
        fromStepId: implement.stepId,
        outcome: "passed",
        priority: 0,
        toStepId: test.stepId,
      },
      {
        routeId: RouteIdSchema.parse("rte_multi_test_pass"),
        fromStepId: test.stepId,
        outcome: "passed",
        priority: 0,
        toStepId: null,
      },
      {
        routeId: RouteIdSchema.parse("rte_multi_test_loop"),
        fromStepId: test.stepId,
        outcome: "failed",
        priority: 0,
        toStepId: implement.stepId,
      },
    ];
    input.loops = [
      {
        ...input.loops[0]!,
        routeId: RouteIdSchema.parse("rte_multi_test_loop"),
        fromStepId: test.stepId,
        toStepId: implement.stepId,
        maxIterations: 3,
        maxElapsedMs: 30_000,
        progressPredicate: { kind: "diff_present", source: "workspace.diff" },
      },
    ];
    const workflow = createWorkflowRevision(input);
    const { store, engine, actor, runId } = engineHarness(workflow);

    engine.handle({ type: "RecordExternalObservation", runId, fact: "agent_returned", expectedVersion: current(store).version, idempotencyKey: "multi-implement-return-1", actor });
    engine.handle({ type: "RecordVerifierResult", runId, outcome: "passed", evidenceFingerprint: "1".repeat(64), expectedVersion: current(store).version, idempotencyKey: "multi-implement-pass-1", actor });
    engine.handle({ type: "RecordExternalObservation", runId, fact: "agent_returned", expectedVersion: current(store).version, idempotencyKey: "multi-test-return-1", actor });
    engine.handle({ type: "RecordVerifierResult", runId, outcome: "failed", evidenceFingerprint: "2".repeat(64), failureFingerprint: "multi-failure-1", diffFingerprint: "multi-diff-1", expectedVersion: current(store).version, idempotencyKey: "multi-test-fail-1", actor });

    expect(current(store).steps.filter(({ conclusion }) => conclusion === "active")).toHaveLength(1);
    expect(current(store).steps.find(({ stepId }) => stepId === test.stepId)?.conclusion).toBe("failed");
    expect(current(store).steps.find(({ stepId }) => stepId === implement.stepId)).toMatchObject({
      conclusion: "active",
      attempts: [{ attemptNumber: 1 }, { attemptNumber: 2 }],
    });

    engine.handle({ type: "RecordExternalObservation", runId, fact: "agent_returned", expectedVersion: current(store).version, idempotencyKey: "multi-implement-return-2", actor });
    engine.handle({ type: "RecordVerifierResult", runId, outcome: "passed", evidenceFingerprint: "3".repeat(64), expectedVersion: current(store).version, idempotencyKey: "multi-implement-pass-2", actor });
    engine.handle({ type: "RecordExternalObservation", runId, fact: "agent_returned", expectedVersion: current(store).version, idempotencyKey: "multi-test-return-2", actor });
    engine.handle({ type: "RecordVerifierResult", runId, outcome: "failed", evidenceFingerprint: "4".repeat(64), failureFingerprint: "multi-failure-2", diffFingerprint: "multi-diff-2", expectedVersion: current(store).version, idempotencyKey: "multi-test-fail-2", actor });

    expect(current(store).loopUsage[workflow.loops[0]!.loopId]?.iterations).toBe(2);
    expect(current(store).steps.filter(({ conclusion }) => conclusion === "active")).toHaveLength(1);
    expect(current(store).steps.find(({ stepId }) => stepId === implement.stepId)?.attempts).toHaveLength(3);
  });

  it("derives retry/backoff from the frozen Step and creates a new bounded Attempt", () => {
    let clock = new Date("2026-07-22T10:00:00.000Z");
    const { store, engine, actor, runId } = engineHarness(singleStepWorkflow(), () => clock);
    const firstAttempt = current(store).steps[0]!.attempts[0]!.attemptId;
    const receipt = engine.handle({ type: "RecordExecutionFailure", runId, errorClass: "transient", expectedVersion: current(store).version, idempotencyKey: "retry-transient", actor });
    expect(receipt.response).toMatchObject({ retryScheduled: true, delayMs: 10, notBefore: "2026-07-22T10:00:00.010Z" });
    expect(current(store).steps[0]!.attempts).toHaveLength(1);
    expect(() => engine.handle({ type: "ActivateScheduledRetry", runId, expectedVersion: current(store).version, idempotencyKey: "retry-too-early", actor })).toThrow(/RETRY_NOT_BEFORE/u);
    clock = new Date("2026-07-22T10:00:00.010Z");
    engine.handle({ type: "ActivateScheduledRetry", runId, expectedVersion: current(store).version, idempotencyKey: "retry-activate", actor });
    expect(current(store).steps[0]!.attempts).toHaveLength(2);
    expect(current(store).steps[0]!.attempts[1]!.attemptId).not.toBe(firstAttempt);
    expect(current(store).budgetUsage.attempts).toBe(2);
    engine.handle({ type: "RecordExecutionFailure", runId, errorClass: "transient", expectedVersion: current(store).version, idempotencyKey: "retry-exhausted", actor });
    expect(current(store).status).toBe("needs_attention");
    expect(current(store).steps[0]!.attempts).toHaveLength(2);
  });

  it("does not retry an undeclared execution error class", () => {
    const { store, engine, actor, runId } = engineHarness();
    engine.handle({ type: "RecordExecutionFailure", runId, errorClass: "fatal", expectedVersion: current(store).version, idempotencyKey: "retry-fatal", actor });
    expect(current(store)).toMatchObject({ status: "failed", steps: [{ conclusion: "failed", executionStatus: "failed" }] });
  });

  it("replays the same Flow command as one transition and rejects changed content", () => {
    const { store, engine, actor, runId } = engineHarness();
    const command = {
      type: "RecordExternalObservation" as const,
      runId,
      fact: "agent_returned" as const,
      expectedVersion: current(store).version,
      idempotencyKey: "replay-return",
      actor,
    };
    const first = engine.handle(command);
    const state = current(store);
    expect(engine.handle(command)).toEqual(first);
    expect(current(store)).toEqual(state);
    expect(() => engine.handle({ ...command, fact: "process_exited" })).toThrow(/IDEMPOTENCY_KEY_REUSED/u);
  });

  it("requires a Human Gate receipt over the fixed content hash", () => {
    const { store, engine, actor, runId } = engineHarness(humanGateWorkflow());
    engine.handle({
      type: "RecordExternalObservation",
      runId,
      fact: "agent_returned",
      expectedVersion: current(store).version,
      idempotencyKey: "gate-returned",
      actor,
    });
    expect(() =>
      engine.handle({
        type: "RecordVerifierResult",
        runId,
        outcome: "passed",
        evidenceFingerprint: "d".repeat(64),
        humanReceipt: { contentHash: "0".repeat(64), actorId: "reviewer-1" },
        expectedVersion: current(store).version,
        idempotencyKey: "gate-wrong-content",
        actor,
      }),
    ).toThrow(/HUMAN_RECEIPT_CONTENT_HASH_MISMATCH/u);
    engine.handle({
      type: "RecordVerifierResult",
      runId,
      outcome: "passed",
      evidenceFingerprint: "d".repeat(64),
      humanReceipt: {
        contentHash: current(store).steps[0]!.fixedContentHash,
        actorId: actor.actorId,
      },
      expectedVersion: current(store).version,
      idempotencyKey: "gate-approved",
      actor,
    });
    expect(current(store).status).toBe("paused");
  });

  it("routes an authenticated Human Gate cancellation without canceling the Run", () => {
    const workflow = humanGateCanceledWorkflow();
    const { store, engine, actor, runId } = engineHarness(workflow);
    engine.handle({
      type: "RecordExternalObservation",
      runId,
      fact: "agent_returned",
      expectedVersion: current(store).version,
      idempotencyKey: "gate-cancel-returned",
      actor,
    });
    engine.handle({
      type: "RecordVerifierResult",
      runId,
      outcome: "canceled",
      evidenceFingerprint: "c".repeat(64),
      humanReceipt: {
        contentHash: current(store).steps[0]!.fixedContentHash,
        actorId: actor.actorId,
      },
      expectedVersion: current(store).version,
      idempotencyKey: "gate-canceled",
      actor,
    });

    const state = current(store);
    expect(state.status).toBe("running");
    expect(state.steps.find(({ stepId }) => stepId === workflow.entryStepId)).toMatchObject({
      verificationStatus: "canceled",
      conclusion: "canceled",
    });
    expect(state.steps.find(({ stepId }) => stepId !== workflow.entryStepId)?.conclusion).toBe("active");
    expect(store.commits.at(-1)!.events).toContainEqual(expect.objectContaining({
      type: "RouteSelected",
      outcome: "canceled",
    }));
    expect(store.commits.at(-1)!.events).not.toContainEqual(expect.objectContaining({
      type: "RunConcluded",
      status: "canceled",
    }));
  });

  it("rejects a canceled verifier outcome for an automated verifier", () => {
    const { store, engine, actor, runId } = engineHarness();
    engine.handle({
      type: "RecordExternalObservation",
      runId,
      fact: "agent_returned",
      expectedVersion: current(store).version,
      idempotencyKey: "automated-cancel-returned",
      actor,
    });

    expect(() => engine.handle({
      type: "RecordVerifierResult",
      runId,
      outcome: "canceled",
      evidenceFingerprint: "c".repeat(64),
      expectedVersion: current(store).version,
      idempotencyKey: "automated-canceled",
      actor,
    })).toThrow(/CANCELED_OUTCOME_REQUIRES_HUMAN_RECEIPT_VERIFIER/u);
  });

  it.each([
    ["missing", undefined],
    ["wrong", { contentHash: "0".repeat(64), actorId: "flow-test" }],
  ] as const)("rejects a Human Gate cancellation with a %s receipt", (_label, humanReceipt) => {
    const { store, engine, actor, runId } = engineHarness(humanGateCanceledWorkflow());
    engine.handle({
      type: "RecordExternalObservation",
      runId,
      fact: "agent_returned",
      expectedVersion: current(store).version,
      idempotencyKey: `gate-cancel-${_label}-returned`,
      actor,
    });

    expect(() => engine.handle({
      type: "RecordVerifierResult",
      runId,
      outcome: "canceled",
      evidenceFingerprint: "c".repeat(64),
      humanReceipt,
      expectedVersion: current(store).version,
      idempotencyKey: `gate-cancel-${_label}`,
      actor,
    })).toThrow(/HUMAN_RECEIPT_CONTENT_HASH_MISMATCH/u);
  });

  it("uses declared terminal transitions for timeout and cancel", () => {
    const timed = engineHarness();
    timed.engine.handle({
      type: "RecordTimeout",
      runId: timed.runId,
      expectedVersion: current(timed.store).version,
      idempotencyKey: "timeout-1",
      actor: timed.actor,
    });
    expect(current(timed.store)).toMatchObject({ status: "failed", steps: [{ conclusion: "failed" }] });
    expect(timed.store.commits.at(-1)!.events.some(({ type }) => type === "ExternalObservationRecorded")).toBe(false);

    const canceled = engineHarness();
    canceled.engine.handle({
      type: "CancelRun",
      runId: canceled.runId,
      expectedVersion: current(canceled.store).version,
      idempotencyKey: "cancel-1",
      actor: canceled.actor,
    });
    expect(current(canceled.store)).toMatchObject({ status: "canceled", steps: [{ conclusion: "canceled" }] });
    expect(canceled.store.commits.at(-1)!.events.some(({ type }) => type === "ExternalObservationRecorded")).toBe(false);
  });

  it.each(["paused", "failed", "needs_attention"] as const)("applies the declared %s Loop exhaustion target without rewriting prior Attempts", (target) => {
    const base = singleStepWorkflow(true);
    const { workflowFingerprint: ignoredFingerprint, ...unsigned } = base;
    void ignoredFingerprint;
    const workflow = createWorkflowRevision({ ...unsigned, loops: base.loops.map((loop) => ({ ...loop, exhaustion: { ...loop.exhaustion, target } })) });
    const { store, engine, actor, runId } = engineHarness(workflow);
    let finalReceipt: ReturnType<typeof engine.handle> | null = null;
    for (let index = 0; index < 3 && current(store).status === "running"; index += 1) {
      engine.handle({
        type: "RecordExternalObservation",
        runId,
        fact: "agent_returned",
        expectedVersion: current(store).version,
        idempotencyKey: `exhaust-return-${index}`,
        actor,
      });
      finalReceipt = engine.handle({
        type: "RecordVerifierResult",
        runId,
        outcome: "failed",
        evidenceFingerprint: "f".repeat(64),
        failureFingerprint: "same-failure",
        diffFingerprint: `diff-${index}`,
        expectedVersion: current(store).version,
        idempotencyKey: `exhaust-verify-${index}`,
        actor,
      });
    }
    expect(current(store).status).toBe(target);
    expect(current(store).steps[0]!.attempts).toHaveLength(3);
    expect(current(store).budgetUsage).toMatchObject({ attempts: 3, loopIterations: 2 });
    expect(finalReceipt?.response).toMatchObject({
      loopIteration: 3,
      loopGuardReason: "MAX_ITERATIONS",
    });
  });

  it("does not treat repeated ordinary verifier failures as verifier improvement", () => {
    const workflow = singleStepWorkflow(true);
    const { workflowFingerprint: ignored, ...unsigned } = workflow;
    void ignored;
    const improved = createWorkflowRevision({ ...unsigned, loops: workflow.loops.map((loop) => ({ ...loop, progressPredicate: { kind: "verifier_improved" as const, source: "verification.outcome" } })) });
    const { store, engine, actor, runId } = engineHarness(improved);
    for (let index = 0; index < 3 && current(store).status === "running"; index += 1) {
      engine.handle({ type: "RecordExternalObservation", runId, fact: "agent_returned", expectedVersion: current(store).version, idempotencyKey: `improvement-return-${index}`, actor });
      engine.handle({ type: "RecordVerifierResult", runId, outcome: "failed", evidenceFingerprint: String(index + 1).repeat(64), failureFingerprint: `unique-${index}`, expectedVersion: current(store).version, idempotencyKey: `improvement-verify-${index}`, actor });
    }
    expect(current(store).status).toBe("needs_attention");
    expect(current(store).steps[0]!.attempts).toHaveLength(3);
    expect(current(store).loopUsage[improved.loops[0]!.loopId]?.noProgressCount).toBe(1);
  });

  it("derives deterministic IDs and fingerprints independent of workflow array order", () => {
    const workflow = singleStepWorkflow();
    const first = engineHarness(workflow);
    const firstState = current(first.store);
    const { bindingFingerprint, ...unsigned } = firstState.binding;
    expect(bindingFingerprint).toBe(canonicalSha256(unsigned));
  });

  it("records one deterministic Task fan-out decision and rejects duplicate active scheduling", () => {
    const { store, engine, actor, runId } = engineHarness();
    const receipt = engine.handle({ type: "ScheduleTaskFanOut", runId, expectedVersion: current(store).version, idempotencyKey: "fanout-one", actor });
    expect(receipt.response).toMatchObject({ children: [{ taskId: ids.task, childRunId: expect.stringMatching(/^run_/u) }] });
    expect(current(store).scheduledChildren).toHaveLength(1);
    const second = engine.handle({ type: "ScheduleTaskFanOut", runId, expectedVersion: current(store).version, idempotencyKey: "fanout-two", actor });
    expect(second.response).toEqual({ children: [] });
    expect(current(store).scheduledChildren).toHaveLength(1);
  });

  it("rejects an oversized frozen Task graph before persisting fan-out", () => {
    const baseTask = executionPlan().tasks[0]!;
    const oversizedPlan = createExecutionPlan({
      executionPlanId: ids.plan,
      projectId: ids.project,
      changeRevisionId: "crv_revision01",
      requirementRevisionIds: requirements,
      tasks: Array.from({ length: MAX_EXECUTION_PLAN_TASKS + 1 }, (_, index) => ({
        ...baseTask,
        taskId: TaskIdSchema.parse(`tsk_flowlimit${index.toString().padStart(5, "0")}`),
        title: `Task ${index}`,
      })),
      publishedAt: "2026-07-22T01:00:00.000Z",
    });
    const { store, engine, actor, runId } = engineHarness(
      singleStepWorkflow(),
      () => new Date("2026-07-22T10:00:00.000Z"),
      oversizedPlan,
    );
    const commitsBefore = store.commits.length;
    expect(() => engine.handle({
      type: "ScheduleTaskFanOut",
      runId,
      expectedVersion: current(store).version,
      idempotencyKey: "fanout-oversized-plan",
      actor,
    })).toThrow(/TASK_SCHEDULER_PLAN_LIMIT_EXCEEDED/u);
    expect(store.commits).toHaveLength(commitsBefore);
    expect(current(store).scheduledChildren).toEqual([]);
  });

  it("keeps a canceled parent non-terminal until every requested child is terminal", () => {
    const { store, engine, actor, runId } = engineHarness();
    const plan = executionPlan();
    const scheduled = engine.handle({ type: "ScheduleTaskFanOut", runId, expectedVersion: current(store).version, idempotencyKey: "cancel-fanout", actor }).response as { children: Array<{ taskId: typeof ids.task; childRunId: typeof ids.childRun; budget: typeof initialBudget }> };
    const parent = current(store).binding;
    const child = createWorkflowRunBinding({
      runId: scheduled.children[0]!.childRunId,
      projectId: parent.projectId,
      changeRevisionId: parent.changeRevisionId,
      requirementRevisionIds: parent.requirementRevisionIds,
      workflowRevisionId: ids.workflow,
      policySnapshot: parent.policySnapshot,
      initialBudget: scheduled.children[0]!.budget,
      subjectKind: "task",
      parentRunId: runId,
      taskId: ids.task,
      executionPlanId: parent.executionPlanId,
    }, { parent, executionPlan: plan, activeTaskIds: [], parentTerminal: false, childBudgetAllocation: scheduled.children[0]!.budget });
    engine.handle({ type: "StartRun", binding: child, expectedVersion: 0, idempotencyKey: "start-child", actor });
    engine.handle({ type: "CancelRun", runId, expectedVersion: current(store).version, idempotencyKey: "cancel-parent", actor });
    expect(current(store).status).toBe("paused");
    expect(store.commits.at(-1)!.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "ChildCancellationRequested", childRunIds: [child.runId] }),
    ]));
    engine.handle({ type: "CancelRun", runId: child.runId, expectedVersion: store.loadRun(child.runId)!.version, idempotencyKey: "cancel-child", actor });
    engine.handle({ type: "ReconcileChildCancellations", runId, expectedVersion: current(store).version, idempotencyKey: "reconcile-cancel", actor });
    expect(current(store)).toMatchObject({ status: "canceled", steps: [{ conclusion: "canceled" }] });
  });

  it("persists bounded child allocations whose total cannot exceed the parent remainder", () => {
    const { store, engine, actor, runId } = engineHarness();
    const response = engine.handle({ type: "ScheduleTaskFanOut", runId, expectedVersion: current(store).version, idempotencyKey: "bounded-fanout", actor }).response as { children: Array<{ budget: typeof initialBudget }> };
    const budget = response.children[0]!.budget;
    expect(budget.maxAttempts).toBeLessThan(initialBudget.maxAttempts);
    expect(budget.maxElapsedMs).toBeLessThanOrEqual(initialBudget.maxElapsedMs - current(store).budgetUsage.elapsedMs);
    expect(current(store).scheduledChildren[0]!.budget).toEqual(budget);
  });

  it("does not let parent retry spend budget already reserved for a child", () => {
    const { store, engine, actor, runId } = engineHarness();
    engine.handle({ type: "ScheduleTaskFanOut", runId, expectedVersion: current(store).version, idempotencyKey: "reserve-before-retry", actor });
    engine.handle({ type: "RecordExecutionFailure", runId, errorClass: "transient", expectedVersion: current(store).version, idempotencyKey: "retry-with-reservation", actor });
    expect(current(store)).toMatchObject({ status: "needs_attention", scheduledRetry: null });
    expect(current(store).steps[0]!.attempts).toHaveLength(1);
  });

  it("keeps an assigned leaf non-terminal until an interrupt receipt is acknowledged", () => {
    const { store, engine, actor, runId } = engineHarness();
    const attemptId = current(store).steps[0]!.attempts[0]!.attemptId;
    const operation = createExternalOperation({ schemaVersion: 1, operationId: "opn_cancelproof01", projectId: ids.project, runId, attemptId, operationVersion: 1, operationType: "session.launch", requestedCapabilities: ["launch"], payload: { agentProfileId: "apr_profile01", workspaceId: "wsp_cancel0001" } });
    engine.handle({ type: "AssignAttempt", runId, operation, capabilityProbeReceiptId: "cpr_cancel0001", leaseIds: ["wsl_cancel0001"], expectedVersion: current(store).version, idempotencyKey: "assign-cancel-leaf", actor });
    engine.handle({ type: "CancelRun", runId, expectedVersion: current(store).version, idempotencyKey: "request-cancel-leaf", actor });
    expect(current(store)).toMatchObject({ status: "paused", attemptCancellation: { attemptId, assignmentOperationId: operation.operationId } });
    engine.handle({ type: "AcknowledgeAttemptCancellation", runId, interruptOperationId: "opn_interrupt001", evidenceFingerprint: "6".repeat(64), expectedVersion: current(store).version, idempotencyKey: "ack-cancel-leaf", actor });
    expect(current(store)).toMatchObject({ status: "canceled", attemptCancellation: null, steps: [{ conclusion: "canceled" }] });
  });

  it("waits for Task fan-in, accepts each child once, and rolls its budget into the parent", () => {
    const { store, engine, actor, runId } = engineHarness();
    const scheduled = engine.handle({ type: "ScheduleTaskFanOut", runId, expectedVersion: current(store).version, idempotencyKey: "fanout-rollup", actor }).response as { children: Array<{ taskId: typeof ids.task; childRunId: typeof ids.childRun; budget: typeof initialBudget }> };
    const parent = current(store).binding;
    const childRunId = scheduled.children[0]!.childRunId;
    const childBudget = scheduled.children[0]!.budget;
    const child = createWorkflowRunBinding({ runId: childRunId, projectId: parent.projectId, changeRevisionId: parent.changeRevisionId, requirementRevisionIds: parent.requirementRevisionIds, workflowRevisionId: ids.workflow, policySnapshot: parent.policySnapshot, initialBudget: childBudget, subjectKind: "task", parentRunId: runId, taskId: ids.task, executionPlanId: parent.executionPlanId }, { parent, executionPlan: executionPlan(), activeTaskIds: [], parentTerminal: false, childBudgetAllocation: childBudget });
    engine.handle({ type: "StartRun", binding: child, expectedVersion: 0, idempotencyKey: "start-rollup-child", actor });

    engine.handle({ type: "RecordExternalObservation", runId, fact: "agent_returned", expectedVersion: current(store).version, idempotencyKey: "root-return-fanin", actor });
    engine.handle({ type: "RecordVerifierResult", runId, outcome: "passed", evidenceFingerprint: "a".repeat(64), expectedVersion: current(store).version, idempotencyKey: "root-verify-fanin", actor });
    expect(current(store).status).toBe("paused");

    const childState = () => store.loadRun(childRunId)!;
    engine.handle({ type: "RecordExternalObservation", runId: childRunId, fact: "agent_returned", expectedVersion: childState().version, idempotencyKey: "child-return-fanin", actor });
    engine.handle({ type: "RecordVerifierResult", runId: childRunId, outcome: "passed", evidenceFingerprint: "b".repeat(64), expectedVersion: childState().version, idempotencyKey: "child-verify-fanin", actor });
    engine.handle({ type: "ReconcileTaskChildren", runId, expectedVersion: current(store).version, idempotencyKey: "reconcile-fanin", actor });
    expect(current(store)).toMatchObject({ status: "succeeded", budgetUsage: { attempts: 2 }, acceptedChildRunIds: [childRunId] });
    expect(() => engine.handle({ type: "ReconcileTaskChildren", runId, expectedVersion: current(store).version, idempotencyKey: "reconcile-twice", actor })).toThrow(/RUN_TERMINAL|NO_NEW_CHILD_CONCLUSION/u);
  });

  it("records explicit superseding-input and frozen Session handoff decisions without mutating the binding", () => {
    const { store, engine, actor, runId } = engineHarness();
    const fingerprint = current(store).binding.bindingFingerprint;
    engine.handle({ type: "RecordSupersedingRequirement", runId, newerRevisionId: RequirementRevisionIdSchema.parse("rrv_newinput01"), decision: "continue_old_input", expectedVersion: current(store).version, idempotencyKey: "supersede-one", actor });
    expect(current(store).binding.bindingFingerprint).toBe(fingerprint);
    expect(current(store).supersedingDecisions).toEqual([{ newerRevisionId: "rrv_newinput01", decision: "continue_old_input" }]);
    engine.handle({ type: "RecordResumeFailure", runId, expectedVersion: current(store).version, idempotencyKey: "resume-failed", actor });
    expect(current(store).status).toBe("paused");
  });

  it("accepts a terminal Subflow child exactly once and routes the parent Step", () => {
    const parentWorkflow = subflowOnlyWorkflow();
    const childWorkflow = childAgentWorkflow();
    const store = new TestFlowStore();
    const plan = executionPlan();
    const engine = new FlowEngine(store, {
      getWorkflowRevision: (id) => id === parentWorkflow.workflowRevisionId ? parentWorkflow : id === childWorkflow.workflowRevisionId ? childWorkflow : null,
      getExecutionPlan: () => plan,
      getRequirementRevision: (revisionId: ReturnType<typeof RequirementRevisionIdSchema.parse>) => requirementRevision(revisionId),
    });
    const actor = { actorId: "flow-test", correlationId: "subflow-test", roles: ["project-approver"] };
    const { bindingFingerprint: ignored, ...root } = rootBinding();
    void ignored;
    const parentBinding = createWorkflowRunBinding({ ...root, workflowRevisionId: parentWorkflow.workflowRevisionId, taskGraphFingerprint: plan.taskGraphFingerprint });
    engine.handle({ type: "StartRun", binding: parentBinding, expectedVersion: 0, idempotencyKey: "sub-parent", actor });
    const parent = store.loadRun(ids.rootRun)!;
    const parentStepRunId = parent.steps[0]!.stepRunId;
    const childRunId = RunIdSchema.parse("run_subflow001");
    const subflowBudget = remainingRunBudget(parent.binding.initialBudget, parent.budgetUsage);
    const childBinding = createWorkflowRunBinding({
      runId: childRunId,
      projectId: parent.binding.projectId,
      changeRevisionId: parent.binding.changeRevisionId,
      requirementRevisionIds: parent.binding.requirementRevisionIds,
      workflowRevisionId: childWorkflow.workflowRevisionId,
      policySnapshot: parent.binding.policySnapshot,
      initialBudget: subflowBudget,
      subjectKind: "subflow",
      parentRunId: parent.binding.runId,
      taskId: null,
      executionPlanId: parent.binding.executionPlanId,
      parentStepRunId,
    }, { parent: parent.binding, executionPlan: plan, activeTaskIds: [], parentTerminal: false, childBudgetAllocation: subflowBudget });
    engine.handle({ type: "StartRun", binding: childBinding, expectedVersion: 0, idempotencyKey: "sub-child", actor });
    const childState = () => store.loadRun(childRunId)!;
    engine.handle({ type: "RecordExternalObservation", runId: childRunId, fact: "agent_returned", expectedVersion: childState().version, idempotencyKey: "sub-return", actor });
    engine.handle({ type: "RecordVerifierResult", runId: childRunId, outcome: "passed", evidenceFingerprint: "c".repeat(64), expectedVersion: childState().version, idempotencyKey: "sub-verify", actor });

    engine.handle({ type: "ReconcileSubflowChild", runId: ids.rootRun, childRunId, expectedVersion: store.loadRun(ids.rootRun)!.version, idempotencyKey: "sub-reconcile", actor } as never);
    expect(store.loadRun(ids.rootRun)).toMatchObject({ status: "succeeded", acceptedChildRunIds: [childRunId], steps: [{ conclusion: "succeeded" }] });
    expect(() => engine.handle({ type: "ReconcileSubflowChild", runId: ids.rootRun, childRunId, expectedVersion: store.loadRun(ids.rootRun)!.version, idempotencyKey: "sub-reconcile-again", actor } as never)).toThrow(/RUN_TERMINAL|CHILD_CONCLUSION_ALREADY_ACCEPTED/u);
  });

  it.each([
    ["block", "paused"],
    ["skip", "running"],
    ["terminate", "canceled"],
  ] as const)("records the server-derived %s dependency-failure rule", (policy, expectedStatus) => {
    const { store, engine, actor, childRunId } = dependencyFailureHarness({ policy });
    engine.handle({ type: "ResolveTaskDependencyFailure", runId: ids.rootRun, taskId: ids.dependent, expectedVersion: store.loadRun(ids.rootRun)!.version, idempotencyKey: `dependency-${policy}`, actor } as never);
    expect(store.loadRun(ids.rootRun)).toMatchObject({
      status: expectedStatus,
      dependencyFailureDecisions: [{ taskId: ids.dependent, action: policy === "block" ? "blocked" : policy === "skip" ? "skipped" : "terminate", failedDependencyIds: [ids.dependency] }],
    });
    expect(store.loadRun(childRunId)!.status).toBe("failed");
  });

  it("schedules only the frozen compensation Task after a dependency failure", () => {
    const { store, engine, actor } = dependencyFailureHarness({ policy: "compensation", compensationTaskId: ids.compensation });
    const receipt = engine.handle({ type: "ResolveTaskDependencyFailure", runId: ids.rootRun, taskId: ids.dependent, expectedVersion: store.loadRun(ids.rootRun)!.version, idempotencyKey: "dependency-compensate", actor } as never);
    expect(receipt.response).toMatchObject({ action: "compensate", children: [{ taskId: ids.compensation }] });
    expect(store.loadRun(ids.rootRun)!.scheduledChildren.at(-1)).toMatchObject({ taskId: ids.compensation });
  });

  it("requires an authorized fixed-content waiver before scheduling the dependent Task", () => {
    const { store, engine, actor } = dependencyFailureHarness({ policy: "waiver", requiredRole: "project-approver" });
    const base = { type: "ResolveTaskDependencyFailure", runId: ids.rootRun, taskId: ids.dependent, expectedVersion: store.loadRun(ids.rootRun)!.version, idempotencyKey: "dependency-waiver", actor } as const;
    expect(() => engine.handle({ ...base, humanWaiver: { actorId: actor.actorId, contentHash: "0".repeat(64) } } as never)).toThrow(/WAIVER_CONTENT_HASH_MISMATCH/u);
    const contentHash = canonicalSha256({ runId: ids.rootRun, taskId: ids.dependent, failedDependencyIds: [ids.dependency] });
    const receipt = engine.handle({ ...base, humanWaiver: { actorId: actor.actorId, contentHash } } as never);
    expect(receipt.response).toMatchObject({ action: "waived", children: [{ taskId: ids.dependent }] });
    expect(store.loadRun(ids.rootRun)!.dependencyFailureDecisions[0]).toMatchObject({ waiverReceiptHash: contentHash });
    const scheduled = (receipt.response as {
      children: Array<{
        taskId: typeof ids.dependent;
        childRunId: typeof ids.childRun;
        budget: typeof initialBudget;
      }>;
    }).children[0]!;
    const parent = store.loadRun(ids.rootRun)!.binding;
    const plan = dependencyPlan();
    const child = createWorkflowRunBinding({
      runId: scheduled.childRunId,
      projectId: parent.projectId,
      changeRevisionId: parent.changeRevisionId,
      requirementRevisionIds: parent.requirementRevisionIds,
      workflowRevisionId: ids.workflow,
      policySnapshot: parent.policySnapshot,
      initialBudget: scheduled.budget,
      subjectKind: "task",
      parentRunId: parent.runId,
      taskId: scheduled.taskId,
      executionPlanId: parent.executionPlanId,
    }, {
      parent,
      executionPlan: plan,
      activeTaskIds: [],
      parentTerminal: false,
      childBudgetAllocation: scheduled.budget,
    });
    engine.handle({
      type: "StartRun",
      binding: child,
      expectedVersion: 0,
      idempotencyKey: "start-waived-dependent",
      actor,
    });
    expect(engine.handle({
      type: "ScheduleTaskFanOut",
      runId: ids.rootRun,
      expectedVersion: store.loadRun(ids.rootRun)!.version,
      idempotencyKey: "fanout-after-waiver-start",
      actor,
    }).response).toEqual({ children: [] });
  });

  it("can finish an already verified parent after an accepted failed dependency is explicitly skipped", () => {
    const { store, engine, actor } = dependencyFailureHarness({ policy: "skip" });
    engine.handle({ type: "RecordExternalObservation", runId: ids.rootRun, fact: "agent_returned", expectedVersion: store.loadRun(ids.rootRun)!.version, idempotencyKey: "dependency-root-return", actor });
    engine.handle({ type: "RecordVerifierResult", runId: ids.rootRun, outcome: "passed", evidenceFingerprint: "e".repeat(64), expectedVersion: store.loadRun(ids.rootRun)!.version, idempotencyKey: "dependency-root-verify", actor });
    expect(store.loadRun(ids.rootRun)).toMatchObject({ status: "needs_attention", acceptedChildRunIds: [expect.any(String)] });
    engine.handle({ type: "ResolveTaskDependencyFailure", runId: ids.rootRun, taskId: ids.dependent, expectedVersion: store.loadRun(ids.rootRun)!.version, idempotencyKey: "dependency-skip-finish", actor } as never);
    expect(store.loadRun(ids.rootRun)!.status).toBe("succeeded");
  });

  it.each([
    ["compensation", ids.compensation],
    ["waiver", ids.dependent],
  ] as const)("reaches clean fan-in after a verified %s disposition", (policy, terminalTaskId) => {
    const rule = policy === "compensation"
      ? { policy: "compensation" as const, compensationTaskId: ids.compensation }
      : { policy: "waiver" as const, requiredRole: "project-approver" };
    const { store, engine, actor } = dependencyFailureHarness(rule);
    const command = { type: "ResolveTaskDependencyFailure", runId: ids.rootRun, taskId: ids.dependent, expectedVersion: store.loadRun(ids.rootRun)!.version, idempotencyKey: `dependency-finish-${policy}`, actor } as const;
    const decision = policy === "waiver"
      ? engine.handle({ ...command, humanWaiver: { actorId: actor.actorId, contentHash: canonicalSha256({ runId: ids.rootRun, taskId: ids.dependent, failedDependencyIds: [ids.dependency] }) } } as never)
      : engine.handle(command as never);
    const scheduled = (decision.response as { children: Array<{ taskId: typeof terminalTaskId; childRunId: typeof ids.childRun; budget: typeof initialBudget }> }).children[0]!;
    expect(scheduled.taskId).toBe(terminalTaskId);
    const parent = store.loadRun(ids.rootRun)!.binding;
    const plan = dependencyPlan(policy === "compensation");
    const child = createWorkflowRunBinding({ runId: scheduled.childRunId, projectId: parent.projectId, changeRevisionId: parent.changeRevisionId, requirementRevisionIds: parent.requirementRevisionIds, workflowRevisionId: ids.workflow, policySnapshot: parent.policySnapshot, initialBudget: scheduled.budget, subjectKind: "task", parentRunId: parent.runId, taskId: scheduled.taskId, executionPlanId: parent.executionPlanId }, { parent, executionPlan: plan, activeTaskIds: [], parentTerminal: false, childBudgetAllocation: scheduled.budget });
    engine.handle({ type: "StartRun", binding: child, expectedVersion: 0, idempotencyKey: `start-${policy}`, actor });
    engine.handle({ type: "RecordExternalObservation", runId: child.runId, fact: "agent_returned", expectedVersion: store.loadRun(child.runId)!.version, idempotencyKey: `return-${policy}`, actor });
    engine.handle({ type: "RecordVerifierResult", runId: child.runId, outcome: "passed", evidenceFingerprint: "7".repeat(64), expectedVersion: store.loadRun(child.runId)!.version, idempotencyKey: `verify-${policy}`, actor });
    engine.handle({ type: "RecordExternalObservation", runId: ids.rootRun, fact: "agent_returned", expectedVersion: store.loadRun(ids.rootRun)!.version, idempotencyKey: `root-return-${policy}`, actor });
    engine.handle({ type: "RecordVerifierResult", runId: ids.rootRun, outcome: "passed", evidenceFingerprint: "8".repeat(64), expectedVersion: store.loadRun(ids.rootRun)!.version, idempotencyKey: `root-verify-${policy}`, actor });
    engine.handle({ type: "ReconcileTaskChildren", runId: ids.rootRun, expectedVersion: store.loadRun(ids.rootRun)!.version, idempotencyKey: `reconcile-${policy}`, actor });
    expect(store.loadRun(ids.rootRun)!.status).toBe("succeeded");
  });
});

function dependencyFailureHarness(rule: { readonly policy: "block" | "skip" | "terminate" } | { readonly policy: "compensation"; readonly compensationTaskId: typeof ids.compensation } | { readonly policy: "waiver"; readonly requiredRole: string }) {
  const store = new TestFlowStore();
  const plan = dependencyPlan(rule.policy === "compensation");
  const workflow = singleStepWorkflow();
  const engine = new FlowEngine(store, {
    getWorkflowRevision: () => workflow,
    getExecutionPlan: () => plan,
    getRequirementRevision: (revisionId: ReturnType<typeof RequirementRevisionIdSchema.parse>) => requirementRevision(revisionId),
    getDependencyFailureRule: () => rule,
  } as never);
  const actor = { actorId: "flow-test", correlationId: "dependency-test", roles: ["project-approver"] };
  const { bindingFingerprint: ignored, ...root } = rootBinding();
  void ignored;
  const parentBinding = createWorkflowRunBinding({ ...root, workflowRevisionId: workflow.workflowRevisionId, taskGraphFingerprint: plan.taskGraphFingerprint });
  engine.handle({ type: "StartRun", binding: parentBinding, expectedVersion: 0, idempotencyKey: `dependency-root-${rule.policy}`, actor });
  const scheduled = engine.handle({ type: "ScheduleTaskFanOut", runId: ids.rootRun, expectedVersion: store.loadRun(ids.rootRun)!.version, idempotencyKey: `dependency-fanout-${rule.policy}`, actor }).response as { children: Array<{ taskId: typeof ids.dependency; childRunId: typeof ids.childRun; budget: typeof initialBudget }> };
  const childRunId = scheduled.children[0]!.childRunId;
  const parent = store.loadRun(ids.rootRun)!.binding;
  const childBudget = scheduled.children[0]!.budget;
  const child = createWorkflowRunBinding({ runId: childRunId, projectId: parent.projectId, changeRevisionId: parent.changeRevisionId, requirementRevisionIds: parent.requirementRevisionIds, workflowRevisionId: ids.workflow, policySnapshot: parent.policySnapshot, initialBudget: childBudget, subjectKind: "task", parentRunId: parent.runId, taskId: ids.dependency, executionPlanId: parent.executionPlanId }, { parent, executionPlan: plan, activeTaskIds: [], parentTerminal: false, childBudgetAllocation: childBudget });
  engine.handle({ type: "StartRun", binding: child, expectedVersion: 0, idempotencyKey: `dependency-child-${rule.policy}`, actor });
  engine.handle({ type: "RecordExecutionFailure", runId: childRunId, errorClass: "fatal", expectedVersion: store.loadRun(childRunId)!.version, idempotencyKey: `dependency-fail-${rule.policy}`, actor });
  engine.handle({ type: "ReconcileTaskChildren", runId: ids.rootRun, expectedVersion: store.loadRun(ids.rootRun)!.version, idempotencyKey: `dependency-accept-${rule.policy}`, actor });
  return { store, engine, actor, childRunId };
}
