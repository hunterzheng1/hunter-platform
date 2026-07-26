import { cpus, release, totalmem } from "node:os";

import { z } from "zod";

export const PHASE1_FAULT_SCENARIOS = [
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
] as const;

export const Phase1FaultScenarioSchema = z.enum(PHASE1_FAULT_SCENARIOS);
export type Phase1FaultScenario = z.infer<typeof Phase1FaultScenarioSchema>;

export const Phase1EvidenceStatusSchema = z.enum([
  "PASS",
  "FAIL",
  "BLOCKED",
  "NOT_PROVEN",
  "NOT_RUN",
]);
export type Phase1EvidenceStatus = z.infer<typeof Phase1EvidenceStatusSchema>;

export const Phase1LoadDatasetSchema = z.strictObject({
  schemaVersion: z.literal(1),
  datasetId: z.literal("phase1-fixed-v1"),
  seed: z.number().int().positive().max(0xffff_ffff),
  fakeClockStart: z.iso.datetime(),
  projectCount: z.number().int().positive().max(1_000),
  runCount: z.number().int().positive().max(10_000),
  stepsPerRun: z.number().int().positive().max(500),
  readonlyWaitingSteps: z.literal(10),
  activeFakeSteps: z.literal(4),
  benchmarkWarmupSamples: z.number().int().nonnegative().max(100),
  benchmarkMeasuredSamples: z.number().int().positive().max(1_000),
  plannedSoakDurationMs: z.literal(86_400_000),
  soakCycleIntervalMs: z.number().int().positive().max(60_000),
  restartEveryCycles: z.number().int().positive(),
  archiveEveryCycles: z.number().int().positive(),
  rebuildEveryCycles: z.number().int().positive(),
  loopEveryCycles: z.number().int().positive(),
  faultMatrixEveryCycles: z.number().int().positive(),
  maxHeapGrowthBytes: z.number().int().positive(),
  maxRssGrowthBytes: z.number().int().positive(),
  maxDatabaseGrowthPerCycleBytes: z.number().int().positive(),
  maxDatabaseBytes: z.number().int().positive(),
  maxArchiveBytes: z.number().int().positive(),
  maxCheckpointBytes: z.number().int().positive(),
});
export type Phase1LoadDataset = z.infer<typeof Phase1LoadDatasetSchema>;

export const PHASE1_LOAD_DATASET = Object.freeze(
  Phase1LoadDatasetSchema.parse({
    schemaVersion: 1,
    datasetId: "phase1-fixed-v1",
    seed: 0x4855_4e54,
    fakeClockStart: "2026-07-25T00:00:00.000Z",
    projectCount: 64,
    runCount: 128,
    stepsPerRun: 14,
    readonlyWaitingSteps: 10,
    activeFakeSteps: 4,
    benchmarkWarmupSamples: 5,
    benchmarkMeasuredSamples: 30,
    plannedSoakDurationMs: 86_400_000,
    soakCycleIntervalMs: 60_000,
    restartEveryCycles: 5,
    archiveEveryCycles: 10,
    rebuildEveryCycles: 30,
    loopEveryCycles: 1,
    faultMatrixEveryCycles: 60,
    maxHeapGrowthBytes: 268_435_456,
    maxRssGrowthBytes: 536_870_912,
    maxDatabaseGrowthPerCycleBytes: 262_144,
    maxDatabaseBytes: 536_870_912,
    maxArchiveBytes: 67_108_864,
    maxCheckpointBytes: 16_777_216,
  }),
);

export interface Phase1Random {
  nextUint32(): number;
  nextFloat(): number;
}

export function createPhase1Random(seed: number): Phase1Random {
  const parsedSeed = z.number().int().positive().max(0xffff_ffff).parse(seed);
  let state = parsedSeed >>> 0;
  return {
    nextUint32(): number {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state;
    },
    nextFloat(): number {
      return this.nextUint32() / 0x1_0000_0000;
    },
  };
}

export interface Phase1FakeClock {
  now(): Date;
  advance(milliseconds: number): Date;
}

