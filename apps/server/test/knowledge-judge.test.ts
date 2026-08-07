import { describe, expect, it } from "vitest";

import {
  adjudicateKnowledgeEntry,
  calculateConfidence,
  shouldAutoPromote
} from "../src/semantic/knowledge-judge.js";

function baseEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "kn-decision-1",
    projectId: "local",
    type: "decision",
    status: "candidate",
    title: "Prefer PowerShell for Chinese paths",
    summary: "Always use PowerShell for Chinese paths.",
    body: "Canonical invariant: prefer PowerShell on Windows for Chinese paths.",
    keywords: ["shell"],
    source: {
      archive: "2026-08-01-shell-policy",
      finalStatus: "OK"
    },
    scope: { sourceFiles: ["scripts/run.ps1"] },
    lifecycle: {
      confidence: "high",
      supersedes: [],
      supersededBy: null,
      conflictsWith: [],
      staleReasons: []
    },
    ...overrides
  };
}

describe("knowledge judge heuristics (S4)", () => {
  it("scores high-confidence decision entries above auto-promote threshold", () => {
    const score = calculateConfidence(baseEntry());
    expect(score.score).toBeGreaterThanOrEqual(0.82);
    expect(score.level).toBe("high");
  });

  it("auto-promotes eligible candidates to active", () => {
    const judged = adjudicateKnowledgeEntry(baseEntry());
    expect(judged.promoted).toBe(true);
    expect(judged.status).toBe("active");
    expect(judged.payload.status).toBe("active");
  });

  it("keeps low-score candidates as candidate", () => {
    const entry = baseEntry({
      type: "risk",
      lifecycle: {
        confidence: "low",
        supersedes: [],
        supersededBy: null,
        conflictsWith: [],
        staleReasons: []
      },
      source: { archive: "2020-01-01-old", finalStatus: "FAILED" },
      scope: { sourceFiles: [] },
      body: "maybe something",
      title: "weak",
      summary: "weak"
    });
    const confidence = calculateConfidence(entry);
    entry.confidence = confidence;
    expect(shouldAutoPromote(entry)).toBe(false);
    expect(adjudicateKnowledgeEntry(entry).status).toBe("candidate");
  });

  it("does not overwrite deprecated status during adjudication", () => {
    const judged = adjudicateKnowledgeEntry(baseEntry({ status: "deprecated" }));
    expect(judged.status).toBe("deprecated");
    expect(judged.promoted).toBe(false);
  });
});
