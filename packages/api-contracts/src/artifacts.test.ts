import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ARTIFACT_HTTP_LIMITS,
  ArtifactBackpressureHttpReceiptSchema,
  ArtifactPageHttpQuerySchema,
  ArtifactPageHttpResponseSchema,
  ArtifactQuotaHttpReceiptSchema,
  ArtifactSummaryHttpSchema,
} from "./artifacts.js";

const artifactId = "art_httpresource01";
const projectId = "prj_httpresource01";
const attemptId = "att_httpresource01";
const hash = "a".repeat(64);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Artifact HTTP contracts", () => {
  it("coerces a bounded cursor query and rejects unknown or oversized input", () => {
    expect(ArtifactPageHttpQuerySchema.parse({
      cursor: "4",
      limit: "12",
    })).toEqual({ cursor: 4, limit: 12 });
    expect(ArtifactPageHttpQuerySchema.safeParse({
      cursor: "0",
      limit: String(ARTIFACT_HTTP_LIMITS.maxPageItems + 1),
    }).success).toBe(false);
    expect(ArtifactPageHttpQuerySchema.safeParse({
      cursor: "0",
      limit: "1",
      path: "C:\\private\\agent.log",
    }).success).toBe(false);
  });

  it("accepts only a bounded page whose content stays within the byte budget", () => {
    const page = ArtifactPageHttpResponseSchema.parse({
      schemaVersion: 1,
      status: "ok",
      artifact: {
        artifactId,
        projectId,
        attemptId,
        kind: "log",
        retentionClass: "standard",
        summary: "bounded agent output",
        byteLength: 12,
        entryCount: 2,
      },
      cursor: 0,
      nextCursor: 2,
      retentionFloor: 0,
      highWaterCursor: 2,
      complete: true,
      responseBytes: 12,
      entries: [
        {
          cursor: 1,
          stream: "stdout",
          content: "hello",
          contentHash: hash,
          byteLength: 5,
          occurredAt: "2026-07-24T12:00:00.000Z",
        },
        {
          cursor: 2,
          stream: "stderr",
          content: "世界!",
          contentHash: "b".repeat(64),
          byteLength: 7,
          occurredAt: "2026-07-24T12:00:01.000Z",
        },
      ],
    });
    expect(page.status).toBe("ok");
    if (page.status !== "ok") throw new Error("ARTIFACT_PAGE_FIXTURE_INVALID");
    expect(JSON.stringify(page)).not.toMatch(
      /(?:relativePath|contentRef|C:\\\\private)/u,
    );

    expect(ArtifactPageHttpResponseSchema.safeParse({
      ...page,
      responseBytes: ARTIFACT_HTTP_LIMITS.maxPageBytes + 1,
    }).success).toBe(false);
    expect(ArtifactPageHttpResponseSchema.safeParse({
      ...page,
      entries: [{
        ...page.entries[0],
        content: "界".repeat(
          Math.floor(ARTIFACT_HTTP_LIMITS.maxChunkBytes / 3) + 1,
        ),
        byteLength:
          (Math.floor(ARTIFACT_HTTP_LIMITS.maxChunkBytes / 3) + 1) * 3,
      }],
    }).success).toBe(false);
  });

  it("validates UTF-8 byte counts in browser runtimes without Node Buffer", () => {
    vi.stubGlobal("Buffer", undefined);
    expect(ArtifactPageHttpResponseSchema.safeParse({
      schemaVersion: 1,
      status: "ok",
      artifact: {
        artifactId,
        projectId,
        attemptId,
        kind: "log",
        retentionClass: "standard",
        summary: "browser page",
        byteLength: 7,
        entryCount: 1,
      },
      cursor: 0,
      nextCursor: 1,
      retentionFloor: 0,
      highWaterCursor: 1,
      complete: true,
      responseBytes: 7,
      entries: [{
        cursor: 1,
        stream: "stdout",
        content: "世界!",
        contentHash: hash,
        byteLength: 7,
        occurredAt: "2026-07-24T12:00:00.000Z",
      }],
    }).success).toBe(true);
  });

  it("uses an explicit resync response below the retention floor", () => {
    expect(ArtifactPageHttpResponseSchema.parse({
      schemaVersion: 1,
      status: "resync_required",
      artifactId,
      code: "ARTIFACT_CURSOR_RESYNC_REQUIRED",
      retentionFloor: 5,
      highWaterCursor: 8,
      instructions: {
        snapshot: "reload_artifact_summary",
        resume: "read_after_retention_floor",
      },
    })).toEqual({
      schemaVersion: 1,
      status: "resync_required",
      artifactId,
      code: "ARTIFACT_CURSOR_RESYNC_REQUIRED",
      retentionFloor: 5,
      highWaterCursor: 8,
      instructions: {
        snapshot: "reload_artifact_summary",
        resume: "read_after_retention_floor",
      },
    });
  });

  it("freezes non-sensitive summary, quota, and backpressure receipts", () => {
    expect(ArtifactSummaryHttpSchema.safeParse({
      artifactId,
      projectId,
      attemptId,
      kind: "log",
      retentionClass: "standard",
      summary: "agent output",
      byteLength: 9,
      entryCount: 1,
      absolutePath: "C:\\Users\\private\\agent.log",
    }).success).toBe(false);

    expect(ArtifactQuotaHttpReceiptSchema.parse({
      schemaVersion: 1,
      level: "hard_limit",
      usedBytes: 10,
      projectedBytes: 17,
      softLimitBytes: 10,
      hardLimitBytes: 16,
      criticalReserveBytes: 8,
      usedCriticalReserveBytes: 1,
      nonCriticalWrites: "rejected",
      coreReceipts: "reserved",
    })).toMatchObject({
      level: "hard_limit",
      usedBytes: 10,
      projectedBytes: 17,
      nonCriticalWrites: "rejected",
      coreReceipts: "reserved",
    });

    expect(ArtifactBackpressureHttpReceiptSchema.parse({
      schemaVersion: 1,
      code: "ARTIFACT_CLIENT_BACKPRESSURE",
      artifactId,
      action: "disconnect_and_replay",
      resumeAfterCursor: 0,
      highWaterCursor: 2,
      droppedNotifications: 1,
    })).toMatchObject({
      code: "ARTIFACT_CLIENT_BACKPRESSURE",
      action: "disconnect_and_replay",
    });
  });
});
