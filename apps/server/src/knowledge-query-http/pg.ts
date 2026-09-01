import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

import {
  canonicalJson,
  knowledgeQueryHttpReceiptId,
  knowledgeQueryHttpRequestSchema,
  knowledgeQueryHttpResponseSchema,
  knowledgeQueryHttpResultSetHash,
  validateKnowledgeQueryHttpResponse,
  type KnowledgeQueryHttpRequest,
  type KnowledgeQueryHttpResponse,
  type KnowledgeQueryHttpResult
} from "@hunter-harness/contracts";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

import { PgKnowledgeIndex } from "../knowledge-pipeline/pg.js";
import type { KnowledgeIndex, KnowledgeIndexQuery } from "../knowledge-pipeline/ports.js";
import type { KnowledgeResult } from "../knowledge-pipeline/types.js";
import type {
  KnowledgeQueryHttpIdempotencyResult,
  KnowledgeQueryHttpServicePort
} from "./ports.js";

const IDEMPOTENCY = /^[\x21-\x7e]{1,240}$/u;
const MAX_SNAPSHOT_NODES = 256;
const MAX_SUMMARY_BYTES = 1_024;
const RESULT_KEYS = [
  "schema_version", "knowledge_id", "project_id", "content_kind", "status", "content_hash",
  "display_title", "summary", "reusability_scope", "confidence", "source_archive_ids",
  "source_change_keys", "source_candidate_ids", "source_refs", "extractor_version", "prompt_version",
  "index_schema_version", "generation", "created_at", "updated_at"
] as const;
type ReceiptRow = QueryResultRow & Record<
  "actor_id" | "project_id" | "idempotency_key" | "request_hash" | "query_hash" | "query_id" |
  "receipt_id" | "result_set_hash" | "index_generation" | "response_json" | "created_at",
  unknown
>;

export type KnowledgeQueryHttpQueryIndex = Pick<KnowledgeIndex, "query"> & {
  /** Required production seam: run the read on the receipt transaction client. */
  readonly queryWithClient: (client: PoolClient, query: KnowledgeIndexQuery) => Promise<KnowledgeResult[]>;
};

export type KnowledgeQueryHttpServiceErrorCode =
  | "KNOWLEDGE_QUERY_INVALID"
  | "PROJECT_INFORMATION_FORBIDDEN"
  | "KNOWLEDGE_QUERY_RECEIPT_INVALID"
  | "KNOWLEDGE_QUERY_TIMEOUT"
  | "KNOWLEDGE_QUERY_ABORTED"
  | "REMOTE_UNAVAILABLE";

export class KnowledgeQueryHttpServiceError extends Error {
  readonly code: KnowledgeQueryHttpServiceErrorCode;
  readonly retryable: boolean;

  constructor(code: KnowledgeQueryHttpServiceErrorCode, retryable = code === "REMOTE_UNAVAILABLE") {
    super(code);
    this.name = "KnowledgeQueryHttpServiceError";
    this.code = code;
    this.retryable = retryable;
  }
}

function invalid(code: KnowledgeQueryHttpServiceErrorCode): never {
  throw new KnowledgeQueryHttpServiceError(code, false);
}

function unavailable(): never {
  throw new KnowledgeQueryHttpServiceError("REMOTE_UNAVAILABLE", true);
}

function aborted(): never {
  throw new KnowledgeQueryHttpServiceError("KNOWLEDGE_QUERY_ABORTED", false);
}

function plainObject(value: unknown): value is object {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function ownRecord(value: unknown, keys: readonly string[], code: KnowledgeQueryHttpServiceErrorCode): Record<string, unknown> {
  if (!plainObject(value)) invalid(code);
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
    if (Object.getOwnPropertySymbols(value).length !== 0) invalid(code);
  } catch {
    invalid(code);
  }
  const actual = Object.keys(descriptors).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid(code);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalid(code);
    result[key] = descriptor.value;
  }
  return result;
}

function ownRecordOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  code: KnowledgeQueryHttpServiceErrorCode
): Record<string, unknown> {
  if (!plainObject(value)) invalid(code);
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
    if (Object.getOwnPropertySymbols(value).length !== 0) invalid(code);
  } catch {
    invalid(code);
  }
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(descriptors);
  if (actual.some((key) => !allowed.has(key)) || required.some((key) => descriptors[key] === undefined)) invalid(code);
  const result: Record<string, unknown> = {};
  for (const key of [...required, ...optional]) {
    const descriptor = descriptors[key];
    if (descriptor === undefined) continue;
    if (!descriptor.enumerable || !("value" in descriptor)) invalid(code);
    result[key] = descriptor.value;
  }
  return result;
}

function safeText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    value === value.trim() && value === value.normalize("NFC") &&
    !Array.from(value).some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point <= 31 || point === 127 || (point >= 0xd800 && point <= 0xdfff);
    });
}

function safeRequest(value: unknown): KnowledgeQueryHttpRequest {
  const top = ownRecord(value, [
    "schema_version", "project_id", "query_id", "query_hash", "reason_code", "query", "budget"
  ], "KNOWLEDGE_QUERY_INVALID");
  const budget = ownRecord(top.budget, ["max_results", "max_total_summary_bytes", "deadline_ms"], "KNOWLEDGE_QUERY_INVALID");
  if (typeof top.query === "string" && new TextEncoder().encode(top.query).byteLength > 16_384) {
    invalid("KNOWLEDGE_QUERY_INVALID");
  }
  let parsed: ReturnType<typeof knowledgeQueryHttpRequestSchema.safeParse>;
  try {
    parsed = knowledgeQueryHttpRequestSchema.safeParse({ ...top, budget });
  } catch {
    invalid("KNOWLEDGE_QUERY_INVALID");
  }
  if (!parsed.success) invalid("KNOWLEDGE_QUERY_INVALID");
  return parsed.data;
}

function nativeAbortSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (typeof AbortSignal === "undefined" || isProxy(value) || !(value instanceof AbortSignal)) {
    invalid("KNOWLEDGE_QUERY_INVALID");
  }
  return value as AbortSignal;
}

function signalIsAborted(signal: AbortSignal): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted");
  if (descriptor === undefined || typeof descriptor.get !== "function") invalid("KNOWLEDGE_QUERY_INVALID");
  try {
    return Reflect.apply(descriptor.get, signal, []) === true;
  } catch {
    invalid("KNOWLEDGE_QUERY_INVALID");
  }
}

function remainingDeadline(deadlineAt: number): number {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    throw new KnowledgeQueryHttpServiceError("KNOWLEDGE_QUERY_TIMEOUT", true);
  }
  return Math.max(1, Math.ceil(remaining));
}

async function setStatementTimeout(
  client: PoolClient,
  deadlineAt: number,
  signal: AbortSignal | undefined
): Promise<void> {
  const remaining = remainingDeadline(deadlineAt);
  await withDeadline(
    () => client.query("SELECT set_config('statement_timeout', $1, true)", [`${remaining}ms`]),
    deadlineAt,
    signal
  );
}

async function transactionQuery<T extends QueryResultRow>(
  client: PoolClient,
  text: string,
  values: unknown[],
  deadlineAt: number,
  signal: AbortSignal | undefined
): Promise<QueryResult<T>> {
  await setStatementTimeout(client, deadlineAt, signal);
  return withDeadline(() => client.query<T>(text, values), deadlineAt, signal);
}

function isStatementTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null || isProxy(error)) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor !== undefined && "value" in descriptor && descriptor.value === "57014";
  } catch {
    return false;
  }
}

