// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { SemanticDocument, SemanticEdge } from "@hunter-harness/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectSemanticPanels } from "../components/project-semantic-panels";
import type { HunterApi } from "../lib/api";

afterEach(cleanup);

function makeKnowledge(count: number): SemanticDocument[] {
  return Array.from({ length: count }, (_, index) => {
    const status = (["active", "candidate", "superseded", "archived"] as const)[index % 4] ?? "active";
    return {
      document_id: `sem_${index}`,
      project_id: "prj_one",
      artifact_id: "art_one",
      kind: "knowledge_entry",
      source_path: `.harness/knowledge/entries/${status}/item-${index}.json`,
      title: `Knowledge item ${String(index).padStart(2, "0")}`,
      body: `Body for item ${index}`,
      metadata: { status },
      content_sha256: "sha256:" + "a".repeat(64)
    };
  });
}

function makeArchivedChange(id: string, title: string): SemanticDocument {
  return {
    document_id: `sem_change_${id}`,
    project_id: "prj_one",
    artifact_id: "art_one",
    kind: "archive_record",
    source_path: `.harness/archive/${id}/reports/final/summary-data.json`,
    title: id,
    body: `# ${title}\n\n## 变更结果\n\n- 状态：OK`,
    metadata: {
      source_archive: id,
      business_goal: title,
      archive_status: "durable",
      knowledge_status: "ready"
    },
    content_sha256: "sha256:" + "e".repeat(64)
  };
}

