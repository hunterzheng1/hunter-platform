import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { runMigrations } from "../src/repositories/migrate.js";
import { PgJobRepository } from "../src/knowledge-pipeline/pg.js";

const databaseUrl = process.env.HUNTER_HARNESS_TEST_DATABASE_URL;

/**
 * Verifies migration 033 against a real PostgreSQL: applies the whole chain,
 * re-applies it (idempotence on an existing database), and exercises the three
 * new nullable columns the ingest bridge depends on.
 */
describe.skipIf(databaseUrl === undefined)("migration 033 on real PostgreSQL", () => {
  it("applies the full chain twice and lands the three nullable columns", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    try {
      const directory = fileURLToPath(new URL("../migrations", import.meta.url));
      await runMigrations(pool, directory);
      // Idempotence on an already-migrated database is the real production case.
      await runMigrations(pool, directory);

      const columns = await pool.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable
           FROM information_schema.columns
          WHERE table_name = 'knowledge_pipeline_results'
            AND column_name IN ('entry_type', 'body', 'keywords')
          ORDER BY column_name`
      );
      expect(columns.rows).toEqual([
        { column_name: "body", is_nullable: "YES" },
        { column_name: "entry_type", is_nullable: "YES" },
        { column_name: "keywords", is_nullable: "YES" }
      ]);

      // The CHECK constraint must reject a type outside the seven-value enum,
      // otherwise a bad row would reach knowledgeIngestEntrySchema and be
      // silently dropped by the semantic projection instead of failing loudly.
      await pool.query(
        `INSERT INTO actors(actor_id, display_name)
         VALUES ('actor_mig_033', 'migration 033')
         ON CONFLICT DO NOTHING`
      );
      await pool.query(
        `INSERT INTO projects(project_id, owner_actor_id, display_name)
         VALUES ('prj_mig_033', 'actor_mig_033', 'migration 033')
         ON CONFLICT DO NOTHING`
      );
      const insert = (entryType: string, keywords: string) => pool.query(
        `INSERT INTO knowledge_pipeline_results(
           project_id, knowledge_id, content_kind, status, content_hash, display_title,
           summary, reusability_scope, confidence, source_archive_ids, source_change_keys,
           source_candidate_ids, source_refs, extractor_version, prompt_version,
           index_schema_version, generation, created_at, updated_at,
           entry_type, body, keywords
         ) VALUES ('prj_mig_033', $1, 'knowledge_entry', 'active', $2, 't', 's', 'packages',
                   0.95, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'e', 'p', 'i',
                   1, now(), now(), $3, 'b', $4::jsonb)`,
        [`kn_${entryType}`, `sha256:${entryType.padEnd(64, "0").slice(0, 64)}`, entryType, keywords]
      );

      await expect(insert("pitfall", '["a","b"]')).resolves.toBeDefined();
      await expect(insert("lesson", "[]")).rejects.toThrow();

      // A row from an archive that predates the candidate generator: all three null.
      await expect(pool.query(
        `INSERT INTO knowledge_pipeline_results(
           project_id, knowledge_id, content_kind, status, content_hash, display_title,
           summary, reusability_scope, confidence, source_archive_ids, source_change_keys,
           source_candidate_ids, source_refs, extractor_version, prompt_version,
           index_schema_version, generation, created_at, updated_at
         ) VALUES ('prj_mig_033', 'kn_bare', 'knowledge_entry', 'active',
                   'sha256:${"c".repeat(64)}', 't', 's', 'packages', 0.9,
                   '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'e', 'p', 'i',
                   1, now(), now())`
      )).resolves.toBeDefined();

      const stored = await pool.query<{ entry_type: string | null; keywords: unknown }>(
        `SELECT entry_type, keywords FROM knowledge_pipeline_results
          WHERE project_id = 'prj_mig_033' ORDER BY knowledge_id`
      );
      expect(stored.rows).toEqual([
        { entry_type: null, keywords: null },
        { entry_type: "pitfall", keywords: ["a", "b"] }
      ]);
    } finally {
      await pool.query("DELETE FROM projects WHERE project_id = 'prj_mig_033'").catch(() => undefined);
      await pool.query("DELETE FROM actors WHERE actor_id = 'actor_mig_033'").catch(() => undefined);
      await pool.end();
    }
  }, 120_000);

  it("keeps knowledge queued until the matching change projection is ready", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const actorId = "actor_mig_033_gate";
    const projectId = "prj_mig_033_gate";
    const archiveId = "arc_mig_033_gate";
    const packageHash = `sha256:${"a".repeat(64)}`;
    try {
      const directory = fileURLToPath(new URL("../migrations", import.meta.url));
      await runMigrations(pool, directory);
      await pool.query("INSERT INTO actors(actor_id, display_name) VALUES ($1, $1)", [actorId]);
      await pool.query(
        "INSERT INTO projects(project_id, owner_actor_id, display_name) VALUES ($1, $2, $1)",
        [projectId, actorId]
      );
      await pool.query(
        `INSERT INTO knowledge_pipeline_archives(
           project_id, archive_id, change_key, package_sha256, manifest_sha256, project_version,
           package_schema_version, archive_schema_version, package_bytes, manifest_bytes,
           knowledge_candidates, project_content_candidates, validation_receipt, stored_at)
         VALUES ($1,$2,'change-gate',$3,$4,'pv_gate',1,1,$5,$6,'[]'::jsonb,'[]'::jsonb,
                 '{}'::jsonb,now())`,
        [projectId, archiveId, packageHash, `sha256:${"b".repeat(64)}`,
          Buffer.from("package"), Buffer.from("manifest")]
      );
      await pool.query(
        `INSERT INTO knowledge_pipeline_change_jobs(
           job_id, project_id, change_key, archive_id, package_sha256, manifest_sha256,
           project_version, package_schema_version, archive_schema_version, status, attempt,
           project_generation, generation, input_hash, retryable, created_at, updated_at)
         VALUES ('job_change_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',$1,'change-gate',$2,$3,$4,
                 'pv_gate',1,1,'queued',1,1,1,$5,true,now(),now())`,
        [projectId, archiveId, packageHash, `sha256:${"b".repeat(64)}`,
          `sha256:${"c".repeat(64)}`]
      );
      await pool.query(
        `INSERT INTO knowledge_pipeline_knowledge_jobs(
           job_id, idempotency_key, project_id, change_key, archive_id, package_sha256,
           extractor_version, prompt_version, index_schema_version, status, attempt, generation,
           input_hash, retryable, knowledge_candidates, created_at, updated_at)
         VALUES ('job_knowledge_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',$1,$2,'change-gate',$3,$4,
                 'e','p','i','queued',1,1,$5,true,
                 '[]'::jsonb,now(),now())`,
        [`sha256:${"d".repeat(64)}`, projectId, archiveId, packageHash,
          `sha256:${"e".repeat(64)}`]
      );

      const repository = new PgJobRepository(pool);
      await expect(repository.listQueuedKnowledgeJobs(10)).resolves.toHaveLength(0);
      await pool.query(
        `UPDATE knowledge_pipeline_change_jobs
            SET status='ready', output_hash=$2, document_count=1, retryable=false, updated_at=now()
          WHERE project_id=$1`,
        [projectId, `sha256:${"f".repeat(64)}`]
      );
      await expect(repository.listQueuedKnowledgeJobs(10)).resolves.toMatchObject([
        { job_id: "job_knowledge_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", status: "queued",
          archive_id: archiveId }
      ]);
    } finally {
      await pool.query("DELETE FROM projects WHERE project_id = $1", [projectId]).catch(() => undefined);
      await pool.query("DELETE FROM actors WHERE actor_id = $1", [actorId]).catch(() => undefined);
      await pool.end();
    }
  }, 120_000);
});
