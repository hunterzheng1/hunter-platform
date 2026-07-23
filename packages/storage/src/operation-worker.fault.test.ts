import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  AttemptIdSchema,
  DeviceBindingIdSchema,
  OperationIdSchema,
  ProjectIdSchema,
  RepositoryIdSchema,
  RunIdSchema,
  RuntimeProviderIdSchema,
  WorkspaceIdSchema,
} from "@hunter/domain";
import { createExternalOperation, type ExternalOperation } from "@hunter/runtime-contracts";
import { FakeRuntime, FaultInjector } from "@hunter/testkit";
import { afterEach, describe, expect, it } from "vitest";

import { OperationWorker } from "./operation-worker.js";
import { SqliteOperationJournal } from "./sqlite-operation-journal.js";

const projectId = ProjectIdSchema.parse("prj_platform01");

function operation(baselineRevision = "66709c49da2fa7959b22bb07441b4b56c06c1b93") {
  return createExternalOperation({
    schemaVersion: 1,
    operationId: OperationIdSchema.parse("opn_prepare101"),
    projectId,
    runId: RunIdSchema.parse("run_foundation1"),
    attemptId: AttemptIdSchema.parse("att_attempt101"),
    operationVersion: 1,
    operationType: "workspace.prepare",
    requestedCapabilities: ["workspace_prepare", "workspace_isolation"],
    payload: {
      repositoryId: RepositoryIdSchema.parse("rep_primary01"),
      deviceBindingId: DeviceBindingIdSchema.parse("dev_binding01"),
      workspaceId: WorkspaceIdSchema.parse("wsp_workspace1"),
      mode: "write",
      baselineRevision,
    },
  });
}

function commit(database: DatabaseSync, externalOperation: ExternalOperation = operation()) {
  const journal = new SqliteOperationJournal(database);
  journal.commitCommand({
    commandId: "cmd_assign_0101",
    requestFingerprint: "a".repeat(64),
    projectId,
    aggregateId: "attempt:att_attempt101",
    expectedVersion: 0,
    actor: { actorId: "flow", correlationId: "run_foundation1" },
    events: [
      {
        eventId: "evt_attempt_assigned_0101",
        eventType: "AttemptAssigned",
        eventData: { attemptId: "att_attempt101" },
        schemaVersion: 1,
        occurredAt: "2026-07-22T00:00:00.000Z",
      },
    ],
    operations: [externalOperation],
    response: { assigned: true },
  });
}

