import {
  AgentProfileIdSchema,
  ChangeIdSchema,
  ChangeRevisionIdSchema,
  ExecutionPlanIdSchema,
  ProjectIdSchema,
  RepositoryIdSchema,
  RequirementIdSchema,
  RequirementRevisionIdSchema,
  RunIdSchema,
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
