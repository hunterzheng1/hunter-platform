import { createHash } from "node:crypto";

import {
  type RemoteContentUploadHttpRecord,
  type RemoteContentUploadHttpRequestDescriptor,
} from "@hunter-harness/contracts";
import { describe, expect, it } from "vitest";

import {
  createPgRemoteContentUploadHttpService,
} from "../src/remote-content-upload-pg/service.js";
import type {
  RemoteContentUploadCas,
  RemoteContentUploadRecordIdentity,
  RemoteContentUploadRecordLookup,
  RemoteContentUploadRecordPort,
} from "../src/remote-content-upload-pg/ports.js";

const bytesHash = (bytes: Uint8Array): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const token = "a".repeat(64);

function descriptor(bytes: Uint8Array, overrides: Partial<RemoteContentUploadHttpRequestDescriptor> = {}): RemoteContentUploadHttpRequestDescriptor {
  return {
    schema_version: 1,
    purpose: "remote_archive",
    path: { project_id: "prj_upload", branch_name: "main" },
    auth: { actor_id: "actor_upload" },
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(bytes.length),
      "Idempotency-Key": `sha256:${token}`,
      "X-Content-SHA256": bytesHash(bytes),
      "X-Upload-Expires-In-Ms": "60000",
    },
    body_stream: {
      kind: "single_binary_stream", media_type: "application/zip", content_encoding: "identity",
      content_length_bytes: bytes.length, content_sha256: bytesHash(bytes), max_chunk_bytes: 1_048_576,
    },
    ...overrides,
  };
}

function chunks(bytes: Uint8Array, signal?: { readonly aborted: boolean }): AsyncIterable<{
  readonly sequence: number; readonly offset: number; readonly size: number; readonly chunk_hash: `sha256:${string}`;
  readonly final: boolean; readonly bytes: Uint8Array;
}> {
  return (async function* () {
    const first = bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2)));
    const second = bytes.subarray(first.length);
    for (const [sequence, value] of [first, second].entries()) {
      if (signal?.aborted === true) return;
      yield { sequence, offset: sequence === 0 ? 0 : first.length, size: value.length,
        chunk_hash: bytesHash(value), final: sequence === 1, bytes: value };
    }
  })();
}

function makeCas(options: { readonly publishAfterCommitThrows?: boolean } = {}): RemoteContentUploadCas & { readonly published: Set<string>; readonly aborted: string[] } {
  const attempts = new Map<string, Uint8Array[] | null>();
  const published = new Set<string>();
  const aborted: string[] = [];
  let next = 0;
  return {
    published, aborted,
    async beginAttempt() { const id = `attempt_${String(++next).padStart(32, "0")}`; attempts.set(id, []); return { attempt_id: id }; },
    async appendAttempt(id, bytes) { attempts.get(id)?.push(new Uint8Array(bytes)); },
    async abortAttempt(id) { aborted.push(id); attempts.delete(id); },
    async sealAttempt(id, expected) {
      const data = Buffer.concat((attempts.get(id) ?? []).map((part) => Buffer.from(part)));
      if (data.length !== expected.expected_bytes || bytesHash(data) !== expected.expected_sha256) throw new Error("REMOTE_CONTENT_UPLOAD_HASH_MISMATCH");
      return { project_id: "prj_upload", sha256: expected.expected_sha256 as `sha256:${string}`, bytes: data.length };
    },
    async publishAttempt(id, expected) {
      published.add(expected.sha256); attempts.delete(id);
      if (options.publishAfterCommitThrows === true) throw new Error("post-publish bookkeeping failed");
      return expected;
    },
    async hasObject(input) { return published.has(input.sha256); },
    async *readObject() { yield new Uint8Array(); },
    async cleanupStaleAttempts() { return 0; },
    async close() { /* no-op */ },
  };
}

