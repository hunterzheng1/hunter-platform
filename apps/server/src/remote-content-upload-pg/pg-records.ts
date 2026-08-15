import { randomBytes } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  remoteContentUploadHttpRecordSchema,
  type RemoteContentUploadHttpRecord,
  type RemoteContentUploadHttpSource,
} from "@hunter-harness/contracts";

import type {
  RemoteContentUploadCasObject,
  RemoteContentUploadRecordIdentity,
  RemoteContentUploadRecordLookup,
  RemoteContentUploadRecordPort,
} from "./ports.js";

interface UploadRow extends QueryResultRow {
  readonly project_id: string;
  readonly actor_id: string;
  readonly branch_name: string;
  readonly idempotency_key: string;
  readonly content_sha256: string;
  readonly size_bytes: string | number;
  readonly source_json: unknown;
  readonly record_json: unknown;
  readonly created_at: string | Date;
  readonly expires_at: string | Date;
  readonly updated_at: string | Date;
  readonly state: "staged" | "stored" | "expired";
  readonly stage_attempt_id: string | null;
  readonly stage_lease_until: string | Date | null;
}

interface GarbageRow extends QueryResultRow {
  readonly content_sha256: string;
  readonly size_bytes: string | number;
  readonly state?: "publishing" | "ready" | "gc_claimed";
  readonly gc_batch_id?: string | null;
}

const GC_BATCH_ID = /^remote_content_upload_gc:[A-Za-z0-9_-]{43}$/u;

function failure(): never {
  throw new Error("REMOTE_CONTENT_UPLOAD_RECORD_INVALID");
}

