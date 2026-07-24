import { DatabaseSync } from "node:sqlite";

import {
  AttemptIdSchema,
  ExecutionPlanIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  StepIdSchema,
  StepRunIdSchema,
  WorkflowRevisionIdSchema,
} from "@hunter/domain";
import {
  createWorkflowRunBinding,
  type FlowDefinitions,
  type FlowStore,
  type WorkflowRunState,
} from "@hunter/flow-engine";
import type { SqliteOperationJournal } from "@hunter/storage";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSqliteRunViewService } from "../src/services/sqlite-run-view.js";

const ids = {
  project: ProjectIdSchema.parse("prj_runviewprod01"),
  run: RunIdSchema.parse("run_runviewprod01"),
  attempt: AttemptIdSchema.parse("att_runviewprod01"),
  historicalAttempt: AttemptIdSchema.parse("att_runviewprod02"),
  step: StepIdSchema.parse("stp_runviewprod01"),
  historicalStep: StepIdSchema.parse("stp_runviewprod02"),
  stepRun: StepRunIdSchema.parse("spr_runviewprod01"),
  historicalStepRun: StepRunIdSchema.parse("spr_runviewprod02"),
  workflow: WorkflowRevisionIdSchema.parse("wfr_runviewprod01"),
  plan: ExecutionPlanIdSchema.parse("epl_runviewprod01"),
};

function runState(
  executionStatus: WorkflowRunState["steps"][number]["executionStatus"],
  verificationStatus: WorkflowRunState["steps"][number]["verificationStatus"],
): WorkflowRunState {
  const failed = executionStatus === "failed";
  return {
    binding: createWorkflowRunBinding({
      runId: ids.run,
      projectId: ids.project,
      changeRevisionId: "crv_runviewprod01",
      requirementRevisionIds: ["rrv_runviewprod01"],
      workflowRevisionId: ids.workflow,
      policySnapshot: {
        snapshotHash: "a".repeat(64),
        policyVersion: 1,
      },
      initialBudget: {
        maxAttempts: 3,
        maxElapsedMs: 60_000,
        maxCost: 10,
        maxTokens: 1_000,
        maxLoopIterations: 1,
      },
      subjectKind: "change",
      parentRunId: null,
      taskId: null,
      executionPlanId: ids.plan,
      taskGraphFingerprint: "b".repeat(64),
    }),
    version: 7,
    status: failed ? "failed" : "needs_attention",
    budgetUsage: {
      attempts: 1,
      elapsedMs: 100,
      cost: 0,
      tokens: 0,
      loopIterations: 0,
      lastProgressFingerprint: null,
      lastFailureFingerprint: null,
      repeatedFailureFingerprintCount: 0,
      noDiffCount: 0,
      verifierErrorCount: 0,
    },
    steps: [{
      stepRunId: ids.stepRun,
      stepId: ids.step,
      executionStatus,
      verificationStatus,
      conclusion: failed ? "failed" : "active",
      fixedContentHash: "c".repeat(64),
      attempts: [{
        attemptId: ids.attempt,
        attemptNumber: 1,
        executionStatus,
        verificationStatus,
        verificationEvidenceFingerprint: "d".repeat(64),
        ...(failed
          ? {
              assignment: {
                operationId: "opn_runviewprod01",
                capabilityProbeReceiptId: "cpr_runviewprod01",
                leaseIds: [],
              },
            }
          : {}),
      }],
    }],
    recoveryFacts: [],
    externalObservationReceipts: [],
    humanVerificationReceipts: [],
    scheduledChildren: [],
    cancellationRequestedChildRunIds: [],
    attemptCancellation: null,
    scheduledRetry: null,
    loopUsage: {},
    acceptedChildRunIds: [],
    supplementalInputs: [],
    supersedingDecisions: [],
    dependencyFailureDecisions: [],
  };
}

