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
import { EmptyState } from "./ui/EmptyState";
import { Icon } from "./ui/icons";
import { PageHeader } from "./ui/PageHeader";
import { Spinner } from "./ui/Spinner";

type Tone = "success" | "danger" | "warning" | "info" | "neutral";

function statusTone(value: string): Tone {
  if (["succeeded", "complete", "online", "completed"].includes(value)) return "success";
  if (["failed", "error"].includes(value)) return "danger";
  if (["partial", "queued", "pending", "offline"].includes(value)) return "warning";
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

export function RunsMonitor({ api }: { api?: HunterApi }) {
  const { lang, t } = useI18n();
  const client = useMemo<HunterApi>(() => api ?? (
    process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true" ? mockApi : browserApi()
  ), [api]);
  const copy = COPY[lang];
  const locale = lang === "zh" ? "zh-CN" : "en-US";
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState("");
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<RunEventSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [liveMode, setLiveMode] = useState<"sse" | "poll" | "idle">("idle");
  const streamAbortRef = useRef<(() => void) | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  const selected = runs.find((run) => run.run_id === selectedRunId) ?? null;

  function mapStatus(value: string): string {
    const labels = t.status as Record<string, string>;
    return labels[value] ?? value.replaceAll("_", " ");
  }

  function formatTime(value: string | null): string {
    if (value === null) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString(locale);
  }

  const refreshProjects = useCallback(async () => {
    try {
      const items = await client.listProjects("active");
      setProjects(items);
      if (projectId === "" && items[0] !== undefined) {
        setProjectId(items[0].project_id);
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : copy.networkError);
    }
  }, [client, copy.networkError, projectId]);

  const refreshRuns = useCallback(async (id: string) => {
    if (id === "" || client.listProjectRuns === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const items = await client.listProjectRuns(id);
      setRuns(items);
      setSelectedRunId((current) => current ?? items[0]?.run_id ?? null);
    } catch (err) {
      setRuns([]);
      setError(err instanceof ApiClientError ? err.message : copy.networkError);
    } finally {
      setBusy(false);
    }
  }, [client, copy.networkError]);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  useEffect(() => {
    void refreshRuns(projectId);
  }, [projectId, refreshRuns]);

  useEffect(() => {
    streamAbortRef.current?.();
    streamAbortRef.current = null;
    setLiveMode("idle");

    if (projectId === "" || selectedRunId === null || client.listProjectRunEvents === undefined) {
      setEvents([]);
      return;
    }

    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let cursor = 0;

    async function loadInitialAndStream(): Promise<void> {
      try {
        const result = await client.listProjectRunEvents!(projectId, selectedRunId!);
        if (cancelled) return;
        setEvents(result.items);
        cursor = result.next_cursor;

        if (client.streamProjectRunEvents !== undefined) {
          const handle = await client.streamProjectRunEvents(
            projectId,
            selectedRunId!,
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
                // Fall through to REST poll below when stream errors.
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
        pollTimer = setInterval(() => {
          void (async () => {
            try {
              const next = await client.listProjectRunEvents!(projectId, selectedRunId!, cursor);
              if (cancelled || next.items.length === 0) return;
              setEvents((current) => {
                const known = new Set(current.map((item) => item.event_id));
                const appended = next.items.filter((item) => !known.has(item.event_id));
                return appended.length === 0 ? current : [...current, ...appended];
              });
              cursor = next.next_cursor;
              if (client.getProjectRun !== undefined) {
                const run = await client.getProjectRun(projectId, selectedRunId!);
                setRuns((current) => current.map((item) =>
                  item.run_id === run.run_id ? run : item
                ));
              }
            } catch {
              // keep polling
            }
          })();
        }, 3000);
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
  }, [client, copy.networkError, projectId, selectedRunId]);

  // 新事件到达时滚动到底部
  useEffect(() => {
    const node = timelineRef.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  }, [events.length]);

  return (
    <section className="runs-monitor">
      <PageHeader
        eyebrow={copy.eyebrow}
        title={copy.title}
        lede={copy.lede}
        actions={liveMode === "idle" ? undefined : (
          <span className={`runs-live-badge ${liveMode}`}>
            {liveMode === "sse" ? <Icon name="zap" size={13} /> : <Icon name="refresh" size={13} />}
            {liveMode === "sse" ? copy.liveSse : copy.livePoll}
          </span>
        )}
      />

      <div className="runs-toolbar">
        <label>
          {copy.project}
          <select
            value={projectId}
            onChange={(event) => {
              setSelectedRunId(null);
              setProjectId(event.target.value);
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
        <button type="button" className="secondary" disabled={busy || projectId === ""} onClick={() => void refreshRuns(projectId)}>
          {busy ? <Spinner size={13} label={copy.loading} /> : <Icon name="refresh" size={13} />}
          {busy ? copy.loading : copy.refresh}
        </button>
      </div>

      {error === null ? null : <p className="api-keys-message">{error}</p>}

      <div className="runs-split">
        {runs.length === 0 ? (
          <div className="panel">
            <EmptyState icon="activity" title={copy.empty} />
          </div>
        ) : (
          <ul className="runs-list">
            {runs.map((run) => {
              const tone = statusTone(run.run_status);
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
                    <small>
                      {mapStatus(run.run_status)} · {mapStatus(run.connection_status)} · {mapStatus(run.sync_completeness)}
                    </small>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <div className="runs-detail">
          {selected === null ? (
            <EmptyState icon="inbox" title={copy.selectHint} />
          ) : (
            <>
              <h2>{selected.title ?? selected.change_key}</h2>
              <div className="runs-status-grid">
                <StatusChip label={copy.runStatus} value={mapStatus(selected.run_status)} tone={statusTone(selected.run_status)} />
                <StatusChip label={copy.connection} value={mapStatus(selected.connection_status)} tone={statusTone(selected.connection_status)} />
                <StatusChip label={copy.sync} value={mapStatus(selected.sync_completeness)} tone={statusTone(selected.sync_completeness)} />
                <StatusChip label={copy.phase} value={selected.current_phase === null ? "—" : mapStatus(selected.current_phase)} tone="neutral" />
              </div>
              <p className="lede">
                {copy.lastEvent}: {formatTime(selected.last_event_at)} · {copy.lastHeartbeat}: {formatTime(selected.last_heartbeat_at)}
              </p>
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
                          {event.phase === null ? null : <p className="timeline-detail">{copy.phaseLabel} · {mapStatus(event.phase)}</p>}
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
    runStatus: "运行状态",
    connection: "连接状态",
    sync: "同步完整性",
    phase: "当前阶段",
    lastEvent: "最近事件",
    lastHeartbeat: "最近心跳",
    timeline: "事件时间线",
    noEvents: "尚无事件。",
    liveSse: "实时（SSE）",
    livePoll: "轮询回退",
    networkError: "无法连接到服务器。",
    eventsCount: "{count} 条事件",
    phaseLabel: "阶段",
    eventTypes: {
      "run.created": "运行已创建",
      "run.started": "运行已开始",
      "run.completed": "运行已完成",
      "run.failed": "运行失败",
      "phase.entered": "进入阶段",
      "files.scanned": "文件扫描",
      "files.synced": "文件已同步",
      "heartbeat": "心跳",
      "verify.warning": "校验警告"
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
    runStatus: "Run status",
    connection: "Connection",
    sync: "Sync completeness",
    phase: "Current phase",
    lastEvent: "Last event",
    lastHeartbeat: "Last heartbeat",
    timeline: "Event timeline",
    noEvents: "No events yet.",
    liveSse: "Live (SSE)",
    livePoll: "Polling fallback",
    networkError: "Unable to reach the server.",
    eventsCount: "{count} events",
    phaseLabel: "phase",
    eventTypes: {
      "run.created": "Run created",
      "run.started": "Run started",
      "run.completed": "Run completed",
      "run.failed": "Run failed",
      "phase.entered": "Phase entered",
      "files.scanned": "Files scanned",
      "files.synced": "Files synced",
      "heartbeat": "Heartbeat",
      "verify.warning": "Verify warning"
    } as Record<string, string>
  }
} as const;
