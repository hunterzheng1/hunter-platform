import { createHash } from "node:crypto";
import { isProxy, isUint8Array } from "node:util/types";

import {
  remoteContentUploadHttpRecordHash,
  validateRemoteContentUploadHttpRequestDescriptor,
  validateRemoteContentUploadHttpStatusDescriptor,
  REMOTE_CONTENT_UPLOAD_HTTP_MAX_CHUNK_BYTES,
  REMOTE_CONTENT_UPLOAD_HTTP_MAX_EXPIRY_MS,
  type RemoteContentUploadHttpErrorCode,
  type RemoteContentUploadHttpRecord,
  type RemoteContentUploadHttpRequestDescriptor,
  type RemoteContentUploadHttpSource,
} from "@hunter-harness/contracts";

import type { RemoteContentUploadChunk } from "../remote-content-upload-http/ports.js";
import { PgRemoteContentUploadRecordPort } from "./pg-records.js";
import type {
  RemoteContentUploadCas,
  RemoteContentUploadPgOptions,
  RemoteContentUploadPgService,
  RemoteContentUploadRecordIdentity,
  RemoteContentUploadRecordLookup,
} from "./ports.js";

const STALE_ATTEMPT_MAINTENANCE_INTERVAL_MS = 60_000;

export class RemoteContentUploadServiceError extends Error {
  public readonly code: RemoteContentUploadHttpErrorCode;

  public constructor(code: RemoteContentUploadHttpErrorCode) {
    super(code);
    this.name = "RemoteContentUploadServiceError";
    this.code = code;
  }
}

function fail(code: RemoteContentUploadHttpErrorCode): never {
  throw new RemoteContentUploadServiceError(code);
}

function canonicalNow(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) fail("REMOTE_UNAVAILABLE");
  return new Date(time).toISOString();
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const typedArraySet = Uint8Array.prototype.set;

function chunkBytes(value: unknown): Uint8Array | null {
  if (!isUint8Array(value) || isProxy(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype) return null;
    if (typedArrayByteLength === undefined) return null;
    const length = Reflect.apply(typedArrayByteLength, value, []) as number;
    if (!Number.isSafeInteger(length) || length === 0 || length > REMOTE_CONTENT_UPLOAD_HTTP_MAX_CHUNK_BYTES) return null;
    const owned = new Uint8Array(length);
    Reflect.apply(typedArraySet, owned, [value]);
    return owned;
  } catch {
    return null;
  }
}

function snapshotChunk(value: unknown): RemoteContentUploadChunk | null {
  if (!plainRecord(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const expected = ["sequence", "offset", "size", "chunk_hash", "final", "bytes"];
    if (keys.length !== expected.length || keys.some((key) => typeof key !== "string" || !expected.includes(key))) return null;
    const values: Record<string, unknown> = {};
    for (const key of expected) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) return null;
      values[key] = descriptor.value;
    }
    const bytes = chunkBytes(values.bytes);
    if (bytes === null) return null;
    return Object.freeze({
      sequence: values.sequence as number,
      offset: values.offset as number,
      size: values.size as number,
      chunk_hash: values.chunk_hash as `sha256:${string}`,
      final: values.final as boolean,
      bytes,
    });
  } catch {
    return null;
  }
}

