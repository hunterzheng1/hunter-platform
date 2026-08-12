"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";

import type {
  AgentTool,
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
    eyebrow: "Agent Tools",
    title: "Agent 工具",
    description: "登记可独立运行的 Agent Harness、运行时、编排器与开发环境，并保留精确来源路径。",
    register: "登记工具",
    search: "搜索 Agent 工具",
    allCategories: "全部分类",
    allSources: "全部来源",
    empty: "暂无匹配的 Agent 工具",
    dialogTitle: "登记 Agent 工具",
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
    save: "保存登记",
    saving: "保存中…",
    saved: "Agent 工具已登记。",
    tools: "个工具",
    exactSource: "精确来源",
    relatedShort: "工作流"
  } : {
    eyebrow: "Agent Tools",
    title: "Agent Tools",
    description: "Register runnable agent harnesses, runtimes, orchestrators and development environments while preserving exact source paths.",
    register: "Register tool",
    search: "Search Agent Tools",
    allCategories: "All categories",
    allSources: "All sources",
    empty: "No matching Agent Tools",
    dialogTitle: "Register Agent Tool",
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
    save: "Save registration",
    saving: "Saving…",
    saved: "Agent Tool registered.",
    tools: "tools",
    exactSource: "Exact source",
    relatedShort: "Workflows"
  };
  const categoryLabels: Record<AgentToolCategory, string> = zh ? {
    harness: "Harness",
    runtime: "运行时",
    orchestrator: "编排器",
    ade: "Agent 开发环境",
    cli: "命令行工具",
    framework: "框架"
  } : {
    harness: "Harness",
    runtime: "Runtime",
    orchestrator: "Orchestrator",
    ade: "Agent IDE",
    cli: "CLI",
    framework: "Framework"
  };

  const [tools, setTools] = useState<AgentTool[] | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<AgentToolCategory | "all">("all");
  const [sourceType, setSourceType] = useState<AgentToolSource["type"] | "all">("all");
  const [registerOpen, setRegisterOpen] = useState(false);
  const [form, setForm] = useState<ToolFormState>(EMPTY_FORM);
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
      setRegisterOpen(false);
      setForm(EMPTY_FORM);
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
      <header className="project-registry-hero agent-tool-hero">
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

      <div className="agent-tool-toolbar">
        <label className="agent-tool-search">
          <Icon name="search" size={16} />
          <input
            aria-label={copy.search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={copy.search}
          />
        </label>
        <select aria-label={zh ? "工具类型筛选" : "Filter by tool type"} value={category} onChange={(event) => setCategory(event.target.value as AgentToolCategory | "all")}>
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
              <article className="agent-tool-card" key={tool.tool_id}>
                <header>
                  <span className={`agent-tool-mark agent-tool-mark-${tool.category}`}><Icon name="agent" size={18} /></span>
                  <div>
                    <h2>{tool.displayName}</h2>
                    <code>{tool.slug}</code>
                  </div>
                  <span className={`agent-tool-status agent-tool-status-${tool.status}`}>{tool.status}</span>
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
        onClose={() => setRegisterOpen(false)}
        title={copy.dialogTitle}
        closeLabel={zh ? "关闭" : "Close"}
        wide
        footer={(
          <>
            <button type="button" className="secondary" onClick={() => setRegisterOpen(false)}>{copy.cancel}</button>
            <button type="submit" form="agent-tool-registration" className="primary" disabled={saving}>
              {saving ? copy.saving : copy.save}
            </button>
          </>
        )}
      >
        <form id="agent-tool-registration" className="agent-tool-form" onSubmit={(event) => void submitRegistration(event)}>
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
              {STATUSES.map((item) => <option value={item} key={item}>{item}</option>)}
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
        </form>
      </Modal>

      <ToastFeedback tone="danger" message={error} />
    </section>
  );
}
