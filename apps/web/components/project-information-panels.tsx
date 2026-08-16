"use client";

import type {
  PlatformInformationDetailResponse,
  PlatformInformationPage,
} from "@hunter-harness/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiClientError, type HunterApi } from "../lib/api";
import { WorkspaceFilterBar, WorkspaceState } from "./project-workspace-shell";

type Lang = "zh" | "en";
type View = PlatformInformationPage["view"];
type Item = PlatformInformationPage["items"][number];

const COPY = {
  zh: {
    loading: "正在加载", empty: "暂无内容", emptyHint: "该视图目前没有可显示的数据。", processing: "数据仍在处理中",
    processingHint: "平台完成投影后会自动显示真实结果。", forbidden: "无权查看", forbiddenHint: "当前身份没有此项目视图的访问权限。",
    partial: "部分结果暂不可用", partialHint: "已加载的结果仍可查看。", failed: "知识提取失败", failedHint: "平台保留了失败状态，需使用可信任务身份重试。",
    error: "加载失败", errorHint: "平台暂时无法返回此视图，请稍后重试。", paginationFailure: "后续结果加载失败，已加载内容不受影响。", retry: "重试", retryMore: "重试加载更多", retryExtraction: "重试提取", loadMore: "加载更多", filter: "筛选当前结果", filterPlaceholder: "搜索名称、路径或版本",
    technical: "技术详情", open: "打开", branchFiles: "分支快照", materials: "项目资料", knowledge: "项目知识", changes: "变更记录", versions: "版本记录",
    bounded: "普通列表最多显示 500 项；其余结果未加载。",
    files: "个文件", changed: "项变化", source: "来源", relations: "个关系", archive: "归档引用", documents: "变更文档", candidates: "治理候选",
    detailLoading: "正在按需加载详情", choose: "选择一项查看详情。", document: "文档", unavailableFiles: "当前 HTTP Interface 尚未暴露快照文件 locator；不会回退到旧的全量项目文件接口。",
    unavailableDiff: "当前 HTTP Interface 尚未接通可信版本差异 locator。", unavailableDownload: "归档身份已就绪，但认证下载 client 尚未接通。",
    documentLoading: "正在按需加载变更文档", documentFailure: "变更文档暂时无法加载，请重试。", documentUnsupported: "当前 API client 不支持加载变更文档详情。"
  },
  en: {
    loading: "Loading", empty: "Nothing here yet", emptyHint: "This view currently has no results.", processing: "Data is still processing",
    processingHint: "Real results appear after the platform projection completes.", forbidden: "Access denied", forbiddenHint: "Your identity cannot access this project view.",
    partial: "Some results are unavailable", partialHint: "Loaded results remain available.", failed: "Knowledge extraction failed", failedHint: "The failure is retained; retry requires a trusted job identity.",
    error: "Could not load", errorHint: "The platform could not return this view. Try again later.", paginationFailure: "More results could not be loaded. Existing results are unchanged.", retry: "Retry", retryMore: "Retry load more", retryExtraction: "Retry extraction", loadMore: "Load more", filter: "Filter current results", filterPlaceholder: "Search names, paths, or versions",
    technical: "Technical details", open: "Open", branchFiles: "Branch snapshots", materials: "Project materials", knowledge: "Project knowledge", changes: "Change records", versions: "Version history",
    bounded: "This list is capped at 500 loaded items; remaining results were not loaded.",
    files: "files", changed: "changed", source: "Source", relations: "relations", archive: "Archive reference", documents: "Change documents", candidates: "Governance candidates",
    detailLoading: "Loading detail on demand", choose: "Select an item to view its detail.", document: "document", unavailableFiles: "The HTTP interface does not expose a trusted snapshot-file locator yet; the legacy unbounded project-file API is not used.",
    unavailableDiff: "The HTTP interface does not expose a trusted version-diff locator yet.", unavailableDownload: "Archive identity is available, but the authenticated download client is not wired yet.",
    documentLoading: "Loading change document on demand", documentFailure: "The change document could not be loaded. Try again.", documentUnsupported: "Change document detail is not supported by this API client."
  }
} as const;

