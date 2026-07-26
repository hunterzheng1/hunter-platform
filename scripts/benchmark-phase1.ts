import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import {
  ProjectListHttpResponseSchema,
  RunViewHttpResponseSchema,
} from "@hunter/api-contracts";
import { DeviceGateway, MobileCommandEnvelopeSchema } from "@hunter/device-gateway";
import {
  AttemptIdSchema,
  DeviceIdSchema,
  LeaseOwnerIdSchema,
  OperationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  RuntimeProviderIdSchema,
  canonicalSha256,
  type AttemptId,
} from "@hunter/domain";
import {
  ArchiveJobWorker,
  ArchiveManifestInputSchema,
  ArchiveWriter,
  SqliteArchiveJobStore,
  SqliteKnowledgeCatalog,
} from "@hunter/knowledge";
import { createExternalOperation } from "@hunter/runtime-contracts";
import {
  EventLedgerReader,
  HunterProjection,
  OperationWorker,
  ProjectionRunner,
  SqliteOperationJournal,
} from "@hunter/storage";
import {
  FakeRuntime,
  FaultInjector,
  PHASE1_FAULT_SCENARIOS,
  PHASE1_LOAD_DATASET,
  Phase1BenchmarkReportSchema,
  Phase1FailureEnvelopeSchema,
  Phase1FaultAttemptSchema,
  createPhase1FakeClock,
  createPhase1Random,
  summarizePhase1Host,
  summarizePhase1Samples,
  type Phase1BenchmarkReport,
  type Phase1FaultAttempt,
  type Phase1FaultScenario,
  type Phase1Metric,
} from "@hunter/testkit";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";

import { DurableEventStream } from "../apps/daemon/src/events/durable-event-stream.js";
import type { RunEventStreamHandlers } from "../apps/web/src/hooks/use-run-events.js";
import { ProjectListPage } from "../apps/web/src/pages/project-list-page.js";
import { RunPage } from "../apps/web/src/pages/run-page.js";
import {
  phase1BuildIdentity,
  preparePhase1EvidenceOutput,
  safePhase1ErrorCode,
  writePhase1JsonAtomic,
} from "./phase1-evidence.js";

const projectId = ProjectIdSchema.parse("prj_phase1load001");
const runId = RunIdSchema.parse("run_phase1load001");
const operationId = OperationIdSchema.parse("opn_phase1load001");
const fixedObservedAt = PHASE1_LOAD_DATASET.fakeClockStart;

interface FaultScenarioResult {
  readonly expected: string;
  readonly observed: string;
  readonly externalOperationCount: number;
  readonly duplicateExternalOperationCount: number;
  readonly falseSuccessCount: number;
  readonly failureHistoryPreserved: boolean;
  readonly history: Phase1FaultAttempt["history"];
}

function safeErrorCode(error: unknown): string {
  return safePhase1ErrorCode(error);
}

function fixtureOperation(
  selectedOperationId = operationId,
  selectedAttemptId = AttemptIdSchema.parse("att_phase1load001"),
) {
  return createExternalOperation({
    schemaVersion: 1,
    operationId: selectedOperationId,
    projectId,
    runId,
    attemptId: selectedAttemptId,
    operationVersion: 2,
    operationType: "session.observe",
    requestedCapabilities: ["observe"],
    payload: {
      nativeSessionId: "ses_phase1load001",
      controllerLeaseId: "ctl_phase1load001",
      controllerLeaseOwnerId: "own_phase1load001",
      controllerLeaseGeneration: 1,
    },
  });
}

function commitFixture(
  journal: SqliteOperationJournal,
  options: {
    readonly commandId: string;
    readonly aggregateId: string;
    readonly eventId: string;
    readonly eventType?: string;
    readonly eventData?: unknown;
    readonly operations?: readonly ReturnType<typeof fixtureOperation>[];
  },
): void {
  journal.commitCommand({
    commandId: options.commandId,
    requestFingerprint: createHash("sha256")
      .update(options.commandId)
      .digest("hex"),
    projectId,
    aggregateId: options.aggregateId,
    expectedVersion: 0,
    actor: {
      actorId: "phase1-benchmark",
      correlationId: options.commandId,
    },
    events: [{
      eventId: options.eventId,
      eventType: options.eventType ?? "ProjectCreated",
      eventData: options.eventData ?? {
        projectId,
        name: "Phase 1 fixed project",
      },
      schemaVersion: 1,
      occurredAt: fixedObservedAt,
    }],
    operations: options.operations ?? [],
    response: { accepted: true },
  });
}

function commitHistoricalRuns(journal: SqliteOperationJournal): void {
  const random = createPhase1Random(PHASE1_LOAD_DATASET.seed);
  journal.commitCommand({
    commandId: "cmd_phase1_historical_runs",
    requestFingerprint: createHash("sha256")
      .update("cmd_phase1_historical_runs")
      .digest("hex"),
    projectId,
    aggregateId: "project:phase1-historical-runs",
    expectedVersion: 0,
    actor: {
      actorId: "phase1-benchmark",
      correlationId: "phase1-historical-runs",
    },
    events: Array.from(
      { length: PHASE1_LOAD_DATASET.runCount },
      (_, index) => ({
        eventId: `evt_phase1_historical_${(index + 1)
          .toString()
          .padStart(6, "0")}`,
        eventType: "HistoricalRunRecorded",
        eventData: {
          runOrdinal: index + 1,
          deterministicBucket: random.nextUint32() % 16,
        },
        schemaVersion: 1,
        occurredAt: fixedObservedAt,
      }),
    ),
    operations: [],
    response: { runCount: PHASE1_LOAD_DATASET.runCount },
  });
}

function fakeRuntime(): FakeRuntime {
  return new FakeRuntime({
    providerId: RuntimeProviderIdSchema.parse("rtp_phase1fake001"),
    implementationVersion: "phase1-contract-only",
    observedAt: fixedObservedAt,
  });
}

