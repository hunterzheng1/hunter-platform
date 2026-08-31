"use client";

import type { SemanticOverview } from "@hunter-harness/contracts";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
  runTitles: Map<string, string>;
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

type ArchiveFileCategory = "plan" | "spec" | "report" | "document" | "other";

interface ArchiveFileGroup {
  category: ArchiveFileCategory;
  files: ArchiveBranchGroup["files"];
}

const ARCHIVE_CATEGORY_ORDER: readonly ArchiveFileCategory[] = ["plan", "spec", "report", "document", "other"];

function archiveFileCategory(relativePath: string): ArchiveFileCategory {
  const normalized = relativePath.toLowerCase();
  if (/(^|\/)(plans?|implementation)(\/|$)|(^|[-_.])plan([-_.]|$)/u.test(normalized)) return "plan";
  if (/(^|\/)(specs?|design)(\/|$)|(^|[-_.])(spec|design)([-_.]|$)/u.test(normalized)) return "spec";
  if (/(^|\/)(reports?|summary)(\/|$)|(^|[-_.])(report|summary)([-_.]|$)/u.test(normalized)) return "report";
  if (/\.(md|mdx|txt|adoc)$/u.test(normalized)) return "document";
  return "other";
}

function archiveFileGroups(files: ArchiveBranchGroup["files"]): ArchiveFileGroup[] {
  const groups = new Map<ArchiveFileCategory, ArchiveBranchGroup["files"]>();
  for (const entry of files) {
    const category = archiveFileCategory(entry.relativePath);
    groups.set(category, [...(groups.get(category) ?? []), entry]);
  }
  return ARCHIVE_CATEGORY_ORDER.flatMap((category) => {
    const entries = groups.get(category);
    return entries === undefined ? [] : [{ category, files: entries }];
  });
}

const BRANCH_TITLES_ZH: Readonly<Record<string, string>> = {
  "kb-config-upload-binding": "知识库配置上传绑定",
  "usage-stats-cli-reporting": "CLI 使用统计报告"
};

const BRANCH_WORDS_ZH: Readonly<Record<string, string>> = {
  ai: "AI", api: "API", binding: "绑定", cli: "CLI", config: "配置", docs: "文档",
  feature: "功能", fix: "修复", kb: "知识库", report: "报告", reporting: "报告",
  stats: "统计", upload: "上传", usage: "使用"
};

function branchDisplayName(branchName: string, lang: "zh" | "en", runTitle?: string): string {
  const title = runTitle?.trim();
  if (title !== undefined && title !== "" && title !== branchName) return title;
  const words = branchName.split(/[-_/]+/u).filter(Boolean);
  if (lang === "en") {
    return words.map((word, index) => {
      const upper = word.toUpperCase();
      if (upper === "KB" || upper === "CLI" || upper === "API" || upper === "AI") return upper;
      return index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word;
    }).join(" ");
  }
  return BRANCH_TITLES_ZH[branchName] ?? words.map((word) => BRANCH_WORDS_ZH[word.toLowerCase()] ?? word).join("");
}

function archiveFileParts(relativePath: string): { name: string; directory: string } {
  const segments = relativePath.split("/");
  return { name: segments.at(-1) ?? relativePath, directory: segments.slice(0, -1).join(" / ") };
}

function archiveFileDisplayName(branchName: string, fileName: string): string {
  const prefix = `${branchName}-`;
  const shortened = fileName.startsWith(prefix) ? fileName.slice(prefix.length) : fileName;
  return shortened === "" ? fileName : shortened;
}

function archiveDesignMarkdown(content: string): string {
  const withoutLeadingMetadata = content.replace(
    /^\s*(?:(?:schema_version|artifact_type|content_hash|generated):[^\r\n]*(?:\r?\n|$))+/iu,
    ""
  );
  const output: string[] = [];
  let hiddenRequirementsLevel: number | null = null;
  for (const line of withoutLeadingMetadata.split(/\r?\n/u)) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    const headingLevel = heading?.[1]?.length;
    const headingText = heading?.[2] ?? "";
    if (hiddenRequirementsLevel === null && headingLevel !== undefined && /^(?:requirements|需求)$/iu.test(headingText)) {
      hiddenRequirementsLevel = headingLevel;
      continue;
    }
    if (hiddenRequirementsLevel !== null) {
      if (headingLevel !== undefined && headingLevel <= hiddenRequirementsLevel) hiddenRequirementsLevel = null;
      else continue;
    }
    output.push(line);
  }
  return output.join("\n").trim();
}

