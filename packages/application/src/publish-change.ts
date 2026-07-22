import {
  ChangeRevisionSchema,
  ExecutionPlanIdSchema,
  ExecutionPlanSchema,
  TaskDefinitionSchema,
  ChangeRevisionIdSchema,
  canonicalSha256,
  createChangeRevision,
  createExecutionPlan,
  validateTaskGraph,
  type ChangeRevision,
  type ExecutionPlan,
} from "@hunter/domain";
import type { ActorContext, CommandReceipt, CommitCommand } from "@hunter/storage";
import { z } from "zod";

import type { PublishChangeRepositories } from "./repositories.js";

export const PublishChangeCommandSchema = z
  .object({
    changeRevisionId: ChangeRevisionIdSchema,
    executionPlanId: ExecutionPlanIdSchema,
    tasks: z.array(TaskDefinitionSchema).min(1),
    expectedVersion: z.number().int().nonnegative(),
    idempotencyKey: z.string().trim().min(8).max(128),
  })
  .strict();
export type PublishChangeCommand = z.infer<typeof PublishChangeCommandSchema>;

export interface PublishChangeResult {
  readonly changeRevision: Readonly<ChangeRevision>;
  readonly executionPlan: Readonly<ExecutionPlan>;
}

export interface CommandJournal {
  commitCommand(command: CommitCommand): CommandReceipt;
}

const PublishChangeReceiptSchema = z
  .object({
    changeRevision: ChangeRevisionSchema,
    executionPlan: ExecutionPlanSchema,
  })
  .strict();

function parseResult(input: unknown): PublishChangeResult {
  const parsed = PublishChangeReceiptSchema.parse(input);
  const changeRevision = createChangeRevision(parsed.changeRevision);
  const executionPlan = createExecutionPlan({
    executionPlanId: parsed.executionPlan.executionPlanId,
    projectId: parsed.executionPlan.projectId,
    changeRevisionId: parsed.executionPlan.changeRevisionId,
    requirementRevisionIds: parsed.executionPlan.requirementRevisionIds,
    tasks: parsed.executionPlan.tasks,
    publishedAt: parsed.executionPlan.publishedAt,
  });
  if (
    executionPlan.taskGraphFingerprint !== parsed.executionPlan.taskGraphFingerprint ||
    executionPlan.planFingerprint !== parsed.executionPlan.planFingerprint
  ) {
    throw new Error("STORED_EXECUTION_PLAN_FINGERPRINT_MISMATCH");
  }
  return { changeRevision, executionPlan };
}