function withTemporaryDatabase<T>(
  prefix: string,
  run: (database: DatabaseSync, root: string) => T,
): T {
  const root = mkdtempSync(join(tmpdir(), `hunter-phase1-${prefix}-`));
  const database = new DatabaseSync(join(root, "hunter.sqlite"));
  try {
    return run(database, root);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function operationCrashScenario(
  faultPoint:
    | "after_command_commit_before_provider_call"
    | "after_provider_success_before_receipt_commit"
    | "after_receipt_commit_before_outbox_complete",
  recoveryPolicy: "inspectable" | "unsafe",
): Promise<FaultScenarioResult> {
  const root = mkdtempSync(join(tmpdir(), "hunter-phase1-operation-crash-"));
  const databasePath = join(root, "hunter.sqlite");
  let database = new DatabaseSync(databasePath);
  const runtime = fakeRuntime();
  try {
    commitFixture(new SqliteOperationJournal(database), {
      commandId: `cmd_phase1_${faultPoint}`,
      aggregateId: `attempt:${faultPoint}`,
      eventId: `evt_phase1_${faultPoint}`,
      eventType: "AttemptAssigned",
      eventData: { attemptId: "att_phase1load001" },
      operations: [fixtureOperation()],
    });
    const crashing = new OperationWorker(database, runtime, {
      ownerId: "phase1-worker-crash",
      dispatchLeaseMs: 1,
      now: () => new Date(fixedObservedAt),
      replayPolicy: () => recoveryPolicy,
      faultInjector: new FaultInjector(faultPoint),
    });
    let injectedCode = "FAULT_NOT_INJECTED";
    try {
      await crashing.runOnce();
    } catch (error) {
      injectedCode = safeErrorCode(error);
    }
    if (injectedCode === "FAULT_NOT_INJECTED") {
      throw new Error(injectedCode);
    }

    database.close();
    database = new DatabaseSync(databasePath);
    const resumed = new OperationWorker(database, runtime, {
      ownerId: "phase1-worker-recovery",
      now: () => new Date("2026-07-25T00:00:01.000Z"),
      replayPolicy: () => recoveryPolicy,
    });
    const recovery = await resumed.runOnce();
    const outbox = database
      .prepare("SELECT status FROM outbox WHERE operation_id = ?")
      .get(operationId) as { readonly status: string } | undefined;
    const expectedRecovery =
      recoveryPolicy === "unsafe" ? "needs_attention" : faultPoint ===
        "after_receipt_commit_before_outbox_complete"
        ? "idle"
        : "completed";
    const converged =
      recovery === expectedRecovery
      && outbox?.status ===
        (recoveryPolicy === "unsafe" ? "needs_attention" : "completed")
      && runtime.nativeEffectCount <= 1;
    if (!converged) {
      throw new Error(
        `OPERATION_RECOVERY_MISMATCH:${recovery}:${outbox?.status ?? "missing"}`,
      );
    }
    return {
      expected:
        "injected crash is preserved and recovery converges without duplicate external operation",
      observed: `${injectedCode} -> ${recovery}:${outbox.status}`,
      externalOperationCount: runtime.nativeEffectCount,
      duplicateExternalOperationCount: Math.max(
        0,
        runtime.nativeEffectCount - 1,
      ),
      falseSuccessCount: recoveryPolicy === "unsafe" && outbox.status ===
        "completed"
        ? 1
        : 0,
      failureHistoryPreserved: true,
      history: [
        {
          sequence: 1,
          outcome: "INJECTED_FAILURE",
          code: injectedCode,
          observedAt: fixedObservedAt,
        },
        {
          sequence: 2,
          outcome: "RECOVERY_PASS",
          code: `RECOVERY_${recovery.toUpperCase()}`,
          observedAt: "2026-07-25T00:00:01.000Z",
        },
      ],
    };
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function commitCrashScenario(
  point: "before_commit" | "after_commit",
): FaultScenarioResult {
  const root = mkdtempSync(join(tmpdir(), `hunter-phase1-${point}-`));
  const databasePath = join(root, "hunter.sqlite");
  let database = new DatabaseSync(databasePath);
  const injectedCode = point === "before_commit"
    ? "INJECTED_BEFORE_COMMIT"
    : "INJECTED_AFTER_COMMIT";
  try {
    const crashing = new SqliteOperationJournal(database, {
      transactionFault: (observedPoint) => {
        if (observedPoint === point) throw new Error(injectedCode);
      },
    });
    let observedCode = "FAULT_NOT_INJECTED";
    try {
      commitFixture(crashing, {
        commandId: `cmd_phase1_${point}`,
        aggregateId: `project:phase1-${point}`,
        eventId: `evt_phase1_${point}`,
      });
    } catch (error) {
      observedCode = safeErrorCode(error);
    }
    database.close();
    database = new DatabaseSync(databasePath);
    const durableBeforeRecovery = (
      database.prepare("SELECT COUNT(*) AS count FROM events").get() as {
        readonly count: number;
      }
    ).count;
    commitFixture(new SqliteOperationJournal(database), {
      commandId: `cmd_phase1_${point}`,
      aggregateId: `project:phase1-${point}`,
      eventId: `evt_phase1_${point}`,
    });
    const durableAfterRecovery = (
      database.prepare("SELECT COUNT(*) AS count FROM events").get() as {
        readonly count: number;
      }
    ).count;
    const expectedBeforeRecovery = point === "before_commit" ? 0 : 1;
    if (
      observedCode !== injectedCode
      || durableBeforeRecovery !== expectedBeforeRecovery
      || durableAfterRecovery !== 1
    ) {
      throw new Error("COMMIT_BOUNDARY_MISMATCH");
    }
    return {
      expected: point === "before_commit"
        ? "connection loss before commit rolls back, then recovery commits once"
        : "connection loss after commit replays the durable receipt without duplication",
      observed:
        `${observedCode}; durable events ${durableBeforeRecovery} before recovery and ${durableAfterRecovery} after`,
      externalOperationCount: 0,
      duplicateExternalOperationCount: 0,
      falseSuccessCount: 0,
      failureHistoryPreserved: true,
      history: [
        {
          sequence: 1,
          outcome: "INJECTED_FAILURE",
          code: injectedCode,
          observedAt: fixedObservedAt,
        },
        {
          sequence: 2,
          outcome: "RECOVERY_PASS",
          code: point === "before_commit"
            ? "RECOVERY_COMMITTED_ONCE"
            : "RECEIPT_REPLAYED_WITHOUT_DUPLICATE",
          observedAt: "2026-07-25T00:00:01.000Z",
        },
      ],
    };
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function archiveManifestInput() {
  const hash = "a".repeat(64);
  const leaseBase = {
    schemaVersion: 2 as const,
    projectId,
    repositoryId: "rep_phase1load001",
    deviceBindingId: "dev_phase1load001",
    canonicalWorkspaceKey: "win32:c:\\hunter\\phase1-load",
    gitHead: "1".repeat(40),
    branch: "codex/phase1-performance-soak",
    ownerRunId: runId,
    ownerAttemptId: "att_phase1load001",
    ownerId: "own_phase1load001",
    generation: 1,
    mode: "write" as const,
    acquiredAt: "2026-07-25T00:00:00.000Z",
    expiresAt: "2026-07-25T01:00:00.000Z",
    revokedAt: null,
    revocationReason: null,
    receiptHash: "b".repeat(64),
  };
  return ArchiveManifestInputSchema.parse({
    schemaVersion: 2,
    projectId,
    repositories: [{
      repositoryId: "rep_phase1load001",
      deviceBindingId: "dev_phase1load001",
      gitHead: "1".repeat(40),
    }],
    requirementRevisionIds: ["rrv_phase1load001"],
    change: {
      changeId: "chg_phase1load001",
      changeRevisionId: "crv_phase1load001",
    },
    executionPlanId: "epl_phase1load001",
    workflowId: "wfl_phase1load001",
    workflowRevisionId: "wfr_phase1load001",
    runGraph: {
      rootRunId: runId,
      runs: [{
        runId,
        parentRunId: null,
        taskId: null,
        outcome: "failed",
        steps: [{
          stepRunId: "spr_phase1load001",
          stepId: "stp_phase1load001",
          attempts: [{
            attemptId: "att_phase1load001",
            agentProfileId: "apr_phase1load001",
            capabilityProbeDigest: "c".repeat(64),
            nativeSessionReferenceHash: "d".repeat(64),
            artifacts: [{
              artifactId: "art_phase1load001",
              contentRef: `cas:sha256:${hash}`,
              contentHash: hash,
            }],
            evidence: [{
              evidenceId: "evd_phase1load001",
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
        leaseId: "wsl_phase1load001",
        scope: { workspaceId: "wsp_phase1load001" },
      }],
      writer: [{
        ...leaseBase,
        kind: "writer",
        leaseId: "wrl_phase1load001",
        scope: {
          workspaceId: "wsp_phase1load001",
          worktreeId: "wtr_phase1load001",
        },
      }],
      controller: [{
        ...leaseBase,
        kind: "controller",
        leaseId: "ctl_phase1load001",
        scope: {
          workspaceId: "wsp_phase1load001",
          worktreeId: "wtr_phase1load001",
          nativeSessionId: "ses_phase1load001",
        },
      }],
    },
    ledger: { firstPosition: 1, lastPosition: 1 },
    actor: {
      actorId: "phase1-benchmark",
      correlationId: "phase1-archive",
    },
    timestamps: {
      occurredAt: fixedObservedAt,
      archivedAt: "2026-07-25T00:00:01.000Z",
    },
    outcome: "failed",
  });
}

async function runFaultScenario(
  scenario: Phase1FaultScenario,
): Promise<FaultScenarioResult> {
  switch (scenario) {
    case "crash_before_commit":
      return commitCrashScenario("before_commit");
    case "crash_after_commit":
      return commitCrashScenario("after_commit");
    case "crash_before_dispatch":
      return await operationCrashScenario(
        "after_command_commit_before_provider_call",
        "inspectable",
      );
    case "crash_after_dispatch":
      return await operationCrashScenario(
        "after_provider_success_before_receipt_commit",
        "unsafe",
      );
    case "crash_before_receipt":
      return await operationCrashScenario(
        "after_provider_success_before_receipt_commit",
        "inspectable",
      );
    case "crash_after_receipt":
      return await operationCrashScenario(
        "after_receipt_commit_before_outbox_complete",
        "inspectable",
      );
    case "projection_loss":
      return withTemporaryDatabase("projection-loss", (database) => {
        const journal = new SqliteOperationJournal(database);
        commitFixture(journal, {
          commandId: "cmd_phase1_projection",
          aggregateId: "project:phase1-projection",
          eventId: "evt_phase1_projection",
        });
        const runner = new ProjectionRunner(database, [new HunterProjection()]);
        runner.rebuild("hunter");
        const expected = JSON.stringify(runner.snapshot("hunter"));
        database.prepare(
          "DELETE FROM entity_views WHERE projector_name = 'hunter'",
        ).run();
        const lost = runner.snapshot("hunter");
        runner.rebuild("hunter");
        const restored = JSON.stringify(runner.snapshot("hunter"));
        if (lost.length !== 0 || restored !== expected) {
          throw new Error("PROJECTION_REBUILD_MISMATCH");
        }
        return {
          expected: "projection deletion is visible and rebuild restores ledger truth",
          observed: "projection emptied then rebuilt byte-for-byte",
          externalOperationCount: 0,
          duplicateExternalOperationCount: 0,
          falseSuccessCount: 0,
          failureHistoryPreserved: true,
          history: [
            {
              sequence: 1,
              outcome: "INJECTED_FAILURE",
              code: "PROJECTION_DELETED",
              observedAt: fixedObservedAt,
            },
            {
              sequence: 2,
              outcome: "RECOVERY_PASS",
              code: "PROJECTION_REBUILT_FROM_LEDGER",
              observedAt: "2026-07-25T00:00:01.000Z",
            },
          ],
        };
      });
    case "archive_interrupted": {
      const root = mkdtempSync(join(tmpdir(), "hunter-phase1-archive-"));
      const database = new DatabaseSync(join(root, "hunter.sqlite"));
      try {
        new SqliteOperationJournal(database);
        const store = new SqliteArchiveJobStore(database);
        store.schedule({
          projectId,
          runId,
          outcome: "failed",
          firstPosition: 1,
          lastPosition: 1,
          actorId: "phase1-benchmark",
          correlationId: "phase1-archive",
          occurredAt: fixedObservedAt,
        });
        let injected = false;
        const crashing = new ArchiveJobWorker({
          store,
          writer: new ArchiveWriter(join(root, "archives")),
          catalog: new SqliteKnowledgeCatalog(
            database,
            () => new Date(fixedObservedAt),
          ),
          source: { build: () => archiveManifestInput() },
          ownerId: LeaseOwnerIdSchema.parse("own_phase1archive001"),
          now: () => new Date(fixedObservedAt),
          leaseDurationMs: 1,
          fault: (point) => {
            if (!injected && point === "after_manifest_publication") {
              injected = true;
              throw new Error("INJECTED_AFTER_MANIFEST_PUBLICATION");
            }
          },
        });
        let injectedCode = "FAULT_NOT_INJECTED";
        try {
          await crashing.runOnce();
        } catch (error) {
          injectedCode = safeErrorCode(error);
        }
        const recovered = new ArchiveJobWorker({
          store: new SqliteArchiveJobStore(database),
          writer: new ArchiveWriter(join(root, "archives")),
          catalog: new SqliteKnowledgeCatalog(
            database,
            () => new Date("2026-07-25T00:00:01.000Z"),
          ),
          source: { build: () => archiveManifestInput() },
          ownerId: LeaseOwnerIdSchema.parse("own_phase1archive001"),
          now: () => new Date("2026-07-25T00:00:01.000Z"),
          leaseDurationMs: 1,
        });
        const result = await recovered.runOnce();
        const archiveFiles = readdirSync(join(root, "archives")).filter(
          (name) => name.endsWith(".json"),
        );
        const row = database.prepare(
          "SELECT status, attempt_count FROM archive_jobs WHERE run_id = ?",
        ).get(runId) as {
          readonly status: string;
          readonly attempt_count: number;
        } | undefined;
        if (
          injectedCode === "FAULT_NOT_INJECTED"
          || result !== "completed"
          || archiveFiles.length !== 1
          || row?.status !== "completed"
          || row.attempt_count !== 2
        ) {
          throw new Error("ARCHIVE_RECOVERY_MISMATCH");
        }
        return {
          expected: "published manifest is recovered exactly once after interruption",
          observed: `${injectedCode} -> completed with one manifest and two attempts`,
          externalOperationCount: 0,
          duplicateExternalOperationCount: 0,
          falseSuccessCount: 0,
          failureHistoryPreserved: true,
          history: [
            {
              sequence: 1,
              outcome: "INJECTED_FAILURE",
              code: injectedCode,
              observedAt: fixedObservedAt,
            },
            {
              sequence: 2,
              outcome: "RECOVERY_PASS",
              code: "ARCHIVE_RECOVERED_EXACTLY_ONCE",
              observedAt: "2026-07-25T00:00:01.000Z",
            },
          ],
        };
      } finally {
        database.close();
        rmSync(root, { recursive: true, force: true });
      }
    }
    case "disk_full":
      return withTemporaryDatabase("disk-full", (database) => {
        const journal = new SqliteOperationJournal(database);
        database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        database.exec("PRAGMA journal_mode = DELETE");
        const currentPages = Number(
          (
            database.prepare("PRAGMA page_count").get() as {
              readonly page_count: number;
            }
          ).page_count,
        );
        database.exec(`PRAGMA max_page_count = ${currentPages}`);
        let rejected = false;
        let rejectionCode = "NO_REJECTION";
        try {
          commitFixture(journal, {
            commandId: "cmd_phase1_disk_full",
            aggregateId: "project:phase1-disk-full",
            eventId: "evt_phase1_disk_full",
            eventData: {
              projectId,
              name: "x".repeat(2 * 1024 * 1024),
            },
          });
        } catch (error) {
          rejectionCode = safeErrorCode(error);
          rejected = /FULL|DISK/iu.test(rejectionCode);
        }
        const failedCount = (
          database.prepare("SELECT COUNT(*) AS count FROM events").get() as {
            readonly count: number;
          }
        ).count;
        database.exec("PRAGMA max_page_count = 1073741823");
        commitFixture(journal, {
          commandId: "cmd_phase1_disk_recovery",
          aggregateId: "project:phase1-disk-recovery",
          eventId: "evt_phase1_disk_recovery",
        });
        if (!rejected || failedCount !== 0) {
          throw new Error(
            `SQLITE_FULL_NOT_FAIL_CLOSED:${rejectionCode}:EVENTS_${failedCount}`,
          );
        }
        return {
          expected: "SQLITE_FULL rolls back the command and later recovery is explicit",
          observed: "large commit rejected with zero events; bounded commit later accepted",
          externalOperationCount: 0,
          duplicateExternalOperationCount: 0,
          falseSuccessCount: 0,
          failureHistoryPreserved: true,
          history: [
            {
              sequence: 1,
              outcome: "EXPECTED_REJECTION",
              code: "SQLITE_FULL",
              observedAt: fixedObservedAt,
            },
            {
              sequence: 2,
              outcome: "RECOVERY_PASS",
              code: "CAPACITY_RESTORED_COMMIT_ACCEPTED",
              observedAt: "2026-07-25T00:00:01.000Z",
            },
          ],
        };
      });
    case "read_only":
      return withTemporaryDatabase("read-only", (database) => {
        const journal = new SqliteOperationJournal(database);
        database.exec("PRAGMA query_only = ON");
        let rejected = false;
        try {
          commitFixture(journal, {
            commandId: "cmd_phase1_read_only",
            aggregateId: "project:phase1-read-only",
            eventId: "evt_phase1_read_only",
          });
        } catch (error) {
          rejected = /READONLY|READ-ONLY/iu.test(
            error instanceof Error ? error.message : "",
          );
        }
        database.exec("PRAGMA query_only = OFF");
        commitFixture(journal, {
          commandId: "cmd_phase1_read_write_recovery",
          aggregateId: "project:phase1-read-write-recovery",
          eventId: "evt_phase1_read_write_recovery",
        });
        if (!rejected) throw new Error("READ_ONLY_NOT_FAIL_CLOSED");
        return {
          expected: "read-only storage rejects mutation without inferred success",
          observed: "read-only command rejected; explicit writable recovery accepted",
          externalOperationCount: 0,
          duplicateExternalOperationCount: 0,
          falseSuccessCount: 0,
          failureHistoryPreserved: true,
          history: [
            {
              sequence: 1,
              outcome: "EXPECTED_REJECTION",
              code: "SQLITE_READONLY",
              observedAt: fixedObservedAt,
            },
            {
              sequence: 2,
              outcome: "RECOVERY_PASS",
              code: "WRITABLE_COMMIT_ACCEPTED",
              observedAt: "2026-07-25T00:00:01.000Z",
            },
          ],
        };
      });
    case "sse_gap":
      return withTemporaryDatabase("sse-gap", (database) => {
        const journal = new SqliteOperationJournal(database);
        commitFixture(journal, {
          commandId: "cmd_phase1_sse",
          aggregateId: "project:phase1-sse",
          eventId: "evt_phase1_sse",
        });
        const reader = new EventLedgerReader(database);
        reader.setRetentionFloor(1);
        const stream = new DurableEventStream(reader, undefined, undefined, () => ({
          projectionVersion: 1,
          cursor: 1,
          entities: [{ projectId }],
        }));
        const gap = stream.replay({
          headerCursor: "0",
          authorizedProjectIds: [projectId],
        });
        const snapshot = stream.snapshot([projectId]);
        const resumed = stream.replay({
          headerCursor: String(snapshot.cursor),
          authorizedProjectIds: [projectId],
        });
        if (
          gap.status !== "resync_required"
          || resumed.status !== "ok"
          || snapshot.cursor !== 1
        ) {
          throw new Error("SSE_GAP_RECOVERY_MISMATCH");
        }
        return {
          expected: "retention gap requires snapshot replacement before resume",
          observed: "EVENT_CURSOR_GAP -> snapshot cursor 1 -> replay ok",
          externalOperationCount: 0,
          duplicateExternalOperationCount: 0,
          falseSuccessCount: 0,
          failureHistoryPreserved: true,
          history: [
            {
              sequence: 1,
              outcome: "EXPECTED_REJECTION",
              code: "EVENT_CURSOR_GAP",
              observedAt: fixedObservedAt,
            },
            {
              sequence: 2,
              outcome: "RECOVERY_PASS",
              code: "SNAPSHOT_REPLACED_AND_RESUMED",
              observedAt: "2026-07-25T00:00:01.000Z",
            },
          ],
        };
      });
    case "mobile_replay":
      return withTemporaryDatabase("mobile-replay", (database) => {
        const journal = new SqliteOperationJournal(database);
        const gateway = new DeviceGateway({
          journal,
          authorization: { authorize: () => undefined },
          commands: {
            handle(command) {
              const commandId = `ApplyRunControl:${command.idempotencyKey}`;
              const receipt = journal.commitCommand({
                commandId,
                requestFingerprint: canonicalSha256(command),
                projectId,
                aggregateId: `mobile:${runId}`,
                expectedVersion: 0,
                actor: {
                  actorId: "phase1-mobile",
                  correlationId: command.idempotencyKey,
                },
                events: [],
                operations: [],
                response: { action: command.type },
              });
              return {
                commandId,
                response: receipt.response,
              };
            },
          },
        });
        const command = MobileCommandEnvelopeSchema.parse({
          projectId,
          runId,
          stepRunId: "spr_phase1load001",
          expectedVersion: 0,
          idempotencyKey: "phase1-mobile-replay-001",
          action: "pause_run",
          payload: {},
        });
        const principal = {
          deviceId: DeviceIdSchema.parse("dvc_phase1load001"),
          scopes: ["runs:control" as const],
          projectIds: [projectId],
        };
        const first = gateway.execute(command, principal);
        const replay = gateway.execute(command, principal);
        const receipts = database.prepare(
          "SELECT COUNT(*) AS count FROM command_receipts WHERE command_id = ?",
        ).get(`ApplyRunControl:${command.idempotencyKey}`) as {
          readonly count: number;
        };
        if (JSON.stringify(first) !== JSON.stringify(replay) || receipts.count !== 1) {
          throw new Error("MOBILE_REPLAY_DUPLICATED");
        }
        return {
          expected: "same mobile idempotency key returns one durable receipt",
          observed: "two deliveries returned one identical command receipt",
          externalOperationCount: 0,
          duplicateExternalOperationCount: 0,
          falseSuccessCount: 0,
          failureHistoryPreserved: true,
          history: [{
            sequence: 1,
            outcome: "OBSERVED_PASS",
            code: "MOBILE_REPLAY_RETURNED_ORIGINAL_RECEIPT",
            observedAt: fixedObservedAt,
          }],
        };
      });
  }
}

export async function runPhase1FaultMatrix(): Promise<
  readonly Phase1FaultAttempt[]
> {
  const clock = createPhase1FakeClock(PHASE1_LOAD_DATASET.fakeClockStart);
  const attempts: Phase1FaultAttempt[] = [];
  for (const [index, scenario] of PHASE1_FAULT_SCENARIOS.entries()) {
    const started = performance.now();
    try {
      const result = await runFaultScenario(scenario);
      attempts.push(
        Phase1FaultAttemptSchema.parse({
          attemptId: `fat_${scenario}_${index + 1}`,
          scenario,
          status: "PASS",
          elapsedMs: performance.now() - started,
          ...result,
        }),
      );
    } catch (error) {
      attempts.push(
        Phase1FaultAttemptSchema.parse({
          attemptId: `fat_${scenario}_${index + 1}`,
          scenario,
          status: "FAIL",
          expected: "scenario converges without duplicate effect or false success",
          observed: safeErrorCode(error),
          elapsedMs: performance.now() - started,
          externalOperationCount: 0,
          duplicateExternalOperationCount: 0,
          falseSuccessCount: 0,
          failureHistoryPreserved: true,
          history: [{
            sequence: 1,
            outcome: "NOT_PROVEN",
            code: safeErrorCode(error),
            observedAt: clock.advance(1).toISOString(),
          }],
        }),
      );
    }
  }
  return attempts;
}

function projectListFixture() {
  return ProjectListHttpResponseSchema.parse({
    projects: Array.from(
      { length: PHASE1_LOAD_DATASET.projectCount },
      (_, index) => ({
        projectId: `prj_phase1${(index + 1).toString().padStart(6, "0")}`,
        name: `Phase 1 Project ${(index + 1).toString().padStart(3, "0")}`,
      }),
    ),
  });
}

function concurrentAttemptId(index: number): AttemptId {
  return AttemptIdSchema.parse(
    `att_phase1concurrent${(index + 1).toString().padStart(3, "0")}`,
  );
}

function runViewFixture(
  position = 1,
  status: "running" | "paused" = "running",
  activeAttemptIds?: readonly AttemptId[],
) {
  if (
    activeAttemptIds !== undefined
    && activeAttemptIds.length !== PHASE1_LOAD_DATASET.activeFakeSteps
  ) {
    throw new Error("PHASE1_ACTIVE_ATTEMPT_SET_INVALID");
  }
  return RunViewHttpResponseSchema.parse({
    runId,
    projectionPosition: position,
    aggregateVersion: position,
    status,
    steps: Array.from(
      { length: PHASE1_LOAD_DATASET.stepsPerRun },
      (_, index) => {
        const suffix = (index + 1).toString().padStart(3, "0");
        const active = index >= PHASE1_LOAD_DATASET.readonlyWaitingSteps;
        const activeIndex = index - PHASE1_LOAD_DATASET.readonlyWaitingSteps;
        const attemptId = active && activeAttemptIds !== undefined
          ? activeAttemptIds[activeIndex]
          : `att_phase1${suffix}`;
        if (attemptId === undefined) {
          throw new Error("PHASE1_ACTIVE_ATTEMPT_SET_INVALID");
        }
        return {
          stepRunId: active && activeAttemptIds !== undefined
            ? `spr_phase1concurrent${(activeIndex + 1)
              .toString()
              .padStart(3, "0")}`
            : `spr_phase1${suffix}`,
          title: active
            ? `active Fake step ${suffix}`
            : `read-only waiting step ${suffix}`,
          conclusion: active ? "active" : "succeeded",
          attempts: [{
            attemptId,
            attemptNumber: 1,
            executionStatus: active ? "running" : "returned",
            verificationStatus: active ? "pending" : "passed",
            artifactIds: [],
            evidenceIds: [],
          }],
        };
      },
    ),
  });
}

const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Node",
  "sessionStorage",
  "React",
] as const;

async function withDom<T>(run: (document: Document) => Promise<T>): Promise<T> {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
    url: "https://phase1.hunter.invalid/",
  });
  const prior = new Map<string, PropertyDescriptor | undefined>();
  for (const key of DOM_GLOBALS) {
    prior.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }
  const window = dom.window;
  const values: Readonly<Record<(typeof DOM_GLOBALS)[number], unknown>> = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    sessionStorage: window.sessionStorage,
    React,
  };
  for (const key of DOM_GLOBALS) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: values[key],
    });
  }
  const actDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "IS_REACT_ACT_ENVIRONMENT",
  );
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    writable: true,
    value: true,
  });
  try {
    return await run(window.document);
  } finally {
    if (actDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    } else {
      Object.defineProperty(
        globalThis,
        "IS_REACT_ACT_ENVIRONMENT",
        actDescriptor,
      );
    }
    for (const key of DOM_GLOBALS) {
      const descriptor = prior.get(key);
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
      else Object.defineProperty(globalThis, key, descriptor);
    }
    dom.window.close();
  }
}

async function waitForDom(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started >= timeoutMs) {
      throw new Error("PHASE1_UI_MEASUREMENT_TIMEOUT");
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 0));
  }
}

