import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import type { Pool, QueryResultRow } from "pg";

import type { BlobReadPort } from "../branch-snapshots/ports.js";
import type {
  ProjectMaterialsSourceDetailQuery,
  ProjectMaterialsSourcePort,
  ProjectMaterialsSourceQuery
} from "./query-adapter.js";
import {
  projectMaterialId
} from "./cursor-authority.js";
import type {
  ProjectMaterialsCursorAuthority,
  ProjectMaterialsCurrentIdentity,
  ProjectMaterialsKey
} from "./cursor-authority.js";

const CATEGORY_SQL = `CASE
  WHEN file.content_kind = 'config' AND
    (file.path = '.harness/project.yaml' OR file.path LIKE '.harness/config/%') THEN 'config'
  WHEN file.content_kind = 'rule' AND file.path = '.harness/rules/architecture.md'
    THEN 'architecture_constraint'
  WHEN file.content_kind = 'rule' AND file.path LIKE '.harness/rules/%'
    THEN 'rule'
  WHEN file.content_kind = 'architecture' AND
    (file.path = '.harness/codebase/map-manifest.json' OR file.path LIKE '.harness/codebase/map/%')
    THEN 'architecture_map'
  WHEN file.content_kind = 'instruction' AND file.path IN ('AGENTS.md', 'CLAUDE.md', 'CODEBUDDY.md')
    THEN 'instruction'
  ELSE NULL
END`;

function sqlLengthPrefixed(value: string): string {
  return `octet_length(convert_to(${value}, 'UTF8'))::text || ':' || ${value}`;
}

const MATERIAL_ID_SQL = `'material_' || encode(sha256(convert_to(
  ${[
    "'project-material-id-v1'", "project_id", "branch_name", "commit_sha",
    "project_version", "artifact_id", "manifest_hash", "category", "path"
  ].map(sqlLengthPrefixed).join(" || ")}, 'UTF8')), 'hex')`;

const allowedContentTypes = Object.freeze(["config", "rule", "architecture", "instruction"] as const);
const allowedMediaTypes = new Set([
  "text/plain", "text/markdown", "application/json", "application/yaml"
]);
const hashPattern = /^sha256:[a-f0-9]{64}$/u;

type Category = ProjectMaterialsKey["category"];

interface MaterialRow {
  readonly category: Category;
  readonly path: string;
  readonly content_kind: "config" | "rule" | "architecture" | "instruction";
  readonly size_bytes: number;
  readonly content_hash: string;
  readonly media_type: string;
}

function forbidden(projectId: string): string {
  return JSON.stringify({
    schema_version: 1,
    project_id: projectId,
    page_state: "forbidden",
    items: [],
    next_cursor: null,
    failures: [{ reason_code: "PROJECT_INFORMATION_FORBIDDEN", retryable: false }]
  });
}

function processing(projectId: string): string {
  return JSON.stringify({
    schema_version: 1,
    project_id: projectId,
    page_state: "processing",
    items: [],
    next_cursor: null,
    failures: []
  });
}

function plainInput(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    !utilTypes.isProxy(value);
}

function validText(value: unknown, maximum = 160): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum &&
    value === value.trim() && value === value.normalize("NFC") &&
    !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff);
    });
}

function validQuery(input: ProjectMaterialsSourceQuery): boolean {
  if (!plainInput(input) || !validText(input.actor_id) ||
      typeof input.project_id !== "string" || !/^prj_[A-Za-z0-9_-]{1,156}$/u.test(input.project_id) ||
      !Array.isArray(input.accessible_project_ids) || utilTypes.isProxy(input.accessible_project_ids) ||
      input.accessible_project_ids.some((value) => typeof value !== "string") ||
      !Array.isArray(input.content_types) || utilTypes.isProxy(input.content_types) ||
      JSON.stringify(input.content_types) !== JSON.stringify(allowedContentTypes) ||
      input.sort !== "category_asc_path_asc_version_desc" ||
      !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100 ||
      !(input.cursor === null || typeof input.cursor === "string")) return false;
  return true;
}

