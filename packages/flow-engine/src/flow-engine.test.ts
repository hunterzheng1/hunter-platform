import {
  ExecutionPlanIdSchema,
  ProjectIdSchema,
  RouteIdSchema,
  RunIdSchema,
  StepRunIdSchema,
  TaskIdSchema,
  WorkflowRevisionIdSchema,
  createExecutionPlan,
  createWorkflowRevision,
  canonicalSha256,
  type WorkflowRevision,
} from "@hunter/domain";
import { describe, expect, it } from "vitest";

import type { FlowCommit, FlowStore } from "./flow-engine.js";
import { FlowEngine } from "./flow-engine.js";
import { reduceFlowEvents, type WorkflowRunState } from "./state.js";
import { createWorkflowRunBinding } from "./run-binding.js";
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

function dependencyPlan() {
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
    tasks: [task(ids.dependent, [ids.dependency]), task(ids.compensation, [ids.dependency]), task(ids.dependency)],
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
      { parent, executionPlan: plan, activeTaskIds: [], parentTerminal: false },
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

function engineHarness(workflow = singleStepWorkflow()) {
  const store = new TestFlowStore();
  const plan = executionPlan();
  const engine = new FlowEngine(store, {
    getWorkflowRevision: () => workflow,
    getExecutionPlan: () => plan,
  });
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
    expect(current(store).status).toBe("succeeded");
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
    ).toThrow(/RUN_TERMINAL/u);
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

  it("derives retry/backoff from the frozen Step and creates a new bounded Attempt", () => {
    const { store, engine, actor, runId } = engineHarness();
    const firstAttempt = current(store).steps[0]!.attempts[0]!.attemptId;
    const receipt = engine.handle({ type: "RecordExecutionFailure", runId, errorClass: "transient", expectedVersion: current(store).version, idempotencyKey: "retry-transient", actor });
    expect(receipt.response).toMatchObject({ retryScheduled: true, delayMs: 10 });
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
    expect(current(store).status).toBe("succeeded");
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

  it("applies the declared Loop exhaustion target without rewriting prior Attempts", () => {
    const { store, engine, actor, runId } = engineHarness(singleStepWorkflow(true));
    for (let index = 0; index < 3 && current(store).status === "running"; index += 1) {
      engine.handle({
        type: "RecordExternalObservation",
        runId,
        fact: "agent_returned",
        expectedVersion: current(store).version,
        idempotencyKey: `exhaust-return-${index}`,
        actor,
      });
      engine.handle({
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
    expect(current(store).status).toBe("needs_attention");
    expect(current(store).steps[0]!.attempts).toHaveLength(3);
    expect(current(store).budgetUsage).toMatchObject({ attempts: 3, loopIterations: 2 });
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

  it("propagates parent cancel requests to active Task children", () => {
    const { store, engine, actor, runId } = engineHarness();
    const parent = current(store).binding;
    const plan = executionPlan();
    const child = createWorkflowRunBinding({
      runId: ids.childRun,
      projectId: parent.projectId,
      changeRevisionId: parent.changeRevisionId,
      requirementRevisionIds: parent.requirementRevisionIds,
      workflowRevisionId: ids.workflow,
      policySnapshot: parent.policySnapshot,
      initialBudget: parent.initialBudget,
      subjectKind: "task",
      parentRunId: runId,
      taskId: ids.task,
      executionPlanId: parent.executionPlanId,
    }, { parent, executionPlan: plan, activeTaskIds: [], parentTerminal: false });
    engine.handle({ type: "StartRun", binding: child, expectedVersion: 0, idempotencyKey: "start-child", actor });
    engine.handle({ type: "CancelRun", runId, expectedVersion: current(store).version, idempotencyKey: "cancel-parent", actor });
    expect(store.commits.at(-1)!.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "ChildCancellationRequested", childRunIds: [ids.childRun] }),
    ]));
  });

  it("waits for Task fan-in, accepts each child once, and rolls its budget into the parent", () => {
    const { store, engine, actor, runId } = engineHarness();
    const scheduled = engine.handle({ type: "ScheduleTaskFanOut", runId, expectedVersion: current(store).version, idempotencyKey: "fanout-rollup", actor }).response as { children: Array<{ taskId: typeof ids.task; childRunId: typeof ids.childRun }> };
    const parent = current(store).binding;
    const childRunId = scheduled.children[0]!.childRunId;
    const child = createWorkflowRunBinding({ runId: childRunId, projectId: parent.projectId, changeRevisionId: parent.changeRevisionId, requirementRevisionIds: parent.requirementRevisionIds, workflowRevisionId: ids.workflow, policySnapshot: parent.policySnapshot, initialBudget: parent.initialBudget, subjectKind: "task", parentRunId: runId, taskId: ids.task, executionPlanId: parent.executionPlanId }, { parent, executionPlan: executionPlan(), activeTaskIds: [], parentTerminal: false });
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
    engine.handle({ type: "RecordSupersedingRequirement", runId, newerRevisionId: "rrv_newinput01", decision: "continue_old_input", expectedVersion: current(store).version, idempotencyKey: "supersede-one", actor });
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
    });
    const actor = { actorId: "flow-test", correlationId: "subflow-test", roles: ["project-approver"] };
    const { bindingFingerprint: ignored, ...root } = rootBinding();
    void ignored;
    const parentBinding = createWorkflowRunBinding({ ...root, workflowRevisionId: parentWorkflow.workflowRevisionId, taskGraphFingerprint: plan.taskGraphFingerprint });
    engine.handle({ type: "StartRun", binding: parentBinding, expectedVersion: 0, idempotencyKey: "sub-parent", actor });
    const parent = store.loadRun(ids.rootRun)!;
    const parentStepRunId = parent.steps[0]!.stepRunId;
    const childRunId = RunIdSchema.parse("run_subflow001");
    const childBinding = createWorkflowRunBinding({
      runId: childRunId,
      projectId: parent.binding.projectId,
      changeRevisionId: parent.binding.changeRevisionId,
      requirementRevisionIds: parent.binding.requirementRevisionIds,
      workflowRevisionId: childWorkflow.workflowRevisionId,
      policySnapshot: parent.binding.policySnapshot,
      initialBudget: parent.binding.initialBudget,
      subjectKind: "subflow",
      parentRunId: parent.binding.runId,
      taskId: null,
      executionPlanId: parent.binding.executionPlanId,
      parentStepRunId,
    }, { parent: parent.binding, executionPlan: plan, activeTaskIds: [], parentTerminal: false });
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
  });
});

