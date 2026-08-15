import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, afterEach } from "vitest";

import { createRemoteContentUploadLocalCas } from "../src/remote-content-upload-pg/local-cas.js";
import { createPgRemoteContentUploadHttpService } from "../src/remote-content-upload-pg/service.js";
import type {
  RemoteContentUploadRecordIdentity,
  RemoteContentUploadRecordLookup,
  RemoteContentUploadRecordPort,
} from "../src/remote-content-upload-pg/ports.js";
import type { RemoteContentUploadHttpRecord, RemoteContentUploadHttpRequestDescriptor } from "@hunter-harness/contracts";

const digest = (bytes: Uint8Array): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function descriptor(bytes: Uint8Array, idempotency = "a".repeat(64), expiry = "60000"): RemoteContentUploadHttpRequestDescriptor {
  const hash = digest(bytes);
  return {
    schema_version: 1,
    purpose: "remote_archive",
    path: { project_id: "prj_upload", branch_name: "feature" },
    auth: { actor_id: "actor_1" },
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(bytes.byteLength),
      "Idempotency-Key": `sha256:${idempotency}`,
      "X-Content-SHA256": hash,
      "X-Upload-Expires-In-Ms": expiry,
      "X-Commit-SHA": "sha256:commit",
    },
    body_stream: {
      kind: "single_binary_stream",
      media_type: "application/zip",
      content_encoding: "identity",
      content_length_bytes: bytes.byteLength,
      content_sha256: hash,
      max_chunk_bytes: 1024 * 1024,
    },
  };
}

function chunks(bytes: Uint8Array): AsyncIterable<{ sequence: number; offset: number; size: number; chunk_hash: `sha256:${string}`; final: boolean; bytes: Uint8Array }> {
  return (async function* () {
    yield { sequence: 0, offset: 0, size: bytes.byteLength, chunk_hash: digest(bytes), final: true, bytes };
  })();
}

function statusDescriptor(request: RemoteContentUploadHttpRequestDescriptor) {
  return {
    schema_version: 1 as const,
    purpose: request.purpose,
    path: request.path,
    auth: request.auth,
    headers: {
      "Idempotency-Key": request.headers["Idempotency-Key"],
      ...(request.headers["X-Commit-SHA"] === undefined ? {} : { "X-Commit-SHA": request.headers["X-Commit-SHA"] }),
    },
  };
}

