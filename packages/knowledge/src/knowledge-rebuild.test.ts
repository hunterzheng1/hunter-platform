import { DatabaseSync } from "node:sqlite";

import {
  KnowledgeEntryIdSchema,
  ProjectIdSchema,
  RequirementRevisionIdSchema,
  RunIdSchema,
} from "@hunter/domain";
import { SqliteOperationJournal } from "@hunter/storage";
import { describe, expect, it } from "vitest";

import {
  KnowledgeEntrySchema,
  KnowledgeResolver,
  SqliteArchiveJobStore,
  SqliteKnowledgeCatalog,
  rebuildKnowledge,
} from "./index.js";

const projectA = ProjectIdSchema.parse("prj_rebuild_a");
const projectB = ProjectIdSchema.parse("prj_rebuild_b");

function seedCompletedArchive(
  database: DatabaseSync,
  projectId: typeof projectA,
  runId: ReturnType<typeof RunIdSchema.parse>,
  hash: string,
): void {
  const store = new SqliteArchiveJobStore(database);
  const scheduled = store.schedule({
    projectId,
    runId,
    outcome: "failed",
    firstPosition: 1,
    lastPosition: 9,
    actorId: "rebuild-test",
    correlationId: `rebuild:${runId}`,
    occurredAt: "2026-07-24T00:00:00.000Z",
  });
  database.prepare(
    `UPDATE archive_jobs
        SET status = 'completed',
            manifest_hash = ?,
            manifest_ref = ?,
            archive_receipt_json = ?,
            updated_at = ?
      WHERE job_id = ?`,
  ).run(
    hash,
    `cas:sha256:${hash}`,
    JSON.stringify({
      receiptSchemaVersion: 1,
      projectId,
      runId,
      outcome: "failed",
      manifestSchemaVersion: 1,
      manifestHash: hash,
      manifestRef: `cas:sha256:${hash}`,
      verifiedAt: "2026-07-24T00:01:00.000Z",
    }),
    "2026-07-24T00:01:00.000Z",
    scheduled.jobId,
  );
}

function seedRequirement(
  database: DatabaseSync,
  projectId: typeof projectA,
  suffix: string,
  status: "draft" | "in_review" | "active" | "superseded" | "withdrawn",
): void {
  const requirementRevisionId = RequirementRevisionIdSchema.parse(
    `rrv_rebuild_${suffix}`,
  );
  database.prepare(
    `INSERT INTO entity_views(
       projector_name, entity_type, entity_id, project_id,
       entity_version, view_json, updated_at
     ) VALUES ('hunter', 'RequirementRevision', ?, ?, 1, ?, ?)`,
  ).run(
    requirementRevisionId,
    projectId,
    JSON.stringify({
      requirementRevisionId,
      status,
      title: `Requirement ${suffix}`,
      body: `Authoritative requirement ${suffix}.`,
    }),
    "2026-07-24T00:00:00.000Z",
  );
}

