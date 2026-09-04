import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  PlatformInformationDetailResponse,
  PlatformInformationExportArtifactReceipt,
  PlatformInformationExportResult,
  PlatformInformationPage
} from "@hunter-harness/contracts";
import { verifyPlatformInformationExportResult } from "@hunter-harness/contracts";
import { createServer } from "../src/app.js";
import { projectApiKeyHash } from "../src/auth/accounts.js";
import type { BranchVersionQueryAdapter } from "../src/branch-version-query/index.js";
import type { ProjectKnowledgeQueryAdapter } from "../src/project-knowledge-query/index.js";
import type { ProjectMaterialsQueryAdapter } from "../src/project-materials/query-adapter.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";
import type { PlatformInformationExportModule, PlatformInformationExportRecordPort,
  PlatformInformationExportDownloadPort } from "../src/platform-information-export/index.js";

function firstArgument(calls: unknown[][]): unknown {
  const call = calls[0];
  if (call === undefined) throw new Error("expected adapter call");
  return call[0];
}

describe("Platform Information HTTP routes", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  let repository: MemoryRepository;
  let projectId: string;
  let emptyMaterialsPage: PlatformInformationPage;
  const materialsQuery = vi.fn<ProjectMaterialsQueryAdapter["query"]>();
  const materialsDetail = vi.fn<ProjectMaterialsQueryAdapter["detail"]>();
  const branchQuery = vi.fn<BranchVersionQueryAdapter["query"]>();
  const branchVersionDetail = vi.fn<BranchVersionQueryAdapter["queryDetail"]>();
  const branchFilesPage = vi.fn<BranchVersionQueryAdapter["listFilesByDetailId"]>();
  const previewRestore = vi.fn<BranchVersionQueryAdapter["previewRestore"]>();
  const knowledgePage = vi.fn<ProjectKnowledgeQueryAdapter["queryPage"]>();
  const knowledgeDetail = vi.fn<ProjectKnowledgeQueryAdapter["queryDetail"]>();
  const retryIntent = vi.fn<ProjectKnowledgeQueryAdapter["createRetryIntent"]>();

  beforeEach(async () => {
    vi.resetAllMocks();
    repository = new MemoryRepository();
    await repository.createActorWithToken({ actorId: "actor_routes", token: "route-token" });
    const resolved = await repository.resolveProject({
      actorId: "actor_routes",
      localProjectKey: "local-routes",
      displayName: "Routes",
      requestedProjectId: null
    });
    projectId = resolved.project.projectId;
    emptyMaterialsPage = {
      schema_version: 1,
      contract_kind: "page",
      view: "project_materials",
      project_id: projectId,
      page_state: "empty",
      sort: "category_asc_path_asc_version_desc",
      items: [],
      next_cursor: null,
      failures: []
    };
    materialsQuery.mockResolvedValue({ ok: true, mode: "current", value: emptyMaterialsPage });
    app = await createServer({
      repository,
      storage: new MemoryArtifactStorage(),
      platformInformation: {
        branchVersion: {
          query: branchQuery,
          listFiles: vi.fn(),
          listFilesByDetailId: branchFilesPage,
          detail: vi.fn(),
          queryDetail: branchVersionDetail,
          previewRestore,
          confirmRestore: vi.fn()
        },
        projectMaterials: { query: materialsQuery, detail: materialsDetail },
        projectKnowledge: {
          queryPage: knowledgePage,
          queryDetail: knowledgeDetail,
          createRetryIntent: retryIntent
        }
      }
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("injects authenticated authority and canonical policy into a bounded list query", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/information/project_materials?limit=12`,
      headers: { authorization: "Bearer route-token", "x-request-id": "0198f012-3456-7abc-8def-0123456789ab" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe("0198f012-3456-7abc-8def-0123456789ab");
    expect(response.json()).toEqual(emptyMaterialsPage);
    expect(materialsQuery).toHaveBeenCalledOnce();
    expect(JSON.parse(firstArgument(materialsQuery.mock.calls) as string)).toEqual({
      schema_version: 1,
      contract_kind: "query",
      view: "project_materials",
      project_id: projectId,
      query_scope: {
        actor_id: "actor_routes",
        accessible_project_ids: [projectId],
        content_types: ["config", "rule", "architecture", "instruction"]
      },
      limit: 12,
      cursor: null,
      cursor_verification: "server_port_required",
      sort: "category_asc_path_asc_version_desc"
    });
  });

  it("exports every authorized page to terminal and returns a self-verifying continuity proof", async () => {
    const cursor = "export_cursor_page_0002";
    const item = (id: string) => ({
      item_kind: "project_material" as const,
      material_id: id,
      category: "rule" as const,
      path: `${id}.md`,
      blob_ref: { blob_hash: `sha256:${"a".repeat(64)}`, snapshot_version: "pv_export" },
      source_branch_name: "main",
      source_commit_sha: "b".repeat(40),
      sort_key: id
    });
    materialsQuery
      .mockResolvedValueOnce({ ok: true, mode: "current", value: {
        ...emptyMaterialsPage, page_state: "ready", items: [item("one")], next_cursor: cursor
      } })
      .mockResolvedValueOnce({ ok: true, mode: "current", value: {
        ...emptyMaterialsPage, page_state: "ready", items: [item("two")], next_cursor: null
      } });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/information/project_materials:export-all?limit=1`,
      headers: { authorization: "Bearer route-token", "x-request-id": "0198f012-3456-7abc-8def-0123456789ab" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe("0198f012-3456-7abc-8def-0123456789ab");
    const proof = response.json<PlatformInformationExportResult>();
    expect(proof).toMatchObject({
      contract_kind: "export_all_result", project_id: projectId, view: "project_materials",
      exported_count: 2, completed: true,
      range: { query_scope: { actor_id: "actor_routes", accessible_project_ids: [projectId] }, limit: 1 },
      pages: [
        { request_cursor: null, response_next_cursor: cursor, result_count: 1 },
        { request_cursor: cursor, response_next_cursor: null, result_count: 1 }
      ]
    });
    const expectedQuery = JSON.parse(firstArgument(materialsQuery.mock.calls) as string);
    expect(verifyPlatformInformationExportResult(JSON.stringify(proof), expectedQuery)).toMatchObject({ ok: true });
    expect(materialsQuery).toHaveBeenCalledTimes(2);
  });

  it("requires platform:read for export and keeps the proof allowlist scoped to the bound project", async () => {
    await repository.createProjectApiKey({
      keyId: "key_export_platform", keyHash: projectApiKeyHash("project-export-platform-key"),
      projectId, actorId: "actor_routes", label: "export", scopes: ["platform:read"]
    });
    await repository.createProjectApiKey({
      keyId: "key_export_files", keyHash: projectApiKeyHash("project-export-files-key"),
      projectId, actorId: "actor_routes", label: "files", scopes: ["files:read"]
    });
    const url = `/api/v1/projects/${projectId}/information/project_materials:export-all`;
    const allowed = await app.inject({ method: "GET", url,
      headers: { authorization: "Bearer project-export-platform-key" } });
    const denied = await app.inject({ method: "GET", url,
      headers: { authorization: "Bearer project-export-files-key" } });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().range.query_scope).toEqual({
      actor_id: "actor_routes", accessible_project_ids: [projectId],
      content_types: ["config", "rule", "architecture", "instruction"]
    });
    expect([denied.statusCode, denied.json().error.code]).toEqual([403, "PROJECT_KEY_SCOPE"]);
  });

  it("fails closed on export cursor non-progress without returning a partial proof", async () => {
    const cursor = "export_cursor_stuck_1";
    const value = {
      ...emptyMaterialsPage, page_state: "ready" as const,
      items: [{ item_kind: "project_material" as const, material_id: "stuck", category: "rule" as const,
        path: "stuck.md", blob_ref: { blob_hash: `sha256:${"a".repeat(64)}`, snapshot_version: "pv_stuck" },
        source_branch_name: "main", source_commit_sha: "b".repeat(40), sort_key: "stuck" }],
      next_cursor: cursor
    };
    materialsQuery
      .mockResolvedValueOnce({ ok: true, mode: "current", value })
      .mockResolvedValueOnce({ ok: true, mode: "current", value });
    const response = await app.inject({ method: "GET",
      url: `/api/v1/projects/${projectId}/information/project_materials:export-all`,
      headers: { authorization: "Bearer route-token", "x-request-id": "0198f012-3456-7abc-8def-0123456789ab" } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "PLATFORM_INFORMATION_SOURCE_INVALID" } });
    expect(response.json()).not.toHaveProperty("completed");
    expect(response.headers["x-request-id"]).toBe("0198f012-3456-7abc-8def-0123456789ab");
  });

  it("detects a resumed export cursor cycle before re-reading its source page", async () => {
    const source = "export_cursor_resume_1";
    const next = "export_cursor_resume_2";
    const value = (cursor: string) => ({
      ...emptyMaterialsPage, page_state: "ready" as const,
      items: [{ item_kind: "project_material" as const, material_id: cursor, category: "rule" as const,
        path: `${cursor}.md`, blob_ref: { blob_hash: `sha256:${"a".repeat(64)}`, snapshot_version: "pv_cycle" },
        source_branch_name: "main", source_commit_sha: "b".repeat(40), sort_key: cursor }],
      next_cursor: cursor
    });
    materialsQuery
      .mockResolvedValueOnce({ ok: true, mode: "current", value: value(next) })
      .mockResolvedValueOnce({ ok: true, mode: "current", value: value(source) })
      .mockResolvedValueOnce({ ok: true, mode: "current", value: { ...emptyMaterialsPage, page_state: "ready",
        items: value(next).items, next_cursor: null } });
    const response = await app.inject({ method: "GET",
      url: `/api/v1/projects/${projectId}/information/project_materials:export-all?cursor=${source}`,
      headers: { authorization: "Bearer route-token" } });
    expect([response.statusCode, response.json().error.code]).toEqual([503, "PLATFORM_INFORMATION_SOURCE_INVALID"]);
    expect(materialsQuery).toHaveBeenCalledTimes(2);
  });

  it("maps nonterminal export page states without treating partial data as complete", async () => {
    const partial = {
      ...emptyMaterialsPage, page_state: "partial_failure" as const,
      items: [{ item_kind: "project_material" as const, material_id: "partial", category: "rule" as const,
        path: "partial.md", blob_ref: { blob_hash: `sha256:${"a".repeat(64)}`, snapshot_version: "pv_partial" },
        source_branch_name: "main", source_commit_sha: "b".repeat(40), sort_key: "partial" }],
      failures: [{ reason_code: "PROJECTION_PARTIAL_FAILURE" as const, retryable: true }]
    };
    materialsQuery
      .mockResolvedValueOnce({ ok: true, mode: "current", value: partial })
      .mockResolvedValueOnce({ ok: true, mode: "current", value: { ...emptyMaterialsPage, page_state: "processing" } })
      .mockResolvedValueOnce({ ok: true, mode: "current", value: { ...emptyMaterialsPage, page_state: "forbidden",
        failures: [{ reason_code: "PROJECT_INFORMATION_FORBIDDEN" as const, retryable: false }] } });
    knowledgePage.mockResolvedValueOnce({ ok: true, value: {
      ...emptyMaterialsPage, view: "project_knowledge", sort: "extracted_at_desc_knowledge_id_asc",
      page_state: "failed", failures: [{ reason_code: "KNOWLEDGE_EXTRACTION_FAILED", retryable: true }]
    } as PlatformInformationPage });
    const request = (view = "project_materials") => app.inject({ method: "GET",
      url: `/api/v1/projects/${projectId}/information/${view}:export-all`,
      headers: { authorization: "Bearer route-token" } });
    const partialResponse = await request();
    const processingResponse = await request();
    const forbiddenResponse = await request();
    const failedResponse = await request("project_knowledge");
    expect([partialResponse.statusCode, partialResponse.json().error.code]).toEqual([503, "PLATFORM_INFORMATION_SOURCE_INVALID"]);
    expect([processingResponse.statusCode, processingResponse.json().error.code]).toEqual([503, "PLATFORM_INFORMATION_UNAVAILABLE"]);
    expect([forbiddenResponse.statusCode, forbiddenResponse.json().error.code]).toEqual([403, "PROJECT_INFORMATION_FORBIDDEN"]);
    expect([failedResponse.statusCode, failedResponse.json().error.code]).toEqual([503, "PLATFORM_INFORMATION_SOURCE_INVALID"]);
  });

  it("rejects an adapter page outside the trusted export range or requested page limit", async () => {
    const item = (id: string) => ({ item_kind: "project_material" as const, material_id: id,
      category: "rule" as const, path: `${id}.md`,
      blob_ref: { blob_hash: `sha256:${"a".repeat(64)}`, snapshot_version: "pv_range" },
      source_branch_name: "main", source_commit_sha: "b".repeat(40), sort_key: id });
    materialsQuery
      .mockResolvedValueOnce({ ok: true, mode: "current", value: {
        ...emptyMaterialsPage, project_id: "prj_wrong", page_state: "ready", items: [item("wrong")]
      } })
      .mockResolvedValueOnce({ ok: true, mode: "current", value: {
        ...emptyMaterialsPage, page_state: "ready", items: [item("one"), item("two")]
      } });
    const request = () => app.inject({ method: "GET",
      url: `/api/v1/projects/${projectId}/information/project_materials:export-all?limit=1`,
      headers: { authorization: "Bearer route-token" } });
    const wrongRange = await request();
    const overLimit = await request();
    expect([wrongRange.statusCode, wrongRange.json().error.code]).toEqual([503, "PLATFORM_INFORMATION_SOURCE_INVALID"]);
    expect([overLimit.statusCode, overLimit.json().error.code]).toEqual([503, "PLATFORM_INFORMATION_SOURCE_INVALID"]);
  });

  it("stops at the frozen 10,000-page export bound without a terminal proof", async () => {
    let page = 0;
    materialsQuery.mockImplementation(async () => {
      page += 1;
      return { ok: true, mode: "current" as const, value: {
        ...emptyMaterialsPage, page_state: "ready" as const,
        items: [{ item_kind: "project_material" as const, material_id: `bounded_${page}`, category: "rule" as const,
          path: `bounded-${page}.md`, blob_ref: { blob_hash: `sha256:${"a".repeat(64)}`, snapshot_version: "pv_bound" },
          source_branch_name: "main", source_commit_sha: "b".repeat(40), sort_key: `bounded_${page}` }],
        next_cursor: `export_cursor_${String(page).padStart(8, "0")}`
      } };
    });
    const response = await app.inject({ method: "GET",
      url: `/api/v1/projects/${projectId}/information/project_materials:export-all?limit=1`,
      headers: { authorization: "Bearer route-token" } });
    expect(materialsQuery).toHaveBeenCalledTimes(10_000);
    expect([response.statusCode, response.json().error.code]).toEqual([503, "PLATFORM_INFORMATION_UNAVAILABLE"]);
    expect(response.json()).not.toHaveProperty("completed");
  });

  it("fails closed for the unwired monitor without invoking another adapter", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/information/branch_monitor`,
      headers: { authorization: "Bearer route-token" }
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("PLATFORM_INFORMATION_UNAVAILABLE");
    const exportResponse = await app.inject({ method: "POST",
      url: `/api/v1/projects/${projectId}/information/project_materials:export`,
      headers: { authorization: "Bearer route-token",
        "idempotency-key": `sha256:${"e".repeat(64)}` },
      payload: { limit: 10, cursor: null } });
    expect([exportResponse.statusCode, exportResponse.json().error.code]).toEqual([
      503, "PLATFORM_INFORMATION_EXPORT_UNAVAILABLE",
    ]);
    expect(branchQuery).not.toHaveBeenCalled();
  });

  it("enforces the descriptor's per-view project-key scope", async () => {
    await repository.createProjectApiKey({
      keyId: "key_routes",
      keyHash: projectApiKeyHash("project-route-key"),
      projectId,
      actorId: "actor_routes",
      label: "monitor only",
      scopes: ["platform:read"]
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/information/project_materials`,
      headers: { authorization: "Bearer project-route-key" }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("PROJECT_KEY_SCOPE");
    expect(materialsQuery).not.toHaveBeenCalled();
  });

  it("rejects a correctly scoped project key on a different project", async () => {
    const other = await repository.resolveProject({
      actorId: "actor_routes",
      localProjectKey: "local-other",
      displayName: "Other",
      requestedProjectId: null
    });
    await repository.createProjectApiKey({
      keyId: "key_bound_routes",
      keyHash: projectApiKeyHash("project-bound-route-key"),
      projectId,
      actorId: "actor_routes",
      label: "files",
      scopes: ["files:read"]
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${other.project.projectId}/information/project_materials`,
      headers: { authorization: "Bearer project-bound-route-key" }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("PROJECT_KEY_MISMATCH");
    expect(materialsQuery).not.toHaveBeenCalled();
  });

  it("does not disclose a project outside the authenticated actor binding", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/projects/prj_not_owned/information/project_materials",
      headers: { authorization: "Bearer route-token" }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("PROJECT_INFORMATION_FORBIDDEN");
  });

  it("dispatches detail by view using a server-authored detail request", async () => {
    const detail: PlatformInformationDetailResponse = {
      schema_version: 1,
      contract_kind: "detail_response",
      view: "project_materials",
      project_id: projectId,
      detail_id: "material_1",
      detail: {
        detail_kind: "project_material",
        content: "# Rules\n",
        content_hash: "sha256:" + "a".repeat(64),
        media_type: "text/markdown"
      }
    };
    materialsDetail.mockResolvedValue({ ok: true, mode: "current", value: detail });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/information/project_materials/material_1`,
      headers: { authorization: "Bearer route-token" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(detail);
    expect(JSON.parse(firstArgument(materialsDetail.mock.calls) as string)).toMatchObject({
      contract_kind: "detail_request",
      view: "project_materials",
      project_id: projectId,
      detail_id: "material_1",
      query_scope: { actor_id: "actor_routes", accessible_project_ids: [projectId] }
    });
  });

  it("lists branch snapshot files through the bf_ locator sub-route", async () => {
    const page = {
      schema_version: 1 as const,
      contract_kind: "branch_files_page" as const,
      project_id: projectId,
      detail_id: "bf_main~pv_0002",
      items: [{
        path: "AGENTS.md",
        size: 8,
        content_hash: `sha256:${"a".repeat(64)}`,
        detail_id: "bff_main~pv_0002~AGENTS.md"
      }],
      next_cursor: null
    };
    branchFilesPage.mockResolvedValue({ ok: true, value: page });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/information/branch_files/${encodeURIComponent("bf_main~pv_0002")}/files?limit=25`,
      headers: { authorization: "Bearer route-token" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(page);
    const [serialized, locator] = branchFilesPage.mock.calls[0] as [string, unknown];
    expect(JSON.parse(serialized)).toMatchObject({
      contract_kind: "query", view: "branch_files", project_id: projectId, limit: 25
    });
    expect(locator).toBe("bf_main~pv_0002");
  });

  it("serves branch file content through bff_ locators but keeps 503 for non-locator branch details", async () => {
    const detail: PlatformInformationDetailResponse = {
      schema_version: 1,
      contract_kind: "detail_response",
      view: "branch_files",
      project_id: projectId,
      detail_id: "bff_main~pv_0002~AGENTS.md",
      detail: {
        detail_kind: "branch_file",
        content: "# agent\n",
        content_hash: `sha256:${"b".repeat(64)}`,
        media_type: "text/markdown"
      }
    };
    branchVersionDetail.mockResolvedValue({ ok: true, mode: "current", value: detail });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/information/branch_files/${encodeURIComponent("bff_main~pv_0002~AGENTS.md")}`,
      headers: { authorization: "Bearer route-token" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(detail);

    const snapshotLevel = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/information/branch_files/${encodeURIComponent("bf_main~pv_0002")}`,
      headers: { authorization: "Bearer route-token" }
    });
    expect(snapshotLevel.statusCode).toBe(503);
  });

  it("returns an explicit 503 when a branch detail has no trusted locator", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/information/branch_files/file_1`,
      headers: { authorization: "Bearer route-token" }
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("PLATFORM_INFORMATION_UNAVAILABLE");
  });

  it("registers the literal-colon restore routes and rejects a mismatched preview body", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/information/branch-files:preview-restore`,
      headers: { authorization: "Bearer route-token" },
      payload: { schema_version: 1 }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("BRANCH_FILES_RESTORE_PREVIEW_INVALID");
    expect(previewRestore).not.toHaveBeenCalled();
  });

  it("injects restore authority and returns a bound preview receipt", async () => {
    const commit = "1".repeat(40);
    const previewHash = "sha256:" + "c".repeat(64);
    const intent = {
      schema_version: 1 as const,
      contract_kind: "branch_files_pull_preview_intent" as const,
      project_id: projectId,
      source_branch_name: "trunk",
      source_commit_sha: commit,
      source_artifact_id: "artifact_snap_02",
      source_project_version: "project_version_02",
      scopes: ["branch_files"] as ["branch_files"],
      selected_paths: [".harness/config/team.yaml"],
      preview_only: true as const
    };
    const receipt = {
      schema_version: 1 as const,
      contract_kind: "branch_files_pull_preview_receipt" as const,
      project_id: projectId,
      source_ref: {
        project_id: projectId,
        branch_name: "trunk",
        commit_sha: commit,
        client_id: "actor_routes"
      },
      source_version: {
        branch_name: "trunk",
        commit_sha: commit,
        artifact_id: "artifact_snap_02",
        project_version: "project_version_02"
      },
      scopes: ["branch_files"] as ["branch_files"],
      selected_paths: [".harness/config/team.yaml"],
      preview_hash: previewHash,
      conflicts: [{
        path: ".harness/config/team.yaml",
        reason_code: "SYNC_CONTENT_CONFLICT" as const
      }]
    };
    previewRestore.mockResolvedValue({ ok: true, value: receipt });
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/information/branch-files:preview-restore`,
      headers: { authorization: "Bearer route-token" },
      payload: intent
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(receipt);
    expect(JSON.parse(firstArgument(previewRestore.mock.calls) as string)).toEqual({
      actor_id: "actor_routes",
      accessible_project_ids: [projectId],
      client_id: "actor_routes",
      intent
    });
  });

  it("uses the serialized confirmation validator at the literal-colon route", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/information/branch-files:confirm-restore`,
      headers: { authorization: "Bearer route-token" },
      payload: { preview_receipt: {}, confirmation_intent: {} }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("BRANCH_FILES_PULL_CONFIRMATION_INVALID");
  });

  it("validates and returns a confirmed request-only restore intent", async () => {
    const commit = "1".repeat(40);
    const previewHash = "sha256:" + "c".repeat(64);
    const sourceRef = {
      project_id: projectId,
      branch_name: "trunk",
      commit_sha: commit,
      client_id: "actor_routes"
    };
    const sourceVersion = {
      branch_name: "trunk",
      commit_sha: commit,
      artifact_id: "artifact_snap_02",
      project_version: "project_version_02"
    };
    const selectedPath = ".harness/config/team.yaml";
    const body = {
      preview_receipt: {
        schema_version: 1,
        contract_kind: "branch_files_pull_preview_receipt",
        project_id: projectId,
        source_ref: sourceRef,
        source_version: sourceVersion,
        scopes: ["branch_files"],
        selected_paths: [selectedPath],
        preview_hash: previewHash,
        conflicts: [{ path: selectedPath, reason_code: "SYNC_CONTENT_CONFLICT" }]
      },
      confirmation_intent: {
        schema_version: 1,
        contract_kind: "branch_files_pull_confirmation_intent",
        project_id: projectId,
        source_ref: sourceRef,
        source_version: sourceVersion,
        scopes: ["branch_files"],
        preview_hash: previewHash,
        action: "continue",
        idempotency_key: "restore_routes_snap_02",
        conflict_decisions: [{
          path: selectedPath,
          resolution: "accept_remote",
          expected_preview_hash: previewHash,
          source_artifact_id: "artifact_snap_02",
          source_project_version: "project_version_02"
        }]
      }
    };
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/information/branch-files:confirm-restore`,
      headers: { authorization: "Bearer route-token" },
      payload: body
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      contract_kind: "branch_files_pull_confirmed_intent",
      project_id: projectId,
      selected_paths: [selectedPath],
      preview_hash: previewHash,
      request_only: true
    });
  });

  it("rejects confirmation for a preview issued to another authenticated client", async () => {
    const commit = "1".repeat(40);
    const previewHash = "sha256:" + "c".repeat(64);
    const sourceRef = { project_id: projectId, branch_name: "trunk", commit_sha: commit, client_id: "actor_other" };
    const sourceVersion = { branch_name: "trunk", commit_sha: commit, artifact_id: "artifact_snap_02", project_version: "project_version_02" };
    const path = ".harness/config/team.yaml";
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/information/branch-files:confirm-restore`,
      headers: { authorization: "Bearer route-token" },
      payload: {
        preview_receipt: { schema_version: 1, contract_kind: "branch_files_pull_preview_receipt", project_id: projectId,
          source_ref: sourceRef, source_version: sourceVersion, scopes: ["branch_files"], selected_paths: [path],
          preview_hash: previewHash, conflicts: [{ path, reason_code: "SYNC_CONTENT_CONFLICT" }] },
        confirmation_intent: { schema_version: 1, contract_kind: "branch_files_pull_confirmation_intent", project_id: projectId,
          source_ref: sourceRef, source_version: sourceVersion, scopes: ["branch_files"], preview_hash: previewHash,
          action: "continue", idempotency_key: "restore_other_client", conflict_decisions: [{ path,
            resolution: "accept_remote", expected_preview_hash: previewHash, source_artifact_id: "artifact_snap_02",
            source_project_version: "project_version_02" }] }
      }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("BRANCH_FILES_PULL_CONFIRMATION_MISMATCH");
  });

  it("maps missing knowledge details to the declared 404", async () => {
    knowledgeDetail.mockResolvedValue({ ok: false, reason_code: "PROJECT_KNOWLEDGE_DETAIL_NOT_FOUND" });
    const knowledge = await app.inject({ method: "GET",
      url: `/api/v1/projects/${projectId}/information/project_knowledge/knowledge_1`,
      headers: { authorization: "Bearer route-token" } });
    expect([knowledge.statusCode, knowledge.json().error.code]).toEqual([404, "PLATFORM_INFORMATION_DETAIL_NOT_FOUND"]);
  });

  it("injects actor and project into a bounded extraction retry request", async () => {
    retryIntent.mockResolvedValue({
      ok: true,
      value: {
        schema_version: 1,
        contract_kind: "knowledge_extraction_retry_intent",
        actor_id: "actor_routes",
        project_id: projectId,
        job_id: "job_knowledge_retry-1",
        expected_generation: 4,
        retryable: true,
        request_only: true,
        intent_hash: "sha256:" + "b".repeat(64)
      }
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/information/knowledge:retry-extraction`,
      headers: { authorization: "Bearer route-token" },
      payload: { job_id: "job_knowledge_retry-1", expected_generation: 4 }
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(firstArgument(retryIntent.mock.calls) as string)).toEqual({
      schema_version: 1,
      contract_kind: "knowledge_extraction_retry_request",
      actor_id: "actor_routes",
      project_id: projectId,
      job_id: "job_knowledge_retry-1",
      expected_generation: 4
    });
  });

  it("maps reachable retry authority outcomes to 404 and 409", async () => {
    retryIntent
      .mockResolvedValueOnce({ ok: false, reason_code: "PROJECT_KNOWLEDGE_RETRY_JOB_NOT_FOUND" })
      .mockResolvedValueOnce({ ok: false, reason_code: "PROJECT_KNOWLEDGE_RETRY_GENERATION_CONFLICT" });
    const request = () => app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/information/knowledge:retry-extraction`,
      headers: { authorization: "Bearer route-token" },
      payload: { job_id: "job_knowledge_retry-1", expected_generation: 4 }
    });
    const missing = await request();
    const stale = await request();
    expect([missing.statusCode, missing.json().error.code]).toEqual([
      404, "KNOWLEDGE_EXTRACTION_JOB_NOT_FOUND"
    ]);
    expect([stale.statusCode, stale.json().error.code]).toEqual([
      409, "KNOWLEDGE_EXTRACTION_GENERATION_CONFLICT"
    ]);
  });

  it("returns 503 when query adapters are not configured", async () => {
    await app.close();
    app = await createServer({ repository, storage: new MemoryArtifactStorage() });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/information/project_materials`,
      headers: { authorization: "Bearer route-token" }
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("PLATFORM_INFORMATION_UNAVAILABLE");
  });

  it("creates idempotent durable exports and streams them through the download route", async () => {
    await app.close();
    const receipt = {
      export_id: "export_routes_1",
      project_id: projectId,
      view: "project_materials",
      artifact: { media_type: "application/x-ndjson", byte_count: 3,
        content_sha: "sha256:" + "a".repeat(64) },
      download_ref: { export_id: "export_routes_1", project_id: projectId, content_sha: "sha256:" + "a".repeat(64) },
    } as unknown as PlatformInformationExportArtifactReceipt;
    const generated = vi.fn<PlatformInformationExportModule["export_all"]>()
      .mockResolvedValue({ ok: true, value: receipt });
    const findReady = vi.fn<PlatformInformationExportRecordPort["findReadyByIdempotency"]>()
      .mockResolvedValueOnce({ status: "not_found" })
      .mockResolvedValueOnce({ status: "ready", record: {
        actor_id: "actor_routes", idempotency_key: "sha256:" + "b".repeat(64),
        query_hash: "sha256:" + "c".repeat(64), receipt
      } });
    const publishReady = vi.fn<PlatformInformationExportRecordPort["publishReady"]>()
      .mockResolvedValue({ status: "published", record: {
        actor_id: "actor_routes", idempotency_key: "sha256:" + "b".repeat(64),
        query_hash: "sha256:" + "c".repeat(64), receipt
      } });
    const getReadyForDownload = vi.fn<PlatformInformationExportRecordPort["getReadyForDownload"]>()
      .mockResolvedValue({ status: "ready", record: {
        actor_id: "actor_routes", idempotency_key: "sha256:" + "b".repeat(64),
        query_hash: "sha256:" + "c".repeat(64), receipt
      } });
    const records = {
      findReadyByIdempotency: findReady,
      publishReady,
      getReadyForDownload,
    } as unknown as PlatformInformationExportRecordPort;
    const download = {
      open: vi.fn<PlatformInformationExportDownloadPort["open"]>().mockResolvedValue((async function* () {
        yield new TextEncoder().encode("{}\\n");
      })())
    } as PlatformInformationExportDownloadPort;
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), platformInformation: {
      export_module: { export_all: generated }, export_records: records, export_download: download
    } });
    const key = "sha256:" + "b".repeat(64);
    const first = await app.inject({ method: "POST",
      url: `/api/v1/projects/${projectId}/information/project_materials:export`,
      headers: { authorization: "Bearer route-token", "idempotency-key": key }, payload: { limit: 10, cursor: null } });
    expect(first.statusCode).toBe(201);
    expect(generated).toHaveBeenCalledOnce();
    const replay = await app.inject({ method: "POST",
      url: `/api/v1/projects/${projectId}/information/project_materials:export`,
      headers: { authorization: "Bearer route-token", "idempotency-key": key }, payload: { limit: 10, cursor: null } });
    expect(replay.statusCode).toBe(200);
    expect(generated).toHaveBeenCalledOnce();
    const streamed = await app.inject({ method: "GET",
      url: `/api/v1/projects/${projectId}/information/project_materials/exports/export_routes_1`,
      headers: { authorization: "Bearer route-token" } });
    expect(streamed.statusCode, streamed.body).toBe(200);
    expect(streamed.headers["content-type"]).toContain("application/x-ndjson");
    expect(streamed.headers["content-disposition"]).toBe('attachment; filename="export_routes_1.ndjson"');
    expect(streamed.headers["x-content-sha256"]).toBe("sha256:" + "a".repeat(64));
    expect(streamed.body).toBe("{}\\n");
  });

  it("serializes concurrent creation for the same idempotency identity", async () => {
    await app.close();
    const receipt = {
      export_id: "export_routes_claim", project_id: projectId, view: "project_materials",
      artifact: { media_type: "application/x-ndjson", byte_count: 3,
        content_sha: `sha256:${"a".repeat(64)}` },
      download_ref: { export_id: "export_routes_claim", project_id: projectId,
        content_sha: `sha256:${"a".repeat(64)}` },
    } as unknown as PlatformInformationExportArtifactReceipt;
    let releaseGeneration = (): void => undefined;
    const generationGate = new Promise<void>((resolve) => { releaseGeneration = resolve; });
    let generationEntered = (): void => undefined;
    const generationStarted = new Promise<void>((resolve) => { generationEntered = resolve; });
    const generated = vi.fn<PlatformInformationExportModule["export_all"]>().mockImplementation(async () => {
      generationEntered();
      await generationGate;
      return { ok: true, value: receipt };
    });
    const findReady = vi.fn<PlatformInformationExportRecordPort["findReadyByIdempotency"]>()
      .mockResolvedValueOnce({ status: "not_found" })
      .mockResolvedValueOnce({ status: "ready", record: {
        actor_id: "actor_routes", idempotency_key: `sha256:${"d".repeat(64)}`,
        query_hash: `sha256:${"c".repeat(64)}`, receipt,
      } });
    const publishReady = vi.fn<PlatformInformationExportRecordPort["publishReady"]>()
      .mockResolvedValue({ status: "published", record: {
        actor_id: "actor_routes", idempotency_key: `sha256:${"d".repeat(64)}`,
        query_hash: `sha256:${"c".repeat(64)}`, receipt,
      } });
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), platformInformation: {
      export_module: { export_all: generated },
      export_records: { findReadyByIdempotency: findReady, publishReady } as unknown as PlatformInformationExportRecordPort,
    } });
    const request = () => app.inject({ method: "POST",
      url: `/api/v1/projects/${projectId}/information/project_materials:export`,
      headers: { authorization: "Bearer route-token", "idempotency-key": `sha256:${"d".repeat(64)}` },
      payload: { limit: 10, cursor: null } });
    const first = request();
    await generationStarted;
    const second = request();
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(generated).toHaveBeenCalledOnce();
    releaseGeneration();
    const [created, replayed] = await Promise.all([first, second]);
    expect([created.statusCode, replayed.statusCode]).toEqual([201, 200]);
    expect(generated).toHaveBeenCalledOnce();
    expect(findReady).toHaveBeenCalledTimes(2);
  });

  it("uses the selected view scope when authorizing export downloads", async () => {
    await app.close();
    await repository.createProjectApiKey({ keyId: "key_download_files",
      keyHash: projectApiKeyHash("download-files-key"), projectId, actorId: "actor_routes",
      label: "files", scopes: ["files:read"] });
    await repository.createProjectApiKey({ keyId: "key_download_platform",
      keyHash: projectApiKeyHash("download-platform-key"), projectId, actorId: "actor_routes",
      label: "platform", scopes: ["platform:read"] });
    const receipt = {
      export_id: "export_routes_scope", project_id: projectId, view: "project_materials",
      artifact: { media_type: "application/x-ndjson", byte_count: 3,
        content_sha: `sha256:${"a".repeat(64)}` },
      download_ref: { export_id: "export_routes_scope", project_id: projectId,
        content_sha: `sha256:${"a".repeat(64)}` },
    } as unknown as PlatformInformationExportArtifactReceipt;
    const getReadyForDownload = vi.fn<PlatformInformationExportRecordPort["getReadyForDownload"]>()
      .mockResolvedValue({ status: "ready", record: { actor_id: "actor_routes",
        idempotency_key: `sha256:${"b".repeat(64)}`, query_hash: `sha256:${"c".repeat(64)}`, receipt } });
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), platformInformation: {
      export_records: { getReadyForDownload } as unknown as PlatformInformationExportRecordPort,
      export_download: { open: async () => (async function* () {
        yield new TextEncoder().encode("{}\n");
      })() },
    } });
    const url = `/api/v1/projects/${projectId}/information/project_materials/exports/export_routes_scope`;
    const allowed = await app.inject({ method: "GET", url,
      headers: { authorization: "Bearer download-files-key" } });
    const denied = await app.inject({ method: "GET", url,
      headers: { authorization: "Bearer download-platform-key" } });
    expect(allowed.statusCode).toBe(200);
    expect(denied.statusCode).toBe(403);
    expect(getReadyForDownload).toHaveBeenCalledOnce();
  });

  it("maps adapter cursor and source failures to the frozen HTTP error set", async () => {
    materialsQuery
      .mockResolvedValueOnce({ ok: false, reason_code: "PROJECT_MATERIALS_CURSOR_INVALID" })
      .mockResolvedValueOnce({ ok: false, reason_code: "PROJECT_MATERIALS_SOURCE_INVALID" });
    const cursor = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/information/project_materials?cursor=${"c".repeat(16)}`,
      headers: { authorization: "Bearer route-token" }
    });
    const source = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/information/project_materials`,
      headers: { authorization: "Bearer route-token" }
    });
    expect([cursor.statusCode, cursor.json().error.code]).toEqual([400, "PLATFORM_INFORMATION_CURSOR_INVALID"]);
    expect([source.statusCode, source.json().error.code]).toEqual([503, "PLATFORM_INFORMATION_SOURCE_INVALID"]);
  });

  it("maps unknown repository and query adapter failures to non-leaking 503 envelopes", async () => {
    vi.spyOn(repository, "getProject").mockRejectedValueOnce(new Error("postgres password leaked"));
    const repositoryFailure = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/information/project_materials`,
      headers: { authorization: "Bearer route-token" }
    });
    expect([repositoryFailure.statusCode, repositoryFailure.json().error.code]).toEqual([
      503, "PLATFORM_INFORMATION_UNAVAILABLE"
    ]);
    expect(repositoryFailure.body).not.toContain("postgres password leaked");

    materialsQuery.mockRejectedValueOnce(new Error("source connection secret"));
    const adapterFailure = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/information/project_materials`,
      headers: { authorization: "Bearer route-token" }
    });
    expect([adapterFailure.statusCode, adapterFailure.json().error.code]).toEqual([
      503, "PLATFORM_INFORMATION_UNAVAILABLE"
    ]);
    expect(adapterFailure.body).not.toContain("source connection secret");

    materialsQuery.mockRejectedValueOnce(new Error("export-all source secret"));
    const exportAllFailure = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/information/project_materials:export-all`,
      headers: { authorization: "Bearer route-token" }
    });
    expect([exportAllFailure.statusCode, exportAllFailure.json().error.code]).toEqual([
      503, "PLATFORM_INFORMATION_UNAVAILABLE"
    ]);
    expect(exportAllFailure.body).not.toContain("export-all source secret");
  });

  it("maps unknown durable export record, generation, and publication failures to export unavailable", async () => {
    await app.close();
    const key = `sha256:${"e".repeat(64)}`;
    const request = () => app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/information/project_materials:export`,
      headers: { authorization: "Bearer route-token", "idempotency-key": key },
      payload: { limit: 10, cursor: null }
    });
    const generated = vi.fn<PlatformInformationExportModule["export_all"]>();
    const findReady = vi.fn<PlatformInformationExportRecordPort["findReadyByIdempotency"]>();
    const publishReady = vi.fn<PlatformInformationExportRecordPort["publishReady"]>();
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), platformInformation: {
      export_module: { export_all: generated },
      export_records: { findReadyByIdempotency: findReady, publishReady } as unknown as PlatformInformationExportRecordPort,
    } });

    const projectRead = vi.spyOn(repository, "getProject")
      .mockRejectedValueOnce(new Error("binding database secret"));
    const bindingFailure = await request();
    expect([bindingFailure.statusCode, bindingFailure.json().error.code]).toEqual([
      503, "PLATFORM_INFORMATION_EXPORT_UNAVAILABLE"
    ]);
    expect(bindingFailure.body).not.toContain("binding database secret");
    projectRead.mockRestore();

    findReady.mockRejectedValueOnce(new Error("record database secret"));
    const recordFailure = await request();
    expect([recordFailure.statusCode, recordFailure.json().error.code]).toEqual([
      503, "PLATFORM_INFORMATION_EXPORT_UNAVAILABLE"
    ]);
    expect(recordFailure.body).not.toContain("record database secret");

    findReady.mockResolvedValueOnce({ status: "not_found" });
    generated.mockRejectedValueOnce(new Error("source adapter secret"));
    const generationFailure = await request();
    expect([generationFailure.statusCode, generationFailure.json().error.code]).toEqual([
      503, "PLATFORM_INFORMATION_EXPORT_UNAVAILABLE"
    ]);
    expect(generationFailure.body).not.toContain("source adapter secret");

    const receipt = { export_id: "export_failure", project_id: projectId, view: "project_materials" } as
      unknown as PlatformInformationExportArtifactReceipt;
    findReady.mockResolvedValueOnce({ status: "not_found" });
    generated.mockResolvedValueOnce({ ok: true, value: receipt });
    publishReady.mockRejectedValueOnce(new Error("publication database secret"));
    const publicationFailure = await request();
    expect([publicationFailure.statusCode, publicationFailure.json().error.code]).toEqual([
      503, "PLATFORM_INFORMATION_EXPORT_UNAVAILABLE"
    ]);
    expect(publicationFailure.body).not.toContain("publication database secret");
  });

  it("maps unknown download record and stream-open failures without leaking backend errors", async () => {
    await app.close();
    const receipt = {
      export_id: "export_download_failure", project_id: projectId, view: "project_materials",
      artifact: { media_type: "application/x-ndjson", byte_count: 3,
        content_sha: `sha256:${"a".repeat(64)}` },
      download_ref: { export_id: "export_download_failure", project_id: projectId,
        content_sha: `sha256:${"a".repeat(64)}` },
    } as unknown as PlatformInformationExportArtifactReceipt;
    const getReady = vi.fn<PlatformInformationExportRecordPort["getReadyForDownload"]>();
    const open = vi.fn<PlatformInformationExportDownloadPort["open"]>();
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), platformInformation: {
      export_records: { getReadyForDownload: getReady } as unknown as PlatformInformationExportRecordPort,
      export_download: { open },
    } });
    const request = () => app.inject({ method: "GET",
      url: `/api/v1/projects/${projectId}/information/project_materials/exports/export_download_failure`,
      headers: { authorization: "Bearer route-token" } });

    getReady.mockRejectedValueOnce(new Error("download records secret"));
    const recordFailure = await request();
    expect([recordFailure.statusCode, recordFailure.json().error.code]).toEqual([
      503, "PLATFORM_INFORMATION_EXPORT_DOWNLOAD_UNAVAILABLE"
    ]);
    expect(recordFailure.body).not.toContain("download records secret");

    getReady.mockResolvedValueOnce({ status: "ready", record: { actor_id: "actor_routes",
      idempotency_key: `sha256:${"b".repeat(64)}`, query_hash: `sha256:${"c".repeat(64)}`, receipt } });
    open.mockRejectedValueOnce(new Error("artifact storage secret"));
    const streamFailure = await request();
    expect([streamFailure.statusCode, streamFailure.json().error.code]).toEqual([
      503, "PLATFORM_INFORMATION_EXPORT_DOWNLOAD_UNAVAILABLE"
    ]);
    expect(streamFailure.body).not.toContain("artifact storage secret");

    await app.close();
    app = await createServer({ repository, storage: new MemoryArtifactStorage() });
    const unavailable = await request();
    expect([unavailable.statusCode, unavailable.json().error.code]).toEqual([
      503, "PLATFORM_INFORMATION_EXPORT_DOWNLOAD_UNAVAILABLE"
    ]);
  });
});