function memoryRecords(options: { failMark?: boolean; failMarkOnce?: boolean } = {}): RemoteContentUploadRecordPort {
  let failMark = options.failMark === true || options.failMarkOnce === true;
  const rows = new Map<string, { identity: RemoteContentUploadRecordIdentity; record: RemoteContentUploadHttpRecord; state: "staged" | "stored"; stage_attempt_id?: string }>();
  const key = (identity: Pick<RemoteContentUploadRecordIdentity, "project_id" | "actor_id" | "idempotency_key">): string =>
    JSON.stringify([identity.project_id, identity.actor_id, identity.idempotency_key]);
  const same = (left: RemoteContentUploadRecordIdentity, right: RemoteContentUploadRecordIdentity): boolean =>
    JSON.stringify({ project_id: left.project_id, branch_name: left.branch_name, actor_id: left.actor_id,
      idempotency_key: left.idempotency_key, content_sha256: left.content_sha256, size_bytes: left.size_bytes,
      expires_at: left.expires_at, purpose: left.purpose, source: left.source }) ===
    JSON.stringify({ project_id: right.project_id, branch_name: right.branch_name, actor_id: right.actor_id,
      idempotency_key: right.idempotency_key, content_sha256: right.content_sha256, size_bytes: right.size_bytes,
      expires_at: right.expires_at, purpose: right.purpose, source: right.source });
  const lookup = (row: { identity: RemoteContentUploadRecordIdentity; record: RemoteContentUploadHttpRecord; state: "staged" | "stored"; stage_attempt_id?: string }, now: string): RemoteContentUploadRecordLookup => {
    if (Date.parse(row.record.expires_at) <= Date.parse(now)) return { outcome: "expired", record: row.record };
    return row.state === "stored" ? { outcome: "stored", record: row.record } : {
      outcome: "staged", record: row.record, ...(row.stage_attempt_id === undefined ? {} : { stage_attempt_id: row.stage_attempt_id })
    };
  };
  const markStored: RemoteContentUploadRecordPort["markStored"] = async (input) => {
    if (failMark) {
      if (options.failMarkOnce === true) failMark = false;
      throw new Error("db unavailable");
    }
    const row = [...rows.values()].find((candidate) => candidate.record.upload_id === input.record.upload_id);
    if (row === undefined) return { outcome: "missing" };
    row.state = "stored";
    delete row.stage_attempt_id;
    return { outcome: "stored", record: row.record };
  };
  return {
    async findByIdentity(input) {
      const row = rows.get(key(input));
      if (row === undefined) return { outcome: "missing" };
      return same(row.identity, input) ? lookup(row, input.now) : { outcome: "conflict", record: row.record };
    },
    async insertStaged(input) {
      const existing = rows.get(key(input));
      if (existing !== undefined) return same(existing.identity, input) ? lookup(existing, input.created_at) : { outcome: "conflict", record: existing.record };
      rows.set(key(input), { identity: input, record: input.record, state: "staged", stage_attempt_id: input.stage_attempt_id });
      return { outcome: "staged", record: input.record, stage_attempt_id: input.stage_attempt_id };
    },
    async reclaimStaleStaged() { return false; },
    async abandonStaged(input) {
      for (const [rowKey, row] of rows.entries()) {
        if (row.stage_attempt_id === input.stage_attempt_id) { rows.delete(rowKey); return true; }
      }
      return false;
    },
    markStored,
    async commitStaged(input) { await input.publishObject(); return markStored(input); },
    async insertStored(input) { rows.set(key(input), { identity: input, record: input.record, state: "stored" }); return { outcome: "stored", record: input.record }; },
    async findByStatus(input) {
      const row = rows.get(key(input));
      if (row === undefined || JSON.stringify(row.record.source) !== JSON.stringify(input.source)) return { outcome: "missing" };
      return lookup(row, input.now);
    },
    async claimGarbage() { return { batch_id: "batch", refs: [] }; },
    async ackGarbage() { return { status: "not_found", refs: [] }; },
    async finalizeGarbage() { return { status: "finalized" }; },
    async reapExpiredGarbageBatches() { return 0; },
  };
}

