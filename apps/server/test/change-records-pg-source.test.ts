import { describe, expect, it } from "vitest";
import type { Pool } from "pg";

import {
  ChangeRecordsCursorAuthority,
  createChangeRecordsQueryAdapter,
  PgChangeArchiveSource
} from "../src/change-records-query/index.js";

const scope = {
  actor_id: "actor_change",
  project_id: "prj_change",
  accessible_project_ids: ["prj_change"],
  content_types: ["change_document", "archive_package", "project_content_candidate"] as const,
  sort: "archived_at_desc_change_key_asc" as const,
  request_cursor: null
};

const archive = {
  archive_id: "archive_1",
  project_id: "prj_change",
  change_key: "change-1",
  package_sha256: "sha256:" + "a".repeat(64),
  knowledge_status: "indexing",
  created_at: "2026-08-14T01:02:03.000Z",
  updated_at: "2026-08-14T01:02:04.000Z",
  attempt_count: 1,
  failure_stage: null,
  last_error_code: null
};

function secret(): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => (index * 17 + 3) & 0xff);
}

function result(rows: readonly Record<string, unknown>[]) {
  return { rows: [...rows], rowCount: rows.length };
}

describe("PgChangeArchiveSource", () => {
  it("projects durable archive metadata without inventing documents", async () => {
    const queries: string[] = [];
    const pool = {
      async query(text: string) {
        queries.push(text);
        return result([archive]);
      }
    } as unknown as Pool;
    const source = new PgChangeArchiveSource({
      pool,
      cursor_authority: new ChangeRecordsCursorAuthority(secret())
    });

    const page = JSON.parse(await source.listPage({
      ...scope, limit: 10, cursor: null
    }));
    expect(page.page_state).toBe("ready");
    expect(page.records).toEqual([expect.objectContaining({
      change_key: "change-1", archive_id: "archive_1", document_refs: [], projection_status: "queued"
    })]);
    expect(page.records[0]).not.toHaveProperty("content");
    expect(queries[0]).not.toMatch(/SELECT\s+\*/iu);

    const detail = JSON.parse(await source.getDetail({
      ...scope, detail_id: "change-1"
    }));
    expect(detail.archive_id).toBe("archive_1");
    expect(detail.document_refs).toEqual([]);
  });

  it("projects the documents and candidates the knowledge pipeline actually produced", async () => {
    // 此前这三个字段是硬编码空数组，视图只读 legacy 的 change_archive_packages，
    // 从不查询 knowledge_pipeline_change_documents / _results——于是平台上
    // 「变更记录」的 document_refs 与 candidate_count 与管道产出完全无关，恒为空。
    const documents = [
      { document_id: `doc_${"1".repeat(32)}`, content_hash: `sha256:${"b".repeat(64)}` },
      { document_id: `doc_${"2".repeat(32)}`, content_hash: `sha256:${"c".repeat(64)}` }
    ];
    const candidates = ["cand_alpha", "cand_beta"];
    const queries: string[] = [];
    const pool = {
      async query(text: string) {
        queries.push(text);
        return result([{ ...archive, documents, candidates }]);
      }
    } as unknown as Pool;
    const source = new PgChangeArchiveSource({
      pool,
      cursor_authority: new ChangeRecordsCursorAuthority(secret())
    });

    const page = JSON.parse(await source.listPage({ ...scope, limit: 10, cursor: null }));
    expect(page.records[0]).toEqual(expect.objectContaining({
      change_key: "change-1",
      document_refs: documents.map((entry) => entry.document_id),
      document_snapshots: documents,
      candidate_refs: candidates
    }));
    // 契约要求 snapshots 与 refs 等长同序，SQL 的排序必须保证这一点。
    expect(page.records[0].document_snapshots.map((s: { document_id: string }) => s.document_id))
      .toEqual(page.records[0].document_refs);
    expect(queries[0]).toMatch(/knowledge_pipeline_change_documents/u);
    expect(queries[0]).toMatch(/knowledge_pipeline_results/u);

    const detail = JSON.parse(await source.getDetail({ ...scope, detail_id: "change-1" }));
    expect(detail.document_refs).toEqual(documents.map((entry) => entry.document_id));
    expect(detail.document_snapshots).toEqual(documents);
    expect(detail.candidate_refs).toEqual(candidates);
  });

  it("produces a page accepted by the change-records adapter when archives exist", async () => {
    const pool = {
      async query() { return result([archive]); }
    } as unknown as Pool;
    const cursorAuthority = new ChangeRecordsCursorAuthority(secret());
    const source = new PgChangeArchiveSource({ pool, cursor_authority: cursorAuthority });
    const adapter = createChangeRecordsQueryAdapter({
      source_port: source,
      reference_port: source,
      cursor_verifier: cursorAuthority
    });

    const page = await adapter.queryPage(JSON.stringify({
      schema_version: 1,
      contract_kind: "query",
      view: "change_records",
      project_id: scope.project_id,
      query_scope: {
        actor_id: scope.actor_id,
        accessible_project_ids: scope.accessible_project_ids,
        content_types: scope.content_types
      },
      limit: 10,
      cursor: null,
      cursor_verification: "server_port_required",
      sort: scope.sort
    }));

    expect(page).toMatchObject({
      ok: true,
      value: {
        page_state: "ready",
        items: [expect.objectContaining({ item_kind: "change_record", change_key: "change-1" })]
      }
    });
  });

  it("does not fabricate document reference descriptors", async () => {
    const source = new PgChangeArchiveSource({
      pool: { async query() { return result([]); } } as unknown as Pool,
      cursor_authority: new ChangeRecordsCursorAuthority(secret())
    });
    await expect(source.resolve({
      actor_id: "actor_change", project_id: "prj_change",
      references: [{ change_key: "change-1", document_ids: ["doc_" + "a".repeat(32)] }]
    })).rejects.toThrow("CHANGE_DOCUMENT_PROJECTION_UNAVAILABLE");
  });

  it("resolves persisted document descriptors for adapter evidence checks", async () => {
    const documentId = "doc_" + "a".repeat(32);
    const pool = { async query(text: string) {
      expect(text).toMatch(/jsonb_to_recordset/u);
      return result([{
        document_id: documentId,
        project_id: scope.project_id,
        change_key: "change-1",
        document_type: "plan",
        source_path: "plans/change-1-plan.md",
        content_hash: "sha256:" + "b".repeat(64),
        source_archive_id: "archive_1",
        source_package_sha256: "sha256:" + "a".repeat(64)
      }]);
    } } as unknown as Pool;
    const source = new PgChangeArchiveSource({
      pool, cursor_authority: new ChangeRecordsCursorAuthority(secret())
    });
    const resolution = JSON.parse(await source.resolve({
      actor_id: scope.actor_id,
      project_id: scope.project_id,
      references: [{ change_key: "change-1", document_ids: [documentId] }]
    }));
    expect(resolution.descriptors).toEqual([expect.objectContaining({
      document_id: documentId,
      source_archive_id: "archive_1"
    })]);
  });
});
