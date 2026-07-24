import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  ARTIFACT_HTTP_LIMITS,
  RunStepHttpViewSchema,
} from "@hunter/api-contracts";
import {
  ArtifactIdSchema,
  OperationIdSchema,
  RuntimeProviderIdSchema,
} from "@hunter/domain";
import {
  createExternalOperation,
  runtimeFactCanCompleteStep,
} from "@hunter/runtime-contracts";
import {
  ARTIFACT_RESOURCE_LIMITS,
  SqliteArtifactCatalog,
} from "@hunter/storage";
import { FakeRuntime } from "@hunter/testkit";

const sharedLimits = {
  defaultPageItems: ARTIFACT_RESOURCE_LIMITS.defaultPageItems,
  maxPageItems: ARTIFACT_RESOURCE_LIMITS.maxPageItems,
  maxChunkBytes: ARTIFACT_RESOURCE_LIMITS.maxChunkBytes,
  maxPageBytes: ARTIFACT_RESOURCE_LIMITS.maxPageBytes,
  maxSummaryCharacters: ARTIFACT_RESOURCE_LIMITS.maxSummaryCharacters,
};

export interface ResourceBoundsVerification {
  readonly schemaVersion: 1;
  readonly status: "PASS" | "FAIL";
  readonly proofScope: "contract_only";
  readonly scenario: {
    readonly readonlyWaitingSteps: 10;
    readonly activeFakeSteps: 4;
    readonly largeLogEntries: 42;
  };
  readonly limits: {
    readonly storage: typeof sharedLimits;
    readonly http: typeof sharedLimits;
    readonly feedCapacity: number;
    readonly quota: {
      readonly softLimitBytes: number;
      readonly hardLimitBytes: number;
      readonly criticalReserveBytes: number;
    };
  };
  readonly measurements: {
    readonly pagesRead: number;
    readonly maxObservedPageItems: number;
    readonly maxObservedPageBytes: number;
    readonly durableHighWaterCursor: number;
    readonly backpressureHighWaterCursor: number;
  };
  readonly checks: {
    readonly boundedPages: boolean;
    readonly retentionResync: boolean;
    readonly softQuotaWarning: boolean;
    readonly hardQuotaRejection: boolean;
    readonly coreReceiptReserve: boolean;
    readonly protectedRetention: boolean;
    readonly slowClientDisconnected: boolean;
    readonly durableReplay: boolean;
    readonly fakeRuntimeReceipts: boolean;
  };
}

function fixedSizeLogEntry(index: number): string {
  const prefix = `entry-${index.toString().padStart(3, "0")}:`;
  return prefix.padEnd(4_096, String(index % 10));
}