const INFORMATION_PAGE_LIMIT = 50;
const INFORMATION_MAX_ITEMS = 500;
const INFORMATION_MAX_PAGES = Math.ceil(INFORMATION_MAX_ITEMS / INFORMATION_PAGE_LIMIT);

function technical(error: unknown): Array<{ label: string; value: string }> {
  if (error instanceof ApiClientError) return [{ label: "Code", value: error.code }, { label: "HTTP", value: String(error.status) }];
  if (error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message)) return [{ label: "Code", value: error.message }];
  return [{ label: "Code", value: "PLATFORM_INFORMATION_UI_ERROR" }];
}

function itemIdentity(item: Item): string {
  switch (item.item_kind) {
    case "branch_monitor": return `run:${item.run_id}`;
    case "branch_snapshot": return `branch:${item.branch_name}:${item.snapshot_version}`;
    case "project_material": return `material:${item.material_id}`;
    case "knowledge_entry": return `knowledge:${item.knowledge_id}`;
    case "change_record": return `change:${item.change_key}`;
    case "version_record": return `version:${item.branch_name}:${item.snapshot_version}`;
  }
}

function mergeUnique(current: readonly Item[], incoming: readonly Item[]): Item[] {
  const values = new Map(current.map((item) => [itemIdentity(item), item]));
  for (const item of incoming) if (!values.has(itemIdentity(item))) values.set(itemIdentity(item), item);
  return [...values.values()];
}

function formatTime(value: string, lang: Lang): string {
  return new Date(value).toLocaleString(lang === "zh" ? "zh-CN" : "en-US");
}

const MACHINE_COPY: Record<Lang, Record<string, string>> = {
  zh: {
    config: "配置", rule: "规则", architecture_map: "架构事实", architecture_constraint: "架构约束", instruction: "指令",
    candidate: "候选", active: "生效", stale: "待更新", deprecated: "已弃用", superseded: "已取代", conflicted: "有冲突",
    absent: "未归档", uploading: "上传中", stored: "已保存", failed: "失败",
    not_scheduled: "未调度", queued: "排队中", extracting: "提取中", ready: "就绪"
  },
  en: {
    config: "Configuration", rule: "Rule", architecture_map: "Architecture facts", architecture_constraint: "Architecture constraint", instruction: "Instruction",
    candidate: "Candidate", active: "Active", stale: "Stale", deprecated: "Deprecated", superseded: "Superseded", conflicted: "Conflicted",
    absent: "Not archived", uploading: "Uploading", stored: "Stored", failed: "Failed",
    not_scheduled: "Not scheduled", queued: "Queued", extracting: "Extracting", ready: "Ready"
  }
};

function machineLabel(value: string, lang: Lang): string {
  return MACHINE_COPY[lang][value] ?? (lang === "zh" ? "未知状态" : "Unknown status");
}

interface PanelProps { api: HunterApi; projectId: string; lang: Lang }

