"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";

import type {
  AgentTool,
  AgentToolGithubInspection,
  AgentToolCategory,
  AgentToolMutation,
  AgentToolSource,
  AgentToolStatus
} from "@hunter-harness/contracts";

import { browserApi, type HunterApi } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { mockApi } from "../lib/mock-api";
import { apiError, required } from "./skill-shared";
import { EmptyState } from "./ui/EmptyState";
import { Icon } from "./ui/icons";
import { Modal } from "./ui/Modal";
import { ToastFeedback, useToast } from "./ui/Toast";

const CATEGORIES: AgentToolCategory[] = ["harness", "runtime", "orchestrator", "ade", "cli", "framework"];
const SOURCE_TYPES: AgentToolSource["type"][] = ["github", "npm", "website"];
const STATUSES: AgentToolStatus[] = ["active", "experimental", "archived"];

interface ToolFormState {
  displayName: string;
  slug: string;
  description: string;
  category: AgentToolCategory;
  status: AgentToolStatus;
  sourceType: AgentToolSource["type"];
  sourceRef: string;
  homepage: string;
  packageName: string;
  installCommand: string;
  tags: string;
  relatedWorkflowFamilies: string;
}

const EMPTY_FORM: ToolFormState = {
  displayName: "",
  slug: "",
  description: "",
  category: "harness",
  status: "active",
  sourceType: "github",
  sourceRef: "",
  homepage: "",
  packageName: "",
  installCommand: "",
  tags: "",
  relatedWorkflowFamilies: ""
};

function resolveApi(): HunterApi {
  return process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true" ? mockApi : browserApi();
}