function isHarnessGeneratedPlan(relativePath: string, content: string | undefined): boolean {
  if (content === undefined || !/^plans\//u.test(relativePath)) return false;
  const endFm = content.indexOf("---\n", 4);
  if (endFm === -1) return false;
  return /^generated:\s*true\s*$/m.test(content.slice(4, endFm));
}

type ReadableJson = null | boolean | number | string | ReadableJson[] | { [key: string]: ReadableJson };
type JsonParseResult = { ok: true; value: ReadableJson } | { ok: false };

const JSON_RENDER_PAGE_SIZE = 100;
const JSON_RENDER_MAX_DEPTH = 12;
const JSON_BROWSER_MAX_BYTES = 2 * 1024 * 1024;

function parseReadableJson(content: string | undefined): JsonParseResult {
  if (content === undefined) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(content) as ReadableJson };
  } catch {
    return { ok: false };
  }
}

function jsonObject(value: ReadableJson): value is { [key: string]: ReadableJson } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const JSON_LABELS_ZH: Readonly<Record<string, string>> = {
  schemaVersion: "结构版本", changeName: "变更标识", displayTitle: "显示标题", businessGoal: "业务目标",
  finalStatus: "最终状态", finalStatusReasons: "状态说明", releaseEligible: "可发布", riskTier: "风险等级",
  verification: "验证结果", changedFiles: "变更文件", knownRisks: "已知风险", reviewSummary: "评审摘要",
  reviewFindings: "评审发现", stageStatus: "阶段状态", timeline: "时间线", durations: "耗时",
  decisions: "设计决策",
  efficiency: "效率", releaseDecision: "发布决策", manualActions: "手工操作", maintenanceNotes: "维护说明",
  artifacts: "交付物", ownership: "归属信息", plannedPhases: "计划阶段", lifecycle: "生命周期",
  build: "构建", tests: "测试", passed: "通过", failed: "失败", owner: "负责人",
  // 工作流阶段名（stageStatus/timeline 等对象的键）；2026-08 起 run+test 合并为
  // execute，旧名仍见于历史归档。
  plan: "计划", execute: "执行", run: "编码", test: "测试", review: "评审",
  package: "打包", apidoc: "接口文档", submit: "提交", merge: "合并", archive: "归档"
};

