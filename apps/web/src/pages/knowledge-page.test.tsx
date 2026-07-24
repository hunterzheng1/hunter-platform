// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import {
  KnowledgeEntryIdSchema,
  ProjectIdSchema,
  RequirementRevisionIdSchema,
  RunIdSchema,
} from "@hunter/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KnowledgePage } from "./knowledge-page.js";

afterEach(cleanup);

describe("KnowledgePage", () => {
  it("shows scoped active and historical knowledge with explicit provenance", async () => {
    const api = {
      getKnowledge: vi.fn(async () => ({
        projectId: ProjectIdSchema.parse("prj_knowledge_page"),
        entries: [{
          schemaVersion: 1 as const,
          entryId: KnowledgeEntryIdSchema.parse("kne_requirement_page"),
          level: "authoritative" as const,
          status: "active" as const,
          scope: { projectId: ProjectIdSchema.parse("prj_knowledge_page") },
          summary: "Mobile approval",
          body: "Resume the same Run after approval.",
          source: {
            type: "requirement_revision" as const,
            projectId: ProjectIdSchema.parse("prj_knowledge_page"),
            requirementRevisionId: RequirementRevisionIdSchema.parse(
              "rrv_knowledge_page",
            ),
          },
        }, {
          schemaVersion: 1 as const,
          entryId: KnowledgeEntryIdSchema.parse("kne_knowledge_page"),
          level: "historical" as const,
          status: "active" as const,
          scope: { projectId: ProjectIdSchema.parse("prj_knowledge_page") },
          summary: "Archived succeeded Run.",
          body: "Verified manifest provenance.",
          source: {
            type: "archive" as const,
            projectId: ProjectIdSchema.parse("prj_knowledge_page"),
            runId: RunIdSchema.parse("run_knowledge_page"),
            outcome: "succeeded" as const,
            manifestSchemaVersion: 2 as const,
            manifestHash: "a".repeat(64),
            manifestRef: `cas:sha256:${"a".repeat(64)}`,
          },
        }],
      })),
    };

    render(
      <KnowledgePage
        projectId="prj_knowledge_page"
        api={api}
        onBack={() => undefined}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Knowledge" })).not.toBeNull();
    expect(screen.getByText("authoritative · active")).not.toBeNull();
    expect(screen.getByText("requirement_revision · rrv_knowledge_page")).not.toBeNull();
    expect(screen.getByText("Archived succeeded Run.")).not.toBeNull();
    expect(screen.getByText("historical · active")).not.toBeNull();
    expect(screen.getByText("archive · run_knowledge_page")).not.toBeNull();
    expect(screen.getByText(`sha256:${"a".repeat(64)}`)).not.toBeNull();
    expect(api.getKnowledge).toHaveBeenCalledWith("prj_knowledge_page", true);
  });
});
