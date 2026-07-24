import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  ArtifactIdSchema,
  AttemptIdSchema,
  ProjectIdSchema,
  type ArtifactId,
  type AttemptId,
  type ProjectId,
} from "@hunter/domain";

import {
  loadStorageMigrations,
  runStorageMigrations,
  type StorageMigrationReceipt,
} from "./migration-runner.js";

export const ARTIFACT_RESOURCE_LIMITS = Object.freeze({
  defaultPageItems: 20,
  maxPageItems: 32,
  maxChunkBytes: 64 * 1_024,
  maxPageBytes: 256 * 1_024,
  maxSummaryCharacters: 500,
  maxFeedCapacity: 128,
});

export const PHASE1_ARTIFACT_QUOTA = Object.freeze({
  softLimitBytes: 2 * 1_024 * 1_024 * 1_024,
  hardLimitBytes: 4 * 1_024 * 1_024 * 1_024,
  criticalReserveBytes: 64 * 1_024 * 1_024,
});

export type ArtifactKind = "log" | "report" | "receipt";
export type ArtifactRetentionClass =
  | "ephemeral"
  | "standard"
  | "evidence"
  | "archive"
  | "core_receipt";

export interface ArtifactQuota {
  readonly softLimitBytes: number;
  readonly hardLimitBytes: number;
  readonly criticalReserveBytes: number;
}

export interface ArtifactCatalogOptions {
  readonly contentRoot: string;
  readonly quota: ArtifactQuota;
  readonly now?: (() => Date) | undefined;
}

export interface ArtifactRecord {
  readonly artifactId: ArtifactId;
  readonly projectId: ProjectId;
  readonly attemptId: AttemptId | null;
  readonly kind: ArtifactKind;
  readonly retentionClass: ArtifactRetentionClass;
  readonly summary: string;
  readonly byteLength: number;
  readonly entryCount: number;
  readonly retentionFloor: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ArtifactPageEntry {
  readonly cursor: number;
  readonly stream: "stdout" | "stderr" | "system";
  readonly content: string;
  readonly contentHash: string;
  readonly contentRef: string;
  readonly byteLength: number;
  readonly occurredAt: string;
}

export interface ArtifactContentEdge {
  readonly contentRef: string;
  readonly contentHash: string;
}

export type ArtifactPage =
  | {
      readonly status: "ok";
      readonly artifactId: ArtifactId;
      readonly cursor: number;
      readonly nextCursor: number;
      readonly retentionFloor: number;
      readonly highWaterCursor: number;
      readonly complete: boolean;
      readonly responseBytes: number;
      readonly entries: readonly ArtifactPageEntry[];
    }
  | {
      readonly status: "resync_required";
      readonly artifactId: ArtifactId;
      readonly code: "ARTIFACT_CURSOR_RESYNC_REQUIRED";
      readonly retentionFloor: number;
      readonly highWaterCursor: number;
      readonly instructions: {
        readonly snapshot: "reload_artifact_summary";
        readonly resume: "read_after_retention_floor";
      };
    };

export interface ArtifactBackpressureReceipt {
  readonly schemaVersion: 1;
  readonly code: "ARTIFACT_CLIENT_BACKPRESSURE";
  readonly artifactId: ArtifactId;
  readonly action: "disconnect_and_replay";
  readonly resumeAfterCursor: number;
  readonly highWaterCursor: number;
  readonly droppedNotifications: number;
}

interface ArtifactRow {
  readonly artifact_id: string;
  readonly project_id: string;
  readonly attempt_id: string | null;
  readonly kind: ArtifactKind;
  readonly retention_class: ArtifactRetentionClass;
  readonly summary: string;
  readonly byte_length: number;
  readonly entry_count: number;
  readonly retention_floor: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ArtifactEntryRow {
  readonly cursor: number;
  readonly stream: "stdout" | "stderr" | "system";
  readonly content_hash: string;
  readonly content_ref: string;
  readonly relative_path: string;
  readonly byte_length: number;
  readonly occurred_at: string;
}

interface UsageRow {
  readonly used_bytes: number;
}

function requireSafeNonNegative(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(code);
}

function validateQuota(quota: ArtifactQuota): void {
  requireSafeNonNegative(quota.softLimitBytes, "ARTIFACT_QUOTA_INVALID");
  requireSafeNonNegative(quota.hardLimitBytes, "ARTIFACT_QUOTA_INVALID");
  requireSafeNonNegative(
    quota.criticalReserveBytes,
    "ARTIFACT_QUOTA_INVALID",
  );
  if (
    quota.softLimitBytes <= 0
    || quota.hardLimitBytes <= quota.softLimitBytes
    || quota.criticalReserveBytes <= 0
  ) {
    throw new Error("ARTIFACT_QUOTA_INVALID");
  }
}

function toArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    artifactId: ArtifactIdSchema.parse(row.artifact_id),
    projectId: ProjectIdSchema.parse(row.project_id),
    attemptId:
      row.attempt_id === null ? null : AttemptIdSchema.parse(row.attempt_id),
    kind: row.kind,
    retentionClass: row.retention_class,
    summary: row.summary,
    byteLength: row.byte_length,
    entryCount: row.entry_count,
    retentionFloor: row.retention_floor,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function quotaLevel(
  usedBytes: number,
  quota: ArtifactQuota,
): "normal" | "soft_limit" | "hard_limit" {
  if (usedBytes >= quota.hardLimitBytes) return "hard_limit";
  if (usedBytes >= quota.softLimitBytes) return "soft_limit";
  return "normal";
}

export class ArtifactCursorFeed {
  private readonly notifications: number[] = [];
  private receipt: ArtifactBackpressureReceipt | null = null;
  private isClosed = false;

