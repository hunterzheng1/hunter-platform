import { createHash, randomBytes } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

import type {
  BlobReadPort, BranchRepositoryPageRequest, BranchSnapshotRepositoryPort,
  CursorCapability, CursorVerifierPort, RepositoryPageEnvelope, RepositoryPageRequest,
  SnapshotRepositoryPageRequest
} from "./ports.js";
import type {
  BranchSnapshotRecord, BranchSnapshotSeed, SnapshotFileRef, SnapshotIdentity
} from "./types.js";
import {
  branchSnapshotRecordSchema, snapshotPlain, validateSnapshotManifest
} from "./module.js";

const identityColumns = [
  "project_id", "branch_name", "commit_sha", "project_version", "artifact_id", "manifest_hash"
] as const;
const order = `uploaded_at DESC, project_version COLLATE "C" ASC, branch_name COLLATE "C" ASC,
  artifact_id COLLATE "C" ASC, commit_sha COLLATE "C" ASC, manifest_hash COLLATE "C" ASC`;

function identityValues(identity: SnapshotIdentity): string[] {
  return identityColumns.map((key) => identity[key]);
}

function identityWhere(start = 1, alias = "snapshot"): string {
  return identityColumns.map((column, index) => `${alias}.${column} = $${start + index}`).join(" AND ");
}

function fileFrom(row: QueryResultRow): SnapshotFileRef {
  return {
    path: String(row.path),
    content_kind: String(row.content_kind) as SnapshotFileRef["content_kind"],
    size: Number(row.size_bytes),
    content_hash: String(row.content_hash),
    media_type: String(row.media_type) as SnapshotFileRef["media_type"],
    ...(row.action === null ? {} : { action: String(row.action) as SnapshotFileRef["action"] })
  };
}

function identityFrom(row: QueryResultRow): SnapshotIdentity {
  return {
    project_id: String(row.project_id), branch_name: String(row.branch_name),
    commit_sha: String(row.commit_sha), project_version: String(row.project_version),
    artifact_id: String(row.artifact_id), manifest_hash: String(row.manifest_hash)
  };
}

async function recordFrom(client: Pool | PoolClient, row: QueryResultRow): Promise<BranchSnapshotRecord> {
  const identity = identityFrom(row);
  const files = await client.query(
    `SELECT path, content_kind, size_bytes, content_hash, media_type, action
     FROM branch_snapshot_files snapshot WHERE ${identityWhere()} ORDER BY path COLLATE "C" ASC`,
    identityValues(identity)
  );
  return validateSnapshotManifest(branchSnapshotRecordSchema.parse({
    ...identity, schema_version: Number(row.schema_version), file_count: Number(row.file_count),
    changed_file_count: Number(row.changed_file_count), uploaded_at: new Date(row.uploaded_at).toISOString(),
    diff_ref: String(row.diff_ref), files: files.rows.map(fileFrom), changed_paths: row.changed_paths
  }));
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 160 &&
    value === value.trim() && value === value.normalize("NFC") &&
    !Array.from(value).some((character) => (character.codePointAt(0) ?? 0) < 32);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function canonicalIdentity(raw: unknown, projectId: string): SnapshotIdentity {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("BRANCH_SNAPSHOT_CURSOR_INVALID");
  }
  const identity = raw as Record<string, unknown>;
  if (!exactKeys(identity, identityColumns) || identity.project_id !== projectId ||
      typeof identity.project_id !== "string" || !/^prj_[A-Za-z0-9_-]{1,156}$/u.test(identity.project_id) ||
      !validId(identity.branch_name) || typeof identity.commit_sha !== "string" ||
      !/^[a-f0-9]{40,64}$/u.test(identity.commit_sha) || !validId(identity.project_version) ||
      !validId(identity.artifact_id) || typeof identity.manifest_hash !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(identity.manifest_hash)) {
    throw new Error("BRANCH_SNAPSHOT_CURSOR_INVALID");
  }
  return {
    project_id: identity.project_id, branch_name: identity.branch_name,
    commit_sha: identity.commit_sha, project_version: identity.project_version,
    artifact_id: identity.artifact_id, manifest_hash: identity.manifest_hash
  };
}

