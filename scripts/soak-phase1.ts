import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import {
  AttemptIdSchema,
  OperationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  RuntimeProviderIdSchema,
} from "@hunter/domain";
import {
  ArchiveManifestInputSchema,
  ArchiveWriter,
  createArchiveManifest,
} from "@hunter/knowledge";
import {
  ExternalOperationReceiptSchema,
  createExternalOperation,
  runtimeFactCanCompleteStep,
} from "@hunter/runtime-contracts";
import {
  HunterProjection,
  OperationWorker,
  ProjectionRunner,
  SqliteOperationJournal,
} from "@hunter/storage";
import {
  PHASE1_LOAD_DATASET,
  Phase1FailureEnvelopeSchema,
  Phase1SoakCycleAttemptSchema,
  Phase1SoakReportSchema,
  createPhase1FakeClock,
  summarizePhase1Host,
  type Phase1FaultAttempt,
  type Phase1SoakCycleAttempt,
  type Phase1SoakReport,
} from "@hunter/testkit";

import { runPhase1FaultMatrix } from "./benchmark-phase1.js";
import {
  phase1BuildIdentity,
  preparePhase1EvidenceOutput,
  safePhase1ErrorCode,
  writePhase1JsonAtomic,
} from "./phase1-evidence.js";
import { PersistentFakeRuntime } from "./phase1-persistent-fake-runtime.js";
import { runPhase1RestartWorkload } from "./phase1-restart-workload.js";

const projectId = ProjectIdSchema.parse("prj_phase1soak001");
const providerId = RuntimeProviderIdSchema.parse("rtp_phase1soak001");

export interface Phase1SoakOptions {
  readonly mode: "full" | "smoke";
  readonly maxCycles?: number | undefined;
  readonly cycleIntervalMs?: number | undefined;
  readonly restartEveryCycles?: number | undefined;
  readonly archiveEveryCycles?: number | undefined;
  readonly rebuildEveryCycles?: number | undefined;
  readonly loopEveryCycles?: number | undefined;
  readonly faultMatrixEveryCycles?: number | undefined;
  readonly injectCycleFailureAt?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onCheckpoint?: ((report: Phase1SoakReport) => void) | undefined;
  readonly stateRoot?: string | undefined;
  readonly resumeFrom?: Phase1SoakReport | undefined;
  readonly preserveStateOnNotProven?: boolean | undefined;
}

type Phase1CheckpointWriter = (path: string, value: unknown) => void;

export function phase1SoakCheckpointPath(output: string): string {
  return join(`${resolve(output)}.state`, "checkpoint.json");
}

export function loadPhase1SoakResumeCheckpoint(
  output: string,
): Phase1SoakReport | undefined {
  const checkpointPath = phase1SoakCheckpointPath(output);
  if (!existsSync(checkpointPath)) return undefined;
  const parsed = Phase1SoakReportSchema.safeParse(
    JSON.parse(readFileSync(checkpointPath, "utf8")) as unknown,
  );
  if (!parsed.success || parsed.data.status !== "NOT_PROVEN") {
    throw new Error("SOAK_RESUME_CHECKPOINT_INVALID");
  }
  return parsed.data;
}

export function persistPhase1SoakCheckpoint(
  output: string,
  checkpoint: Phase1SoakReport,
  writer: Phase1CheckpointWriter = writePhase1JsonAtomic,
): void {
  const target = resolve(output);
  const report = Phase1SoakReportSchema.parse(checkpoint);
  writer(phase1SoakCheckpointPath(target), report);
  writer(target, report);
}

export function phase1SoakOptionsForMode(
  mode: "full" | "smoke",
): Phase1SoakOptions {
  if (mode === "full") return { mode };
  return {
    mode,
    maxCycles: 4,
    cycleIntervalMs: 0,
    restartEveryCycles: 2,
    archiveEveryCycles: 2,
    rebuildEveryCycles: 2,
    loopEveryCycles: 1,
    faultMatrixEveryCycles: 4,
  };
}

export function phase1SoakExitCode(
  mode: "full" | "smoke",
  status: Phase1SoakReport["status"],
): 0 | 1 {
  if (mode === "full") return status === "PASS" ? 0 : 1;
  return status === "FAIL" ? 1 : 0;
}

export interface Phase1SoakStatusInput {
  readonly mode: "full" | "smoke";
  readonly elapsedMs: number;
  readonly stoppedByFailure: boolean;
  readonly aborted: boolean;
  readonly checks: Phase1SoakReport["checks"];
  readonly cycleCount: number;
  readonly restartCount: number;
  readonly scheduledRestartCount: number;
  readonly recoveryRestartCount: number;
  readonly archiveCount: number;
  readonly rebuildCount: number;
  readonly loopCount: number;
  readonly faultMatrixCount: number;
  readonly allFaultAttemptsPassed: boolean;
}

