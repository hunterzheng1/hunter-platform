import {
  KnowledgeEntryIdSchema,
  ProjectIdSchema,
  canonicalSha256,
  deepFreeze,
  type ProjectId,
} from "@hunter/domain";
import { z } from "zod";

import {
  KnowledgeEntrySchema,
  KnowledgeSelectionReceiptSchema,
  type KnowledgeEntry,
  type KnowledgeSelectionCandidate,
  type KnowledgeSelectionReceipt,
} from "./contracts.js";
import {
  KNOWLEDGE_HANDOFF_MIN_CONTENT_BYTES,
  KNOWLEDGE_HANDOFF_PLACEHOLDER_SELECTION_HASH,
  encodeKnowledgeHandoffContent,
  knowledgeHandoffDataEntry,
} from "./handoff-format.js";

const KnowledgeResolutionInputSchema = z
  .object({
    projectId: ProjectIdSchema,
    includeHistorical: z.boolean().optional().default(false),
  })
  .strict();

const KnowledgeHandoffSelectionInputSchema = z
  .object({
    projectId: ProjectIdSchema,
    explicitEntryIds: z
      .array(KnowledgeEntryIdSchema)
      .max(32)
      .default([])
      .refine((entryIds) => new Set(entryIds).size === entryIds.length),
    budget: z
      .object({
        maxItems: z.number().int().positive().max(128),
        maxBytes: z
          .number()
          .int()
          .min(KNOWLEDGE_HANDOFF_MIN_CONTENT_BYTES)
          .max(128 * 1024),
        maxTokens: z
          .number()
          .int()
          .min(KNOWLEDGE_HANDOFF_MIN_CONTENT_BYTES)
          .max(128 * 1024),
      })
      .strict(),
  })
  .strict();

