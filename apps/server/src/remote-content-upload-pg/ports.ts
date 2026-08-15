import type { Pool, PoolClient, QueryResultRow } from "pg";

import type {
  RemoteContentUploadHttpRecord,
  RemoteContentUploadHttpRequestDescriptor,
  RemoteContentUploadHttpResult,
  RemoteContentUploadHttpSource,
  RemoteContentUploadHttpStatus,
  RemoteContentUploadHttpStatusDescriptor,
} from "@hunter-harness/contracts";
import type { RemoteContentUploadChunk, RemoteContentUploadHttpServicePort } from "../remote-content-upload-http/ports.js";

export interface RemoteContentUploadCasObject {
  readonly project_id: string;
  readonly sha256: `sha256:${string}`;
  readonly bytes: number;
}

export type RemoteContentUploadCasSealedAttempt = RemoteContentUploadCasObject;

export interface RemoteContentUploadCasOptions {
  readonly root: string;
}

export interface RemoteContentUploadCas {
  beginAttempt(input: { readonly project_id: string; readonly expected_sha256: string; readonly expected_bytes: number }):
    Promise<{ readonly attempt_id: string }>;
  appendAttempt(attempt_id: string, bytes: Uint8Array): Promise<void>;
  abortAttempt(attempt_id: string): Promise<void>;
  sealAttempt(attempt_id: string, input: { readonly expected_sha256: string; readonly expected_bytes: number }):
    Promise<RemoteContentUploadCasSealedAttempt>;
  publishAttempt(attempt_id: string, expected: RemoteContentUploadCasObject): Promise<RemoteContentUploadCasObject>;
  hasObject(input: RemoteContentUploadCasObject): Promise<boolean>;
  removeObject(input: RemoteContentUploadCasObject): Promise<void>;
  readObject(input: RemoteContentUploadCasObject): AsyncIterable<Uint8Array>;
  cleanupStaleAttempts(input: { readonly before: string }): Promise<number>;
  close(): Promise<void>;
}

export interface RemoteContentUploadRecordIdentity {
  readonly project_id: string;
  readonly branch_name: string;
  readonly actor_id: string;
  readonly idempotency_key: string;
  readonly content_sha256: string;
  readonly size_bytes: number;
  readonly expires_at: string;
  readonly source: RemoteContentUploadHttpSource;
}

export type RemoteContentUploadRecordLookup =
  | { readonly outcome: "missing" }
  | { readonly outcome: "staged"; readonly record: RemoteContentUploadHttpRecord; readonly stage_attempt_id?: string }
  | { readonly outcome: "expired"; readonly record: RemoteContentUploadHttpRecord }
  | { readonly outcome: "conflict"; readonly record: RemoteContentUploadHttpRecord }
  | { readonly outcome: "stored"; readonly record: RemoteContentUploadHttpRecord };