function InformationPanel({ api, projectId, lang, view, title, renderItem, emptyTechnical, onDetail, onDetailStart, onDetailReset, onDetailError }: PanelProps & {
  view: View; title: string; renderItem(item: Item, select: (id: string) => void): React.ReactNode; emptyTechnical?: { label: string; value: string };
  onDetail?: (detail: PlatformInformationDetailResponse) => void;
  onDetailStart?: () => void;
  onDetailReset?: () => void;
  onDetailError?: () => void;
}) {
  const c = COPY[lang];
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [pageState, setPageState] = useState<PlatformInformationPage["page_state"] | "loading" | "error">("loading");
  const [failures, setFailures] = useState<PlatformInformationPage["failures"]>([]);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PlatformInformationDetailResponse | null>(null);
  const [detailError, setDetailError] = useState<unknown>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [paginationError, setPaginationError] = useState<unknown>(null);
  const [bounded, setBounded] = useState(false);
  const itemsRef = useRef<Item[]>([]);
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const mounted = useRef(true);
  const loadMoreBusy = useRef(false);
  const seenCursors = useRef(new Set<string>());
  const loadedPages = useRef(0);
  const cursorRef = useRef<string | null>(null);
  const paginationStopped = useRef(false);
  const panelOnDetail = useRef(onDetail);
  panelOnDetail.current = onDetail;
  const detailCallbacks = useRef({ start: onDetailStart, reset: onDetailReset, error: onDetailError });
  detailCallbacks.current = { start: onDetailStart, reset: onDetailReset, error: onDetailError };
  itemsRef.current = items;

  const load = useCallback(async (nextCursor: string | null, append: boolean) => {
    if (api.listPlatformInformation === undefined) { setPageState("processing"); return; }
    if (append && (nextCursor === null || nextCursor.length === 0 || loadMoreBusy.current || paginationStopped.current || nextCursor !== cursorRef.current)) return;
    if (append) { loadMoreBusy.current = true; setLoadingMore(true); setPaginationError(null); }
    if (!append) {
      seenCursors.current = new Set();
      loadedPages.current = 0;
      cursorRef.current = null;
      paginationStopped.current = false;
      setBounded(false);
    }
    const generation = append ? listGeneration.current : ++listGeneration.current;
    if (!append) setPageState("loading");
    try {
      const value = await api.listPlatformInformation(projectId, view, { limit: INFORMATION_PAGE_LIMIT, cursor: nextCursor });
      if (!mounted.current || generation !== listGeneration.current) return;
      loadedPages.current += 1;
      const merged = append ? mergeUnique(itemsRef.current, value.items) : mergeUnique([], value.items);
      const boundedItems = merged.slice(0, INFORMATION_MAX_ITEMS);
      const returnedCursor = value.next_cursor;
      const malformedCursor = returnedCursor !== null && returnedCursor.trim().length === 0;
      const nonProgress = returnedCursor !== null &&
        (returnedCursor === nextCursor || seenCursors.current.has(returnedCursor));
      const reachedLimit = returnedCursor !== null &&
        (boundedItems.length >= INFORMATION_MAX_ITEMS || loadedPages.current >= INFORMATION_MAX_PAGES);
      itemsRef.current = boundedItems;
      setItems(boundedItems);
      if (malformedCursor) {
        cursorRef.current = null; paginationStopped.current = true;
        setCursor(null); setPaginationError(new Error("PLATFORM_INFORMATION_CURSOR_INVALID"));
      } else if (nonProgress) {
        cursorRef.current = null; paginationStopped.current = true;
        setCursor(null); setPaginationError(new Error("PLATFORM_INFORMATION_CURSOR_NON_PROGRESS"));
      } else if (reachedLimit) {
        cursorRef.current = null; paginationStopped.current = true;
        setCursor(null); setPaginationError(null); setBounded(true);
      } else {
        if (returnedCursor !== null) seenCursors.current.add(returnedCursor);
        cursorRef.current = returnedCursor;
        setCursor(returnedCursor);
      }
      setFailures(value.failures);
      setPageState(append && boundedItems.length > 0 && ["empty", "failed", "processing"].includes(value.page_state)
        ? "partial_failure"
        : value.page_state);
      setError(null);
    } catch (reason) {
      if (!mounted.current || generation !== listGeneration.current) return;
      if (append) setPaginationError(reason);
      else { setError(reason); setPageState(reason instanceof ApiClientError && reason.status === 403 ? "forbidden" : "error"); }
    } finally {
      if (append && generation === listGeneration.current && mounted.current) { loadMoreBusy.current = false; setLoadingMore(false); }
    }
  }, [api, projectId, view]);

  useEffect(() => {
    mounted.current = true; listGeneration.current += 1; detailGeneration.current += 1;
    loadMoreBusy.current = false; seenCursors.current = new Set();
    loadedPages.current = 0; itemsRef.current = []; cursorRef.current = null; paginationStopped.current = false;
    setItems([]); setCursor(null); setSelectedId(null); setDetail(null); setDetailError(null);
    setDetailLoading(false); setLoadingMore(false); setPaginationError(null); setBounded(false);
    detailCallbacks.current.reset?.();
    void load(null, false);
    return () => { listGeneration.current += 1; detailGeneration.current += 1; loadMoreBusy.current = false; };
  }, [load]);
  useEffect(() => () => { mounted.current = false; listGeneration.current += 1; detailGeneration.current += 1; }, []);

  async function select(id: string): Promise<void> {
    const generation = ++detailGeneration.current;
    detailCallbacks.current.start?.();
    setSelectedId(id); setDetail(null); setDetailError(null); setDetailLoading(false);
    if (api.getPlatformInformationDetail === undefined) { setDetailError(new Error("detail unavailable")); return; }
    setDetailLoading(true);
    try {
      const value = await api.getPlatformInformationDetail(projectId, view, id);
      if (!mounted.current || generation !== detailGeneration.current) return;
      setDetail(value);
      // Notify composed panels from the exact request already rendered here.
      panelOnDetail.current?.(value);
    } catch (reason) {
      if (mounted.current && generation === detailGeneration.current) { setDetailError(reason); detailCallbacks.current.error?.(); }
    }
    finally { if (mounted.current && generation === detailGeneration.current) setDetailLoading(false); }
  }

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle === "" ? items : items.filter((item) => JSON.stringify(item).toLocaleLowerCase().includes(needle));
  }, [items, query]);
  const stateDetails = failures.map((failure) => ({ label: "Code", value: failure.reason_code }));

  if (pageState === "loading") return <WorkspaceState technicalDetailsLabel={c.technical} state={{ kind: "loading", label: `${c.loading} ${title}` }} />;
  if (pageState === "processing") return <WorkspaceState technicalDetailsLabel={c.technical} state={{ kind: "processing", title: c.processing, description: c.processingHint }} />;
  if (pageState === "forbidden") return <WorkspaceState technicalDetailsLabel={c.technical} state={{ kind: "forbidden", title: c.forbidden, description: c.forbiddenHint, technicalDetails: stateDetails.length ? stateDetails : technical(error) }} />;
  if (pageState === "error") return <div className="information-terminal-state"><WorkspaceState technicalDetailsLabel={c.technical} state={{ kind: "error", title: c.error, description: c.errorHint, technicalDetails: technical(error) }} /><button type="button" onClick={() => void load(null, false)}>{c.retry}</button></div>;
  if (pageState === "failed") return <div className="information-terminal-state"><WorkspaceState technicalDetailsLabel={c.technical} state={{ kind: "error", title: c.failed, description: c.failedHint, technicalDetails: [...stateDetails, { label: "Code", value: "KNOWLEDGE_RETRY_IDENTITY_UNAVAILABLE" }] }} /><button type="button" disabled>{c.retryExtraction}</button></div>;
  if (pageState === "empty") return <WorkspaceState technicalDetailsLabel={c.technical} state={{ kind: "empty", title: c.empty, description: c.emptyHint, ...(emptyTechnical ? { technicalDetails: [emptyTechnical] } : {}) }} />;

  const content = <div className="information-panel-grid">
    <section className="information-list" aria-label={title}>
      <WorkspaceFilterBar label={c.filter} placeholder={c.filterPlaceholder} query={query} onQueryChange={setQuery} />
      <div className="information-list-items">{filtered.map((item) => <div key={itemIdentity(item)}>{renderItem(item, (id) => void select(id))}</div>)}</div>
      {bounded ? <p className="information-list-bounded" role="status">{c.bounded}</p> : null}
      {cursor !== null && paginationError === null ? <button className="information-load-more" type="button" disabled={loadingMore} onClick={() => void load(cursor, true)}>{c.loadMore}</button> : null}
    </section>
    <aside className="information-detail" aria-live="polite">
      {detailLoading ? <WorkspaceState technicalDetailsLabel={c.technical} state={{ kind: "loading", label: c.detailLoading }} /> : null}
      {!detailLoading && detail !== null ? <DetailView detail={detail} lang={lang} /> : null}
      {!detailLoading && detailError !== null ? <WorkspaceState technicalDetailsLabel={c.technical} state={{ kind: "error", title: c.error, description: c.errorHint, technicalDetails: technical(detailError) }} /> : null}
      {!detailLoading && selectedId === null ? <p className="information-detail-placeholder">{c.choose}</p> : null}
    </aside>
  </div>;
  if (pageState === "partial_failure") return <WorkspaceState technicalDetailsLabel={c.technical} state={{ kind: "partialFailure", title: c.partial, description: c.partialHint, technicalDetails: stateDetails }}>{content}</WorkspaceState>;
  return paginationError === null ? content : <div className="information-pagination-failure"><WorkspaceState technicalDetailsLabel={c.technical} state={{ kind: "error", title: c.error, description: c.paginationFailure, technicalDetails: technical(paginationError) }} />{cursor === null ? null : <button type="button" onClick={() => void load(cursor, true)}>{c.retryMore}</button>}{content}</div>;
}

