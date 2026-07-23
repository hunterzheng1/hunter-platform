import { existsSync, readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import type { ProjectId } from "@hunter/domain";
import {
  ExternalOperationSchema,
  fingerprintExternalOperation,
  type ExternalOperation,
} from "@hunter/runtime-contracts";

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

function loadCoreMigration(): string {
  const candidates = [
    new URL("./migrations/001-core.sql", import.meta.url),
    new URL("../src/migrations/001-core.sql", import.meta.url),
  ];
  const migration = candidates.find((candidate) => existsSync(candidate));
  if (migration === undefined) throw new Error("CORE_MIGRATION_NOT_FOUND");
  return readFileSync(migration, "utf8");
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

export class SqliteOperationJournal {
  private transactionDepth = 0;

  public constructor(private readonly database: DatabaseSync) {
    this.database.exec(loadCoreMigration());
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
