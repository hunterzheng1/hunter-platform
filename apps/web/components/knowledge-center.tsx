"use client";

import type { SemanticDocument } from "@hunter-harness/contracts";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import {
  ApiClientError,
  browserApi,
  type HunterApi,
  type ProjectSummary
} from "../lib/api";
import { useI18n } from "../lib/i18n";
import { mockApi } from "../lib/mock-api";
import { EmptyState } from "./ui/EmptyState";
import { Icon } from "./ui/icons";
import { PageHeader } from "./ui/PageHeader";
import { Pagination, usePagination } from "./ui/Pagination";
import { Spinner } from "./ui/Spinner";

interface SearchHit {
  document: SemanticDocument;
  project_id: string;
}

function statusLabel(value: string, labels: Record<string, string>): string {
  return labels[value] ?? value.replaceAll("_", " ");
}

/**
 * 全局知识库：跨项目搜索与浏览。
 * 知识候选的裁决在服务端 ingest 时自动完成（见 docs/backend-gaps-frontend-ux.md），
 * 此处不再提供"候选审核"入口。
 */
export function KnowledgeCenter({ api }: { api?: HunterApi }) {
  const { lang } = useI18n();
  const client = useMemo<HunterApi>(() => api ?? (
    process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true" ? mockApi : browserApi()
  ), [api]);
  const copy = COPY[lang];

  return (
    <section className="knowledge-center">
      <PageHeader eyebrow={copy.eyebrow} title={copy.title} lede={copy.lede} />
      <GlobalKnowledgeSearch api={client} copy={copy} />
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
  const [libraryEmpty, setLibraryEmpty] = useState(false);
  const {
    page,
    totalPages,
    pageItems,
    setPage,
    total
  } = usePagination(hits ?? [], 20, [hits?.length, mode, projectId]);

  const browse = useCallback(async (selectedProjectId: string) => {
    const listKnowledge = api.listProjectSemanticKnowledge?.bind(api);
    if (listKnowledge === undefined) return;
    setBusy(true);
    setError(null);
    setMode("browse");
    try {
      const projectList = projects.length > 0 ? projects : await api.listProjects("active");
      if (projects.length === 0) setProjects(projectList);
      const targetIds = selectedProjectId === ""
        ? projectList.map((project) => project.project_id)
        : [selectedProjectId];
      // 并行拉取各项目知识，避免串行瀑布
      const perProject = await Promise.all(targetIds.map(async (id) => {
        const page = await listKnowledge(id, { includeBody: true });
        return page.items.map((document): SearchHit => ({ document, project_id: id }));
      }));
      const collected = perProject.flat();
      setHits(collected);
      setSelected(collected[0] ?? null);
      setLibraryEmpty(collected.length === 0);
    } catch (err) {
      setHits([]);
      setSelected(null);
      setError(err instanceof ApiClientError ? err.message : copy.networkError);
    } finally {
      setBusy(false);
    }
  }, [api, copy.networkError, projects]);

  useEffect(() => {
    void browse(projectId);
  }, [projectId]);

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
          <div className="knowledge-hit-col">
            <ul className="knowledge-hit-list">
              {pageItems.map((hit) => (
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
                    <Icon className="hit-chevron" name="chevron-right" size={13} />
                  </button>
                </li>
              ))}
            </ul>
            {totalPages <= 1 ? null : (
              <Pagination
                page={page}
                totalPages={totalPages}
                total={total}
                onChange={setPage}
                labels={{
                  first: copy.pageFirst,
                  prev: copy.pagePrev,
                  next: copy.pageNext,
                  last: copy.pageLast,
                  pageInfo: copy.pageInfo,
                  totalCount: copy.totalCount
                }}
              />
            )}
          </div>
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

const COPY = {
  zh: {
    eyebrow: "知识库",
    title: "全局知识",
    lede: "跨项目浏览与搜索语义知识。候选条目在服务端 ingest 时自动裁决并投影。",
    searchPlaceholder: "搜索决策、风险、实现笔记…",
    search: "搜索",
    browse: "浏览",
    searching: "加载中…",
    searchHint: "输入关键词搜索，或留空浏览已投影的知识文档。",
    noResults: "没有匹配的知识条目。",
    emptyLibrary: "语义库当前为空。",
    emptyHint: "请先通过 CLI push 归档/知识，或等待 ingest 投影完成。若曾 purge/换库，需重新 push。",
    project: "项目",
    filterProject: "项目筛选",
    allProjects: "全部项目",
    refresh: "刷新",
    loading: "加载中…",
    networkError: "无法连接到服务器。",
    pageFirst: "第一页",
    pagePrev: "上一页",
    pageNext: "下一页",
    pageLast: "最后一页",
    pageInfo: "第 {page} / {total} 页",
    totalCount: "共 {count} 条"
  },
  en: {
    eyebrow: "Knowledge",
    title: "Global knowledge",
    lede: "Browse and search semantic knowledge across projects. Candidates are auto-adjudicated during server-side ingest.",
    searchPlaceholder: "Search decisions, risks, implementation notes…",
    search: "Search",
    browse: "Browse",
    searching: "Loading…",
    searchHint: "Enter a query to search, or leave empty to browse projected documents.",
    noResults: "No matching knowledge entries.",
    emptyLibrary: "The semantic library is empty.",
    emptyHint: "Push archives/knowledge via the CLI, or wait for ingest projection. If the DB was purged or replaced, push again.",
    project: "Project",
    filterProject: "Filter by project",
    allProjects: "All projects",
    refresh: "Refresh",
    loading: "Loading…",
    networkError: "Unable to reach the server.",
    pageFirst: "First page",
    pagePrev: "Previous page",
    pageNext: "Next page",
    pageLast: "Last page",
    pageInfo: "Page {page} of {total}",
    totalCount: "{count} entries"
  }
} as const;