async function withDeadline<T>(
  operation: () => Promise<T>,
  deadlineAt: number,
  signal: AbortSignal | undefined
): Promise<T> {
  const deadlineMs = remainingDeadline(deadlineAt);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new KnowledgeQueryHttpServiceError("KNOWLEDGE_QUERY_TIMEOUT", true)), deadlineMs);
  });
  let abort: Promise<never> | undefined;
  if (signal !== undefined) {
    abort = new Promise<never>((_, reject) => {
      const listener = () => reject(new KnowledgeQueryHttpServiceError("KNOWLEDGE_QUERY_ABORTED", false));
      const add = EventTarget.prototype.addEventListener;
      const remove = EventTarget.prototype.removeEventListener;
      Reflect.apply(add, signal, ["abort", listener, { once: true }]);
      removeAbortListener = () => { Reflect.apply(remove, signal, ["abort", listener]); };
    });
    // The signal may abort between the first check and listener registration.
    if (signalIsAborted(signal)) {
      clearTimeout(timeoutId);
      removeAbortListener?.();
      aborted();
    }
  }
  let pendingOperation: Promise<T>;
  try {
    pendingOperation = operation();
  } catch (error) {
    clearTimeout(timeoutId);
    removeAbortListener?.();
    throw error;
  }
  const pending: Array<Promise<T | never>> = [pendingOperation, timeout];
  if (abort !== undefined) {
    pending.push(abort);
  }
  try {
    return await Promise.race(pending);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    removeAbortListener?.();
  }
}

async function connectWithDeadline(
  pool: Pool,
  deadlineAt: number,
  signal: AbortSignal | undefined
): Promise<PoolClient> {
  if (signal !== undefined && signalIsAborted(signal)) aborted();
  const pending = pool.connect();
  try {
    return await withDeadline(() => pending, deadlineAt, signal);
  } catch (error) {
    // A pool may resolve a queued connection after the caller has timed out;
    // release that late lease instead of leaking it into the pool.
    void pending.then((client) => { client.release(); }, () => undefined);
    throw error;
  }
}

function hashCanonical(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function positiveGeneration(value: unknown): number {
  const number = typeof value === "bigint" ? Number(value) :
    typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || Number(number) < 0) unavailable();
  return Number(number);
}

function safeTimestamp(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value !== "string" || value.length > 64 || Number.isNaN(Date.parse(value))) unavailable();
  const normalized = new Date(value).toISOString();
  if (normalized !== value) unavailable();
  return normalized;
}

function safeStringArray(value: unknown): string[] {
  if (value === null || typeof value !== "object" || !Array.isArray(value) || isProxy(value)) unavailable();
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0) unavailable();
    descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  } catch { unavailable(); }
  const length = descriptors.length;
  if (length === undefined || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > MAX_SNAPSHOT_NODES) {
    unavailable();
  }
  const result: string[] = [];
  for (let index = 0; index < Number(length.value); index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor) || !safeText(descriptor.value, 1_024)) unavailable();
    result.push(descriptor.value);
  }
  const expected = new Set(["length", ...result.map((_, index) => String(index))]);
  if (Object.keys(descriptors).some((key) => !expected.has(key))) unavailable();
  return result;
}

interface SnapshotResult {
  readonly knowledge_id: string;
  readonly project_id: string;
  readonly summary: string;
  readonly confidence: number;
  readonly source_archive_ids: readonly string[];
  readonly source_refs: readonly string[];
  readonly index_schema_version: string;
  readonly generation: number;
  readonly updated_at: string;
}

function snapshotResult(value: unknown): SnapshotResult {
  const record = ownRecord(value, RESULT_KEYS, "REMOTE_UNAVAILABLE");
  if (record.schema_version !== 1 || record.content_kind !== "knowledge_entry" || record.status !== "active") unavailable();
  const knowledgeId = record.knowledge_id;
  const project = record.project_id;
  const summary = record.summary;
  const confidence = record.confidence;
  const indexSchema = record.index_schema_version;
  if (!safeText(knowledgeId, 256) || !safeText(project, 160) || !safeText(summary, 1_048_576) ||
      typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1 ||
      !safeText(indexSchema, 128)) unavailable();
  return {
    knowledge_id: knowledgeId,
    project_id: project,
    summary,
    confidence,
    source_archive_ids: safeStringArray(record.source_archive_ids),
    source_refs: safeStringArray(record.source_refs),
    index_schema_version: indexSchema,
    generation: positiveGeneration(record.generation),
    updated_at: safeTimestamp(record.updated_at)
  };
}

