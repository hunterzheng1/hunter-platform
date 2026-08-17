"use client";

import type { SemanticOverview } from "@hunter-harness/contracts";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  ApiClientError,
  type ArtifactSummary,
  type HunterApi,
  type ProjectDetailModel,
  type ProjectFileMetadata
} from "../lib/api";
import { classifyManagedFile, isProposalEditable } from "../lib/file-policy";
import { ProjectApiKeysPanel } from "./project-api-keys";
import {
  BranchFilesInformationPanel,
  ChangeRecordsInformationPanel,
  ProjectKnowledgeInformationPanel,
  ProjectMaterialsInformationPanel,
  VersionRecordsInformationPanel
} from "./project-information-panels";
import { useI18n } from "../lib/i18n";
import { runPreservingWindowScroll } from "../lib/preserve-scroll";
import { ProjectSemanticPanels } from "./project-semantic-panels";
import { ProjectVersionsPanel } from "./project-versions-panel";
import { RunsMonitor } from "./runs-monitor";
import {
  ProjectWorkspaceShell,
  WorkspaceFilterBar,
  WorkspaceState,
  type ProjectWorkspaceSection
} from "./project-workspace-shell";
import { Icon } from "./ui/icons";
import { ToastFeedback, useToast } from "./ui/Toast";

interface WorkspaceData {
  project: ProjectDetailModel;
  artifacts: ArtifactSummary[];
  files: ProjectFileMetadata[];
  overview: SemanticOverview | null;
  branchProjectionAvailable: boolean;
}

interface ProjectFileContentCacheEntry {
  project_id: string;
  project_version: string;
  content_sha256: string;
  content: string;
}

function contentCacheMatches(entry: ProjectFileContentCacheEntry | undefined, file: ProjectFileMetadata, projectId: string): boolean {
  return entry?.project_id === projectId &&
    entry.project_version === file.project_version &&
    entry.content_sha256 === file.content_sha256;
}

type DraftAction = "add" | "modify" | "rename" | "delete";
interface Draft {
  action: DraftAction;
  path: string;
  targetPath: string;
  content: string;
  baseContentHash?: string;
}

interface TreeNode {
  name: string;
  path: string;
  directories: Map<string, TreeNode>;
  files: ProjectFileMetadata[];
}

interface ArchiveBranchGroup {
  name: string;
  files: Array<{ file: ProjectFileMetadata; relativePath: string }>;
  updatedAt: string;
}

function archiveBranchGroups(files: readonly ProjectFileMetadata[]): ArchiveBranchGroup[] | null {
  if (files.length === 0) return null;
  const groups = new Map<string, ArchiveBranchGroup>();
  for (const file of files) {
    const match = /^\.harness\/archive\/([^/]+)\/(.+)$/u.exec(file.path);
    if (match === null) return null;
    const [, name, relativePath] = match;
    if (name === undefined || relativePath === undefined) return null;
    const current = groups.get(name) ?? { name, files: [], updatedAt: file.updated_at };
    current.files.push({ file, relativePath });
    if (file.updated_at > current.updatedAt) current.updatedAt = file.updated_at;
    groups.set(name, current);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      files: group.files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    }))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name));
}

const EMPTY_MANIFEST_HASH = "sha256:" + "0".repeat(64);

