import {
  EvidenceIdSchema,
  ProjectIdSchema,
  RequirementRevisionIdSchema,
  RunIdSchema,
} from "@hunter/domain";
import { describe, expect, it } from "vitest";

import {
  KnowledgeEntrySchema,
  KNOWLEDGE_HANDOFF_MIN_CONTENT_BYTES,
  KnowledgeResolver,
  renderKnowledgeHandoff,
  type KnowledgeEntry,
  type KnowledgeReadStore,
} from "./index.js";

const projectId = ProjectIdSchema.parse("prj_resolver_a");
const otherProjectId = ProjectIdSchema.parse("prj_resolver_b");

function authoritative(
  suffix: string,
  status: KnowledgeEntry["status"] = "active",
  scopedProjectId = projectId,
): KnowledgeEntry {
  return KnowledgeEntrySchema.parse({
    schemaVersion: 1,
    entryId: `kne_authoritative_${suffix}`,
    level: "authoritative",
    status,
    source: {
      type: "requirement_revision",
      projectId: scopedProjectId,
      requirementRevisionId: RequirementRevisionIdSchema.parse(`rrv_source_${suffix}`),
    },
    scope: { projectId: scopedProjectId },
    summary: `Authoritative ${suffix}.`,
    body: `Approved rule ${suffix}.`,
  });
}

function experiential(
  suffix: string,
  status: KnowledgeEntry["status"] = "active",
): KnowledgeEntry {
  return KnowledgeEntrySchema.parse({
    schemaVersion: 1,
    entryId: `kne_experiential_${suffix}`,
    level: "experiential",
    status,
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
      evidenceId: EvidenceIdSchema.parse(`evd_source_${suffix}`),
      contentHash: "b".repeat(64),
    },
    scope: { projectId },
    summary: `Experiential ${suffix}.`,
    body: `Verified constraint ${suffix}.`,
  });
}

function historical(
  suffix: string,
  status: KnowledgeEntry["status"] = "active",
  outcome: "succeeded" | "failed" | "canceled" = "canceled",
): KnowledgeEntry {
  const hash = "c".repeat(64);
  return KnowledgeEntrySchema.parse({
    schemaVersion: 1,
    entryId: `kne_historical_${suffix}`,
    level: "historical",
    status,
    source: {
      type: "archive",
      projectId,
      runId: RunIdSchema.parse(`run_source_${suffix}`),
      outcome,
      manifestSchemaVersion: 2,
      manifestHash: hash,
      manifestRef: `cas:sha256:${hash}`,
    },
    scope: { projectId },
    summary: `Historical ${suffix}.`,
    body: `Archived Run ${suffix}.`,
  });
}

class TestOnlyKnowledgeReadStore implements KnowledgeReadStore {
  readonly requestedProjects: string[] = [];

  constructor(private readonly entries: readonly unknown[]) {}

  async listByProject(requestedProjectId: typeof projectId): Promise<readonly unknown[]> {
    this.requestedProjects.push(requestedProjectId);
    return this.entries;
  }
}

