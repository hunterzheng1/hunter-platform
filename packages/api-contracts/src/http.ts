import {
  AgentProfileIdSchema,
  ArtifactIdSchema,
  ChangeIdSchema,
  ChangeRevisionIdSchema,
  ExecutionPlanIdSchema,
  KnowledgeEntryIdSchema,
  ProjectIdSchema,
  RepositoryIdSchema,
  RequirementIdSchema,
  RequirementRevisionIdSchema,
  RunIdSchema,
  StepRunIdSchema,
  AttemptIdSchema,
  EvidenceIdSchema,
  NativeSessionIdSchema,
  TaskIdSchema,
  WorkflowRevisionIdSchema,
} from "@hunter/domain/ids";
import { z } from "zod";

export const CommandMetadataSchema = z.strictObject({
  expectedVersion: z.number().int().nonnegative(),
  idempotencyKey: z.string().trim().min(8).max(128),
});

export const StartRunHttpRequestSchema = z.strictObject({
  runId: RunIdSchema,
  executionPlanId: ExecutionPlanIdSchema,
  workflowRevisionId: WorkflowRevisionIdSchema,
  expectedVersion: CommandMetadataSchema.shape.expectedVersion,
  idempotencyKey: CommandMetadataSchema.shape.idempotencyKey,
});
export type StartRunHttpRequest = z.infer<typeof StartRunHttpRequestSchema>;

export const RunIdParamsSchema = z.strictObject({ runId: RunIdSchema });

export const ExecutionStatusHttpSchema = z.enum([
  "assigned",
  "running",
  "waiting_input",
  "returned",
  "failed",
  "canceled",
  "stale",
  "needs_attention",
]);
export const VerificationStatusHttpSchema = z.enum([
  "pending",
  "verifying",
  "passed",
  "failed",
  "error",
  "needs_human",
  "canceled",
]);
export const StepConclusionHttpSchema = z.enum(["active", "succeeded", "failed", "blocked", "canceled"]);
export const RunStatusHttpSchema = z.enum([
  "created",
  "running",
  "waiting_approval",
  "paused",
  "succeeded",
  "failed",
  "canceled",
  "needs_attention",
]);

export const StepAttemptHttpViewSchema = z.strictObject({
  attemptId: AttemptIdSchema,
  attemptNumber: z.number().int().positive(),
  executionStatus: ExecutionStatusHttpSchema,
  verificationStatus: VerificationStatusHttpSchema,
  agentProfileId: AgentProfileIdSchema.optional(),
  nativeSessionId: NativeSessionIdSchema.optional(),
  artifactIds: z.array(ArtifactIdSchema).max(100),
  evidenceIds: z.array(EvidenceIdSchema).max(100),
  waitingReason: z.strictObject({
    code: z.enum([
      "input_required",
      "human_verification_required",
      "recovery_attention_required",
      "external_operation_indeterminate",
    ]),
  }).optional(),
}).superRefine((attempt, context) => {
  if (new Set(attempt.artifactIds).size !== attempt.artifactIds.length) {
    context.addIssue({ code: "custom", path: ["artifactIds"], message: "artifactIds must be unique" });
  }
  if (new Set(attempt.evidenceIds).size !== attempt.evidenceIds.length) {
    context.addIssue({ code: "custom", path: ["evidenceIds"], message: "evidenceIds must be unique" });
  }
  const isWaiting = attempt.executionStatus === "waiting_input"
    || attempt.executionStatus === "needs_attention"
    || attempt.verificationStatus === "needs_human";
  if (isWaiting && attempt.waitingReason === undefined) {
    context.addIssue({ code: "custom", path: ["waitingReason"], message: "waitingReason is required for a waiting status" });
  }
  if (!isWaiting && attempt.waitingReason !== undefined) {
    context.addIssue({ code: "custom", path: ["waitingReason"], message: "waitingReason is only valid for a waiting status" });
  }
});
export type StepAttemptHttpView = z.infer<typeof StepAttemptHttpViewSchema>;

export const RunStepHttpViewSchema = z.strictObject({
  stepRunId: StepRunIdSchema,
  title: z.string().trim().min(1).max(200),
  conclusion: StepConclusionHttpSchema,
  attempts: z.array(StepAttemptHttpViewSchema).max(100),
}).superRefine((step, context) => {
  const attemptIds = new Set<string>();
  step.attempts.forEach((attempt, index) => {
    if (attemptIds.has(attempt.attemptId)) {
      context.addIssue({ code: "custom", path: ["attempts", index, "attemptId"], message: "attemptId must be unique within a Step" });
    }
    attemptIds.add(attempt.attemptId);
    if (attempt.attemptNumber !== index + 1) {
      context.addIssue({ code: "custom", path: ["attempts", index, "attemptNumber"], message: "Attempt history must be continuous from 1" });
    }
  });
  const finalAttempt = step.attempts.at(-1);
  if (step.conclusion === "succeeded" && finalAttempt?.verificationStatus !== "passed") {
    context.addIssue({
      code: "custom",
      path: ["conclusion"],
      message: "a succeeded Step requires a final passed verification",
    });
  }
});
export type RunStepHttpView = z.infer<typeof RunStepHttpViewSchema>;

