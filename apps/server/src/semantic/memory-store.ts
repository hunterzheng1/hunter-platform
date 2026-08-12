import type {
  SemanticDocument,
  SemanticDocumentKind,
  SemanticEdge,
  SemanticIndexBuild,
  SemanticOverview
} from "@hunter-harness/contracts";

import {
  INGEST_ARTIFACT_ID,
  SEMANTIC_INDEX_SCHEMA_VERSION,
  overviewFromDocuments,
  type SemanticGenerationGuard,
  type SemanticSearchOptions,
  type SemanticStore
} from "./store.js";

export class SemanticMemoryStore implements SemanticStore {
  private readonly documents = new Map<string, SemanticDocument>();
  private readonly edges = new Map<string, SemanticEdge>();
  private readonly latestArtifactByProject = new Map<string, string>();
  private readonly schemaVersionByProject = new Map<string, number>();

  async rebuild(
    build: SemanticIndexBuild,
    guard?: SemanticGenerationGuard
  ): Promise<boolean> {
    if (guard !== undefined &&
        (guard.expectedArtifactId !== build.artifact_id || !await guard.isCurrent())) {
      return false;
    }
    for (const [documentId, document] of [...this.documents.entries()]) {
      if (document.project_id === build.project_id &&
          document.artifact_id !== INGEST_ARTIFACT_ID) {
        this.documents.delete(documentId);
      }
    }
    for (const [edgeId, edge] of [...this.edges.entries()]) {
      if (edge.project_id === build.project_id) {
        this.edges.delete(edgeId);
      }
    }
    for (const document of build.documents) {
      this.documents.set(document.document_id, document);
    }
    for (const edge of build.edges) {
      this.edges.set(edge.edge_id, edge);
    }
    this.latestArtifactByProject.set(build.project_id, build.artifact_id);
    this.schemaVersionByProject.set(build.project_id, SEMANTIC_INDEX_SCHEMA_VERSION);
    return true;
  }

  async upsertDocuments(documents: readonly SemanticDocument[]): Promise<void> {
    for (const document of documents) {
      this.documents.set(document.document_id, document);
    }
  }

  async overview(projectId: string): Promise<SemanticOverview> {
    const documents = await this.listByKinds(projectId, [
      "knowledge_entry",
      "knowledge_markdown",
      "change_document",
      "architecture_document",
      "rule",
      "archive_record",
      "agent_instruction"
    ]);
    return overviewFromDocuments(
      projectId,
      await this.latestArtifactId(projectId),
      documents,
      await this.listEdges(projectId)
    );
  }

  async listByKinds(
    projectId: string,
    kinds: readonly SemanticDocumentKind[]
  ): Promise<SemanticDocument[]> {
    const allowed = new Set(kinds);
    return [...this.documents.values()]
      .filter((document) => document.project_id === projectId && allowed.has(document.kind))
      .filter((document) => document.metadata.status !== "deprecated")
      .sort((left, right) => left.source_path.localeCompare(right.source_path));
  }

  async listByKindsPage(
    projectId: string,
    kinds: readonly SemanticDocumentKind[],
    options: { limit: number; offset: number; order?: "asc" | "desc" | "change-history" }
  ): Promise<{ items: SemanticDocument[]; total: number }> {
    const all = await this.listByKinds(projectId, kinds);
    if (options.order === "change-history") {
      all.sort((left, right) => {
        const leftArchive = /^\.harness\/archive\/([^/]+)\//u.exec(left.source_path)?.[1] ?? left.source_path;
        const rightArchive = /^\.harness\/archive\/([^/]+)\//u.exec(right.source_path)?.[1] ?? right.source_path;
        return rightArchive.localeCompare(leftArchive)
          || Number(right.kind === "archive_record") - Number(left.kind === "archive_record")
          || left.source_path.localeCompare(right.source_path)
          || left.document_id.localeCompare(right.document_id);
      });
    } else {
      const direction = options.order === "desc" ? -1 : 1;
      all.sort((left, right) => direction * (
        left.source_path.localeCompare(right.source_path)
        || left.document_id.localeCompare(right.document_id)
      ));
    }
    return {
      items: all.slice(options.offset, options.offset + options.limit),
      total: all.length
    };
  }

