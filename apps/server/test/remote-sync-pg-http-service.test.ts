import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { Pool } from "pg";

import { describe, expect, it } from "vitest";
import { canonicalJson } from "@hunter-harness/contracts";

import { createPgRemoteSyncHttpService } from "../src/remote-sync-pg/index.js";

const digest = (value: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const fullSource = () => ({
  project_id: "prj_remote_sync",
  branch_name: "feature/contracts",
  actor_id: "actor_remote_sync",
  commit_sha: "a".repeat(40),
  client_id: "cli_remote_sync",
  change_key: "change_remote_sync",
});

const leaseFor = (source = fullSource(), overrides: Partial<{
  lease_id: string; lease_token: string; generation: number; expires_at: string;
}> = {}) => ({
  schema_version: 1 as const,
  lease_id: overrides.lease_id ?? "lease_remote_sync",
  lease_token: overrides.lease_token ?? `lease_${"A".repeat(43)}`,
  generation: overrides.generation ?? 1,
  project_id: source.project_id,
  branch_name: source.branch_name,
  actor_id: source.actor_id,
  expires_at: overrides.expires_at ?? "2026-08-15T02:00:00.000Z",
});

const pushPrepareInput = () => {
  const source = fullSource();
  const lease = leaseFor(source);
  const contentHash = digest("x");
  return {
    source,
    lease,
    expected_revision: "revision_0001",
    preview_hash: digest("preview"),
    idempotency_key: "push-prepare-1",
    payload_hash: digest("payload"),
    files: [{
      path: "src/index.ts",
      content_hash: contentHash,
      size: 1,
      content_kind: "branch_file" as const,
      upload_ref: { ref_id: `bounded_upload:${"A".repeat(43)}`, sha256: contentHash, size_bytes: 1 },
    }],
    operations: [{
      path: "src/index.ts",
      content_kind: "branch_file" as const,
      action: "modify" as const,
      remote_hash: contentHash,
    }],
    skipped: [],
  };
};

class LeaseCommandDatabase {
  readonly commands = new Map<string, { payload_hash: string; command_kind: string; generation: number; lease_json: unknown }>();
  active: { lease_id: string; lease_token: string; generation: number; expires_at: string; source_json: unknown } | undefined;
  generation = 0;
  private tail: Promise<void> = Promise.resolve();

  private async acquire(): Promise<() => void> {
    const prior = this.tail;
    let release = (): void => undefined;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    return release;
  }

  pool(): Pool {
    return { connect: async () => {
      let unlock: (() => void) | undefined;
      return {
        query: async (sql: string, params: readonly unknown[] = []) => {
          const normalized = sql.trim();
          if (normalized === "BEGIN") return { rows: [], rowCount: 0 };
          if (normalized === "COMMIT" || normalized === "ROLLBACK") {
            unlock?.();
            unlock = undefined;
            return { rows: [], rowCount: 0 };
          }
          if (normalized.startsWith("SELECT pg_advisory_xact_lock")) {
            unlock = await this.acquire();
            return { rows: [], rowCount: 1 };
          }
          if (normalized.startsWith("SELECT payload_hash,command_kind,generation,lease_json")) {
            const command = this.commands.get(String(params[3]));
            return command === undefined ? { rows: [], rowCount: 0 } : { rows: [command], rowCount: 1 };
          }
          if (normalized.startsWith("SELECT lease_id,lease_token,generation,expires_at,source_json")) {
            return this.active === undefined ? { rows: [], rowCount: 0 } : { rows: [this.active], rowCount: 1 };
          }
          if (normalized.startsWith("SELECT COALESCE(MAX(generation),0)")) {
            return { rows: [{ generation: this.generation }], rowCount: 1 };
          }
          if (normalized.startsWith("INSERT INTO remote_sync_http_active_leases")) {
            this.active = {
              lease_id: String(params[3]), lease_token: String(params[4]), generation: Number(params[5]),
              expires_at: String(params[6]), source_json: params[7],
            };
            this.generation = Number(params[5]);
            return { rows: [], rowCount: 1 };
          }
          if (normalized.startsWith("UPDATE remote_sync_http_active_leases")) {
            if (this.active !== undefined) this.active.expires_at = String(params[3]);
            return { rows: [], rowCount: this.active === undefined ? 0 : 1 };
          }
          if (normalized.startsWith("DELETE FROM remote_sync_http_active_leases")) {
            this.active = undefined;
            return { rows: [], rowCount: 1 };
          }
          if (normalized.startsWith("INSERT INTO remote_sync_http_lease_commands")) {
            const kind = normalized.includes("'acquire'") ? "acquire" : normalized.includes("'renew'") ? "renew" : "release";
            const leaseJson = kind === "release" ? null : JSON.parse(String(params[6])) as unknown;
            this.commands.set(String(params[3]), {
              payload_hash: String(params[4]), command_kind: kind, generation: Number(params[5]), lease_json: leaseJson,
            });
            return { rows: [], rowCount: 1 };
          }
          throw new Error(`unhandled SQL: ${normalized}`);
        },
        release() { unlock?.(); unlock = undefined; },
      };
    } } as unknown as Pool;
  }
}

describe("Remote Sync PostgreSQL HTTP service", () => {
  it("keeps migration identity checks non-null, string-typed, exact, and bounded", async () => {
    const migration = await readFile(new URL("../migrations/030_remote_sync_http.sql", import.meta.url), "utf8");
    expect(migration).toContain("source_json ?& ARRAY['project_id','branch_name','actor_id']");
    expect(migration).toContain("jsonb_typeof(source_json->'project_id') = 'string'");
    expect(migration).toContain("jsonb_typeof(receipt_json->'source'->'actor_id') = 'string'");
    expect(migration).toContain("lease_json->>'generation' = generation::text");
    expect(migration).toContain("jsonb_array_length(files_json) <= 100000");
  });

  it("durably records and replays an acquire lease command", async () => {
    let command: { payload_hash: string; command_kind: string; generation: number; lease_json: unknown } | undefined;
    const client = {
      async query(sql: string, params: readonly unknown[] = []) {
        const normalized = sql.trim();
        if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK" ||
            normalized.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [], rowCount: 0 };
        if (normalized.startsWith("SELECT payload_hash,command_kind,generation,lease_json")) {
          return command === undefined ? { rows: [], rowCount: 0 } : { rows: [command], rowCount: 1 };
        }
        if (normalized.startsWith("SELECT lease_id,lease_token,generation,expires_at,source_json")) {
          return { rows: [], rowCount: 0 };
        }
        if (normalized.startsWith("SELECT COALESCE(MAX(generation),0)")) {
          return { rows: [{ generation: command?.generation ?? 0 }], rowCount: 1 };
        }
        if (normalized.startsWith("INSERT INTO remote_sync_http_active_leases")) return { rows: [], rowCount: 1 };
        if (normalized.startsWith("INSERT INTO remote_sync_http_lease_commands")) {
          command = {
            payload_hash: String(params[4]), command_kind: "acquire", generation: Number(params[5]),
            lease_json: JSON.parse(String(params[6])) as unknown,
          };
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`unhandled SQL: ${normalized}`);
      },
      release() { /* test client */ },
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const service = createPgRemoteSyncHttpService({
      pool,
      branchSnapshotProducer: { publish: async () => ({ outcome: "no_changes" as const }) },
      resolveUpload: async () => (async function* () {})(),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    const source = { project_id: "prj_remote_sync", branch_name: "main", actor_id: "actor_remote_sync" };
    const first = await service.acquireLease({ source, idempotency_key: "acquire-1" });
    expect(first.outcome).toBe("new");
    const replay = await service.acquireLease({ source, idempotency_key: "acquire-1" });
    expect(replay.outcome).toBe("replay");
    if (first.outcome === "new" && replay.outcome === "replay") expect(replay.value).toEqual(first.value);
    await service.close();
  });

  it("emits a final zero-byte content chunk for an empty snapshot file", async () => {
    const emptyHash = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const source = { project_id: "prj_remote_sync", branch_name: "main", actor_id: "actor_remote_sync" };
    const pool = {
      connect: async () => { throw new Error("unexpected transaction"); },
      async query(sql: string) {
        if (sql.startsWith("SELECT p.revision")) return {
          rows: [{ revision: "rev_1", project_version: "pv_1", artifact_id: "art_1", manifest_hash: emptyHash,
            commit_sha: "sha_commit", source_json: JSON.stringify(source), snapshot_json: JSON.stringify({ files: [
              { path: "README.md", content_hash: emptyHash, size: 0, content_kind: "branch_file" }
            ] }) }], rowCount: 1
        };
        if (sql.startsWith("SELECT b.content_bytes")) return { rows: [{ content_bytes: Buffer.alloc(0) }], rowCount: 1 };
        throw new Error(`unhandled SQL: ${sql}`);
      }
    } as unknown as Pool;
    const service = createPgRemoteSyncHttpService({
      pool,
      branchSnapshotProducer: { publish: async () => ({ outcome: "no_changes" as const }) },
      resolveUpload: async () => (async function* () {})(),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    const snapshot = await service.readRemoteSnapshot({ source });
    const stream = await service.openContentStream({
      source, path: "README.md", snapshot_id: snapshot.snapshot_id, expected_revision: snapshot.revision, chunk_size: 1024
    });
    const chunks = [];
    for await (const chunk of stream.stream) chunks.push(chunk);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ sequence: 0, offset: 0, size: 0, final: true, chunk_hash: emptyHash });
    await service.close();
  });

  it("serializes acquire, renew, and release receipts and replays each concurrent duplicate", async () => {
    const database = new LeaseCommandDatabase();
    const service = createPgRemoteSyncHttpService({
      pool: database.pool(),
      branchSnapshotProducer: { publish: async () => ({ outcome: "no_changes" as const }) },
      resolveUpload: async () => (async function* () {})(),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    const source = {
      project_id: "prj_remote_sync",
      branch_name: "feature/contracts",
      actor_id: "actor_remote_sync",
      commit_sha: "a".repeat(40),
      client_id: "cli_remote_sync",
      change_key: "change_remote_sync",
    };

    const acquired = await Promise.all([
      service.acquireLease({ source, idempotency_key: "acquire-concurrent" }),
      service.acquireLease({ source, idempotency_key: "acquire-concurrent" }),
    ]);
    expect(acquired.map((result) => result.outcome).sort()).toEqual(["new", "replay"]);
    const lease = acquired[0]?.outcome === "new" || acquired[0]?.outcome === "replay"
      ? acquired[0].value
      : acquired[1]?.outcome === "new" || acquired[1]?.outcome === "replay" ? acquired[1].value : undefined;
    if (lease === undefined) throw new Error("lease fixture missing");

    const renewed = await Promise.all([
      service.renewLease({ lease, idempotency_key: "renew-concurrent" }),
      service.renewLease({ lease, idempotency_key: "renew-concurrent" }),
    ]);
    expect(renewed.map((result) => result.outcome).sort()).toEqual(["new", "replay"]);
    const renewedLease = renewed[0]?.outcome === "new" || renewed[0]?.outcome === "replay"
      ? renewed[0].value
      : renewed[1]?.outcome === "new" || renewed[1]?.outcome === "replay" ? renewed[1].value : undefined;
    if (renewedLease === undefined) throw new Error("renewed lease fixture missing");

    const released = await Promise.all([
      service.releaseLease({ lease: renewedLease, idempotency_key: "release-concurrent" }),
      service.releaseLease({ lease: renewedLease, idempotency_key: "release-concurrent" }),
    ]);
    expect(released.map((result) => result.outcome).sort()).toEqual(["new", "replay"]);
    expect(database.active).toBeUndefined();
    await service.close();
  });

  it("holds sorted upload object fences and re-resolves exact raw-file refs on the push transaction client", async () => {
    const input = pushPrepareInput();
    const trace: string[] = [];
    const client = {
      async query(sql: string, params: readonly unknown[] = []) {
        const normalized = sql.trim();
        if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
          trace.push(normalized);
          return { rows: [], rowCount: 0 };
        }
        if (normalized.startsWith("SELECT pg_advisory_xact_lock")) {
          trace.push(`lock:${String(params[0])}`);
          return { rows: [], rowCount: 1 };
        }
        if (normalized.startsWith("SELECT * FROM remote_sync_http_pushes")) return { rows: [], rowCount: 0 };
        if (normalized.startsWith("SELECT lease_id,lease_token,generation,expires_at,source_json")) {
          return { rows: [{
            lease_id: input.lease.lease_id,
            lease_token: input.lease.lease_token,
            generation: input.lease.generation,
            expires_at: input.lease.expires_at,
            source_json: JSON.stringify(input.source),
          }], rowCount: 1 };
        }
        if (normalized.startsWith("SELECT p.revision")) {
          return { rows: [{ revision: input.expected_revision }], rowCount: 1 };
        }
        if (normalized.startsWith("INSERT INTO remote_sync_http_pushes")) {
          trace.push("insert:prepared");
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`unhandled SQL: ${normalized}`);
      },
      release() { /* test client */ },
    };
    const resolverInputs: Array<Record<string, unknown>> = [];
    const service = createPgRemoteSyncHttpService({
      pool: { connect: async () => client } as unknown as Pool,
      branchSnapshotProducer: { publish: async () => ({ outcome: "no_changes" as const }) },
      resolveUpload: async (value) => {
        trace.push("resolve:upload");
        resolverInputs.push(value as unknown as Record<string, unknown>);
        return (async function* () { yield new Uint8Array([120]); })();
      },
      now: () => new Date("2026-08-15T01:00:00.000Z"),
    });

    await expect(service.preparePush(input)).resolves.toMatchObject({ outcome: "new" });
    expect(resolverInputs).toHaveLength(1);
    expect(resolverInputs[0]).toMatchObject({
      source: input.source,
      upload_ref: input.files[0]?.upload_ref,
      purpose: "remote_sync_file",
      now: "2026-08-15T01:00:00.000Z",
      executor: client,
    });
    const objectLock = trace.findIndex((entry) => entry.includes(input.files[0]?.content_hash ?? "missing"));
    expect(objectLock).toBeGreaterThanOrEqual(0);
    expect(trace.indexOf("resolve:upload")).toBeGreaterThan(objectLock);
    expect(trace.indexOf("insert:prepared")).toBeGreaterThan(trace.indexOf("resolve:upload"));
    await service.close();
  });

  it("rejects cross-array duplicate paths before opening a transaction or resolving bytes", async () => {
    const input = pushPrepareInput();
    let poolCalls = 0;
    let resolverCalls = 0;
    const service = createPgRemoteSyncHttpService({
      pool: { connect: async () => { poolCalls += 1; throw new Error("unexpected pool call"); } } as unknown as Pool,
      branchSnapshotProducer: { publish: async () => { throw new Error("unexpected producer call"); } },
      resolveUpload: async () => { resolverCalls += 1; return (async function* () {})(); },
    });
    const duplicate = input.operations[0];
    if (duplicate === undefined) throw new Error("operation fixture missing");

    await expect(service.preparePush({
      ...input,
      skipped: [{ ...duplicate, action: "no_change" as const }],
    })).rejects.toMatchObject({ code: "SYNC_CONTENT_INVALID" });
    expect({ poolCalls, resolverCalls }).toEqual({ poolCalls: 0, resolverCalls: 0 });
    await service.close();
  });

  it("completes a no-change push atomically without fabricating durable version identities", async () => {
    const source = fullSource();
    const lease = leaseFor(source);
    const row = {
      project_id: source.project_id,
      branch_name: source.branch_name,
      actor_id: source.actor_id,
      idempotency_key: "push-no-change",
      prepare_id: "prepare_no_change",
      source_json: JSON.stringify(source),
      lease_id: lease.lease_id,
      lease_token: lease.lease_token,
      lease_generation: lease.generation,
      expected_revision: "0",
      preview_hash: digest("preview-no-change"),
      payload_hash: digest("payload-no-change"),
      request_hash: digest("request-no-change"),
      files_json: "[]",
      operations_json: "[]",
      skipped_json: "[]",
      state: "prepared",
      receipt_json: null,
      created_at: "2026-08-15T00:00:00.000Z",
      expires_at: lease.expires_at,
      updated_at: "2026-08-15T00:00:00.000Z",
    };
    let producerCalls = 0;
    let receiptJson: unknown;
    const client = {
      async query(sql: string, params: readonly unknown[] = []) {
        const normalized = sql.trim();
        if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK" ||
            normalized.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [], rowCount: 0 };
        if (normalized.startsWith("SELECT * FROM remote_sync_http_pushes")) return { rows: [row], rowCount: 1 };
        if (normalized.startsWith("SELECT lease_id,lease_token,generation,expires_at,source_json")) {
          return { rows: [{ lease_id: lease.lease_id, lease_token: lease.lease_token, generation: lease.generation,
            expires_at: lease.expires_at, source_json: JSON.stringify(source) }], rowCount: 1 };
        }
        if (normalized.startsWith("SELECT p.revision")) return { rows: [], rowCount: 0 };
        if (normalized.startsWith("UPDATE remote_sync_http_pushes")) {
          receiptJson = JSON.parse(String(params[4])) as unknown;
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`unhandled SQL: ${normalized}`);
      },
      release() { /* test client */ },
    };
    const service = createPgRemoteSyncHttpService({
      pool: { connect: async () => client } as unknown as Pool,
      branchSnapshotProducer: { publish: async () => { producerCalls += 1; return { outcome: "no_changes" as const }; } },
      resolveUpload: async () => (async function* () {})(),
      now: () => new Date("2026-08-15T01:00:00.000Z"),
    });

    const result = await service.commitPush({
      prepare_id: row.prepare_id,
      lease,
      idempotency_key: row.idempotency_key,
      payload_hash: row.payload_hash,
    });
    expect(result).toMatchObject({ outcome: "new", value: {
      no_changes: true,
      project_version: null,
      artifact_id: null,
      commit_sha: source.commit_sha,
    } });
    expect(receiptJson).toMatchObject({ project_version: null, artifact_id: null });
    expect(producerCalls).toBe(0);
    await service.close();
  });

  it("rejects committing a prepared L1 push under a reacquired L2 before producer execution", async () => {
    const input = pushPrepareInput();
    const oldLease = input.lease;
    const newLease = leaseFor(input.source, {
      lease_id: "lease_reacquired",
      lease_token: `lease_${"B".repeat(43)}`,
      generation: 2,
    });
    const row = {
      project_id: input.source.project_id,
      branch_name: input.source.branch_name,
      actor_id: input.source.actor_id,
      idempotency_key: input.idempotency_key,
      prepare_id: "prepare_old_lease",
      source_json: JSON.stringify(input.source),
      lease_id: oldLease.lease_id,
      lease_token: oldLease.lease_token,
      lease_generation: oldLease.generation,
      expected_revision: input.expected_revision,
      preview_hash: input.preview_hash,
      payload_hash: input.payload_hash,
      request_hash: digest("request"),
      files_json: JSON.stringify(input.files),
      operations_json: JSON.stringify(input.operations),
      skipped_json: "[]",
      state: "prepared",
      receipt_json: null,
      created_at: "2026-08-15T00:00:00.000Z",
      expires_at: oldLease.expires_at,
      updated_at: "2026-08-15T00:00:00.000Z",
    };
    let producerCalls = 0;
    const client = {
      async query(sql: string) {
        const normalized = sql.trim();
        if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK" ||
            normalized.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [], rowCount: 0 };
        if (normalized.startsWith("SELECT * FROM remote_sync_http_pushes")) return { rows: [row], rowCount: 1 };
        throw new Error(`unhandled SQL: ${normalized}`);
      },
      release() { /* test client */ },
    };
    const service = createPgRemoteSyncHttpService({
      pool: { connect: async () => client } as unknown as Pool,
      branchSnapshotProducer: { publish: async () => { producerCalls += 1; return { outcome: "no_changes" as const }; } },
      resolveUpload: async () => (async function* () {})(),
      now: () => new Date("2026-08-15T01:00:00.000Z"),
    });

    await expect(service.commitPush({
      prepare_id: row.prepare_id,
      lease: newLease,
      idempotency_key: row.idempotency_key,
      payload_hash: row.payload_hash,
    })).rejects.toMatchObject({ code: "SYNC_LEASE_FENCED" });
    expect(producerCalls).toBe(0);
    await service.close();
  });

  it("reconciles a durable producer receipt after response loss even after the HTTP lease expires", async () => {
    const input = pushPrepareInput();
    const preparedId = "prepare_response_loss";
    const suffix = digest(canonicalJson({ prepare_id: preparedId, payload_hash: input.payload_hash })).slice(7, 39);
    const file = {
      path: "src/index.ts",
      content_kind: "branch_file" as const,
      size: 1,
      content_hash: input.files[0]?.content_hash ?? digest("x"),
      media_type: "text/plain" as const,
      action: "modify" as const,
    };
    const manifestHash = digest(JSON.stringify([file]));
    const record = {
      schema_version: 1 as const,
      project_id: input.source.project_id,
      branch_name: input.source.branch_name,
      commit_sha: input.source.commit_sha,
      project_version: `pv_${suffix}`,
      artifact_id: `art_${suffix}`,
      manifest_hash: manifestHash,
      file_count: 1,
      changed_file_count: 1,
      uploaded_at: "2026-08-15T01:00:00.000Z",
      diff_ref: `diff_${suffix}`,
      files: [file],
      changed_paths: [file.path],
    };
    const row = {
      project_id: input.source.project_id,
      branch_name: input.source.branch_name,
      actor_id: input.source.actor_id,
      idempotency_key: input.idempotency_key,
      prepare_id: preparedId,
      source_json: JSON.stringify(input.source),
      lease_id: input.lease.lease_id,
      lease_token: input.lease.lease_token,
      lease_generation: input.lease.generation,
      expected_revision: input.expected_revision,
      preview_hash: input.preview_hash,
      payload_hash: input.payload_hash,
      request_hash: digest("request-response-loss"),
      files_json: JSON.stringify(input.files),
      operations_json: JSON.stringify(input.operations),
      skipped_json: "[]",
      state: "committing",
      receipt_json: null,
      created_at: "2026-08-15T00:00:00.000Z",
      expires_at: "2026-08-15T00:01:00.000Z",
      updated_at: "2026-08-15T00:00:00.000Z",
    };
    let producerCalls = 0;
    const client = {
      async query(sql: string) {
        const normalized = sql.trim();
        if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK" ||
            normalized.startsWith("SELECT pg_advisory_xact_lock") || normalized.startsWith("UPDATE remote_sync_http_pushes")) {
          return { rows: [], rowCount: 1 };
        }
        if (normalized.startsWith("SELECT * FROM remote_sync_http_pushes")) return { rows: [row], rowCount: 1 };
        if (normalized.includes("FROM remote_sync_commit_receipts")) return { rows: [{
          payload_hash: digest("internal-producer-payload"),
          source_json: JSON.stringify(input.source),
          expected_revision: input.expected_revision,
          project_version: record.project_version,
          artifact_id: record.artifact_id,
          manifest_hash: record.manifest_hash,
          commit_sha: record.commit_sha,
          record_json: JSON.stringify(record),
        }], rowCount: 1 };
        throw new Error(`unhandled SQL: ${normalized}`);
      },
      release() { /* test client */ },
    };
    const service = createPgRemoteSyncHttpService({
      pool: { connect: async () => client } as unknown as Pool,
      branchSnapshotProducer: { publish: async () => { producerCalls += 1; return { outcome: "no_changes" as const }; } },
      resolveUpload: async () => (async function* () {})(),
      now: () => new Date("2026-08-15T03:00:00.000Z"),
    });

    await expect(service.commitPush({
      prepare_id: preparedId,
      lease: input.lease,
      idempotency_key: input.idempotency_key,
      payload_hash: input.payload_hash,
    })).resolves.toMatchObject({ outcome: "replay", value: {
      project_version: record.project_version,
      artifact_id: record.artifact_id,
      manifest_hash: record.manifest_hash,
    } });
    expect(producerCalls).toBe(0);
    await service.close();
  });

  it("replays an exact durable pull under the branch lock and fails closed for a new pull", async () => {
    const source = fullSource();
    const payloadHash = digest("pull-payload");
    const receipt = {
      schema_version: 1 as const,
      source,
      idempotency_key: "pull-replay",
      payload_hash: payloadHash,
      remote_revision: "revision_0001",
      local_transaction: "committed" as const,
      commit_sha: source.commit_sha,
      artifact_id: "art_pull_1",
      manifest_hash: digest("pull-manifest"),
      project_version: "pv_pull_1",
      no_changes: true,
      applied: [],
      skipped: [],
      retryable: [],
    };
    const trace: string[] = [];
    const pool = { connect: async () => ({
      async query(sql: string, params: readonly unknown[] = []) {
        const normalized = sql.trim();
        if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") return { rows: [], rowCount: 0 };
        if (normalized.startsWith("SELECT pg_advisory_xact_lock")) { trace.push("lock"); return { rows: [], rowCount: 1 }; }
        if (normalized.startsWith("SELECT payload_hash,receipt_json FROM remote_sync_http_pulls")) {
          trace.push("receipt");
          return params[3] === receipt.idempotency_key
            ? { rows: [{ payload_hash: payloadHash, receipt_json: JSON.stringify(receipt) }], rowCount: 1 }
            : { rows: [], rowCount: 0 };
        }
        throw new Error(`unhandled SQL: ${normalized}`);
      },
      release() { /* test client */ },
    }) } as unknown as Pool;
    const service = createPgRemoteSyncHttpService({
      pool,
      branchSnapshotProducer: { publish: async () => ({ outcome: "no_changes" as const }) },
      resolveUpload: async () => (async function* () {})(),
    });

    await expect(service.pull({ source, actor_id: source.actor_id, idempotency_key: receipt.idempotency_key,
      payload_hash: payloadHash })).resolves.toEqual({ outcome: "replay", value: receipt });
    expect(trace.slice(0, 2)).toEqual(["lock", "receipt"]);
    await expect(service.pull({ source, actor_id: source.actor_id, idempotency_key: "pull-new",
      payload_hash: digest("pull-new") })).rejects.toMatchObject({ code: "REMOTE_UNAVAILABLE" });
    await service.close();
  });
});