function validDetailQuery(input: ProjectMaterialsSourceDetailQuery): boolean {
  return plainInput(input) && validText(input.actor_id) &&
    typeof input.project_id === "string" && /^prj_[A-Za-z0-9_-]{1,156}$/u.test(input.project_id) &&
    Array.isArray(input.accessible_project_ids) && !utilTypes.isProxy(input.accessible_project_ids) &&
    input.accessible_project_ids.every((value) => typeof value === "string") &&
    Array.isArray(input.content_types) && !utilTypes.isProxy(input.content_types) &&
    JSON.stringify(input.content_types) === JSON.stringify(allowedContentTypes) &&
    typeof input.material_id === "string" && /^material_[a-f0-9]{64}$/u.test(input.material_id);
}

function identityFrom(row: QueryResultRow, projectId: string): ProjectMaterialsCurrentIdentity {
  const identity = {
    project_id: String(row.project_id),
    branch_name: String(row.branch_name),
    commit_sha: String(row.commit_sha),
    project_version: String(row.project_version),
    artifact_id: String(row.artifact_id),
    manifest_hash: String(row.manifest_hash)
  };
  if (identity.project_id !== projectId || !validText(identity.branch_name) ||
      !/^[a-f0-9]{40,64}$/u.test(identity.commit_sha) || !validText(identity.project_version) ||
      !validText(identity.artifact_id) || !hashPattern.test(identity.manifest_hash)) {
    throw new Error("PROJECT_MATERIALS_SNAPSHOT_INVALID");
  }
  return identity;
}

function rowFrom(value: QueryResultRow): MaterialRow {
  const row = {
    category: String(value.category) as Category,
    path: String(value.path),
    content_kind: String(value.content_kind) as MaterialRow["content_kind"],
    size_bytes: Number(value.size_bytes),
    content_hash: String(value.content_hash),
    media_type: String(value.media_type)
  };
  if (!["config", "rule", "architecture_map", "architecture_constraint", "instruction"]
    .includes(row.category) || !validText(row.path, 1024) || !Number.isSafeInteger(row.size_bytes) ||
      row.size_bytes < 0 || !hashPattern.test(row.content_hash) || !allowedMediaTypes.has(row.media_type)) {
    throw new Error("PROJECT_MATERIALS_ROW_INVALID");
  }
  const expectedKind = row.category === "architecture_map" ? "architecture"
    : row.category === "architecture_constraint" || row.category === "rule" ? "rule"
      : row.category;
  if (row.content_kind !== expectedKind) throw new Error("PROJECT_MATERIALS_ROW_INVALID");
  return row;
}

function keyFor(row: MaterialRow, identity: ProjectMaterialsCurrentIdentity): ProjectMaterialsKey {
  return { category: row.category, path: row.path, snapshot_version: identity.project_version };
}

export class PgProjectMaterialsSource implements ProjectMaterialsSourcePort {
  readonly #pool: Pool;
  readonly #blobReader: BlobReadPort;
  readonly #cursorAuthority: ProjectMaterialsCursorAuthority;

  constructor(dependencies: {
    readonly pool: Pool;
    readonly blob_reader: BlobReadPort;
    readonly cursor_authority: ProjectMaterialsCursorAuthority;
  }) {
    this.#pool = dependencies.pool;
    this.#blobReader = dependencies.blob_reader;
    this.#cursorAuthority = dependencies.cursor_authority;
  }

