import { DatabaseSync } from "node:sqlite";

import { ProjectIdSchema } from "@hunter/domain";
import { afterEach, describe, expect, it } from "vitest";

import { HunterProjection } from "./hunter-projection.js";
import { ProjectionRunner } from "./projection-runner.js";
import { SqliteOperationJournal } from "./sqlite-operation-journal.js";

const projectId = ProjectIdSchema.parse("prj_platform01");

const projectionEvents = [
  ["ProjectCreated", { projectId, name: "Hunter" }],
  ["RepositoryBound", { repositoryId: "rep_primary01", role: "primary" }],
  ["DeviceBound", { deviceBindingId: "dev_binding01", repositoryId: "rep_primary01" }],
  ["RequirementRevisionApproved", { requirementRevisionId: "rrv_revision01", status: "approved" }],
  ["ChangePublished", { changeRevisionId: "crv_revision01", status: "published" }],
  ["ExecutionPlanPublished", { executionPlanId: "epl_plan0001", fingerprint: "a".repeat(64) }],
  ["TaskGraphPublished", { executionPlanId: "epl_plan0001", taskCount: 2 }],
  ["RunStarted", { runId: "run_foundation1", status: "running" }],
  ["StepActivated", { stepRunId: "spr_step00001", status: "active" }],
  ["AttemptAssigned", { attemptId: "att_attempt001", status: "assigned" }],
  ["ExternalOperationObserved", { operationId: "opn_prepare001", status: "completed" }],
  ["LeaseAcquired", { leaseId: "wsl_workspace1", status: "active" }],
  ["RecoveryAttentionRequired", { attentionId: "rcv_attention1", status: "needs_attention" }],
] as const;

function seed(journal: SqliteOperationJournal): void {
  projectionEvents.forEach(([eventType, eventData], index) => {
    journal.commitCommand({
      commandId: `cmd_projection_${String(index).padStart(4, "0")}`,
      requestFingerprint: index.toString(16).padStart(64, "0"),
      projectId,
      aggregateId: `aggregate:${index}`,
      expectedVersion: 0,
      actor: { actorId: "test", correlationId: "projection-test" },
      events: [
        {
          eventId: `evt_projection_${String(index).padStart(4, "0")}`,
          eventType,
          eventData,
          schemaVersion: 1,
          occurredAt: `2026-07-22T00:00:${String(index).padStart(2, "0")}.000Z`,
        },
      ],
      operations: [],
      response: { accepted: true },
    });
  });
}

