import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";

import {
  PgProjectKnowledgeSource,
  PgProjectKnowledgeRetryAuthority,
  ProjectKnowledgeCursorAuthority,
  type ProjectKnowledgeCurrentFence
} from "../src/project-knowledge-query/pg-source.js";

const scope = {
  actor_id: "actor_knowledge",
  project_id: "prj_knowledge",
  view: "project_knowledge" as const,
  accessible_project_ids: ["prj_knowledge"],
  content_types: ["knowledge_entry"] as const,
  sort: "extracted_at_desc_knowledge_id_asc" as const,
  request_cursor: null
};

function secret(): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => (index * 29 + 7) & 0xff);
}

const payload = {
  schemaVersion: 1,
  id: "kn_decision_1",
  projectId: "prj_knowledge",
  type: "decision",
  status: "active",
  title: "Use the durable source",
  summary: "Keep current truth in the database.",
  body: "The database row is the current source of truth.",
  keywords: ["durable", "source"],
  source: {
    archive: "archive_1",
    summaryData: "summary",
    summarySha256: "sha256:" + "a".repeat(64),
    sourceCommit: "commit_1",
    baseCommit: "base_1",
    changeName: "change-1",
    finalStatus: "ready"
  },
  scope: { sourceFiles: ["src/index.ts"] },
  lifecycle: {
    createdAt: "2026-08-14T01:02:03.000Z",
    verifiedAt: "2026-08-14T01:02:03.000Z",
    lastCheckedAt: "2026-08-14T01:02:03.000Z",
    confidence: "high",
    supersedes: [],
    supersededBy: null,
    conflictsWith: [],
    staleReasons: []
  }
};

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project_id: "prj_knowledge",
    entry_id: "kn_decision_1",
    content_sha256: `sha256:${createHash("sha256").update(payload.body, "utf8").digest("hex")}`,
    payload,
    status: "active",
    created_at: "2026-08-14T01:02:03.000Z",
    updated_at: "2026-08-14T01:02:03.000Z",
    projected_at: "2026-08-14T01:02:04.000Z",
    ...overrides
  };
}

function result(rows: readonly Record<string, unknown>[]) {
  return { rows: [...rows], rowCount: rows.length };
}

describe("ProjectKnowledgeCursorAuthority", () => {
  it("survives restart and binds the actor/project/sort fence", async () => {
    const current: ProjectKnowledgeCurrentFence = {
      project_id: scope.project_id,
      fence: "sha256:" + "c".repeat(64)
    };
    const first = new ProjectKnowledgeCursorAuthority(secret());
    const cursor = first.issue({ ...scope, current, last_key: {
      extracted_at: "2026-08-14T01:02:03.000Z", knowledge_id: "kn_decision_1"
    }});
    await expect(new ProjectKnowledgeCursorAuthority(secret()).verify({ ...scope, cursor }))
      .resolves.toBe(true);
    expect(first.locate(cursor, { ...scope, current })).toEqual({
      extracted_at: "2026-08-14T01:02:03.000Z", knowledge_id: "kn_decision_1"
    });
    await expect(first.verify({ ...scope, actor_id: "actor_other", cursor })).resolves.toBe(false);
    const tampered = cursor.slice(0, -1) + (cursor.endsWith("A") ? "B" : "A");
    await expect(first.verify({ ...scope, cursor: tampered })).resolves.toBe(false);
  });
});

describe("PgProjectKnowledgeSource", () => {
  it("returns descriptor-only page metadata and reads body only for detail", async () => {
    const queries: string[] = [];
    const pool = {
      async query(text: string) {
        queries.push(text);
        return result([row()]);
      }
    } as unknown as Pool;
    const authority = new ProjectKnowledgeCursorAuthority(secret());
    const source = new PgProjectKnowledgeSource({ pool, cursor_authority: authority });

    const page = JSON.parse(await source.listPage({ ...scope, limit: 10, cursor: null }));
    expect(page.page_state).toBe("ready");
    expect(page.entries).toEqual([expect.objectContaining({
      knowledge_id: "kn_decision_1",
      source_change_key: "change-1",
      source_refs: ["archive_1", "commit_1"]
    })]);
    expect(page.entries[0]).not.toHaveProperty("content");
    expect(queries[0]).not.toMatch(/SELECT\s+\*/iu);

    const detail = JSON.parse(await source.getDetail({ ...scope, detail_id: "kn_decision_1" }));
    expect(detail.content).toBe(payload.body);
    expect(detail.media_type).toBe("text/markdown");
    expect(queries).toHaveLength(2);
  });

  it("fails closed on malformed persisted payloads", async () => {
    const pool = { async query() { return result([row({ payload: { invalid: true } })]); } } as unknown as Pool;
    const source = new PgProjectKnowledgeSource({
      pool, cursor_authority: new ProjectKnowledgeCursorAuthority(secret())
    });
    const page = JSON.parse(await source.listPage({ ...scope, limit: 10, cursor: null }));
    expect(page.page_state).toBe("failed");
    expect(page.failures).toEqual([{ reason_code: "KNOWLEDGE_EXTRACTION_FAILED", retryable: true }]);
  });
});

describe("PgProjectKnowledgeRetryAuthority", () => {
  it("returns only failed retryable jobs from the project-scoped table", async () => {
    const pool = {
      async query() {
        return result([{
          project_id: "prj_knowledge",
          job_id: "job_knowledge_1",
          generation: 4,
          status: "failed",
          retryable: true
        }]);
      }
    } as unknown as Pool;
    const authority = new PgProjectKnowledgeRetryAuthority(pool);
    const serialized = await authority.lookup({
      actor_id: "actor_knowledge", project_id: "prj_knowledge",
      job_id: "job_knowledge_1", expected_generation: 4
    });
    expect(JSON.parse(serialized)).toMatchObject({
      decision: "authorized", job_status: "failed", retryable: true,
      expected_generation: 4, accessible_project_ids: ["prj_knowledge"]
    });
  });

  it("does not leak jobs from another project", async () => {
    const pool = {
      async query() {
        return result([]);
      }
    } as unknown as Pool;
    const authority = new PgProjectKnowledgeRetryAuthority(pool);
    const serialized = await authority.lookup({
      actor_id: "actor_knowledge", project_id: "prj_knowledge",
      job_id: "job_knowledge_other", expected_generation: 0
    });
    expect(JSON.parse(serialized)).toMatchObject({ decision: "not_found" });
  });
});
