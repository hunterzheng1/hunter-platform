import {
  ChangeRevisionIdSchema,
  ExecutionPlanIdSchema,
  ProjectIdSchema,
  RequirementRevisionIdSchema,
  RunIdSchema,
  StepRunIdSchema,
  TaskIdSchema,
  WorkflowRevisionIdSchema,
  canonicalSha256,
  deepFreeze,
  type ChangeRevisionId,
  type ExecutionPlan,
  type ExecutionPlanId,
  type ProjectId,
  type RequirementRevisionId,
  type RunId,
  type StepRunId,
  type TaskId,
  type WorkflowRevisionId,
} from "@hunter/domain";
import { z } from "zod";

import { RunBudgetLimitSchema, type RunBudgetLimit } from "./run-budget.js";

export const PolicySnapshotSchema = z
  .object({
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
    policyVersion: z.number().int().positive(),
  })
  .strict();
export type PolicySnapshot = z.infer<typeof PolicySnapshotSchema>;

interface CommonRunBinding {
  readonly runId: RunId;
  readonly projectId: ProjectId;
  readonly changeRevisionId: ChangeRevisionId;
  readonly requirementRevisionIds: readonly RequirementRevisionId[];
  readonly workflowRevisionId: WorkflowRevisionId;
  readonly policySnapshot: PolicySnapshot;
  readonly initialBudget: RunBudgetLimit;
  readonly bindingFingerprint: string;
}

export type WorkflowRunBinding =
  | (CommonRunBinding & {
      readonly subjectKind: "change";
      readonly parentRunId: null;
      readonly taskId: null;
      readonly executionPlanId: ExecutionPlanId;
      readonly taskGraphFingerprint: string;
    })
  | (CommonRunBinding & {
      readonly subjectKind: "task";
      readonly parentRunId: RunId;
      readonly taskId: TaskId;
      readonly executionPlanId: ExecutionPlanId;
    })
  | (CommonRunBinding & {
      readonly subjectKind: "subflow";
      readonly parentRunId: RunId;
      readonly taskId: null;
      readonly executionPlanId: ExecutionPlanId;
      readonly parentStepRunId: StepRunId;
    });

const commonFields = {
  runId: RunIdSchema,
  projectId: ProjectIdSchema,
  changeRevisionId: ChangeRevisionIdSchema,
  requirementRevisionIds: z.array(RequirementRevisionIdSchema).min(1),
  workflowRevisionId: WorkflowRevisionIdSchema,
  policySnapshot: PolicySnapshotSchema,
  initialBudget: RunBudgetLimitSchema,
  bindingFingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
};

const WorkflowRunBindingInputSchema = z.discriminatedUnion("subjectKind", [
  z
    .object({
      ...commonFields,
      subjectKind: z.literal("change"),
      parentRunId: z.null(),
      taskId: z.null(),
      executionPlanId: ExecutionPlanIdSchema,
      taskGraphFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    })
    .strict(),
  z
    .object({
      ...commonFields,
      subjectKind: z.literal("task"),
      parentRunId: RunIdSchema,
      taskId: TaskIdSchema,
      executionPlanId: ExecutionPlanIdSchema,
    })
    .strict(),
  z
    .object({
      ...commonFields,
      subjectKind: z.literal("subflow"),
      parentRunId: RunIdSchema,
      taskId: z.null(),
      executionPlanId: ExecutionPlanIdSchema,
      parentStepRunId: StepRunIdSchema,
    })
    .strict(),
]);

export interface RunBindingContext {
  readonly parent?: WorkflowRunBinding | undefined;
  readonly executionPlan: Readonly<ExecutionPlan>;
  readonly activeTaskIds: readonly TaskId[];
  readonly parentTerminal: boolean;
  readonly childBudgetAllocation?: RunBudgetLimit | undefined;
}

function sameFrozenContext(child: WorkflowRunBinding, parent: WorkflowRunBinding): boolean {
  return (
    child.parentRunId === parent.runId &&
    child.projectId === parent.projectId &&
    child.changeRevisionId === parent.changeRevisionId &&
    child.executionPlanId === parent.executionPlanId &&
    canonicalSha256([...child.requirementRevisionIds].sort()) ===
      canonicalSha256([...parent.requirementRevisionIds].sort()) &&
    canonicalSha256(child.policySnapshot) === canonicalSha256(parent.policySnapshot)
  );
}

export function createWorkflowRunBinding(
  input: unknown,
  context?: RunBindingContext,
): Readonly<WorkflowRunBinding> {
  const parsed = WorkflowRunBindingInputSchema.parse(input);
  if (new Set(parsed.requirementRevisionIds).size !== parsed.requirementRevisionIds.length) {
    throw new Error("DUPLICATE_RUN_REQUIREMENT_REVISION");
  }
  const { bindingFingerprint: suppliedFingerprint, ...unsigned } = parsed;
  const canonicalUnsigned = {
    ...unsigned,
    requirementRevisionIds: [...unsigned.requirementRevisionIds].sort(),
    policySnapshot: { ...unsigned.policySnapshot },
    initialBudget: { ...unsigned.initialBudget },
  };
  const bindingFingerprint = canonicalSha256(canonicalUnsigned);
  if (suppliedFingerprint !== undefined && suppliedFingerprint !== bindingFingerprint) {
    throw new Error("RUN_BINDING_FINGERPRINT_MISMATCH");
  }
  const binding = { ...canonicalUnsigned, bindingFingerprint } as WorkflowRunBinding;

  if (binding.subjectKind !== "change") {
    if (context?.parent === undefined) throw new Error("ORPHAN_CHILD_RUN");
    if (context.parentTerminal) throw new Error("PARENT_RUN_TERMINAL");
    if (!sameFrozenContext(binding, context.parent)) throw new Error("CHILD_RUN_CONTEXT_MISMATCH");
    if (context.childBudgetAllocation === undefined || canonicalSha256(binding.initialBudget) !== canonicalSha256(context.childBudgetAllocation)) {
      throw new Error("CHILD_RUN_BUDGET_ALLOCATION_MISMATCH");
    }
    if (context.executionPlan.executionPlanId !== binding.executionPlanId) {
      throw new Error("CHILD_EXECUTION_PLAN_MISMATCH");
    }
    if (binding.subjectKind === "task") {
      const task = context.executionPlan.tasks.find(({ taskId }) => taskId === binding.taskId);
      if (task === undefined) throw new Error("TASK_NOT_IN_PARENT_EXECUTION_PLAN");
      if (task.workflowRevisionId !== binding.workflowRevisionId) {
        throw new Error("TASK_WORKFLOW_REVISION_MISMATCH");
      }
      if (context.activeTaskIds.includes(binding.taskId)) throw new Error("TASK_CHILD_ALREADY_ACTIVE");
    }
  }
  return deepFreeze(binding);
}