  public constructor(
    public readonly artifactId: ArtifactId,
    private readonly afterCursor: number,
    private readonly capacity: number,
    private readonly onClose: (feed: ArtifactCursorFeed) => void,
  ) {}

  public publish(cursor: number): void {
    if (this.isClosed || cursor <= this.afterCursor) return;
    if (this.notifications.length >= this.capacity) {
      this.receipt = {
        schemaVersion: 1,
        code: "ARTIFACT_CLIENT_BACKPRESSURE",
        artifactId: this.artifactId,
        action: "disconnect_and_replay",
        resumeAfterCursor: this.afterCursor,
        highWaterCursor: cursor,
        droppedNotifications: 1,
      };
      this.notifications.length = 0;
      this.isClosed = true;
      this.onClose(this);
      return;
    }
    this.notifications.push(cursor);
  }

  public drain(): readonly number[] {
    const drained = [...this.notifications];
    this.notifications.length = 0;
    return drained;
  }

  public backpressureReceipt(): ArtifactBackpressureReceipt | null {
    return this.receipt;
  }

  public get closed(): boolean {
    return this.isClosed;
  }

  public close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.notifications.length = 0;
    this.onClose(this);
  }
}

export class SqliteArtifactCatalog {
  private readonly contentRoot: string;
  private readonly now: () => Date;
  private readonly feeds = new Map<string, Set<ArtifactCursorFeed>>();
  public readonly migrationReceipt: StorageMigrationReceipt;

  public constructor(
    private readonly database: DatabaseSync,
    private readonly options: ArtifactCatalogOptions,
  ) {
    validateQuota(options.quota);
    this.contentRoot = resolve(options.contentRoot);
    this.now = options.now ?? (() => new Date());
    mkdirSync(this.contentRoot, { recursive: true });
    this.migrationReceipt = runStorageMigrations(
      this.database,
      loadStorageMigrations(),
      { now: this.now },
    );
  }