async function measureProjectListInteractive(): Promise<number> {
  return await withDom(async (document) => {
    const host = document.getElementById("root");
    if (host === null) throw new Error("PHASE1_UI_ROOT_MISSING");
    const root = createRoot(host);
    const fixture = projectListFixture();
    const started = performance.now();
    await React.act(async () => {
      root.render(
        React.createElement(ProjectListPage, {
          api: {
            listProjects: async () => fixture,
            createProject: async () => {
              throw new Error("PHASE1_CREATE_NOT_MEASURED");
            },
          },
          onOpen: () => undefined,
        }),
      );
    });
    await waitForDom(
      () =>
        document.querySelectorAll("ul.project-list > li").length ===
        PHASE1_LOAD_DATASET.projectCount,
    );
    const elapsed = performance.now() - started;
    await React.act(async () => root.unmount());
    return elapsed;
  });
}

async function measureRunPageInteractive(): Promise<number> {
  return await withDom(async (document) => {
    const host = document.getElementById("root");
    if (host === null) throw new Error("PHASE1_UI_ROOT_MISSING");
    const root = createRoot(host);
    const fixture = runViewFixture();
    const started = performance.now();
    await React.act(async () => {
      root.render(
        React.createElement(RunPage, {
          runId,
          api: { getRun: async () => fixture },
        }),
      );
    });
    await waitForDom(
      () =>
        document.querySelectorAll("ol.run-line > li").length ===
        PHASE1_LOAD_DATASET.stepsPerRun,
    );
    const elapsed = performance.now() - started;
    await React.act(async () => root.unmount());
    return elapsed;
  });
}