function chunkHash(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sourceFromDescriptor(descriptor: RemoteContentUploadHttpRequestDescriptor): RemoteContentUploadHttpSource {
  const headers = descriptor.headers;
  return Object.freeze({
    project_id: descriptor.path.project_id,
    branch_name: descriptor.path.branch_name,
    actor_id: descriptor.auth.actor_id,
    ...(headers["X-Commit-SHA"] === undefined ? {} : { commit_sha: headers["X-Commit-SHA"] }),
    ...(headers["X-Client-Id"] === undefined ? {} : { client_id: headers["X-Client-Id"] }),
    ...(headers["X-Change-Key"] === undefined ? {} : { change_key: headers["X-Change-Key"] }),
  });
}

function identityFromDescriptor(descriptor: RemoteContentUploadHttpRequestDescriptor, now: string): RemoteContentUploadRecordIdentity {
  const source = sourceFromDescriptor(descriptor);
  return {
    project_id: source.project_id,
    branch_name: source.branch_name,
    actor_id: source.actor_id,
    idempotency_key: descriptor.headers["Idempotency-Key"],
    content_sha256: descriptor.headers["X-Content-SHA256"],
    size_bytes: Number(descriptor.headers["Content-Length"]),
    expires_at: new Date(Date.parse(now) + Number(descriptor.headers["X-Upload-Expires-In-Ms"])).toISOString(),
    source,
  };
}

function uploadToken(identity: RemoteContentUploadRecordIdentity): string {
  const digest = createHash("sha256").update(JSON.stringify([
    identity.project_id, identity.branch_name, identity.actor_id, identity.idempotency_key,
    identity.content_sha256, identity.size_bytes, identity.expires_at, identity.source.commit_sha ?? null,
    identity.source.client_id ?? null, identity.source.change_key ?? null,
  ])).digest("base64url");
  return digest;
}

function recordFor(identity: RemoteContentUploadRecordIdentity, createdAt: string): RemoteContentUploadHttpRecord {
  const token = uploadToken(identity);
  const body = {
    schema_version: 1 as const,
    upload_id: `remote_content_upload:${token}`,
    source: identity.source,
    idempotency_key: identity.idempotency_key,
    purpose: "remote_archive" as const,
    content_sha256: identity.content_sha256,
    size_bytes: identity.size_bytes,
    upload_ref: { ref_id: `bounded_upload:${token}`, sha256: identity.content_sha256, size_bytes: identity.size_bytes },
    state: "stored" as const,
    created_at: createdAt,
    expires_at: identity.expires_at,
  };
  return Object.freeze({ ...body, record_hash: remoteContentUploadHttpRecordHash(body) });
}

function resultFor(record: RemoteContentUploadHttpRecord, outcome: "new" | "replay") {
  return Object.freeze({ outcome, upload_ref: Object.freeze({ ...record.upload_ref }), record });
}

function statusFor(lookup: RemoteContentUploadRecordLookup) {
  if (lookup.outcome === "missing" || lookup.outcome === "staged") {
    return Object.freeze({ state: "unknown" as const, record: null });
  }
  if (lookup.outcome === "expired") return Object.freeze({ state: "expired" as const, record: lookup.record });
  if (lookup.outcome === "conflict") fail("REMOTE_CONTENT_UPLOAD_IDEMPOTENCY_CONFLICT");
  return Object.freeze({ state: "stored" as const, record: lookup.record });
}

async function consumeChunks(
  chunks: AsyncIterable<RemoteContentUploadChunk>,
  expected: { readonly sha256: string; readonly bytes: number },
  signal: AbortSignal | undefined,
  cas: RemoteContentUploadCas | null,
  attemptId: string | null,
): Promise<void> {
  const digest = createHash("sha256");
  let sequence = 0;
  let offset = 0;
  let final = false;
  // There is no protocol-level chunk-count limit: every chunk must carry at
  // least one byte, so the declared byte budget itself is the strict upper
  // bound.  The HTTP adapter coalesces transport chunks, while this service
  // remains correct for any valid bounded AsyncIterable caller.
  const maxChunks = expected.bytes;
  try {
    for await (const raw of chunks) {
      if (signal?.aborted === true) fail("REMOTE_CONTENT_UPLOAD_ABORTED");
      if (final) fail("REMOTE_CONTENT_UPLOAD_STREAM_INVALID");
      if (sequence >= maxChunks) fail("REMOTE_CONTENT_UPLOAD_STREAM_INVALID");
      const chunk = snapshotChunk(raw);
      if (chunk === null) fail("REMOTE_CONTENT_UPLOAD_STREAM_INVALID");
      const bytes = chunk.bytes;
      if (!Number.isSafeInteger(chunk.sequence) || !Number.isSafeInteger(chunk.offset) ||
          !Number.isSafeInteger(chunk.size) || chunk.sequence !== sequence || chunk.offset !== offset ||
          chunk.size !== bytes.byteLength || chunk.chunk_hash !== chunkHash(bytes) ||
          chunk.final !== (offset + bytes.byteLength === expected.bytes)) {
        fail("REMOTE_CONTENT_UPLOAD_STREAM_INVALID");
      }
      if (offset + bytes.byteLength > expected.bytes) fail("REMOTE_CONTENT_UPLOAD_SIZE_MISMATCH");
      digest.update(bytes);
      if (cas !== null && attemptId !== null) await cas.appendAttempt(attemptId, bytes);
      offset += bytes.byteLength;
      sequence += 1;
      final = chunk.final;
    }
  } catch (error) {
    if (error instanceof RemoteContentUploadServiceError) throw error;
    fail("REMOTE_CONTENT_UPLOAD_STREAM_INVALID");
  }
  if (!final || offset !== expected.bytes || `sha256:${digest.digest("hex")}` !== expected.sha256) {
    fail(offset !== expected.bytes ? "REMOTE_CONTENT_UPLOAD_SIZE_MISMATCH" : "REMOTE_CONTENT_UPLOAD_HASH_MISMATCH");
  }
}

export function createPgRemoteContentUploadHttpService(options: RemoteContentUploadPgOptions): RemoteContentUploadPgService {
  const records = options.records ?? new PgRemoteContentUploadRecordPort(options.pool);
  const now = options.now ?? (() => new Date().toISOString());
  const cas = options.cas;
  let closed = false;
  let nextAttemptCleanupAt = Number.NEGATIVE_INFINITY;
  let attemptCleanup: Promise<number> | null = null;
  const assertOpen = (): void => { if (closed) fail("REMOTE_UNAVAILABLE"); };
  const cleanupAttemptsAt = async (at: string, force: boolean): Promise<number> => {
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs)) fail("REMOTE_UNAVAILABLE");
    if (!force && atMs < nextAttemptCleanupAt) return 0;
    if (attemptCleanup !== null) return attemptCleanup;
    const before = new Date(atMs - REMOTE_CONTENT_UPLOAD_HTTP_MAX_EXPIRY_MS).toISOString();
    nextAttemptCleanupAt = atMs + STALE_ATTEMPT_MAINTENANCE_INTERVAL_MS;
    let pending: Promise<number>;
    try {
      pending = cas.cleanupStaleAttempts({ before });
    } catch {
      nextAttemptCleanupAt = Number.NEGATIVE_INFINITY;
      fail("REMOTE_UNAVAILABLE");
    }
    attemptCleanup = pending;
    try {
      return await pending;
    } catch {
      nextAttemptCleanupAt = Number.NEGATIVE_INFINITY;
      fail("REMOTE_UNAVAILABLE");
    } finally {
      if (attemptCleanup === pending) attemptCleanup = null;
    }
  };
  const service: RemoteContentUploadPgService = {
    async stage(input) {
      assertOpen();
      const descriptorResult = validateRemoteContentUploadHttpRequestDescriptor(input.descriptor);
      if (!descriptorResult.success) fail("REMOTE_CONTENT_UPLOAD_INPUT_INVALID");
      const descriptor = descriptorResult.data;
      const createdAt = canonicalNow(now());
      await cleanupAttemptsAt(createdAt, false);
      const identity = identityFromDescriptor(descriptor, createdAt);
      await records.reclaimStaleStaged({ project_id: identity.project_id, branch_name: identity.branch_name,
        actor_id: identity.actor_id, idempotency_key: identity.idempotency_key, now: createdAt });
      const existing = await records.findByIdentity({ ...identity, now: createdAt });
      if (existing.outcome === "stored") {
        await consumeChunks(input.chunks, { sha256: identity.content_sha256, bytes: identity.size_bytes }, input.signal, null, null);
        return resultFor(existing.record, "replay");
      }
      if (existing.outcome === "expired") {
        await consumeChunks(input.chunks, { sha256: identity.content_sha256, bytes: identity.size_bytes }, input.signal, null, null);
        fail("REMOTE_CONTENT_UPLOAD_EXPIRED");
      }
      if (existing.outcome === "conflict") {
        await consumeChunks(input.chunks, { sha256: identity.content_sha256, bytes: identity.size_bytes }, input.signal, null, null);
        fail("REMOTE_CONTENT_UPLOAD_IDEMPOTENCY_CONFLICT");
      }
      if (existing.outcome === "staged") {
        // A previous worker may have published the object and then lost the
        // database transaction before markStored.  The durable staged row is
        // the recovery record; promote it only after the CAS verifies the
        // exact project/hash/size, then consume this request as a replay.
        if (existing.stage_attempt_id !== undefined && await cas.hasObject({
          project_id: identity.project_id, sha256: identity.content_sha256 as `sha256:${string}`, bytes: identity.size_bytes,
        })) {
          const recovered = await records.markStored({
            project_id: identity.project_id, branch_name: identity.branch_name, actor_id: identity.actor_id,
            idempotency_key: identity.idempotency_key, stage_attempt_id: existing.stage_attempt_id,
            now: canonicalNow(now()), record: existing.record,
          });
          if (recovered.outcome === "stored") {
            await consumeChunks(input.chunks, { sha256: identity.content_sha256, bytes: identity.size_bytes }, input.signal, null, null);
            return resultFor(recovered.record, "replay");
          }
        }
        await consumeChunks(input.chunks, { sha256: identity.content_sha256, bytes: identity.size_bytes }, input.signal, null, null);
        fail("REMOTE_UNAVAILABLE");
      }
      const record = recordFor(identity, createdAt);
      const stageLeaseUntil = identity.expires_at;
      const attempt = await cas.beginAttempt({ project_id: identity.project_id,
        expected_sha256: identity.content_sha256, expected_bytes: identity.size_bytes });
      let retained = false;
      let staged = false;
      let publishAttempted = false;
      try {
        const claimed = await records.insertStaged({ ...identity, created_at: createdAt, upload_id: record.upload_id,
          upload_ref: record.upload_ref, stage_attempt_id: attempt.attempt_id,
          stage_lease_until: stageLeaseUntil, record });
        if (claimed.outcome === "conflict" || claimed.outcome === "expired") {
          await cas.abortAttempt(attempt.attempt_id);
          await consumeChunks(input.chunks, { sha256: identity.content_sha256, bytes: identity.size_bytes }, input.signal, null, null);
          fail(claimed.outcome === "expired" ? "REMOTE_CONTENT_UPLOAD_EXPIRED" : "REMOTE_CONTENT_UPLOAD_IDEMPOTENCY_CONFLICT");
        }
        if (claimed.outcome === "staged" && claimed.stage_attempt_id !== attempt.attempt_id) {
          await cas.abortAttempt(attempt.attempt_id);
          await consumeChunks(input.chunks, { sha256: identity.content_sha256, bytes: identity.size_bytes }, input.signal, null, null);
          fail("REMOTE_UNAVAILABLE");
        }
        if (claimed.outcome === "stored") {
          await cas.abortAttempt(attempt.attempt_id);
          await consumeChunks(input.chunks, { sha256: identity.content_sha256, bytes: identity.size_bytes }, input.signal, null, null);
          return resultFor(claimed.record, "replay");
        }
        staged = true;
        await consumeChunks(input.chunks, { sha256: identity.content_sha256, bytes: identity.size_bytes }, input.signal, cas, attempt.attempt_id);
        const sealed = await cas.sealAttempt(attempt.attempt_id, { expected_sha256: identity.content_sha256, expected_bytes: identity.size_bytes });
        // From this point the CAS operation is an ambiguous commit: an
        // implementation may publish the object and then fail while cleaning
        // its attempt bookkeeping.  Keep the durable staged row until a
        // recovery pass can verify the object instead of deleting its only
        // metadata handoff.
        const completedAt = canonicalNow(now());
        const stored = await records.commitStaged({ project_id: identity.project_id, actor_id: identity.actor_id,
          branch_name: identity.branch_name, idempotency_key: identity.idempotency_key,
          stage_attempt_id: attempt.attempt_id, now: completedAt, record,
          publishObject: async () => {
            publishAttempted = true;
            await cas.publishAttempt(attempt.attempt_id, sealed);
          } });
        if (stored.outcome !== "stored") {
          if (stored.outcome === "conflict") fail("REMOTE_CONTENT_UPLOAD_IDEMPOTENCY_CONFLICT");
          if (stored.outcome === "expired" || Date.parse(completedAt) >= Date.parse(identity.expires_at)) {
            fail("REMOTE_CONTENT_UPLOAD_EXPIRED");
          }
          fail("REMOTE_UNAVAILABLE");
        }
        retained = true;
        return resultFor(stored.record, "new");
      } catch (error) {
        // Once the CAS object is published, retain the staged row as a
        // durable recovery handoff.  Deleting it here would strand an object
        // with no metadata after a transient markStored/DB failure.
        if (staged && !publishAttempted) {
          await records.abandonStaged({ project_id: identity.project_id, branch_name: identity.branch_name,
            actor_id: identity.actor_id, idempotency_key: identity.idempotency_key,
            stage_attempt_id: attempt.attempt_id }).catch(() => undefined);
        }
        if (!retained) await cas.abortAttempt(attempt.attempt_id).catch(() => undefined);
        if (error instanceof RemoteContentUploadServiceError) throw error;
        fail("REMOTE_UNAVAILABLE");
      }
    },
    async status(input) {
      assertOpen();
      const descriptorResult = validateRemoteContentUploadHttpStatusDescriptor(input.descriptor);
      if (!descriptorResult.success) fail("REMOTE_CONTENT_UPLOAD_INPUT_INVALID");
      const descriptor = descriptorResult.data;
      const source: RemoteContentUploadHttpSource = {
        project_id: descriptor.path.project_id,
        branch_name: descriptor.path.branch_name,
        actor_id: descriptor.auth.actor_id,
        ...(descriptor.headers["X-Commit-SHA"] === undefined ? {} : { commit_sha: descriptor.headers["X-Commit-SHA"] }),
        ...(descriptor.headers["X-Client-Id"] === undefined ? {} : { client_id: descriptor.headers["X-Client-Id"] }),
        ...(descriptor.headers["X-Change-Key"] === undefined ? {} : { change_key: descriptor.headers["X-Change-Key"] }),
      };
      const lookup = await records.findByStatus({ project_id: source.project_id, branch_name: source.branch_name,
        actor_id: source.actor_id, idempotency_key: descriptor.headers["Idempotency-Key"], source, now: canonicalNow(now()) });
      return statusFor(lookup);
    },
    async claimGarbage(input) {
      assertOpen();
      await cleanupAttemptsAt(canonicalNow(input.now), false);
      await records.reapExpiredGarbageBatches({ project_id: input.project_id, now: input.now, limit: 32 });
      return records.claimGarbage(input);
    },
    async acknowledgeGarbage(input) {
      assertOpen();
      const result = await records.ackGarbage(input);
      if (result.status === "acked") {
        try {
          const finalized = await records.finalizeGarbage({ project_id: input.project_id,
            batch_id: input.batch_id, worker_id: input.worker_id,
            removeObject: (ref) => cas.removeObject(ref) });
          if (finalized.status !== "finalized") fail("REMOTE_UNAVAILABLE");
        } catch (error) {
          if (error instanceof RemoteContentUploadServiceError) throw error;
          fail("REMOTE_UNAVAILABLE");
        }
      }
      return result;
    },
    async cleanupStaleAttempts() {
      assertOpen();
      return cleanupAttemptsAt(canonicalNow(now()), true);
    },
    async close() {
      if (closed) return;
      closed = true;
      await cas.close();
    },
  };
  return Object.freeze(service);
}
