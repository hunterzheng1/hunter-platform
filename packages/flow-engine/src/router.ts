import { TaskIdSchema, type ExecutionPlan, type RouteOutcome, type SessionPolicy, type TaskId, type WorkflowRevision } from "@hunter/domain";
import { z } from "zod";

export function selectRoute(
  workflow: WorkflowRevision,
  stepId: string,
  outcome: RouteOutcome,
  facts: Readonly<Record<string, string | number | boolean>>,
) {
  const candidates = workflow.routes.filter(
    (route) => route.fromStepId === stepId && route.outcome === outcome,
  );
  const conditioned = candidates
    .filter((route) => route.condition !== undefined)
    .filter((route) => route.condition?.kind === "equals" && facts[route.condition.fact] === route.condition.value)
    .sort((left, right) => right.priority - left.priority);
  const route = conditioned[0] ?? candidates.find(({ condition }) => condition === undefined) ?? null;
  if (route === null) return null;
  return {
    route,
    loop: workflow.loops.find(({ routeId }) => routeId === route.routeId) ?? null,
  };
}

export type ChildTaskStatus = "running" | "succeeded" | "failed" | "canceled" | "skipped";

export function deriveTaskFanOut(
  plan: Readonly<ExecutionPlan>,
  children: readonly { readonly taskId: TaskId; readonly status: ChildTaskStatus }[],
  decisions: readonly DependencyFailureDecisionView[] = [],
): readonly TaskId[] {
  const byTask: Partial<Record<TaskId, ChildTaskStatus>> = {};
  for (const child of children) {
    if (byTask[child.taskId] !== undefined) throw new Error("TASK_CHILD_DUPLICATE");
    byTask[child.taskId] = child.status;
  }
  for (const decision of decisions) {
    if (decision.action === "skipped") byTask[decision.taskId] = "skipped";
  }
  const ready: TaskId[] = [];
  for (const task of plan.tasks) {
    if (byTask[task.taskId] !== undefined) continue;
    const decision = decisions.find(({ taskId }) => taskId === task.taskId);
    if (decision !== undefined && decision.action !== "waived") continue;
    const dependencyStatuses = task.dependsOn.map((taskId) => byTask[taskId]);
    if (dependencyStatuses.some((status) => status === "failed" || status === "canceled")) {
      if (decision?.action !== "waived") throw new Error("DEPENDENCY_FAILURE_DECISION_REQUIRED");
    }
    if (dependencyStatuses.every((status) => status === "succeeded" || status === "skipped" || (decision?.action === "waived" && (status === "failed" || status === "canceled")))) ready.push(task.taskId);
  }
  return ready.sort();
}

export type DependencyFailurePolicy = "block" | "skip" | "compensation" | "waiver" | "terminate";

export const FrozenDependencyFailureRuleSchema = z.discriminatedUnion("policy", [
  z.strictObject({ policy: z.enum(["block", "skip", "terminate"]) }),
  z.strictObject({ policy: z.literal("compensation"), compensationTaskId: TaskIdSchema }),
  z.strictObject({ policy: z.literal("waiver"), requiredRole: z.string().trim().min(1) }),
]);
export type FrozenDependencyFailureRule = z.infer<typeof FrozenDependencyFailureRuleSchema>;

export interface DependencyFailureDecisionView {
  readonly taskId: TaskId;
  readonly action: "blocked" | "skipped" | "compensate" | "waived" | "terminate";
}

export function resolveDependencyFailure(input: {
  readonly policy: DependencyFailurePolicy;
  readonly compensationTaskId?: TaskId | undefined;
  readonly waiver?: { readonly actorId: string; readonly contentHash: string } | undefined;
}) {
  switch (input.policy) {
    case "block": return { action: "blocked" } as const;
    case "skip": return { action: "skipped" } as const;
    case "terminate": return { action: "terminate" } as const;
    case "compensation":
      if (input.compensationTaskId === undefined) throw new Error("COMPENSATION_TASK_REQUIRED");
      return { action: "compensate", taskId: input.compensationTaskId } as const;
    case "waiver":
      if (input.waiver === undefined || !/^[a-f0-9]{64}$/u.test(input.waiver.contentHash) || input.waiver.actorId.trim() === "") throw new Error("DEPENDENCY_WAIVER_REQUIRED");
      return { action: "waived", receiptHash: input.waiver.contentHash } as const;
  }
}

export function resolveSupersedingRequirement<T>(
  binding: T,
  input: { readonly newerRevisionId: string; readonly decision: "continue_old_input" | "terminate" | "create_new_plan" },
): { readonly binding: T; readonly newerRevisionId: string; readonly action: typeof input.decision } {
  if (!['continue_old_input', 'terminate', 'create_new_plan'].includes(input.decision)) throw new Error("SUPERSEDING_REQUIREMENT_DECISION_REQUIRED");
  return { binding, newerRevisionId: input.newerRevisionId, action: input.decision };
}

export function resolveResumeFailure(policy: SessionPolicy) {
  return policy === "resume_if_supported" || policy === "new"
    ? { action: "new_session_handoff", status: "paused" } as const
    : { action: "needs_attention", status: "needs_attention" } as const;
}
