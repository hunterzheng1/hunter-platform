import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgRemoteSyncCommitPort } from "../src/remote-sync-pg/index.js";
import { runMigrations } from "../src/repositories/migrate.js";

const databaseUrl = process.env.HUNTER_HARNESS_TEST_DATABASE_URL;
const postgresDescribe = databaseUrl === undefined ? describe.skip : describe;
const digest = (value: string): string =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

function input() {
  const content = "# remote sync pg\n";
  const file = {
    path: "AGENTS.md",
    content_kind: "instruction" as const,
    size: Buffer.byteLength(content),
    content_hash: digest(content),
    media_type: "text/markdown" as const,
    action: "modify" as const,
    content,
  };
  const refs = [{
    path: file.path, content_kind: file.content_kind, size: file.size,
    content_hash: file.content_hash, media_type: file.media_type, action: file.action,
  }];
  return {
    actor_id: "actor_remote_sync_tx_pg",
    idempotency_key: "remote_sync_tx_pg_0001",
    expected_revision: "0",
    source: {
      project_id: "prj_remote_sync_tx_pg",
      branch_name: "main",
      actor_id: "actor_remote_sync_tx_pg",
      commit_sha: "a".repeat(40),
      client_id: "cli_remote_sync_tx_pg",
      change_key: "change_remote_sync_tx_pg",
    },
    seed: {
      schema_version: 1 as const,
      project_id: "prj_remote_sync_tx_pg",
      branch_name: "main",
      commit_sha: "a".repeat(40),
      project_version: "pv_remote_sync_tx_pg_1",
      artifact_id: "art_remote_sync_tx_pg_1",
      manifest_hash: digest(JSON.stringify(refs)),
      file_count: 1,
      changed_file_count: 1,
      uploaded_at: "2026-08-15T01:00:00.000Z",
      diff_ref: "diff_remote_sync_tx_pg_1",
      changed_paths: ["AGENTS.md"],
      files: [file],
    },
  };
}

postgresDescribe("Remote Sync transaction adapter PostgreSQL integration", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  beforeAll(async () => {
    await runMigrations(pool, fileURLToPath(new URL("../migrations", import.meta.url)));
    await pool.query("DELETE FROM projects WHERE project_id=$1", ["prj_remote_sync_tx_pg"]);
    await pool.query(
      "INSERT INTO actors(actor_id, display_name) VALUES ($1,$1) ON CONFLICT (actor_id) DO NOTHING",
      ["actor_remote_sync_tx_pg"]
    );
    await pool.query(
      "INSERT INTO projects(project_id, owner_actor_id, display_name) VALUES ($1,$2,$1)",
      ["prj_remote_sync_tx_pg", "actor_remote_sync_tx_pg"]
    );
  });
  afterAll(async () => { await pool.end(); });

  it("commits and replays one durable receipt across adapter instances", async () => {
    const first = await createPgRemoteSyncCommitPort({ pool }).commitSnapshot(input());
    const replay = await createPgRemoteSyncCommitPort({ pool }).commitSnapshot(input());
    expect(first.outcome).toBe("new");
    expect(replay.outcome).toBe("replay");
    expect(replay.record).toEqual(first.record);
    const counts = await pool.query(`SELECT
      (SELECT count(*)::int FROM remote_sync_versions WHERE project_id=$1) AS versions,
      (SELECT count(*)::int FROM remote_sync_artifacts WHERE project_id=$1) AS artifacts,
      (SELECT count(*)::int FROM branch_snapshots WHERE project_id=$1) AS snapshots,
      (SELECT count(*)::int FROM remote_sync_commit_receipts WHERE project_id=$1) AS receipts`,
    ["prj_remote_sync_tx_pg"]);
    expect(counts.rows[0]).toEqual({ versions: 1, artifacts: 1, snapshots: 1, receipts: 1 });
  });
});
