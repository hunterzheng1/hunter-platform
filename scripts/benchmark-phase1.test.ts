import { describe, expect, it } from "vitest";

import {
  PHASE1_FAULT_SCENARIOS,
  Phase1BenchmarkReportSchema,
} from "@hunter/testkit";

import {
  runPhase1Benchmark,
  runPhase1FaultMatrix,
} from "./benchmark-phase1.js";

describe("Phase 1 benchmark and failure matrix", () => {
  it("preserves every injected failure and converges without duplicate effects or false success", async () => {
    const attempts = await runPhase1FaultMatrix();

    expect(attempts.map(({ scenario }) => scenario)).toEqual(
      PHASE1_FAULT_SCENARIOS,
    );
    expect(attempts.every(({ status }) => status === "PASS")).toBe(true);
    expect(
      attempts.every(
        ({ duplicateExternalOperationCount, falseSuccessCount }) =>
          duplicateExternalOperationCount === 0 && falseSuccessCount === 0,
      ),
    ).toBe(true);
    expect(
      attempts
        .filter(({ history }) =>
          history.some(({ outcome }) => outcome === "INJECTED_FAILURE"),
        )
        .every(({ history }) =>
          history.some(({ outcome }) => outcome === "RECOVERY_PASS"),
        ),
    ).toBe(true);
  });

  it("measures the fixed 10+4 local UI workload under frozen thresholds", async () => {
    const report = await runPhase1Benchmark({
      measuredAt: "2026-07-25T00:00:00.000Z",
    });
    expect(Phase1BenchmarkReportSchema.parse(report)).toEqual(report);
    expect(report).toMatchObject({
      schemaVersion: 1,
      proofScope: "contract_only",
      status: "PASS",
      dataset: {
        datasetId: "phase1-fixed-v1",
        readonlyWaitingSteps: 10,
        activeFakeSteps: 4,
      },
      execution: {
        warmupSamples: 5,
        measuredSamples: 30,
      },
      metrics: {
        projectListInteractive: { status: "PASS", targetMs: 1_000 },
        runPageInteractive: { status: "PASS", targetMs: 1_000 },
        eventToUiVisible: { status: "PASS", targetMs: 500 },
        concurrentWorkload: { status: "PASS" },
      },
      concurrentWorkloadEvidence: {
        uiStepCount: 14,
        readonlyWaitingStepCount: 10,
        activeFakeStepCount: 4,
        linkedActiveStepCount: 4,
        ledgerEventCount: 136,
        completedOutboxCount: 4,
        receiptCount: 4,
        providerInvocationCount: 4,
        providerNativeEffectCount: 4,
      },
    });
    expect(JSON.stringify(report)).not.toMatch(
      /(?:hostname|[A-Z]:\\|\/(?:home|Users|tmp)\/|token|cookie|authorization)/iu,
    );
  }, 20_000);
});
