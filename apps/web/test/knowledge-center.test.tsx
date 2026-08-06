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

  it("searches globally and shows hits", async () => {
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
    const api = {
      searchSemanticDocuments,
      listProjects: vi.fn().mockResolvedValue([]),
      listKnowledgeEntries: vi.fn().mockResolvedValue([])
    } as unknown as HunterApi;

    wrap(<KnowledgeCenter api={api} />);
    fireEvent.change(screen.getByLabelText(/搜索决策|Search decisions/i), {
      target: { value: "scrypt" }
    });
    fireEvent.click(screen.getByRole("button", { name: /搜索|Search/i }));

    await waitFor(() => {
      expect(searchSemanticDocuments).toHaveBeenCalledWith("scrypt");
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
      listKnowledgeEntries,
      updateKnowledgeEntryStatus
    } as unknown as HunterApi;

    wrap(<KnowledgeCenter api={api} />);
    fireEvent.click(screen.getByRole("tab", { name: /Candidate|审核/i }));

    await waitFor(() => {
      expect(screen.getByText("Candidate decision")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /批准|Approve/i }));

    await waitFor(() => {
      expect(updateKnowledgeEntryStatus).toHaveBeenCalledWith("prj_demo", "kn-c1", "active");
    });
  });
});