const COPY = {
  zh: {
    back: "返回项目列表",
    eyebrow: "项目工作台",
    tabs: { monitor: "分支监控", branchFiles: "分支文件", materials: "项目资料", knowledge: "项目知识", changes: "变更记录", versions: "版本记录", apiKeys: "API 密钥" },
    loading: "正在加载项目工作台",
    pendingMaterialsTitle: "项目资料查询正在接入",
    pendingMaterialsDescription: "规则、架构事实、架构约束、指令和配置将在查询 Adapter 接通后显示。",
    legacyMaterialsTitle: "暂无可信项目资料投影",
    legacyMaterialsDescription: "当前文件来自普通 artifact 或历史归档，没有 branch snapshot；真实项目文件可在“分支文件”中查看，资料投影将在后续 Remote Sync 生成快照后显示。",
    pendingChangesTitle: "变更记录查询正在接入",
    pendingChangesDescription: "设计、计划、测试场景、变更总结和归档状态将在查询 Adapter 接通后显示。",
    pendingSectionTitle: "此工作台查询正在接入",
    pendingSectionDescription: "查询 Adapter 接通前不会展示模拟的生产数据。",
    technicalDetails: "技术详情",
    healthy: "项目状态正常",
    healthyHint: "文件快照、知识索引和版本记录已同步到最新保存。",
    noVersion: "尚未生成项目版本",
    fileCount: "当前文件",
    editableCount: "可直接编辑",
    knowledgeCount: "知识条目",
    relations: "知识关系",
    lastUpdated: "最近更新",
    quickActions: "常用操作",
    manageFiles: "管理文件",
    browseKnowledge: "浏览项目知识",
    recentVersions: "最近版本",
    noVersions: "保存第一个文件后，这里会出现版本记录。",
    changedFiles: (count: number) => `${count} 个文件变更`,
    fileTitle: "项目文件",
    archiveBranches: "归档分支",
    archived: "已归档",
    branchFileCount: (count: number) => `${count} 个文件`,
    branchUpdated: "最近更新",
    branchFilesTitle: "分支文件",
    openBranch: (name: string) => `打开分支 ${name}`,
    newFile: "新建文件",
    searchFiles: "搜索文件或目录",
    collapseAll: "全部折叠",
    expandToSelected: "展开到选中",
    folderCount: (count: number) => `${count} 项`,
    treeLabel: "项目文件",
    allFiles: "全部文件",
    editableFiles: "可编辑",
    systemFiles: "系统只读",
    noFiles: "没有符合当前筛选的文件。",
    chooseFile: "从左侧目录中选择文件，正文将在打开时加载。",
    loadingContent: "正在加载文件内容…",
    editable: "可直接编辑",
    readOnly: "系统只读",
    edit: "编辑",
    rename: "重命名",
    delete: "删除",
    fileContent: "文件内容",
    filePath: "文件路径",
    targetPath: "新文件路径",
    save: "保存",
    confirmDelete: "确认删除",
    cancel: "取消",
    saved: "文件已保存并生成新版本。",
    saveFailed: "保存失败，请刷新后重试。",
    authFailed: "需要有效的 API 令牌才能访问此项目。",
    loadFailed: "项目数据加载失败。",
    versionNumber: (index: number) => `版本 ${index}`,
    current: "当前",
    bytes: "字节"
  },
  en: {
    back: "Back to projects",
    eyebrow: "Project workbench",
    tabs: { monitor: "Branch monitor", branchFiles: "Branch files", materials: "Project materials", knowledge: "Project knowledge", changes: "Changes", versions: "Version history", apiKeys: "API keys" },
    loading: "Loading project workspace",
    pendingMaterialsTitle: "Project materials query is being connected",
    pendingMaterialsDescription: "Rules, architecture facts and constraints, instructions, and configuration will appear after the query adapter is connected.",
    legacyMaterialsTitle: "No trusted project-material projection yet",
    legacyMaterialsDescription: "Current files came from regular artifacts or historical archives and have no branch snapshot. View the real files under Branch files; material projections appear after a later Remote Sync creates a snapshot.",
    pendingChangesTitle: "Changes query is being connected",
    pendingChangesDescription: "Designs, plans, test scenarios, change summaries, and archive status will appear after the query adapter is connected.",
    pendingSectionTitle: "This workspace query is being connected",
    pendingSectionDescription: "No simulated production data is shown before the query adapter is connected.",
    technicalDetails: "Technical details",
    healthy: "Project is healthy",
    healthyHint: "The file snapshot, knowledge index, and version history are synchronized.",
    noVersion: "No project version yet",
    fileCount: "Current files",
    editableCount: "Directly editable",
    knowledgeCount: "Knowledge entries",
    relations: "Knowledge relations",
    lastUpdated: "Last updated",
    quickActions: "Quick actions",
    manageFiles: "Manage files",
    browseKnowledge: "Browse project knowledge",
    recentVersions: "Recent versions",
    noVersions: "Version history appears after the first file is saved.",
    changedFiles: (count: number) => `${count} file changes`,
    fileTitle: "Project files",
    archiveBranches: "Archived branches",
    archived: "Archived",
    branchFileCount: (count: number) => `${count} files`,
    branchUpdated: "Last updated",
    branchFilesTitle: "Branch files",
    openBranch: (name: string) => `Open branch ${name}`,
    newFile: "New file",
    searchFiles: "Search files or folders",
    collapseAll: "Collapse all",
    expandToSelected: "Expand to selected",
    folderCount: (count: number) => `${count} items`,
    treeLabel: "Project files",
    allFiles: "All files",
    editableFiles: "Editable",
    systemFiles: "System read-only",
    noFiles: "No files match the current filter.",
    chooseFile: "Choose a file from the directory. Content loads only when opened.",
    loadingContent: "Loading file content…",
    editable: "Directly editable",
    readOnly: "System read-only",
    edit: "Edit",
    rename: "Rename",
    delete: "Delete",
    fileContent: "File content",
    filePath: "File path",
    targetPath: "New file path",
    save: "Save",
    confirmDelete: "Confirm delete",
    cancel: "Cancel",
    saved: "File saved and a new version was created.",
    saveFailed: "Save failed. Refresh and try again.",
    authFailed: "A valid API token is required to access this project.",
    loadFailed: "Project data could not be loaded.",
    versionNumber: (index: number) => `Version ${index}`,
    current: "Current",
    bytes: "bytes"
  }
} as const;

