import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  KnowledgeEntryIdSchema,
  ProjectIdSchema,
  RequirementRevisionIdSchema,
  createRequirementRevision,
} from "@hunter/domain";
import { z } from "zod";

import { historicalKnowledgeEntryFor } from "./archive-projector.js";
import {
  KnowledgeEntrySchema,
  VerifiedArchiveReceiptSchema,
  type KnowledgeEntry,
} from "./contracts.js";
import { SqliteKnowledgeCatalog } from "./knowledge-catalog.js";

const RebuildInputSchema = z
  .object({
    projectId: ProjectIdSchema,
  })
  .strict();

interface ArchiveReceiptRow {
  readonly archive_receipt_json: string;
}

interface RequirementViewRow {
  readonly entity_id: string;
  readonly view_json: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function authoritativeEntry(
  projectId: ReturnType<typeof ProjectIdSchema.parse>,
  row: RequirementViewRow,
): KnowledgeEntry {
  const requirementRevisionId = RequirementRevisionIdSchema.parse(row.entity_id);
  const view = JSON.parse(row.view_json) as unknown;
  if (view === null || typeof view !== "object" || Array.isArray(view)) {
    throw new Error("KNOWLEDGE_REQUIREMENT_VIEW_INVALID");
  }
  const record = view as Record<string, unknown>;
  if (record.requirementRevisionId !== requirementRevisionId) {
    throw new Error("KNOWLEDGE_REQUIREMENT_VIEW_ID_MISMATCH");
  }
  const nested = record.requirementRevision;
  const revision = nested === undefined
    ? undefined
    : createRequirementRevision(nested);
  if (
    revision !== undefined
    && (
      revision.revisionId !== requirementRevisionId
      || revision.projectId !== projectId
    )
  ) {
    throw new Error("KNOWLEDGE_REQUIREMENT_VIEW_SCOPE_MISMATCH");
  }
  const rawStatus = revision?.status ?? record.status;
  const status = rawStatus === "active" || rawStatus === "approved"
    ? "active"
    : rawStatus === "superseded" || rawStatus === "withdrawn"
      ? rawStatus
      : null;
  if (status === null) {
    throw new Error("KNOWLEDGE_REQUIREMENT_STATUS_INVALID");
  }
  const rawTitle = revision?.title ?? record.title;
  const rawBody = revision?.body ?? record.body;
  const title =
    typeof rawTitle === "string" && rawTitle.trim().length > 0
      ? rawTitle.trim()
      : `Requirement ${requirementRevisionId}`;
  const body =
    typeof rawBody === "string" && rawBody.trim().length > 0
      ? rawBody.trim()
      : JSON.stringify(record);
  return KnowledgeEntrySchema.parse({
    schemaVersion: 1,
    entryId: KnowledgeEntryIdSchema.parse(
      `kne_${sha256(
        `requirement_revision\u0000${projectId}\u0000${requirementRevisionId}`,
      )}`,
    ),
    level: "authoritative",
    status,
    source: {
      type: "requirement_revision",
      projectId,
      requirementRevisionId,
    },
    scope: { projectId },
    summary: title.slice(0, 500),
    body: body.slice(0, 10_000),
  });
}

export async function rebuildKnowledge(input: {
  readonly database: DatabaseSync;
  readonly projectId: unknown;
  readonly now?: () => Date;
}): Promise<{
  readonly projectId: ReturnType<typeof ProjectIdSchema.parse>;
  readonly archiveCount: number;
  readonly authoritativeCount: number;
  readonly digest: string;
}> {
  const { projectId } = RebuildInputSchema.parse({
    projectId: input.projectId,
  });
  const archiveRows = input.database.prepare(
    `SELECT archive_receipt_json FROM archive_jobs
      WHERE project_id = ? AND status = 'completed'
      ORDER BY run_id, job_id`,
  ).all(projectId) as unknown as ArchiveReceiptRow[];
  const historical = archiveRows.map((row) =>
    historicalKnowledgeEntryFor(
      VerifiedArchiveReceiptSchema.parse(
        JSON.parse(row.archive_receipt_json) as unknown,
      ),
    ));
  const requirementRows = input.database.prepare(
    `SELECT entity_id, view_json FROM entity_views
      WHERE projector_name = 'hunter'
        AND entity_type = 'RequirementRevision'
        AND project_id = ?
      ORDER BY entity_id`,
  ).all(projectId) as unknown as RequirementViewRow[];
  const authoritative = requirementRows.map((row) =>
    authoritativeEntry(projectId, row));
  const entries = [...historical, ...authoritative].sort((left, right) =>
    left.entryId.localeCompare(right.entryId));
  const catalog = new SqliteKnowledgeCatalog(
    input.database,
    input.now ?? (() => new Date()),
  );
  const persisted = catalog.replaceRebuildableEntries(projectId, entries);
  return {
    projectId,
    archiveCount: historical.length,
    authoritativeCount: authoritative.length,
    digest: sha256(JSON.stringify(persisted)),
  };
}
