import type { DatabaseSync } from "node:sqlite";

import type { LedgerEvent } from "./event-ledger-reader.js";
import type { EventProjector } from "./projection-runner.js";

interface ProjectionRule {
  readonly entityType: string;
  readonly idField: string;
}

const RULES: Readonly<Record<string, ProjectionRule>> = {
  ProjectCreated: { entityType: "Project", idField: "projectId" },
  RepositoryBound: { entityType: "RepositoryBinding", idField: "repositoryId" },
  DeviceBound: { entityType: "DeviceBinding", idField: "deviceBindingId" },
  RequirementRevisionApproved: {
    entityType: "RequirementRevision",
    idField: "requirementRevisionId",
  },
  ChangePublished: { entityType: "ChangeRevision", idField: "changeRevisionId" },
  ChangeRevisionDefined: { entityType: "ChangeRevision", idField: "changeRevisionId" },
  ExecutionPlanPublished: { entityType: "ExecutionPlan", idField: "executionPlanId" },
  TaskGraphPublished: { entityType: "TaskGraph", idField: "executionPlanId" },
  WorkflowRevisionPublished: { entityType: "WorkflowRevision", idField: "workflowRevisionId" },
  AgentProfileDefined: { entityType: "AgentProfile", idField: "agentProfileId" },
  ProjectRunPolicyDefined: { entityType: "ProjectRunPolicy", idField: "projectId" },
  RunStarted: { entityType: "WorkflowRun", idField: "runId" },
  RunStatusChanged: { entityType: "WorkflowRun", idField: "runId" },
  RunConcluded: { entityType: "WorkflowRun", idField: "runId" },
  BudgetConsumed: { entityType: "WorkflowRun", idField: "runId" },
  RecoveryFactsRecorded: { entityType: "WorkflowRun", idField: "runId" },
  TaskFanOutDecided: { entityType: "WorkflowRun", idField: "runId" },
  ChildConclusionAccepted: { entityType: "WorkflowRun", idField: "runId" },
  SubflowConclusionAccepted: { entityType: "WorkflowRun", idField: "runId" },
  ChildCancellationRequested: { entityType: "WorkflowRun", idField: "runId" },
  AttemptCancellationRequested: { entityType: "WorkflowRun", idField: "runId" },
  AttemptCancellationAcknowledged: { entityType: "WorkflowRun", idField: "runId" },
  SupersedingRequirementDecided: { entityType: "WorkflowRun", idField: "runId" },
  SessionHandoffRequested: { entityType: "WorkflowRun", idField: "runId" },
  RetryScheduled: { entityType: "WorkflowRun", idField: "runId" },
  LoopActivated: { entityType: "WorkflowRun", idField: "runId" },
  DependencyFailureDecided: { entityType: "WorkflowRun", idField: "runId" },
  StepActivated: { entityType: "StepRun", idField: "stepRunId" },
  StepConcluded: { entityType: "StepRun", idField: "stepRunId" },
  ExternalObservationRecorded: { entityType: "StepAttempt", idField: "attemptId" },
  VerificationChanged: { entityType: "StepAttempt", idField: "attemptId" },
  StepStatusChanged: { entityType: "StepRun", idField: "stepRunId" },
  AttemptAssigned: { entityType: "StepAttempt", idField: "attemptId" },
  AttemptStatusChanged: { entityType: "StepAttempt", idField: "attemptId" },
  ExecutionFailed: { entityType: "StepAttempt", idField: "attemptId" },
  ExternalOperationObserved: { entityType: "OutboxOperation", idField: "operationId" },
  LeaseAcquired: { entityType: "Lease", idField: "leaseId" },
  LeaseChanged: { entityType: "Lease", idField: "leaseId" },
  RecoveryAttentionRequired: { entityType: "RecoveryAttention", idField: "attentionId" },
};

function eventObject(event: LedgerEvent): Record<string, unknown> {
  if (event.eventData === null || typeof event.eventData !== "object" || Array.isArray(event.eventData)) {
    throw new Error(`PROJECTION_EVENT_DATA_INVALID:${event.eventType}`);
  }
  return event.eventData as Record<string, unknown>;
}

export class HunterProjection implements EventProjector {
  public readonly name = "hunter";

  public constructor(public readonly version = 1) {
    if (!Number.isSafeInteger(version) || version <= 0) throw new Error("PROJECTOR_VERSION_INVALID");
  }

