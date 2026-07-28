import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function readRepositoryFile(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}

describe("Hunter Platform archive status", () => {
  it("makes the archived state visible at every contributor entry point", () => {
    expect(readRepositoryFile("README.md")).toContain(
      "Hunter Platform is archived",
    );
    expect(readRepositoryFile("AGENTS.md")).toContain(
      "## Archived repository policy",
    );
    expect(readRepositoryFile("docs/README.md")).toContain(
      "ADR-0008",
    );
  });

  it("marks every top-level design document as historical", () => {
    const designDocuments = [
      "docs/01-product-vision.md",
      "docs/02-system-architecture.md",
      "docs/03-domain-model-and-state-machines.md",
      "docs/04-workflow-and-loop-semantics.md",
      "docs/05-client-information-architecture.md",
      "docs/06-runtime-provider-and-connectors.md",
      "docs/07-storage-security-and-remote-access.md",
      "docs/08-user-stories-and-acceptance.md",
      "docs/09-migration-and-roadmap.md",
      "docs/10-risk-register.md",
    ];

    for (const document of designDocuments) {
      expect(readRepositoryFile(document), document).toContain(
        "ADR-0008",
      );
    }
  });

  it("records the owner-approved, reversible architecture decision", () => {
    const adr = readRepositoryFile(
      "docs/adr/0008-archive-hunter-platform.md",
    );

    expect(adr).toContain("- Status: Accepted");
    expect(adr).toMatch(/GitHub\s+repository is archived read-only/u);
    expect(adr).toContain("does not delete source, Evidence, or history");
    expect(adr).toContain("does not automatically start Pi");
    expect(adr).toContain("## Reactivation gate");
  });

  it("has no active implementation plan", () => {
    const plans = readRepositoryFile("docs/plans/README.md");

    expect(plans).toContain(
      "## Archived — no active implementation plan",
    );
    expect(plans).not.toContain("## Active plan");
    expect(plans).toContain("Herdr replacement control-plane gate");
    expect(plans).toContain("Stopped Orca-first gate");
  });

  it("indexes the archive decision and preserves terminal evidence states", () => {
    expect(readRepositoryFile("docs/adr/README.md")).toContain(
      "0008 — Archive Hunter Platform",
    );

    const decisions = readRepositoryFile("docs/11-decision-summary.md");
    expect(decisions).toContain("## 2026-07-28 Hunter Platform archive");
    expect(decisions).toContain("Tasks 2–8 remain `NOT_RUN`");
    expect(decisions).toContain(
      "The `codex/windows-pc-daily-preview` branch is preserved",
    );
  });

  it("requires an explicit new decision before implementation resumes", () => {
    const instructions = readRepositoryFile("AGENTS.md");

    expect(instructions).toContain(
      "Do not begin implementation, Provider probes, releases, or scope expansion",
    );
    expect(instructions).toContain(
      "explicit owner decision that reactivates the repository",
    );
  });
});
