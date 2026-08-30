// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PlatformInformationDetailResponse, PlatformInformationPage } from "@hunter-harness/contracts";
import {
  BranchFilesInformationPanel,
  ChangeRecordsInformationPanel,
  ProjectKnowledgeInformationPanel,
  ProjectMaterialsInformationPanel,
  VersionRecordsInformationPanel
} from "../components/project-information-panels";
import type { HunterApi } from "../lib/api";

afterEach(cleanup);

function page(view: PlatformInformationPage["view"], items: PlatformInformationPage["items"], nextCursor: string | null = null): PlatformInformationPage {
  const sort = view === "project_materials" ? "category_asc_path_asc_version_desc"
    : view === "project_knowledge" ? "extracted_at_desc_knowledge_id_asc"
      : view === "change_records" ? "archived_at_desc_change_key_asc"
        : "uploaded_at_desc_snapshot_version_asc";
  return { schema_version: 1, contract_kind: "page", view, project_id: "prj_one", page_state: items.length === 0 ? "empty" : "ready", sort, items, next_cursor: nextCursor, failures: [] };
}

function api(overrides: Partial<HunterApi>): HunterApi {
  return overrides as HunterApi;
}

describe("project information panels", () => {
  it("ignores a stale list response after project identity changes", async () => {
    let release!: (value: PlatformInformationPage) => void;
    const oldPage = new Promise<PlatformInformationPage>((resolve) => { release = resolve; });
    const list = vi.fn(async (project: string) => project === "prj_old" ? oldPage : page("project_materials", [{
      item_kind: "project_material", material_id: "new", category: "rule", path: "NEW.md",
      blob_ref: { blob_hash: `sha256:${"a".repeat(64)}`, snapshot_version: "pv_new" }, source_branch_name: "main",
      source_commit_sha: "b".repeat(40), sort_key: "new"
    }]));
    const shared = api({ listPlatformInformation: list });
    const { rerender } = render(<ProjectMaterialsInformationPanel api={shared} projectId="prj_old" lang="en" />);
    rerender(<ProjectMaterialsInformationPanel api={shared} projectId="prj_new" lang="en" />);
    expect(await screen.findByText("NEW.md")).toBeInTheDocument();
    release(page("project_materials", [{ item_kind: "project_material", material_id: "old", category: "rule", path: "OLD.md", blob_ref: { blob_hash: `sha256:${"a".repeat(64)}`, snapshot_version: "pv_old" }, source_branch_name: "main", source_commit_sha: "b".repeat(40), sort_key: "old" }]));
    await waitFor(() => expect(screen.queryByText("OLD.md")).not.toBeInTheDocument());
  });

  it("paginates materials and loads body only after selecting a reference", async () => {
    const list = vi.fn(async (_project: string, _view: PlatformInformationPage["view"], query?: { cursor?: string | null }) => page("project_materials", [{
      item_kind: "project_material", material_id: query?.cursor ? "mat_rule" : "mat_map",
      category: query?.cursor ? "rule" : "architecture_map", path: query?.cursor ? "AGENTS.md" : ".harness/codebase/map.json",
      blob_ref: { blob_hash: `sha256:${"a".repeat(64)}`, snapshot_version: "pv_2" }, source_branch_name: "develop",
      source_commit_sha: "b".repeat(40), sort_key: query?.cursor ? "rule" : "map"
    }], query?.cursor ? null : "cursor_page_two_1"));
    const detail = vi.fn(async () => ({ schema_version: 1, contract_kind: "detail_response", view: "project_materials", project_id: "prj_one", detail_id: "mat_map", detail: {
      detail_kind: "project_material", content: "# Architecture map", content_hash: `sha256:${"a".repeat(64)}`, media_type: "text/markdown"
    } } as const));
    render(<ProjectMaterialsInformationPanel api={api({ listPlatformInformation: list, getPlatformInformationDetail: detail })} projectId="prj_one" lang="en" />);

    expect(await screen.findByText("map.json")).toBeInTheDocument();
    expect(detail).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open map.json" }));
    expect(await screen.findByRole("heading", { name: "Architecture map" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("AGENTS.md")).toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith("prj_one", "project_materials", { limit: 50, cursor: "cursor_page_two_1" });
  });

  it("lists material filenames without directory segments and previews Markdown as a readable document", async () => {
    const materials = [
      { item_kind: "project_material" as const, material_id: "readme", category: "rule" as const, path: "docs/guide/README.md", blob_ref: { blob_hash: `sha256:${"a".repeat(64)}`, snapshot_version: "pv_1" }, source_branch_name: "main", source_commit_sha: "b".repeat(40), sort_key: "readme" },
      { item_kind: "project_material" as const, material_id: "note", category: "instruction" as const, path: "docs/notes.md", blob_ref: { blob_hash: `sha256:${"a".repeat(64)}`, snapshot_version: "pv_1" }, source_branch_name: "main", source_commit_sha: "b".repeat(40), sort_key: "note" }
    ];
    render(<ProjectMaterialsInformationPanel api={api({
      listPlatformInformation: vi.fn(async () => page("project_materials", materials)),
      getPlatformInformationDetail: vi.fn(async () => ({ schema_version: 1, contract_kind: "detail_response", view: "project_materials", project_id: "prj_one", detail_id: "readme", detail: { detail_kind: "project_material", content: "# Guide\n\n- First step\n- Second step", content_hash: `sha256:${"a".repeat(64)}`, media_type: "text/markdown" } } as const))
    })} projectId="prj_one" lang="zh" />);

    expect(await screen.findByRole("button", { name: "打开 README.md" })).not.toHaveAttribute("title");
    expect(screen.getByRole("button", { name: "打开 notes.md" })).toBeInTheDocument();
    expect(screen.getByText("规则").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("指令").closest("details")).not.toHaveAttribute("open");
    expect(screen.queryByText("docs")).not.toBeInTheDocument();
    expect(screen.queryByText("guide")).not.toBeInTheDocument();
    expect(screen.queryByText("docs/guide/README.md")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "筛选当前结果" }), { target: { value: "README" } });
    expect(screen.getByText("规则").closest("details")).toHaveAttribute("open");
    expect(screen.getByRole("button", { name: "打开 README.md" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "打开 README.md" }));
    expect(await screen.findByRole("heading", { name: "Guide" })).toBeInTheDocument();
    expect(screen.getByText("First step")).toBeInTheDocument();
  });

  it("does not let stale detail overwrite a newer project and localizes the open action", async () => {
    let release!: (value: PlatformInformationDetailResponse) => void;
    const oldDetail = new Promise<PlatformInformationDetailResponse>((resolve) => { release = resolve; });
    const material = (id: string, path: string) => ({ item_kind: "project_material" as const, material_id: id, category: "rule" as const, path, blob_ref: { blob_hash: `sha256:${"a".repeat(64)}`, snapshot_version: "pv_1" }, source_branch_name: "main", source_commit_sha: "b".repeat(40), sort_key: id });
    const shared = api({
      listPlatformInformation: vi.fn(async (project: string) => ({ ...page("project_materials", [project === "prj_old" ? material("old", "旧.md") : material("new", "新.md")]), project_id: project })),
      getPlatformInformationDetail: vi.fn(async (project: string, _view, id): Promise<PlatformInformationDetailResponse> => project === "prj_old" ? oldDetail : ({ schema_version: 1, contract_kind: "detail_response", view: "project_materials", project_id: project, detail_id: id, detail: { detail_kind: "project_material", content: "new body", content_hash: `sha256:${"a".repeat(64)}`, media_type: "text/markdown" } }))
    });
    const { rerender } = render(<ProjectMaterialsInformationPanel api={shared} projectId="prj_old" lang="zh" />);
    fireEvent.click(await screen.findByRole("button", { name: "打开 旧.md" }));
    rerender(<ProjectMaterialsInformationPanel api={shared} projectId="prj_new" lang="zh" />);
    fireEvent.click(await screen.findByRole("button", { name: "打开 新.md" }));
    expect(await screen.findByText("new body")).toBeInTheDocument();
    release({ schema_version: 1, contract_kind: "detail_response", view: "project_materials", project_id: "prj_old", detail_id: "old", detail: { detail_kind: "project_material", content: "stale body", content_hash: `sha256:${"a".repeat(64)}`, media_type: "text/markdown" } });
    await waitFor(() => expect(screen.queryByText("stale body")).not.toBeInTheDocument());
  });

  it("clears a pending detail loading state when the project identity changes", async () => {
    const pending = new Promise<PlatformInformationDetailResponse>(() => undefined);
    const material = (id: string, path: string) => ({ item_kind: "project_material" as const, material_id: id, category: "rule" as const, path, blob_ref: { blob_hash: `sha256:${"a".repeat(64)}`, snapshot_version: "pv_1" }, source_branch_name: "main", source_commit_sha: "b".repeat(40), sort_key: id });
    const shared = api({
      listPlatformInformation: vi.fn(async (project: string) => ({ ...page("project_materials", [project === "prj_old" ? material("old", "OLD.md") : material("new", "NEW.md")]), project_id: project })),
      getPlatformInformationDetail: vi.fn(async (project: string): Promise<PlatformInformationDetailResponse> => project === "prj_old" ? pending : ({ schema_version: 1, contract_kind: "detail_response", view: "project_materials", project_id: project, detail_id: "new", detail: { detail_kind: "project_material", content: "new body", content_hash: `sha256:${"a".repeat(64)}`, media_type: "text/markdown" } }))
    });
    const { rerender } = render(<ProjectMaterialsInformationPanel api={shared} projectId="prj_old" lang="en" />);
    fireEvent.click(await screen.findByRole("button", { name: "Open OLD.md" }));
    expect(await screen.findByText("Loading detail on demand")).toBeInTheDocument();
    rerender(<ProjectMaterialsInformationPanel api={shared} projectId="prj_new" lang="en" />);
    expect(await screen.findByRole("button", { name: "Open NEW.md" })).toBeInTheDocument();
    expect(screen.queryByText("Loading detail on demand")).not.toBeInTheDocument();
  });

  it("keeps knowledge retry request-only when the server did not expose a trusted job identity", async () => {
    const retry = vi.fn();
    render(<ProjectKnowledgeInformationPanel api={api({
      listPlatformInformation: vi.fn(async () => ({ ...page("project_knowledge", []), page_state: "failed" as const, failures: [{ reason_code: "KNOWLEDGE_EXTRACTION_FAILED" as const, retryable: true }] })),
      retryProjectKnowledgeExtraction: retry
    })} projectId="prj_one" lang="en" />);

    expect(await screen.findByText("Knowledge extraction failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry extraction" })).toBeDisabled();
    expect(screen.getByText("KNOWLEDGE_RETRY_IDENTITY_UNAVAILABLE")).toBeInTheDocument();
    expect(retry).not.toHaveBeenCalled();
  });

  it("loads change metadata and documents separately and exposes only the canonical archive reference", async () => {
    const detail = vi.fn(async (_project: string, _view: PlatformInformationPage["view"], id: string): Promise<PlatformInformationDetailResponse> => id === "change-one"
      ? { schema_version: 1, contract_kind: "detail_response", view: "change_records", project_id: "prj_one", detail_id: id, detail: { detail_kind: "change_record", document_refs: ["doc_design"], candidate_refs: ["candidate_1"], archive_download_ref: { archive_id: "archive_1", package_hash: `sha256:${"c".repeat(64)}` } } }
      : { schema_version: 1, contract_kind: "detail_response", view: "change_records", project_id: "prj_one", detail_id: id, detail: { detail_kind: "change_document", content: "# Design", content_hash: `sha256:${"d".repeat(64)}`, media_type: "text/markdown" } });
    render(<ChangeRecordsInformationPanel api={api({
      listPlatformInformation: vi.fn(async () => page("change_records", [{ item_kind: "change_record", change_key: "change-one", title: "真实变更", archived_at: "2026-08-13T00:00:00Z", archive_status: "stored", knowledge_extraction_status: "ready", document_refs: ["doc_design"], candidate_count: 1, archive_download_ref: { archive_id: "archive_1", package_hash: `sha256:${"c".repeat(64)}` }, sort_key: "change-one" }])),
      getPlatformInformationDetail: detail
    })} projectId="prj_one" lang="en" />);

    fireEvent.click(await screen.findByRole("button", { name: /Open 真实变更/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Open document doc_design" }));
    expect(await screen.findByRole("heading", { name: "Design" })).toBeInTheDocument();
    expect(screen.getByText("archive_1")).toBeInTheDocument();
    expect(screen.getByText("ARCHIVE_AUTHENTICATED_DOWNLOAD_CLIENT_UNAVAILABLE")).toBeInTheDocument();
  });

  it("shows change-document loading and technical failure state, then retries the same document safely", async () => {
    let documentAttempts = 0;
    let release!: (value: PlatformInformationDetailResponse) => void;
    const pending = new Promise<PlatformInformationDetailResponse>((resolve) => { release = resolve; });
    const detail = vi.fn(async (_project: string, _view: PlatformInformationPage["view"], id: string): Promise<PlatformInformationDetailResponse> => {
      if (id === "change-one") return { schema_version: 1, contract_kind: "detail_response", view: "change_records", project_id: "prj_one", detail_id: id, detail: { detail_kind: "change_record", document_refs: ["doc_design"], candidate_refs: [], archive_download_ref: null } };
      documentAttempts += 1;
      if (documentAttempts === 1) throw new Error("CHANGE_DOCUMENT_FETCH_FAILED");
      return pending;
    });
    render(<ChangeRecordsInformationPanel api={api({
      listPlatformInformation: vi.fn(async () => page("change_records", [{ item_kind: "change_record", change_key: "change-one", title: "Change one", archived_at: "2026-08-13T00:00:00Z", archive_status: "stored", knowledge_extraction_status: "ready", document_refs: ["doc_design"], candidate_count: 0, archive_download_ref: null, sort_key: "change-one" }])),
      getPlatformInformationDetail: detail
    })} projectId="prj_one" lang="en" />);

    fireEvent.click(await screen.findByRole("button", { name: "Open Change one" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open document doc_design" }));
    expect(await screen.findByText("CHANGE_DOCUMENT_FETCH_FAILED")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Loading change document on demand")).toBeInTheDocument();
    release({ schema_version: 1, contract_kind: "detail_response", view: "change_records", project_id: "prj_one", detail_id: "doc_design", detail: { detail_kind: "change_document", content: "# Recovered", content_hash: `sha256:${"d".repeat(64)}`, media_type: "text/markdown" } });
    expect(await screen.findByRole("heading", { name: "Recovered" })).toBeInTheDocument();
    expect(detail).toHaveBeenCalledTimes(3);
  });

  it("reports unsupported change-document loading when the detail API disappears", async () => {
    const shared = api({});
    shared.listPlatformInformation = vi.fn(async () => page("change_records", [{ item_kind: "change_record", change_key: "change-one", title: "Change one", archived_at: "2026-08-13T00:00:00Z", archive_status: "stored", knowledge_extraction_status: "ready", document_refs: ["doc_design"], candidate_count: 0, archive_download_ref: null, sort_key: "change-one" }]));
    shared.getPlatformInformationDetail = vi.fn(async (): Promise<PlatformInformationDetailResponse> => {
      delete shared.getPlatformInformationDetail;
      return { schema_version: 1, contract_kind: "detail_response", view: "change_records", project_id: "prj_one", detail_id: "change-one", detail: { detail_kind: "change_record", document_refs: ["doc_design"], candidate_refs: [], archive_download_ref: null } };
    });
    render(<ChangeRecordsInformationPanel api={shared} projectId="prj_one" lang="en" />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Change one" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open document doc_design" }));
    expect(await screen.findByText("CHANGE_DOCUMENT_DETAIL_UNSUPPORTED")).toBeInTheDocument();
    expect(screen.getByText("Change document detail is not supported by this API client.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("keeps the pagination retry action at least 44px high", () => {
    const css = readFileSync(resolve(process.cwd(), "apps/web/app/globals.css"), "utf8");
    expect(css).toMatch(/\.information-pagination-failure\s*>\s*button[^{}]*\{[^{}]*min-height:\s*44px;/u);
  });

  it("uses canonical branch and version pages without falling back to legacy full-file APIs", async () => {
    const listProjectFiles = vi.fn();
    const list = vi.fn(async (_project: string, view: PlatformInformationPage["view"]) => view === "branch_files"
      ? page(view, [{ item_kind: "branch_snapshot", branch_name: "feature", snapshot_version: "pv_2", commit_sha: "e".repeat(40), uploaded_at: "2026-08-13T00:00:00Z", file_count: 8, changed_file_count: 2, sort_key: "feature" }])
      : page(view, [{ item_kind: "version_record", branch_name: "feature", snapshot_version: "pv_2", commit_sha: "e".repeat(40), uploaded_at: "2026-08-13T00:00:00Z", file_count: 8, changed_file_count: 2, diff_ref: "diff_2", sort_key: "version" }]));
    const sharedApi = api({ listPlatformInformation: list, listProjectFiles });
    const { rerender } = render(<BranchFilesInformationPanel api={sharedApi} projectId="prj_one" lang="en" />);
    expect(await screen.findByText("feature")).toBeInTheDocument();
    expect(screen.getByText("BRANCH_FILE_LOCATOR_ROUTE_UNAVAILABLE")).toBeInTheDocument();
    expect(listProjectFiles).not.toHaveBeenCalled();

    rerender(<VersionRecordsInformationPanel api={sharedApi} projectId="prj_one" lang="en" />);
    expect(await screen.findByText("diff_2")).toBeInTheDocument();
    await waitFor(() => expect(list).toHaveBeenCalledWith("prj_one", "version_records", { limit: 50, cursor: null }));
  });

  it("gates concurrent load-more and stops on a non-progress cursor while deduplicating identities", async () => {
    let release!: (value: PlatformInformationPage) => void;
    const second = new Promise<PlatformInformationPage>((resolve) => { release = resolve; });
    const item = { item_kind: "knowledge_entry" as const, knowledge_id: "k1", display_title: "One", lifecycle_status: "active" as const, source_change_key: "c1", extracted_at: "2026-08-13T00:00:00Z", relationship_count: 0, sort_key: "k1" };
    const list = vi.fn(async (_project: string, _view: PlatformInformationPage["view"], query?: { cursor?: string | null }) => query?.cursor ? second : page("project_knowledge", [item], "cursor_page_two_1"));
    render(<ProjectKnowledgeInformationPanel api={api({ listPlatformInformation: list })} projectId="prj_one" lang="en" />);
    const more = await screen.findByRole("button", { name: "Load more" });
    fireEvent.click(more); fireEvent.click(more);
    expect(list).toHaveBeenCalledTimes(2);
    release(page("project_knowledge", [item], "cursor_page_two_1"));
    expect(await screen.findByText("PLATFORM_INFORMATION_CURSOR_NON_PROGRESS")).toBeInTheDocument();
    expect(screen.getAllByText("One")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("rejects a cursor cycle that returns to the first page anchor", async () => {
    const item = (id: string) => ({ item_kind: "knowledge_entry" as const, knowledge_id: id, display_title: id, lifecycle_status: "active" as const, source_change_key: `change:${id}`, extracted_at: "2026-08-13T00:00:00Z", relationship_count: 0, sort_key: id });
    const list = vi.fn(async (_project: string, _view: PlatformInformationPage["view"], query?: { cursor?: string | null }) => {
      if (query?.cursor === "cursor_a") return page("project_knowledge", [item("two")], "cursor_b");
      if (query?.cursor === "cursor_b") return page("project_knowledge", [item("three")], "cursor_a");
      return page("project_knowledge", [item("one")], "cursor_a");
    });
    render(<ProjectKnowledgeInformationPanel api={api({ listPlatformInformation: list })} projectId="prj_one" lang="en" />);

    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));

    expect(await screen.findByText("PLATFORM_INFORMATION_CURSOR_NON_PROGRESS")).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(3);
    expect(screen.getAllByRole("button", { name: /Open/ })).toHaveLength(3);
  });

  it("keeps ordinary list rendering bounded after repeated cursor pages", async () => {
    const list = vi.fn(async (_project: string, _view: PlatformInformationPage["view"], query?: { cursor?: string | null }) => {
      const pageNumber = query?.cursor === null || query?.cursor === undefined ? 0 : Number(query.cursor);
      const items = Array.from({ length: 50 }, (_, index) => ({
        item_kind: "knowledge_entry" as const,
        knowledge_id: `k-${pageNumber}-${index}`,
        display_title: `Knowledge ${pageNumber}-${index}`,
        lifecycle_status: "active" as const,
        source_change_key: `change:${pageNumber}-${index}`,
        extracted_at: "2026-08-13T00:00:00Z",
        relationship_count: 0,
        sort_key: `${pageNumber}-${index}`
      }));
      return page("project_knowledge", items, pageNumber < 20 ? String(pageNumber + 1) : null);
    });
    render(<ProjectKnowledgeInformationPanel api={api({ listPlatformInformation: list })} projectId="prj_one" lang="en" />);

    for (let index = 0; index < 12; index += 1) {
      const more = await screen.findByRole("button", { name: "Load more" });
      fireEvent.click(more);
      await waitFor(() => {
        const next = screen.queryByRole("button", { name: "Load more" });
        if (next === null || !next.hasAttribute("disabled")) return;
        throw new Error("load-more still pending");
      });
      if (screen.queryByRole("button", { name: "Load more" }) === null) break;
    }

    expect(screen.getAllByRole("button", { name: /Open/ })).toHaveLength(500);
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("does not expose raw detail failures in the rendered error description", async () => {
    const secret = "backend password should not render";
    render(<ProjectMaterialsInformationPanel api={api({
      listPlatformInformation: vi.fn(async () => page("project_materials", [{
        item_kind: "project_material", material_id: "m1", category: "rule", path: "RULE.md",
        blob_ref: { blob_hash: `sha256:${"a".repeat(64)}`, snapshot_version: "pv_1" }, source_branch_name: "main",
        source_commit_sha: "b".repeat(40), sort_key: "m1"
      }])),
      getPlatformInformationDetail: vi.fn(async () => { throw new Error(secret); })
    })} projectId="prj_one" lang="en" />);

    fireEvent.click(await screen.findByRole("button", { name: "Open RULE.md" }));
    expect((await screen.findAllByText("Could not load")).length).toBeGreaterThan(0);
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
  });

  it("clears a pending load-more busy state when the project identity changes", async () => {
    const pending = new Promise<PlatformInformationPage>(() => undefined);
    const item = (id: string) => ({ item_kind: "knowledge_entry" as const, knowledge_id: id, display_title: id, lifecycle_status: "active" as const, source_change_key: `change:${id}`, extracted_at: "2026-08-13T00:00:00Z", relationship_count: 0, sort_key: id });
    const list = vi.fn(async (project: string, _view: PlatformInformationPage["view"], query?: { cursor?: string | null }) => {
      if (project === "prj_old" && query?.cursor) return pending;
      return { ...page("project_knowledge", [item(project)], project === "prj_old" ? "cursor_old_1" : "cursor_new_1"), project_id: project };
    });
    const shared = api({ listPlatformInformation: list });
    const { rerender } = render(<ProjectKnowledgeInformationPanel api={shared} projectId="prj_old" lang="en" />);
    const oldMore = await screen.findByRole("button", { name: "Load more" });
    fireEvent.click(oldMore);
    expect(oldMore).toBeDisabled();
    rerender(<ProjectKnowledgeInformationPanel api={shared} projectId="prj_new" lang="en" />);
    expect(await screen.findByText("prj_new")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more" })).toBeEnabled();
  });

  it("requests a change detail only once per click and clears navigation across projects", async () => {
    const detail = vi.fn(async (project: string): Promise<PlatformInformationDetailResponse> => ({ schema_version: 1, contract_kind: "detail_response", view: "change_records", project_id: project, detail_id: "change-one", detail: { detail_kind: "change_record", document_refs: ["doc_one"], candidate_refs: [], archive_download_ref: null } }));
    const shared = api({ listPlatformInformation: vi.fn(async (project: string) => ({ ...page("change_records", [{ item_kind: "change_record", change_key: "change-one", title: project, archived_at: "2026-08-13T00:00:00Z", archive_status: "stored", knowledge_extraction_status: "ready", document_refs: ["doc_one"], candidate_count: 0, archive_download_ref: null, sort_key: project }]), project_id: project })), getPlatformInformationDetail: detail });
    const { rerender } = render(<ChangeRecordsInformationPanel api={shared} projectId="prj_one" lang="en" />);
    fireEvent.click(await screen.findByRole("button", { name: "Open prj_one" }));
    expect(await screen.findByRole("button", { name: "Open document doc_one" })).toBeInTheDocument();
    expect(detail).toHaveBeenCalledTimes(1);
    rerender(<ChangeRecordsInformationPanel api={shared} projectId="prj_two" lang="en" />);
    await screen.findByRole("button", { name: "Open prj_two" });
    expect(screen.queryByRole("button", { name: "Open document doc_one" })).not.toBeInTheDocument();
  });

  it("clears the previous change navigation as soon as another change starts and keeps it clear on failure", async () => {
    let rejectSecond!: (reason: unknown) => void;
    const second = new Promise<PlatformInformationDetailResponse>((_resolve, reject) => { rejectSecond = reject; });
    const detail = vi.fn(async (_project: string, _view: PlatformInformationPage["view"], id: string): Promise<PlatformInformationDetailResponse> => id === "one"
      ? { schema_version: 1, contract_kind: "detail_response", view: "change_records", project_id: "prj_one", detail_id: id, detail: { detail_kind: "change_record", document_refs: ["doc_old"], candidate_refs: [], archive_download_ref: null } }
      : second);
    render(<ChangeRecordsInformationPanel api={api({
      listPlatformInformation: vi.fn(async () => page("change_records", [
        { item_kind: "change_record", change_key: "one", title: "One", archived_at: "2026-08-13T00:00:00Z", archive_status: "stored", knowledge_extraction_status: "ready", document_refs: ["doc_old"], candidate_count: 0, archive_download_ref: null, sort_key: "one" },
        { item_kind: "change_record", change_key: "two", title: "Two", archived_at: "2026-08-12T00:00:00Z", archive_status: "failed", knowledge_extraction_status: "failed", document_refs: [], candidate_count: 0, archive_download_ref: null, sort_key: "two" }
      ])), getPlatformInformationDetail: detail
    })} projectId="prj_one" lang="en" />);
    fireEvent.click(await screen.findByRole("button", { name: "Open One" }));
    expect(await screen.findByRole("button", { name: "Open document doc_old" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Two" }));
    expect(screen.queryByRole("button", { name: "Open document doc_old" })).not.toBeInTheDocument();
    rejectSecond(new Error("raw backend secret"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open document doc_old" })).not.toBeInTheDocument());
    expect(screen.queryByText("raw backend secret")).not.toBeInTheDocument();
  });

  it("keeps loaded items and cursor after load-more failure, then retries that same cursor", async () => {
    let attempts = 0;
    const list = vi.fn(async (_project: string, _view: PlatformInformationPage["view"], query?: { cursor?: string | null }) => {
      if (!query?.cursor) return page("project_knowledge", [{ item_kind: "knowledge_entry", knowledge_id: "k1", display_title: "Kept", lifecycle_status: "active", source_change_key: "c1", extracted_at: "2026-08-13T00:00:00Z", relationship_count: 0, sort_key: "k1" }], "cursor_retry_page_1");
      attempts += 1;
      if (attempts === 1) throw new Error("raw transport detail");
      return page("project_knowledge", [{ item_kind: "knowledge_entry", knowledge_id: "k2", display_title: "Recovered", lifecycle_status: "stale", source_change_key: "c2", extracted_at: "2026-08-12T00:00:00Z", relationship_count: 0, sort_key: "k2" }]);
    });
    render(<ProjectKnowledgeInformationPanel api={api({ listPlatformInformation: list })} projectId="prj_one" lang="zh" />);
    fireEvent.click(await screen.findByRole("button", { name: "加载更多" }));
    const retry = await screen.findByRole("button", { name: "重试加载更多" });
    expect(screen.getByText("Kept")).toBeInTheDocument();
    expect(screen.queryByText("raw transport detail")).not.toBeInTheDocument();
    fireEvent.click(retry);
    expect(await screen.findByText("Recovered")).toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith("prj_one", "project_knowledge", { limit: 50, cursor: "cursor_retry_page_1" });
  });

  it("deduplicates the first page and localizes machine categories and lifecycle statuses", async () => {
    const material = { item_kind: "project_material" as const, material_id: "m1", category: "architecture_constraint" as const, path: "architecture.md", blob_ref: { blob_hash: `sha256:${"a".repeat(64)}`, snapshot_version: "pv_1" }, source_branch_name: "main", source_commit_sha: "b".repeat(40), sort_key: "m1" };
    const { rerender } = render(<ProjectMaterialsInformationPanel api={api({ listPlatformInformation: vi.fn(async () => page("project_materials", [material, material])) })} projectId="prj_one" lang="zh" />);
    expect(await screen.findAllByText("architecture.md")).toHaveLength(1);
    expect(screen.getByText("架构约束")).toBeInTheDocument();
    rerender(<ProjectKnowledgeInformationPanel api={api({ listPlatformInformation: vi.fn(async () => page("project_knowledge", [{ item_kind: "knowledge_entry", knowledge_id: "k1", display_title: "知识", lifecycle_status: "deprecated", source_change_key: "c1", extracted_at: "2026-08-13T00:00:00Z", relationship_count: 0, sort_key: "k1" }])) })} projectId="prj_one" lang="zh" />);
    expect(await screen.findByText("已弃用")).toBeInTheDocument();
    expect(screen.queryByText("deprecated")).not.toBeInTheDocument();
  });
});
