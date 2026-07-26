import type {
  AgentProfileId,
  ChangeRevision,
  ChangeRevisionId,
  ExecutionPlan,
  ExecutionPlanId,
  Project,
  ProjectId,
  RequirementRevision,
  RequirementRevisionId,
  WorkflowRevision,
  WorkflowRevisionId,
} from "@hunter/domain";

export interface AgentProfileRecord {
  readonly agentProfileId: AgentProfileId;
  readonly projectId: ProjectId;
  readonly status: "active" | "disabled";
}

export interface PublishChangeRepositories {
  getProject(projectId: ProjectId): Readonly<Project> | null;
  getChangeRevision(revisionId: ChangeRevisionId): Readonly<ChangeRevision> | null;
  getRequirementRevision(
    revisionId: RequirementRevisionId,
  ): Readonly<RequirementRevision> | null;
  getExecutionPlanForChangeRevision(revisionId: ChangeRevisionId): Readonly<ExecutionPlan> | null;
  getExecutionPlanWorkflowRevisionId(
    executionPlanId: ExecutionPlanId,
  ): WorkflowRevisionId | null;
  getWorkflowRevision(revisionId: WorkflowRevisionId): Readonly<WorkflowRevision> | null;
  getAgentProfile(profileId: AgentProfileId): Readonly<AgentProfileRecord> | null;
}
