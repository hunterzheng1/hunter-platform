import { createHash } from "node:crypto";

import {
  ExecutionPlanSchema,
  RunIdSchema,
  TaskIdSchema,
  type ExecutionPlan,
  type RunId,
  type TaskId,
} from "@hunter/domain";
import { z } from "zod";

export const MAX_EXECUTION_PLAN_TASKS = 1_024;
export const MAX_EXECUTION_PLAN_DEPENDENCY_EDGES = 16_384;

export const ChildTaskStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "canceled",
  "skipped",
]);
export type ChildTaskStatus = z.infer<typeof ChildTaskStatusSchema>;

export const DependencyFailureDecisionViewSchema = z
  .object({
    taskId: TaskIdSchema,
    action: z.enum(["blocked", "skipped", "compensate", "waived", "terminate"]),
  })
  .strict();
export type DependencyFailureDecisionView = z.infer<
  typeof DependencyFailureDecisionViewSchema
>;

const TaskChildViewSchema = z
  .object({
    taskId: TaskIdSchema,
    status: ChildTaskStatusSchema,
  })
  .strict();

function parsePlan(plan: Readonly<ExecutionPlan>): Readonly<ExecutionPlan> {
  try {
    if (plan !== null && typeof plan === "object") {
      const rawTasks = (plan as unknown as Record<string, unknown>).tasks;
      if (Array.isArray(rawTasks)) {
        if (rawTasks.length > MAX_EXECUTION_PLAN_TASKS) {
          throw new Error("TASK_SCHEDULER_PLAN_LIMIT_EXCEEDED");
        }
        let dependencyEdges = 0;
        for (const rawTask of rawTasks) {
          if (rawTask !== null && typeof rawTask === "object") {
            const dependsOn = (rawTask as Record<string, unknown>).dependsOn;
            if (Array.isArray(dependsOn)) {
              dependencyEdges += dependsOn.length;
              if (dependencyEdges > MAX_EXECUTION_PLAN_DEPENDENCY_EDGES) {
                throw new Error("TASK_SCHEDULER_PLAN_LIMIT_EXCEEDED");
              }
            }
          }
        }
      }
    }
    return ExecutionPlanSchema.parse(plan);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "TASK_SCHEDULER_PLAN_LIMIT_EXCEEDED"
    ) {
      throw error;
    }
    throw new Error("TASK_SCHEDULER_PLAN_INVALID");
  }
}

function parseChildren(input: unknown): readonly z.infer<typeof TaskChildViewSchema>[] {
  try {
    return z.array(TaskChildViewSchema).max(MAX_EXECUTION_PLAN_TASKS).parse(input);
  } catch {
    throw new Error("TASK_SCHEDULER_CHILDREN_INVALID");
  }
}

function parseDecisions(
  input: unknown,
): readonly DependencyFailureDecisionView[] {
  try {
    return z.array(DependencyFailureDecisionViewSchema).max(MAX_EXECUTION_PLAN_TASKS).parse(input);
  } catch {
    throw new Error("TASK_SCHEDULER_DECISIONS_INVALID");
  }
}

export function deriveChildRunId(parentRunId: RunId, taskId: TaskId): RunId {
  try {
    const parent = RunIdSchema.parse(parentRunId);
    const task = TaskIdSchema.parse(taskId);
    return RunIdSchema.parse(
      `run_${createHash("sha256").update(`${parent}:${task}`).digest("hex").slice(0, 24)}`,
    );
  } catch {
    throw new Error("CHILD_RUN_ID_INPUT_INVALID");
  }
}

export function deriveTaskFanOut(
  planInput: Readonly<ExecutionPlan>,
  childrenInput: readonly {
    readonly taskId: TaskId;
    readonly status: ChildTaskStatus;
  }[],
  decisionsInput: readonly DependencyFailureDecisionView[] = [],
): readonly TaskId[] {
  const plan = parsePlan(planInput);
  const children = parseChildren(childrenInput);
  const decisions = parseDecisions(decisionsInput);
  const planTaskIds = new Set(plan.tasks.map(({ taskId }) => taskId));

  const byTask = new Map<TaskId, ChildTaskStatus>();
  for (const child of children) {
    if (!planTaskIds.has(child.taskId)) throw new Error("TASK_CHILD_NOT_IN_PLAN");
    if (byTask.has(child.taskId)) throw new Error("TASK_CHILD_DUPLICATE");
    byTask.set(child.taskId, child.status);
  }

  const decisionByTask = new Map<TaskId, DependencyFailureDecisionView>();
  for (const decision of decisions) {
    if (!planTaskIds.has(decision.taskId)) {
      throw new Error("DEPENDENCY_DECISION_TASK_NOT_IN_PLAN");
    }
    if (decisionByTask.has(decision.taskId)) {
      throw new Error("DEPENDENCY_DECISION_DUPLICATE");
    }
    if (byTask.has(decision.taskId) && decision.action !== "waived") {
      throw new Error("DEPENDENCY_DECISION_CHILD_CONFLICT");
    }
    decisionByTask.set(decision.taskId, decision);
    if (decision.action === "skipped") byTask.set(decision.taskId, "skipped");
  }

  const ready: TaskId[] = [];
  for (const task of plan.tasks) {
    if (byTask.has(task.taskId)) continue;
    const decision = decisionByTask.get(task.taskId);
    if (decision !== undefined && decision.action !== "waived") continue;
    const dependencyStatuses = task.dependsOn.map((taskId) => byTask.get(taskId));
    if (
      dependencyStatuses.some(
        (status) => status === "failed" || status === "canceled",
      ) &&
      decision?.action !== "waived"
    ) {
      throw new Error("DEPENDENCY_FAILURE_DECISION_REQUIRED");
    }
    if (
      dependencyStatuses.every(
        (status) =>
          status === "succeeded" ||
          status === "skipped" ||
          (decision?.action === "waived" &&
            (status === "failed" || status === "canceled")),
      )
    ) {
      ready.push(task.taskId);
    }
  }
  return ready.sort();
}
