import type { Pool, QueryResultRow } from "pg";
import { canonicalJson } from "@hunter-harness/contracts";

import {
  deriveCanonicalRunAggregate,
  decodeRunCursor,
  encodeRunCursor,
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
  const markedChange = row.lifecycle_kind === "change" &&
    typeof row.branch_name === "string" && row.branch_name.length > 0 &&
    row.source_version === "plan-event-bundle/v1";
  return {
    runId: String(row.run_id),
    projectId: String(row.project_id),
    changeKey: String(row.change_key),
    lifecycleKind: markedChange ? "change" : "legacy_unmarked",
    branchName: markedChange ? String(row.branch_name) : null,
    sourceVersion: markedChange ? String(row.source_version) : null,
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
    planEvent: row.plan_event == null ? null : row.plan_event as RunEventRecord["planEvent"],
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
    lifecycleKind: "change" | "legacy_unmarked";
    branchName: string | null;
    sourceVersion: string | null;
  }): Promise<RunRecord> {
    const result = await this.pool.query(
      `INSERT INTO runs(run_id, project_id, change_key, title, started_at,
         lifecycle_kind, branch_name, source_version)
       VALUES ($1, $2, $3, $4, NULL, $5, $6, $7)
       ON CONFLICT (run_id) DO UPDATE SET run_id = runs.run_id
       RETURNING *`,
      [input.runId, input.projectId, input.changeKey, input.title ?? input.changeKey,
        input.lifecycleKind, input.branchName, input.sourceVersion]
    );
    let run = runFrom(result.rows[0] ?? {});
    if (run.projectId !== input.projectId || run.changeKey !== input.changeKey ||
        run.lifecycleKind !== input.lifecycleKind || run.branchName !== input.branchName ||
        run.sourceVersion !== input.sourceVersion) throw new Error("RUN_IDENTITY_CONFLICT");
    const candidate = input.title?.trim();
    if ((run.title === null || run.title === run.changeKey) && candidate !== undefined &&
        candidate !== "" && candidate !== input.changeKey) {
      const promoted = await this.pool.query(
        `UPDATE runs SET title = $2, updated_at = now()
         WHERE run_id = $1 AND (title IS NULL OR title = change_key) RETURNING *`,
        [input.runId, candidate]
      );
      run = runFrom(promoted.rows[0] ?? result.rows[0] ?? {});
    }
    return run;
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
          const same = row.producerSeq === event.producerSeq && row.eventType === event.eventType &&
            (run.lifecycleKind !== "change" || canonicalJson(row.planEvent) === canonicalJson(event.planEvent));
          items.push({
            id: event.eventId,
            status: same ? "duplicate_accepted" : "id_conflict",
            server_cursor: same ? row.serverCursor : null,
            error_code: same ? null : "ID_CONFLICT"
          });
          continue;
        }
        const seqConflict = await client.query(
          `SELECT 1 FROM run_events WHERE run_id = $1 AND producer_seq = $2
             AND ($3::boolean = false OR phase = $4 AND (plan_event->>'attempt')::bigint = $5)`,
          [input.runId, event.producerSeq, run.lifecycleKind === "change", event.planEvent?.phase ?? null,
            event.planEvent?.attempt ?? null]
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
             project_id, run_id, event_id, producer_seq, event_type, phase, occurred_at, payload, plan_event
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)
           RETURNING *`,
          [
            input.projectId,
            input.runId,
            event.eventId,
            event.producerSeq,
            event.eventType,
            event.phase ?? null,
            event.occurredAt,
            JSON.stringify(event.payload),
            event.planEvent === undefined ? null : JSON.stringify(event.planEvent)
          ]
        );
        const record = eventFrom(inserted.rows[0] ?? {});
        items.push({
          id: event.eventId,
          status: "accepted",
          server_cursor: record.serverCursor,
          error_code: null
        });
      }

      const eventRows = await client.query(
        `SELECT * FROM run_events WHERE run_id = $1 ORDER BY server_cursor`,
        [input.runId]
      );
      const storedEvents = eventRows.rows.map(eventFrom);
      const completeness = isContiguous(storedEvents) ? "complete" : "gapped";
      const aggregate = deriveCanonicalRunAggregate(storedEvents);
      const final = await client.query(
        `UPDATE runs SET sync_completeness = $2, server_cursor = $3::bigint,
           started_at = $4::timestamptz, last_event_at = $5::timestamptz,
           current_phase = $6, run_status = $7, ended_at = $8::timestamptz,
           connection_status = CASE WHEN $3::bigint > 0 THEN 'online' ELSE connection_status END,
           updated_at = now()
         WHERE run_id = $1 RETURNING *`,
        [input.runId, completeness, aggregate.serverCursor, aggregate.startedAt,
          aggregate.lastEventAt, aggregate.currentPhase, aggregate.runStatus, aggregate.endedAt]
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

  async listRuns(projectId: string, options: {
    limit?: number;
    cursor?: string | null;
    status?: string;
    lifecycleKind?: "change" | "legacy_unmarked";
  } = {}): Promise<{ items: RunRecord[]; nextCursor: string | null; total: number }> {
    const limit = options.limit ?? 50;
    const offset = decodeRunCursor(options.cursor);
    const countParameters: unknown[] = [projectId];
    const countClauses = ["project_id = $1"];
    if (options.status !== undefined) {
      countParameters.push(options.status);
      countClauses.push(`run_status = $${countParameters.length}`);
    }
    if (options.lifecycleKind !== undefined) {
      countParameters.push(options.lifecycleKind);
      countClauses.push(`lifecycle_kind = $${countParameters.length}`);
    }
    const count = await this.pool.query(
      `SELECT COUNT(*)::int AS total FROM runs WHERE ${countClauses.join(" AND ")}`,
      countParameters
    );
    const pageParameters: unknown[] = [projectId, limit + 1, offset];
    const pageClauses = ["project_id = $1"];
    if (options.status !== undefined) {
      pageParameters.push(options.status);
      pageClauses.push(`run_status = $${pageParameters.length}`);
    }
    if (options.lifecycleKind !== undefined) {
      pageParameters.push(options.lifecycleKind);
      pageClauses.push(`lifecycle_kind = $${pageParameters.length}`);
    }
    const result = await this.pool.query(
      `SELECT * FROM runs WHERE ${pageClauses.join(" AND ")}
       ORDER BY last_event_at DESC NULLS LAST, run_id COLLATE "C" ASC
       LIMIT $2 OFFSET $3`,
      pageParameters
    );
    const rows = result.rows.slice(0, limit);
    return {
      items: rows.map(runFrom),
      total: Number(count.rows[0]?.total ?? 0),
      nextCursor: result.rows.length > limit
        ? encodeRunCursor(offset + limit)
        : null
    };
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

function isContiguous(events: RunEventRecord[]): boolean {
  const groups = new Map<string, number[]>();
  for (const event of events) {
    const key = event.planEvent === null ? "legacy" : `${event.planEvent.phase}:${event.planEvent.attempt}`;
    groups.set(key, [...(groups.get(key) ?? []), event.producerSeq]);
  }
  for (const seqs of groups.values()) {
    seqs.sort((a, b) => a - b);
    if (seqs[0] !== 1) return false;
    for (let i = 1; i < seqs.length; i += 1) {
      if ((seqs[i] ?? 0) !== (seqs[i - 1] ?? 0) + 1) return false;
    }
  }
  return true;
}
