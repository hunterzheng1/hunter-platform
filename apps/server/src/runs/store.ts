/**
 * P4 Run monitoring store — three-state model (run / connection / sync).
 * Inspired by kb-sdd progress monitoring, slimmed for Hunter Harness.
 */

export type RunStatus = "running" | "succeeded" | "failed" | "partial";
export type ConnectionStatus =
  | "online"
  | "delayed"
  | "offline"
  | "reconciling"
  | "idle"
  | "closed";
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
  "timestamp",
  "schema_version",
  "ts",
  "type",
  "phase",
  "status",
  "note",
  "message",
  "attempt",
  "name",
  "code",
  "severity",
  "decision",
  "reason",
  "exit_code",
  "duration_ms",
  "schemaVersion",
  "summary",
  "executor_tool",
  "executor_agent",
  "executor_model",
  "execution_mode",
  "decision_reason_code",
  "fallback_reason_code",
  "trigger",
  "from_phase",
  "result_status"
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
  listRuns(projectId: string, options?: {
    limit?: number;
    cursor?: string | null;
    status?: string;
  }): Promise<{ items: RunRecord[]; nextCursor: string | null; total: number }>;
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
  if (eventType === "phase.start") return "running";
  if (eventType === "workflow.end" || eventType === "run.end") {
    const status = String(payload.status ?? "OK").toUpperCase();
    if (["OK", "SUCCESS", "COMPLETED"].includes(status)) return "succeeded";
    if (["WARN", "WARNING", "PARTIAL", "CONDITIONAL_OK"].includes(status)) return "partial";
    return "failed";
  }
  if (eventType === "phase.end" && payload.phase === "archive") {
    const status = String(payload.status ?? "OK").toUpperCase();
    if (status === "OK" || status === "SUCCESS") return "succeeded";
    if (status === "FAIL" || status === "FAILED" || status === "ERROR") {
      return payload.terminal === true ? "failed" : "running";
    }
    return "partial";
  }
  return current === "succeeded" || current === "failed" || current === "partial"
    ? current
    : "running";
}

export interface RunPhaseSummary {
  id: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  total_duration_ms: number;
  attempt_count: number;
  active_attempt: number | null;
  latest_status: string | null;
  validity: "current" | "stale" | "pending" | "unknown";
  attempts: RunPhaseAttemptSummary[];
}

export interface RunPhaseAttemptSummary {
  attempt: number;
  run_id: string | null;
  trigger: string | null;
  from_phase: string | null;
  started_at: string;
  ended_at: string | null;
  status: string | null;
  duration_ms: number | null;
}

interface MutableAttempt extends RunPhaseAttemptSummary {
  startCursor: number;
  endCursor: number | null;
}

const WORKFLOW_PHASE_ORDER = [
  "plan",
  "run",
  "test",
  "review",
  "package",
  "apidoc",
  "submit",
  "merge",
  "archive"
] as const;