  public register(input: {
    readonly artifactId: ArtifactId;
    readonly projectId: ProjectId;
    readonly attemptId?: AttemptId | undefined;
    readonly kind: ArtifactKind;
    readonly retentionClass: ArtifactRetentionClass;
    readonly summary: string;
  }): ArtifactRecord {
    const artifactId = ArtifactIdSchema.parse(input.artifactId);
    const projectId = ProjectIdSchema.parse(input.projectId);
    const attemptId = input.attemptId === undefined
      ? null
      : AttemptIdSchema.parse(input.attemptId);
    if (
      input.summary.length === 0
      || input.summary.length > ARTIFACT_RESOURCE_LIMITS.maxSummaryCharacters
    ) {
      throw new Error("ARTIFACT_SUMMARY_TOO_LARGE");
    }
    const existing = this.find(artifactId);
    if (existing !== null) {
      if (
        existing.projectId !== projectId
        || existing.attemptId !== attemptId
        || existing.kind !== input.kind
        || existing.retentionClass !== input.retentionClass
        || existing.summary !== input.summary
      ) {
        throw new Error("ARTIFACT_REGISTRATION_CONFLICT");
      }
      return existing;
    }
    const at = this.now().toISOString();
    this.database.prepare(
      `INSERT INTO artifact_catalog(
         artifact_id, project_id, attempt_id, kind, retention_class, summary,
         byte_length, entry_count, retention_floor, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`,
    ).run(
      artifactId,
      projectId,
      attemptId,
      input.kind,
      input.retentionClass,
      input.summary,
      at,
      at,
    );
    const registered = this.find(artifactId);
    if (registered === null) throw new Error("ARTIFACT_REGISTRATION_FAILED");
    return registered;
  }

  public find(artifactIdInput: ArtifactId): ArtifactRecord | null {
    const artifactId = ArtifactIdSchema.parse(artifactIdInput);
    const row = this.database.prepare(
      `SELECT artifact_id, project_id, attempt_id, kind, retention_class,
              summary, byte_length, entry_count, retention_floor,
              created_at, updated_at
         FROM artifact_catalog
        WHERE artifact_id = ?`,
    ).get(artifactId) as ArtifactRow | undefined;
    return row === undefined ? null : toArtifact(row);
  }

  public listForAttempt(attemptIdInput: AttemptId): readonly ArtifactRecord[] {
    const attemptId = AttemptIdSchema.parse(attemptIdInput);
    const rows = this.database.prepare(
      `SELECT artifact_id, project_id, attempt_id, kind, retention_class,
              summary, byte_length, entry_count, retention_floor,
              created_at, updated_at
         FROM artifact_catalog
        WHERE attempt_id = ?
        ORDER BY created_at, artifact_id`,
    ).all(attemptId) as unknown as readonly ArtifactRow[];
    return rows.map((row) => toArtifact(row));
  }

  public contentEdges(
    artifactIdInput: ArtifactId,
  ): readonly ArtifactContentEdge[] {
    const artifactId = ArtifactIdSchema.parse(artifactIdInput);
    if (this.find(artifactId) === null) throw new Error("ARTIFACT_NOT_FOUND");
    return (this.database.prepare(
      `SELECT content_ref, content_hash
         FROM artifact_entries
        WHERE artifact_id = ?
        ORDER BY cursor`,
    ).all(artifactId) as unknown as readonly {
      readonly content_ref: string;
      readonly content_hash: string;
    }[]).map((row) => ({
      contentRef: row.content_ref,
      contentHash: row.content_hash,
    }));
  }

