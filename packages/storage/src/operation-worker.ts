import type { DatabaseSync } from "node:sqlite";

import {
  ExternalOperationReceiptSchema,
  ExternalOperationSchema,
  fingerprintExternalOperation,
  type ExternalOperation,
  type ExternalOperationHandler,
  type ExternalOperationReceipt,
} from "@hunter/runtime-contracts";

export type ReplayPolicy = "replay_safe" | "inspectable" | "unsafe";
export type WorkerResult = "idle" | "completed" | "indeterminate" | "needs_attention";

type FaultPoint =
  | "after_command_commit_before_provider_call"
  | "after_provider_success_before_receipt_commit"
  | "after_receipt_commit_before_outbox_complete"
  | "during_duplicate_delivery";

export interface FaultSink {
  hit(point: FaultPoint): void;
}

export interface OperationWorkerOptions {
  readonly ownerId: string;
  readonly dispatchLeaseMs?: number;
  readonly now?: () => Date;
  readonly replayPolicy?: (operation: ExternalOperation) => ReplayPolicy;
  readonly faultInjector?: FaultSink;
}

interface OutboxRow {
  readonly operation_id: string;
  readonly request_fingerprint: string;
  readonly operation_json: string;
  readonly status: "pending" | "in_flight";
  readonly dispatch_generation: number;
  readonly delivery_count: number;
}

interface StoredReceiptRow {
  readonly request_fingerprint: string;
  readonly provider_receipt_json: string;
}

interface AggregateVersionRow {
  readonly version: number;
}

function providerKind(receipt: ExternalOperationReceipt): string {
  return receipt.subject.kind === "provider"
    ? `provider:${receipt.subject.providerId}`
    : `connector:${receipt.subject.connectorId}`;
}

function observedStatus(
  receipt: ExternalOperationReceipt,
): "completed" | "indeterminate" | "needs_attention" {
  return receipt.operationStatus === "completed"
    ? "completed"
    : receipt.operationStatus === "indeterminate"
      ? "indeterminate"
      : "needs_attention";
}

export class OperationWorker {
  readonly #dispatchLeaseMs: number;
  readonly #now: () => Date;
  readonly #replayPolicy: (operation: ExternalOperation) => ReplayPolicy;

