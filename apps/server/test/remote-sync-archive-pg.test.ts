import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  remoteArchiveV2PayloadHash,
  normalizeRemoteArchiveV2Record,
  type RemoteArchiveV2PrepareInput,
} from "@hunter-harness/core";
import { describe, expect, it } from "vitest";
import { createPgRemoteSyncArchiveV2 } from "../src/remote-sync-archive-pg/index.js";

const hash = (digit: string) => `sha256:${digit.repeat(64)}` as `sha256:${string}`;

function input(projectId = "prj_archive_pg"): RemoteArchiveV2PrepareInput {
  const metadata = {
    schema_version: 2 as const,
    source: { project_id: projectId, branch_name: "main", actor_id: "actor_archive_pg" },
    archive_id: "archive-pg-test",
    identities: {
      package_sha256: hash("1"), package_size_bytes: 42, archive_schema_version: 1 as const,
      trusted_package_receipt_hash: hash("2"), local_archive_receipt_hash: hash("3"),
      manifest_hash: hash("4"), inventory_hash: hash("5"), core_v2_projection_hash: hash("6")
    },
    upload_ref: { ref_id: "bounded_upload:pg-test", sha256: hash("1"), size_bytes: 42 }
  };
  return {
    schema_version: 2, operation_id: "remote_archive_operation:pg-test", idempotency_key: hash("7"),
    payload_hash: remoteArchiveV2PayloadHash(metadata), lease_ttl_ms: 60_000, metadata
  };
}

type Stored = {
  project_id: string; operation_id: string; idempotency_key: string; payload_hash: string;
  state: string; generation: number; record_json: unknown; created_at: string; updated_at: string;
};

function fakePool() {
  const rows = new Map<string, Stored>();
  const uploads = new Set<string>(["prj_archive_pg\0bounded_upload:pg-test"]);
  const key = (project: string, operation: string) => `${project}\0${operation}`;
  const client = {
    async query(sql: string, params: readonly unknown[] = []) {
      if (/^(BEGIN|COMMIT|ROLLBACK|SELECT pg_advisory)/u.test(sql.trim())) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM remote_content_uploads")) {
        const project = String(params[0]); const ref = String(params[1]);
        const found = uploads.has(`${project}\0${ref}`);
        return { rows: found ? [{ ref_id: ref, content_sha256: params[2], size_bytes: params[3], expires_at: "2026-08-15T01:00:00.000Z", state: "stored" }] : [], rowCount: found ? 1 : 0 };
      }
      if (sql.includes("FROM remote_archive_v2_records")) {
        const project = String(params[0]);
        const operation = sql.includes("operation_id=$2") ? String(params[1]) :
          [...rows.values()].find((item) => item.project_id === project && item.idempotency_key === String(params[1]))?.operation_id;
        const row = operation === undefined ? undefined : rows.get(key(project, operation));
        return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
      }
      if (sql.startsWith("INSERT INTO remote_archive_v2_records")) {
        const row: Stored = { project_id: String(params[0]), operation_id: String(params[1]), idempotency_key: String(params[2]),
          payload_hash: String(params[3]), state: String(params[4]), generation: Number(params[5]), record_json: JSON.parse(String(params[6])),
          created_at: String(params[7]), updated_at: String(params[8]) };
        rows.set(key(row.project_id, row.operation_id), row); return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE remote_archive_v2_records")) {
        const row = rows.get(key(String(params[0]), String(params[1])));
        if (row === undefined) return { rows: [], rowCount: 0 };
        row.payload_hash = String(params[2]); row.state = String(params[3]); row.generation = Number(params[4]);
        row.record_json = JSON.parse(String(params[5])); row.updated_at = String(params[6]);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unhandled SQL: ${sql}`);
    },
    release() { /* no-op */ }
  };
  return { connect: async () => client, query: client.query } as never;
}

describe("Remote Sync Archive PostgreSQL adapter", () => {
  it("persists canonical prepare/commit state and replays after a new service instance", async () => {
    const pool = fakePool();
    const first = createPgRemoteSyncArchiveV2({ pool, now: () => "2026-08-15T00:00:00.000Z" });
    const request = input();
    const prepared = await first.prepare(request);
    expect(prepared.outcome).toBe("new");
    expect(normalizeRemoteArchiveV2Record(JSON.parse(JSON.stringify(prepared.record))), JSON.stringify(prepared.record)).toMatchObject({ ok: true });
    const replay = await first.prepare(request);
    expect(replay).toMatchObject({ outcome: "replay", claim: null, record: prepared.record });
    if (prepared.claim === null) throw new Error("claim missing");
    const committed = await first.commit({ claim: prepared.claim });
    expect(committed).toMatchObject({ outcome: "new", record: { state: "committed", generation: 3 }, receipt: {
      operation_id: request.operation_id, payload_hash: request.payload_hash
    } });
    const restarted = createPgRemoteSyncArchiveV2({ pool, now: () => "2026-08-15T00:00:00.000Z" });
    expect((await restarted.prepare(request)).claim).toBeNull();
    expect((await restarted.status({ operation_id: request.operation_id, source: request.metadata.source })).state).toBe("committed");
    expect(await restarted.receipt({ operation_id: request.operation_id, source: request.metadata.source })).toEqual(committed.receipt);
  });

  it("keeps the migration scoped to project and durable record identity", async () => {
    const migration = await readFile(fileURLToPath(new URL("../migrations/026_remote_sync_archive_v2.sql", import.meta.url)), "utf8");
    expect(migration).toContain("PRIMARY KEY (project_id, operation_id)");
    expect(migration).toContain("UNIQUE (project_id, idempotency_key)");
    expect(migration).toContain("record_json->>'operation_id' = operation_id");
    expect(migration).toContain("record_json->'source'->>'project_id' = project_id");
  });
});