function humanizeJsonKey(key: string, lang: "zh" | "en"): string {
  if (lang === "zh" && JSON_LABELS_ZH[key] !== undefined) return JSON_LABELS_ZH[key];
  const words = key.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replaceAll("_", " ").replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function jsonCollectionSummary(value: ReadableJson, lang: "zh" | "en"): string {
  if (Array.isArray(value)) return lang === "zh" ? `${value.length} 项` : `${value.length} items`;
  if (jsonObject(value)) return lang === "zh" ? `${Object.keys(value).length} 个字段` : `${Object.keys(value).length} fields`;
  return "";
}

function JsonScalar({ value, lang }: { value: null | boolean | number | string; lang: "zh" | "en" }) {
  if (value === null) return <span className="json-null">—</span>;
  if (typeof value === "boolean") return <span className={`json-boolean ${value ? "positive" : "negative"}`}>{lang === "zh" ? value ? "是" : "否" : String(value)}</span>;
  if (typeof value === "number") return <span className="json-number">{value.toLocaleString(lang === "zh" ? "zh-CN" : "en-US")}</span>;
  return <span className="json-string">{value}</span>;
}

function JsonLazySection({ name, value, lang, depth }: { name: string; value: ReadableJson[] | { [key: string]: ReadableJson }; lang: "zh" | "en"; depth: number }) {
  const [open, setOpen] = useState(false);
  return <details className="json-section" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><span><strong>{humanizeJsonKey(name, lang)}</strong><code>{name}</code></span><small>{jsonCollectionSummary(value, lang)}</small></summary>
    {open ? <JsonCollection value={value} lang={lang} depth={depth + 1} /> : null}
  </details>;
}

function JsonCollection({ value, lang, depth = 0, skip = new Set<string>() }: { value: ReadableJson[] | { [key: string]: ReadableJson }; lang: "zh" | "en"; depth?: number; skip?: ReadonlySet<string> }) {
  const [visibleCount, setVisibleCount] = useState(JSON_RENDER_PAGE_SIZE);
  useEffect(() => setVisibleCount(JSON_RENDER_PAGE_SIZE), [value]);
  if (depth >= JSON_RENDER_MAX_DEPTH) {
    return <p className="json-render-limit">{lang === "zh" ? "内容层级过深，已停止继续展开。" : "Maximum display depth reached."}</p>;
  }
  if (Array.isArray(value)) {
    const visible = value.slice(0, visibleCount);
    const remaining = value.length - visible.length;
    return <><ol className="json-array">{visible.map((item, index) => <li key={index}>
      {Array.isArray(item) || jsonObject(item)
        ? <JsonLazySection name={lang === "zh" ? `第 ${index + 1} 项` : `Item ${index + 1}`} value={item} lang={lang} depth={depth} />
        : <JsonScalar value={item} lang={lang} />}
    </li>)}</ol>{remaining > 0 ? <button type="button" className="json-load-more" onClick={() => setVisibleCount((count) => count + JSON_RENDER_PAGE_SIZE)}>{lang === "zh" ? `继续显示（剩余 ${remaining} 项）` : `Show more (${remaining} remaining)`}</button> : null}</>;
  }
  const entries = Object.entries(value).filter(([key]) => !skip.has(key));
  const visible = entries.slice(0, visibleCount);
  const remaining = entries.length - visible.length;
  return <><div className="json-object">{visible.map(([key, item]) =>
    Array.isArray(item) || jsonObject(item)
      ? <JsonLazySection key={key} name={key} value={item} lang={lang} depth={depth} />
      : <div className="json-field" key={key}><div className="json-field-label"><span>{humanizeJsonKey(key, lang)}</span><code>{key}</code></div><div className="json-field-value"><JsonScalar value={item} lang={lang} /></div></div>
  )}</div>{remaining > 0 ? <button type="button" className="json-load-more" onClick={() => setVisibleCount((count) => count + JSON_RENDER_PAGE_SIZE)}>{lang === "zh" ? `继续显示（剩余 ${remaining} 项）` : `Show more (${remaining} remaining)`}</button> : null}</>;
}

function JsonDocument({ value, lang, report }: { value: ReadableJson; lang: "zh" | "en"; report: boolean }) {
  const title = report ? (lang === "zh" ? "交付报告概览" : "Delivery report overview") : (lang === "zh" ? "JSON 阅读视图" : "JSON reading view");
  const summaryKeys = report
    ? ["changeName", "businessGoal", "finalStatus", "releaseEligible", "riskTier", "schemaVersion"]
    : ["displayTitle", "changeName", "schemaVersion"];
  const summary = jsonObject(value) ? summaryKeys.flatMap((key) => {
    const item = value[key];
    return item === null || typeof item === "boolean" || typeof item === "number" || typeof item === "string" ? [{ key, item }] : [];
  }) : [];
  const renderedSummaryKeys = new Set(summary.map(({ key }) => key));
  return <article className={`archive-json ${report ? "report" : "generic"}`}>
    <header><div><p className="eyebrow">{report ? (lang === "zh" ? "结构化报告" : "Structured report") : "JSON"}</p><h3>{title}</h3></div></header>
    {summary.length === 0 ? null : <div className="json-summary-grid">{summary.map(({ key, item }) => <section key={key}><small>{humanizeJsonKey(key, lang)}</small><JsonScalar value={item} lang={lang} /></section>)}</div>}
    <div className="json-document-body">{Array.isArray(value) || jsonObject(value)
      ? <JsonCollection value={value} lang={lang} skip={renderedSummaryKeys} />
      : <JsonScalar value={value} lang={lang} />}</div>
  </article>;
}

function archiveBranchGroups(files: readonly ProjectFileMetadata[]): ArchiveBranchGroup[] | null {
  if (files.length === 0) return null;
  const groups = new Map<string, ArchiveBranchGroup>();
  for (const file of files) {
    const match = /^\.harness\/archive\/([^/]+)\/(.+)$/u.exec(file.path);
    // A project may contain both archived delivery documents and ordinary
    // Git/codebase files.  Only the archive subset belongs in this reader;
    // unrelated files must not disable the entire archived-branch view.
    if (match === null) continue;
    const [, name, relativePath] = match;
    if (name === undefined || relativePath === undefined) return null;
    const current = groups.get(name) ?? { name, files: [], updatedAt: file.updated_at };
    current.files.push({ file, relativePath });
    if (file.updated_at > current.updatedAt) current.updatedAt = file.updated_at;
    groups.set(name, current);
  }
  if (groups.size === 0) return null;
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
    archiveBranches: "已上传分支",
    archiveBranchesHint: "选择分支，查看其中的计划、设计规格与交付文档。",
    branchFileCount: (count: number) => `${count} 个文件`,
    branchUpdated: "最近更新",
    branchFilesTitle: "文件概览",
    categoryLabels: { plan: "实施计划", spec: "设计规格", report: "交付报告", document: "相关文档", other: "其他文件" },
    categoryHints: { plan: "Plan", spec: "Spec", report: "Report", document: "Docs", other: "Other" },
    openBranch: (name: string) => `打开分支 ${name}`,
    openFile: (name: string) => `打开文件 ${name}`,
    chooseArchiveFile: "选择一个文件查看内容。计划与设计规格已优先排列。",
    noDesignFile: "该分支没有 design.md。",
    markdownPreview: "Markdown 阅读视图",
    archiveReadOnly: "历史文件 · 只读",
    remoteImageBlocked: "远程图片未自动加载",
    harnessGenerated: "机器生成",
    harnessPlanNote: "此文件由 harness-plan finalize 自动生成，是受完整性门禁保护的机器契约。规划的自然语言输入保存在本地 .harness/changes/<change>/meta/plan-evidence-input.json。",
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
    archiveBranches: "Uploaded branches",
    archiveBranchesHint: "Select a branch to review its plans, specifications, and delivery documents.",
    branchFileCount: (count: number) => `${count} files`,
    branchUpdated: "Last updated",
    branchFilesTitle: "File overview",
    categoryLabels: { plan: "Implementation plans", spec: "Design specifications", report: "Delivery reports", document: "Related documents", other: "Other files" },
    categoryHints: { plan: "Plan", spec: "Spec", report: "Report", document: "Docs", other: "Other" },
    openBranch: (name: string) => `Open branch ${name}`,
    openFile: (name: string) => `Open file ${name}`,
    chooseArchiveFile: "Choose a file to read. Plans and specifications are shown first.",
    noDesignFile: "This branch does not contain design.md.",
    markdownPreview: "Markdown reading view",
    archiveReadOnly: "Historical file · read only",
    remoteImageBlocked: "Remote image not loaded automatically",
    harnessGenerated: "Machine-generated",
    harnessPlanNote: "This file is auto-generated by harness-plan finalize and is a machine contract protected by integrity gates. The natural-language planning input lives at .harness/changes/<change>/meta/plan-evidence-input.json.",
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
    // Always inspect current project files when the endpoint exists.  Archived
    // delivery branches and Remote Sync Git snapshots are different concepts:
    // the existence of a snapshot must not hide real .harness/archive files.
    api.listProjectFiles?.(projectId) ?? Promise.resolve(null)
  ]);
  const runTitles = new Map<string, string>();
  if (snapshot !== null && snapshot !== undefined && archiveBranchGroups(snapshot.items) !== null && api.listProjectRuns !== undefined) {
    try {
      const runs = await api.listProjectRuns(projectId, { limit: 100, cursor: null });
      for (const run of runs.items) {
        const title = run.title?.trim();
        if (title !== undefined && title !== "" && title !== run.change_key && !runTitles.has(run.change_key)) {
          runTitles.set(run.change_key, title);
        }
      }
    } catch {
      // Archive files remain readable when run-monitor titles are unavailable.
    }
  }
  return { project, artifacts, files: snapshot?.items ?? [], overview, branchProjectionAvailable, runTitles };
}

