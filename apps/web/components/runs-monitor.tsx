"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ApiClientError,
  browserApi,
  type HunterApi,
  type ProjectSummary,
  type RunEventSummary,
  type RunSummary
} from "../lib/api";
import { useI18n } from "../lib/i18n";

export function RunsMonitor({ api }: { api?: HunterApi }) {
  const { lang } = useI18n();
  const client = useMemo(() => api ?? browserApi(), [api]);
  const copy = COPY[lang];
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState("");
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<RunEventSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selected = runs.find((run) => run.run_id === selectedRunId) ?? null;

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
    if (projectId === "" || selectedRunId === null || client.listProjectRunEvents === undefined) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await client.listProjectRunEvents!(projectId, selectedRunId);
        if (!cancelled) setEvents(result.items);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiClientError ? err.message : copy.networkError);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, copy.networkError, projectId, selectedRunId]);

  return (
    <section className="runs-monitor">
      <header className="page-header">
        <div>
          <p className="eyebrow">{copy.eyebrow}</p>
          <h1>{copy.title}</h1>
          <p className="lede">{copy.lede}</p>
        </div>
      </header>

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
        <button type="button" disabled={busy || projectId === ""} onClick={() => void refreshRuns(projectId)}>
          {busy ? copy.loading : copy.refresh}
        </button>
      </div>

      {error === null ? null : <p className="api-keys-message">{error}</p>}

      <div className="runs-split">
        <ul className="runs-list">
          {runs.length === 0 ? (
            <li className="lede">{copy.empty}</li>
          ) : (
            runs.map((run) => (
              <li key={run.run_id}>
                <button
                  type="button"
                  className={selectedRunId === run.run_id ? "active" : ""}
                  onClick={() => setSelectedRunId(run.run_id)}
                >
                  <strong>{run.title ?? run.change_key}</strong>
                  <small>
                    {run.run_status} · {run.connection_status} · {run.sync_completeness}
                  </small>
                </button>
              </li>
            ))
          )}
        </ul>

        <div className="runs-detail">
          {selected === null ? (
            <p className="lede">{copy.selectHint}</p>
          ) : (
            <>
              <h2>{selected.title ?? selected.change_key}</h2>
              <div className="runs-status-grid">
                <StatusChip label={copy.runStatus} value={selected.run_status} />
                <StatusChip label={copy.connection} value={selected.connection_status} />
                <StatusChip label={copy.sync} value={selected.sync_completeness} />
                <StatusChip label={copy.phase} value={selected.current_phase ?? "—"} />
              </div>
              <p className="lede">
                {copy.lastEvent}: {selected.last_event_at ?? "—"} · {copy.lastHeartbeat}:{" "}
                {selected.last_heartbeat_at ?? "—"}
              </p>
              <h3>{copy.timeline}</h3>
              <ol className="runs-timeline">
                {events.map((event) => (
                  <li key={event.event_id}>
                    <code>{event.occurred_at}</code>
                    <span>
                      {event.event_type}
                      {event.phase === null ? "" : ` · ${event.phase}`}
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function StatusChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="runs-status-chip">
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}

const COPY = {
  zh: {
    eyebrow: "监控",
    title: "Run 监控",
    lede: "三态分离：Run 状态 / 连接状态 / 同步完整性。事件来自本地 events.ndjson 上报。",
    project: "项目",
    noProjects: "暂无项目",
    refresh: "刷新",
    loading: "加载中…",
    empty: "尚无上报的 Run。",
    selectHint: "选择左侧 Run 查看时间线。",
    runStatus: "Run 状态",
    connection: "连接状态",
    sync: "同步完整性",
    phase: "当前阶段",
    lastEvent: "最近事件",
    lastHeartbeat: "最近心跳",
    timeline: "事件时间线",
    networkError: "无法连接到服务器。"
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
    networkError: "Unable to reach the server."
  }
} as const;