export function createPhase1FakeClock(startedAt: string): Phase1FakeClock {
  let current = Date.parse(z.iso.datetime().parse(startedAt));
  return {
    now: () => new Date(current),
    advance(milliseconds: number): Date {
      const duration = z.number().int().nonnegative().parse(milliseconds);
      current += duration;
      return new Date(current);
    },
  };
}

export const Phase1HostSummarySchema = z.strictObject({
  platform: z.enum(["win32", "linux", "darwin"]),
  release: z.string().trim().min(1).max(120),
  architecture: z.string().trim().min(1).max(40),
  cpuModel: z.string().trim().min(1).max(200),
  logicalCores: z.number().int().positive(),
  totalMemoryBytes: z.number().int().positive(),
  nodeVersion: z.string().regex(/^v[0-9]+\.[0-9]+\.[0-9]+/u),
});
export type Phase1HostSummary = z.infer<typeof Phase1HostSummarySchema>;

export function summarizePhase1Host(): Phase1HostSummary {
  const processors = cpus();
  return Phase1HostSummarySchema.parse({
    platform: process.platform,
    release: release(),
    architecture: process.arch,
    cpuModel: processors[0]?.model.trim() || "unknown cpu",
    logicalCores: Math.max(1, processors.length),
    totalMemoryBytes: totalmem(),
    nodeVersion: process.version,
  });
}

export const Phase1SampleSummarySchema = z.strictObject({
  count: z.number().int().positive(),
  minMs: z.number().finite().nonnegative(),
  p50Ms: z.number().finite().nonnegative(),
  p95Ms: z.number().finite().nonnegative(),
  maxMs: z.number().finite().nonnegative(),
});
export type Phase1SampleSummary = z.infer<typeof Phase1SampleSummarySchema>;

function nearestRank(sorted: readonly number[], percentile: number): number {
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
  const value = sorted[index];
  if (value === undefined) throw new Error("PHASE1_SAMPLE_SET_EMPTY");
  return value;
}

export function summarizePhase1Samples(samples: readonly number[]): Phase1SampleSummary {
  if (samples.length === 0 || samples.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    throw new Error("PHASE1_SAMPLE_SET_INVALID");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return Phase1SampleSummarySchema.parse({
    count: sorted.length,
    minMs: sorted[0],
    p50Ms: nearestRank(sorted, 0.5),
    p95Ms: nearestRank(sorted, 0.95),
    maxMs: sorted.at(-1),
  });
}

export const Phase1MetricSchema = Phase1SampleSummarySchema.extend({
  targetMs: z.number().finite().positive(),
  status: z.enum(["PASS", "FAIL", "NOT_PROVEN"]),
}).strict().superRefine((metric, context) => {
  if (
    metric.minMs > metric.p50Ms
    || metric.p50Ms > metric.p95Ms
    || metric.p95Ms > metric.maxMs
  ) {
    context.addIssue({
      code: "custom",
      path: ["p95Ms"],
      message: "metric summary must be monotonic",
    });
  }
  const meetsTarget = metric.p95Ms < metric.targetMs;
  if (metric.status === "PASS" && !meetsTarget) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "PASS requires p95 below target",
    });
  }
  if (metric.status === "FAIL" && meetsTarget) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "FAIL requires p95 at or above target",
    });
  }
});
export type Phase1Metric = z.infer<typeof Phase1MetricSchema>;

