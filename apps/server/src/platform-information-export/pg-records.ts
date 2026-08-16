import { createHash, randomBytes } from "node:crypto";
import { isProxy } from "node:util/types";

import {
  canonicalJson,
  platformInformationExportArtifactReceiptSchema,
  type PlatformInformationExportArtifactReceipt,
} from "@hunter-harness/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { PlatformInformationExportRecordPort } from "./ports.js";
import type {
  PlatformInformationExportRecord,
  PlatformInformationExportRecordAckResult,
  PlatformInformationExportRecordClaimResult,
  PlatformInformationExportRecordDownloadResult,
  PlatformInformationExportRecordFindResult,
  PlatformInformationExportRecordPublishResult,
} from "./types.js";

const INPUT_INVALID = "PLATFORM_INFORMATION_EXPORT_RECORD_INPUT_INVALID";
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const PROJECT_ID_PATTERN = /^prj_[A-Za-z0-9_-]{1,156}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;
const MAX_CLAIM_LIMIT = 1_000;
const MAX_LEASE_MS = 86_400_000;

function invalid(): never { throw new Error(INPUT_INVALID); }

function snapshot(value: unknown): unknown {
  const seen = new WeakSet<object>();
  let nodes = 100_000;
  let characters = 2_000_000;
  const visit = (current: unknown, depth: number): unknown => {
    nodes -= 1;
    if (nodes < 0 || depth > 32) invalid();
    if (current === null || typeof current === "boolean" || current === undefined) return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) invalid();
      return current;
    }
    if (typeof current === "string") {
      characters -= current.length;
      if (characters < 0) invalid();
      return current;
    }
    if (typeof current !== "object" || isProxy(current) || seen.has(current)) invalid();
    seen.add(current);
    let prototype: object | null;
    let descriptors: PropertyDescriptorMap;
    try {
      prototype = Object.getPrototypeOf(current) as object | null;
      descriptors = Object.getOwnPropertyDescriptors(current);
    } catch { invalid(); }
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) invalid();
    if (Array.isArray(current)) {
      const length = descriptors.length;
      if (prototype !== Array.prototype || length === undefined || !("value" in length) ||
          !Number.isSafeInteger(length.value) || length.value < 0 || length.value > 10_000 ||
          length.value > nodes || keys.length !== length.value + 1) invalid();
      const copy = new Array<unknown>(length.value as number);
      for (let index = 0; index < copy.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) invalid();
        copy[index] = visit(descriptor.value, depth + 1);
      }
      return Object.freeze(copy);
    }
    if ((prototype !== Object.prototype && prototype !== null) || keys.length > nodes) invalid();
    const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (key === "__proto__" || descriptor === undefined || !("value" in descriptor) ||
          descriptor.enumerable !== true) invalid();
      Object.defineProperty(copy, key, { value: visit(descriptor.value, depth + 1), enumerable: true,
        configurable: false, writable: false });
    }
    return Object.freeze(copy);
  };
  return visit(value, 0);
}

function exact(value: unknown, required: readonly string[], optional: readonly string[] = []):
Readonly<Record<string, unknown>> {
  const copy = snapshot(value);
  if (copy === null || typeof copy !== "object" || Array.isArray(copy)) invalid();
  const keys = Object.keys(copy);
  if (keys.length < required.length || required.some((key) => !Object.hasOwn(copy, key)) ||
      keys.some((key) => !required.includes(key) && !optional.includes(key))) invalid();
  return copy as Readonly<Record<string, unknown>>;
}

function identity(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 160) invalid();
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) invalid();
      index += 1;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) invalid();
  }
  return value;
}

function projectId(value: unknown): string {
  if (typeof value !== "string" || !PROJECT_ID_PATTERN.test(value)) invalid();
  return value;
}

function hash(value: unknown): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) invalid();
  return value;
}

function timestamp(value: unknown): { source: string; milliseconds: number } {
  if (typeof value !== "string" || value.length > 40 || !TIMESTAMP_PATTERN.test(value)) invalid();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !==
      new Date(value).toISOString()) invalid();
  return { source: value, milliseconds };
}

function frozen<const T extends object>(value: T): Readonly<T> { return Object.freeze(value); }

