"use client";

import type { SemanticDocument } from "@hunter-harness/contracts";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import {
  ApiClientError,
  browserApi,
  type HunterApi,
  type KnowledgeIngestListItem,
  type ProjectSummary
} from "../lib/api";
import { useI18n } from "../lib/i18n";
import { mockApi } from "../lib/mock-api";
import { EmptyState } from "./ui/EmptyState";
import { Icon } from "./ui/icons";
import { PageHeader } from "./ui/PageHeader";
import { Spinner } from "./ui/Spinner";

type KnowledgeTab = "search" | "review";

interface SearchHit {
  document: SemanticDocument;
  project_id: string;
}

interface ReviewRow {
  projectId: string;
  projectName: string;
  entry: KnowledgeIngestListItem;
}

function payloadField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

function statusLabel(value: string, labels: Record<string, string>): string {
  return labels[value] ?? value.replaceAll("_", " ");
}

export function KnowledgeCenter({ api }: { api?: HunterApi }) {
  const { lang } = useI18n();
  const client = useMemo<HunterApi>(() => api ?? (
    process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true" ? mockApi : browserApi()
  ), [api]);
  const copy = COPY[lang];
  const [tab, setTab] = useState<KnowledgeTab>("search");

  return (
    <section className="knowledge-center">
      <PageHeader eyebrow={copy.eyebrow} title={copy.title} lede={copy.lede} />
      <div className="workspace-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          className={tab === "search" ? "active" : ""}
          aria-selected={tab === "search"}
          onClick={() => setTab("search")}
        >
          {copy.tabs.search}
        </button>
        <button
          type="button"
          role="tab"
          className={tab === "review" ? "active" : ""}
          aria-selected={tab === "review"}
          onClick={() => setTab("review")}
        >
          {copy.tabs.review}
        </button>
      </div>
      {tab === "search" ? <GlobalKnowledgeSearch api={client} copy={copy} /> : null}
      {tab === "review" ? <CandidateReviewPanel api={client} copy={copy} /> : null}
    </section>
  );
}