describe("remote content upload local CAS", () => {
  const roots: string[] = [];
  const services: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.close().catch(() => undefined)));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("keeps upload metadata and CAS references project scoped in the migration", async () => {
    const migration = await readFile(fileURLToPath(new URL("../migrations/025_remote_content_upload_staging.sql", import.meta.url)), "utf8");
    expect(migration).toContain("PRIMARY KEY (project_id, branch_name, actor_id, idempotency_key)");
    expect(migration).toContain("PRIMARY KEY (project_id, content_sha256)");
    expect(migration).toContain("FOREIGN KEY (project_id, content_sha256)");
    expect(migration).toContain("record_json->'source'->>'project_id' = project_id");
  });

  it("streams an attempt into a private file and publishes an idempotent hash object", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "hunter-upload-cas-")), "store");
    roots.push(root);
    const cas = await createRemoteContentUploadLocalCas({ root });
    services.push(cas);
    const bytes = Buffer.from("zip payload streamed without a whole-body buffer");
    const hash = digest(bytes);
    const attempt = await cas.beginAttempt({ project_id: "prj_cas", expected_sha256: hash, expected_bytes: bytes.length });
    await cas.appendAttempt(attempt.attempt_id, bytes.subarray(0, 9));
    await cas.appendAttempt(attempt.attempt_id, bytes.subarray(9));
    const sealed = await cas.sealAttempt(attempt.attempt_id, { expected_sha256: hash, expected_bytes: bytes.length });
    expect(sealed).toMatchObject({ sha256: hash, bytes: bytes.length });
    const published = await cas.publishAttempt(attempt.attempt_id, { project_id: "prj_cas", sha256: hash, bytes: bytes.length });
    expect(published).toMatchObject({ sha256: hash, bytes: bytes.length });
    expect(await cas.hasObject({ project_id: "prj_cas", sha256: hash, bytes: bytes.length })).toBe(true);
    const read: Uint8Array[] = [];
    for await (const chunk of cas.readObject({ project_id: "prj_cas", sha256: hash, bytes: bytes.length })) read.push(chunk);
    expect(Buffer.concat(read.map((chunk) => Buffer.from(chunk)))).toEqual(bytes);
  });

  it("serializes concurrent initialization of the same private CAS root", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "hunter-upload-cas-concurrent-")), "store");
    roots.push(root);
    const [first, second] = await Promise.all([
      createRemoteContentUploadLocalCas({ root }),
      createRemoteContentUploadLocalCas({ root }),
    ]);
    services.push(first, second);
    const bytes = Buffer.from("concurrent root");
    const hash = digest(bytes);
    const attempt = await first.beginAttempt({ project_id: "prj_cas", expected_sha256: hash, expected_bytes: bytes.length });
    await first.appendAttempt(attempt.attempt_id, bytes);
    const sealed = await first.sealAttempt(attempt.attempt_id, { expected_sha256: hash, expected_bytes: bytes.length });
    await first.publishAttempt(attempt.attempt_id, sealed);
    expect(await second.hasObject({ project_id: "prj_cas", sha256: hash, bytes: bytes.length })).toBe(true);
  });

  it("does not reclaim an active attempt owned by another adapter instance", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "hunter-upload-cas-active-")), "store");
    roots.push(root);
    const [first, second] = await Promise.all([
      createRemoteContentUploadLocalCas({ root }),
      createRemoteContentUploadLocalCas({ root }),
    ]);
    services.push(first, second);
    const bytes = Buffer.from("active attempt");
    const hash = digest(bytes);
    const attempt = await first.beginAttempt({ project_id: "prj_cas", expected_sha256: hash, expected_bytes: bytes.length });
    await first.appendAttempt(attempt.attempt_id, bytes);
    const removed = await second.cleanupStaleAttempts({ before: new Date(Date.now() + 60_000).toISOString() });
    expect(removed).toBe(0);
    await expect(first.sealAttempt(attempt.attempt_id, { expected_sha256: hash, expected_bytes: bytes.length }))
      .resolves.toMatchObject({ sha256: hash, bytes: bytes.length });
  });

  it("cleans a crashed attempt through the safe service facade while preserving an active attempt", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "hunter-upload-cas-maintenance-")), "store");
    roots.push(root);
    const crashed = await createRemoteContentUploadLocalCas({ root });
    const staleBytes = Buffer.from("crashed attempt");
    const staleHash = digest(staleBytes);
    const stale = await crashed.beginAttempt({ project_id: "prj_cas", expected_sha256: staleHash, expected_bytes: staleBytes.length });
    await crashed.appendAttempt(stale.attempt_id, staleBytes);
    await crashed.close();

    const reopened = await createRemoteContentUploadLocalCas({ root });
    const activeBytes = Buffer.from("active after restart");
    const activeHash = digest(activeBytes);
    const active = await reopened.beginAttempt({ project_id: "prj_cas", expected_sha256: activeHash, expected_bytes: activeBytes.length });
    await reopened.appendAttempt(active.attempt_id, activeBytes);
    const service = createPgRemoteContentUploadHttpService({ pool: {} as never, cas: reopened,
      records: memoryRecords(), now: () => "2099-08-15T00:00:00.000Z" });
    services.push(service);

    await expect(service.cleanupStaleAttempts()).resolves.toBe(1);
    await expect(reopened.sealAttempt(active.attempt_id, { expected_sha256: activeHash, expected_bytes: activeBytes.length }))
      .resolves.toMatchObject({ sha256: activeHash, bytes: activeBytes.length });
    expect((await readdir(join(root, "attempts"))).filter((name) => name.endsWith(".part"))).toHaveLength(1);
  });

  it("rejects mismatched size/hash and does not publish a partial object", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "hunter-upload-cas-")), "store");
    roots.push(root);
    const cas = await createRemoteContentUploadLocalCas({ root });
    services.push(cas);
    const attempt = await cas.beginAttempt({ project_id: "prj_cas", expected_sha256: digest(Buffer.from("good")), expected_bytes: 4 });
    await cas.appendAttempt(attempt.attempt_id, Buffer.from("bad!"));
    await expect(cas.sealAttempt(attempt.attempt_id, {
      expected_sha256: digest(Buffer.from("good")), expected_bytes: 4
    })).rejects.toThrow(/hash/i);
    expect(await cas.hasObject({ project_id: "prj_cas", sha256: digest(Buffer.from("good")), bytes: 4 })).toBe(false);
  });

  it("binds service replay and conflict to the complete project-scoped identity", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "hunter-upload-service-")), "store");
    roots.push(root);
    const cas = await createRemoteContentUploadLocalCas({ root });
    services.push(cas);
    const records = memoryRecords();
    const service = createPgRemoteContentUploadHttpService({
      pool: {} as never,
      cas,
      records,
      now: () => "2026-08-15T00:00:00.000Z",
    });
    services.push(service);
    const bytes = Buffer.from("service bytes");
    const request = descriptor(bytes);
    const first = await service.stage({ descriptor: request, chunks: chunks(bytes) });
    expect(first.outcome).toBe("new");
    const replay = await service.stage({ descriptor: request, chunks: chunks(bytes) });
    expect(replay.outcome).toBe("replay");
    expect(replay.record.upload_ref).toEqual(first.record.upload_ref);
    const conflictRequest = descriptor(Buffer.from("different"));
    await expect(service.stage({ descriptor: conflictRequest, chunks: chunks(Buffer.from("different")) }))
      .rejects.toMatchObject({ code: "REMOTE_CONTENT_UPLOAD_IDEMPOTENCY_CONFLICT" });
    const status = await service.status({ descriptor: statusDescriptor(request) });
    expect(status).toMatchObject({ state: "stored", record: first.record });
  });

  it("fails with a stable abort code and does not publish an incomplete attempt", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "hunter-upload-abort-")), "store");
    roots.push(root);
    const cas = await createRemoteContentUploadLocalCas({ root });
    services.push(cas);
    const service = createPgRemoteContentUploadHttpService({
      pool: {} as never,
      cas,
      records: memoryRecords(),
      now: () => "2026-08-15T00:00:00.000Z",
    });
    services.push(service);
    const bytes = Buffer.from("aborted");
    const controller = new AbortController();
    controller.abort();
    await expect(service.stage({ descriptor: descriptor(bytes, "b".repeat(64)), chunks: chunks(bytes), signal: controller.signal }))
      .rejects.toMatchObject({ code: "REMOTE_CONTENT_UPLOAD_ABORTED" });
  });

  it("maps storage/database finalization failure without returning an upload reference", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "hunter-upload-db-failure-")), "store");
    roots.push(root);
    const cas = await createRemoteContentUploadLocalCas({ root });
    services.push(cas);
    const service = createPgRemoteContentUploadHttpService({
      pool: {} as never,
      cas,
      records: memoryRecords({ failMark: true }),
      now: () => "2026-08-15T00:00:00.000Z",
    });
    services.push(service);
    const bytes = Buffer.from("database failure");
    await expect(service.stage({ descriptor: descriptor(bytes, "c".repeat(64)), chunks: chunks(bytes) }))
      .rejects.toMatchObject({ code: "REMOTE_UNAVAILABLE" });
  });

  it("recovers a published CAS object after a transient markStored failure", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "hunter-upload-recovery-")), "store");
    roots.push(root);
    const cas = await createRemoteContentUploadLocalCas({ root });
    services.push(cas);
    const records = memoryRecords({ failMarkOnce: true });
    const service = createPgRemoteContentUploadHttpService({ pool: {} as never, cas, records,
      now: () => "2026-08-15T00:00:00.000Z" });
    services.push(service);
    const bytes = Buffer.from("recover after commit");
    const request = descriptor(bytes, "d".repeat(64));
    await expect(service.stage({ descriptor: request, chunks: chunks(bytes) })).rejects.toMatchObject({ code: "REMOTE_UNAVAILABLE" });
    const replay = await service.stage({ descriptor: request, chunks: chunks(bytes) });
    expect(replay.outcome).toBe("replay");
  });
});