  public apply(database: DatabaseSync, event: LedgerEvent): void {
    const outer = eventObject(event);
    const wrapped = event.eventType === "FlowEvent" && outer.flowEvent !== null && typeof outer.flowEvent === "object" && !Array.isArray(outer.flowEvent)
      ? outer.flowEvent as Record<string, unknown>
      : null;
    const eventType = wrapped !== null && typeof wrapped.type === "string" ? wrapped.type : event.eventType;
    const rule = RULES[eventType];
    if (rule === undefined) return;
    const data = wrapped ?? outer;
    const binding = data.binding !== null && typeof data.binding === "object" && !Array.isArray(data.binding) ? data.binding as Record<string, unknown> : null;
    const aggregateRunId = event.aggregateId.startsWith("run:") ? event.aggregateId.slice(4) : undefined;
    const entityId = data[rule.idField] ?? binding?.[rule.idField] ?? (rule.entityType === "WorkflowRun" ? aggregateRunId : undefined);
    if (typeof entityId !== "string" || entityId.length === 0) {
      throw new Error(`PROJECTION_ENTITY_ID_MISSING:${eventType}:${rule.idField}`);
    }
    if (eventType === "StepActivated" && typeof data.attemptId === "string") {
      this.upsert(database, event, "StepAttempt", data.attemptId, {
        attemptId: data.attemptId,
        stepRunId: data.stepRunId,
        attemptNumber: data.attemptNumber,
        executionStatus: "assigned",
        verificationStatus: "pending",
      });
    }
    if ((eventType === "ExternalObservationRecorded" || eventType === "VerificationChanged" || eventType === "ExecutionFailed") && typeof data.stepRunId === "string") {
      const stepFragment = eventType === "VerificationChanged"
        ? { stepRunId: data.stepRunId, verificationStatus: data.status }
        : { stepRunId: data.stepRunId, executionStatus: eventType === "ExecutionFailed" ? "failed" : data.executionStatus };
      this.upsert(database, event, "StepRun", data.stepRunId, stepFragment, eventType);
    }
    this.upsert(database, event, rule.entityType, entityId, this.normalize(eventType, entityId, data), eventType);
  }

  private normalize(eventType: string, entityId: string, data: Record<string, unknown>): Record<string, unknown> {
    if (eventType === "RunStarted") return { ...data, runId: entityId, status: "running" };
    if (eventType === "StepActivated") return { ...data, conclusion: "active", executionStatus: "assigned", verificationStatus: "pending" };
    if (eventType === "StepConcluded") return { ...data, conclusion: data.conclusion };
    if (eventType === "ExternalObservationRecorded") return { ...data, executionStatus: data.executionStatus };
    if (eventType === "ExecutionFailed") return { ...data, executionStatus: "failed" };
    if (eventType === "VerificationChanged") return { ...data, verificationStatus: data.status };
    return data;
  }

  private upsert(database: DatabaseSync, event: LedgerEvent, entityType: string, entityId: string, fragment: Record<string, unknown>, eventType = "StepActivated"): void {
    const existing = database.prepare(
      "SELECT view_json FROM entity_views WHERE projector_name = ? AND entity_type = ? AND entity_id = ?",
    ).get(this.name, entityType, entityId) as { view_json: string } | undefined;
    const prior = existing === undefined ? {} : JSON.parse(existing.view_json) as Record<string, unknown>;
    let complete: Record<string, unknown> = { ...prior, ...fragment };
    if (entityType === "WorkflowRun" && eventType === "BudgetConsumed") {
      const usage = prior.budgetUsage !== null && typeof prior.budgetUsage === "object" && !Array.isArray(prior.budgetUsage) ? prior.budgetUsage as Record<string, number> : {};
      complete = { ...prior, budgetUsage: {
        attempts: (usage.attempts ?? 0) + Number(fragment.attempts ?? 0),
        elapsedMs: (usage.elapsedMs ?? 0) + Number(fragment.elapsedMs ?? 0),
        cost: (usage.cost ?? 0) + Number(fragment.cost ?? 0),
        tokens: (usage.tokens ?? 0) + Number(fragment.tokens ?? 0),
        loopIterations: (usage.loopIterations ?? 0) + Number(fragment.loopIterations ?? 0),
      } };
    }
    if (entityType === "WorkflowRun" && eventType === "TaskFanOutDecided") complete = { ...prior, scheduledChildren: [...(Array.isArray(prior.scheduledChildren) ? prior.scheduledChildren : []), ...(Array.isArray(fragment.children) ? fragment.children : [])] };
    if (entityType === "WorkflowRun" && (eventType === "ChildConclusionAccepted" || eventType === "SubflowConclusionAccepted")) complete = { ...prior, acceptedChildRunIds: [...(Array.isArray(prior.acceptedChildRunIds) ? prior.acceptedChildRunIds : []), fragment.childRunId] };
    if (entityType === "WorkflowRun" && eventType === "RecoveryFactsRecorded") complete = { ...prior, recoveryFacts: [...(Array.isArray(prior.recoveryFacts) ? prior.recoveryFacts : []), ...(Array.isArray(fragment.facts) ? fragment.facts : [])] };
    if (entityType === "WorkflowRun" && eventType === "DependencyFailureDecided") complete = { ...prior, dependencyFailureDecisions: [...(Array.isArray(prior.dependencyFailureDecisions) ? prior.dependencyFailureDecisions : []), fragment] };
    database
      .prepare(
        `INSERT INTO entity_views(
           projector_name, entity_type, entity_id, project_id,
           entity_version, view_json, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(projector_name, entity_type, entity_id) DO UPDATE SET
           project_id = excluded.project_id,
           entity_version = excluded.entity_version,
           view_json = excluded.view_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        this.name,
        entityType,
        entityId,
        event.projectId,
        event.aggregateVersion,
        JSON.stringify(complete),
        event.recordedAt,
      );
  }
}