function dependencyFailureHarness(rule: { readonly policy: "block" | "skip" | "terminate" } | { readonly policy: "compensation"; readonly compensationTaskId: typeof ids.compensation } | { readonly policy: "waiver"; readonly requiredRole: string }) {
  const store = new TestFlowStore();
  const plan = dependencyPlan();
  const workflow = singleStepWorkflow();
  const engine = new FlowEngine(store, {
    getWorkflowRevision: () => workflow,
    getExecutionPlan: () => plan,
    getDependencyFailureRule: () => rule,
  } as never);
  const actor = { actorId: "flow-test", correlationId: "dependency-test", roles: ["project-approver"] };
  const { bindingFingerprint: ignored, ...root } = rootBinding();
  void ignored;
  const parentBinding = createWorkflowRunBinding({ ...root, workflowRevisionId: workflow.workflowRevisionId, taskGraphFingerprint: plan.taskGraphFingerprint });
  engine.handle({ type: "StartRun", binding: parentBinding, expectedVersion: 0, idempotencyKey: `dependency-root-${rule.policy}`, actor });
  const scheduled = engine.handle({ type: "ScheduleTaskFanOut", runId: ids.rootRun, expectedVersion: store.loadRun(ids.rootRun)!.version, idempotencyKey: `dependency-fanout-${rule.policy}`, actor }).response as { children: Array<{ taskId: typeof ids.dependency; childRunId: typeof ids.childRun }> };
  const childRunId = scheduled.children[0]!.childRunId;
  const parent = store.loadRun(ids.rootRun)!.binding;
  const child = createWorkflowRunBinding({ runId: childRunId, projectId: parent.projectId, changeRevisionId: parent.changeRevisionId, requirementRevisionIds: parent.requirementRevisionIds, workflowRevisionId: ids.workflow, policySnapshot: parent.policySnapshot, initialBudget: parent.initialBudget, subjectKind: "task", parentRunId: parent.runId, taskId: ids.dependency, executionPlanId: parent.executionPlanId }, { parent, executionPlan: plan, activeTaskIds: [], parentTerminal: false });
  engine.handle({ type: "StartRun", binding: child, expectedVersion: 0, idempotencyKey: `dependency-child-${rule.policy}`, actor });
  engine.handle({ type: "RecordExecutionFailure", runId: childRunId, errorClass: "fatal", expectedVersion: store.loadRun(childRunId)!.version, idempotencyKey: `dependency-fail-${rule.policy}`, actor });
  return { store, engine, actor, childRunId };
}
