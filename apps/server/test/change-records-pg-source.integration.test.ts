import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ChangeRecordsCursorAuthority,
  PgChangeArchiveSource
} from "../src/change-records-query/index.js";
import { runMigrations } from "../src/repositories/migrate.js";

const databaseUrl = process.env.HUNTER_HARNESS_TEST_DATABASE_URL;
const postgresDescribe = databaseUrl === undefined ? describe.skip : describe;

// 单元测试用假 pool，SQL 字符串本身从未被 Postgres 解析过——语法错误、列名笔误、
// lateral 作用域问题都只会在生产暴露。这条集成测试专门盯住 SQL 能否真正执行，
// 并验证 document_refs / candidate_refs 确实来自知识管道而非硬编码。
postgresDescribe("PgChangeArchiveSource real PostgreSQL integration", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const namespace = randomBytes(4).toString("hex");
  const actorId = `actor_changerec_${namespace}`;
  const projectId = `prj_changerec_${namespace}`;
  const changeKey = `change-${namespace}`;
  const archiveId = `arc_${namespace}`;
  const packageHash = `sha256:${"a".repeat(64)}`;
  const manifestHash = `sha256:${"e".repeat(64)}`;
  const documentIds = [`doc_${"1".repeat(32)}`, `doc_${"2".repeat(32)}`];
  const documentHashes = [`sha256:${"b".repeat(64)}`, `sha256:${"c".repeat(64)}`];
  const candidateIds = [`cand_${namespace}_a`, `cand_${namespace}_b`];
  const secret = Uint8Array.from({ length: 32 }, (_, index) => (index * 23 + 5) & 0xff);

  const scope = {
    actor_id: actorId,
    project_id: projectId,
    accessible_project_ids: [projectId],
    content_types: ["change_document", "archive_package", "project_content_candidate"] as const,
    sort: "archived_at_desc_change_key_asc" as const,
    request_cursor: null
  };

  beforeAll(async () => {
    await runMigrations(pool, fileURLToPath(new URL("../migrations", import.meta.url)));
    await pool.query("INSERT INTO actors(actor_id, display_name) VALUES ($1, $1)", [actorId]);
    await pool.query(
      "INSERT INTO projects(project_id, owner_actor_id, display_name) VALUES ($1, $2, $1)",
      [projectId, actorId]
    );
    await pool.query(
      `INSERT INTO change_archive_packages(
         archive_id, project_id, change_key, package_sha256, manifest_sha256,
         archive_status, knowledge_status, stored_files, created_at, updated_at,
         attempt_count, core_content_sha256)
       VALUES ($1,$2,$3,$4,$5,'durable','ready',2, now(), now(), 1, '[]'::jsonb)`,
      [archiveId, projectId, changeKey, packageHash, manifestHash]
    );
    await pool.query(
      `INSERT INTO knowledge_pipeline_archives(
         project_id, archive_id, change_key, package_sha256, manifest_sha256, project_version,
         package_schema_version, archive_schema_version, package_bytes, manifest_bytes,
         knowledge_candidates, project_content_candidates, validation_receipt, stored_at)
       VALUES ($1,$2,$3,$4,$5,$6,1,1,$7,$8,'[]'::jsonb,'[]'::jsonb,'{}'::jsonb, now())`,
      [projectId, archiveId, changeKey, packageHash, manifestHash, `pv_${namespace}`,
        Buffer.from("package"), Buffer.from("manifest")]
    );
    for (const [index, documentId] of documentIds.entries()) {
      await pool.query(
        `INSERT INTO knowledge_pipeline_change_documents(
           project_id, document_id, document_version, change_key, archive_id, package_sha256,
           project_version, document_type, source_path, content_hash, content, generation,
           created_at, updated_at)
         VALUES ($1,$2,'v1',$3,$4,$5,$6,$7,$8,$9,'# body',1, now(), now())`,
        [projectId, documentId, changeKey, archiveId, packageHash, `pv_${namespace}`,
          index === 0 ? "plan" : "design", `plans/doc-${index}.md`, documentHashes[index]]
      );
    }
    await pool.query(
      `INSERT INTO knowledge_pipeline_results(
         project_id, knowledge_id, content_kind, status, content_hash, display_title, summary,
         reusability_scope, confidence, source_archive_ids, source_change_keys,
         source_candidate_ids, source_refs, extractor_version, prompt_version,
         index_schema_version, generation, created_at, updated_at)
       VALUES ($1,$2,'knowledge_entry','active',$3,'title','summary','project',0.9,
         $4::jsonb,$5::jsonb,$6::jsonb,'[]'::jsonb,'v1','v1','v1',1, now(), now())`,
      [projectId, `kn_${namespace}`, `sha256:${"d".repeat(64)}`,
        JSON.stringify([archiveId]), JSON.stringify([changeKey]), JSON.stringify(candidateIds)]
    );
  });

  afterAll(async () => {
    await pool.query("DELETE FROM knowledge_pipeline_results WHERE project_id = $1", [projectId]);
    await pool.query("DELETE FROM knowledge_pipeline_change_documents WHERE project_id = $1", [projectId]);
    await pool.query("DELETE FROM knowledge_pipeline_archives WHERE project_id = $1", [projectId]);
    await pool.query("DELETE FROM change_archive_packages WHERE project_id = $1", [projectId]);
    await pool.query("DELETE FROM projects WHERE project_id = $1", [projectId]);
    await pool.query("DELETE FROM actors WHERE actor_id = $1", [actorId]);
    await pool.end();
  });

  it("executes both queries against Postgres and projects real pipeline documents and candidates", async () => {
    const source = new PgChangeArchiveSource({
      pool,
      cursor_authority: new ChangeRecordsCursorAuthority(secret)
    });

    const page = JSON.parse(await source.listPage({ ...scope, limit: 10, cursor: null })) as {
      page_state: string;
      records: Array<{
        change_key: string;
        document_refs: string[];
        document_snapshots: Array<{ document_id: string; content_hash: string }>;
        candidate_refs: string[];
      }>;
    };
    expect(page.page_state).toBe("ready");
    const record = page.records.find((entry) => entry.change_key === changeKey);
    expect(record).toBeDefined();
    expect(record?.document_refs).toEqual(documentIds);
    expect(record?.document_snapshots).toEqual(
      documentIds.map((documentId, index) => ({
        document_id: documentId,
        content_hash: documentHashes[index]
      }))
    );
    expect(record?.candidate_refs).toEqual(candidateIds);

    const detail = JSON.parse(await source.getDetail({ ...scope, detail_id: changeKey }) ?? "null") as {
      document_refs: string[];
      candidate_refs: string[];
    };
    // 列表与详情必须给出一致的 refs——两处共用同一段聚合 SQL 正是为此。
    expect(detail.document_refs).toEqual(documentIds);
    expect(detail.candidate_refs).toEqual(candidateIds);
  });
});