describe("OperationWorker crash convergence", () => {
  let directory: string | undefined;
  let database: DatabaseSync | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  function open() {
    directory ??= mkdtempSync(join(tmpdir(), "hunter-storage-test-"));
    database = new DatabaseSync(join(directory, "hunter.sqlite"));
    return database;
  }

  function restart() {
    database?.close();
    database = undefined;
    return open();
  }

  function fake() {
    return new FakeRuntime({
      providerId: RuntimeProviderIdSchema.parse("rtp_fake0001"),
      implementationVersion: "1.0.0-test",
      observedAt: "2026-07-22T00:00:01.000Z",
    });
  }

  it("delivers a command committed before the Provider call after restart", async () => {
    const runtime = fake();
    commit(open());
    const crashing = new OperationWorker(database!, runtime, {
      ownerId: "worker-one",
      faultInjector: new FaultInjector("after_command_commit_before_provider_call"),
      replayPolicy: () => "inspectable",
    });
    await expect(crashing.runOnce()).rejects.toThrow(/after_command_commit_before_provider_call/u);

    const resumed = new OperationWorker(restart(), runtime, {
      ownerId: "worker-two",
      replayPolicy: () => "inspectable",
    });
    await expect(resumed.runOnce()).resolves.toBe("completed");
    expect(runtime.nativeEffectCount).toBe(1);
    expect(database!.prepare("SELECT status FROM outbox").get()).toEqual({ status: "completed" });
  });

  it("retries with the same operationId after Provider success and gets the idempotent receipt", async () => {
    const runtime = fake();
    commit(open());
    const crashing = new OperationWorker(database!, runtime, {
      ownerId: "worker-one",
      dispatchLeaseMs: 1,
      now: () => new Date("2026-07-22T00:00:00.000Z"),
      faultInjector: new FaultInjector("after_provider_success_before_receipt_commit"),
      replayPolicy: () => "inspectable",
    });
    await expect(crashing.runOnce()).rejects.toThrow(/after_provider_success_before_receipt_commit/u);
    expect(runtime.nativeEffectCount).toBe(1);

    const resumed = new OperationWorker(restart(), runtime, {
      ownerId: "worker-two",
      now: () => new Date("2026-07-22T00:00:01.000Z"),
      replayPolicy: () => "inspectable",
    });
    await expect(resumed.runOnce()).resolves.toBe("completed");
    expect(runtime.executeCount).toBe(1);
    expect(runtime.nativeEffectCount).toBe(1);
    expect(database!.prepare("SELECT COUNT(*) AS count FROM side_effect_receipts").get()).toEqual({ count: 1 });
  });

  it("marks an unprovable prior delivery indeterminate and needing attention without blind replay", async () => {
    const runtime = fake();
    commit(open());
    const crashing = new OperationWorker(database!, runtime, {
      ownerId: "worker-one",
      dispatchLeaseMs: 1,
      now: () => new Date("2026-07-22T00:00:00.000Z"),
      faultInjector: new FaultInjector("after_provider_success_before_receipt_commit"),
      replayPolicy: () => "unsafe",
    });
    await expect(crashing.runOnce()).rejects.toThrow();

    const resumed = new OperationWorker(restart(), runtime, {
      ownerId: "worker-two",
      now: () => new Date("2026-07-22T00:00:01.000Z"),
      replayPolicy: () => "unsafe",
    });
    await expect(resumed.runOnce()).resolves.toBe("needs_attention");
    expect(runtime.executeCount).toBe(1);
    expect(runtime.nativeEffectCount).toBe(1);
    expect(database!.prepare("SELECT status FROM outbox").get()).toEqual({ status: "needs_attention" });
    expect(
      database!.prepare("SELECT event_type, event_data FROM events ORDER BY position DESC LIMIT 1").get(),
    ).toMatchObject({ event_type: "ExternalOperationObserved" });
  });

  it("refuses an external effect when dispatch-time authority is no longer valid", async () => {
    const runtime = fake();
    commit(open());
    const worker = new OperationWorker(database!, runtime, {
      ownerId: "worker-authority",
      replayPolicy: () => "inspectable",
      dispatchAuthority: () => ({ allowed: false, reason: "controller_lease_expired" }),
    });
    await expect(worker.runOnce()).resolves.toBe("needs_attention");
    expect(runtime.executeCount).toBe(0);
    expect(runtime.nativeEffectCount).toBe(0);
    expect(database!.prepare("SELECT status FROM outbox").get()).toEqual({ status: "needs_attention" });
  });

  it("sees the atomically completed receipt after a crash before the worker returns", async () => {
    const runtime = fake();
    commit(open());
    const crashing = new OperationWorker(database!, runtime, {
      ownerId: "worker-one",
      faultInjector: new FaultInjector("after_receipt_commit_before_outbox_complete"),
      replayPolicy: () => "inspectable",
    });
    await expect(crashing.runOnce()).rejects.toThrow(/after_receipt_commit_before_outbox_complete/u);

    const resumed = new OperationWorker(restart(), runtime, {
      ownerId: "worker-two",
      replayPolicy: () => "inspectable",
    });
    await expect(resumed.runOnce()).resolves.toBe("idle");
    expect(runtime.executeCount).toBe(1);
    expect(runtime.nativeEffectCount).toBe(1);
    expect(database!.prepare("SELECT status FROM outbox").get()).toEqual({ status: "completed" });
  });

  it("rolls back receipt, Evidence, lease issuance, and completion when the receipt hook crashes", async () => {
    const runtime = fake();
    commit(open());
    const worker = new OperationWorker(database!, runtime, {
      ownerId: "worker-receipt-hook",
      replayPolicy: () => "inspectable",
      prepareReceiptTransaction: () => () => {
        database!.prepare(
          `INSERT INTO lease_records(
             lease_id, lease_kind, scope_key, owner_id, generation,
             expires_at, receipt_json, updated_at
           ) VALUES (?, 'workspace', ?, ?, 1, ?, '{}', ?)`,
        ).run(
          "wsl_hookrollback01",
          "hook:rollback",
          "own_hookrollback01",
          "2026-07-22T01:00:00.000Z",
          "2026-07-22T00:00:01.000Z",
        );
        throw new Error("RECEIPT_HOOK_CRASH");
      },
    });

    await expect(worker.runOnce()).rejects.toThrow(/^RECEIPT_HOOK_CRASH$/u);
    expect(database!.prepare("SELECT COUNT(*) AS count FROM side_effect_receipts").get()).toEqual({ count: 0 });
    expect(database!.prepare("SELECT COUNT(*) AS count FROM evidence_records").get()).toEqual({ count: 0 });
    expect(database!.prepare("SELECT COUNT(*) AS count FROM lease_records").get()).toEqual({ count: 0 });
    expect(database!.prepare("SELECT status FROM outbox").get()).toEqual({ status: "pending" });
  });

  it("prepares receipt work before the SQLite writer transaction", async () => {
    const runtime = fake();
    commit(open());
    const phases: string[] = [];
    const worker = new OperationWorker(database!, runtime, {
      ownerId: "worker-receipt-phases",
      replayPolicy: () => "inspectable",
      prepareReceiptTransaction: () => {
        expect(database!.isTransaction).toBe(false);
        phases.push("prepare");
        return () => {
          expect(database!.isTransaction).toBe(true);
          phases.push("commit");
        };
      },
    });

    await expect(worker.runOnce()).resolves.toBe("completed");
    expect(phases).toEqual(["prepare", "commit"]);
  });

  it("returns the stored receipt for duplicate delivery and rejects different content", async () => {
    const runtime = fake();
    const externalOperation = operation();
    commit(open(), externalOperation);
    const worker = new OperationWorker(database!, runtime, {
      ownerId: "worker-one",
      replayPolicy: () => "inspectable",
    });
    await expect(worker.runOnce()).resolves.toBe("completed");
    const original = worker.resolveReceipt(externalOperation);
    expect(original?.operationId).toBe(externalOperation.operationId);

    const duplicateCrash = new OperationWorker(database!, runtime, {
      ownerId: "worker-two",
      faultInjector: new FaultInjector("during_duplicate_delivery"),
      replayPolicy: () => "inspectable",
    });
    expect(() => duplicateCrash.resolveReceipt(externalOperation)).toThrow(/during_duplicate_delivery/u);
    expect(new OperationWorker(database!, runtime, { ownerId: "worker-three" }).resolveReceipt(externalOperation)).toEqual(
      original,
    );

    expect(() => worker.resolveReceipt(operation("7777777777777777777777777777777777777777"))).toThrow(
      /OPERATION_ID_REUSED_WITH_DIFFERENT_PAYLOAD/u,
    );
  });
});
