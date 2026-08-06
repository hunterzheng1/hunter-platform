import type { Pool, QueryResultRow } from "pg";

import {
  deriveRunStatus,
  type IngestEventInput,
  type IngestItemResult,
  type RunEventRecord,
  type RunRecord,
  type RunStore,
  type RunStatus,
  type ConnectionStatus,
  type SyncCompleteness
} from "./store.js";

function runFrom(row: QueryResultRow): RunRecord {
  return {
    runId: String(row.run_id),
    projectId: String(row.project_id),
    changeKey: String(row.change_key),
    title: row.title == null ? null : String(row.title),
    runStatus: String(row.run_status) as RunStatus,
    connectionStatus: String(row.connection_status) as ConnectionStatus,
    syncCompleteness: String(row.sync_completeness) as SyncCompleteness,
    currentPhase: row.current_phase == null ? null : String(row.current_phase),
    startedAt: row.started_at == null ? null : new Date(row.started_at).toISOString(),
    endedAt: row.ended_at == null ? null : new Date(row.ended_at).toISOString(),
    lastEventAt: row.last_event_at == null ? null : new Date(row.last_event_at).toISOString(),
    lastHeartbeatAt: row.last_heartbeat_at == null
      ? null
      : new Date(row.last_heartbeat_at).toISOString(),
    serverCursor: Number(row.server_cursor),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

function eventFrom(row: QueryResultRow): RunEventRecord {
  return {
    serverCursor: Number(row.server_cursor),
    projectId: String(row.project_id),
    runId: String(row.run_id),
    eventId: String(row.event_id),
    producerSeq: Number(row.producer_seq),
    eventType: String(row.event_type),
    phase: row.phase == null ? null : String(row.phase),
    occurredAt: new Date(row.occurred_at).toISOString(),
    payload: (row.payload ?? {}) as Record<string, unknown>,
    receivedAt: new Date(row.received_at).toISOString()
  };
}

export class PgRunStore implements RunStore {
  constructor(private readonly pool: Pool) {}

  async ensureRun(input: {
    runId: string;
    projectId: string;
    changeKey: string;
    title?: string;
  }): Promise<RunRecord> {
    const result = await this.pool.query(
      `INSERT INTO runs(run_id, project_id, change_key, title, started_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (run_id) DO UPDATE SET updated_at = runs.updated_at
       RETURNING *`,
      [input.runId, input.projectId, input.changeKey, input.title ?? input.changeKey]
    );
    return runFrom(result.rows[0] ?? {});
  }

  async ingestBatch(input: {
    projectId: string;
    runId: string;
    events: IngestEventInput[];
  }): Promise<{ items: IngestItemResult[]; run: RunRecord }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const runResult = await client.query(
        `SELECT * FROM runs WHERE run_id = $1 AND project_id = $2 FOR UPDATE`,
        [input.runId, input.projectId]
      );
      if (runResult.rowCount === 0) throw new Error("RUN_NOT_FOUND");
      let run = runFrom(runResult.rows[0] ?? {});
      const items: IngestItemResult[] = [];

      for (const event of input.events) {
        if (!event.eventId || !event.eventType || event.producerSeq < 1) {
          items.push({
            id: event.eventId || "",
            status: "rejected_schema",
            server_cursor: null,
            error_code: "INVALID_EVENT"
          });
          continue;
        }
        const existing = await client.query(
          `SELECT * FROM run_events WHERE project_id = $1 AND event_id = $2`,
          [input.projectId, event.eventId]
        );
        if ((existing.rowCount ?? 0) > 0) {
          const row = eventFrom(existing.rows[0] ?? {});
          const same = row.producerSeq === event.producerSeq && row.eventType === event.eventType;
          items.push({
            id: event.eventId,
            status: same ? "duplicate_accepted" : "id_conflict",
            server_cursor: same ? row.serverCursor : null,
            error_code: same ? null : "ID_CONFLICT"
          });
          continue;
        }
        const seqConflict = await client.query(
          `SELECT 1 FROM run_events WHERE run_id = $1 AND producer_seq = $2`,
          [input.runId, event.producerSeq]
        );
        if ((seqConflict.rowCount ?? 0) > 0) {
          items.push({
            id: event.eventId,
            status: "id_conflict",
            server_cursor: null,
            error_code: "SEQ_CONFLICT"
          });
          continue;
        }
        const inserted = await client.query(
          `INSERT INTO run_events(
             project_id, run_id, event_id, producer_seq, event_type, phase, occurred_at, payload
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
           RETURNING *`,
          [
            input.projectId,
            input.runId,
            event.eventId,
            event.producerSeq,
            event.eventType,
            event.phase ?? null,
            event.occurredAt,
            JSON.stringify(event.payload)
          ]
        );
        const record = eventFrom(inserted.rows[0] ?? {});
        const nextStatus = deriveRunStatus(run.runStatus, event.eventType, {
          ...event.payload,
          phase: event.phase
        });
        const updated = await client.query(
          `UPDATE runs SET
             server_cursor = $2,
             last_event_at = $3,
             current_phase = COALESCE($4, current_phase),
             run_status = $5,
             ended_at = CASE
               WHEN $5 <> 'running' AND ended_at IS NULL THEN $3::timestamptz
               ELSE ended_at
             END,
             connection_status = 'online',
             updated_at = now()
           WHERE run_id = $1
           RETURNING *`,
          [input.runId, record.serverCursor, event.occurredAt, event.phase ?? null, nextStatus]
        );
        run = runFrom(updated.rows[0] ?? {});
        items.push({
          id: event.eventId,
          status: "accepted",
          server_cursor: record.serverCursor,
          error_code: null
        });
      }

      const seqs = await client.query(
        `SELECT producer_seq FROM run_events WHERE run_id = $1 ORDER BY producer_seq`,
        [input.runId]
      );
      const values = seqs.rows.map((row) => Number(row.producer_seq));
      const completeness = isContiguous(values) ? "complete" : "gapped";
      const final = await client.query(
        `UPDATE runs SET sync_completeness = $2, updated_at = now()
         WHERE run_id = $1 RETURNING *`,
        [input.runId, completeness]
      );
      run = runFrom(final.rows[0] ?? {});
      await client.query("COMMIT");
      return { items, run };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async heartbeat(input: {
    projectId: string;
    runId: string;
    clientTime: string;
  }): Promise<RunRecord | null> {
    const result = await this.pool.query(
      `UPDATE runs SET
         last_heartbeat_at = $3,
         connection_status = 'online',
         updated_at = now()
       WHERE run_id = $1 AND project_id = $2
       RETURNING *`,
      [input.runId, input.projectId, input.clientTime]
    );
    return result.rowCount === 0 ? null : runFrom(result.rows[0] ?? {});
  }

  async listRuns(projectId: string, limit = 50): Promise<RunRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM runs
       WHERE project_id = $1
       ORDER BY COALESCE(last_event_at, created_at) DESC
       LIMIT $2`,
      [projectId, limit]
    );
    return result.rows.map(runFrom);
  }

  async getRun(projectId: string, runId: string): Promise<RunRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM runs WHERE run_id = $1 AND project_id = $2`,
      [runId, projectId]
    );
    return result.rowCount === 0 ? null : runFrom(result.rows[0] ?? {});
  }

  async listEvents(
    runId: string,
    options: { afterCursor?: number; limit?: number } = {}
  ): Promise<RunEventRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM run_events
       WHERE run_id = $1 AND server_cursor > $2
       ORDER BY server_cursor ASC
       LIMIT $3`,
      [runId, options.afterCursor ?? 0, options.limit ?? 200]
    );
    return result.rows.map(eventFrom);
  }
}

function isContiguous(seqs: number[]): boolean {
  if (seqs.length === 0) return true;
  if (seqs[0] !== 1) return false;
  for (let i = 1; i < seqs.length; i += 1) {
    if ((seqs[i] ?? 0) !== (seqs[i - 1] ?? 0) + 1) return false;
  }
  return true;
}
