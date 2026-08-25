import type { PlanEvent } from "@hunter-harness/contracts";

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
export type RunLifecycleKind = "change" | "legacy_unmarked";

export type StoredPlanEvent = PlanEvent;

export interface RunRecord {
  runId: string;
  projectId: string;
  changeKey: string;
  lifecycleKind: RunLifecycleKind;
  branchName: string | null;
  sourceVersion: string | null;
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
  planEvent: StoredPlanEvent | null;
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
  "result_status",
  "planned_phases",
  "skipped_phases",
  "next_phase",
  "phase_plan_source",
  "closure_disposition",
  "closure_reason",
  "command",
  "path",
  "kind",
  "terminal",
  "recovery_status",
  "reasonCode",
  "runner_ms",
  "orchestration_active_ms",
  "wall_clock_ms",
  "user_wait_ms",
  "changed_files"
] as const;

export interface IngestEventInput {
  eventId: string;
  producerSeq: number;
  eventType: string;
  phase?: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  planEvent?: StoredPlanEvent;
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
    lifecycleKind: RunLifecycleKind;
    branchName: string | null;
    sourceVersion: string | null;
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
    lifecycleKind?: RunLifecycleKind;
  }): Promise<{ items: RunRecord[]; nextCursor: string | null; total: number }>;
  getRun(projectId: string, runId: string): Promise<RunRecord | null>;
  listEvents(
    runId: string,
    options?: { afterCursor?: number; limit?: number }
  ): Promise<RunEventRecord[]>;
}

export function decodeRunCursor(cursor: string | null | undefined): number {
  if (cursor === null || cursor === undefined || cursor === "") return 0;
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const candidate = decoded.startsWith("run-offset:") ? decoded.slice("run-offset:".length) : decoded;
  const offset = Number.parseInt(candidate, 10);
  if (!Number.isSafeInteger(offset) || offset < 0 || String(offset) !== candidate) {
    throw new Error("INVALID_CURSOR");
  }
  return offset;
}

