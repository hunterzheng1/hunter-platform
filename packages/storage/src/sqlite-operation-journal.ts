import type { DatabaseSync } from "node:sqlite";

import {
  AttemptIdSchema,
  OperationIdSchema,
  RunIdSchema,
  type AttemptId,
  type OperationId,
  type ProjectId,
  type RunId,
} from "@hunter/domain";
import {
  ExternalOperationSchema,
  fingerprintExternalOperation,
  type ExternalOperation,
} from "@hunter/runtime-contracts";
import {
  loadStorageMigrations,
  runStorageMigrations,
  type StorageMigrationReceipt,
} from "./migration-runner.js";

export interface ActorContext {
  readonly actorId: string;
  readonly correlationId: string;
  readonly causationId?: string | undefined;
}

export interface NewDomainEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly eventData: unknown;
  readonly schemaVersion: number;
  readonly occurredAt: string;
}

export interface CommitCommand {
  readonly commandId: string;
  readonly requestFingerprint: string;
  readonly projectId: ProjectId;
  readonly aggregateId: string;
  readonly expectedVersion: number;
  readonly actor: ActorContext;
  readonly events: readonly NewDomainEvent[];
  readonly operations: readonly ExternalOperation[];
  readonly response: unknown;
}

export interface CommandReceipt {
  readonly commandId: string;
  readonly firstPosition: number | null;
  readonly lastPosition: number | null;
  readonly response: unknown;
  readonly committedAt: string;
}

export interface TerminalRunArchiveSchedule {
  readonly projectId: ProjectId;
  readonly runId: RunId;
  readonly outcome: "succeeded" | "failed" | "canceled";
  readonly firstPosition: number;
  readonly lastPosition: number;
  readonly actorId: string;
  readonly correlationId: string;
  readonly occurredAt: string;
}

export interface SqliteOperationJournalOptions {
  readonly scheduleTerminalRunArchive?: ((input: TerminalRunArchiveSchedule) => void) | undefined;
}

export type OutboxOperationStatus =
  | "pending"
  | "in_flight"
  | "completed"
  | "indeterminate"
  | "needs_attention";

export interface JournaledOperationState {
  readonly operation: ExternalOperation;
  readonly status: OutboxOperationStatus;
}

export interface UnprovenOperationState {
  readonly operationId: OperationId;
  readonly runId: RunId | null;
  readonly attemptId: AttemptId | null;
  readonly status: "indeterminate" | "needs_attention";
}

interface ReceiptRow {
  readonly command_id: string;
  readonly request_fingerprint: string;
  readonly first_position: number | null;
  readonly last_position: number | null;
  readonly response_json: string;
  readonly committed_at: string;
}

interface VersionRow {
  readonly version: number;
}

function requireNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`${label}_REQUIRED`);
}

function validateCommand(command: CommitCommand): void {
  requireNonEmpty(command.commandId, "COMMAND_ID");
  requireNonEmpty(command.aggregateId, "AGGREGATE_ID");
  requireNonEmpty(command.actor.actorId, "ACTOR_ID");
  requireNonEmpty(command.actor.correlationId, "CORRELATION_ID");
  if (!/^[a-f0-9]{64}$/u.test(command.requestFingerprint)) {
    throw new Error("REQUEST_FINGERPRINT_INVALID");
  }
  if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 0) {
    throw new Error("EXPECTED_VERSION_INVALID");
  }
  for (const event of command.events) {
    requireNonEmpty(event.eventId, "EVENT_ID");
    requireNonEmpty(event.eventType, "EVENT_TYPE");
    if (!Number.isSafeInteger(event.schemaVersion) || event.schemaVersion <= 0) {
      throw new Error("EVENT_SCHEMA_VERSION_INVALID");
    }
    if (Number.isNaN(Date.parse(event.occurredAt))) throw new Error("EVENT_OCCURRED_AT_INVALID");
  }
}

function toReceipt(row: ReceiptRow): CommandReceipt {
  return {
    commandId: row.command_id,
    firstPosition: row.first_position,
    lastPosition: row.last_position,
    response: JSON.parse(row.response_json) as unknown,
    committedAt: row.committed_at,
  };
}