function freezeRecord(raw: unknown): PlatformInformationExportRecord {
  const value = exact(raw, ["actor_id", "idempotency_key", "query_hash", "receipt"]);
  const actorId = identity(value.actor_id);
  const idempotencyKey = hash(value.idempotency_key);
  const queryHash = hash(value.query_hash);
  const receiptRaw = exact(value.receipt, ["schema_version", "contract_kind", "export_id", "project_id",
    "view", "range", "m4_proof", "proof_sha", "artifact", "download_ref", "status", "created_at",
    "expires_at"]);
  identity(receiptRaw.export_id);
  const download = exact(receiptRaw.download_ref, ["export_id", "project_id", "content_sha"]);
  identity(download.export_id);
  const parsed = platformInformationExportArtifactReceiptSchema.safeParse(receiptRaw);
  if (!parsed.success || parsed.data.range.query_scope.actor_id !== actorId) invalid();
  const queryCanonical = canonicalJson({ schema_version: 1, contract_kind: "query", view: parsed.data.view,
    project_id: parsed.data.project_id, query_scope: parsed.data.range.query_scope,
    limit: parsed.data.range.limit, cursor: parsed.data.range.source_cursor,
    cursor_verification: parsed.data.range.cursor_verification, sort: parsed.data.range.sort });
  const expected = `sha256:${createHash("sha256").update(queryCanonical).digest("hex")}`;
  if (queryHash !== expected) invalid();
  const receipt = snapshot(parsed.data) as PlatformInformationExportArtifactReceipt;
  return frozen({ actor_id: actorId, idempotency_key: idempotencyKey, query_hash: queryHash, receipt });
}

interface ExportRow extends QueryResultRow {
  actor_id: string; idempotency_key: string; query_hash: string; receipt_canonical: string;
  expires_ms: string; status: "ready" | "expired";
}

function recordFromRow(row: ExportRow): PlatformInformationExportRecord {
  let receipt: unknown;
  try { receipt = JSON.parse(row.receipt_canonical) as unknown; } catch { invalid(); }
  return freezeRecord({ actor_id: row.actor_id, idempotency_key: row.idempotency_key,
    query_hash: row.query_hash, receipt });
}

async function inTransaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
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
  } finally { client.release(); }
}

function queryCanonical(record: PlatformInformationExportRecord): string {
  const receipt = record.receipt;
  return canonicalJson({ schema_version: 1, contract_kind: "query", view: receipt.view,
    project_id: receipt.project_id, query_scope: receipt.range.query_scope, limit: receipt.range.limit,
    cursor: receipt.range.source_cursor, cursor_verification: receipt.range.cursor_verification,
    sort: receipt.range.sort });
}

export class PgPlatformInformationExportRecordPort implements PlatformInformationExportRecordPort {
  public constructor(private readonly pool: Pool) {}

  public async findReadyByIdempotency(raw: Parameters<PlatformInformationExportRecordPort["findReadyByIdempotency"]>[0]):
  Promise<PlatformInformationExportRecordFindResult> {
    const input = exact(raw, ["actor_id", "project_id", "idempotency_key", "query_hash", "now"]);
    const actor = identity(input.actor_id); const project = projectId(input.project_id);
    const key = hash(input.idempotency_key); const query = hash(input.query_hash);
    const now = timestamp(input.now);
    const result = await this.pool.query<ExportRow>(`SELECT actor_id,idempotency_key,query_hash,receipt_canonical,
      expires_ms,status FROM platform_information_exports WHERE actor_id=$1 AND project_id=$2 AND idempotency_key=$3`,
    [actor, project, key]);
    const row = result.rows[0];
    if (row === undefined) return frozen({ status: "not_found" });
    if (row.query_hash !== query) return frozen({ status: "conflict", reason_code: "different_query" });
    if (row.status !== "ready" || BigInt(row.expires_ms) <= BigInt(now.milliseconds)) {
      return frozen({ status: "expired" });
    }
    return frozen({ status: "ready", record: recordFromRow(row) });
  }

