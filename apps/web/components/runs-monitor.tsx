"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ApiClientError,
  browserApi,
  type HunterApi,
  type ProjectSummary,
  type RunEventSummary,
  type RunPhasePreparationSummary,
  type RunSummary
} from "../lib/api";
import { useI18n } from "../lib/i18n";
import { mockApi } from "../lib/mock-api";
import { mockChangeArchive, type ArchiveFileEntry, type ChangeArchive } from "../lib/mock-archive";
import { EmptyState } from "./ui/EmptyState";
import { Icon } from "./ui/icons";
import { Modal } from "./ui/Modal";
import { PageHeader } from "./ui/PageHeader";
import { Spinner } from "./ui/Spinner";
import { ToastFeedback } from "./ui/Toast";
import { MarkdownDocument } from "./skill-shared";

type Tone = "success" | "danger" | "warning" | "info" | "neutral";

function statusTone(value: string): Tone {
  if (["succeeded", "complete", "online", "completed"].includes(value)) return "success";
  if (["failed", "error"].includes(value)) return "danger";
  if (["partial", "queued", "pending", "offline", "delayed"].includes(value)) return "warning";
  if (value === "running" || value === "preparing") return "info";
  return "neutral";
}

function eventTone(event: RunEventSummary): Tone {
  const tone = event.payload?.tone;
  if (tone === "success" || tone === "danger" || tone === "warning" || tone === "info") return tone;
  if (/fail|error/i.test(event.event_type)) return "danger";
  if (/complete|synced|succeed/i.test(event.event_type)) return "success";
  if (/warn/i.test(event.event_type)) return "warning";
  return "info";
}

/** 运行排序键：开始时间优先，缺失时退到最近事件时间。 */
function runSortKey(run: RunSummary): string {
  return run.started_at ?? run.last_event_at ?? "";
}

function runDisplayTitle(run: RunSummary): string {
  return run.title?.trim() || run.change_key;
}

function hasDistinctChangeKey(run: RunSummary): boolean {
  return runDisplayTitle(run) !== run.change_key;
}

function phaseClass(value: string | null): string {
  return value !== null && HARNESS_PHASE_ORDER.includes(value as typeof HARNESS_PHASE_ORDER[number])
    ? value
    : "unknown";
}

function durationMs(run: RunSummary, now: number): number | null {
  if (run.started_at === null) return null;
  const start = Date.parse(run.started_at);
  if (Number.isNaN(start)) return null;
  const end = run.ended_at === null ? now : Date.parse(run.ended_at);
  if (Number.isNaN(end) || end < start) return null;
  return end - start;
}

/**
 * harness CLI 的阶段模板（Hunter-Harness harness/scripts/harness_phase.py 的 PHASE_ORDER）。
 * 通用工作流只有 6 个阶段；package / apidoc 是 workflow-policy.json 里的条件阶段（如 java overlay），
 * 仅当事件流或 current_phase 中实际出现时才插入到规范位置。
 */
const HARNESS_PHASE_ORDER = ["plan", "run", "test", "review", "package", "apidoc", "submit", "archive"] as const;
const CONDITIONAL_PHASES = new Set(["package", "apidoc"]);

type PhaseState = "done" | "active" | "preparing" | "failed" | "warning" | "stale" | "pending";

interface PhaseStep {
  name: string;
  state: PhaseState;
  attention?: "warning" | undefined;
  durationMs: number | null;
  attemptCount: number;
  activeAttempt: number | null;
  preparationAttemptCount: number;
  activePreparation: number | null;
  blockedPreparationCount: number;
  latestPreparation: RunPhasePreparationSummary | null;
}

function latestRunPreparation(run: RunSummary): {
  phase: string;
  preparation: RunPhasePreparationSummary;
} | null {
  const candidates = (run.phases ?? []).flatMap((phase) => {
    const preparation = phase.latest_preparation;
    return preparation === null || preparation === undefined ? [] : [{ phase: phase.id, preparation }];
  });
  return candidates.sort((left, right) =>
    right.preparation.started_at.localeCompare(left.preparation.started_at)
  )[0] ?? null;
}

/**
 * 基于 harness 阶段模板推导每阶段状态：完成=绿 / 进行中=蓝 / 失败=红 / 未开始=灰。
 * 当前阶段优先取 run.current_phase，缺失时回退到事件流中最近上报的 phase。
 * 若 run.phases[] 有服务端聚合耗时则叠加显示。
 */
function derivePhaseSteps(events: RunEventSummary[], run: RunSummary, now: number): PhaseStep[] {
  const failed = run.run_status === "failed" || run.run_status === "error";
  const finished = ["succeeded", "completed", "complete"].includes(run.run_status);
  const phaseByName = new Map((run.phases ?? []).map((phase) => [phase.id, phase]));

  const observed = new Set<string>();
  let lastSeen: string | null = null;
  for (const event of events) {
    if (event.phase !== null) {
      observed.add(event.phase);
      lastSeen = event.phase;
    }
  }
  for (const phase of run.phases ?? []) observed.add(phase.id);
  const currentName = run.current_phase ?? lastSeen;
  if (currentName !== null) observed.add(currentName);

  // 新流程直接消费 Harness 上报的实际计划；旧流程才使用兼容模板。
  const reportedPlan = run.planned_phases?.filter((name) => name.trim() !== "") ?? [];
  const template = reportedPlan.length > 0
    ? [...new Set(reportedPlan)]
    : HARNESS_PHASE_ORDER.filter((name) =>
        CONDITIONAL_PHASES.has(name) ? observed.has(name) : true
      );
  const currentIndex = currentName === null
    ? -1
    : (template as readonly string[]).indexOf(currentName);

  return template.map((name, index) => {
    const phase = phaseByName.get(name);
    let durationMs = phase?.total_duration_ms ?? phase?.duration_ms ?? null;
    const attemptCount = phase?.attempt_count ?? phase?.attempts?.length ?? (phase === undefined ? 0 : 1);
    const activeAttempt = phase?.active_attempt ?? null;
    const preparationAttemptCount = phase?.preparation_attempt_count ?? phase?.preparations?.length ?? 0;
    const activePreparation = phase?.active_preparation ?? null;
    const blockedPreparationCount = phase?.blocked_preparation_count ?? 0;
    const latestPreparation = phase?.latest_preparation ?? null;
    if (phase !== undefined && activeAttempt !== null) {
      const attempt = phase.attempts?.find((item) => item.attempt === activeAttempt);
      const startedAt = attempt?.started_at ?? phase.started_at;
      const started = startedAt === null ? Number.NaN : Date.parse(startedAt);
      if (!Number.isNaN(started)) {
        durationMs = Math.max(0, durationMs ?? 0) + Math.max(0, now - started);
      }
    }
    if (phase !== undefined) {
      const latestStatus = phase.latest_status?.toUpperCase() ?? null;
      const hasWarning = latestStatus === "WARN" || latestStatus === "WARNING" ||
        latestPreparation?.status?.toUpperCase() === "BLOCKED";
      let state: PhaseState;
      if (activeAttempt !== null) state = "active";
      else if (activePreparation !== null) state = "preparing";
      else if (phase.validity === "stale") state = "stale";
      else if (latestStatus === "FAIL" || latestStatus === "ERROR") state = "failed";
      else if (phase.ended_at !== null) state = "done";
      else if (hasWarning) state = "warning";
      else state = "pending";
      return {
        name,
        state,
        attention: state === "done" && hasWarning ? "warning" : undefined,
        durationMs,
        attemptCount,
        activeAttempt,
        preparationAttemptCount,
        activePreparation,
        blockedPreparationCount,
        latestPreparation
      };
    }
    if (finished) {
      // 只给真正执行过的阶段涂绿：事件流里出现过的阶段算执行过；
      // 没有任何上报痕迹的阶段（例如只跑到 plan 的 run 里的 run/test/archive）
      // 保持未开始，不能跟着 run 的终态一起变绿。
      const executed = observed.has(name);
      return {
        name,
        state: executed ? ("done" as const) : ("pending" as const),
        durationMs,
        attemptCount,
        activeAttempt,
        preparationAttemptCount,
        activePreparation,
        blockedPreparationCount,
        latestPreparation
      };
    }
    let state: PhaseState;
    if (currentIndex === -1) {
      // 还没有任何阶段上报：运行中则第一个阶段视为进行中，否则全部未开始
      state = run.run_status === "running" && index === 0 ? "active" : "pending";
    } else if (index < currentIndex) {
      state = "done";
    } else if (index === currentIndex) {
      state = failed ? "failed" : "active";
    } else {
      state = "pending";
    }
    return {
      name,
      state,
      durationMs,
      attemptCount,
      activeAttempt,
      preparationAttemptCount,
      activePreparation,
      blockedPreparationCount,
      latestPreparation
    };
  });
}

function formatPhaseDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms > 0 && ms < 1000) return "<1s";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

function formatMetricDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 秒";
  if (ms < 10_000) {
    const seconds = Math.round(ms / 100) / 10;
    return `${seconds.toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 秒`;
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} 分钟` : `${minutes} 分 ${rest} 秒`;
}

export function RunsMonitor({ api, projectId: fixedProjectId }: { api?: HunterApi; projectId?: string }) {
  const { lang, t } = useI18n();
  const client = useMemo<HunterApi>(() => api ?? (
    process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true" ? mockApi : browserApi()
  ), [api]);
  const copy = COPY[lang];
  const locale = lang === "zh" ? "zh-CN" : "en-US";
  const embedded = fixedProjectId !== undefined;
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [chosenProjectId, setChosenProjectId] = useState("");
  const projectId = fixedProjectId ?? chosenProjectId;
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<RunEventSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [liveMode, setLiveMode] = useState<"sse" | "poll" | "idle">("idle");
  const [streamNonce, setStreamNonce] = useState(0);
  const [viewingFile, setViewingFile] = useState<ArchiveFileEntry | null>(null);
  const [selectedArchive, setSelectedArchive] = useState<ChangeArchive | null>(null);
  const [archiveIsSample, setArchiveIsSample] = useState(false);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const streamAbortRef = useRef<(() => void) | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  const selected = runs.find((run) => run.run_id === selectedRunId) ?? null;
  const selectedPreparation = selected === null ? null : latestRunPreparation(selected);
  const clockRunning = selected !== null && (
    selected.active_phase !== null && selected.active_phase !== undefined ||
    selected.preparing_phase !== null && selected.preparing_phase !== undefined ||
    selected.phases?.some((phase) =>
      phase.active_attempt !== null || phase.active_preparation !== null
    ) === true
  );

  const stats = useMemo(() => {
    let running = 0;
    let succeeded = 0;
    let endedEarly = 0;
    let failed = 0;
    for (const run of runs) {
      if (run.workflow_status === "failed" || run.result_status === "failure" || ["failed", "error"].includes(run.run_status)) {
        failed += 1;
      } else if (run.workflow_status === "abandoned" || run.workflow_status === "superseded") {
        endedEarly += 1;
      } else if (run.workflow_status === "completed" || ["succeeded", "completed", "complete", "partial"].includes(run.run_status)) {
        succeeded += 1;
      } else {
        running += 1;
      }
    }
    return { total: runs.length, running, succeeded, endedEarly, failed };
  }, [runs]);

  const phaseSteps = useMemo(
    () => (selected === null ? [] : derivePhaseSteps(events, selected, clockNow)),
    [clockNow, events, selected]
  );
  const timelineEvents = useMemo(
    () => [...events].sort((left, right) =>
      right.server_cursor - left.server_cursor || right.event_id.localeCompare(left.event_id)
    ),
    [events]
  );

  function mapStatus(value: string): string {
    const labels = t.status as Record<string, string>;
    return labels[value] ?? value.replaceAll("_", " ");
  }

  function mapPhase(value: string): string {
    return copy.phaseNames[value] ?? mapStatus(value);
  }

  function connectionLabel(value: string): string {
    return copy.connectionLabels[value] ?? mapStatus(value);
  }

  function runStateLabel(run: RunSummary): string {
    if (run.workflow_status === "abandoned") return copy.abandoned;
    if (run.workflow_status === "superseded") return copy.superseded;
    const preparation = latestRunPreparation(run);
    if (run.workflow_status === "preparing" || preparation?.preparation.ended_at === null) {
      return copy.preparingFix.replace("{n}", String(preparation?.preparation.attempt ?? 1));
    }
    if (preparation?.preparation.status?.toUpperCase() === "BLOCKED") {
      return copy.fixbackNotStarted;
    }
    if (run.workflow_status === "waiting") {
      const completed = run.current_phase === null ? copy.phase : mapPhase(run.current_phase);
      if (run.waiting_for_phase === null || run.waiting_for_phase === undefined) {
        return copy.phaseEnded.replace("{completed}", completed);
      }
      const waiting = mapPhase(run.waiting_for_phase);
      return copy.phaseWaiting.replace("{completed}", completed).replace("{next}", waiting);
    }
    if (run.workflow_status === "completed" && run.current_phase === "archive") {
      return run.result_status === "warning" ? copy.archivedWarning : copy.archived;
    }
    const activePhase = run.active_phase ?? run.current_phase;
    if (run.workflow_status === "running" && activePhase !== null) {
      const phase = run.phases?.find((item) => item.id === activePhase);
      const suffix = (phase?.active_attempt ?? phase?.attempt_count ?? 1) > 1
        ? copy.attemptNumber.replace("{n}", String(phase?.active_attempt ?? phase?.attempt_count ?? 1))
        : "";
      return `${mapPhase(activePhase)}${copy.inProgress}${suffix}`;
    }
    return mapStatus(run.run_status);
  }

  function runListStateLabel(run: RunSummary): string {
    if (run.workflow_status === "abandoned") return copy.abandoned;
    if (run.workflow_status === "superseded") return copy.superseded;
    const preparation = latestRunPreparation(run);
    if (run.workflow_status === "preparing" || preparation?.preparation.ended_at === null) {
      return copy.preparingFixShort;
    }
    if (preparation?.preparation.status?.toUpperCase() === "BLOCKED") {
      return copy.fixbackNotStarted;
    }
    if (run.workflow_status === "waiting") {
      return run.waiting_for_phase === null || run.waiting_for_phase === undefined
        ? copy.phaseEndedShort
        : copy.waitingPhaseShort.replace("{phase}", mapPhase(run.waiting_for_phase));
    }
    if (run.workflow_status === "completed" && run.current_phase === "archive") {
      return run.result_status === "warning" ? copy.archivedWarningShort : copy.archived;
    }
    if (run.workflow_status === "running") return runStateLabel(run);
    return mapStatus(run.run_status);
  }

  function runListDetailLabel(run: RunSummary): string {
    const preparation = latestRunPreparation(run);
    if (run.workflow_status === "preparing" || preparation?.preparation.ended_at === null) {
      return copy.preparingAttempt.replace("{n}", String(preparation?.preparation.attempt ?? 1));
    }
    if (preparation?.preparation.status?.toUpperCase() === "BLOCKED") {
      return copy.preparationBlockedShort;
    }
    if (run.workflow_status === "waiting") return copy.phaseCompletedShort;
    if (run.connection_status === "closed") return copy.workflowEndedShort;
    return connectionLabel(run.connection_status);
  }

  function formatTime(value: string | null): string {
    if (value === null) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString(locale);
  }

  function formatDateTime(value: string | null): string {
    if (value === null) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  function formatDuration(run: RunSummary): string | null {
    const ms = durationMs(run, clockNow);
    if (ms === null) return null;
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return copy.durationSeconds.replace("{n}", String(seconds));
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      const rest = seconds % 60;
      return rest === 0
        ? copy.durationMinutes.replace("{n}", String(minutes))
        : copy.durationMinutesSeconds.replace("{m}", String(minutes)).replace("{s}", String(rest));
    }
    const hours = Math.floor(minutes / 60);
    return copy.durationHours.replace("{h}", String(hours)).replace("{m}", String(minutes % 60));
  }

  function eventDescription(event: RunEventSummary): string {
    const text = (key: string): string => {
      const value = event.payload[key];
      if (typeof value !== "string") return "";
      const normalized = value.replace(/\s+/g, " ").trim().slice(0, 500);
      return normalized
        .replace(
          /(?:\s*[；;,，]?\s*)(?:artifactsHash|artifactHash|receiptHash|content_sha256|contentSha256)\s*[:=]\s*(?:sha256:)?[0-9a-f]{32,64}/gi,
          ""
        )
        .replace(/\bfinalize\s+ok\b/gi, copy.planArtifactsPublished)
        .replace(/\s*([；;，,])\s*([；;，,])/g, "$1")
        .trim()
        .replace(/^[；;，,]+|[；;，,]+$/g, "")
        .trim();
    };
    const rawReviewText = ["summary", "note", "decision", "reason", "message"]
      .map((key) => typeof event.payload[key] === "string" ? String(event.payload[key]) : "")
      .join(" ");
    if (/\bREVIEW_INLINE_NO_DELEGATE\b/.test(rawReviewText)) {
      return copy.legacyInlineReview;
    }
    const structuredReasonCode = typeof event.payload.fallback_reason_code === "string"
      ? event.payload.fallback_reason_code.trim()
      : typeof event.payload.decision_reason_code === "string"
        ? event.payload.decision_reason_code.trim()
        : "";
    const structuredReason = copy.reviewReasonSummaries[structuredReasonCode];
    const summary = text("summary");
    if (structuredReason !== undefined && (
      summary === ""
      || summary === structuredReasonCode
      || /REVIEW_[A-Z0-9_]+|INLINE_BY_ADAPTER/.test(summary)
    )) return structuredReason;
    if (summary !== "") {
      const yellow = summary.match(/YELLOW\s*[×x]\s*(\d+)/i)?.[1];
      if (/review\s+OK\s+advisory/i.test(summary)) {
        return copy.reviewAdvisorySummary.replace("{count}", yellow ?? "0");
      }
      if (/strict-review-gate\s*=\s*false/i.test(summary)) {
        return copy.advisoryReviewPolicy;
      }
      if (!/\b[A-Z][A-Z0-9_]{3,}\b|\b[a-z][\w.-]+\s*=\s*(?:true|false)\b/.test(summary)) {
        return summary;
      }
    }

    const phaseName = event.phase === null ? copy.currentPhase : mapPhase(event.phase);
    const note = text("note");
    const message = text("message");
    const decision = text("decision");
    const reason = text("reason");
    const name = text("name");
    const code = text("code");
    const status = text("status");
    if (event.event_type === "decision" && decision !== "") {
      return reason === "" ? decision : copy.decisionReason.replace("{decision}", decision).replace("{reason}", reason);
    }
    if (event.event_type === "issue" || event.event_type === "issue.resolve") {
      const issue = message || note || code;
      if (issue !== "") return issue;
    }
    if (event.event_type === "phase.start" && note !== "") {
      return copy.phaseStartedDetail.replace("{phase}", phaseName).replace("{detail}", note);
    }
    if ((event.event_type === "phase.end" || event.event_type === "phase.auto_sealed") && (note || status)) {
      return copy.phaseEndedDetail.replace("{phase}", phaseName).replace("{detail}", note || status);
    }
    if (event.event_type === "phase.prepare.start") {
      return note || copy.preparationStarted.replace("{phase}", phaseName);
    }
    if (event.event_type === "phase.prepare.end") {
      if (status.toUpperCase() === "BLOCKED") return message || note || copy.preparationBlocked;
      return message || note || copy.preparationEnded.replace("{phase}", phaseName);
    }
    if (event.event_type === "gate.blocked") {
      return message || note || copy.preparationBlocked;
    }
    const detail = note || message || name || reason || code;
    if (detail !== "") return detail;
    const fallback = (copy.eventFallbacks as Record<string, string>)[event.event_type] ?? copy.eventFallback;
    return fallback.replace("{phase}", phaseName);
  }

  function eventTechnicalDetails(event: RunEventSummary): string[] {
    const details = new Set<string>();
    for (const value of Object.values(event.payload)) {
      if (typeof value !== "string") continue;
      for (const match of value.matchAll(/sha256:[0-9a-f]{64}/gi)) {
        details.add(match[0]);
      }
    }
    for (const key of [
      "decision_reason_code",
      "fallback_reason_code",
      "execution_mode",
      "executor_agent",
      "executor_tool",
      "command",
      "path",
      "code"
    ]) {
      const value = event.payload[key];
      if (typeof value === "string" && value.trim() !== "") {
        details.add(`${key}=${value.trim()}`);
      }
    }
    return [...details];
  }

  function eventExecutionLabel(event: RunEventSummary): string | null {
    const agent = typeof event.payload.executor_agent === "string"
      ? event.payload.executor_agent.trim()
      : "";
    const mode = typeof event.payload.execution_mode === "string"
      ? event.payload.execution_mode.trim()
      : "";
    const reasonCode = typeof event.payload.decision_reason_code === "string"
      ? event.payload.decision_reason_code.trim()
      : typeof event.payload.fallback_reason_code === "string"
        ? event.payload.fallback_reason_code.trim()
        : "";
    if (agent !== "") return copy.delegatedTo.replace("{agent}", agent);
    if (mode === "inline") {
      const readableReason = copy.reviewReasonLabels[reasonCode] ?? copy.reviewReasonUnknown;
      return reasonCode === ""
        ? copy.inlineReview
        : copy.inlineReviewReason.replace("{reason}", readableReason);
    }
    return null;
  }

  const refreshProjects = useCallback(async () => {
    try {
      const items = await client.listProjects("active");
      setProjects(items);
      if (chosenProjectId === "" && items[0] !== undefined) {
        setChosenProjectId(items[0].project_id);
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : copy.networkError);
    }
  }, [client, copy.networkError, chosenProjectId]);

  const refreshRuns = useCallback(async (id: string, silent = false) => {
    if (id === "" || client.listProjectRuns === undefined) return;
    if (!silent) {
      setBusy(true);
      setError(null);
    }
    try {
      const page = await client.listProjectRuns(id);
      const sorted = [...page.items].sort((left, right) =>
        runSortKey(right).localeCompare(runSortKey(left))
      );
      setRuns(sorted);
      setSelectedRunId((current) =>
        current !== null && sorted.some((run) => run.run_id === current)
          ? current
          : sorted[0]?.run_id ?? null
      );
    } catch (err) {
      if (!silent) {
        setRuns([]);
        setError(err instanceof ApiClientError ? err.message : copy.networkError);
      }
    } finally {
      if (!silent) setBusy(false);
    }
  }, [client, copy.networkError]);

  useEffect(() => {
    const tick = () => setClockNow(Date.now());
    tick();
    if (!clockRunning) return;
    const timer = setInterval(tick, 1000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [clockRunning, selectedRunId]);

  useEffect(() => {
    let cancelled = false;
    async function loadArchive(): Promise<void> {
      if (
        selected === null ||
        !["succeeded", "completed", "complete"].includes(selected.run_status)
      ) {
        setSelectedArchive(null);
        setArchiveIsSample(false);
        return;
      }
      if (client.getChangeArchive === undefined) {
        setSelectedArchive(mockChangeArchive(selected.change_key));
        setArchiveIsSample(true);
        return;
      }
      try {
        const archive = await client.getChangeArchive(selected.project_id, selected.change_key);
        if (cancelled) return;
        if (archive.files.length === 0) {
          setSelectedArchive(null);
          setArchiveIsSample(false);
          return;
        }
        setSelectedArchive({
          changeKey: archive.changeKey,
          archivedAt: archive.archivedAt ?? new Date().toISOString(),
          files: archive.files
        });
        setArchiveIsSample(false);
      } catch {
        if (cancelled) return;
        setSelectedArchive(mockChangeArchive(selected.change_key));
        setArchiveIsSample(true);
      }
    }
    void loadArchive();
    return () => { cancelled = true; };
  }, [client, selected]);

  useEffect(() => {
    if (embedded) return;
    void refreshProjects();
  }, [embedded, refreshProjects]);

  useEffect(() => {
    void refreshRuns(projectId);
    if (projectId === "") return;
    const timer = setInterval(() => {
      void refreshRuns(projectId, true);
    }, 3000);
    return () => clearInterval(timer);
  }, [projectId, refreshRuns]);

  useEffect(() => {
    streamAbortRef.current?.();
    streamAbortRef.current = null;
    setLiveMode("idle");

    if (projectId === "" || selectedRunId === null || client.listProjectRunEvents === undefined) {
      setEvents([]);
      return;
    }

    const runId = selectedRunId;
    const listProjectRunEvents = client.listProjectRunEvents.bind(client);
    const streamProjectRunEvents = client.streamProjectRunEvents?.bind(client);
    const getProjectRun = client.getProjectRun?.bind(client);
    let cancelled = false;
    let reconcileTimer: ReturnType<typeof setInterval> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let cursor = 0;

    async function pollOnce(): Promise<void> {
      try {
        const next = await listProjectRunEvents(projectId, runId, cursor);
        if (cancelled) return;
        if (next.items.length > 0) {
          setEvents((current) => {
            const known = new Set(current.map((item) => item.event_id));
            const appended = next.items.filter((item) => !known.has(item.event_id));
            return appended.length === 0 ? current : [...current, ...appended];
          });
          cursor = next.next_cursor;
        }
        if (getProjectRun !== undefined) {
          const run = await getProjectRun(projectId, runId);
          if (!cancelled) {
            setRuns((current) => current.map((item) =>
              item.run_id === run.run_id ? run : item
            ));
          }
        }
      } catch {
        // A later polling cycle can recover from a transient failure.
      }
    }

    function scheduleReconnect(): void {
      if (cancelled || retryTimer !== null) return;
      retryTimer = setTimeout(() => {
        if (!cancelled) setStreamNonce((nonce) => nonce + 1);
      }, 6000);
    }

    async function loadInitialAndStream(): Promise<void> {
      try {
        const result = await listProjectRunEvents(projectId, runId);
        if (cancelled) return;
        setEvents(result.items);
        cursor = result.next_cursor;
        // SSE 负责低延迟推送；轻量轮询负责游标对账，能补回静默断流期间遗漏的事件。
        reconcileTimer = setInterval(() => { void pollOnce(); }, 3000);

        if (streamProjectRunEvents !== undefined) {
          const handle = await streamProjectRunEvents(
            projectId,
            runId,
            cursor,
            {
              onEvent: (event) => {
                setEvents((current) => {
                  if (current.some((item) => item.event_id === event.event_id)) return current;
                  return [...current, event];
                });
                cursor = Math.max(cursor, event.server_cursor);
              },
              onRun: (run) => {
                setRuns((current) => current.map((item) =>
                  item.run_id === run.run_id ? run : item
                ));
              },
              onError: () => {
                if (cancelled) return;
                streamAbortRef.current?.();
                streamAbortRef.current = null;
                setLiveMode("poll");
                scheduleReconnect();
              }
            }
          );
          if (cancelled) {
            handle?.abort();
            return;
          }
          if (handle !== null) {
            streamAbortRef.current = handle.abort;
            setLiveMode("sse");
            return;
          }
        }

        setLiveMode("poll");
        scheduleReconnect();
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiClientError ? err.message : copy.networkError);
          setLiveMode("poll");
          reconcileTimer ??= setInterval(() => { void pollOnce(); }, 3000);
          scheduleReconnect();
        }
      }
    }

    void loadInitialAndStream();

    return () => {
      cancelled = true;
      streamAbortRef.current?.();
      streamAbortRef.current = null;
      if (reconcileTimer !== null) clearInterval(reconcileTimer);
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [client, copy.networkError, projectId, selectedRunId, streamNonce]);

  // 最新事件置顶；切换运行或收到新事件时回到顶部。
  useEffect(() => {
    const node = timelineRef.current;
    if (node !== null) node.scrollTop = 0;
  }, [events.length, selectedRunId]);

  const liveBadge = liveMode === "idle" ? null : liveMode === "sse" ? (
    <span className="runs-live-badge sse" title={copy.liveSseHint}>
      <Icon name="zap" size={13} />
      {copy.liveSse}
    </span>
  ) : (
    <button
      type="button"
      className="runs-live-badge poll"
      title={copy.livePollHint}
      onClick={() => setStreamNonce((nonce) => nonce + 1)}
    >
      <Icon name="refresh" size={13} />
      {copy.livePoll}
    </button>
  );

  return (
    <section className="runs-monitor">
      {embedded ? null : (
        <PageHeader
          eyebrow={copy.eyebrow}
          title={copy.title}
          lede={copy.lede}
        />
      )}

      <div className="runs-toolbar">
        {embedded ? null : (
          <label>
            {copy.project}
            <select
              value={projectId}
              onChange={(event) => {
                setSelectedRunId(null);
                setChosenProjectId(event.target.value);
              }}
            >
              {projects.length === 0 ? <option value="">{copy.noProjects}</option> : null}
              {projects.map((project) => (
                <option key={project.project_id} value={project.project_id}>
                  {project.display_name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="runs-stats" role="status" aria-label={copy.statsLabel}>
          <div className="runs-stat"><strong>{stats.total}</strong><span>{copy.statTotal}</span></div>
          <div className="runs-stat tone-info"><strong>{stats.running}</strong><span>{copy.statRunning}</span></div>
          <div className="runs-stat tone-success"><strong>{stats.succeeded}</strong><span>{copy.statSucceeded}</span></div>
          <div className="runs-stat tone-warning"><strong>{stats.endedEarly}</strong><span>{copy.statEndedEarly}</span></div>
          <div className="runs-stat tone-danger"><strong>{stats.failed}</strong><span>{copy.statFailed}</span></div>
        </div>
      </div>

      <ToastFeedback tone="danger" message={error} />

      <div className="runs-split">
        <div className="runs-list-panel">
          <div className="runs-list-head">
            <h2>{copy.listTitle}<span className="runs-list-count">{runs.length}</span></h2>
            <button
              type="button"
              className="icon-button"
              disabled={busy || projectId === ""}
              title={copy.refreshAll}
              aria-label={copy.refreshAll}
              onClick={() => {
                void refreshRuns(projectId);
                setStreamNonce((nonce) => nonce + 1);
              }}
            >
              {busy ? <Spinner size={13} label={copy.loading} /> : <Icon name="refresh" size={13} />}
            </button>
          </div>
          {runs.length === 0 ? (
            <EmptyState icon="activity" title={copy.empty} />
          ) : (
            <ul className="runs-list">
              {runs.map((run) => {
                const tone = statusTone(run.run_status);
                const duration = formatDuration(run);
                const title = runDisplayTitle(run);
                return (
                  <li key={run.run_id}>
                    <button
                      type="button"
                      className={selectedRunId === run.run_id ? "active" : ""}
                      onClick={() => setSelectedRunId(run.run_id)}
                    >
                      <span className="run-row">
                        <i className={`run-dot run-dot-${tone}`} aria-hidden="true" />
                        <span className="run-title-stack">
                          <strong title={title}>{title}</strong>
                          {hasDistinctChangeKey(run) ? (
                            <span className="run-subtitle" title={run.change_key}>
                              {run.change_key}
                            </span>
                          ) : null}
                        </span>
                      </span>
                      <span className="run-meta">
                        <span className={`run-chip run-chip-${tone}`}>{runListStateLabel(run)}</span>
                        <span>{runListDetailLabel(run)}</span>
                      </span>
                      <span className="run-meta run-time">
                        <time dateTime={run.started_at ?? undefined}>{formatDateTime(run.started_at ?? run.last_event_at)}</time>
                        {duration === null ? null : <span>{duration}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="runs-detail">
          {selected === null ? (
            <EmptyState icon="inbox" title={copy.selectHint} />
          ) : (
            <>
              <div className="runs-detail-head">
                <div>
                  <h2>{runDisplayTitle(selected)}</h2>
                  <p className="runs-mono">
                    {hasDistinctChangeKey(selected)
                      ? `${selected.change_key} · ${selected.run_id}`
                      : selected.run_id}
                  </p>
                </div>
                {liveBadge}
              </div>
              <div className="runs-status-grid">
                <StatusChip
                  label={copy.runStatus}
                  value={runStateLabel(selected)}
                  tone={selectedPreparation?.preparation.status?.toUpperCase() === "BLOCKED"
                    ? "warning"
                    : statusTone(selected.workflow_status ?? selected.run_status)}
                />
                <StatusChip label={copy.connection} value={connectionLabel(selected.connection_status)} tone={statusTone(selected.connection_status)} />
                <StatusChip label={copy.sync} value={mapStatus(selected.sync_completeness)} tone={statusTone(selected.sync_completeness)} />
                <StatusChip
                  label={copy.phase}
                  value={selectedPreparation?.preparation.ended_at === null
                    ? copy.preparingPhase
                      .replace("{phase}", mapPhase(selectedPreparation.phase))
                      .replace("{n}", String(selectedPreparation.preparation.attempt))
                    : selectedPreparation?.preparation.status?.toUpperCase() === "BLOCKED"
                      ? copy.fixbackNotStarted
                      : selected.active_phase !== null && selected.active_phase !== undefined
                    ? mapPhase(selected.active_phase)
                    : selected.workflow_status === "waiting"
                      ? selected.waiting_for_phase === null || selected.waiting_for_phase === undefined
                        ? copy.phaseEndedShort
                        : copy.nextPhaseValue.replace("{phase}", mapPhase(selected.waiting_for_phase))
                      : selected.current_phase === null ? "—" : mapPhase(selected.current_phase)}
                  tone={selectedPreparation?.preparation.status?.toUpperCase() === "BLOCKED"
                    ? "warning"
                    : selected.workflow_status === "waiting" || selected.workflow_status === "preparing"
                      ? "info"
                      : "neutral"}
                />
              </div>
              <div className="runs-meta">
                <span>{copy.startedAt} <strong>{formatDateTime(selected.started_at)}</strong></span>
                <span>{copy.endedAt} <strong>{formatDateTime(selected.ended_at)}</strong></span>
                <span>{copy.durationLabel} <strong>{formatDuration(selected) ?? "—"}</strong></span>
                <span>{copy.lastEvent} <strong>{formatTime(selected.last_event_at)}</strong></span>
                <span>{copy.lastHeartbeat} <strong>{formatTime(selected.last_heartbeat_at)}</strong></span>
              </div>
              {selected.closure_reason === null || selected.closure_reason === undefined ? null : (
                <p className="runs-closure-reason">{selected.closure_reason}</p>
              )}
              {selected.timing_breakdown === undefined ? null : (
                <div className="runs-breakdown" aria-label={copy.timingBreakdown}>
                  {selected.timing_breakdown.product_verification_ms > 0 ? <span>{copy.productVerification} {formatMetricDuration(selected.timing_breakdown.product_verification_ms)}</span> : null}
                  {selected.timing_breakdown.process_evidence_ms > 0 ? <span>{copy.processEvidence} {formatMetricDuration(selected.timing_breakdown.process_evidence_ms)}</span> : null}
                  {selected.timing_breakdown.user_wait_ms > 0 ? <span>{copy.userWait} {formatMetricDuration(selected.timing_breakdown.user_wait_ms)}</span> : null}
                </div>
              )}
              {selected.file_breakdown === undefined || (selected.file_breakdown.product_files === 0 && selected.file_breakdown.process_evidence_files === 0) ? null : (
                <p className="runs-file-breakdown">
                  {copy.productFiles.replace("{n}", String(selected.file_breakdown.product_files))}
                  {" · "}
                  {copy.processEvidenceFiles.replace("{n}", String(selected.file_breakdown.process_evidence_files))}
                </p>
              )}
              <div className="runs-phases">
                <h3>{copy.phasesTitle}</h3>
                <ol className="phase-steps">
                  {phaseSteps.map((step) => {
                    const duration = formatPhaseDuration(step.durationMs);
                    const attemptText = step.activePreparation !== null
                      ? copy.preparingAttempt.replace("{n}", String(step.activePreparation))
                      : step.blockedPreparationCount > 0
                        ? step.attemptCount > 0
                          ? copy.completedBlockedAttempts
                            .replace("{completed}", String(step.attemptCount))
                            .replace("{blocked}", String(step.blockedPreparationCount))
                          : copy.blockedAttempts.replace("{n}", String(step.blockedPreparationCount))
                        : step.attemptCount === 0
                          ? null
                          : step.state === "active"
                        ? copy.runningAttempt.replace("{n}", String(step.activeAttempt ?? step.attemptCount))
                        : step.state === "stale"
                          ? copy.staleAttempts.replace("{n}", String(step.attemptCount))
                          : copy.completedAttempts.replace("{n}", String(step.attemptCount));
                    const stateLabel = copy.phaseStateLabels[step.state] ?? step.state;
                    const attentionLabel = step.attention === "warning"
                      ? copy.phaseStateLabels.warning
                      : null;
                    return (
                      <li
                        aria-label={`${mapPhase(step.name)}：${stateLabel}${attentionLabel === null ? "" : `，${attentionLabel}`}${attemptText === null ? "" : `，${attemptText}`}`}
                        className={`phase-step phase-${step.name}`}
                        data-attention={step.attention}
                        data-phase={step.name}
                        data-state={step.state}
                        key={step.name}
                      >
                        <span className="phase-step-dot" aria-hidden="true" />
                        <span className="phase-step-label">
                          {mapPhase(step.name)}{step.attemptCount > 1 ? ` ×${step.attemptCount}` : ""}
                        </span>
                        {duration === null ? null : <span className="phase-step-duration">{duration}</span>}
                        {attemptText === null ? null : <span className="phase-step-attempt">{attemptText}</span>}
                        {attentionLabel === null ? null : (
                          <span className="phase-step-attention">{attentionLabel}</span>
                        )}
                      </li>
                    );
                  })}
                </ol>
                {selectedPreparation === null || (
                  selectedPreparation.preparation.ended_at !== null &&
                  selectedPreparation.preparation.status?.toUpperCase() !== "BLOCKED"
                ) ? null : (
                  <div
                    className={`phase-preparation ${selectedPreparation.preparation.status?.toUpperCase() === "BLOCKED" ? "is-blocked" : "is-active"}`}
                    role="status"
                  >
                    <strong>
                      {selectedPreparation.preparation.status?.toUpperCase() === "BLOCKED"
                        ? copy.fixbackNotStarted
                        : copy.preparingFix.replace("{n}", String(selectedPreparation.preparation.attempt))}
                    </strong>
                    <span>
                      {selectedPreparation.preparation.message
                        ?? (selectedPreparation.preparation.status?.toUpperCase() === "BLOCKED"
                          ? copy.preparationBlocked
                          : copy.preparationStarted.replace("{phase}", mapPhase(selectedPreparation.phase)))}
                    </span>
                    <small>
                      {copy.preparationTiming
                        .replace("{start}", formatTime(selectedPreparation.preparation.started_at))
                        .replace("{end}", formatTime(selectedPreparation.preparation.ended_at))}
                    </small>
                  </div>
                )}
              </div>
              {selectedArchive === null ? null : (
                <details className="run-archive">
                  <summary>
                    <span>{copy.archiveTitle}</span>
                    <span className="run-archive-count">{copy.filesCount.replace("{n}", String(selectedArchive.files.length))}</span>
                    {archiveIsSample ? (
                      <span className="sample-badge" title={copy.sampleDataHint}>{copy.sampleData}</span>
                    ) : null}
                  </summary>
                  <p className="run-archive-meta">{copy.archivedAt} {formatDateTime(selectedArchive.archivedAt)} · {copy.archiveHint}</p>
                  <ul className="run-archive-list">
                    {selectedArchive.files.map((file) => (
                      <li key={file.path}>
                        <span className={`archive-kind archive-kind-${file.kind}`}>{copy.archiveKinds[file.kind]}</span>
                        <button
                          type="button"
                          className="archive-file-open"
                          title={copy.viewFile}
                          onClick={() => {
                            void (async () => {
                              if (file.content !== undefined || selected === null || client.getChangeArchiveContent === undefined) {
                                setViewingFile(file);
                                return;
                              }
                              try {
                                const result = await client.getChangeArchiveContent(
                                  selected.project_id,
                                  selected.change_key,
                                  file.path
                                );
                                setViewingFile({ ...file, content: result.content });
                              } catch {
                                setViewingFile(file);
                              }
                            })();
                          }}
                        >
                          <code>{file.path}</code>
                        </button>
                        <small>{formatFileSize(file.sizeBytes)}</small>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <h3>{copy.timeline}</h3>
              {events.length === 0 ? (
                <EmptyState icon="clock" title={copy.noEvents} />
              ) : (
                <div className="log-panel">
                  <div className="log-panel-head">
                    <span>{copy.eventsCount.replace("{count}", String(events.length))}</span>
                    <span className="log-panel-actions">
                      {liveMode === "idle" ? null : <Spinner size={12} />}
                    </span>
                  </div>
                  <div className="log-panel-body runs-timeline-scroll" ref={timelineRef}>
                    <ol className="timeline">
                      {timelineEvents.map((event, index) => (
                        <li
                          className={`timeline-item timeline-${eventTone(event)} phase-${phaseClass(event.phase)} ${index === 0 || timelineEvents[index - 1]?.phase !== event.phase ? "timeline-phase-break" : ""}`}
                          data-phase={event.phase ?? "unknown"}
                          key={event.event_id}
                        >
                          <div className="timeline-meta">
                            <time dateTime={event.occurred_at}>{formatTime(event.occurred_at)}</time>
                            <span className="timeline-title">{copy.eventTypes[event.event_type] ?? event.event_type}</span>
                            {event.phase === null ? null : (
                              <span
                                className={`timeline-phase-badge phase-${phaseClass(event.phase)}`}
                                aria-label={`${copy.phaseLabel}：${mapPhase(event.phase)}`}
                              >
                                {mapPhase(event.phase)}
                              </span>
                            )}
                          </div>
                          <p className="timeline-summary">{eventDescription(event)}</p>
                          {eventExecutionLabel(event) === null ? null : (
                            <p className="timeline-detail">{eventExecutionLabel(event)}</p>
                          )}
                          {eventTechnicalDetails(event).length === 0 ? null : (
                            <details className="timeline-technical">
                              <summary>{copy.technicalDetails}</summary>
                              {eventTechnicalDetails(event).map((detail) => (
                                <code key={detail}>{detail}</code>
                              ))}
                            </details>
                          )}
                        </li>
                      ))}
                    </ol>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <Modal
        open={viewingFile !== null}
        onClose={() => setViewingFile(null)}
        title={<code className="archive-viewer-title">{viewingFile?.path}</code>}
        wide
        closeLabel={copy.closeViewer}
      >
        {viewingFile === null ? null : viewingFile.content === undefined ? (
          <p className="lede">{copy.noContent}</p>
        ) : viewingFile.path.endsWith(".md") ? (
          <MarkdownDocument content={viewingFile.content} />
        ) : (
          <pre className="archive-viewer-pre">{viewingFile.content}</pre>
        )}
      </Modal>
    </section>
  );
}

function StatusChip({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className={`runs-status-chip tone-${tone}`}>
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const COPY = {
  zh: {
    eyebrow: "监控",
    title: "运行监控",
    lede: "三态分离：运行状态 / 连接状态 / 同步完整性。事件来自本机 events.ndjson 上报。",
    project: "项目",
    noProjects: "暂无项目",
    refresh: "刷新",
    refreshAll: "刷新运行与事件",
    loading: "加载中…",
    empty: "尚无上报的运行记录。",
    selectHint: "选择左侧运行记录查看时间线。",
    listTitle: "运行记录",
    statsLabel: "运行统计",
    statTotal: "全部",
    statRunning: "进行中",
    statSucceeded: "已成功",
    statEndedEarly: "提前结束",
    statFailed: "失败",
    runStatus: "运行状态",
    connection: "连接状态",
    sync: "同步完整性",
    phase: "当前阶段",
    nextPhase: "下一阶段",
    nextPhaseValue: "下一步：{phase}",
    phaseWaiting: "{completed}已结束 · 等待{next}",
    phaseEnded: "{completed}已结束",
    archived: "已归档",
    archivedWarning: "已归档（有警告）",
    archivedWarningShort: "归档有警告",
    abandoned: "已主动结束",
    superseded: "已被其他方案替代",
    waitingShort: "等待继续",
    phaseEndedShort: "阶段已结束",
    waitingPhaseShort: "等待{phase}",
    phaseCompletedShort: "上一阶段已完成",
    workflowEndedShort: "流程已结束",
    inProgress: "中",
    attemptNumber: " · 第 {n} 次",
    preparingFix: "正在准备修复 · 第 {n} 次",
    preparingFixShort: "正在准备修复",
    fixbackNotStarted: "修复未启动",
    preparingPhase: "正在准备第 {n} 次{phase}",
    waitingForNext: "等待下一阶段",
    runningAttempt: "正在执行第 {n} 次",
    preparingAttempt: "正在准备第 {n} 次",
    completedAttempts: "已完成 {n} 次",
    completedBlockedAttempts: "已完成 {completed} 次 · 启动受阻 {blocked} 次",
    blockedAttempts: "启动受阻 {n} 次",
    staleAttempts: "已执行 {n} 次 · 待重新验证",
    preparationBlockedShort: "启动受阻",
    preparationStarted: "开始准备再次执行{phase}阶段。",
    preparationEnded: "{phase}阶段的再次执行准备已结束。",
    preparationBlocked: "前置条件未满足，本次修复尚未启动。",
    preparationTiming: "准备开始 {start} · 结束 {end}",
    phaseStateLabels: {
      done: "已完成",
      active: "执行中",
      preparing: "准备再次执行",
      failed: "失败",
      warning: "需要注意",
      stale: "待重新验证",
      pending: "未开始"
    } as Record<string, string>,
    connectionLabels: {
      online: "上报正常",
      delayed: "上报延迟",
      offline: "上报中断",
      idle: "等待新阶段",
      closed: "已结束"
    } as Record<string, string>,
    startedAt: "开始",
    endedAt: "结束",
    durationLabel: "时长",
    timingBreakdown: "耗时分类",
    productVerification: "产品验证",
    processEvidence: "流程证据",
    userWait: "等待确认",
    productFiles: "产品文件 {n} 个",
    processEvidenceFiles: "流程证据文件 {n} 个",
    phasesTitle: "阶段进度",
    archiveTitle: "归档文件",
    sampleData: "示例数据",
    sampleDataHint: "归档清单端点未落地，当前展示与真实归档同构的示例数据。",
    archivedAt: "归档于",
    filesCount: "{n} 个文件",
    archiveHint: "点击文件可阅读内容",
    viewFile: "阅读文件内容",
    noContent: "该文件暂无示例内容（真实端点落地后可读）。",
    closeViewer: "关闭",
    archiveKinds: {
      design: "设计",
      plan: "计划",
      knowledge: "知识",
      report: "报告",
      evidence: "证据",
      meta: "元信息",
      log: "日志"
    } as Record<string, string>,
    lastEvent: "最近事件",
    lastHeartbeat: "最近心跳",
    timeline: "事件时间线",
    noEvents: "尚无事件。",
    liveSse: "实时（SSE）",
    livePoll: "轮询更新",
    liveSseHint: "事件通过 SSE 实时推送。",
    livePollHint: "实时连接不可用，已降级为每 3 秒轮询。点击重试实时连接。",
    networkError: "无法连接到服务器。",
    eventsCount: "{count} 条事件",
    phaseLabel: "阶段",
    currentPhase: "当前阶段",
    decisionReason: "{decision}；原因：{reason}",
    phaseStartedDetail: "开始执行{phase}阶段：{detail}",
    phaseEndedDetail: "{phase}阶段已结束：{detail}",
    planArtifactsPublished: "规划产物已校验并发布",
    technicalDetails: "技术详情",
    delegatedTo: "隔离审查 · {agent}",
    inlineReview: "主会话评审",
    inlineReviewReason: "主会话评审 · {reason}",
    legacyInlineReview: "旧版记录未说明为何未委派，已由主会话完成评审。",
    reviewReasonLabels: {
      REVIEW_DELEGATED: "已使用独立评审",
      REVIEW_INLINE_UNAVAILABLE: "当前环境不支持隔离评审",
      REVIEW_INLINE_SPAWN_FAILED: "独立评审启动失败",
      REVIEW_INLINE_INVALID_RESULT: "独立评审结果无效",
      INLINE_BY_ADAPTER: "当前适配器使用主会话评审"
    } as Record<string, string>,
    reviewReasonSummaries: {
      REVIEW_DELEGATED: "已使用独立评审，主会话负责核验结果。",
      REVIEW_INLINE_UNAVAILABLE: "当前环境没有可用的隔离评审能力，已由主会话完成评审。",
      REVIEW_INLINE_SPAWN_FAILED: "独立评审启动失败，已由主会话完成评审。",
      REVIEW_INLINE_INVALID_RESULT: "独立评审未返回有效结果，已由主会话重新完成评审。",
      INLINE_BY_ADAPTER: "当前适配器未提供隔离评审，已由主会话完成评审。"
    } as Record<string, string>,
    reviewReasonUnknown: "已记录评审执行原因",
    reviewAdvisorySummary: "评审已完成：发现 {count} 项改进建议，不影响后续流程；已生成修复清单。",
    advisoryReviewPolicy: "当前项目采用建议性评审，本次改进建议不阻止进入下一阶段。",
    eventFallback: "记录了一项运行事件。",
    eventFallbacks: {
      "phase.start": "开始执行{phase}阶段。",
      "phase.end": "{phase}阶段已结束。",
      "phase.auto_sealed": "{phase}阶段已自动封存。",
      "phase.prepare.start": "开始准备再次执行{phase}阶段。",
      "phase.prepare.end": "再次执行{phase}阶段的准备已结束。",
      "gate.blocked": "前置条件未满足，本次阶段尚未启动。",
      "command": "执行了一项工作步骤。",
      "verification": "完成了一项结果验证。",
      "artifact": "生成或更新了一项交付内容。",
      "issue": "发现一项需要处理的问题。",
      "issue.resolve": "解决了此前记录的问题。",
      "decision": "记录了一项执行决策。",
      "correction": "根据当前结果调整了执行方式。",
      "change.rename": "更新了变更名称。",
      "recovery": "恢复了中断的运行状态。",
      "phase.recovery": "恢复了中断的阶段状态。",
      "attempt.recovery": "恢复了中断的执行尝试。",
      "heartbeat": "客户端保持在线，并同步了最新运行状态。"
    } as Record<string, string>,
    durationSeconds: "{n} 秒",
    durationMinutes: "{n} 分钟",
    durationMinutesSeconds: "{m} 分 {s} 秒",
    durationHours: "{h} 小时 {m} 分",
    eventTypes: {
      "phase.start": "阶段开始",
      "phase.end": "阶段结束",
      "phase.auto_sealed": "阶段自动封存",
      "phase.prepare.start": "阶段准备开始",
      "phase.prepare.end": "阶段准备结束",
      "gate.blocked": "阶段启动受阻",
      "command": "执行命令",
      "verification": "验证",
      "artifact": "产物",
      "issue": "发现问题",
      "issue.resolve": "问题解决",
      "decision": "记录决策",
      "correction": "纠偏",
      "change.rename": "变更改名",
      "recovery": "运行恢复",
      "phase.recovery": "阶段恢复",
      "attempt.recovery": "尝试恢复",
      "heartbeat": "心跳"
    } as Record<string, string>,
    phaseNames: {
      plan: "计划",
      run: "编码",
      test: "测试",
      review: "评审",
      package: "打包",
      apidoc: "接口文档",
      submit: "提交",
      archive: "归档"
    } as Record<string, string>
  },
  en: {
    eyebrow: "Monitoring",
    title: "Run monitor",
    lede: "Three-state model: run status / connection / sync completeness. Events come from local events.ndjson sync.",
    project: "Project",
    noProjects: "No projects",
    refresh: "Refresh",
    refreshAll: "Refresh runs and events",
    loading: "Loading…",
    empty: "No runs have been reported yet.",
    selectHint: "Select a run to inspect its timeline.",
    listTitle: "Runs",
    statsLabel: "Run statistics",
    statTotal: "Total",
    statRunning: "Running",
    statSucceeded: "Succeeded",
    statEndedEarly: "Ended early",
    statFailed: "Failed",
    runStatus: "Run status",
    connection: "Connection",
    sync: "Sync completeness",
    phase: "Current phase",
    nextPhase: "the next phase",
    nextPhaseValue: "Next: {phase}",
    phaseWaiting: "{completed} finished · waiting for {next}",
    phaseEnded: "{completed} finished",
    archived: "Archived",
    archivedWarning: "Archived with warnings",
    archivedWarningShort: "Archive warning",
    abandoned: "Ended by choice",
    superseded: "Superseded",
    waitingShort: "Waiting",
    phaseEndedShort: "Phase finished",
    waitingPhaseShort: "Waiting for {phase}",
    phaseCompletedShort: "Previous phase complete",
    workflowEndedShort: "Workflow ended",
    inProgress: " in progress",
    attemptNumber: " · attempt {n}",
    preparingFix: "Preparing fix · attempt {n}",
    preparingFixShort: "Preparing fix",
    fixbackNotStarted: "Fix not started",
    preparingPhase: "Preparing {phase} attempt {n}",
    waitingForNext: "Waiting for next phase",
    runningAttempt: "Running attempt {n}",
    preparingAttempt: "Preparing attempt {n}",
    completedAttempts: "Completed {n} times",
    completedBlockedAttempts: "Completed {completed} times · {blocked} blocked starts",
    blockedAttempts: "{n} blocked starts",
    staleAttempts: "Ran {n} times · revalidation required",
    preparationBlockedShort: "Start blocked",
    preparationStarted: "Preparing to run the {phase} phase again.",
    preparationEnded: "Preparation to rerun the {phase} phase finished.",
    preparationBlocked: "Prerequisites were not met, so this fix did not start.",
    preparationTiming: "Preparation started {start} · ended {end}",
    phaseStateLabels: {
      done: "completed",
      active: "running",
      preparing: "preparing rerun",
      failed: "failed",
      warning: "attention needed",
      stale: "revalidation required",
      pending: "not started"
    } as Record<string, string>,
    connectionLabels: {
      online: "Reporting normally",
      delayed: "Reporting delayed",
      offline: "Reporting interrupted",
      idle: "Waiting for next phase",
      closed: "Ended"
    } as Record<string, string>,
    startedAt: "Started",
    endedAt: "Ended",
    durationLabel: "Duration",
    timingBreakdown: "Timing breakdown",
    productVerification: "Product verification",
    processEvidence: "Process evidence",
    userWait: "Waiting for confirmation",
    productFiles: "{n} product files",
    processEvidenceFiles: "{n} process evidence files",
    phasesTitle: "Phase progress",
    archiveTitle: "Archived files",
    sampleData: "Sample data",
    sampleDataHint: "The archive manifest endpoint is not available yet; showing sample data shaped like a real archive.",
    archivedAt: "Archived at",
    filesCount: "{n} files",
    archiveHint: "Click a file to read its content",
    viewFile: "Read file content",
    noContent: "No sample content for this file (readable once the real endpoint lands).",
    closeViewer: "Close",
    archiveKinds: {
      design: "Design",
      plan: "Plan",
      knowledge: "Knowledge",
      report: "Report",
      evidence: "Evidence",
      meta: "Meta",
      log: "Log"
    } as Record<string, string>,
    lastEvent: "Last event",
    lastHeartbeat: "Last heartbeat",
    timeline: "Event timeline",
    noEvents: "No events yet.",
    liveSse: "Live (SSE)",
    livePoll: "Polling",
    liveSseHint: "Events are pushed in real time over SSE.",
    livePollHint: "Live stream unavailable; falling back to polling every 3s. Click to retry the live connection.",
    networkError: "Unable to reach the server.",
    eventsCount: "{count} events",
    phaseLabel: "phase",
    currentPhase: "the current",
    decisionReason: "{decision}; reason: {reason}",
    phaseStartedDetail: "Started the {phase} phase: {detail}",
    phaseEndedDetail: "The {phase} phase finished: {detail}",
    planArtifactsPublished: "planning artifacts verified and published",
    technicalDetails: "Technical details",
    delegatedTo: "Delegated review · {agent}",
    inlineReview: "Inline review",
    inlineReviewReason: "Inline review · {reason}",
    legacyInlineReview: "This legacy record did not explain why review was not delegated; the main session completed it.",
    reviewReasonLabels: {
      REVIEW_DELEGATED: "independent review used",
      REVIEW_INLINE_UNAVAILABLE: "isolated review is unavailable",
      REVIEW_INLINE_SPAWN_FAILED: "independent review failed to start",
      REVIEW_INLINE_INVALID_RESULT: "independent review returned an invalid result",
      INLINE_BY_ADAPTER: "the adapter uses inline review"
    } as Record<string, string>,
    reviewReasonSummaries: {
      REVIEW_DELEGATED: "An independent reviewer completed the review; the main session verified the result.",
      REVIEW_INLINE_UNAVAILABLE: "No isolated review capability is available, so the main session completed the review.",
      REVIEW_INLINE_SPAWN_FAILED: "The independent reviewer failed to start, so the main session completed the review.",
      REVIEW_INLINE_INVALID_RESULT: "The independent review was invalid, so the main session repeated the review.",
      INLINE_BY_ADAPTER: "This adapter does not provide isolated review, so the main session completed it."
    } as Record<string, string>,
    reviewReasonUnknown: "review execution reason recorded",
    reviewAdvisorySummary: "Review completed with {count} improvement suggestions; they do not block the next step, and a fix list was created.",
    advisoryReviewPolicy: "This project uses advisory review, so these suggestions do not block the next phase.",
    eventFallback: "A run event was recorded.",
    eventFallbacks: {
      "phase.start": "Started the {phase} phase.",
      "phase.end": "The {phase} phase finished.",
      "phase.auto_sealed": "The {phase} phase was auto-sealed.",
      "phase.prepare.start": "Preparing to run the {phase} phase again.",
      "phase.prepare.end": "Preparation to rerun the {phase} phase finished.",
      "gate.blocked": "Prerequisites were not met, so the phase did not start.",
      "command": "A work step was executed.",
      "verification": "A result was verified.",
      "artifact": "A deliverable was created or updated.",
      "issue": "An issue requiring attention was found.",
      "issue.resolve": "A previously recorded issue was resolved.",
      "decision": "An execution decision was recorded.",
      "correction": "The execution approach was adjusted.",
      "change.rename": "The change name was updated.",
      "recovery": "The interrupted run state was restored.",
      "phase.recovery": "The interrupted phase state was restored.",
      "attempt.recovery": "The interrupted attempt was restored.",
      "heartbeat": "The client stayed online and synced its latest state."
    } as Record<string, string>,
    durationSeconds: "{n}s",
    durationMinutes: "{n}m",
    durationMinutesSeconds: "{m}m {s}s",
    durationHours: "{h}h {m}m",
    eventTypes: {
      "phase.start": "Phase started",
      "phase.end": "Phase finished",
      "phase.auto_sealed": "Phase auto-sealed",
      "phase.prepare.start": "Phase preparation started",
      "phase.prepare.end": "Phase preparation finished",
      "gate.blocked": "Phase start blocked",
      "command": "Command",
      "verification": "Verification",
      "artifact": "Artifact",
      "issue": "Issue found",
      "issue.resolve": "Issue resolved",
      "decision": "Decision logged",
      "correction": "Correction",
      "change.rename": "Change renamed",
      "recovery": "Run recovery",
      "phase.recovery": "Phase recovery",
      "attempt.recovery": "Attempt recovery",
      "heartbeat": "Heartbeat"
    } as Record<string, string>,
    phaseNames: {
      plan: "Plan",
      run: "Code",
      test: "Test",
      review: "Review",
      package: "Package",
      apidoc: "API docs",
      submit: "Submit",
      archive: "Archive"
    } as Record<string, string>
  }
} as const;
