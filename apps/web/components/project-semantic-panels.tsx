"use client";

import type { SemanticDocument, SemanticEdge, SemanticOverview } from "@hunter-harness/contracts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { HunterApi, ProjectSemanticGraph } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { runPreservingWindowScroll, suppressMouseFocusScroll } from "../lib/preserve-scroll";
import { MarkdownDocument } from "./skill-shared";
import { ToastFeedback } from "./ui/Toast";

type SemanticTab = "library" | "rules" | "architecture" | "changes" | "relations";

interface SemanticData {
  overview: SemanticOverview;
  knowledge: SemanticDocument[];
  rules: SemanticDocument[] | null;
  architecture: SemanticDocument[] | null;
  changes: SemanticDocument[] | null;
}

interface SemanticChangePage {
  items: SemanticDocument[];
  total: number;
  next_cursor: string | null;
}

const PAGE_SIZE = 25;

function exportContextPack(projectId: string, data: SemanticData): void {
  const rules = data.rules ?? [];
  const architecture = data.architecture ?? [];
  const changes = data.changes ?? [];
  const lines = [
    "# 项目上下文", "", `已整理文档：${data.overview.counts.documents}`, "",
    "## Knowledge", ...data.knowledge.flatMap((item) => [`### ${item.title}`, item.body, ""]),
    "## Rules", ...rules.flatMap((item) => [`### ${item.title}`, item.body, ""]),
    "## Architecture", ...architecture.flatMap((item) => [`### ${item.title}`, item.body, ""]),
    "## Changes", ...changes.flatMap((item) => [`### ${item.title}`, item.body, ""])
  ];
  const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `context-pack-${projectId}.md`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function humanKind(document: SemanticDocument, lang: "zh" | "en"): string {
  const labels = lang === "zh" ? {
    knowledge_entry: "知识条目", knowledge_markdown: "知识文档", rule: "项目规则",
    change_document: "变更文档", architecture_document: "架构地图",
    archive_record: "变更总结", agent_instruction: "Agent 指令"
  } : {
    knowledge_entry: "Knowledge entry", knowledge_markdown: "Knowledge document", rule: "Project rule",
    change_document: "Change document", architecture_document: "Architecture map",
    archive_record: "Change summary", agent_instruction: "Agent instruction"
  };
  return labels[document.kind];
}

function readableArchiveBody(document: SemanticDocument): string {
  if (document.kind !== "archive_record" || !document.body.trimStart().startsWith("{")) {
    return document.body;
  }
  try {
    const raw = JSON.parse(document.body) as Record<string, unknown>;
    const verification = typeof raw.verification === "object" && raw.verification !== null
      ? raw.verification as Record<string, unknown>
      : {};
    const gitFacts = typeof raw.gitFacts === "object" && raw.gitFacts !== null
      ? raw.gitFacts as Record<string, unknown>
      : {};
    const risks = Array.isArray(raw.knownRisks) ? raw.knownRisks.map(String) : [];
    const status = String(raw.finalStatus ?? raw.status ?? "未知");
    return [
      `# ${String(raw.businessGoal ?? raw.changeName ?? document.title)}`,
      "",
      "## 变更结果",
      "",
      `- 状态：${status}`,
      `- 变更文件：${String(gitFacts.filesChanged ?? "未知")}`,
      `- 新增 / 删除：${String(gitFacts.insertions ?? "未知")} / ${String(gitFacts.deletions ?? "未知")}`,
      "",
      "## 验证结果",
      "",
      ...Object.entries(verification).map(([key, value]) =>
        `- ${key}：${typeof value === "object" && value !== null ? String((value as Record<string, unknown>).status ?? "已记录") : String(value)}`
      ),
      "",
      "## 需要注意",
      "",
      ...(risks.length > 0 ? risks.map((risk) => `- ${risk}`) : ["- 无已知风险"])
    ].join("\n");
  } catch {
    return document.body;
  }
}

function documentStatus(document: SemanticDocument, lang: "zh" | "en", statusLabels: Record<string, string>): string {
  const status = document.metadata.status;
  if (typeof status === "string" && status.trim() !== "") {
    return statusLabels[status] ?? statusLabels[status.replaceAll("_", "-")] ?? status.replaceAll("_", " ");
  }
  return lang === "zh" ? "有效" : "Active";
}

function DocumentBrowser({
  items, selectedId, onSelect, empty, emptyHint, lang, enableStatusFilter = false, statusLabels
}: {
  items: SemanticDocument[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  empty: string;
  emptyHint?: string;
  lang: "zh" | "en";
  enableStatusFilter?: boolean;
  statusLabels: Record<string, string>;
}) {
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState("all");
  // Only auto-jump the pager when selection identity changes. Re-running on
  // `filtered` identity churn (same selection, new array) races manual Next/Prev
  // and was flaking Ubuntu CI after "下一页".
  const lastJumpedSelectedId = useRef<string | null>(selectedId);

  const statuses = useMemo(() => {
    if (!enableStatusFilter) return [] as string[];
    const values = new Set<string>();
    for (const item of items) {
      const status = item.metadata.status;
      if (typeof status === "string" && status.trim() !== "") values.add(status);
    }
    return [...values].sort((left, right) => left.localeCompare(right));
  }, [items, enableStatusFilter]);

  const showStatusFilters = statuses.length > 1;

  const filtered = useMemo(() => {
    if (!showStatusFilters || statusFilter === "all") return items;
    return items.filter((item) => String(item.metadata.status ?? "") === statusFilter);
  }, [items, showStatusFilters, statusFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageItems = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const selected = filtered.find((item) => item.document_id === selectedId)
    ?? items.find((item) => item.document_id === selectedId)
    ?? pageItems[0]
    ?? null;

  useLayoutEffect(() => {
    setPage(0);
  }, [items]);

  useEffect(() => {
    if (!showStatusFilters && statusFilter !== "all") setStatusFilter("all");
  }, [showStatusFilters, statusFilter]);

  useEffect(() => {
    if (selectedId === null) {
      lastJumpedSelectedId.current = null;
      return;
    }
    if (filtered.length === 0) return;
    const index = filtered.findIndex((item) => item.document_id === selectedId);
    if (index < 0) return;
    if (lastJumpedSelectedId.current === selectedId) return;
    lastJumpedSelectedId.current = selectedId;
    const nextPage = Math.floor(index / PAGE_SIZE);
    setPage((current) => (current === nextPage ? current : nextPage));
  }, [selectedId, filtered]);

  if (items.length === 0) return <div className="knowledge-empty"><span>◇</span><p>{empty}</p>{emptyHint === undefined ? null : <small>{emptyHint}</small>}</div>;

  const copy = lang === "zh" ? {
    all: "全部状态",
    page: (current: number, total: number, count: number) => `第 ${current}/${total} 页 · ${count} 条`,
    prev: "上一页",
    next: "下一页",
    emptyFilter: "当前筛选下没有条目。"
  } : {
    all: "All statuses",
    page: (current: number, total: number, count: number) => `Page ${current}/${total} · ${count} items`,
    prev: "Previous",
    next: "Next",
    emptyFilter: "No items match this filter."
  };

  return <div className="knowledge-browser">
    <div className="knowledge-list-pane">
      {showStatusFilters ? <div className="knowledge-status-filters" role="toolbar" aria-label={lang === "zh" ? "按状态筛选" : "Filter by status"}>
          <button type="button" className={statusFilter === "all" ? "selected" : ""} onMouseDown={suppressMouseFocusScroll} onClick={() => { setStatusFilter("all"); setPage(0); }}>{copy.all}</button>
          {statuses.map((status) => <button key={status} type="button" className={statusFilter === status ? "selected" : ""} onMouseDown={suppressMouseFocusScroll} onClick={() => { setStatusFilter(status); setPage(0); }}>{statusLabels[status] ?? statusLabels[status.replaceAll("_", "-")] ?? status.replaceAll("_", " ")}</button>)}
        </div> : null}
      <div className="knowledge-list">
        {pageItems.length === 0 ? <div className="knowledge-empty compact"><p>{copy.emptyFilter}</p></div> : pageItems.map((item) => <button key={item.document_id} type="button" className={item.document_id === selected?.document_id ? "selected" : ""} onMouseDown={suppressMouseFocusScroll} onClick={() => onSelect(item.document_id)}>
          <span className="knowledge-kind-icon">{item.kind === "rule" ? "R" : item.kind === "archive_record" ? "V" : "K"}</span>
          <span><strong>{item.title}</strong><small>{humanKind(item, lang)} · {documentStatus(item, lang, statusLabels)}</small></span>
          <i>›</i>
        </button>)}
      </div>
      <div className="knowledge-pager">
        <span>{copy.page(safePage + 1, pageCount, filtered.length)}</span>
        <div>
          <button type="button" className="text-button" disabled={safePage <= 0} onMouseDown={suppressMouseFocusScroll} onClick={() => setPage((current) => Math.max(0, current - 1))}>{copy.prev}</button>
          <button type="button" className="text-button" disabled={safePage >= pageCount - 1} onMouseDown={suppressMouseFocusScroll} onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}>{copy.next}</button>
        </div>
      </div>
    </div>
    <article className="knowledge-preview">
      {selected === null ? <div className="knowledge-empty"><span>◇</span><p>{empty}</p></div> : <>
        <header><div><span>{humanKind(selected, lang)}</span><h2>{selected.title}</h2></div><p className="knowledge-source-path" title={selected.source_path}>{lang === "zh" ? "来源" : "Source"} · <code>{selected.source_path}</code></p></header>
        <div className="knowledge-body"><MarkdownDocument content={readableArchiveBody(selected)} /></div>
        <footer>{Object.entries(selected.metadata).filter(([, value]) => typeof value === "string" || Array.isArray(value)).slice(0, 5).map(([key, value]) => <span key={key}>{key}: {Array.isArray(value) ? value.join(", ") : (statusLabels[String(value)] ?? String(value))}</span>)}</footer>
      </>}
    </article>
  </div>;
}

function archiveKeyOf(document: SemanticDocument): string {
  if (typeof document.metadata.source_archive === "string" && document.metadata.source_archive !== "") {
    return document.metadata.source_archive;
  }
  return /^\.harness\/archive\/([^/]+)\//u.exec(document.source_path)?.[1] ?? document.title;
}

function archiveHeading(document: SemanticDocument): string {
  return readableArchiveBody(document).match(/^#\s+(.+)$/mu)?.[1]?.trim() ?? document.title;
}

function ChangeHistoryPanel({
  items,
  selectedId,
  onSelect,
  lang,
  total,
  hasMore,
  loadingMore,
  onLoadMore
}: {
  items: SemanticDocument[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  lang: "zh" | "en";
  total: number;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const groups = useMemo(() => {
    const grouped = new Map<string, SemanticDocument[]>();
    for (const item of items) {
      const key = archiveKeyOf(item);
      grouped.set(key, [...(grouped.get(key) ?? []), item]);
    }
    return [...grouped.entries()].map(([key, documents]) => {
      const summary = documents.find((item) => item.kind === "archive_record") ?? null;
      const uploadedAt = typeof summary?.metadata.archive_uploaded_at === "string"
        ? summary.metadata.archive_uploaded_at
        : "";
      return { key, documents, summary, uploadedAt };
    }).sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt) || left.key.localeCompare(right.key));
  }, [items]);
  const selectedGroup = groups.find((group) =>
    group.documents.some((item) => item.document_id === selectedId)
  ) ?? groups[0] ?? null;
  const selectedDocument = selectedGroup?.documents.find((item) => item.document_id === selectedId)
    ?? selectedGroup?.summary
    ?? selectedGroup?.documents[0]
    ?? null;
  const copy = lang === "zh" ? {
    empty: "还没有变更记录。",
    records: "历史变更",
    summary: "变更总结",
    spec: "设计说明",
    plan: "实施计划",
    archiveMeta: "归档说明",
    attachment: "相关文档",
    remoteReady: "远端归档已保存",
    remotePending: "归档状态待确认",
    knowledgeReady: "知识索引已就绪",
    knowledgePending: "知识索引处理中",
    knowledgeFailed: "知识索引失败",
    files: (count: number) => `${count} 个文件`,
    lines: (additions: number, deletions: number) => `+${additions} / -${deletions} 行`,
    goal: "本次目标",
    loaded: (count: number, all: number) => `已加载 ${count} / ${all} 份文档`,
    loadMore: "加载更多变更"
  } : {
    empty: "No change history yet.",
    records: "Change history",
    summary: "Summary",
    spec: "Design",
    plan: "Plan",
    archiveMeta: "Archive notes",
    attachment: "Related documents",
    remoteReady: "Remote archive saved",
    remotePending: "Archive status pending",
    knowledgeReady: "Knowledge index ready",
    knowledgePending: "Knowledge indexing",
    knowledgeFailed: "Knowledge indexing failed",
    files: (count: number) => `${count} files`,
    lines: (additions: number, deletions: number) => `+${additions} / -${deletions} lines`,
    goal: "Goal",
    loaded: (count: number, all: number) => `${count} of ${all} documents loaded`,
    loadMore: "Load more changes"
  };
  if (selectedGroup === null || selectedDocument === null) {
    return <div className="knowledge-empty"><span>◇</span><p>{copy.empty}</p></div>;
  }
  const summary = selectedGroup.summary;
  const metadata = summary?.metadata ?? {};
  const filesChanged = Number(metadata.files_changed ?? 0);
  const additions = Number(metadata.additions ?? 0);
  const deletions = Number(metadata.deletions ?? 0);
  const businessGoal = typeof metadata.business_goal === "string" ? metadata.business_goal : null;
  const archiveReady = metadata.archive_status === "durable";
  const knowledgeStatus = metadata.knowledge_status;
  const knowledgeLabel = knowledgeStatus === "ready"
    ? copy.knowledgeReady
    : knowledgeStatus === "failed"
      ? copy.knowledgeFailed
      : copy.knowledgePending;
  const roleLabel = (document: SemanticDocument): string => {
    if (document.kind === "archive_record") return copy.summary;
    if (document.metadata.archive_role === "spec") return copy.spec;
    if (document.metadata.archive_role === "plan") return copy.plan;
    if (document.metadata.archive_role === "archive_meta") return copy.archiveMeta;
    return copy.attachment;
  };
  const orderedDocuments = [...selectedGroup.documents].sort((left, right) => {
    if (left.kind === "archive_record") return -1;
    if (right.kind === "archive_record") return 1;
    return left.source_path.localeCompare(right.source_path);
  });

  return <div className="change-history-workbench">
    <aside className="change-history-list">
      <header><strong>{copy.records}</strong><span>{copy.loaded(items.length, total)}</span></header>
      <div>
        {groups.map((group) => {
          const groupSummary = group.summary ?? group.documents[0];
          if (groupSummary === undefined) return null;
          const active = group.key === selectedGroup.key;
          return <button
            key={group.key}
            type="button"
            className={active ? "selected" : ""}
            onMouseDown={suppressMouseFocusScroll}
            onClick={() => onSelect(groupSummary.document_id)}
          >
            <strong>{archiveHeading(groupSummary)}</strong>
            <small>{group.key}</small>
            <span>{group.documents.length} {lang === "zh" ? "份文档" : "documents"}</span>
          </button>;
        })}
        {hasMore ? <button
          type="button"
          className="change-history-load-more"
          disabled={loadingMore}
          onClick={onLoadMore}
        >{loadingMore ? (lang === "zh" ? "正在加载…" : "Loading…") : copy.loadMore}</button> : null}
      </div>
    </aside>
    <article className="change-history-detail">
      <header className="change-history-summary">
        <div className="change-history-state">
          <span className={archiveReady ? "success" : "neutral"}>{archiveReady ? copy.remoteReady : copy.remotePending}</span>
          <span className={knowledgeStatus === "failed" ? "danger" : knowledgeStatus === "ready" ? "success" : "warning"}>{knowledgeLabel}</span>
        </div>
        <div className="change-history-metrics">
          <span><strong>{copy.files(filesChanged)}</strong><small>{copy.lines(additions, deletions)}</small></span>
          <span><strong>{String(metadata.final_status ?? "—")}</strong><small>{lang === "zh" ? "归档结果" : "Archive result"}</small></span>
        </div>
        {businessGoal === null ? null : <p><span>{copy.goal}</span>{businessGoal}</p>}
      </header>
      <nav className="change-document-tabs" aria-label={copy.attachment}>
        {orderedDocuments.map((document) => <button
          key={document.document_id}
          type="button"
          className={document.document_id === selectedDocument.document_id ? "selected" : ""}
          onMouseDown={suppressMouseFocusScroll}
          onClick={() => onSelect(document.document_id)}
        >
          <span>{roleLabel(document)}</span>
          <strong>{document.title}</strong>
        </button>)}
      </nav>
      <section className="change-document-preview">
        <MarkdownDocument content={readableArchiveBody(selectedDocument)} />
      </section>
    </article>
  </div>;
}

function ArchitecturePanel({
  items,
  selectedId,
  onSelect,
  lang,
  statusLabels
}: {
  items: SemanticDocument[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  lang: "zh" | "en";
  statusLabels: Record<string, string>;
}) {
  const manifest = items.find((item) => item.metadata.map_role === "manifest") ?? null;
  const documents = items.filter((item) => item.metadata.map_role !== "manifest");
  const generatedAt = typeof manifest?.metadata.generated_at === "string"
    ? manifest.metadata.generated_at
    : null;
  const mappedCommit = typeof manifest?.metadata.last_mapped_commit === "string"
    ? manifest.metadata.last_mapped_commit
    : null;
  const warnings = Array.isArray(manifest?.metadata.warnings)
    ? manifest.metadata.warnings.map(String)
    : [];
  const generatedTime = generatedAt === null
    ? (lang === "zh" ? "尚未记录" : "Not recorded")
    : new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(generatedAt));
  const copy = lang === "zh" ? {
    snapshot: "架构快照",
    docs: "地图文档",
    generated: "最近生成",
    commit: "对应版本",
    health: "地图状态",
    healthy: "内容完整",
    warning: `${warnings.length} 条生成提示`,
    empty: "还没有项目架构地图。",
    hint: "运行 /harness-codebase-map 后，平台会展示技术栈、模块结构、集成、约定、测试与风险。"
  } : {
    snapshot: "Architecture snapshot",
    docs: "Map documents",
    generated: "Generated",
    commit: "Mapped commit",
    health: "Map status",
    healthy: "Complete",
    warning: `${warnings.length} generation warnings`,
    empty: "No architecture map yet.",
    hint: "Run /harness-codebase-map to publish stack, structure, integrations, conventions, testing, and risks."
  };
  if (items.length === 0) {
    return <div className="knowledge-empty"><span>◇</span><p>{copy.empty}</p><small>{copy.hint}</small></div>;
  }
  return <div className="architecture-workbench">
    <section className="architecture-snapshot" aria-label={copy.snapshot}>
      <div><span>{copy.docs}</span><strong>{documents.length}</strong></div>
      <div><span>{copy.generated}</span><strong>{generatedTime}</strong></div>
      <div><span>{copy.commit}</span><strong>{mappedCommit?.slice(0, 12) ?? "—"}</strong></div>
      <div className={warnings.length > 0 ? "warning" : "success"}>
        <span>{copy.health}</span><strong>{warnings.length > 0 ? copy.warning : copy.healthy}</strong>
      </div>
    </section>
    {warnings.length > 0 ? <details className="architecture-warnings"><summary>{copy.warning}</summary><ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details> : null}
    <DocumentBrowser
      items={documents}
      selectedId={selectedId}
      onSelect={onSelect}
      empty={copy.empty}
      emptyHint={copy.hint}
      lang={lang}
      statusLabels={statusLabels}
    />
  </div>;
}

function edgeKindLabel(kind: SemanticEdge["kind"], lang: "zh" | "en"): string {
  const zh: Record<SemanticEdge["kind"], string> = {
    references_path: "引用",
    supersedes: "取代",
    conflicts_with: "冲突",
    shared_scope: "共享源码",
    related_archive: "关联变更",
    tag_cooccurrence: "共享标签"
  };
  return lang === "zh" ? zh[kind] : kind.replaceAll("_", " ");
}

function RelationWorkbench({
  graph,
  candidates,
  selectedId,
  onSelect,
  lang
}: {
  graph: ProjectSemanticGraph;
  candidates: SemanticDocument[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  lang: "zh" | "en";
}) {
  const [focusQuery, setFocusQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | SemanticEdge["kind"]>("all");
  const [neighbourPage, setNeighbourPage] = useState(1);
  const NEIGHBOUR_PAGE_SIZE = 12;

  const copy = lang === "zh" ? {
    focus: "当前中心",
    focusSearch: "搜索条目，切换探索中心",
    focusHint: "同一时间只有一个中心。这里只展示与它直接相连的关系（一跳），不会一次展开全库。",
    health: (indexed: number, edges: number, neighbours: number) =>
      `索引 ${indexed} · 与中心直接相关 ${neighbours} 条` + (edges !== neighbours ? `（接口返回 ${edges} 条）` : ""),
    emptyTitle: "暂未发现可展示的知识关系",
    emptyBody: (indexed: number) =>
      `已索引 ${indexed} 份文档。系统不会把孤立节点画成装饰圆环；当知识声明取代、冲突、共享源码或引用后，选一个中心条目即可查看它的直接关系。`,
    neighbourhood: "直接关系",
    ego: "邻域示意",
    egoMore: (hidden: number) => `示意最多 12 个邻居；另有 ${hidden} 个请看左侧列表。`,
    allKinds: "全部类型",
    noMatch: "当前筛选下没有直接关系。",
    setFocus: "设为中心",
    outbound: "指出",
    inbound: "指入",
    noFocus: "请选择一个中心条目。",
    page: (current: number, total: number, count: number) => `第 ${current}/${total} 页 · ${count} 条`
  } : {
    focus: "Current center",
    focusSearch: "Search to change the exploration center",
    focusHint: "Only one center at a time. This view shows direct (one-hop) relations around it — never the whole library at once.",
    health: (indexed: number, edges: number, neighbours: number) =>
      `${indexed} indexed · ${neighbours} direct relations` + (edges !== neighbours ? ` (${edges} from API)` : ""),
    emptyTitle: "No useful knowledge relationships yet",
    emptyBody: (indexed: number) =>
      `${indexed} documents are indexed. Isolated nodes are not drawn as decoration; pick a center document to inspect its declared supersedes, conflicts, shared-source, and references.`,
    neighbourhood: "Direct relations",
    ego: "Neighbourhood sketch",
    egoMore: (hidden: number) => `Sketch shows up to 12 neighbours; ${hidden} more are in the list.`,
    allKinds: "All types",
    noMatch: "No direct relations match this filter.",
    setFocus: "Make center",
    outbound: "Out",
    inbound: "In",
    noFocus: "Choose a center document.",
    page: (current: number, total: number, count: number) => `Page ${current}/${total} · ${count}`
  };

  const focus = useMemo(() => {
    const focusId = graph.focus_document_id ?? selectedId;
    return graph.nodes.find((node) => node.document_id === focusId)
      ?? candidates.find((node) => node.document_id === focusId)
      ?? graph.nodes[0]
      ?? candidates[0]
      ?? null;
  }, [graph, selectedId, candidates]);

  useLayoutEffect(() => {
    setNeighbourPage(1);
    setKindFilter("all");
  }, [focus?.document_id]);

  const filteredCandidates = useMemo(() => {
    const needle = focusQuery.trim().toLowerCase();
    const limit = needle === "" ? 12 : 24;
    const pool = needle === ""
      ? candidates
      : candidates.filter((item) =>
        item.title.toLowerCase().includes(needle)
        || item.source_path.toLowerCase().includes(needle)
      );
    const focusId = focus?.document_id;
    const ordered = focusId === undefined
      ? pool
      : [
        ...pool.filter((item) => item.document_id === focusId),
        ...pool.filter((item) => item.document_id !== focusId)
      ];
    return ordered.slice(0, limit);
  }, [candidates, focusQuery, focus]);

  const presentKinds = useMemo(() => {
    const kinds = new Set<SemanticEdge["kind"]>();
    for (const edge of graph.edges) kinds.add(edge.kind);
    return [...kinds].sort((left, right) => left.localeCompare(right));
  }, [graph.edges]);

  const neighbourhood = useMemo(() => {
    if (focus === null) return [];
    return graph.edges
      .filter((edge) =>
        edge.from_document_id === focus.document_id || edge.to_document_id === focus.document_id
      )
      .filter((edge) => kindFilter === "all" || edge.kind === kindFilter)
      .map((edge) => {
        const outbound = edge.from_document_id === focus.document_id;
        const otherId = outbound ? edge.to_document_id : edge.from_document_id;
        const other = graph.nodes.find((node) => node.document_id === otherId)
          ?? candidates.find((node) => node.document_id === otherId)
          ?? null;
        return { edge, outbound, other };
      })
      .sort((left, right) => {
        const kindCmp = left.edge.kind.localeCompare(right.edge.kind);
        if (kindCmp !== 0) return kindCmp;
        return (left.other?.title ?? "").localeCompare(right.other?.title ?? "");
      });
  }, [graph, focus, kindFilter, candidates]);

  const neighbourPages = Math.max(1, Math.ceil(neighbourhood.length / NEIGHBOUR_PAGE_SIZE));
  const pagedNeighbourhood = neighbourhood.slice(
    (neighbourPage - 1) * NEIGHBOUR_PAGE_SIZE,
    neighbourPage * NEIGHBOUR_PAGE_SIZE
  );

  const grouped = useMemo(() => {
    const map = new Map<SemanticEdge["kind"], typeof neighbourhood>();
    for (const item of pagedNeighbourhood) {
      const list = map.get(item.edge.kind) ?? [];
      list.push(item);
      map.set(item.edge.kind, list);
    }
    return [...map.entries()];
  }, [pagedNeighbourhood]);

  const width = 520;
  const height = 360;
  const egoOthers = useMemo(() => {
    const byId = new Map<string, (typeof neighbourhood)[number]>();
    for (const item of neighbourhood) {
      if (item.other === null) continue;
      byId.set(item.other.document_id, item);
    }
    return [...byId.values()];
  }, [neighbourhood]);
  const egoVisible = egoOthers.slice(0, 12);
  const egoHidden = Math.max(0, egoOthers.length - egoVisible.length);

  const egoPoints = useMemo(() => {
    const result = new Map<string, { x: number; y: number; label: string }>();
    if (focus === null) return result;
    result.set(focus.document_id, { x: width / 2, y: height / 2, label: focus.title });
    egoVisible.forEach((item, index) => {
      if (item.other === null) return;
      const angle = (Math.PI * 2 * index) / Math.max(1, egoVisible.length) - Math.PI / 2;
      result.set(item.other.document_id, {
        x: width / 2 + Math.cos(angle) * 140,
        y: height / 2 + Math.sin(angle) * 120,
        label: item.other.title
      });
    });
    return result;
  }, [focus, egoVisible]);

  const focusChrome = <>
    <div className="relation-toolbar">
      <label className="relation-focus-search">
        <span>{copy.focus}</span>
        <input
          aria-label={copy.focusSearch}
          placeholder={copy.focusSearch}
          value={focusQuery}
          onChange={(event) => setFocusQuery(event.target.value)}
        />
      </label>
      <p className="relation-health">{copy.health(graph.indexed_documents, graph.edges.length, neighbourhood.length)}</p>
    </div>
    <p className="relation-focus-hint">{copy.focusHint}</p>
    {focus !== null ? <div className="relation-center-chip">
      <span>{copy.focus}</span>
      <strong>{focus.title}</strong>
      <small>{focus.source_path}</small>
    </div> : null}
  </>;

  if (graph.relation_status === "no_relations" || graph.edges.length === 0) {
    return <div className="relation-workbench">
      {focusChrome}
      <div className="relation-empty">
        <div className="relation-empty-visual"><span /><span /><span /></div>
        <h2>{copy.emptyTitle}</h2>
        <p>{copy.emptyBody(graph.indexed_documents)}</p>
      </div>
      {filteredCandidates.length > 0 ? <div className="relation-focus-candidates" role="listbox" aria-label={copy.focus}>
        {filteredCandidates.map((item) => <button
          key={item.document_id}
          type="button"
          role="option"
          aria-selected={item.document_id === focus?.document_id}
          className={item.document_id === focus?.document_id ? "selected" : ""}
          onMouseDown={suppressMouseFocusScroll}
          onClick={() => runPreservingWindowScroll(() => onSelect(item.document_id))}
        >
          <strong>{item.title}</strong>
          <small>{item.source_path}</small>
        </button>)}
      </div> : null}
    </div>;
  }

  if (focus === null) {
    return <div className="relation-workbench"><p className="project-empty-copy">{copy.noFocus}</p></div>;
  }

  return <div className="relation-workbench">
    {focusChrome}
    <div className="relation-focus-candidates" role="listbox" aria-label={copy.focus}>
      {filteredCandidates.map((item) => <button
        key={item.document_id}
        type="button"
        role="option"
        aria-selected={item.document_id === focus.document_id}
        className={item.document_id === focus.document_id ? "selected" : ""}
        onMouseDown={suppressMouseFocusScroll}
        onClick={() => runPreservingWindowScroll(() => onSelect(item.document_id))}
      >
        <strong>{item.title}</strong>
        <small>{item.source_path}</small>
      </button>)}
    </div>
    <div className="relation-layout">
      <section className="relation-neighbourhood">
        <header>
          <h3>{copy.neighbourhood}</h3>
          {presentKinds.length > 1 ? <div className="relation-kind-filters" role="toolbar" aria-label={lang === "zh" ? "按关系类型筛选" : "Filter by relation kind"}>
            <button type="button" className={kindFilter === "all" ? "selected" : ""} onMouseDown={suppressMouseFocusScroll} onClick={() => { setKindFilter("all"); setNeighbourPage(1); }}>{copy.allKinds}</button>
            {presentKinds.map((kind) => <button
              key={kind}
              type="button"
              className={kindFilter === kind ? "selected" : ""}
              onMouseDown={suppressMouseFocusScroll}
              onClick={() => { setKindFilter(kind); setNeighbourPage(1); }}
            >{edgeKindLabel(kind, lang)}</button>)}
          </div> : null}
        </header>
        {grouped.length === 0 ? <p className="project-empty-copy">{copy.noMatch}</p> : <>
          {grouped.map(([kind, items]) => <div key={kind} className="relation-group">
            <h4>{edgeKindLabel(kind, lang)} · {items.length}</h4>
            <ul>
              {items.map(({ edge, outbound, other }) => <li key={edge.edge_id}>
                <span className="relation-direction">{outbound ? copy.outbound : copy.inbound}</span>
                <div>
                  <strong>{other?.title ?? "—"}</strong>
                  <small>{other?.source_path ?? edge.edge_id}</small>
                </div>
                {other === null ? null : <button type="button" className="text-button" onMouseDown={suppressMouseFocusScroll} onClick={() => runPreservingWindowScroll(() => onSelect(other.document_id))}>{copy.setFocus}</button>}
              </li>)}
            </ul>
          </div>)}
          {neighbourPages > 1 ? <div className="relation-pager">
            <span>{copy.page(neighbourPage, neighbourPages, neighbourhood.length)}</span>
            <div>
              <button type="button" className="text-button" disabled={neighbourPage <= 1} onMouseDown={suppressMouseFocusScroll} onClick={() => setNeighbourPage((page) => page - 1)}>{lang === "zh" ? "上一页" : "Prev"}</button>
              <button type="button" className="text-button" disabled={neighbourPage >= neighbourPages} onMouseDown={suppressMouseFocusScroll} onClick={() => setNeighbourPage((page) => page + 1)}>{lang === "zh" ? "下一页" : "Next"}</button>
            </div>
          </div> : null}
        </>}
      </section>
      <aside className="relation-ego" aria-label={copy.ego}>
        <h3>{copy.ego}</h3>
        <svg className="relation-map" viewBox={`0 0 ${width} ${height}`} role="img">
          <defs>
            <marker id="relation-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
            </marker>
          </defs>
          {egoVisible.map(({ edge, other }) => {
            if (other === null) return null;
            const from = egoPoints.get(edge.from_document_id);
            const to = egoPoints.get(edge.to_document_id);
            if (from === undefined || to === undefined) return null;
            const midX = (from.x + to.x) / 2;
            const midY = (from.y + to.y) / 2;
            return <g key={`edge-${edge.edge_id}`}>
              <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} markerEnd="url(#relation-arrow)" />
              <text className="relation-edge-label" x={midX} y={midY - 6} textAnchor="middle">{edgeKindLabel(edge.kind, lang)}</text>
            </g>;
          })}
          {[...egoPoints.entries()].map(([id, point]) => {
            const isFocus = id === focus.document_id;
            const radius = isFocus ? 34 : 22;
            const maxChars = isFocus ? 22 : 16;
            const title = point.label.length > maxChars ? `${point.label.slice(0, maxChars)}…` : point.label;
            return <g
              key={id}
              className={isFocus ? "focus" : ""}
              transform={`translate(${point.x}, ${point.y})`}
              onClick={() => runPreservingWindowScroll(() => onSelect(id))}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") runPreservingWindowScroll(() => onSelect(id)); }}
              role="button"
              tabIndex={0}
            >
              <circle r={radius} />
              <title>{point.label}</title>
              <text className="relation-node-initial" textAnchor="middle" dy="4">{point.label.slice(0, 1)}</text>
              <text className="relation-node-label" textAnchor="middle" y={radius + 13}>{title}</text>
            </g>;
          })}
        </svg>
        <p className="relation-ego-caption"><strong>{focus.title}</strong></p>
        {egoHidden > 0 ? <p className="relation-ego-more">{copy.egoMore(egoHidden)}</p> : null}
      </aside>
    </div>
  </div>;
}

export function ProjectSemanticPanels({ api, projectId }: { api: HunterApi; projectId: string }) {
  const { lang, t } = useI18n();
  const statusLabels = t.status as Record<string, string>;
  const [tab, setTab] = useState<SemanticTab>("library");
  const [data, setData] = useState<SemanticData | null>(null);
  const [graph, setGraph] = useState<ProjectSemanticGraph | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<SemanticDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [changesCursor, setChangesCursor] = useState<string | null>(null);
  const [changesTotal, setChangesTotal] = useState(0);
  const [changesLoadingMore, setChangesLoadingMore] = useState(false);
  const rulesRequest = useRef<{ projectId: string; promise: Promise<SemanticDocument[]> } | null>(null);
  const architectureRequest = useRef<{ projectId: string; promise: Promise<SemanticDocument[]> } | null>(null);
  const changesRequest = useRef<{ projectId: string; promise: Promise<SemanticChangePage> } | null>(null);

  const copy = lang === "zh" ? {
    title: "项目知识", subtitle: "集中查看经过整理的知识、规则、架构地图与历史变更。", library: "知识库", rules: "项目规则", architecture: "项目架构", changes: "变更记录", relations: "知识关系",
    search: "搜索标题、正文或路径", export: "导出上下文", preparingExport: "正在准备…", noKnowledge: "还没有知识条目", noRules: "还没有项目规则。", noChanges: "还没有变更记录。",
    loading: "正在加载项目内容…", loadingGraph: "正在更新关系…", failed: "项目内容暂不可用。", documents: "已整理文档", knowledge: "知识条目", edges: "知识关系",
    pending: "还有 {n} 条知识正在由服务端整理，内容可能暂时不完整。", emptyPushHint: "知识库只展示明确提交到知识入库流程的内容；设计、计划和架构地图会分别展示。"
  } : {
    title: "Project knowledge", subtitle: "Curated knowledge, rules, architecture maps, and change history.", library: "Knowledge library", rules: "Project rules", architecture: "Architecture", changes: "Change history", relations: "Relationship explorer",
    search: "Search titles, content, or paths", export: "Export context", preparingExport: "Preparing…", noKnowledge: "No project knowledge yet. Sources: push file index and knowledge ingest projection.", noRules: "No project rules yet.", noChanges: "No change summaries yet.",
    loading: "Loading project knowledge…", loadingGraph: "Updating relations…", failed: "Project knowledge is unavailable.", documents: "Indexed documents", knowledge: "Knowledge", edges: "Relationships",
    pending: "{n} ingest entries pending projection — the semantic library may be incomplete.", emptyPushHint: "If empty: CLI push first, or wait for ingest projection; after purge/DB swap, push again."
  };

  useEffect(() => {
    let active = true;
    setError(null);
    setHits(null);
    setQuery("");
    setSelectedId(null);
    setGraph(null);
    setData(null);
    setPendingCount(0);
    setChangesCursor(null);
    setChangesTotal(0);
    void (async () => {
      if (api.getProjectSemanticOverview === undefined || api.listProjectSemanticKnowledge === undefined) throw new Error("semantic API unavailable");
      const pendingRequest = api.getKnowledgeProjectionStatus === undefined
        ? Promise.resolve(0)
        : api.getKnowledgeProjectionStatus(projectId).then((status) => status.pending_count).catch(() => 0);
      const [overview, knowledgePage, pending] = await Promise.all([
        api.getProjectSemanticOverview(projectId), api.listProjectSemanticKnowledge(projectId, { includeBody: true }),
        pendingRequest
      ]);
      const knowledge = knowledgePage.items;
      if (!active) return;
      setData({ overview, knowledge, rules: null, architecture: null, changes: null });
      setPendingCount(pending);
      setSelectedId(knowledge[0]?.document_id ?? null);
    })().catch(() => { if (active) setError(copy.failed); });
    return () => { active = false; };
  }, [api, projectId, copy.failed]);

  const requestRules = useCallback((): Promise<SemanticDocument[]> => {
    if (api.listProjectSemanticRules === undefined) return Promise.reject(new Error("semantic rules API unavailable"));
    if (rulesRequest.current?.projectId === projectId) return rulesRequest.current.promise;
    const promise = api.listProjectSemanticRules(projectId).catch((reason: unknown) => {
      if (rulesRequest.current?.promise === promise) rulesRequest.current = null;
      throw reason;
    });
    rulesRequest.current = { projectId, promise };
    return promise;
  }, [api, projectId]);

  const requestChanges = useCallback((): Promise<SemanticChangePage> => {
    if (api.listProjectSemanticChanges === undefined) return Promise.reject(new Error("semantic changes API unavailable"));
    if (changesRequest.current?.projectId === projectId) return changesRequest.current.promise;
    const promise = api.listProjectSemanticChanges(projectId, { limit: 50 }).catch((reason: unknown) => {
      if (changesRequest.current?.promise === promise) changesRequest.current = null;
      throw reason;
    });
    changesRequest.current = { projectId, promise };
    return promise;
  }, [api, projectId]);

  const requestArchitecture = useCallback((): Promise<SemanticDocument[]> => {
    if (api.listProjectSemanticArchitecture === undefined) return Promise.reject(new Error("semantic architecture API unavailable"));
    if (architectureRequest.current?.projectId === projectId) return architectureRequest.current.promise;
    const promise = api.listProjectSemanticArchitecture(projectId).catch((reason: unknown) => {
      if (architectureRequest.current?.promise === promise) architectureRequest.current = null;
      throw reason;
    });
    architectureRequest.current = { projectId, promise };
    return promise;
  }, [api, projectId]);

  useEffect(() => {
    if (data === null || data.rules !== null || (tab !== "rules" && tab !== "relations")) return;
    let active = true;
    void requestRules()
      .then((rules) => { if (active) setData((current) => current === null ? current : { ...current, rules }); })
      .catch(() => { if (active) setError(copy.failed); });
    return () => { active = false; };
  }, [data, tab, requestRules, copy.failed]);

  useEffect(() => {
    if (data === null || data.architecture !== null || (tab !== "architecture" && tab !== "relations")) return;
    let active = true;
    void requestArchitecture()
      .then((architecture) => { if (active) setData((current) => current === null ? current : { ...current, architecture }); })
      .catch(() => { if (active) setError(copy.failed); });
    return () => { active = false; };
  }, [data, tab, requestArchitecture, copy.failed]);

  useEffect(() => {
    if (data === null || data.changes !== null || (tab !== "changes" && tab !== "relations")) return;
    let active = true;
    void requestChanges()
      .then((page) => {
        if (!active) return;
        setData((current) => current === null ? current : { ...current, changes: page.items });
        setChangesCursor(page.next_cursor);
        setChangesTotal(page.total);
      })
      .catch(() => { if (active) setError(copy.failed); });
    return () => { active = false; };
  }, [data, tab, requestChanges, copy.failed]);

  useEffect(() => {
    if (tab !== "relations" || api.getProjectSemanticGraph === undefined) return;
    let active = true;
    setGraphLoading(true);
    void api.getProjectSemanticGraph(projectId, selectedId ?? undefined)
      .then((result) => { if (active) setGraph(result); })
      .catch(() => { if (active) setError(copy.failed); })
      .finally(() => { if (active) setGraphLoading(false); });
    return () => { active = false; };
  }, [api, projectId, selectedId, tab, copy.failed]);

  function switchTab(id: SemanticTab): void {
    runPreservingWindowScroll(() => {
      setTab(id);
      setHits(null);
    });
  }

  function selectDocument(id: string): void {
    runPreservingWindowScroll(() => setSelectedId(id));
  }

  async function search(): Promise<void> {
    if (query.trim() === "") { setHits(null); return; }
    setSearching(true);
    try {
      const results = await api.searchSemanticDocuments?.(query.trim(), projectId) ?? [];
      setHits(results.map((item) => item.document));
      setSelectedId(results[0]?.document.document_id ?? null);
    } finally {
      setSearching(false);
    }
  }

  async function loadMoreChanges(): Promise<void> {
    if (changesCursor === null || changesLoadingMore || api.listProjectSemanticChanges === undefined) return;
    setChangesLoadingMore(true);
    try {
      const page = await api.listProjectSemanticChanges(projectId, {
        limit: 50,
        cursor: changesCursor
      });
      setData((current) => current === null ? current : {
        ...current,
        changes: [...(current.changes ?? []), ...page.items]
      });
      setChangesCursor(page.next_cursor);
      setChangesTotal(page.total);
    } catch {
      setError(copy.failed);
    } finally {
      setChangesLoadingMore(false);
    }
  }

  async function requestAllChanges(): Promise<SemanticChangePage> {
    if (api.listProjectSemanticChanges === undefined) throw new Error("semantic changes API unavailable");
    const first = await requestChanges();
    const items = [...first.items];
    const seenCursors = new Set<string>();
    let cursor = first.next_cursor;
    let total = first.total;
    while (cursor !== null) {
      if (seenCursors.has(cursor)) throw new Error("semantic changes cursor repeated");
      seenCursors.add(cursor);
      const page = await api.listProjectSemanticChanges(projectId, { limit: 200, cursor });
      items.push(...page.items);
      total = page.total;
      cursor = page.next_cursor;
    }
    return { items, total, next_cursor: cursor };
  }

  async function exportAll(): Promise<void> {
    if (data === null || exporting) return;
    setExporting(true);
    setError(null);
    try {
      const [rules, architecture, changePage] = await Promise.all([
        data.rules === null ? requestRules() : Promise.resolve(data.rules),
        data.architecture === null ? requestArchitecture() : Promise.resolve(data.architecture),
        requestAllChanges()
      ]);
      const changes = changePage.items;
      const complete = { ...data, rules, architecture, changes };
      setData(complete);
      setChangesCursor(changePage.next_cursor);
      setChangesTotal(changePage.total);
      exportContextPack(projectId, complete);
    } catch {
      setError(copy.failed);
    } finally {
      setExporting(false);
    }
  }

  if (error !== null && data === null) return <div className="empty-state">{error}</div>;
  if (data === null) return <div className="empty-state">{copy.loading}</div>;
  const items = tab === "rules" ? data.rules ?? [] : tab === "architecture" ? data.architecture ?? [] : tab === "changes" ? data.changes ?? [] : hits ?? data.knowledge;
  const documentsLoading = (tab === "rules" && data.rules === null) || (tab === "architecture" && data.architecture === null) || (tab === "changes" && data.changes === null);
  const emptyCopy = tab === "rules"
    ? copy.noRules
    : tab === "architecture"
      ? (lang === "zh" ? "还没有项目架构地图。" : "No architecture map yet.")
      : tab === "changes"
      ? copy.noChanges
      : copy.noKnowledge;

  return <section className="project-knowledge-v2">
    <header className="knowledge-header"><div><p className="eyebrow">{copy.title}</p><h2>{copy.subtitle}</h2></div><button type="button" className="secondary" disabled={exporting} onClick={() => void exportAll()}>⇩ {exporting ? copy.preparingExport : copy.export}</button></header>
    <div className="knowledge-metrics"><span><strong>{data.overview.counts.documents}</strong>{copy.documents}</span><span><strong>{data.overview.counts.knowledge}</strong>{copy.knowledge}</span><span><strong>{data.overview.counts.edges}</strong>{copy.edges}</span></div>
    {pendingCount > 0 ? <p className="notice warning" role="status">{copy.pending.replace("{n}", String(pendingCount))}</p> : null}
    <div className="knowledge-controls">
      <div className="knowledge-tabs" role="tablist" aria-label={copy.title}>{(["library", "rules", "architecture", "changes", "relations"] as const).map((id) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "selected" : ""} onMouseDown={suppressMouseFocusScroll} onClick={() => switchTab(id)}>{copy[id]}</button>)}</div>
      {tab === "library" ? <div className="knowledge-search"><span>⌕</span><input aria-label={copy.search} placeholder={copy.search} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void search(); }} /><button type="button" disabled={searching} onClick={() => void search()}>{lang === "zh" ? "搜索" : "Search"}</button></div> : null}
    </div>
    {tab === "relations" ? graph === null ? <div className="empty-state">{copy.loading}</div> : <div className={graphLoading ? "relation-panel refreshing" : "relation-panel"}>
      {graphLoading ? <p className="relation-refresh-hint" aria-live="polite">{copy.loadingGraph}</p> : null}
      <RelationWorkbench
        graph={graph}
        candidates={[...data.knowledge, ...(data.rules ?? []), ...(data.architecture ?? []), ...(data.changes ?? [])]}
        selectedId={selectedId}
        onSelect={selectDocument}
        lang={lang}
      />
    </div> : documentsLoading ? <div className="empty-state">{copy.loading}</div> : tab === "architecture" ? <ArchitecturePanel items={items} selectedId={selectedId} onSelect={selectDocument} lang={lang} statusLabels={statusLabels} /> : tab === "changes" ? <ChangeHistoryPanel items={items} selectedId={selectedId} onSelect={selectDocument} lang={lang} total={changesTotal} hasMore={changesCursor !== null} loadingMore={changesLoadingMore} onLoadMore={() => void loadMoreChanges()} /> : <DocumentBrowser items={items} selectedId={selectedId} onSelect={selectDocument} empty={emptyCopy} {...(tab === "library" && data.knowledge.length === 0 ? { emptyHint: copy.emptyPushHint } : {})} lang={lang} enableStatusFilter={tab === "library"} statusLabels={statusLabels} />}
    {data === null ? null : <ToastFeedback tone="danger" message={error} />}
  </section>;
}
