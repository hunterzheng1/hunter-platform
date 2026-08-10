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

describe("KnowledgeCenter (P3)", () => {
  afterEach(() => {
    cleanup();
  });

  it("browses without a query and searches with a query", async () => {
    const searchSemanticDocuments = vi.fn().mockResolvedValue([
      {
        project_id: "prj_demo",
        document: {
          document_id: "doc_1",
          project_id: "prj_demo",
          artifact_id: "ingest",
          kind: "knowledge_entry",
          source_path: "entries/candidate/x.json",
          title: "Use scrypt",
          body: "## 密码存储\n\n- 使用 **scrypt**\n- 保留随机盐\n\n运行 `npm test` 验证。",
          metadata: { status: "active", entry_id: "kn-1" },
          content_sha256: "sha256:abc"
        }
      }
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

    expect(await screen.findByText("还没有可搜索的知识")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\bingest\b|\bpush\b|purge|投影|语义库/i);
  });
});
