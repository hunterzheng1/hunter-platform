import type { Pool } from "pg";

import type { RemoteArchiveV2, RemoteArchiveV2Record } from "@hunter-harness/core";

export interface RemoteSyncArchivePgOptions {
  readonly pool: Pool;
  readonly now?: () => string;
}

export interface RemoteSyncArchivePgService extends RemoteArchiveV2 {
  close(): Promise<void>;
}

export interface RemoteSyncArchivePgRow {
  readonly project_id: string;
  readonly operation_id: string;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly state: string;
  readonly generation: number | string;
  readonly record_json: unknown;
  readonly created_at: string | Date;
  readonly updated_at: string | Date;
}

export type StoredRemoteSyncArchiveRecord = RemoteArchiveV2Record;
