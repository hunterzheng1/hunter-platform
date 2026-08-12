import { uuidV7 } from "@hunter-harness/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createServer } from "../src/app.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { SemanticMemoryStore } from "../src/semantic/memory-store.js";
import { buildSemanticIndex } from "../src/semantic/indexer.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

describe("/api/v1 semantic query routes", () => {
  const token = "semantic-owner-token";
  let repository: MemoryRepository;
  let semanticStore: SemanticMemoryStore;
  let app: Awaited<ReturnType<typeof createServer>>;
  let projectId: string;

  beforeEach(async () => {
    repository = new MemoryRepository();
    semanticStore = new SemanticMemoryStore();
    await repository.createActorWithToken({ actorId: "actor_owner", token });
    const resolved = await repository.resolveProject({
      actorId: "actor_owner",
      localProjectKey: uuidV7(),
      displayName: "Semantic Sample",
      requestedProjectId: null
    });
    projectId = resolved.project.projectId;
    await semanticStore.rebuild(buildSemanticIndex({
      projectId,
      artifactId: "art_semantic1",
      files: {
        "CLAUDE.md": "# Sample project\n",
        ".claude/rules/harness-general.md": "general rule\n",
        ".harness/knowledge/entries/active/decision.json": JSON.stringify({
          schemaVersion: 1,
          id: "sample.decision.aaaaaaaaaa",
          projectId: "sample",
          type: "decision",
          status: "active",
          title: "Reuse LlmClient",
          summary: "Reuse LlmClient for AI jobs.",
          body: "Reuse LlmClient for AI jobs without new provider abstractions.",
          keywords: ["llm"],
          source: {
            archive: ".harness/archive/2026-06-30-sample",
            summaryData: ".harness/archive/2026-06-30-sample/reports/final/summary-data.json",
            summarySha256: "abc",
            sourceCommit: "",
            baseCommit: "",
            changeName: "sample",
            finalStatus: "OK"
          },
          scope: { sourceFiles: ["apps/server/src/registry/store.ts"] },
          lifecycle: {
            createdAt: "2026-06-30T00:00:00+08:00",
            verifiedAt: "2026-06-30T00:00:00+08:00",
            lastCheckedAt: "2026-06-30T00:00:00+08:00",
            confidence: "medium",
            supersedes: [],
            supersededBy: null,
            conflictsWith: [],
            staleReasons: []
          }
        }),
        ".harness/archive/2026-06-30-sample/reports/final/summary-data.json": JSON.stringify({
          changeName: "sample",
          finalStatus: "OK"
        }),
        ".harness/archive/2026-06-30-sample/spec/sample-design.md": "# 示例设计\n",
        ".harness/codebase/map/ARCHITECTURE.md": "# 项目架构\n"
      }
    }));
    app = await createServer({
      repository,
      storage: new MemoryArtifactStorage(),
      semanticStore
    });
  });

  afterEach(async () => app.close());

  function headers(): Record<string, string> {
    return {
      authorization: "Bearer " + token,
      "x-request-id": uuidV7(),
      "idempotency-key": uuidV7()
    };
  }

  it("returns overview, knowledge, rules, changes, graph, and search hits", async () => {
    const overview = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/semantic/overview`,
      headers: headers()
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      project_id: projectId,
      artifact_id: "art_semantic1",
      counts: {
        documents: 6,
        knowledge: 1,
        rules: 1,
        changes: 2,
        architecture: 1,
        agent_instructions: 1
      }
    });

    const knowledge = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/semantic/knowledge`,
      headers: headers()
    });
    expect(knowledge.statusCode).toBe(200);
    expect(knowledge.json().items).toHaveLength(1);
    expect(knowledge.json().items[0].title).toBe("Reuse LlmClient");

    const rules = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/semantic/rules`,
      headers: headers()
    });
    expect(rules.statusCode).toBe(200);
    expect(rules.json().items).toHaveLength(1);

    const changes = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/semantic/changes`,
      headers: headers()
    });
    expect(changes.statusCode).toBe(200);
    expect(changes.json().items[0].title).toBe("sample");
    expect(changes.json().items).toHaveLength(2);

    const architecture = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/semantic/architecture`,
      headers: headers()
    });
    expect(architecture.statusCode).toBe(200);
    expect(architecture.json().items).toHaveLength(1);
    expect(architecture.json().items[0]).toMatchObject({
      kind: "architecture_document",
      title: "项目架构"
    });

    const graph = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/semantic/graph`,
      headers: headers()
    });
    expect(graph.statusCode).toBe(200);
    expect(graph.json()).toMatchObject({
      nodes: [],
      edges: [],
      relation_status: "no_relations",
      indexed_documents: 6
    });

    const knowledgeDocumentId = knowledge.json().items[0].document_id as string;
    const focusedGraph = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/semantic/graph?focus_document_id=${encodeURIComponent(knowledgeDocumentId)}`,
      headers: headers()
    });
    expect(focusedGraph.statusCode).toBe(200);
    expect(focusedGraph.json()).toMatchObject({
      focus_document_id: knowledgeDocumentId,
      relation_status: "no_relations"
    });
    expect(focusedGraph.json().nodes).toHaveLength(1);

    const search = await app.inject({
      method: "GET",
      url: `/api/v1/semantic/search?q=LlmClient&project_id=${encodeURIComponent(projectId)}`,
      headers: headers()
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().items).toHaveLength(1);
    expect(search.json().items[0].project_id).toBe(projectId);
  });

  it("never returns another actor's documents from global semantic search", async () => {
    const otherToken = "semantic-other-token";
    await repository.createActorWithToken({ actorId: "actor_other", token: otherToken });
    const other = await repository.resolveProject({
      actorId: "actor_other",
      localProjectKey: uuidV7(),
      displayName: "Other tenant",
      requestedProjectId: null
    });
    await semanticStore.rebuild(buildSemanticIndex({
      projectId: other.project.projectId,
      artifactId: "art_other1",
      files: {
        ".harness/knowledge/entries/active/private.md": "# secret-b-only\n\nprivate tenant body\n"
      }
    }));

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/semantic/search?q=secret-b-only",
      headers: headers()
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([]);
  });

  it("hides unversioned legacy archive documents but keeps explicit ingest knowledge", async () => {
    await semanticStore.deleteProject(projectId);
    await semanticStore.upsertDocuments([
      {
        document_id: "doc_legacy_archive",
        project_id: projectId,
        artifact_id: "art_legacy",
        kind: "knowledge_markdown",
        source_path: ".harness/archive/old/plans/legacy.md",
        title: "legacy-hidden-needle",
        body: "legacy-hidden-needle",
        metadata: {},
        content_sha256: "sha256:" + "1".repeat(64)
      },
      {
        document_id: "doc_ingest_knowledge",
        project_id: projectId,
        artifact_id: "ingest",
        kind: "knowledge_entry",
        source_path: ".harness/knowledge/entries/active/current.md",
        title: "ingest-visible-needle",
        body: "ingest-visible-needle",
        metadata: {},
        content_sha256: "sha256:" + "2".repeat(64)
      }
    ]);

    const legacy = await app.inject({
      method: "GET",
      url: "/api/v1/semantic/search?q=legacy-hidden-needle",
      headers: headers()
    });
    const ingest = await app.inject({
      method: "GET",
      url: "/api/v1/semantic/search?q=ingest-visible-needle",
      headers: headers()
    });

    expect(legacy.statusCode).toBe(200);
    expect(legacy.json().items).toEqual([]);
    expect(ingest.statusCode).toBe(200);
    expect(ingest.json().items).toHaveLength(1);
    expect(ingest.json().items[0]).toMatchObject({
      project_id: projectId,
      document: {
        document_id: "doc_ingest_knowledge",
        title: "ingest-visible-needle"
      }
    });
  });

  it("runs one allowlisted store query for global search", async () => {
    const second = await repository.resolveProject({
      actorId: "actor_owner",
      localProjectKey: uuidV7(),
      displayName: "Second accessible project",
      requestedProjectId: null
    });
    await semanticStore.rebuild(buildSemanticIndex({
      projectId: second.project.projectId,
      artifactId: "art_semantic2",
      files: { ".harness/knowledge/entries/active/second.md": "# LlmClient second\n" }
    }));
    const search = vi.spyOn(semanticStore, "search");

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/semantic/search?q=LlmClient",
      headers: headers()
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items.length).toBeGreaterThanOrEqual(1);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith(
      "LlmClient",
      expect.arrayContaining([projectId, second.project.projectId]),
      { limit: 100, currentSchemaOnly: true }
    );
  });

  it("paginates change history and batch-loads archive metadata", async () => {
    await semanticStore.upsertDocuments(Array.from({ length: 5 }, (_, index) => ({
      document_id: `doc_change_page_${index}`,
      project_id: projectId,
      artifact_id: "art_semantic1",
      kind: "archive_record" as const,
      source_path: `.harness/archive/change-${index}/reports/final/summary-data.json`,
      title: `change-${index}`,
      body: `change-${index}`,
      metadata: { source_archive: `change-${index}` },
      content_sha256: "sha256:" + String(index + 1).repeat(64)
    })));
    const batch = vi.spyOn(repository, "getChangeArchivePackages");

    const first = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/semantic/changes?limit=2`,
      headers: headers()
    });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ total: 7 });
    expect(first.json().items).toHaveLength(2);
    expect(first.json().items[0].title).toBe("change-4");
    expect(first.json().next_cursor).toEqual(expect.any(String));
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]?.[2].length).toBeLessThanOrEqual(2);

    const second = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/semantic/changes?limit=2&cursor=${encodeURIComponent(first.json().next_cursor)}`,
      headers: headers()
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().items).toHaveLength(2);
    expect(batch).toHaveBeenCalledTimes(2);
  });

  it("rejects empty search query", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/semantic/search?q=",
      headers: headers()
    });
    expect(response.statusCode).toBe(400);
  });
});