async function measureEventToUiVisible(): Promise<number> {
  const database = new DatabaseSync(":memory:");
  const journal = new SqliteOperationJournal(database);
  commitHistoricalRuns(journal);
  commitFixture(journal, {
    commandId: "cmd_phase1_event_initial",
    aggregateId: "run:phase1-event-initial",
    eventId: "evt_phase1_event_initial",
  });
  const reader = new EventLedgerReader(database);
  const durable = new DurableEventStream(reader);
  try {
    return await withDom(async (document) => {
      const host = document.getElementById("root");
      if (host === null) throw new Error("PHASE1_UI_ROOT_MISSING");
      const root = createRoot(host);
      const initialPosition = PHASE1_LOAD_DATASET.runCount + 1;
      const initial = runViewFixture(initialPosition);
      const refreshed = runViewFixture(initialPosition + 1, "paused");
      let calls = 0;
      const stream = {
        subscribe(
          input: { readonly after: number },
          handlers: RunEventStreamHandlers,
        ): () => void {
          const abort = new AbortController();
          void (async () => {
            try {
              for await (
                const event of durable.readerTail({
                  position: input.after,
                  authorizedProjectIds: [projectId],
                  signal: abort.signal,
                })
              ) {
                await React.act(async () => {
                  handlers.onEvent({
                    schemaVersion: 1,
                    position: event.position,
                    runId,
                    eventType: "run_projection_changed",
                  });
                });
              }
            } catch {
              if (!abort.signal.aborted) handlers.onError();
            }
          })();
          return () => abort.abort();
        },
      };
      await React.act(async () => {
        root.render(
          React.createElement(RunPage, {
            runId,
            api: {
              getRun: async () => {
                calls += 1;
                return calls === 1 ? initial : refreshed;
              },
            },
            eventStream: stream,
          }),
        );
      });
      await waitForDom(
        () => document.body.textContent?.includes("实时更新已连接") === true,
      );
      const started = performance.now();
      commitFixture(journal, {
        commandId: "cmd_phase1_event_refresh",
        aggregateId: "run:phase1-event-refresh",
        eventId: "evt_phase1_event_refresh",
      });
      await waitForDom(
        () => document.body.textContent?.includes("已暂停") === true,
      );
      const elapsed = performance.now() - started;
      await React.act(async () => root.unmount());
      return elapsed;
    });
  } finally {
    database.close();
  }
}

