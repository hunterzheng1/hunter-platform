import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

import { ConnectorIdSchema, EvidenceIdSchema } from "@hunter/domain";
import {
  ExternalOperationSchema,
  decodeExternalOperationReceipt,
  decodeExternalOperationReconciliation,
  fingerprintExternalOperation,
  type ExternalOperation,
  type ExternalOperationHandler,
  type ExternalOperationReconciler,
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
  readonly dispatchAuthority?: (operation: ExternalOperation) =>
    | { readonly allowed: true }
    | { readonly allowed: false; readonly reason: string };
  readonly prepareReceiptTransaction?: (
    operation: ExternalOperation,
    receipt: ExternalOperationReceipt,
  ) =>
    | void
    | (() => void)
    | Promise<void | (() => void)>;
  readonly faultInjector?: FaultSink;
}

export interface InspectableExternalOperationHandler extends ExternalOperationHandler {
  inspect(operation: ExternalOperation): Promise<ExternalOperationReceipt | null>;
}

function canInspect(handler: ExternalOperationHandler): handler is InspectableExternalOperationHandler {
  return "inspect" in handler && typeof handler.inspect === "function";
}

function canReconcile(
  handler: ExternalOperationHandler,
): handler is ExternalOperationHandler & ExternalOperationReconciler {
  return "reconcile" in handler && typeof handler.reconcile === "function";
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
    if (uncertainPriorDelivery) {
      const replayPolicy = this.#replayPolicy(operation);
      if (replayPolicy === "unsafe") {
        this.finalizeIndeterminate(
          claimed,
          operation,
          "prior_delivery_outcome_unprovable",
          "needs_attention",
        );
        return "needs_attention";
      }
      if (replayPolicy === "inspectable") {
        if (canReconcile(this.handler)) {
          const reconciled = decodeExternalOperationReconciliation(
            await this.handler.reconcile(operation),
          );
          if (reconciled.outcome === "attached") {
            const receipt = reconciled.receipt;
            if (
              receipt.operationId !== operation.operationId ||
              receipt.fingerprint !== operation.fingerprint
            ) {
              this.finalizeIndeterminate(
                claimed,
                operation,
                "reconciliation_receipt_identity_mismatch",
                "needs_attention",
              );
              return "needs_attention";
            }
            return await this.finalizeReceipt(claimed, operation, receipt);
          }
          if (reconciled.outcome === "unknown") {
            this.finalizeIndeterminate(
              claimed,
              operation,
              "reconciliation_unknown",
              "needs_attention",
            );
            return "needs_attention";
          }
          // A confirmed absence is the only uncertain-delivery result that is
          // allowed to reach the single dispatch below.
        } else if (!canInspect(this.handler)) {
          this.finalizeIndeterminate(
            claimed,
            operation,
            "inspection_not_available",
            "needs_attention",
          );
          return "needs_attention";
        } else {
          const inspected = await this.handler.inspect(operation);
          if (inspected === null) {
            this.finalizeIndeterminate(
              claimed,
              operation,
              "inspection_outcome_unprovable",
              "needs_attention",
            );
            return "needs_attention";
          }
          const receipt = decodeExternalOperationReceipt(inspected);
          if (
            receipt.operationId !== operation.operationId ||
            receipt.fingerprint !== operation.fingerprint
          ) {
            this.finalizeIndeterminate(
              claimed,
              operation,
              "inspection_receipt_identity_mismatch",
              "needs_attention",
            );
            return "needs_attention";
          }
          return await this.finalizeReceipt(claimed, operation, receipt);
        }
      }
    }

    let authority: { readonly allowed: true } | { readonly allowed: false; readonly reason: string } = { allowed: true };
    if (this.options.dispatchAuthority !== undefined) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        authority = this.options.dispatchAuthority(operation);
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    if (!authority.allowed) {
      this.finalizeIndeterminate(claimed, operation, authority.reason, "needs_attention");
      return "needs_attention";
    }
    let receipt: ExternalOperationReceipt;
    try {
      receipt = decodeExternalOperationReceipt(
        await this.handler.execute(operation),
      );
    } catch {
      this.finalizeIndeterminate(
        claimed,
        operation,
        "provider_execution_or_receipt_invalid",
        "needs_attention",
      );
      return "needs_attention";
    }
    if (receipt.operationId !== operation.operationId || receipt.fingerprint !== operation.fingerprint) {
      this.finalizeIndeterminate(claimed, operation, "provider_receipt_identity_mismatch");
      return "indeterminate";
    }
    this.options.faultInjector?.hit("after_provider_success_before_receipt_commit");
    const status = await this.finalizeReceipt(claimed, operation, receipt);

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
    return decodeExternalOperationReceipt(JSON.parse(stored.provider_receipt_json));
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

  private async finalizeReceipt(
    claimed: OutboxRow,
    operation: ExternalOperation,
    receipt: ExternalOperationReceipt,
  ): Promise<"completed" | "indeterminate" | "needs_attention"> {
    let receiptTransaction: (() => void) | undefined;
    try {
      receiptTransaction =
        await this.options.prepareReceiptTransaction?.(operation, receipt)
        ?? undefined;
    } catch {
      this.finalizeIndeterminate(
        claimed,
        operation,
        "receipt_transaction_preparation_failed",
        "needs_attention",
      );
      return "needs_attention";
    }
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
        this.recordEvidence(operation, receipt, status, recordedAt);
        this.appendObservedEvent(operation, status, receipt, recordedAt);
        receiptTransaction?.();
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
      this.database.prepare(
        `UPDATE outbox
            SET status = 'pending', dispatch_owner = NULL,
                dispatch_expires_at = NULL, updated_at = ?
          WHERE operation_id = ? AND dispatch_owner = ? AND dispatch_generation = ?`,
      ).run(
        this.#now().toISOString(),
        operation.operationId,
        this.options.ownerId,
        claimed.dispatch_generation,
      );
      throw error;
    }
  }

  private finalizeIndeterminate(
    claimed: OutboxRow,
    operation: ExternalOperation,
    reason: string,
    status: "indeterminate" | "needs_attention" = "indeterminate",
  ): void {
    const recordedAt = this.#now().toISOString();
    const evidencePayload = {
      operationId: operation.operationId,
      fingerprint: operation.fingerprint,
      status,
      reason,
    };
    const receipt: ExternalOperationReceipt = {
      schemaVersion: 1,
      operationId: operation.operationId,
      fingerprint: operation.fingerprint,
      operationStatus: "indeterminate",
      subject: {
        kind: "connector",
        connectorId: ConnectorIdSchema.parse("con_hunter_foundation"),
        implementationVersion: "1",
      },
      nativeReferences: [],
      facts: [{ kind: "session_observed", state: "unknown" }],
      evidence: {
        evidenceId: EvidenceIdSchema.parse(
          `evd_${createHash("sha256").update(operation.operationId).digest("hex").slice(0, 24)}`,
        ),
        evidenceHash: createHash("sha256")
          .update(JSON.stringify(evidencePayload))
          .digest("hex"),
        proofScope: "contract_only",
      },
      observedAt: recordedAt,
    };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(
        `INSERT INTO side_effect_receipts(
           operation_id, request_fingerprint, provider_kind, provider_receipt_json,
           evidence_id, observed_status, recorded_at
         ) VALUES (?, ?, 'hunter:foundation', ?, ?, ?, ?)`,
      ).run(
        operation.operationId,
        operation.fingerprint,
        JSON.stringify(receipt),
        receipt.evidence.evidenceId,
        status,
        recordedAt,
      );
      this.recordEvidence(operation, receipt, status, recordedAt, { reason });
      this.appendObservedEvent(
        operation,
        status,
        {
          reason,
          operationStatus: "indeterminate",
          requiresAttention: status === "needs_attention",
          facts: [{ kind: "session_observed", state: "unknown" }],
        },
        recordedAt,
      );
      const result = this.database
        .prepare(
          `UPDATE outbox
              SET status = ?, dispatch_owner = NULL,
                  dispatch_expires_at = NULL, updated_at = ?
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

  private recordEvidence(
    operation: ExternalOperation,
    receipt: ExternalOperationReceipt,
    status: "completed" | "indeterminate" | "needs_attention",
    recordedAt: string,
    supplemental: Readonly<Record<string, unknown>> = {},
  ): void {
    this.database.prepare(
      `INSERT INTO evidence_records(
         evidence_id, operation_id, evidence_hash, observed_status,
         proof_scope, observed_at, payload_json, recorded_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      receipt.evidence.evidenceId,
      operation.operationId,
      receipt.evidence.evidenceHash,
      status,
      receipt.evidence.proofScope,
      receipt.observedAt,
      JSON.stringify({
        facts: receipt.facts,
        nativeReferences: receipt.nativeReferences,
        subject: receipt.subject,
        ...supplemental,
      }),
      recordedAt,
    );
  }
}
