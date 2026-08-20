import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { types as utilTypes } from "node:util";

import { canonicalJson, knowledgeIngestEntrySchema } from "@hunter-harness/contracts";
import type { Pool } from "pg";

import type { KnowledgeRetryAuthorityPort, ProjectKnowledgeQuerySourcePort } from "./ports.js";
import type {
  ProjectKnowledgeDetailSourceRequest,
  ProjectKnowledgePageSourceRequest,
  ProjectKnowledgeRetryAuthorityRequest
} from "./types.js";

const TOKEN_VERSION = 1;
const SECRET_BYTES = 32;
const MAX_CURSOR_BYTES = 1024;
const SHA = /^sha256:[a-f0-9]{64}$/u;
const PROJECT = /^prj_[A-Za-z0-9_-]{1,156}$/u;

export interface ProjectKnowledgeCurrentFence {
  readonly project_id: string;
  readonly fence: string;
}

export interface ProjectKnowledgeCursorPosition {
  readonly extracted_at: string;
  readonly knowledge_id: string;
}

interface CursorScope {
  readonly actor_id: string;
  readonly project_id: string;
  readonly view: "project_knowledge";
  readonly sort: "extracted_at_desc_knowledge_id_asc";
}

interface PositionedScope extends CursorScope {
  readonly current: ProjectKnowledgeCurrentFence;
  readonly last_key: ProjectKnowledgeCursorPosition;
}

function ownValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !utilTypes.isProxy(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function text(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value === value.trim() &&
    value === value.normalize("NFC") && !Array.from(value).some((char) => {
      const codePoint = char.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 || (codePoint >= 0xd800 && codePoint <= 0xdfff);
    });
}

function tupleBytes(domain: string, fields: readonly string[]): Buffer {
  return Buffer.concat([domain, ...fields].map((field) => {
    const bytes = Buffer.from(field, "utf8");
    return Buffer.concat([Buffer.from(`${bytes.byteLength}:`, "ascii"), bytes]);
  }));
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function safeScope(value: unknown): value is CursorScope {
  if (!plainRecord(value)) return false;
  const actor = ownValue(value, "actor_id");
  const project = ownValue(value, "project_id");
  return text(actor, 160) && typeof project === "string" && PROJECT.test(project) &&
    ownValue(value, "view") === "project_knowledge" &&
    ownValue(value, "sort") === "extracted_at_desc_knowledge_id_asc";
}

function safeFence(value: unknown): value is ProjectKnowledgeCurrentFence {
  return plainRecord(value) && typeof ownValue(value, "project_id") === "string" &&
    PROJECT.test(ownValue(value, "project_id") as string) &&
    typeof ownValue(value, "fence") === "string" && SHA.test(ownValue(value, "fence") as string);
}

function safePosition(value: unknown): value is ProjectKnowledgeCursorPosition {
  return plainRecord(value) && text(ownValue(value, "extracted_at"), 64) && text(ownValue(value, "knowledge_id"), 160);
}

export class ProjectKnowledgeCursorAuthority {
  readonly #secret: Buffer;

  constructor(secret: Uint8Array) {
    if (utilTypes.isProxy(secret) || !utilTypes.isUint8Array(secret) || secret.byteLength !== SECRET_BYTES) {
      throw new Error("PROJECT_KNOWLEDGE_CURSOR_SECRET_INVALID");
    }
    const copy = Buffer.from(secret.buffer, secret.byteOffset, secret.byteLength);
    if (new Set(copy).size < 16) throw new Error("PROJECT_KNOWLEDGE_CURSOR_SECRET_INVALID");
    this.#secret = Buffer.from(copy);
  }

  issue(input: PositionedScope): string {
    if (!safeScope(input) || !safeFence(input.current) || input.current.project_id !== input.project_id ||
        !safePosition(input.last_key)) throw new Error("PROJECT_KNOWLEDGE_CURSOR_INVALID");
    const payload = Buffer.from(JSON.stringify({
      v: TOKEN_VERSION, actor_id: input.actor_id, project_id: input.project_id,
      view: input.view, sort: input.sort, fence: input.current.fence, last_key: input.last_key
    }), "utf8");
    if (payload.byteLength > MAX_CURSOR_BYTES) throw new Error("PROJECT_KNOWLEDGE_CURSOR_INVALID");
    const mac = createHmac("sha256", this.#secret).update(tupleBytes("project-knowledge-cursor-v1", [payload.toString("base64url")])).digest();
    return Buffer.concat([payload, Buffer.from("."), mac]).toString("base64url");
  }

  async verify(input: {
    readonly cursor: string;
    readonly actor_id: string;
    readonly project_id: string;
    readonly view: "project_knowledge";
    readonly sort: "extracted_at_desc_knowledge_id_asc";
  }): Promise<boolean> {
    try {
      const decoded = this.#decode(input.cursor);
      const value = JSON.parse(decoded.payload.toString("utf8")) as unknown;
      return plainRecord(value) && ownValue(value, "v") === TOKEN_VERSION &&
        ownValue(value, "actor_id") === input.actor_id && ownValue(value, "project_id") === input.project_id &&
        ownValue(value, "view") === input.view && ownValue(value, "sort") === input.sort &&
        typeof ownValue(value, "fence") === "string" && safePosition(ownValue(value, "last_key"));
    } catch {
      return false;
    }
  }

  readPosition(cursor: string, scope: CursorScope): { readonly current: ProjectKnowledgeCurrentFence; readonly last_key: ProjectKnowledgeCursorPosition } {
    if (!safeScope(scope)) throw new Error("PROJECT_KNOWLEDGE_CURSOR_INVALID");
    const decoded = this.#decode(cursor);
    const value = JSON.parse(decoded.payload.toString("utf8")) as unknown;
    if (!plainRecord(value) || ownValue(value, "v") !== TOKEN_VERSION || ownValue(value, "actor_id") !== scope.actor_id ||
        ownValue(value, "project_id") !== scope.project_id || ownValue(value, "view") !== scope.view ||
        ownValue(value, "sort") !== scope.sort || !safePosition(ownValue(value, "last_key")) ||
        typeof ownValue(value, "fence") !== "string" || !SHA.test(ownValue(value, "fence") as string)) {
      throw new Error("PROJECT_KNOWLEDGE_CURSOR_INVALID");
    }
    return {
      current: { project_id: scope.project_id, fence: ownValue(value, "fence") as string },
      last_key: ownValue(value, "last_key") as ProjectKnowledgeCursorPosition
    };
  }

  locate(cursor: string, input: PositionedScope): ProjectKnowledgeCursorPosition {
    const position = this.readPosition(cursor, input);
    if (position.current.fence !== input.current.fence) throw new Error("PROJECT_KNOWLEDGE_CURSOR_INVALID");
    return position.last_key;
  }

  #decode(cursor: string): { readonly payload: Buffer; readonly mac: Buffer } {
    if (!text(cursor, 2048)) throw new Error("PROJECT_KNOWLEDGE_CURSOR_INVALID");
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.toString("base64url") !== cursor) throw new Error("PROJECT_KNOWLEDGE_CURSOR_INVALID");
    // The JSON payload may contain `.` (for example fractional ISO timestamps),
    // so the separator is the final byte before the fixed-length MAC rather
    // than the first dot found in the decoded bytes.
    const separator = decoded.byteLength - 33;
    if (separator <= 0 || separator > MAX_CURSOR_BYTES || decoded[separator] !== 46) {
      throw new Error("PROJECT_KNOWLEDGE_CURSOR_INVALID");
    }
    const payload = decoded.subarray(0, separator);
    const mac = decoded.subarray(separator + 1);
    const expected = createHmac("sha256", this.#secret)
      .update(tupleBytes("project-knowledge-cursor-v1", [payload.toString("base64url")])).digest();
    if (!timingSafeEqual(mac, expected)) throw new Error("PROJECT_KNOWLEDGE_CURSOR_INVALID");
    return { payload, mac };
  }
}

interface SourceOptions {
  readonly pool: Pool;
  readonly cursor_authority: ProjectKnowledgeCursorAuthority;
}

interface SourceRow extends Record<string, unknown> {
  readonly payload?: unknown;
  readonly content_sha256?: unknown;
  readonly entry_id?: unknown;
  readonly knowledge_id?: unknown;
  readonly title?: unknown;
  readonly entry_status?: unknown;
  readonly source_change_key?: unknown;
  readonly source_archive?: unknown;
  readonly source_commit?: unknown;
  readonly extracted_at?: unknown;
  readonly relationship_refs?: unknown;
  readonly projected_at?: unknown;
  readonly _total_count?: unknown;
  readonly _max_updated_at?: unknown;
  readonly result_confidence?: unknown;
  readonly result_updated_at?: unknown;
}

function sourceDescriptor(row: SourceRow): {
  readonly entry_origin: "explicit";
  readonly knowledge_id: string; readonly display_title: string; readonly lifecycle_status: string;
  readonly source_change_key: string; readonly source_refs: string[]; readonly extracted_at: string;
  readonly relationship_refs: string[];
} | null {
  if (row.payload !== undefined) {
    const parsed = knowledgeIngestEntrySchema.safeParse(row.payload);
    if (!parsed.success) return null;
    const entry = parsed.data;
    if (!persistedEntryHashMatches(row, entry)) return null;
    const refs = [entry.source.archive, entry.source.sourceCommit].filter((value, index, all) => value !== "" && all.indexOf(value) === index);
    const relationships = [...entry.lifecycle.supersedes, ...(entry.lifecycle.supersededBy === null ? [] : [entry.lifecycle.supersededBy]), ...entry.lifecycle.conflictsWith]
      .filter((value, index, all) => value !== "" && all.indexOf(value) === index);
    return {
      entry_origin: "explicit",
      knowledge_id: entry.id, display_title: entry.title, lifecycle_status: entry.status,
      source_change_key: entry.source.changeName || entry.source.sourceCommit, source_refs: refs,
      extracted_at: entry.lifecycle.createdAt, relationship_refs: relationships
    };
  }
  if (!text(row.knowledge_id ?? row.entry_id, 160) || !text(row.title, 240) || !text(row.entry_status, 64) ||
      !text(row.source_change_key, 160) || !text(row.source_archive, 160) || !text(row.source_commit, 160) ||
      !text(row.extracted_at, 64)) return null;
  const sourceRefs = [row.source_archive as string, row.source_commit as string];
  const relationships = Array.isArray(row.relationship_refs) && row.relationship_refs.every((value) => typeof value === "string")
    ? [...new Set(row.relationship_refs as string[])] : [];
  return {
    entry_origin: "explicit",
    knowledge_id: (row.knowledge_id ?? row.entry_id) as string, display_title: row.title as string,
    lifecycle_status: row.entry_status as string, source_change_key: row.source_change_key as string,
    source_refs: sourceRefs, extracted_at: row.extracted_at as string, relationship_refs: relationships
  };
}

function contentHash(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function entryContentHash(entry: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(entry), "utf8").digest("hex")}`;
}

function legacyBridgeEntryHash(entry: Record<string, unknown>, row: SourceRow): string | null {
  if (typeof row.result_confidence !== "number" || !Number.isFinite(row.result_confidence) ||
      row.result_confidence < 0 || row.result_confidence > 1) return null;
  const parsedTime = row.result_updated_at instanceof Date
    ? row.result_updated_at
    : typeof row.result_updated_at === "string" ? new Date(row.result_updated_at) : null;
  if (parsedTime === null || Number.isNaN(parsedTime.getTime())) return null;
  const score = row.result_confidence;
  return entryContentHash({
    ...entry,
    confidence: {
      score,
      level: score >= 0.9 ? "high" : score >= 0.75 ? "medium" : "low",
      signals: ["archive-review-finding"],
      lastCalculatedAt: parsedTime.toISOString()
    }
  });
}

function persistedEntryHashMatches(row: SourceRow, entry: Record<string, unknown>): boolean {
  if (row.content_sha256 === undefined) return true;
  return row.content_sha256 === entryContentHash(entry) ||
    row.content_sha256 === legacyBridgeEntryHash(entry, row);
}

export class PgProjectKnowledgeSource implements ProjectKnowledgeQuerySourcePort, KnowledgeRetryAuthorityPort {
  readonly #pool: Pool;
  readonly #cursor: ProjectKnowledgeCursorAuthority;

  constructor(options: SourceOptions) {
    this.#pool = options.pool;
    this.#cursor = options.cursor_authority;
  }

  async listPage(input: ProjectKnowledgePageSourceRequest): Promise<string> {
    const cursorScope = {
      actor_id: input.actor_id,
      project_id: input.project_id,
      view: "project_knowledge" as const,
      sort: input.sort
    };
    const position = input.cursor === null ? null : this.#cursor.readPosition(input.cursor, cursorScope);
    const result = await this.#pool.query<SourceRow>(
      `WITH current_fence AS (
         SELECT COUNT(*)::int AS total_count,
                COALESCE(MAX(updated_at)::text, '') AS max_updated_at
           FROM knowledge_ingest_entries
          WHERE project_id = $1
       )
       SELECT
         project_id,
         entry_id,
         content_sha256,
         payload->>'id' AS knowledge_id,
         payload->>'title' AS title,
         payload->>'status' AS entry_status,
         COALESCE(NULLIF(payload->'source'->>'changeName', ''), payload->'source'->>'sourceCommit') AS source_change_key,
         payload->'source'->>'archive' AS source_archive,
         payload->'source'->>'sourceCommit' AS source_commit,
         payload->'lifecycle'->>'createdAt' AS extracted_at,
         COALESCE(payload->'lifecycle'->'supersedes', '[]'::jsonb) ||
           CASE WHEN payload->'lifecycle'->>'supersededBy' IS NULL THEN '[]'::jsonb
                ELSE jsonb_build_array(payload->'lifecycle'->>'supersededBy') END ||
         COALESCE(payload->'lifecycle'->'conflictsWith', '[]'::jsonb) AS relationship_refs,
         projected_at,
         current_fence.total_count AS _total_count,
         current_fence.max_updated_at AS _max_updated_at
       FROM knowledge_ingest_entries
       CROSS JOIN current_fence
       WHERE project_id = $1
         AND ($2::text IS NULL OR
           payload->'lifecycle'->>'createdAt' < $2::text OR
           (payload->'lifecycle'->>'createdAt' = $2::text AND entry_id > $3::text))
       ORDER BY payload->'lifecycle'->>'createdAt' DESC NULLS LAST, entry_id ASC
       LIMIT $4`,
      [input.project_id, position?.last_key.extracted_at ?? null, position?.last_key.knowledge_id ?? null, input.limit + 1]
    );
    const rows = result.rows;
    const total = Number(rows[0]?._total_count ?? rows.length);
    const maxUpdated = String(rows[0]?._max_updated_at ?? "");
    const fence = digest({ project_id: input.project_id, total, max_updated_at: maxUpdated });
    const current = { project_id: input.project_id, fence } satisfies ProjectKnowledgeCurrentFence;
    if (position !== null && position.current.fence !== fence) throw new Error("PROJECT_KNOWLEDGE_CURSOR_INVALID");
    const limited = rows.slice(0, input.limit);
    const entries = limited.map(sourceDescriptor);
    const invalid = entries.some((entry) => entry === null);
    const validEntries = entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    const next = rows.length > input.limit && validEntries.at(-1) !== undefined
      ? this.#cursor.issue({
          actor_id: input.actor_id, project_id: input.project_id, view: "project_knowledge",
          sort: input.sort, current, last_key: {
            extracted_at: validEntries.at(-1)?.extracted_at ?? "", knowledge_id: validEntries.at(-1)?.knowledge_id ?? ""
          }
        })
      : null;
    const pending = limited.some((row) => row.projected_at === null);
    let pageState: "ready" | "empty" | "processing" | "failed" = "ready";
    let failures: Array<{ reason_code: "KNOWLEDGE_EXTRACTION_FAILED"; retryable: true }> = [];
    if (invalid && validEntries.length === 0) {
      pageState = "failed";
      failures = [{ reason_code: "KNOWLEDGE_EXTRACTION_FAILED", retryable: true }];
    } else if (pending) {
      pageState = "processing";
    } else if (validEntries.length === 0) {
      pageState = "empty";
    }
    return JSON.stringify({
      schema_version: 1, source_kind: "project_knowledge_page", actor_id: input.actor_id,
      project_id: input.project_id, accessible_project_ids: input.accessible_project_ids,
      content_types: ["knowledge_entry"], sort: input.sort, request_cursor: input.cursor,
      page_state: pageState, entries: validEntries, next_cursor: next, failures
    });
  }

  async getDetail(input: ProjectKnowledgeDetailSourceRequest): Promise<string | null> {
    const result = await this.#pool.query<SourceRow>(
      `SELECT ingest.project_id, ingest.entry_id, ingest.content_sha256, ingest.payload,
              result.confidence AS result_confidence, result.updated_at AS result_updated_at
         FROM knowledge_ingest_entries ingest
         LEFT JOIN knowledge_pipeline_results result
           ON result.project_id = ingest.project_id AND result.knowledge_id = ingest.entry_id
        WHERE ingest.project_id = $1 AND ingest.entry_id = $2
        LIMIT 1`, [input.project_id, input.detail_id]
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const parsed = knowledgeIngestEntrySchema.safeParse(row.payload);
    if (!parsed.success) return null;
    const entry = parsed.data;
    if (!persistedEntryHashMatches(row, entry)) return null;
    const sourceRefs = [entry.source.archive, entry.source.sourceCommit].filter((value, index, all) => value !== "" && all.indexOf(value) === index);
    return JSON.stringify({
      schema_version: 1, source_kind: "project_knowledge_detail", actor_id: input.actor_id,
      project_id: input.project_id, accessible_project_ids: input.accessible_project_ids,
      content_types: ["knowledge_entry"], sort: input.sort, request_cursor: null, detail_id: input.detail_id,
      entry_origin: "explicit", knowledge_id: entry.id, display_title: entry.title,
      source_change_key: entry.source.changeName || entry.source.sourceCommit, source_refs: sourceRefs,
      content: entry.body, content_hash: contentHash(entry.body), media_type: "text/markdown"
    });
  }

  async lookup(input: ProjectKnowledgeRetryAuthorityRequest): Promise<string> {
    void input;
    return JSON.stringify({ schema_version: 1, authority_kind: "knowledge_retry_authority",
      actor_id: input.actor_id, project_id: input.project_id, job_id: input.job_id,
      expected_generation: input.expected_generation, decision: "not_found" });
  }
}

/**
 * Read-only authority over the durable extraction-job table.  It deliberately
 * does not infer retryability from knowledge content rows: a job must be
 * explicitly failed and marked retryable by the pipeline writer.
 */
export class PgProjectKnowledgeRetryAuthority implements KnowledgeRetryAuthorityPort {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async lookup(input: ProjectKnowledgeRetryAuthorityRequest): Promise<string> {
    const result = await this.#pool.query<{
      readonly project_id?: unknown;
      readonly job_id?: unknown;
      readonly generation?: unknown;
      readonly status?: unknown;
      readonly retryable?: unknown;
    }>(
      `SELECT project_id, job_id, generation, status, retryable
         FROM knowledge_extraction_jobs
        WHERE project_id = $1 AND job_id = $2
        LIMIT 1`,
      [input.project_id, input.job_id]
    );
    const row = result.rows[0];
    const base = {
      schema_version: 1 as const,
      authority_kind: "knowledge_retry_authority" as const,
      actor_id: input.actor_id,
      project_id: input.project_id,
      job_id: input.job_id
    };
    if (row === undefined) {
      return JSON.stringify({ ...base, expected_generation: input.expected_generation, decision: "not_found" });
    }
    if (row.project_id !== input.project_id || row.job_id !== input.job_id ||
        !Number.isSafeInteger(row.generation) || (row.generation as number) < 0 ||
        (row.status !== "failed" && row.status !== "queued" && row.status !== "extracting" && row.status !== "ready") ||
        typeof row.retryable !== "boolean") {
      throw new Error("KNOWLEDGE_RETRY_AUTHORITY_INVALID");
    }
    const generation = row.generation as number;
    if (row.status === "failed" && row.retryable === true) {
      return JSON.stringify({
        ...base,
        expected_generation: generation,
        decision: "authorized",
        accessible_project_ids: [input.project_id],
        job_status: "failed",
        retryable: true
      });
    }
    return JSON.stringify({ ...base, expected_generation: generation, decision: "forbidden" });
  }
}
