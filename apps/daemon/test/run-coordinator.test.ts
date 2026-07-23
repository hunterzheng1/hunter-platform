import {
  RunIdSchema,
  TaskIdSchema,
  canonicalSha256,
  createExecutionPlan,
  type RunId,
} from "@hunter/domain";
import {
  createWorkflowRunBinding,
  deriveChildRunId,
  type FlowCommand,
  type FlowCommandReceipt,
  type WorkflowRunState,
} from "@hunter/flow-engine";
import { describe, expect, it } from "vitest";

import { RunCoordinator } from "../src/services/run-coordinator.js";

const ids = {
  parent: RunIdSchema.parse("run_coordinator_parent"),
  api: TaskIdSchema.parse("tsk_coordinator_api"),
  ui: TaskIdSchema.parse("tsk_coordinator_ui"),
};

function plan() {
  const task = (taskId: typeof ids.api) => ({
    taskId,
    title: taskId,
    objective: "execute",
    acceptanceCriteria: ["verified"],
    repositoryIds: ["rep_coordinator_main"],
    moduleScopes: ["packages"],
    dependsOn: [],
    readSet: [],
    writeSet: ["packages"],
    access: "write" as const,
    workflowRevisionId: "wfr_coordinator_task",
    defaultAgentProfileId: "apr_coordinator_agent",
    sessionPolicy: "new" as const,
    workspacePolicy: {
      mode: "write" as const,
      isolation: "worktree" as const,
      reuse: false,
    },
  });
  return createExecutionPlan({
    executionPlanId: "epl_coordinator_main",
    projectId: "prj_coordinator_main",
    changeRevisionId: "crv_coordinator_main",
    requirementRevisionIds: ["rrv_coordinator_main"],
    tasks: [task(ids.ui), task(ids.api)],
    publishedAt: "2026-07-23T00:00:00.000Z",
  });
}

function parentState(): WorkflowRunState {
  const executionPlan = plan();
  const binding = createWorkflowRunBinding({
    runId: ids.parent,
    projectId: executionPlan.projectId,
    changeRevisionId: executionPlan.changeRevisionId,
    requirementRevisionIds: executionPlan.requirementRevisionIds,
    workflowRevisionId: "wfr_coordinator_root",
    policySnapshot: { snapshotHash: "a".repeat(64), policyVersion: 1 },
    initialBudget: {
      maxAttempts: 10,
      maxElapsedMs: 100_000,
      maxCost: 1_000,
      maxTokens: 1_000,
      maxLoopIterations: 3,
    },
    subjectKind: "change",
    parentRunId: null,
    taskId: null,
    executionPlanId: executionPlan.executionPlanId,
    taskGraphFingerprint: executionPlan.taskGraphFingerprint,
  });
  return {
    binding,
    version: 2,
    status: "running",
    budgetUsage: {
      attempts: 1,
      elapsedMs: 1,
      cost: 0,
      tokens: 0,
      loopIterations: 0,
      lastProgressFingerprint: null,
      lastFailureFingerprint: null,
      repeatedFailureFingerprintCount: 0,
      noDiffCount: 0,
      verifierErrorCount: 0,
    },
    steps: [],
    recoveryFacts: [],
    scheduledChildren: [],
    cancellationRequestedChildRunIds: [],
    attemptCancellation: null,
    scheduledRetry: null,
    loopUsage: {},
    acceptedChildRunIds: [],
    supersedingDecisions: [],
    dependencyFailureDecisions: [],
  };
}

function childState(command: Extract<FlowCommand, { type: "StartRun" }>): WorkflowRunState {
  return {
    ...parentState(),
    binding: command.binding,
    version: 3,
    status: "running",
  };
}

