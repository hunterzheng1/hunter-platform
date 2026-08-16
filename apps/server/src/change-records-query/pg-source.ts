import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { types as utilTypes } from "node:util";

import type { Pool } from "pg";

import type {
  ChangeDocumentReferencePort,
  ChangeRecordsQuerySourcePort
} from "./ports.js";
import type {
  ChangeRecordsDetailSourceRequest,
  ChangeRecordsPageSourceRequest
} from "./types.js";

const SECRET_BYTES = 32;
const MAX_CURSOR_BYTES = 1024;
const PROJECT = /^prj_[A-Za-z0-9_-]{1,156}$/u;
const CHANGE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;
const SHA = /^sha256:[a-f0-9]{64}$/u;

interface ChangeCursorScope {
  readonly actor_id: string;
  readonly project_id: string;
  readonly view: "change_records";
  readonly sort: "archived_at_desc_change_key_asc";
}

interface ChangeCursorPosition {
  readonly archived_at: string;
  readonly change_key: string;
}

interface PositionedChangeScope extends ChangeCursorScope {
  readonly current: { readonly project_id: string; readonly fence: string };
  readonly last_key: ChangeCursorPosition;
}

function ownValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    !utilTypes.isProxy(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function text(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    value === value.trim() && value === value.normalize("NFC") &&
    !Array.from(value).some((char) => {
      const point = char.codePointAt(0) ?? 0;
      return point <= 31 || point === 127 || (point >= 0xd800 && point <= 0xdfff);
    });
}

function tupleBytes(domain: string, fields: readonly string[]): Buffer {
  return Buffer.concat([domain, ...fields].map((field) => {
    const bytes = Buffer.from(field, "utf8");
    return Buffer.concat([Buffer.from(`${bytes.byteLength}:`, "ascii"), bytes]);
  }));
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

function safeScope(value: unknown): value is ChangeCursorScope {
  if (!plainRecord(value)) return false;
  return text(ownValue(value, "actor_id"), 160) &&
    typeof ownValue(value, "project_id") === "string" &&
    PROJECT.test(ownValue(value, "project_id") as string) &&
    ownValue(value, "view") === "change_records" &&
    ownValue(value, "sort") === "archived_at_desc_change_key_asc";
}

function safePosition(value: unknown): value is ChangeCursorPosition {
  return plainRecord(value) && text(ownValue(value, "archived_at"), 64) &&
    typeof ownValue(value, "change_key") === "string" &&
    CHANGE.test(ownValue(value, "change_key") as string);
}

export class ChangeRecordsCursorAuthority {
  readonly #secret: Buffer;

  constructor(secret: Uint8Array) {
    if (utilTypes.isProxy(secret) || !utilTypes.isUint8Array(secret) || secret.byteLength !== SECRET_BYTES) {
      throw new Error("CHANGE_RECORDS_CURSOR_SECRET_INVALID");
    }
    const copy = Buffer.from(secret.buffer, secret.byteOffset, secret.byteLength);
    if (new Set(copy).size < 16) throw new Error("CHANGE_RECORDS_CURSOR_SECRET_INVALID");
    this.#secret = Buffer.from(copy);
  }

  issue(input: PositionedChangeScope): string {
    if (!safeScope(input) || !plainRecord(input.current) ||
        input.current.project_id !== input.project_id || !SHA.test(input.current.fence) ||
        !safePosition(input.last_key)) throw new Error("CHANGE_RECORDS_CURSOR_INVALID");
    const payload = Buffer.from(JSON.stringify({
      v: 1, actor_id: input.actor_id, project_id: input.project_id,
      view: input.view, sort: input.sort, fence: input.current.fence,
      last_key: input.last_key
    }), "utf8");
    if (payload.byteLength > MAX_CURSOR_BYTES) throw new Error("CHANGE_RECORDS_CURSOR_INVALID");
    const mac = createHmac("sha256", this.#secret)
      .update(tupleBytes("change-records-cursor-v1", [payload.toString("base64url")])).digest();
    return Buffer.concat([payload, Buffer.from("."), mac]).toString("base64url");
  }

  verify(input: {
    readonly cursor: string;
    readonly actor_id: string;
    readonly project_id: string;
    readonly view: "change_records";
    readonly sort: "archived_at_desc_change_key_asc";
  }): boolean {
    try {
      const decoded = this.#decode(input.cursor);
      const value = JSON.parse(decoded.payload.toString("utf8")) as unknown;
      return plainRecord(value) && ownValue(value, "v") === 1 &&
        ownValue(value, "actor_id") === input.actor_id &&
        ownValue(value, "project_id") === input.project_id &&
        ownValue(value, "view") === input.view &&
        ownValue(value, "sort") === input.sort &&
        typeof ownValue(value, "fence") === "string" &&
        SHA.test(ownValue(value, "fence") as string) && safePosition(ownValue(value, "last_key"));
    } catch {
      return false;
    }
  }

  readPosition(cursor: string, scope: ChangeCursorScope): {
    readonly current: { readonly project_id: string; readonly fence: string };
    readonly last_key: ChangeCursorPosition;
  } {
    if (!safeScope(scope)) throw new Error("CHANGE_RECORDS_CURSOR_INVALID");
    const decoded = this.#decode(cursor);
    const value = JSON.parse(decoded.payload.toString("utf8")) as unknown;
    if (!plainRecord(value) || ownValue(value, "v") !== 1 ||
        ownValue(value, "actor_id") !== scope.actor_id ||
        ownValue(value, "project_id") !== scope.project_id ||
        ownValue(value, "view") !== scope.view || ownValue(value, "sort") !== scope.sort ||
        typeof ownValue(value, "fence") !== "string" || !SHA.test(ownValue(value, "fence") as string) ||
        !safePosition(ownValue(value, "last_key"))) {
      throw new Error("CHANGE_RECORDS_CURSOR_INVALID");
    }
    return {
      current: { project_id: scope.project_id, fence: ownValue(value, "fence") as string },
      last_key: ownValue(value, "last_key") as ChangeCursorPosition
    };
  }

  #decode(cursor: string): { readonly payload: Buffer; readonly mac: Buffer } {
    if (!text(cursor, 2048)) throw new Error("CHANGE_RECORDS_CURSOR_INVALID");
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.toString("base64url") !== cursor) throw new Error("CHANGE_RECORDS_CURSOR_INVALID");
    const separator = decoded.byteLength - 33;
    if (separator <= 0 || separator > MAX_CURSOR_BYTES || decoded[separator] !== 46) {
      throw new Error("CHANGE_RECORDS_CURSOR_INVALID");
    }
    const payload = decoded.subarray(0, separator);
    const mac = decoded.subarray(separator + 1);
    const expected = createHmac("sha256", this.#secret)
      .update(tupleBytes("change-records-cursor-v1", [payload.toString("base64url")])).digest();
    if (mac.byteLength !== expected.byteLength || !timingSafeEqual(mac, expected)) {
      throw new Error("CHANGE_RECORDS_CURSOR_INVALID");
    }
    return { payload, mac };
  }
}

interface ArchiveRow extends Record<string, unknown> {
  readonly archive_id?: unknown;
  readonly project_id?: unknown;
  readonly change_key?: unknown;
  readonly package_sha256?: unknown;
  readonly knowledge_status?: unknown;
  readonly created_at?: unknown;
  readonly updated_at?: unknown;
  readonly attempt_count?: unknown;
  readonly failure_stage?: unknown;
  readonly last_error_code?: unknown;
}

function iso(value: unknown): string | null {
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function archiveRecord(row: ArchiveRow): {
  readonly change_key: string; readonly title: string; readonly archived_at: string;
  readonly archive_status: "durable"; readonly archive_id: string; readonly package_sha256: string;
  readonly knowledge_extraction_status: "queued" | "ready" | "failed";
  readonly projection_status: "queued" | "failed";
  readonly document_refs: string[]; readonly document_snapshots: Array<{ document_id: string; content_hash: string }>;
  readonly candidate_refs: string[];
} | null {
  const changeKey = row.change_key;
  const archiveId = row.archive_id;
  const packageHash = row.package_sha256;
  const archivedAt = iso(row.created_at);
  if (typeof changeKey !== "string" || !CHANGE.test(changeKey) ||
      typeof archiveId !== "string" || !text(archiveId, 160) ||
      typeof packageHash !== "string" || !SHA.test(packageHash) || archivedAt === null) return null;
  const knowledge = row.knowledge_status === "ready" ? "ready" as const
    : row.knowledge_status === "failed" ? "failed" as const : "queued" as const;
  return {
    change_key: changeKey, title: changeKey, archived_at: archivedAt,
    archive_status: "durable", archive_id: archiveId, package_sha256: packageHash,
    knowledge_extraction_status: knowledge,
    projection_status: row.knowledge_status === "failed" ? "failed" : "queued",
    document_refs: [], document_snapshots: [], candidate_refs: []
  };
}

interface SourceOptions {
  readonly pool: Pool;
  readonly cursor_authority: ChangeRecordsCursorAuthority;
}

export class PgChangeArchiveSource implements ChangeRecordsQuerySourcePort, ChangeDocumentReferencePort {
  readonly #pool: Pool;
  readonly #cursor: ChangeRecordsCursorAuthority;

  constructor(options: SourceOptions) {
    this.#pool = options.pool;
    this.#cursor = options.cursor_authority;
  }

  async listPage(input: ChangeRecordsPageSourceRequest): Promise<string> {
    const scope = {
      actor_id: input.actor_id, project_id: input.project_id,
      view: "change_records" as const, sort: input.sort
    };
    const position = input.cursor === null ? null : this.#cursor.readPosition(input.cursor, scope);
    const result = await this.#pool.query<ArchiveRow>(
      `WITH current_fence AS (
         SELECT COUNT(*)::int AS total_count,
                COALESCE(MAX(updated_at)::text, '') AS max_updated_at
           FROM change_archive_packages
          WHERE project_id = $1
       )
       SELECT archive_id, project_id, change_key, package_sha256,
              knowledge_status, created_at, updated_at, attempt_count,
              failure_stage, last_error_code,
              current_fence.total_count AS _total_count,
              current_fence.max_updated_at AS _max_updated_at
         FROM change_archive_packages
         CROSS JOIN current_fence
        WHERE project_id = $1
          AND ($2::text IS NULL OR created_at < $2::timestamptz OR
            (created_at = $2::timestamptz AND change_key > $3::text))
        ORDER BY created_at DESC, change_key ASC
        LIMIT $4`,
      [input.project_id, position?.last_key.archived_at ?? null,
        position?.last_key.change_key ?? null, input.limit + 1]
    );
    const total = Number(result.rows[0]?._total_count ?? result.rows.length);
    const maxUpdated = String(result.rows[0]?._max_updated_at ?? "");
    const fence = digest({ project_id: input.project_id, total, max_updated_at: maxUpdated });
    if (position !== null && position.current.fence !== fence) {
      throw new Error("CHANGE_RECORDS_CURSOR_INVALID");
    }
    const rows = result.rows;
    const records = rows.slice(0, input.limit).map(archiveRecord);
    if (records.some((record) => record === null)) throw new Error("CHANGE_RECORDS_SOURCE_INVALID");
    const valid = records.filter((record): record is NonNullable<typeof record> => record !== null);
    const next = rows.length > input.limit && valid.at(-1) !== undefined
      ? this.#cursor.issue({
          ...scope, current: { project_id: input.project_id, fence },
          last_key: { archived_at: valid.at(-1)?.archived_at ?? "", change_key: valid.at(-1)?.change_key ?? "" }
        })
      : null;
    return JSON.stringify({
      schema_version: 1, source_kind: "change_records_page", actor_id: input.actor_id,
      project_id: input.project_id, accessible_project_ids: input.accessible_project_ids,
      content_types: input.content_types, sort: input.sort, request_cursor: input.cursor,
      page_state: valid.length === 0 ? "empty" : "processing", records: valid,
      next_cursor: next, failures: []
    });
  }

  async getDetail(input: ChangeRecordsDetailSourceRequest): Promise<string | null> {
    const result = await this.#pool.query<ArchiveRow>(
      `SELECT archive_id, project_id, change_key, package_sha256, knowledge_status,
              created_at, updated_at, attempt_count, failure_stage, last_error_code
         FROM change_archive_packages
        WHERE project_id = $1 AND change_key = $2
        LIMIT 1`, [input.project_id, input.detail_id]
    );
    const record = archiveRecord(result.rows[0] ?? {});
    if (record === null) return null;
    return JSON.stringify({
      schema_version: 1, source_kind: "change_record_detail", actor_id: input.actor_id,
      project_id: input.project_id, accessible_project_ids: input.accessible_project_ids,
      content_types: input.content_types, detail_id: input.detail_id, sort: input.sort,
      request_cursor: null, change_key: record.change_key, document_refs: [],
      document_snapshots: [], candidate_refs: [], archive_id: record.archive_id,
      package_sha256: record.package_sha256
    });
  }

  async resolve(input: {
    readonly actor_id: string;
    readonly project_id: string;
    readonly references: readonly { readonly change_key: string; readonly document_ids: readonly string[] }[];
  }): Promise<string> {
    if (input.references.some((reference) => reference.document_ids.length > 0)) {
      throw new Error("CHANGE_DOCUMENT_PROJECTION_UNAVAILABLE");
    }
    return JSON.stringify({
      schema_version: 1, source_kind: "change_document_reference_resolution",
      actor_id: input.actor_id, project_id: input.project_id,
      references: input.references, descriptors: []
    });
  }
}