describe("ProjectSemanticPanels", () => {
  it("opens on the searchable knowledge library and loads only a focused graph on demand", async () => {
    const knowledgeList = makeKnowledge(1);
    const knowledge = knowledgeList[0];
    if (knowledge === undefined) throw new Error("expected knowledge fixture");
    knowledge.document_id = "sem_one";
    knowledge.title = "Architecture boundary";
    knowledge.body = "Keep the boundary explicit.";
    knowledge.metadata = { status: "active" };
    knowledge.source_path = ".harness/knowledge/entries/active/one.json";

    const getProjectSemanticGraph = vi.fn(async () => ({
      nodes: [knowledge],
      edges: [],
      focus_document_id: knowledge.document_id,
      relation_status: "no_relations" as const,
      indexed_documents: 1
    }));
    const listProjectSemanticRules = vi.fn(async () => []);
    const listProjectSemanticChanges = vi.fn(async () => ({ items: [], total: 0, next_cursor: null }));
    const architecture: SemanticDocument = {
      document_id: "sem_architecture",
      project_id: "prj_one",
      artifact_id: "art_one",
      kind: "architecture_document",
      source_path: ".harness/codebase/map/ARCHITECTURE.md",
      title: "系统架构",
      body: "# 系统架构\n\n模块之间通过稳定接口协作。",
      metadata: { map_role: "architecture" },
      content_sha256: "sha256:" + "b".repeat(64)
    };
    const listProjectSemanticArchitecture = vi.fn(async () => [architecture]);
    const api = {
      getProjectSemanticOverview: vi.fn(async () => ({
        project_id: "prj_one",
        artifact_id: "art_one",
        counts: { documents: 1, knowledge: 1, rules: 0, changes: 0, agent_instructions: 0, edges: 0 }
      })),
      listProjectSemanticKnowledge: vi.fn(async () => ({ items: [knowledge], total: 1, next_cursor: null })),
      listProjectSemanticRules,
      listProjectSemanticChanges,
      listProjectSemanticArchitecture,
      getProjectSemanticGraph,
      searchSemanticDocuments: vi.fn(async () => [{ document: knowledge, project_id: "prj_one" }])
    } as unknown as HunterApi;

    render(<ProjectSemanticPanels api={api} projectId="prj_one" />);
    expect(await screen.findByRole("heading", { name: "Architecture boundary" })).toBeInTheDocument();
    expect(listProjectSemanticRules).not.toHaveBeenCalled();
    expect(listProjectSemanticChanges).not.toHaveBeenCalled();
    expect(listProjectSemanticArchitecture).not.toHaveBeenCalled();
    expect(getProjectSemanticGraph).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: "项目规则" }));
    await waitFor(() => expect(listProjectSemanticRules).toHaveBeenCalledOnce());
    expect(listProjectSemanticChanges).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: "项目架构" }));
    await waitFor(() => expect(listProjectSemanticArchitecture).toHaveBeenCalledOnce());
    expect((await screen.findAllByRole("heading", { name: "系统架构" })).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("tab", { name: "变更记录" }));
    await waitFor(() => expect(listProjectSemanticChanges).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("tab", { name: "知识关系" }));
    await waitFor(() => expect(getProjectSemanticGraph).toHaveBeenCalledWith("prj_one", "sem_one"));
    expect(await screen.findByText("暂未发现可展示的知识关系")).toBeInTheDocument();
  });

  it("paginates dense knowledge lists and filters by status", async () => {
    const knowledge = makeKnowledge(52);
    const api = {
      getProjectSemanticOverview: vi.fn(async () => ({
        project_id: "prj_one",
        artifact_id: "art_one",
        counts: { documents: 52, knowledge: 52, rules: 0, changes: 0, agent_instructions: 0, edges: 0 }
      })),
      listProjectSemanticKnowledge: vi.fn(async () => ({ items: knowledge, total: knowledge.length, next_cursor: null })),
      listProjectSemanticRules: vi.fn(async () => []),
      listProjectSemanticChanges: vi.fn(async () => ({ items: [], total: 0, next_cursor: null })),
      getProjectSemanticGraph: vi.fn(),
      searchSemanticDocuments: vi.fn(async () => [])
    } as unknown as HunterApi;

    render(<ProjectSemanticPanels api={api} projectId="prj_one" />);
    expect(await screen.findByText("第 1/3 页 · 52 条")).toBeInTheDocument();
    const listPane = document.querySelector(".knowledge-list") as HTMLElement;
    expect(within(listPane).getByText("Knowledge item 00")).toBeInTheDocument();
    expect(within(listPane).queryByText("Knowledge item 25")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => {
      expect(screen.getByText(/第 2\/3 页 · 52 条/)).toBeInTheDocument();
      expect(within(listPane).getByText("Knowledge item 25")).toBeInTheDocument();
    });
    expect(within(listPane).queryByText("Knowledge item 00")).not.toBeInTheDocument();

    const statusToolbar = screen.getByRole("toolbar", { name: /按状态筛选|Filter by status/i });
    fireEvent.click(within(statusToolbar).getByRole("button", { name: /^(候选|candidate)$/i }));
    await waitFor(() => {
      expect(screen.getByText(/第 1\/1 页 · 13 条/)).toBeInTheDocument();
      expect(within(listPane).getAllByRole("button")).toHaveLength(13);
    });

    fireEvent.click(screen.getByRole("tab", { name: "项目规则" }));
    expect(screen.queryByRole("toolbar", { name: "按状态筛选" })).not.toBeInTheDocument();
  });

  it("shows a focus neighbourhood workbench with kind filters", async () => {
    const knowledge = makeKnowledge(4);
    const focus = knowledge[0];
    const superseded = knowledge[1];
    const conflict = knowledge[2];
    const shared = knowledge[3];
    if (focus === undefined || superseded === undefined || conflict === undefined || shared === undefined) {
      throw new Error("expected knowledge fixtures");
    }
    focus.title = "Reuse LlmClient";
    superseded.title = "Old client guidance";
    conflict.title = "Conflicting shell rule";
    shared.title = "Shared scope note";

    const edges: SemanticEdge[] = [
      {
        edge_id: "e1",
        project_id: "prj_one",
        artifact_id: "art_one",
        from_document_id: superseded.document_id,
        to_document_id: focus.document_id,
        kind: "supersedes",
        metadata: {}
      },
      {
        edge_id: "e2",
        project_id: "prj_one",
        artifact_id: "art_one",
        from_document_id: focus.document_id,
        to_document_id: conflict.document_id,
        kind: "conflicts_with",
        metadata: {}
      },
      {
        edge_id: "e3",
        project_id: "prj_one",
        artifact_id: "art_one",
        from_document_id: focus.document_id,
        to_document_id: shared.document_id,
        kind: "shared_scope",
        metadata: {}
      }
    ];

    const getProjectSemanticGraph = vi.fn(async (_projectId: string, focusDocumentId?: string) => {
      const focusId = focusDocumentId ?? focus.document_id;
      const neighbourhood = edges.filter((edge) =>
        edge.from_document_id === focusId || edge.to_document_id === focusId
      );
      const keep = new Set([focusId, ...neighbourhood.flatMap((edge) => [edge.from_document_id, edge.to_document_id])]);
      return {
        nodes: knowledge.filter((item) => keep.has(item.document_id)),
        edges: neighbourhood,
        focus_document_id: focusId,
        relation_status: "ready" as const,
        indexed_documents: knowledge.length
      };
    });

    const api = {
      getProjectSemanticOverview: vi.fn(async () => ({
        project_id: "prj_one",
        artifact_id: "art_one",
        counts: { documents: 4, knowledge: 4, rules: 0, changes: 0, agent_instructions: 0, edges: 3 }
      })),
      listProjectSemanticKnowledge: vi.fn(async () => ({ items: knowledge, total: knowledge.length, next_cursor: null })),
      listProjectSemanticRules: vi.fn(async () => []),
      listProjectSemanticChanges: vi.fn(async () => ({ items: [], total: 0, next_cursor: null })),
      getProjectSemanticGraph,
      searchSemanticDocuments: vi.fn(async () => [])
    } as unknown as HunterApi;

    render(<ProjectSemanticPanels api={api} projectId="prj_one" />);
    await screen.findByRole("heading", { name: "Reuse LlmClient" });
    fireEvent.click(screen.getByRole("tab", { name: "知识关系" }));

    expect(await screen.findByRole("heading", { name: "直接关系" })).toBeInTheDocument();
    const neighbourhood = document.querySelector(".relation-neighbourhood") as HTMLElement;
    expect(within(neighbourhood).getByText("取代 · 1")).toBeInTheDocument();
    expect(within(neighbourhood).getByText("冲突 · 1")).toBeInTheDocument();
    expect(within(neighbourhood).getByText("共享源码 · 1")).toBeInTheDocument();
    expect(within(neighbourhood).getByText("Old client guidance")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "冲突" }));
    expect(within(neighbourhood).queryByText("Old client guidance")).not.toBeInTheDocument();
    expect(within(neighbourhood).getByText("Conflicting shell rule")).toBeInTheDocument();

    fireEvent.click(within(neighbourhood).getByRole("button", { name: "设为中心" }));
    await waitFor(() => expect(getProjectSemanticGraph).toHaveBeenCalledWith("prj_one", conflict.document_id));
  });

  it("keeps the previous relation workbench visible while refetching a new center", async () => {
    const knowledge = makeKnowledge(3);
    const focus = knowledge[0];
    const other = knowledge[1];
    if (focus === undefined || other === undefined) throw new Error("expected knowledge fixtures");
    focus.title = "Center A";
    other.title = "Center B";

    let release!: (value: unknown) => void;
    const gate = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const getProjectSemanticGraph = vi.fn(async (_projectId: string, focusDocumentId?: string) => {
      calls += 1;
      const focusId = focusDocumentId ?? focus.document_id;
      if (calls > 1) await gate;
      return {
        nodes: knowledge.filter((item) => item.document_id === focusId || item.document_id === other.document_id),
        edges: [{
          edge_id: "e1",
          project_id: "prj_one",
          artifact_id: "art_one",
          from_document_id: focus.document_id,
          to_document_id: other.document_id,
          kind: "shared_scope" as const,
          metadata: {}
        }],
        focus_document_id: focusId,
        relation_status: "ready" as const,
        indexed_documents: knowledge.length
      };
    });

    const api = {
      getProjectSemanticOverview: vi.fn(async () => ({
        project_id: "prj_one",
        artifact_id: "art_one",
        counts: { documents: 3, knowledge: 3, rules: 0, changes: 0, agent_instructions: 0, edges: 1 }
      })),
      listProjectSemanticKnowledge: vi.fn(async () => ({ items: knowledge, total: knowledge.length, next_cursor: null })),
      listProjectSemanticRules: vi.fn(async () => []),
      listProjectSemanticChanges: vi.fn(async () => ({ items: [], total: 0, next_cursor: null })),
      getProjectSemanticGraph,
      searchSemanticDocuments: vi.fn(async () => [])
    } as unknown as HunterApi;

    render(<ProjectSemanticPanels api={api} projectId="prj_one" />);
    await screen.findByRole("heading", { name: "Center A" });
    fireEvent.click(screen.getByRole("tab", { name: "知识关系" }));
    expect(await screen.findByRole("heading", { name: "直接关系" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "设为中心" }));
    expect(await screen.findByText("正在更新关系…")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "直接关系" })).toBeInTheDocument();
    expect(screen.queryByText("正在加载项目知识…")).not.toBeInTheDocument();

    release(undefined);
    await waitFor(() => expect(getProjectSemanticGraph).toHaveBeenCalledWith("prj_one", other.document_id));
    await waitFor(() => expect(screen.queryByText("正在更新关系…")).not.toBeInTheDocument());
  });

  it("uses plain Chinese guidance for an empty project knowledge library", async () => {
    const api = {
      getProjectSemanticOverview: vi.fn(async () => ({
        project_id: "prj_one",
        artifact_id: null,
        counts: { documents: 0, knowledge: 0, rules: 0, changes: 0, agent_instructions: 0, edges: 0 }
      })),
      listProjectSemanticKnowledge: vi.fn(async () => ({ items: [], total: 0, next_cursor: null })),
      listProjectSemanticRules: vi.fn(async () => []),
      listProjectSemanticChanges: vi.fn(async () => ({ items: [], total: 0, next_cursor: null })),
      getProjectSemanticGraph: vi.fn(async () => ({ nodes: [], edges: [], focus_document_id: null, relation_status: "no_relations", indexed_documents: 0 })),
      searchSemanticDocuments: vi.fn(async () => [])
    } as unknown as HunterApi;

    render(<ProjectSemanticPanels api={api} projectId="prj_one" />);

    expect(await screen.findByText("还没有知识条目")).toBeInTheDocument();
    expect(screen.getByText(/知识库只展示明确提交到知识入库流程的内容/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\bingest\b|\bpush\b|purge|投影|语义库/i);
  });

  it("groups archived plans under one readable change record and shows remote durability", async () => {
    const summary: SemanticDocument = {
      document_id: "sem_summary",
      project_id: "prj_one",
      artifact_id: "art_one",
      kind: "archive_record",
      source_path: ".harness/archive/readable-change/reports/final/summary-data.json",
      title: "readable-change",
      body: "# 可读的归档总结\n\n## 变更结果\n\n- 目标：让变更记录便于快速阅读。\n- 最终状态：OK\n",
      metadata: {
        source_archive: "readable-change",
        business_goal: "让变更记录便于快速阅读。",
        final_status: "OK",
        files_changed: 6,
        additions: 42,
        deletions: 8,
        archive_status: "durable",
        knowledge_status: "ready",
        archive_uploaded_at: "2026-08-12T10:00:00.000Z"
      },
      content_sha256: "sha256:" + "c".repeat(64)
    };
    const plan: SemanticDocument = {
      document_id: "sem_plan",
      project_id: "prj_one",
      artifact_id: "art_one",
      kind: "change_document",
      source_path: ".harness/archive/readable-change/plans/implementation.md",
      title: "实施计划",
      body: "# 实施计划\n\n按三个步骤完成。",
      metadata: { source_archive: "readable-change", archive_role: "plan" },
      content_sha256: "sha256:" + "d".repeat(64)
    };
    const api = {
      getProjectSemanticOverview: vi.fn(async () => ({
        project_id: "prj_one",
        artifact_id: "art_one",
        counts: { documents: 2, knowledge: 0, rules: 0, changes: 2, architecture: 0, agent_instructions: 0, edges: 0 }
      })),
      listProjectSemanticKnowledge: vi.fn(async () => ({ items: [], total: 0, next_cursor: null })),
      listProjectSemanticRules: vi.fn(async () => []),
      listProjectSemanticArchitecture: vi.fn(async () => []),
      listProjectSemanticChanges: vi.fn(async () => ({ items: [summary, plan], total: 2, next_cursor: null })),
      getProjectSemanticGraph: vi.fn(),
      searchSemanticDocuments: vi.fn(async () => [])
    } as unknown as HunterApi;

    render(<ProjectSemanticPanels api={api} projectId="prj_one" />);
    await screen.findByText("还没有知识条目");
    fireEvent.click(screen.getByRole("tab", { name: "变更记录" }));

    expect(await screen.findByRole("heading", { name: "可读的归档总结" })).toBeInTheDocument();
    expect(screen.getByText("远端归档已保存")).toBeInTheDocument();
    expect(screen.getByText("知识索引已就绪")).toBeInTheDocument();
    expect(screen.getByText("6 个文件")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /实施计划/ })).toBeInTheDocument();
    expect(screen.queryByText(/archive_id|package_sha256/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /实施计划/ }));
    expect(await screen.findByRole("heading", { name: "实施计划" })).toBeInTheDocument();
    expect(screen.getByText("按三个步骤完成。")).toBeInTheDocument();
  });

  it("loads later change-history pages without hiding older records", async () => {
    const latest = makeArchivedChange("latest-change", "最近一次变更");
    const older = makeArchivedChange("older-change", "更早的变更");
    const listProjectSemanticChanges = vi.fn(async (
      _projectId: string,
      options?: { limit?: number; cursor?: string | null }
    ) => options?.cursor === "next-page"
      ? { items: [older], total: 2, next_cursor: null }
      : { items: [latest], total: 2, next_cursor: "next-page" });
    const api = {
      getProjectSemanticOverview: vi.fn(async () => ({
        project_id: "prj_one",
        artifact_id: "art_one",
        counts: { documents: 2, knowledge: 0, rules: 0, changes: 2, architecture: 0, agent_instructions: 0, edges: 0 }
      })),
      listProjectSemanticKnowledge: vi.fn(async () => ({ items: [], total: 0, next_cursor: null })),
      listProjectSemanticRules: vi.fn(async () => []),
      listProjectSemanticArchitecture: vi.fn(async () => []),
      listProjectSemanticChanges,
      getProjectSemanticGraph: vi.fn(),
      searchSemanticDocuments: vi.fn(async () => [])
    } as unknown as HunterApi;

    render(<ProjectSemanticPanels api={api} projectId="prj_one" />);
    await screen.findByText("还没有知识条目");
    fireEvent.click(screen.getByRole("tab", { name: "变更记录" }));

    expect(await screen.findByRole("heading", { name: "最近一次变更" })).toBeInTheDocument();
    expect(screen.getByText("已加载 1 / 2 份文档")).toBeInTheDocument();
    expect(screen.queryByText("更早的变更")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "加载更多变更" }));

    await waitFor(() => expect(listProjectSemanticChanges).toHaveBeenCalledWith("prj_one", {
      limit: 50,
      cursor: "next-page"
    }));
    expect(await screen.findByText("更早的变更")).toBeInTheDocument();
    expect(screen.getByText("已加载 2 / 2 份文档")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "加载更多变更" })).not.toBeInTheDocument();
  });
});