function harness(options: {
  malformedFanOut?: boolean;
  malformedStartReceipt?: boolean;
  failSecondStartOnce?: boolean;
  planOverride?: ReturnType<typeof plan>;
} = {}) {
  const frozenPlan = options.planOverride ?? plan();
  const parent = parentState();
  const started = new Map<RunId, FlowCommand>();
  const handled: FlowCommand[] = [];
  const receipts = new Map<string, { fingerprint: string; receipt: FlowCommandReceipt }>();
  let failed = false;
  let parentVersion = parent.version;
  let parentStatus = parent.status;
  const budget = {
    maxAttempts: 4,
    maxElapsedMs: 40_000,
    maxCost: 400,
    maxTokens: 400,
    maxLoopIterations: 1,
  };
  const handle = (command: FlowCommand): FlowCommandReceipt => {
    handled.push(command);
    const commandId = `${command.type}:${command.idempotencyKey}`;
    const fingerprint = canonicalSha256(command);
    const replay = receipts.get(commandId);
    if (replay !== undefined) {
      if (replay.fingerprint !== fingerprint) throw new Error("IDEMPOTENCY_KEY_REUSED");
      return replay.receipt;
    }
    if (command.type === "ScheduleTaskFanOut") {
      const response = options.malformedFanOut
        ? { children: [{ taskId: ids.api, childRunId: "private-native-id", budget }] }
        : {
            children: [ids.api, ids.ui].map((taskId) => ({
              taskId,
              childRunId: deriveChildRunId(ids.parent, taskId),
              budget,
            })),
          };
      const receipt = { commandId, response };
      receipts.set(commandId, { fingerprint, receipt });
      parentVersion += 1;
      return receipt;
    }
    if (command.type !== "StartRun") throw new Error("UNEXPECTED_COMMAND");
    if (
      options.failSecondStartOnce === true &&
      command.binding.taskId === ids.ui &&
      !failed
    ) {
      failed = true;
      throw new Error("SIMULATED_PARTIAL_FAILURE");
    }
    started.set(command.binding.runId, command);
    const receipt = {
      commandId,
      response: options.malformedStartReceipt === true
        ? { runId: command.binding.runId, privateSessionId: "native-private-id" }
        : {
            runId: command.binding.runId,
            bindingFingerprint: command.binding.bindingFingerprint,
          },
    };
    receipts.set(commandId, { fingerprint, receipt });
    return receipt;
  };
  const coordinator = new RunCoordinator({
    store: {
      loadRun: (runId) => {
        if (runId === ids.parent) {
          return { ...parent, version: parentVersion, status: parentStatus };
        }
        const parsedRunId = RunIdSchema.safeParse(runId);
        if (!parsedRunId.success) return null;
        const start = started.get(parsedRunId.data);
        return start?.type === "StartRun" ? childState(start) : null;
      },
      activeTaskIds: () => [...started.values()].flatMap((command) =>
        command.type === "StartRun" && command.binding.subjectKind === "task"
          ? [command.binding.taskId]
          : []),
    },
    definitions: {
      getExecutionPlan: () => frozenPlan,
    },
    commands: { handle },
  });
  return {
    coordinator,
    handled,
    started,
    parent,
    plan: frozenPlan,
    concludeParent: () => {
      parentStatus = "succeeded";
    },
  };
}

const dispatch = {
  parentRunId: ids.parent,
  expectedVersion: 2,
  idempotencyKey: "dispatch-coordinator-main",
  actor: { actorId: "coordinator-test", correlationId: "task-10" },
};