function terminalRunOutcome(
  event: NewDomainEvent,
): "succeeded" | "failed" | "canceled" | null {
  if (
    event.eventType !== "FlowEvent" ||
    typeof event.eventData !== "object" ||
    event.eventData === null ||
    !("flowEvent" in event.eventData)
  ) {
    return null;
  }
  const flowEvent = event.eventData.flowEvent;
  if (
    typeof flowEvent !== "object" ||
    flowEvent === null ||
    !("type" in flowEvent) ||
    flowEvent.type !== "RunConcluded" ||
    !("status" in flowEvent)
  ) {
    return null;
  }
  return flowEvent.status === "succeeded" ||
    flowEvent.status === "failed" ||
    flowEvent.status === "canceled"
    ? flowEvent.status
    : null;
}

export class SqliteOperationJournal {
  private transactionDepth = 0;
  public readonly migrationReceipt: StorageMigrationReceipt;

  public constructor(
    private readonly database: DatabaseSync,
    private readonly options: SqliteOperationJournalOptions = {},
  ) {
    this.migrationReceipt = runStorageMigrations(
      this.database,
      loadStorageMigrations(),
    );
  }

  public runInImmediateTransaction<T>(work: () => T): T {
    if (this.transactionDepth > 0) return work();
    this.database.exec("BEGIN IMMEDIATE");
    this.transactionDepth += 1;
    try {
      const result = work();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  public findOperation(operationIdInput: OperationId): JournaledOperationState | null {
    const operationId = OperationIdSchema.parse(operationIdInput);
    const row = this.database.prepare(
      "SELECT operation_json, status FROM outbox WHERE operation_id = ?",
    ).get(operationId) as {
      readonly operation_json: string;
      readonly status: OutboxOperationStatus;
    } | undefined;
    if (row === undefined) return null;
    const operation = ExternalOperationSchema.parse(
      JSON.parse(row.operation_json) as unknown,
    );
    if (operation.operationId !== operationId) {
      throw new Error("JOURNALED_OPERATION_IDENTITY_MISMATCH");
    }
    return { operation, status: row.status };
  }

  public aggregateVersion(aggregateId: string): number {
    requireNonEmpty(aggregateId, "AGGREGATE_ID");
    const row = this.database.prepare(
      "SELECT COALESCE(MAX(aggregate_version), 0) AS version FROM events WHERE aggregate_id = ?",
    ).get(aggregateId) as unknown as VersionRow;
    return row.version;
  }

  public reconcileObservedOperations(at: Date): void {
    this.database.prepare(
      `UPDATE outbox
          SET status = (
                SELECT observed_status
                  FROM side_effect_receipts
                 WHERE side_effect_receipts.operation_id = outbox.operation_id
              ),
              dispatch_owner = NULL,
              dispatch_expires_at = NULL,
              updated_at = ?
        WHERE EXISTS (
                SELECT 1
                  FROM side_effect_receipts
                 WHERE side_effect_receipts.operation_id = outbox.operation_id
              )
          AND status <> (
                SELECT observed_status
                  FROM side_effect_receipts
                 WHERE side_effect_receipts.operation_id = outbox.operation_id
              )`,
    ).run(at.toISOString());
  }

  public listUnprovenOperations(): readonly UnprovenOperationState[] {
    const rows = this.database.prepare(
      `SELECT operation_id, run_id, attempt_id, status
         FROM outbox
        WHERE status IN ('indeterminate', 'needs_attention')
        ORDER BY operation_id`,
    ).all() as unknown as Array<{
      readonly operation_id: string;
      readonly run_id: string | null;
      readonly attempt_id: string | null;
      readonly status: "indeterminate" | "needs_attention";
    }>;
    return rows.map((row) => ({
      operationId: OperationIdSchema.parse(row.operation_id),
      runId: row.run_id === null ? null : RunIdSchema.parse(row.run_id),
      attemptId:
        row.attempt_id === null ? null : AttemptIdSchema.parse(row.attempt_id),
      status: row.status,
    }));
  }

  public commitCommand(command: CommitCommand): CommandReceipt {
    validateCommand(command);
    return this.runInImmediateTransaction(() => {
      const existing = this.database
        .prepare(
          `SELECT command_id, request_fingerprint, first_position, last_position, response_json, committed_at
             FROM command_receipts WHERE command_id = ?`,
        )
        .get(command.commandId) as unknown as ReceiptRow | undefined;
      if (existing !== undefined) {
        if (existing.request_fingerprint !== command.requestFingerprint) {
          throw new Error("IDEMPOTENCY_KEY_REUSED");
        }
        return toReceipt(existing);
      }

      const versionRow = this.database
        .prepare("SELECT COALESCE(MAX(aggregate_version), 0) AS version FROM events WHERE aggregate_id = ?")
        .get(command.aggregateId) as unknown as VersionRow;
      if (versionRow.version !== command.expectedVersion) {
        throw new Error(
          `EXPECTED_VERSION_CONFLICT expected=${command.expectedVersion} actual=${versionRow.version}`,
        );
      }

      const committedAt = new Date().toISOString();
      const insertEvent = this.database.prepare(
        `INSERT INTO events(
           event_id, project_id, aggregate_id, aggregate_version, event_type, event_data,
           actor_id, correlation_id, causation_id, schema_version, occurred_at, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let firstPosition: number | null = null;
      let lastPosition: number | null = null;
      for (const [index, event] of command.events.entries()) {
        const result = insertEvent.run(
          event.eventId,
          command.projectId,
          command.aggregateId,
          command.expectedVersion + index + 1,
          event.eventType,
          JSON.stringify(event.eventData),
          command.actor.actorId,
          command.actor.correlationId,
          command.actor.causationId ?? null,
          event.schemaVersion,
          event.occurredAt,
          committedAt,
        );
        const position = Number(result.lastInsertRowid);
        firstPosition ??= position;
        lastPosition = position;
      }

      const insertOutbox = this.database.prepare(
        `INSERT INTO outbox(
           outbox_id, operation_id, request_fingerprint, project_id, run_id, attempt_id,
           operation_type, operation_version, payload_json, operation_json, status,
           dispatch_owner, dispatch_generation, dispatch_expires_at, delivery_count,
           next_attempt_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 0, NULL, 0, NULL, ?, ?)`,
      );
      for (const candidate of command.operations) {
        const operation = ExternalOperationSchema.parse(candidate);
        if (operation.projectId !== command.projectId) throw new Error("OPERATION_PROJECT_SCOPE_MISMATCH");
        if (fingerprintExternalOperation(operation) !== operation.fingerprint) {
          throw new Error("OPERATION_FINGERPRINT_MISMATCH");
        }
        insertOutbox.run(
          `outbox:${operation.operationId}`,
          operation.operationId,
          operation.fingerprint,
          operation.projectId,
          operation.runId,
          operation.attemptId,
          operation.operationType,
          operation.operationVersion,
          JSON.stringify(operation.payload),
          JSON.stringify(operation),
          committedAt,
          committedAt,
        );
      }

      const terminalEvents = command.events
        .map((event) => ({ event, outcome: terminalRunOutcome(event) }))
        .filter(
          (
            candidate,
          ): candidate is {
            readonly event: NewDomainEvent;
            readonly outcome: "succeeded" | "failed" | "canceled";
          } => candidate.outcome !== null,
        );
      if (terminalEvents.length > 1) {
        throw new Error("MULTIPLE_TERMINAL_RUN_EVENTS");
      }
      if (
        terminalEvents.length === 1 &&
        this.options.scheduleTerminalRunArchive !== undefined
      ) {
        const runId = RunIdSchema.parse(
          command.aggregateId.startsWith("run:")
            ? command.aggregateId.slice("run:".length)
            : command.aggregateId,
        );
        const range = this.database.prepare(
          `SELECT MIN(position) AS first_position, MAX(position) AS last_position
             FROM events WHERE aggregate_id = ?`,
        ).get(command.aggregateId) as unknown as {
          readonly first_position: number | null;
          readonly last_position: number | null;
        };
        if (range.first_position === null || range.last_position === null) {
          throw new Error("TERMINAL_RUN_LEDGER_RANGE_MISSING");
        }
        const terminal = terminalEvents[0];
        if (terminal === undefined) throw new Error("TERMINAL_RUN_EVENT_MISSING");
        this.options.scheduleTerminalRunArchive({
          projectId: command.projectId,
          runId,
          outcome: terminal.outcome,
          firstPosition: range.first_position,
          lastPosition: range.last_position,
          actorId: command.actor.actorId,
          correlationId: command.actor.correlationId,
          occurredAt: terminal.event.occurredAt,
        });
      }

      this.database
        .prepare(
          `INSERT INTO command_receipts(
             command_id, request_fingerprint, project_id, aggregate_id,
             first_position, last_position, response_json, committed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          command.commandId,
          command.requestFingerprint,
          command.projectId,
          command.aggregateId,
          firstPosition,
          lastPosition,
          JSON.stringify(command.response),
          committedAt,
        );

      return {
        commandId: command.commandId,
        firstPosition,
        lastPosition,
        response: command.response,
        committedAt,
      };
    });
  }
}