function truncateUtf8(value: string, maximum: number): string {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const size = new TextEncoder().encode(character).byteLength;
    if (bytes + size > maximum) break;
    result += character;
    bytes += size;
  }
  return result;
}

function sourceFor(result: SnapshotResult): string | undefined {
  const reference = result.source_refs[0];
  if (reference !== undefined && reference.length <= 256) return reference;
  const archive = result.source_archive_ids[0];
  if (archive !== undefined && `archive:${archive}`.length <= 256) return `archive:${archive}`;
  return undefined;
}

function resultFor(result: SnapshotResult, summaryBudget: number): KnowledgeQueryHttpResult | null {
  const summary = truncateUtf8(result.summary, Math.min(MAX_SUMMARY_BYTES, summaryBudget));
  if (summary.length === 0) return null;
  return {
    result_id: result.knowledge_id,
    kind: "archive_knowledge",
    summary,
    relevance: result.confidence >= 0.8 ? "high" : result.confidence >= 0.5 ? "medium" : "low",
    ...(sourceFor(result) === undefined ? {} : { source: sourceFor(result) }),
    verified_at: result.updated_at,
    source_version: result.index_schema_version,
    conflicts_with_intent: false
  };
}

function responseForSuccess(
  request: KnowledgeQueryHttpRequest,
  generation: number,
  results: readonly KnowledgeQueryHttpResult[],
  executedAt: string
): KnowledgeQueryHttpResponse {
  const resultIds = results.map((result) => result.result_id);
  const sourceVersions = [...new Set(results.flatMap((result) => result.source_version === undefined ? [] : [result.source_version]))].sort();
  const resultSetHash = knowledgeQueryHttpResultSetHash({
    index_generation: `knowledge_generation:${generation}`,
    result_ids: resultIds,
    source_versions: sourceVersions
  });
  const receiptBody = {
    schema_version: 1 as const,
    query_hash: request.query_hash,
    project_id: request.project_id,
    index_generation: `knowledge_generation:${generation}`,
    result_ids: resultIds,
    source_versions: sourceVersions,
    result_set_hash: resultSetHash,
    status: "succeeded" as const,
    executed_at: executedAt,
    reason_code: request.reason_code
  };
  const response: KnowledgeQueryHttpResponse = {
    schema_version: 1,
    query_id: request.query_id,
    project_id: request.project_id,
    receipt: { ...receiptBody, receipt_id: knowledgeQueryHttpReceiptId(receiptBody) },
    results: [...results]
  };
  if (!knowledgeQueryHttpResponseSchema.safeParse(response).success) invalid("KNOWLEDGE_QUERY_RECEIPT_INVALID");
  return response;
}

function responseForFailure(
  request: KnowledgeQueryHttpRequest,
  executedAt: string,
  generation?: number
): KnowledgeQueryHttpResponse {
  const indexGeneration = generation === undefined ? undefined : `knowledge_generation:${generation}`;
  const resultSetHash = knowledgeQueryHttpResultSetHash({ index_generation: indexGeneration, result_ids: [], source_versions: [] });
  const receiptBody = {
    schema_version: 1 as const,
    query_hash: request.query_hash,
    project_id: request.project_id,
    ...(indexGeneration === undefined ? {} : { index_generation: indexGeneration }),
    result_ids: [] as string[],
    source_versions: [] as string[],
    result_set_hash: resultSetHash,
    status: "failed" as const,
    executed_at: executedAt,
    reason_code: "remote_knowledge_unavailable" as const,
    failure_code: "remote_knowledge_unavailable"
  };
  const response: KnowledgeQueryHttpResponse = {
    schema_version: 1,
    query_id: request.query_id,
    project_id: request.project_id,
    receipt: { ...receiptBody, receipt_id: knowledgeQueryHttpReceiptId(receiptBody) },
    results: []
  };
  if (!knowledgeQueryHttpResponseSchema.safeParse(response).success) invalid("KNOWLEDGE_QUERY_RECEIPT_INVALID");
  return response;
}

