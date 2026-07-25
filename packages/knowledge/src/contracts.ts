import {
  EvidenceIdSchema,
  KnowledgeEntryIdSchema,
  ProjectIdSchema,
  RequirementRevisionIdSchema,
  RunIdSchema,
  canonicalSha256,
} from "@hunter/domain";
import { z } from "zod";

const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u, "must be a lowercase SHA-256 digest");

const ContentAddressedManifestRefSchema = z
  .string()
  .regex(/^cas:sha256:[a-f0-9]{64}$/u, "must be an opaque content-addressed manifest reference");

const ManifestIdentitySchema = z
  .object({
    projectId: ProjectIdSchema,
    runId: RunIdSchema,
    outcome: z.enum(["succeeded", "failed", "canceled"]),
    manifestSchemaVersion: z.literal(2),
    manifestHash: Sha256Schema,
    manifestRef: ContentAddressedManifestRefSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.manifestRef !== `cas:sha256:${value.manifestHash}`) {
      context.addIssue({
        code: "custom",
        path: ["manifestRef"],
        message: "manifestRef digest must match manifestHash",
      });
    }
  });

/**
 * The Task 18 atomic manifest worker is the only production authority allowed
 * to issue this receipt. This package consumes the verified boundary; it does
 * not read manifest paths or parse raw manifests.
 */
export const VerifiedArchiveReceiptSchema = ManifestIdentitySchema.extend({
  receiptSchemaVersion: z.literal(1),
  verifiedAt: z.string().datetime({ offset: true }),
})
  .strict()
  .superRefine((value, context) => {
    if (value.manifestRef !== `cas:sha256:${value.manifestHash}`) {
      context.addIssue({
        code: "custom",
        path: ["manifestRef"],
        message: "manifestRef digest must match manifestHash",
      });
    }
  });
export type VerifiedArchiveReceipt = z.infer<typeof VerifiedArchiveReceiptSchema>;

const KnowledgeBaseSchema = z.object({
  schemaVersion: z.literal(1),
  entryId: KnowledgeEntryIdSchema,
  status: z.enum(["active", "superseded", "withdrawn"]),
  scope: z.object({ projectId: ProjectIdSchema }).strict(),
  summary: z.string().trim().min(1).max(500),
  body: z.string().trim().min(1).max(10_000),
});

const AuthoritativeKnowledgeEntrySchema = KnowledgeBaseSchema.extend({
  level: z.literal("authoritative"),
  source: z
    .object({
      type: z.literal("requirement_revision"),
      projectId: ProjectIdSchema,
      requirementRevisionId: RequirementRevisionIdSchema,
    })
    .strict(),
}).strict();

const ExperientialKnowledgeEntrySchema = KnowledgeBaseSchema.extend({
  level: z.literal("experiential"),
  confidence: z
    .object({
      level: z.enum(["low", "medium", "high"]),
      rationale: z.string().trim().min(1).max(1_000),
    })
    .strict(),
  invalidationConditions: z
    .array(
      z
        .object({
          condition: z.string().trim().min(1).max(1_000),
        })
        .strict(),
    )
    .min(1)
    .max(32),
  source: z
    .object({
      type: z.literal("evidence"),
      projectId: ProjectIdSchema,
      evidenceId: EvidenceIdSchema,
      contentHash: Sha256Schema,
    })
    .strict(),
}).strict();

const HistoricalKnowledgeEntrySchema = KnowledgeBaseSchema.extend({
  level: z.literal("historical"),
  source: z
    .object({
      type: z.literal("archive"),
      ...ManifestIdentitySchema.shape,
    })
    .strict(),
}).strict();

export const KnowledgeEntrySchema = z
  .discriminatedUnion("level", [
    AuthoritativeKnowledgeEntrySchema,
    ExperientialKnowledgeEntrySchema,
    HistoricalKnowledgeEntrySchema,
  ])
  .superRefine((entry, context) => {
    if (entry.scope.projectId !== entry.source.projectId) {
      context.addIssue({
        code: "custom",
        path: ["scope", "projectId"],
        message: "knowledge scope must match source Project",
      });
    }
    if (
      entry.level === "historical" &&
      entry.source.manifestRef !== `cas:sha256:${entry.source.manifestHash}`
    ) {
      context.addIssue({
        code: "custom",
        path: ["source", "manifestRef"],
        message: "manifestRef digest must match manifestHash",
      });
    }
  });
export type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;

const KnowledgeSelectionSourceSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("requirement_revision"),
      referenceId: RequirementRevisionIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("evidence"),
      referenceId: EvidenceIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("archive"),
      referenceId: RunIdSchema,
    })
    .strict(),
]);

