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
          body: "Hash passwords with scrypt.",
          metadata: { status: "active", entry_id: "kn-1" },
          content_sha256: "sha256:abc"
        }
      }
    ]);
    const listProjectSemanticKnowledge = vi.fn().mockResolvedValue([]);
    const api = {
      searchSemanticDocuments,
      listProjects: vi.fn().mockResolvedValue([
        { project_id: "prj_demo", display_name: "Demo", role: "owner", created_at: "2026-01-01T00:00:00Z" }
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
      expect(screen.getByText("Hash passwords with scrypt.")).toBeTruthy();
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
    expect(screen.queryByText("无法连接到服务器。")).toBeNull();
  });

  it("does not render manual candidate review controls", async () => {
    const listProjectSemanticKnowledge = vi.fn().mockResolvedValue([]);
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
});
