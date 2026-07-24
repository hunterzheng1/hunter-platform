import { createHash } from "node:crypto";

import {
  AgentProfileIdSchema,
  ArtifactIdSchema,
  AttemptIdSchema,
  ChangeIdSchema,
  ChangeRevisionIdSchema,
  ControllerLeaseIdSchema,
  DeviceBindingIdSchema,
  EvidenceIdSchema,
  ExecutionPlanIdSchema,
  ProjectIdSchema,
  RepositoryIdSchema,
  RequirementRevisionIdSchema,
  RunIdSchema,
  StepIdSchema,
  StepRunIdSchema,
  TaskIdSchema,
  WorkflowRevisionIdSchema,
  WorkspaceLeaseIdSchema,
  WriterLeaseIdSchema,
} from "@hunter/domain";
import { z } from "zod";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const GitHeadSchema = z.string().regex(/^[a-f0-9]{40,64}$/u);
const ContentRefSchema = z
  .string()
  .regex(/^cas:sha256:[a-f0-9]{64}$/u);
const OutcomeSchema = z.enum(["succeeded", "failed", "canceled"]);

const ContentEdgeSchema = z
  .object({
    contentRef: ContentRefSchema,
    contentHash: Sha256Schema,
  })
  .strict()
  .superRefine((edge, context) => {
    if (edge.contentRef !== `cas:sha256:${edge.contentHash}`) {
      context.addIssue({
        code: "custom",
        path: ["contentRef"],
        message: "CONTENT_REF_HASH_MISMATCH",
      });
    }
  });

const ArtifactEdgeSchema = ContentEdgeSchema.extend({
  artifactId: ArtifactIdSchema,
}).strict();

const EvidenceEdgeSchema = ContentEdgeSchema.extend({
  evidenceId: EvidenceIdSchema,
}).strict();

const AttemptManifestSchema = z
  .object({
    attemptId: AttemptIdSchema,
    agentProfileId: AgentProfileIdSchema,
    capabilityProbeDigest: Sha256Schema,
    nativeSessionReferenceHash: Sha256Schema,
    artifacts: z.array(ArtifactEdgeSchema).max(1_000),
    evidence: z.array(EvidenceEdgeSchema).min(1).max(1_000),
  })
  .strict();

const StepManifestSchema = z
  .object({
    stepRunId: StepRunIdSchema,
    stepId: StepIdSchema,
    attempts: z.array(AttemptManifestSchema).min(1).max(1_000),
  })
  .strict();

const RunManifestSchema = z
  .object({
    runId: RunIdSchema,
    parentRunId: RunIdSchema.nullable(),
    taskId: TaskIdSchema.nullable(),
    outcome: OutcomeSchema,
    steps: z.array(StepManifestSchema).min(1).max(10_000),
  })
  .strict();

const LeaseReceiptBaseSchema = z
  .object({
    repositoryId: RepositoryIdSchema,
    deviceBindingId: DeviceBindingIdSchema,
    gitHead: GitHeadSchema,
    receiptHash: Sha256Schema,
  })
  .strict();

const WorkspaceLeaseReceiptSchema = LeaseReceiptBaseSchema.extend({
  leaseId: WorkspaceLeaseIdSchema,
}).strict();
const WriterLeaseReceiptSchema = LeaseReceiptBaseSchema.extend({
  leaseId: WriterLeaseIdSchema,
}).strict();
const ControllerLeaseReceiptSchema = LeaseReceiptBaseSchema.extend({
  leaseId: ControllerLeaseIdSchema,
}).strict();

