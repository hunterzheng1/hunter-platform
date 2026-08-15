import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  remoteContentUploadHttpRecordHash,
  type RemoteContentUploadHttpRecord,
} from "@hunter-harness/contracts";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import * as publicApi from "../src/remote-content-upload-pg/index.js";
import { PgRemoteContentUploadRecordPort } from "../src/remote-content-upload-pg/pg-records.js";
import { createPgRemoteContentUploadHttpService } from "../src/remote-content-upload-pg/service.js";

interface QueryReply {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount?: number;
}

function compact(sql: string): string {
  return sql.replace(/\s+/gu, " ").trim();
}

function poolFor(handler: (sql: string, values: readonly unknown[]) => QueryReply | Promise<QueryReply>): Pool {
  const client = {
    async query(sql: string, values: readonly unknown[] = []): Promise<QueryReply> {
      return handler(compact(sql), values);
    },
    release(): void { /* no-op */ },
  };
  return { async connect() { return client; } } as unknown as Pool;
}

function stagedFixture(expiresAt = "2026-08-15T00:01:00.000Z") {
  const createdAt = "2026-08-15T00:00:00.000Z";
  const source = { project_id: "prj_upload", branch_name: "main", actor_id: "actor_upload" };
  const contentSha256 = `sha256:${"b".repeat(64)}`;
  const idempotencyKey = `sha256:${"a".repeat(64)}`;
  const refToken = "r".repeat(43);
  const uploadRef = { ref_id: `bounded_upload:${refToken}`, sha256: contentSha256, size_bytes: 17 };
  const body = {
    schema_version: 1 as const,
    upload_id: `remote_content_upload:${refToken}`,
    source,
    idempotency_key: idempotencyKey,
    purpose: "remote_archive" as const,
    content_sha256: contentSha256,
    size_bytes: 17,
    upload_ref: uploadRef,
    state: "stored" as const,
    created_at: createdAt,
    expires_at: expiresAt,
  };
  const record: RemoteContentUploadHttpRecord = { ...body, record_hash: remoteContentUploadHttpRecordHash(body) };
  return {
    project_id: source.project_id,
    branch_name: source.branch_name,
    actor_id: source.actor_id,
    idempotency_key: idempotencyKey,
    content_sha256: contentSha256,
    size_bytes: body.size_bytes,
    expires_at: expiresAt,
    source,
    created_at: createdAt,
    upload_id: body.upload_id,
    upload_ref: uploadRef,
    stage_attempt_id: `attempt_${"c".repeat(32)}`,
    stage_lease_until: expiresAt,
    record,
  };
}

function uploadRow(input: ReturnType<typeof stagedFixture>) {
  return {
    project_id: input.project_id,
    actor_id: input.actor_id,
    branch_name: input.branch_name,
    idempotency_key: input.idempotency_key,
    content_sha256: input.content_sha256,
    size_bytes: input.size_bytes,
    source_json: input.source,
    record_json: input.record,
    created_at: input.created_at,
    expires_at: input.expires_at,
    updated_at: input.created_at,
    state: "staged",
    stage_attempt_id: input.stage_attempt_id,
    stage_lease_until: input.stage_lease_until,
  };
}

const empty = (): QueryReply => ({ rows: [], rowCount: 0 });

