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

  it("lists candidates and approves them", async () => {
    const updateKnowledgeEntryStatus = vi.fn().mockResolvedValue({
      entry_id: "kn-c1",
      status: "active",
      updated_at: "2026-08-06T00:00:00Z"
    });
    const listKnowledgeEntries = vi.fn()
      .mockResolvedValueOnce([
        {
          entry_id: "kn-c1",
          status: "candidate",
          content_sha256: "sha256:1",
          payload: { title: "Candidate decision", summary: "Needs review" },
          updated_at: "2026-08-06T00:00:00Z",
          projected_at: null
        }
      ])
      .mockResolvedValue([]);
    const api = {
      searchSemanticDocuments: vi.fn(),
      listProjects: vi.fn().mockResolvedValue([
        { project_id: "prj_demo", display_name: "Demo", role: "owner", created_at: "2026-01-01T00:00:00Z" }
      ]),
      listProjectSemanticKnowledge: vi.fn().mockResolvedValue([]),
      listKnowledgeEntries,
      getKnowledgeProjectionStatus: vi.fn().mockResolvedValue({ pending_count: 2, pending_capped: false }),
      updateKnowledgeEntryStatus
    } as unknown as HunterApi;

    wrap(<KnowledgeCenter api={api} />);
    fireEvent.click(screen.getByRole("tab", { name: /Candidate|候选审核/i }));

    await waitFor(() => {
      expect(screen.getByText("Candidate decision")).toBeTruthy();
      expect(screen.getByText(/待投影 2|2 knowledge entries pending/i)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /批准|Approve/i }));

    await waitFor(() => {
      expect(updateKnowledgeEntryStatus).toHaveBeenCalledWith("prj_demo", "kn-c1", "active");
    });
  });
});