describe("rebuildKnowledge", () => {
  it("skips legitimate draft and in-review revisions while rebuilding approved authoritative knowledge", async () => {
    const database = new DatabaseSync(":memory:");
    new SqliteOperationJournal(database);
    seedRequirement(database, projectA, "draft_a", "draft");
    seedRequirement(database, projectA, "review_a", "in_review");
    seedRequirement(database, projectA, "active_a", "active");

    const rebuilt = await rebuildKnowledge({
      database,
      projectId: projectA,
      now: () => new Date("2026-07-24T00:02:00.000Z"),
    });
    const entries = await new SqliteKnowledgeCatalog(database)
      .listByProject(projectA);

    expect(rebuilt.authoritativeCount).toBe(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toMatchObject({
      type: "requirement_revision",
      requirementRevisionId: "rrv_rebuild_active_a",
    });
    database.close();
  });

  it("rebuilds only one Project from verified Archives and authoritative revisions with byte-stable ordering", async () => {
    const database = new DatabaseSync(":memory:");
    new SqliteOperationJournal(database);
    seedCompletedArchive(
      database,
      projectA,
      RunIdSchema.parse("run_rebuild_a"),
      "a".repeat(64),
    );
    seedCompletedArchive(
      database,
      projectB,
      RunIdSchema.parse("run_rebuild_b"),
      "b".repeat(64),
    );
    seedRequirement(database, projectA, "active_a", "active");
    seedRequirement(database, projectA, "old_a", "superseded");
    seedRequirement(database, projectA, "withdrawn_a", "withdrawn");
    seedRequirement(database, projectB, "active_b", "active");
    const catalog = new SqliteKnowledgeCatalog(database);
    const experiential = KnowledgeEntrySchema.parse({
      schemaVersion: 1,
      entryId: KnowledgeEntryIdSchema.parse("kne_rebuild_experience"),
      level: "experiential",
      status: "active",
      confidence: { level: "high", rationale: "Verified independently." },
      invalidationConditions: [{ condition: "Evidence is withdrawn." }],
      source: {
        type: "evidence",
        projectId: projectA,
        evidenceId: "evd_rebuild_experience",
        contentHash: "c".repeat(64),
      },
      scope: { projectId: projectA },
      summary: "Retained experience.",
      body: "This non-rebuildable promoted entry must survive index rebuild.",
    });
    catalog.insertPromoted(experiential);

    const first = await rebuildKnowledge({
      database,
      projectId: projectA,
      now: () => new Date("2026-07-24T00:02:00.000Z"),
    });
    const firstBytes = JSON.stringify(
      await catalog.listByProject(projectA),
    );
    const second = await rebuildKnowledge({
      database,
      projectId: projectA,
      now: () => new Date("2026-07-24T00:03:00.000Z"),
    });
    const secondBytes = JSON.stringify(
      await catalog.listByProject(projectA),
    );

    expect(second.digest).toBe(first.digest);
    expect(secondBytes).toBe(firstBytes);
    expect(second).toMatchObject({
      archiveCount: 1,
      authoritativeCount: 3,
    });
    expect(await catalog.listByProject(projectB)).toEqual([]);
    expect(firstBytes).toContain("kne_rebuild_experience");
    expect(firstBytes).toContain("superseded");
    expect(firstBytes).toContain("withdrawn");

    const resolved = await new KnowledgeResolver(catalog).resolve({
      projectId: projectA,
      includeHistorical: true,
    });
    expect(resolved.every(({ status }) => status === "active")).toBe(true);
    expect(resolved.some(({ level }) => level === "historical")).toBe(true);
    expect(resolved.some(({ level }) => level === "authoritative")).toBe(true);
    database.close();
  });

  it("fails closed for an unknown or tampered Archive receipt without deleting the existing Project index", async () => {
    const database = new DatabaseSync(":memory:");
    new SqliteOperationJournal(database);
    seedCompletedArchive(
      database,
      projectA,
      RunIdSchema.parse("run_rebuild_tamper"),
      "d".repeat(64),
    );
    seedRequirement(database, projectA, "active_safe", "active");
    const catalog = new SqliteKnowledgeCatalog(database);
    await rebuildKnowledge({ database, projectId: projectA });
    const before = JSON.stringify(await catalog.listByProject(projectA));
    const row = database.prepare(
      "SELECT job_id, archive_receipt_json FROM archive_jobs WHERE project_id = ?",
    ).get(projectA) as {
      job_id: string;
      archive_receipt_json: string;
    };
    const receipt = JSON.parse(row.archive_receipt_json) as Record<string, unknown>;
    database.prepare(
      "UPDATE archive_jobs SET archive_receipt_json = ? WHERE job_id = ?",
    ).run(JSON.stringify({
      ...receipt,
      manifestSchemaVersion: 99,
    }), row.job_id);

    await expect(
      rebuildKnowledge({ database, projectId: projectA }),
    ).rejects.toThrow();
    expect(JSON.stringify(await catalog.listByProject(projectA))).toBe(before);
    database.close();
  });

  it.each(["", "*", "prj_other"])(
    "rejects invalid Project scope %j before touching indexes",
    async (projectId) => {
      const database = new DatabaseSync(":memory:");
      new SqliteOperationJournal(database);
      await expect(
        rebuildKnowledge({ database, projectId }),
      ).rejects.toThrow();
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM knowledge_entries",
      ).get()).toEqual({ count: 0 });
      database.close();
    },
  );
});