export function encodeRunCursor(offset: number): string {
  return Buffer.from(`run-offset:${offset}`).toString("base64url");
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
  if (eventType === "phase_started") return "running";
  if (eventType === "validation_failed") return "failed";
  if (eventType === "phase_ended") {
    if (current === "failed" || current === "partial") return current;
    // Stage 12 emits phase_ended after every phase. Only archive completion is a
    // run terminal; plan/execute/review/... completion leaves the workflow running.
    return payload.phase === "archive" ? "succeeded" : "running";
  }
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

export function isRunTerminalEvent(eventType: string): boolean {
  return eventType === "workflow.end" || eventType === "run.end" ||
    eventType === "phase.end" || eventType === "phase_ended";
}

export function deriveCanonicalRunAggregate(events: readonly RunEventRecord[]): Pick<
  RunRecord,
  "startedAt" | "lastEventAt" | "currentPhase" | "runStatus" | "endedAt" | "serverCursor"
> {
  const phases = ["plan", "execute", "run", "test", "review", "package", "apidoc", "submit", "merge", "archive"];
  const ordered = [...events].sort((left, right) => {
    if (left.planEvent !== null && right.planEvent !== null) {
      return phases.indexOf(left.planEvent.phase) - phases.indexOf(right.planEvent.phase) ||
        left.planEvent.attempt - right.planEvent.attempt ||
        left.planEvent.producer_seq - right.planEvent.producer_seq || left.eventId.localeCompare(right.eventId);
    }
    return left.serverCursor - right.serverCursor || left.eventId.localeCompare(right.eventId);
  });
  let runStatus: RunStatus = "running";
  let currentPhase: string | null = null;
  for (const event of ordered) {
    currentPhase = event.phase ?? currentPhase;
    runStatus = deriveRunStatus(runStatus, event.eventType, {
      ...event.payload,
      phase: event.phase
    });
  }
  const last = ordered.at(-1) ?? null;
  const terminal = runStatus === "running"
    ? null
    : ordered.findLast((event) => isRunTerminalEvent(event.eventType)) ?? null;
  return {
    startedAt: ordered[0]?.occurredAt ?? null,
    lastEventAt: last?.occurredAt ?? null,
    currentPhase,
    runStatus,
    endedAt: terminal?.occurredAt ?? null,
    serverCursor: events.reduce((maximum, event) => Math.max(maximum, event.serverCursor), 0)
  };
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
  preparation_attempt_count: number;
  active_preparation: number | null;
  blocked_preparation_count: number;
  reconciled: boolean;
  latest_preparation: RunPhasePreparationSummary | null;
  preparations: RunPhasePreparationSummary[];
  validity: "current" | "stale" | "pending" | "unknown";
  attempts: RunPhaseAttemptSummary[];
}

export interface RunPhasePreparationSummary {
  attempt: number;
  run_id: string | null;
  trigger: string | null;
  from_phase: string | null;
  started_at: string;
  ended_at: string | null;
  status: string | null;
  duration_ms: number | null;
  code: string | null;
  message: string | null;
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

interface MutablePreparation extends RunPhasePreparationSummary {
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
  const preparationsByPhase = new Map<string, MutablePreparation[]>();
  const reconciledPhases = new Set<string>();
  const sorted = [...events].sort((left, right) =>
    left.serverCursor - right.serverCursor || left.eventId.localeCompare(right.eventId)
  );
  let legacyArchivePreparationStart: RunEventRecord | null = null;
  let legacyArchivePreparationEnd: RunEventRecord | null = null;
  for (const event of sorted) {
    const phase = event.phase ??
      (typeof event.payload.phase === "string" ? event.payload.phase : null);
    if (phase === null || phase.length === 0) continue;
    let attempts = attemptsByPhase.get(phase);
    if (attempts === undefined) {
      attempts = [];
      attemptsByPhase.set(phase, attempts);
      preparationsByPhase.set(phase, []);
      order.push(phase);
    }
    const preparations = preparationsByPhase.get(phase) ?? [];
    const declaredAttempt = positiveAttempt(event.payload.attempt);
    const note = payloadText(event.payload, "note") ?? "";
    if (["phase.start", "phase.end", "phase.auto_sealed"].includes(event.eventType)) {
      for (const [candidate, candidateAttempts] of attemptsByPhase) {
        if (candidate === phase) continue;
        const openAttempt = candidateAttempts.findLast((item) => item.ended_at === null);
        if (openAttempt === undefined) continue;
        const duration = durationBetween(openAttempt.started_at, event.occurredAt);
        if (duration === null) continue;
        openAttempt.ended_at = event.occurredAt;
        openAttempt.status = "AUTO_SEALED";
        openAttempt.duration_ms = duration;
        openAttempt.endCursor = event.serverCursor;
        reconciledPhases.add(candidate);
      }
    }
    const isLegacyArchivePreparationStart = phase === "archive" &&
      event.eventType === "phase.start" &&
      /^finalize operation a-[0-9a-f]+ failed before publish$/i.test(note);
    if (isLegacyArchivePreparationStart) {
      legacyArchivePreparationStart ??= event;
      continue;
    }
    const isLegacyArchivePreparationEnd = phase === "archive" &&
      event.eventType === "phase.end" &&
      payloadText(event.payload, "status")?.toUpperCase() === "FAIL" &&
      /^finalize operation a-[0-9a-f]+ discarded:/i.test(note);
    if (isLegacyArchivePreparationEnd && legacyArchivePreparationStart !== null) {
      legacyArchivePreparationEnd = event;
      continue;
    }
    if (event.eventType === "phase.prepare.start") {
      const nextAttempt = declaredAttempt ?? Math.max(
        attempts.at(-1)?.attempt ?? 0,
        preparations.at(-1)?.attempt ?? 0
      ) + 1;
      preparations.push({
        attempt: nextAttempt,
        run_id: payloadText(event.payload, "run_id") ?? event.runId,
        trigger: payloadText(event.payload, "trigger"),
        from_phase: payloadText(event.payload, "from_phase"),
        started_at: event.occurredAt,
        ended_at: null,
        status: null,
        duration_ms: null,
        code: null,
        message: null,
        startCursor: event.serverCursor,
        endCursor: null
      });
      continue;
    }
    const isPreparationEnd = event.eventType === "phase.prepare.end" || (
      event.eventType === "gate.blocked" &&
      payloadText(event.payload, "trigger") === "review-fixback"
    );
    if (isPreparationEnd) {
      let preparation = declaredAttempt === null
        ? preparations.findLast((item) => item.ended_at === null)
        : preparations.findLast((item) => item.attempt === declaredAttempt);
      const explicitDuration = typeof event.payload.orchestration_active_ms === "number"
        ? event.payload.orchestration_active_ms
        : typeof event.payload.wall_clock_ms === "number"
          ? event.payload.wall_clock_ms
          : null;
      if (preparation === undefined) {
        const attempt = declaredAttempt ?? Math.max(
          attempts.at(-1)?.attempt ?? 0,
          preparations.at(-1)?.attempt ?? 0
        ) + 1;
        const started = explicitDuration === null
          ? event.occurredAt
          : new Date(Date.parse(event.occurredAt) - explicitDuration).toISOString();
        preparation = {
          attempt,
          run_id: payloadText(event.payload, "run_id") ?? event.runId,
          trigger: payloadText(event.payload, "trigger"),
          from_phase: payloadText(event.payload, "from_phase"),
          started_at: started,
          ended_at: null,
          status: null,
          duration_ms: null,
          code: null,
          message: null,
          startCursor: event.serverCursor,
          endCursor: null
        };
        preparations.push(preparation);
      }
      preparation.ended_at = event.occurredAt;
      preparation.status = payloadText(event.payload, "status") ?? "BLOCKED";
      preparation.duration_ms = explicitDuration ?? durationBetween(
        preparation.started_at,
        preparation.ended_at
      );
      preparation.code = payloadText(event.payload, "code");
      preparation.message = payloadText(event.payload, "message") ??
        payloadText(event.payload, "note");
      preparation.endCursor = event.serverCursor;
      continue;
    }
    if (event.eventType === "phase.start") {
      const matchingPreparation = preparations.findLast((item) =>
        item.ended_at === null &&
        (declaredAttempt === null || item.attempt === declaredAttempt)
      );
      if (matchingPreparation !== undefined) {
        matchingPreparation.ended_at = event.occurredAt;
        matchingPreparation.status = "STARTED";
        matchingPreparation.duration_ms = durationBetween(
          matchingPreparation.started_at,
          matchingPreparation.ended_at
        );
        matchingPreparation.endCursor = event.serverCursor;
      }
      const nextAttempt = declaredAttempt ?? ((attempts.at(-1)?.attempt ?? 0) + 1);
      attempts.push({
        attempt: nextAttempt,
        run_id: payloadText(event.payload, "run_id") ?? event.runId,
        trigger: payloadText(event.payload, "trigger"),
        from_phase: payloadText(event.payload, "from_phase"),
        started_at: phase === "archive" && legacyArchivePreparationStart !== null
          ? legacyArchivePreparationStart.occurredAt
          : event.occurredAt,
        ended_at: null,
        status: null,
        duration_ms: null,
        startCursor: event.serverCursor,
        endCursor: null
      });
      if (phase === "archive") {
        legacyArchivePreparationStart = null;
        legacyArchivePreparationEnd = null;
      }
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

  if (legacyArchivePreparationStart !== null) {
    const preparations = preparationsByPhase.get("archive") ?? [];
    const endedAt = legacyArchivePreparationEnd?.occurredAt ?? null;
    preparations.push({
      attempt: preparations.length + 1,
      run_id: legacyArchivePreparationStart.runId,
      trigger: "legacy-finalize-validation",
      from_phase: null,
      started_at: legacyArchivePreparationStart.occurredAt,
      ended_at: endedAt,
      status: endedAt === null ? null : "BLOCKED",
      duration_ms: durationBetween(legacyArchivePreparationStart.occurredAt, endedAt),
      code: endedAt === null ? null : "ARCHIVE_PREPARE_BLOCKED",
      message: legacyArchivePreparationEnd === null
        ? null
        : payloadText(legacyArchivePreparationEnd.payload, "note"),
      startCursor: legacyArchivePreparationStart.serverCursor,
      endCursor: legacyArchivePreparationEnd?.serverCursor ?? null
    });
  }

  return order.map((id) => {
    const attempts = attemptsByPhase.get(id) ?? [];
    const preparations = preparationsByPhase.get(id) ?? [];
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
    const publicPreparations: RunPhasePreparationSummary[] = preparations.map(
      (preparation) => ({
        attempt: preparation.attempt,
        run_id: preparation.run_id,
        trigger: preparation.trigger,
        from_phase: preparation.from_phase,
        started_at: preparation.started_at,
        ended_at: preparation.ended_at,
        status: preparation.status,
        duration_ms: preparation.duration_ms,
        code: preparation.code,
        message: preparation.message
      })
    );
    const latestPreparation = publicPreparations.at(-1) ?? null;
    return {
      id,
      started_at: attempts[0]?.started_at ?? new Date(0).toISOString(),
      ended_at: latest?.ended_at ?? null,
      duration_ms: latest?.duration_ms ?? null,
      total_duration_ms: totalDuration,
      attempt_count: attempts.length,
      active_attempt: latest?.ended_at === null ? latest?.attempt ?? null : null,
      latest_status: latest?.ended_at === null ? "RUNNING" : latest?.status ?? null,
      preparation_attempt_count: publicPreparations.length,
      active_preparation: latestPreparation?.ended_at === null
        ? latestPreparation.attempt
        : null,
      blocked_preparation_count: publicPreparations.filter((item) =>
        item.status === "BLOCKED"
      ).length,
      reconciled: reconciledPhases.has(id),
      latest_preparation: latestPreparation,
      preparations: publicPreparations,
      validity: invalidatedByUpstream ? "stale" : attempts.length === 0 ? "pending" : "current",
      attempts: publicAttempts
    };
  });
}

function reportedWorkflowPlan(events: readonly RunEventRecord[]): {
  plannedPhases: string[] | null;
  skippedPhases: unknown[];
  nextPhase: string | null;
  source: string;
} {
  let plannedPhases: string[] | null = null;
  let skippedPhases: unknown[] = [];
  let nextPhase: string | null = null;
  let source = "legacy-unknown";
  for (const event of [...events].sort((left, right) => left.serverCursor - right.serverCursor)) {
    const planned = event.payload.planned_phases;
    if (Array.isArray(planned)) {
      const normalized = planned
        .filter((item): item is string => typeof item === "string" && item.trim() !== "")
        .map((item) => item.trim());
      if (normalized.length > 0) {
        plannedPhases = [...new Set(normalized)];
        source = typeof event.payload.phase_plan_source === "string"
          ? event.payload.phase_plan_source
          : "reported";
      }
    }
    if (Array.isArray(event.payload.skipped_phases)) {
      skippedPhases = event.payload.skipped_phases;
    }
    if ("next_phase" in event.payload) {
      nextPhase = typeof event.payload.next_phase === "string" && event.payload.next_phase.trim() !== ""
        ? event.payload.next_phase.trim()
        : null;
    }
  }
  return { plannedPhases, skippedPhases, nextPhase, source };
}

function reportedRunOutcome(events: readonly RunEventRecord[]): {
  closureDisposition: "completed" | "abandoned" | "superseded" | null;
  closureReason: string | null;
  timingBreakdown: Record<string, number>;
  fileBreakdown: Record<string, number>;
} {
  let closureDisposition: "completed" | "abandoned" | "superseded" | null = null;
  let closureReason: string | null = null;
  const timingBreakdown = {
    product_verification_ms: 0,
    process_evidence_ms: 0,
    user_wait_ms: 0,
    wall_clock_reported_ms: 0
  };
  const productFiles = new Set<string>();
  const processEvidenceFiles = new Set<string>();
  const addPath = (candidate: unknown): void => {
    if (typeof candidate !== "string" || candidate.trim() === "") return;
    const path = candidate.trim().replaceAll("\\", "/").replace(/^\.\//, "");
    (path === ".harness" || path.startsWith(".harness/")
      ? processEvidenceFiles
      : productFiles).add(path);
  };
  const addDuration = (target: keyof typeof timingBreakdown, candidate: unknown): void => {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
      timingBreakdown[target] += candidate;
    }
  };

  for (const event of [...events].sort((left, right) => left.serverCursor - right.serverCursor)) {
    const disposition = event.payload.closure_disposition;
    if (disposition === "completed" || disposition === "abandoned" || disposition === "superseded") {
      closureDisposition = disposition;
      closureReason = typeof event.payload.closure_reason === "string" && event.payload.closure_reason.trim() !== ""
        ? event.payload.closure_reason.trim()
        : null;
    }
    addDuration("product_verification_ms", event.payload.runner_ms);
    addDuration("process_evidence_ms", event.payload.orchestration_active_ms);
    addDuration("user_wait_ms", event.payload.user_wait_ms);
    addDuration("wall_clock_reported_ms", event.payload.wall_clock_ms);
    addPath(event.payload.path);
    if (Array.isArray(event.payload.changed_files)) {
      event.payload.changed_files.forEach(addPath);
    }
  }

  return {
    closureDisposition,
    closureReason,
    timingBreakdown,
    fileBreakdown: {
      product_files: productFiles.size,
      process_evidence_files: processEvidenceFiles.size
    }
  };
}

export function publicRun(
  run: RunRecord,
  phases?: readonly RunPhaseSummary[],
  events: readonly RunEventRecord[] = []
): Record<string, unknown> {
  const phaseItems = phases === undefined ? [] : phases.map((phase) => {
    if (run.runStatus === "running" || run.endedAt === null || phase.active_attempt === null) {
      return { ...phase };
    }
    const attempts = phase.attempts.map((attempt) => {
      if (attempt.attempt !== phase.active_attempt || attempt.ended_at !== null) return attempt;
      return {
        ...attempt,
        ended_at: run.endedAt,
        status: run.runStatus === "failed" ? "FAIL" : "AUTO_SEALED",
        duration_ms: durationBetween(attempt.started_at, run.endedAt)
      };
    });
    const latest = attempts.at(-1);
    return {
      ...phase,
      ended_at: latest?.ended_at ?? run.endedAt,
      duration_ms: latest?.duration_ms ?? null,
      total_duration_ms: attempts.reduce(
        (sum, attempt) => sum + (attempt.duration_ms ?? 0),
        0
      ),
      active_attempt: null,
      latest_status: latest?.status ?? (run.runStatus === "failed" ? "FAIL" : "AUTO_SEALED"),
      reconciled: true,
      attempts
    };
  });
  const syncCompleteness = phaseItems.some((phase) => phase.reconciled)
    ? "degraded"
    : run.syncCompleteness;
  const reportedPlan = reportedWorkflowPlan(events);
  const reportedOutcome = reportedRunOutcome(events);
  const activePhase = [...phaseItems].reverse().find((phase) => phase.active_attempt !== null)?.id ?? null;
  const preparingPhase = [...phaseItems].reverse().find(
    (phase) => phase.active_preparation !== null
  )?.id ?? null;
  let workflowStatus = run.runStatus === "running"
    ? activePhase !== null
      ? "running"
      : preparingPhase !== null
        ? "preparing"
        : phaseItems.length > 0 ? "waiting" : "running"
    : run.runStatus === "failed" ? "failed" : "completed";
  if (reportedOutcome.closureDisposition === "abandoned" || reportedOutcome.closureDisposition === "superseded") {
    workflowStatus = reportedOutcome.closureDisposition;
  }
  const resultStatus = run.runStatus === "partial"
    ? "warning"
    : run.runStatus === "succeeded"
      ? "success"
      : run.runStatus === "failed" ? "failure" : "pending";
  let connectionStatus = run.connectionStatus;
  const serverObservedAt = run.lastHeartbeatAt ?? (run.lastEventAt === null ? null : run.updatedAt);
  if (["completed", "failed", "abandoned", "superseded"].includes(workflowStatus)) {
    connectionStatus = "closed";
  } else if (activePhase === null && preparingPhase === null && phaseItems.length > 0) {
    connectionStatus = "idle";
  } else if (serverObservedAt !== null) {
    const observedAt = Date.parse(serverObservedAt);
    if (Number.isFinite(observedAt)) {
      const age = Math.max(0, Date.now() - observedAt);
      connectionStatus = age > 120_000 ? "offline" : age > 45_000 ? "delayed" : "online";
    }
  }
  let waitingForPhase = reportedPlan.nextPhase;
  if (waitingForPhase === null && reportedPlan.plannedPhases !== null && run.currentPhase !== null) {
    const currentIndex = reportedPlan.plannedPhases.indexOf(run.currentPhase);
    waitingForPhase = currentIndex >= 0
      ? reportedPlan.plannedPhases[currentIndex + 1] ?? null
      : null;
  }
  return {
    run_id: run.runId,
    project_id: run.projectId,
    change_key: run.changeKey,
    lifecycle_kind: run.lifecycleKind,
    branch_name: run.branchName,
    source_version: run.sourceVersion,
    title: run.title,
    run_status: run.runStatus,
    connection_status: connectionStatus,
    sync_completeness: syncCompleteness,
    current_phase: run.currentPhase,
    active_phase: activePhase,
    preparing_phase: preparingPhase,
    waiting_for_phase: workflowStatus === "waiting" ? waitingForPhase : null,
    planned_phases: reportedPlan.plannedPhases,
    skipped_phases: reportedPlan.skippedPhases,
    phase_plan_source: reportedPlan.source,
    closure_disposition: reportedOutcome.closureDisposition,
    closure_reason: reportedOutcome.closureReason,
    timing_breakdown: reportedOutcome.timingBreakdown,
    file_breakdown: reportedOutcome.fileBreakdown,
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