export const KnowledgeSelectionCandidateSchema = z
  .object({
    entryId: KnowledgeEntryIdSchema,
    scope: z.object({ projectId: ProjectIdSchema }).strict(),
    source: KnowledgeSelectionSourceSchema,
    decision: z.enum(["selected", "excluded"]),
    reason: z.enum([
      "selected_by_policy",
      "status_superseded",
      "status_withdrawn",
      "historical_not_promoted",
      "failed_archive_historical_only",
      "conflict_requires_selection",
      "explicit_conflict_selection",
      "conflict_not_selected",
      "budget_items_exhausted",
      "budget_bytes_exhausted",
      "budget_tokens_exhausted",
    ]),
    authority: z.enum(["authoritative", "experiential", "historical"]),
    confidence: z.enum(["low", "medium", "high"]).nullable(),
    validity: z.enum(["active", "superseded", "withdrawn"]),
    contentHash: Sha256Schema,
  })
  .strict();
export type KnowledgeSelectionCandidate = z.infer<
  typeof KnowledgeSelectionCandidateSchema
>;

const KnowledgeSelectionConflictSchema = z
  .object({
    claimHash: Sha256Schema,
    entryIds: z.array(KnowledgeEntryIdSchema).min(2),
    resolution: z.enum([
      "explicit_selection_required",
      "explicit_selection",
    ]),
    selectedEntryId: KnowledgeEntryIdSchema.optional(),
  })
  .strict()
  .superRefine((conflict, context) => {
    if (
      conflict.resolution === "explicit_selection"
      && conflict.selectedEntryId === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectedEntryId"],
        message: "explicit selection must identify the selected entry",
      });
    }
    if (
      conflict.resolution === "explicit_selection_required"
      && conflict.selectedEntryId !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectedEntryId"],
        message: "unresolved conflict must not identify a selected entry",
      });
    }
    if (
      conflict.selectedEntryId !== undefined
      && !conflict.entryIds.includes(conflict.selectedEntryId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectedEntryId"],
        message: "selected entry must belong to the conflict",
      });
    }
  });

const KnowledgeSelectionReceiptBaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: ProjectIdSchema,
    selectedEntryIds: z.array(KnowledgeEntryIdSchema),
    candidates: z.array(KnowledgeSelectionCandidateSchema),
    requiresExplicitSelection: z.boolean(),
    conflicts: z.array(KnowledgeSelectionConflictSchema),
    budget: z
      .object({
        maxItems: z.number().int().positive(),
        maxBytes: z.number().int().positive(),
        maxTokens: z.number().int().positive(),
        usedItems: z.number().int().nonnegative(),
        usedBytes: z.number().int().nonnegative(),
        usedTokens: z.number().int().nonnegative(),
        truncated: z.boolean(),
        omittedEntryIds: z.array(KnowledgeEntryIdSchema),
      })
      .strict(),
  })
  .strict();