  public constructor(
    private readonly database: DatabaseSync,
    private readonly handler: ExternalOperationHandler,
    private readonly options: OperationWorkerOptions,
  ) {
    if (options.ownerId.trim().length === 0) throw new Error("WORKER_OWNER_REQUIRED");
    this.#dispatchLeaseMs = options.dispatchLeaseMs ?? 30_000;
    if (!Number.isSafeInteger(this.#dispatchLeaseMs) || this.#dispatchLeaseMs <= 0) {
      throw new Error("DISPATCH_LEASE_INVALID");
    }
    this.#now = options.now ?? (() => new Date());
    this.#replayPolicy = options.replayPolicy ?? (() => "unsafe");
  }

  public async runOnce(): Promise<WorkerResult> {
    this.options.faultInjector?.hit("after_command_commit_before_provider_call");
    const claimed = this.claimOne();
    if (claimed === undefined) return "idle";
    const operation = ExternalOperationSchema.parse(JSON.parse(claimed.operation_json));
    if (
      operation.fingerprint !== claimed.request_fingerprint ||
      fingerprintExternalOperation(operation) !== operation.fingerprint
    ) {
      this.finalizeIndeterminate(claimed, operation, "stored_operation_fingerprint_mismatch");
      return "indeterminate";
    }

    const uncertainPriorDelivery = claimed.delivery_count > 0;
    if (uncertainPriorDelivery && this.#replayPolicy(operation) === "unsafe") {
      this.finalizeIndeterminate(claimed, operation, "prior_delivery_outcome_unprovable");
      return "indeterminate";
    }

    const receipt = ExternalOperationReceiptSchema.parse(await this.handler.execute(operation));
    if (receipt.operationId !== operation.operationId || receipt.fingerprint !== operation.fingerprint) {
      this.finalizeIndeterminate(claimed, operation, "provider_receipt_identity_mismatch");
      return "indeterminate";
    }
    this.options.faultInjector?.hit("after_provider_success_before_receipt_commit");
    const status = this.finalizeReceipt(claimed, operation, receipt);

    // Receipt, observed fact, and Outbox completion are one SQLite commit. This
    // named point therefore has no durable half-completed state to recover.
    this.options.faultInjector?.hit("after_receipt_commit_before_outbox_complete");
    return status;
  }

  public resolveReceipt(operationInput: ExternalOperation): ExternalOperationReceipt | null {
    const operation = ExternalOperationSchema.parse(operationInput);
    if (fingerprintExternalOperation(operation) !== operation.fingerprint) {
      throw new Error("OPERATION_FINGERPRINT_MISMATCH");
    }
    const outbox = this.database
      .prepare("SELECT request_fingerprint FROM outbox WHERE operation_id = ?")
      .get(operation.operationId) as unknown as { request_fingerprint: string } | undefined;
    if (outbox === undefined) return null;
    if (outbox.request_fingerprint !== operation.fingerprint) {
      throw new Error("OPERATION_ID_REUSED_WITH_DIFFERENT_PAYLOAD");
    }
    const stored = this.database
      .prepare(
        "SELECT request_fingerprint, provider_receipt_json FROM side_effect_receipts WHERE operation_id = ?",
      )
      .get(operation.operationId) as unknown as StoredReceiptRow | undefined;
    if (stored === undefined) return null;
    if (stored.request_fingerprint !== operation.fingerprint) {
      throw new Error("OPERATION_ID_REUSED_WITH_DIFFERENT_PAYLOAD");
    }
    this.options.faultInjector?.hit("during_duplicate_delivery");
    return ExternalOperationReceiptSchema.parse(JSON.parse(stored.provider_receipt_json));
  }

  private claimOne(): OutboxRow | undefined {
    const now = this.#now();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.#dispatchLeaseMs).toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database
        .prepare(
          `SELECT operation_id, request_fingerprint, operation_json, status,
                  dispatch_generation, delivery_count
             FROM outbox
            WHERE (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
               OR (status = 'in_flight' AND dispatch_expires_at <= ?)
            ORDER BY created_at, outbox_id
            LIMIT 1`,
        )
        .get(nowIso, nowIso) as unknown as OutboxRow | undefined;
      if (row === undefined) {
        this.database.exec("COMMIT");
        return undefined;
      }
      const nextGeneration = row.dispatch_generation + 1;
      this.database
        .prepare(
          `UPDATE outbox
              SET status = 'in_flight', dispatch_owner = ?, dispatch_generation = ?,
                  dispatch_expires_at = ?, delivery_count = delivery_count + 1, updated_at = ?
            WHERE operation_id = ? AND dispatch_generation = ?`,
        )
        .run(
          this.options.ownerId,
          nextGeneration,
          expiresAt,
          nowIso,
          row.operation_id,
          row.dispatch_generation,
        );
      this.database.exec("COMMIT");
      return { ...row, dispatch_generation: nextGeneration };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private finalizeReceipt(
    claimed: OutboxRow,
    operation: ExternalOperation,
    receipt: ExternalOperationReceipt,
  ): "completed" | "indeterminate" | "needs_attention" {
    const status = observedStatus(receipt);
    const recordedAt = this.#now().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database
        .prepare(
          "SELECT request_fingerprint, provider_receipt_json FROM side_effect_receipts WHERE operation_id = ?",
        )
        .get(operation.operationId) as unknown as StoredReceiptRow | undefined;
      if (existing !== undefined) {
        if (existing.request_fingerprint !== operation.fingerprint) {
          throw new Error("OPERATION_ID_REUSED_WITH_DIFFERENT_PAYLOAD");
        }
      } else {
        this.database
          .prepare(
            `INSERT INTO side_effect_receipts(
               operation_id, request_fingerprint, provider_kind, provider_receipt_json,
               evidence_id, observed_status, recorded_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            operation.operationId,
            operation.fingerprint,
            providerKind(receipt),
            JSON.stringify(receipt),
            receipt.evidence.evidenceId,
            status,
            recordedAt,
          );
        this.appendObservedEvent(operation, status, receipt, recordedAt);
      }
      const result = this.database
        .prepare(
          `UPDATE outbox
              SET status = ?, dispatch_owner = NULL, dispatch_expires_at = NULL, updated_at = ?
            WHERE operation_id = ? AND dispatch_owner = ? AND dispatch_generation = ?`,
        )
        .run(
          status,
          recordedAt,
          operation.operationId,
          this.options.ownerId,
          claimed.dispatch_generation,
        );
      if (result.changes !== 1) throw new Error("OUTBOX_DISPATCH_LEASE_LOST");
      this.database.exec("COMMIT");
      return status;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private finalizeIndeterminate(
    claimed: OutboxRow,
    operation: ExternalOperation,
    reason: string,
  ): void {
    const recordedAt = this.#now().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.appendObservedEvent(
        operation,
        "indeterminate",
        { reason, facts: [{ kind: "session_observed", state: "unknown" }] },
        recordedAt,
      );
      const result = this.database
        .prepare(
          `UPDATE outbox
              SET status = 'indeterminate', dispatch_owner = NULL,
                  dispatch_expires_at = NULL, updated_at = ?
            WHERE operation_id = ? AND dispatch_owner = ? AND dispatch_generation = ?`,
        )
        .run(
          recordedAt,
          operation.operationId,
          this.options.ownerId,
          claimed.dispatch_generation,
        );
      if (result.changes !== 1) throw new Error("OUTBOX_DISPATCH_LEASE_LOST");
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private appendObservedEvent(
    operation: ExternalOperation,
    status: "completed" | "indeterminate" | "needs_attention",
    observation: unknown,
    recordedAt: string,
  ): void {
    const aggregateId = `attempt:${operation.attemptId ?? operation.operationId}`;
    const versionRow = this.database
      .prepare("SELECT COALESCE(MAX(aggregate_version), 0) AS version FROM events WHERE aggregate_id = ?")
      .get(aggregateId) as unknown as AggregateVersionRow;
    this.database
      .prepare(
        `INSERT INTO events(
           event_id, project_id, aggregate_id, aggregate_version, event_type, event_data,
           actor_id, correlation_id, causation_id, schema_version, occurred_at, recorded_at
         ) VALUES (?, ?, ?, ?, 'ExternalOperationObserved', ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        `evt_external:${operation.operationId}:${versionRow.version + 1}`,
        operation.projectId,
        aggregateId,
        versionRow.version + 1,
        JSON.stringify({ operationId: operation.operationId, status, observation }),
        this.options.ownerId,
        operation.runId ?? operation.operationId,
        operation.operationId,
        recordedAt,
        recordedAt,
      );
  }
}
