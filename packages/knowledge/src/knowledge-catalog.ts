import type { DatabaseSync } from "node:sqlite";

import type { ProjectId } from "@hunter/domain";

import {
  validateArchiveKnowledgeProjectionCommit,
  type ArchiveKnowledgeProjectionCommit,
  type ArchiveKnowledgeProjectionCommitResult,
  type DurableKnowledgeProjectionStore,
} from "./archive-projector.js";
import {
  KnowledgeEntrySchema,
  type KnowledgeEntry,
} from "./contracts.js";
import type { KnowledgeReadStore } from "./resolver.js";

interface ArchiveJobLeaseRow {
  readonly status: string;
  readonly attempt_count: number;
  readonly lease_owner: string | null;
  readonly lease_generation: number;
  readonly lease_token_hash: string | null;
  readonly lease_acquired_at: string | null;
  readonly lease_expires_at: string | null;
  readonly projection_fingerprint: string | null;
  readonly knowledge_entry_id: string | null;
}

interface EntryRow {
  readonly entry_json: string;
}

function sourceIdentity(entry: KnowledgeEntry): string {
  switch (entry.source.type) {
    case "requirement_revision":
      return `requirement_revision\u0000${entry.source.requirementRevisionId}`;
    case "evidence":
      return `evidence\u0000${entry.source.evidenceId}`;
    case "archive":
      return `archive\u0000${entry.source.runId}`;
  }
}

function manifestHashFor(entry: KnowledgeEntry): string | null {
  return entry.level === "historical" ? entry.source.manifestHash : null;
}

