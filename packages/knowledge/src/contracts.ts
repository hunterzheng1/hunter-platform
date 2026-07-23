import {
  EvidenceIdSchema,
  KnowledgeEntryIdSchema,
  ProjectIdSchema,
  RequirementRevisionIdSchema,
  RunIdSchema,
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
    manifestSchemaVersion: z.literal(1),
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
