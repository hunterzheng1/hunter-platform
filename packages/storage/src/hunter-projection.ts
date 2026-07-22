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
  StepActivated: { entityType: "StepRun", idField: "stepRunId" },
  StepConcluded: { entityType: "StepRun", idField: "stepRunId" },
  ExternalObservationRecorded: { entityType: "StepAttempt", idField: "attemptId" },
  VerificationChanged: { entityType: "StepAttempt", idField: "attemptId" },
  StepStatusChanged: { entityType: "StepRun", idField: "stepRunId" },
  AttemptAssigned: { entityType: "StepAttempt", idField: "attemptId" },
  AttemptStatusChanged: { entityType: "StepAttempt", idField: "attemptId" },
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
        rule.entityType,
        entityId,
        event.projectId,
        event.aggregateVersion,
        JSON.stringify(data),
        event.recordedAt,
      );
  }
}