function canonicalCapability(raw: unknown): CursorCapability {
  let plain: unknown;
  try { plain = snapshotPlain(raw); } catch { throw new Error("BRANCH_SNAPSHOT_CURSOR_INVALID"); }
  if (plain === null || typeof plain !== "object" || Array.isArray(plain)) {
    throw new Error("BRANCH_SNAPSHOT_CURSOR_INVALID");
  }
  const value = plain as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  const expected = value.query_kind === "versions"
    ? ["actor_id", "branch_name", "offset", "project_id", "query_kind"]
    : value.query_kind === "files"
      ? ["actor_id", "identity", "offset", "project_id", "query_kind"]
      : ["actor_id", "offset", "project_id", "query_kind"];
  if (JSON.stringify(keys) !== JSON.stringify(expected) || !validId(value.actor_id) ||
      typeof value.project_id !== "string" || !/^prj_[A-Za-z0-9_-]{1,156}$/u.test(value.project_id) ||
      !Number.isSafeInteger(value.offset) || (value.offset as number) < 0 ||
      !["branches", "project_versions", "versions", "files"].includes(String(value.query_kind))) {
    throw new Error("BRANCH_SNAPSHOT_CURSOR_INVALID");
  }
  const base = { actor_id: value.actor_id, project_id: value.project_id };
  if (value.query_kind === "versions") {
    if (!validId(value.branch_name)) throw new Error("BRANCH_SNAPSHOT_CURSOR_INVALID");
    return { ...base, query_kind: "versions", branch_name: value.branch_name, offset: value.offset as number };
  }
  if (value.query_kind === "files") {
    return { ...base, query_kind: "files", identity: canonicalIdentity(value.identity, value.project_id),
      offset: value.offset as number };
  }
  return { ...base, query_kind: value.query_kind as "branches" | "project_versions",
    offset: value.offset as number };
}

function capabilityKey(value: CursorCapability): string { return JSON.stringify(value); }

export class PgBranchSnapshotPort implements BranchSnapshotRepositoryPort, BlobReadPort, CursorVerifierPort {
  constructor(private readonly pool: Pool) {}

  private async authorize(input: {
    actor_id: string; allowed_project_ids: readonly string[]; project_id: string;
  }): Promise<void> {
    if (!input.allowed_project_ids.includes(input.project_id)) throw new Error("BRANCH_SNAPSHOT_FORBIDDEN");
    const result = await this.pool.query(
      "SELECT 1 FROM projects WHERE project_id = $1 AND owner_actor_id = $2", [input.project_id, input.actor_id]
    );
    if (result.rowCount !== 1) throw new Error("BRANCH_SNAPSHOT_FORBIDDEN");
  }