describe("Pg remote content upload durable records", () => {
  it("exposes only the safe upload service facade from the package index", () => {
    expect(Object.keys(publicApi).sort()).toEqual([
      "createPgRemoteContentUploadHttpService",
      "createRemoteContentUploadLocalCas",
    ]);
    const service = createPgRemoteContentUploadHttpService({
      pool: {} as never,
      cas: {} as never,
      records: {} as never,
    });
    expect(Object.keys(service).sort()).toEqual([
      "acknowledgeGarbage",
      "claimGarbage",
      "cleanupStaleAttempts",
      "close",
      "stage",
      "status",
    ]);
  });

  it("migrates publishing metadata and exact GC batch ownership", async () => {
    const migration = await readFile(fileURLToPath(new URL("../migrations/027_remote_content_upload_gc_ownership.sql", import.meta.url)), "utf8");
    expect(migration).toContain("gc_batch_id");
    expect(migration).toContain("'publishing'");
    expect(migration).toContain("remote_content_upload_cas_objects_claim_shape_check");
    expect(migration).toContain("remote_content_upload_gc_batches_unack_reap_idx");
    expect(migration).toContain("WHERE acknowledged=false");
  });

  it("does not let an old acknowledged batch finalize an object reclaimed by a new batch", async () => {
    const oldBatch = `remote_content_upload_gc:${"o".repeat(43)}`;
    const newBatch = `remote_content_upload_gc:${"n".repeat(43)}`;
    const sha256 = `sha256:${"d".repeat(64)}`;
    const calls: string[] = [];
    const removed: unknown[] = [];
    const pool = poolFor((sql) => {
      calls.push(sql);
      if (sql.includes("SELECT worker_id,acknowledged FROM remote_content_upload_gc_batches")) {
        return { rows: [{ worker_id: "worker_old", acknowledged: true }], rowCount: 1 };
      }
      if (sql.includes("FROM remote_content_upload_gc_items")) {
        return { rows: [{ content_sha256: sha256, size_bytes: 23 }], rowCount: 1 };
      }
      if (sql.includes("FROM remote_content_upload_cas_objects") && sql.includes("FOR UPDATE")) {
        return { rows: [{ content_sha256: sha256, size_bytes: 23, state: "gc_claimed", gc_batch_id: newBatch }], rowCount: 1 };
      }
      if (sql.includes("SELECT 1 FROM remote_content_uploads")) return empty();
      return empty();
    });
    const records = new PgRemoteContentUploadRecordPort(pool);

    const result = await records.finalizeGarbage({
      project_id: "prj_upload",
      batch_id: oldBatch,
      worker_id: "worker_old",
      async removeObject(ref) { removed.push(ref); },
    });

    expect(result.status).toBe("finalized");
    expect(removed).toHaveLength(0);
    const itemRead = calls.find((sql) => sql.includes("FROM remote_content_upload_gc_items"));
    expect(itemRead).not.toContain("FOR UPDATE");
    const advisoryIndex = calls.findIndex((sql) => sql.includes("pg_advisory_xact_lock"));
    const objectRowIndex = calls.findIndex((sql) => sql.includes("FROM remote_content_upload_cas_objects") && sql.includes("FOR UPDATE"));
    expect(advisoryIndex).toBeGreaterThanOrEqual(0);
    expect(objectRowIndex).toBeGreaterThan(advisoryIndex);
  });

  it("reaps an expired unacknowledged batch without disturbing a newer object owner", async () => {
    const oldBatch = `remote_content_upload_gc:${"o".repeat(43)}`;
    const newBatch = `remote_content_upload_gc:${"n".repeat(43)}`;
    const oldOwnedSha = `sha256:${"1".repeat(64)}`;
    const newOwnedSha = `sha256:${"2".repeat(64)}`;
    const calls: Array<{ readonly sql: string; readonly values: readonly unknown[] }> = [];
    const reset: string[] = [];
    let batchDeleted = false;
    const pool = poolFor((sql, values) => {
      calls.push({ sql, values });
      if (sql.includes("SELECT batch_id FROM remote_content_upload_gc_batches")) {
        return { rows: [{ batch_id: oldBatch }], rowCount: 1 };
      }
      if (sql.includes("SELECT worker_id,lease_until,acknowledged FROM remote_content_upload_gc_batches")) {
        return { rows: [{ worker_id: "dead_worker", lease_until: "2026-08-15T00:01:00.000Z", acknowledged: false }], rowCount: 1 };
      }
      if (sql.includes("FROM remote_content_upload_gc_items")) {
        return { rows: [
          { content_sha256: oldOwnedSha, size_bytes: 11 },
          { content_sha256: newOwnedSha, size_bytes: 12 },
        ], rowCount: 2 };
      }
      if (sql.includes("FROM remote_content_upload_cas_objects") && sql.includes("FOR UPDATE")) {
        const sha256 = String(values[1]);
        return { rows: [{ content_sha256: sha256, size_bytes: sha256 === oldOwnedSha ? 11 : 12,
          state: "gc_claimed", gc_batch_id: sha256 === oldOwnedSha ? oldBatch : newBatch }], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE remote_content_upload_cas_objects") && sql.includes("SET state='ready'")) {
        reset.push(String(values[1]));
        return empty();
      }
      if (sql.startsWith("DELETE FROM remote_content_upload_gc_batches")) {
        batchDeleted = true;
        return empty();
      }
      return empty();
    });
    const records = new PgRemoteContentUploadRecordPort(pool);

    await expect(records.reapExpiredGarbageBatches({ project_id: "prj_upload",
      now: "2026-08-15T00:02:00.000Z", limit: 8 })).resolves.toBe(1);

    expect(reset).toEqual([oldOwnedSha]);
    expect(batchDeleted).toBe(true);
    const itemRead = calls.find((call) => call.sql.includes("FROM remote_content_upload_gc_items"));
    expect(itemRead?.sql).not.toContain("FOR UPDATE");
    const objectAdvisories = calls.filter((call) => call.sql.includes("pg_advisory_xact_lock"));
    expect(objectAdvisories).toHaveLength(2);
  });

  it("reaps an expired acknowledged batch left between ack and finalize", async () => {
    const batchId = `remote_content_upload_gc:${"a".repeat(43)}`;
    let candidateSql = "";
    let batchDeleted = false;
    const pool = poolFor((sql) => {
      if (sql.includes("SELECT batch_id FROM remote_content_upload_gc_batches")) {
        candidateSql = sql;
        return { rows: [{ batch_id: batchId }], rowCount: 1 };
      }
      if (sql.includes("SELECT worker_id,lease_until,acknowledged FROM remote_content_upload_gc_batches")) {
        return { rows: [{ worker_id: "crashed_worker", lease_until: "2026-08-15T00:01:00.000Z", acknowledged: true }], rowCount: 1 };
      }
      if (sql.includes("FROM remote_content_upload_gc_items")) return empty();
      if (sql.startsWith("DELETE FROM remote_content_upload_gc_batches")) {
        batchDeleted = true;
        return empty();
      }
      return empty();
    });
    const records = new PgRemoteContentUploadRecordPort(pool);

    await expect(records.reapExpiredGarbageBatches({ project_id: "prj_upload",
      now: "2026-08-15T00:02:00.000Z", limit: 8 })).resolves.toBe(1);

    expect(candidateSql).not.toContain("acknowledged=false");
    expect(batchDeleted).toBe(true);
  });

  it("runs physical publish inside the durable object advisory and staged-row transaction", async () => {
    const input = stagedFixture();
    const staged = uploadRow(input);
    const stored = { ...staged, state: "stored", stage_attempt_id: null, stage_lease_until: null,
      updated_at: "2026-08-15T00:00:30.000Z" };
    const order: string[] = [];
    const pool = poolFor((sql) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        order.push(sql);
        return empty();
      }
      if (sql.includes("pg_advisory_xact_lock")) {
        order.push("advisory");
        return empty();
      }
      if (sql.startsWith("SELECT project_id,actor_id,branch_name") && sql.includes("FOR UPDATE")) {
        order.push("row-lock");
        return { rows: [{ ...staged, fence_checked_at: "2026-08-15T00:00:30.000Z" }], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE remote_content_uploads") && sql.includes("SET state='stored'")) {
        order.push("stored-record");
        return { rows: [stored], rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO remote_content_upload_cas_objects")) {
        order.push("ready-metadata");
        return { rows: [{ size_bytes: input.size_bytes }], rowCount: 1 };
      }
      return empty();
    });
    const records = new PgRemoteContentUploadRecordPort(pool);

    await expect(records.commitStaged({ project_id: input.project_id, branch_name: input.branch_name,
      actor_id: input.actor_id, idempotency_key: input.idempotency_key,
      stage_attempt_id: input.stage_attempt_id, now: "2026-08-15T00:00:30.000Z", record: input.record,
      async publishObject() { order.push("publish"); } })).resolves.toMatchObject({ outcome: "stored" });

    expect(order).toEqual([
      "BEGIN",
      "advisory",
      "row-lock",
      "publish",
      "stored-record",
      "ready-metadata",
      "COMMIT",
    ]);
  });

  it("keeps the publishing handoff staged when a 50ms callback crosses a 20ms expiry", async () => {
    const input = stagedFixture("2026-08-15T00:00:00.020Z");
    const staged = uploadRow(input);
    const stored = { ...staged, state: "stored", stage_attempt_id: null, stage_lease_until: null,
      updated_at: "2026-08-15T00:00:00.050Z" };
    let readyWrites = 0;
    let updateSql = "";
    const pool = poolFor((sql) => {
      if (sql.startsWith("SELECT project_id,actor_id,branch_name") && sql.includes("FOR UPDATE")) {
        return { rows: [{ ...staged, fence_checked_at: "2026-08-15T00:00:00.010Z" }], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE remote_content_uploads") && sql.includes("SET state='stored'")) {
        updateSql = sql;
        return sql.includes("expires_at > clock_timestamp()") ? empty() : { rows: [stored], rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO remote_content_upload_cas_objects")) {
        readyWrites += 1;
        return { rows: [{ size_bytes: input.size_bytes }], rowCount: 1 };
      }
      return empty();
    });
    const records = new PgRemoteContentUploadRecordPort(pool);

    const result = await records.commitStaged({ project_id: input.project_id, branch_name: input.branch_name,
      actor_id: input.actor_id, idempotency_key: input.idempotency_key,
      stage_attempt_id: input.stage_attempt_id, now: input.created_at, record: input.record,
      async publishObject() { await new Promise((resolve) => setTimeout(resolve, 50)); } });

    expect(result).toMatchObject({ outcome: "expired" });
    expect(updateSql).toContain("stage_lease_until > clock_timestamp()");
    expect(updateSql).toContain("expires_at > clock_timestamp()");
    expect(readyWrites).toBe(0);
  });

  it("keeps a published-but-uncommitted object discoverable and removable without client replay", async () => {
    const input = stagedFixture();
    const row = uploadRow(input);
    let metadataRegistered = false;
    let activeBatch: string | null = null;
    let acknowledged = false;
    const removed: unknown[] = [];
    const candidateQueries: string[] = [];
    const pool = poolFor((sql, values) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("pg_advisory_xact_lock")) return empty();
      if (sql.startsWith("INSERT INTO remote_content_uploads")) return { rows: [{ stage_attempt_id: input.stage_attempt_id }], rowCount: 1 };
      if (sql.startsWith("SELECT project_id,actor_id,branch_name") && sql.includes("FROM remote_content_uploads")) {
        return { rows: [row], rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO remote_content_upload_cas_objects")) {
        metadataRegistered = true;
        return { rows: [{ size_bytes: input.size_bytes }], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE remote_content_uploads") && sql.includes("SET state='stored'")) {
        throw new Error("simulated permanent markStored failure");
      }
      if (sql.includes("FROM remote_content_upload_cas_objects c")) {
        candidateQueries.push(sql);
        return metadataRegistered
          ? { rows: [{ content_sha256: input.content_sha256, size_bytes: input.size_bytes }], rowCount: 1 }
          : empty();
      }
      if (sql.startsWith("INSERT INTO remote_content_upload_gc_batches")) {
        activeBatch = String(values[0]);
        return empty();
      }
      if (sql.includes("FROM remote_content_upload_cas_objects") && sql.includes("FOR UPDATE")) {
        return metadataRegistered
          ? { rows: [{ content_sha256: input.content_sha256, size_bytes: input.size_bytes,
              state: activeBatch === null ? "publishing" : "gc_claimed", gc_batch_id: activeBatch }], rowCount: 1 }
          : empty();
      }
      if (sql.includes("SELECT 1 FROM remote_content_uploads")) return empty();
      if (sql.startsWith("INSERT INTO remote_content_upload_gc_items")) return empty();
      if (sql.startsWith("UPDATE remote_content_upload_cas_objects") && sql.includes("SET state='gc_claimed'")) {
        activeBatch = String(values[4]);
        return empty();
      }
      if (sql.includes("SELECT worker_id,lease_until,acknowledged FROM remote_content_upload_gc_batches")) {
        return activeBatch === null ? empty() : { rows: [{ worker_id: "worker_gc",
          lease_until: "2026-08-15T00:03:00.000Z", acknowledged }], rowCount: 1 };
      }
      if (sql.includes("SELECT worker_id,acknowledged FROM remote_content_upload_gc_batches")) {
        return activeBatch === null ? empty() : { rows: [{ worker_id: "worker_gc", acknowledged }], rowCount: 1 };
      }
      if (sql.includes("FROM remote_content_upload_gc_items")) {
        return activeBatch === null ? empty() : { rows: [{ content_sha256: input.content_sha256,
          size_bytes: input.size_bytes }], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE remote_content_upload_gc_batches SET acknowledged=true")) {
        acknowledged = true;
        return empty();
      }
      if (sql.startsWith("DELETE FROM remote_content_upload_cas_objects")) {
        metadataRegistered = false;
        return empty();
      }
      if (sql.startsWith("DELETE FROM remote_content_upload_gc_batches")) {
        activeBatch = null;
        return empty();
      }
      return empty();
    });
    const records = new PgRemoteContentUploadRecordPort(pool);

    await expect(records.insertStaged(input)).resolves.toMatchObject({ outcome: "staged" });
    await expect(records.markStored({ project_id: input.project_id, branch_name: input.branch_name,
      actor_id: input.actor_id, idempotency_key: input.idempotency_key,
      stage_attempt_id: input.stage_attempt_id, now: "2026-08-15T00:00:30.000Z", record: input.record }))
      .rejects.toThrow("simulated permanent markStored failure");
    const claim = await records.claimGarbage({ project_id: input.project_id,
      now: "2026-08-15T00:02:00.000Z", limit: 1, worker_id: "worker_gc",
      lease_until: "2026-08-15T00:03:00.000Z" });

    expect(claim.refs).toEqual([{ project_id: input.project_id, sha256: input.content_sha256, bytes: input.size_bytes }]);
    expect(candidateQueries[0]).toContain("'publishing'");
    await expect(records.ackGarbage({ project_id: input.project_id, batch_id: claim.batch_id,
      worker_id: "worker_gc", now: "2026-08-15T00:02:30.000Z" }))
      .resolves.toMatchObject({ status: "acked", refs: [{ sha256: input.content_sha256 }] });
    await expect(records.finalizeGarbage({ project_id: input.project_id, batch_id: claim.batch_id,
      worker_id: "worker_gc", async removeObject(ref) { removed.push(ref); } }))
      .resolves.toMatchObject({ status: "finalized" });
    expect(removed).toEqual([{ project_id: input.project_id, sha256: input.content_sha256, bytes: input.size_bytes }]);
    expect(metadataRegistered).toBe(false);
  });
});
