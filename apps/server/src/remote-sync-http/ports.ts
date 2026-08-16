import type {
  RemoteSyncContentChunk,
  RemoteSyncLease,
  RemoteSyncPreparedPush,
  RemoteSyncPullReceipt,
  RemoteSyncPushStatus,
  RemoteSyncPushReceiptHttp,
  RemoteSyncRemoteSnapshot,
  RemoteSyncSourceRef,
  RemoteSyncPushPrepareHttpRequest,
  RemoteSyncPushCommitHttpRequest
} from "@hunter-harness/contracts";

export type RemoteSyncIdempotencyResult<T> =
  | { outcome: "new" | "replay"; value: T }
  | { outcome: "conflict"; error: { code: "SYNC_IDEMPOTENCY_CONFLICT"; retryable: boolean } };

/**
 * The HTTP adapter is deliberately a port.  A production deployment may
 * supply a PostgreSQL-backed implementation, while tests can use the
 * reference implementation without making the routes aware of persistence.
 */
export interface RemoteSyncHttpContentStream {
  readonly snapshot_id: string;
  readonly revision: string;
  readonly content_sha256: string;
  readonly size: number;
  readonly stream: AsyncIterable<RemoteSyncContentChunk>;
}

export interface RemoteSyncHttpServicePort {
  acquireLease(input: {
    source: RemoteSyncSourceRef;
    ttl_ms?: number;
    idempotency_key: string;
  }): Promise<RemoteSyncIdempotencyResult<RemoteSyncLease>>;
  renewLease(input: {
    lease: RemoteSyncLease;
    ttl_ms?: number;
    idempotency_key: string;
  }): Promise<RemoteSyncIdempotencyResult<RemoteSyncLease>>;
  releaseLease(input: {
    lease: RemoteSyncLease;
    idempotency_key: string;
  }): Promise<RemoteSyncIdempotencyResult<void>>;
  readRemoteSnapshot(input: {
    source: RemoteSyncSourceRef;
    expected_revision?: string;
    signal?: AbortSignal;
  }): Promise<RemoteSyncRemoteSnapshot>;
  openContentStream(input: {
    source: RemoteSyncSourceRef;
    path: string;
    snapshot_id: string;
    expected_revision: string;
    chunk_size: number;
    signal?: AbortSignal;
  }): Promise<RemoteSyncHttpContentStream>;
  preparePush(input: RemoteSyncPushPrepareHttpRequest): Promise<RemoteSyncIdempotencyResult<RemoteSyncPreparedPush>>;
  commitPush(input: RemoteSyncPushCommitHttpRequest): Promise<RemoteSyncIdempotencyResult<RemoteSyncPushReceiptHttp>>;
  getPushStatus(input: {
    source: RemoteSyncSourceRef;
    idempotency_key: string;
  }): Promise<RemoteSyncPushStatus | null>;
  getPushReceipt(input: {
    source: RemoteSyncSourceRef;
    prepare_id: string;
  }): Promise<RemoteSyncPushReceiptHttp | null>;
  pull(input: {
    source: RemoteSyncSourceRef;
    actor_id: string;
    idempotency_key: string;
    payload_hash?: string;
    signal?: AbortSignal;
  }): Promise<RemoteSyncIdempotencyResult<RemoteSyncPullReceipt>>;
}
