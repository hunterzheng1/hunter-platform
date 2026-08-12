import type {
  SemanticDocument,
  SemanticDocumentKind,
  SemanticEdge,
  SemanticIndexBuild,
  SemanticOverview
} from "@hunter-harness/contracts";
import type { Pool } from "pg";

import {
  INGEST_ARTIFACT_ID,
  SEMANTIC_INDEX_SCHEMA_VERSION,
  overviewFromDocuments,
  type SemanticGenerationGuard,
  type SemanticSearchOptions,
  type SemanticStore
} from "./store.js";

function documentFromRow(row: Record<string, unknown>): SemanticDocument {
  return {
    document_id: String(row.document_id),
    project_id: String(row.project_id),
    artifact_id: String(row.artifact_id),
    kind: String(row.kind) as SemanticDocumentKind,
    source_path: String(row.source_path),
    title: String(row.title),
    body: String(row.body),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    content_sha256: String(row.content_sha256)
  };
}

function edgeFromRow(row: Record<string, unknown>): SemanticEdge {
  return {
    edge_id: String(row.edge_id),
    project_id: String(row.project_id),
    artifact_id: String(row.artifact_id),
    from_document_id: String(row.from_document_id),
    to_document_id: String(row.to_document_id),
    kind: String(row.kind) as SemanticEdge["kind"],
    metadata: (row.metadata ?? {}) as Record<string, unknown>
  };
}

export class PgSemanticStore implements SemanticStore {
  constructor(private readonly pool: Pool) {}

