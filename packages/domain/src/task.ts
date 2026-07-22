import { z } from "zod";

import {
  AgentProfileIdSchema,
  ChangeRevisionIdSchema,
  ExecutionPlanIdSchema,
  ProjectIdSchema,
  RepositoryIdSchema,
  RequirementRevisionIdSchema,
  TaskIdSchema,
  WorkflowRevisionIdSchema,
} from "./ids.js";
import type {
  AgentProfileId,
  ChangeRevisionId,
  ExecutionPlanId,
  ProjectId,
  RepositoryId,
  RequirementRevisionId,
  TaskId,
  WorkflowRevisionId,
} from "./ids.js";
import {
  assertUnique,
  canonicalSha256,
  compareCanonicalText,
  deepFreeze,
} from "./immutable.js";

export type SessionPolicy = "reuse" | "resume_if_supported" | "new" | "manual";

export interface WorkspacePolicy {
  readonly mode: "read" | "write";
  readonly isolation: "shared_snapshot" | "worktree" | "single_writer";
  readonly reuse: boolean;
}

export interface TaskDefinition {
  readonly taskId: TaskId;
  readonly title: string;
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly repositoryIds: readonly RepositoryId[];
  readonly moduleScopes: readonly string[];
  readonly dependsOn: readonly TaskId[];
  readonly readSet: readonly string[];
  readonly writeSet: readonly string[];
  readonly access: "read" | "write";
  readonly workflowRevisionId: WorkflowRevisionId;
  readonly defaultAgentProfileId: AgentProfileId;
  readonly sessionPolicy: SessionPolicy;
  readonly workspacePolicy: WorkspacePolicy;
}

export interface ExecutionPlan {
  readonly executionPlanId: ExecutionPlanId;
  readonly projectId: ProjectId;
  readonly changeRevisionId: ChangeRevisionId;
  readonly requirementRevisionIds: readonly RequirementRevisionId[];
  readonly tasks: readonly TaskDefinition[];
  readonly taskGraphFingerprint: string;
  readonly planFingerprint: string;
  readonly publishedAt: string;
}

export const SessionPolicySchema = z.enum(["reuse", "resume_if_supported", "new", "manual"]);

export const WorkspacePolicySchema = z
  .object({
    mode: z.enum(["read", "write"]),
    isolation: z.enum(["shared_snapshot", "worktree", "single_writer"]),
    reuse: z.boolean(),
  })
  .strict();

export const TaskDefinitionSchema = z
  .object({
    taskId: TaskIdSchema,
    title: z.string().trim().min(1),
    objective: z.string().trim().min(1),
    acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
    repositoryIds: z.array(RepositoryIdSchema).min(1),
    moduleScopes: z.array(z.string().trim().min(1)).min(1),
    dependsOn: z.array(TaskIdSchema),
    readSet: z.array(z.string().trim().min(1)),
    writeSet: z.array(z.string().trim().min(1)),
    access: z.enum(["read", "write"]),
    workflowRevisionId: WorkflowRevisionIdSchema,
    defaultAgentProfileId: AgentProfileIdSchema,
    sessionPolicy: SessionPolicySchema,
    workspacePolicy: WorkspacePolicySchema,
  })
  .strict();