function DetailView({ detail, lang }: { detail: PlatformInformationDetailResponse; lang: Lang }) {
  const c = COPY[lang];
  if (detail.detail.detail_kind === "change_record") return <div className="information-detail-stack">
    <h3>{c.documents}</h3>
    {[...new Set(detail.detail.document_refs)].map((id) => <code key={id}>{id}</code>)}
    <p>{c.candidates}: {detail.detail.candidate_refs.length}</p>
    {detail.detail.archive_download_ref ? <><h3>{c.archive}</h3><code>{detail.detail.archive_download_ref.archive_id}</code><code>{detail.detail.archive_download_ref.package_hash}</code><p>{c.unavailableDownload}</p><code>ARCHIVE_AUTHENTICATED_DOWNLOAD_CLIENT_UNAVAILABLE</code></> : null}
  </div>;
  if (detail.detail.detail_kind === "version_diff") return <div className="information-detail-stack"><h3>{detail.detail.from_version} → {detail.detail.to_version}</h3>{[...new Set(detail.detail.changed_paths)].map((path) => <code key={path}>{path}</code>)}</div>;
  if (detail.detail.detail_kind === "branch_monitor") return <div className="information-detail-stack">{[...new Set(detail.detail.event_refs)].map((id) => <code key={id}>{id}</code>)}</div>;
  return <div className="information-detail-stack"><div className="information-detail-meta"><code>{detail.detail.media_type}</code><code>{detail.detail.content_hash}</code></div><pre>{detail.detail.content}</pre></div>;
}