  async list(input: ProjectMaterialsSourceQuery): Promise<string> {
    if (!validQuery(input)) throw new Error("PROJECT_MATERIALS_QUERY_INVALID");
    if (!input.accessible_project_ids.includes(input.project_id)) return forbidden(input.project_id);
    const identity = await this.#current(input.actor_id, input.project_id);
    if (identity === "forbidden") return forbidden(input.project_id);
    if (identity === null) {
      if (input.cursor !== null) throw new Error("PROJECT_MATERIALS_CURSOR_INVALID");
      return processing(input.project_id);
    }

    let after: MaterialRow | null = null;
    if (input.cursor !== null) {
      const locator = this.#cursorAuthority.locate(input.cursor, {
        actor_id: input.actor_id,
        project_id: input.project_id,
        view: "project_materials",
        sort: input.sort,
        current: identity
      });
      after = await this.#findMaterial(identity, locator);
      if (after === null) throw new Error("PROJECT_MATERIALS_CURSOR_INVALID");
      this.#cursorAuthority.assertPosition(input.cursor, {
        actor_id: input.actor_id,
        project_id: input.project_id,
        view: "project_materials",
        sort: input.sort,
        current: identity,
        last_key: keyFor(after, identity)
      });
    }

    const values: unknown[] = [
      identity.project_id, identity.branch_name, identity.commit_sha, identity.project_version,
      identity.artifact_id, identity.manifest_hash
    ];
    const keyset = after === null ? "" : `AND (
      category COLLATE "C" > $7 COLLATE "C" OR
      (category = $7 AND path COLLATE "C" > $8 COLLATE "C") OR
      (category = $7 AND path = $8 AND project_version COLLATE "C" < $9 COLLATE "C")
    )`;
    if (after !== null) values.push(after.category, after.path, identity.project_version);
    values.push(input.limit + 1);
    const result = await this.#pool.query(
      `WITH materials AS (
        SELECT file.project_id, file.branch_name, file.commit_sha, file.project_version,
          file.artifact_id, file.manifest_hash, file.path, file.content_kind,
          file.size_bytes, file.content_hash, file.media_type, ${CATEGORY_SQL} AS category
        FROM branch_snapshot_files file
        WHERE file.project_id = $1 AND file.branch_name = $2 AND file.commit_sha = $3
          AND file.project_version = $4 AND file.artifact_id = $5 AND file.manifest_hash = $6
      )
      SELECT category, path, content_kind, size_bytes, content_hash, media_type
      FROM materials WHERE category IS NOT NULL ${keyset}
      ORDER BY category COLLATE "C" ASC, path COLLATE "C" ASC,
        project_version COLLATE "C" DESC LIMIT $${values.length}`,
      values
    );
    const rows = result.rows.map(rowFrom);
    const hasNext = rows.length > input.limit;
    const pageRows = rows.slice(0, input.limit);
    const items = pageRows.map((row) => {
      const key = keyFor(row, identity);
      return {
        material_id: projectMaterialId(identity, key),
        content_type: row.content_kind,
        category: row.category,
        path: row.path,
        blob_hash: row.content_hash,
        snapshot_version: identity.project_version,
        source_branch_name: identity.branch_name,
        source_commit_sha: identity.commit_sha,
        sort_key: `${row.category}|${row.path}|${identity.project_version}`
      };
    });
    const last = pageRows.at(-1);
    const nextCursor = hasNext && last !== undefined
      ? this.#cursorAuthority.issue({
          actor_id: input.actor_id,
          project_id: input.project_id,
          view: "project_materials",
          sort: input.sort,
          current: identity,
          last_key: keyFor(last, identity)
        })
      : null;
    return JSON.stringify({
      schema_version: 1,
      project_id: input.project_id,
      page_state: items.length === 0 ? "empty" : "ready",
      items,
      next_cursor: nextCursor,
      failures: []
    });
  }

  async detail(input: ProjectMaterialsSourceDetailQuery): Promise<string | null> {
    if (!validDetailQuery(input)) throw new Error("PROJECT_MATERIALS_DETAIL_INVALID");
    if (!input.accessible_project_ids.includes(input.project_id)) return null;
    const identity = await this.#current(input.actor_id, input.project_id);
    if (identity === "forbidden") return null;
    if (identity === null) throw new Error("PROJECT_MATERIALS_SNAPSHOT_PROCESSING");
    const row = await this.#findMaterial(identity, input.material_id);
    if (row === null) return null;
    const raw = await this.#blobReader.readBlob(row.content_hash);
    if (raw === null || !ArrayBuffer.isView(raw) || utilTypes.isProxy(raw) ||
        raw.byteLength !== row.size_bytes || raw.byteLength > 2_000_000) {
      throw new Error("PROJECT_MATERIALS_BLOB_INVALID");
    }
    const bytes = new Uint8Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    const contentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (contentHash !== row.content_hash) throw new Error("PROJECT_MATERIALS_BLOB_INVALID");
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("PROJECT_MATERIALS_BLOB_INVALID");
    }
    if (/\p{Surrogate}/u.test(content) || Buffer.byteLength(content, "utf8") !== bytes.byteLength ||
        content.length > 2_000_000) throw new Error("PROJECT_MATERIALS_BLOB_INVALID");
    return JSON.stringify({
      schema_version: 1,
      project_id: input.project_id,
      material_id: input.material_id,
      content_type: row.content_kind,
      category: row.category,
      path: row.path,
      blob_hash: row.content_hash,
      snapshot_version: identity.project_version,
      source_branch_name: identity.branch_name,
      source_commit_sha: identity.commit_sha,
      content,
      content_hash: contentHash,
      media_type: row.media_type
    });
  }

  async #current(actorId: string, projectId: string): Promise<ProjectMaterialsCurrentIdentity | null | "forbidden"> {
    const current = await this.#pool.query(
      `SELECT project.latest_project_version AS current_project_version,
         project.latest_artifact_id AS current_artifact_id,
         snapshot.project_id, snapshot.branch_name, snapshot.commit_sha,
         snapshot.project_version, snapshot.artifact_id, snapshot.manifest_hash
       FROM projects project
       LEFT JOIN branch_snapshots snapshot
         ON snapshot.project_id = project.project_id
        AND snapshot.project_version = project.latest_project_version
        AND snapshot.artifact_id = project.latest_artifact_id
       WHERE project.project_id = $1 AND project.owner_actor_id = $2
       ORDER BY snapshot.branch_name COLLATE "C" ASC,
         snapshot.commit_sha COLLATE "C" ASC, snapshot.manifest_hash COLLATE "C" ASC
       LIMIT 2`,
      [projectId, actorId]
    );
    if (current.rowCount === 0) return "forbidden";
    if (current.rowCount !== 1) throw new Error("PROJECT_MATERIALS_SNAPSHOT_AMBIGUOUS");
    const row = current.rows[0];
    if (row === undefined || row.current_project_version === null ||
        row.current_artifact_id === null || row.project_id === null) return null;
    if (typeof row.current_project_version !== "string" || typeof row.current_artifact_id !== "string" ||
        row.current_project_version !== row.project_version || row.current_artifact_id !== row.artifact_id) {
      throw new Error("PROJECT_MATERIALS_SNAPSHOT_INVALID");
    }
    return identityFrom(row, projectId);
  }

  async #findMaterial(identity: ProjectMaterialsCurrentIdentity, materialId: string): Promise<MaterialRow | null> {
    const result = await this.#pool.query(
      `WITH materials AS (
        SELECT file.project_id, file.branch_name, file.commit_sha, file.project_version,
          file.artifact_id, file.manifest_hash, file.path, file.content_kind,
          file.size_bytes, file.content_hash, file.media_type, ${CATEGORY_SQL} AS category
        FROM branch_snapshot_files file
        WHERE file.project_id = $1 AND file.branch_name = $2 AND file.commit_sha = $3
          AND file.project_version = $4 AND file.artifact_id = $5 AND file.manifest_hash = $6
      )
      SELECT category, path, content_kind, size_bytes, content_hash, media_type
      FROM materials WHERE category IS NOT NULL AND ${MATERIAL_ID_SQL} = $7 LIMIT 2`,
      [identity.project_id, identity.branch_name, identity.commit_sha, identity.project_version,
        identity.artifact_id, identity.manifest_hash, materialId]
    );
    if (result.rowCount === 0) return null;
    if (result.rowCount !== 1) throw new Error("PROJECT_MATERIALS_ID_AMBIGUOUS");
    return rowFrom(result.rows[0] ?? {});
  }
}
