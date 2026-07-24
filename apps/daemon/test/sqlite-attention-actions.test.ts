import { DatabaseSync } from "node:sqlite";

import {
  AttemptIdSchema,
  CapabilityProbeReceiptIdSchema,
  EventIdSchema,
  EvidenceIdSchema,
  ExecutionPlanIdSchema,
  OperationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  RuntimeProviderIdSchema,
  StepIdSchema,
  StepRunIdSchema,
  WorkflowRevisionIdSchema,
  canonicalSha256,
} from "@hunter/domain";
import {
  createWorkflowRunBinding,
  FlowEngine,
  deriveHumanGateId,
  type FlowDefinitions,
  type FlowStore,
  type WorkflowRunState,
} from "@hunter/flow-engine";
import {
  CapabilityProbeReceiptSchema,
  createExternalOperation,
} from "@hunter/runtime-contracts";
import {
  SqliteOperationJournal,
  loadStorageMigrations,
  runStorageMigrations,
} from "@hunter/storage";
import { describe, expect, it, vi } from "vitest";

import { createSqliteAttentionActionService } from "../src/services/sqlite-attention-actions.js";
import { SqliteFlowStore } from "../src/services/sqlite-application-services.js";
import type { SqliteAttemptObservation } from "../src/services/sqlite-attempt-observation.js";

const ids = {
  project: ProjectIdSchema.parse("prj_sqlattention01"),
  run: RunIdSchema.parse("run_sqlattention01"),
  attempt: AttemptIdSchema.parse("att_sqlattention01"),
  step: StepIdSchema.parse("stp_sqlattention01"),
  stepRun: StepRunIdSchema.parse("spr_sqlattention01"),
  workflow: WorkflowRevisionIdSchema.parse("wfr_sqlattention01"),
  plan: ExecutionPlanIdSchema.parse("epl_sqlattention01"),
  operation: OperationIdSchema.parse("opn_sqlattention01"),
  evidence: EvidenceIdSchema.parse("evd_sqlattention01"),
  probe: CapabilityProbeReceiptIdSchema.parse("cpr_sqlattention01"),
};

function capability(
  status: "supported" | "unsupported" | "unknown",
  probeReceiptId = ids.probe,
) {
  return CapabilityProbeReceiptSchema.parse({
    schemaVersion: 2,
    probeReceiptId,
    subject: {
      kind: "provider",
      providerId: RuntimeProviderIdSchema.parse("rtp_sqlattention01"),
      implementationVersion: "test",
    },
    platform: "windows",
    executable: { status: "available" },
    loginState: "not_required",
    productVersion: { observed: "test", supported: ["test"] },
    protocol: {
      kind: "test",
      observedVersion: "1",
      supportedVersions: ["1"],
      schemaVersion: 1,
      supportedSchemaVersions: [1],
      schemaDigest: "c".repeat(64),
    },
    probedAt: "2026-07-24T00:00:00.000Z",
    validUntil: "2026-07-25T00:00:00.000Z",
    results: [{
      capability: "observe",
      status,
      evidenceId: EvidenceIdSchema.parse("evd_sqlattentionprobe"),
      evidence: { source: "local_probe", digest: "d".repeat(64) },
      probedAt: "2026-07-24T00:00:00.000Z",
    }],
  });
}