export const RunViewHttpResponseSchema = z.strictObject({
  runId: RunIdSchema,
  projectionPosition: z.number().int().nonnegative(),
  status: RunStatusHttpSchema,
  steps: z.array(RunStepHttpViewSchema).max(500),
}).superRefine((run, context) => {
  const stepRunIds = new Set<string>();
  const attemptIds = new Set<string>();
  run.steps.forEach((step, index) => {
    if (stepRunIds.has(step.stepRunId)) {
      context.addIssue({ code: "custom", path: ["steps", index, "stepRunId"], message: "stepRunId must be unique within a Run" });
    }
    stepRunIds.add(step.stepRunId);
    step.attempts.forEach((attempt, attemptIndex) => {
      if (attemptIds.has(attempt.attemptId)) {
        context.addIssue({
          code: "custom",
          path: ["steps", index, "attempts", attemptIndex, "attemptId"],
          message: "attemptId must be unique within a Run",
        });
      }
      attemptIds.add(attempt.attemptId);
    });
  });
});
export type RunViewHttpResponse = z.infer<typeof RunViewHttpResponseSchema>;

export const RunEventEnvelopeHttpSchema = z.strictObject({
  schemaVersion: z.literal(1),
  position: z.number().int().positive(),
  runId: RunIdSchema,
  eventType: z.literal("run_projection_changed"),
});
export type RunEventEnvelopeHttp = z.infer<typeof RunEventEnvelopeHttpSchema>;

export const RunEventGapHttpSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: RunIdSchema,
  code: z.literal("EVENT_CURSOR_GAP"),
  retentionFloor: z.number().int().nonnegative(),
  highWaterPosition: z.number().int().nonnegative(),
  instructions: z.strictObject({
    snapshot: z.literal("reload_run_snapshot"),
    rebuild: z.literal("replace_run_projection_from_snapshot"),
    resume: z.literal("subscribe_after_high_water_position"),
  }),
}).refine((signal) => signal.retentionFloor <= signal.highWaterPosition, {
  message: "retentionFloor cannot exceed highWaterPosition",
});
export type RunEventGapHttp = z.infer<typeof RunEventGapHttpSchema>;

const ProjectNameSchema = z.string().trim().min(1).max(120);
const RequirementTitleSchema = z.string().trim().min(1).max(200);
const RequirementBodySchema = z.string().trim().min(1).max(20_000);
const RequirementListItemSchema = z.string().trim().min(1).max(1_000);

function requirementListSchema(minimumItems: number) {
  return z.array(RequirementListItemSchema).min(minimumItems).max(50).superRefine((items, context) => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      if (seen.has(item)) {
        context.addIssue({ code: "custom", path: [index], message: "requirement list items must be unique" });
      }
      seen.add(item);
    });
  });
}

const AcceptanceCriteriaSchema = requirementListSchema(1);
const RequirementConstraintsSchema = requirementListSchema(0);

const ChangeTitleSchema = z.string().trim().min(1).max(200);
const ChangeGoalSchema = z.string().trim().min(1).max(4_000);
const ChangeItemsSchema = requirementListSchema(0);
const ChangeAcceptanceCriteriaSchema = requirementListSchema(1);

export const SessionPolicyHttpSchema = z.enum(["reuse", "resume_if_supported", "new", "manual"]);
export const WorkspacePolicyHttpSchema = z.strictObject({
  mode: z.enum(["read", "write"]),
  isolation: z.enum(["shared_snapshot", "worktree", "single_writer"]),
  reuse: z.boolean(),
});
export const TaskDefinitionHttpSchema = z.strictObject({
  taskId: TaskIdSchema,
  title: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(4_000),
  acceptanceCriteria: ChangeAcceptanceCriteriaSchema,
  repositoryIds: z.array(RepositoryIdSchema).min(1).max(50),
  moduleScopes: requirementListSchema(1),
  dependsOn: z.array(TaskIdSchema).max(100),
  readSet: requirementListSchema(0),
  writeSet: requirementListSchema(0),
  access: z.enum(["read", "write"]),
  workflowRevisionId: WorkflowRevisionIdSchema,
  defaultAgentProfileId: AgentProfileIdSchema,
  sessionPolicy: SessionPolicyHttpSchema,
  workspacePolicy: WorkspacePolicyHttpSchema,
});
export type TaskDefinitionHttp = z.infer<typeof TaskDefinitionHttpSchema>;

