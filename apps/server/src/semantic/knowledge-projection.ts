import { createHash } from "node:crypto";

import {
  canonicalJson,
  knowledgeIngestEntrySchema,
  type KnowledgeIngestEntry,
  type SemanticDocument
} from "@hunter-harness/contracts";

import type {
  KnowledgeIngestRecord,
  ServerRepository
} from "../repositories/interfaces.js";
import { INGEST_ARTIFACT_ID, type SemanticStore } from "./store.js";

export function knowledgeContentHash(entry: KnowledgeIngestEntry): string {
  return "sha256:" + createHash("sha256")
    .update(canonicalJson(entry), "utf8")
    .digest("hex");
}

function documentIdFor(projectId: string, entryId: string): string {
  return "doc_" + createHash("sha256")
    .update(projectId + "\0ingest\0" + entryId, "utf8")
    .digest("hex")
    .slice(0, 32);
}

/** Mirror of the push-indexer knowledge_entry document shape (indexer.ts). */
export function knowledgeEntryDocument(record: KnowledgeIngestRecord): SemanticDocument | null {
  const parsed = knowledgeIngestEntrySchema.safeParse(record.payload);
  if (!parsed.success) return null;
  const entry = parsed.data;
  return {
    document_id: documentIdFor(record.projectId, record.entryId),
    project_id: record.projectId,
    artifact_id: INGEST_ARTIFACT_ID,
    kind: "knowledge_entry",
    source_path: `.harness/knowledge/entries/${entry.status}/${entry.id}.json`,
    title: entry.title,
    body: entry.body,
    metadata: {
      entry_id: entry.id,
      entry_type: entry.type,
      status: entry.status,
      keywords: entry.keywords,
      source_archive: entry.source.archive,
      source_files: entry.scope.sourceFiles,
      supersedes: entry.lifecycle.supersedes,
      superseded_by: entry.lifecycle.supersededBy,
      conflicts_with: entry.lifecycle.conflictsWith,
      ingested: true
    },
    content_sha256: record.contentSha256
  };
}

/**
 * Async projection worker (outbox drain): converts pending ingest rows into
 * semantic documents. Invalid payloads are marked projected so they do not
 * wedge the outbox; they remain queryable via the raw entries API.
 */
export async function projectPendingKnowledge(
  repository: ServerRepository,
  semanticStore: SemanticStore,
  projectId: string,
  limit = 200
): Promise<{ projected: number; skipped: number }> {
  const pending = await repository.listUnprojectedKnowledge(projectId, limit);
  if (pending.length === 0) return { projected: 0, skipped: 0 };
  const documents: SemanticDocument[] = [];
  let skipped = 0;
  for (const record of pending) {
    const document = knowledgeEntryDocument(record);
    if (document === null) {
      skipped += 1;
    } else {
      documents.push(document);
    }
  }
  await semanticStore.upsertDocuments(documents);
  await repository.markKnowledgeProjected(
    projectId,
    pending.map((record) => record.entryId),
    new Date().toISOString()
  );
  return { projected: documents.length, skipped };
}