interface ConcurrentWorkloadEvidence {
  readonly uiStepCount: number;
  readonly readonlyWaitingStepCount: number;
  readonly activeFakeStepCount: number;
  readonly linkedActiveStepCount: number;
  readonly ledgerEventCount: number;
  readonly completedOutboxCount: number;
  readonly receiptCount: number;
  readonly providerInvocationCount: number;
  readonly providerNativeEffectCount: number;
}

export async function runPhase1ConcurrentWorkloadProbe(): Promise<{
  readonly elapsedMs: number;
  readonly evidence: ConcurrentWorkloadEvidence;
}> {
  const database = new DatabaseSync(":memory:");
  const journal = new SqliteOperationJournal(database);
  commitHistoricalRuns(journal);
  const runtime = new FakeRuntime({
    providerId: RuntimeProviderIdSchema.parse("rtp_phase1fake001"),
    implementationVersion: "phase1-concurrent-contract-only",
    observedAt: fixedObservedAt,
  });
  const activeAttemptIds = Array.from(
    { length: PHASE1_LOAD_DATASET.activeFakeSteps },
    (_, index) => concurrentAttemptId(index),
  );
  for (let index = 0; index < PHASE1_LOAD_DATASET.activeFakeSteps; index += 1) {
    const suffix = index + 1;
    const attemptId = activeAttemptIds[index];
    if (attemptId === undefined) {
      throw new Error("PHASE1_ACTIVE_ATTEMPT_SET_INVALID");
    }
    commitFixture(journal, {
      commandId: `cmd_phase1_concurrent_${suffix}`,
      aggregateId: `attempt:phase1-concurrent-${suffix}`,
      eventId: `evt_phase1_concurrent_${suffix}`,
      eventType: "AttemptAssigned",
      eventData: { attemptId },
      operations: [
        fixtureOperation(
          OperationIdSchema.parse(`opn_phase1concurrent${suffix}`),
          attemptId,
        ),
      ],
    });
  }
  try {
    return await withDom(async (document) => {
      const host = document.getElementById("root");
      if (host === null) throw new Error("PHASE1_UI_ROOT_MISSING");
      const root = createRoot(host);
      const fixture = runViewFixture(1, "running", activeAttemptIds);
      const workers = Array.from(
        { length: PHASE1_LOAD_DATASET.activeFakeSteps },
        (_, index) =>
          new OperationWorker(database, runtime, {
            ownerId: `phase1-concurrent-worker-${index + 1}`,
          }),
      );
      const started = performance.now();
      const workerResults = Promise.all(
        workers.map(async (worker) => await worker.runOnce()),
      );
      await React.act(async () => {
        root.render(
          React.createElement(RunPage, {
            runId,
            api: { getRun: async () => fixture },
          }),
        );
      });
      const results = await workerResults;
      await waitForDom(
        () =>
          document.querySelectorAll("ol.run-line > li").length
            === PHASE1_LOAD_DATASET.stepsPerRun,
      );
      const elapsedMs = performance.now() - started;
      const ledgerAttemptIds = new Set(
        (
          database.prepare(
            `SELECT json_extract(event_data, '$.attemptId') AS attempt_id
               FROM events
              WHERE event_type = 'AttemptAssigned'`,
          ).all() as unknown as readonly {
            readonly attempt_id: string | null;
          }[]
        ).flatMap(({ attempt_id }) => attempt_id === null ? [] : [attempt_id]),
      );
      const receiptOperationIds = new Set(
        (
          database.prepare(
            "SELECT operation_id FROM side_effect_receipts",
          ).all() as unknown as readonly {
            readonly operation_id: string;
          }[]
        ).map(({ operation_id }) => operation_id),
      );
      const providerOperationIds = new Set(runtime.operationIds());
      const linkedAttemptIds = new Set(
        (
          database.prepare(
            "SELECT operation_id, attempt_id FROM outbox",
          ).all() as unknown as readonly {
            readonly operation_id: string;
            readonly attempt_id: string;
          }[]
        ).flatMap(({ attempt_id, operation_id }) =>
          ledgerAttemptIds.has(attempt_id)
          && receiptOperationIds.has(operation_id)
          && providerOperationIds.has(operation_id)
            ? [attempt_id]
            : []),
      );
      const activeUiAttemptIds = fixture.steps
        .filter(({ title }) => title.startsWith("active Fake step"))
        .flatMap(({ attempts }) => attempts.map(({ attemptId }) => attemptId));
      const evidence: ConcurrentWorkloadEvidence = {
        uiStepCount: document.querySelectorAll("ol.run-line > li").length,
        readonlyWaitingStepCount: fixture.steps.filter(
          ({ title }) => title.startsWith("read-only waiting step"),
        ).length,
        activeFakeStepCount: fixture.steps.filter(
          ({ title }) => title.startsWith("active Fake step"),
        ).length,
        linkedActiveStepCount: activeUiAttemptIds.filter(
          (attemptId) => linkedAttemptIds.has(attemptId),
        ).length,
        ledgerEventCount: (
          database.prepare("SELECT COUNT(*) AS count FROM events").get() as {
            readonly count: number;
          }
        ).count,
        completedOutboxCount: (
          database.prepare(
            "SELECT COUNT(*) AS count FROM outbox WHERE status = 'completed'",
          ).get() as { readonly count: number }
        ).count,
        receiptCount: (
          database.prepare(
            "SELECT COUNT(*) AS count FROM side_effect_receipts",
          ).get() as { readonly count: number }
        ).count,
        providerInvocationCount: runtime.executeCount,
        providerNativeEffectCount: runtime.nativeEffectCount,
      };
      await React.act(async () => root.unmount());
      if (
        results.some((result) => result !== "completed")
        || evidence.uiStepCount !== PHASE1_LOAD_DATASET.stepsPerRun
        || evidence.readonlyWaitingStepCount
          !== PHASE1_LOAD_DATASET.readonlyWaitingSteps
        || evidence.activeFakeStepCount !== PHASE1_LOAD_DATASET.activeFakeSteps
        || evidence.linkedActiveStepCount
          !== PHASE1_LOAD_DATASET.activeFakeSteps
        || evidence.ledgerEventCount
          !== PHASE1_LOAD_DATASET.runCount
            + PHASE1_LOAD_DATASET.activeFakeSteps * 2
        || evidence.completedOutboxCount
          !== PHASE1_LOAD_DATASET.activeFakeSteps
        || evidence.receiptCount !== PHASE1_LOAD_DATASET.activeFakeSteps
        || evidence.providerInvocationCount
          !== PHASE1_LOAD_DATASET.activeFakeSteps
        || evidence.providerNativeEffectCount
          !== PHASE1_LOAD_DATASET.activeFakeSteps
      ) {
        throw new Error("PHASE1_CONCURRENT_WORKLOAD_MISMATCH");
      }
      return { elapsedMs, evidence };
    });
  } finally {
    database.close();
  }
}