function state(): WorkflowRunState {
  const binding = createWorkflowRunBinding({
    runId: ids.run,
    projectId: ids.project,
    changeRevisionId: "crv_sqlattention01",
    requirementRevisionIds: ["rrv_sqlattention01"],
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
  });
  return {
    binding,
    version: 7,
    status: "needs_attention",
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
      executionStatus: "stale",
      verificationStatus: "pending",
      conclusion: "active",
      fixedContentHash: "e".repeat(64),
      attempts: [{
        attemptId: ids.attempt,
        attemptNumber: 1,
        executionStatus: "stale",
        verificationStatus: "pending",
        assignment: {
          operationId: ids.operation,
          capabilityProbeReceiptId: ids.probe,
          leaseIds: [],
        },
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

function fixture(
  observeStatus: "supported" | "unsupported" | "unknown",
  actionProbeReceiptId = ids.probe,
) {
  const database = new DatabaseSync(":memory:");
  database.exec(`
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
    CREATE TABLE command_receipts (
      command_id TEXT PRIMARY KEY,
      request_fingerprint TEXT NOT NULL,
      first_position INTEGER,
      last_position INTEGER
    );
    CREATE TABLE events (
      position INTEGER PRIMARY KEY,
      event_id TEXT,
      aggregate_id TEXT,
      event_type TEXT NOT NULL,
      event_data TEXT NOT NULL
    );
  `);
  database.prepare(
    "INSERT INTO outbox(operation_id, run_id, attempt_id) VALUES (?, ?, ?)",
  ).run(ids.operation, ids.run, ids.attempt);
  database.prepare(
    "INSERT INTO evidence_records(evidence_id, operation_id, evidence_hash, observed_at) VALUES (?, ?, ?, ?)",
  ).run(
    ids.evidence,
    ids.operation,
    "f".repeat(64),
    "2026-07-24T00:00:00.000Z",
  );
  const launch = createExternalOperation({
    schemaVersion: 1,
    operationId: ids.operation,
    projectId: ids.project,
    runId: ids.run,
    attemptId: ids.attempt,
    operationVersion: 1,
    operationType: "session.launch",
    requestedCapabilities: ["launch"],
    payload: {
      agentProfileId: "apr_sqlattention01",
      workspaceId: "wsp_sqlattention01",
    },
  });
  const flowState = state();
  const getReceipt = vi.fn(() => ({
    commandId: "attention-command",
    response: {},
  }));
  const loadRun = vi.fn(() => flowState);
  const flowStore = {
    loadRun,
    getReceipt,
  } as unknown as FlowStore;
  const handle = vi.fn((command: unknown) => {
    void command;
    return {
      commandId: "attention-command",
      response: {},
    };
  });
  const flowEngine = { handle } as unknown as FlowEngine;
  const definitions = {
    getWorkflowRevision: vi.fn(() => ({
      workflowRevisionId: ids.workflow,
      steps: [{
        stepId: ids.step,
        retryPolicy: { maxAttempts: 3 },
        budgetCost: { elapsedMs: 100, cost: 1 },
      }],
    })),
  } as unknown as FlowDefinitions;
  const journal = {
    findOperation: vi.fn(() => ({
      operation: launch,
      status: "completed",
    })),
    aggregateVersion: vi.fn(() => 0),
    commitCommand: vi.fn((command: {
      readonly commandId: string;
      readonly requestFingerprint: string;
      readonly response: unknown;
    }) => {
      database.prepare(
        `INSERT INTO command_receipts(
           command_id, request_fingerprint, first_position, last_position
         ) VALUES (?, ?, NULL, NULL)`,
      ).run(command.commandId, command.requestFingerprint);
      return { response: command.response };
    }),
  } as unknown as SqliteOperationJournal;
  const attemptObservation = {
    observeForAttention: vi.fn(async () => ({
      fact: "session_running" as const,
      evidenceId: ids.evidence,
      evidenceHash: "f".repeat(64),
      capabilityProbeReceiptId: ids.probe,
    })),
  } as unknown as SqliteAttemptObservation;
  return {
    database,
    attemptObservation,
    getReceipt,
    handle,
    loadRun,
    service: createSqliteAttentionActionService({
      database,
      flowStore,
      flowEngine,
      definitions,
      journal,
      attemptObservation,
      capabilityReceiptFor: () =>
        capability(observeStatus, actionProbeReceiptId),
      now: () => new Date("2026-07-24T01:00:00.000Z"),
    }),
  };
}

describe("SQLite Attention actions", () => {
  it("records a human receipt against a durable Flow event reference, not a fabricated Evidence id", async () => {
    const { database, handle, loadRun, service } = fixture("supported");
    const humanState: WorkflowRunState = {
      ...state(),
      status: "waiting_approval",
      steps: [{
        ...state().steps[0]!,
        executionStatus: "returned",
        verificationStatus: "needs_human",
        attempts: [{
          ...state().steps[0]!.attempts[0]!,
          executionStatus: "returned",
          verificationStatus: "needs_human",
          verificationEvidenceFingerprint: "9".repeat(64),
        }],
      }],
    };
    loadRun.mockReturnValue(humanState);
    const eventId = EventIdSchema.parse("evt_sqlattention_human_0001");
    const flowEvent = {
      type: "VerificationChanged",
      stepRunId: ids.stepRun,
      attemptId: ids.attempt,
      status: "needs_human",
      evidenceFingerprint: "9".repeat(64),
    };
    database.prepare(
      `INSERT INTO events(
         position, event_id, aggregate_id, event_type, event_data
       ) VALUES (?, ?, ?, 'FlowEvent', ?)`,
    ).run(
      1,
      eventId,
      `run:${ids.run}`,
      JSON.stringify({ flowEvent }),
    );
    await expect(service.execute(ids.run, {
      attemptId: ids.attempt,
      action: "record_human_receipt",
      receipt: {
        evidenceRef: {
          source: "flow_event",
          eventId,
          contentHash: canonicalSha256(flowEvent),
        },
        acknowledgedInputHash: "e".repeat(64),
      },
      expectedVersion: 7,
      idempotencyKey: "sqlite-attention-human-event",
    }, {
      actorId: "desktop-owner",
      correlationId: "sqlite-attention-human-event",
    })).resolves.toMatchObject({
      effect: "human_receipt_recorded",
      stepCompletion: "human_verified",
    });
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({
      type: "ApplyRunControl",
      payload: {
        humanReceipt: {
          sourceEventId: eventId,
          evidenceContentHash: canonicalSha256(flowEvent),
          acknowledgedInputHash: "e".repeat(64),
        },
      },
    }));
    database.close();
  });

  it("replays submit_input from a real SqliteFlowStore ledger and rejects changed API payload reuse", async () => {
    const database = new DatabaseSync(":memory:");
    runStorageMigrations(database, loadStorageMigrations());
    const journal = new SqliteOperationJournal(database);
    const binding = state().binding;
    const definitions = {
      getWorkflowRevision: vi.fn(() => null),
      getExecutionPlan: vi.fn(() => null),
      getRequirementRevision: vi.fn(() => null),
    } satisfies FlowDefinitions;
    const flowStore = new SqliteFlowStore(database, journal);
    flowStore.commit({
      commandId: "task6-real-ledger-fixture",
      requestFingerprint: canonicalSha256("task6-real-ledger-fixture"),
      runId: ids.run,
      expectedVersion: 0,
      events: [
        { type: "RunStarted", binding },
        {
          type: "StepActivated",
          stepRunId: ids.stepRun,
          stepId: ids.step,
          attemptId: ids.attempt,
          attemptNumber: 1,
          fixedContentHash: "e".repeat(64),
        },
        {
          type: "ExternalObservationRecorded",
          stepRunId: ids.stepRun,
          attemptId: ids.attempt,
          fact: "terminal_idle",
          executionStatus: "waiting_input",
        },
      ],
      response: { initialized: true },
    });
    const flowEngine = new FlowEngine(flowStore, definitions);
    const service = createSqliteAttentionActionService({
      database,
      flowStore,
      flowEngine,
      definitions,
      journal,
      attemptObservation: {
        observeForAttention: vi.fn(),
      } as unknown as SqliteAttemptObservation,
      capabilityReceiptFor: undefined,
      now: () => new Date("2026-07-24T01:00:00.000Z"),
    });
    const text = "补充真实账本输入";
    const command = {
      attemptId: ids.attempt,
      action: "submit_input" as const,
      input: { text, contentHash: canonicalSha256(text) },
      expectedVersion: 3,
      idempotencyKey: "task6-real-ledger-submit",
    };
    const actor = {
      actorId: "desktop-owner",
      correlationId: command.idempotencyKey,
    };
    const first = await service.execute(ids.run, command, actor);
    await expect(service.execute(ids.run, command, actor)).resolves.toEqual(
      first,
    );
    await expect(service.execute(ids.run, {
      ...command,
      input: {
        text: "被更改的输入",
        contentHash: canonicalSha256("被更改的输入"),
      },
    }, actor)).rejects.toThrow("ATTENTION_IDEMPOTENCY_CONFLICT");
    expect(flowStore.loadRun(ids.run)?.supplementalInputs).toHaveLength(1);
    database.close();
  });

  it("finds the human VerificationChanged event inside a multi-event real ledger receipt", async () => {
    const database = new DatabaseSync(":memory:");
    runStorageMigrations(database, loadStorageMigrations());
    const journal = new SqliteOperationJournal(database);
    const binding = state().binding;
    const definitions = {
      getWorkflowRevision: vi.fn(() => null),
      getExecutionPlan: vi.fn(() => null),
      getRequirementRevision: vi.fn(() => null),
    } satisfies FlowDefinitions;
    const flowStore = new SqliteFlowStore(database, journal);
    flowStore.commit({
      commandId: "task6-human-ledger-fixture",
      requestFingerprint: canonicalSha256("task6-human-ledger-fixture"),
      runId: ids.run,
      expectedVersion: 0,
      events: [
        { type: "RunStarted", binding },
        {
          type: "StepActivated",
          stepRunId: ids.stepRun,
          stepId: ids.step,
          attemptId: ids.attempt,
          attemptNumber: 1,
          fixedContentHash: "e".repeat(64),
        },
        {
          type: "ExternalObservationRecorded",
          stepRunId: ids.stepRun,
          attemptId: ids.attempt,
          fact: "agent_returned",
          executionStatus: "returned",
        },
        {
          type: "VerificationChanged",
          stepRunId: ids.stepRun,
          attemptId: ids.attempt,
          status: "needs_human",
          evidenceFingerprint: "d".repeat(64),
        },
      ],
      response: { initialized: true },
    });
    const evidenceId = EvidenceIdSchema.parse("evd_task6humanreceipt");
    const actor = {
      actorId: "desktop-owner",
      correlationId: "task6-human-ledger-approve",
    };
    const flowCommand = {
      type: "ApplyRunControl" as const,
      projectId: ids.project,
      runId: ids.run,
      action: "approve" as const,
      target: {
        kind: "gate" as const,
        gateId: deriveHumanGateId(ids.run, ids.stepRun),
      },
      payload: {
        humanReceipt: {
          evidenceId,
          evidenceContentHash: "d".repeat(64),
          acknowledgedInputHash: "e".repeat(64),
        },
      },
      expectedVersion: 4,
      idempotencyKey: "task6-human-ledger-approve",
      actor,
    };
    flowStore.commit({
      commandId: "ApplyRunControl:task6-human-ledger-approve",
      requestFingerprint: canonicalSha256(flowCommand),
      runId: ids.run,
      expectedVersion: 4,
      events: [
        {
          type: "VerificationChanged",
          stepRunId: ids.stepRun,
          attemptId: ids.attempt,
          status: "verifying",
          evidenceFingerprint: canonicalSha256(flowCommand),
        },
        {
          type: "VerificationChanged",
          stepRunId: ids.stepRun,
          attemptId: ids.attempt,
          status: "passed",
          evidenceFingerprint: canonicalSha256(flowCommand),
          humanReceipt: {
            evidenceId,
            evidenceContentHash: "d".repeat(64),
            acknowledgedInputHash: "e".repeat(64),
            actorId: actor.actorId,
          },
        },
        {
          type: "StepConcluded",
          stepRunId: ids.stepRun,
          conclusion: "succeeded",
        },
        { type: "RunConcluded", status: "succeeded" },
      ],
      response: { verificationStatus: "passed" },
    });
    const service = createSqliteAttentionActionService({
      database,
      flowStore,
      flowEngine: new FlowEngine(flowStore, definitions),
      definitions,
      journal,
      attemptObservation: {
        observeForAttention: vi.fn(),
      } as unknown as SqliteAttemptObservation,
      capabilityReceiptFor: undefined,
      now: () => new Date("2026-07-24T01:00:00.000Z"),
    });
    await expect(service.execute(ids.run, {
      attemptId: ids.attempt,
      action: "record_human_receipt",
      receipt: {
        evidenceRef: {
          evidenceId,
          contentHash: "d".repeat(64),
        },
        acknowledgedInputHash: "e".repeat(64),
      },
      expectedVersion: 4,
      idempotencyKey: "task6-human-ledger-approve",
    }, actor)).resolves.toMatchObject({
      effect: "human_receipt_recorded",
      stepCompletion: "human_verified",
    });
    database.close();
  });

  it("derives allowed actions from durable evidence and records a scoped human observation receipt", async () => {
    const { database, handle, service } = fixture("supported");
    await expect(service.execute(ids.run, {
      attemptId: ids.attempt,
      action: "confirm_external_result",
      observation: {
        fact: "session_missing",
        evidenceId: ids.evidence,
        contentHash: "f".repeat(64),
      },
      expectedVersion: 7,
      idempotencyKey: "sqlite-attention-confirm",
    }, {
      actorId: "desktop-owner",
      correlationId: "sqlite-attention-confirm",
    })).resolves.toMatchObject({
      effect: "observation_recorded",
      stepCompletion: "unchanged",
    });
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({
      type: "RecordExternalObservation",
      fact: "session_missing",
      humanReceipt: {
        evidenceId: ids.evidence,
        contentHash: "f".repeat(64),
        actorId: "desktop-owner",
      },
    }));
    database.close();
  });

  it("disables external recheck when the probe receipt does not prove observe", async () => {
    const { database, service } = fixture("unknown");
    await expect(service.execute(ids.run, {
      attemptId: ids.attempt,
      action: "retry_external_check",
      capabilityProbeReceiptId: ids.probe,
      expectedVersion: 7,
      idempotencyKey: "sqlite-attention-retry",
    }, {
      actorId: "desktop-owner",
      correlationId: "sqlite-attention-retry",
    })).rejects.toThrow("ATTENTION_ACTION_DISABLED");
    database.close();
  });

  it("replays a durable recheck receipt before state validation and rejects cross-action key reuse", async () => {
    const {
      database,
      attemptObservation,
      getReceipt,
      handle,
      service,
    } = fixture("supported");
    database.prepare(
      "INSERT INTO command_receipts(command_id, request_fingerprint, first_position, last_position) VALUES (?, ?, ?, ?)",
    ).run(
      "RecordExternalObservation:sqlite-attention-durable-replay",
      "a".repeat(64),
      1,
      1,
    );
    database.prepare(
      "INSERT INTO events(position, event_type, event_data) VALUES (?, ?, ?)",
    ).run(
      1,
      "FlowEvent",
      JSON.stringify({
        flowEvent: {
          type: "ExternalObservationRecorded",
          fact: "session_running",
          capabilityProbeReceiptId: ids.probe,
        },
      }),
    );

    await expect(service.execute(ids.run, {
      attemptId: ids.attempt,
      action: "retry_external_check",
      capabilityProbeReceiptId: ids.probe,
      expectedVersion: 7,
      idempotencyKey: "sqlite-attention-durable-replay",
    }, {
      actorId: "desktop-owner",
      correlationId: "sqlite-attention-durable-replay",
    })).resolves.toMatchObject({
      effect: "recheck_requested",
      stepCompletion: "unchanged",
    });
    expect(getReceipt).toHaveBeenCalledOnce();
    expect(handle).not.toHaveBeenCalled();
    expect(attemptObservation.observeForAttention).not.toHaveBeenCalled();

    await expect(service.execute(ids.run, {
      attemptId: ids.attempt,
      action: "create_new_attempt",
      expectedVersion: 7,
      idempotencyKey: "sqlite-attention-durable-replay",
    }, {
      actorId: "desktop-owner",
      correlationId: "sqlite-attention-durable-replay",
    })).rejects.toThrow("ATTENTION_IDEMPOTENCY_CONFLICT");
    database.close();
  });

  it("records a runtime recheck without labeling it as a human receipt", async () => {
    const { database, handle, service } = fixture("supported");
    await expect(service.execute(ids.run, {
      attemptId: ids.attempt,
      action: "retry_external_check",
      capabilityProbeReceiptId: ids.probe,
      expectedVersion: 7,
      idempotencyKey: "sqlite-attention-runtime-recheck",
    }, {
      actorId: "desktop-owner",
      correlationId: "sqlite-attention-runtime-recheck",
    })).resolves.toMatchObject({
      effect: "recheck_requested",
      stepCompletion: "unchanged",
    });
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({
      type: "RecordExternalObservation",
      fact: "session_running",
    }));
    expect(handle.mock.calls[0]?.[0]).not.toHaveProperty("humanReceipt");
    database.close();
  });

  it("uses and audits the fresh action probe receipt instead of pinning the assignment receipt", async () => {
    const freshProbe = CapabilityProbeReceiptIdSchema.parse(
      "cpr_sqlattentionfresh",
    );
    const {
      database,
      attemptObservation,
      handle,
      service,
    } = fixture("supported", freshProbe);
    await service.execute(ids.run, {
      attemptId: ids.attempt,
      action: "retry_external_check",
      capabilityProbeReceiptId: freshProbe,
      expectedVersion: 7,
      idempotencyKey: "sqlite-attention-fresh-probe",
    }, {
      actorId: "desktop-owner",
      correlationId: "sqlite-attention-fresh-probe",
    });
    expect(attemptObservation.observeForAttention).toHaveBeenCalledWith(
      expect.objectContaining({ probeReceiptId: freshProbe }),
    );
    expect(handle).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "RecordExternalObservation",
        capabilityProbeReceiptId: freshProbe,
      }),
    );
    database.close();
  });
});
