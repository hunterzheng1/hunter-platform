import {
  RunIdSchema,
  TaskIdSchema,
  createExecutionPlan,
  type TaskId,
} from "@hunter/domain";
import { describe, expect, it } from "vitest";

import {
  deriveChildRunId,
  deriveTaskFanOut,
  MAX_EXECUTION_PLAN_TASKS,
} from "./task-scheduler.js";

const ids = {
  parent: RunIdSchema.parse("run_scheduler_parent"),
  api: TaskIdSchema.parse("tsk_scheduler_api"),
  ui: TaskIdSchema.parse("tsk_scheduler_ui"),
  integration: TaskIdSchema.parse("tsk_scheduler_integration"),
  unknown: TaskIdSchema.parse("tsk_scheduler_unknown"),
};

function plan() {
  const task = (taskId: TaskId, dependsOn: readonly TaskId[] = []) => ({
    taskId,
    title: taskId,
    objective: "execute",
    acceptanceCriteria: ["verified"],
    repositoryIds: ["rep_scheduler_main"],
    moduleScopes: ["packages"],
    dependsOn,
    readSet: [],
    writeSet: ["packages"],
    access: "write" as const,
    workflowRevisionId: "wfr_scheduler_task",
    defaultAgentProfileId: "apr_scheduler_agent",
    sessionPolicy: "new" as const,
    workspacePolicy: {
      mode: "write" as const,
      isolation: "worktree" as const,
      reuse: false,
    },
  });
  return createExecutionPlan({
    executionPlanId: "epl_scheduler_main",
    projectId: "prj_scheduler_main",
    changeRevisionId: "crv_scheduler_main",
    requirementRevisionIds: ["rrv_scheduler_main"],
    tasks: [
      task(ids.integration, [ids.api, ids.ui]),
      task(ids.ui),
      task(ids.api),
    ],
    publishedAt: "2026-07-23T00:00:00.000Z",
  });
}

function planWithTaskCount(count: number) {
  return createExecutionPlan({
    executionPlanId: "epl_scheduler_limit",
    projectId: "prj_scheduler_main",
    changeRevisionId: "crv_scheduler_main",
    requirementRevisionIds: ["rrv_scheduler_main"],
    tasks: Array.from({ length: count }, (_, index) => ({
      taskId: TaskIdSchema.parse(`tsk_limit${index.toString().padStart(5, "0")}`),
      title: `Task ${index}`,
      objective: "execute",
      acceptanceCriteria: ["verified"],
      repositoryIds: ["rep_scheduler_main"],
      moduleScopes: ["packages"],
      dependsOn: [],
      readSet: [],
      writeSet: ["packages"],
      access: "write" as const,
      workflowRevisionId: "wfr_scheduler_task",
      defaultAgentProfileId: "apr_scheduler_agent",
      sessionPolicy: "new" as const,
      workspacePolicy: {
        mode: "write" as const,
        isolation: "worktree" as const,
        reuse: false,
      },
    })),
    publishedAt: "2026-07-23T00:00:00.000Z",
  });
}

describe("Task scheduler", () => {
  it("fans out independent Tasks deterministically and waits for fan-in", () => {
    expect(deriveTaskFanOut(plan(), [])).toEqual([ids.api, ids.ui]);
    expect(deriveTaskFanOut(plan(), [
      { taskId: ids.api, status: "succeeded" },
      { taskId: ids.ui, status: "running" },
    ])).toEqual([]);
    expect(deriveTaskFanOut(plan(), [
      { taskId: ids.api, status: "succeeded" },
      { taskId: ids.ui, status: "succeeded" },
    ])).toEqual([ids.integration]);
  });

  it("derives a stable branded child Run identity", () => {
    const first = deriveChildRunId(ids.parent, ids.api);
    expect(first).toBe(deriveChildRunId(ids.parent, ids.api));
    expect(first).not.toBe(deriveChildRunId(ids.parent, ids.ui));
    expect(RunIdSchema.parse(first)).toBe(first);
  });

  it("rejects duplicate, unknown, and unbranded scheduling views", () => {
    expect(() => deriveTaskFanOut(plan(), [
      { taskId: ids.api, status: "running" },
      { taskId: ids.api, status: "succeeded" },
    ])).toThrow(/TASK_CHILD_DUPLICATE/u);
    expect(() => deriveTaskFanOut(plan(), [
      { taskId: ids.unknown, status: "running" },
    ])).toThrow(/TASK_CHILD_NOT_IN_PLAN/u);
    expect(() => deriveTaskFanOut(plan(), [], [
      { taskId: ids.integration, action: "blocked" },
      { taskId: ids.integration, action: "skipped" },
    ])).toThrow(/DEPENDENCY_DECISION_DUPLICATE/u);
    expect(() => deriveTaskFanOut(plan(), [], [
      { taskId: ids.unknown, action: "blocked" },
    ])).toThrow(/DEPENDENCY_DECISION_TASK_NOT_IN_PLAN/u);
    expect(() => deriveTaskFanOut(plan(), [
      { taskId: ids.api, status: "failed" },
    ], [
      { taskId: ids.api, action: "skipped" },
    ])).toThrow(/DEPENDENCY_DECISION_CHILD_CONFLICT/u);
    expect(() => deriveTaskFanOut(plan(), Array.from({ length: 1_025 }, () => ({
      taskId: ids.api,
      status: "running" as const,
    })))).toThrow(/TASK_SCHEDULER_CHILDREN_INVALID/u);
    expect(() => deriveChildRunId("raw-parent" as never, ids.api)).toThrow(/CHILD_RUN_ID_INPUT_INVALID/u);
    expect(() => deriveTaskFanOut(new Proxy({}, {
      get() {
        throw new Error("private proxy detail");
      },
    }) as never, [])).toThrow(/^TASK_SCHEDULER_PLAN_INVALID$/u);
  });

  it("requires an explicit decision for failed dependencies", () => {
    const children = [
      { taskId: ids.api, status: "failed" as const },
      { taskId: ids.ui, status: "running" as const },
    ];
    expect(() => deriveTaskFanOut(plan(), children)).toThrow(/DEPENDENCY_FAILURE_DECISION_REQUIRED/u);
    expect(deriveTaskFanOut(plan(), children, [
      { taskId: ids.integration, action: "waived" },
    ])).toEqual([]);
    expect(deriveTaskFanOut(plan(), [
      ...children,
      { taskId: ids.integration, status: "running" as const },
    ], [
      { taskId: ids.integration, action: "waived" },
    ])).toEqual([]);
  });

  it("rejects a plan above the shared fan-out resource limit", () => {
    expect(() => deriveTaskFanOut(
      planWithTaskCount(MAX_EXECUTION_PLAN_TASKS + 1),
      [],
    )).toThrow(/TASK_SCHEDULER_PLAN_LIMIT_EXCEEDED/u);
  });
});