function timestamp(value: string | Date): string {
  try {
    const result = value instanceof Date ? value.toISOString() : value;
    if (typeof result !== "string" || !Number.isFinite(Date.parse(result))) failure();
    return result;
  } catch {
    failure();
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { failure(); }
}

function recordFromRow(row: UploadRow): RemoteContentUploadHttpRecord {
  const staged = row.state === "staged";
  if (staged !== (row.stage_attempt_id !== null && row.stage_lease_until !== null) ||
      !staged && (row.stage_attempt_id !== null || row.stage_lease_until !== null)) failure();
  const createdAt = timestamp(row.created_at);
  const expiresAt = timestamp(row.expires_at);
  if (row.stage_lease_until !== null && (Date.parse(timestamp(row.stage_lease_until)) <= Date.parse(createdAt) ||
      Date.parse(timestamp(row.stage_lease_until)) > Date.parse(expiresAt))) failure();
  const parsed = remoteContentUploadHttpRecordSchema.safeParse(parseJson(row.record_json));
  if (!parsed.success || parsed.data.source.project_id !== row.project_id ||
      parsed.data.source.actor_id !== row.actor_id || parsed.data.source.branch_name !== row.branch_name ||
      parsed.data.idempotency_key !== row.idempotency_key || parsed.data.content_sha256 !== row.content_sha256 ||
      parsed.data.size_bytes !== Number(row.size_bytes) || parsed.data.expires_at !== expiresAt ||
      parsed.data.created_at !== createdAt) {
    failure();
  }
  if (parsed.data.source.project_id !== row.project_id) failure();
  return parsed.data;
}

function sameOptional(left: string | undefined, right: string | undefined): boolean {
  return left === right;
}

function identityMatches(record: RemoteContentUploadHttpRecord, input: RemoteContentUploadRecordIdentity, now: string): boolean {
  const recordTtl = Date.parse(record.expires_at) - Date.parse(record.created_at);
  const inputTtl = Date.parse(input.expires_at) - Date.parse(now);
  return record.source.project_id === input.project_id && record.source.branch_name === input.branch_name &&
    record.source.actor_id === input.actor_id && record.idempotency_key === input.idempotency_key &&
    record.content_sha256 === input.content_sha256 && record.size_bytes === input.size_bytes &&
    Number.isFinite(recordTtl) && Number.isFinite(inputTtl) && recordTtl === inputTtl &&
    sameOptional(record.source.commit_sha, input.source.commit_sha) &&
    sameOptional(record.source.client_id, input.source.client_id) &&
    sameOptional(record.source.change_key, input.source.change_key);
}

function lookupRow(row: UploadRow | undefined, input: RemoteContentUploadRecordIdentity, now: string): RemoteContentUploadRecordLookup {
  if (row === undefined) return Object.freeze({ outcome: "missing" });
  const record = recordFromRow(row);
  if (!identityMatches(record, input, now)) return Object.freeze({ outcome: "conflict", record });
  if (Date.parse(record.expires_at) <= Date.parse(now) || row.state === "expired") {
    return Object.freeze({ outcome: "expired", record });
  }
  if (row.state === "staged") return Object.freeze({ outcome: "staged" as const, record,
    ...(row.stage_attempt_id === null ? {} : { stage_attempt_id: row.stage_attempt_id }) });
  if (row.state !== "stored") return Object.freeze({ outcome: "missing" });
  return Object.freeze({ outcome: "stored", record });
}

function statusLookupRow(row: UploadRow | undefined, input: {
  readonly project_id: string;
  readonly branch_name: string;
  readonly actor_id: string;
  readonly idempotency_key: string;
  readonly source: RemoteContentUploadHttpSource;
  readonly now: string;
}): RemoteContentUploadRecordLookup {
  if (row === undefined) return Object.freeze({ outcome: "missing" });
  const record = recordFromRow(row);
  if (record.source.project_id !== input.project_id || record.source.branch_name !== input.branch_name ||
      record.source.actor_id !== input.actor_id || record.idempotency_key !== input.idempotency_key ||
      !sameOptional(record.source.commit_sha, input.source.commit_sha) ||
      !sameOptional(record.source.client_id, input.source.client_id) ||
      !sameOptional(record.source.change_key, input.source.change_key)) {
    return Object.freeze({ outcome: "conflict", record });
  }
  if (Date.parse(record.expires_at) <= Date.parse(input.now) || row.state === "expired") {
    return Object.freeze({ outcome: "expired", record });
  }
  if (row.state === "staged") return Object.freeze({ outcome: "staged" as const, record,
    ...(row.stage_attempt_id === null ? {} : { stage_attempt_id: row.stage_attempt_id }) });
  if (row.state !== "stored") return Object.freeze({ outcome: "missing" });
  return Object.freeze({ outcome: "stored", record });
}

async function transaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
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

const selectColumns = `project_id,actor_id,branch_name,idempotency_key,content_sha256,size_bytes,
  source_json,record_json,created_at,expires_at,updated_at,state,stage_attempt_id,stage_lease_until`;

function sourceJson(source: RemoteContentUploadHttpSource): string {
  return JSON.stringify(source);
}

export class PgRemoteContentUploadRecordPort implements RemoteContentUploadRecordPort {
  public constructor(private readonly pool: Pool) {}

  public async findByIdentity(input: RemoteContentUploadRecordIdentity & { readonly now: string }): Promise<RemoteContentUploadRecordLookup> {
    const result = await this.pool.query<UploadRow>(`SELECT ${selectColumns} FROM remote_content_uploads
      WHERE project_id=$1 AND actor_id=$2 AND idempotency_key=$3 AND branch_name=$4`, [input.project_id, input.actor_id, input.idempotency_key, input.branch_name]);
    return lookupRow(result.rows[0], input, input.now);
  }

  public async findByStatus(input: {
    readonly project_id: string;
    readonly branch_name: string;
    readonly actor_id: string;
    readonly idempotency_key: string;
    readonly source: RemoteContentUploadHttpSource;
    readonly now: string;
  }): Promise<RemoteContentUploadRecordLookup> {
    const result = await this.pool.query<UploadRow>(`SELECT ${selectColumns} FROM remote_content_uploads
      WHERE project_id=$1 AND actor_id=$2 AND idempotency_key=$3 AND branch_name=$4`, [input.project_id, input.actor_id, input.idempotency_key, input.branch_name]);
    return statusLookupRow(result.rows[0], input);
  }

  public async insertStaged(input: RemoteContentUploadRecordIdentity & {
    readonly created_at: string;
    readonly upload_id: string;
    readonly upload_ref: { readonly ref_id: string; readonly sha256: string; readonly size_bytes: number };
    readonly stage_attempt_id: string;
    readonly stage_lease_until: string;
    readonly record: RemoteContentUploadHttpRecord;
  }): Promise<RemoteContentUploadRecordLookup> {
    return transaction(this.pool, async (client) => {
      // Serialize staging with GC/finalization for the same project/CAS
      // object.  Without this fence a finalizer can pass its live-ref check,
      // then a concurrent upload can publish and mark a new reference after
      // the physical object has already been removed.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        JSON.stringify({ project_id: input.project_id, content_sha256: input.content_sha256 })
      ]);
      const inserted = await client.query<{ readonly stage_attempt_id: string }>(`INSERT INTO remote_content_uploads
        (project_id,actor_id,branch_name,idempotency_key,source_json,upload_id,ref_id,content_sha256,size_bytes,
         state,stage_attempt_id,stage_lease_until,record_json,created_at,expires_at,updated_at)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,'staged',$10,$11,$12::jsonb,$13,$14,$13)
        ON CONFLICT (project_id,branch_name,actor_id,idempotency_key) DO NOTHING
        RETURNING stage_attempt_id`, [
        input.project_id, input.actor_id, input.branch_name, input.idempotency_key, sourceJson(input.source),
        input.upload_id, input.upload_ref.ref_id, input.content_sha256, input.size_bytes, input.stage_attempt_id,
        input.stage_lease_until, JSON.stringify(input.record), input.created_at, input.expires_at,
      ]);
      if (inserted.rows[0]?.stage_attempt_id === input.stage_attempt_id) {
        // The physical publish happens after this transaction.  Persist its
        // exact project/hash/size first so a publish followed by a permanent
        // markStored failure remains discoverable by metadata-driven GC.
        const registered = await client.query<{ readonly size_bytes: string | number }>(`INSERT INTO remote_content_upload_cas_objects
          (project_id,content_sha256,size_bytes,state,created_at,gc_claimed_at,gc_lease_until,gc_batch_id)
          VALUES ($1,$2,$3,'publishing',$4,NULL,NULL,NULL)
          ON CONFLICT (project_id,content_sha256) DO UPDATE
            SET state=CASE WHEN remote_content_upload_cas_objects.state='ready' THEN 'ready' ELSE 'publishing' END,
                gc_claimed_at=NULL,gc_lease_until=NULL,gc_batch_id=NULL
            WHERE remote_content_upload_cas_objects.size_bytes=EXCLUDED.size_bytes
          RETURNING size_bytes`,
        [input.project_id, input.content_sha256, input.size_bytes, input.created_at]);
        if (Number(registered.rows[0]?.size_bytes) !== input.size_bytes) failure();
      }
      const result = await client.query<UploadRow>(`SELECT ${selectColumns} FROM remote_content_uploads
        WHERE project_id=$1 AND actor_id=$2 AND idempotency_key=$3 AND branch_name=$4 FOR SHARE`,
      [input.project_id, input.actor_id, input.idempotency_key, input.branch_name]);
      return lookupRow(result.rows[0], input, input.created_at);
    });
  }

  public async markStored(input: {
    readonly project_id: string;
    readonly branch_name: string;
    readonly actor_id: string;
    readonly idempotency_key: string;
    readonly stage_attempt_id: string;
    readonly now: string;
    readonly record: RemoteContentUploadHttpRecord;
  }): Promise<RemoteContentUploadRecordLookup> {
    return transaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        JSON.stringify({ project_id: input.project_id, content_sha256: input.record.content_sha256 })
      ]);
      const result = await client.query<UploadRow>(`UPDATE remote_content_uploads
        SET state='stored',stage_attempt_id=NULL,stage_lease_until=NULL,record_json=$6::jsonb,updated_at=$7
        WHERE project_id=$1 AND branch_name=$5 AND actor_id=$2 AND idempotency_key=$3 AND stage_attempt_id=$4 AND state='staged'
          AND stage_lease_until > $8 AND stage_lease_until > clock_timestamp()
        RETURNING ${selectColumns}`, [input.project_id, input.actor_id, input.idempotency_key,
        input.stage_attempt_id, input.branch_name, JSON.stringify(input.record), input.record.created_at, input.now]);
      if (result.rows[0] !== undefined) {
        const registered = await client.query<{ readonly size_bytes: string | number }>(`INSERT INTO remote_content_upload_cas_objects
          (project_id,content_sha256,size_bytes,state,created_at,gc_claimed_at,gc_lease_until,gc_batch_id)
          VALUES ($1,$2,$3,'ready',$4,NULL,NULL,NULL)
          ON CONFLICT (project_id,content_sha256) DO UPDATE
            SET state='ready',gc_claimed_at=NULL,gc_lease_until=NULL,gc_batch_id=NULL
            WHERE remote_content_upload_cas_objects.size_bytes=EXCLUDED.size_bytes
          RETURNING size_bytes`,
        [input.project_id, input.record.content_sha256, input.record.size_bytes, input.record.created_at]);
        if (Number(registered.rows[0]?.size_bytes) !== input.record.size_bytes) failure();
        return Object.freeze({ outcome: "stored" as const, record: recordFromRow(result.rows[0]) });
      }
      const existing = await client.query<UploadRow>(`SELECT ${selectColumns} FROM remote_content_uploads
        WHERE project_id=$1 AND branch_name=$4 AND actor_id=$2 AND idempotency_key=$3 FOR SHARE`,
      [input.project_id, input.actor_id, input.idempotency_key, input.record.source.branch_name]);
      const row = existing.rows[0];
      if (row === undefined) return Object.freeze({ outcome: "missing" as const });
      return lookupRow(row, {
        project_id: input.project_id, branch_name: input.record.source.branch_name, actor_id: input.actor_id,
        idempotency_key: input.idempotency_key, content_sha256: input.record.content_sha256,
        size_bytes: input.record.size_bytes, expires_at: input.record.expires_at, source: input.record.source,
      }, input.record.created_at);
    });
  }

  public async commitStaged(input: {
    readonly project_id: string;
    readonly branch_name: string;
    readonly actor_id: string;
    readonly idempotency_key: string;
    readonly stage_attempt_id: string;
    readonly now: string;
    readonly record: RemoteContentUploadHttpRecord;
    readonly publishObject: () => Promise<void>;
  }): Promise<RemoteContentUploadRecordLookup> {
    const nowMs = Date.parse(input.now);
    if (!Number.isFinite(nowMs)) failure();
    return transaction(this.pool, async (client) => {
      // GC claim/finalize and the physical publish share this exact object
      // fence.  The callback runs only after the durable staged owner and
      // lease are revalidated while both the advisory and upload row are held.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        JSON.stringify({ project_id: input.project_id, content_sha256: input.record.content_sha256 })
      ]);
      const existing = await client.query<UploadRow & { readonly fence_checked_at: string | Date }>(`SELECT ${selectColumns},
          clock_timestamp() AS fence_checked_at FROM remote_content_uploads
        WHERE project_id=$1 AND branch_name=$4 AND actor_id=$2 AND idempotency_key=$3 FOR UPDATE`,
      [input.project_id, input.actor_id, input.idempotency_key, input.branch_name]);
      const row = existing.rows[0];
      if (row === undefined) return Object.freeze({ outcome: "missing" as const });
      const expected: RemoteContentUploadRecordIdentity = {
        project_id: input.project_id,
        branch_name: input.branch_name,
        actor_id: input.actor_id,
        idempotency_key: input.idempotency_key,
        content_sha256: input.record.content_sha256,
        size_bytes: input.record.size_bytes,
        expires_at: input.record.expires_at,
        source: input.record.source,
      };
      // identityMatches compares the declared TTL, so bind identity at the
      // record's creation instant and apply the completion-time lease below.
      const lookup = lookupRow(row, expected, input.record.created_at);
      if (lookup.outcome !== "staged") return lookup;
      if (row.stage_attempt_id !== input.stage_attempt_id) return lookup;
      const fenceCheckedAt = Date.parse(timestamp(row.fence_checked_at));
      const effectiveNow = Math.max(nowMs, fenceCheckedAt);
      if (Date.parse(lookup.record.expires_at) <= effectiveNow || row.stage_lease_until === null ||
          Date.parse(timestamp(row.stage_lease_until)) <= effectiveNow) {
        return Object.freeze({ outcome: "expired" as const, record: lookup.record });
      }

      await input.publishObject();
      const stored = await client.query<UploadRow>(`UPDATE remote_content_uploads
        SET state='stored',stage_attempt_id=NULL,stage_lease_until=NULL,record_json=$6::jsonb,updated_at=$7
        WHERE project_id=$1 AND branch_name=$5 AND actor_id=$2 AND idempotency_key=$3
          AND stage_attempt_id=$4 AND state='staged'
          AND stage_lease_until > clock_timestamp() AND expires_at > clock_timestamp()
        RETURNING ${selectColumns}`,
      [input.project_id, input.actor_id, input.idempotency_key, input.stage_attempt_id,
        input.branch_name, JSON.stringify(input.record), input.now]);
      const storedRow = stored.rows[0];
      if (storedRow === undefined) {
        // The external publish may have crossed the expiry while this
        // transaction held the fence.  Keep the original staged row and its
        // durable publishing metadata so GC can reclaim the physical object.
        return Object.freeze({ outcome: "expired" as const, record: lookup.record });
      }
      const registered = await client.query<{ readonly size_bytes: string | number }>(`INSERT INTO remote_content_upload_cas_objects
        (project_id,content_sha256,size_bytes,state,created_at,gc_claimed_at,gc_lease_until,gc_batch_id)
        VALUES ($1,$2,$3,'ready',$4,NULL,NULL,NULL)
        ON CONFLICT (project_id,content_sha256) DO UPDATE
          SET state='ready',gc_claimed_at=NULL,gc_lease_until=NULL,gc_batch_id=NULL
          WHERE remote_content_upload_cas_objects.size_bytes=EXCLUDED.size_bytes
        RETURNING size_bytes`,
      [input.project_id, input.record.content_sha256, input.record.size_bytes, input.record.created_at]);
      if (Number(registered.rows[0]?.size_bytes) !== input.record.size_bytes) failure();
      return Object.freeze({ outcome: "stored" as const, record: recordFromRow(storedRow) });
    });
  }

  public async reclaimStaleStaged(input: {
    readonly project_id: string;
    readonly branch_name: string;
    readonly actor_id: string;
    readonly idempotency_key: string;
    readonly now: string;
  }): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const result = await client.query(`DELETE FROM remote_content_uploads
        WHERE project_id=$1 AND branch_name=$2 AND actor_id=$3 AND idempotency_key=$4
          AND state='staged' AND stage_lease_until <= $5
        RETURNING project_id`, [input.project_id, input.branch_name, input.actor_id, input.idempotency_key, input.now]);
      return (result.rowCount ?? 0) === 1;
    });
  }

  public async abandonStaged(input: {
    readonly project_id: string;
    readonly branch_name: string;
    readonly actor_id: string;
    readonly idempotency_key: string;
    readonly stage_attempt_id: string;
  }): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const result = await client.query(`DELETE FROM remote_content_uploads
        WHERE project_id=$1 AND branch_name=$2 AND actor_id=$3 AND idempotency_key=$4
          AND stage_attempt_id=$5 AND state='staged'`,
      [input.project_id, input.branch_name, input.actor_id, input.idempotency_key, input.stage_attempt_id]);
      return (result.rowCount ?? 0) === 1;
    });
  }

  public async insertStored(input: RemoteContentUploadRecordIdentity & {
    readonly created_at: string;
    readonly upload_id: string;
    readonly upload_ref: { readonly ref_id: string; readonly sha256: string; readonly size_bytes: number };
    readonly record: RemoteContentUploadHttpRecord;
  }): Promise<RemoteContentUploadRecordLookup> {
    return transaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        JSON.stringify({ project_id: input.project_id, content_sha256: input.record.content_sha256 })
      ]);
      await client.query(`INSERT INTO remote_content_uploads
        (project_id,actor_id,branch_name,idempotency_key,source_json,upload_id,ref_id,content_sha256,size_bytes,
         state,stage_attempt_id,record_json,created_at,expires_at,updated_at)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,'stored',NULL,$10::jsonb,$11,$12,$11)
        ON CONFLICT (project_id,branch_name,actor_id,idempotency_key) DO NOTHING`, [
        input.project_id, input.actor_id, input.branch_name, input.idempotency_key, sourceJson(input.source),
        input.upload_id, input.upload_ref.ref_id, input.content_sha256, input.size_bytes, JSON.stringify(input.record),
        input.created_at, input.expires_at,
      ]);
      const result = await client.query<UploadRow>(`SELECT ${selectColumns} FROM remote_content_uploads
        WHERE project_id=$1 AND branch_name=$4 AND actor_id=$2 AND idempotency_key=$3 FOR SHARE`,
      [input.project_id, input.actor_id, input.idempotency_key, input.branch_name]);
      if (result.rows[0] !== undefined) {
        const registered = await client.query<{ readonly size_bytes: string | number }>(`INSERT INTO remote_content_upload_cas_objects
          (project_id,content_sha256,size_bytes,state,created_at,gc_claimed_at,gc_lease_until,gc_batch_id)
          VALUES ($1,$2,$3,'ready',$4,NULL,NULL,NULL)
          ON CONFLICT (project_id,content_sha256) DO UPDATE
            SET state='ready',gc_claimed_at=NULL,gc_lease_until=NULL,gc_batch_id=NULL
            WHERE remote_content_upload_cas_objects.size_bytes=EXCLUDED.size_bytes
          RETURNING size_bytes`,
        [input.project_id, input.record.content_sha256, input.record.size_bytes, input.record.created_at]);
        if (Number(registered.rows[0]?.size_bytes) !== input.record.size_bytes) failure();
      }
      return lookupRow(result.rows[0], input, input.created_at);
    });
  }

  public async reapExpiredGarbageBatches(input: {
    readonly project_id: string;
    readonly now: string;
    readonly limit: number;
  }): Promise<number> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 32 ||
        !Number.isFinite(Date.parse(input.now))) failure();
    const candidates = await transaction(this.pool, async (client) => client.query<{ readonly batch_id: string }>(
      `SELECT batch_id FROM remote_content_upload_gc_batches
       WHERE project_id=$1 AND lease_until<=$2
       ORDER BY lease_until,batch_id LIMIT $3`,
      [input.project_id, input.now, input.limit]));
    let reaped = 0;
    for (const candidate of candidates.rows) {
      if (typeof candidate.batch_id !== "string" || !GC_BATCH_ID.test(candidate.batch_id)) failure();
      const removed = await transaction(this.pool, async (client) => {
        // Batch row first, then sorted object advisories, then object rows.
        // ack/finalize use the same order and claim never locks an old batch.
        const batchResult = await client.query<{ readonly worker_id: string; readonly lease_until: string | Date; readonly acknowledged: boolean }>(
          `SELECT worker_id,lease_until,acknowledged FROM remote_content_upload_gc_batches
           WHERE batch_id=$1 AND project_id=$2 FOR UPDATE`, [candidate.batch_id, input.project_id]);
        const batch = batchResult.rows[0];
        if (batch === undefined || Date.parse(timestamp(batch.lease_until)) > Date.parse(input.now)) return false;
        const items = await client.query<GarbageRow>(`SELECT content_sha256,size_bytes
          FROM remote_content_upload_gc_items
          WHERE batch_id=$1 AND project_id=$2 ORDER BY content_sha256`,
        [candidate.batch_id, input.project_id]);
        for (const item of items.rows) {
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            JSON.stringify({ project_id: input.project_id, content_sha256: item.content_sha256 })
          ]);
          const owned = await client.query<GarbageRow>(`SELECT content_sha256,size_bytes,state,gc_batch_id
            FROM remote_content_upload_cas_objects
            WHERE project_id=$1 AND content_sha256=$2 FOR UPDATE`,
          [input.project_id, item.content_sha256]);
          const object = owned.rows[0];
          if (object === undefined || object.state !== "gc_claimed" || object.gc_batch_id !== candidate.batch_id) continue;
          if (Number(object.size_bytes) !== Number(item.size_bytes)) failure();
          await client.query(`UPDATE remote_content_upload_cas_objects
            SET state='ready',gc_claimed_at=NULL,gc_lease_until=NULL,gc_batch_id=NULL
            WHERE project_id=$1 AND content_sha256=$2 AND gc_batch_id=$3`,
          [input.project_id, item.content_sha256, candidate.batch_id]);
        }
        await client.query(`DELETE FROM remote_content_upload_gc_batches
          WHERE batch_id=$1 AND project_id=$2`, [candidate.batch_id, input.project_id]);
        return true;
      });
      if (removed) reaped += 1;
    }
    return reaped;
  }

  public async claimGarbage(input: {
    readonly project_id: string;
    readonly now: string;
    readonly limit: number;
    readonly worker_id: string;
    readonly lease_until: string;
  }): Promise<{ readonly batch_id: string; readonly refs: readonly RemoteContentUploadCasObject[] }> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 256 ||
        Date.parse(input.lease_until) <= Date.parse(input.now)) failure();
    const batch_id = `remote_content_upload_gc:${randomBytes(32).toString("base64url")}`;
    return transaction(this.pool, async (client) => {
      const requestKey = JSON.stringify({ project_id: input.project_id, now: input.now, limit: input.limit,
        worker_id: input.worker_id, lease_until: input.lease_until });
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [requestKey]);
      const selected = await client.query<GarbageRow>(`SELECT c.content_sha256,c.size_bytes
        FROM remote_content_upload_cas_objects c
        WHERE c.project_id=$1 AND (c.state IN ('publishing','ready') OR (c.state='gc_claimed' AND c.gc_lease_until<=$2))
          AND NOT EXISTS (SELECT 1 FROM remote_content_uploads u
            WHERE u.project_id=c.project_id AND u.content_sha256=c.content_sha256
              AND ((u.state='staged' AND u.stage_lease_until>$2 AND u.expires_at>$2)
                OR (u.state='stored' AND u.expires_at>$2)))
        ORDER BY c.content_sha256 LIMIT $3`,
      [input.project_id, input.now, input.limit]);
      await client.query(`INSERT INTO remote_content_upload_gc_batches
        (batch_id,project_id,worker_id,lease_until,created_at) VALUES ($1,$2,$3,$4,$5)`,
      [batch_id, input.project_id, input.worker_id, input.lease_until, input.now]);
      const refs: Array<{ readonly project_id: string; readonly sha256: `sha256:${string}`; readonly bytes: number }> = [];
      for (const row of selected.rows) {
        const ref = { project_id: input.project_id, sha256: row.content_sha256 as `sha256:${string}`, bytes: Number(row.size_bytes) };
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          JSON.stringify({ project_id: ref.project_id, content_sha256: ref.sha256 })
        ]);
        const current = await client.query<GarbageRow>(`SELECT content_sha256,size_bytes,state,gc_batch_id
          FROM remote_content_upload_cas_objects
          WHERE project_id=$1 AND content_sha256=$2
            AND (state IN ('publishing','ready') OR (state='gc_claimed' AND gc_lease_until<=$3)) FOR UPDATE`,
        [input.project_id, ref.sha256, input.now]);
        if (current.rows[0] === undefined) continue;
        const live = await client.query(`SELECT 1 FROM remote_content_uploads u
          WHERE u.project_id=$1 AND u.content_sha256=$2
            AND ((u.state='staged' AND u.stage_lease_until>$3 AND u.expires_at>$3)
              OR (u.state='stored' AND u.expires_at>$3)) LIMIT 1`,
        [input.project_id, ref.sha256, input.now]);
        if ((live.rowCount ?? 0) !== 0) continue;
        const ordinal = refs.length + 1;
        refs.push({ ...ref, bytes: Number(current.rows[0].size_bytes) });
        await client.query(`INSERT INTO remote_content_upload_gc_items
          (batch_id,project_id,content_sha256,size_bytes,ordinal) VALUES ($1,$2,$3,$4,$5)`,
        [batch_id, input.project_id, ref.sha256, ref.bytes, ordinal]);
        await client.query(`UPDATE remote_content_upload_cas_objects
          SET state='gc_claimed',gc_claimed_at=$3,gc_lease_until=$4,gc_batch_id=$5
          WHERE project_id=$1 AND content_sha256=$2`,
        [input.project_id, ref.sha256, input.now, input.lease_until, batch_id]);
      }
      return Object.freeze({ batch_id, refs: Object.freeze(refs) });
    });
  }

  public async ackGarbage(input: {
    readonly project_id: string;
    readonly batch_id: string;
    readonly worker_id: string;
    readonly now: string;
  }): Promise<{ readonly status: "acked" | "lease_lost" | "not_found"; readonly refs: readonly RemoteContentUploadCasObject[] }> {
    return transaction(this.pool, async (client) => {
      const batchResult = await client.query<{ worker_id: string; lease_until: string; acknowledged: boolean }>(
        `SELECT worker_id,lease_until,acknowledged FROM remote_content_upload_gc_batches
         WHERE batch_id=$1 AND project_id=$2 FOR UPDATE`, [input.batch_id, input.project_id]);
      const batch = batchResult.rows[0];
      if (batch === undefined) return Object.freeze({ status: "not_found" as const, refs: Object.freeze([]) as readonly RemoteContentUploadCasObject[] });
      if (batch.worker_id !== input.worker_id || !batch.acknowledged && Date.parse(batch.lease_until) <= Date.parse(input.now)) {
        return Object.freeze({ status: "lease_lost" as const, refs: Object.freeze([]) as readonly RemoteContentUploadCasObject[] });
      }
      const items = await client.query<GarbageRow>(`SELECT content_sha256,size_bytes
        FROM remote_content_upload_gc_items WHERE batch_id=$1 AND project_id=$2 ORDER BY ordinal`,
      [input.batch_id, input.project_id]);
      const removable: Array<{ readonly project_id: string; readonly sha256: `sha256:${string}`; readonly bytes: number }> = [];
      for (const item of items.rows) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          JSON.stringify({ project_id: input.project_id, content_sha256: item.content_sha256 })
        ]);
        const owned = await client.query<GarbageRow>(`SELECT content_sha256,size_bytes,state,gc_batch_id
          FROM remote_content_upload_cas_objects
          WHERE project_id=$1 AND content_sha256=$2 FOR UPDATE`,
        [input.project_id, item.content_sha256]);
        const object = owned.rows[0];
        if (object === undefined || object.state !== "gc_claimed" || object.gc_batch_id !== input.batch_id) continue;
        if (Number(object.size_bytes) !== Number(item.size_bytes)) failure();
        const live = await client.query(`SELECT 1 FROM remote_content_uploads
          WHERE project_id=$1 AND content_sha256=$2
            AND ((state='staged' AND stage_lease_until>$3 AND expires_at>$3)
              OR (state='stored' AND expires_at>$3)) LIMIT 1`,
        [input.project_id, item.content_sha256, input.now]);
        if (live.rowCount === 0) {
          removable.push({ project_id: input.project_id, sha256: item.content_sha256 as `sha256:${string}`, bytes: Number(object.size_bytes) });
        } else {
          await client.query(`UPDATE remote_content_upload_cas_objects
            SET state='ready',gc_claimed_at=NULL,gc_lease_until=NULL,gc_batch_id=NULL
            WHERE project_id=$1 AND content_sha256=$2 AND gc_batch_id=$3`,
          [input.project_id, item.content_sha256, input.batch_id]);
        }
      }
      await client.query(`UPDATE remote_content_upload_gc_batches SET acknowledged=true
        WHERE batch_id=$1 AND project_id=$2`, [input.batch_id, input.project_id]);
      return Object.freeze({ status: "acked" as const, refs: Object.freeze(removable) });
    });
  }

  public async finalizeGarbage(input: {
    readonly project_id: string;
    readonly batch_id: string;
    readonly worker_id: string;
    readonly removeObject: (ref: RemoteContentUploadCasObject) => Promise<void>;
  }): Promise<{ readonly status: "finalized" | "pending" | "lease_lost" | "not_found" }> {
    return transaction(this.pool, async (client) => {
      const batchResult = await client.query<{ worker_id: string; acknowledged: boolean }>(
        `SELECT worker_id,acknowledged FROM remote_content_upload_gc_batches
         WHERE batch_id=$1 AND project_id=$2 FOR UPDATE`, [input.batch_id, input.project_id]);
      const batch = batchResult.rows[0];
      if (batch === undefined) return Object.freeze({ status: "not_found" as const });
      if (batch.worker_id !== input.worker_id) return Object.freeze({ status: "lease_lost" as const });
      if (!batch.acknowledged) return Object.freeze({ status: "pending" as const });
      const items = await client.query<GarbageRow>(`SELECT content_sha256,size_bytes
        FROM remote_content_upload_gc_items WHERE batch_id=$1 AND project_id=$2 ORDER BY ordinal`,
      [input.batch_id, input.project_id]);
      for (const item of items.rows) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          JSON.stringify({ project_id: input.project_id, content_sha256: item.content_sha256 })
        ]);
        const owned = await client.query<GarbageRow>(`SELECT content_sha256,size_bytes,state,gc_batch_id
          FROM remote_content_upload_cas_objects
          WHERE project_id=$1 AND content_sha256=$2 FOR UPDATE`,
        [input.project_id, item.content_sha256]);
        const object = owned.rows[0];
        if (object === undefined || object.state !== "gc_claimed" || object.gc_batch_id !== input.batch_id) continue;
        if (Number(object.size_bytes) !== Number(item.size_bytes)) failure();
        const live = await client.query(`SELECT 1 FROM remote_content_uploads
          WHERE project_id=$1 AND content_sha256=$2
            AND ((state='staged' AND stage_lease_until>now() AND expires_at>now())
              OR (state='stored' AND expires_at>now())) LIMIT 1`,
        [input.project_id, item.content_sha256]);
        if ((live.rowCount ?? 0) === 0) {
          await input.removeObject({ project_id: input.project_id,
            sha256: item.content_sha256 as `sha256:${string}`, bytes: Number(object.size_bytes) });
          await client.query(`DELETE FROM remote_content_upload_cas_objects
            WHERE project_id=$1 AND content_sha256=$2 AND gc_batch_id=$3`,
          [input.project_id, item.content_sha256, input.batch_id]);
        } else {
          await client.query(`UPDATE remote_content_upload_cas_objects
            SET state='ready',gc_claimed_at=NULL,gc_lease_until=NULL,gc_batch_id=NULL
            WHERE project_id=$1 AND content_sha256=$2 AND gc_batch_id=$3`,
          [input.project_id, item.content_sha256, input.batch_id]);
        }
      }
      await client.query("DELETE FROM remote_content_upload_gc_batches WHERE batch_id=$1 AND project_id=$2", [input.batch_id, input.project_id]);
      return Object.freeze({ status: "finalized" as const });
    });
  }
}