const ParallelWriteWorkspacePolicyHttpSchema = z.strictObject({
  mode: z.literal("write"),
  isolation: z.literal("worktree"),
  reuse: z.literal(false),
});

export const ChangePlanningDefaultsHttpSchema = z.strictObject({
  repositoryIds: z.array(RepositoryIdSchema).min(1).max(50),
  workflowRevisionId: WorkflowRevisionIdSchema,
  defaultAgentProfileId: AgentProfileIdSchema,
  sessionPolicy: SessionPolicyHttpSchema,
  workspacePolicy: ParallelWriteWorkspacePolicyHttpSchema,
}).superRefine((defaults, context) => {
  if (new Set(defaults.repositoryIds).size !== defaults.repositoryIds.length) {
    context.addIssue({ code: "custom", path: ["repositoryIds"], message: "repositoryIds must be unique" });
  }
});
export type ChangePlanningDefaultsHttp = z.infer<typeof ChangePlanningDefaultsHttpSchema>;

export const PublishChangeHttpRequestSchema = z.strictObject({
  changeId: ChangeIdSchema,
  changeRevisionId: ChangeRevisionIdSchema,
  executionPlanId: ExecutionPlanIdSchema,
  title: ChangeTitleSchema,
  goal: ChangeGoalSchema,
  nonGoals: ChangeItemsSchema,
  requirementRevisionIds: z.array(RequirementRevisionIdSchema).min(1).max(50),
  repositoryIds: z.array(RepositoryIdSchema).min(1).max(50),
  acceptanceCriteria: ChangeAcceptanceCriteriaSchema,
  constraints: ChangeItemsSchema,
  risks: ChangeItemsSchema,
  dependsOnChangeRevisionIds: z.array(ChangeRevisionIdSchema).max(50),
  tasks: z.array(TaskDefinitionHttpSchema).min(1).max(100),
  expectedVersion: CommandMetadataSchema.shape.expectedVersion,
  idempotencyKey: CommandMetadataSchema.shape.idempotencyKey,
});
export type PublishChangeHttpRequest = z.infer<typeof PublishChangeHttpRequestSchema>;

