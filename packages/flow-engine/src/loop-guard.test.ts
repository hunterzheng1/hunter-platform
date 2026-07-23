import {
  LoopPolicySchema,
  type LoopPolicy,
} from "@hunter/domain";
import { describe, expect, it } from "vitest";

import { evaluateLoopGuard } from "./loop-guard.js";

function policy(overrides: Partial<LoopPolicy> = {}): LoopPolicy {
  return LoopPolicySchema.parse({
    loopId: "lop_guard_main",
    routeId: "rte_guard_back",
    fromStepId: "stp_guard_verify",
    toStepId: "stp_guard_implement",
    maxIterations: 3,
    maxElapsedMs: 60_000,
    maxCost: 500,
    progressPredicate: { kind: "diff_present", source: "workspace.diff" },
    stagnation: {
      maxSameFailureFingerprint: 2,
      maxNoDiffIterations: 2,
      maxVerifierErrors: 1,
    },
    reuse: { profile: true, session: false, workspace: true },
    exhaustion: { target: "needs_attention", notify: true },
    ...overrides,
  });
}

const base = {
  policy: policy(),
  usage: {
    iterations: 0,
    elapsedMs: 0,
    cost: 0,
    lastProgressFingerprint: null,
    repeatedFailureFingerprintCount: 0,
    lastFailureFingerprint: null,
    noProgressCount: 0,
    verifierErrorCount: 0,
  },
  runLimit: {
    maxAttempts: 10,
    maxElapsedMs: 100_000,
    maxCost: 1_000,
    maxTokens: 1_000,
    maxLoopIterations: 3,
  },
  runUsage: {
    attempts: 1,
    elapsedMs: 1,
    cost: 1,
    tokens: 0,
    loopIterations: 0,
    lastProgressFingerprint: null,
    lastFailureFingerprint: null,
    repeatedFailureFingerprintCount: 0,
    noDiffCount: 0,
    verifierErrorCount: 0,
  },
  targetBudgetCost: { elapsedMs: 10, cost: 1 },
  stepBudgetAvailable: true,
  progressSatisfied: true,
  failureFingerprint: null,
  verifierError: false,
} as const;

describe("Loop guard", () => {
  it.each([
    ["MAX_ITERATIONS", { usage: { ...base.usage, iterations: 3 } }],
    ["ROOT_MAX_LOOP_ITERATIONS", { runUsage: { ...base.runUsage, loopIterations: 3 } }],
    ["MAX_ELAPSED", { usage: { ...base.usage, elapsedMs: 60_000 } }],
    ["MAX_COST", { usage: { ...base.usage, cost: 500 } }],
    ["REPEATED_FAILURE", {
      usage: {
        ...base.usage,
        lastFailureFingerprint: "same",
        repeatedFailureFingerprintCount: 2,
      },
      failureFingerprint: "same",
    }],
    ["NO_PROGRESS", {
      usage: { ...base.usage, noProgressCount: 2 },
      progressSatisfied: false,
    }],
    ["VERIFIER_ERROR", {
      usage: { ...base.usage, verifierErrorCount: 1 },
      verifierError: true,
    }],
    ["STEP_OR_RUN_BUDGET", { stepBudgetAvailable: false }],
  ] as const)("stops deterministically with %s before creating another Attempt", (reason, patch) => {
    expect(evaluateLoopGuard({ ...base, ...patch })).toMatchObject({
      proceed: false,
      reason,
    });
  });

  it("allows exact limits and stops only when the next activation exceeds them", () => {
    const result = evaluateLoopGuard({
      ...base,
      usage: {
        ...base.usage,
        iterations: 2,
        elapsedMs: 59_990,
        cost: 499,
        repeatedFailureFingerprintCount: 1,
        lastFailureFingerprint: "same",
        noProgressCount: 1,
        verifierErrorCount: 0,
      },
      runUsage: { ...base.runUsage, loopIterations: 2 },
      progressSatisfied: false,
      failureFingerprint: "same",
      verifierError: true,
    });
    expect(result).toEqual({
      proceed: true,
      next: {
        iteration: 3,
        elapsedMs: 60_000,
        cost: 500,
        repeatedFailureCount: 2,
        noProgressCount: 2,
        verifierErrorCount: 1,
      },
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1e16])(
    "rejects invalid numeric guard input %s with a fixed public error",
    (value) => {
      expect(() => evaluateLoopGuard({
        ...base,
        targetBudgetCost: { elapsedMs: value, cost: 1 },
      })).toThrow(/^LOOP_GUARD_INPUT_INVALID$/u);
    },
  );

  it("rejects derived arithmetic beyond MAX_SAFE_INTEGER", () => {
    expect(() => evaluateLoopGuard({
      ...base,
      usage: {
        ...base.usage,
        elapsedMs: Number.MAX_SAFE_INTEGER,
      },
      targetBudgetCost: { elapsedMs: 1, cost: 0 },
    })).toThrow(/^LOOP_GUARD_INPUT_INVALID$/u);
    expect(() => evaluateLoopGuard({
      ...base,
      usage: {
        ...base.usage,
        iterations: Number.MAX_SAFE_INTEGER,
      },
    })).toThrow(/^LOOP_GUARD_INPUT_INVALID$/u);
  });
});