export class SqliteKnowledgeCatalog
  implements DurableKnowledgeProjectionStore, KnowledgeReadStore
{
  public constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async commitArchiveProjection(
    input: ArchiveKnowledgeProjectionCommit,
  ): Promise<ArchiveKnowledgeProjectionCommitResult> {
    const commit = validateArchiveKnowledgeProjectionCommit(input);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const lease = this.database.prepare(
        `SELECT status, attempt_count, lease_owner, lease_generation,
                lease_token_hash, lease_acquired_at, lease_expires_at,
                projection_fingerprint, knowledge_entry_id
           FROM archive_jobs WHERE job_id = ?`,
      ).get(commit.jobId) as unknown as ArchiveJobLeaseRow | undefined;
      if (
        lease === undefined ||
        lease.status !== "leased" ||
        lease.attempt_count !== commit.attempt ||
        lease.lease_owner !== commit.ownerId ||
        lease.lease_generation !== commit.generation ||
        lease.lease_token_hash !== commit.leaseTokenHash ||
        lease.lease_acquired_at !== commit.acquiredAt ||
        lease.lease_expires_at !== commit.expiresAt ||
        Date.parse(commit.expiresAt) <= this.now().getTime()
      ) {
        throw new Error("KNOWLEDGE_PROJECTION_LEASE_NOT_CURRENT");
      }
      if (
        lease.projection_fingerprint !== null &&
        lease.projection_fingerprint !== commit.inputFingerprint
      ) {
        throw new Error("KNOWLEDGE_PROJECTION_INPUT_CONFLICT");
      }

      if (lease.knowledge_entry_id !== null) {
        const existing = this.entryById(lease.knowledge_entry_id);
        if (existing === undefined) {
          throw new Error("KNOWLEDGE_PROJECTION_JOB_RECEIPT_MISSING");
        }
        this.database.exec("COMMIT");
        return {
          jobId: commit.jobId,
          inputFingerprint: commit.inputFingerprint,
          outcome: "existing",
          entry: existing,
        };
      }

      const identity = sourceIdentity(commit.entry);
      const manifestHash =
        commit.entry.level === "historical"
          ? commit.entry.source.manifestHash
          : null;
      const existingRow = this.database.prepare(
        `SELECT entry_json FROM knowledge_entries
          WHERE project_id = ?
            AND (source_identity = ? OR (? IS NOT NULL AND manifest_hash = ?))
          ORDER BY entry_id LIMIT 1`,
      ).get(
        commit.entry.scope.projectId,
        identity,
        manifestHash,
        manifestHash,
      ) as unknown as EntryRow | undefined;
      let outcome: "inserted" | "existing" = "existing";
      let entry = commit.entry;
      if (existingRow === undefined) {
        const timestamp = this.now().toISOString();
        this.database.prepare(
          `INSERT INTO knowledge_entries(
             entry_id, project_id, level, status, source_identity,
             manifest_hash, rebuildable, entry_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        ).run(
          entry.entryId,
          entry.scope.projectId,
          entry.level,
          entry.status,
          identity,
          manifestHash,
          JSON.stringify(entry),
          timestamp,
          timestamp,
        );
        outcome = "inserted";
      } else {
        const persisted = KnowledgeEntrySchema.parse(
          JSON.parse(existingRow.entry_json) as unknown,
        );
        if (
          persisted.entryId !== entry.entryId ||
          JSON.stringify(persisted) !== JSON.stringify(entry)
        ) {
          throw new Error("KNOWLEDGE_PROJECTION_SOURCE_CONFLICT");
        }
        entry = persisted;
      }

      this.database.prepare(
        `UPDATE archive_jobs
            SET status = 'completed',
                projection_fingerprint = ?,
                knowledge_entry_id = ?,
                updated_at = ?
          WHERE job_id = ?`,
      ).run(
        commit.inputFingerprint,
        entry.entryId,
        this.now().toISOString(),
        commit.jobId,
      );
      this.database.exec("COMMIT");
      return {
        jobId: commit.jobId,
        inputFingerprint: commit.inputFingerprint,
        outcome,
        entry,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public async listByProject(
    projectId: ProjectId,
  ): Promise<readonly KnowledgeEntry[]> {
    const rows = this.database.prepare(
      `SELECT entry_json FROM knowledge_entries
        WHERE project_id = ?
        ORDER BY level, entry_id`,
    ).all(projectId) as unknown as EntryRow[];
    return rows.map((row) =>
      KnowledgeEntrySchema.parse(JSON.parse(row.entry_json) as unknown));
  }

  public insertPromoted(input: unknown): KnowledgeEntry {
    const entry = KnowledgeEntrySchema.parse(input);
    if (entry.level === "historical") {
      throw new Error("HISTORICAL_ENTRY_REQUIRES_ARCHIVE_PROJECTION");
    }
    const timestamp = this.now().toISOString();
    this.database.prepare(
      `INSERT INTO knowledge_entries(
         entry_id, project_id, level, status, source_identity,
         manifest_hash, rebuildable, entry_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?, ?)`,
    ).run(
      entry.entryId,
      entry.scope.projectId,
      entry.level,
      entry.status,
      sourceIdentity(entry),
      JSON.stringify(entry),
      timestamp,
      timestamp,
    );
    return entry;
  }

  public replaceRebuildableEntries(
    projectId: ProjectId,
    inputs: readonly unknown[],
  ): readonly KnowledgeEntry[] {
    const entries = inputs
      .map((input) => KnowledgeEntrySchema.parse(input))
      .sort((left, right) => left.entryId.localeCompare(right.entryId));
    if (
      entries.some(
        (entry) =>
          entry.scope.projectId !== projectId ||
          entry.source.projectId !== projectId,
      )
    ) {
      throw new Error("KNOWLEDGE_REBUILD_PROJECT_SCOPE_MISMATCH");
    }
    const identities = new Set<string>();
    const manifests = new Set<string>();
    for (const entry of entries) {
      const identity = sourceIdentity(entry);
      const manifestHash = manifestHashFor(entry);
      if (identities.has(identity)) {
        throw new Error("KNOWLEDGE_REBUILD_DUPLICATE_SOURCE");
      }
      identities.add(identity);
      if (manifestHash !== null) {
        if (manifests.has(manifestHash)) {
          throw new Error("KNOWLEDGE_REBUILD_DUPLICATE_MANIFEST");
        }
        manifests.add(manifestHash);
      }
    }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(
        "DELETE FROM knowledge_entries WHERE project_id = ? AND rebuildable = 1",
      ).run(projectId);
      const timestamp = this.now().toISOString();
      const insert = this.database.prepare(
        `INSERT INTO knowledge_entries(
           entry_id, project_id, level, status, source_identity,
           manifest_hash, rebuildable, entry_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      );
      for (const entry of entries) {
        insert.run(
          entry.entryId,
          projectId,
          entry.level,
          entry.status,
          sourceIdentity(entry),
          manifestHashFor(entry),
          JSON.stringify(entry),
          timestamp,
          timestamp,
        );
      }
      this.database.exec("COMMIT");
      return entries;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private entryById(entryId: string): KnowledgeEntry | undefined {
    const row = this.database.prepare(
      "SELECT entry_json FROM knowledge_entries WHERE entry_id = ?",
    ).get(entryId) as unknown as EntryRow | undefined;
    return row === undefined
      ? undefined
      : KnowledgeEntrySchema.parse(JSON.parse(row.entry_json) as unknown);
  }
}
