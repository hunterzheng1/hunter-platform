import type { DatabaseSync } from "node:sqlite";

import type { ProjectId } from "@hunter/domain";

interface HighWaterRow {
  readonly position: number;
}

interface MetadataRow {
  readonly metadata_value: string;
}

interface EventRow {
  readonly position: number;
  readonly event_id: string;
  readonly project_id: string;
  readonly aggregate_id: string;
  readonly aggregate_version: number;
  readonly event_type: string;
  readonly event_data: string;
  readonly actor_id: string;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly schema_version: number;
  readonly occurred_at: string;
  readonly recorded_at: string;
}

export interface LedgerEvent {
  readonly position: number;
  readonly eventId: string;
  readonly projectId: ProjectId;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly eventType: string;
  readonly eventData: unknown;
  readonly actorId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly schemaVersion: number;
  readonly occurredAt: string;
  readonly recordedAt: string;
}

export type LedgerReadResult =
  | {
      readonly status: "ok";
      readonly retentionFloor: number;
      readonly highWaterPosition: number;
      readonly events: readonly LedgerEvent[];
    }
  | {
      readonly status: "resync_required";
      readonly retentionFloor: number;
      readonly highWaterPosition: number;
    };

export class EventCursorResyncRequiredError extends Error {
  public constructor(
    public readonly retentionFloor: number,
    public readonly highWaterPosition: number,
  ) {
    super("EVENT_CURSOR_RESYNC_REQUIRED");
    this.name = "EventCursorResyncRequiredError";
  }
}

function waitForPoll(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export class EventLedgerReader {
  public constructor(private readonly database: DatabaseSync) {}

  public highWaterPosition(): number {
    const row = this.database
      .prepare("SELECT COALESCE(MAX(position), 0) AS position FROM events")
      .get() as unknown as HighWaterRow;
    return row.position;
  }

  public retentionFloor(): number {
    const row = this.database
      .prepare("SELECT metadata_value FROM storage_metadata WHERE metadata_key = 'event_retention_floor'")
      .get() as unknown as MetadataRow | undefined;
    if (row === undefined) return 0;
    const position = Number(row.metadata_value);
    if (!Number.isSafeInteger(position) || position < 0) throw new Error("EVENT_RETENTION_FLOOR_CORRUPT");
    return position;
  }

  public setRetentionFloor(position: number): void {
    if (!Number.isSafeInteger(position) || position < 0) throw new Error("EVENT_RETENTION_FLOOR_INVALID");
    this.database
      .prepare(
        `INSERT INTO storage_metadata(metadata_key, metadata_value, updated_at)
         VALUES ('event_retention_floor', ?, ?)
         ON CONFLICT(metadata_key) DO UPDATE SET
           metadata_value = excluded.metadata_value,
           updated_at = excluded.updated_at`,
      )
      .run(String(position), new Date().toISOString());
  }

  public readAfter(input: {
    readonly position: number;
    readonly authorizedProjectIds: readonly ProjectId[];
    readonly limit: number;
  }): LedgerReadResult {
    if (!Number.isSafeInteger(input.position) || input.position < 0) {
      throw new Error("EVENT_CURSOR_INVALID");
    }
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0 || input.limit > 1_000) {
      throw new Error("EVENT_PAGE_LIMIT_INVALID");
    }
    const retentionFloor = this.retentionFloor();
    const highWaterPosition = this.highWaterPosition();
    if (input.position < retentionFloor) {
      return { status: "resync_required", retentionFloor, highWaterPosition };
    }
    const projectIds = [...new Set(input.authorizedProjectIds)];
    if (projectIds.length === 0) {
      return { status: "ok", retentionFloor, highWaterPosition, events: [] };
    }
    const placeholders = projectIds.map(() => "?").join(", ");
    const rows = this.database
      .prepare(
        `SELECT position, event_id, project_id, aggregate_id, aggregate_version,
                event_type, event_data, actor_id, correlation_id, causation_id,
                schema_version, occurred_at, recorded_at
           FROM events
          WHERE position > ? AND project_id IN (${placeholders})
          ORDER BY position
          LIMIT ?`,
      )
      .all(input.position, ...projectIds, input.limit) as unknown as EventRow[];
    return {
      status: "ok",
      retentionFloor,
      highWaterPosition,
      events: rows.map((row) => ({
        position: row.position,
        eventId: row.event_id,
        projectId: row.project_id as ProjectId,
        aggregateId: row.aggregate_id,
        aggregateVersion: row.aggregate_version,
        eventType: row.event_type,
        eventData: JSON.parse(row.event_data) as unknown,
        actorId: row.actor_id,
        correlationId: row.correlation_id,
        causationId: row.causation_id,
        schemaVersion: row.schema_version,
        occurredAt: row.occurred_at,
        recordedAt: row.recorded_at,
      })),
    };
  }

  public async *tail(input: {
    readonly position: number;
    readonly authorizedProjectIds: readonly ProjectId[];
    readonly limit?: number;
    readonly pollIntervalMs?: number;
    readonly signal?: AbortSignal;
  }): AsyncGenerator<LedgerEvent, void, void> {
    const pollIntervalMs = input.pollIntervalMs ?? 100;
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) {
      throw new Error("EVENT_POLL_INTERVAL_INVALID");
    }
    let position = input.position;
    while (input.signal?.aborted !== true) {
      const page = this.readAfter({
        position,
        authorizedProjectIds: input.authorizedProjectIds,
        limit: input.limit ?? 100,
      });
      if (page.status === "resync_required") {
        throw new EventCursorResyncRequiredError(page.retentionFloor, page.highWaterPosition);
      }
      if (page.events.length === 0) {
        position = page.highWaterPosition;
        await waitForPoll(pollIntervalMs, input.signal);
        continue;
      }
      for (const event of page.events) {
        position = event.position;
        yield event;
      }
    }
  }
}
