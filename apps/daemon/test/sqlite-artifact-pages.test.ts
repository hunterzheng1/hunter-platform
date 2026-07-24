import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  ArtifactIdSchema,
  AttemptIdSchema,
  ProjectIdSchema,
} from "@hunter/domain";
import { SqliteArtifactCatalog } from "@hunter/storage";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteArtifactPages } from "../src/services/sqlite-artifact-pages.js";

const roots: string[] = [];
const databases: DatabaseSync[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hunter artifact pages "));
  const database = new DatabaseSync(":memory:");
  roots.push(root);
  databases.push(database);
  const catalog = new SqliteArtifactCatalog(database, {
    contentRoot: root,
    quota: {
      softLimitBytes: 1_024,
      hardLimitBytes: 2_048,
      criticalReserveBytes: 256,
    },
    now: () => new Date("2026-07-24T12:00:00.000Z"),
  });
  const artifactId = ArtifactIdSchema.parse("art_sqlitepages01");
  const projectId = ProjectIdSchema.parse("prj_sqlitepages01");
  const attemptId = AttemptIdSchema.parse("att_sqlitepages01");
  catalog.register({
    artifactId,
    projectId,
    attemptId,
    kind: "log",
    retentionClass: "standard",
    summary: "sqlite page fixture",
  });
  catalog.append({ artifactId, stream: "stdout", content: "hello" });
  return {
    catalog,
    artifactId,
    projectId,
    pages: new SqliteArtifactPages(catalog),
  };
}

describe("SqliteArtifactPages", () => {
  it("maps durable catalog pages to the strict path-free HTTP contract", () => {
    const { artifactId, projectId, pages } = fixture();
    expect(pages.projectForArtifact(artifactId)).toEqual({
      artifactId,
      projectId,
    });
    const page = pages.readPage(artifactId, { cursor: 0, limit: 1 });
    expect(page).toMatchObject({
      schemaVersion: 1,
      status: "ok",
      artifact: {
        artifactId,
        projectId,
        summary: "sqlite page fixture",
        byteLength: 5,
        entryCount: 1,
      },
      responseBytes: 5,
      entries: [{ cursor: 1, content: "hello", byteLength: 5 }],
    });
    expect(JSON.stringify(page)).not.toMatch(
      /(?:relativePath|contentRef|contentRoot)/u,
    );
  });

  it("returns null for unknown artifacts and preserves a retention resync receipt", () => {
    const { catalog, artifactId, pages } = fixture();
    expect(pages.readPage(
      ArtifactIdSchema.parse("art_sqlitepages02"),
      { cursor: 0, limit: 1 },
    )).toBeNull();

    catalog.pruneBefore({ artifactId, cursor: 1 });
    expect(pages.readPage(artifactId, {
      cursor: 0,
      limit: 1,
    })).toEqual({
      schemaVersion: 1,
      status: "resync_required",
      artifactId,
      code: "ARTIFACT_CURSOR_RESYNC_REQUIRED",
      retentionFloor: 1,
      highWaterCursor: 1,
      instructions: {
        snapshot: "reload_artifact_summary",
        resume: "read_after_retention_floor",
      },
    });
  });
});
