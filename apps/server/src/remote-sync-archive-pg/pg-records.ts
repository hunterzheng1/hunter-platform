import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  normalizeRemoteArchiveV2Record,
  sameRemoteArchiveV2Source,
  type RemoteArchiveV2Record,
  type RemoteArchiveV2Source,
} from "@hunter-harness/core";
import type { RemoteSyncArchivePgRow } from "./ports.js";

interface UploadRow extends QueryResultRow {
  readonly ref_id: string;
  readonly content_sha256: string;
  readonly size_bytes: number | string;
  readonly expires_at: string | Date;
  readonly state: string;
}

function fail(): never { throw new Error("REMOTE_ARCHIVE_RECORD_INVALID"); }

function leaseScopeMismatch(): never {
  const error = new Error("REMOTE_ARCHIVE_LEASE_SCOPE_MISMATCH") as Error & { code: string };
  error.code = "REMOTE_ARCHIVE_LEASE_SCOPE_MISMATCH";
  throw error;
}

function instant(value: string | Date): string {
  const result = value instanceof Date ? value.toISOString() : value;
  if (typeof result !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(result) ||
      !Number.isFinite(Date.parse(result))) fail();
  return result;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { fail(); }
}

export function recordFromRow(row: RemoteSyncArchivePgRow): RemoteArchiveV2Record {
  const normalized = normalizeRemoteArchiveV2Record(parseJson(row.record_json));
  if (!normalized.ok || normalized.source_schema_version !== 2 || normalized.readiness !== "ready") fail();
  const record = normalized.record;
  if (record.operation_id !== row.operation_id || record.idempotency_key !== row.idempotency_key ||
      record.payload_hash !== row.payload_hash || record.state !== row.state ||
      record.generation !== Number(row.generation) || record.created_at !== instant(row.created_at) ||
      record.updated_at !== instant(row.updated_at) || record.source.project_id !== row.project_id) fail();
  return record;
}

export async function inTransaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}

const columns = "project_id,operation_id,idempotency_key,payload_hash,state,generation,record_json,created_at,updated_at";

export class PgRemoteSyncArchiveRecordPort {
  public constructor(private readonly pool: Pool) {}

  public async lock(client: PoolClient, projectId: string, idempotencyKey: string): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      JSON.stringify({ project_id: projectId, idempotency_key: idempotencyKey })
    ]);
  }

  public async lockOperation(client: PoolClient, projectId: string, operationId: string): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      JSON.stringify({ project_id: projectId, operation_id: operationId })
    ]);
  }

  public async lockUploadObject(client: PoolClient, projectId: string, contentSha256: string): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      JSON.stringify({ project_id: projectId, content_sha256: contentSha256 })
    ]);
  }

  public async findById(client: PoolClient, projectId: string, operationId: string): Promise<RemoteArchiveV2Record | null> {
    const result = await client.query<RemoteSyncArchivePgRow>(`SELECT ${columns} FROM remote_archive_v2_records
      WHERE project_id=$1 AND operation_id=$2 FOR UPDATE`, [projectId, operationId]);
    return result.rows[0] === undefined ? null : recordFromRow(result.rows[0]);
  }

  public async findByKey(client: PoolClient, projectId: string, idempotencyKey: string): Promise<RemoteArchiveV2Record | null> {
    const result = await client.query<RemoteSyncArchivePgRow>(`SELECT ${columns} FROM remote_archive_v2_records
      WHERE project_id=$1 AND idempotency_key=$2 FOR UPDATE`, [projectId, idempotencyKey]);
    return result.rows[0] === undefined ? null : recordFromRow(result.rows[0]);
  }

  public async uploadIsStored(client: PoolClient, input: {
    readonly project_id: string; readonly ref_id: string; readonly sha256: string; readonly size_bytes: number; readonly now: string;
  }): Promise<boolean> {
    const result = await client.query<UploadRow>(`SELECT ref_id,content_sha256,size_bytes,expires_at,state
      FROM remote_content_uploads
      WHERE project_id=$1 AND ref_id=$2 AND content_sha256=$3 AND size_bytes=$4
        AND state='stored' AND expires_at>$5`,
    [input.project_id, input.ref_id, input.sha256, input.size_bytes, input.now]);
    const row = result.rows[0];
    return row !== undefined && row.ref_id === input.ref_id && row.content_sha256 === input.sha256 &&
      Number(row.size_bytes) === input.size_bytes && row.state === "stored" && Date.parse(instant(row.expires_at)) > Date.parse(input.now);
  }

  public async create(client: PoolClient, record: RemoteArchiveV2Record): Promise<void> {
    await client.query(`INSERT INTO remote_archive_v2_records
      (project_id,operation_id,idempotency_key,payload_hash,state,generation,record_json,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`, [
      record.source.project_id, record.operation_id, record.idempotency_key, record.payload_hash,
      record.state, record.generation, JSON.stringify(record), record.created_at, record.updated_at
    ]);
  }

  public async replace(client: PoolClient, record: RemoteArchiveV2Record): Promise<void> {
    const result = await client.query(`UPDATE remote_archive_v2_records
      SET payload_hash=$3,state=$4,generation=$5,record_json=$6::jsonb,updated_at=$7
      WHERE project_id=$1 AND operation_id=$2`, [
      record.source.project_id, record.operation_id, record.payload_hash, record.state, record.generation,
      JSON.stringify(record), record.updated_at
    ]);
    if ((result.rowCount ?? 0) !== 1) fail();
  }

  public async findVisible(projectId: string, operationId: string, source: RemoteArchiveV2Source): Promise<RemoteArchiveV2Record | null> {
    const result = await this.pool.query<RemoteSyncArchivePgRow>(`SELECT ${columns} FROM remote_archive_v2_records
      WHERE project_id=$1 AND operation_id=$2`, [projectId, operationId]);
    if (result.rows[0] === undefined) return null;
    const record = recordFromRow(result.rows[0]);
    if (!sameRemoteArchiveV2Source(record.source, source)) leaseScopeMismatch();
    return record;
  }
}
