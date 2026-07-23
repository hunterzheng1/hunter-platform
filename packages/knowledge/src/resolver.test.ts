import {
  EvidenceIdSchema,
  ProjectIdSchema,
  RequirementRevisionIdSchema,
  RunIdSchema,
} from "@hunter/domain";
import { describe, expect, it } from "vitest";

import {
  KnowledgeEntrySchema,
  KnowledgeResolver,
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
      outcome: "canceled",
      manifestSchemaVersion: 1,
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
