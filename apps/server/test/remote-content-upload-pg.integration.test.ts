import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RemoteContentUploadHttpRequestDescriptor } from "@hunter-harness/contracts";
import { createRemoteContentUploadLocalCas, createPgRemoteContentUploadHttpService } from "../src/remote-content-upload-pg/index.js";
import { runMigrations } from "../src/repositories/migrate.js";

const databaseUrl = process.env.HUNTER_HARNESS_TEST_DATABASE_URL;
const postgresDescribe = databaseUrl === undefined ? describe.skip : describe;
const hash = (bytes: Uint8Array): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function descriptor(bytes: Uint8Array): RemoteContentUploadHttpRequestDescriptor {
  const sha = hash(bytes);
  return {
    schema_version: 1,
    // e35909d 起 purpose 必填，且决定 media_type 白名单（application/zip ↔ remote_archive）
    purpose: "remote_archive",
    path: { project_id: "prj_upload_pg", branch_name: "main" },
    auth: { actor_id: "actor_upload_pg" },
    headers: { "Content-Type": "application/zip", "Content-Length": String(bytes.length),
      "Idempotency-Key": `sha256:${"b".repeat(64)}`, "X-Content-SHA256": sha, "X-Upload-Expires-In-Ms": "60000" },
    body_stream: { kind: "single_binary_stream", media_type: "application/zip", content_encoding: "identity",
      content_length_bytes: bytes.length, content_sha256: sha, max_chunk_bytes: 1_048_576 },
  };
}

function chunks(bytes: Uint8Array) {
  return (async function* () {
    yield { sequence: 0, offset: 0, size: bytes.length, chunk_hash: hash(bytes), final: true, bytes };
  })();
}

postgresDescribe("Pg remote content upload integration", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  let root: string;
  let service: ReturnType<typeof createPgRemoteContentUploadHttpService> | undefined;

  beforeAll(async () => {
    await runMigrations(pool, fileURLToPath(new URL("../migrations", import.meta.url)));
    await pool.query("DELETE FROM remote_content_uploads WHERE project_id=$1", ["prj_upload_pg"]);
    await pool.query("DELETE FROM remote_content_upload_cas_objects WHERE project_id=$1", ["prj_upload_pg"]);
    await pool.query("DELETE FROM remote_content_upload_gc_batches WHERE project_id=$1", ["prj_upload_pg"]);
    await pool.query("INSERT INTO actors(actor_id,display_name) VALUES ($1,$1) ON CONFLICT DO NOTHING", ["actor_upload_pg"]);
    await pool.query(`INSERT INTO projects(project_id,owner_actor_id,display_name) VALUES ($1,$2,$1)
      ON CONFLICT (project_id) DO NOTHING`, ["prj_upload_pg", "actor_upload_pg"]);
    const parent = await mkdtemp(join(tmpdir(), "hunter-upload-pg-"));
    root = join(parent, "store");
    const cas = await createRemoteContentUploadLocalCas({ root });
    service = createPgRemoteContentUploadHttpService({ pool, cas });
  }, 120_000);

  afterAll(async () => {
    await service?.close();
    await pool.query("DELETE FROM remote_content_uploads WHERE project_id=$1", ["prj_upload_pg"]).catch(() => undefined);
    await pool.query("DELETE FROM remote_content_upload_cas_objects WHERE project_id=$1", ["prj_upload_pg"]).catch(() => undefined);
    await pool.query("DELETE FROM remote_content_upload_gc_batches WHERE project_id=$1", ["prj_upload_pg"]).catch(() => undefined);
    await pool.end();
    if (root !== undefined) await rm(join(root, ".."), { recursive: true, force: true }).catch(() => undefined);
  });

  it("persists one project-scoped record and replays it", async () => {
    const bytes = Buffer.from("pg-backed upload");
    const request = descriptor(bytes);
    const active = service;
    if (active === undefined) throw new Error("service not initialized");
    const first = await active.stage({ descriptor: request, chunks: chunks(bytes) });
    const replay = await active.stage({ descriptor: request, chunks: chunks(bytes) });
    expect(first.outcome).toBe("new");
    expect(replay.outcome).toBe("replay");
    await expect(active.status({ descriptor: {
      schema_version: 1, purpose: "remote_archive", path: request.path, auth: request.auth,
      headers: { "Idempotency-Key": request.headers["Idempotency-Key"] }
    } })).resolves.toMatchObject({ state: "stored" });
  });

  it("claims, acknowledges, and finalizes expired uploads without mixing receipt text and push timestamps", async () => {
    const active = service;
    if (active === undefined) throw new Error("service not initialized");
    const now = new Date().toISOString();
    await pool.query("UPDATE remote_content_uploads SET expires_at=$2 WHERE project_id=$1", [
      "prj_upload_pg", new Date(Date.now() - 1_000).toISOString(),
    ]);
    const claimed = await active.claimGarbage({
      project_id: "prj_upload_pg", now, limit: 1, worker_id: "worker_upload_pg",
      lease_until: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(claimed.refs).toHaveLength(1);
    await expect(active.acknowledgeGarbage({
      project_id: "prj_upload_pg", batch_id: claimed.batch_id, worker_id: "worker_upload_pg", now,
    })).resolves.toMatchObject({ status: "acked" });
    await expect(pool.query("SELECT 1 FROM remote_content_upload_gc_batches WHERE project_id=$1", ["prj_upload_pg"])).resolves.toMatchObject({ rowCount: 0 });
  });
});