export const KnowledgeSelectionReceiptSchema =
  KnowledgeSelectionReceiptBaseSchema.extend({
    selectionHash: Sha256Schema,
  })
    .strict()
    .superRefine((receipt, context) => {
      const addIssue = (path: PropertyKey[], message: string): void => {
        context.addIssue({
          code: "custom",
          path,
          message,
        });
      };
      const { selectionHash, ...receiptBase } = receipt;
      if (selectionHash !== canonicalSha256(receiptBase)) {
        addIssue(
          ["selectionHash"],
          "selectionHash must match the canonical receipt",
        );
      }
      const candidateIds = receipt.candidates.map(({ entryId }) => entryId);
      if (new Set(candidateIds).size !== candidateIds.length) {
        addIssue(["candidates"], "candidate entry IDs must be unique");
      }
      for (const [index, candidate] of receipt.candidates.entries()) {
        if (candidate.scope.projectId !== receipt.projectId) {
          addIssue(
            ["candidates", index, "scope", "projectId"],
            "candidate scope must match the receipt Project",
          );
        }
        const expectedSource = candidate.authority === "authoritative"
          ? "requirement_revision"
          : candidate.authority === "experiential"
            ? "evidence"
            : "archive";
        if (candidate.source.type !== expectedSource) {
          addIssue(
            ["candidates", index, "source", "type"],
            "candidate source must match its authority",
          );
        }
        if (
          (candidate.authority === "experiential")
            !== (candidate.confidence !== null)
        ) {
          addIssue(
            ["candidates", index, "confidence"],
            "only experiential candidates carry confidence",
          );
        }
        const selectedReason =
          candidate.reason === "selected_by_policy"
          || candidate.reason === "explicit_conflict_selection";
        if ((candidate.decision === "selected") !== selectedReason) {
          addIssue(
            ["candidates", index, "reason"],
            "candidate reason must match its decision",
          );
        }
        if (
          candidate.decision === "selected"
          && (
            candidate.validity !== "active"
            || candidate.authority === "historical"
          )
        ) {
          addIssue(
            ["candidates", index, "decision"],
            "only active non-historical candidates may be selected",
          );
        }
        if (
          candidate.reason === "status_superseded"
          && candidate.validity !== "superseded"
        ) {
          addIssue(
            ["candidates", index, "validity"],
            "superseded exclusion must match candidate validity",
          );
        }
        if (
          candidate.reason === "status_withdrawn"
          && candidate.validity !== "withdrawn"
        ) {
          addIssue(
            ["candidates", index, "validity"],
            "withdrawn exclusion must match candidate validity",
          );
        }
        if (
          (
            candidate.reason === "historical_not_promoted"
            || candidate.reason === "failed_archive_historical_only"
          )
          && candidate.authority !== "historical"
        ) {
          addIssue(
            ["candidates", index, "authority"],
            "historical exclusion must match candidate authority",
          );
        }
      }
      const selectedCandidateIds = receipt.candidates
        .filter(({ decision }) => decision === "selected")
        .map(({ entryId }) => entryId);
      if (
        selectedCandidateIds.length !== receipt.selectedEntryIds.length
        || selectedCandidateIds.some((entryId, index) =>
          receipt.selectedEntryIds[index] !== entryId
        )
      ) {
        addIssue(
          ["selectedEntryIds"],
          "selected entries must exactly match selected candidates",
        );
      }
      if (receipt.budget.usedItems !== selectedCandidateIds.length) {
        addIssue(
          ["budget", "usedItems"],
          "usedItems must match selected candidates",
        );
      }
      if (
        receipt.budget.usedItems > receipt.budget.maxItems
        || receipt.budget.usedBytes > receipt.budget.maxBytes
        || receipt.budget.usedTokens > receipt.budget.maxTokens
      ) {
        addIssue(["budget"], "used budget must not exceed its limits");
      }
      const omittedCandidateIds = receipt.candidates
        .filter(({ reason }) => reason.startsWith("budget_"))
        .map(({ entryId }) => entryId);
      if (
        omittedCandidateIds.length !== receipt.budget.omittedEntryIds.length
        || omittedCandidateIds.some((entryId, index) =>
          receipt.budget.omittedEntryIds[index] !== entryId
        )
      ) {
        addIssue(
          ["budget", "omittedEntryIds"],
          "omitted entries must match budget exclusions",
        );
      }
      if (
        receipt.budget.truncated
          !== (receipt.budget.omittedEntryIds.length > 0)
      ) {
        addIssue(
          ["budget", "truncated"],
          "truncated must reflect omitted entries",
        );
      }
      const requiresExplicitSelection = receipt.conflicts.some(
        ({ resolution }) => resolution === "explicit_selection_required",
      );
      if (
        receipt.requiresExplicitSelection !== requiresExplicitSelection
      ) {
        addIssue(
          ["requiresExplicitSelection"],
          "explicit-selection flag must match unresolved conflicts",
        );
      }
      const conflictCandidateIds = new Set<string>();
      for (const [index, conflict] of receipt.conflicts.entries()) {
        if (
          conflict.entryIds.some((entryId) =>
            !candidateIds.includes(entryId)
          )
        ) {
          addIssue(
            ["conflicts", index, "entryIds"],
            "conflict entries must be receipt candidates",
          );
        }
        for (const entryId of conflict.entryIds) {
          if (conflictCandidateIds.has(entryId)) {
            addIssue(
              ["conflicts", index, "entryIds"],
              "a candidate must not belong to multiple conflicts",
            );
          }
          conflictCandidateIds.add(entryId);
          const candidate = receipt.candidates.find((item) =>
            item.entryId === entryId
          );
          if (candidate === undefined) continue;
          if (conflict.resolution === "explicit_selection_required") {
            if (
              candidate.decision !== "excluded"
              || candidate.reason !== "conflict_requires_selection"
            ) {
              addIssue(
                ["conflicts", index, "entryIds"],
                "unresolved conflict candidates must require selection",
              );
            }
            continue;
          }
          if (entryId === conflict.selectedEntryId) {
            const explicitlySelected =
              candidate.reason === "explicit_conflict_selection"
              && candidate.decision === "selected";
            const omittedByBudget =
              candidate.decision === "excluded"
              && candidate.reason.startsWith("budget_");
            if (!explicitlySelected && !omittedByBudget) {
              addIssue(
                ["conflicts", index, "selectedEntryId"],
                "selected conflict entry must match the candidate decision",
              );
            }
          } else if (
            candidate.decision !== "excluded"
            || candidate.reason !== "conflict_not_selected"
          ) {
            addIssue(
              ["conflicts", index, "entryIds"],
              "non-selected conflict entries must remain excluded",
            );
          }
        }
      }
      for (const [index, candidate] of receipt.candidates.entries()) {
        if (
          (
            candidate.reason === "conflict_requires_selection"
            || candidate.reason === "explicit_conflict_selection"
            || candidate.reason === "conflict_not_selected"
          )
          && !conflictCandidateIds.has(candidate.entryId)
        ) {
          addIssue(
            ["candidates", index, "reason"],
            "conflict decisions must reference a receipt conflict",
          );
        }
      }
    });
export type KnowledgeSelectionReceipt = z.infer<
  typeof KnowledgeSelectionReceiptSchema
>;
