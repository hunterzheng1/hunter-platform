import type { DatabaseSync } from "node:sqlite";

import type { LedgerEvent } from "./event-ledger-reader.js";

export interface EventProjector {
  readonly name: string;
  readonly version: number;
  apply(database: DatabaseSync, event: LedgerEvent): void;
}

interface CheckpointRow {
  readonly projector_version: number;
  readonly last_position: number;
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

interface ViewRow {
  readonly entity_type: string;
  readonly entity_id: string;
  readonly project_id: string;
  readonly entity_version: number;
  readonly view_json: string;
}

export interface ProjectionSnapshotEntry {
  readonly entityType: string;
  readonly entityId: string;
  readonly projectId: string;
  readonly entityVersion: number;
  readonly view: unknown;
}

function toEvent(row: EventRow): LedgerEvent {
  return {
    position: row.position,
    eventId: row.event_id,
    projectId: row.project_id as LedgerEvent["projectId"],
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
  };
}

export class ProjectionRunner {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly projectors: readonly EventProjector[],
  ) {
    const names = projectors.map(({ name }) => name);
    if (new Set(names).size !== names.length) throw new Error("DUPLICATE_PROJECTOR_NAME");
  }

  public runIncremental(batchSize = 100): { readonly applied: number; readonly highWaterPosition: number } {
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > 10_000) {
      throw new Error("PROJECTION_BATCH_SIZE_INVALID");
    }
    let totalApplied = 0;
    let highWaterPosition = 0;
    for (const projector of this.projectors) {
      const result = this.runProjectorBatch(projector, batchSize);
      totalApplied += result.applied;
      highWaterPosition = Math.max(highWaterPosition, result.highWaterPosition);
    }
    return { applied: totalApplied, highWaterPosition };
  }

  public rebuild(projectorName: string): void {
    const projector = this.projectors.find(({ name }) => name === projectorName);
    if (projector === undefined) throw new Error("PROJECTOR_NOT_FOUND");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.reset(projector.name);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    for (;;) {
      const result = this.runProjectorBatch(projector, 1_000);
      if (result.applied === 0) return;
    }
  }

  public snapshot(projectorName: string): readonly ProjectionSnapshotEntry[] {
    const rows = this.database
      .prepare(
        `SELECT entity_type, entity_id, project_id, entity_version, view_json
           FROM entity_views
          WHERE projector_name = ?
          ORDER BY entity_type, entity_id`,
      )
      .all(projectorName) as unknown as ViewRow[];
    return rows.map((row) => ({
      entityType: row.entity_type,
      entityId: row.entity_id,
      projectId: row.project_id,
      entityVersion: row.entity_version,
      view: JSON.parse(row.view_json) as unknown,
    }));
  }

  private runProjectorBatch(
    projector: EventProjector,
    batchSize: number,
  ): { readonly applied: number; readonly highWaterPosition: number } {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      let checkpoint = this.database
        .prepare(
          "SELECT projector_version, last_position FROM projection_checkpoints WHERE projector_name = ?",
        )
        .get(projector.name) as unknown as CheckpointRow | undefined;
      if (checkpoint !== undefined && checkpoint.projector_version !== projector.version) {
        this.reset(projector.name);
        checkpoint = undefined;
      }
      const lastPosition = checkpoint?.last_position ?? 0;
      const rows = this.database
        .prepare(
          `SELECT position, event_id, project_id, aggregate_id, aggregate_version,
                  event_type, event_data, actor_id, correlation_id, causation_id,
                  schema_version, occurred_at, recorded_at
             FROM events
            WHERE position > ?
            ORDER BY position
            LIMIT ?`,
        )
        .all(lastPosition, batchSize) as unknown as EventRow[];
      for (const row of rows) projector.apply(this.database, toEvent(row));
      const highWaterPosition = rows.at(-1)?.position ?? lastPosition;
      const updatedAt = rows.at(-1)?.recorded_at ?? new Date(0).toISOString();
      this.database
        .prepare(
          `INSERT INTO projection_checkpoints(
             projector_name, projector_version, last_position, updated_at
           ) VALUES (?, ?, ?, ?)
           ON CONFLICT(projector_name) DO UPDATE SET
             projector_version = excluded.projector_version,
             last_position = excluded.last_position,
             updated_at = excluded.updated_at`,
        )
        .run(projector.name, projector.version, highWaterPosition, updatedAt);
      this.database.exec("COMMIT");
      return { applied: rows.length, highWaterPosition };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private reset(projectorName: string): void {
    this.database.prepare("DELETE FROM entity_views WHERE projector_name = ?").run(projectorName);
    this.database.prepare("DELETE FROM projection_checkpoints WHERE projector_name = ?").run(projectorName);
  }
}
