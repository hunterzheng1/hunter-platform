import { describe, expect, it } from "vitest";

import {
  PHASE1_FAULT_SCENARIOS,
  PHASE1_LOAD_DATASET,
  Phase1BenchmarkReportSchema,
  Phase1SoakReportSchema,
  createPhase1FakeClock,
  createPhase1Random,
  summarizePhase1Samples,
} from "./phase1-load-fixture.js";

describe("Phase 1 deterministic load fixture", () => {
  it("freezes the dataset, seed, Fake clock, and complete failure matrix", () => {
    expect(PHASE1_LOAD_DATASET).toMatchObject({
      schemaVersion: 1,
      datasetId: "phase1-fixed-v1",
      readonlyWaitingSteps: 10,
      activeFakeSteps: 4,
      plannedSoakDurationMs: 86_400_000,
      soakCycleIntervalMs: 60_000,
      restartEveryCycles: 5,
      archiveEveryCycles: 10,
      rebuildEveryCycles: 30,
      loopEveryCycles: 1,
      faultMatrixEveryCycles: 60,
    });
    expect(PHASE1_FAULT_SCENARIOS).toEqual([
      "crash_before_commit",
      "crash_after_commit",
      "crash_before_dispatch",
      "crash_after_dispatch",
      "crash_before_receipt",
      "crash_after_receipt",
      "projection_loss",
      "archive_interrupted",
      "disk_full",
      "read_only",
      "sse_gap",
      "mobile_replay",
    ]);

    const first = createPhase1Random(PHASE1_LOAD_DATASET.seed);
    const second = createPhase1Random(PHASE1_LOAD_DATASET.seed);
    expect(Array.from({ length: 8 }, () => first.nextUint32())).toEqual(
      Array.from({ length: 8 }, () => second.nextUint32()),
    );

    const clock = createPhase1FakeClock(PHASE1_LOAD_DATASET.fakeClockStart);
    expect(clock.now().toISOString()).toBe(PHASE1_LOAD_DATASET.fakeClockStart);
    expect(clock.advance(1_250).toISOString()).toBe("2026-07-25T00:00:01.250Z");
  });

  it("uses an independent nearest-rank summary with fixed p50 and p95", () => {
    expect(summarizePhase1Samples([9, 1, 5, 7, 3])).toEqual({
      count: 5,
      minMs: 1,
      p50Ms: 5,
      p95Ms: 9,
      maxMs: 9,
    });
  });

  it("strictly validates benchmark and soak envelopes without private host fields", () => {
    const host = {
      platform: "win32",
      release: "10.0.26200",
      architecture: "x64",
      cpuModel: "fixture cpu",
      logicalCores: 8,
      totalMemoryBytes: 16_000_000_000,
      nodeVersion: "v24.0.0",
    };
    const metric = {
      count: 30,
      minMs: 1,
      p50Ms: 2,
      p95Ms: 3,
      maxMs: 3,
      targetMs: 1_000,
      status: "PASS",
    };
    const benchmark = Phase1BenchmarkReportSchema.parse({
      schemaVersion: 1,
      proofScope: "contract_only",
      build: {
        productVersion: "0.0.0",
        baseRevision: "1".repeat(40),
        sourceDigest: "2".repeat(64),
      },
      status: "PASS",
      dataset: PHASE1_LOAD_DATASET,
      execution: {
        warmupSamples: PHASE1_LOAD_DATASET.benchmarkWarmupSamples,
        measuredSamples: PHASE1_LOAD_DATASET.benchmarkMeasuredSamples,
      },
      host,
      measuredAt: "2026-07-25T00:00:00.000Z",
      metrics: {
        projectListInteractive: metric,
        runPageInteractive: metric,
        eventToUiVisible: { ...metric, targetMs: 500 },
        concurrentWorkload: metric,
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
      faultAttempts: PHASE1_FAULT_SCENARIOS.map((scenario, index) => ({
        attemptId: `fat_${scenario}_${index + 1}`,
        scenario,
        status: "PASS",
        expected: "fixed expected outcome",
        observed: "fixed observed outcome",
        elapsedMs: index + 1,
        externalOperationCount: 1,
        duplicateExternalOperationCount: 0,
        falseSuccessCount: 0,
        failureHistoryPreserved: true,
        history: [{
          sequence: 1,
          outcome: "OBSERVED_PASS",
          code: "FIXTURE_PASS",
          observedAt: "2026-07-25T00:00:00.000Z",
        }],
      })),
      notes: ["Fake-only fixture"],
    });
    expect(benchmark.status).toBe("PASS");
    expect(() =>
      Phase1BenchmarkReportSchema.parse({
        ...benchmark,
        host: { ...host, hostname: "private-machine" },
      }),
    ).toThrow();
    expect(() =>
      Phase1BenchmarkReportSchema.parse({
        ...benchmark,
        metrics: {
          ...benchmark.metrics,
          projectListInteractive: {
            ...benchmark.metrics.projectListInteractive,
            count: 3,
          },
        },
      }),
    ).toThrow();
    expect(() =>
      Phase1BenchmarkReportSchema.parse({
        ...benchmark,
        metrics: {
          ...benchmark.metrics,
          projectListInteractive: {
            ...benchmark.metrics.projectListInteractive,
            p50Ms: 4,
            p95Ms: 3,
          },
        },
      }),
    ).toThrow();
    expect(() =>
      Phase1BenchmarkReportSchema.parse({
        ...benchmark,
        faultAttempts: benchmark.faultAttempts.map((attempt) => ({
          ...attempt,
          duplicateExternalOperationCount: 1,
          falseSuccessCount: 1,
          failureHistoryPreserved: false,
        })),
      }),
    ).toThrow();

    const notRun = {
      schemaVersion: 1 as const,
      proofScope: "contract_only" as const,
      build: benchmark.build,
      status: "NOT_RUN" as const,
      dataset: PHASE1_LOAD_DATASET,
      execution: {
        mode: "full" as const,
        cycleIntervalMs: PHASE1_LOAD_DATASET.soakCycleIntervalMs,
        restartEveryCycles: PHASE1_LOAD_DATASET.restartEveryCycles,
        archiveEveryCycles: PHASE1_LOAD_DATASET.archiveEveryCycles,
        rebuildEveryCycles: PHASE1_LOAD_DATASET.rebuildEveryCycles,
        loopEveryCycles: PHASE1_LOAD_DATASET.loopEveryCycles,
        faultMatrixEveryCycles: PHASE1_LOAD_DATASET.faultMatrixEveryCycles,
      },
      host,
      startedAt: null,
      completedAt: null,
      elapsedMs: 0,
      cycleCount: 0,
      restartCount: 0,
      archiveCount: 0,
      rebuildCount: 0,
      loopCount: 0,
      faultMatrixCount: 0,
      faultAttempts: [],
      cycleAttempts: [],
      resources: {
        initialHeapBytes: 0,
        peakHeapBytes: 0,
        finalHeapBytes: 0,
        initialRssBytes: 0,
        peakRssBytes: 0,
        finalRssBytes: 0,
        initialDatabaseBytes: 0,
        peakDatabaseBytes: 0,
        finalDatabaseBytes: 0,
        peakArchiveBytes: 0,
        finalArchiveBytes: 0,
        peakCheckpointBytes: 0,
        finalCheckpointBytes: 0,
      },
      observations: {
        receiptCount: 0,
        providerInvocationCount: 0,
        providerNativeEffectCount: 0,
        completedOutboxCount: 0,
        totalOutboxCount: 0,
        restartOperationCount: 0,
        highWaterPosition: 0,
        projectionPosition: 0,
        archiveFileCount: 0,
        failedAttemptCount: 0,
        falseSuccessCount: 0,
      },
      checks: {
        noDuplicateExternalOperations: false,
        noFalseSuccess: false,
        boundedResourceGrowth: false,
        allStatesExplainable: false,
        failedAttemptsPreserved: false,
      },
      notes: ["24h run has not started"],
    };
    expect(Phase1SoakReportSchema.parse(notRun).status).toBe("NOT_RUN");
    expect(
      Phase1SoakReportSchema.parse({
        ...notRun,
        scheduledRestartCount: 0,
        recoveryRestartCount: 0,
      }),
    ).toMatchObject({
      restartCount: 0,
      scheduledRestartCount: 0,
      recoveryRestartCount: 0,
    });
    expect(() =>
      Phase1SoakReportSchema.parse({
        ...notRun,
        status: "PASS",
        startedAt: "2026-07-25T00:00:00.000Z",
        completedAt: "2026-07-26T00:00:00.000Z",
        elapsedMs: PHASE1_LOAD_DATASET.plannedSoakDurationMs,
        checks: Object.fromEntries(
          Object.keys(notRun.checks).map((key) => [key, true]),
        ),
      }),
    ).toThrow();
    expect(() =>
      Phase1SoakReportSchema.parse({
        ...notRun,
        status: "NOT_PROVEN",
        faultMatrixCount: 1,
        faultAttempts: benchmark.faultAttempts.map((attempt, index) => ({
          ...attempt,
          attemptId: `fat_duplicate_mobile_${index + 1}`,
          scenario: "mobile_replay",
        })),
      }),
    ).toThrow();
  });
});
