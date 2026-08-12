import type {
  SemanticDocument,
  SemanticDocumentKind,
  SemanticEdge,
  SemanticIndexBuild,
  SemanticOverview
} from "@hunter-harness/contracts";

/**
 * Documents created by the P3 knowledge ingest API carry this artifact id.
 * `rebuild` (push-triggered full replace) must not delete them.
 */
export const INGEST_ARTIFACT_ID = "ingest";
/** Bump whenever source classification or document rendering changes incompatibly. */
export const SEMANTIC_INDEX_SCHEMA_VERSION = 2;

export interface SemanticGenerationGuard {
  expectedArtifactId: string;
  isCurrent(): Promise<boolean>;
}

export interface SemanticSearchOptions {
  limit?: number;
  currentSchemaOnly?: boolean;
  kinds?: readonly SemanticDocumentKind[];
}

export interface SemanticDocumentPage {
  items: SemanticDocument[];
  total: number;
}

export interface SemanticStore {
  /**
   * Publish a full semantic snapshot. When a guard is supplied, the snapshot is
   * committed only while its project artifact is still current.
   */
  rebuild(build: SemanticIndexBuild, guard?: SemanticGenerationGuard): Promise<boolean>;
  /** Insert or replace individual documents (P3 ingest projection). */
  upsertDocuments(documents: readonly SemanticDocument[]): Promise<void>;
  overview(projectId: string): Promise<SemanticOverview>;
  listByKinds(projectId: string, kinds: readonly SemanticDocumentKind[]): Promise<SemanticDocument[]>;
  listByKindsPage(
    projectId: string,
    kinds: readonly SemanticDocumentKind[],
    options: { limit: number; offset: number; order?: "asc" | "desc" | "change-history" }
  ): Promise<SemanticDocumentPage>;
  getDocument(projectId: string, documentId: string): Promise<SemanticDocument | null>;
  listEdges(projectId: string): Promise<SemanticEdge[]>;
  graph(projectId: string, focusDocumentId?: string): Promise<{
    nodes: SemanticDocument[];
    edges: SemanticEdge[];
  }>;
  deleteProject(projectId: string): Promise<void>;
  search(
    query: string,
    projectScope?: string | readonly string[],
    options?: SemanticSearchOptions
  ): Promise<SemanticDocument[]>;
  latestArtifactId(projectId: string): Promise<string | null>;
  indexSchemaVersion(projectId: string): Promise<number | null>;
}

export function overviewFromDocuments(
  projectId: string,
  artifactId: string | null,
  documents: readonly SemanticDocument[],
  edges: readonly SemanticEdge[]
): SemanticOverview {
  const kindCount = (kind: SemanticDocumentKind): number =>
    documents.filter((document) => document.kind === kind).length;
  return {
    project_id: projectId,
    artifact_id: artifactId,
    counts: {
      documents: documents.length,
      knowledge: kindCount("knowledge_entry") + kindCount("knowledge_markdown"),
      rules: kindCount("rule"),
      changes: kindCount("archive_record") + kindCount("change_document"),
      architecture: kindCount("architecture_document"),
      agent_instructions: kindCount("agent_instruction"),
      edges: edges.length
    }
  };
}
