import type { WorkflowStep } from "@hunter/domain";

import type { WorkflowRunState } from "./state.js";

export type RecoveryAttemptBlockReason =
  | "attempt_limit_reached"
  | "run_budget_exhausted";

export function currentRecoveryStep(
  state: WorkflowRunState,
): WorkflowRunState["steps"][number] | undefined {
  const active = [...state.steps].reverse().find(
    ({ conclusion }) => conclusion === "active",
  );
  if (active !== undefined) return active;
  if (state.status !== "failed" && state.status !== "needs_attention") {
    return undefined;
  }
  if (state.lastActivatedAttemptId !== undefined) {
    const lastActivated = [...state.steps].reverse().find((step) =>
      step.attempts.at(-1)?.attemptId === state.lastActivatedAttemptId
    );
    if (lastActivated !== undefined) return lastActivated;
  }
  return state.steps.at(-1);
}

export function recoveryAttemptBlockReason(
  state: WorkflowRunState,
  step: WorkflowStep,
  attemptNumber: number,
): RecoveryAttemptBlockReason | null {
  if (attemptNumber >= step.retryPolicy.maxAttempts) {
    return "attempt_limit_reached";
  }
  const reserved = state.scheduledChildren
    .filter(({ childRunId }) =>
      !state.acceptedChildRunIds.includes(childRunId)
    )
    .reduce((sum, child) => ({
      attempts: sum.attempts + child.budget.maxAttempts,
      elapsedMs: sum.elapsedMs + child.budget.maxElapsedMs,
      cost: sum.cost + child.budget.maxCost,
      tokens: sum.tokens + child.budget.maxTokens,
      loopIterations:
        sum.loopIterations + child.budget.maxLoopIterations,
    }), {
      attempts: 0,
      elapsedMs: 0,
      cost: 0,
      tokens: 0,
      loopIterations: 0,
    });
  const exhausted =
    state.budgetUsage.attempts + reserved.attempts + 1
      > state.binding.initialBudget.maxAttempts
    || state.budgetUsage.elapsedMs
      + reserved.elapsedMs
      + step.budgetCost.elapsedMs
      > state.binding.initialBudget.maxElapsedMs
    || state.budgetUsage.cost + reserved.cost + step.budgetCost.cost
      > state.binding.initialBudget.maxCost
    || state.budgetUsage.tokens + reserved.tokens
      > state.binding.initialBudget.maxTokens
    || state.budgetUsage.loopIterations + reserved.loopIterations
      > state.binding.initialBudget.maxLoopIterations;
  return exhausted ? "run_budget_exhausted" : null;
}