describe("RunCoordinator", () => {
  it("uses the frozen plan and durable fan-out receipt to start each Task child exactly once", () => {
    const { coordinator, started } = harness();
    const first = coordinator.dispatch(dispatch);
    const replay = coordinator.dispatch(dispatch);
    expect(replay).toEqual(first);
    expect(started).toHaveLength(2);
    for (const command of started.values()) {
      expect(command).toMatchObject({
        type: "StartRun",
        expectedVersion: 0,
        binding: {
          parentRunId: ids.parent,
          subjectKind: "task",
          executionPlanId: "epl_coordinator_main",
        },
      });
      if (command.type === "StartRun" && command.binding.subjectKind === "task") {
        expect(plan().tasks.find(({ taskId }) => taskId === command.binding.taskId)?.workspacePolicy)
          .toEqual({ mode: "write", isolation: "worktree", reuse: false });
      }
    }
  });

  it("recovers a partial child-start failure by replaying stable durable command keys", () => {
    const { coordinator, started } = harness({ failSecondStartOnce: true });
    expect(() => coordinator.dispatch(dispatch)).toThrow(/SIMULATED_PARTIAL_FAILURE/u);
    expect(started).toHaveLength(1);
    expect(coordinator.dispatch(dispatch).children).toHaveLength(2);
    expect(started).toHaveLength(2);
  });

  it("replays a completed dispatch after the parent later becomes terminal", () => {
    const { coordinator, concludeParent, started } = harness();
    const first = coordinator.dispatch(dispatch);
    concludeParent();
    expect(coordinator.dispatch(dispatch)).toEqual(first);
    expect(started).toHaveLength(2);
  });

  it("does not create a missing child after a partial failure if the parent becomes terminal", () => {
    const { coordinator, concludeParent, started } = harness({
      failSecondStartOnce: true,
    });
    expect(() => coordinator.dispatch(dispatch)).toThrow(/SIMULATED_PARTIAL_FAILURE/u);
    expect(started).toHaveLength(1);
    concludeParent();
    expect(() => coordinator.dispatch(dispatch)).toThrow(/PARENT_RUN_TERMINAL/u);
    expect(started).toHaveLength(1);
  });

  it("delegates same-key changed-payload rejection to the durable command store", () => {
    const { coordinator } = harness();
    coordinator.dispatch(dispatch);
    expect(() => coordinator.dispatch({
      ...dispatch,
      actor: { ...dispatch.actor, correlationId: "changed-payload" },
    })).toThrow(/IDEMPOTENCY_KEY_REUSED/u);
  });

  it("fails closed on malformed receipts and parent/plan mismatch", () => {
    expect(() => harness({ malformedFanOut: true }).coordinator.dispatch(dispatch))
      .toThrow(/^TASK_FANOUT_RECEIPT_INVALID$/u);
    expect(() => harness({ malformedStartReceipt: true }).coordinator.dispatch(dispatch))
      .toThrow(/^CHILD_START_RECEIPT_INVALID$/u);
    const mismatched = createExecutionPlan({
      executionPlanId: "epl_coordinator_other",
      projectId: "prj_coordinator_main",
      changeRevisionId: "crv_coordinator_main",
      requirementRevisionIds: ["rrv_coordinator_main"],
      tasks: plan().tasks,
      publishedAt: "2026-07-23T00:00:00.000Z",
    });
    expect(() => harness({ planOverride: mismatched }).coordinator.dispatch(dispatch))
      .toThrow(/PARENT_EXECUTION_PLAN_MISMATCH/u);
  });

  it("rejects a plan with a different frozen Requirement set before fan-out", () => {
    const requirementMismatch = createExecutionPlan({
      executionPlanId: "epl_coordinator_main",
      projectId: "prj_coordinator_main",
      changeRevisionId: "crv_coordinator_main",
      requirementRevisionIds: ["rrv_coordinator_other"],
      tasks: plan().tasks,
      publishedAt: "2026-07-23T00:00:00.000Z",
    });
    const { coordinator, handled } = harness({
      planOverride: requirementMismatch,
    });
    expect(() => coordinator.dispatch(dispatch))
      .toThrow(/^PARENT_EXECUTION_PLAN_MISMATCH$/u);
    expect(handled).toEqual([]);
  });

  it("rejects raw IDs and proxy input with fixed public errors", () => {
    const { coordinator } = harness();
    expect(() => coordinator.dispatch({ ...dispatch, parentRunId: "raw-parent" as never }))
      .toThrow(/^RUN_COORDINATOR_INPUT_INVALID$/u);
    expect(() => coordinator.dispatch(new Proxy({}, {
      get() {
        throw new Error("private proxy detail");
      },
    }) as never)).toThrow(/^RUN_COORDINATOR_INPUT_INVALID$/u);
  });
});
