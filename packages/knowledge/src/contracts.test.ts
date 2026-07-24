import {
  EvidenceIdSchema,
  ProjectIdSchema,
  RequirementRevisionIdSchema,
  RunIdSchema,
  canonicalSha256,
} from "@hunter/domain";
import { describe, expect, it } from "vitest";

import {
  KnowledgeEntrySchema,
  KnowledgeSelectionReceiptSchema,
  VerifiedArchiveReceiptSchema,
} from "./index.js";

const projectId = ProjectIdSchema.parse("prj_knowledge_a");
const otherProjectId = ProjectIdSchema.parse("prj_knowledge_b");
const runId = RunIdSchema.parse("run_knowledge_a");
const manifestHash = "a".repeat(64);
const receipt = {
  receiptSchemaVersion: 1,
  projectId,
  runId,
  outcome: "failed",
  manifestSchemaVersion: 2,
  manifestHash,
  manifestRef: `cas:sha256:${manifestHash}`,
  verifiedAt: "2026-07-23T01:02:03.000Z",
} as const;

describe("VerifiedArchiveReceipt", () => {
  it("accepts a strictly scoped content-addressed verification receipt", () => {
    expect(VerifiedArchiveReceiptSchema.parse(receipt)).toEqual(receipt);
  });

  it.each([
    ["missing Project scope", { ...receipt, projectId: undefined }],
    ["local manifest path", { ...receipt, manifestPath: "C:\\private\\manifest.json" }],
    ["raw manifest", { ...receipt, manifest: { privatePrompt: "secret" } }],
    ["provider-private identity", { ...receipt, orcaSessionId: "private-session" }],
    ["unknown manifest schema", { ...receipt, manifestSchemaVersion: 1 }],
    [
      "non-content-addressed reference",
      { ...receipt, manifestRef: "file:///private/manifest.json" },
    ],
  ])("rejects %s", (_label, candidate) => {
    expect(VerifiedArchiveReceiptSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects a content reference whose digest differs from the verified manifest", () => {
    expect(
      VerifiedArchiveReceiptSchema.safeParse({
        ...receipt,
        manifestRef: `cas:sha256:${"b".repeat(64)}`,
      }).success,
    ).toBe(false);
  });
});

describe("KnowledgeEntry", () => {
  it.each([
    {
      schemaVersion: 1,
      entryId: "kne_authoritative_knowledge",
      level: "authoritative",
      status: "active",
      source: {
        type: "requirement_revision",
        projectId,
        requirementRevisionId: RequirementRevisionIdSchema.parse("rrv_knowledge_a"),
      },
      scope: { projectId },
      summary: "Approved project rule.",
      body: "Mobile approval is required.",
    },
    {
      schemaVersion: 1,
      entryId: "kne_experiential_knowledge",
      level: "experiential",
      status: "active",
      confidence: {
        level: "high",
        rationale: "Supported by verification evidence.",
      },
      invalidationConditions: [
        {
          condition: "The supporting Evidence is withdrawn or superseded.",
        },
      ],
      source: {
        type: "evidence",
        projectId,
        evidenceId: EvidenceIdSchema.parse("evd_knowledge_a"),
        contentHash: "b".repeat(64),
      },
      scope: { projectId },
      summary: "Verified implementation constraint.",
      body: "The repository requires an isolated writer.",
    },
    {
      schemaVersion: 1,
      entryId: "kne_historical_knowledge",
      level: "historical",
      status: "active",
      source: {
        type: "archive",
        projectId,
        runId,
        outcome: "failed",
        manifestSchemaVersion: 2,
        manifestHash,
        manifestRef: `cas:sha256:${manifestHash}`,
      },
      scope: { projectId },
      summary: "Archived failed Run.",
      body: `Archived failed Run ${runId}.`,
    },
  ])("accepts a strict $level entry with typed source identity", (entry) => {
    expect(KnowledgeEntrySchema.parse(entry)).toEqual(entry);
  });

  it.each([
    ["missing Project scope", { scope: {} }],
    ["empty Project scope", { scope: { projectId: "" } }],
    ["cross-project source scope", { scope: { projectId: otherProjectId } }],
    ["raw private data", { rawPrivateData: { prompt: "secret" } }],
    ["untyped source identity", { source: { type: "archive", id: runId } }],
  ])("rejects %s", (_label, override) => {
    const candidate = {
      schemaVersion: 1,
      entryId: "kne_historical_knowledge",
      level: "historical",
      status: "active",
      source: {
        type: "archive",
        projectId,
        runId,
        outcome: "failed",
        manifestSchemaVersion: 2,
        manifestHash,
        manifestRef: `cas:sha256:${manifestHash}`,
      },
      scope: { projectId },
      summary: "Archived failed Run.",
      body: `Archived failed Run ${runId}.`,
      ...override,
    };
    expect(KnowledgeEntrySchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects a historical source whose content reference digest differs from its manifest hash", () => {
    expect(
      KnowledgeEntrySchema.safeParse({
        schemaVersion: 1,
        entryId: "kne_historical_mismatch",
        level: "historical",
        status: "active",
        source: {
          type: "archive",
          projectId,
          runId,
          outcome: "failed",
          manifestSchemaVersion: 2,
          manifestHash,
          manifestRef: `cas:sha256:${"d".repeat(64)}`,
        },
        scope: { projectId },
        summary: "Archived failed Run.",
        body: `Archived failed Run ${runId}.`,
      }).success,
    ).toBe(false);
  });

  it.each([
    ["structured Confidence", {}],
    [
      "invalidation conditions",
      {
        confidence: {
          level: "high",
          rationale: "Supported by verification evidence.",
        },
      },
    ],
  ])("rejects experiential knowledge missing %s", (_label, fields) => {
    expect(
      KnowledgeEntrySchema.safeParse({
        schemaVersion: 1,
        entryId: "kne_experiential_required_fields",
        level: "experiential",
        status: "active",
        source: {
          type: "evidence",
          projectId,
          evidenceId: EvidenceIdSchema.parse("evd_knowledge_required"),
          contentHash: "e".repeat(64),
        },
        scope: { projectId },
        summary: "Verified implementation constraint.",
        body: "The repository requires an isolated writer.",
        ...fields,
      }).success,
    ).toBe(false);
  });
});

describe("KnowledgeSelectionReceipt", () => {
  it("exports a strict runtime schema for persisted Handoff selection receipts", async () => {
    const knowledgeModule = await import("./index.js") as Record<string, unknown>;

    expect(knowledgeModule.KnowledgeSelectionReceiptSchema).toBeDefined();
  });

  it("accepts only a canonical hash-bound provider-neutral receipt", () => {
    const receiptBase = {
      schemaVersion: 1 as const,
      projectId,
      selectedEntryIds: ["kne_receipt_selected"],
      candidates: [{
        entryId: "kne_receipt_selected",
        scope: { projectId },
        source: {
          type: "requirement_revision" as const,
          referenceId: "rrv_receipt_selected",
        },
        decision: "selected" as const,
        reason: "selected_by_policy" as const,
        authority: "authoritative" as const,
        confidence: null,
        validity: "active" as const,
        contentHash: "f".repeat(64),
      }],
      requiresExplicitSelection: false,
      conflicts: [],
      budget: {
        maxItems: 4,
        maxBytes: 16_384,
        maxTokens: 16_384,
        usedItems: 1,
        usedBytes: 64,
        usedTokens: 64,
        truncated: false,
        omittedEntryIds: [],
      },
    };
    const candidate = {
      ...receiptBase,
      selectionHash: canonicalSha256(receiptBase),
    };

    expect(KnowledgeSelectionReceiptSchema.parse(candidate)).toEqual(candidate);
    expect(KnowledgeSelectionReceiptSchema.safeParse({
      ...candidate,
      selectionHash: "0".repeat(64),
    }).success).toBe(false);
    expect(KnowledgeSelectionReceiptSchema.safeParse({
      ...candidate,
      runtimeProviderId: "private",
    }).success).toBe(false);
    for (const invalidBase of [
      {
        ...receiptBase,
        candidates: receiptBase.candidates.map((item) => ({
          ...item,
          scope: { projectId: otherProjectId },
        })),
      },
      {
        ...receiptBase,
        selectedEntryIds: [],
      },
      {
        ...receiptBase,
        budget: {
          ...receiptBase.budget,
          usedItems: 0,
        },
      },
    ]) {
      expect(KnowledgeSelectionReceiptSchema.safeParse({
        ...invalidBase,
        selectionHash: canonicalSha256(invalidBase),
      }).success).toBe(false);
    }

    const contradictoryConflictBase = {
      ...receiptBase,
      candidates: [{
        ...receiptBase.candidates[0]!,
        reason: "explicit_conflict_selection" as const,
      }, {
        ...receiptBase.candidates[0]!,
        entryId: "kne_receipt_other",
        source: {
          type: "requirement_revision" as const,
          referenceId: "rrv_receipt_other",
        },
        decision: "excluded" as const,
        reason: "conflict_not_selected" as const,
        contentHash: "e".repeat(64),
      }],
      conflicts: [{
        claimHash: "d".repeat(64),
        entryIds: ["kne_receipt_selected", "kne_receipt_other"],
        resolution: "explicit_selection" as const,
        selectedEntryId: "kne_receipt_other",
      }],
    };
    expect(KnowledgeSelectionReceiptSchema.safeParse({
      ...contradictoryConflictBase,
      selectionHash: canonicalSha256(contradictoryConflictBase),
    }).success).toBe(false);
  });
});
