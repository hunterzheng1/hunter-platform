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

export function KnowledgeCenter({ api }: { api?: HunterApi }) {
  const { lang } = useI18n();
  const client = useMemo(() => api ?? browserApi(), [api]);
  const copy = COPY[lang];
  const [tab, setTab] = useState<KnowledgeTab>("search");

  return (
    <section className="knowledge-center">
      <header className="page-header">
        <div>
          <p className="eyebrow">{copy.eyebrow}</p>
          <h1>{copy.title}</h1>
          <p className="lede">{copy.lede}</p>
        </div>
      </header>
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
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [selected, setSelected] = useState<SearchHit | null>(null);

  async function handleSearch(event: FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed === "" || api.searchSemanticDocuments === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const items = await api.searchSemanticDocuments(trimmed);
      setHits(items);
      setSelected(items[0] ?? null);
    } catch (err) {
      setHits([]);
      setSelected(null);
      setError(err instanceof ApiClientError ? err.message : copy.networkError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="knowledge-search-panel">
      <form className="knowledge-search-form" onSubmit={(event) => { void handleSearch(event); }}>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={copy.searchPlaceholder}
          aria-label={copy.searchPlaceholder}
        />
        <button type="submit" disabled={busy || query.trim() === ""}>
          {busy ? copy.searching : copy.search}
        </button>
      </form>
      {error === null ? null : <p className="api-keys-message">{error}</p>}
      {hits === null ? (
        <p className="lede">{copy.searchHint}</p>
      ) : hits.length === 0 ? (
        <div className="knowledge-empty"><span>◇</span><p>{copy.noResults}</p></div>
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
                    {hit.project_id} · {String(hit.document.metadata.status ?? hit.document.kind)}
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
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState("");
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      }
      setRows(collected);
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
        <button type="button" disabled={busy} onClick={() => void refresh(projectId)}>
          {busy ? copy.loading : copy.refresh}
        </button>
      </div>
      {message === null ? null : <p className="lede">{message}</p>}
      {error === null ? null : <p className="api-keys-message">{error}</p>}
      {rows.length === 0 && !busy ? (
        <div className="knowledge-empty"><span>◇</span><p>{copy.noCandidates}</p></div>
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
                    {row.projectName} · {row.entry.entry_id}
                  </small>
                </header>
                <p>{summary.slice(0, 400)}</p>
                <div className="knowledge-review-actions">
                  <button
                    type="button"
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
    lede: "跨项目搜索语义知识，并审核待批准的 candidate 条目。",
    tabs: { search: "全局搜索", review: "Candidate 审核" },
    searchPlaceholder: "搜索决策、风险、实现笔记…",
    search: "搜索",
    searching: "搜索中…",
    searchHint: "输入关键词，检索所有已投影的知识文档。",
    noResults: "没有匹配的知识条目。",
    project: "项目",
    filterProject: "项目筛选",
    allProjects: "全部项目",
    refresh: "刷新",
    loading: "加载中…",
    noCandidates: "当前没有待审核的 candidate。",
    approve: "批准为 active",
    reject: "驳回（deprecated）",
    openProject: "打开项目",
    approved: "已批准 {id}",
    rejected: "已驳回 {id}",
    networkError: "无法连接到服务器。"
  },
  en: {
    eyebrow: "Knowledge",
    title: "Global knowledge",
    lede: "Search semantic knowledge across projects and review pending candidates.",
    tabs: { search: "Global search", review: "Candidate review" },
    searchPlaceholder: "Search decisions, risks, implementation notes…",
    search: "Search",
    searching: "Searching…",
    searchHint: "Enter a query to search all projected knowledge documents.",
    noResults: "No matching knowledge entries.",
    project: "Project",
    filterProject: "Filter by project",
    allProjects: "All projects",
    refresh: "Refresh",
    loading: "Loading…",
    noCandidates: "No candidate entries awaiting review.",
    approve: "Approve as active",
    reject: "Reject (deprecated)",
    openProject: "Open project",
    approved: "Approved {id}",
    rejected: "Rejected {id}",
    networkError: "Unable to reach the server."
  }
} as const;