export function resolvePhase1SoakStatus(
  input: Phase1SoakStatusInput,
): "PASS" | "FAIL" | "NOT_PROVEN" {
  if (input.stoppedByFailure) return "FAIL";
  if (
    input.mode !== "full"
    || input.elapsedMs < PHASE1_LOAD_DATASET.plannedSoakDurationMs
    || input.aborted
  ) {
    return "NOT_PROVEN";
  }
  const minimumCycles = Math.floor(
    PHASE1_LOAD_DATASET.plannedSoakDurationMs
      / PHASE1_LOAD_DATASET.soakCycleIntervalMs,
  );
  const scheduledRestartCount = Math.floor(
    input.cycleCount / PHASE1_LOAD_DATASET.restartEveryCycles,
  );
  const scheduledArchiveCount = Math.floor(
    input.cycleCount / PHASE1_LOAD_DATASET.archiveEveryCycles,
  );
  const scheduledRebuildCount = Math.floor(
    input.cycleCount / PHASE1_LOAD_DATASET.rebuildEveryCycles,
  );
  const scheduledLoopCount = Math.floor(
    input.cycleCount / PHASE1_LOAD_DATASET.loopEveryCycles,
  );
  const scheduledFaultMatrixCount = Math.floor(
    input.cycleCount / PHASE1_LOAD_DATASET.faultMatrixEveryCycles,
  );
  return Object.values(input.checks).every(Boolean)
      && input.cycleCount >= minimumCycles
      && input.scheduledRestartCount === scheduledRestartCount
      && input.recoveryRestartCount >= 0
      && input.restartCount
        === input.scheduledRestartCount + input.recoveryRestartCount
      && input.archiveCount === scheduledArchiveCount
      && input.rebuildCount === scheduledRebuildCount
      && input.loopCount === scheduledLoopCount
      && input.faultMatrixCount === scheduledFaultMatrixCount
      && input.allFaultAttemptsPassed
    ? "PASS"
    : "FAIL";
}

function safeErrorCode(error: unknown): string {
  return safePhase1ErrorCode(error);
}