function userError(error: unknown, copy: typeof COPY.zh | typeof COPY.en): string {
  if (error instanceof ApiClientError && (error.status === 401 || error.status === 403)) {
    return copy.authFailed;
  }
  return copy.loadFailed;
}

function buildTree(files: ProjectFileMetadata[]): TreeNode {
  const root: TreeNode = { name: "", path: "", directories: new Map(), files: [] };
  for (const file of files) {
    const segments = file.path.split("/");
    let current = root;
    for (const segment of segments.slice(0, -1)) {
      const childPath = current.path === "" ? segment : `${current.path}/${segment}`;
      const child = current.directories.get(segment) ?? {
        name: segment,
        path: childPath,
        directories: new Map<string, TreeNode>(),
        files: []
      };
      current.directories.set(segment, child);
      current = child;
    }
    current.files.push(file);
  }
  return root;
}

function ancestorDirectoryPaths(filePath: string): string[] {
  const segments = filePath.split("/");
  const paths: string[] = [];
  for (let index = 0; index < segments.length - 1; index += 1) {
    paths.push(segments.slice(0, index + 1).join("/"));
  }
  return paths;
}

function collectDirectoryPaths(node: TreeNode): string[] {
  const paths: string[] = [];
  for (const directory of node.directories.values()) {
    paths.push(directory.path, ...collectDirectoryPaths(directory));
  }
  return paths;
}

function countNodeFiles(node: TreeNode): number {
  let total = node.files.length;
  for (const directory of node.directories.values()) {
    total += countNodeFiles(directory);
  }
  return total;
}

function DirectoryTree({
  node,
  selectedPath,
  openPaths,
  onOpenChange,
  onSelect,
  folderCountLabel,
  treeLabel,
  disabled = false,
  depth = 0
}: {
  node: TreeNode;
  selectedPath: string | null;
  openPaths: ReadonlySet<string>;
  onOpenChange: (path: string, open: boolean) => void;
  onSelect: (file: ProjectFileMetadata) => void;
  folderCountLabel: (count: number) => string;
  treeLabel: string;
  disabled?: boolean;
  depth?: number;
}) {
  const directories = [...node.directories.values()].sort((left, right) => left.name.localeCompare(right.name));
  const files = [...node.files].sort((left, right) => left.path.localeCompare(right.path));
  const content = <ul className="project-tree-list">
    {directories.map((directory) => {
      const count = countNodeFiles(directory);
      const isOpen = openPaths.has(directory.path);
      return <li key={directory.path}>
        <details
          open={isOpen}
          onToggle={(event) => {
            const nextOpen = (event.currentTarget as HTMLDetailsElement).open;
            if (nextOpen !== isOpen) onOpenChange(directory.path, nextOpen);
          }}
        >
          <summary data-touch-target="true">
            <span className="project-tree-folder" aria-hidden="true" />
            <span className="project-tree-name">{directory.name}</span>
            <span className="project-tree-count">{folderCountLabel(count)}</span>
          </summary>
          <DirectoryTree
            node={directory}
            selectedPath={selectedPath}
            openPaths={openPaths}
            onOpenChange={onOpenChange}
            onSelect={onSelect}
            folderCountLabel={folderCountLabel}
            treeLabel={treeLabel}
            disabled={disabled}
            depth={depth + 1}
          />
        </details>
      </li>;
    })}
    {files.map((file) => (
      <li key={file.path}>
        <button
          type="button"
          data-touch-target="true"
          disabled={disabled}
          aria-label={file.path}
          className={selectedPath === file.path ? "selected" : ""}
          onClick={() => onSelect(file)}
        >
          <span className="project-tree-file" aria-hidden="true" />
          {file.path.split("/").pop()}
        </button>
      </li>
    ))}
  </ul>;
  return depth === 0 ? <nav className="project-tree" aria-label={treeLabel}>{content}</nav> : content;
}