  async rebuild(
    build: SemanticIndexBuild,
    guard?: SemanticGenerationGuard
  ): Promise<boolean> {
    if (guard !== undefined &&
        (guard.expectedArtifactId !== build.artifact_id || !await guard.isCurrent())) {
      return false;
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (guard !== undefined) {
        const generation = await client.query(
          `SELECT latest_artifact_id
           FROM projects
           WHERE project_id = $1
           FOR SHARE`,
          [build.project_id]
        );
        const row = generation.rows[0] as { latest_artifact_id?: string | null } | undefined;
        if (row?.latest_artifact_id !== guard.expectedArtifactId) {
          await client.query("ROLLBACK");
          return false;
        }
      }
      await client.query("DELETE FROM semantic_edges WHERE project_id = $1", [build.project_id]);
      // Ingest-projected documents are owned by the P3 knowledge API, not the push snapshot.
      await client.query(
        "DELETE FROM semantic_documents WHERE project_id = $1 AND artifact_id <> $2",
        [build.project_id, INGEST_ARTIFACT_ID]
      );
      if (build.documents.length > 0) {
        await client.query(
          `INSERT INTO semantic_documents(
             document_id, project_id, artifact_id, kind, source_path, title, body, metadata, content_sha256
           )
           SELECT document_id, project_id, artifact_id, kind, source_path, title, body,
                  metadata, content_sha256
           FROM jsonb_to_recordset($1::jsonb) AS document(
             document_id text, project_id text, artifact_id text, kind text,
             source_path text, title text, body text, metadata jsonb, content_sha256 text
           )`,
          [JSON.stringify(build.documents)]
        );
      }
      if (build.edges.length > 0) {
        await client.query(
          `INSERT INTO semantic_edges(
             edge_id, project_id, artifact_id, from_document_id, to_document_id, kind, metadata
           )
           SELECT edge_id, project_id, artifact_id, from_document_id, to_document_id, kind, metadata
           FROM jsonb_to_recordset($1::jsonb) AS edge(
             edge_id text, project_id text, artifact_id text, from_document_id text,
             to_document_id text, kind text, metadata jsonb
           )`,
          [JSON.stringify(build.edges)]
        );
      }
      await client.query(
        `INSERT INTO semantic_generations(project_id, artifact_id, schema_version, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (project_id) DO UPDATE SET
           artifact_id = EXCLUDED.artifact_id,
           schema_version = EXCLUDED.schema_version,
           updated_at = EXCLUDED.updated_at`,
        [build.project_id, build.artifact_id, SEMANTIC_INDEX_SCHEMA_VERSION]
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async upsertDocuments(documents: readonly SemanticDocument[]): Promise<void> {
    if (documents.length === 0) return;
    await this.pool.query(
      `INSERT INTO semantic_documents(
         document_id, project_id, artifact_id, kind, source_path, title, body, metadata, content_sha256
       )
       SELECT document_id, project_id, artifact_id, kind, source_path, title, body,
              metadata, content_sha256
       FROM jsonb_to_recordset($1::jsonb) AS document(
         document_id text, project_id text, artifact_id text, kind text,
         source_path text, title text, body text, metadata jsonb, content_sha256 text
       )
       ON CONFLICT (document_id) DO UPDATE SET
         artifact_id = EXCLUDED.artifact_id,
         kind = EXCLUDED.kind,
         source_path = EXCLUDED.source_path,
         title = EXCLUDED.title,
         body = EXCLUDED.body,
         metadata = EXCLUDED.metadata,
         content_sha256 = EXCLUDED.content_sha256`,
      [JSON.stringify(documents)]
    );
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
    if (kinds.length === 0) return [];
    const result = await this.pool.query(
      `SELECT document_id, project_id, artifact_id, kind, source_path, title, body, metadata, content_sha256
       FROM semantic_documents
       WHERE project_id = $1 AND kind = ANY($2::text[])
         AND COALESCE(metadata->>'status', '') <> 'deprecated'
       ORDER BY source_path ASC`,
      [projectId, [...kinds]]
    );
    return result.rows.map((row) => documentFromRow(row as Record<string, unknown>));
  }

  async listByKindsPage(
    projectId: string,
    kinds: readonly SemanticDocumentKind[],
    options: { limit: number; offset: number; order?: "asc" | "desc" | "change-history" }
  ): Promise<{ items: SemanticDocument[]; total: number }> {
    if (kinds.length === 0) return { items: [], total: 0 };
    const order = options.order === "desc" ? "DESC" : "ASC";
    const orderClause = options.order === "change-history"
      ? `split_part(source_path, '/', 3) DESC,
         CASE WHEN kind = 'archive_record' THEN 0 ELSE 1 END ASC,
         source_path ASC, document_id ASC`
      : `source_path ${order}, document_id ${order}`;
    const [page, count] = await Promise.all([
      this.pool.query(
        `SELECT document_id, project_id, artifact_id, kind, source_path, title, body,
                metadata, content_sha256
         FROM semantic_documents
         WHERE project_id = $1 AND kind = ANY($2::text[])
           AND COALESCE(metadata->>'status', '') <> 'deprecated'
         ORDER BY ${orderClause}
         LIMIT $3 OFFSET $4`,
        [projectId, [...kinds], options.limit, options.offset]
      ),
      this.pool.query(
        `SELECT COUNT(*)::integer AS total
         FROM semantic_documents
         WHERE project_id = $1 AND kind = ANY($2::text[])
           AND COALESCE(metadata->>'status', '') <> 'deprecated'`,
        [projectId, [...kinds]]
      )
    ]);
    const countRow = count.rows[0] as { total?: number | string } | undefined;
    return {
      items: page.rows.map((row) => documentFromRow(row as Record<string, unknown>)),
      total: Number(countRow?.total ?? 0)
    };
  }

  async getDocument(projectId: string, documentId: string): Promise<SemanticDocument | null> {
    const result = await this.pool.query(
      `SELECT document_id, project_id, artifact_id, kind, source_path, title, body, metadata, content_sha256
       FROM semantic_documents
       WHERE project_id = $1 AND document_id = $2`,
      [projectId, documentId]
    );
    if (result.rowCount === 0) return null;
    return documentFromRow(result.rows[0] as Record<string, unknown>);
  }

  async listEdges(projectId: string): Promise<SemanticEdge[]> {
    const result = await this.pool.query(
      `SELECT edge_id, project_id, artifact_id, from_document_id, to_document_id, kind, metadata
       FROM semantic_edges
       WHERE project_id = $1
       ORDER BY edge_id ASC`,
      [projectId]
    );
    return result.rows.map((row) => edgeFromRow(row as Record<string, unknown>));
  }

  async graph(projectId: string, focusDocumentId?: string): Promise<{
    nodes: SemanticDocument[];
    edges: SemanticEdge[];
  }> {
    const edgeRows = focusDocumentId === undefined
      ? await this.pool.query(
        `SELECT * FROM semantic_edges WHERE project_id = $1 ORDER BY edge_id LIMIT 100`,
        [projectId]
      )
      : await this.pool.query(
        `SELECT * FROM semantic_edges
         WHERE project_id = $1 AND (from_document_id = $2 OR to_document_id = $2)
         ORDER BY edge_id LIMIT 100`,
        [projectId, focusDocumentId]
      );
    const edges = edgeRows.rows.map((row) => edgeFromRow(row as Record<string, unknown>));
    const nodeIds = new Set(edges.flatMap((edge) => [edge.from_document_id, edge.to_document_id]));
    if (focusDocumentId !== undefined) nodeIds.add(focusDocumentId);
    if (nodeIds.size === 0) return { nodes: [], edges };
    const documentRows = await this.pool.query(
      `SELECT document_id, project_id, artifact_id, kind, source_path, title, body, metadata, content_sha256
       FROM semantic_documents
       WHERE project_id = $1 AND document_id = ANY($2::text[])
       ORDER BY source_path`,
      [projectId, [...nodeIds]]
    );
    return {
      nodes: documentRows.rows.map((row) => documentFromRow(row as Record<string, unknown>)),
      edges
    };
  }

  async deleteProject(projectId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM semantic_edges WHERE project_id = $1", [projectId]);
      await client.query("DELETE FROM semantic_documents WHERE project_id = $1", [projectId]);
      await client.query("DELETE FROM semantic_generations WHERE project_id = $1", [projectId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async latestArtifactId(projectId: string): Promise<string | null> {
    const result = await this.pool.query(
      `SELECT artifact_id FROM semantic_generations WHERE project_id = $1`,
      [projectId]
    );
    const row = result.rows[0] as { artifact_id?: string } | undefined;
    return row?.artifact_id ?? null;
  }

  async indexSchemaVersion(projectId: string): Promise<number | null> {
    const result = await this.pool.query(
      `SELECT schema_version FROM semantic_generations WHERE project_id = $1`,
      [projectId]
    );
    const row = result.rows[0] as { schema_version?: number | string } | undefined;
    if (row?.schema_version === undefined) return null;
    const value = Number(row.schema_version);
    return Number.isInteger(value) ? value : null;
  }

  async search(
    query: string,
    projectScope?: string | readonly string[],
    options: SemanticSearchOptions = {}
  ): Promise<SemanticDocument[]> {
    const needle = query.trim();
    if (needle === "") return [];
    if (Array.isArray(projectScope) && projectScope.length === 0) return [];
    if (options.kinds !== undefined && options.kinds.length === 0) return [];
    const parameters: unknown[] = [needle];
    const filters = [
      "d.search_vector @@ plainto_tsquery('simple', $1)",
      "COALESCE(d.metadata->>'status', '') <> 'deprecated'"
    ];
    if (typeof projectScope === "string") {
      parameters.push(projectScope);
      filters.push(`d.project_id = $${parameters.length}`);
    } else if (projectScope !== undefined) {
      parameters.push([...projectScope]);
      filters.push(`d.project_id = ANY($${parameters.length}::text[])`);
    }
    if (options.kinds !== undefined) {
      parameters.push([...options.kinds]);
      filters.push(`d.kind = ANY($${parameters.length}::text[])`);
    }
    const generationJoin = options.currentSchemaOnly === true
      ? "LEFT JOIN semantic_generations g ON g.project_id = d.project_id"
      : "";
    if (options.currentSchemaOnly === true) {
      parameters.push(SEMANTIC_INDEX_SCHEMA_VERSION);
      filters.push(`(g.schema_version = $${parameters.length} OR ` +
        `(g.schema_version IS NULL AND d.artifact_id = '${INGEST_ARTIFACT_ID}'))`);
    }
    parameters.push(Math.max(1, Math.min(options.limit ?? 100, 100)));
    const result = await this.pool.query(
      `SELECT d.document_id, d.project_id, d.artifact_id, d.kind, d.source_path,
              d.title, d.body, d.metadata, d.content_sha256
       FROM semantic_documents d
       ${generationJoin}
       WHERE ${filters.join(" AND ")}
       ORDER BY d.title ASC
       LIMIT $${parameters.length}`,
      parameters
    );
    return result.rows.map((row) => documentFromRow(row as Record<string, unknown>));
  }
}
