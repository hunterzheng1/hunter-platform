import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  AttemptIdSchema,
  ControllerLeaseIdSchema,
  DeviceBindingIdSchema,
  EvidenceIdSchema,
  LeaseOwnerIdSchema,
  NativeSessionIdSchema,
  OperationIdSchema,
  ProjectIdSchema,
  RepositoryIdSchema,
  RunIdSchema,
  RuntimeProviderIdSchema,
  WorkspaceIdSchema,
} from "@hunter/domain";
import {
  createExternalOperation,
  type ExternalOperation,
  type ExternalOperationHandler,
  type ExternalOperationReconciler,
  type ExternalOperationReceipt,
} from "@hunter/runtime-contracts";
import { OperationWorker, SqliteOperationJournal } from "@hunter/storage";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeOperationHandler } from "./runtime-operation-handler.js";

const projectId = ProjectIdSchema.parse("prj_recovery1401");
const operationId = OperationIdSchema.parse("opn_recovery1401");

function operation(): ExternalOperation {
  return createExternalOperation({
    schemaVersion: 1,
    operationId,
    projectId,
    runId: RunIdSchema.parse("run_recovery1401"),
    attemptId: AttemptIdSchema.parse("att_recovery1401"),
    operationVersion: 1,
    operationType: "workspace.prepare",
    requestedCapabilities: ["workspace_prepare", "workspace_isolation"],
    payload: {
      repositoryId: RepositoryIdSchema.parse("rep_recovery1401"),
      deviceBindingId: DeviceBindingIdSchema.parse("dev_recovery1401"),
      workspaceId: WorkspaceIdSchema.parse("wsp_recovery1401"),
      mode: "write",
      baselineRevision: "a".repeat(40),
    },
  });
}

function receipt(externalOperation: ExternalOperation): ExternalOperationReceipt {
  return {
    schemaVersion: 1,
    operationId: externalOperation.operationId,
    fingerprint: externalOperation.fingerprint,
    operationStatus: "completed",
    subject: {
      kind: "provider",
      providerId: RuntimeProviderIdSchema.parse("rtp_recovery1401"),
      implementationVersion: "task14-fixture",
    },
    nativeReferences: [],
    facts: [{ kind: "operation_accepted" }],
    evidence: {
      evidenceId: EvidenceIdSchema.parse(
        externalOperation.operationId.replace(/^opn_/u, "evd_"),
      ),
      evidenceHash: createHash("sha256")
        .update(externalOperation.operationId)
        .digest("hex"),
      proofScope: "contract_only",
    },
    observedAt: "2026-07-23T14:00:00.000Z",
  };
}

class FileBackedExternalSystem {
  public constructor(private readonly objectFile: string) {}

  public create(externalOperation: ExternalOperation): ExternalOperationReceipt {
    if (existsSync(this.objectFile)) {
      throw new Error("DUPLICATE_EXTERNAL_OBJECT");
    }
    const created = receipt(externalOperation);
    writeFileSync(this.objectFile, JSON.stringify(created), {
      encoding: "utf8",
      flag: "wx",
    });
    return created;
  }

  public find(operationToFind: ExternalOperation): ExternalOperationReceipt | null {
    if (!existsSync(this.objectFile)) return null;
    const found = JSON.parse(readFileSync(this.objectFile, "utf8")) as ExternalOperationReceipt;
    return found.operationId === operationToFind.operationId ? found : null;
  }

  public count(): number {
    return existsSync(this.objectFile) ? 1 : 0;
  }
}

class ReconstructableAdapter implements ExternalOperationHandler {
  public constructor(private readonly upstream: FileBackedExternalSystem) {}

  public async execute(externalOperation: ExternalOperation): Promise<ExternalOperationReceipt> {
    return this.upstream.create(externalOperation);
  }

  public async inspect(externalOperation: ExternalOperation): Promise<ExternalOperationReceipt | null> {
    return this.upstream.find(externalOperation);
  }
}

function commit(database: DatabaseSync, externalOperation: ExternalOperation): void {
  new SqliteOperationJournal(database).commitCommand({
    commandId: "cmd_recovery_task14",
    requestFingerprint: "b".repeat(64),
    projectId,
    aggregateId: "attempt:att_recovery1401",
    expectedVersion: 0,
    actor: {
      actorId: "task14-test",
      correlationId: "run_recovery1401",
    },
    events: [
      {
        eventId: "evt_recovery_task14",
        eventType: "AttemptAssigned",
        eventData: { operationId },
        schemaVersion: 1,
        occurredAt: "2026-07-23T14:00:00.000Z",
      },
    ],
    operations: [externalOperation],
    response: { operationId },
  });
}

