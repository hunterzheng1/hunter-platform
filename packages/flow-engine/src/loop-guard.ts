import { LoopPolicySchema, type LoopPolicy } from "@hunter/domain";
import { z } from "zod";

import { RunBudgetLimitSchema, type RunBudgetLimit } from "./run-budget.js";

const BoundedIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const BoundedNumberSchema = z
  .number()
  .finite()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const FingerprintSchema = z.string().min(1).max(256).nullable();

const LoopUsageSchema = z
  .object({
    iterations: BoundedIntegerSchema,
    elapsedMs: BoundedIntegerSchema,
    cost: BoundedNumberSchema,
    lastProgressFingerprint: FingerprintSchema,
    repeatedFailureFingerprintCount: BoundedIntegerSchema,
    lastFailureFingerprint: FingerprintSchema,
    noProgressCount: BoundedIntegerSchema,
    verifierErrorCount: BoundedIntegerSchema,
  })
  .strict();

const RunUsageSchema = z
  .object({
    attempts: BoundedIntegerSchema,
    elapsedMs: BoundedIntegerSchema,
    cost: BoundedNumberSchema,
    tokens: BoundedIntegerSchema,
    loopIterations: BoundedIntegerSchema,
    lastProgressFingerprint: FingerprintSchema,
    lastFailureFingerprint: FingerprintSchema,
    repeatedFailureFingerprintCount: BoundedIntegerSchema,
    noDiffCount: BoundedIntegerSchema,
    verifierErrorCount: BoundedIntegerSchema,
  })
  .strict();

const LoopGuardInputSchema = z
  .object({
    policy: LoopPolicySchema,
    usage: LoopUsageSchema,
    runLimit: RunBudgetLimitSchema,
    runUsage: RunUsageSchema,
    targetBudgetCost: z
      .object({
        elapsedMs: BoundedIntegerSchema,
        cost: BoundedNumberSchema,
      })
      .strict(),
    stepBudgetAvailable: z.boolean(),
    progressSatisfied: z.boolean(),
    failureFingerprint: FingerprintSchema,
    verifierError: z.boolean(),
  })
  .strict();

export type LoopStopReason =
  | "MAX_ITERATIONS"
  | "ROOT_MAX_LOOP_ITERATIONS"
  | "MAX_ELAPSED"
  | "MAX_COST"
  | "REPEATED_FAILURE"
  | "NO_PROGRESS"
  | "VERIFIER_ERROR"
  | "STEP_OR_RUN_BUDGET";

export interface LoopGuardInput {
  readonly policy: LoopPolicy;
  readonly usage: z.infer<typeof LoopUsageSchema>;
  readonly runLimit: RunBudgetLimit;
  readonly runUsage: z.infer<typeof RunUsageSchema>;
  readonly targetBudgetCost: {
    readonly elapsedMs: number;
    readonly cost: number;
  };
  readonly stepBudgetAvailable: boolean;
  readonly progressSatisfied: boolean;
  readonly failureFingerprint: string | null;
  readonly verifierError: boolean;
}

interface NextLoopState {
  readonly iteration: number;
  readonly elapsedMs: number;
  readonly cost: number;
  readonly repeatedFailureCount: number;
  readonly noProgressCount: number;
  readonly verifierErrorCount: number;
}

export type LoopGuardResult =
  | { readonly proceed: true; readonly next: NextLoopState }
  | {
      readonly proceed: false;
      readonly reason: LoopStopReason;
      readonly next: NextLoopState;
    };

function safeIntegerAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("LOOP_GUARD_INPUT_INVALID");
  }
  return value;
}

function safeNumberAdd(left: number, right: number): number {
  const value = left + right;
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER ||
    (right > 0 && value <= left)
  ) {
    throw new Error("LOOP_GUARD_INPUT_INVALID");
  }
  return value;
}

export function evaluateLoopGuard(input: LoopGuardInput): LoopGuardResult {
  let parsed: z.infer<typeof LoopGuardInputSchema>;
  try {
    parsed = LoopGuardInputSchema.parse(input);
  } catch {
    throw new Error("LOOP_GUARD_INPUT_INVALID");
  }
  const safePolicyIntegers = [
    parsed.policy.maxIterations,
    parsed.policy.maxElapsedMs,
    parsed.policy.stagnation.maxSameFailureFingerprint,
    parsed.policy.stagnation.maxNoDiffIterations,
    parsed.policy.stagnation.maxVerifierErrors,
  ];
  const safeRunIntegers = [
    parsed.runLimit.maxAttempts,
    parsed.runLimit.maxElapsedMs,
    parsed.runLimit.maxTokens,
    parsed.runLimit.maxLoopIterations,
  ];
  if (
    safePolicyIntegers.some((value) => !Number.isSafeInteger(value)) ||
    safeRunIntegers.some((value) => !Number.isSafeInteger(value)) ||
    parsed.policy.maxCost !== undefined &&
      parsed.policy.maxCost > Number.MAX_SAFE_INTEGER ||
    parsed.runLimit.maxCost > Number.MAX_SAFE_INTEGER
  ) {
    throw new Error("LOOP_GUARD_INPUT_INVALID");
  }
  const next = {
    iteration: safeIntegerAdd(parsed.usage.iterations, 1),
    elapsedMs: safeIntegerAdd(
      parsed.usage.elapsedMs,
      parsed.targetBudgetCost.elapsedMs,
    ),
    cost: safeNumberAdd(parsed.usage.cost, parsed.targetBudgetCost.cost),
    repeatedFailureCount:
      parsed.failureFingerprint === null
        ? parsed.usage.repeatedFailureFingerprintCount
        : parsed.failureFingerprint === parsed.usage.lastFailureFingerprint
          ? safeIntegerAdd(parsed.usage.repeatedFailureFingerprintCount, 1)
          : 1,
    noProgressCount: parsed.progressSatisfied
      ? 0
      : safeIntegerAdd(parsed.usage.noProgressCount, 1),
    verifierErrorCount: parsed.verifierError
      ? safeIntegerAdd(parsed.usage.verifierErrorCount, 1)
      : 0,
  };
  const stop = (reason: LoopStopReason): LoopGuardResult => ({
    proceed: false,
    reason,
    next,
  });
  if (next.iteration > parsed.policy.maxIterations) return stop("MAX_ITERATIONS");
  if (
    safeIntegerAdd(parsed.runUsage.loopIterations, 1) >
    parsed.runLimit.maxLoopIterations
  ) {
    return stop("ROOT_MAX_LOOP_ITERATIONS");
  }
  if (next.elapsedMs > parsed.policy.maxElapsedMs) return stop("MAX_ELAPSED");
  if (parsed.policy.maxCost !== undefined && next.cost > parsed.policy.maxCost) {
    return stop("MAX_COST");
  }
  if (
    next.repeatedFailureCount >
    parsed.policy.stagnation.maxSameFailureFingerprint
  ) {
    return stop("REPEATED_FAILURE");
  }
  if (next.noProgressCount > parsed.policy.stagnation.maxNoDiffIterations) {
    return stop("NO_PROGRESS");
  }
  if (next.verifierErrorCount > parsed.policy.stagnation.maxVerifierErrors) {
    return stop("VERIFIER_ERROR");
  }
  if (!parsed.stepBudgetAvailable) return stop("STEP_OR_RUN_BUDGET");
  return { proceed: true, next };
}