  public async publishReady(raw: PlatformInformationExportRecord):
  Promise<PlatformInformationExportRecordPublishResult> {
    const record = freezeRecord(raw);
    const created = timestamp(record.receipt.created_at); const expires = timestamp(record.receipt.expires_at);
    if (created.milliseconds >= expires.milliseconds) invalid();
    const receiptCanonical = canonicalJson(record.receipt);
    const recordCanonical = canonicalJson(record);
    return inTransaction(this.pool, async (client) => {
      const inserted = await client.query<ExportRow>(`INSERT INTO platform_information_exports
        (export_id,export_id_utf8,project_id,actor_id,view,query_hash,idempotency_key,query_canonical,
         range_json,m4_proof_json,proof_sha,receipt_json,receipt_canonical,content_sha,items_sha,
         byte_count,item_count,page_count,format,media_type,status,created_at,expires_at,created_ms,expires_ms)
        VALUES ($1,convert_to($1,'UTF8'),$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11::jsonb,$12,
          $13,$14,$15,$16,$17,$18,$19,'ready',$20,$21,$22,$23)
        ON CONFLICT DO NOTHING RETURNING actor_id,idempotency_key,query_hash,receipt_canonical,expires_ms,status`, [
        record.receipt.export_id, record.receipt.project_id, record.actor_id, record.receipt.view,
        record.query_hash, record.idempotency_key, queryCanonical(record), canonicalJson(record.receipt.range),
        canonicalJson(record.receipt.m4_proof), record.receipt.proof_sha, receiptCanonical, receiptCanonical,
        record.receipt.artifact.content_sha, record.receipt.artifact.items_sha,
        record.receipt.artifact.byte_count, record.receipt.artifact.item_count,
        record.receipt.artifact.page_count, record.receipt.artifact.format, record.receipt.artifact.media_type,
        record.receipt.created_at, record.receipt.expires_at, created.milliseconds, expires.milliseconds,
      ]);
      if (inserted.rowCount === 1) return frozen({ status: "published", record });
      const existing = await client.query<ExportRow>(`SELECT actor_id,idempotency_key,query_hash,
        receipt_canonical,expires_ms,status FROM platform_information_exports
        WHERE actor_id=$1 AND project_id=$2 AND idempotency_key=$3 FOR SHARE`,
      [record.actor_id, record.receipt.project_id, record.idempotency_key]);
      const prior = existing.rows[0];
      if (prior === undefined) {
        const sameExport = await client.query<ExportRow>(`SELECT actor_id,idempotency_key,query_hash,
          receipt_canonical,expires_ms,status FROM platform_information_exports WHERE export_id=$1 FOR SHARE`,
        [record.receipt.export_id]);
        if (sameExport.rows[0] === undefined) throw new Error("platform export publication postcondition failed");
        return frozen({ status: "conflict", reason_code: "different_record" });
      }
      if (prior.query_hash !== record.query_hash) {
        return frozen({ status: "conflict", reason_code: "different_query" });
      }
      const priorRecord = recordFromRow(prior);
      if (canonicalJson(priorRecord) !== recordCanonical) {
        return frozen({ status: "conflict", reason_code: "different_record" });
      }
      return frozen({ status: "existing", record: priorRecord });
    });
  }

  public async getReadyForDownload(raw: Parameters<PlatformInformationExportRecordPort["getReadyForDownload"]>[0]):
  Promise<PlatformInformationExportRecordDownloadResult> {
    const input = exact(raw, ["actor_id", "project_id", "export_id", "now"]);
    const actor = identity(input.actor_id); const project = projectId(input.project_id);
    const exportId = identity(input.export_id); const now = timestamp(input.now);
    const result = await this.pool.query<ExportRow>(`SELECT actor_id,idempotency_key,query_hash,
      receipt_canonical,expires_ms,status FROM platform_information_exports
      WHERE actor_id=$1 AND project_id=$2 AND export_id=$3`, [actor, project, exportId]);
    const row = result.rows[0];
    if (row === undefined) return frozen({ status: "not_found" });
    if (row.status !== "ready" || BigInt(row.expires_ms) <= BigInt(now.milliseconds)) {
      return frozen({ status: "expired" });
    }
    return frozen({ status: "ready", record: recordFromRow(row) });
  }