  async getDocument(projectId: string, documentId: string): Promise<SemanticDocument | null> {
    const document = this.documents.get(documentId);
    if (document === undefined || document.project_id !== projectId) return null;
    return document;
  }

  async listEdges(projectId: string): Promise<SemanticEdge[]> {
    return [...this.edges.values()]
      .filter((edge) => edge.project_id === projectId)
      .sort((left, right) => left.edge_id.localeCompare(right.edge_id));
  }

  async graph(projectId: string, focusDocumentId?: string): Promise<{
    nodes: SemanticDocument[];
    edges: SemanticEdge[];
  }> {
    const allEdges = await this.listEdges(projectId);
    const edges = (focusDocumentId === undefined
      ? allEdges
      : allEdges.filter((edge) =>
        edge.from_document_id === focusDocumentId || edge.to_document_id === focusDocumentId
      )).slice(0, 100);
    const nodeIds = new Set(edges.flatMap((edge) => [edge.from_document_id, edge.to_document_id]));
    if (focusDocumentId !== undefined) nodeIds.add(focusDocumentId);
    const nodes = [...this.documents.values()]
      .filter((document) => document.project_id === projectId && nodeIds.has(document.document_id))
      .sort((left, right) => left.source_path.localeCompare(right.source_path));
    return { nodes, edges };
  }

  async deleteProject(projectId: string): Promise<void> {
    for (const [documentId, document] of this.documents) {
      if (document.project_id === projectId) this.documents.delete(documentId);
    }
    for (const [edgeId, edge] of this.edges) {
      if (edge.project_id === projectId) this.edges.delete(edgeId);
    }
    this.latestArtifactByProject.delete(projectId);
    this.schemaVersionByProject.delete(projectId);
  }

  async latestArtifactId(projectId: string): Promise<string | null> {
    return this.latestArtifactByProject.get(projectId) ?? null;
  }

  async indexSchemaVersion(projectId: string): Promise<number | null> {
    return this.schemaVersionByProject.get(projectId) ?? null;
  }

  async search(
    query: string,
    projectScope?: string | readonly string[],
    options: SemanticSearchOptions = {}
  ): Promise<SemanticDocument[]> {
    const needle = query.trim().toLowerCase();
    if (needle === "") return [];
    const allowedProjects = projectScope === undefined
      ? null
      : new Set(typeof projectScope === "string" ? [projectScope] : projectScope);
    if (allowedProjects?.size === 0) return [];
    const allowedKinds = options.kinds === undefined ? null : new Set(options.kinds);
    if (allowedKinds?.size === 0) return [];
    let documents = [...this.documents.values()]
      .filter((document) => allowedProjects === null || allowedProjects.has(document.project_id))
      .filter((document) => allowedKinds === null || allowedKinds.has(document.kind))
      .filter((document) => document.metadata.status !== "deprecated")
      .filter((document) =>
        document.title.toLowerCase().includes(needle) ||
        document.body.toLowerCase().includes(needle) ||
        document.source_path.toLowerCase().includes(needle)
      );
    if (options.currentSchemaOnly === true) {
      const versions = new Map<string, number | null>();
      for (const projectId of new Set(documents.map((document) => document.project_id))) {
        versions.set(projectId, await this.indexSchemaVersion(projectId));
      }
      documents = documents.filter((document) => {
        const version = versions.get(document.project_id) ?? null;
        return version === SEMANTIC_INDEX_SCHEMA_VERSION ||
          (version === null && document.artifact_id === INGEST_ARTIFACT_ID);
      });
    }
    return documents
      .sort((left, right) => left.title.localeCompare(right.title))
      .slice(0, options.limit ?? 100);
  }
}
