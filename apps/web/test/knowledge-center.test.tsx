// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KnowledgeCenter } from "../components/knowledge-center";
import type { HunterApi } from "../lib/api";
import { I18nProvider } from "../lib/i18n";

function wrap(ui: React.ReactElement) {
  return render(<I18nProvider>{ui}</I18nProvider>);
}

function semanticDocument(overrides: Record<string, unknown> = {}) {
  return {
    document_id: "doc_1",
    project_id: "prj_demo",
    artifact_id: "ingest",
    kind: "knowledge_entry",
    source_path: "entries/candidate/x.json",
    title: "Use scrypt",
    body: "## 密码存储\n\n- 使用 **scrypt**\n- 保留随机盐\n\n运行 `npm test` 验证。",
    metadata: { status: "active", entry_id: "kn-1" },
    content_sha256: "sha256:abc",
    ...overrides
  };
}

describe("KnowledgeCenter (P3)", () => {
  afterEach(() => {
    cleanup();
  });

  it("browses without a query and searches with a query", async () => {
    const searchSemanticDocuments = vi.fn().mockResolvedValue([
      { project_id: "prj_demo", document: semanticDocument() }
    ]);
    const listProjectSemanticKnowledge = vi.fn().mockResolvedValue({ items: [], total: 0, next_cursor: null });
    const api = {
      searchSemanticDocuments,
      listProjects: vi.fn().mockResolvedValue([
        { project_id: "prj_demo", display_name: "演示项目", role: "owner", created_at: "2026-01-01T00:00:00Z" }
      ]),
      listProjectSemanticKnowledge,
      listKnowledgeEntries: vi.fn().mockResolvedValue([]),
      getKnowledgeProjectionStatus: vi.fn().mockResolvedValue({ pending_count: 0, pending_capped: false })
    } as unknown as HunterApi;

    wrap(<KnowledgeCenter api={api} />);

    await waitFor(() => {
      expect(listProjectSemanticKnowledge).toHaveBeenCalled();
    });

    fireEvent.change(screen.getByLabelText(/搜索决策|Search decisions/i), {
      target: { value: "scrypt" }
    });
    fireEvent.click(screen.getByRole("button", { name: /搜索|Search/i }));

    await waitFor(() => {
      expect(searchSemanticDocuments).toHaveBeenCalledWith("scrypt", undefined);
      expect(screen.getAllByText("Use scrypt").length).toBeGreaterThan(0);
      expect(screen.getByRole("heading", { name: "密码存储", level: 2 })).toBeInTheDocument();
      expect(screen.getAllByText("演示项目").length).toBeGreaterThan(0);
      expect(screen.queryByText("prj_demo")).not.toBeInTheDocument();
      expect(screen.getByText("scrypt", { selector: "strong" })).toBeInTheDocument();
      expect(screen.getByText("npm test", { selector: "code" })).toBeInTheDocument();
    });
  });

  it("browses one summary page per project and lazily fetches the body on open", async () => {
    // next_cursor 非空也只取一页：首屏不再排空所有项目/所有页（审查报告·页面节）。
    const summaryOnly = semanticDocument({ body: "" });
    const fullDocument = semanticDocument();
    const listProjectSemanticKnowledge = vi.fn().mockResolvedValue({
      items: [summaryOnly], total: 5, next_cursor: "Mg"
    });
    const getProjectSemanticKnowledgeDocument = vi.fn().mockResolvedValue(fullDocument);
    const api = {
      listProjects: vi.fn().mockResolvedValue([
        { project_id: "prj_demo", display_name: "演示项目", role: "owner", created_at: "2026-01-01T00:00:00Z" }
      ]),
      listProjectSemanticKnowledge,
      getProjectSemanticKnowledgeDocument
    } as unknown as HunterApi;

    wrap(<KnowledgeCenter api={api} />);

    await waitFor(() => {
      expect(listProjectSemanticKnowledge).toHaveBeenCalledWith("prj_demo", { includeBody: false, cursor: null });
    });
    expect(listProjectSemanticKnowledge).toHaveBeenCalledTimes(1);

    // 选中首条后正文按 documentId 单取。
    await waitFor(() => {
      expect(getProjectSemanticKnowledgeDocument).toHaveBeenCalledWith("prj_demo", "doc_1");
    });
    expect(await screen.findByRole("heading", { name: "密码存储", level: 2 })).toBeInTheDocument();

    // 来源与历史：document_id / content_sha256 收进展开区。
    fireEvent.click(screen.getByText("来源与历史"));
    expect(await screen.findByText("sha256:abc")).toBeInTheDocument();
    expect(screen.getByText("doc_1", { selector: "code" })).toBeInTheDocument();
  });

  it("shows kind labels instead of status badges and marks only deprecated entries", async () => {
    const deprecated = semanticDocument({
      document_id: "doc_old",
      title: "旧方案：手动同步",
      metadata: { status: "deprecated", entry_id: "kn-old" }
    });
    const active = semanticDocument({ document_id: "doc_new", title: "新方案：自动同步" });
    const listProjectSemanticKnowledge = vi.fn().mockResolvedValue({
      items: [deprecated, active], total: 2, next_cursor: null
    });
    const api = {
      listProjects: vi.fn().mockResolvedValue([
        { project_id: "prj_demo", display_name: "演示项目", role: "owner", created_at: "2026-01-01T00:00:00Z" }
      ]),
      listProjectSemanticKnowledge,
      getProjectSemanticKnowledgeDocument: vi.fn().mockResolvedValue(active)
    } as unknown as HunterApi;

    wrap(<KnowledgeCenter api={api} />);

    expect((await screen.findAllByText("旧方案：手动同步")).length).toBeGreaterThan(0);
    // FIXED/active 历史条目不再用"生效"式徽标装饰（审查报告：无重新核验
    // 证据不显示"当前有效"）；仅 deprecated 显示"已停用"。
    expect(screen.getAllByText(/知识条目/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/已停用/).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain("active");
    expect(document.body.textContent).not.toContain("生效");
  });

  it("preserves the API method receiver while browsing", async () => {
    const api = {
      browseCalls: 0,
      searchSemanticDocuments: vi.fn(),
      listProjects: vi.fn().mockResolvedValue([
        { project_id: "prj_demo", display_name: "Demo", role: "owner", created_at: "2026-01-01T00:00:00Z" }
      ]),
      async listProjectSemanticKnowledge(this: { browseCalls: number }) {
        this.browseCalls += 1;
        return { items: [], total: 0, next_cursor: null };
      }
    } as unknown as HunterApi & { browseCalls: number };

    wrap(<KnowledgeCenter api={api} />);

    await waitFor(() => {
      expect(api.browseCalls).toBeGreaterThan(0);
    });
    expect(api.listProjects).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("无法连接到服务器。")).toBeNull();
  });

  it("does not render manual candidate review controls", async () => {
    const listProjectSemanticKnowledge = vi.fn().mockResolvedValue({ items: [], total: 0, next_cursor: null });
    const api = {
      searchSemanticDocuments: vi.fn(),
      listProjects: vi.fn().mockResolvedValue([
        { project_id: "prj_demo", display_name: "Demo", role: "owner", created_at: "2026-01-01T00:00:00Z" }
      ]),
      listProjectSemanticKnowledge
    } as unknown as HunterApi;

    wrap(<KnowledgeCenter api={api} />);

    await waitFor(() => {
      expect(listProjectSemanticKnowledge).toHaveBeenCalled();
    });
    expect(screen.queryByRole("tab", { name: /Candidate|候选审核/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /批准|Approve/i })).toBeNull();
  });

  it("explains the empty state in user-facing Chinese", async () => {
    const api = {
      searchSemanticDocuments: vi.fn(),
      listProjects: vi.fn().mockResolvedValue([]),
      listProjectSemanticKnowledge: vi.fn().mockResolvedValue({ items: [], total: 0, next_cursor: null })
    } as unknown as HunterApi;

    wrap(<KnowledgeCenter api={api} />);

    expect(await screen.findByText("还没有可阅读的知识")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\bingest\b|\bpush\b|purge|投影|语义库/i);
  });
});