function storedGeneration(receipt: ReceiptRow): number {
  const raw = receipt.index_generation;
  const match = typeof raw === "string" ? /^(?:knowledge_generation:)?(\d+)$/.exec(raw) : null;
  if (match !== null) return Number(match[1]);
  return 0;
}

function storedResponse(
  row: ReceiptRow,
  request: KnowledgeQueryHttpRequest,
  actorId: string,
  idempotencyKey: string,
  requestHash: string
): KnowledgeQueryHttpResponse {
  const parsed = knowledgeQueryHttpResponseSchema.safeParse(row.response_json);
  if (!parsed.success || !validateKnowledgeQueryHttpResponse(parsed.data, request).success) invalid("KNOWLEDGE_QUERY_RECEIPT_INVALID");
  const response = parsed.data;
  const indexGeneration = response.receipt.index_generation ?? null;
  if (row.actor_id !== actorId || row.project_id !== request.project_id ||
      row.idempotency_key !== idempotencyKey || row.request_hash !== requestHash ||
      row.query_hash !== response.receipt.query_hash || row.query_id !== response.query_id ||
      row.receipt_id !== response.receipt.receipt_id || row.result_set_hash !== response.receipt.result_set_hash ||
      row.index_generation !== indexGeneration) {
    invalid("KNOWLEDGE_QUERY_RECEIPT_INVALID");
  }
  return response;
}

async function transaction<T>(
  pool: Pool,
  action: (client: PoolClient) => Promise<T>,
  deadlineAt: number,
  signal: AbortSignal | undefined,
  beforeCommit?: (client: PoolClient) => Promise<void>
): Promise<T> {
  const client = await connectWithDeadline(pool, deadlineAt, signal);
  let releaseError: Error | undefined;
  try {
    try {
      await withDeadline(() => client.query("BEGIN"), deadlineAt, signal);
    } catch (error) {
      // BEGIN may still be active when its deadline wins the race.  Destroy
      // the client instead of returning an active query to the idle pool.
      releaseError = error instanceof Error ? error : new Error("transaction begin failed");
      throw error;
    }
    try {
      const value = await action(client);
      await beforeCommit?.(client);
      await withDeadline(() => client.query("COMMIT"), deadlineAt, signal);
      return value;
    } catch (error) {
      try {
        await withDeadline(() => client.query("ROLLBACK"), deadlineAt, undefined);
      } catch (rollbackError) {
        releaseError = rollbackError instanceof Error ? rollbackError : new Error("transaction rollback failed");
      }
      throw error;
    }
  } finally {
    client.release(releaseError);
  }
}

export class PgKnowledgeQueryHttpService implements KnowledgeQueryHttpServicePort {
  readonly #pool: Pool;
  readonly #index: KnowledgeQueryHttpQueryIndex;
  readonly #clock: () => string;

  constructor(pool: Pool, index?: KnowledgeQueryHttpQueryIndex, clock: () => string = () => new Date().toISOString()) {
    this.#pool = pool;
    this.#index = index ?? new PgKnowledgeIndex(pool);
    this.#clock = clock;
  }