export function ProjectWorkspace({ api, projectId }: { api: HunterApi; projectId: string }) {
  const { lang } = useI18n();
  const toast = useToast();
  const copy = COPY[lang];
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [activeTab, setActiveTab] = useState<ProjectWorkspaceSection>("monitor");
  const [knowledgeActivated, setKnowledgeActivated] = useState(false);
  const [selectedArchiveBranch, setSelectedArchiveBranch] = useState<string | null>(null);
  const [openArchiveCategories, setOpenArchiveCategories] = useState<Set<ArchiveFileCategory>>(() => new Set(["plan", "spec"]));
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
    setOpenArchiveCategories(new Set(["plan", "spec"]));
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
  const selectedJsonTooLarge = selected !== null && /\.json$/iu.test(selected.path) && selected.size_bytes > JSON_BROWSER_MAX_BYTES;
  const selectedJson = useMemo(
    () => selected !== null && /\.json$/iu.test(selected.path) && !selectedJsonTooLarge ? parseReadableJson(selectedContent) : { ok: false } as const,
    [selected, selectedContent, selectedJsonTooLarge]
  );
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
  const activeArchiveDesignFile = activeArchiveBranch?.files.find((entry) => /(?:^|-)design\.md$/iu.test(archiveFileParts(entry.relativePath).name)) ?? null;
  const activeArchiveFile = activeArchiveDesignFile !== null && selectedPath === activeArchiveDesignFile.file.path ? activeArchiveDesignFile : null;
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
    if (/\.json$/iu.test(file.path) && file.size_bytes > JSON_BROWSER_MAX_BYTES) {
      contentRequest.current += 1;
      setLoadingContent(false);
      return;
    }
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

  useEffect(() => {
    if (activeArchiveBranch === null) return;
    if (activeArchiveDesignFile === null) {
      setSelectedPath(null);
      return;
    }
    if (selectedPath !== activeArchiveDesignFile.file.path) void choose(activeArchiveDesignFile.file);
    // This intentionally reacts only to a branch/data change, not to the unstable choose closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeArchiveBranch?.name, activeArchiveDesignFile?.file.path]);

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
        <div className="runs-list-head"><div><h2>{copy.archiveBranches}<span className="runs-list-count">{archiveBranches.length}</span></h2><p>{copy.archiveBranchesHint}</p></div></div>
        <ul className="runs-list archive-branch-options">
          {archiveBranches.map((branch) => {
            const displayName = branchDisplayName(branch.name, lang, data.runTitles.get(branch.name));
            return <li key={branch.name}><button
              type="button"
              className={activeArchiveBranch.name === branch.name ? "active" : ""}
              aria-label={copy.openBranch(`${displayName} ${branch.name}`)}
              aria-pressed={activeArchiveBranch.name === branch.name}
              onClick={() => {
                contentRequest.current += 1;
                setSelectedArchiveBranch(branch.name);
                setOpenArchiveCategories(new Set(["plan", "spec"]));
                setSelectedPath(null);
                setDraft(null);
                setLoadingContent(false);
              }}
            >
              <span className="run-row"><span className="run-title-stack"><strong title={displayName}>{displayName}</strong><small title={branch.name}>{branch.name}</small></span></span>
              <span className="run-meta"><span>{copy.branchFileCount(branch.files.length)}</span><time dateTime={branch.updatedAt}>{new Date(branch.updatedAt).toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US")}</time></span>
            </button></li>;
          })}
        </ul>
      </aside>
      <main className="runs-detail archive-branch-detail">
        <div className="runs-detail-head"><div><h2>{branchDisplayName(activeArchiveBranch.name, lang, data.runTitles.get(activeArchiveBranch.name))}</h2><p className="runs-mono">{activeArchiveBranch.name}</p></div><div className="archive-branch-meta"><span>{copy.branchFileCount(activeArchiveBranch.files.length)}</span><time dateTime={activeArchiveBranch.updatedAt}>{copy.branchUpdated}：{new Date(activeArchiveBranch.updatedAt).toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US")}</time></div></div>
        <div className="archive-branch-browser archive-branch-design-browser">
          <div className="archive-content-pane">
            {activeArchiveDesignFile === null ? <div className="project-file-placeholder archive-file-placeholder"><Icon name="file" size={24} /><h3>{copy.noDesignFile}</h3></div> : activeArchiveFile === null ? <div className="project-file-placeholder archive-file-placeholder"><Icon name="file" size={24} /><h3>{copy.loadingContent}</h3></div> : <section className="archive-file-content">
              <header><div><p className="project-file-name">design.md</p><div className="project-file-badges"><span className="readonly">{copy.archiveReadOnly}</span><span>{activeArchiveFile.file.size_bytes} {copy.bytes}</span><span>{copy.markdownPreview}</span></div></div></header>
              {loadingContent && selectedContent === undefined ? <p className="archive-content-loading">{copy.loadingContent}</p> : /\.mdx?$/iu.test(activeArchiveFile.relativePath) ? <article className="archive-markdown"><ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  img: ({ alt }) => <span className="archive-markdown-image-blocked" role="note">{copy.remoteImageBlocked}{alt === undefined || alt === "" ? null : `：${alt}`}</span>,
                  a: ({ href, children }) => href?.startsWith("http://") === true || href?.startsWith("https://") === true
                    ? <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
                    : href?.startsWith("#") === true
                      ? <a href={href}>{children}</a>
                      : <span className="archive-markdown-relative-link" title={href}>{children}</span>
                }}
              >{archiveDesignMarkdown(selectedContent ?? "")}</ReactMarkdown></article> : selectedJsonTooLarge ? <div className="json-too-large"><strong>{lang === "zh" ? "JSON 文件过大" : "JSON file is too large"}</strong><p>{lang === "zh" ? "为避免浏览器卡顿，超过 2 MB 的 JSON 不在页面中展开。" : "JSON files over 2 MB are not expanded in the browser."}</p></div> : /\.json$/iu.test(activeArchiveFile.relativePath) && selectedJson.ok ? <JsonDocument value={selectedJson.value} lang={lang} report={/(^|\/)reports\/final\/summary-data\.json$/iu.test(activeArchiveFile.relativePath)} /> : <pre className="project-file-content">{selectedContent ?? ""}</pre>}
            </section>}
          </div>
        </div>
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