export const ArchiveManifestInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: ProjectIdSchema,
    repositories: z
      .array(
        z
          .object({
            repositoryId: RepositoryIdSchema,
            deviceBindingId: DeviceBindingIdSchema,
            gitHead: GitHeadSchema,
          })
          .strict(),
      )
      .min(1)
      .max(1_000),
    requirementRevisionIds: z
      .array(RequirementRevisionIdSchema)
      .min(1)
      .max(10_000),
    change: z
      .object({
        changeId: ChangeIdSchema,
        changeRevisionId: ChangeRevisionIdSchema,
      })
      .strict(),
    executionPlanId: ExecutionPlanIdSchema,
    workflowRevisionId: WorkflowRevisionIdSchema,
    runGraph: z
      .object({
        rootRunId: RunIdSchema,
        runs: z.array(RunManifestSchema).min(1).max(10_000),
      })
      .strict(),
    leases: z
      .object({
        workspace: z.array(WorkspaceLeaseReceiptSchema).min(1).max(10_000),
        writer: z.array(WriterLeaseReceiptSchema).min(1).max(10_000),
        controller: z.array(ControllerLeaseReceiptSchema).min(1).max(10_000),
      })
      .strict(),
    ledger: z
      .object({
        firstPosition: z.number().int().positive(),
        lastPosition: z.number().int().positive(),
      })
      .strict()
      .refine(
        ({ firstPosition, lastPosition }) => lastPosition >= firstPosition,
        "ARCHIVE_LEDGER_RANGE_INVALID",
      ),
    actor: z
      .object({
        actorId: z.string().trim().min(1).max(256),
        correlationId: z.string().trim().min(1).max(256),
      })
      .strict(),
    timestamps: z
      .object({
        occurredAt: z.iso.datetime(),
        archivedAt: z.iso.datetime(),
      })
      .strict()
      .refine(
        ({ occurredAt, archivedAt }) =>
          Date.parse(archivedAt) >= Date.parse(occurredAt),
        "ARCHIVE_TIMESTAMP_ORDER_INVALID",
      ),
    outcome: OutcomeSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    const runIds = new Set(manifest.runGraph.runs.map(({ runId }) => runId));
    const root = manifest.runGraph.runs.find(
      ({ runId }) => runId === manifest.runGraph.rootRunId,
    );
    if (
      root === undefined ||
      (root.parentRunId === null) !== (root.taskId === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["runGraph", "rootRunId"],
        message: "ARCHIVE_ROOT_RUN_INVALID",
      });
    }
    for (const [index, run] of manifest.runGraph.runs.entries()) {
      if (
        run.runId !== manifest.runGraph.rootRunId &&
        (run.parentRunId === null ||
          !runIds.has(run.parentRunId) ||
          run.taskId === null)
      ) {
        context.addIssue({
          code: "custom",
          path: ["runGraph", "runs", index],
          message: "ARCHIVE_RUN_EDGE_INVALID",
        });
      }
    }
    if (
      root !== undefined &&
      (root.outcome !== manifest.outcome ||
        manifest.runGraph.runs.some(({ outcome }) => outcome !== manifest.outcome))
    ) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "ARCHIVE_OUTCOME_MISMATCH",
      });
    }
  });
export type ArchiveManifestInput = z.infer<typeof ArchiveManifestInputSchema>;

export const ArchiveManifestSchema = ArchiveManifestInputSchema.safeExtend({
  manifestHash: Sha256Schema,
});
export type ArchiveManifest = z.infer<typeof ArchiveManifestSchema>;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashInput(input: ArchiveManifestInput): string {
  return sha256(JSON.stringify(ArchiveManifestInputSchema.parse(input)));
}

export function createArchiveManifest(input: unknown): ArchiveManifest {
  const parsed = ArchiveManifestInputSchema.parse(input);
  return ArchiveManifestSchema.parse({
    ...parsed,
    manifestHash: hashInput(parsed),
  });
}

export function verifyArchiveManifest(input: unknown): ArchiveManifest {
  const manifest = ArchiveManifestSchema.parse(input);
  const { manifestHash, ...payload } = manifest;
  if (hashInput(payload) !== manifestHash) {
    throw new Error("ARCHIVE_MANIFEST_HASH_MISMATCH");
  }
  return manifest;
}
