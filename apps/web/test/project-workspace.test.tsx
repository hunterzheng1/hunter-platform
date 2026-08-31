// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PlatformInformationPage } from "@hunter-harness/contracts";
import { ProjectWorkspace } from "../components/project-workspace";
import { ToastProvider } from "../components/ui/Toast";
import type { ArtifactManifestModel, HunterApi, ProjectFileContent, ProjectFileMetadata } from "../lib/api";

const sha = (character: string) => "sha256:" + character.repeat(64);
const files: ProjectFileMetadata[] = [
  {
    path: ".harness/knowledge/architecture.md",
    file_kind: "user_editable",
    content_sha256: sha("b"),
    size_bytes: 12,
    project_version: "pv_one",
    updated_at: "2026-06-20T00:00:00Z"
  },
  {
    path: ".harness/state/local/status.json",
    file_kind: "internal_state",
    content_sha256: sha("c"),
    size_bytes: 2,
    project_version: "pv_one",
    updated_at: "2026-06-20T00:00:00Z"
  }
];

afterEach(cleanup);

function api(overrides: Partial<HunterApi> = {}): HunterApi {
  return {
    getDashboardOverview: vi.fn(async () => { throw new Error("not used"); }),
    listProjects: vi.fn(async () => []),
    getProject: vi.fn(async () => ({
      project_id: "prj_one",
      display_name: "Payments",
      role: "owner" as const,
      latest_project_version: "pv_one",
      latest_artifact_id: "art_one",
      current_file_count: 2,
      updated_at: "2026-06-20T00:00:00Z",
      created_at: "2026-06-20T00:00:00Z",
      request_id: "req_one"
    })),
    listProjectFiles: vi.fn(async () => ({
      project_id: "prj_one",
      project_version: "pv_one",
      total: 2,
      items: files
    })),
    getProjectFileContent: vi.fn(async (_projectId, path) => ({
      ...(files.find((file) => file.path === path) ?? files[0] as ProjectFileMetadata),
      project_id: "prj_one",
      content: path.endsWith(".md") ? "# Architecture" : "{}"
    })),
    listProjectProposals: vi.fn(async () => []),
    listAllProposals: vi.fn(async () => []),
    listProjectArtifacts: vi.fn(async () => [{
      artifact_id: "art_one",
      project_id: "prj_one",
      project_version: "pv_one",
      base_project_version: null,
      proposal_id: "prp_one",
      changed_item_count: 2,
      manifest_sha256: sha("a"),
      created_at: "2026-06-20T00:00:00Z"
    }]),
    listAllArtifacts: vi.fn(async () => []),
    getArtifactManifest: vi.fn(async () => { throw new Error("browser artifact replay must not run"); }),
    getArtifactText: vi.fn(async () => { throw new Error("browser artifact replay must not run"); }),
    createProjectFileProposal: vi.fn(async () => ({
      proposal_id: "prp_new",
      status: "approved" as const,
      artifact_id: "art_two",
      received_files: 1
    })),
    getProposal: vi.fn(async () => { throw new Error("not used"); }),
    ...overrides
  };
}