describe("KnowledgeResolver", () => {
  it("returns an auditable Handoff selection receipt for every candidate", async () => {
    const selected = authoritative("handoff_rule");
    const superseded = experiential(
      "handoff_superseded",
      "superseded",
    );
    const failedArchive = historical(
      "handoff_failed",
      "active",
      "failed",
    );
    const resolver = new KnowledgeResolver(
      new TestOnlyKnowledgeReadStore([
        failedArchive,
        superseded,
        selected,
      ]),
    ) as KnowledgeResolver & {
      selectForHandoff(input: unknown): Promise<{
        readonly entries: readonly KnowledgeEntry[];
        readonly receipt: {
          readonly schemaVersion: 1;
          readonly projectId: string;
          readonly selectedEntryIds: readonly string[];
          readonly candidates: readonly {
            readonly entryId: string;
            readonly decision: "selected" | "excluded";
            readonly reason: string;
            readonly authority: string;
            readonly confidence: string | null;
            readonly validity: string;
            readonly contentHash: string;
          }[];
          readonly selectionHash: string;
        };
      }>;
    };

    const result = await resolver.selectForHandoff({
      projectId,
      budget: {
        maxItems: 8,
        maxBytes: 16_384,
        maxTokens: 16_384,
      },
    });

    expect(result.entries.map(({ entryId }) => entryId)).toEqual([
      selected.entryId,
    ]);
    expect(result.receipt).toMatchObject({
      schemaVersion: 1,
      projectId,
      selectedEntryIds: [selected.entryId],
      candidates: [
        {
          entryId: selected.entryId,
          decision: "selected",
          reason: "selected_by_policy",
          authority: "authoritative",
          confidence: null,
          validity: "active",
          scope: { projectId },
          source: {
            type: "requirement_revision",
            referenceId: "rrv_source_handoff_rule",
          },
          contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        {
          entryId: superseded.entryId,
          decision: "excluded",
          reason: "status_superseded",
          authority: "experiential",
          confidence: "high",
          validity: "superseded",
          scope: { projectId },
          source: {
            type: "evidence",
            referenceId: "evd_source_handoff_superseded",
          },
          contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        {
          entryId: failedArchive.entryId,
          decision: "excluded",
          reason: "failed_archive_historical_only",
          authority: "historical",
          confidence: null,
          validity: "active",
          scope: { projectId },
          source: {
            type: "archive",
            referenceId: "run_source_handoff_failed",
          },
          contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      ],
      selectionHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it("omits whole entries at the item budget while retaining their references", async () => {
    const first = authoritative("budget_a");
    const second = authoritative("budget_b");

    const result = await new KnowledgeResolver(
      new TestOnlyKnowledgeReadStore([second, first]),
    ).selectForHandoff({
      projectId,
      budget: {
        maxItems: 1,
        maxBytes: 16_384,
        maxTokens: 16_384,
      },
    });

    expect(result.entries.map(({ entryId }) => entryId)).toEqual([
      first.entryId,
    ]);
    expect(result.receipt.candidates.find(({ entryId }) =>
      entryId === second.entryId
    )).toMatchObject({
      decision: "excluded",
      reason: "budget_items_exhausted",
    });
    expect(result.receipt).toMatchObject({
      budget: {
        maxItems: 1,
        maxBytes: 16_384,
        maxTokens: 16_384,
        usedItems: 1,
        truncated: true,
        omittedEntryIds: [second.entryId],
      },
    });
  });

  it.each([
    {
      label: "byte",
      budget: {
        maxItems: 8,
        maxBytes: KNOWLEDGE_HANDOFF_MIN_CONTENT_BYTES,
        maxTokens: 16_384,
      },
      reason: "budget_bytes_exhausted",
    },
    {
      label: "token",
      budget: {
        maxItems: 8,
        maxBytes: 16_384,
        maxTokens: KNOWLEDGE_HANDOFF_MIN_CONTENT_BYTES,
      },
      reason: "budget_tokens_exhausted",
    },
  ])(
    "explains $label budget truncation without partially injecting an entry",
    async ({ label, budget, reason }) => {
      const entry = authoritative(`budget_${label}`);
      const result = await new KnowledgeResolver(
        new TestOnlyKnowledgeReadStore([entry]),
      ).selectForHandoff({ projectId, budget });

      expect(result.entries).toEqual([]);
      expect(result.receipt.candidates).toEqual([
        expect.objectContaining({
          entryId: entry.entryId,
          decision: "excluded",
          reason,
        }),
      ]);
      expect(result.receipt.budget).toMatchObject({
        usedItems: 0,
        usedBytes: KNOWLEDGE_HANDOFF_MIN_CONTENT_BYTES,
        usedTokens: KNOWLEDGE_HANDOFF_MIN_CONTENT_BYTES,
        truncated: true,
        omittedEntryIds: [entry.entryId],
      });
    },
  );

  it("applies byte/token budget to the exact rendered Handoff envelope", async () => {
    const entry = KnowledgeEntrySchema.parse({
      ...authoritative("rendered_budget"),
      body: "x".repeat(300),
    });
    const result = await new KnowledgeResolver(
      new TestOnlyKnowledgeReadStore([entry]),
    ).selectForHandoff({
      projectId,
      budget: {
        maxItems: 8,
        maxBytes: 512,
        maxTokens: 512,
      },
    });
    const bundle = renderKnowledgeHandoff(result);

    expect(bundle.byteLength).toBeLessThanOrEqual(512);
    expect(bundle.tokenEstimate).toBeLessThanOrEqual(512);
    expect(result.receipt.budget.usedBytes).toBe(bundle.byteLength);
    expect(result.receipt.budget.usedTokens).toBe(bundle.tokenEstimate);
    expect(result.receipt.budget.truncated).toBe(true);
    expect(result.receipt.budget.omittedEntryIds).toEqual([entry.entryId]);
  });

  it("downgrades conflicting active claims until one entry is explicitly selected", async () => {
    const first = KnowledgeEntrySchema.parse({
      ...authoritative("conflict_a"),
      summary: "Use the project release policy.",
      body: "Require a verifier before release.",
    });
    const second = KnowledgeEntrySchema.parse({
      ...experiential("conflict_b"),
      summary: "Use the project release policy.",
      body: "Skip verification for small releases.",
    });

    const result = await new KnowledgeResolver(
      new TestOnlyKnowledgeReadStore([second, first]),
    ).selectForHandoff({
      projectId,
      budget: {
        maxItems: 8,
        maxBytes: 16_384,
        maxTokens: 16_384,
      },
    });

    expect(result.entries).toEqual([]);
    expect(result.receipt).toMatchObject({
      requiresExplicitSelection: true,
      conflicts: [{
        claimHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        entryIds: [first.entryId, second.entryId],
        resolution: "explicit_selection_required",
      }],
    });
    expect(result.receipt.candidates).toEqual([
      expect.objectContaining({
        entryId: first.entryId,
        decision: "excluded",
        reason: "conflict_requires_selection",
      }),
      expect.objectContaining({
        entryId: second.entryId,
        decision: "excluded",
        reason: "conflict_requires_selection",
      }),
    ]);
  });

  it("selects exactly one explicitly chosen conflicting claim and audits the resolution", async () => {
    const first = KnowledgeEntrySchema.parse({
      ...authoritative("explicit_a"),
      summary: "Use the project release policy.",
      body: "Require a verifier before release.",
    });
    const second = KnowledgeEntrySchema.parse({
      ...experiential("explicit_b"),
      summary: "Use the project release policy.",
      body: "Skip verification for small releases.",
    });

    const result = await new KnowledgeResolver(
      new TestOnlyKnowledgeReadStore([second, first]),
    ).selectForHandoff({
      projectId,
      explicitEntryIds: [first.entryId],
      budget: {
        maxItems: 8,
        maxBytes: 16_384,
        maxTokens: 16_384,
      },
    });

    expect(result.entries.map(({ entryId }) => entryId)).toEqual([
      first.entryId,
    ]);
    expect(result.receipt).toMatchObject({
      requiresExplicitSelection: false,
      selectedEntryIds: [first.entryId],
      conflicts: [{
        entryIds: [first.entryId, second.entryId],
        resolution: "explicit_selection",
        selectedEntryId: first.entryId,
      }],
    });
    expect(result.receipt.candidates).toEqual([
      expect.objectContaining({
        entryId: first.entryId,
        decision: "selected",
        reason: "explicit_conflict_selection",
      }),
      expect.objectContaining({
        entryId: second.entryId,
        decision: "excluded",
        reason: "conflict_not_selected",
      }),
    ]);
  });

  it("keeps selection stable across store order and rejects Provider-specific policy", async () => {
    const first = authoritative("provider_neutral_a");
    const second = experiential("provider_neutral_b");
    const budget = {
      maxItems: 8,
      maxBytes: 16_384,
      maxTokens: 16_384,
    };
    const forward = await new KnowledgeResolver(
      new TestOnlyKnowledgeReadStore([first, second]),
    ).selectForHandoff({ projectId, budget });
    const reverse = await new KnowledgeResolver(
      new TestOnlyKnowledgeReadStore([second, first]),
    ).selectForHandoff({ projectId, budget });

    expect(reverse).toEqual(forward);
    expect(JSON.stringify(forward.receipt)).not.toMatch(
      /\b(?:orca|codex|codebuddy|cursor|goose|provider|terminal|gui)\b/iu,
    );
    expect(Object.isFrozen(forward)).toBe(true);
    expect(Object.isFrozen(forward.receipt.candidates)).toBe(true);
    await expect(
      new KnowledgeResolver(
        new TestOnlyKnowledgeReadStore([first, second]),
      ).selectForHandoff({
        projectId,
        budget,
        runtimeProviderId: "private",
      }),
    ).rejects.toThrow();
  });

  it("defaults to active authoritative and experiential knowledge for the exact Project", async () => {
    const store = new TestOnlyKnowledgeReadStore([
      historical("history_a"),
      authoritative("other_a", "active", otherProjectId),
      experiential("experience_a"),
      authoritative("rule_a"),
      authoritative("withdrawn_a", "withdrawn"),
      experiential("superseded_a", "superseded"),
    ]);

    const resolved = await new KnowledgeResolver(store).resolve({ projectId });

    expect(resolved.map(({ entryId }) => entryId)).toEqual([
      "kne_authoritative_rule_a",
      "kne_experiential_experience_a",
    ]);
    expect(store.requestedProjects).toEqual([projectId]);
  });

  it("includes active historical knowledge only when explicitly requested", async () => {
    const store = new TestOnlyKnowledgeReadStore([
      historical("history_b", "withdrawn"),
      historical("history_a"),
      experiential("experience_a"),
    ]);

    const resolved = await new KnowledgeResolver(store).resolve({
      projectId,
      includeHistorical: true,
    });

    expect(resolved.map(({ entryId }) => entryId)).toEqual([
      "kne_experiential_experience_a",
      "kne_historical_history_a",
    ]);
  });

  it("returns stable level-priority and entry-ID ordering independent of store order", async () => {
    const unordered = [
      historical("history_z"),
      experiential("experience_z"),
      authoritative("rule_z"),
      experiential("experience_a"),
      authoritative("rule_a"),
      historical("history_a"),
    ];
    const resolver = new KnowledgeResolver(new TestOnlyKnowledgeReadStore(unordered));

    const resolved = await resolver.resolve({ projectId, includeHistorical: true });

    expect(resolved.map(({ entryId }) => entryId)).toEqual([
      "kne_authoritative_rule_a",
      "kne_authoritative_rule_z",
      "kne_experiential_experience_a",
      "kne_experiential_experience_z",
      "kne_historical_history_a",
      "kne_historical_history_z",
    ]);
  });

  it.each(["", "*", "prj_other"])(
    "rejects invalid or wildcard Project scope %j before querying storage",
    async (candidate) => {
      const store = new TestOnlyKnowledgeReadStore([]);

      await expect(
        new KnowledgeResolver(store).resolve({ projectId: candidate }),
      ).rejects.toThrow();
      expect(store.requestedProjects).toEqual([]);
    },
  );

  it("fails closed when storage returns an invalid knowledge record", async () => {
    const store = new TestOnlyKnowledgeReadStore([
      { ...authoritative("rule_a"), rawPrivateData: "secret" },
    ]);

    await expect(
      new KnowledgeResolver(store).resolve({ projectId }),
    ).rejects.toThrow();
  });

  it.each([
    [
      "the same payload",
      () => {
        const entry = authoritative("duplicate_same");
        return [entry, entry];
      },
    ],
    [
      "different payloads",
      () => {
        const first = authoritative("duplicate_conflict");
        return [
          first,
          {
            ...authoritative("duplicate_other"),
            entryId: first.entryId,
            body: "A contradictory body under the same entry ID.",
          },
        ];
      },
    ],
  ])("fails closed for a duplicate entryId with %s", async (_label, entries) => {
    await expect(
      new KnowledgeResolver(new TestOnlyKnowledgeReadStore(entries())).resolve({
        projectId,
      }),
    ).rejects.toThrow("KNOWLEDGE_DUPLICATE_ENTRY_ID");
  });

  it("fails closed deterministically for multiple active records with one typed source identity", async () => {
    const first = authoritative("source_identity_a");
    const second = {
      ...authoritative("source_identity_b"),
      source: first.source,
    };

    for (const entries of [
      [first, second],
      [second, first],
    ]) {
      await expect(
        new KnowledgeResolver(new TestOnlyKnowledgeReadStore(entries)).resolve({
          projectId,
        }),
      ).rejects.toThrow("KNOWLEDGE_DUPLICATE_SOURCE_IDENTITY");
    }
  });
});
