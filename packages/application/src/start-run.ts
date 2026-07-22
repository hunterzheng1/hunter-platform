import {
  ExecutionPlanIdSchema,
  RunIdSchema,
  WorkflowRevisionIdSchema,
  type ChangeRevision,
  type ChangeRevisionId,
  type ExecutionPlan,
  type ExecutionPlanId,
  type Project,
  type ProjectId,
  type RequirementRevision,
  type RequirementRevisionId,
  type WorkflowRevision,
  type WorkflowRevisionId,
} from "@hunter/domain";
import {
  createWorkflowRunBinding,
  type FlowCommandHandler,
  type PolicySnapshot,
  type RunBudgetLimit,
} from "@hunter/flow-engine";
import type { ActorContext } from "@hunter/storage";
import { z } from "zod";

export const StartRunPublicCommandSchema = z
  .object({
    runId: RunIdSchema,
    executionPlanId: ExecutionPlanIdSchema,
    workflowRevisionId: WorkflowRevisionIdSchema,
    expectedVersion: z.number().int().nonnegative(),
    idempotencyKey: z.string().trim().min(8).max(128),
  })
  .strict();
export type StartRunPublicCommand = z.infer<typeof StartRunPublicCommandSchema>;

export interface StartRunRepositories {
  getProject(projectId: ProjectId): Readonly<Project> | null;
  getExecutionPlan(executionPlanId: ExecutionPlanId): Readonly<ExecutionPlan> | null;
  getChangeRevision(changeRevisionId: ChangeRevisionId): Readonly<ChangeRevision> | null;
  getRequirementRevision(
    requirementRevisionId: RequirementRevisionId,
  ): Readonly<RequirementRevision> | null;
  getWorkflowRevision(workflowRevisionId: WorkflowRevisionId): Readonly<WorkflowRevision> | null;
  getEffectivePolicySnapshot(projectId: ProjectId): PolicySnapshot;
  getRunBudgetLimit(projectId: ProjectId, workflowRevisionId: WorkflowRevisionId): RunBudgetLimit;
}

export class StartRunService {
  public constructor(
    private readonly repositories: StartRunRepositories,
    private readonly flowEngine: FlowCommandHandler,
  ) {}

  public execute(commandInput: unknown, actor: ActorContext): unknown {
    const command = StartRunPublicCommandSchema.parse(commandInput);
    const plan = this.repositories.getExecutionPlan(command.executionPlanId);
    if (plan === null) throw new Error("EXECUTION_PLAN_NOT_FOUND");
    const project = this.repositories.getProject(plan.projectId);
    if (project === null) throw new Error("RUN_PROJECT_NOT_FOUND");
    const change = this.repositories.getChangeRevision(plan.changeRevisionId);
    if (change === null || change.status !== "published") throw new Error("CHANGE_REVISION_NOT_PUBLISHED");
    if (change.projectId !== plan.projectId) throw new Error("CHANGE_EXECUTION_PLAN_PROJECT_MISMATCH");
    if (
      canonicalIdSet(change.requirementRevisionIds) !== canonicalIdSet(plan.requirementRevisionIds)
    ) {
      throw new Error("CHANGE_EXECUTION_PLAN_REQUIREMENTS_MISMATCH");
    }
    for (const requirementRevisionId of plan.requirementRevisionIds) {
      const requirement = this.repositories.getRequirementRevision(requirementRevisionId);
      if (requirement === null) throw new Error("REQUIREMENT_REVISION_NOT_FOUND");
      if (requirement.status !== "approved") throw new Error("REQUIREMENT_REVISION_NOT_APPROVED");
      if (requirement.projectId !== plan.projectId) throw new Error("REQUIREMENT_REVISION_CROSS_PROJECT");
    }
    const workflow = this.repositories.getWorkflowRevision(command.workflowRevisionId);
    if (workflow === null || workflow.status !== "published") {
      throw new Error("WORKFLOW_REVISION_NOT_PUBLISHED");
    }
    const binding = createWorkflowRunBinding({
      runId: command.runId,
      projectId: plan.projectId,
      changeRevisionId: plan.changeRevisionId,
      requirementRevisionIds: plan.requirementRevisionIds,
      workflowRevisionId: workflow.workflowRevisionId,
      policySnapshot: this.repositories.getEffectivePolicySnapshot(plan.projectId),
      initialBudget: this.repositories.getRunBudgetLimit(plan.projectId, workflow.workflowRevisionId),
      subjectKind: "change",
      parentRunId: null,
      taskId: null,
      executionPlanId: plan.executionPlanId,
      taskGraphFingerprint: plan.taskGraphFingerprint,
    });
    return this.flowEngine.handle({
      type: "StartRun",
      binding,
      expectedVersion: command.expectedVersion,
      idempotencyKey: command.idempotencyKey,
      actor,
    }).response;
  }
}

function canonicalIdSet(values: readonly string[]): string {
  return JSON.stringify([...values].sort());
}