export interface RemoteContentUploadRecordPort {
  findByIdentity(input: RemoteContentUploadRecordIdentity & { readonly now: string }):
    Promise<RemoteContentUploadRecordLookup>;
  insertStored(input: RemoteContentUploadRecordIdentity & {
    readonly created_at: string;
    readonly upload_id: string;
    readonly upload_ref: { readonly ref_id: string; readonly sha256: string; readonly size_bytes: number };
    readonly record: RemoteContentUploadHttpRecord;
  }): Promise<RemoteContentUploadRecordLookup>;
  insertStaged(input: RemoteContentUploadRecordIdentity & {
    readonly created_at: string;
    readonly upload_id: string;
    readonly upload_ref: { readonly ref_id: string; readonly sha256: string; readonly size_bytes: number };
    readonly stage_attempt_id: string;
    readonly stage_lease_until: string;
    readonly record: RemoteContentUploadHttpRecord;
  }): Promise<RemoteContentUploadRecordLookup>;
  reclaimStaleStaged(input: {
    readonly project_id: string;
    readonly branch_name: string;
    readonly actor_id: string;
    readonly idempotency_key: string;
    readonly now: string;
  }): Promise<boolean>;
  abandonStaged(input: {
    readonly project_id: string;
    readonly branch_name: string;
    readonly actor_id: string;
    readonly idempotency_key: string;
    readonly stage_attempt_id: string;
  }): Promise<boolean>;
  markStored(input: {
    readonly project_id: string;
    readonly branch_name: string;
    readonly actor_id: string;
    readonly idempotency_key: string;
    readonly stage_attempt_id: string;
    readonly now: string;
    readonly record: RemoteContentUploadHttpRecord;
  }): Promise<RemoteContentUploadRecordLookup>;
  commitStaged(input: {
    readonly project_id: string;
    readonly branch_name: string;
    readonly actor_id: string;
    readonly idempotency_key: string;
    readonly stage_attempt_id: string;
    readonly now: string;
    readonly record: RemoteContentUploadHttpRecord;
    readonly publishObject: () => Promise<void>;
  }): Promise<RemoteContentUploadRecordLookup>;
  findByStatus(input: {
    readonly project_id: string;
    readonly branch_name: string;
    readonly actor_id: string;
    readonly idempotency_key: string;
    readonly source: RemoteContentUploadHttpSource;
    readonly now: string;
  }): Promise<RemoteContentUploadRecordLookup>;
  claimGarbage(input: {
    readonly project_id: string;
    readonly now: string;
    readonly limit: number;
    readonly worker_id: string;
    readonly lease_until: string;
  }): Promise<{ readonly batch_id: string; readonly refs: readonly RemoteContentUploadCasObject[] }>;
  ackGarbage(input: {
    readonly project_id: string;
    readonly batch_id: string;
    readonly worker_id: string;
    readonly now: string;
  }): Promise<{ readonly status: "acked" | "lease_lost" | "not_found"; readonly refs: readonly RemoteContentUploadCasObject[] }>;
  finalizeGarbage(input: {
    readonly project_id: string;
    readonly batch_id: string;
    readonly worker_id: string;
    readonly removeObject: (ref: RemoteContentUploadCasObject) => Promise<void>;
  }): Promise<{ readonly status: "finalized" | "pending" | "lease_lost" | "not_found" }>;
  reapExpiredGarbageBatches(input: {
    readonly project_id: string;
    readonly now: string;
    readonly limit: number;
  }): Promise<number>;
}

export interface RemoteContentUploadPgOptions {
  readonly pool: Pool;
  readonly cas: RemoteContentUploadCas;
  readonly now?: () => string;
  /** Narrow deterministic seam for unit tests; production uses Pg records. */
  readonly records?: RemoteContentUploadRecordPort;
}

export interface RemoteContentUploadPgService extends RemoteContentUploadHttpServicePort {
  close(): Promise<void>;
  cleanupStaleAttempts(): Promise<number>;
  claimGarbage(input: Parameters<RemoteContentUploadRecordPort["claimGarbage"]>[0]):
    ReturnType<RemoteContentUploadRecordPort["claimGarbage"]>;
  acknowledgeGarbage(input: Parameters<RemoteContentUploadRecordPort["ackGarbage"]>[0]):
    ReturnType<RemoteContentUploadRecordPort["ackGarbage"]>;
}

export interface RemoteContentUploadPgRow extends QueryResultRow {
  readonly project_id: string;
  readonly branch_name: string;
  readonly actor_id: string;
  readonly idempotency_key: string;
  readonly content_sha256: string;
  readonly size_bytes: string | number;
  readonly source_json: unknown;
  readonly record_json: unknown;
  readonly created_at: string | Date;
  readonly expires_at: string | Date;
  readonly state: "staged" | "stored" | "expired";
}

export type RemoteContentUploadDbExecutor = Pool | PoolClient;
export type RemoteContentUploadStream = AsyncIterable<RemoteContentUploadChunk>;
export type RemoteContentUploadServiceResult = RemoteContentUploadHttpResult | RemoteContentUploadHttpStatus;
export type RemoteContentUploadRequest = RemoteContentUploadHttpRequestDescriptor | RemoteContentUploadHttpStatusDescriptor;