function GlobalKnowledgeSearch({
  api,
  copy
}: {
  api: HunterApi;
  copy: (typeof COPY)[keyof typeof COPY];
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [projectId, setProjectId] = useState("");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [selected, setSelected] = useState<SearchHit | null>(null);
  const [mode, setMode] = useState<"idle" | "browse" | "search">("idle");
  const [pendingTotal, setPendingTotal] = useState(0);
  const [libraryEmpty, setLibraryEmpty] = useState(false);

  const loadProjects = useCallback(async () => {
    try {
      const list = await api.listProjects("active");
      setProjects(list);
    } catch {
      // project filter is optional
    }
  }, [api]);

  const loadPending = useCallback(async (ids: string[]) => {
    if (api.getKnowledgeProjectionStatus === undefined) {
      setPendingTotal(0);
      return;
    }
    let total = 0;
    for (const id of ids) {
      try {
        const status = await api.getKnowledgeProjectionStatus(id);
        total += status.pending_count;
      } catch {
        // ignore per-project projection status failures
      }
    }
    setPendingTotal(total);
  }, [api]);

  const browse = useCallback(async (selectedProjectId: string) => {
    if (api.listProjectSemanticKnowledge === undefined) return;
    setBusy(true);
    setError(null);
    setMode("browse");
    try {
      const projectList = projects.length > 0 ? projects : await api.listProjects("active");
      if (projects.length === 0) setProjects(projectList);
      const targetIds = selectedProjectId === ""
        ? projectList.map((project) => project.project_id)
        : [selectedProjectId];
      const collected: SearchHit[] = [];
      for (const id of targetIds) {
        const docs = await api.listProjectSemanticKnowledge(id);
        for (const document of docs) {
          collected.push({ document, project_id: id });
        }
      }
      setHits(collected);
      setSelected(collected[0] ?? null);
      setLibraryEmpty(collected.length === 0);
      await loadPending(targetIds);
    } catch (err) {
      setHits([]);
      setSelected(null);
      setError(err instanceof ApiClientError ? err.message : copy.networkError);
    } finally {
      setBusy(false);
    }
  }, [api, copy.networkError, loadPending, projects]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    void browse(projectId);
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps -- browse on filter change only

  async function handleSearch(event: FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed === "") {
      await browse(projectId);
      return;
    }
    if (api.searchSemanticDocuments === undefined) return;
    setBusy(true);
    setError(null);
    setMode("search");
    try {
      const items = await api.searchSemanticDocuments(
        trimmed,
        projectId === "" ? undefined : projectId
      );
      setHits(items);
      setSelected(items[0] ?? null);
      setLibraryEmpty(false);
      const targetIds = projectId === ""
        ? projects.map((project) => project.project_id)
        : [projectId];
      await loadPending(targetIds);
    } catch (err) {
      setHits([]);
      setSelected(null);
      setError(err instanceof ApiClientError ? err.message : copy.networkError);
    } finally {
      setBusy(false);
    }
  }

  function emptyMessage(): string {
    if (mode === "idle" || hits === null) return copy.searchHint;
    if (libraryEmpty && mode === "browse") {
      if (pendingTotal > 0) return copy.emptyPending.replace("{n}", String(pendingTotal));
      return copy.emptyLibrary;
    }
    if (mode === "search") return copy.noResults;
    return copy.noResults;
  }

  return (
    <div className="knowledge-search-panel">
      <form className="knowledge-search-form" onSubmit={(event) => { void handleSearch(event); }}>
        <label className="form-field knowledge-filter">
          <span className="form-label">{copy.filterProject}</span>
          <select
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            disabled={busy}
          >
            <option value="">{copy.allProjects}</option>
            {projects.map((project) => (
              <option key={project.project_id} value={project.project_id}>
                {project.display_name}
              </option>
            ))}
          </select>
        </label>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={copy.searchPlaceholder}
          aria-label={copy.searchPlaceholder}
        />
        <button type="submit" className="primary" disabled={busy}>
          {busy ? <Spinner size={13} label={copy.searching} /> : <Icon name="search" size={13} />}
          {busy ? copy.searching : query.trim() === "" ? copy.browse : copy.search}
        </button>
      </form>

      {pendingTotal > 0 ? (
        <p className="notice warning" role="status">
          {copy.pendingBanner.replace("{n}", String(pendingTotal))}
        </p>
      ) : null}

      {error === null ? null : <p className="api-keys-message">{error}</p>}

      {hits === null || busy ? (
        <div className="skeleton-block" aria-busy="true" aria-label={copy.loading} />
      ) : hits.length === 0 ? (
        <EmptyState
          icon="brain"
          title={emptyMessage()}
          hint={libraryEmpty ? copy.emptyHint : undefined}
        />
      ) : (
        <div className="knowledge-split">
          <ul className="knowledge-hit-list">
            {hits.map((hit) => (
              <li key={hit.document.document_id + hit.project_id}>
                <button
                  type="button"
                  className={selected?.document.document_id === hit.document.document_id ? "active" : ""}
                  onClick={() => setSelected(hit)}
                >
                  <strong>{hit.document.title}</strong>
                  <small>
                    {hit.project_id} · {statusLabel(
                      String(hit.document.metadata.status ?? hit.document.kind),
                      t.status as Record<string, string>
                    )}
                  </small>
                </button>
              </li>
            ))}
          </ul>
          {selected === null ? null : (
            <article className="knowledge-hit-detail">
              <h2>{selected.document.title}</h2>
              <p className="lede">
                {copy.project}:{" "}
                <Link href={"/projects/" + encodeURIComponent(selected.project_id)}>
                  {selected.project_id}
                </Link>
              </p>
              <pre className="knowledge-body">{selected.document.body}</pre>
            </article>
          )}
        </div>
      )}
    </div>
  );
}

function CandidateReviewPanel({
  api,
  copy
}: {
  api: HunterApi;
  copy: (typeof COPY)[keyof typeof COPY];
}) {
  const { t } = useI18n();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState("");
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingTotal, setPendingTotal] = useState(0);

  const refresh = useCallback(async (selectedProjectId: string) => {
    if (api.listKnowledgeEntries === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const projectList = await api.listProjects("active");
      setProjects(projectList);
      const targetIds = selectedProjectId === ""
        ? projectList.map((project) => project.project_id)
        : [selectedProjectId];
      const collected: ReviewRow[] = [];
      let pending = 0;
      for (const id of targetIds) {
        const project = projectList.find((item) => item.project_id === id);
        const entries = await api.listKnowledgeEntries(id, { status: "candidate", limit: 100 });
        for (const entry of entries) {
          collected.push({
            projectId: id,
            projectName: project?.display_name ?? id,
            entry
          });
        }
        if (api.getKnowledgeProjectionStatus !== undefined) {
          try {
            const status = await api.getKnowledgeProjectionStatus(id);
            pending += status.pending_count;
          } catch {
            // ignore
          }
        }
      }
      setRows(collected);
      setPendingTotal(pending);
    } catch (err) {
      setRows([]);
      setError(err instanceof ApiClientError ? err.message : copy.networkError);
    } finally {
      setBusy(false);
    }
  }, [api, copy.networkError]);

  useEffect(() => {
    void refresh(projectId);
  }, [projectId, refresh]);

  async function adjudicate(row: ReviewRow, status: "active" | "deprecated"): Promise<void> {
    if (api.updateKnowledgeEntryStatus === undefined) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      await api.updateKnowledgeEntryStatus(row.projectId, row.entry.entry_id, status);
      setMessage(
        status === "active"
          ? copy.approved.replace("{id}", row.entry.entry_id)
          : copy.rejected.replace("{id}", row.entry.entry_id)
      );
      await refresh(projectId);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : copy.networkError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="knowledge-review-panel">
      <p className="lede">{copy.reviewHint}</p>
      <div className="knowledge-review-toolbar">
        <label>
          {copy.filterProject}
          <select
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            disabled={busy}
          >
            <option value="">{copy.allProjects}</option>
            {projects.map((project) => (
              <option key={project.project_id} value={project.project_id}>
                {project.display_name}
              </option>
            ))}
          </select>
        </label>
        <span className="knowledge-count">{copy.candidateCount.replace("{n}", String(rows.length))}</span>
        <button type="button" className="secondary" disabled={busy} onClick={() => void refresh(projectId)}>
          {busy ? copy.loading : copy.refresh}
        </button>
      </div>
      {pendingTotal > 0 ? (
        <p className="notice warning" role="status">
          {copy.pendingBanner.replace("{n}", String(pendingTotal))}
        </p>
      ) : null}
      {message === null ? null : <p className="lede">{message}</p>}
      {error === null ? null : <p className="api-keys-message">{error}</p>}
      {rows.length === 0 && !busy ? (
        <EmptyState icon="tasks" title={copy.noCandidates} />
      ) : (
        <div className="knowledge-review-list">
          {rows.map((row) => {
            const title = payloadField(row.entry.payload, "title") || row.entry.entry_id;
            const summary = payloadField(row.entry.payload, "summary") ||
              payloadField(row.entry.payload, "body");
            return (
              <article key={row.projectId + ":" + row.entry.entry_id} className="knowledge-review-card">
                <header>
                  <h3>{title}</h3>
                  <small>
                    {row.projectName} · {row.entry.entry_id} ·{" "}
                    {statusLabel(row.entry.status, t.status as Record<string, string>)}
                  </small>
                </header>
                <p>{summary.slice(0, 400)}</p>
                <div className="knowledge-review-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() => void adjudicate(row, "active")}
                  >
                    {copy.approve}
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={busy}
                    onClick={() => void adjudicate(row, "deprecated")}
                  >
                    {copy.reject}
                  </button>
                  <Link href={"/projects/" + encodeURIComponent(row.projectId)}>
                    {copy.openProject}
                  </Link>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

const COPY = {
  zh: {
    eyebrow: "知识库",
    title: "全局知识",
    lede: "跨项目浏览与搜索语义知识，并审核待批准的候选条目。",
    tabs: { search: "跨项目搜索", review: "候选审核" },
    searchPlaceholder: "搜索决策、风险、实现笔记…",
    search: "搜索",
    browse: "浏览",
    searching: "加载中…",
    searchHint: "输入关键词搜索，或留空浏览已投影的知识文档。",
    noResults: "没有匹配的知识条目。",
    emptyLibrary: "语义库当前为空。",
    emptyPending: "库中暂无可见文档，但仍有 {n} 条待投影——请稍候或先 push。",
    emptyHint: "请先通过 CLI push 归档/知识，或等待 ingest 投影完成。若曾 purge/换库，需重新 push。",
    pendingBanner: "待投影 {n} 条知识条目（尚未进入语义库）。",
    project: "项目",
    filterProject: "项目筛选",
    allProjects: "全部项目",
    refresh: "刷新",
    loading: "加载中…",
    reviewHint: "仅显示待审候选条目；已批准内容可在「跨项目搜索」或项目知识库中查看。",
    candidateCount: "待审 {n} 条",
    noCandidates: "当前没有待审核的候选条目。",
    approve: "批准为生效",
    reject: "驳回（已废弃）",
    openProject: "打开项目",
    approved: "已批准 {id}",
    rejected: "已驳回 {id}",
    networkError: "无法连接到服务器。"
  },
  en: {
    eyebrow: "Knowledge",
    title: "Global knowledge",
    lede: "Browse and search semantic knowledge across projects, and review pending candidates.",
    tabs: { search: "Cross-project search", review: "Candidate review" },
    searchPlaceholder: "Search decisions, risks, implementation notes…",
    search: "Search",
    browse: "Browse",
    searching: "Loading…",
    searchHint: "Enter a query to search, or leave empty to browse projected documents.",
    noResults: "No matching knowledge entries.",
    emptyLibrary: "The semantic library is empty.",
    emptyPending: "No visible documents yet, but {n} entries are still pending projection — wait or push first.",
    emptyHint: "Push archives/knowledge via the CLI, or wait for ingest projection. If the DB was purged or replaced, push again.",
    pendingBanner: "{n} knowledge entries pending projection (not yet in the semantic library).",
    project: "Project",
    filterProject: "Filter by project",
    allProjects: "All projects",
    refresh: "Refresh",
    loading: "Loading…",
    reviewHint: "Only pending candidates are listed here. Approved entries appear in Cross-project search or project knowledge.",
    candidateCount: "{n} pending",
    noCandidates: "No candidate entries awaiting review.",
    approve: "Approve as active",
    reject: "Reject (deprecated)",
    openProject: "Open project",
    approved: "Approved {id}",
    rejected: "Rejected {id}",
    networkError: "Unable to reach the server."
  }
} as const;