export const PublishChangeHttpResponseSchema = z.strictObject({
  projectId: ProjectIdSchema,
  changeId: ChangeIdSchema,
  changeRevisionId: ChangeRevisionIdSchema,
  executionPlanId: ExecutionPlanIdSchema,
  status: z.literal("published"),
  taskGraphFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type PublishChangeHttpResponse = z.infer<typeof PublishChangeHttpResponseSchema>;

export const ProjectIdParamsSchema = z.strictObject({ projectId: ProjectIdSchema });
export const RequirementRevisionParamsSchema = z.strictObject({
  projectId: ProjectIdSchema,
  revisionId: RequirementRevisionIdSchema,
});

export const CreateProjectHttpRequestSchema = z.strictObject({
  projectId: ProjectIdSchema,
  name: ProjectNameSchema,
  expectedVersion: CommandMetadataSchema.shape.expectedVersion,
  idempotencyKey: CommandMetadataSchema.shape.idempotencyKey,
});
export type CreateProjectHttpRequest = z.infer<typeof CreateProjectHttpRequestSchema>;

export const CreateRequirementHttpRequestSchema = z.strictObject({
  requirementId: RequirementIdSchema,
  revisionId: RequirementRevisionIdSchema,
  title: RequirementTitleSchema,
  body: RequirementBodySchema,
  acceptanceCriteria: AcceptanceCriteriaSchema,
  constraints: RequirementConstraintsSchema,
  expectedVersion: CommandMetadataSchema.shape.expectedVersion,
  idempotencyKey: CommandMetadataSchema.shape.idempotencyKey,
});
export type CreateRequirementHttpRequest = z.infer<typeof CreateRequirementHttpRequestSchema>;

export const ApproveRequirementHttpRequestSchema = CommandMetadataSchema;
export type ApproveRequirementHttpRequest = z.infer<typeof ApproveRequirementHttpRequestSchema>;

export const ReplaceRequirementHttpRequestSchema = z
  .strictObject({
    title: RequirementTitleSchema.optional(),
    body: RequirementBodySchema.optional(),
    acceptanceCriteria: AcceptanceCriteriaSchema.optional(),
    constraints: RequirementConstraintsSchema.optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: "replacement content is required",
  });

export const ProjectSummaryHttpResponseSchema = z.strictObject({
  projectId: ProjectIdSchema,
  name: ProjectNameSchema,
});
export type ProjectSummaryHttpResponse = z.infer<typeof ProjectSummaryHttpResponseSchema>;

export const CreateProjectHttpResponseSchema = ProjectSummaryHttpResponseSchema.extend({
  authorization: z.literal("host_session_reissue_required"),
}).strict();
export type CreateProjectHttpResponse = z.infer<typeof CreateProjectHttpResponseSchema>;

export const RequirementRevisionHttpResponseSchema = z.strictObject({
  projectId: ProjectIdSchema,
  requirementId: RequirementIdSchema,
  revisionId: RequirementRevisionIdSchema,
  aggregateVersion: z.number().int().nonnegative(),
  title: RequirementTitleSchema,
  body: RequirementBodySchema,
  acceptanceCriteria: AcceptanceCriteriaSchema,
  constraints: RequirementConstraintsSchema,
  status: z.enum(["draft", "in_review", "approved", "superseded", "withdrawn"]),
  approvedAt: z.string().datetime({ offset: true }).optional(),
}).superRefine((revision, context) => {
  if (revision.status === "approved" && revision.approvedAt === undefined) {
    context.addIssue({ code: "custom", message: "approvedAt is required for approved revisions" });
  }
  if (revision.status !== "approved" && revision.approvedAt !== undefined) {
    context.addIssue({ code: "custom", message: "approvedAt is only valid for approved revisions" });
  }
});
export type RequirementRevisionHttpResponse = z.infer<typeof RequirementRevisionHttpResponseSchema>;

export const ProjectListHttpResponseSchema = z.strictObject({
  projects: z.array(ProjectSummaryHttpResponseSchema),
});
export type ProjectListHttpResponse = z.infer<typeof ProjectListHttpResponseSchema>;

export const ProjectDetailHttpResponseSchema = ProjectSummaryHttpResponseSchema.extend({
  requirements: z.array(RequirementRevisionHttpResponseSchema),
  planningDefaults: ChangePlanningDefaultsHttpSchema.optional(),
}).strict();
export type ProjectDetailHttpResponse = z.infer<typeof ProjectDetailHttpResponseSchema>;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const KnowledgeEntryBaseHttpSchema = z.strictObject({
  schemaVersion: z.literal(1),
  entryId: KnowledgeEntryIdSchema,
  status: z.enum(["active", "superseded", "withdrawn"]),
  scope: z.strictObject({ projectId: ProjectIdSchema }),
  summary: z.string().trim().min(1).max(500),
  body: z.string().trim().min(1).max(10_000),
});
export const KnowledgeEntryHttpSchema = z.discriminatedUnion("level", [
  KnowledgeEntryBaseHttpSchema.extend({
    level: z.literal("authoritative"),
    source: z.strictObject({
      type: z.literal("requirement_revision"),
      projectId: ProjectIdSchema,
      requirementRevisionId: RequirementRevisionIdSchema,
    }),
  }).strict(),
  KnowledgeEntryBaseHttpSchema.extend({
    level: z.literal("experiential"),
    confidence: z.strictObject({
      level: z.enum(["low", "medium", "high"]),
      rationale: z.string().trim().min(1).max(1_000),
    }),
    invalidationConditions: z.array(z.strictObject({
      condition: z.string().trim().min(1).max(1_000),
    })).min(1).max(32),
    source: z.strictObject({
      type: z.literal("evidence"),
      projectId: ProjectIdSchema,
      evidenceId: EvidenceIdSchema,
      contentHash: Sha256Schema,
    }),
  }).strict(),
  KnowledgeEntryBaseHttpSchema.extend({
    level: z.literal("historical"),
    source: z.strictObject({
      type: z.literal("archive"),
      projectId: ProjectIdSchema,
      runId: RunIdSchema,
      outcome: z.enum(["succeeded", "failed", "canceled"]),
      manifestSchemaVersion: z.literal(2),
      manifestHash: Sha256Schema,
      manifestRef: z.string().regex(/^cas:sha256:[a-f0-9]{64}$/u),
    }),
  }).strict(),
]);
export const KnowledgeHttpResponseSchema = z.strictObject({
  projectId: ProjectIdSchema,
  entries: z.array(KnowledgeEntryHttpSchema),
}).superRefine((response, context) => {
  response.entries.forEach((entry, index) => {
    if (
      entry.scope.projectId !== response.projectId
      || entry.source.projectId !== response.projectId
    ) {
      context.addIssue({
        code: "custom",
        path: ["entries", index, "scope"],
        message: "Knowledge entry must remain within the response Project",
      });
    }
    if (
      entry.level === "historical"
      && entry.source.manifestRef !== `cas:sha256:${entry.source.manifestHash}`
    ) {
      context.addIssue({
        code: "custom",
        path: ["entries", index, "source", "manifestRef"],
        message: "manifest reference digest must match manifest hash",
      });
    }
  });
});
export type KnowledgeHttpResponse = z.infer<typeof KnowledgeHttpResponseSchema>;