function positiveAttempt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function payloadText(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function durationBetween(startedAt: string, endedAt: string | null): number | null {
  if (endedAt === null) return null;
  const duration = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

/** Aggregate phase.start / phase.end (and phase field) into per-phase timing. */
export function aggregateRunPhases(events: readonly RunEventRecord[]): RunPhaseSummary[] {
  const order: string[] = [];
  const attemptsByPhase = new Map<string, MutableAttempt[]>();
  const sorted = [...events].sort((left, right) =>
    left.serverCursor - right.serverCursor || left.eventId.localeCompare(right.eventId)
  );
  for (const event of sorted) {
    const phase = event.phase ??
      (typeof event.payload.phase === "string" ? event.payload.phase : null);
    if (phase === null || phase.length === 0) continue;
    let attempts = attemptsByPhase.get(phase);
    if (attempts === undefined) {
      attempts = [];
      attemptsByPhase.set(phase, attempts);
      order.push(phase);
    }
    const declaredAttempt = positiveAttempt(event.payload.attempt);
    if (event.eventType === "phase.start") {
      const nextAttempt = declaredAttempt ?? ((attempts.at(-1)?.attempt ?? 0) + 1);
      attempts.push({
        attempt: nextAttempt,
        run_id: payloadText(event.payload, "run_id") ?? event.runId,
        trigger: payloadText(event.payload, "trigger"),
        from_phase: payloadText(event.payload, "from_phase"),
        started_at: event.occurredAt,
        ended_at: null,
        status: null,
        duration_ms: null,
        startCursor: event.serverCursor,
        endCursor: null
      });
      continue;
    }
    let attempt = declaredAttempt === null
      ? attempts.findLast((item) => item.ended_at === null) ?? attempts.at(-1)
      : attempts.findLast((item) => item.attempt === declaredAttempt);
    if (attempt === undefined) {
      attempt = {
        attempt: declaredAttempt ?? ((attempts.at(-1)?.attempt ?? 0) + 1),
        run_id: payloadText(event.payload, "run_id") ?? event.runId,
        trigger: payloadText(event.payload, "trigger"),
        from_phase: payloadText(event.payload, "from_phase"),
        started_at: event.occurredAt,
        ended_at: null,
        status: null,
        duration_ms: null,
        startCursor: event.serverCursor,
        endCursor: null
      };
      attempts.push(attempt);
    }
    attempt.trigger ??= payloadText(event.payload, "trigger");
    attempt.from_phase ??= payloadText(event.payload, "from_phase");
    if (event.eventType === "phase.end" || event.eventType === "phase.auto_sealed") {
      attempt.ended_at = event.occurredAt;
      attempt.status = payloadText(event.payload, "status") ??
        (event.eventType === "phase.auto_sealed" ? "AUTO_SEALED" : null);
      attempt.duration_ms = durationBetween(attempt.started_at, attempt.ended_at);
      attempt.endCursor = event.serverCursor;
    }
  }

  return order.map((id) => {
    const attempts = attemptsByPhase.get(id) ?? [];
    const latest = attempts.at(-1);
    const phaseIndex = WORKFLOW_PHASE_ORDER.indexOf(id as typeof WORKFLOW_PHASE_ORDER[number]);
    const latestTerminalCursor = latest?.endCursor ?? latest?.startCursor ?? 0;
    const invalidatedByUpstream = phaseIndex > 0 && order.some((candidate) => {
      const upstreamIndex = WORKFLOW_PHASE_ORDER.indexOf(
        candidate as typeof WORKFLOW_PHASE_ORDER[number]
      );
      if (upstreamIndex < 0 || upstreamIndex >= phaseIndex) return false;
      return (attemptsByPhase.get(candidate)?.at(-1)?.startCursor ?? 0) > latestTerminalCursor;
    });
    const publicAttempts: RunPhaseAttemptSummary[] = attempts.map((attempt) => ({
      attempt: attempt.attempt,
      run_id: attempt.run_id,
      trigger: attempt.trigger,
      from_phase: attempt.from_phase,
      started_at: attempt.started_at,
      ended_at: attempt.ended_at,
      status: attempt.status,
      duration_ms: attempt.duration_ms
    }));
    const totalDuration = attempts.reduce(
      (sum, attempt) => sum + (attempt.duration_ms ?? 0),
      0
    );
    return {
      id,
      started_at: attempts[0]?.started_at ?? new Date(0).toISOString(),
      ended_at: latest?.ended_at ?? null,
      duration_ms: latest?.duration_ms ?? null,
      total_duration_ms: totalDuration,
      attempt_count: attempts.length,
      active_attempt: latest?.ended_at === null ? latest?.attempt ?? null : null,
      latest_status: latest?.ended_at === null ? "RUNNING" : latest?.status ?? null,
      validity: invalidatedByUpstream ? "stale" : attempts.length === 0 ? "pending" : "current",
      attempts: publicAttempts
    };
  });
}

function nextWorkflowPhase(phase: string | null): string | null {
  if (phase === null) return WORKFLOW_PHASE_ORDER[0];
  const index = WORKFLOW_PHASE_ORDER.indexOf(phase as typeof WORKFLOW_PHASE_ORDER[number]);
  return index >= 0 && index < WORKFLOW_PHASE_ORDER.length - 1
    ? WORKFLOW_PHASE_ORDER[index + 1] ?? null
    : null;
}

export function publicRun(
  run: RunRecord,
  phases?: readonly RunPhaseSummary[]
): Record<string, unknown> {
  const phaseItems = phases === undefined ? [] : phases.map((phase) => ({ ...phase }));
  const activePhase = [...phaseItems].reverse().find((phase) => phase.active_attempt !== null)?.id ?? null;
  const workflowStatus = run.runStatus === "running"
    ? activePhase === null && phaseItems.length > 0 ? "waiting" : "running"
    : run.runStatus === "failed" ? "failed" : "completed";
  const resultStatus = run.runStatus === "partial"
    ? "warning"
    : run.runStatus === "succeeded"
      ? "success"
      : run.runStatus === "failed" ? "failure" : "pending";
  let connectionStatus = run.connectionStatus;
  const serverObservedAt = run.lastHeartbeatAt ?? (run.lastEventAt === null ? null : run.updatedAt);
  if (workflowStatus === "completed" || workflowStatus === "failed") {
    connectionStatus = "closed";
  } else if (activePhase === null && phaseItems.length > 0) {
    connectionStatus = "idle";
  } else if (serverObservedAt !== null) {
    const observedAt = Date.parse(serverObservedAt);
    if (Number.isFinite(observedAt)) {
      const age = Math.max(0, Date.now() - observedAt);
      connectionStatus = age > 120_000 ? "offline" : age > 45_000 ? "delayed" : "online";
    }
  }
  return {
    run_id: run.runId,
    project_id: run.projectId,
    change_key: run.changeKey,
    title: run.title,
    run_status: run.runStatus,
    connection_status: connectionStatus,
    sync_completeness: run.syncCompleteness,
    current_phase: run.currentPhase,
    active_phase: activePhase,
    waiting_for_phase: workflowStatus === "waiting" ? nextWorkflowPhase(run.currentPhase) : null,
    workflow_status: workflowStatus,
    result_status: resultStatus,
    started_at: run.startedAt,
    ended_at: run.endedAt,
    last_event_at: run.lastEventAt,
    last_heartbeat_at: run.lastHeartbeatAt,
    server_cursor: run.serverCursor,
    phases: phaseItems,
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