export class PublishChangeService {
  public constructor(
    private readonly repositories: PublishChangeRepositories,
    private readonly journal: CommandJournal,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public execute(commandInput: unknown, actor: ActorContext): PublishChangeResult {
    const command = PublishChangeCommandSchema.parse(commandInput);
    const source = this.repositories.getChangeRevision(command.changeRevisionId);
    if (source === null) throw new Error("CHANGE_REVISION_NOT_FOUND");
    const project = this.repositories.getProject(source.projectId);
    if (project === null) throw new Error("CHANGE_PROJECT_NOT_FOUND");

    const boundRepositories = new Set(project.repositoryBindings.map(({ repositoryId }) => repositoryId));
    for (const repositoryId of source.repositoryIds) {
      if (!boundRepositories.has(repositoryId)) throw new Error("CHANGE_REPOSITORY_NOT_BOUND_TO_PROJECT");
    }
    for (const requirementRevisionId of source.requirementRevisionIds) {
      const requirement = this.repositories.getRequirementRevision(requirementRevisionId);
      if (requirement === null) throw new Error("REQUIREMENT_REVISION_NOT_FOUND");
      if (requirement.status !== "approved") throw new Error("REQUIREMENT_REVISION_NOT_APPROVED");
      if (requirement.projectId !== source.projectId) throw new Error("REQUIREMENT_REVISION_CROSS_PROJECT");
    }
    for (const dependencyId of source.dependsOnChangeRevisionIds) {
      const dependency = this.repositories.getChangeRevision(dependencyId);
      if (dependency === null) throw new Error("CHANGE_DEPENDENCY_NOT_FOUND");
      if (dependency.status !== "published") throw new Error("CHANGE_DEPENDENCY_NOT_PUBLISHED");
      if (dependency.projectId !== source.projectId) throw new Error("CHANGE_DEPENDENCY_CROSS_PROJECT");
    }

    const graph = validateTaskGraph(command.tasks);
    const changeRepositoryIds = new Set(source.repositoryIds);
    for (const task of graph.tasks) {
      if (task.repositoryIds.some((repositoryId) => !changeRepositoryIds.has(repositoryId))) {
        throw new Error("TASK_REPOSITORY_OUTSIDE_CHANGE_SCOPE");
      }
      const workflow = this.repositories.getWorkflowRevision(task.workflowRevisionId);
      if (workflow === null || workflow.status !== "published") {
        throw new Error("WORKFLOW_REVISION_NOT_PUBLISHED");
      }
      const profile = this.repositories.getAgentProfile(task.defaultAgentProfileId);
      if (profile === null || profile.status !== "active") throw new Error("AGENT_PROFILE_NOT_ACTIVE");
      if (profile.projectId !== source.projectId) throw new Error("AGENT_PROFILE_CROSS_PROJECT");
    }

    const existingPlan = this.repositories.getExecutionPlanForChangeRevision(source.revisionId);
    const publishedAt =
      source.status === "published"
        ? source.publishedAt
        : source.status === "draft"
          ? this.now().toISOString()
          : undefined;
    if (publishedAt === undefined) throw new Error("CHANGE_REVISION_NOT_PUBLISHABLE");
    const changeRevision =
      source.status === "published"
        ? createChangeRevision(source)
        : createChangeRevision({ ...source, status: "published", publishedAt });
    const executionPlan = createExecutionPlan({
      executionPlanId: command.executionPlanId,
      projectId: source.projectId,
      changeRevisionId: source.revisionId,
      requirementRevisionIds: source.requirementRevisionIds,
      tasks: graph.tasks,
      publishedAt: existingPlan?.publishedAt ?? publishedAt,
    });

    if (source.status === "published") {
      if (
        existingPlan === null ||
        existingPlan.executionPlanId !== executionPlan.executionPlanId ||
        existingPlan.planFingerprint !== executionPlan.planFingerprint ||
        canonicalSha256(source) !== canonicalSha256(changeRevision)
      ) {
        throw new Error("PUBLISHED_CONTENT_MISMATCH");
      }
      return { changeRevision, executionPlan };
    }
    if (existingPlan !== null) throw new Error("DRAFT_CHANGE_HAS_EXISTING_EXECUTION_PLAN");

    const response: PublishChangeResult = { changeRevision, executionPlan };
    const requestFingerprint = canonicalSha256(response);
    const eventSuffix = canonicalSha256(command.idempotencyKey).slice(0, 24);
    const receipt = this.journal.commitCommand({
      commandId: `publish-change:${command.idempotencyKey}`,
      requestFingerprint,
      projectId: source.projectId,
      aggregateId: `change:${source.revisionId}`,
      expectedVersion: command.expectedVersion,
      actor,
      events: [
        {
          eventId: `evt_change_published_${eventSuffix}`,
          eventType: "ChangePublished",
          eventData: {
            changeRevisionId: changeRevision.revisionId,
            changeRevision,
            contentFingerprint: canonicalSha256(changeRevision),
          },
          schemaVersion: 1,
          occurredAt: publishedAt,
        },
        {
          eventId: `evt_plan_published_${eventSuffix}`,
          eventType: "ExecutionPlanPublished",
          eventData: {
            executionPlanId: executionPlan.executionPlanId,
            executionPlan,
            planFingerprint: executionPlan.planFingerprint,
          },
          schemaVersion: 1,
          occurredAt: publishedAt,
        },
      ],
      operations: [],
      response,
    });
    return parseResult(receipt.response);
  }
}