const ExecutionPlanInputSchema = z
  .object({
    executionPlanId: ExecutionPlanIdSchema,
    projectId: ProjectIdSchema,
    changeRevisionId: ChangeRevisionIdSchema,
    requirementRevisionIds: z.array(RequirementRevisionIdSchema).min(1),
    tasks: z.array(TaskDefinitionSchema).min(1),
    publishedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const ExecutionPlanSchema = z
  .object({
    executionPlanId: ExecutionPlanIdSchema,
    projectId: ProjectIdSchema,
    changeRevisionId: ChangeRevisionIdSchema,
    requirementRevisionIds: z.array(RequirementRevisionIdSchema).min(1),
    tasks: z.array(TaskDefinitionSchema).min(1),
    taskGraphFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    planFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    publishedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((plan, context) => {
    try {
      const graph = validateTaskGraph(plan.tasks);
      if (graph.taskGraphFingerprint !== plan.taskGraphFingerprint) {
        context.addIssue({ code: "custom", message: "TASK_GRAPH_FINGERPRINT_MISMATCH" });
        return;
      }
      const expectedPlanFingerprint = canonicalSha256({
        executionPlanId: plan.executionPlanId,
        projectId: plan.projectId,
        changeRevisionId: plan.changeRevisionId,
        requirementRevisionIds: [...plan.requirementRevisionIds].sort(),
        tasks: graph.tasks,
        taskGraphFingerprint: graph.taskGraphFingerprint,
        publishedAt: plan.publishedAt,
      });
      if (expectedPlanFingerprint !== plan.planFingerprint) {
        context.addIssue({ code: "custom", message: "PLAN_FINGERPRINT_MISMATCH" });
      }
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "EXECUTION_PLAN_INVALID",
      });
    }
  });

function canonicalTask(task: TaskDefinition): TaskDefinition {
  return {
    ...task,
    acceptanceCriteria: [...task.acceptanceCriteria],
    repositoryIds: [...task.repositoryIds].sort(),
    moduleScopes: [...task.moduleScopes].sort(),
    dependsOn: [...task.dependsOn].sort(),
    readSet: [...task.readSet].sort(),
    writeSet: [...task.writeSet].sort(),
    workspacePolicy: { ...task.workspacePolicy },
  };
}

export function validateTaskGraph(input: unknown): {
  readonly tasks: readonly TaskDefinition[];
  readonly taskGraphFingerprint: string;
} {
  const parsed = z.array(TaskDefinitionSchema).min(1).parse(input);
  const taskIds = parsed.map(({ taskId }) => taskId);
  assertUnique(taskIds, "task_id");
  const knownIds = new Set(taskIds);

  for (const task of parsed) {
    assertUnique(task.acceptanceCriteria, "task_acceptance_criterion");
    assertUnique(task.repositoryIds, "task_repository");
    assertUnique(task.moduleScopes, "task_module_scope");
    assertUnique(task.dependsOn, "task_dependency");
    assertUnique(task.readSet, "task_read_set");
    assertUnique(task.writeSet, "task_write_set");
    if (task.dependsOn.includes(task.taskId)) throw new Error("TASK_GRAPH_CYCLE");
    if (task.dependsOn.some((dependency) => !knownIds.has(dependency))) {
      throw new Error("UNKNOWN_TASK_DEPENDENCY");
    }
    if (task.access === "write" && task.writeSet.length === 0) {
      throw new Error("WRITE_TASK_REQUIRES_WRITE_SET");
    }
    if (task.access === "read" && task.writeSet.length > 0) {
      throw new Error("READ_TASK_CANNOT_DECLARE_WRITE_SET");
    }
    if (task.workspacePolicy.mode !== task.access) {
      throw new Error("TASK_WORKSPACE_ACCESS_MISMATCH");
    }
  }

  const dependencies = new Map(parsed.map((task) => [task.taskId, task.dependsOn]));
  const visiting = new Set<TaskId>();
  const visited = new Set<TaskId>();
  const visit = (taskId: TaskId): void => {
    if (visiting.has(taskId)) throw new Error("TASK_GRAPH_CYCLE");
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependency of dependencies.get(taskId) ?? []) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const taskId of taskIds) visit(taskId);

  const tasks = parsed
    .map(canonicalTask)
    .sort((left, right) => compareCanonicalText(left.taskId, right.taskId));
  return deepFreeze({ tasks, taskGraphFingerprint: canonicalSha256(tasks) });
}

export function createExecutionPlan(input: unknown): Readonly<ExecutionPlan> {
  const parsed = ExecutionPlanInputSchema.parse(input);
  assertUnique(parsed.requirementRevisionIds, "plan_requirement_revision");
  const graph = validateTaskGraph(parsed.tasks);
  const common = {
    executionPlanId: parsed.executionPlanId,
    projectId: parsed.projectId,
    changeRevisionId: parsed.changeRevisionId,
    requirementRevisionIds: [...parsed.requirementRevisionIds].sort(),
    tasks: graph.tasks,
    taskGraphFingerprint: graph.taskGraphFingerprint,
  };
  const planFingerprint = canonicalSha256({ ...common, publishedAt: parsed.publishedAt });
  return deepFreeze(
    ExecutionPlanSchema.parse({ ...common, planFingerprint, publishedAt: parsed.publishedAt }),
  );
}