function splitSlugs(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function sourceHref(tool: AgentTool): string | null {
  if (tool.source.type === "npm") {
    return `https://www.npmjs.com/package/${encodeURIComponent(tool.source.ref).replace("%40", "@")}`;
  }
  return /^https?:\/\//i.test(tool.source.ref) ? tool.source.ref : null;
}

export function AgentToolCenter({ api: apiValue }: { api?: HunterApi }) {
  const { lang, t } = useI18n();
  const toast = useToast();
  const api = useMemo(() => apiValue ?? resolveApi(), [apiValue]);
  const zh = lang === "zh";
  const copy = zh ? {
    eyebrow: "Agent 能力",
    title: "Agent",
    description: "集中管理可独立运行的 Harness、运行时、编排器和开发环境，快速查看来源与接入方式。",
    register: "添加 Agent",
    search: "搜索 Agent",
    allCategories: "全部分类",
    allSources: "全部来源",
    empty: "暂无匹配的 Agent",
    dialogTitle: "添加 Agent",
    githubTitle: "从 GitHub 添加",
    githubDescription: "粘贴仓库地址，平台会读取名称、简介和标签；确认前仍可调整。",
    githubUrl: "GitHub 仓库地址",
    inspect: "读取仓库信息",
    inspecting: "读取中…",
    manual: "手动填写",
    backToGithub: "返回 GitHub 导入",
    recognized: "已读取仓库信息",
    aiFill: "AI 智能填写",
    aiFilling: "AI 正在整理…",
    aiHint: "根据仓库信息生成中文描述、分类和标签。生成后仍可修改，也可以直接确认添加。",
    aiFilled: "AI 草稿已生成，请检查后确认。",
    displayName: "显示名称",
    slug: "标识",
    descriptionField: "描述",
    category: "分类",
    status: "状态",
    sourceType: "来源类型",
    sourceRef: "来源地址",
    homepage: "主页（可选）",
    packageName: "包名（可选）",
    installCommand: "安装命令（可选）",
    tags: "标签",
    related: "关联工作流",
    commaHint: "多个值用英文逗号分隔",
    cancel: "取消",
    save: "确认添加",
    saving: "添加中…",
    saved: "Agent 已添加。",
    tools: "个 Agent",
    exactSource: "来源",
    relatedShort: "工作流"
  } : {
    eyebrow: "Agent catalog",
    title: "Agents",
    description: "Manage runnable harnesses, runtimes, orchestrators and agent development environments in one catalog.",
    register: "Add Agent",
    search: "Search Agents",
    allCategories: "All categories",
    allSources: "All sources",
    empty: "No matching Agents",
    dialogTitle: "Add Agent",
    githubTitle: "Add from GitHub",
    githubDescription: "Paste a repository URL to prefill its name, description and tags. You can review everything before saving.",
    githubUrl: "GitHub repository",
    inspect: "Inspect repository",
    inspecting: "Inspecting…",
    manual: "Enter manually",
    backToGithub: "Back to GitHub import",
    recognized: "Repository details loaded",
    aiFill: "Fill with AI",
    aiFilling: "AI is drafting…",
    aiHint: "Generate a Chinese description, category and tags from the repository. You can edit every field before saving.",
    aiFilled: "AI draft generated. Review it before saving.",
    displayName: "Display name",
    slug: "Slug",
    descriptionField: "Description",
    category: "Category",
    status: "Status",
    sourceType: "Source type",
    sourceRef: "Source reference",
    homepage: "Homepage (optional)",
    packageName: "Package name (optional)",
    installCommand: "Install command (optional)",
    tags: "Tags",
    related: "Related workflows",
    commaHint: "Separate multiple values with commas",
    cancel: "Cancel",
    save: "Add Agent",
    saving: "Adding…",
    saved: "Agent added.",
    tools: "Agents",
    exactSource: "Source",
    relatedShort: "Workflows"
  };
  const categoryLabels: Record<AgentToolCategory, string> = zh ? {
    harness: "Harness",
    runtime: "运行时",
    orchestrator: "编排器",
    ade: "Agent 开发环境",
    cli: "命令行",
    framework: "框架"
  } : {
    harness: "Harness",
    runtime: "Runtime",
    orchestrator: "Orchestrator",
    ade: "Agent IDE",
    cli: "CLI",
    framework: "Framework"
  };
  const statusLabels: Record<AgentToolStatus, string> = zh ? {
    active: "可用",
    experimental: "试用",
    archived: "已停用"
  } : {
    active: "Active",
    experimental: "Experimental",
    archived: "Archived"
  };

  const [tools, setTools] = useState<AgentTool[] | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<AgentToolCategory | "all">("all");
  const [sourceType, setSourceType] = useState<AgentToolSource["type"] | "all">("all");
  const [registerOpen, setRegisterOpen] = useState(false);
  const [form, setForm] = useState<ToolFormState>(EMPTY_FORM);
  const [registrationMode, setRegistrationMode] = useState<"github" | "details">("github");
  const [githubUrl, setGithubUrl] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const [inspection, setInspection] = useState<AgentToolGithubInspection | null>(null);
  const [aiFilling, setAiFilling] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refreshTools(): Promise<void> {
    try {
      setTools(await required(api, "listAgentTools")());
      setError(null);
    } catch (reason) {
      setError(apiError(reason, t));
    }
  }

  useEffect(() => { void refreshTools(); }, [api]);

  const needle = query.trim().toLowerCase();
  const filtered = (tools ?? []).filter((tool) => {
    if (category !== "all" && tool.category !== category) return false;
    if (sourceType !== "all" && tool.source.type !== sourceType) return false;
    return needle === "" || [
      tool.displayName,
      tool.slug,
      tool.description,
      tool.source.ref,
      tool.packageName ?? "",
      ...tool.tags,
      ...tool.relatedWorkflowFamilies
    ].join(" ").toLowerCase().includes(needle);
  });

  function updateForm<K extends keyof ToolFormState>(key: K, value: ToolFormState[K]): void {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function applyInspection(inspection: AgentToolGithubInspection): void {
    const suggested = inspection.suggested;
    setForm({
      displayName: suggested.displayName,
      slug: suggested.slug,
      description: suggested.description,
      category: suggested.category,
      status: suggested.status,
      sourceType: inspection.source.type,
      sourceRef: inspection.source.ref,
      homepage: suggested.homepage ?? "",
      packageName: suggested.packageName ?? "",
      installCommand: suggested.installCommand ?? "",
      tags: suggested.tags.join(", "),
      relatedWorkflowFamilies: suggested.relatedWorkflowFamilies.join(", ")
    });
    setRegistrationMode("details");
  }

  function applyMutation(suggested: AgentToolMutation): void {
    setForm({
      displayName: suggested.displayName,
      slug: suggested.slug,
      description: suggested.description,
      category: suggested.category,
      status: suggested.status,
      sourceType: suggested.source.type,
      sourceRef: suggested.source.ref,
      homepage: suggested.homepage ?? "",
      packageName: suggested.packageName ?? "",
      installCommand: suggested.installCommand ?? "",
      tags: suggested.tags.join(", "),
      relatedWorkflowFamilies: suggested.relatedWorkflowFamilies.join(", ")
    });
  }

  async function inspectGithub(): Promise<void> {
    if (inspecting || githubUrl.trim() === "") return;
    setInspecting(true);
    setError(null);
    try {
      const result = await required(api, "inspectAgentToolGithub")(githubUrl.trim());
      setInspection(result);
      applyInspection(result);
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setInspecting(false);
    }
  }

  async function fillWithAi(): Promise<void> {
    if (inspection === null || aiFilling) return;
    setAiFilling(true);
    setError(null);
    try {
      applyMutation(await required(api, "generateAgentToolPrefill")(inspection));
      toast.success(copy.aiFilled);
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setAiFilling(false);
    }
  }

  function closeRegistration(): void {
    setRegisterOpen(false);
    setRegistrationMode("github");
    setGithubUrl("");
    setInspection(null);
    setForm(EMPTY_FORM);
  }

  async function submitRegistration(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    const input: AgentToolMutation = {
      slug: form.slug.trim(),
      displayName: form.displayName.trim(),
      description: form.description.trim(),
      category: form.category,
      status: form.status,
      source: { type: form.sourceType, ref: form.sourceRef.trim() },
      homepage: form.homepage.trim() || null,
      packageName: form.packageName.trim() || null,
      installCommand: form.installCommand.trim() || null,
      tags: splitSlugs(form.tags),
      relatedWorkflowFamilies: splitSlugs(form.relatedWorkflowFamilies)
    };
    try {
      const created = await required(api, "createAgentTool")(input);
      setTools((current) => [created, ...(current ?? []).filter((tool) => tool.slug !== created.slug)]);
      closeRegistration();
      toast.success(copy.saved);
      void refreshTools();
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="stack page-module-v2 agent-tool-page">
      <header className="project-registry-hero agent-tool-hero" data-slot="agent-header">
        <div>
          <p className="eyebrow">{copy.eyebrow}</p>
          <h1>{copy.title}</h1>
          <p>{copy.description}</p>
        </div>
        <button type="button" className="primary agent-tool-register" onClick={() => setRegisterOpen(true)}>
          <Icon name="plus" size={15} />
          {copy.register}
        </button>
      </header>

      <div className="agent-tool-toolbar" data-slot="agent-filters">
        <label className="agent-tool-search">
          <Icon name="search" size={16} />
          <input
            aria-label={copy.search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={copy.search}
          />
        </label>
        <select aria-label={zh ? "类型筛选" : "Filter by category"} value={category} onChange={(event) => setCategory(event.target.value as AgentToolCategory | "all")}>
          <option value="all">{copy.allCategories}</option>
          {CATEGORIES.map((item) => <option value={item} key={item}>{categoryLabels[item]}</option>)}
        </select>
        <select aria-label={zh ? "来源筛选" : "Filter by source"} value={sourceType} onChange={(event) => setSourceType(event.target.value as AgentToolSource["type"] | "all")}>
          <option value="all">{copy.allSources}</option>
          {SOURCE_TYPES.map((item) => <option value={item} key={item}>{item === "github" ? "GitHub" : item === "npm" ? "npm" : "Web"}</option>)}
        </select>
        <span className="agent-tool-count"><strong>{filtered.length}</strong> {copy.tools}</span>
      </div>

      {tools === null ? <div className="skeleton-block" /> : filtered.length === 0 ? (
        <div className="panel agent-tool-empty"><EmptyState icon="agent" title={copy.empty} /></div>
      ) : (
        <div className="agent-tool-grid" data-slot="agent-tool-grid" data-layout="dense-cards">
          {filtered.map((tool) => {
            const href = sourceHref(tool);
            return (
              <article className="agent-tool-card" data-slot="agent-card" key={tool.tool_id}>
                <header>
                  <span className={`agent-tool-mark agent-tool-mark-${tool.category}`}><Icon name="agent" size={18} /></span>
                  <div>
                    <h2>{tool.displayName}</h2>
                    <code>{tool.slug}</code>
                  </div>
                  <span className={`agent-tool-status agent-tool-status-${tool.status}`}>{statusLabels[tool.status]}</span>
                </header>
                <p>{tool.description}</p>
                <div className="agent-tool-source">
                  <span>{copy.exactSource} · {tool.source.type}</span>
                  {href === null ? <code>{tool.source.ref}</code> : (
                    <a href={href} target="_blank" rel="noreferrer" title={tool.source.ref}>{tool.source.ref}</a>
                  )}
                </div>
                <footer>
                  <span className="agent-tool-category">{categoryLabels[tool.category]}</span>
                  {tool.tags.slice(0, 2).map((tag) => <span className="agent-tool-tag" key={tag}>{tag}</span>)}
                  {tool.relatedWorkflowFamilies.length === 0 ? null : (
                    <span className="agent-tool-related"><Icon name="workflow" size={12} /> {tool.relatedWorkflowFamilies.length} {copy.relatedShort}</span>
                  )}
                </footer>
              </article>
            );
          })}
        </div>
      )}

      <Modal
        open={registerOpen}
        onClose={closeRegistration}
        title={copy.dialogTitle}
        closeLabel={zh ? "关闭" : "Close"}
        wide
        footer={(
          <>
            <button type="button" className="secondary" onClick={closeRegistration}>{copy.cancel}</button>
            {registrationMode === "details" ? (
              <button type="submit" form="agent-tool-registration" className="primary" disabled={saving}>
                {saving ? copy.saving : copy.save}
              </button>
            ) : null}
          </>
        )}
      >
        {registrationMode === "github" ? (
          <div className="agent-import-start" data-slot="agent-github-import">
            <div className="agent-import-intro">
              <span className="agent-import-icon"><Icon name="folder" size={20} /></span>
              <div><strong>{copy.githubTitle}</strong><p>{copy.githubDescription}</p></div>
            </div>
            <label className="agent-import-url">
              <span>{copy.githubUrl}</span>
              <div>
                <input aria-label={copy.githubUrl} type="url" value={githubUrl} onChange={(event) => setGithubUrl(event.target.value)} placeholder="https://github.com/owner/repository" />
                <button type="button" className="primary" disabled={inspecting || githubUrl.trim() === ""} onClick={() => void inspectGithub()}>
                  {inspecting ? copy.inspecting : copy.inspect}
                </button>
              </div>
            </label>
            <button type="button" className="agent-import-manual" onClick={() => setRegistrationMode("details")}>{copy.manual}</button>
          </div>
        ) : (
        <form id="agent-tool-registration" className="agent-tool-form" data-slot="agent-details-form" onSubmit={(event) => void submitRegistration(event)}>
          <div className="agent-import-detail-head span-2">
            <span><Icon name="check" size={15} /> {form.sourceRef ? copy.recognized : copy.manual}</span>
            <button type="button" onClick={() => setRegistrationMode("github")}>{copy.backToGithub}</button>
          </div>
          {inspection === null ? null : (
            <div className="agent-ai-prefill span-2" data-slot="agent-ai-prefill">
              <span className="agent-ai-prefill-icon"><Icon name="sparkles" size={17} /></span>
              <div><strong>{copy.aiFill}</strong><p>{copy.aiHint}</p></div>
              <button type="button" className="secondary" data-slot="agent-ai-prefill-action" disabled={aiFilling} onClick={() => void fillWithAi()}>
                <Icon name="sparkles" size={14} /> {aiFilling ? copy.aiFilling : copy.aiFill}
              </button>
            </div>
          )}
          <label>
            <span>{copy.displayName}</span>
            <input aria-label={copy.displayName} required value={form.displayName} onChange={(event) => updateForm("displayName", event.target.value)} />
          </label>
          <label>
            <span>{copy.slug}</span>
            <input aria-label={copy.slug} required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" value={form.slug} onChange={(event) => updateForm("slug", event.target.value)} placeholder="pi-coding-agent" />
          </label>
          <label className="span-2">
            <span>{copy.descriptionField}</span>
            <textarea aria-label={copy.descriptionField} required rows={3} value={form.description} onChange={(event) => updateForm("description", event.target.value)} />
          </label>
          <label>
            <span>{copy.category}</span>
            <select aria-label={copy.category} value={form.category} onChange={(event) => updateForm("category", event.target.value as AgentToolCategory)}>
              {CATEGORIES.map((item) => <option value={item} key={item}>{categoryLabels[item]}</option>)}
            </select>
          </label>
          <label>
            <span>{copy.status}</span>
            <select aria-label={copy.status} value={form.status} onChange={(event) => updateForm("status", event.target.value as AgentToolStatus)}>
              {STATUSES.map((item) => <option value={item} key={item}>{statusLabels[item]}</option>)}
            </select>
          </label>
          <label>
            <span>{copy.sourceType}</span>
            <select aria-label={copy.sourceType} value={form.sourceType} onChange={(event) => updateForm("sourceType", event.target.value as AgentToolSource["type"])}>
              {SOURCE_TYPES.map((item) => <option value={item} key={item}>{item === "github" ? "GitHub" : item === "npm" ? "npm" : "Web"}</option>)}
            </select>
          </label>
          <label>
            <span>{copy.sourceRef}</span>
            <input aria-label={copy.sourceRef} required value={form.sourceRef} onChange={(event) => updateForm("sourceRef", event.target.value)} placeholder="https://github.com/org/repo/tree/main/packages/tool" />
          </label>
          <label>
            <span>{copy.homepage}</span>
            <input aria-label={copy.homepage} type="url" value={form.homepage} onChange={(event) => updateForm("homepage", event.target.value)} />
          </label>
          <label>
            <span>{copy.packageName}</span>
            <input aria-label={copy.packageName} value={form.packageName} onChange={(event) => updateForm("packageName", event.target.value)} placeholder="@scope/package" />
          </label>
          <label className="span-2">
            <span>{copy.installCommand}</span>
            <input aria-label={copy.installCommand} value={form.installCommand} onChange={(event) => updateForm("installCommand", event.target.value)} placeholder="npm install @scope/package" />
          </label>
          <label>
            <span>{copy.tags}</span>
            <input aria-label={copy.tags} value={form.tags} onChange={(event) => updateForm("tags", event.target.value)} placeholder="coding-agent, runtime" />
            <small>{copy.commaHint}</small>
          </label>
          <label>
            <span>{copy.related}</span>
            <input aria-label={copy.related} value={form.relatedWorkflowFamilies} onChange={(event) => updateForm("relatedWorkflowFamilies", event.target.value)} placeholder="harness, review-loop" />
            <small>{copy.commaHint}</small>
          </label>
        </form>)}
      </Modal>

      <ToastFeedback tone="danger" message={error} />
    </section>
  );
}
