import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.HUNTER_HARNESS_TEST_DATABASE_URL;
const postgresDescribe = databaseUrl === undefined ? describe.skip : describe;

postgresDescribe("Stage 06A PostgreSQL migration integration", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  let migration = "";

  beforeAll(async () => {
    migration = await readFile(
      fileURLToPath(new URL("../migrations/023_knowledge_pipeline_pg.sql", import.meta.url)),
      "utf8"
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it("applies the new schema repeatedly without changing its durable shape", async () => {
    await pool.query(migration);
    await pool.query(migration);
    const result = await pool.query<{ table_name: string | null }>(`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name LIKE 'knowledge_pipeline_%'
       ORDER BY table_name`);
    expect(result.rows.map((row) => row.table_name)).toEqual([
      "knowledge_pipeline_archives",
      "knowledge_pipeline_capacity_fence",
      "knowledge_pipeline_change_documents",
      "knowledge_pipeline_change_jobs",
      "knowledge_pipeline_knowledge_jobs",
      "knowledge_pipeline_project_candidates",
      "knowledge_pipeline_project_fences",
      "knowledge_pipeline_results",
      "knowledge_pipeline_task_plans"
    ]);
  });

  it("keeps DDL transactional so a failed transaction leaves no probe state", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("CREATE TEMP TABLE stage06a_rollback_probe(value text)");
      await client.query("INSERT INTO stage06a_rollback_probe(value) VALUES ('uncommitted')");
      await client.query("ROLLBACK");
      await expect(client.query("SELECT to_regclass('pg_temp.stage06a_rollback_probe') AS name"))
        .resolves.toMatchObject({ rows: [{ name: null }] });
    } finally {
      client.release();
    }
  });
});