function itemButton(id: string, label: string, action: string, children: React.ReactNode, select: (id: string) => void) {
  return <button type="button" className="information-list-card" aria-label={`${action} ${label}`} onClick={() => select(id)}>{children}</button>;
}

export function ProjectMaterialsInformationPanel(props: PanelProps) {
  const c = COPY[props.lang];
  return <InformationPanel {...props} view="project_materials" title={c.materials} renderItem={(raw, select) => {
    if (raw.item_kind !== "project_material") return null;
    return itemButton(raw.material_id, raw.path, c.open, <><span className="information-kicker">{machineLabel(raw.category, props.lang)}</span><strong>{raw.path}</strong><span>{c.source}: {raw.source_branch_name} · {raw.source_commit_sha.slice(0, 8)}</span></>, select);
  }} />;
}

export function ProjectKnowledgeInformationPanel(props: PanelProps) {
  const c = COPY[props.lang];
  return <InformationPanel {...props} view="project_knowledge" title={c.knowledge} renderItem={(raw, select) => {
    if (raw.item_kind !== "knowledge_entry") return null;
    return itemButton(raw.knowledge_id, raw.display_title, c.open, <><span className="information-kicker">{machineLabel(raw.lifecycle_status, props.lang)}</span><strong>{raw.display_title}</strong><span>{raw.source_change_key} · {raw.relationship_count} {c.relations}</span><time>{formatTime(raw.extracted_at, props.lang)}</time></>, select);
  }} />;
}