function makeRecords(options: { failInsert?: boolean } = {}): RemoteContentUploadRecordPort & { readonly values: Map<string, RemoteContentUploadHttpRecord> } {
  const values = new Map<string, RemoteContentUploadHttpRecord>();
  const keyOf = (input: { project_id: string; actor_id: string; idempotency_key: string }): string =>
    `${input.project_id}\0${input.actor_id}\0${input.idempotency_key}`;
  const lookup = (record: RemoteContentUploadHttpRecord | undefined, input: RemoteContentUploadRecordIdentity, now: string): RemoteContentUploadRecordLookup => {
    if (record === undefined) return { outcome: "missing" };
    if (record.content_sha256 !== input.content_sha256 || record.size_bytes !== input.size_bytes ||
        record.source.branch_name !== input.branch_name) return { outcome: "conflict", record };
    if (Date.parse(record.expires_at) <= Date.parse(now)) return { outcome: "expired", record };
    return { outcome: "stored", record };
  };
  return {
    values,
    async findByIdentity(input) { return lookup(values.get(keyOf(input)), input, input.now); },
    async findByStatus(input) {
      const record = values.get(keyOf(input));
      if (record === undefined) return { outcome: "missing" };
      if (Date.parse(record.expires_at) <= Date.parse(input.now)) return { outcome: "expired", record };
      return { outcome: "stored", record };
    },
    async insertStaged(input) {
      if (options.failInsert) throw new Error("database down");
      const key = keyOf(input); const existing = values.get(key);
      if (existing !== undefined) return { outcome: "conflict", record: existing };
      values.set(key, input.record); return { outcome: "staged", record: input.record, stage_attempt_id: input.stage_attempt_id };
    },
    async reclaimStaleStaged() { return false; },
    async abandonStaged(input) {
      const key = keyOf(input);
      const existed = values.delete(key);
      return existed;
    },
    async markStored(input) { const record = values.get(keyOf(input)); return record === undefined ? { outcome: "missing" } : { outcome: "stored", record }; },
    async commitStaged(input) {
      await input.publishObject();
      const record = values.get(keyOf(input));
      return record === undefined ? { outcome: "missing" } : { outcome: "stored", record };
    },
    async insertStored(input) { values.set(keyOf(input), input.record); return { outcome: "stored", record: input.record }; },
    async claimGarbage() { return { batch_id: "remote_content_upload_gc:" + "c".repeat(43), refs: [] }; },
    async ackGarbage() { return { status: "acked", refs: [] }; },
    async finalizeGarbage() { return { status: "finalized" }; },
    async reapExpiredGarbageBatches() { return 0; },
  };
}

