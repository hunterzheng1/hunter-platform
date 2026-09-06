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
import { MarkdownDocument } from "./skill-shared";
import { EmptyState } from "./ui/EmptyState";
import { Icon } from "./ui/icons";
import { PageHeader } from "./ui/PageHeader";
import { Pagination, usePagination } from "./ui/Pagination";
import { Spinner } from "./ui/Spinner";
import { ToastFeedback } from "./ui/Toast";

interface SearchHit {
  document: SemanticDocument;
  project_id: string;
}

/** 阅读分组的展示顺序；未列出的 kind 归入"其他资料"。 */
const KIND_GROUP_ORDER = ["knowledge_entry", "knowledge_markdown", "rule"] as const;

function kindLabel(hit: SearchHit, labels: Record<string, string>): string {
  return labels[hit.document.kind] ?? hit.document.kind.replaceAll("_", " ");
}

/**
 * 全局知识库：跨项目搜索与阅读。
 * 知识候选的裁决在服务端 ingest 时自动完成（见 docs/backend-gaps-frontend-ux.md），
 * 此处不再提供"候选审核"入口。
 *
 * 2026-09 阅读化改造（审查报告·页面节）：浏览按项目单页取摘要、正文在详情
 * 打开时单取；列表不再对人人相同的 status 徽标装饰（FIXED 历史条目不隐含
 * "当前有效"，仅 deprecated 显示"已停用"）；按 kind 分组；来源与历史收进展开区。
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
  const [bodyCache, setBodyCache] = useState<Map<string, SemanticDocument>>(new Map());
  const [bodyBusy, setBodyBusy] = useState(false);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const {
    page,
    totalPages,
    pageItems,
    setPage,
    total
  } = usePagination(hits ?? [], 20, [hits?.length, mode, projectId]);
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.project_id, project.display_name])),
    [projects]
  );
  const projectName = (id: string): string => projectNames.get(id) ?? copy.unknownProject;

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
      // 每个项目只取第一页摘要（cursor:null=单页，includeBody:false），
      // 不再排空所有页、不在首屏加载所有正文——详情打开时才取正文。
      const perProject = await Promise.all(targetIds.map(async (id) => {
        const page = await listKnowledge(id, { includeBody: false, cursor: null });
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

  // 正文懒加载：列表拿到的条目 body 为空串（include_body=0），选中后单取。
  const selectedKey = selected === null
    ? null
    : selected.project_id + "/" + selected.document.document_id;
  const selectedDocument = useMemo(() => {
    if (selected === null) return null;
    if (selected.document.body !== "") return selected.document;
    return selectedKey === null ? null : bodyCache.get(selectedKey) ?? null;
  }, [selected, selectedKey, bodyCache]);

  useEffect(() => {
    if (selected === null || selected.document.body !== "") return;
    if (selectedKey === null || bodyCache.has(selectedKey)) return;
    const fetchBody = api.getProjectSemanticKnowledgeDocument?.bind(api);
    if (fetchBody === undefined) return;
    let cancelled = false;
    setBodyBusy(true);
    setBodyError(null);
    fetchBody(selected.project_id, selected.document.document_id).then((document) => {
      if (cancelled) return;
      setBodyCache((previous) => new Map(previous).set(selectedKey, document));
    }).catch((err: unknown) => {
      if (cancelled) return;
      setBodyError(err instanceof ApiClientError ? err.message : copy.networkError);
    }).finally(() => {
      if (!cancelled) setBodyBusy(false);
    });
    return () => { cancelled = true; };
  }, [api, bodyCache, copy.networkError, selected, selectedKey]);

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
    return copy.noResults;
  }

  const statusLabels = t.status as Record<string, string>;
  // 浏览模式按 kind 分组阅读；搜索保持相关度顺序（服务端 tsvector 排序）。
  const orderedItems = mode === "browse"
    ? [...pageItems].sort((left, right) => {
        const leftIndex = KIND_GROUP_ORDER.indexOf(left.document.kind as (typeof KIND_GROUP_ORDER)[number]);
        const rightIndex = KIND_GROUP_ORDER.indexOf(right.document.kind as (typeof KIND_GROUP_ORDER)[number]);
        return (leftIndex === -1 ? KIND_GROUP_ORDER.length : leftIndex) -
          (rightIndex === -1 ? KIND_GROUP_ORDER.length : rightIndex);
      })
    : pageItems;
  let renderedGroup: string | null = null;

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

      <ToastFeedback tone="danger" message={error} />

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
              {orderedItems.map((hit) => {
                const groupKey = mode === "browse" ? hit.document.kind : null;
                const showGroup = groupKey !== null && groupKey !== renderedGroup;
                renderedGroup = groupKey;
                const deprecated = hit.document.metadata.status === "deprecated";
                return (
                  <li key={hit.document.document_id + hit.project_id} className={showGroup ? "knowledge-kind-start" : undefined}>
                    {showGroup ? (
                      <h3 className="knowledge-kind-group">{groupKey === "rule"
                        ? copy.kindRule
                        : groupKey === "knowledge_markdown"
                          ? copy.kindMarkdown
                          : copy.kindKnowledge}
                      </h3>
                    ) : null}
                    <button
                      type="button"
                      className={selected?.document.document_id === hit.document.document_id ? "active" : ""}
                      onClick={() => setSelected(hit)}
                    >
                      <strong>{hit.document.title}</strong>
                      <small>
                        {projectName(hit.project_id)} · {kindLabel(hit, statusLabels)}
                        {deprecated ? ` · ${copy.deprecated}` : ""}
                      </small>
                      <Icon className="hit-chevron" name="chevron-right" size={13} />
                    </button>
                  </li>
                );
              })}
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
                {kindLabel(selected, statusLabels)}
                {selected.document.metadata.status === "deprecated" ? ` · ${copy.deprecated}` : ""}
                {" · "}
                {copy.project}:{" "}
                <Link href={"/projects/" + encodeURIComponent(selected.project_id)}>
                  {projectName(selected.project_id)}
                </Link>
              </p>
              {bodyBusy ? <Spinner size={13} label={copy.loadingBody} /> : null}
              <ToastFeedback tone="danger" message={bodyError} />
              {selectedDocument === null ? null : (
                <div className="knowledge-body">
                  <MarkdownDocument content={selectedDocument.body} />
                </div>
              )}
              <details className="knowledge-source">
                <summary>{copy.sourceHistory}</summary>
                <dl>
                  <dt>document_id</dt>
                  <dd><code>{selected.document.document_id}</code></dd>
                  <dt>artifact_id</dt>
                  <dd><code>{selected.document.artifact_id}</code></dd>
                  <dt>source_path</dt>
                  <dd><code>{selected.document.source_path}</code></dd>
                  <dt>content_sha256</dt>
                  <dd><code>{selected.document.content_sha256}</code></dd>
                </dl>
                {Object.keys(selected.document.metadata).length > 0 ? (
                  <pre>{JSON.stringify(selected.document.metadata, null, 2)}</pre>
                ) : null}
              </details>
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
    lede: "跨项目阅读和搜索已沉淀的知识：决定与原因、约束、经验与风险。",
    searchPlaceholder: "搜索决策、风险、实现笔记…",
    search: "搜索",
    browse: "浏览",
    searching: "加载中…",
    searchHint: "输入关键词搜索，或留空浏览全部知识。",
    noResults: "没有匹配的知识条目。",
    emptyLibrary: "还没有可阅读的知识",
    emptyHint: "先在本地完成项目归档并上传；平台整理完成后，知识会显示在这里。",
    project: "项目",
    unknownProject: "未命名项目",
    filterProject: "项目筛选",
    allProjects: "全部项目",
    refresh: "刷新",
    loading: "加载中…",
    loadingBody: "加载正文…",
    networkError: "无法连接到服务器。",
    deprecated: "已停用",
    kindKnowledge: "知识",
    kindMarkdown: "Markdown 文档",
    kindRule: "规则",
    sourceHistory: "来源与历史",
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
    lede: "Read and search distilled knowledge across projects: decisions, constraints, experience, and risks.",
    searchPlaceholder: "Search decisions, risks, implementation notes…",
    search: "Search",
    browse: "Browse",
    searching: "Loading…",
    searchHint: "Enter a query to search, or leave empty to browse knowledge.",
    noResults: "No matching knowledge entries.",
    emptyLibrary: "No readable knowledge yet",
    emptyHint: "Push archives/knowledge via the CLI, or wait for ingest projection. If the DB was purged or replaced, push again.",
    project: "Project",
    unknownProject: "Unnamed project",
    filterProject: "Filter by project",
    allProjects: "All projects",
    refresh: "Refresh",
    loading: "Loading…",
    loadingBody: "Loading body…",
    networkError: "Unable to reach the server.",
    deprecated: "Deprecated",
    kindKnowledge: "Knowledge",
    kindMarkdown: "Markdown documents",
    kindRule: "Rules",
    sourceHistory: "Source & history",
    pageFirst: "First page",
    pagePrev: "Previous page",
    pageNext: "Next page",
    pageLast: "Last page",
    pageInfo: "Page {page} of {total}",
    totalCount: "{count} entries"
  }
} as const;