describe("durable external operation recovery contract", () => {
  let directory: string | undefined;
  let database: DatabaseSync | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
      directory = undefined;
    }
  });

  function openDatabase(): DatabaseSync {
    directory ??= mkdtempSync(join(tmpdir(), "hunter-operation-recovery-"));
    database = new DatabaseSync(join(directory, "hunter.sqlite"));
    return database;
  }

  function restartDatabase(): DatabaseSync {
    database?.close();
    database = undefined;
    return openDatabase();
  }

  it("OP-01..03 reconstructs DB/client/worker/adapter and reconciles one external object", async () => {
    const externalOperation = operation();
    const firstDatabase = openDatabase();
    commit(firstDatabase, externalOperation);
    const upstreamFile = join(directory!, "upstream-object.json");
    const firstWorker = new OperationWorker(
      firstDatabase,
      new RuntimeOperationHandler(
        new ReconstructableAdapter(new FileBackedExternalSystem(upstreamFile)),
      ),
      {
        ownerId: "worker-task14-first",
        dispatchLeaseMs: 1,
        now: () => new Date("2026-07-23T14:00:00.000Z"),
        replayPolicy: () => "inspectable",
        faultInjector: {
          hit(point) {
            if (point === "after_provider_success_before_receipt_commit") {
              throw new Error(point);
            }
          },
        },
      },
    );

    await expect(firstWorker.runOnce()).rejects.toThrow(
      "after_provider_success_before_receipt_commit",
    );
    expect(new FileBackedExternalSystem(upstreamFile).count()).toBe(1);

    const secondDatabase = restartDatabase();
    const reconstructedUpstream = new FileBackedExternalSystem(upstreamFile);
    const secondWorker = new OperationWorker(
      secondDatabase,
      new RuntimeOperationHandler(
        new ReconstructableAdapter(reconstructedUpstream),
      ),
      {
        ownerId: "worker-task14-second",
        now: () => new Date("2026-07-23T14:00:01.000Z"),
        replayPolicy: () => "inspectable",
      },
    );

    await expect(secondWorker.runOnce()).resolves.toBe("completed");
    expect(reconstructedUpstream.count()).toBe(1);
    expect(
      secondDatabase
        .prepare(
          "SELECT operation_id, observed_status FROM side_effect_receipts",
        )
        .all(),
    ).toEqual([
      { operation_id: operationId, observed_status: "completed" },
    ]);
    expect(
      secondDatabase.prepare(
        "SELECT evidence_id, operation_id, evidence_hash, observed_status FROM evidence_records",
      ).all(),
    ).toEqual([{
      evidence_id: "evd_recovery1401",
      operation_id: operationId,
      evidence_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      observed_status: "completed",
    }]);
    expect(
      secondDatabase
        .prepare("SELECT status, delivery_count FROM outbox")
        .get(),
    ).toEqual({ status: "completed", delivery_count: 2 });
    expect(
      secondDatabase.prepare(
        "SELECT COUNT(*) AS count FROM events WHERE event_type = 'ExternalOperationObserved'",
      ).get(),
    ).toEqual({ count: 1 });
  });

  it("OP-04 marks an uninspectable ambiguous delivery needs_attention without redispatch", async () => {
    const externalOperation = operation();
    const firstDatabase = openDatabase();
    commit(firstDatabase, externalOperation);
    const upstreamFile = join(directory!, "upstream-object.json");
    const firstUpstream = new FileBackedExternalSystem(upstreamFile);
    const firstWorker = new OperationWorker(
      firstDatabase,
      new RuntimeOperationHandler(new ReconstructableAdapter(firstUpstream)),
      {
        ownerId: "worker-task14-ambiguous-first",
        dispatchLeaseMs: 1,
        now: () => new Date("2026-07-23T14:00:00.000Z"),
        replayPolicy: () => "inspectable",
        faultInjector: {
          hit(point) {
            if (point === "after_provider_success_before_receipt_commit") {
              throw new Error(point);
            }
          },
        },
      },
    );
    await expect(firstWorker.runOnce()).rejects.toThrow();
    expect(firstUpstream.count()).toBe(1);

    const execute = vi.fn(async (): Promise<ExternalOperationReceipt> => {
      throw new Error("BLIND_REDISPATCH");
    });
    const ambiguousAdapter: ExternalOperationHandler = { execute };
    const secondWorker = new OperationWorker(
      restartDatabase(),
      new RuntimeOperationHandler(ambiguousAdapter),
      {
        ownerId: "worker-task14-ambiguous-second",
        now: () => new Date("2026-07-23T14:00:01.000Z"),
        replayPolicy: () => "inspectable",
      },
    );

    await expect(secondWorker.runOnce()).resolves.toBe("needs_attention");
    expect(execute).not.toHaveBeenCalled();
    expect(firstUpstream.count()).toBe(1);
    expect(
      database!.prepare("SELECT status FROM outbox").get(),
    ).toEqual({ status: "needs_attention" });
    const observation = database!
      .prepare(
        "SELECT event_data FROM events WHERE event_type = 'ExternalOperationObserved' ORDER BY position DESC LIMIT 1",
      )
      .get() as { event_data: string };
    expect(JSON.parse(observation.event_data)).toMatchObject({
      status: "needs_attention",
      observation: {
        operationStatus: "indeterminate",
        requiresAttention: true,
      },
    });
    expect(
      database!.prepare(
        "SELECT operation_id, observed_status FROM side_effect_receipts",
      ).all(),
    ).toEqual([{ operation_id: operationId, observed_status: "needs_attention" }]);
    expect(
      database!.prepare(
        "SELECT operation_id, observed_status FROM evidence_records",
      ).all(),
    ).toEqual([{ operation_id: operationId, observed_status: "needs_attention" }]);
  });

  it("OP-04 confirmed_absent permits exactly one recovery dispatch", async () => {
    const externalOperation = operation();
    const firstDatabase = openDatabase();
    commit(firstDatabase, externalOperation);
    firstDatabase
      .prepare(
        `UPDATE outbox
            SET status = 'in_flight', dispatch_owner = 'crashed',
                dispatch_generation = 1, dispatch_expires_at = ?,
                delivery_count = 1
          WHERE operation_id = ?`,
      )
      .run("2026-07-23T14:00:00.001Z", operationId);

    const execute = vi.fn(async () => receipt(externalOperation));
    const adapter: ExternalOperationHandler & ExternalOperationReconciler = {
      execute,
      reconcile: async () => ({ outcome: "confirmed_absent" }),
    };
    const worker = new OperationWorker(
      restartDatabase(),
      new RuntimeOperationHandler(adapter),
      {
        ownerId: "worker-task14-confirmed-absent",
        now: () => new Date("2026-07-23T14:00:01.000Z"),
        replayPolicy: () => "inspectable",
      },
    );

    await expect(worker.runOnce()).resolves.toBe("completed");
    expect(execute).toHaveBeenCalledOnce();
    expect(
      database!
        .prepare("SELECT delivery_count, status FROM outbox")
        .get(),
    ).toEqual({ delivery_count: 2, status: "completed" });
    expect(
      database!.prepare(
        "SELECT observed_status FROM side_effect_receipts",
      ).get(),
    ).toEqual({ observed_status: "completed" });
    expect(
      database!.prepare(
        "SELECT observed_status FROM evidence_records",
      ).get(),
    ).toEqual({ observed_status: "completed" });
    expect(
      database!.prepare(
        "SELECT COUNT(*) AS count FROM events WHERE event_type = 'ExternalOperationObserved'",
      ).get(),
    ).toEqual({ count: 1 });
  });

  it("journals task-pack write and session resume before either handler side effect", async () => {
    const taskPack = createExternalOperation({
      schemaVersion: 1,
      operationId: OperationIdSchema.parse("opn_taskpack14001"),
      projectId,
      runId: RunIdSchema.parse("run_recovery1401"),
      attemptId: AttemptIdSchema.parse("att_recovery1401"),
      operationVersion: 2,
      operationType: "task_pack.write",
      requestedCapabilities: ["artifact_export"],
      payload: {
        workspaceId: WorkspaceIdSchema.parse("wsp_recovery1401"),
        inputEvidenceId: EvidenceIdSchema.parse("evd_taskpack14001"),
      },
    });
    const resume = createExternalOperation({
      schemaVersion: 1,
      operationId: OperationIdSchema.parse("opn_resume140001"),
      projectId,
      runId: RunIdSchema.parse("run_recovery1401"),
      attemptId: AttemptIdSchema.parse("att_recovery1401"),
      operationVersion: 2,
      operationType: "session.resume",
      requestedCapabilities: ["resume"],
      payload: {
        nativeSessionId: NativeSessionIdSchema.parse("ses_recovery1401"),
        controllerLeaseId: ControllerLeaseIdSchema.parse("ctl_recovery1401"),
        controllerLeaseOwnerId: LeaseOwnerIdSchema.parse("own_recovery1401"),
        controllerLeaseGeneration: 1,
      },
    });
    const activeDatabase = openDatabase();
    new SqliteOperationJournal(activeDatabase).commitCommand({
      commandId: "cmd_taskpack_resume_task14",
      requestFingerprint: "c".repeat(64),
      projectId,
      aggregateId: "attempt:att_recovery1401",
      expectedVersion: 0,
      actor: {
        actorId: "task14-test",
        correlationId: "run_recovery1401",
      },
      events: [],
      operations: [taskPack, resume],
      response: {
        operationIds: [taskPack.operationId, resume.operationId],
      },
    });
    const execute = vi.fn(
      async (externalOperation: ExternalOperation) =>
        receipt(externalOperation),
    );
    const worker = new OperationWorker(
      activeDatabase,
      new RuntimeOperationHandler({ execute }),
      {
        ownerId: "worker-task14-journaled-kinds",
        replayPolicy: () => "inspectable",
      },
    );

    expect(execute).not.toHaveBeenCalled();
    await expect(worker.runOnce()).resolves.toBe("completed");
    await expect(worker.runOnce()).resolves.toBe("completed");
    expect(
      execute.mock.calls
        .map(([candidate]) => candidate.operationType)
        .sort(),
    ).toEqual(["session.resume", "task_pack.write"]);
    expect(
      activeDatabase
        .prepare(
          "SELECT COUNT(*) AS count FROM side_effect_receipts",
        )
        .get(),
    ).toEqual({ count: 2 });
  });
});
