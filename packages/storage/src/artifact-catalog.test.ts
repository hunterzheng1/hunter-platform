import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  ArtifactIdSchema,
  AttemptIdSchema,
  ProjectIdSchema,
} from "@hunter/domain";
import { afterEach, describe, expect, it } from "vitest";

import {
  ARTIFACT_RESOURCE_LIMITS,
  SqliteArtifactCatalog,
} from "./artifact-catalog.js";

const projectId = ProjectIdSchema.parse("prj_resource01");
const attemptId = AttemptIdSchema.parse("att_resource01");

const roots: string[] = [];
const databases: DatabaseSync[] = [];

function createCatalog(
  quota: {
    readonly softLimitBytes: number;
    readonly hardLimitBytes: number;
    readonly criticalReserveBytes: number;
  } = {
    softLimitBytes: 1_024,
    hardLimitBytes: 2_048,
    criticalReserveBytes: 512,
  },
) {
  const contentRoot = mkdtempSync(
    join(tmpdir(), "hunter artifact 资源 "),
  );
  const database = new DatabaseSync(":memory:");
  roots.push(contentRoot);
  databases.push(database);
  const catalog = new SqliteArtifactCatalog(database, {
    contentRoot,
    quota,
    now: () => new Date("2026-07-24T12:00:00.000Z"),
  });
  return { catalog, contentRoot };
}