export const Phase1FaultAttemptSchema = z.strictObject({
  attemptId: z.string().regex(/^fat_[a-z0-9_]+$/u),
  scenario: Phase1FaultScenarioSchema,
  status: z.enum(["PASS", "FAIL", "NOT_PROVEN"]),
  expected: z.string().trim().min(1).max(500),
  observed: z.string().trim().min(1).max(1_000),
  elapsedMs: z.number().finite().nonnegative(),
  externalOperationCount: z.number().int().nonnegative(),
  duplicateExternalOperationCount: z.number().int().nonnegative(),
  falseSuccessCount: z.number().int().nonnegative(),
  failureHistoryPreserved: z.boolean(),
  history: z.array(z.strictObject({
    sequence: z.number().int().positive(),
    outcome: z.enum([
      "INJECTED_FAILURE",
      "EXPECTED_REJECTION",
      "RECOVERY_PASS",
      "OBSERVED_PASS",
      "NOT_PROVEN",
    ]),
    code: z.string().regex(/^[A-Z0-9_:-]+$/u).max(200),
    observedAt: z.iso.datetime(),
  })).min(1).max(20),
}).superRefine((attempt, context) => {
  attempt.history.forEach((entry, index) => {
    if (entry.sequence !== index + 1) {
      context.addIssue({
        code: "custom",
        path: ["history", index, "sequence"],
        message: "fault history sequence must be contiguous",
      });
    }
  });
  if (
    attempt.status === "PASS"
    && (
      attempt.history.at(-1)?.outcome === "NOT_PROVEN"
      || attempt.duplicateExternalOperationCount !== 0
      || attempt.falseSuccessCount !== 0
      || !attempt.failureHistoryPreserved
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "PASS requires preserved history without duplicates or false success",
    });
  }
  if (attempt.status === "PASS") {
    const requiresRecovery = attempt.history.some(
      ({ outcome }) =>
        outcome === "INJECTED_FAILURE"
        || outcome === "EXPECTED_REJECTION",
    );
    const hasTerminalProof = requiresRecovery
      ? attempt.history.some(({ outcome }) => outcome === "RECOVERY_PASS")
      : attempt.history.at(-1)?.outcome === "OBSERVED_PASS";
    if (!hasTerminalProof) {
      context.addIssue({
        code: "custom",
        path: ["history"],
        message: "PASS requires scenario terminal recovery or observation evidence",
      });
    }
  }
});
export type Phase1FaultAttempt = z.infer<typeof Phase1FaultAttemptSchema>;

export const Phase1BuildIdentitySchema = z.strictObject({
  productVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/u),
  baseRevision: z.string().regex(/^[a-f0-9]{40}$/u),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type Phase1BuildIdentity = z.infer<typeof Phase1BuildIdentitySchema>;

export const Phase1FailureEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  proofScope: z.literal("contract_only"),
  build: Phase1BuildIdentitySchema,
  command: z.enum(["benchmark", "soak"]),
  status: z.enum(["FAIL", "NOT_PROVEN"]),
  observedAt: z.iso.datetime(),
  errorCode: z.string().regex(/^[A-Z0-9_:-]+$/u).max(200),
});
export type Phase1FailureEnvelope = z.infer<
  typeof Phase1FailureEnvelopeSchema
>;

const Phase1ReportBase = {
  schemaVersion: z.literal(1),
  proofScope: z.literal("contract_only"),
  build: Phase1BuildIdentitySchema,
  dataset: Phase1LoadDatasetSchema,
  host: Phase1HostSummarySchema,
  notes: z.array(z.string().trim().min(1).max(1_000)).max(100),
} as const;