export interface KnowledgeHandoffSelection {
  readonly entries: readonly KnowledgeEntry[];
  readonly receipt: KnowledgeSelectionReceipt;
}

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

  async selectForHandoff(
    input: unknown,
  ): Promise<KnowledgeHandoffSelection> {
    const parsedInput = KnowledgeHandoffSelectionInputSchema.parse(input);
    const storedEntries = await this.store.listByProject(
      parsedInput.projectId,
    );
    const entries = z.array(KnowledgeEntrySchema).parse(storedEntries);
    assertUnambiguousKnowledge(entries);
    const scoped = entries
      .filter((entry) =>
        entry.scope.projectId === parsedInput.projectId
        && entry.source.projectId === parsedInput.projectId
      )
      .sort(compareEntries);
    const candidates: KnowledgeSelectionCandidate[] = scoped.map((entry) => {
      const reason: KnowledgeSelectionCandidate["reason"] =
        entry.status === "superseded"
          ? "status_superseded"
          : entry.status === "withdrawn"
            ? "status_withdrawn"
            : entry.level === "historical"
              ? entry.source.outcome === "failed"
                ? "failed_archive_historical_only"
                : "historical_not_promoted"
              : "selected_by_policy";
      return {
        entryId: KnowledgeEntryIdSchema.parse(entry.entryId),
        scope: {
          projectId: entry.scope.projectId,
        },
        source: entry.source.type === "requirement_revision"
          ? {
            type: entry.source.type,
            referenceId: entry.source.requirementRevisionId,
          }
          : entry.source.type === "evidence"
            ? {
              type: entry.source.type,
              referenceId: entry.source.evidenceId,
            }
            : {
              type: entry.source.type,
              referenceId: entry.source.runId,
            },
        decision: reason === "selected_by_policy"
          ? "selected"
          : "excluded",
        reason,
        authority: entry.level,
        confidence: entry.level === "experiential"
          ? entry.confidence.level
          : null,
        validity: entry.status,
        contentHash: canonicalSha256({
          summary: entry.summary,
          body: entry.body,
        }),
      };
    });
    const claimGroups = new Map<string, number[]>();
    for (let index = 0; index < candidates.length; index += 1) {
      if (candidates[index]?.decision !== "selected") continue;
      const entry = scoped[index]!;
      const claimHash = canonicalSha256({
        projectId: parsedInput.projectId,
        summary: entry.summary
          .normalize("NFKC")
          .trim()
          .replace(/\s+/gu, " ")
          .toLowerCase(),
      });
      const indexes = claimGroups.get(claimHash) ?? [];
      indexes.push(index);
      claimGroups.set(claimHash, indexes);
    }
    const conflicts: Array<
      Omit<KnowledgeSelectionReceipt["conflicts"][number], "selectedEntryId">
      & { selectedEntryId?: KnowledgeSelectionCandidate["entryId"] }
    > = [];
    const explicitEntryIds = new Set(parsedInput.explicitEntryIds);
    for (const [claimHash, indexes] of [...claimGroups.entries()].sort()) {
      const contentHashes = new Set(indexes.map((index) =>
        candidates[index]!.contentHash
      ));
      if (indexes.length < 2 || contentHashes.size < 2) continue;
      const entryIds = indexes.map((index) => candidates[index]!.entryId);
      const explicitlySelected = indexes.filter((index) =>
        explicitEntryIds.has(candidates[index]!.entryId)
      );
      if (explicitlySelected.length === 1) {
        const selectedIndex = explicitlySelected[0]!;
        const selectedEntryId = candidates[selectedIndex]!.entryId;
        conflicts.push({
          claimHash,
          entryIds,
          resolution: "explicit_selection",
          selectedEntryId,
        });
        for (const index of indexes) {
          candidates[index] = {
            ...candidates[index]!,
            decision: index === selectedIndex ? "selected" : "excluded",
            reason: index === selectedIndex
              ? "explicit_conflict_selection"
              : "conflict_not_selected",
          };
        }
        continue;
      }
      conflicts.push({
        claimHash,
        entryIds,
        resolution: "explicit_selection_required",
      });
      for (const index of indexes) {
        candidates[index] = {
          ...candidates[index]!,
          decision: "excluded",
          reason: "conflict_requires_selection",
        };
      }
    }
    let usedItems = 0;
    let usedBytes = KNOWLEDGE_HANDOFF_MIN_CONTENT_BYTES;
    let usedTokens = KNOWLEDGE_HANDOFF_MIN_CONTENT_BYTES;
    let selectedDataEntries: ReturnType<
      typeof knowledgeHandoffDataEntry
    >[] = [];
    const omittedEntryIds: KnowledgeSelectionCandidate["entryId"][] = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]!;
      if (candidate.decision !== "selected") continue;
      const entry = scoped[index]!;
      const nextDataEntries = [
        ...selectedDataEntries,
        knowledgeHandoffDataEntry(entry, candidate),
      ];
      const bytes = Buffer.byteLength(
        encodeKnowledgeHandoffContent(
          KNOWLEDGE_HANDOFF_PLACEHOLDER_SELECTION_HASH,
          nextDataEntries,
        ),
        "utf8",
      );
      const tokens = bytes;
      const reason =
        usedItems + 1 > parsedInput.budget.maxItems
          ? "budget_items_exhausted"
          : bytes > parsedInput.budget.maxBytes
            ? "budget_bytes_exhausted"
            : tokens > parsedInput.budget.maxTokens
              ? "budget_tokens_exhausted"
              : null;
      if (reason !== null) {
        candidates[index] = {
          ...candidate,
          decision: "excluded",
          reason,
        };
        omittedEntryIds.push(candidate.entryId);
        continue;
      }
      usedItems += 1;
      usedBytes = bytes;
      usedTokens = tokens;
      selectedDataEntries = nextDataEntries;
    }
    const selectedEntryIds = candidates
      .filter(({ decision }) => decision === "selected")
      .map(({ entryId }) => entryId);
    const selectedEntries = scoped.filter(({ entryId }) =>
      selectedEntryIds.includes(entryId)
    );
    const receiptBase = {
      schemaVersion: 1 as const,
      projectId: parsedInput.projectId,
      selectedEntryIds,
      candidates,
      requiresExplicitSelection: conflicts.some(({ resolution }) =>
        resolution === "explicit_selection_required"
      ),
      conflicts,
      budget: {
        ...parsedInput.budget,
        usedItems,
        usedBytes,
        usedTokens,
        truncated: omittedEntryIds.length > 0,
        omittedEntryIds,
      },
    };
    const receipt = KnowledgeSelectionReceiptSchema.parse({
      ...receiptBase,
      selectionHash: canonicalSha256(receiptBase),
    });
    return deepFreeze({
      entries: selectedEntries,
      receipt,
    });
  }
}
