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

export class KnowledgeResolver {
  constructor(private readonly store: KnowledgeReadStore) {}

  async resolve(input: unknown): Promise<KnowledgeEntry[]> {
    const parsedInput = KnowledgeResolutionInputSchema.parse(input);
    const storedEntries = await this.store.listByProject(parsedInput.projectId);
    const entries = z.array(KnowledgeEntrySchema).parse(storedEntries);

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
