"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { browserApi, type HunterApi, type ProjectSummary } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { mockApi } from "../lib/mock-api";
import {
  formatProjectDateTime,
  paginateProjects,
  PROJECT_LIST_PAGE_SIZE,
  projectMatchesQuery,
  sortProjectsByUpdatedDesc
} from "../lib/project-list";
import { suppressMouseFocusScroll } from "../lib/preserve-scroll";
import { apiError } from "./skill-shared";
import { EmptyState } from "./ui/EmptyState";
import { Icon } from "./ui/icons";
import { Modal } from "./ui/Modal";
import { Pagination } from "./ui/Pagination";
import { Skeleton } from "./ui/Skeleton";
import { ToastFeedback } from "./ui/Toast";

function resolveApi(): HunterApi {
  return process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true" ? mockApi : browserApi();
}

export function ProjectRegistry({ api: propApi }: { api?: HunterApi }) {
  const { t, lang } = useI18n();
  const api = useMemo(() => propApi ?? resolveApi(), [propApi]);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [archived, setArchived] = useState<ProjectSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"active" | "trash">("active");
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<{
    kind: "archive" | "restore" | "purge" | "empty";
    project?: ProjectSummary;
  } | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createdProject, setCreatedProject] = useState<ProjectSummary | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(false);
  busyRef.current = busy;

  const copy = lang === "zh" ? {
    eyebrow: "项目工作区", title: "项目", description: "集中查看项目文件、知识状态与版本记录。",
    active: "当前项目", trash: "回收站", search: "搜索项目", searchPlaceholder: "按名称或 ID 搜索",
    files: "受管文件", versioned: "已有版本", recentlyUpdated: "近 7 天更新",
    firstSync: "等待首次同步", fileUnit: "个文件", updated: "更新于",
    archive: "移到回收站", restore: "恢复", purge: "永久删除", emptyTrash: "清空回收站",
    noProjects: "还没有项目。运行 npx hunter-harness 完成首次同步后会显示在这里。", noTrash: "回收站是空的。",
    noMatch: "没有符合搜索条件的项目。", trashHint: "项目会在回收站保留 30 天，到期后自动清理。",
    purgeAt: "自动清理", confirmArchive: "将此项目移到回收站？30 天内可以恢复。",
    confirmRestore: "恢复此项目？", confirmPurge: "永久删除后无法恢复，是否继续？",
    confirmEmpty: "永久删除回收站中的所有项目？此操作无法撤销。", confirm: "确认", cancel: "取消",
    prev: "上一页", next: "下一页", first: "第一页", last: "最后一页",
    pageInfo: "第 {page} / {total} 页", totalCount: "共 {count} 项",
    count: (n: number) => `${n} 个`,
    createProject: "新建项目", createTitle: "创建项目", nameLabel: "项目名称", namePlaceholder: "例如：支付网关改造",
    submitCreate: "创建", creating: "创建中…",
    createdTitle: "项目已创建",
    createdBody: "进入项目后，在「API 密钥」页签发密钥并执行 npx hunter-harness connect，即可开始首次同步。",
    openProject: "打开项目",
    createUnsupported: "服务端尚未支持 Web 端创建项目（端点落地中）。当前请先用 CLI：npx hunter-harness 首次同步会自动创建项目。"
  } : {
    eyebrow: "Project workspace", title: "Projects", description: "View project files, knowledge health, and version history in one place.",
    active: "Active projects", trash: "Recycle bin", search: "Search projects", searchPlaceholder: "Search by name or ID",
    files: "Managed files", versioned: "With versions", recentlyUpdated: "Updated in 7 days",
    firstSync: "Awaiting first sync", fileUnit: "files", updated: "Updated",
    archive: "Move to recycle bin", restore: "Restore", purge: "Delete permanently", emptyTrash: "Empty recycle bin",
    noProjects: "No projects yet. Run npx hunter-harness to complete the first sync.", noTrash: "The recycle bin is empty.",
    noMatch: "No projects match your search.", trashHint: "Projects remain in the recycle bin for 30 days, then are removed automatically.",
    purgeAt: "Auto removal", confirmArchive: "Move this project to the recycle bin? You can restore it for 30 days.",
    confirmRestore: "Restore this project?", confirmPurge: "Permanent deletion cannot be undone. Continue?",
    confirmEmpty: "Permanently delete every project in the recycle bin? This cannot be undone.", confirm: "Confirm", cancel: "Cancel",
    prev: "Previous", next: "Next", first: "First page", last: "Last page",
    pageInfo: "Page {page} / {total}", totalCount: "{count} total",
    count: (n: number) => `${n}`,
    createProject: "New project", createTitle: "Create project", nameLabel: "Project name", namePlaceholder: "e.g. Payments gateway overhaul",
    submitCreate: "Create", creating: "Creating…",
    createdTitle: "Project created",
    createdBody: "Open the project, issue an API key under “API keys”, then run npx hunter-harness connect to start the first sync.",
    openProject: "Open project",
    createUnsupported: "The server does not support web-side project creation yet (endpoint in progress). For now, run npx hunter-harness — the first sync creates the project automatically."
  };

  async function reload(): Promise<void> {
    const [activeItems, archivedItems] = await Promise.all([
      api.listProjects("active"), api.listProjects("archived")
    ]);
    setProjects(activeItems);
    setArchived(archivedItems);
  }

  async function submitCreate(): Promise<void> {
    const name = createName.trim();
    if (name === "" || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      if (api.createProject === undefined) throw new Error("unsupported");
      const project = await api.createProject({ display_name: name });
      setCreatedProject(project);
      await reload();
    } catch (reason) {
      const status = reason instanceof Error && "status" in reason ? (reason as { status: number }).status : 0;
      setCreateError(status === 404 || status === 405 || status === 501 || status === 0
        ? copy.createUnsupported
        : apiError(reason, t));
    } finally {
      setCreating(false);
    }
  }

  function closeCreate(): void {
    setShowCreate(false);
    setCreateName("");
    setCreateError(null);
    setCreatedProject(null);
  }

  useEffect(() => {
    let active = true;
    setError(null);
    void Promise.all([api.listProjects("active"), api.listProjects("archived")])
      .then(([items, trash]) => { if (active) { setProjects(items); setArchived(trash); } })
      .catch((reason: unknown) => { if (active) setError(apiError(reason, t)); });
    return () => { active = false; };
  }, [api, t]);

  useEffect(() => {
    setPage(0);
  }, [query, view]);

  useEffect(() => {
    if (pendingAction === null) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        if (busyRef.current) return;
        event.preventDefault();
        setPendingAction(null);
        return;
      }
      if (event.key !== "Tab" || dialogRef.current === null) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled])")];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [pendingAction]);

  if (error !== null && projects === null) return <div className="empty-state">{error}</div>;
  if (projects === null) {
    return (
      <section className="stack governance-page project-registry-v2" aria-busy="true">
        <div className="project-registry-metrics">
          <Skeleton variant="metric" />
          <Skeleton variant="metric" />
          <Skeleton variant="metric" />
        </div>
        <Skeleton variant="table" lines={6} />
      </section>
    );
  }

  const source = view === "active" ? projects : archived;
  const needle = query.trim().toLowerCase();
  const filtered = sortProjectsByUpdatedDesc(
    source.filter((project) => projectMatchesQuery(project, needle))
  );
  const { pageCount, safePage, pageItems } = paginateProjects(filtered, page, PROJECT_LIST_PAGE_SIZE);
  const withVersion = projects.filter((project) => project.latest_project_version !== null).length;
  const fileCount = projects.reduce((sum, project) => sum + (project.current_file_count ?? 0), 0);
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = projects.filter((project) => Date.parse(project.updated_at ?? project.created_at) >= weekAgo).length;

  async function executeAction(): Promise<void> {
    if (pendingAction === null) return;
    setBusy(true);
    try {
      if (pendingAction.kind === "archive" && pendingAction.project !== undefined) {
        await api.archiveProject?.(pendingAction.project.project_id);
      } else if (pendingAction.kind === "restore" && pendingAction.project !== undefined) {
        await api.restoreProject?.(pendingAction.project.project_id);
      } else if (pendingAction.kind === "purge" && pendingAction.project !== undefined) {
        await api.purgeProject?.(pendingAction.project.project_id);
      } else if (pendingAction.kind === "empty") {
        const results = await Promise.allSettled(
          archived.map((project) => api.purgeProject?.(project.project_id))
        );
        await reload();
        const failed = results.filter((result) => result.status === "rejected").length;
        if (failed > 0) throw new Error(`${failed} project(s) could not be permanently deleted.`);
        setPendingAction(null);
        return;
      }
      await reload();
      setPendingAction(null);
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setBusy(false);
    }
  }

  const confirmText = pendingAction?.kind === "archive" ? copy.confirmArchive
    : pendingAction?.kind === "restore" ? copy.confirmRestore
      : pendingAction?.kind === "empty" ? copy.confirmEmpty : copy.confirmPurge;

  return <section className="stack governance-page project-registry-v2">
    <header className="project-registry-hero">
      <div><p className="eyebrow">{copy.eyebrow}</p><h1>{copy.title}</h1><p>{copy.description}</p></div>
      <div className="project-hero-actions">
        <button type="button" className="primary-button" onClick={() => setShowCreate(true)}>
          <Icon name="plus" size={14} /> {copy.createProject}
        </button>
        <div className="project-view-switch" role="tablist" aria-label={copy.title}>
          <button type="button" role="tab" aria-selected={view === "active"} className={view === "active" ? "selected" : ""} onMouseDown={suppressMouseFocusScroll} onClick={() => setView("active")}>{copy.active}<span>{projects.length}</span></button>
          <button type="button" role="tab" aria-selected={view === "trash"} className={view === "trash" ? "selected" : ""} onMouseDown={suppressMouseFocusScroll} onClick={() => setView("trash")}>{copy.trash}<span>{archived.length}</span></button>
        </div>
      </div>
    </header>

    {view === "active" ? <div className="project-registry-metrics rise-in">
      <article><span><Icon name="layers" size={18} /></span><div><strong>{fileCount}</strong><small>{copy.files}</small></div></article>
      <article><span><Icon name="tag" size={18} /></span><div><strong>{withVersion}</strong><small>{copy.versioned}</small></div></article>
      <article><span><Icon name="clock" size={18} /></span><div><strong>{recent}</strong><small>{copy.recentlyUpdated}</small></div></article>
    </div> : <div className="project-trash-banner"><span><Icon name="trash" size={18} /></span><div><strong>{copy.trashHint}</strong><p>{archived.length}</p></div>{archived.length > 0 ? <button type="button" className="danger secondary" onClick={() => setPendingAction({ kind: "empty" })}>{copy.emptyTrash}</button> : null}</div>}

    <div className="project-registry-toolbar">
      <label><span><Icon name="search" size={14} /></span><input aria-label={copy.search} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={copy.searchPlaceholder} /></label>
      <span>{copy.count(filtered.length)}</span>
    </div>

    <div className="project-card-list">
      {filtered.length === 0 ? (
        <EmptyState
          icon={view === "trash" ? "trash" : "folder"}
          title={needle !== "" ? copy.noMatch : view === "active" ? copy.noProjects : copy.noTrash}
        />
      ) : pageItems.map((project) => {
        const version = project.latest_project_version;
        const hasVersion = version !== null && version !== "";
        return <article key={project.project_id} className="project-list-card">
          {view === "active" ? <Link href={`/projects/${project.project_id}`} className="project-list-link" aria-label={project.display_name} /> : null}
          <div className="project-avatar" aria-hidden="true">{project.display_name.slice(0, 1).toUpperCase()}</div>
          <div className="project-list-main">
            <div>
              <h2>{project.display_name}</h2>
              <span className={hasVersion ? "synced" : "waiting"}>{hasVersion ? version : copy.firstSync}</span>
            </div>
            <p>{project.current_file_count ?? 0} {copy.fileUnit} · {copy.updated} {formatProjectDateTime(project.updated_at ?? project.created_at, lang)}</p>
          </div>
          <div className="project-list-actions">
            {view === "active" ? <button type="button" className="secondary danger" onClick={() => setPendingAction({ kind: "archive", project })}>{copy.archive}</button> : <><button type="button" onClick={() => setPendingAction({ kind: "restore", project })}>{copy.restore}</button><button type="button" className="secondary danger" onClick={() => setPendingAction({ kind: "purge", project })}>{copy.purge}</button></>}
            {view === "trash" && project.purge_after !== null && project.purge_after !== undefined ? <small>{copy.purgeAt} {formatProjectDateTime(project.purge_after, lang)}</small> : null}
          </div>
        </article>;
      })}
      {filtered.length === 0 || pageCount <= 1 ? null : (
        <Pagination
          page={safePage + 1}
          totalPages={pageCount}
          total={filtered.length}
          onChange={(next) => setPage(next - 1)}
          labels={{
            first: copy.first,
            prev: copy.prev,
            next: copy.next,
            last: copy.last,
            pageInfo: copy.pageInfo,
            totalCount: copy.totalCount
          }}
        />
      )}
    </div>

    {projects === null ? null : <ToastFeedback tone="danger" message={error} />}

    <Modal
      open={showCreate}
      onClose={closeCreate}
      title={createdProject === null ? copy.createTitle : copy.createdTitle}
      closeLabel={copy.cancel}
      footer={createdProject === null ? (
        <>
          <button type="button" className="secondary" disabled={creating} onClick={closeCreate}>{copy.cancel}</button>
          <button type="button" disabled={creating || createName.trim() === ""} onClick={() => void submitCreate()}>
            {creating ? copy.creating : copy.submitCreate}
          </button>
        </>
      ) : undefined}
    >
      {createdProject === null ? (
        <div className="form-stack">
          <label className="form-field">
            <span className="form-label">{copy.nameLabel}</span>
            <input
              value={createName}
              placeholder={copy.namePlaceholder}
              disabled={creating}
              onChange={(event) => setCreateName(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void submitCreate(); }}
            />
          </label>
          {createError === null ? null : <p className="notice warning">{createError}</p>}
        </div>
      ) : (
        <div className="form-stack">
          <p className="notice success">{copy.createdTitle}：{createdProject.display_name}</p>
          <p className="lede">{copy.createdBody}</p>
          <div className="actions">
            <Link href={`/projects/${createdProject.project_id}`} onClick={closeCreate}>
              {copy.openProject} →
            </Link>
          </div>
        </div>
      )}
    </Modal>

    {pendingAction === null ? null : <div
      className="project-confirm-backdrop"
      role="presentation"
      onClick={() => { if (!busy) setPendingAction(null); }}
    >
      <section
        ref={dialogRef}
        className="project-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-confirm-title"
        aria-describedby="project-confirm-desc"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="project-confirm-icon" aria-hidden="true"><Icon name="warning" size={20} /></div>
        <h2 id="project-confirm-title">{pendingAction.project?.display_name ?? copy.emptyTrash}</h2>
        <p id="project-confirm-desc">{confirmText}</p>
        <div className="actions">
          <button type="button" className={pendingAction.kind === "purge" || pendingAction.kind === "empty" ? "danger" : ""} disabled={busy} onClick={() => void executeAction()}>{copy.confirm}</button>
          <button ref={cancelRef} type="button" className="secondary" disabled={busy} onClick={() => setPendingAction(null)}>{copy.cancel}</button>
        </div>
      </section>
    </div>}
  </section>;
}