describe("Pg remote content upload service", () => {
  it("publishes once and replays the same identity without a second CAS publish", async () => {
    const bytes = Buffer.from("streamed archive"); const cas = makeCas(); const records = makeRecords();
    const service = createPgRemoteContentUploadHttpService({ pool: {} as never, cas, records,
      now: () => "2026-08-15T00:00:00.000Z" });
    const request = descriptor(bytes);
    const first = await service.stage({ descriptor: request, chunks: chunks(bytes) });
    const second = await service.stage({ descriptor: request, chunks: chunks(bytes) });
    expect(first.outcome).toBe("new"); expect(second.outcome).toBe("replay"); expect(cas.published.size).toBe(1);
  });

  it("persists raw Remote Sync file uploads under an exact purpose identity", async () => {
    const bytes = Buffer.from("remote sync file", "utf8");
    const cas = makeCas();
    const records = makeRecords();
    const service = createPgRemoteContentUploadHttpService({ pool: {} as never, cas, records,
      now: () => "2026-08-15T00:00:00.000Z" });
    const base = descriptor(bytes);
    const request = descriptor(bytes, {
      purpose: "remote_sync_file",
      headers: { ...base.headers, "Content-Type": "application/octet-stream" },
      body_stream: { ...base.body_stream, media_type: "application/octet-stream" },
    });

    const result = await service.stage({ descriptor: request, chunks: chunks(bytes) });

    expect(result.record.purpose).toBe("remote_sync_file");
    expect([...records.values.values()]).toHaveLength(1);
    expect([...records.values.values()][0]?.purpose).toBe("remote_sync_file");
  });

  it("keeps a 15-minute upload claim live through a valid 11-minute stream", async () => {
    const bytes = Buffer.from("slow streamed archive");
    const cas = makeCas();
    const records = makeRecords();
    let stageLeaseUntil: string | null = null;
    const leaseAwareRecords: RemoteContentUploadRecordPort = {
      ...records,
      async insertStaged(input) {
        stageLeaseUntil = input.stage_lease_until;
        return records.insertStaged(input);
      },
      async markStored(input) {
        if (stageLeaseUntil === null || Date.parse(input.now) >= Date.parse(stageLeaseUntil)) {
          return { outcome: "missing" };
        }
        return records.markStored(input);
      },
    };
    const times = ["2026-08-15T00:00:00.000Z", "2026-08-15T00:11:00.000Z"] as const;
    let timeIndex = 0;
    const service = createPgRemoteContentUploadHttpService({ pool: {} as never, cas, records: leaseAwareRecords,
      now: () => times[timeIndex++] ?? times[1] });
    const base = descriptor(bytes);
    const request = descriptor(bytes, { headers: { ...base.headers, "X-Upload-Expires-In-Ms": "900000" } });

    const result = await service.stage({ descriptor: request, chunks: chunks(bytes) });

    expect(result.outcome).toBe("new");
    expect(stageLeaseUntil).toBe("2026-08-15T00:15:00.000Z");
  });

  it("runs bounded stale-attempt maintenance before opening a new upload", async () => {
    const bytes = Buffer.from("maintained stream");
    const baseCas = makeCas();
    const cleanups: string[] = [];
    const cas: RemoteContentUploadCas = {
      ...baseCas,
      async cleanupStaleAttempts(input) { cleanups.push(input.before); return 0; },
    };
    const service = createPgRemoteContentUploadHttpService({ pool: {} as never, cas, records: makeRecords(),
      now: () => "2026-08-15T00:00:00.000Z" });

    await service.stage({ descriptor: descriptor(bytes), chunks: chunks(bytes) });

    expect(cleanups).toEqual(["2026-08-14T23:45:00.000Z"]);
  });

  it("does not publish a 1ms-TTL upload after GC wins the durable object fence", async () => {
    const bytes = Buffer.from("late publisher");
    const cas = makeCas();
    const baseRecords = makeRecords();
    let enterFence: (() => void) | undefined;
    const fenceEntered = new Promise<void>((resolve) => { enterFence = resolve; });
    let releaseFence: (() => void) | undefined;
    const fenceReleased = new Promise<void>((resolve) => { releaseFence = resolve; });
    const records = {
      ...baseRecords,
      async commitStaged(input: Parameters<RemoteContentUploadRecordPort["markStored"]>[0] & {
        readonly publishObject: () => Promise<void>;
      }) {
        enterFence?.();
        await fenceReleased;
        return { outcome: "staged" as const, record: input.record, stage_attempt_id: input.stage_attempt_id };
      },
    };
    const times = ["2026-08-15T00:00:00.000Z", "2026-08-15T00:00:00.002Z"] as const;
    let timeIndex = 0;
    const service = createPgRemoteContentUploadHttpService({ pool: {} as never, cas, records,
      now: () => times[timeIndex++] ?? times[1] });
    const base = descriptor(bytes);
    const request = descriptor(bytes, { headers: { ...base.headers, "X-Upload-Expires-In-Ms": "1" } });
    const stage = service.stage({ descriptor: request, chunks: chunks(bytes) });

    const winner = await Promise.race([
      fenceEntered.then(() => "fence" as const),
      stage.then(() => "stage" as const, () => "stage" as const),
    ]);
    expect(winner).toBe("fence");
    releaseFence?.();
    await expect(stage).rejects.toMatchObject({ code: "REMOTE_CONTENT_UPLOAD_EXPIRED" });
    expect(cas.published.size).toBe(0);
  });

  it("rejects chunk accessors before executing them", async () => {
    const bytes = Buffer.from("hostile chunk"); const cas = makeCas(); const records = makeRecords();
    const service = createPgRemoteContentUploadHttpService({ pool: {} as never, cas, records,
      now: () => "2026-08-15T00:00:00.000Z" });
    const request = descriptor(bytes, { headers: { ...descriptor(bytes).headers, "Idempotency-Key": `sha256:${"d".repeat(64)}` } });
    let reads = 0;
    const hostile = { sequence: 0, offset: 0, size: bytes.length, chunk_hash: bytesHash(bytes), final: true } as Record<string, unknown>;
    Object.defineProperty(hostile, "bytes", { get() { reads += 1; throw new Error("secret"); }, enumerable: true });
    await expect(service.stage({ descriptor: request, chunks: (async function* () { yield hostile; })() }))
      .rejects.toMatchObject({ code: "REMOTE_CONTENT_UPLOAD_STREAM_INVALID" });
    expect(reads).toBe(0);
  });

  it("rejects zero-length chunks before they can stall a bounded stream", async () => {
    const bytes = Buffer.from("nonempty"); const cas = makeCas(); const records = makeRecords();
    const service = createPgRemoteContentUploadHttpService({ pool: {} as never, cas, records,
      now: () => "2026-08-15T00:00:00.000Z" });
    const request = descriptor(bytes, { headers: { ...descriptor(bytes).headers, "Idempotency-Key": `sha256:${"e".repeat(64)}` } });
    const zero = new Uint8Array(0);
    await expect(service.stage({ descriptor: request, chunks: (async function* () {
      yield { sequence: 0, offset: 0, size: 0, chunk_hash: bytesHash(zero), final: false, bytes: zero };
    })() })).rejects.toMatchObject({ code: "REMOTE_CONTENT_UPLOAD_STREAM_INVALID" });
  });

  it("abandons a staged row when stream validation fails before CAS publish", async () => {
    const bytes = Buffer.from("bad stream"); const cas = makeCas(); const records = makeRecords();
    const service = createPgRemoteContentUploadHttpService({ pool: {} as never, cas, records,
      now: () => "2026-08-15T00:00:00.000Z" });
    const request = descriptor(bytes, { headers: { ...descriptor(bytes).headers, "Idempotency-Key": `sha256:${"2".repeat(64)}` } });
    await expect(service.stage({ descriptor: request, chunks: (async function* () {
      yield { sequence: 0, offset: 0, size: bytes.length, chunk_hash: bytesHash(Buffer.from("wrong")), final: true, bytes };
    })() })).rejects.toMatchObject({ code: "REMOTE_CONTENT_UPLOAD_STREAM_INVALID" });
    expect(records.values.size).toBe(0);
  });

  it("consumes a conflicting body then returns a stable idempotency conflict", async () => {
    const bytes = Buffer.from("first"); const other = Buffer.from("other"); const cas = makeCas(); const records = makeRecords();
    const service = createPgRemoteContentUploadHttpService({ pool: {} as never, cas, records,
      now: () => "2026-08-15T00:00:00.000Z" });
    await service.stage({ descriptor: descriptor(bytes), chunks: chunks(bytes) });
    const conflicting = descriptor(other, { headers: { ...descriptor(other).headers, "Content-Length": String(other.length),
      "Idempotency-Key": `sha256:${token}`, "X-Content-SHA256": bytesHash(other) }, body_stream: {
        ...descriptor(other).body_stream, content_length_bytes: other.length, content_sha256: bytesHash(other)
      } });
    await expect(service.stage({ descriptor: conflicting, chunks: chunks(other) })).rejects.toMatchObject({ code: "REMOTE_CONTENT_UPLOAD_IDEMPOTENCY_CONFLICT" });
  });

  it("retains a durable staged handoff when CAS publish commits before throwing", async () => {
    const bytes = Buffer.from("publish then throw");
    const cas = makeCas({ publishAfterCommitThrows: true });
    const records = makeRecords();
    const service = createPgRemoteContentUploadHttpService({ pool: {} as never, cas, records,
      now: () => "2026-08-15T00:00:00.000Z" });
    const request = descriptor(bytes, { headers: { ...descriptor(bytes).headers, "Idempotency-Key": `sha256:${"f".repeat(64)}` } });
    await expect(service.stage({ descriptor: request, chunks: chunks(bytes) })).rejects.toMatchObject({ code: "REMOTE_UNAVAILABLE" });
    expect(records.values.size).toBe(1);
    const replay = await service.stage({ descriptor: request, chunks: chunks(bytes) });
    expect(replay.outcome).toBe("replay");
  });

  it("accepts more than one thousand valid non-empty chunks within the byte budget", async () => {
    const bytes = new Uint8Array(1_025).fill(7);
    const cas = makeCas();
    const records = makeRecords();
    const service = createPgRemoteContentUploadHttpService({ pool: {} as never, cas, records,
      now: () => "2026-08-15T00:00:00.000Z" });
    const request = descriptor(bytes, { headers: { ...descriptor(bytes).headers, "Idempotency-Key": `sha256:${"1".repeat(64)}` } });
    const stream = (async function* () {
      for (let index = 0; index < bytes.length; index += 1) {
        const byte = bytes.subarray(index, index + 1);
        yield { sequence: index, offset: index, size: 1, chunk_hash: bytesHash(byte), final: index === bytes.length - 1, bytes: byte };
      }
    })();
    const result = await service.stage({ descriptor: request, chunks: stream });
    expect(result.outcome).toBe("new");
  });

  it("does not publish or retain a CAS attempt when the durable claim fails", async () => {
    const bytes = Buffer.from("database failure"); const cas = makeCas();
    const service = createPgRemoteContentUploadHttpService({ pool: {} as never, cas, records: makeRecords({ failInsert: true }),
      now: () => "2026-08-15T00:00:00.000Z" });
    await expect(service.stage({ descriptor: descriptor(bytes), chunks: chunks(bytes) })).rejects.toMatchObject({ code: "REMOTE_UNAVAILABLE" });
    expect(cas.published.size).toBe(0); expect(cas.aborted).toHaveLength(1);
  });

  it("maps cancellation before persistence to REMOTE_CONTENT_UPLOAD_ABORTED", async () => {
    const bytes = Buffer.from("abort me"); const cas = makeCas(); const records = makeRecords();
    const service = createPgRemoteContentUploadHttpService({ pool: {} as never, cas, records,
      now: () => "2026-08-15T00:00:00.000Z" });
    const signal = { aborted: true } as AbortSignal;
    await expect(service.stage({ descriptor: descriptor(bytes), chunks: chunks(bytes), signal })).rejects.toMatchObject({ code: "REMOTE_CONTENT_UPLOAD_ABORTED" });
    expect(cas.published.size).toBe(0);
  });
});
