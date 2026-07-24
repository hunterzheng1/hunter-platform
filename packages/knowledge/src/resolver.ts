import { ProjectIdSchema, type ProjectId } from "@hunter/domain";
import { z } from "zod";

import { KnowledgeEntrySchema, type KnowledgeEntry } from "./contracts.js";

const KnowledgeResolutionInputSchema = z
  .object({
    projectId: ProjectIdSchema,
    includeHistorical: z.boolean().optional().default(false),
  })
  .strict();

export interface KnowledgeReadStore {
  listByProject(projectId: ProjectId): Promise<readonly unknown[]>;
}

export const KNOWLEDGE_DUPLICATE_ENTRY_ID = "KNOWLEDGE_DUPLICATE_ENTRY_ID";
export const KNOWLEDGE_DUPLICATE_SOURCE_IDENTITY =
  "KNOWLEDGE_DUPLICATE_SOURCE_IDENTITY";

const levelPriority: Readonly<Record<KnowledgeEntry["level"], number>> = {
  authoritative: 0,
  experiential: 1,
  historical: 2,
};

function compareEntries(left: KnowledgeEntry, right: KnowledgeEntry): number {
  const levelDifference = levelPriority[left.level] - levelPriority[right.level];
  if (levelDifference !== 0) return levelDifference;
  if (left.entryId < right.entryId) return -1;
  if (left.entryId > right.entryId) return 1;
  return 0;
}

function canonicalSourceIdentity(entry: KnowledgeEntry): string {
  switch (entry.source.type) {
    case "requirement_revision":
      return [
        entry.source.type,
        entry.source.projectId,
        entry.source.requirementRevisionId,
      ].join("\u0000");
    case "evidence":
      return [
        entry.source.type,
        entry.source.projectId,
        entry.source.evidenceId,
      ].join("\u0000");
    case "archive":
      return [
        entry.source.type,
        entry.source.projectId,
        entry.source.runId,
      ].join("\u0000");
  }
}

function assertUnambiguousKnowledge(entries: readonly KnowledgeEntry[]): void {
  const entryIds = new Set<string>();
  const activeSources = new Set<string>();

  for (const entry of entries) {
    if (entryIds.has(entry.entryId)) {
      throw new Error(KNOWLEDGE_DUPLICATE_ENTRY_ID);
    }
    entryIds.add(entry.entryId);

    if (entry.status === "active") {
      const sourceIdentity = canonicalSourceIdentity(entry);
      if (activeSources.has(sourceIdentity)) {
        throw new Error(KNOWLEDGE_DUPLICATE_SOURCE_IDENTITY);
      }
      activeSources.add(sourceIdentity);
    }
  }
}

export class KnowledgeResolver {
  constructor(private readonly store: KnowledgeReadStore) {}

  async resolve(input: unknown): Promise<KnowledgeEntry[]> {
    const parsedInput = KnowledgeResolutionInputSchema.parse(input);
    const storedEntries = await this.store.listByProject(parsedInput.projectId);
    const entries = z.array(KnowledgeEntrySchema).parse(storedEntries);
    assertUnambiguousKnowledge(entries);

    return entries
      .filter(
        (entry) =>
          entry.scope.projectId === parsedInput.projectId &&
          entry.source.projectId === parsedInput.projectId &&
          entry.status === "active" &&
          (parsedInput.includeHistorical || entry.level !== "historical"),
      )
      .sort(compareEntries);
  }
}
