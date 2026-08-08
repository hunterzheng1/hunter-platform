"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ApiClientError,
  browserApi,
  type HunterApi,
  type ProjectSummary,
  type RunEventSummary,
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
import { MarkdownDocument } from "./skill-shared";

type Tone = "success" | "danger" | "warning" | "info" | "neutral";

function statusTone(value: string): Tone {
  if (["succeeded", "complete", "online", "completed"].includes(value)) return "success";
  if (["failed", "error"].includes(value)) return "danger";
  if (["partial", "queued", "pending", "offline", "delayed"].includes(value)) return "warning";
  if (value === "running") return "info";
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

type PhaseState = "done" | "active" | "failed" | "pending";

interface PhaseStep {
  name: string;
  state: PhaseState;
  durationMs: number | null;
}

/**
 * 基于 harness 阶段模板推导每阶段状态：完成=绿 / 进行中=蓝 / 失败=红 / 未开始=灰。
 * 当前阶段优先取 run.current_phase，缺失时回退到事件流中最近上报的 phase。
 * 若 run.phases[] 有服务端聚合耗时则叠加显示。
 */
function derivePhaseSteps(events: RunEventSummary[], run: RunSummary): PhaseStep[] {
  const failed = run.run_status === "failed" || run.run_status === "error";
  const finished = ["succeeded", "completed", "complete"].includes(run.run_status);
  const durationByPhase = new Map(
    (run.phases ?? []).map((phase) => [phase.id, phase.duration_ms])
  );

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

  // 条件阶段只在实际出现时纳入模板
  const template = HARNESS_PHASE_ORDER.filter((name) =>
    CONDITIONAL_PHASES.has(name) ? observed.has(name) : true
  );
  const currentIndex = currentName === null
    ? -1
    : (template as readonly string[]).indexOf(currentName);

  return template.map((name, index) => {
    const durationMs = durationByPhase.get(name) ?? null;
    if (finished) return { name, state: "done" as const, durationMs };
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
    return { name, state, durationMs };
  });
}

function formatPhaseDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
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
  const streamAbortRef = useRef<(() => void) | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  const selected = runs.find((run) => run.run_id === selectedRunId) ?? null;

  const stats = useMemo(() => {
    let running = 0;
    let succeeded = 0;
    let failed = 0;
    for (const run of runs) {
      const tone = statusTone(run.run_status);
      if (tone === "info" || tone === "warning") running += 1;
      else if (tone === "success") succeeded += 1;
      else if (tone === "danger") failed += 1;
    }
    return { total: runs.length, running, succeeded, failed };
  }, [runs]);

  const phaseSteps = useMemo(
    () => (selected === null ? [] : derivePhaseSteps(events, selected)),
    [events, selected]
  );

  function mapStatus(value: string): string {
    const labels = t.status as Record<string, string>;
    return labels[value] ?? value.replaceAll("_", " ");
  }

  function mapPhase(value: string): string {
    return copy.phaseNames[value] ?? mapStatus(value);
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
    const ms = durationMs(run, Date.now());
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
    let pollTimer: ReturnType<typeof setInterval> | null = null;
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

    function startPolling(): void {
      if (cancelled || pollTimer !== null) return;
      setLiveMode("poll");
      pollTimer = setInterval(() => { void pollOnce(); }, 3000);
    }

    async function loadInitialAndStream(): Promise<void> {
      try {
        const result = await listProjectRunEvents(projectId, runId);
        if (cancelled) return;
        setEvents(result.items);
        cursor = result.next_cursor;

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
                streamAbortRef.current?.();
                streamAbortRef.current = null;
                startPolling();
              }
            }
          );
          if (cancelled) {
            handle?.abort();
            return;
          }
          if (handle !== null) {
            if (pollTimer !== null) {
              handle.abort();
              return;
            }
            streamAbortRef.current = handle.abort;
            setLiveMode("sse");
            return;
          }
        }

        startPolling();
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiClientError ? err.message : copy.networkError);
        }
      }
    }

    void loadInitialAndStream();

    return () => {
      cancelled = true;
      streamAbortRef.current?.();
      streamAbortRef.current = null;
      if (pollTimer !== null) clearInterval(pollTimer);
    };
  }, [client, copy.networkError, projectId, selectedRunId, streamNonce]);

  // 新事件到达时滚动到底部
  useEffect(() => {
    const node = timelineRef.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  }, [events.length]);

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
          <div className="runs-stat tone-danger"><strong>{stats.failed}</strong><span>{copy.statFailed}</span></div>
        </div>
      </div>

      {error === null ? null : <p className="api-keys-message">{error}</p>}

      <div className="runs-split">
        <div className="runs-list-panel">
          <div className="runs-list-head">
            <h2>{copy.listTitle}<span className="runs-list-count">{runs.length}</span></h2>
            <button
              type="button"
              className="icon-button"
              disabled={busy || projectId === ""}
              title={copy.refresh}
              aria-label={copy.refresh}
              onClick={() => void refreshRuns(projectId)}
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
                return (
                  <li key={run.run_id}>
                    <button
                      type="button"
                      className={selectedRunId === run.run_id ? "active" : ""}
                      onClick={() => setSelectedRunId(run.run_id)}
                    >
                      <span className="run-row">
                        <i className={`run-dot run-dot-${tone}`} aria-hidden="true" />
                        <strong>{run.title ?? run.change_key}</strong>
                      </span>
                      <span className="run-meta">
                        <span className={`run-chip run-chip-${tone}`}>{mapStatus(run.run_status)}</span>
                        <span>{mapStatus(run.sync_completeness)}</span>
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
                  <h2>{selected.title ?? selected.change_key}</h2>
                  <p className="runs-mono">{selected.run_id}</p>
                </div>
                {liveBadge}
              </div>
              <div className="runs-status-grid">
                <StatusChip label={copy.runStatus} value={mapStatus(selected.run_status)} tone={statusTone(selected.run_status)} />
                <StatusChip label={copy.connection} value={mapStatus(selected.connection_status)} tone={statusTone(selected.connection_status)} />
                <StatusChip label={copy.sync} value={mapStatus(selected.sync_completeness)} tone={statusTone(selected.sync_completeness)} />
                <StatusChip label={copy.phase} value={selected.current_phase === null ? "—" : mapPhase(selected.current_phase)} tone="neutral" />
              </div>
              <div className="runs-meta">
                <span>{copy.startedAt} <strong>{formatDateTime(selected.started_at)}</strong></span>
                <span>{copy.endedAt} <strong>{formatDateTime(selected.ended_at)}</strong></span>
                <span>{copy.durationLabel} <strong>{formatDuration(selected) ?? "—"}</strong></span>
                <span>{copy.lastEvent} <strong>{formatTime(selected.last_event_at)}</strong></span>
                <span>{copy.lastHeartbeat} <strong>{formatTime(selected.last_heartbeat_at)}</strong></span>
              </div>
              <div className="runs-phases">
                <h3>{copy.phasesTitle}</h3>
                <ol className="phase-steps">
                  {phaseSteps.map((step) => {
                    const duration = formatPhaseDuration(step.durationMs);
                    return (
                      <li className="phase-step" data-state={step.state} key={step.name}>
                        <span className="phase-step-dot" aria-hidden="true" />
                        <span className="phase-step-label">{mapPhase(step.name)}</span>
                        {duration === null ? null : <span className="phase-step-duration">{duration}</span>}
                      </li>
                    );
                  })}
                </ol>
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
                      {events.map((event) => (
                        <li className={`timeline-item timeline-${eventTone(event)}`} key={event.event_id}>
                          <div className="timeline-meta">
                            <time dateTime={event.occurred_at}>{formatTime(event.occurred_at)}</time>
                            <span className="timeline-title">{copy.eventTypes[event.event_type] ?? event.event_type}</span>
                          </div>
                          {event.phase === null ? null : <p className="timeline-detail">{copy.phaseLabel} · {mapPhase(event.phase)}</p>}
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
    loading: "加载中…",
    empty: "尚无上报的运行记录。",
    selectHint: "选择左侧运行记录查看时间线。",
    listTitle: "运行记录",
    statsLabel: "运行统计",
    statTotal: "全部",
    statRunning: "进行中",
    statSucceeded: "已成功",
    statFailed: "失败",
    runStatus: "运行状态",
    connection: "连接状态",
    sync: "同步完整性",
    phase: "当前阶段",
    startedAt: "开始",
    endedAt: "结束",
    durationLabel: "时长",
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
    durationSeconds: "{n} 秒",
    durationMinutes: "{n} 分钟",
    durationMinutesSeconds: "{m} 分 {s} 秒",
    durationHours: "{h} 小时 {m} 分",
    eventTypes: {
      "phase.start": "阶段开始",
      "phase.end": "阶段结束",
      "phase.auto_sealed": "阶段自动封存",
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
    loading: "Loading…",
    empty: "No runs have been reported yet.",
    selectHint: "Select a run to inspect its timeline.",
    listTitle: "Runs",
    statsLabel: "Run statistics",
    statTotal: "Total",
    statRunning: "Running",
    statSucceeded: "Succeeded",
    statFailed: "Failed",
    runStatus: "Run status",
    connection: "Connection",
    sync: "Sync completeness",
    phase: "Current phase",
    startedAt: "Started",
    endedAt: "Ended",
    durationLabel: "Duration",
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
    durationSeconds: "{n}s",
    durationMinutes: "{n}m",
    durationMinutesSeconds: "{m}m {s}s",
    durationHours: "{h}h {m}m",
    eventTypes: {
      "phase.start": "Phase started",
      "phase.end": "Phase finished",
      "phase.auto_sealed": "Phase auto-sealed",
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