function fixture(state: WorkflowRunState) {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE events (
      position INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_data TEXT NOT NULL
    );
    CREATE TABLE outbox (
      operation_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL
    );
    CREATE TABLE evidence_records (
      evidence_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      evidence_hash TEXT NOT NULL,
      observed_at TEXT NOT NULL
    );
  `);
  let position = 8;
  for (const step of state.steps) {
    for (const attempt of step.attempts) {
      position += 1;
      database.prepare(
        `INSERT INTO events(
           position, event_id, aggregate_id, event_type, event_data
         ) VALUES (?, ?, ?, 'FlowEvent', ?)`,
      ).run(
        position,
        `evt_runview_state_${String(position).padStart(4, "0")}`,
        `run:${ids.run}`,
        JSON.stringify({
          flowEvent: {
            type: "StepActivated",
            stepRunId: step.stepRunId,
            attemptId: attempt.attemptId,
            attemptNumber: attempt.attemptNumber,
            fixedContentHash: step.fixedContentHash,
          },
        }),
      );
    }
  }
  const staleAttempt = state.steps
    .flatMap(({ attempts }) => attempts)
    .find(({ executionStatus }) => executionStatus === "stale");
  if (staleAttempt !== undefined) {
    database.prepare(
      "INSERT INTO outbox(operation_id, run_id, attempt_id) VALUES (?, ?, ?)",
    ).run("opn_runviewprod01", ids.run, staleAttempt.attemptId);
    database.prepare(
      `INSERT INTO evidence_records(
         evidence_id, operation_id, evidence_hash, observed_at
       ) VALUES (?, ?, ?, ?)`,
    ).run(
      "evd_runviewprod01",
      "opn_runviewprod01",
      "d".repeat(64),
      "2026-07-24T00:00:00.000Z",
    );
  }
  const definitions = {
    getWorkflowRevision: vi.fn(() => ({
      workflowRevisionId: ids.workflow,
      steps: state.steps.map((step) => ({
        stepId: step.stepId,
        retryPolicy: { maxAttempts: 3 },
        budgetCost: { elapsedMs: 100, cost: 1 },
      })),
    })),
  } as unknown as FlowDefinitions;
  const service = createSqliteRunViewService({
    database,
    flowStore: {
      loadRun: vi.fn(() => state),
    } as unknown as FlowStore,
    definitions,
    journal: {
      findOperation: vi.fn(() => null),
    } as unknown as SqliteOperationJournal,
    capabilityReceiptFor: undefined,
    now: () => new Date("2026-07-24T00:00:00.000Z"),
  });
  return { database, service };
}

let openDatabase: DatabaseSync | undefined;
afterEach(() => {
  openDatabase?.close();
  openDatabase = undefined;
});

describe("SQLite production RunView", () => {
  it.each([
    ["waiting_input", "pending", "input_required", "submit_input"],
    ["failed", "pending", "recovery_attention_required", "create_new_attempt"],
    ["stale", "pending", "external_operation_indeterminate", "confirm_external_result"],
    ["needs_attention", "pending", "recovery_attention_required", "create_new_attempt"],
    ["returned", "failed", "verifier_failed", "create_new_attempt"],
    ["returned", "error", "verifier_error", "create_new_attempt"],
    ["returned", "needs_human", "human_verification_required", "record_human_receipt"],
  ] as const)(
    "projects %s/%s with fixed evidence and an authoritative recovery action",
    (execution, verification, reasonCode, action) => {
      const fixtureValue = fixture(runState(execution, verification));
      openDatabase = fixtureValue.database;
      const view = fixtureValue.service.get(ids.run);
      const attempt = view?.steps[0]?.attempts[0];
      expect(view).toMatchObject({
        runId: ids.run,
        projectionPosition: 9,
        aggregateVersion: 7,
      });
      expect(attempt?.attention).toMatchObject({
        reasonCode,
        inputRevision: { fixedContentHash: "c".repeat(64) },
      });
      expect(attempt?.attention?.evidence[0]?.contentHash).toMatch(
        /^[a-f0-9]{64}$/u,
      );
      expect(attempt?.attention?.actions).toContainEqual(
        expect.objectContaining({ action, enabled: true }),
      );
      fixtureValue.database.close();
      openDatabase = undefined;
    },
  );

  it("disables every projected action on a historical Attempt", () => {
    const state = runState("needs_attention", "pending");
    const currentAttemptId = AttemptIdSchema.parse(
      "att_runviewprod02",
    );
    const historicalState: WorkflowRunState = {
      ...state,
      steps: [{
        ...state.steps[0]!,
        attempts: [
          {
            ...state.steps[0]!.attempts[0]!,
            executionStatus: "failed",
          },
          {
            attemptId: currentAttemptId,
            attemptNumber: 2,
            executionStatus: "needs_attention",
            verificationStatus: "pending",
          },
        ],
      }],
    };
    const fixtureValue = fixture(historicalState);
    openDatabase = fixtureValue.database;
    const attempts = fixtureValue.service.get(ids.run)?.steps[0]?.attempts;
    expect(attempts?.[0]?.attention?.actions.every(
      ({ enabled, disabledReasonCode }) =>
        !enabled && disabledReasonCode === "action_not_available",
    )).toBe(true);
    expect(attempts?.[1]?.attention?.actions.some(({ enabled }) => enabled))
      .toBe(true);
    fixtureValue.database.close();
    openDatabase = undefined;
  });

  it("uses the durable Flow event when no canonical Evidence record exists", () => {
    const fixtureValue = fixture(runState("waiting_input", "pending"));
    openDatabase = fixtureValue.database;
    const attempt = fixtureValue.service.get(ids.run)?.steps[0]?.attempts[0];
    expect(attempt?.evidenceIds).toEqual([]);
    expect(attempt?.attention?.evidence).toEqual([{
      source: "flow_event",
      eventId: "evt_runview_state_0009",
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    }]);
    fixtureValue.database.close();
    openDatabase = undefined;
  });

  it("offers only append-only recovery for the current concluded failed Attempt", () => {
    const fixtureValue = fixture(runState("failed", "pending"));
    openDatabase = fixtureValue.database;
    const actions = fixtureValue.service.get(ids.run)?.steps[0]?.attempts[0]
      ?.attention?.actions;
    expect(actions).toEqual([{
      action: "create_new_attempt",
      enabled: true,
    }]);
    fixtureValue.database.close();
    openDatabase = undefined;
  });

  it("projects a terminal Loop back-edge Step from last activation, not array order", () => {
    const state = runState("failed", "pending");
    const loopTerminalState: WorkflowRunState = {
      ...state,
      lastActivatedAttemptId: ids.attempt,
      steps: [
        state.steps[0]!,
        {
          stepRunId: ids.historicalStepRun,
          stepId: ids.historicalStep,
          executionStatus: "failed",
          verificationStatus: "pending",
          conclusion: "failed",
          fixedContentHash: "e".repeat(64),
          attempts: [{
            attemptId: ids.historicalAttempt,
            attemptNumber: 1,
            executionStatus: "failed",
            verificationStatus: "pending",
          }],
        },
      ],
    };
    const fixtureValue = fixture(loopTerminalState);
    openDatabase = fixtureValue.database;
    const steps = fixtureValue.service.get(ids.run)?.steps;
    expect(steps?.[0]?.attempts[0]?.attention?.actions).toEqual([{
      action: "create_new_attempt",
      enabled: true,
    }]);
    expect(steps?.[1]?.attempts[0]?.attention?.actions.every(
      ({ enabled, disabledReasonCode }) =>
        !enabled && disabledReasonCode === "action_not_available",
    )).toBe(true);
    fixtureValue.database.close();
    openDatabase = undefined;
  });
});
