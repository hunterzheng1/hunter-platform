import type { KnowledgeIngestEntry } from "@hunter-harness/contracts";

import type { KnowledgeResult } from "../knowledge-pipeline/types.js";

/**
 * The bridge from the knowledge pipeline into the ingest table.
 *
 * `project_knowledge` reads `knowledge_ingest_entries`, whose only writers were
 * two HTTP routes. The pipeline's own output (`knowledge_pipeline_results`) had
 * no consumer at all, so results could never become searchable knowledge. This
 * module closes that gap.
 *
 * Everything written here comes from real data. Provenance is what makes a
 * knowledge entry worth trusting, so a result whose classification, body, or
 * provenance cannot be filled truthfully is skipped — never padded with a
 * plausible-looking default. A partially filled payload would be worse than
 * nothing: `knowledgeEntryDocument` safeParses it and returns null on failure,
 * which lights up `project_knowledge` while leaving `knowledge query` empty,
 * and the failure is silent.
 */

/** The `change_summary` document projected from the archive package. */
export interface ChangeSummaryDocument {
  source_path: string;
  content_hash: string;
  content: string;
}

interface Provenance {
  changeName: string;
  baseCommit: string;
  finalCommit: string;
  finalStatus: string;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * summary-data.json carries the four provenance facts. All four must be
 * present: a knowledge entry that cannot say which change and which commits it
 * came from is not traceable, and an untraceable entry is not usable.
 */
function provenanceFrom(document: ChangeSummaryDocument | null): Provenance | null {
  if (document === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(document.content) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const changeName = nonEmpty(record.changeName);
  const baseCommit = nonEmpty(record.baseCommit);
  const finalCommit = nonEmpty(record.finalCommit);
  const finalStatus = nonEmpty(record.finalStatus);
  if (changeName === null || baseCommit === null ||
      finalCommit === null || finalStatus === null) {
    return null;
  }
  return { changeName, baseCommit, finalCommit, finalStatus };
}

/**
 * Project one pipeline result into an ingest entry, or null when it cannot be
 * done without inventing something.
 */
export function knowledgeEntryFromResult(
  result: KnowledgeResult,
  summary: ChangeSummaryDocument | null
): KnowledgeIngestEntry | null {
  // entry_type / body come from the archive's candidate generator. Archives
  // built before it existed carry neither, and there is no honest way to
  // reconstruct them: reusability_scope is free text that does not map onto the
  // seven-value type enum.
  const entryType = result.entry_type;
  const body = nonEmpty(result.body);
  if (entryType === undefined || body === null) return null;

  const provenance = provenanceFrom(summary);
  if (provenance === null || summary === null) return null;

  const archive = result.source_archive_ids[0];
  if (archive === undefined) return null;

  return {
    schemaVersion: 1,
    id: result.knowledge_id,
    projectId: result.project_id,
    type: entryType,
    status: "active",
    title: result.display_title,
    summary: result.summary,
    body,
    // Absent keywords mean "none", which is a fact; only classification and
    // provenance are load-bearing enough to skip over.
    keywords: result.keywords ?? [],
    source: {
      archive,
      summaryData: summary.source_path,
      summarySha256: summary.content_hash,
      sourceCommit: provenance.finalCommit,
      baseCommit: provenance.baseCommit,
      changeName: provenance.changeName,
      finalStatus: provenance.finalStatus
    },
    scope: { sourceFiles: [...result.source_refs] },
    lifecycle: {
      createdAt: result.created_at,
      verifiedAt: result.updated_at,
      lastCheckedAt: result.updated_at,
      // The pipeline already applied the 0.82 auto-promote threshold; this
      // records that judgement rather than re-deriving a new one.
      confidence: confidenceLevel(result.confidence),
      supersedes: [],
      supersededBy: null,
      conflictsWith: [],
      staleReasons: []
    },
    confidence: {
      score: result.confidence,
      level: confidenceLevel(result.confidence),
      signals: ["archive-review-finding"],
      lastCalculatedAt: result.updated_at
    }
  };
}

function confidenceLevel(score: number): string {
  if (score >= 0.9) return "high";
  if (score >= 0.75) return "medium";
  return "low";
}


// --- runner ------------------------------------------------------------------

/** Only the repository surface the bridge needs. */
export interface KnowledgeUpsertRepository {
  upsertKnowledgeEntry(input: {
    projectId: string;
    entryId: string;
    contentSha256: string;
    payload: Record<string, unknown>;
    status: string;
  }): Promise<"created" | "updated" | "duplicate">;
}

export interface IngestPipelineKnowledgeInput {
  repository: KnowledgeUpsertRepository;
  results: readonly KnowledgeResult[];
  /** The change_summary document for the change these results came from. */
  summary: ChangeSummaryDocument | null;
  contentHash: (entry: KnowledgeIngestEntry) => string;
  preparePayload: (entry: KnowledgeIngestEntry) => {
    payload: Record<string, unknown>;
    status: string;
  };
}

export interface IngestPipelineKnowledgeOutcome {
  created: number;
  updated: number;
  duplicate: number;
  /** Results skipped because they could not be projected without inventing. */
  skipped: number;
}

/**
 * Write pipeline results into the ingest table. Skips are counted rather than
 * thrown: one unprojectable result must not block the rest of the batch, and
 * the count is what makes the degradation visible instead of silent.
 */
export async function ingestPipelineKnowledge(
  input: IngestPipelineKnowledgeInput
): Promise<IngestPipelineKnowledgeOutcome> {
  const outcome: IngestPipelineKnowledgeOutcome = {
    created: 0, updated: 0, duplicate: 0, skipped: 0
  };
  for (const result of input.results) {
    const entry = knowledgeEntryFromResult(result, input.summary);
    if (entry === null) {
      outcome.skipped += 1;
      continue;
    }
    const prepared = input.preparePayload(entry);
    const written = await input.repository.upsertKnowledgeEntry({
      projectId: entry.projectId,
      entryId: entry.id,
      contentSha256: input.contentHash(entry),
      payload: prepared.payload,
      status: prepared.status
    });
    outcome[written] += 1;
  }
  return outcome;
}


// --- change summary lookup ---------------------------------------------------

/**
 * Read the `change_summary` document the projection worker produced for a
 * change. It is where the seven provenance fields come from, so a knowledge
 * entry cannot be written without it.
 */
export async function readChangeSummaryDocument(
  pool: { query: (text: string, values: unknown[]) => Promise<{ rows: unknown[] }> },
  projectId: string,
  changeKey: string
): Promise<ChangeSummaryDocument | null> {
  const result = await pool.query(
    `SELECT source_path, content_hash, content
       FROM knowledge_pipeline_change_documents
      WHERE project_id = $1 AND change_key = $2 AND document_type = 'change_summary'
      ORDER BY document_id ASC
      LIMIT 1`,
    [projectId, changeKey]
  );
  const row = result.rows[0];
  if (row === null || row === undefined || typeof row !== "object") return null;
  const record = row as Record<string, unknown>;
  if (typeof record.source_path !== "string" || typeof record.content_hash !== "string" ||
      typeof record.content !== "string") {
    return null;
  }
  return {
    source_path: record.source_path,
    content_hash: record.content_hash,
    content: record.content
  };
}
