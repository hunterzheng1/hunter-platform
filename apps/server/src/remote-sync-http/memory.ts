import { createHash, randomBytes } from "node:crypto";
import {
  canonicalJson,
  type RemoteSyncContentChunk,
  type RemoteSyncLease,
  type RemoteSyncPreparedPush,
  type RemoteSyncPullReceipt,
  type RemoteSyncPushStatus,
  type RemoteSyncPushReceiptHttp,
  type RemoteSyncRemoteFileMetadata,
  type RemoteSyncRemoteSnapshot,
  type RemoteSyncSourceRef,
  type RemoteSyncOperation,
  type RemoteSyncPushPrepareHttpRequest,
  type RemoteSyncPushCommitHttpRequest
} from "@hunter-harness/contracts";

import type {
  RemoteSyncHttpContentStream,
  RemoteSyncHttpServicePort,
  RemoteSyncIdempotencyResult
} from "./ports.js";

type Keyed<T> = { fingerprint: string; value: T };

class MemoryRemoteSyncError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable = false) {
    super(code);
    this.name = "MemoryRemoteSyncError";
    this.code = code;
    this.retryable = retryable;
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function hash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function token(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function branchKey(source: RemoteSyncSourceRef): string {
  return JSON.stringify([source.project_id, source.branch_name]);
}

function actorKey(source: RemoteSyncSourceRef, idempotencyKey: string): string {
  return JSON.stringify([source.project_id, source.branch_name, source.actor_id, idempotencyKey]);
}

function result<T>(
  records: Map<string, Keyed<T>>,
  key: string,
  fingerprint: string,
  value: T
): RemoteSyncIdempotencyResult<T> {
  const prior = records.get(key);
  if (prior !== undefined) {
    return prior.fingerprint === fingerprint
      ? { outcome: "replay", value: clone(prior.value) }
      : { outcome: "conflict", error: { code: "SYNC_IDEMPOTENCY_CONFLICT", retryable: false } };
  }
  records.set(key, { fingerprint, value: clone(value) });
  return { outcome: "new", value: clone(value) };
}

interface StoredSnapshot {
  snapshot: RemoteSyncRemoteSnapshot;
  files: Map<string, RemoteSyncRemoteFileMetadata>;
}

interface StoredPrepare {
  request: RemoteSyncPushPrepareHttpRequest;
  prepared: RemoteSyncPreparedPush;
  state: RemoteSyncPushStatus["state"];
  receipt?: RemoteSyncPushReceiptHttp;
}

/**
 * A deliberately small, transport-neutral reference. It is suitable for
 * route tests and zero-byte fixtures; production must inject its own service.
 */
export class MemoryRemoteSyncHttpService implements RemoteSyncHttpServicePort {
  readonly #leases = new Map<string, RemoteSyncLease>();
  readonly #generations = new Map<string, number>();
  readonly #snapshots = new Map<string, StoredSnapshot>();
  readonly #preparesByKey = new Map<string, Keyed<RemoteSyncPreparedPush>>();
  readonly #preparesById = new Map<string, StoredPrepare>();
  readonly #commits = new Map<string, Keyed<RemoteSyncPushReceiptHttp>>();
  readonly #statuses = new Map<string, RemoteSyncPushStatus>();
  readonly #receiptsByPrepare = new Map<string, RemoteSyncPushReceiptHttp>();
  readonly #leaseAcquires = new Map<string, Keyed<RemoteSyncLease>>();
  readonly #leaseRenews = new Map<string, Keyed<RemoteSyncLease>>();
  readonly #leaseReleases = new Map<string, Keyed<void>>();
  readonly #pulls = new Map<string, Keyed<RemoteSyncPullReceipt>>();

  async acquireLease(input: {
    source: RemoteSyncSourceRef;
    ttl_ms?: number;
    idempotency_key: string;
  }): Promise<RemoteSyncIdempotencyResult<RemoteSyncLease>> {
    const key = actorKey(input.source, input.idempotency_key);
    const fingerprint = hash({ source: input.source, ttl_ms: input.ttl_ms ?? null });
    const prior = this.#leaseAcquires.get(key);
    if (prior !== undefined) return result(this.#leaseAcquires, key, fingerprint, prior.value);
    const branch = branchKey(input.source);
    const active = this.#leases.get(branch);
    if (active !== undefined && Date.parse(active.expires_at) > Date.now()) {
      throw new MemoryRemoteSyncError("SYNC_LEASE_BUSY", true);
    }
    const generation = (this.#generations.get(branch) ?? 0) + 1;
    this.#generations.set(branch, generation);
    const ttl = input.ttl_ms ?? 60_000;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 600_000) {
      throw new MemoryRemoteSyncError("SYNC_LEASE_INVALID");
    }
    const lease: RemoteSyncLease = {
      schema_version: 1,
      lease_id: `lease_${randomBytes(8).toString("hex")}`,
      lease_token: token("lease"),
      generation,
      project_id: input.source.project_id,
      branch_name: input.source.branch_name,
      actor_id: input.source.actor_id,
      expires_at: new Date(Date.now() + ttl).toISOString()
    };
    this.#leases.set(branch, lease);
    this.#ensureSnapshot(input.source);
    this.#leaseAcquires.set(key, { fingerprint, value: clone(lease) });
    return { outcome: "new", value: clone(lease) };
  }

  async renewLease(input: {
    lease: RemoteSyncLease;
    ttl_ms?: number;
    idempotency_key: string;
  }): Promise<RemoteSyncIdempotencyResult<RemoteSyncLease>> {
    const source = this.#sourceFromLease(input.lease);
    const key = actorKey(source, input.idempotency_key);
    const fingerprint = hash({ lease: input.lease, ttl_ms: input.ttl_ms ?? null });
    const prior = this.#leaseRenews.get(key);
    if (prior !== undefined) return result(this.#leaseRenews, key, fingerprint, prior.value);
    this.#assertLease(input.lease, source);
    const ttl = input.ttl_ms ?? 60_000;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 600_000) {
      throw new MemoryRemoteSyncError("SYNC_LEASE_INVALID");
    }
    const renewed = { ...input.lease, expires_at: new Date(Date.now() + ttl).toISOString() };
    this.#leases.set(branchKey(source), renewed);
    this.#leaseRenews.set(key, { fingerprint, value: clone(renewed) });
    return { outcome: "new", value: clone(renewed) };
  }

  async releaseLease(input: {
    lease: RemoteSyncLease;
    idempotency_key: string;
  }): Promise<RemoteSyncIdempotencyResult<void>> {
    const source = this.#sourceFromLease(input.lease);
    const key = actorKey(source, input.idempotency_key);
    const fingerprint = hash(input.lease);
    const prior = this.#leaseReleases.get(key);
    if (prior !== undefined) return prior.fingerprint === fingerprint
      ? { outcome: "replay", value: undefined }
      : { outcome: "conflict", error: { code: "SYNC_IDEMPOTENCY_CONFLICT", retryable: false } };
    this.#assertLease(input.lease, source);
    this.#leases.delete(branchKey(source));
    this.#leaseReleases.set(key, { fingerprint, value: undefined });
    return { outcome: "new", value: undefined };
  }

  async readRemoteSnapshot(input: {
    source: RemoteSyncSourceRef;
    expected_revision?: string;
    signal?: AbortSignal;
  }): Promise<RemoteSyncRemoteSnapshot> {
    if (input.signal?.aborted === true) throw new MemoryRemoteSyncError("SYNC_STREAM_ABORTED", true);
    const stored = this.#ensureSnapshot(input.source);
    if (input.expected_revision !== undefined && input.expected_revision !== stored.snapshot.revision) {
      throw new MemoryRemoteSyncError("SYNC_PREVIEW_STALE");
    }
    return clone(stored.snapshot);
  }

  async openContentStream(input: {
    source: RemoteSyncSourceRef;
    path: string;
    snapshot_id: string;
    expected_revision: string;
    chunk_size: number;
    signal?: AbortSignal;
  }): Promise<RemoteSyncHttpContentStream> {
    if (input.signal?.aborted === true) throw new MemoryRemoteSyncError("SYNC_STREAM_ABORTED", true);
    const stored = this.#ensureSnapshot(input.source);
    if (stored.snapshot.snapshot_id !== input.snapshot_id || stored.snapshot.revision !== input.expected_revision) {
      throw new MemoryRemoteSyncError("SYNC_PREVIEW_STALE");
    }
    const file = stored.files.get(input.path);
    if (file === undefined) throw new MemoryRemoteSyncError("SYNC_SNAPSHOT_NOT_FOUND");
    const chunk: RemoteSyncContentChunk = {
      sequence: 0,
      offset: 0,
      size: file.size,
      chunk_hash: file.content_hash,
      final: true,
      bytes: new Uint8Array(file.size)
    };
    return {
      snapshot_id: stored.snapshot.snapshot_id,
      revision: stored.snapshot.revision,
      content_sha256: file.content_hash,
      size: file.size,
      stream: (async function* (): AsyncGenerator<RemoteSyncContentChunk> {
        if (input.chunk_size > 1024 * 1024) throw new MemoryRemoteSyncError("SYNC_STREAM_TOO_LARGE");
        yield chunk;
      })()
    };
  }

  async preparePush(input: RemoteSyncPushPrepareHttpRequest): Promise<RemoteSyncIdempotencyResult<RemoteSyncPreparedPush>> {
    const key = actorKey(input.source, input.idempotency_key);
    const fingerprint = hash(input);
    const prior = this.#preparesByKey.get(key);
    if (prior !== undefined) return result(this.#preparesByKey, key, fingerprint, prior.value);
    this.#assertLease(input.lease, input.source);
    const snapshot = this.#ensureSnapshot(input.source);
    if (snapshot.snapshot.revision !== input.expected_revision) throw new MemoryRemoteSyncError("SYNC_PREVIEW_STALE");
    if (input.files.some((file) => file.size !== 0)) throw new MemoryRemoteSyncError("SYNC_STREAM_INVALID");
    const prepared: RemoteSyncPreparedPush = {
      schema_version: 1,
      prepare_id: token("prepare"),
      source: clone(input.source),
      lease_id: input.lease.lease_id,
      lease_token: input.lease.lease_token,
      lease_generation: input.lease.generation,
      expected_revision: input.expected_revision,
      preview_hash: input.preview_hash,
      idempotency_key: input.idempotency_key,
      payload_hash: input.payload_hash,
      state: "prepared",
      expires_at: input.lease.expires_at
    };
    this.#preparesByKey.set(key, { fingerprint, value: clone(prepared) });
    this.#preparesById.set(prepared.prepare_id, { request: clone(input), prepared: clone(prepared), state: "prepared" });
    this.#statuses.set(key, {
      source: clone(input.source),
      state: "prepared",
      prepare_id: prepared.prepare_id,
      idempotency_key: input.idempotency_key,
      payload_hash: input.payload_hash
    });
    return { outcome: "new", value: clone(prepared) };
  }

  async commitPush(input: RemoteSyncPushCommitHttpRequest): Promise<RemoteSyncIdempotencyResult<RemoteSyncPushReceiptHttp>> {
    const source = this.#sourceFromLease(input.lease);
    const key = actorKey(source, input.idempotency_key);
    const prior = this.#commits.get(key);
    if (prior !== undefined) return result(this.#commits, key, hash(input), prior.value);
    const prepared = this.#preparesById.get(input.prepare_id);
    if (prepared === undefined) throw new MemoryRemoteSyncError("SYNC_PREPARE_NOT_FOUND");
    this.#assertLease(input.lease, source);
    if (prepared.prepared.idempotency_key !== input.idempotency_key || prepared.prepared.payload_hash !== input.payload_hash) {
      return { outcome: "conflict", error: { code: "SYNC_IDEMPOTENCY_CONFLICT", retryable: false } };
    }
    if (Date.parse(prepared.prepared.expires_at) <= Date.now()) throw new MemoryRemoteSyncError("SYNC_PREPARE_EXPIRED");
    const receipt: RemoteSyncPushReceiptHttp = {
      schema_version: 1,
      prepare_id: input.prepare_id,
      source: clone(source),
      idempotency_key: input.idempotency_key,
      payload_hash: input.payload_hash,
      preview_hash: prepared.prepared.preview_hash,
      project_version: "pv_0",
      artifact_id: "art_0",
      commit_sha: source.commit_sha ?? null,
      manifest_hash: this.#ensureSnapshot(source).snapshot.manifest_hash,
      no_changes: prepared.request.operations.length === 0,
      applied: clone(prepared.request.operations),
      skipped: clone(prepared.request.skipped),
      retryable: []
    };
    prepared.state = "committed";
    prepared.receipt = clone(receipt);
    this.#commits.set(key, { fingerprint: hash(input), value: clone(receipt) });
    this.#receiptsByPrepare.set(input.prepare_id, clone(receipt));
    this.#statuses.set(key, {
      source: clone(source),
      state: "committed",
      prepare_id: input.prepare_id,
      idempotency_key: input.idempotency_key,
      payload_hash: input.payload_hash,
      receipt: clone(receipt)
    });
    return { outcome: "new", value: clone(receipt) };
  }

  getPushStatus(input: { source: RemoteSyncSourceRef; idempotency_key: string }): Promise<RemoteSyncPushStatus | null> {
    return Promise.resolve(clone(this.#statuses.get(actorKey(input.source, input.idempotency_key)) ?? null));
  }

  getPushReceipt(input: { source: RemoteSyncSourceRef; prepare_id: string }): Promise<RemoteSyncPushReceiptHttp | null> {
    const receipt = this.#receiptsByPrepare.get(input.prepare_id);
    if (receipt === undefined || receipt.source.project_id !== input.source.project_id ||
        receipt.source.branch_name !== input.source.branch_name || receipt.source.actor_id !== input.source.actor_id) {
      return Promise.resolve(null);
    }
    return Promise.resolve(clone(receipt));
  }

  async pull(input: {
    source: RemoteSyncSourceRef;
    actor_id: string;
    idempotency_key: string;
    payload_hash?: string;
    signal?: AbortSignal;
  }): Promise<RemoteSyncIdempotencyResult<RemoteSyncPullReceipt>> {
    if (input.signal?.aborted === true) throw new MemoryRemoteSyncError("SYNC_STREAM_ABORTED", true);
    const key = actorKey(input.source, input.idempotency_key);
    const payloadHash = input.payload_hash ?? hash({ source: input.source, actor_id: input.actor_id, idempotency_key: input.idempotency_key });
    const prior = this.#pulls.get(key);
    if (prior !== undefined) return result(this.#pulls, key, payloadHash, prior.value);
    const snapshot = this.#ensureSnapshot(input.source).snapshot;
    const receipt: RemoteSyncPullReceipt = {
      schema_version: 1,
      source: clone(input.source),
      idempotency_key: input.idempotency_key,
      payload_hash: payloadHash,
      remote_revision: snapshot.revision,
      commit_sha: snapshot.commit_sha,
      artifact_id: snapshot.artifact_id,
      manifest_hash: snapshot.manifest_hash,
      local_transaction: "committed",
      project_version: snapshot.project_version,
      no_changes: true,
      applied: [],
      skipped: [],
      retryable: []
    };
    this.#pulls.set(key, { fingerprint: payloadHash, value: clone(receipt) });
    return { outcome: "new", value: clone(receipt) };
  }

  #sourceFromLease(lease: RemoteSyncLease): RemoteSyncSourceRef {
    return {
      project_id: lease.project_id,
      branch_name: lease.branch_name,
      actor_id: lease.actor_id
    };
  }

  #assertLease(lease: RemoteSyncLease, source: RemoteSyncSourceRef): void {
    if (lease.project_id !== source.project_id || lease.branch_name !== source.branch_name || lease.actor_id !== source.actor_id) {
      throw new MemoryRemoteSyncError("SYNC_LEASE_SCOPE_MISMATCH");
    }
    if (Date.parse(lease.expires_at) <= Date.now()) throw new MemoryRemoteSyncError("SYNC_LEASE_EXPIRED");
    const current = this.#leases.get(branchKey(source));
    if (current === undefined || current.lease_id !== lease.lease_id || current.lease_token !== lease.lease_token ||
        current.generation !== lease.generation || current.expires_at !== lease.expires_at) {
      throw new MemoryRemoteSyncError("SYNC_LEASE_FENCED");
    }
  }

  #ensureSnapshot(source: RemoteSyncSourceRef): StoredSnapshot {
    const key = branchKey(source);
    const existing = this.#snapshots.get(key);
    if (existing !== undefined) return existing;
    const emptyHash = "sha256:" + createHash("sha256").update("").digest("hex");
    const snapshot: RemoteSyncRemoteSnapshot = {
      source: clone(source),
      snapshot_id: token("snapshot"),
      revision: "0",
      project_version: null,
      commit_sha: source.commit_sha ?? null,
      artifact_id: null,
      manifest_hash: emptyHash,
      files: []
    };
    const stored = { snapshot, files: new Map<string, RemoteSyncRemoteFileMetadata>() };
    this.#snapshots.set(key, stored);
    return stored;
  }
}

export type { RemoteSyncContentChunk, RemoteSyncOperation };