export function ChangeRecordsInformationPanel(props: PanelProps) {
  const c = COPY[props.lang];
  const [record, setRecord] = useState<PlatformInformationDetailResponse | null>(null);
  const [document, setDocument] = useState<PlatformInformationDetailResponse | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [documentError, setDocumentError] = useState<unknown>(null);
  const documentGeneration = useRef(0);
  function clearRecordAndDocument(): void {
    documentGeneration.current += 1;
    setRecord(null); setDocument(null); setDocumentId(null); setDocumentLoading(false); setDocumentError(null);
  }
  useEffect(() => {
    documentGeneration.current += 1;
    setRecord(null); setDocument(null); setDocumentId(null); setDocumentLoading(false); setDocumentError(null);
    return () => { documentGeneration.current += 1; };
  }, [props.api, props.projectId]);
  async function selectDocument(id: string): Promise<void> {
    const generation = ++documentGeneration.current;
    setDocumentId(id); setDocument(null); setDocumentError(null); setDocumentLoading(false);
    if (props.api.getPlatformInformationDetail === undefined) {
      setDocumentError(new Error("CHANGE_DOCUMENT_DETAIL_UNSUPPORTED"));
      return;
    }
    setDocumentLoading(true);
    try {
      const value = await props.api.getPlatformInformationDetail(props.projectId, "change_records", id);
      if (generation === documentGeneration.current) setDocument(value);
    } catch (reason) {
      if (generation === documentGeneration.current) setDocumentError(reason);
    } finally {
      if (generation === documentGeneration.current) setDocumentLoading(false);
    }
  }
  return <div className="information-change-wrapper"><InformationPanel {...props} view="change_records" title={c.changes} onDetail={setRecord} onDetailStart={clearRecordAndDocument} onDetailReset={clearRecordAndDocument} onDetailError={clearRecordAndDocument} renderItem={(raw, select) => {
    if (raw.item_kind !== "change_record") return null;
    return itemButton(raw.change_key, raw.title, c.open, <><span className="information-kicker">{machineLabel(raw.archive_status, props.lang)} · {machineLabel(raw.knowledge_extraction_status, props.lang)}</span><strong>{raw.title}</strong><code>{raw.change_key}</code><time>{formatTime(raw.archived_at, props.lang)}</time></>, select);
  }} />{record?.detail.detail_kind === "change_record" ? <nav className="information-document-nav" aria-label={c.documents}>{[...new Set(record.detail.document_refs)].map((id) => <button key={id} type="button" onClick={() => void selectDocument(id)}>{`${c.open} ${c.document} ${id}`}</button>)}</nav> : null}
  {documentLoading ? <WorkspaceState technicalDetailsLabel={c.technical} state={{ kind: "loading", label: c.documentLoading }} /> : null}
  {!documentLoading && document !== null ? <DetailView detail={document} lang={props.lang} /> : null}
  {!documentLoading && documentError !== null ? <div className="information-terminal-state"><WorkspaceState technicalDetailsLabel={c.technical} state={{ kind: "error", title: c.error, description: documentError instanceof Error && documentError.message === "CHANGE_DOCUMENT_DETAIL_UNSUPPORTED" ? c.documentUnsupported : c.documentFailure, technicalDetails: technical(documentError) }} />{documentId === null || documentError instanceof Error && documentError.message === "CHANGE_DOCUMENT_DETAIL_UNSUPPORTED" ? null : <button type="button" onClick={() => void selectDocument(documentId)}>{c.retry}</button>}</div> : null}</div>;
}

export function BranchFilesInformationPanel(props: PanelProps) {
  const c = COPY[props.lang];
  return <InformationPanel {...props} view="branch_files" title={c.branchFiles} emptyTechnical={{ label: "Code", value: "BRANCH_FILE_LOCATOR_ROUTE_UNAVAILABLE" }} renderItem={(raw) => {
    if (raw.item_kind !== "branch_snapshot") return null;
    return <article className="information-list-card static"><span className="information-kicker">{raw.snapshot_version}</span><strong>{raw.branch_name}</strong><code>{raw.commit_sha.slice(0, 8)}</code><span>{raw.file_count} {c.files} · {raw.changed_file_count} {c.changed}</span><time>{formatTime(raw.uploaded_at, props.lang)}</time><p>{c.unavailableFiles}</p><code>BRANCH_FILE_LOCATOR_ROUTE_UNAVAILABLE</code></article>;
  }} />;
}

export function VersionRecordsInformationPanel(props: PanelProps) {
  const c = COPY[props.lang];
  return <InformationPanel {...props} view="version_records" title={c.versions} renderItem={(raw) => {
    if (raw.item_kind !== "version_record") return null;
    return <article className="information-list-card static"><span className="information-kicker">{raw.branch_name}</span><strong>{raw.snapshot_version}</strong><code>{raw.diff_ref}</code><span>{raw.file_count} {c.files} · {raw.changed_file_count} {c.changed}</span><time>{formatTime(raw.uploaded_at, props.lang)}</time><p>{c.unavailableDiff}</p><code>VERSION_DIFF_LOCATOR_ROUTE_UNAVAILABLE</code></article>;
  }} />;
}