  public async claimExpired(raw: Parameters<PlatformInformationExportRecordPort["claimExpired"]>[0]):
  Promise<PlatformInformationExportRecordClaimResult> {
    const input = exact(raw, ["now", "limit", "worker_id", "lease_until"], ["cursor"]);
    const now = timestamp(input.now); const lease = timestamp(input.lease_until);
    const worker = identity(input.worker_id);
    if (!Number.isSafeInteger(input.limit) || (input.limit as number) < 1 ||
        (input.limit as number) > MAX_CLAIM_LIMIT || lease.milliseconds <= now.milliseconds ||
        lease.milliseconds - now.milliseconds > MAX_LEASE_MS) invalid();
    const cursor = input.cursor;
    if (!(cursor === undefined || cursor === null || typeof cursor === "string" && TOKEN_PATTERN.test(cursor))) invalid();
    const requestKey = canonicalJson({ now_ms: now.milliseconds, limit: input.limit,
      cursor: cursor ?? null, worker_id: worker, lease_ms: lease.milliseconds });
    return inTransaction(this.pool, async (client) => {
      // Serialize the same logical claim so an overlapping retry observes the
      // committed batch instead of returning a misleading empty page.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [requestKey]);
      const replay = await client.query<{ batch_id: string; next_cursor: string | null }>(`SELECT batch_id,next_cursor
        FROM platform_information_export_batches WHERE request_key=$1 AND acknowledged=false
          AND lease_until_ms>$2 ORDER BY batch_seq DESC LIMIT 1 FOR UPDATE`, [requestKey, now.milliseconds]);
      if (replay.rows[0] !== undefined) return this.claimResult(client, replay.rows[0]);
      let cursorExpires: string | null = null; let cursorExport: Buffer | null = null;
      if (typeof cursor === "string") {
        const capability = await client.query<{ now_ms: string; expires_ms: string; export_id_utf8: Buffer }>(
          `SELECT now_ms,expires_ms,export_id_utf8 FROM platform_information_export_cursors WHERE token=$1`, [cursor]);
        const value = capability.rows[0];
        if (value === undefined || BigInt(value.now_ms) !== BigInt(now.milliseconds)) invalid();
        cursorExpires = value.expires_ms; cursorExport = value.export_id_utf8;
      }
      const selected = await client.query<{ export_id: string; expires_ms: string }>(`SELECT e.export_id,e.expires_ms
        FROM platform_information_exports e
        WHERE e.status='ready' AND e.expires_ms<=$1
          AND ($2::bigint IS NULL OR (e.expires_ms,e.export_id_utf8)>($2::bigint,$3::bytea))
          AND NOT EXISTS (SELECT 1 FROM platform_information_export_batch_items bi
            JOIN platform_information_export_batches b ON b.batch_id=bi.batch_id
            WHERE bi.export_id=e.export_id AND b.acknowledged=false AND b.lease_until_ms>$1)
        ORDER BY e.expires_ms,e.export_id_utf8 LIMIT $4 FOR UPDATE OF e SKIP LOCKED`,
      [now.milliseconds, cursorExpires, cursorExport, (input.limit as number) + 1]);
      const page = selected.rows.slice(0, input.limit as number);
      if (page.length === 0) return frozen({ status: "empty", refs: Object.freeze([]), next_cursor: null });
      let nextCursor: string | null = null;
      if (selected.rows.length > page.length) {
        const last = page.at(-1) as { export_id: string; expires_ms: string };
        const capabilityKey = canonicalJson({ now_ms: now.milliseconds,
          expires_ms: Number(last.expires_ms), export_id: last.export_id });
        nextCursor = await this.cursorFor(client, capabilityKey, now.milliseconds,
          Number(last.expires_ms), last.export_id);
      }
      const batchId = randomBytes(32).toString("base64url");
      await client.query(`INSERT INTO platform_information_export_batches
        (batch_id,request_key,worker_id,lease_until,lease_until_ms,next_cursor)
        VALUES ($1,$2,$3,$4,$5,$6)`, [batchId, requestKey, worker, lease.source,
        lease.milliseconds, nextCursor]);
      for (let index = 0; index < page.length; index += 1) {
        await client.query(`INSERT INTO platform_information_export_batch_items(batch_id,export_id,ordinal)
          VALUES ($1,$2,$3)`, [batchId, page[index]?.export_id, index + 1]);
      }
      return this.claimResult(client, { batch_id: batchId, next_cursor: nextCursor });
    });
  }