function registerLog(
  catalog: SqliteArtifactCatalog,
  suffix: string,
  retentionClass:
    | "ephemeral"
    | "standard"
    | "evidence"
    | "archive"
    | "core_receipt" = "standard",
) {
  const artifactId = ArtifactIdSchema.parse(`art_resource${suffix}`);
  catalog.register({
    artifactId,
    projectId,
    attemptId,
    kind: retentionClass === "core_receipt" ? "receipt" : "log",
    retentionClass,
    summary: `resource fixture ${suffix}`,
  });
  return artifactId;
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("SqliteArtifactCatalog", () => {
  it("persists bounded log chunks and reads only a bounded cursor page", () => {
    const { catalog, contentRoot } = createCatalog();
    const artifactId = registerLog(catalog, "page01");

    for (let index = 1; index <= 5; index += 1) {
      catalog.append({
        artifactId,
        stream: "stdout",
        content: `line-${index}`,
      });
    }

    const first = catalog.readPage({ artifactId, cursor: 0, limit: 2 });
    expect(first).toMatchObject({
      status: "ok",
      cursor: 0,
      nextCursor: 2,
      retentionFloor: 0,
      highWaterCursor: 5,
      complete: false,
    });
    if (first.status !== "ok") throw new Error("expected an artifact page");
    expect(first.entries.map(({ content }) => content)).toEqual([
      "line-1",
      "line-2",
    ]);
    expect(first.entries).toHaveLength(2);
    expect(first.responseBytes).toBeLessThanOrEqual(
      ARTIFACT_RESOURCE_LIMITS.maxPageBytes,
    );
    expect(() =>
      catalog.readPage({
        artifactId,
        cursor: 0,
        limit: ARTIFACT_RESOURCE_LIMITS.maxPageItems + 1,
      })
    ).toThrow("ARTIFACT_PAGE_LIMIT_INVALID");
    expect(() =>
      catalog.readPage({
        artifactId,
        cursor: 6,
        limit: 1,
      })
    ).toThrow("ARTIFACT_CURSOR_AHEAD_OF_HIGH_WATER");

    const stored = catalog.inspectEntry(artifactId, 1);
    expect(stored?.contentRef).toMatch(/^cas:sha256:[a-f0-9]{64}$/u);
    expect(stored?.relativePath).toMatch(
      /^sha256\/[a-f0-9]{2}\/[a-f0-9]{64}$/u,
    );
    expect(stored?.relativePath).not.toContain("\\");
    expect(readFileSync(join(contentRoot, stored?.relativePath ?? ""), "utf8"))
      .toBe("line-1");
    expect(catalog.listForAttempt(attemptId).map(
      ({ artifactId: listedArtifactId }) => listedArtifactId,
    )).toEqual([artifactId]);
    expect(catalog.contentEdges(artifactId)).toHaveLength(5);
    expect(catalog.contentEdges(artifactId)[0]).toMatchObject({
      contentRef: stored?.contentRef,
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(catalog.contentEdges(artifactId))).not.toMatch(
      /(?:relativePath|contentRoot)/u,
    );
  });

  it("returns an explicit resync receipt when a cursor is below the retention floor", () => {
    const { catalog } = createCatalog();
    const artifactId = registerLog(catalog, "floor01", "ephemeral");
    for (let index = 1; index <= 4; index += 1) {
      catalog.append({
        artifactId,
        stream: "system",
        content: `retained-${index}`,
      });
    }

    const retention = catalog.pruneBefore({
      artifactId,
      cursor: 2,
    });
    expect(retention).toMatchObject({
      artifactId,
      retentionFloor: 2,
      deletedEntries: 2,
    });
    expect(catalog.readPage({ artifactId, cursor: 1, limit: 2 })).toEqual({
      status: "resync_required",
      artifactId,
      code: "ARTIFACT_CURSOR_RESYNC_REQUIRED",
      retentionFloor: 2,
      highWaterCursor: 4,
      instructions: {
        snapshot: "reload_artifact_summary",
        resume: "read_after_retention_floor",
      },
    });
    const resumed = catalog.readPage({
      artifactId,
      cursor: 2,
      limit: 2,
    });
    expect(resumed.status).toBe("ok");
  });

  it("warns at the soft limit, rejects non-critical bytes at hard limit, and keeps a bounded receipt reserve", () => {
    const { catalog } = createCatalog({
      softLimitBytes: 10,
      hardLimitBytes: 16,
      criticalReserveBytes: 8,
    });
    const logId = registerLog(catalog, "quota01", "ephemeral");
    const receiptId = registerLog(catalog, "quota02", "core_receipt");

    expect(catalog.append({
      artifactId: logId,
      stream: "stdout",
      content: "1234567890",
    })).toMatchObject({
      status: "accepted",
      quota: { level: "soft_limit", usedBytes: 10 },
    });
    expect(catalog.append({
      artifactId: logId,
      stream: "stdout",
      content: "123456",
    })).toMatchObject({
      status: "rejected",
      code: "ARTIFACT_QUOTA_HARD_LIMIT",
      quota: {
        level: "hard_limit",
        usedBytes: 10,
        projectedBytes: 16,
      },
      coreReceiptPreserved: true,
    });
    expect(catalog.append({
      artifactId: receiptId,
      stream: "system",
      content: "receipt",
    })).toMatchObject({
      status: "accepted",
      quota: { level: "hard_limit", usedBytes: 17 },
      usedCriticalReserveBytes: 1,
    });
    expect(catalog.readPage({
      artifactId: receiptId,
      cursor: 0,
      limit: 1,
    })).toMatchObject({
      status: "ok",
      entries: [{ content: "receipt" }],
    });
  });

  it("never evicts artifacts referenced by current Evidence or Archive records", () => {
    const { catalog } = createCatalog();
    const disposable = registerLog(catalog, "evict01", "ephemeral");
    const evidence = registerLog(catalog, "evict02", "evidence");
    const archive = registerLog(catalog, "evict03", "archive");
    for (const artifactId of [disposable, evidence, archive]) {
      catalog.append({
        artifactId,
        stream: "system",
        content: `${artifactId}:content`,
      });
    }
    catalog.protect({
      artifactId: evidence,
      reference: { kind: "evidence", referenceId: "evd_resource01" },
    });
    catalog.protect({
      artifactId: archive,
      reference: { kind: "archive", referenceId: "arc_resource01" },
    });

    const receipt = catalog.enforceRetention({ targetBytes: 0 });
    expect(receipt.deletedArtifactIds).toEqual([disposable]);
    expect(receipt.protectedArtifactIds).toEqual([archive, evidence].sort());
    expect(catalog.find(disposable)).toBeNull();
    expect(catalog.find(evidence)).not.toBeNull();
    expect(catalog.find(archive)).not.toBeNull();
  });

  it("disconnects a slow cursor feed without blocking the durable writer and resumes from the catalog", () => {
    const { catalog } = createCatalog();
    const artifactId = registerLog(catalog, "slow01");
    const feed = catalog.openCursorFeed({
      artifactId,
      afterCursor: 0,
      capacity: 1,
    });

    const first = catalog.append({
      artifactId,
      stream: "stdout",
      content: "first",
    });
    const second = catalog.append({
      artifactId,
      stream: "stdout",
      content: "second",
    });
    const third = catalog.append({
      artifactId,
      stream: "stdout",
      content: "third",
    });

    expect([first.status, second.status, third.status]).toEqual([
      "accepted",
      "accepted",
      "accepted",
    ]);
    expect(feed.backpressureReceipt()).toEqual({
      schemaVersion: 1,
      code: "ARTIFACT_CLIENT_BACKPRESSURE",
      artifactId,
      action: "disconnect_and_replay",
      resumeAfterCursor: 0,
      highWaterCursor: 2,
      droppedNotifications: 1,
    });
    expect(feed.closed).toBe(true);
    expect(catalog.readPage({
      artifactId,
      cursor: 0,
      limit: 3,
    })).toMatchObject({
      status: "ok",
      highWaterCursor: 3,
      entries: [
        { cursor: 1, content: "first" },
        { cursor: 2, content: "second" },
        { cursor: 3, content: "third" },
      ],
    });

    const explicitlyClosed = catalog.openCursorFeed({
      artifactId,
      afterCursor: 3,
      capacity: 1,
    });
    explicitlyClosed.close();
    catalog.append({
      artifactId,
      stream: "stdout",
      content: "after-close",
    });
    expect(explicitlyClosed.closed).toBe(true);
    expect(explicitlyClosed.drain()).toEqual([]);
  });

  it("rejects oversized chunks and summaries before touching durable storage", () => {
    const { catalog } = createCatalog();
    const artifactId = ArtifactIdSchema.parse("art_resourcelimit01");
    expect(() =>
      catalog.register({
        artifactId,
        projectId,
        attemptId,
        kind: "log",
        retentionClass: "standard",
        summary: "x".repeat(
          ARTIFACT_RESOURCE_LIMITS.maxSummaryCharacters + 1,
        ),
      })
    ).toThrow("ARTIFACT_SUMMARY_TOO_LARGE");

    const valid = registerLog(catalog, "limit02");
    expect(() =>
      catalog.append({
        artifactId: valid,
        stream: "stderr",
        content: "x".repeat(ARTIFACT_RESOURCE_LIMITS.maxChunkBytes + 1),
      })
    ).toThrow("ARTIFACT_CHUNK_TOO_LARGE");
    expect(catalog.find(valid)?.byteLength).toBe(0);
  });
});