describe("ProjectionRunner", () => {
  let database: DatabaseSync | undefined;
  afterEach(() => database?.close());

  function setup(version = 1) {
    database = new DatabaseSync(":memory:");
    const journal = new SqliteOperationJournal(database);
    seed(journal);
    const runner = new ProjectionRunner(database, [new HunterProjection(version)]);
    return { database, runner };
  }

  it("incrementally projects every canonical Foundation query entity in global order", () => {
    const { runner } = setup();
    expect(runner.runIncremental(5)).toEqual({ applied: 5, highWaterPosition: 5 });
    expect(runner.runIncremental(20)).toEqual({ applied: 8, highWaterPosition: 13 });

    const snapshot = runner.snapshot("hunter");
    expect(snapshot.map(({ entityType }) => entityType).sort()).toEqual(
      [
        "ChangeRevision",
        "DeviceBinding",
        "ExecutionPlan",
        "Lease",
        "OutboxOperation",
        "Project",
        "RecoveryAttention",
        "RepositoryBinding",
        "RequirementRevision",
        "StepAttempt",
        "StepRun",
        "TaskGraph",
        "WorkflowRun",
      ].sort(),
    );
    expect(runner.runIncremental()).toEqual({ applied: 0, highWaterPosition: 13 });
    expect(runner.snapshot("hunter")).toEqual(snapshot);
  });

  it("produces identical snapshots after two clean full rebuilds", () => {
    const { runner } = setup();
    runner.rebuild("hunter");
    const first = runner.snapshot("hunter");
    runner.rebuild("hunter");
    expect(runner.snapshot("hunter")).toEqual(first);
  });

  it("reduces wrapped Flow fragments into complete Run, Step, and Attempt views", () => {
    database = new DatabaseSync(":memory:");
    const journal = new SqliteOperationJournal(database);
    const events = [
      { type: "RunStarted", binding: { runId: "run_complete01", projectId, bindingFingerprint: "a".repeat(64) } },
      { type: "StepActivated", stepRunId: "spr_complete01", stepId: "stp_complete01", attemptId: "att_complete01", attemptNumber: 1, fixedContentHash: "b".repeat(64) },
      { type: "AttemptAssigned", attemptId: "att_complete01", operationId: "opn_complete01", capabilityProbeReceiptId: "cpr_complete01", leaseIds: ["wsl_complete01"] },
      { type: "ExternalObservationRecorded", stepRunId: "spr_complete01", attemptId: "att_complete01", fact: "agent_returned", executionStatus: "returned" },
      { type: "VerificationChanged", stepRunId: "spr_complete01", attemptId: "att_complete01", status: "passed", evidenceFingerprint: "c".repeat(64) },
      { type: "StepConcluded", stepRunId: "spr_complete01", conclusion: "succeeded" },
      { type: "RunConcluded", status: "succeeded" },
    ];
    events.forEach((flowEvent, index) => journal.commitCommand({
      commandId: `cmd_complete_${index}`,
      requestFingerprint: String(index).padStart(64, "0"),
      projectId,
      aggregateId: "run:run_complete01",
      expectedVersion: index,
      actor: { actorId: "test", correlationId: "complete-projection" },
      events: [{ eventId: `evt_complete_${index}`, eventType: "FlowEvent", eventData: { flowEvent }, schemaVersion: 1, occurredAt: `2026-07-22T01:00:0${index}.000Z` }],
      operations: [],
      response: { accepted: true },
    }));
    const runner = new ProjectionRunner(database, [new HunterProjection()]);
    runner.rebuild("hunter");
    const byType = new Map(runner.snapshot("hunter").map((view) => [view.entityType, view.view]));
    expect(byType.get("WorkflowRun")).toMatchObject({ runId: "run_complete01", status: "succeeded", binding: { bindingFingerprint: "a".repeat(64) } });
    expect(byType.get("StepRun")).toMatchObject({ stepRunId: "spr_complete01", attemptId: "att_complete01", fixedContentHash: "b".repeat(64), executionStatus: "returned", verificationStatus: "passed", conclusion: "succeeded" });
    expect(byType.get("StepAttempt")).toMatchObject({ attemptId: "att_complete01", operationId: "opn_complete01", executionStatus: "returned", verificationStatus: "passed" });
  });

  it("projects execution failure onto both the Step and its current Attempt", () => {
    database = new DatabaseSync(":memory:");
    const journal = new SqliteOperationJournal(database);
    const events = [
      { type: "RunStarted", binding: { runId: "run_failure001", projectId, bindingFingerprint: "d".repeat(64) } },
      { type: "StepActivated", stepRunId: "spr_failure001", stepId: "stp_failure001", attemptId: "att_failure001", attemptNumber: 1, fixedContentHash: "e".repeat(64) },
      { type: "ExecutionFailed", stepRunId: "spr_failure001", attemptId: "att_failure001", errorClass: "runtime_failed" },
    ];
    events.forEach((flowEvent, index) => journal.commitCommand({
      commandId: `cmd_failure_${index}`,
      requestFingerprint: String(index + 20).padStart(64, "0"),
      projectId,
      aggregateId: "run:run_failure001",
      expectedVersion: index,
      actor: { actorId: "test", correlationId: "failure-projection" },
      events: [{ eventId: `evt_failure_${index}`, eventType: "FlowEvent", eventData: { flowEvent }, schemaVersion: 1, occurredAt: `2026-07-22T01:01:0${index}.000Z` }],
      operations: [],
      response: { accepted: true },
    }));
    const runner = new ProjectionRunner(database, [new HunterProjection()]);
    runner.rebuild("hunter");
    const views = runner.snapshot("hunter");
    expect(views.find(({ entityType }) => entityType === "StepRun")?.view).toMatchObject({ stepRunId: "spr_failure001", executionStatus: "failed" });
    expect(views.find(({ entityType }) => entityType === "StepAttempt")?.view).toMatchObject({ attemptId: "att_failure001", executionStatus: "failed", errorClass: "runtime_failed" });
  });

  it("resets stale views and checkpoint when projector code version changes", () => {
    const { database: db, runner } = setup(1);
    runner.runIncremental();
    db.prepare(
      `INSERT INTO entity_views(
         projector_name, entity_type, entity_id, project_id, entity_version, view_json, updated_at
       ) VALUES ('hunter', 'Stale', 'stale', ?, 1, '{}', '2026-07-22T00:00:00.000Z')`,
    ).run(projectId);

    const upgraded = new ProjectionRunner(db, [new HunterProjection(2)]);
    expect(upgraded.runIncremental(100)).toEqual({ applied: 13, highWaterPosition: 13 });
    expect(upgraded.snapshot("hunter").some(({ entityType }) => entityType === "Stale")).toBe(false);
    expect(db.prepare("SELECT projector_version, last_position FROM projection_checkpoints").get()).toEqual({
      projector_version: 2,
      last_position: 13,
    });
  });
});