  async persistSnapshotWithClient(
    client: PoolClient,
    input: { actor_id: string; seed: BranchSnapshotSeed }
  ): Promise<BranchSnapshotRecord> {
    const plain = snapshotPlain(input.seed) as BranchSnapshotSeed;
    const refs: SnapshotFileRef[] = plain.files.map((file) => ({
      path: file.path, content_kind: file.content_kind, size: file.size,
      content_hash: file.content_hash, media_type: file.media_type,
      ...(file.action === undefined ? {} : { action: file.action })
    }));
    const record = validateSnapshotManifest(branchSnapshotRecordSchema.parse({ ...plain, files: refs }));
    const project = await client.query(
      "SELECT 1 FROM projects WHERE project_id = $1 AND owner_actor_id = $2 FOR SHARE",
      [record.project_id, input.actor_id]
    );
    if (project.rowCount !== 1) throw new Error("BRANCH_SNAPSHOT_FORBIDDEN");
    for (const file of plain.files) {
      const bytes = Buffer.from(file.content, "utf8");
      if (/\p{Surrogate}/u.test(file.content) || bytes.byteLength !== file.size ||
          `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== file.content_hash) {
        throw new Error("BRANCH_SNAPSHOT_BLOB_INVALID");
      }
      const blob = await client.query(
        `INSERT INTO branch_snapshot_blobs(content_hash, content_bytes, size_bytes)
         VALUES ($1, $2, $3) ON CONFLICT (content_hash) DO UPDATE
         SET content_hash = EXCLUDED.content_hash
         WHERE branch_snapshot_blobs.size_bytes = EXCLUDED.size_bytes
           AND branch_snapshot_blobs.content_bytes = EXCLUDED.content_bytes RETURNING content_hash`,
        [file.content_hash, bytes, file.size]
      );
      if (blob.rowCount !== 1) throw new Error("BRANCH_SNAPSHOT_BLOB_HASH_CONFLICT");
    }
    let inserted;
    try {
      inserted = await client.query(
        `INSERT INTO branch_snapshots(project_id, branch_name, commit_sha, project_version,
           artifact_id, manifest_hash, schema_version, file_count, changed_file_count,
           uploaded_at, diff_ref, changed_paths)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) RETURNING *`,
        [...identityValues(record), record.schema_version, record.file_count, record.changed_file_count,
          record.uploaded_at, record.diff_ref, JSON.stringify(record.changed_paths)]
      );
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
        throw new Error("BRANCH_SNAPSHOT_IDENTITY_CONFLICT", { cause: error });
      }
      throw error;
    }
    for (const file of record.files) {
      await client.query(
        `INSERT INTO branch_snapshot_files(project_id, branch_name, commit_sha, project_version,
           artifact_id, manifest_hash, path, content_kind, size_bytes, content_hash, media_type, action)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [...identityValues(record), file.path, file.content_kind, file.size, file.content_hash,
          file.media_type, file.action ?? null]
      );
    }
    return recordFrom(client, inserted.rows[0] ?? {});
  }

  async persistSnapshot(input: { actor_id: string; seed: BranchSnapshotSeed }): Promise<BranchSnapshotRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this.persistSnapshotWithClient(client, input);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  private async page(
    input: RepositoryPageRequest, queryKind: RepositoryPageEnvelope<unknown>["query_kind"],
    where = "", parameters: unknown[] = []
  ): Promise<RepositoryPageEnvelope<BranchSnapshotRecord>> {
    await this.authorize(input);
    const result = await this.pool.query(
      `SELECT * FROM branch_snapshots snapshot WHERE snapshot.project_id = $1 ${where}
       ORDER BY ${order} OFFSET $${parameters.length + 2} LIMIT $${parameters.length + 3}`,
      [input.project_id, ...parameters, input.cursor_offset, input.limit + 1]
    );
    const hasNext = result.rows.length > input.limit;
    const rows = result.rows.slice(0, input.limit);
    const items = await Promise.all(rows.map((row) => recordFrom(this.pool, row)));
    return { actor_id: input.actor_id, project_id: input.project_id, query_kind: queryKind,
      cursor_offset: input.cursor_offset,
      next_offset: hasNext ? input.cursor_offset + items.length : null, items };
  }

  async listLatestBranches(input: RepositoryPageRequest): Promise<RepositoryPageEnvelope<BranchSnapshotRecord>> {
    await this.authorize(input);
    const result = await this.pool.query(
      `SELECT * FROM (SELECT DISTINCT ON (branch_name) * FROM branch_snapshots
        WHERE project_id = $1 ORDER BY branch_name, ${order}) snapshot
       ORDER BY ${order} OFFSET $2 LIMIT $3`,
      [input.project_id, input.cursor_offset, input.limit + 1]
    );
    const rows = result.rows.slice(0, input.limit);
    return { actor_id: input.actor_id, project_id: input.project_id, query_kind: "branches",
      cursor_offset: input.cursor_offset,
      next_offset: result.rows.length > input.limit ? input.cursor_offset + rows.length : null,
      items: await Promise.all(rows.map((row) => recordFrom(this.pool, row))) };
  }

  listProjectVersions(input: RepositoryPageRequest) { return this.page(input, "project_versions"); }
  listVersions(input: BranchRepositoryPageRequest) {
    return this.page(input, "versions", "AND snapshot.branch_name = $2", [input.branch_name]);
  }

  async listFiles(input: SnapshotRepositoryPageRequest) {
    await this.authorize(input);
    const found = await this.getSnapshot(input);
    if (found === null) throw new Error("BRANCH_SNAPSHOT_NOT_FOUND");
    const result = await this.pool.query(
      `SELECT path, content_kind, size_bytes, content_hash, media_type, action
       FROM branch_snapshot_files snapshot WHERE ${identityWhere()}
       ORDER BY path COLLATE "C" ASC OFFSET $7 LIMIT $8`,
      [...identityValues(input.identity), input.cursor_offset, input.limit + 1]
    );
    const rows = result.rows.slice(0, input.limit);
    return { actor_id: input.actor_id, project_id: input.project_id, query_kind: "files" as const,
      cursor_offset: input.cursor_offset,
      next_offset: result.rows.length > input.limit ? input.cursor_offset + rows.length : null,
      items: rows.map(fileFrom), identity: structuredClone(input.identity) };
  }

  async getSnapshot(input: { actor_id: string; allowed_project_ids: readonly string[]; identity: SnapshotIdentity }) {
    await this.authorize({ ...input, project_id: input.identity.project_id });
    const result = await this.pool.query(
      `SELECT * FROM branch_snapshots snapshot WHERE ${identityWhere()}`, identityValues(input.identity)
    );
    if (result.rowCount !== 1) return null;
    return { actor_id: input.actor_id, identity: structuredClone(input.identity),
      record: await recordFrom(this.pool, result.rows[0] ?? {}) };
  }

  async getSnapshotByVersionRef(input: {
    actor_id: string; allowed_project_ids: readonly string[];
    project_id: string; branch_name: string; project_version: string;
  }) {
    await this.authorize(input);
    const result = await this.pool.query(
      `SELECT * FROM branch_snapshots snapshot
       WHERE snapshot.project_id = $1 AND snapshot.branch_name = $2 AND snapshot.project_version = $3`,
      [input.project_id, input.branch_name, input.project_version]
    );
    if (result.rowCount !== 1) return null;
    const record = await recordFrom(this.pool, result.rows[0] ?? {});
    return { actor_id: input.actor_id, identity: identityFrom(result.rows[0] ?? {}), record };
  }

  async getSnapshotPredecessor(input: {
    actor_id: string; allowed_project_ids: readonly string[]; identity: SnapshotIdentity;
  }) {
    await this.authorize({ ...input, project_id: input.identity.project_id });
    const target = await this.pool.query(
      `SELECT uploaded_at, project_version FROM branch_snapshots snapshot WHERE ${identityWhere()}`,
      identityValues(input.identity)
    );
    if (target.rowCount !== 1) return null;
    const result = await this.pool.query(
      `SELECT * FROM branch_snapshots snapshot
       WHERE snapshot.project_id = $1 AND snapshot.branch_name = $2
         AND (snapshot.uploaded_at < $3::timestamptz
           OR (snapshot.uploaded_at = $3::timestamptz AND snapshot.project_version COLLATE "C" > $4))
       ORDER BY snapshot.uploaded_at DESC, snapshot.project_version COLLATE "C" ASC
       LIMIT 1`,
      [input.identity.project_id, input.identity.branch_name,
        target.rows[0]?.uploaded_at, input.identity.project_version]
    );
    if (result.rowCount !== 1) return null;
    const record = await recordFrom(this.pool, result.rows[0] ?? {});
    return { actor_id: input.actor_id, identity: identityFrom(result.rows[0] ?? {}), record };
  }

  async getFile(input: { actor_id: string; allowed_project_ids: readonly string[]; identity: SnapshotIdentity; path: string }) {
    await this.authorize({ ...input, project_id: input.identity.project_id });
    const result = await this.pool.query(
      `SELECT path, content_kind, size_bytes, content_hash, media_type, action
       FROM branch_snapshot_files snapshot WHERE ${identityWhere()} AND snapshot.path = $7`,
      [...identityValues(input.identity), input.path]
    );
    if (result.rowCount !== 1) return null;
    return { actor_id: input.actor_id, identity: structuredClone(input.identity), file: fileFrom(result.rows[0] ?? {}) };
  }

  async readBlob(contentHash: string): Promise<Uint8Array | null> {
    const result = await this.pool.query(
      "SELECT content_bytes FROM branch_snapshot_blobs WHERE content_hash = $1", [contentHash]
    );
    return result.rowCount === 1 ? new Uint8Array(result.rows[0]?.content_bytes as Buffer) : null;
  }

  async issue(raw: CursorCapability): Promise<string> {
    const capability = canonicalCapability(raw);
    const authorized = await this.pool.query(
      "SELECT 1 FROM projects WHERE project_id = $1 AND owner_actor_id = $2",
      [capability.project_id, capability.actor_id]
    );
    if (authorized.rowCount !== 1) throw new Error("BRANCH_SNAPSHOT_FORBIDDEN");
    const key = capabilityKey(capability);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const token = randomBytes(32).toString("base64url");
      try {
        const result = await this.pool.query(
          `INSERT INTO branch_snapshot_cursors(token, capability_key, actor_id, project_id,
             query_kind, branch_name, snapshot_identity, cursor_offset)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
           ON CONFLICT (capability_key) DO UPDATE SET capability_key = EXCLUDED.capability_key
           RETURNING token`,
          [token, key, capability.actor_id, capability.project_id, capability.query_kind,
            capability.branch_name ?? null, capability.identity === undefined ? null : JSON.stringify(capability.identity),
            capability.offset]
        );
        return String(result.rows[0]?.token);
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "23505")) throw error;
      }
    }
    throw new Error("BRANCH_SNAPSHOT_CURSOR_INVALID");
  }

  async verify(cursor: string, expected: Omit<CursorCapability, "offset">): Promise<number> {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(cursor)) throw new Error("BRANCH_SNAPSHOT_CURSOR_INVALID");
    const result = await this.pool.query("SELECT * FROM branch_snapshot_cursors WHERE token = $1", [cursor]);
    const row = result.rows[0];
    if (result.rowCount !== 1 || row === undefined) throw new Error("BRANCH_SNAPSHOT_CURSOR_INVALID");
    const stored = canonicalCapability({ actor_id: row.actor_id, project_id: row.project_id,
      query_kind: row.query_kind, ...(row.branch_name === null ? {} : { branch_name: row.branch_name }),
      ...(row.snapshot_identity === null ? {} : { identity: row.snapshot_identity }),
      offset: Number(row.cursor_offset) });
    const expectedCapability = canonicalCapability({ ...expected, offset: stored.offset });
    if (capabilityKey(stored) !== capabilityKey(expectedCapability)) throw new Error("BRANCH_SNAPSHOT_CURSOR_INVALID");
    return stored.offset;
  }
}
