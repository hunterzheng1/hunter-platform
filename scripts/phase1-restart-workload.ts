import type { DatabaseSync } from "node:sqlite";

import {
  AttemptIdSchema,
  OperationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
} from "@hunter/domain";
import {
  ExternalOperationReceiptSchema,
  createExternalOperation,
  runtimeFactCanCompleteStep,
} from "@hunter/runtime-contracts";
import {
  OperationWorker,
  type ProjectionRunner,
  type SqliteOperationJournal,
} from "@hunter/storage";

import type { PersistentFakeRuntime } from "./phase1-persistent-fake-runtime.js";

const projectId = ProjectIdSchema.parse("prj_phase1soak001");

function suffix(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new Error("RESTART_PROBE_SEQUENCE_INVALID");
  }
  return sequence.toString().padStart(6, "0");
}

export async function runPhase1RestartWorkload(options: {
  readonly database: DatabaseSync;
  readonly journal: SqliteOperationJournal;
  readonly projection: ProjectionRunner;
  readonly runtime: PersistentFakeRuntime;
  readonly sequence: number;
  readonly observedAt: string;
}): Promise<void> {
  if (Number.isNaN(Date.parse(options.observedAt))) {
    throw new Error("RESTART_PROBE_TIME_INVALID");
  }
  const id = suffix(options.sequence);
  const operation = createExternalOperation({
    schemaVersion: 1,
    operationId: OperationIdSchema.parse(`opn_phase1restart${id}`),
    projectId,
    runId: RunIdSchema.parse(`run_phase1restart${id}`),
    attemptId: AttemptIdSchema.parse(`att_phase1restart${id}`),
    operationVersion: 2,
    operationType: "session.observe",
    requestedCapabilities: ["observe"],
    payload: {
      nativeSessionId: `ses_phase1restart${id}`,
      controllerLeaseId: `ctl_phase1restart${id}`,
      controllerLeaseOwnerId: `own_phase1restart${id}`,
      controllerLeaseGeneration: 1,
    },
  });
  options.journal.commitCommand({
    commandId: `cmd_phase1restart${id}`,
    requestFingerprint: operation.fingerprint,
    projectId,
    aggregateId: `attempt:${operation.attemptId}`,
    expectedVersion: 0,
    actor: {
      actorId: "phase1-restart-workload",
      correlationId: `phase1-restart-${id}`,
    },
    events: [{
      eventId: `evt_phase1restart${id}`,
      eventType: "AttemptAssigned",
      eventData: { attemptId: operation.attemptId },
      schemaVersion: 1,
      occurredAt: options.observedAt,
    }],
    operations: [operation],
    response: { accepted: true },
  });

  const result = await new OperationWorker(options.database, options.runtime, {
    ownerId: `phase1-restart-worker-${id}`,
    replayPolicy: () => "inspectable",
  }).runOnce();
  if (result !== "completed" && result !== "idle") {
    throw new Error(`RESTART_WORKLOAD_${result.toUpperCase()}`);
  }
  const row = options.database.prepare(
    `SELECT outbox.status, side_effect_receipts.provider_receipt_json
       FROM outbox
       LEFT JOIN side_effect_receipts USING(operation_id)
      WHERE outbox.operation_id = ?`,
  ).get(operation.operationId) as {
    readonly status: string;
    readonly provider_receipt_json: string | null;
  } | undefined;
  if (row?.status !== "completed" || row.provider_receipt_json === null) {
    throw new Error("RESTART_WORKLOAD_RECEIPT_MISSING");
  }
  const receipt = ExternalOperationReceiptSchema.parse(
    JSON.parse(row.provider_receipt_json) as unknown,
  );
  if (
    receipt.operationId !== operation.operationId
    || receipt.fingerprint !== operation.fingerprint
    || receipt.facts.some(runtimeFactCanCompleteStep)
  ) {
    throw new Error("RESTART_WORKLOAD_RECEIPT_INVALID");
  }
  options.projection.runIncremental();
  options.runtime.recordRestartProbe(options.sequence, options.observedAt);
}
