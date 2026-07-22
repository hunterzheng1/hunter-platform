import { z } from "zod";

export const RunBudgetLimitSchema = z
  .object({
    maxAttempts: z.number().int().positive(),
    maxElapsedMs: z.number().int().positive(),
    maxCost: z.number().nonnegative(),
    maxTokens: z.number().int().nonnegative(),
    maxLoopIterations: z.number().int().nonnegative(),
  })
  .strict();
export type RunBudgetLimit = z.infer<typeof RunBudgetLimitSchema>;

export interface RunBudgetUsage {
  readonly attempts: number;
  readonly elapsedMs: number;
  readonly cost: number;
  readonly tokens: number;
  readonly loopIterations: number;
  readonly lastProgressFingerprint: string | null;
  readonly lastFailureFingerprint: string | null;
  readonly repeatedFailureFingerprintCount: number;
  readonly noDiffCount: number;
  readonly verifierErrorCount: number;
}

export const EMPTY_RUN_BUDGET_USAGE: RunBudgetUsage = Object.freeze({
  attempts: 0,
  elapsedMs: 0,
  cost: 0,
  tokens: 0,
  loopIterations: 0,
  lastProgressFingerprint: null,
  lastFailureFingerprint: null,
  repeatedFailureFingerprintCount: 0,
  noDiffCount: 0,
  verifierErrorCount: 0,
});

export function remainingRunBudget(limit: RunBudgetLimit, usage: RunBudgetUsage): RunBudgetLimit {
  const remaining = RunBudgetLimitSchema.safeParse({
    maxAttempts: limit.maxAttempts - usage.attempts,
    maxElapsedMs: limit.maxElapsedMs - usage.elapsedMs,
    maxCost: limit.maxCost - usage.cost,
    maxTokens: limit.maxTokens - usage.tokens,
    maxLoopIterations: limit.maxLoopIterations - usage.loopIterations,
  });
  if (!remaining.success) throw new Error("CHILD_BUDGET_EXHAUSTED");
  return remaining.data;
}