export const Phase1BenchmarkReportSchema = z.strictObject({
  ...Phase1ReportBase,
  status: Phase1EvidenceStatusSchema,
  execution: z.strictObject({
    warmupSamples: z.number().int().nonnegative(),
    measuredSamples: z.number().int().positive(),
  }),
  measuredAt: z.iso.datetime(),
  metrics: z.strictObject({
    projectListInteractive: Phase1MetricSchema,
    runPageInteractive: Phase1MetricSchema,
    eventToUiVisible: Phase1MetricSchema,
    concurrentWorkload: Phase1MetricSchema,
  }),
  concurrentWorkloadEvidence: z.strictObject({
    uiStepCount: z.number().int().nonnegative(),
    readonlyWaitingStepCount: z.number().int().nonnegative(),
    activeFakeStepCount: z.number().int().nonnegative(),
    linkedActiveStepCount: z.number().int().nonnegative(),
    ledgerEventCount: z.number().int().nonnegative(),
    completedOutboxCount: z.number().int().nonnegative(),
    receiptCount: z.number().int().nonnegative(),
    providerInvocationCount: z.number().int().nonnegative(),
    providerNativeEffectCount: z.number().int().nonnegative(),
  }),
  faultAttempts: z.array(Phase1FaultAttemptSchema).max(PHASE1_FAULT_SCENARIOS.length),
}).superRefine((report, context) => {
  const scenarios = report.faultAttempts.map(({ scenario }) => scenario);
  if (new Set(scenarios).size !== scenarios.length) {
    context.addIssue({
      code: "custom",
      path: ["faultAttempts"],
      message: "fault attempts must be unique by scenario",
    });
  }
  if (report.status === "PASS") {
    const complete = PHASE1_FAULT_SCENARIOS.every((scenario) => scenarios.includes(scenario));
    const workload = report.concurrentWorkloadEvidence;
    if (
      !complete
      || report.faultAttempts.some(({ status }) => status !== "PASS")
      || Object.values(report.metrics).some(({ status }) => status !== "PASS")
      || Object.values(report.metrics).some(
        ({ count }) => count !== report.execution.measuredSamples,
      )
      || report.execution.warmupSamples !== report.dataset.benchmarkWarmupSamples
      || report.execution.measuredSamples !== report.dataset.benchmarkMeasuredSamples
      || workload.uiStepCount !== report.dataset.stepsPerRun
      || workload.readonlyWaitingStepCount !== report.dataset.readonlyWaitingSteps
      || workload.activeFakeStepCount !== report.dataset.activeFakeSteps
      || workload.linkedActiveStepCount !== report.dataset.activeFakeSteps
      || workload.ledgerEventCount
        !== report.dataset.runCount + report.dataset.activeFakeSteps * 2
      || workload.completedOutboxCount !== report.dataset.activeFakeSteps
      || workload.receiptCount !== report.dataset.activeFakeSteps
      || workload.providerInvocationCount !== report.dataset.activeFakeSteps
      || workload.providerNativeEffectCount !== report.dataset.activeFakeSteps
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "PASS requires complete passing metrics and fault matrix",
      });
    }
  }
});
export type Phase1BenchmarkReport = z.infer<typeof Phase1BenchmarkReportSchema>;

export const Phase1SoakCycleAttemptSchema = z.strictObject({
  sequence: z.number().int().positive(),
  status: z.enum(["PASS", "FAIL"]),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  operationId: z.string().regex(/^opn_[a-z0-9_]+$/u),
  errorCode: z.string().regex(/^[A-Z0-9_:-]+$/u).max(200).nullable(),
  heapBytes: z.number().int().nonnegative(),
  databaseBytes: z.number().int().nonnegative(),
}).superRefine((attempt, context) => {
  if ((attempt.status === "PASS") !== (attempt.errorCode === null)) {
    context.addIssue({
      code: "custom",
      path: ["errorCode"],
      message: "only failed cycles carry an error code",
    });
  }
});
export type Phase1SoakCycleAttempt = z.infer<
  typeof Phase1SoakCycleAttemptSchema
>;