async function loadWorkspace(api: HunterApi, projectId: string): Promise<WorkspaceData> {
  const [project, overview] = await Promise.all([
    api.getProject(projectId),
    api.getProjectSemanticOverview?.(projectId).catch(() => null) ?? Promise.resolve(null)
  ]);
  let branchProjectionAvailable = api.listPlatformInformation !== undefined;
  if (api.listPlatformInformation !== undefined) {
    try {
      const page = await api.listPlatformInformation(projectId, "branch_files", { limit: 1, cursor: null });
      branchProjectionAvailable = page.items.some((item) => item.item_kind === "branch_snapshot");
    } catch {
      // Keep the new panel authoritative on transport/auth failures so it can show the real error.
      branchProjectionAvailable = true;
    }
  }
  const useLegacyWorkspaceLists = api.listPlatformInformation === undefined || !branchProjectionAvailable;
  if (useLegacyWorkspaceLists && api.listProjectFiles === undefined) throw new Error("project file API unavailable");
  const [artifacts, snapshot] = await Promise.all([
    useLegacyWorkspaceLists ? api.listProjectArtifacts(projectId) : Promise.resolve([]),
    useLegacyWorkspaceLists ? api.listProjectFiles?.(projectId) : Promise.resolve(null)
  ]);
  return { project, artifacts, files: snapshot?.items ?? [], overview, branchProjectionAvailable };
}