export async function verifyResourceBounds(): Promise<ResourceBoundsVerification> {
  const root = mkdtempSync(join(tmpdir(), "hunter-resource-bounds-"));
  const mainDatabase = new DatabaseSync(join(root, "resource.sqlite"));
  const quotaDatabase = new DatabaseSync(join(root, "quota.sqlite"));
  try {
    const mainCatalog = new SqliteArtifactCatalog(mainDatabase, {
      contentRoot: join(root, "content"),
      quota: {
        softLimitBytes: 1_048_576,
        hardLimitBytes: 2_097_152,
        criticalReserveBytes: 65_536,
      },
      now: () => new Date("2026-07-24T12:00:00.000Z"),
    });
    const largeLogId = ArtifactIdSchema.parse("art_resource_large_log");
    mainCatalog.register({
      artifactId: largeLogId,
      projectId: "prj_resource_bounds",
      attemptId: "att_resource_bounds",
      kind: "log",
      retentionClass: "standard",
      summary: "bounded large-log verification fixture",
    });
    for (let index = 1; index <= 40; index += 1) {
      const receipt = mainCatalog.append({
        artifactId: largeLogId,
        stream: "stdout",
        content: fixedSizeLogEntry(index),
      });
      if (receipt.status !== "accepted") {
        throw new Error("RESOURCE_BOUNDS_LARGE_LOG_REJECTED");
      }
    }

    let cursor = 0;
    let pagesRead = 0;
    let maxObservedPageItems = 0;
    let maxObservedPageBytes = 0;
    while (true) {
      const page = mainCatalog.readPage({
        artifactId: largeLogId,
        cursor,
        limit: ARTIFACT_RESOURCE_LIMITS.maxPageItems,
      });
      if (page.status !== "ok") {
        throw new Error("RESOURCE_BOUNDS_UNEXPECTED_RESYNC");
      }
      pagesRead += 1;
      maxObservedPageItems = Math.max(
        maxObservedPageItems,
        page.entries.length,
      );
      maxObservedPageBytes = Math.max(
        maxObservedPageBytes,
        page.responseBytes,
      );
      cursor = page.nextCursor;
      if (page.complete) break;
      if (pagesRead > 10) throw new Error("RESOURCE_BOUNDS_PAGE_LOOP");
    }

    const slowFeed = mainCatalog.openCursorFeed({
      artifactId: largeLogId,
      afterCursor: cursor,
      capacity: 1,
    });
    for (let index = 41; index <= 42; index += 1) {
      const receipt = mainCatalog.append({
        artifactId: largeLogId,
        stream: "stdout",
        content: fixedSizeLogEntry(index),
      });
      if (receipt.status !== "accepted") {
        throw new Error("RESOURCE_BOUNDS_WRITER_BLOCKED");
      }
    }
    const backpressure = slowFeed.backpressureReceipt();
    const replay = backpressure === null
      ? null
      : mainCatalog.readPage({
          artifactId: largeLogId,
          cursor: backpressure.resumeAfterCursor,
          limit: ARTIFACT_RESOURCE_LIMITS.maxPageItems,
        });

    mainCatalog.pruneBefore({
      artifactId: largeLogId,
      cursor: 3,
    });
    const retentionGap = mainCatalog.readPage({
      artifactId: largeLogId,
      cursor: 0,
    });

    const protectedArtifactId = ArtifactIdSchema.parse(
      "art_resource_protected",
    );
    mainCatalog.register({
      artifactId: protectedArtifactId,
      projectId: "prj_resource_bounds",
      attemptId: "att_resource_bounds",
      kind: "report",
      retentionClass: "standard",
      summary: "protected evidence reference",
    });
    mainCatalog.append({
      artifactId: protectedArtifactId,
      stream: "system",
      content: "protected",
    });
    mainCatalog.protect({
      artifactId: protectedArtifactId,
      reference: {
        kind: "evidence",
        referenceId: "evd_resource_protected",
      },
    });
    let protectedRetention = false;
    try {
      mainCatalog.pruneBefore({
        artifactId: protectedArtifactId,
        cursor: 1,
      });
    } catch (error) {
      protectedRetention = error instanceof Error
        && error.message === "ARTIFACT_RETENTION_PROTECTED";
    }

    const quota = {
      softLimitBytes: 10,
      hardLimitBytes: 16,
      criticalReserveBytes: 8,
    };
    const quotaCatalog = new SqliteArtifactCatalog(quotaDatabase, {
      contentRoot: join(root, "quota-content"),
      quota,
      now: () => new Date("2026-07-24T12:00:00.000Z"),
    });
    const quotaLogId = ArtifactIdSchema.parse("art_resource_quota_log");
    quotaCatalog.register({
      artifactId: quotaLogId,
      projectId: "prj_resource_bounds",
      kind: "log",
      retentionClass: "standard",
      summary: "quota fixture",
    });
    const softReceipt = quotaCatalog.append({
      artifactId: quotaLogId,
      stream: "stdout",
      content: "1234567890",
    });
    const hardReceipt = quotaCatalog.append({
      artifactId: quotaLogId,
      stream: "stdout",
      content: "1234567",
    });
    const coreReceiptId = ArtifactIdSchema.parse("art_resource_core_receipt");
    quotaCatalog.register({
      artifactId: coreReceiptId,
      projectId: "prj_resource_bounds",
      kind: "receipt",
      retentionClass: "core_receipt",
      summary: "core receipt reserve fixture",
    });
    const coreReceipt = quotaCatalog.append({
      artifactId: coreReceiptId,
      stream: "system",
      content: "receipt",
    });

    const waitingSteps = Array.from({ length: 10 }, (_, index) => {
      const suffix = (index + 1).toString().padStart(2, "0");
      return RunStepHttpViewSchema.parse({
        stepRunId: `spr_resource_wait_${suffix}`,
        title: `read-only fixture ${suffix}`,
        conclusion: "succeeded",
        attempts: [{
          attemptId: `att_resource_wait_${suffix}`,
          attemptNumber: 1,
          isCurrent: false,
          executionStatus: "returned",
          verificationStatus: "passed",
          artifactIds: [],
          evidenceIds: [],
        }],
      });
    });
    const fakeReceipts = await Promise.all(
      Array.from({ length: 4 }, async (_, index) => {
        const suffix = (index + 1).toString().padStart(2, "0");
        const fake = new FakeRuntime({
          providerId: RuntimeProviderIdSchema.parse("rtp_resource_fake"),
          implementationVersion: "phase1-resource-contract",
          observedAt: "2026-07-24T12:00:00.000Z",
        });
        return fake.execute(createExternalOperation({
          schemaVersion: 1,
          operationId: OperationIdSchema.parse(`opn_resource_fake_${suffix}`),
          projectId: "prj_resource_bounds",
          runId: "run_resource_bounds",
          attemptId: `att_resource_fake_${suffix}`,
          operationVersion: 2,
          operationType: "session.observe",
          requestedCapabilities: ["observe"],
          payload: {
            nativeSessionId: `ses_resource_fake_${suffix}`,
            controllerLeaseId: `ctl_resource_fake_${suffix}`,
            controllerLeaseOwnerId: `own_resource_fake_${suffix}`,
            controllerLeaseGeneration: 1,
          },
        }));
      }),
    );
    const activeFakeSteps = fakeReceipts.map((receipt, index) => {
      const suffix = (index + 1).toString().padStart(2, "0");
      return RunStepHttpViewSchema.parse({
        stepRunId: `spr_resource_fake_${suffix}`,
        title: `active Fake fixture ${suffix}`,
        conclusion: "active",
        attempts: [{
          attemptId: `att_resource_fake_${suffix}`,
          attemptNumber: 1,
          isCurrent: true,
          executionStatus: "running",
          verificationStatus: "pending",
          artifactIds: [largeLogId],
          evidenceIds: [receipt.evidence.evidenceId],
        }],
      });
    });

    const durableHighWaterCursor =
      mainCatalog.find(largeLogId)?.entryCount ?? 0;
    const checks = {
      boundedPages:
        pagesRead > 1
        && maxObservedPageItems <= ARTIFACT_RESOURCE_LIMITS.maxPageItems
        && maxObservedPageBytes <= ARTIFACT_RESOURCE_LIMITS.maxPageBytes,
      retentionResync:
        retentionGap.status === "resync_required"
        && retentionGap.retentionFloor === 3,
      softQuotaWarning:
        softReceipt.status === "accepted"
        && softReceipt.quota.level === "soft_limit",
      hardQuotaRejection:
        hardReceipt.status === "rejected"
        && hardReceipt.code === "ARTIFACT_QUOTA_HARD_LIMIT",
      coreReceiptReserve:
        coreReceipt.status === "accepted"
        && coreReceipt.quota.level === "hard_limit"
        && coreReceipt.usedCriticalReserveBytes === 1,
      protectedRetention,
      slowClientDisconnected:
        backpressure?.code === "ARTIFACT_CLIENT_BACKPRESSURE"
        && backpressure.action === "disconnect_and_replay",
      durableReplay:
        replay?.status === "ok"
        && replay.entries.length === 2
        && replay.highWaterCursor === 42,
      fakeRuntimeReceipts:
        waitingSteps.length === 10
        && waitingSteps.every((step) =>
          step.conclusion === "succeeded"
          && step.attempts[0]?.executionStatus === "returned"
        )
        && fakeReceipts.length === 4
        && activeFakeSteps.length === 4
        && activeFakeSteps.every((step) =>
          step.conclusion === "active"
          && step.attempts[0]?.executionStatus === "running"
        )
        && fakeReceipts.every((receipt) =>
          receipt.evidence.proofScope === "contract_only"
          && receipt.facts.every((fact) =>
            runtimeFactCanCompleteStep(fact) === false
          )
        ),
    };
    const status = Object.values(checks).every(Boolean) ? "PASS" : "FAIL";

    return {
      schemaVersion: 1,
      status,
      proofScope: "contract_only",
      scenario: {
        readonlyWaitingSteps: 10,
        activeFakeSteps: 4,
        largeLogEntries: 42,
      },
      limits: {
        storage: sharedLimits,
        http: {
          defaultPageItems: ARTIFACT_HTTP_LIMITS.defaultPageItems,
          maxPageItems: ARTIFACT_HTTP_LIMITS.maxPageItems,
          maxChunkBytes: ARTIFACT_HTTP_LIMITS.maxChunkBytes,
          maxPageBytes: ARTIFACT_HTTP_LIMITS.maxPageBytes,
          maxSummaryCharacters: ARTIFACT_HTTP_LIMITS.maxSummaryCharacters,
        },
        feedCapacity: ARTIFACT_RESOURCE_LIMITS.maxFeedCapacity,
        quota,
      },
      measurements: {
        pagesRead,
        maxObservedPageItems,
        maxObservedPageBytes,
        durableHighWaterCursor,
        backpressureHighWaterCursor: backpressure?.highWaterCursor ?? 0,
      },
      checks,
    };
  } finally {
    mainDatabase.close();
    quotaDatabase.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined
  && pathToFileURL(resolve(entrypoint)).href === import.meta.url
) {
  const result = await verifyResourceBounds();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "PASS") process.exitCode = 1;
}