  public append(input: {
    readonly artifactId: ArtifactId;
    readonly stream: "stdout" | "stderr" | "system";
    readonly content: string;
    readonly transaction?: "new" | "existing" | undefined;
  }):
    | {
        readonly status: "accepted";
        readonly artifactId: ArtifactId;
        readonly cursor: number;
        readonly contentHash: string;
        readonly byteLength: number;
        readonly quota: {
          readonly level: "normal" | "soft_limit" | "hard_limit";
          readonly usedBytes: number;
          readonly projectedBytes: number;
          readonly softLimitBytes: number;
          readonly hardLimitBytes: number;
        };
        readonly usedCriticalReserveBytes: number;
      }
    | {
        readonly status: "rejected";
        readonly artifactId: ArtifactId;
        readonly code:
          | "ARTIFACT_QUOTA_HARD_LIMIT"
          | "ARTIFACT_CRITICAL_RESERVE_EXHAUSTED";
        readonly quota: {
          readonly level: "hard_limit";
          readonly usedBytes: number;
          readonly projectedBytes: number;
          readonly softLimitBytes: number;
          readonly hardLimitBytes: number;
        };
        readonly coreReceiptPreserved: true;
      } {
    const artifactId = ArtifactIdSchema.parse(input.artifactId);
    const artifact = this.find(artifactId);
    if (artifact === null) throw new Error("ARTIFACT_NOT_FOUND");
    const byteLength = Buffer.byteLength(input.content, "utf8");
    if (
      byteLength <= 0
      || byteLength > ARTIFACT_RESOURCE_LIMITS.maxChunkBytes
    ) {
      throw new Error("ARTIFACT_CHUNK_TOO_LARGE");
    }
    const usedBytes = this.usedBytes();
    const projectedBytes = usedBytes + byteLength;
    const quota = this.options.quota;
    const critical = artifact.retentionClass === "core_receipt";
    if (!critical && projectedBytes >= quota.hardLimitBytes) {
      return {
        status: "rejected",
        artifactId,
        code: "ARTIFACT_QUOTA_HARD_LIMIT",
        quota: {
          level: "hard_limit",
          usedBytes,
          projectedBytes,
          softLimitBytes: quota.softLimitBytes,
          hardLimitBytes: quota.hardLimitBytes,
        },
        coreReceiptPreserved: true,
      };
    }
    if (
      critical
      && projectedBytes
        > quota.hardLimitBytes + quota.criticalReserveBytes
    ) {
      return {
        status: "rejected",
        artifactId,
        code: "ARTIFACT_CRITICAL_RESERVE_EXHAUSTED",
        quota: {
          level: "hard_limit",
          usedBytes,
          projectedBytes,
          softLimitBytes: quota.softLimitBytes,
          hardLimitBytes: quota.hardLimitBytes,
        },
        coreReceiptPreserved: true,
      };
    }

    const contentHash = createHash("sha256")
      .update(input.content, "utf8")
      .digest("hex");
    const relativePath =
      `sha256/${contentHash.slice(0, 2)}/${contentHash}`;
    this.writeContent(relativePath, input.content);
    const at = this.now().toISOString();
    const cursor = artifact.entryCount + 1;
    const ownsTransaction = input.transaction !== "existing";
    if (ownsTransaction) this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(
        `INSERT INTO artifact_entries(
           artifact_id, cursor, stream, content_hash, content_ref,
           relative_path, byte_length, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        artifactId,
        cursor,
        input.stream,
        contentHash,
        `cas:sha256:${contentHash}`,
        relativePath,
        byteLength,
        at,
      );
      this.database.prepare(
        `UPDATE artifact_catalog
            SET byte_length = byte_length + ?,
                entry_count = ?,
                updated_at = ?
          WHERE artifact_id = ?`,
      ).run(byteLength, cursor, at, artifactId);
      if (ownsTransaction) this.database.exec("COMMIT");
    } catch (error) {
      if (ownsTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
    for (const feed of this.feeds.get(artifactId) ?? []) feed.publish(cursor);
    return {
      status: "accepted",
      artifactId,
      cursor,
      contentHash,
      byteLength,
      quota: {
        level: quotaLevel(projectedBytes, quota),
        usedBytes: projectedBytes,
        projectedBytes,
        softLimitBytes: quota.softLimitBytes,
        hardLimitBytes: quota.hardLimitBytes,
      },
      usedCriticalReserveBytes: Math.max(
        0,
        projectedBytes - quota.hardLimitBytes,
      ),
    };
  }

  public readPage(input: {
    readonly artifactId: ArtifactId;
    readonly cursor: number;
    readonly limit?: number | undefined;
  }): ArtifactPage {
    const artifactId = ArtifactIdSchema.parse(input.artifactId);
    requireSafeNonNegative(input.cursor, "ARTIFACT_CURSOR_INVALID");
    const limit = input.limit ?? ARTIFACT_RESOURCE_LIMITS.defaultPageItems;
    if (
      !Number.isSafeInteger(limit)
      || limit <= 0
      || limit > ARTIFACT_RESOURCE_LIMITS.maxPageItems
    ) {
      throw new Error("ARTIFACT_PAGE_LIMIT_INVALID");
    }
    const artifact = this.find(artifactId);
    if (artifact === null) throw new Error("ARTIFACT_NOT_FOUND");
    if (input.cursor > artifact.entryCount) {
      throw new Error("ARTIFACT_CURSOR_AHEAD_OF_HIGH_WATER");
    }
    if (input.cursor < artifact.retentionFloor) {
      return {
        status: "resync_required",
        artifactId,
        code: "ARTIFACT_CURSOR_RESYNC_REQUIRED",
        retentionFloor: artifact.retentionFloor,
        highWaterCursor: artifact.entryCount,
        instructions: {
          snapshot: "reload_artifact_summary",
          resume: "read_after_retention_floor",
        },
      };
    }
    const rows = this.database.prepare(
      `SELECT cursor, stream, content_hash, content_ref, relative_path,
              byte_length, occurred_at
         FROM artifact_entries
        WHERE artifact_id = ? AND cursor > ?
        ORDER BY cursor
        LIMIT ?`,
    ).all(artifactId, input.cursor, limit) as unknown as ArtifactEntryRow[];
    const entries: ArtifactPageEntry[] = [];
    let responseBytes = 0;
    for (const row of rows) {
      const content = this.readContent(row);
      const nextBytes = responseBytes + Buffer.byteLength(content, "utf8");
      if (
        entries.length > 0
        && nextBytes > ARTIFACT_RESOURCE_LIMITS.maxPageBytes
      ) {
        break;
      }
      responseBytes = nextBytes;
      entries.push({
        cursor: row.cursor,
        stream: row.stream,
        content,
        contentHash: row.content_hash,
        contentRef: row.content_ref,
        byteLength: row.byte_length,
        occurredAt: row.occurred_at,
      });
    }
    const nextCursor = entries.at(-1)?.cursor ?? input.cursor;
    return {
      status: "ok",
      artifactId,
      cursor: input.cursor,
      nextCursor,
      retentionFloor: artifact.retentionFloor,
      highWaterCursor: artifact.entryCount,
      complete: nextCursor >= artifact.entryCount,
      responseBytes,
      entries,
    };
  }

  public inspectEntry(
    artifactIdInput: ArtifactId,
    cursor: number,
  ):
    | {
        readonly contentRef: string;
        readonly relativePath: string;
      }
    | null {
    const artifactId = ArtifactIdSchema.parse(artifactIdInput);
    const row = this.database.prepare(
      `SELECT content_ref, relative_path
         FROM artifact_entries
        WHERE artifact_id = ? AND cursor = ?`,
    ).get(artifactId, cursor) as
      | { readonly content_ref: string; readonly relative_path: string }
      | undefined;
    return row === undefined
      ? null
      : {
          contentRef: row.content_ref,
          relativePath: row.relative_path,
        };
  }

  public pruneBefore(input: {
    readonly artifactId: ArtifactId;
    readonly cursor: number;
  }): {
    readonly artifactId: ArtifactId;
    readonly retentionFloor: number;
    readonly deletedEntries: number;
  } {
    const artifactId = ArtifactIdSchema.parse(input.artifactId);
    requireSafeNonNegative(input.cursor, "ARTIFACT_CURSOR_INVALID");
    const artifact = this.find(artifactId);
    if (artifact === null) throw new Error("ARTIFACT_NOT_FOUND");
    if (input.cursor > artifact.entryCount) {
      throw new Error("ARTIFACT_CURSOR_INVALID");
    }
    if (this.hasProtectedReference(artifactId)) {
      throw new Error("ARTIFACT_RETENTION_PROTECTED");
    }
    const rows = this.database.prepare(
      `SELECT cursor, stream, content_hash, content_ref, relative_path,
              byte_length, occurred_at
         FROM artifact_entries
        WHERE artifact_id = ? AND cursor <= ?`,
    ).all(artifactId, input.cursor) as unknown as ArtifactEntryRow[];
    const deletedBytes = rows.reduce(
      (total, row) => total + row.byte_length,
      0,
    );
    const retentionFloor = Math.max(
      artifact.retentionFloor,
      input.cursor,
    );
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(
        "DELETE FROM artifact_entries WHERE artifact_id = ? AND cursor <= ?",
      ).run(artifactId, input.cursor);
      this.database.prepare(
        `UPDATE artifact_catalog
            SET byte_length = byte_length - ?,
                retention_floor = ?,
                updated_at = ?
          WHERE artifact_id = ?`,
      ).run(
        deletedBytes,
        retentionFloor,
        this.now().toISOString(),
        artifactId,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    this.removeUnreferencedContent(
      rows.map(({ content_hash }) => content_hash),
    );
    return {
      artifactId,
      retentionFloor,
      deletedEntries: rows.length,
    };
  }

  public protect(input: {
    readonly artifactId: ArtifactId;
    readonly reference: {
      readonly kind: "evidence" | "archive";
      readonly referenceId: string;
    };
  }): void {
    const artifactId = ArtifactIdSchema.parse(input.artifactId);
    if (this.find(artifactId) === null) throw new Error("ARTIFACT_NOT_FOUND");
    if (input.reference.referenceId.trim().length === 0) {
      throw new Error("ARTIFACT_REFERENCE_INVALID");
    }
    this.database.prepare(
      `INSERT INTO artifact_references(
         artifact_id, reference_kind, reference_id, created_at
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT(artifact_id, reference_kind, reference_id) DO NOTHING`,
    ).run(
      artifactId,
      input.reference.kind,
      input.reference.referenceId,
      this.now().toISOString(),
    );
  }

  public enforceRetention(input: {
    readonly targetBytes: number;
  }): {
    readonly targetBytes: number;
    readonly remainingBytes: number;
    readonly deletedArtifactIds: readonly ArtifactId[];
    readonly protectedArtifactIds: readonly ArtifactId[];
  } {
    requireSafeNonNegative(
      input.targetBytes,
      "ARTIFACT_RETENTION_TARGET_INVALID",
    );
    const rows = this.database.prepare(
      `SELECT artifact_id, project_id, attempt_id, kind, retention_class,
              summary, byte_length, entry_count, retention_floor,
              created_at, updated_at
         FROM artifact_catalog
        ORDER BY
          CASE retention_class
            WHEN 'ephemeral' THEN 0
            WHEN 'standard' THEN 1
            WHEN 'evidence' THEN 2
            WHEN 'archive' THEN 3
            WHEN 'core_receipt' THEN 4
          END,
          created_at,
          artifact_id`,
    ).all() as unknown as ArtifactRow[];
    let remainingBytes = this.usedBytes();
    const deletedArtifactIds: ArtifactId[] = [];
    const protectedArtifactIds: ArtifactId[] = [];
    for (const row of rows) {
      const artifact = toArtifact(row);
      const protectedArtifact =
        artifact.retentionClass === "evidence"
        || artifact.retentionClass === "archive"
        || artifact.retentionClass === "core_receipt"
        || this.hasProtectedReference(artifact.artifactId);
      if (protectedArtifact) {
        protectedArtifactIds.push(artifact.artifactId);
        continue;
      }
      if (remainingBytes <= input.targetBytes) continue;
      const hashes = this.database.prepare(
        "SELECT content_hash FROM artifact_entries WHERE artifact_id = ?",
      ).all(artifact.artifactId) as unknown as readonly {
        readonly content_hash: string;
      }[];
      this.database.prepare(
        "DELETE FROM artifact_catalog WHERE artifact_id = ?",
      ).run(artifact.artifactId);
      remainingBytes -= artifact.byteLength;
      deletedArtifactIds.push(artifact.artifactId);
      this.removeUnreferencedContent(
        hashes.map(({ content_hash }) => content_hash),
      );
    }
    return {
      targetBytes: input.targetBytes,
      remainingBytes,
      deletedArtifactIds,
      protectedArtifactIds: protectedArtifactIds.sort(),
    };
  }

  public openCursorFeed(input: {
    readonly artifactId: ArtifactId;
    readonly afterCursor: number;
    readonly capacity: number;
  }): ArtifactCursorFeed {
    const artifactId = ArtifactIdSchema.parse(input.artifactId);
    requireSafeNonNegative(input.afterCursor, "ARTIFACT_CURSOR_INVALID");
    if (
      !Number.isSafeInteger(input.capacity)
      || input.capacity <= 0
      || input.capacity > ARTIFACT_RESOURCE_LIMITS.maxFeedCapacity
    ) {
      throw new Error("ARTIFACT_FEED_CAPACITY_INVALID");
    }
    const artifact = this.find(artifactId);
    if (artifact === null) throw new Error("ARTIFACT_NOT_FOUND");
    if (input.afterCursor < artifact.retentionFloor) {
      throw new Error("ARTIFACT_CURSOR_RESYNC_REQUIRED");
    }
    const feeds = this.feeds.get(artifactId) ?? new Set();
    const feed = new ArtifactCursorFeed(
      artifactId,
      input.afterCursor,
      input.capacity,
      (closedFeed) => {
        feeds.delete(closedFeed);
        if (feeds.size === 0) this.feeds.delete(artifactId);
      },
    );
    feeds.add(feed);
    this.feeds.set(artifactId, feeds);
    return feed;
  }

  private usedBytes(): number {
    const row = this.database.prepare(
      "SELECT COALESCE(SUM(byte_length), 0) AS used_bytes FROM artifact_catalog",
    ).get() as unknown as UsageRow;
    return row.used_bytes;
  }

  private hasProtectedReference(artifactId: ArtifactId): boolean {
    return this.database.prepare(
      "SELECT 1 FROM artifact_references WHERE artifact_id = ? LIMIT 1",
    ).get(artifactId) !== undefined;
  }

  private writeContent(relativePath: string, content: string): void {
    const target = this.resolveContentPath(relativePath);
    if (existsSync(target)) {
      const existing = readFileSync(target, "utf8");
      if (existing !== content) throw new Error("ARTIFACT_CONTENT_HASH_COLLISION");
      return;
    }
    mkdirSync(dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    const descriptor = openSync(temporary, "wx");
    try {
      writeFileSync(descriptor, content, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      renameSync(temporary, target);
    } catch (error) {
      rmSync(temporary, { force: true });
      if (!existsSync(target)) throw error;
      const existing = readFileSync(target, "utf8");
      if (existing !== content) throw new Error("ARTIFACT_CONTENT_HASH_COLLISION");
    }
  }

  private readContent(row: ArtifactEntryRow): string {
    const content = readFileSync(
      this.resolveContentPath(row.relative_path),
      "utf8",
    );
    if (
      Buffer.byteLength(content, "utf8") !== row.byte_length
      || createHash("sha256").update(content, "utf8").digest("hex")
        !== row.content_hash
    ) {
      throw new Error("ARTIFACT_CONTENT_INTEGRITY_FAILED");
    }
    return content;
  }

  private resolveContentPath(relativePath: string): string {
    const segments = relativePath.split(/[\\/]/u);
    if (
      segments.length === 0
      || segments.some((segment) =>
        segment.length === 0 || segment === "." || segment === ".."
      )
    ) {
      throw new Error("ARTIFACT_CONTENT_PATH_INVALID");
    }
    const target = resolve(this.contentRoot, ...segments);
    const pathFromRoot = relative(this.contentRoot, target);
    if (
      pathFromRoot.startsWith("..")
      || pathFromRoot === ""
      || resolve(this.contentRoot, pathFromRoot) !== target
    ) {
      throw new Error("ARTIFACT_CONTENT_PATH_INVALID");
    }
    return target;
  }

  private removeUnreferencedContent(hashes: readonly string[]): void {
    for (const hash of new Set(hashes)) {
      const remaining = this.database.prepare(
        "SELECT 1 FROM artifact_entries WHERE content_hash = ? LIMIT 1",
      ).get(hash);
      if (remaining !== undefined) continue;
      const relativePath = `sha256/${hash.slice(0, 2)}/${hash}`;
      rmSync(this.resolveContentPath(relativePath), { force: true });
    }
  }
}