  private async cursorFor(client: PoolClient, key: string, nowMs: number, expiresMs: number,
    exportId: string): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const result = await client.query<{ token: string }>(`INSERT INTO platform_information_export_cursors
      (token,capability_key,now_ms,expires_ms,export_id,export_id_utf8)
      VALUES ($1,$2,$3,$4,$5,convert_to($5,'UTF8'))
      ON CONFLICT (capability_key) DO UPDATE SET capability_key=EXCLUDED.capability_key RETURNING token`,
    [token, key, nowMs, expiresMs, exportId]);
    const value = result.rows[0]?.token;
    if (value === undefined || !TOKEN_PATTERN.test(value)) throw new Error("cursor postcondition failed");
    return value;
  }

  private async claimResult(client: PoolClient, batch: { batch_id: string; next_cursor: string | null }):
  Promise<PlatformInformationExportRecordClaimResult> {
    const refs = await client.query<{ receipt_canonical: string }>(`SELECT e.receipt_canonical
      FROM platform_information_export_batch_items bi JOIN platform_information_exports e
        ON e.export_id=bi.export_id WHERE bi.batch_id=$1 ORDER BY bi.ordinal`, [batch.batch_id]);
    const values = refs.rows.map((row) => {
      let receipt: unknown;
      try { receipt = JSON.parse(row.receipt_canonical) as unknown; } catch { invalid(); }
      const parsed = platformInformationExportArtifactReceiptSchema.safeParse(receipt);
      if (!parsed.success) invalid();
      return snapshot(parsed.data.download_ref) as PlatformInformationExportArtifactReceipt["download_ref"];
    });
    return frozen({ status: "claimed", batch_id: batch.batch_id,
      refs: Object.freeze(values), next_cursor: batch.next_cursor });
  }

  public async ackExpired(raw: Parameters<PlatformInformationExportRecordPort["ackExpired"]>[0]):
  Promise<PlatformInformationExportRecordAckResult> {
    const input = exact(raw, ["batch_id", "worker_id"]);
    const batchId = identity(input.batch_id); const worker = identity(input.worker_id);
    return inTransaction(this.pool, async (client) => {
      const result = await client.query<{ batch_seq: string; worker_id: string; acknowledged: boolean;
        lease_expired: boolean }>(
        `SELECT batch_seq,worker_id,acknowledged,clock_timestamp()>=lease_until AS lease_expired
         FROM platform_information_export_batches
         WHERE batch_id=$1 FOR UPDATE`, [batchId]);
      const batch = result.rows[0];
      if (batch === undefined) return frozen({ status: "not_found" });
      if (batch.worker_id !== worker) return frozen({ status: "not_owner" });
      if (batch.acknowledged) return frozen({ status: "already_acked" });
      if (batch.lease_expired) return frozen({ status: "lease_lost" });
      await client.query(`SELECT e.export_id FROM platform_information_export_batch_items item
        JOIN platform_information_exports e ON e.export_id=item.export_id
        WHERE item.batch_id=$1 ORDER BY item.ordinal FOR UPDATE OF item,e`, [batchId]);
      const lost = await client.query(`SELECT 1 FROM platform_information_export_batch_items mine
        JOIN platform_information_exports e ON e.export_id=mine.export_id
        WHERE mine.batch_id=$1 AND (e.status<>'ready' OR EXISTS (
          SELECT 1 FROM platform_information_export_batch_items newer_items
          JOIN platform_information_export_batches newer ON newer.batch_id=newer_items.batch_id
          WHERE newer_items.export_id=mine.export_id AND newer.batch_seq>$2)) LIMIT 1`,
      [batchId, batch.batch_seq]);
      if (lost.rowCount !== 0) return frozen({ status: "lease_lost" });
      await client.query(`UPDATE platform_information_exports SET status='expired'
        WHERE export_id IN (SELECT export_id FROM platform_information_export_batch_items WHERE batch_id=$1)`,
      [batchId]);
      await client.query(`UPDATE platform_information_export_batches SET acknowledged=true WHERE batch_id=$1`,
      [batchId]);
      return frozen({ status: "acked" });
    });
  }

  public async hasLiveReference(raw: Parameters<PlatformInformationExportRecordPort["hasLiveReference"]>[0]):
  Promise<boolean> {
    const input = exact(raw, ["content_hash", "now"]);
    const content = hash(input.content_hash); const now = timestamp(input.now);
    const result = await this.pool.query(`SELECT 1 FROM platform_information_exports
      WHERE content_sha=$1 AND status='ready' AND expires_ms>$2 LIMIT 1`, [content, now.milliseconds]);
    return result.rowCount === 1;
  }
}