export const Phase1SoakReportSchema = z.strictObject({
  ...Phase1ReportBase,
  status: Phase1EvidenceStatusSchema,
  execution: z.strictObject({
    mode: z.enum(["full", "smoke"]),
    cycleIntervalMs: z.number().int().nonnegative().max(60_000),
    restartEveryCycles: z.number().int().positive(),
    archiveEveryCycles: z.number().int().positive(),
    rebuildEveryCycles: z.number().int().positive(),
    loopEveryCycles: z.number().int().positive(),
    faultMatrixEveryCycles: z.number().int().positive(),
  }),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  elapsedMs: z.number().int().nonnegative(),
  cycleCount: z.number().int().nonnegative(),
  restartCount: z.number().int().nonnegative(),
  scheduledRestartCount: z.number().int().nonnegative().optional(),
  recoveryRestartCount: z.number().int().nonnegative().optional(),
  archiveCount: z.number().int().nonnegative(),
  rebuildCount: z.number().int().nonnegative(),
  loopCount: z.number().int().nonnegative(),
  faultMatrixCount: z.number().int().nonnegative(),
  faultAttempts: z.array(Phase1FaultAttemptSchema),
  cycleAttempts: z.array(Phase1SoakCycleAttemptSchema),
  resources: z.strictObject({
    initialHeapBytes: z.number().int().nonnegative(),
    peakHeapBytes: z.number().int().nonnegative(),
    finalHeapBytes: z.number().int().nonnegative(),
    initialRssBytes: z.number().int().nonnegative(),
    peakRssBytes: z.number().int().nonnegative(),
    finalRssBytes: z.number().int().nonnegative(),
    initialDatabaseBytes: z.number().int().nonnegative(),
    peakDatabaseBytes: z.number().int().nonnegative(),
    finalDatabaseBytes: z.number().int().nonnegative(),
    peakArchiveBytes: z.number().int().nonnegative(),
    finalArchiveBytes: z.number().int().nonnegative(),
    peakCheckpointBytes: z.number().int().nonnegative(),
    finalCheckpointBytes: z.number().int().nonnegative(),
  }),
  observations: z.strictObject({
    receiptCount: z.number().int().nonnegative(),
    providerInvocationCount: z.number().int().nonnegative(),
    providerNativeEffectCount: z.number().int().nonnegative(),
    completedOutboxCount: z.number().int().nonnegative(),
    totalOutboxCount: z.number().int().nonnegative(),
    restartOperationCount: z.number().int().nonnegative(),
    highWaterPosition: z.number().int().nonnegative(),
    projectionPosition: z.number().int().nonnegative(),
    archiveFileCount: z.number().int().nonnegative(),
    failedAttemptCount: z.number().int().nonnegative(),
    falseSuccessCount: z.number().int().nonnegative(),
  }),
  checks: z.strictObject({
    noDuplicateExternalOperations: z.boolean(),
    noFalseSuccess: z.boolean(),
    boundedResourceGrowth: z.boolean(),
    allStatesExplainable: z.boolean(),
    failedAttemptsPreserved: z.boolean(),
  }),
}).superRefine((report, context) => {
  if (
    (report.scheduledRestartCount === undefined)
      !== (report.recoveryRestartCount === undefined)
    || (
      report.scheduledRestartCount !== undefined
      && report.recoveryRestartCount !== undefined
      && report.restartCount
        !== report.scheduledRestartCount + report.recoveryRestartCount
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["restartCount"],
      message: "restartCount must equal scheduled plus recovery restarts",
    });
  }
  if (
    report.startedAt !== null
    && report.completedAt !== null
    && (
      Date.parse(report.completedAt) < Date.parse(report.startedAt)
      || Date.parse(report.completedAt) - Date.parse(report.startedAt) + 1_000
        < report.elapsedMs
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["completedAt"],
      message: "wall-clock bounds must cover monotonic elapsed time",
    });
  }
  if (report.cycleCount !== report.cycleAttempts.length) {
    context.addIssue({
      code: "custom",
      path: ["cycleCount"],
      message: "cycleCount must equal the preserved cycle attempts",
    });
  }
  report.cycleAttempts.forEach((attempt, index) => {
    if (attempt.sequence !== index + 1) {
      context.addIssue({
        code: "custom",
        path: ["cycleAttempts", index, "sequence"],
        message: "cycle attempts must be contiguous",
      });
    }
  });
  if (
    report.faultAttempts.length
      !== report.faultMatrixCount * PHASE1_FAULT_SCENARIOS.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["faultAttempts"],
      message: "fault attempts must contain every matrix execution",
    });
  }
  for (
    let matrixIndex = 0;
    matrixIndex < report.faultMatrixCount;
    matrixIndex += 1
  ) {
    const offset = matrixIndex * PHASE1_FAULT_SCENARIOS.length;
    const scenarios = new Set(
      report.faultAttempts
        .slice(offset, offset + PHASE1_FAULT_SCENARIOS.length)
        .map(({ scenario }) => scenario),
    );
    if (
      scenarios.size !== PHASE1_FAULT_SCENARIOS.length
      || !PHASE1_FAULT_SCENARIOS.every((scenario) => scenarios.has(scenario))
    ) {
      context.addIssue({
        code: "custom",
        path: ["faultAttempts", offset],
        message: "each fault matrix must contain every scenario exactly once",
      });
    }
  }
  if (
    report.resources.peakHeapBytes < report.resources.initialHeapBytes
    || report.resources.peakHeapBytes < report.resources.finalHeapBytes
    || report.resources.peakRssBytes < report.resources.initialRssBytes
    || report.resources.peakRssBytes < report.resources.finalRssBytes
    || report.resources.peakDatabaseBytes < report.resources.initialDatabaseBytes
    || report.resources.peakDatabaseBytes < report.resources.finalDatabaseBytes
    || report.resources.peakArchiveBytes < report.resources.finalArchiveBytes
    || report.resources.peakCheckpointBytes < report.resources.finalCheckpointBytes
  ) {
    context.addIssue({
      code: "custom",
      path: ["resources"],
      message: "resource peaks must cover initial and final observations",
    });
  }
  if (
    report.status === "PASS"
    && (
      report.elapsedMs < report.dataset.plannedSoakDurationMs
      || report.execution.mode !== "full"
      || report.execution.cycleIntervalMs !== report.dataset.soakCycleIntervalMs
      || report.execution.restartEveryCycles !== report.dataset.restartEveryCycles
      || report.execution.archiveEveryCycles !== report.dataset.archiveEveryCycles
      || report.execution.rebuildEveryCycles !== report.dataset.rebuildEveryCycles
      || report.execution.loopEveryCycles !== report.dataset.loopEveryCycles
      || report.execution.faultMatrixEveryCycles
        !== report.dataset.faultMatrixEveryCycles
      || report.startedAt === null
      || report.completedAt === null
      || report.cycleCount
        < Math.floor(
          report.dataset.plannedSoakDurationMs
            / report.dataset.soakCycleIntervalMs,
        )
      || report.scheduledRestartCount === undefined
      || report.recoveryRestartCount === undefined
      || report.scheduledRestartCount
        !== Math.floor(
          report.cycleCount / report.execution.restartEveryCycles,
        )
      || report.restartCount
        !== report.scheduledRestartCount + report.recoveryRestartCount
      || report.archiveCount
        !== Math.floor(
          report.cycleCount / report.execution.archiveEveryCycles,
        )
      || report.rebuildCount
        !== Math.floor(
          report.cycleCount / report.execution.rebuildEveryCycles,
        )
      || report.loopCount
        !== Math.floor(report.cycleCount / report.execution.loopEveryCycles)
      || report.faultMatrixCount
        !== Math.floor(
          report.cycleCount / report.execution.faultMatrixEveryCycles,
        )
      || report.cycleAttempts.some(({ status }) => status !== "PASS")
      || report.faultAttempts.some(({ status }) => status !== "PASS")
      || report.observations.receiptCount
        !== report.cycleCount + report.restartCount
      || report.observations.providerInvocationCount
        !== report.cycleCount + report.restartCount
      || report.observations.providerNativeEffectCount
        !== report.cycleCount + report.restartCount
      || report.observations.completedOutboxCount
        !== report.cycleCount + report.restartCount
      || report.observations.totalOutboxCount
        !== report.cycleCount + report.restartCount
      || report.observations.restartOperationCount !== report.restartCount
      || report.observations.highWaterPosition
        !== report.observations.projectionPosition
      || report.observations.archiveFileCount !== report.archiveCount
      || report.observations.failedAttemptCount !== report.loopCount
      || report.observations.falseSuccessCount !== 0
      || report.resources.peakHeapBytes - report.resources.initialHeapBytes
        > report.dataset.maxHeapGrowthBytes
      || report.resources.peakRssBytes - report.resources.initialRssBytes
        > report.dataset.maxRssGrowthBytes
      || report.resources.peakDatabaseBytes > report.dataset.maxDatabaseBytes
      || report.resources.peakArchiveBytes > report.dataset.maxArchiveBytes
      || report.resources.peakCheckpointBytes
        > report.dataset.maxCheckpointBytes
      || report.resources.finalDatabaseBytes
        - report.resources.initialDatabaseBytes
        > report.cycleCount * report.dataset.maxDatabaseGrowthPerCycleBytes
      || Object.values(report.checks).some((check) => !check)
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "PASS requires the full planned duration and all checks",
    });
  }
  if (
    report.status === "NOT_RUN"
    && (
      report.startedAt !== null
      || report.completedAt !== null
      || report.elapsedMs !== 0
      || report.cycleCount !== 0
      || report.cycleAttempts.length !== 0
      || Object.values(report.observations).some((count) => count !== 0)
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "NOT_RUN cannot contain execution evidence",
    });
  }
});
export type Phase1SoakReport = z.infer<typeof Phase1SoakReportSchema>;
