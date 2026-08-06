/**
 * P4 Run monitoring store — three-state model (run / connection / sync).
 * Inspired by kb-sdd progress monitoring, slimmed for Hunter Harness.
 */

export type RunStatus = "running" | "succeeded" | "failed" | "partial";
export type ConnectionStatus = "online" | "delayed" | "offline" | "reconciling";
export type SyncCompleteness = "complete" | "pending" | "gapped" | "degraded";

export interface RunRecord {
  runId: string;
  projectId: string;
  changeKey: string;
  title: string | null;
  runStatus: RunStatus;
  connectionStatus: ConnectionStatus;
  syncCompleteness: SyncCompleteness;
  currentPhase: string | null;
  startedAt: string | null;
  endedAt: string | null;
  lastEventAt: string | null;
  lastHeartbeatAt: string | null;
  serverCursor: number;
  createdAt: string;
  updatedAt: string;
}

export interface RunEventRecord {
  serverCursor: number;
  projectId: string;
  runId: string;
  eventId: string;
  producerSeq: number;
  eventType: string;
  phase: string | null;
  occurredAt: string;
  payload: Record<string, unknown>;
  receivedAt: string;
}

/** Whitelisted fields accepted from local events.ndjson (desensitized). */
export const RUN_EVENT_WHITELIST = [
  "id",
  "ts",
  "type",
  "phase",
  "status",
  "note",
  "attempt",
  "name",
  "code",
  "severity",
  "decision",
  "reason",
  "exit_code",
  "duration_ms",
  "schemaVersion"
] as const;

export interface IngestEventInput {
  eventId: string;
  producerSeq: number;
  eventType: string;
  phase?: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export type IngestItemStatus =
  | "accepted"
  | "duplicate_accepted"
  | "id_conflict"
  | "rejected_schema";

export interface IngestItemResult {
  id: string;
  status: IngestItemStatus;
  server_cursor: number | null;
  error_code: string | null;
}

export interface RunStore {
  ensureRun(input: {
    runId: string;
    projectId: string;
    changeKey: string;
    title?: string;
  }): Promise<RunRecord>;
  ingestBatch(input: {
    projectId: string;
    runId: string;
    events: IngestEventInput[];
  }): Promise<{ items: IngestItemResult[]; run: RunRecord }>;
  heartbeat(input: {
    projectId: string;
    runId: string;
    clientTime: string;
  }): Promise<RunRecord | null>;
  listRuns(projectId: string, limit?: number): Promise<RunRecord[]>;
  getRun(projectId: string, runId: string): Promise<RunRecord | null>;
  listEvents(
    runId: string,
    options?: { afterCursor?: number; limit?: number }
  ): Promise<RunEventRecord[]>;
}

export function sanitizeEventPayload(
  raw: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of RUN_EVENT_WHITELIST) {
    if (key in raw) out[key] = raw[key];
  }
  return out;
}

export function deriveRunStatus(
  current: RunStatus,
  eventType: string,
  payload: Record<string, unknown>
): RunStatus {
  if (eventType === "phase.end" && payload.phase === "archive") {
    const status = String(payload.status ?? "OK").toUpperCase();
    if (status === "OK" || status === "SUCCESS") return "succeeded";
    if (status === "FAIL" || status === "FAILED" || status === "ERROR") return "failed";
    return "partial";
  }
  return current === "succeeded" || current === "failed" || current === "partial"
    ? current
    : "running";
}

export function publicRun(run: RunRecord): Record<string, unknown> {
  return {
    run_id: run.runId,
    project_id: run.projectId,
    change_key: run.changeKey,
    title: run.title,
    run_status: run.runStatus,
    connection_status: run.connectionStatus,
    sync_completeness: run.syncCompleteness,
    current_phase: run.currentPhase,
    started_at: run.startedAt,
    ended_at: run.endedAt,
    last_event_at: run.lastEventAt,
    last_heartbeat_at: run.lastHeartbeatAt,
    server_cursor: run.serverCursor,
    created_at: run.createdAt,
    updated_at: run.updatedAt
  };
}

export function publicEvent(event: RunEventRecord): Record<string, unknown> {
  return {
    server_cursor: event.serverCursor,
    run_id: event.runId,
    event_id: event.eventId,
    producer_seq: event.producerSeq,
    event_type: event.eventType,
    phase: event.phase,
    occurred_at: event.occurredAt,
    payload: event.payload,
    received_at: event.receivedAt
  };
}