  async execute(rawInput: {
    readonly request: KnowledgeQueryHttpRequest;
    readonly actor_id: string;
    readonly idempotency_key: string;
    readonly signal?: AbortSignal;
  }): Promise<KnowledgeQueryHttpIdempotencyResult> {
    try {
      const input = ownRecordOptional(rawInput, ["request", "actor_id", "idempotency_key"], ["signal"], "KNOWLEDGE_QUERY_INVALID");
      const request = safeRequest(input.request);
      const signal = nativeAbortSignal(input.signal);
      if (!safeText(input.actor_id, 160)) invalid("KNOWLEDGE_QUERY_INVALID");
      if (typeof input.idempotency_key !== "string" || !IDEMPOTENCY.test(input.idempotency_key)) invalid("KNOWLEDGE_QUERY_INVALID");
      const actorId = input.actor_id;
      const idempotencyKey = input.idempotency_key;
      const requestHash = hashCanonical(request);
      const lockKey = JSON.stringify([actorId, request.project_id, idempotencyKey]);
      const deadlineAt = Date.now() + request.budget.deadline_ms;
      return await transaction(this.#pool, async (client) => {
        await setStatementTimeout(client, deadlineAt, signal);
        if (signal !== undefined && signalIsAborted(signal)) aborted();
        await transactionQuery(
          client,
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [lockKey],
          deadlineAt,
          signal
        );
        const project = await transactionQuery<Record<string, unknown>>(
          client,
          "SELECT project_id, owner_actor_id FROM projects WHERE project_id=$1 AND owner_actor_id=$2 AND lifecycle_state='active' FOR SHARE",
          [request.project_id, actorId],
          deadlineAt,
          signal
        );
        if (project.rows[0] === undefined) {
          throw new KnowledgeQueryHttpServiceError("PROJECT_INFORMATION_FORBIDDEN", false);
        }
        const existing = await transactionQuery<ReceiptRow>(
          client,
          `SELECT actor_id, project_id, idempotency_key, request_hash, query_hash, query_id,
                  receipt_id, result_set_hash, index_generation, response_json, created_at
             FROM knowledge_query_http_receipts
            WHERE actor_id=$1 AND project_id=$2 AND idempotency_key=$3
            FOR UPDATE`,
          [actorId, request.project_id, idempotencyKey],
          deadlineAt,
          signal
        );
        const prior = existing.rows[0];
        if (prior !== undefined) {
          if (prior.request_hash !== requestHash) {
            return {
              outcome: "conflict",
              error: { code: "KNOWLEDGE_QUERY_IDEMPOTENCY_CONFLICT", retryable: false }
            };
          }
          // 幂等重放只在索引代际未变时成立：同文本查询在归档/重建后必须拿到新
          // 结果。CLI 幂等键按 query 文本恒定（knowledge-query:<hash>），若服务端
          // 无条件重放，新知识入库后同文本永远返回旧 generation 的空结果——
          // 2026-09 自测「问候语」复现：gen1 查 0 条，v3 归档入库后仍查 0。
          // 这里读取当前代际；与存储的代际不一致时放弃重放、重新执行（幂等键
          // 仍保留，请求一致时不冲突）。
          const generationRow = await transactionQuery<Record<string, unknown>>(
            client,
            "SELECT knowledge_generation FROM knowledge_pipeline_project_fences WHERE project_id=$1 FOR SHARE",
            [request.project_id],
            deadlineAt,
            signal
          );
          const currentGeneration = generationRow.rows[0] === undefined
            ? 0
            : positiveGeneration(generationRow.rows[0].knowledge_generation);
          if (storedGeneration(prior) === currentGeneration) {
            return { outcome: "replay", value: storedResponse(prior, request, actorId, idempotencyKey, requestHash) };
          }
        }
        const generationRow = await transactionQuery<Record<string, unknown>>(
          client,
          "SELECT knowledge_generation FROM knowledge_pipeline_project_fences WHERE project_id=$1 FOR SHARE",
          [request.project_id],
          deadlineAt,
          signal
        );
        const generation = generationRow.rows[0] === undefined ? 0 : positiveGeneration(generationRow.rows[0].knowledge_generation);
        const executedAt = safeTimestamp(this.#clock());
        let response: KnowledgeQueryHttpResponse;
        try {
          const indexQuery = {
            project_id: request.project_id,
            content_kind: "knowledge_entry",
            status: "active",
            query: request.query,
            limit: request.budget.max_results
          } satisfies KnowledgeIndexQuery;
          await setStatementTimeout(client, deadlineAt, signal);
          const indexed = await withDeadline(
            () => this.#index.queryWithClient(client, indexQuery),
            deadlineAt,
            signal
          );
          if (!Array.isArray(indexed) || isProxy(indexed)) unavailable();
          const snapshots = indexed.slice(0, request.budget.max_results).map(snapshotResult);
          if (snapshots.some((item) => item.project_id !== request.project_id || item.generation > generation)) unavailable();
          let remaining = request.budget.max_total_summary_bytes;
          const projected: KnowledgeQueryHttpResult[] = [];
          // 知识条目跨代累积：generation 是索引版本号而非过滤条件。若只取
          // `=== 当前代`，每次新 change 归档后代际递增，旧 change 的所有知识
          // 都会从查询结果消失（2026-09 自测：shout 归档后 gen 4→5，greeting
          // 的「问候语」条目随之查不到）。任何未超过当前代际的 active 条目
          // 都应可查。
          for (const item of snapshots.filter((value) => value.generation <= generation)) {
            const mapped = resultFor(item, remaining);
            if (mapped === null) continue;
            const bytes = new TextEncoder().encode(mapped.summary).byteLength;
            if (bytes > remaining) break;
            projected.push(mapped);
            remaining -= bytes;
          }
          projected.sort((left, right) => left.result_id < right.result_id ? -1 : left.result_id > right.result_id ? 1 : 0);
          response = responseForSuccess(request, generation, projected, executedAt);
        } catch (error) {
          if (isStatementTimeout(error)) {
            throw new KnowledgeQueryHttpServiceError("KNOWLEDGE_QUERY_TIMEOUT", true);
          }
          if (error instanceof KnowledgeQueryHttpServiceError &&
              (error.code === "KNOWLEDGE_QUERY_RECEIPT_INVALID" ||
               error.code === "KNOWLEDGE_QUERY_TIMEOUT" || error.code === "KNOWLEDGE_QUERY_ABORTED")) throw error;
          response = responseForFailure(request, executedAt, generation);
        }
        if (signal !== undefined && signalIsAborted(signal)) aborted();
        await transactionQuery(
          client,
          `INSERT INTO knowledge_query_http_receipts(
             actor_id, project_id, idempotency_key, request_hash, query_hash, query_id,
             receipt_id, result_set_hash, index_generation, response_json, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
           ON CONFLICT (actor_id, project_id, idempotency_key) DO UPDATE SET
             request_hash = EXCLUDED.request_hash,
             query_hash = EXCLUDED.query_hash,
             query_id = EXCLUDED.query_id,
             receipt_id = EXCLUDED.receipt_id,
             result_set_hash = EXCLUDED.result_set_hash,
             index_generation = EXCLUDED.index_generation,
             response_json = EXCLUDED.response_json,
             created_at = EXCLUDED.created_at`,
          [actorId, request.project_id, idempotencyKey, requestHash, request.query_hash,
            response.query_id, response.receipt.receipt_id, response.receipt.result_set_hash,
            response.receipt.index_generation ?? null, canonicalJson(response), executedAt],
          deadlineAt,
          signal
        );
        return { outcome: "new", value: response };
      }, deadlineAt, signal, async (client) => {
        if (signal !== undefined && signalIsAborted(signal)) aborted();
        await setStatementTimeout(client, deadlineAt, signal);
      });
    } catch (error) {
      if (isStatementTimeout(error)) {
        throw new KnowledgeQueryHttpServiceError("KNOWLEDGE_QUERY_TIMEOUT", true);
      }
      if (error instanceof KnowledgeQueryHttpServiceError) throw error;
      unavailable();
    }
  }
}

export function createPgKnowledgeQueryHttpService(pool: Pool): PgKnowledgeQueryHttpService {
  return new PgKnowledgeQueryHttpService(pool);
}