async function sample(
  measure: () => Promise<number>,
  warmups: number,
  measured: number,
): Promise<readonly number[]> {
  for (let index = 0; index < warmups; index += 1) await measure();
  const samples: number[] = [];
  for (let index = 0; index < measured; index += 1) {
    samples.push(await measure());
  }
  return samples;
}

async function sampleConcurrent(
  warmups: number,
  measured: number,
): Promise<{
  readonly samples: readonly number[];
  readonly evidence: ConcurrentWorkloadEvidence;
}> {
  let evidence: ConcurrentWorkloadEvidence | undefined;
  for (let index = 0; index < warmups; index += 1) {
    evidence = (await runPhase1ConcurrentWorkloadProbe()).evidence;
  }
  const samples: number[] = [];
  for (let index = 0; index < measured; index += 1) {
    const result = await runPhase1ConcurrentWorkloadProbe();
    samples.push(result.elapsedMs);
    evidence = result.evidence;
  }
  if (evidence === undefined) throw new Error("PHASE1_CONCURRENT_WORKLOAD_MISMATCH");
  return { samples, evidence };
}

function metric(samples: readonly number[], targetMs: number): Phase1Metric {
  const summary = summarizePhase1Samples(samples);
  return {
    ...summary,
    targetMs,
    status: summary.p95Ms < targetMs ? "PASS" : "FAIL",
  };
}