export function ProjectWorkspace({ api, projectId }: { api: HunterApi; projectId: string }) {
  const { lang } = useI18n();
  const toast = useToast();
  const copy = COPY[lang];
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [activeTab, setActiveTab] = useState<ProjectWorkspaceSection>("monitor");
  const [knowledgeActivated, setKnowledgeActivated] = useState(false);
  const [selectedArchiveBranch, setSelectedArchiveBranch] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [contentByPath, setContentByPath] = useState<Map<string, ProjectFileContentCacheEntry>>(new Map());
  const [loadingContent, setLoadingContent] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "editable" | "system">("all");
  const [openPaths, setOpenPaths] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const contentRequest = useRef(0);
  const workspaceRequest = useRef(0);

  useEffect(() => {
    setActiveTab("monitor");
    setKnowledgeActivated(false);
    setSelectedArchiveBranch(null);
  }, [api, projectId]);

  useEffect(() => {
    const request = ++workspaceRequest.current;
    contentRequest.current += 1;
    let active = true;
    setData(null);
    setError(null);
    setSelectedPath(null);
    setOpenPaths(new Set());
    setContentByPath(new Map());
    setLoadingContent(false);
    setDraft(null);
    setBusy(false);
    setQuery("");
    setFilter("all");
    void loadWorkspace(api, projectId).then((next) => {
      if (active && request === workspaceRequest.current) setData(next);
    }).catch((reason: unknown) => {
      if (active && request === workspaceRequest.current) setError(userError(reason, copy));
    });
    return () => { active = false; workspaceRequest.current += 1; };
  }, [api, projectId, copy]);

  const selected = useMemo(
    () => data?.files.find((file) => file.path === selectedPath) ?? null,
    [data, selectedPath]
  );
  const selectedPolicy = selected === null ? null : classifyManagedFile(selected.path);
  const selectedCache = selected === null ? undefined : contentByPath.get(selected.path);
  const selectedContent = selected === null || !contentCacheMatches(selectedCache, selected, projectId)
    ? undefined
    : selectedCache?.content;
  const editableFiles = data?.files.filter((file) => isProposalEditable(classifyManagedFile(file.path))).length ?? 0;
  const visibleFiles = useMemo(() => {
    if (data === null) return [];
    const needle = query.trim().toLowerCase();
    return data.files.filter((file) => {
      const editable = isProposalEditable(classifyManagedFile(file.path));
      return (needle === "" || file.path.toLowerCase().includes(needle)) &&
        (filter === "all" || (filter === "editable" ? editable : !editable));
    });
  }, [data, query, filter]);
  const tree = useMemo(() => buildTree(visibleFiles), [visibleFiles]);
  const archiveBranches = useMemo(() => archiveBranchGroups(data?.files ?? []), [data?.files]);
  const activeArchiveBranch = archiveBranches?.find((branch) => branch.name === selectedArchiveBranch)
    ?? archiveBranches?.[0]
    ?? null;
  const activeArchiveFile = activeArchiveBranch?.files.find((entry) => entry.file.path === selectedPath) ?? null;
  const latestArtifact = data?.artifacts.find((artifact) => artifact.artifact_id === data.project.latest_artifact_id)
    ?? data?.artifacts[0]
    ?? null;
  const usesInformationApi = api.listPlatformInformation !== undefined;
  const usesLegacyWorkspaceLists = !usesInformationApi || data?.branchProjectionAvailable === false;
  const fileCount = usesLegacyWorkspaceLists ? data?.files.length ?? 0 : data?.project.current_file_count ?? "—";
  const editableFileCount: number | string = usesLegacyWorkspaceLists ? editableFiles : "—";

  useEffect(() => {
    if (query.trim() !== "") {
      setOpenPaths(new Set(collectDirectoryPaths(tree)));
      return;
    }
  }, [query, tree]);

  useEffect(() => {
    if (query.trim() !== "" || selectedPath === null) return;
    setOpenPaths((current) => {
      const next = new Set(current);
      for (const path of ancestorDirectoryPaths(selectedPath)) next.add(path);
      return next;
    });
  }, [selectedPath, query]);

  function setDirectoryOpen(path: string, open: boolean): void {
    setOpenPaths((current) => {
      const next = new Set(current);
      if (open) next.add(path);
      else next.delete(path);
      return next;
    });
  }

  async function choose(file: ProjectFileMetadata): Promise<void> {
    if (busy) return;
    setError(null);
    setSelectedPath(file.path);
    setDraft(null);
    if (contentCacheMatches(contentByPath.get(file.path), file, projectId) || api.getProjectFileContent === undefined) return;
    const request = ++contentRequest.current;
    setLoadingContent(true);
    try {
      const loaded = await api.getProjectFileContent(projectId, file.path);
      const matches = loaded.project_id === projectId &&
        loaded.path === file.path &&
        loaded.project_version === file.project_version &&
        loaded.content_sha256 === file.content_sha256;
      if (request === contentRequest.current && matches) {
        setContentByPath((current) => new Map(current).set(file.path, {
          project_id: loaded.project_id,
          project_version: loaded.project_version,
          content_sha256: loaded.content_sha256,
          content: loaded.content
        }));
      } else if (request === contentRequest.current) {
        setError(copy.loadFailed);
      }
    } catch (reason) {
      if (request === contentRequest.current) setError(userError(reason, copy));
    } finally {
      if (request === contentRequest.current) setLoadingContent(false);
    }
  }

  function beginAdd(): void {
    if (busy) return;
    setSelectedPath(null);
    setDraft({
      action: "add",
      path: ".harness/knowledge/new-note.md",
      targetPath: "",
      content: "# New knowledge\n"
    });
  }

  function beginEdit(action: Exclude<DraftAction, "add">): void {
    if (busy) return;
    if (selected === null || selectedPolicy === null || !isProposalEditable(selectedPolicy)) return;
    if (action !== "delete" && selectedContent === undefined) return;
    setDraft({
      action,
      path: selected.path,
      targetPath: action === "rename" ? selected.path : "",
      content: selectedContent ?? "",
      baseContentHash: selected.content_sha256
    });
  }

  async function refreshWorkspace(preferredPath?: string): Promise<void> {
    const workspaceGeneration = workspaceRequest.current;
    const contentGeneration = ++contentRequest.current;
    setDraft(null);
    const next = await loadWorkspace(api, projectId);
    if (workspaceGeneration !== workspaceRequest.current) return;
    setData(next);
    const nextFile = preferredPath === undefined ? undefined : next.files.find((file) => file.path === preferredPath);
    if (preferredPath !== undefined && nextFile !== undefined) {
      setSelectedPath(preferredPath);
      if (api.getProjectFileContent !== undefined) {
        const loaded = await api.getProjectFileContent(projectId, preferredPath);
        const matches = loaded.project_id === projectId &&
          loaded.path === preferredPath &&
          loaded.project_version === nextFile.project_version &&
          loaded.content_sha256 === nextFile.content_sha256;
        if (workspaceGeneration === workspaceRequest.current && contentGeneration === contentRequest.current && matches) {
          setContentByPath((current) => new Map(current).set(preferredPath, {
            project_id: loaded.project_id,
            project_version: loaded.project_version,
            content_sha256: loaded.content_sha256,
            content: loaded.content
          }));
        } else if (workspaceGeneration === workspaceRequest.current && contentGeneration === contentRequest.current) {
          setError(copy.loadFailed);
        }
      }
    } else {
      setSelectedPath(null);
    }
  }

  async function save(): Promise<void> {
    if (busy || data === null || draft === null) return;
    const targetPath = draft.action === "rename" ? draft.targetPath.trim() : draft.path.trim();
    const policy = classifyManagedFile(targetPath);
    if (!isProposalEditable(policy) || targetPath === "") return;
    setBusy(true);
    setError(null);
    try {
      await api.createProjectFileProposal({
        projectId,
        baseProjectVersion: data.project.latest_project_version,
        baseManifestHash: latestArtifact?.manifest_sha256 ?? EMPTY_MANIFEST_HASH,
        baseArtifactId: data.project.latest_artifact_id,
        action: draft.action,
        path: draft.path.trim(),
        fileKind: policy.file_kind,
        confirmProjectLocal: policy.push_policy === "confirm-before-proposal",
        ...(draft.action === "rename" ? { targetPath } : {}),
        ...(draft.baseContentHash === undefined ? {} : { baseContentHash: draft.baseContentHash }),
        ...(draft.action === "delete" ? {} : { content: draft.content })
      });
      setDraft(null);
      toast.success(copy.saved);
      await refreshWorkspace(draft.action === "delete" ? undefined : targetPath);
    } catch {
      toast.danger(copy.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  if (error !== null && data === null) return <WorkspaceState technicalDetailsLabel={copy.technicalDetails} state={{
    kind: "error",
    title: copy.loadFailed,
    description: error
  }} />;
  if (data === null) {
    return <section className="stack governance-page project-workspace-v2">
      <WorkspaceState technicalDetailsLabel={copy.technicalDetails} state={{ kind: "loading", label: copy.loading }} />
    </section>;
  }
  const lastUpdated = data.project.updated_at ?? data.project.created_at;

  return <section className="stack governance-page project-workspace-v2">
    <header className="project-hero-card">
      <Link href="/projects" className="project-back" aria-label={copy.back}><Icon name="back" size={15} /></Link>
      <div className="project-hero-mark" aria-hidden="true">{data.project.display_name.slice(0, 1).toUpperCase()}</div>
      <div className="project-head-title">
        <p className="eyebrow">{copy.eyebrow}</p>
        <h1>{data.project.display_name}</h1>
      </div>
      <div className="project-hero-status">
        <span className={`project-status-pill ${data.project.latest_project_version === null ? "waiting" : "healthy"}`}>
          <span className="project-status-dot" />
          {data.project.latest_project_version === null ? copy.noVersion : copy.healthy}
        </span>
        <time>{new Date(lastUpdated).toLocaleString(lang === "zh" ? "zh-CN" : "en-US")}</time>
      </div>
    </header>

    <div className="project-overview-strip">
      <article><strong>{fileCount}</strong><span>{copy.fileCount}</span></article>
      <article><strong>{editableFileCount}</strong><span>{copy.editableCount}</span></article>
      <article><strong>{data.overview?.counts.knowledge ?? "—"}</strong><span>{copy.knowledgeCount}</span></article>
      <article><strong>{data.overview?.counts.edges ?? "—"}</strong><span>{copy.relations}</span></article>
    </div>

    <ProjectWorkspaceShell
      activeSection={activeTab}
      ariaLabel={copy.eyebrow}
      labels={copy.tabs}
      fallback={<WorkspaceState technicalDetailsLabel={copy.technicalDetails} state={{
        kind: "processing",
        title: copy.pendingSectionTitle,
        description: copy.pendingSectionDescription
      }} />}
      onSectionChange={(section) => runPreservingWindowScroll(() => {
        if (section === "knowledge") setKnowledgeActivated(true);
        setActiveTab(section);
      })}
      slots={{
        monitor: { content: <RunsMonitor api={api} projectId={projectId} /> },
        branchFiles: { content: archiveBranches !== null && activeArchiveBranch !== null ? <div className="runs-split archive-branches-shell">
      <aside className="runs-list-panel archive-branches-panel">
        <div className="runs-list-head"><h2>{copy.archiveBranches}<span className="runs-list-count">{archiveBranches.length}</span></h2></div>
        <ul className="runs-list archive-branch-options">
          {archiveBranches.map((branch) => <li key={branch.name}><button
            type="button"
            className={activeArchiveBranch.name === branch.name ? "active" : ""}
            aria-label={copy.openBranch(branch.name)}
            onClick={() => {
              contentRequest.current += 1;
              setSelectedArchiveBranch(branch.name);
              setSelectedPath(null);
              setDraft(null);
              setLoadingContent(false);
            }}
          >
            <span className="run-row"><i className="run-dot run-dot-success" aria-hidden="true" /><span className="run-title-stack"><strong title={branch.name}>{branch.name}</strong></span></span>
            <span className="run-meta"><span className="run-chip run-chip-success">{copy.archived}</span><span>{copy.branchFileCount(branch.files.length)}</span></span>
            <span className="run-meta run-time"><span>{copy.branchUpdated}</span><time dateTime={branch.updatedAt}>{new Date(branch.updatedAt).toLocaleString(lang === "zh" ? "zh-CN" : "en-US")}</time></span>
          </button></li>)}
        </ul>
      </aside>
      <main className="runs-detail archive-branch-detail">
        <div className="runs-detail-head"><div><h2>{activeArchiveBranch.name}</h2><p className="runs-mono">{copy.archived}</p></div></div>
        <div className="runs-status-grid archive-branch-stats">
          <div className="runs-status-chip tone-success"><small>{copy.branchFilesTitle}</small><strong>{activeArchiveBranch.files.length}</strong></div>
          <div className="runs-status-chip tone-neutral"><small>{copy.branchUpdated}</small><strong>{new Date(activeArchiveBranch.updatedAt).toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US")}</strong></div>
        </div>
        <section className="archive-branch-files" aria-label={copy.branchFilesTitle}>
          <h3>{copy.branchFilesTitle}</h3>
          <ul>{activeArchiveBranch.files.map(({ file, relativePath }) => <li key={file.path}><button
            type="button"
            className={selectedPath === file.path ? "selected" : ""}
            aria-label={relativePath}
            title={relativePath}
            onClick={() => void choose(file)}
          ><code>{relativePath}</code><small>{file.size_bytes} {copy.bytes}</small></button></li>)}</ul>
        </section>
        {activeArchiveFile === null ? <div className="project-file-placeholder archive-file-placeholder"><Icon name="file" size={24} /><h3>{copy.chooseFile}</h3></div> : <section className="archive-file-content">
          <header><div><p className="project-file-path">{activeArchiveFile.relativePath}</p><div className="project-file-badges"><span className="readonly">{copy.readOnly}</span><span>{activeArchiveFile.file.size_bytes} {copy.bytes}</span></div></div></header>
          <pre className="project-file-content">{loadingContent && selectedContent === undefined ? copy.loadingContent : selectedContent ?? ""}</pre>
        </section>}
      </main>
    </div> : usesLegacyWorkspaceLists ? <div className="project-files-shell">
      <aside className="project-files-sidebar">
        <div className="project-files-heading"><div><p className="eyebrow">{copy.fileTitle}</p><strong>{data.files.length}</strong></div><button type="button" data-touch-target="true" disabled={busy} onClick={beginAdd}><Icon name="plus" size={13} /> {copy.newFile}</button></div>
        <WorkspaceFilterBar label={copy.searchFiles} placeholder={copy.searchFiles} query={query} onQueryChange={setQuery}>
          {(["all", "editable", "system"] as const).map((value) => <button key={value} type="button" aria-pressed={filter === value} disabled={busy} className={filter === value ? "selected" : ""} onClick={() => setFilter(value)}>{value === "all" ? copy.allFiles : value === "editable" ? copy.editableFiles : copy.systemFiles}</button>)}
        </WorkspaceFilterBar>
        <div className="project-tree-toolbar">
          <button type="button" data-touch-target="true" disabled={busy} className="text-button" onClick={() => setOpenPaths(new Set())}>{copy.collapseAll}</button>
          <button
            type="button"
            data-touch-target="true"
            className="text-button"
            disabled={busy || selectedPath === null}
            onClick={() => setOpenPaths(new Set(selectedPath === null ? [] : ancestorDirectoryPaths(selectedPath)))}
          >{copy.expandToSelected}</button>
        </div>
        {visibleFiles.length === 0 ? <p className="project-empty-copy">{copy.noFiles}</p> : <DirectoryTree
          node={tree}
          selectedPath={selectedPath}
          openPaths={openPaths}
          onOpenChange={setDirectoryOpen}
          onSelect={(file) => void choose(file)}
          folderCountLabel={copy.folderCount}
          treeLabel={copy.treeLabel}
          disabled={busy}
        />}
      </aside>
      <main className="project-file-detail-v2">
        {selected === null && draft === null ? <div className="project-file-placeholder"><Icon name="file" size={26} /><h2>{copy.chooseFile}</h2></div> : null}
        {selected !== null ? <>
          <header className="project-file-detail-header">
            <div><p className="project-file-path">{selected.path}</p><div className="project-file-badges"><span className={selectedPolicy !== null && isProposalEditable(selectedPolicy) ? "editable" : "readonly"}>{selectedPolicy !== null && isProposalEditable(selectedPolicy) ? copy.editable : copy.readOnly}</span><span>{selected.size_bytes} {copy.bytes}</span></div></div>
            {selectedPolicy !== null && isProposalEditable(selectedPolicy) ? <div className="project-file-actions"><button type="button" data-touch-target="true" disabled={busy || selectedContent === undefined} onClick={() => beginEdit("modify")}>{copy.edit}</button><button type="button" data-touch-target="true" disabled={busy || selectedContent === undefined} onClick={() => beginEdit("rename")}>{copy.rename}</button><button type="button" data-touch-target="true" className="danger" disabled={busy} onClick={() => beginEdit("delete")}>{copy.delete}</button></div> : null}
          </header>
          <pre className="project-file-content">{loadingContent && selectedContent === undefined ? copy.loadingContent : selectedContent ?? ""}</pre>
        </> : null}
        {draft !== null ? <section className="project-file-editor">
          <header><h2>{draft.action === "add" ? copy.newFile : draft.action === "delete" ? copy.confirmDelete : copy.edit}</h2><button type="button" data-touch-target="true" className="icon-button" aria-label={copy.cancel} disabled={busy} onClick={() => setDraft(null)}><Icon name="close" size={14} /></button></header>
          <label>{copy.filePath}<input aria-label={copy.filePath} value={draft.path} disabled={busy || draft.action !== "add"} onChange={(event) => setDraft({ ...draft, path: event.target.value })} /></label>
          {draft.action === "rename" ? <label>{copy.targetPath}<input aria-label={copy.targetPath} value={draft.targetPath} disabled={busy} onChange={(event) => setDraft({ ...draft, targetPath: event.target.value })} /></label> : null}
          {draft.action === "delete" ? <p className="notice danger">{lang === "zh" ? "删除后会立即生成新版本；可通过历史版本追溯。" : "Deleting creates a new version immediately; prior versions remain traceable."}</p> : <label className="project-editor-content">{copy.fileContent}<textarea aria-label={copy.fileContent} value={draft.content} disabled={busy} onChange={(event) => setDraft({ ...draft, content: event.target.value })} /></label>}
          <div className="actions"><button type="button" data-touch-target="true" disabled={busy} onClick={() => void save()}>{draft.action === "delete" ? copy.confirmDelete : copy.save}</button><button type="button" data-touch-target="true" className="secondary" disabled={busy} onClick={() => setDraft(null)}>{copy.cancel}</button></div>
        </section> : null}
      </main>
    </div> : <BranchFilesInformationPanel api={api} projectId={projectId} lang={lang} /> },
        materials: { content: api.listPlatformInformation === undefined
          ? <WorkspaceState technicalDetailsLabel={copy.technicalDetails} state={{ kind: "processing", title: copy.pendingMaterialsTitle, description: copy.pendingMaterialsDescription }} />
          : usesLegacyWorkspaceLists
            ? <WorkspaceState technicalDetailsLabel={copy.technicalDetails} state={{ kind: "empty", title: copy.legacyMaterialsTitle, description: copy.legacyMaterialsDescription, technicalDetails: [{ label: "Code", value: "BRANCH_SNAPSHOT_REQUIRED" }] }} />
            : <ProjectMaterialsInformationPanel api={api} projectId={projectId} lang={lang} /> },
        ...(knowledgeActivated ? { knowledge: {
          content: api.listPlatformInformation === undefined || usesLegacyWorkspaceLists && (data.overview?.counts.documents ?? 0) > 0
            ? <ProjectSemanticPanels api={api} projectId={projectId} />
            : <ProjectKnowledgeInformationPanel api={api} projectId={projectId} lang={lang} />,
          keepMounted: true
        } } : {}),
        changes: { content: api.listPlatformInformation === undefined
          ? <WorkspaceState technicalDetailsLabel={copy.technicalDetails} state={{ kind: "processing", title: copy.pendingChangesTitle, description: copy.pendingChangesDescription }} />
          : <ChangeRecordsInformationPanel api={api} projectId={projectId} lang={lang} /> },
        versions: { content: usesLegacyWorkspaceLists
          ? <ProjectVersionsPanel api={api} artifacts={data.artifacts} lang={lang} />
          : <VersionRecordsInformationPanel api={api} projectId={projectId} lang={lang} /> },
        apiKeys: { content: <ProjectApiKeysPanel projectId={projectId} />, keepMounted: true }
      }}
    />

    {data === null ? null : <ToastFeedback tone="danger" message={error} />}
  </section>;
}
