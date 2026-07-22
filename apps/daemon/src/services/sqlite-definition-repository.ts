import type { DatabaseSync } from "node:sqlite";

import {
  AgentProfileIdSchema,
  ProjectIdSchema,
  createChangeRevision,
  createExecutionPlan,
  createProject,
  createRequirementRevision,
  createWorkflowRevision,
  type AgentProfileId,
  type ChangeRevision,
  type ChangeRevisionId,
  type ExecutionPlan,
  type ExecutionPlanId,
  type Project,
  type ProjectId,
  type RequirementRevision,
  type RequirementRevisionId,
  type TaskId,
  type WorkflowRevision,
  type WorkflowRevisionId,
} from "@hunter/domain";
import {
  PolicySnapshotSchema,
  RunBudgetLimitSchema,
  FrozenDependencyFailureRuleSchema,
  type FrozenDependencyFailureRule,
  type PolicySnapshot,
  type RunBudgetLimit,
} from "@hunter/flow-engine";

import type { AgentProfileRecord } from "@hunter/application";

interface EventRow {
  readonly event_type: string;
  readonly event_data: string;
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

export class SqliteDefinitionRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public getProject(projectId: ProjectId): Readonly<Project> | null {
    return this.latest(["ProjectCreated"], (data) => {
      const project = createProject(object(data, "PROJECT_EVENT_INVALID").project);
      return project.projectId === projectId ? project : null;
    });
  }

  public getRequirementRevision(revisionId: RequirementRevisionId): Readonly<RequirementRevision> | null {
    return this.latest(["RequirementRevisionApproved"], (data) => {
      const revision = createRequirementRevision(object(data, "REQUIREMENT_EVENT_INVALID").requirementRevision);
      return revision.revisionId === revisionId ? revision : null;
    });
  }

  public getChangeRevision(revisionId: ChangeRevisionId): Readonly<ChangeRevision> | null {
    return this.latest(["ChangePublished", "ChangeRevisionDefined"], (data, eventType) => {
      const record = object(data, "CHANGE_EVENT_INVALID");
      const revision = createChangeRevision(eventType === "ChangePublished" ? record.changeRevision : record.changeRevision);
      return revision.revisionId === revisionId ? revision : null;
    });
  }

  public getExecutionPlan(executionPlanId: ExecutionPlanId | string): Readonly<ExecutionPlan> | null {
    return this.latest(["ExecutionPlanPublished"], (data) => {
      const stored = object(object(data, "EXECUTION_PLAN_EVENT_INVALID").executionPlan, "EXECUTION_PLAN_INVALID") as unknown as ExecutionPlan;
      const plan = createExecutionPlan({
        executionPlanId: stored.executionPlanId,
        projectId: stored.projectId,
        changeRevisionId: stored.changeRevisionId,
        requirementRevisionIds: stored.requirementRevisionIds,
        tasks: stored.tasks,
        publishedAt: stored.publishedAt,
      });
      if (plan.taskGraphFingerprint !== stored.taskGraphFingerprint || plan.planFingerprint !== stored.planFingerprint) {
        throw new Error("EXECUTION_PLAN_FINGERPRINT_MISMATCH");
      }
      return plan.executionPlanId === executionPlanId ? plan : null;
    });
  }

  public getExecutionPlanForChangeRevision(revisionId: ChangeRevisionId): Readonly<ExecutionPlan> | null {
    return this.latest(["ExecutionPlanPublished"], (data) => {
      const stored = object(object(data, "EXECUTION_PLAN_EVENT_INVALID").executionPlan, "EXECUTION_PLAN_INVALID") as unknown as ExecutionPlan;
      if (stored.changeRevisionId !== revisionId) return null;
      return this.getExecutionPlan(stored.executionPlanId);
    });
  }

  public getWorkflowRevision(revisionId: WorkflowRevisionId | string): Readonly<WorkflowRevision> | null {
    return this.latest(["WorkflowRevisionPublished"], (data) => {
      const stored = object(object(data, "WORKFLOW_EVENT_INVALID").workflowRevision, "WORKFLOW_REVISION_INVALID") as unknown as WorkflowRevision;
      const { workflowFingerprint, ...input } = stored;
      const workflow = createWorkflowRevision(input);
      if (workflow.workflowFingerprint !== workflowFingerprint) throw new Error("WORKFLOW_FINGERPRINT_MISMATCH");
      return workflow.workflowRevisionId === revisionId ? workflow : null;
    });
  }

  public getAgentProfile(profileId: AgentProfileId): Readonly<AgentProfileRecord> | null {
    return this.latest(["AgentProfileDefined"], (data) => {
      const stored = object(object(data, "AGENT_PROFILE_EVENT_INVALID").agentProfile, "AGENT_PROFILE_INVALID");
      const profile: AgentProfileRecord = {
        agentProfileId: AgentProfileIdSchema.parse(stored.agentProfileId),
        projectId: ProjectIdSchema.parse(stored.projectId),
        status: stored.status === "active" || stored.status === "disabled" ? stored.status : (() => { throw new Error("AGENT_PROFILE_STATUS_INVALID"); })(),
      };
      return profile.agentProfileId === profileId ? profile : null;
    });
  }

  public getEffectivePolicySnapshot(projectId: ProjectId): PolicySnapshot {
    const policy = this.latest(["ProjectRunPolicyDefined"], (data) => {
      const stored = object(data, "PROJECT_POLICY_EVENT_INVALID");
      return ProjectIdSchema.parse(stored.projectId) === projectId ? PolicySnapshotSchema.parse(stored.policySnapshot) : null;
    });
    if (policy === null) throw new Error("PROJECT_POLICY_NOT_FOUND");
    return policy;
  }

  public getRunBudgetLimit(projectId: ProjectId, workflowRevisionId: WorkflowRevisionId): RunBudgetLimit {
    void workflowRevisionId;
    const budget = this.latest(["ProjectRunPolicyDefined"], (data) => {
      const stored = object(data, "PROJECT_POLICY_EVENT_INVALID");
      return ProjectIdSchema.parse(stored.projectId) === projectId ? RunBudgetLimitSchema.parse(stored.budgetLimit) : null;
    });
    if (budget === null) throw new Error("PROJECT_RUN_BUDGET_NOT_FOUND");
    return budget;
  }

  public getDependencyFailureRule(executionPlanId: string, taskId: TaskId): Readonly<FrozenDependencyFailureRule> | null {
    const plan = this.getExecutionPlan(executionPlanId);
    if (plan === null || !plan.tasks.some((task) => task.taskId === taskId)) return null;
    return this.latest(["ProjectRunPolicyDefined"], (data) => {
      const rules = object(data, "PROJECT_POLICY_EVENT_INVALID").dependencyFailureRules;
      if (rules === undefined) return null;
      const rule = object(rules, "DEPENDENCY_FAILURE_RULES_INVALID")[taskId];
      if (rule === undefined) return null;
      return FrozenDependencyFailureRuleSchema.parse(rule) as FrozenDependencyFailureRule;
    });
  }

  private latest<T>(eventTypes: readonly string[], decode: (data: unknown, eventType: string) => T | null): T | null {
    const placeholders = eventTypes.map(() => "?").join(",");
    const rows = this.database.prepare(
      `SELECT event_type, event_data FROM events WHERE event_type IN (${placeholders}) ORDER BY position DESC`,
    ).all(...eventTypes) as unknown as EventRow[];
    for (const row of rows) {
      const value = decode(JSON.parse(row.event_data) as unknown, row.event_type);
      if (value !== null) return value;
    }
    return null;
  }
}