export async function runPhase1Benchmark(options: {
  readonly measuredAt?: string;
} = {}): Promise<Phase1BenchmarkReport> {
  const warmups = PHASE1_LOAD_DATASET.benchmarkWarmupSamples;
  const measured = PHASE1_LOAD_DATASET.benchmarkMeasuredSamples;
  const projectSamples = await sample(
    measureProjectListInteractive,
    warmups,
    measured,
  );
  const runSamples = await sample(
    measureRunPageInteractive,
    warmups,
    measured,
  );
  const eventSamples = await sample(
    measureEventToUiVisible,
    warmups,
    measured,
  );
  const concurrent = await sampleConcurrent(warmups, measured);
  const faultAttempts = await runPhase1FaultMatrix();
  const metrics = {
    projectListInteractive: metric(projectSamples, 1_000),
    runPageInteractive: metric(runSamples, 1_000),
    eventToUiVisible: metric(eventSamples, 500),
    concurrentWorkload: metric(concurrent.samples, 500),
  };
  const status =
    Object.values(metrics).every((entry) => entry.status === "PASS")
    && faultAttempts.every((attempt) => attempt.status === "PASS")
      ? "PASS"
      : "FAIL";
  return Phase1BenchmarkReportSchema.parse({
    schemaVersion: 1,
    proofScope: "contract_only",
    build: phase1BuildIdentity(),
    status,
    dataset: PHASE1_LOAD_DATASET,
    execution: {
      warmupSamples: warmups,
      measuredSamples: measured,
    },
    host: summarizePhase1Host(),
    measuredAt: options.measuredAt ?? new Date().toISOString(),
    metrics,
    concurrentWorkloadEvidence: concurrent.evidence,
    faultAttempts,
    notes: [
      "React component measurements use local JSDOM and deterministic Fake data.",
      "Fake Runtime proves Hunter contracts only; no real Provider is measured.",
      "Failures are retained as separate fault-history entries and are never rewritten.",
    ],
  });
}

function outputPath(args: readonly string[]): string {
  const index = args.indexOf("--output");
  if (index === -1) throw new Error("PHASE1_BENCHMARK_OUTPUT_REQUIRED");
  const path = args[index + 1];
  if (path === undefined || path.startsWith("--")) {
    throw new Error("PHASE1_BENCHMARK_OUTPUT_REQUIRED");
  }
  return path;
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined
  && pathToFileURL(resolve(entrypoint)).href === import.meta.url
) {
  const target = outputPath(process.argv.slice(2));
  preparePhase1EvidenceOutput(target);
  try {
    const report = await runPhase1Benchmark();
    writePhase1JsonAtomic(target, report);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.status !== "PASS") process.exitCode = 1;
  } catch (error) {
    const failure = Phase1FailureEnvelopeSchema.parse({
      schemaVersion: 1,
      proofScope: "contract_only",
      build: phase1BuildIdentity(),
      command: "benchmark",
      status: "FAIL",
      observedAt: new Date().toISOString(),
      errorCode: safePhase1ErrorCode(error),
    });
    writePhase1JsonAtomic(target, failure);
    process.stderr.write(`${failure.errorCode}\n`);
    process.exitCode = 1;
  }
}