describe("ProjectWorkspace", () => {
  it("falls back to current project files and artifact versions when branch projections are empty", async () => {
    const listProjectFiles = vi.fn(async () => ({ project_id: "prj_one", project_version: "pv_one", total: 2, items: files }));
    const listProjectArtifacts = vi.fn(async () => [{
      artifact_id: "art_one", project_id: "prj_one", project_version: "pv_one",
      base_project_version: null, proposal_id: "prp_one", changed_item_count: 2,
      manifest_sha256: sha("a"), created_at: "2026-06-20T00:00:00Z"
    }]);
    render(<ProjectWorkspace api={api({
      listPlatformInformation: vi.fn(async (): Promise<PlatformInformationPage> => ({
        schema_version: 1,
        contract_kind: "page" as const,
        view: "branch_files" as const,
        project_id: "prj_one",
        page_state: "empty" as const,
        sort: "uploaded_at_desc_snapshot_version_asc" as const,
        items: [],
        next_cursor: null,
        failures: []
      })),
      listProjectFiles,
      listProjectArtifacts
    })} projectId="prj_one" />);

    fireEvent.click(await screen.findByRole("tab", { name: "分支文件" }));
    expect(await screen.findByRole("button", { name: ".harness/knowledge/architecture.md" })).toBeInTheDocument();
    expect(listProjectFiles).toHaveBeenCalledOnce();
    expect(listProjectArtifacts).toHaveBeenCalledOnce();
  });

  it("presents archived branches with localized names, prioritized file groups, and rendered Markdown", async () => {
    const archiveFiles: ProjectFileMetadata[] = [
      { ...files[0] as ProjectFileMetadata, path: ".harness/archive/kb-config-upload-binding/spec/kb-config-upload-binding-design.md" },
      { ...files[1] as ProjectFileMetadata, path: ".harness/archive/kb-config-upload-binding/plans/kb-config-upload-binding-plan.md" },
      { ...files[0] as ProjectFileMetadata, path: ".harness/archive/kb-config-upload-binding/reports/final/summary-data.json" },
      { ...files[0] as ProjectFileMetadata, path: ".harness/archive/kb-config-upload-binding/change-context.json" },
      { ...files[0] as ProjectFileMetadata, path: ".harness/archive/required-indicators-raw-config/notes.md" }
    ];
    render(<ProjectWorkspace api={api({
      listPlatformInformation: vi.fn(async (): Promise<PlatformInformationPage> => ({
        schema_version: 1, contract_kind: "page", view: "branch_files", project_id: "prj_one",
        page_state: "empty", sort: "uploaded_at_desc_snapshot_version_asc", items: [], next_cursor: null, failures: []
      })),
      listProjectFiles: vi.fn(async () => ({ project_id: "prj_one", project_version: "pv_one", total: 5, items: archiveFiles })),
      listProjectRuns: vi.fn(async () => ({
        items: [{
          run_id: "run_required", project_id: "prj_one", change_key: "required-indicators-raw-config",
          title: "所需指标返回指标原始配置与指标ID", run_status: "completed", connection_status: "offline",
          sync_completeness: "complete", current_phase: null, started_at: "2026-06-20T00:00:00Z",
          ended_at: "2026-06-20T01:00:00Z", last_event_at: "2026-06-20T01:00:00Z",
          last_heartbeat_at: null, server_cursor: 10
        }], total: 1, next_cursor: null
      })),
      getProjectFileContent: vi.fn(async (_projectId, path) => ({
        ...(archiveFiles.find((file) => file.path === path) as ProjectFileMetadata),
        project_id: "prj_one",
        content: path.endsWith("summary-data.json")
          ? JSON.stringify({
              schemaVersion: "2.0", changeName: "kb-config-upload-binding", businessGoal: "支持配置上传绑定",
              finalStatus: "passed", releaseEligible: true, riskTier: "low",
              verification: { tests: { passed: 18, failed: 0 }, build: "passed" },
              changedFiles: Array.from({ length: 130 }, (_, index) => index === 0 ? "apps/server/src/config.ts" : `files/change-${index}.ts`),
              knownRisks: []
            })
          : path.endsWith("change-context.json")
            ? JSON.stringify({ schemaVersion: 1, displayTitle: "知识库配置上传绑定", ownership: { owner: "team-platform" } })
            : path.endsWith(".md")
              ? "# 设计方案\n\n- 支持配置上传\n- 保留审计记录\n\n![远程示意图](https://example.invalid/tracker.png)\n\n[相关文档](./related.md)"
              : "{}"
      }))
    })} projectId="prj_one" />);

    fireEvent.click(await screen.findByRole("tab", { name: "分支文件" }));
    const primaryBranch = await screen.findByRole("button", { name: /知识库配置上传绑定.*kb-config-upload-binding/ });
    expect(primaryBranch).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /所需指标返回指标原始配置与指标ID.*required-indicators-raw-config/ })).toBeInTheDocument();
    expect(screen.queryByText(/requiredindicatorsraw配置/u)).not.toBeInTheDocument();
    expect(screen.queryByText("已归档")).not.toBeInTheDocument();

    expect(await screen.findByRole("heading", { name: "设计方案" })).toBeInTheDocument();
    expect(screen.getByText("支持配置上传").closest("li")).not.toBeNull();
    expect(screen.queryByText("plan.md")).not.toBeInTheDocument();
    expect(screen.queryByText("summary-data.json")).not.toBeInTheDocument();
    expect(screen.queryByText("change-context.json")).not.toBeInTheDocument();
    expect(screen.queryByText("spec/kb-config-upload-binding-design.md")).not.toBeInTheDocument();
    expect(screen.queryByText("# 设计方案")).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "远程示意图" })).not.toBeInTheDocument();
    expect(screen.getByText(/^远程图片未自动加载/u)).toBeInTheDocument();
    expect(screen.getByText("相关文档").closest("a")).toBeNull();

    expect(screen.queryByText(".harness")).not.toBeInTheDocument();
    expect(screen.queryByText("archive")).not.toBeInTheDocument();

    const css = readFileSync(resolve(process.cwd(), "apps/web/app/globals.css"), "utf8");
    expect(css).toMatch(/\.archive-branch-design-browser\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/u);
    expect(css).toMatch(/\.archive-markdown\s*\{/u);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.archive-branches-shell/u);
  });

  it("does not download oversized archived JSON in the browser", async () => {
    const oversized: ProjectFileMetadata = {
      ...(files[0] as ProjectFileMetadata),
      path: ".harness/archive/large-report/change-context.json",
      size_bytes: 2 * 1024 * 1024 + 1
    };
    const getProjectFileContent = vi.fn(async () => ({ ...oversized, project_id: "prj_one", content: "{}" }));
    render(<ProjectWorkspace api={api({
      listPlatformInformation: vi.fn(async (): Promise<PlatformInformationPage> => ({
        schema_version: 1, contract_kind: "page", view: "branch_files", project_id: "prj_one",
        page_state: "empty", sort: "uploaded_at_desc_snapshot_version_asc", items: [], next_cursor: null, failures: []
      })),
      listProjectFiles: vi.fn(async () => ({ project_id: "prj_one", project_version: "pv_one", total: 1, items: [oversized] })),
      getProjectFileContent
    })} projectId="prj_one" />);

    fireEvent.click(await screen.findByRole("tab", { name: "分支文件" }));
    expect(await screen.findByText("该分支没有 design.md。")).toBeInTheDocument();
    expect(getProjectFileContent).not.toHaveBeenCalled();
  });

  it("keeps bounded platform projections authoritative when a branch snapshot exists", async () => {
    const listProjectFiles = vi.fn(async () => ({ project_id: "prj_one", project_version: "pv_one", total: 2, items: files }));
    const listProjectArtifacts = vi.fn(async () => []);
    render(<ProjectWorkspace api={api({
      listPlatformInformation: vi.fn(async (): Promise<PlatformInformationPage> => ({
        schema_version: 1,
        contract_kind: "page" as const,
        view: "branch_files" as const,
        project_id: "prj_one",
        page_state: "ready" as const,
        sort: "uploaded_at_desc_snapshot_version_asc" as const,
        items: [{
          item_kind: "branch_snapshot", branch_name: "feature", snapshot_version: "pv_one",
          commit_sha: "e".repeat(40), uploaded_at: "2026-08-13T00:00:00Z",
          file_count: 2, changed_file_count: 1, sort_key: "feature"
        }],
        next_cursor: null,
        failures: []
      })),
      listProjectFiles,
      listProjectArtifacts
    })} projectId="prj_one" />);

    fireEvent.click(await screen.findByRole("tab", { name: "分支文件" }));
    expect(await screen.findByText("feature")).toBeInTheDocument();
    expect(listProjectFiles).toHaveBeenCalledOnce();
    expect(listProjectArtifacts).not.toHaveBeenCalled();
  });

  it("prefers the archived-branch reader and hides mixed non-archive files even when a branch snapshot exists", async () => {
    const archiveFile: ProjectFileMetadata = {
      ...(files[0] as ProjectFileMetadata),
      path: ".harness/archive/usage-stats-platform-support/spec/usage-stats-platform-support-design.md"
    };
    const nonArchiveFile: ProjectFileMetadata = {
      ...(files[1] as ProjectFileMetadata),
      path: ".harness/codebase/map/ARCHITECTURE.md"
    };
    render(<ProjectWorkspace api={api({
      listPlatformInformation: vi.fn(async (): Promise<PlatformInformationPage> => ({
        schema_version: 1, contract_kind: "page", view: "branch_files", project_id: "prj_one",
        page_state: "ready", sort: "uploaded_at_desc_snapshot_version_asc",
        items: [{
          item_kind: "branch_snapshot", branch_name: "master", snapshot_version: "pv_remote",
          commit_sha: "e".repeat(40), uploaded_at: "2026-08-20T00:00:00Z",
          file_count: 12, changed_file_count: 1, sort_key: "master"
        }],
        next_cursor: null, failures: []
      })),
      listProjectFiles: vi.fn(async () => ({
        project_id: "prj_one", project_version: "pv_legacy", total: 2,
        items: [archiveFile, nonArchiveFile]
      }))
    })} projectId="prj_one" />);

    fireEvent.click(await screen.findByRole("tab", { name: "分支文件" }));
    expect(await screen.findByRole("button", { name: /^打开分支 .*usage-stats-platform-support/u })).toBeInTheDocument();
    expect(screen.queryByText("master")).not.toBeInTheDocument();
    expect(screen.queryByText("ARCHITECTURE.md")).not.toBeInTheDocument();
    expect(await screen.findByText("design.md")).toBeInTheDocument();
  });

  it("does not let stale file content overwrite a newer project selection", async () => {
    let releaseOld!: (value: ProjectFileContent) => void;
    const oldContent = new Promise<ProjectFileContent>((resolve) => { releaseOld = resolve; });
    const file = (project: string): ProjectFileMetadata => ({
      path: "README.md",
      file_kind: "user_editable",
      content_sha256: sha(project === "prj_old" ? "b" : "c"),
      size_bytes: 12,
      project_version: `${project}_version`,
      updated_at: "2026-06-20T00:00:00Z"
    });
    const shared = api({
      getProject: vi.fn(async (projectId: string) => ({
        project_id: projectId,
        display_name: projectId,
        role: "owner" as const,
        latest_project_version: "pv_one",
        latest_artifact_id: "art_one",
        current_file_count: 1,
        updated_at: "2026-06-20T00:00:00Z",
        created_at: "2026-06-20T00:00:00Z",
        request_id: `req_${projectId}`
      })),
      listProjectFiles: vi.fn(async (projectId: string) => ({ project_id: projectId, project_version: `${projectId}_version`, total: 1, items: [file(projectId)] })),
      getProjectFileContent: vi.fn(async (projectId: string): Promise<ProjectFileContent> => projectId === "prj_old" ? oldContent : { ...file(projectId), project_id: projectId, content: "NEW CONTENT" })
    });
    const { rerender } = render(<ProjectWorkspace api={shared} projectId="prj_old" />);
    fireEvent.click(await screen.findByRole("tab", { name: "分支文件" }));
    fireEvent.click(await screen.findByRole("button", { name: "README.md" }));
    expect(await screen.findByText(/正在加载文件内容/)).toBeInTheDocument();

    rerender(<ProjectWorkspace api={shared} projectId="prj_new" />);
    fireEvent.click(await screen.findByRole("tab", { name: "分支文件" }));
    fireEvent.click(await screen.findByRole("button", { name: "README.md" }));
    expect(await screen.findByText("NEW CONTENT")).toBeInTheDocument();
    releaseOld({ ...file("prj_old"), project_id: "prj_old", content: "STALE CONTENT" });
    await waitFor(() => expect(screen.queryByText("STALE CONTENT")).not.toBeInTheDocument());
  });

  it("uses the canonical workspace navigation without inventing data for pending query pages", async () => {
    render(<ProjectWorkspace api={api()} projectId="prj_one" />);

    expect((await screen.findAllByRole("tab")).map((tab) => tab.textContent)).toEqual([
      "分支监控",
      "分支文件",
      "项目资料",
      "项目知识",
      "变更记录",
      "版本记录",
      "API 密钥"
    ]);

    fireEvent.click(screen.getByRole("tab", { name: "项目资料" }));
    expect(screen.getByRole("status")).toHaveAttribute("data-state", "processing");
    expect(screen.getByText("项目资料查询正在接入")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "变更记录" }));
    expect(screen.getByText("变更记录查询正在接入")).toBeInTheDocument();
  });

  it("keeps project knowledge mounted after its first visit", async () => {
    const listProjectSemanticKnowledge = vi.fn(async () => ({ items: [], total: 0, next_cursor: null }));
    const semanticApi = api({
      getProjectSemanticOverview: vi.fn(async () => ({
        project_id: "prj_one",
        artifact_id: null,
        counts: { documents: 0, knowledge: 0, rules: 0, changes: 0, architecture: 0, agent_instructions: 0, edges: 0 }
      })),
      listProjectSemanticKnowledge,
      listProjectSemanticRules: vi.fn(async () => []),
      listProjectSemanticChanges: vi.fn(async () => ({ items: [], total: 0, next_cursor: null })),
      getKnowledgeProjectionStatus: vi.fn(async () => ({ pending_count: 0, pending_capped: false })),
      getProjectSemanticGraph: vi.fn(async () => ({
        nodes: [], edges: [], focus_document_id: null, relation_status: "no_relations" as const, indexed_documents: 0
      })),
      searchSemanticDocuments: vi.fn(async () => [])
    });

    render(
      <ToastProvider>
        <ProjectWorkspace api={semanticApi} projectId="prj_one" />
      </ToastProvider>
    );

    fireEvent.click(await screen.findByRole("tab", { name: "项目知识" }));
    expect(await screen.findByText("还没有知识条目")).toBeInTheDocument();
    expect(listProjectSemanticKnowledge).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("tab", { name: "分支文件" }));
    fireEvent.click(screen.getByRole("tab", { name: "项目知识" }));
    expect(screen.getByText("还没有知识条目")).toBeInTheDocument();
    expect(listProjectSemanticKnowledge).toHaveBeenCalledOnce();
  });

  it("loads only file metadata, then saves an edit directly", async () => {
    const getProjectFileContent = vi.fn(async (_projectId: string, path: string) => ({
      ...(files.find((file) => file.path === path) ?? files[0] as ProjectFileMetadata),
      project_id: "prj_one",
      content: "# Architecture"
    }));
    const createProjectFileProposal = vi.fn(async () => ({
      proposal_id: "prp_new",
      status: "approved" as const,
      artifact_id: "art_two",
      received_files: 1
    }));
    render(
      <ToastProvider>
        <ProjectWorkspace api={api({ getProjectFileContent, createProjectFileProposal })} projectId="prj_one" />
      </ToastProvider>
    );

    fireEvent.click(await screen.findByRole("tab", { name: "分支文件" }));
    expect(getProjectFileContent).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: ".harness/knowledge/architecture.md" }));
    expect(await screen.findByText("# Architecture")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("文件内容"), { target: { value: "# Revised architecture" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(createProjectFileProposal).toHaveBeenCalledWith(expect.objectContaining({
      action: "modify",
      path: ".harness/knowledge/architecture.md",
      content: "# Revised architecture",
      baseProjectVersion: "pv_one",
      baseArtifactId: "art_one",
      baseManifestHash: sha("a")
    })));
    expect(await screen.findByText(/文件已保存并生成新版本/)).toBeInTheDocument();
  });

  it("keeps system paths visible but read-only", async () => {
    render(<ProjectWorkspace api={api()} projectId="prj_one" />);

    fireEvent.click(await screen.findByRole("tab", { name: "分支文件" }));
    fireEvent.click(await screen.findByRole("button", { name: ".harness/state/local/status.json" }));
    expect((await screen.findAllByText("系统只读")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();
  });

  it("keeps legacy tree and action controls keyboard-sized and exposes filter selection", async () => {
    const css = readFileSync(resolve(process.cwd(), "apps/web/app/globals.css"), "utf8");
    render(<ProjectWorkspace api={api()} projectId="prj_one" />);

    fireEvent.click(await screen.findByRole("tab", { name: "分支文件" }));
    const allFiles = screen.getByRole("button", { name: "全部文件" });
    const editable = screen.getByRole("button", { name: "可编辑" });
    expect(allFiles).toHaveAttribute("aria-pressed", "true");
    expect(editable).toHaveAttribute("aria-pressed", "false");
    expect(allFiles).toHaveAttribute("data-touch-target", "true");
    expect(screen.getByRole("button", { name: "新建文件" })).toHaveAttribute("data-touch-target", "true");
    expect(screen.getByRole("button", { name: "全部折叠" })).toHaveAttribute("data-touch-target", "true");
    expect((await screen.findByText(".harness")).closest("summary")).toHaveAttribute("data-touch-target", "true");
    expect(screen.getByRole("button", { name: ".harness/state/local/status.json" })).toHaveAttribute("data-touch-target", "true");
    fireEvent.click(await screen.findByRole("button", { name: ".harness/knowledge/architecture.md" }));
    expect(await screen.findByRole("button", { name: "编辑" })).toHaveAttribute("data-touch-target", "true");
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    for (const button of screen.getAllByRole("button", { name: "取消" })) expect(button).toHaveAttribute("data-touch-target", "true");
    expect(screen.getByRole("button", { name: "保存" })).toHaveAttribute("data-touch-target", "true");
    expect(css).toMatch(/\.project-tree summary,\s*\.project-tree button\s*\{[^{}]*min-height:\s*44px;/u);
    expect(css).toMatch(/\.project-tree-toolbar \.text-button\s*\{[^{}]*min-height:\s*44px;/u);
    expect(css).toMatch(/\.project-file-filters button\s*\{[^{}]*min-height:\s*44px;/u);
    expect(css).toMatch(/\.project-file-actions button\s*\{[^{}]*min-height:\s*44px;/u);
    expect(css).toMatch(/\.project-file-editor \.icon-button\s*\{[^{}]*min-height:\s*44px;/u);
    expect(css).toMatch(/\.project-file-editor \.actions button\s*\{[^{}]*min-height:\s*44px;/u);
  });

  it("does not reuse legacy content after a same-project version changes", async () => {
    let revision = 1;
    let releaseRefresh!: (value: ProjectFileContent) => void;
    const metadata = (): ProjectFileMetadata => ({
      path: ".harness/knowledge/README.md",
      file_kind: "user_editable",
      content_sha256: sha(revision === 1 ? "b" : "c"),
      size_bytes: 12,
      project_version: revision === 1 ? "pv_one" : "pv_two",
      updated_at: "2026-06-20T00:00:00Z"
    });
    const getProjectFileContent = vi.fn(async (): Promise<ProjectFileContent> => {
      const current = metadata();
      if (revision === 1) return { ...current, project_id: "prj_one", content: "OLD CONTENT" };
      return new Promise((resolve) => { releaseRefresh = (value) => resolve(value); });
    });
    const shared = api({
      getProject: vi.fn(async () => ({
        project_id: "prj_one", display_name: "Payments", role: "owner" as const,
        latest_project_version: revision === 1 ? "pv_one" : "pv_two", latest_artifact_id: "art_one",
        current_file_count: 1, updated_at: "2026-06-20T00:00:00Z", created_at: "2026-06-20T00:00:00Z", request_id: "req_one"
      })),
      listProjectFiles: vi.fn(async () => ({ project_id: "prj_one", project_version: metadata().project_version, total: 2, items: [metadata(), { ...(files[1] as ProjectFileMetadata), project_version: metadata().project_version }] })),
      getProjectFileContent,
      createProjectFileProposal: vi.fn(async () => {
        revision = 2;
        return { proposal_id: "prp_new", status: "approved" as const, artifact_id: "art_two", received_files: 1 };
      })
    });
    render(<ToastProvider><ProjectWorkspace api={shared} projectId="prj_one" /></ToastProvider>);
    fireEvent.click(await screen.findByRole("tab", { name: "分支文件" }));
    fireEvent.click(await screen.findByRole("button", { name: ".harness/knowledge/README.md" }));
    expect(await screen.findByText("OLD CONTENT")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("文件内容"), { target: { value: "NEW CONTENT" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(shared.listProjectFiles).toHaveBeenCalledTimes(2));
    const otherFile = screen.getByRole("button", { name: ".harness/state/local/status.json" });
    expect(otherFile).toBeDisabled();
    fireEvent.click(otherFile);
    expect(screen.getByRole("button", { name: ".harness/knowledge/README.md" })).toHaveClass("selected");
    expect(screen.getByRole("button", { name: "新建文件" })).toBeDisabled();
    expect(screen.queryByText("OLD CONTENT")).not.toBeInTheDocument();
    releaseRefresh({ ...metadata(), project_id: "prj_one", content: "NEW CONTENT" });
    expect(await screen.findByText("NEW CONTENT")).toBeInTheDocument();
  });

  it("keeps edit and rename disabled until lazy content is available", async () => {
    let release: (() => void) | undefined;
    const getProjectFileContent = vi.fn((_projectId: string, path: string) =>
      new Promise<ProjectFileContent>((resolve) => {
        release = () => resolve({
          ...(files.find((file) => file.path === path) ?? files[0] as ProjectFileMetadata),
          project_id: "prj_one",
          content: "# Architecture"
        });
      })
    );
    render(<ProjectWorkspace api={api({ getProjectFileContent })} projectId="prj_one" />);

    fireEvent.click(await screen.findByRole("tab", { name: "分支文件" }));
    fireEvent.click(await screen.findByRole("button", { name: ".harness/knowledge/architecture.md" }));
    expect(screen.getByRole("button", { name: "编辑" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重命名" })).toBeDisabled();

    release?.();
    expect(await screen.findByText("# Architecture")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "重命名" })).toBeEnabled();
  });

  it("keeps directories collapsed by default until expanded", async () => {
    render(<ProjectWorkspace api={api()} projectId="prj_one" />);
    fireEvent.click(await screen.findByRole("tab", { name: "分支文件" }));

    const harness = await screen.findByText(".harness");
    const details = harness.closest("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByText("2 项")).toBeInTheDocument();

    fireEvent.click(harness);
    await waitFor(() => expect(details).toHaveAttribute("open"));
    expect(screen.getByText("knowledge")).toBeInTheDocument();
  });

  it("shows human version bases and paginates dense change sets", async () => {
    const manyFiles: ArtifactManifestModel["files"] = Array.from({ length: 45 }, (_, index) => {
      const path = `.harness/knowledge/entries/active/item-${String(index).padStart(2, "0")}.json`;
      if (index % 2 === 0) {
        return {
          operation: "add" as const,
          path,
          file_kind: "user_editable" as const,
          content_sha256: sha("d"),
          size_bytes: 40
        };
      }
      return {
        operation: "modify" as const,
        path,
        file_kind: "user_editable" as const,
        base_content_sha256: sha("b"),
        content_sha256: sha("c"),
        size_bytes: 12
      };
    });
    const getArtifactManifest = vi.fn(async () => ({
      schema_version: 1 as const,
      project_id: "prj_one",
      project_version: "pv_two",
      artifact_id: "art_two",
      manifest_sha256: sha("a"),
      files: manyFiles
    }));
    render(<ProjectWorkspace api={api({
      listProjectArtifacts: vi.fn(async () => [
        {
          artifact_id: "art_two",
          project_id: "prj_one",
          project_version: "pv_two",
          base_project_version: "pv_one",
          proposal_id: "prp_two",
          changed_item_count: 45,
          manifest_sha256: sha("a"),
          created_at: "2026-06-21T00:00:00Z"
        },
        {
          artifact_id: "art_one",
          project_id: "prj_one",
          project_version: "pv_one",
          base_project_version: null,
          proposal_id: "prp_one",
          changed_item_count: 2,
          manifest_sha256: sha("a"),
          created_at: "2026-06-20T00:00:00Z"
        }
      ]),
      getArtifactManifest
    })} projectId="prj_one" />);

    fireEvent.click(await screen.findByRole("tab", { name: "版本记录" }));
    expect(await screen.findByText(/基于版本 1/)).toBeInTheDocument();
    expect(screen.queryByText(/pv_/)).not.toBeInTheDocument();

    const viewButton = screen.getAllByRole("button", { name: "查看变更" })[0];
    if (viewButton === undefined) throw new Error("expected view-changes button");
    fireEvent.click(viewButton);
    expect(await screen.findByText("第 1/3 页 · 45 条")).toBeInTheDocument();
    expect(screen.getByText(".harness/knowledge/entries/active/item-00.json")).toBeInTheDocument();
    expect(screen.queryByText(".harness/knowledge/entries/active/item-20.json")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByText("第 2/3 页 · 45 条")).toBeInTheDocument();
    expect(screen.getByText(".harness/knowledge/entries/active/item-20.json")).toBeInTheDocument();
    expect(getArtifactManifest).toHaveBeenCalledWith("art_two");
  });

  it("renders an empty version history with normal heading hierarchy", async () => {
    render(<ProjectWorkspace api={api({
      listProjectArtifacts: vi.fn(async () => [])
    })} projectId="prj_one" />);

    fireEvent.click(await screen.findByRole("tab", { name: "版本记录" }));

    expect(await screen.findByRole("heading", { name: "版本记录", level: 2 })).toBeInTheDocument();
    expect(screen.getByText("每次保存或同步文件后，平台都会保留一个版本。展开版本可查看具体改动。")).toBeInTheDocument();
    expect(screen.getByText("还没有版本记录。保存或同步第一个文件后，版本会显示在这里。")).toBeInTheDocument();
  });
});
