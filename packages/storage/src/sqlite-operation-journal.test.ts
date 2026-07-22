import { DatabaseSync } from "node:sqlite";

import {
  AttemptIdSchema,
  DeviceBindingIdSchema,
  OperationIdSchema,
  ProjectIdSchema,
  RepositoryIdSchema,
  RunIdSchema,
  WorkspaceIdSchema,
} from "@hunter/domain";
import { createExternalOperation } from "@hunter/runtime-contracts";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteOperationJournal } from "./sqlite-operation-journal.js";

const projectId = ProjectIdSchema.parse("prj_platform01");
const runId = RunIdSchema.parse("run_foundation1");
const attemptId = AttemptIdSchema.parse("att_attempt001");

function operation(operationId = "opn_prepare001") {
  return createExternalOperation({
    schemaVersion: 1,
    operationId: OperationIdSchema.parse(operationId),
    projectId,
    runId,
    attemptId,
    operationVersion: 1,
    operationType: "workspace.prepare",
    requestedCapabilities: ["workspace_prepare", "workspace_isolation"],
    payload: {
      repositoryId: RepositoryIdSchema.parse("rep_primary01"),
      deviceBindingId: DeviceBindingIdSchema.parse("dev_binding01"),
      workspaceId: WorkspaceIdSchema.parse("wsp_workspace1"),
      mode: "write",
      baselineRevision: "66709c49da2fa7959b22bb07441b4b56c06c1b93",
    },
  });
}

function command(overrides: Record<string, unknown> = {}) {
  return {
    commandId: "cmd_publish_0001",
    requestFingerprint: "a".repeat(64),
    projectId,
    aggregateId: "change:crv_revision01",
    expectedVersion: 0,
    actor: {
      actorId: "local-user",
      correlationId: "correlation-0001",
      causationId: "causation-0001",
    },
    events: [
      {
        eventId: "evt_change_published_0001",
        eventType: "ChangePublished",
        eventData: { changeRevisionId: "crv_revision01", secret: "[REDACTED]" },
        schemaVersion: 1,
        occurredAt: "2026-07-22T00:00:00.000Z",
      },
      {
        eventId: "evt_plan_published_0001",
        eventType: "ExecutionPlanPublished",
        eventData: { executionPlanId: "epl_plan0001" },
        schemaVersion: 1,
        occurredAt: "2026-07-22T00:00:01.000Z",
      },
    ],
    operations: [operation()],
    response: { changeRevisionId: "crv_revision01", executionPlanId: "epl_plan0001" },
    ...overrides,
  };
}

describe("SqliteOperationJournal", () => {
  let database: DatabaseSync | undefined;

  afterEach(() => database?.close());

  function setup() {
    database = new DatabaseSync(":memory:");
    return { database, journal: new SqliteOperationJournal(database) };
  }

  it("atomically commits Events, one command receipt, and Outbox operations", () => {
    const { database: db, journal } = setup();
    const receipt = journal.commitCommand(command());

    expect(receipt).toMatchObject({
      commandId: "cmd_publish_0001",
      firstPosition: 1,
      lastPosition: 2,
      response: { changeRevisionId: "crv_revision01", executionPlanId: "epl_plan0001" },
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM command_receipts").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbox").get()).toEqual({ count: 1 });
  });

  it("returns the original receipt for an exact replay without appending", () => {
    const { database: db, journal } = setup();
    const first = journal.commitCommand(command());
    const replay = journal.commitCommand(command({ response: { ignored: "new serialization" } }));

    expect(replay).toEqual(first);
    expect(db.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbox").get()).toEqual({ count: 1 });
  });

  it("rejects reuse of a command ID with a different server fingerprint", () => {
    const { database: db, journal } = setup();
    journal.commitCommand(command());

    expect(() => journal.commitCommand(command({ requestFingerprint: "b".repeat(64) }))).toThrow(
      /IDEMPOTENCY_KEY_REUSED/u,
    );
    expect(db.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 2 });
  });

  it("rolls back Events, receipt, and Outbox together on optimistic-version conflict", () => {
    const { database: db, journal } = setup();
    journal.commitCommand(command());

    expect(() =>
      journal.commitCommand(
        command({
          commandId: "cmd_publish_0002",
          requestFingerprint: "c".repeat(64),
          operations: [operation("opn_prepare002")],
        }),
      ),
    ).toThrow(/EXPECTED_VERSION_CONFLICT/u);

    expect(db.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM command_receipts").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbox").get()).toEqual({ count: 1 });
  });

  it("stores the complete redacted Event and versioned Outbox envelopes", () => {
    const { database: db, journal } = setup();
    journal.commitCommand(command());

    expect(db.prepare("SELECT * FROM events WHERE position = 1").get()).toMatchObject({
      position: 1,
      event_id: "evt_change_published_0001",
      project_id: projectId,
      aggregate_id: "change:crv_revision01",
      aggregate_version: 1,
      event_type: "ChangePublished",
      event_data: JSON.stringify({ changeRevisionId: "crv_revision01", secret: "[REDACTED]" }),
      actor_id: "local-user",
      correlation_id: "correlation-0001",
      causation_id: "causation-0001",
      schema_version: 1,
      occurred_at: "2026-07-22T00:00:00.000Z",
    });
    const storedOperation = db.prepare("SELECT * FROM outbox").get();
    expect(storedOperation).toMatchObject({
      operation_id: "opn_prepare001",
      request_fingerprint: operation().fingerprint,
      project_id: projectId,
      run_id: runId,
      attempt_id: attemptId,
      operation_type: "workspace.prepare",
      operation_version: 1,
      status: "pending",
      dispatch_owner: null,
      dispatch_generation: 0,
      delivery_count: 0,
    });
    expect(JSON.parse((storedOperation as { payload_json: string }).payload_json)).toEqual(operation().payload);
    expect((storedOperation as { created_at: string }).created_at).toBe(
      (storedOperation as { updated_at: string }).updated_at,
    );
  });

  it("allows an idempotent response-only command with null Event positions", () => {
    const { journal } = setup();
    const receipt = journal.commitCommand(
      command({
        commandId: "cmd_query_receipt",
        requestFingerprint: "d".repeat(64),
        aggregateId: "receipt:one",
        events: [],
        operations: [],
        response: { accepted: true },
      }),
    );
    expect(receipt).toMatchObject({ firstPosition: null, lastPosition: null, response: { accepted: true } });
  });
});