function validateInterval(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name}_INVALID`);
  }
  return value;
}

function cycleSuffix(sequence: number): string {
  return sequence.toString().padStart(6, "0");
}

function cycleOperation(sequence: number) {
  const suffix = cycleSuffix(sequence);
  return createExternalOperation({
    schemaVersion: 1,
    operationId: OperationIdSchema.parse(`opn_phase1soak${suffix}`),
    projectId,
    runId: RunIdSchema.parse(`run_phase1soak${suffix}`),
    attemptId: AttemptIdSchema.parse(`att_phase1soak${suffix}`),
    operationVersion: 2,
    operationType: "session.observe",
    requestedCapabilities: ["observe"],
    payload: {
      nativeSessionId: `ses_phase1soak${suffix}`,
      controllerLeaseId: `ctl_phase1soak${suffix}`,
      controllerLeaseOwnerId: `own_phase1soak${suffix}`,
      controllerLeaseGeneration: 1,
    },
  });
}

function archiveInput(sequence: number, occurredAt: string) {
  const suffix = cycleSuffix(sequence);
  const runId = `run_phase1archive${suffix}`;
  const hash = "a".repeat(64);
  const leaseBase = {
    schemaVersion: 2 as const,
    projectId,
    repositoryId: "rep_phase1soak001",
    deviceBindingId: "dev_phase1soak001",
    canonicalWorkspaceKey: "win32:c:\\hunter\\phase1-soak",
    gitHead: "1".repeat(40),
    branch: "codex/phase1-performance-soak",
    ownerRunId: runId,
    ownerAttemptId: `att_phase1archive${suffix}`,
    ownerId: "own_phase1soak001",
    generation: 1,
    mode: "write" as const,
    acquiredAt: occurredAt,
    expiresAt: new Date(Date.parse(occurredAt) + 3_600_000).toISOString(),
    revokedAt: null,
    revocationReason: null,
    receiptHash: "b".repeat(64),
  };
  return ArchiveManifestInputSchema.parse({
    schemaVersion: 2,
    projectId,
    repositories: [{
      repositoryId: "rep_phase1soak001",
      deviceBindingId: "dev_phase1soak001",
      gitHead: "1".repeat(40),
    }],
    requirementRevisionIds: ["rrv_phase1soak001"],
    change: {
      changeId: "chg_phase1soak001",
      changeRevisionId: "crv_phase1soak001",
    },
    executionPlanId: "epl_phase1soak001",
    workflowId: "wfl_phase1soak001",
    workflowRevisionId: "wfr_phase1soak001",
    runGraph: {
      rootRunId: runId,
      runs: [{
        runId,
        parentRunId: null,
        taskId: null,
        outcome: "failed",
        steps: [{
          stepRunId: `spr_phase1archive${suffix}`,
          stepId: "stp_phase1soak001",
          attempts: [{
            attemptId: `att_phase1archive${suffix}`,
            agentProfileId: "apr_phase1soak001",
            capabilityProbeDigest: "c".repeat(64),
            nativeSessionReferenceHash: "d".repeat(64),
            artifacts: [{
              artifactId: `art_phase1archive${suffix}`,
              contentRef: `cas:sha256:${hash}`,
              contentHash: hash,
            }],
            evidence: [{
              evidenceId: `evd_phase1archive${suffix}`,
              contentRef: `cas:sha256:${hash}`,
              contentHash: hash,
            }],
          }],
        }],
      }],
    },
    leases: {
      workspace: [{
        ...leaseBase,
        kind: "workspace",
        leaseId: `wsl_phase1archive${suffix}`,
        scope: { workspaceId: "wsp_phase1soak001" },
      }],
      writer: [{
        ...leaseBase,
        kind: "writer",
        leaseId: `wrl_phase1archive${suffix}`,
        scope: {
          workspaceId: "wsp_phase1soak001",
          worktreeId: "wtr_phase1soak001",
        },
      }],
      controller: [{
        ...leaseBase,
        kind: "controller",
        leaseId: `ctl_phase1archive${suffix}`,
        scope: {
          workspaceId: "wsp_phase1soak001",
          worktreeId: "wtr_phase1soak001",
          nativeSessionId: "ses_phase1soak001",
        },
      }],
    },
    ledger: { firstPosition: 1, lastPosition: sequence },
    actor: {
      actorId: "phase1-soak",
      correlationId: `phase1-soak-archive-${suffix}`,
    },
    timestamps: {
      occurredAt,
      archivedAt: new Date(Date.parse(occurredAt) + 1).toISOString(),
    },
    outcome: "failed",
  });
}

function fileBytes(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

function databaseBytes(databasePath: string): number {
  return (
    fileBytes(databasePath)
    + fileBytes(`${databasePath}-wal`)
    + fileBytes(`${databasePath}-shm`)
  );
}

function directoryBytes(path: string): number {
  if (!existsSync(path)) return 0;
  return readdirSync(path, { withFileTypes: true }).reduce(
    (total, entry) => {
      const child = join(path, entry.name);
      return total + (entry.isDirectory()
        ? directoryBytes(child)
        : entry.isFile()
          ? statSync(child).size
          : 0);
    },
    0,
  );
}

function countJsonFiles(path: string): number {
  if (!existsSync(path)) return 0;
  return readdirSync(path, { withFileTypes: true }).reduce(
    (total, entry) => {
      const child = join(path, entry.name);
      if (entry.isDirectory()) return total + countJsonFiles(child);
      return total + (entry.isFile() && entry.name.endsWith(".json") ? 1 : 0);
    },
    0,
  );
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0 || signal?.aborted === true) return Promise.resolve();
  return new Promise((resolveSleep) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolveSleep();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function relabelFaultAttempts(
  attempts: readonly Phase1FaultAttempt[],
  matrixSequence: number,
): readonly Phase1FaultAttempt[] {
  return attempts.map((attempt, index) => ({
    ...attempt,
    attemptId:
      `fat_soak${matrixSequence.toString().padStart(4, "0")}_${attempt.scenario}_${index + 1}`,
  }));
}

export function createNotRunPhase1SoakReport(
  mode: "full" | "smoke" = "full",
): Phase1SoakReport {
  const preset = phase1SoakOptionsForMode(mode);
  return Phase1SoakReportSchema.parse({
    schemaVersion: 1,
    proofScope: "contract_only",
    build: phase1BuildIdentity(),
    status: "NOT_RUN",
    dataset: PHASE1_LOAD_DATASET,
    execution: {
      mode,
      cycleIntervalMs:
        preset.cycleIntervalMs ?? PHASE1_LOAD_DATASET.soakCycleIntervalMs,
      restartEveryCycles:
        preset.restartEveryCycles ?? PHASE1_LOAD_DATASET.restartEveryCycles,
      archiveEveryCycles:
        preset.archiveEveryCycles ?? PHASE1_LOAD_DATASET.archiveEveryCycles,
      rebuildEveryCycles:
        preset.rebuildEveryCycles ?? PHASE1_LOAD_DATASET.rebuildEveryCycles,
      loopEveryCycles:
        preset.loopEveryCycles ?? PHASE1_LOAD_DATASET.loopEveryCycles,
      faultMatrixEveryCycles:
        preset.faultMatrixEveryCycles
          ?? PHASE1_LOAD_DATASET.faultMatrixEveryCycles,
    },
    host: summarizePhase1Host(),
    startedAt: null,
    completedAt: null,
    elapsedMs: 0,
    cycleCount: 0,
    restartCount: 0,
    scheduledRestartCount: 0,
    recoveryRestartCount: 0,
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
    notes: [
      "The real 24-hour soak has not started.",
      "No short smoke run may be rewritten as PASS.",
    ],
  });
}

export async function runPhase1Soak(
  options: Phase1SoakOptions,
): Promise<Phase1SoakReport> {
  const cycleIntervalMs =
    options.cycleIntervalMs ?? PHASE1_LOAD_DATASET.soakCycleIntervalMs;
  if (
    !Number.isSafeInteger(cycleIntervalMs)
    || cycleIntervalMs < 0
    || cycleIntervalMs > 60_000
  ) {
    throw new Error("SOAK_CYCLE_INTERVAL_INVALID");
  }
  const restartEvery = validateInterval(
    options.restartEveryCycles ?? PHASE1_LOAD_DATASET.restartEveryCycles,
    "SOAK_RESTART_INTERVAL",
  );
  const archiveEvery = validateInterval(
    options.archiveEveryCycles ?? PHASE1_LOAD_DATASET.archiveEveryCycles,
    "SOAK_ARCHIVE_INTERVAL",
  );
  const rebuildEvery = validateInterval(
    options.rebuildEveryCycles ?? PHASE1_LOAD_DATASET.rebuildEveryCycles,
    "SOAK_REBUILD_INTERVAL",
  );
  const loopEvery = validateInterval(
    options.loopEveryCycles ?? PHASE1_LOAD_DATASET.loopEveryCycles,
    "SOAK_LOOP_INTERVAL",
  );
  const faultMatrixEvery = validateInterval(
    options.faultMatrixEveryCycles
      ?? PHASE1_LOAD_DATASET.faultMatrixEveryCycles,
    "SOAK_FAULT_MATRIX_INTERVAL",
  );
  const maxCycles = options.maxCycles;
  if (
    maxCycles !== undefined
    && (!Number.isSafeInteger(maxCycles) || maxCycles <= 0)
  ) {
    throw new Error("SOAK_MAX_CYCLES_INVALID");
  }
  if (options.mode === "full" && maxCycles !== undefined) {
    throw new Error("SOAK_FULL_MODE_CANNOT_LIMIT_CYCLES");
  }
  if (options.mode === "full" && options.injectCycleFailureAt !== undefined) {
    throw new Error("SOAK_FULL_MODE_CANNOT_INJECT_TEST_FAILURE");
  }

  const execution = {
    mode: options.mode,
    cycleIntervalMs,
    restartEveryCycles: restartEvery,
    archiveEveryCycles: archiveEvery,
    rebuildEveryCycles: rebuildEvery,
    loopEveryCycles: loopEvery,
    faultMatrixEveryCycles: faultMatrixEvery,
  } as const;
  const build = phase1BuildIdentity();
  const resumeFrom = options.resumeFrom === undefined
    ? undefined
    : Phase1SoakReportSchema.parse(options.resumeFrom);
  if (
    resumeFrom !== undefined
    && (
      resumeFrom.status !== "NOT_PROVEN"
      || resumeFrom.scheduledRestartCount === undefined
      || resumeFrom.recoveryRestartCount === undefined
      || JSON.stringify(resumeFrom.build) !== JSON.stringify(build)
      || JSON.stringify(resumeFrom.dataset)
        !== JSON.stringify(PHASE1_LOAD_DATASET)
      || JSON.stringify(resumeFrom.execution) !== JSON.stringify(execution)
    )
  ) {
    throw new Error("SOAK_RESUME_EVIDENCE_MISMATCH");
  }
  const ownsTemporaryRoot = options.stateRoot === undefined;
  const root = ownsTemporaryRoot
    ? mkdtempSync(join(tmpdir(), "hunter-phase1-soak-"))
    : resolve(options.stateRoot);
  if (!ownsTemporaryRoot) mkdirSync(root, { recursive: true });
  const databasePath = join(root, "hunter.sqlite");
  const providerDatabasePath = join(root, "provider.sqlite");
  const archivesPath = join(root, "archives");
  if (
    resumeFrom !== undefined
    && (!existsSync(databasePath) || !existsSync(providerDatabasePath))
  ) {
    throw new Error("SOAK_RESUME_STATE_MISSING");
  }
  if (
    resumeFrom === undefined
    && (existsSync(databasePath) || existsSync(providerDatabasePath))
  ) {
    throw new Error("SOAK_STATE_ALREADY_EXISTS");
  }
  const observedPersistentBytes = () =>
    databaseBytes(databasePath) + databaseBytes(providerDatabasePath);
  let database = new DatabaseSync(databasePath);
  let journal = new SqliteOperationJournal(database);
  let projection = new ProjectionRunner(database, [new HunterProjection()]);
  let runtime = new PersistentFakeRuntime(providerDatabasePath, {
    providerId,
    implementationVersion: "phase1-soak-contract-only",
    observedAt: PHASE1_LOAD_DATASET.fakeClockStart,
  });
  let worker = new OperationWorker(database, runtime, {
    ownerId: "phase1-soak-worker",
    replayPolicy: () => "inspectable",
  });
  const writer = new ArchiveWriter(archivesPath);
  const fakeClock = createPhase1FakeClock(PHASE1_LOAD_DATASET.fakeClockStart);
  for (let index = 0; index < (resumeFrom?.cycleCount ?? 0); index += 1) {
    fakeClock.advance(PHASE1_LOAD_DATASET.soakCycleIntervalMs);
  }
  const startedAt = resumeFrom?.startedAt ?? new Date().toISOString();
  if (startedAt === null) throw new Error("SOAK_RESUME_START_TIME_MISSING");
  const elapsedBeforeMs = resumeFrom?.elapsedMs ?? 0;
  const wallStarted = performance.now();
  const initialHeapBytes =
    resumeFrom?.resources.initialHeapBytes ?? process.memoryUsage().heapUsed;
  const initialRssBytes =
    resumeFrom?.resources.initialRssBytes ?? process.memoryUsage().rss;
  const initialDatabaseBytes =
    resumeFrom?.resources.initialDatabaseBytes ?? observedPersistentBytes();
  let peakHeapBytes =
    resumeFrom?.resources.peakHeapBytes ?? initialHeapBytes;
  let peakRssBytes = resumeFrom?.resources.peakRssBytes ?? initialRssBytes;
  let peakDatabaseBytes =
    resumeFrom?.resources.peakDatabaseBytes ?? initialDatabaseBytes;
  let peakArchiveBytes = resumeFrom?.resources.peakArchiveBytes ?? 0;
  let peakCheckpointBytes = resumeFrom?.resources.peakCheckpointBytes ?? 0;
  let restartCount = resumeFrom?.restartCount ?? 0;
  let scheduledRestartCount = resumeFrom?.scheduledRestartCount ?? 0;
  let recoveryRestartCount = resumeFrom?.recoveryRestartCount ?? 0;
  let archiveCount = resumeFrom?.archiveCount ?? 0;
  let rebuildCount = resumeFrom?.rebuildCount ?? 0;
  let loopCount = resumeFrom?.loopCount ?? 0;
  let faultMatrixCount = resumeFrom?.faultMatrixCount ?? 0;
  const faultAttempts: Phase1FaultAttempt[] = [
    ...(resumeFrom?.faultAttempts ?? []),
  ];
  const cycleAttempts: Phase1SoakCycleAttempt[] = [
    ...(resumeFrom?.cycleAttempts ?? []),
  ];
  let stoppedByFailure = false;
  let finalStatus: Phase1SoakReport["status"] | undefined;

  const makeReport = (
    status: "PASS" | "FAIL" | "NOT_PROVEN",
  ): Phase1SoakReport => {
    const finalHeapBytes = process.memoryUsage().heapUsed;
    const finalRssBytes = process.memoryUsage().rss;
    peakHeapBytes = Math.max(peakHeapBytes, finalHeapBytes);
    peakRssBytes = Math.max(peakRssBytes, finalRssBytes);
    const finalDatabaseBytes = observedPersistentBytes();
    const finalArchiveBytes = directoryBytes(archivesPath);
    peakDatabaseBytes = Math.max(peakDatabaseBytes, finalDatabaseBytes);
    peakArchiveBytes = Math.max(peakArchiveBytes, finalArchiveBytes);
    const passedCycles = cycleAttempts.filter(
      (attempt) => attempt.status === "PASS",
    ).length;
    const receiptCount = (
      database.prepare(
        "SELECT COUNT(*) AS count FROM side_effect_receipts",
      ).get() as { readonly count: number }
    ).count;
    const receiptOperationIds = (
      database.prepare(
        "SELECT operation_id FROM side_effect_receipts ORDER BY operation_id",
      ).all() as unknown as readonly { readonly operation_id: string }[]
    ).map(({ operation_id }) => operation_id);
    const providerOperationIds = runtime.operationIds();
    const providerInvocationCount = runtime.providerInvocationCount;
    const providerNativeEffectCount = runtime.providerNativeEffectCount;
    const falseSuccessCount = (
      database.prepare(
        `SELECT COUNT(*) AS count
           FROM events
          WHERE event_type = 'FlowEvent'
            AND json_extract(event_data, '$.flowEvent.type') = 'RunConcluded'
            AND json_extract(event_data, '$.flowEvent.status') = 'succeeded'`,
      ).get() as { readonly count: number }
    ).count;
    const failedAttemptCount = (
      database.prepare(
        "SELECT COUNT(*) AS count FROM events WHERE event_type = 'ExecutionFailed'",
      ).get() as { readonly count: number }
    ).count;
    const unexplainedOutboxCount = (
      database.prepare(
        `SELECT COUNT(*) AS count
           FROM outbox
          WHERE status NOT IN ('completed', 'needs_attention', 'indeterminate')`,
      ).get() as { readonly count: number }
    ).count;
    const completedOutboxCount = (
      database.prepare(
        "SELECT COUNT(*) AS count FROM outbox WHERE status = 'completed'",
      ).get() as { readonly count: number }
    ).count;
    const totalOutboxCount = (
      database.prepare("SELECT COUNT(*) AS count FROM outbox").get() as {
        readonly count: number;
      }
    ).count;
    const restartOperationCount = (
      database.prepare(
        `SELECT COUNT(*) AS count
           FROM outbox
          WHERE operation_id LIKE 'opn_phase1restart%'
            AND status = 'completed'`,
      ).get() as { readonly count: number }
    ).count;
    const highWaterPosition = (
      database.prepare(
        "SELECT COALESCE(MAX(position), 0) AS position FROM events",
      ).get() as { readonly position: number }
    ).position;
    const projectionPosition = (
      database.prepare(
        `SELECT last_position
           FROM projection_checkpoints
          WHERE projector_name = 'hunter'`,
      ).get() as { readonly last_position: number } | undefined
    )?.last_position ?? 0;
    const archiveFileCount = countJsonFiles(archivesPath);
    const databaseGrowth = Math.max(
      0,
      finalDatabaseBytes - initialDatabaseBytes,
    );
    const expectedExternalOperationCount = passedCycles + restartCount;
    const base = {
      schemaVersion: 1,
      proofScope: "contract_only",
      build,
      status,
      dataset: PHASE1_LOAD_DATASET,
      execution,
      host: summarizePhase1Host(),
      startedAt,
      completedAt: new Date().toISOString(),
      elapsedMs:
        elapsedBeforeMs + Math.floor(performance.now() - wallStarted),
      cycleCount: cycleAttempts.length,
      restartCount,
      scheduledRestartCount,
      recoveryRestartCount,
      archiveCount,
      rebuildCount,
      loopCount,
      faultMatrixCount,
      faultAttempts,
      cycleAttempts,
      resources: {
        initialHeapBytes,
        peakHeapBytes,
        finalHeapBytes,
        initialRssBytes,
        peakRssBytes,
        finalRssBytes,
        initialDatabaseBytes,
        peakDatabaseBytes,
        finalDatabaseBytes,
        peakArchiveBytes,
        finalArchiveBytes,
        peakCheckpointBytes,
        finalCheckpointBytes: 0,
      },
      observations: {
        receiptCount,
        providerInvocationCount,
        providerNativeEffectCount,
        completedOutboxCount,
        totalOutboxCount,
        restartOperationCount,
        highWaterPosition,
        projectionPosition,
        archiveFileCount,
        failedAttemptCount,
        falseSuccessCount,
      },
      checks: {
        noDuplicateExternalOperations:
          receiptCount === expectedExternalOperationCount
          && providerNativeEffectCount === expectedExternalOperationCount
          && providerInvocationCount === expectedExternalOperationCount
          && JSON.stringify(receiptOperationIds)
            === JSON.stringify(providerOperationIds),
        noFalseSuccess: falseSuccessCount === 0,
        boundedResourceGrowth:
          Math.max(0, peakHeapBytes - initialHeapBytes)
            <= PHASE1_LOAD_DATASET.maxHeapGrowthBytes
          && Math.max(0, peakRssBytes - initialRssBytes)
            <= PHASE1_LOAD_DATASET.maxRssGrowthBytes
          && databaseGrowth
            <= Math.max(1, passedCycles)
              * PHASE1_LOAD_DATASET.maxDatabaseGrowthPerCycleBytes
          && peakDatabaseBytes <= PHASE1_LOAD_DATASET.maxDatabaseBytes
          && peakArchiveBytes <= PHASE1_LOAD_DATASET.maxArchiveBytes,
        allStatesExplainable:
          unexplainedOutboxCount === 0
          && totalOutboxCount === expectedExternalOperationCount
          && completedOutboxCount === expectedExternalOperationCount
          && restartOperationCount === restartCount
          && restartCount
            === scheduledRestartCount + recoveryRestartCount
          && projectionPosition === highWaterPosition
          && archiveFileCount === archiveCount,
        failedAttemptsPreserved: failedAttemptCount === loopCount,
      },
      notes: [
        options.mode === "full"
          ? "Full mode uses actual monotonic wall time for the 24-hour gate."
          : "Smoke mode is NOT_PROVEN regardless of its internal checks.",
        "Domain timestamps use the fixed Fake clock; host paths and environment variables are not recorded.",
        "Fake Runtime proves Hunter contracts only and does not validate any real Provider.",
        "A failed cycle stops the run; it is never automatically rerun as PASS.",
      ],
    } as const;
    let finalCheckpointBytes = 0;
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const candidate = {
        ...base,
        resources: {
          ...base.resources,
          peakCheckpointBytes: Math.max(
            peakCheckpointBytes,
            finalCheckpointBytes,
          ),
          finalCheckpointBytes,
        },
      };
      finalCheckpointBytes = Buffer.byteLength(
        `${JSON.stringify(candidate, null, 2)}\n`,
        "utf8",
      );
    }
    peakCheckpointBytes = Math.max(peakCheckpointBytes, finalCheckpointBytes);
    return Phase1SoakReportSchema.parse({
      ...base,
      resources: {
        ...base.resources,
        peakCheckpointBytes,
        finalCheckpointBytes,
      },
      checks: {
        ...base.checks,
        boundedResourceGrowth:
          base.checks.boundedResourceGrowth
          && peakCheckpointBytes <= PHASE1_LOAD_DATASET.maxCheckpointBytes,
      },
    });
  };

  function reopen(): void {
    database.close();
    runtime.close();
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve(
          dirname(fileURLToPath(import.meta.url)),
          "phase1-restart-probe.ts",
        ),
        root,
        String(restartCount + 1),
        fakeClock.now().toISOString(),
      ],
      {
        cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    database = new DatabaseSync(databasePath);
    journal = new SqliteOperationJournal(database);
    projection = new ProjectionRunner(database, [new HunterProjection()]);
    runtime = new PersistentFakeRuntime(providerDatabasePath, {
      providerId,
      implementationVersion: "phase1-soak-contract-only",
      observedAt: fakeClock.now().toISOString(),
    });
    worker = new OperationWorker(database, runtime, {
      ownerId: "phase1-soak-worker",
      replayPolicy: () => "inspectable",
    });
    restartCount = runtime.restartProbeCount;
    scheduledRestartCount += 1;
  }

  try {
    if (resumeFrom !== undefined) {
      const expectedScheduledRestartCount = Math.floor(
        cycleAttempts.length / restartEvery,
      );
      while (scheduledRestartCount < expectedScheduledRestartCount) {
        await runPhase1RestartWorkload({
          database,
          journal,
          projection,
          runtime,
          sequence: restartCount + 1,
          observedAt: fakeClock.now().toISOString(),
        });
        restartCount = runtime.restartProbeCount;
        scheduledRestartCount += 1;
        options.onCheckpoint?.(makeReport("NOT_PROVEN"));
      }
      await runPhase1RestartWorkload({
        database,
        journal,
        projection,
        runtime,
        sequence: restartCount + 1,
        observedAt: fakeClock.now().toISOString(),
      });
      restartCount = runtime.restartProbeCount;
      recoveryRestartCount += 1;
      options.onCheckpoint?.(makeReport("NOT_PROVEN"));
    }
    options.onCheckpoint?.(makeReport("NOT_PROVEN"));
    for (;;) {
      const elapsed =
        elapsedBeforeMs + performance.now() - wallStarted;
      if (
        options.signal?.aborted === true
        || (options.mode === "full"
          && elapsed >= PHASE1_LOAD_DATASET.plannedSoakDurationMs)
        || (maxCycles !== undefined && cycleAttempts.length >= maxCycles)
      ) {
        break;
      }
      const sequence = cycleAttempts.length + 1;
      const cycleWallStarted = performance.now();
      const operation = cycleOperation(sequence);
      const cycleStartedAt = fakeClock.now().toISOString();
      let cycleError: string | null = null;
      try {
        if (options.injectCycleFailureAt === sequence) {
          throw new Error("INJECTED_SOAK_CYCLE_FAILURE");
        }
        journal.commitCommand({
          commandId: `cmd_phase1soak${cycleSuffix(sequence)}`,
          requestFingerprint: canonicalRequestFingerprint(sequence),
          projectId,
          aggregateId: `attempt:${operation.attemptId}`,
          expectedVersion: 0,
          actor: {
            actorId: "phase1-soak",
            correlationId: `phase1-soak-${cycleSuffix(sequence)}`,
          },
          events: [{
            eventId: `evt_phase1soak${cycleSuffix(sequence)}`,
            eventType: "AttemptAssigned",
            eventData: { attemptId: operation.attemptId },
            schemaVersion: 1,
            occurredAt: cycleStartedAt,
          }],
          operations: [operation],
          response: { accepted: true },
        });
        const workerResult = await worker.runOnce();
        const receiptRow = database.prepare(
          "SELECT provider_receipt_json FROM side_effect_receipts WHERE operation_id = ?",
        ).get(operation.operationId) as {
          readonly provider_receipt_json: string;
        } | undefined;
        if (receiptRow === undefined) throw new Error("SOAK_RECEIPT_MISSING");
        if (workerResult !== "completed" && workerResult !== "idle") {
          throw new Error(`SOAK_OPERATION_${workerResult.toUpperCase()}`);
        }
        const receipt = ExternalOperationReceiptSchema.parse(
          JSON.parse(receiptRow.provider_receipt_json) as unknown,
        );
        if (receipt.facts.some(runtimeFactCanCompleteStep)) {
          throw new Error("SOAK_RUNTIME_FACT_FALSE_SUCCESS");
        }
        projection.runIncremental();

        if (sequence % loopEvery === 0) {
          const loopSuffix = cycleSuffix(sequence);
          const loopAggregate = `run:phase1-loop-${loopSuffix}`;
          journal.commitCommand({
            commandId: `cmd_phase1loop_fail${loopSuffix}`,
            requestFingerprint: canonicalRequestFingerprint(sequence * 2),
            projectId,
            aggregateId: loopAggregate,
            expectedVersion: 0,
            actor: {
              actorId: "phase1-soak",
              correlationId: `phase1-loop-${loopSuffix}`,
            },
            events: [{
              eventId: `evt_phase1loop_fail${loopSuffix}`,
              eventType: "ExecutionFailed",
              eventData: {
                stepRunId: `spr_phase1loop${loopSuffix}`,
                attemptId: `att_phase1loopfail${loopSuffix}`,
              },
              schemaVersion: 1,
              occurredAt: fakeClock.now().toISOString(),
            }],
            operations: [],
            response: { retryRequired: true },
          });
          journal.commitCommand({
            commandId: `cmd_phase1loop_retry${loopSuffix}`,
            requestFingerprint: canonicalRequestFingerprint(sequence * 2 + 1),
            projectId,
            aggregateId: loopAggregate,
            expectedVersion: 1,
            actor: {
              actorId: "phase1-soak",
              correlationId: `phase1-loop-${loopSuffix}`,
            },
            events: [{
              eventId: `evt_phase1loop_retry${loopSuffix}`,
              eventType: "AttemptAssigned",
              eventData: { attemptId: `att_phase1loopretry${loopSuffix}` },
              schemaVersion: 1,
              occurredAt: fakeClock.now().toISOString(),
            }],
            operations: [],
            response: { newAttempt: true },
          });
          loopCount += 1;
        }
        if (sequence % archiveEvery === 0) {
          writer.publish(
            createArchiveManifest(
              archiveInput(sequence, fakeClock.now().toISOString()),
            ),
            fakeClock.now().toISOString(),
          );
          archiveCount += 1;
        }
        if (sequence % rebuildEvery === 0) {
          projection.rebuild("hunter");
          rebuildCount += 1;
        }
        if (sequence % faultMatrixEvery === 0) {
          faultMatrixCount += 1;
          faultAttempts.push(
            ...relabelFaultAttempts(
              await runPhase1FaultMatrix(),
              faultMatrixCount,
            ),
          );
          if (
            faultAttempts
              .slice(-12)
              .some((attempt) => attempt.status !== "PASS")
          ) {
            throw new Error("SOAK_FAULT_MATRIX_FAILED");
          }
        }
        projection.runIncremental();
      } catch (error) {
        cycleError = safeErrorCode(error);
        stoppedByFailure = true;
      }

      fakeClock.advance(PHASE1_LOAD_DATASET.soakCycleIntervalMs);
      const heapBytes = process.memoryUsage().heapUsed;
      const rssBytes = process.memoryUsage().rss;
      peakHeapBytes = Math.max(peakHeapBytes, heapBytes);
      peakRssBytes = Math.max(peakRssBytes, rssBytes);
      const observedDatabaseBytes = observedPersistentBytes();
      const observedArchiveBytes = directoryBytes(archivesPath);
      peakDatabaseBytes = Math.max(
        peakDatabaseBytes,
        observedDatabaseBytes,
      );
      peakArchiveBytes = Math.max(peakArchiveBytes, observedArchiveBytes);
      cycleAttempts.push(
        Phase1SoakCycleAttemptSchema.parse({
          sequence,
          status: cycleError === null ? "PASS" : "FAIL",
          startedAt: cycleStartedAt,
          completedAt: fakeClock.now().toISOString(),
          operationId: operation.operationId,
          errorCode: cycleError,
          heapBytes,
          databaseBytes: observedDatabaseBytes,
        }),
      );
      if (stoppedByFailure) break;
      if (sequence % restartEvery === 0) {
        options.onCheckpoint?.(makeReport("NOT_PROVEN"));
        reopen();
      }
      options.onCheckpoint?.(makeReport("NOT_PROVEN"));
      await sleep(
        Math.max(0, cycleIntervalMs - (performance.now() - cycleWallStarted)),
        options.signal,
      );
    }

    const inspected = makeReport(
      stoppedByFailure ? "FAIL" : "NOT_PROVEN",
    );
    const status = resolvePhase1SoakStatus({
      mode: options.mode,
      elapsedMs: inspected.elapsedMs,
      stoppedByFailure,
      aborted: options.signal?.aborted === true,
      checks: inspected.checks,
      cycleCount: inspected.cycleCount,
      restartCount: inspected.restartCount,
      scheduledRestartCount: inspected.scheduledRestartCount ?? 0,
      recoveryRestartCount: inspected.recoveryRestartCount ?? 0,
      archiveCount: inspected.archiveCount,
      rebuildCount: inspected.rebuildCount,
      loopCount: inspected.loopCount,
      faultMatrixCount: inspected.faultMatrixCount,
      allFaultAttemptsPassed:
        inspected.faultAttempts.length > 0
        && inspected.faultAttempts.every(({ status }) => status === "PASS"),
    });
    const report = status === inspected.status
      ? inspected
      : makeReport(status);
    options.onCheckpoint?.(report);
    finalStatus = report.status;
    return report;
  } finally {
    database.close();
    runtime.close();
    if (
      ownsTemporaryRoot
      || options.preserveStateOnNotProven !== true
      || finalStatus === "PASS"
      || finalStatus === "FAIL"
    ) {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

function canonicalRequestFingerprint(sequence: number): string {
  return sequence.toString(16).padStart(64, "0");
}

function parseCli(args: readonly string[]): {
  readonly mode: "full" | "smoke";
  readonly output: string;
} {
  const outputIndex = args.indexOf("--output");
  const output = outputIndex === -1 ? undefined : args[outputIndex + 1];
  if (output === undefined || output.startsWith("--")) {
    throw new Error("PHASE1_SOAK_OUTPUT_REQUIRED");
  }
  return {
    mode: args.includes("--smoke") ? "smoke" : "full",
    output,
  };
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined
  && pathToFileURL(resolve(entrypoint)).href === import.meta.url
) {
  const abort = new AbortController();
  const requestStop = () => abort.abort();
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  let cli: ReturnType<typeof parseCli> | undefined;
  try {
    const parsedCli = parseCli(process.argv.slice(2));
    cli = parsedCli;
    const stateRoot = `${resolve(parsedCli.output)}.state`;
    const resumeFrom = parsedCli.mode === "full"
      ? loadPhase1SoakResumeCheckpoint(parsedCli.output)
      : undefined;
    if (resumeFrom === undefined) {
      preparePhase1EvidenceOutput(parsedCli.output);
      if (parsedCli.mode === "full" && existsSync(stateRoot)) {
        if (!stateRoot.endsWith(".json.state")) {
          throw new Error("SOAK_STATE_PATH_INVALID");
        }
        rmSync(stateRoot, { recursive: true, force: true });
      }
      writePhase1JsonAtomic(
        parsedCli.output,
        createNotRunPhase1SoakReport(parsedCli.mode),
      );
    } else {
      preparePhase1EvidenceOutput(parsedCli.output);
    }
    const report = await runPhase1Soak({
      ...phase1SoakOptionsForMode(parsedCli.mode),
      ...(parsedCli.mode === "full"
        ? {
          stateRoot,
          resumeFrom,
          preserveStateOnNotProven: true,
        }
        : {}),
      signal: abort.signal,
      onCheckpoint: (checkpoint) => {
        if (parsedCli.mode === "full") {
          persistPhase1SoakCheckpoint(parsedCli.output, checkpoint);
        } else {
          writePhase1JsonAtomic(parsedCli.output, checkpoint);
        }
      },
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = phase1SoakExitCode(parsedCli.mode, report.status);
  } catch (error) {
    let errorCode = safePhase1ErrorCode(error);
    if (cli !== undefined) {
      try {
        const failure = Phase1FailureEnvelopeSchema.parse({
          schemaVersion: 1,
          proofScope: "contract_only",
          build: phase1BuildIdentity(),
          command: "soak",
          status: cli.mode === "full" ? "NOT_PROVEN" : "FAIL",
          observedAt: new Date().toISOString(),
          errorCode,
        });
        writePhase1JsonAtomic(cli.output, failure);
        errorCode = failure.errorCode;
      } catch {
        errorCode = "PHASE1_EVIDENCE_WRITE_FAILED";
      }
    }
    process.stderr.write(`${errorCode}\n`);
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
  }
}
