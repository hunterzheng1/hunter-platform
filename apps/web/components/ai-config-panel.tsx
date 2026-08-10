"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";

import { ApiClientError, browserApi, type HunterApi } from "../lib/api";
import {
  AI_PROVIDER_PRESETS,
  createProviderId,
  findAiProviderPreset,
  type AiProviderPreset
} from "../lib/ai-provider-presets";
import { mockApi } from "../lib/mock-api";
import type {
  AiProviderConfig,
  AiProviderWithKeySet,
  AiQuotaUsage,
  CodexConnectionState,
  CodexLoginStart
} from "@hunter-harness/contracts";
import { useI18n } from "../lib/i18n";
import { EmptyState } from "./ui/EmptyState";
import { Icon } from "./ui/icons";
import { Modal } from "./ui/Modal";
import { PageHeader } from "./ui/PageHeader";
import { Skeleton } from "./ui/Skeleton";
import { useToast } from "./ui/Toast";

// demo 模式（NEXT_PUBLIC_HUNTER_HARNESS_DEMO=true）用 MockApiClient，不调真治理 API
function resolveApi(): HunterApi {
  return process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true" ? mockApi : browserApi();
}

// ── 纯前端 UI 版本（先设计，功能后续接入） ───────────────────
// 列表态：单选互斥启用 + toast 反馈 + 用量弹窗
// 详情态：精简字段（基本信息 + 接入配置 + 模型映射）+ sticky 右下角保存

type ApiFormat = "openai" | "anthropic" | "custom";

interface ProviderModel {
  id: string;
  displayModel: string; // 模型实际名称（展示）
  requestModel: string; // 实际请求模型（API 调用）
  inputCost: number; // 输入成本（每百万 tokens，USD）
  outputCost: number; // 输出成本
  cacheHitCost: number; // 缓存命中
  cacheCreateCost: number; // 缓存创建
}

interface ProviderDraft {
  provider_id: string;
  label: string; // 供应商名称
  note: string; // 备注
  website: string; // 官网链接
  apiKey: string; // API Key（前端占位，实际走 secret file）
  keySet: boolean; // 后端 secret file 是否已设置（GET /providers key_set，不回看真实 key）
  base_url: string; // 请求地址
  api_format: ApiFormat; // API 格式
  enabled: boolean; // 单选互斥：同时只一个 enabled
  models: ProviderModel[];
  selectedModelId: string; // 列表行选中的模型
}

interface UsageRecord {
  provider_id: string;
  model: string;
  date: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cost: number;
}

const uid = (): string => Math.random().toString(36).slice(2, 9);

function emptyModel(): ProviderModel {
  return { id: uid(), displayModel: "", requestModel: "", inputCost: 0, outputCost: 0, cacheHitCost: 0, cacheCreateCost: 0 };
}

function emptyProvider(id: string): ProviderDraft {
  const m = emptyModel();
  return {
    provider_id: id, label: "", note: "", website: "https://", apiKey: "", keySet: false,
    base_url: "https://", api_format: "openai", enabled: false, models: [m], selectedModelId: m.id,
  };
}

function providerFromPreset(preset: AiProviderPreset, id: string, enabled: boolean): ProviderDraft {
  return {
    provider_id: id,
    label: preset.label,
    note: preset.note,
    website: preset.website,
    apiKey: "",
    keySet: false,
    base_url: preset.baseUrl,
    api_format: preset.apiFormat,
    enabled,
    models: preset.models.map((item) => ({ ...item })),
    selectedModelId: ""
  };
}

function matchingPreset(provider: ProviderDraft): AiProviderPreset | null {
  const normalizedUrl = provider.base_url.replace(/\/$/, "");
  return AI_PROVIDER_PRESETS.find((preset) => preset.baseUrl.replace(/\/$/, "") === normalizedUrl) ??
    findAiProviderPreset(provider.provider_id.replace(/-(?:copy-)?[a-z0-9]+$/i, ""));
}

function providerVisual(provider: ProviderDraft): { initials: string; accent: string } {
  const preset = matchingPreset(provider);
  if (preset !== null) return { initials: preset.initials, accent: preset.accent };
  const words = (provider.label || provider.provider_id).split(/[\s_-]+/).filter(Boolean);
  const initials = words.slice(0, 2).map((word) => word[0]?.toUpperCase() ?? "").join("") || "AI";
  return { initials, accent: "#7086ff" };
}

function endpointLabel(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

function providerCanSave(provider: ProviderDraft, isNew: boolean): boolean {
  if (provider.label.trim() === "") return false;
  if (isNew && provider.apiKey.trim() === "") return false;
  try {
    const url = new URL(provider.base_url);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  } catch {
    return false;
  }
  const selected = provider.models.find((model) => model.id === provider.selectedModelId);
  return selected !== undefined && selected.requestModel.trim() !== "";
}

const API_FORMATS: ApiFormat[] = ["openai", "anthropic", "custom"];
const DEFAULT_API_KEY_ENV = "secret-file";

// ── 后端 AiProviderConfig（snake_case）↔ 前端 ProviderDraft（camelCase）转换 ──
function toDraft(p: AiProviderConfig & { key_set?: boolean }): ProviderDraft {
  return {
    provider_id: p.provider_id,
    label: p.label,
    note: p.note,
    website: p.website,
    apiKey: "",
    keySet: p.key_set ?? false,
    base_url: p.base_url,
    api_format: p.api_format,
    enabled: p.enabled,
    models: p.models.map((m) => ({
      id: m.id,
      displayModel: m.display_model,
      requestModel: m.request_model,
      inputCost: m.input_cost,
      outputCost: m.output_cost,
      cacheHitCost: m.cache_hit_cost,
      cacheCreateCost: m.cache_create_cost
    })),
    selectedModelId: p.selected_model_id ?? p.models[0]?.id ?? ""
  };
}

function fromDraft(d: ProviderDraft): {
  models: Array<{ id: string; display_model: string; request_model: string; input_cost: number; output_cost: number; cache_hit_cost: number; cache_create_cost: number }>;
  api_format: ApiFormat;
  note: string;
  website: string;
  base_url: string;
  model: string;
  selected_model_id: string | null;
} {
  const selected = d.models.find((m) => m.id === d.selectedModelId);
  return {
    models: d.models.map((m) => ({
      id: m.id, display_model: m.displayModel, request_model: m.requestModel,
      input_cost: m.inputCost, output_cost: m.outputCost, cache_hit_cost: m.cacheHitCost, cache_create_cost: m.cacheCreateCost
    })),
    api_format: d.api_format,
    note: d.note,
    website: d.website,
    base_url: d.base_url,
    model: selected?.requestModel ?? "",
    selected_model_id: d.selectedModelId || null
  };
}

function toUsageRecord(u: AiQuotaUsage): UsageRecord {
  return {
    provider_id: u.provider_id,
    model: u.model,
    date: u.date,
    requests: u.requests,
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheHitTokens: u.cache_hit_tokens,
    cost: u.cost
  };
}

const fmt = (n: number): string => new Intl.NumberFormat("en-US").format(n);

const EMPTY_CODEX_CONNECTION: CodexConnectionState = {
  status: "disconnected",
  auth_mode: null,
  email: null,
  plan_type: null,
  enabled: false,
  selected_model: null,
  models: [],
  error: null
};

function codexPlanLabel(plan: string | null): string {
  if (plan === null || plan === "unknown") return "ChatGPT 账号";
  const labels: Record<string, string> = {
    free: "ChatGPT Free",
    plus: "ChatGPT Plus",
    pro: "ChatGPT Pro",
    team: "ChatGPT Team",
    business: "ChatGPT Business",
    enterprise: "ChatGPT Enterprise"
  };
  return labels[plan.toLowerCase()] ?? `ChatGPT ${plan}`;
}

export function AiConfigPanel() {
  const { t } = useI18n();
  const toast = useToast();
  const [providers, setProviders] = useState<ProviderDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [revisions, setRevisions] = useState<Map<string, number>>(new Map());
  const revisionsRef = useRef<Map<string, number>>(new Map());
  // Keep ref in sync with state so async closures always read latest revision
  useEffect(() => { revisionsRef.current = revisions; }, [revisions]);
  const [usage, setUsage] = useState<UsageRecord[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [presetPickerOpen, setPresetPickerOpen] = useState(false);
  const [usageProviderId, setUsageProviderId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [codexConnection, setCodexConnection] = useState<CodexConnectionState>(EMPTY_CODEX_CONNECTION);
  const [codexLogin, setCodexLogin] = useState<CodexLoginStart | null>(null);
  const [codexBusy, setCodexBusy] = useState(false);

  useEffect(() => {
    const api = resolveApi();
    Promise.all([
      api.listAiProviders?.() ?? Promise.resolve({ items: [] as AiProviderWithKeySet[], default_provider: null }),
      api.getAiUsage?.() ?? Promise.resolve([] as AiQuotaUsage[]),
      api.getCodexConnection?.().catch(() => ({
        ...EMPTY_CODEX_CONNECTION,
        status: "unavailable" as const,
        error: "Codex 服务暂不可用，请稍后重试。"
      })) ?? Promise.resolve(EMPTY_CODEX_CONNECTION)
    ]).then(([list, u, codex]) => {
      setProviders(list.items.map((provider) => toDraft(provider)));
      setRevisions(new Map(list.items.map((p) => [p.provider_id, p.revision])));
      setUsage(u.map(toUsageRecord));
      setCodexConnection(codex);
    }).catch(() => {
      // 加载失败（未配 token / 服务器不可达）静默降级为空列表，不弹 danger toast——
      // token 缺失是预期状态（用户尚未配置），非错误；用户主动操作失败才提示
      setProviders([]);
      setUsage([]);
    }).finally(() => setLoading(false));
  }, [t]);

  useEffect(() => {
    if (codexLogin === null) return;
    const timer = window.setInterval(() => {
      const api = resolveApi();
      void api.getCodexConnection?.().then((connection) => {
        setCodexConnection(connection);
        if (connection.status === "connected") setCodexLogin(null);
      }).catch(() => undefined);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [codexLogin]);

  const editing = providers.find((p) => p.provider_id === editingId) ?? null;
  const codexConnected = codexConnection.status === "connected";
  const sourceCount = providers.length + (codexConnected ? 1 : 0);
  const enabledCount = providers.filter((p) => p.enabled).length + (codexConnection.enabled ? 1 : 0);
  const readyCount = providers.filter((p) => p.keySet).length + (codexConnected ? 1 : 0);
  const modelCount = providers.reduce((sum, provider) => sum + provider.models.length, 0)
    + (codexConnected ? codexConnection.models.length : 0);

  function patch(id: string, fn: (p: ProviderDraft) => ProviderDraft): void {
    setProviders((cur) => cur.map((p) => (p.provider_id === id ? fn(p) : p)));
  }

  async function reorder(draggedId: string, targetId: string): Promise<void> {
    if (draggedId === targetId) return;
    const from = providers.findIndex((p) => p.provider_id === draggedId);
    const to = providers.findIndex((p) => p.provider_id === targetId);
    if (from === -1 || to === -1) return;
    const next = [...providers];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return;
    next.splice(to, 0, moved);
    const prev = providers;
    setProviders(next);
    try {
      const api = resolveApi();
      await api.reorderAiProviders?.(next.map((p) => p.provider_id));
    } catch {
      setProviders(prev);
      toast.danger(t.aiConfig.saveFailed);
    }
  }

  // 单选互斥：后端 PATCH enabled=true 时联动其他 false（API-04）；前端乐观更新 + 失败回滚由 toast 提示
  // REVISION_CONFLICT 自动拉最新 revision 重试一次（乐观锁冲突兜底）
  async function toggleEnabled(id: string): Promise<void> {
    const target = providers.find((p) => p.provider_id === id);
    if (target === undefined) return;
    const newEnabled = !target.enabled;
    const prev = providers;
    const previousCodex = codexConnection;
    setProviders((current) => current.map((provider) => ({
      ...provider,
      enabled: provider.provider_id === id ? newEnabled : newEnabled ? false : provider.enabled
    })));
    if (newEnabled) {
      setCodexConnection((current) => ({ ...current, enabled: false }));
    }
    try {
      const api = resolveApi();
      const doUpdate = async (rev: number): Promise<void> => {
        const updated = await api.updateAiProvider?.(id, rev, { enabled: newEnabled });
        if (updated !== undefined) {
          setRevisions((cur) => { const m = new Map(cur); m.set(id, updated.revision); return m; });
          if (newEnabled) {
            setProviders((cur) => cur.map((p) => (p.provider_id === id ? p : { ...p, enabled: false })));
          }
        }
      };
      const rev = revisionsRef.current.get(id) ?? 1;
      try {
        await doUpdate(rev);
      } catch (err) {
        if (err instanceof ApiClientError && err.code === "REVISION_CONFLICT") {
          const fresh = await api.listAiProviders?.();
          const freshProvider = fresh?.items.find((p) => p.provider_id === id);
          if (freshProvider !== undefined) await doUpdate(freshProvider.revision);
          else throw err;
        } else {
          throw err;
        }
      }
    } catch {
      setProviders(prev);
      setCodexConnection(previousCodex);
      toast.danger(t.aiConfig.saveFailed);
    }
  }

  async function duplicate(id: string): Promise<void> {
    const src = providers.find((p) => p.provider_id === id);
    if (src === undefined) return;
    const newId = `${id}-copy-${uid()}`;
    const copy: ProviderDraft = {
      ...src,
      provider_id: newId,
      label: `${src.label} ${t.aiConfig.copySuffix}`,
      enabled: false,
      models: src.models.map((m) => ({ ...m, id: uid() })),
    };
    if (copy.models[0] !== undefined) copy.selectedModelId = copy.models[0].id;
    const payload = fromDraft(copy);
    try {
      const api = resolveApi();
      const created = await api.createAiProvider?.({
        provider_id: copy.provider_id,
        label: copy.label,
        enabled: copy.enabled,
        api_key_env: DEFAULT_API_KEY_ENV,
        ...payload
      });
      setProviders((cur) => [...cur, created ? toDraft(created) : copy]);
      if (created !== undefined) {
        setRevisions((cur) => { const m = new Map(cur); m.set(created.provider_id, created.revision); return m; });
      }
      toast.success(t.aiConfig.duplicated.replace("{provider}", src.label));
    } catch {
      toast.danger(t.aiConfig.saveFailed);
    }
  }

  async function testConnection(id: string): Promise<void> {
    const p = providers.find((x) => x.provider_id === id);
    try {
      const api = resolveApi();
      const res = await api.testAiProvider?.(id);
      if (res?.ok === true) {
        toast.success(t.aiConfig.testPassed.replace("{provider}", p?.label ?? ""));
      } else {
        toast.danger(t.aiConfig.saveFailed);
      }
    } catch {
      toast.danger(t.aiConfig.saveFailed);
    }
  }

  async function remove(id: string): Promise<void> {
    const target = providers.find((p) => p.provider_id === id);
    if (target === undefined) return;
    try {
      const api = resolveApi();
      await api.deleteAiProvider?.(id);
      setProviders((cur) => cur.filter((p) => p.provider_id !== id));
      setConfirmDeleteId(null);
      toast.info(t.aiConfig.deletedNotice.replace("{provider}", target.label));
    } catch {
      toast.danger(t.aiConfig.saveFailed);
    }
  }

  function addProvider(): void {
    setPresetPickerOpen(true);
  }

  function selectPreset(preset: AiProviderPreset | null): void {
    const id = preset === null
      ? `provider-${uid()}`
      : createProviderId(preset.id, providers.map((provider) => provider.provider_id));
    const draft = preset === null
      ? emptyProvider(id)
      : providerFromPreset(preset, id, providers.length === 0);
    setProviders((current) => [...current, draft]);
    setPresetPickerOpen(false);
    setEditingId(id);
  }

  function closeDetail(): void {
    if (editingId !== null && !revisionsRef.current.has(editingId)) {
      setProviders((current) => current.filter((provider) => provider.provider_id !== editingId));
    }
    setEditingId(null);
  }

  async function saveDetail(): Promise<void> {
    if (editing === null) return;
    const api = resolveApi();
    const base = fromDraft(editing);
    const payload = editing.apiKey !== "" ? { ...base, api_key: editing.apiKey } : base;
    const nextKeySet = editing.apiKey !== "" ? true : editing.keySet;
    const applySavedProvider = (saved: AiProviderConfig): void => {
      const next = { ...toDraft(saved), keySet: nextKeySet };
      setProviders((current) => current.map((provider) => {
        if (provider.provider_id === editing.provider_id) return next;
        return saved.enabled ? { ...provider, enabled: false } : provider;
      }));
      if (saved.enabled) setCodexConnection((current) => ({ ...current, enabled: false }));
    };
    try {
      if (!revisionsRef.current.has(editing.provider_id)) {
        const created = await api.createAiProvider?.({
          provider_id: editing.provider_id,
          label: editing.label,
          enabled: editing.enabled,
          is_default: editing.enabled,
          api_key_env: DEFAULT_API_KEY_ENV,
          ...payload
        });
        if (created !== undefined) {
          setRevisions((cur) => { const m = new Map(cur); m.set(editing.provider_id, created.revision); return m; });
          applySavedProvider(created);
        }
        toast.success(t.aiConfig.saveSuccess.replace("{provider}", editing.label || editing.provider_id));
        setEditingId(null);
        return;
      }
      // update 分支：遇 REVISION_CONFLICT 自动 refresh 最新 revision 重试一次（乐观锁冲突兜底）
      const applyUpdate = async (rev: number): Promise<void> => {
        const updated = await api.updateAiProvider?.(editing.provider_id, rev, payload);
        if (updated !== undefined) {
          setRevisions((cur) => { const m = new Map(cur); m.set(editing.provider_id, updated.revision); return m; });
          applySavedProvider(updated);
        }
      };
      const rev = revisionsRef.current.get(editing.provider_id) ?? 1;
      try {
        await applyUpdate(rev);
      } catch (err) {
        if (err instanceof ApiClientError && err.code === "REVISION_CONFLICT") {
          // 本地 revision 落后（如 setEnabledExclusive 联动未同步本地），拉最新 revision 重试一次
          const fresh = await api.listAiProviders?.();
          const freshProvider = fresh?.items.find((p) => p.provider_id === editing.provider_id);
          if (freshProvider === undefined) throw err;
          await applyUpdate(freshProvider.revision);
        } else {
          throw err;
        }
      }
      toast.success(t.aiConfig.saveSuccess.replace("{provider}", editing.label || editing.provider_id));
      setEditingId(null);
    } catch {
      toast.danger(t.aiConfig.saveFailed);
    }
  }

  // REVISION_CONFLICT 自动拉最新 revision 重试一次（乐观锁冲突兜底）
  async function selectModel(id: string, mid: string): Promise<void> {
    const prev = providers;
    patch(id, (cur) => ({ ...cur, selectedModelId: mid }));
    try {
      const api = resolveApi();
      const doUpdate = async (rev: number): Promise<void> => {
        const updated = await api.updateAiProvider?.(id, rev, { selected_model_id: mid });
        if (updated !== undefined) {
          setRevisions((cur) => { const m = new Map(cur); m.set(id, updated.revision); return m; });
        }
      };
      const rev = revisionsRef.current.get(id) ?? 1;
      try {
        await doUpdate(rev);
      } catch (err) {
        if (err instanceof ApiClientError && err.code === "REVISION_CONFLICT") {
          const fresh = await api.listAiProviders?.();
          const freshProvider = fresh?.items.find((p) => p.provider_id === id);
          if (freshProvider !== undefined) await doUpdate(freshProvider.revision);
          else throw err;
        } else {
          throw err;
        }
      }
    } catch {
      setProviders(prev);
      toast.danger(t.aiConfig.saveFailed);
    }
  }

  async function startCodexLogin(): Promise<void> {
    setPresetPickerOpen(false);
    setCodexBusy(true);
    try {
      const login = await resolveApi().startCodexLogin?.();
      if (login !== undefined) setCodexLogin(login);
    } catch {
      toast.danger("无法启动 ChatGPT 授权，请稍后重试。");
    } finally {
      setCodexBusy(false);
    }
  }

  async function cancelCodexLogin(): Promise<void> {
    if (codexLogin === null) return;
    setCodexBusy(true);
    try {
      await resolveApi().cancelCodexLogin?.(codexLogin.login_id);
      setCodexLogin(null);
    } catch {
      toast.danger("取消授权失败，请稍后重试。");
    } finally {
      setCodexBusy(false);
    }
  }

  async function selectCodexModel(model: string): Promise<void> {
    const previous = codexConnection;
    setCodexConnection((current) => ({ ...current, selected_model: model }));
    try {
      const updated = await resolveApi().updateCodexConnection?.({ selected_model: model });
      if (updated !== undefined) setCodexConnection(updated);
    } catch {
      setCodexConnection(previous);
      toast.danger("Codex 模型保存失败。");
    }
  }

  async function toggleCodexEnabled(): Promise<void> {
    if (codexConnection.status !== "connected") return;
    const previousCodex = codexConnection;
    const previousProviders = providers;
    const enabled = !codexConnection.enabled;
    setCodexConnection((current) => ({ ...current, enabled }));
    if (enabled) {
      setProviders((current) => current.map((provider) => ({ ...provider, enabled: false })));
    }
    try {
      const updated = await resolveApi().updateCodexConnection?.({ enabled });
      if (updated !== undefined) setCodexConnection(updated);
    } catch {
      setCodexConnection(previousCodex);
      setProviders(previousProviders);
      toast.danger("默认模型来源保存失败。");
    }
  }

  async function testCodexConnection(): Promise<void> {
    setCodexBusy(true);
    try {
      const result = await resolveApi().testCodexConnection?.();
      if (result?.ok === true) toast.success(`Codex 连接正常，当前模型：${result.model ?? "自动选择"}`);
      else toast.danger("Codex 连接测试未通过。");
    } catch {
      toast.danger("Codex 连接测试未通过。");
    } finally {
      setCodexBusy(false);
    }
  }

  async function disconnectCodex(): Promise<void> {
    setCodexBusy(true);
    try {
      await resolveApi().disconnectCodex?.();
      setCodexConnection(EMPTY_CODEX_CONNECTION);
      setCodexLogin(null);
      toast.info("已解除 Codex 账号连接。");
    } catch {
      toast.danger("解除 Codex 账号连接失败。");
    } finally {
      setCodexBusy(false);
    }
  }

  async function copyCodexCode(): Promise<void> {
    if (codexLogin === null) return;
    try {
      await navigator.clipboard.writeText(codexLogin.user_code);
      toast.success("验证码已复制。");
    } catch {
      toast.info(`验证码：${codexLogin.user_code}`);
    }
  }

  if (editing !== null) {
    return (
      <ProviderDetail
        draft={editing}
        isNew={!revisions.has(editing.provider_id)}
        t={t}
        onChange={(fn) => patch(editing.provider_id, fn)}
        onBack={closeDetail}
        onSave={saveDetail}
      />
    );
  }

  const confirmTarget = providers.find((p) => p.provider_id === confirmDeleteId) ?? null;
  const usageProvider = providers.find((p) => p.provider_id === usageProviderId) ?? null;

  return (
    <section className="stack governance-page page-module-v2 ai-provider-workbench">
      <PageHeader
        eyebrow={t.aiConfig.eyebrow}
        title={t.aiConfig.title}
        lede="统一管理 API 厂商与 Codex 账号。连接信息表示来源可用；全局只能启用一个来源，其默认模型将用于平台 AI 功能。"
        actions={
          <>
            <span className="status status-clear">{enabledCount} {t.aiConfig.enabled}</span>
            <button type="button" className="prominent-action" onClick={addProvider}>
              <Icon name="plus" size={15} /> {t.aiConfig.addProvider}
            </button>
          </>
        }
      />

      <div className="provider-summary-strip" aria-label={t.aiConfig.configuredProviders}>
        <article><span>{t.aiConfig.configuredProviders}</span><strong>{sourceCount}</strong><small>API 密钥或 ChatGPT 授权</small></article>
        <article><span>{t.aiConfig.enabledProviders}</span><strong>{enabledCount}</strong><small>{enabledCount === 1 ? "平台当前默认来源" : "请选择一个默认来源"}</small></article>
        <article><span>{t.aiConfig.keysReady}</span><strong>{readyCount}</strong><small>{sourceCount === 0 ? "—" : `${Math.round((readyCount / sourceCount) * 100)}%`}</small></article>
        <article><span>{t.aiConfig.modelsConfigured}</span><strong>{modelCount}</strong><small>{t.aiConfig.modelMapping}</small></article>
      </div>

      <div className="panel provider-table rise-in">
        <div className="panel-title">
          <div><h2>{t.aiConfig.providers}</h2><p>启用一个来源后，其默认模型将供平台统一使用。</p></div>
          <span>{sourceCount}</span>
        </div>
        {loading ? (
          <Skeleton variant="table" lines={4} />
        ) : sourceCount === 0 ? (
          <EmptyState
            icon="sparkles"
            title={t.aiConfig.noProviders}
            action={
              <button type="button" className="prominent-action" onClick={addProvider}>
                <Icon name="plus" size={15} /> {t.aiConfig.addProvider}
              </button>
            }
          />
        ) : (
          <div className="provider-rows">
            {providers.map((p) => (
              <ProviderRow
                key={p.provider_id}
                provider={p}
                t={t}
                isDragging={draggingId === p.provider_id}
                onDragStart={() => setDraggingId(p.provider_id)}
                onDrop={() => {
                  if (draggingId !== null) void reorder(draggingId, p.provider_id);
                  setDraggingId(null);
                }}
                onDragEnd={() => setDraggingId(null)}
                onToggleEnabled={() => void toggleEnabled(p.provider_id)}
                onSelectModel={(mid) => void selectModel(p.provider_id, mid)}
                onEdit={() => setEditingId(p.provider_id)}
                onDuplicate={() => duplicate(p.provider_id)}
                onTest={() => void testConnection(p.provider_id)}
                onUsage={() => setUsageProviderId(p.provider_id)}
                onDelete={() => setConfirmDeleteId(p.provider_id)}
              />
            ))}
            {codexConnected ? (
              <CodexProviderRow
                connection={codexConnection}
                busy={codexBusy}
                onToggleEnabled={() => void toggleCodexEnabled()}
                onSelectModel={(model) => void selectCodexModel(model)}
                onTest={() => void testCodexConnection()}
                onDisconnect={() => void disconnectCodex()}
              />
            ) : null}
          </div>
        )}
      </div>

      <ProviderPresetModal
        open={presetPickerOpen}
        t={t}
        onClose={() => setPresetPickerOpen(false)}
        onSelect={selectPreset}
        onSelectCodex={() => void startCodexLogin()}
        codexConnected={codexConnected}
      />

      <Modal
        open={codexLogin !== null}
        onClose={() => void cancelCodexLogin()}
        title="连接 Codex"
        closeLabel={t.common.cancel}
      >
        {codexLogin !== null ? (
          <div className="codex-device-login">
            <div className="codex-device-login-intro">
              <span className="provider-mark codex">CX</span>
              <div><strong>使用 ChatGPT 账号授权</strong><p>在 OpenAI 官方页面登录，然后输入下面的一次性验证码。</p></div>
            </div>
            <strong className="codex-device-code">{codexLogin.user_code}</strong>
            <div>
              <a className="prominent-action" href={codexLogin.verification_url} target="_blank" rel="noreferrer">打开授权页面</a>
              <button type="button" className="secondary" onClick={() => void copyCodexCode()}>复制验证码</button>
              <button type="button" className="secondary" disabled={codexBusy} onClick={() => void cancelCodexLogin()}>取消</button>
            </div>
            <small>授权完成后会自动加入模型来源列表；平台不会读取或展示登录令牌。</small>
          </div>
        ) : null}
      </Modal>

      {usageProvider !== null ? (
        <UsageModal
          provider={usageProvider}
          records={usage.filter((r) => r.provider_id === usageProvider.provider_id)}
          t={t}
          onClose={() => setUsageProviderId(null)}
        />
      ) : null}

      <Modal
        open={confirmTarget !== null}
        onClose={() => setConfirmDeleteId(null)}
        title={confirmTarget !== null ? t.aiConfig.deleteConfirm.replace("{provider}", confirmTarget.label) : ""}
        closeLabel={t.common.cancel}
        footer={
          confirmTarget !== null ? (
            <>
              <button type="button" onClick={() => setConfirmDeleteId(null)}>{t.common.cancel}</button>
              <button type="button" className="danger" onClick={() => void remove(confirmTarget.provider_id)}>{t.common.delete}</button>
            </>
          ) : undefined
        }
      >
        <p>{t.aiConfig.deleteHint}</p>
      </Modal>
    </section>
  );
}

function ProviderPresetModal({
  open,
  t,
  onClose,
  onSelect,
  onSelectCodex,
  codexConnected
}: {
  open: boolean;
  t: ReturnType<typeof useI18n>["t"];
  onClose: () => void;
  onSelect: (preset: AiProviderPreset | null) => void;
  onSelectCodex: () => void;
  codexConnected: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t.aiConfig.chooseProvider}
      closeLabel={t.common.cancel}
      wide
    >
      <div className="provider-preset-picker">
        <header>
          <p>{t.aiConfig.chooseProviderHint}</p>
          <span><Icon name="shield" size={14} /> {t.aiConfig.presetProviders}</span>
        </header>
        <div className="provider-preset-grid">
          <button
            type="button"
            className="provider-preset-card codex-preset-card"
            style={{ "--provider-accent": "#10a37f" } as CSSProperties}
            onClick={onSelectCodex}
            disabled={codexConnected}
          >
            <span className="provider-mark">CX</span>
            <span className="provider-preset-copy">
              <strong>Codex（ChatGPT 账号）</strong>
              <small>通过 OpenAI 官方账号授权接入，无需填写 API Key。</small>
              <code>模型由当前账号动态提供</code>
            </span>
            <span className="provider-preset-ready"><Icon name="shield" size={12} /> {codexConnected ? "已连接" : "官方账号授权"}</span>
            <Icon name="chevron-right" size={15} className="provider-preset-arrow" />
          </button>
          {AI_PROVIDER_PRESETS.map((preset) => (
            <button
              type="button"
              key={preset.id}
              className="provider-preset-card"
              style={{ "--provider-accent": preset.accent } as CSSProperties}
              onClick={() => onSelect(preset)}
            >
              <span className="provider-mark">{preset.initials}</span>
              <span className="provider-preset-copy">
                <strong>{preset.label}</strong>
                <small>{preset.description}</small>
                <code>{t.aiConfig.modelOptions.replace("{count}", String(preset.models.length))}</code>
              </span>
              <span className="provider-preset-ready"><Icon name="check" size={12} /> {t.aiConfig.presetReady}</span>
              <Icon name="chevron-right" size={15} className="provider-preset-arrow" />
            </button>
          ))}
        </div>
        <button type="button" className="provider-custom-option" onClick={() => onSelect(null)}>
          <span className="provider-mark custom"><Icon name="settings" size={17} /></span>
          <span><strong>{t.aiConfig.customProvider}</strong><small>{t.aiConfig.customProviderHint}</small></span>
          <Icon name="chevron-right" size={15} />
        </button>
      </div>
    </Modal>
  );
}

// ── 列表行 ──────────────────────────────────────────────────
function CodexProviderRow({
  connection,
  busy,
  onToggleEnabled,
  onSelectModel,
  onTest,
  onDisconnect
}: {
  connection: CodexConnectionState;
  busy: boolean;
  onToggleEnabled: () => void;
  onSelectModel: (model: string) => void;
  onTest: () => void;
  onDisconnect: () => void;
}) {
  return (
    <div
      className="provider-row codex-provider-row"
      data-model-source="codex"
      style={{ "--provider-accent": "#10a37f" } as CSSProperties}
    >
      <span className="drag-handle codex-source-lock" title="账号授权来源固定在列表中" aria-hidden>
        <Icon name="shield" size={14} />
      </span>
      <span className="provider-mark provider-row-mark">CX</span>
      <div className="provider-row-main">
        <div className="provider-row-title">
          <strong>Codex</strong>
          <span className="key-badge set">ChatGPT 授权</span>
        </div>
        <small>{connection.email ?? "ChatGPT 账号"} · {codexPlanLabel(connection.plan_type)}</small>
      </div>

      <label className="provider-model-select codex-model-picker">
        <span>默认模型</span>
        <select
          aria-label="Codex 默认模型"
          className="codex-model-select"
          data-slot="codex-model-select"
          value={connection.selected_model ?? ""}
          onChange={(event) => onSelectModel(event.target.value)}
          disabled={connection.models.length === 0 || busy}
        >
          {connection.models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.display_name}{model.is_default ? "（账号推荐）" : ""}
            </option>
          ))}
        </select>
      </label>

      <div className="provider-key-state">
        <span>连接状态</span>
        <strong className="key-badge set"><Icon name="check" size={12} /> 已连接</strong>
      </div>

      <button
        type="button"
        className={`toggle-pill ${connection.enabled ? "on" : "off"}`}
        onClick={onToggleEnabled}
        disabled={busy}
        title={connection.enabled ? "已启用" : "未启用"}
      >
        <span className="toggle-knob" />
        <span className="toggle-label">{connection.enabled ? "已启用" : "未启用"}</span>
      </button>

      <div className="provider-row-actions">
        <button type="button" className="provider-action primary-action" disabled={busy} onClick={onTest}>
          <Icon name="zap" size={13} /> 测试连接
        </button>
        <button type="button" className="provider-action danger-action" disabled={busy} onClick={onDisconnect}>
          解除连接
        </button>
      </div>
    </div>
  );
}

interface ProviderRowProps {
  provider: ProviderDraft;
  t: ReturnType<typeof useI18n>["t"];
  isDragging: boolean;
  onDragStart: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
  onToggleEnabled: () => void;
  onSelectModel: (modelId: string) => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onTest: () => void;
  onUsage: () => void;
  onDelete: () => void;
}

function ProviderRow(props: ProviderRowProps) {
  const { provider: p, t } = props;
  const selectedModel = p.models.find((m) => m.id === p.selectedModelId) ?? p.models[0] ?? null;
  const visual = providerVisual(p);

  return (
    <div
      className={`provider-row${props.isDragging ? " dragging" : ""}`}
      style={{ "--provider-accent": visual.accent } as CSSProperties}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); props.onDrop(); }}
    >
      <span
        className="drag-handle"
        draggable
        onDragStart={(e) => { if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", p.provider_id); } props.onDragStart(); }}
        onDragEnd={props.onDragEnd}
        aria-hidden
      ><Icon name="grip" size={14} /></span>
      <span className="provider-mark provider-row-mark">{visual.initials}</span>
      <div className="provider-row-main">
        <div className="provider-row-title">
          <strong>{p.label || p.provider_id}</strong>
          {p.api_format === "openai" ? null : <span className="key-badge not-set">{t.aiConfig.providerNotSupported}</span>}
        </div>
        <small>{p.note || endpointLabel(p.base_url)}</small>
      </div>

      <label className="provider-model-select">
        <span>{t.aiConfig.activeModel}</span>
        <select value={selectedModel?.id ?? ""} onChange={(e) => props.onSelectModel(e.target.value)} disabled={p.models.length === 0}>
          {p.models.length === 0 ? <option value="">{t.aiConfig.noModels}</option> : null}
          {p.models.map((m) => (
            <option key={m.id} value={m.id}>{m.displayModel || m.requestModel}</option>
          ))}
        </select>
      </label>

      <div className="provider-key-state">
        <span>{t.aiConfig.apiKey}</span>
        <strong className={`key-badge ${p.keySet ? "set" : "not-set"}`}><Icon name={p.keySet ? "check" : "warning"} size={12} /> {p.keySet ? t.aiConfig.keySet : t.aiConfig.keyNotSet}</strong>
      </div>

      <button
        type="button"
        className={`toggle-pill ${p.enabled ? "on" : "off"}`}
        onClick={props.onToggleEnabled}
        title={p.enabled ? t.aiConfig.enabled : t.aiConfig.disabled}
      >
        <span className="toggle-knob" />
        <span className="toggle-label">{p.enabled ? t.aiConfig.enabled : t.aiConfig.disabled}</span>
      </button>

      <div className="provider-row-actions">
        <button type="button" className="provider-action primary-action" onClick={props.onEdit} title={t.common.edit}><Icon name="edit" size={13} /> {t.common.edit}</button>
        <button type="button" className="provider-action" onClick={props.onTest} title={t.aiConfig.testConnection}><Icon name="zap" size={13} /> {t.aiConfig.testConnection}</button>
        <details className="provider-row-menu">
          <summary aria-label={t.aiConfig.moreActions} title={t.aiConfig.moreActions}><Icon name="settings" size={14} /></summary>
          <div>
            <button type="button" onClick={props.onUsage}>{t.aiConfig.usage}</button>
            <button type="button" onClick={props.onDuplicate}>{t.aiConfig.duplicate}</button>
            <button type="button" className="danger" onClick={props.onDelete}>{t.common.delete}</button>
          </div>
        </details>
      </div>
    </div>
  );
}

// ── 详情编辑态 ──────────────────────────────────────────────
interface ProviderDetailProps {
  draft: ProviderDraft;
  isNew: boolean;
  t: ReturnType<typeof useI18n>["t"];
  onChange: (fn: (p: ProviderDraft) => ProviderDraft) => void;
  onBack: () => void;
  onSave: () => void;
}

function ProviderDetail(props: ProviderDetailProps) {
  const { draft: p, t, onChange } = props;
  const [showKey, setShowKey] = useState(false);
  const preset = matchingPreset(p);
  const visual = providerVisual(p);
  const selectedModel = p.models.find((model) => model.id === p.selectedModelId) ?? null;
  const canSave = providerCanSave(p, props.isNew);

  function setField<K extends keyof ProviderDraft>(key: K, value: ProviderDraft[K]): void {
    onChange((cur) => ({ ...cur, [key]: value }));
  }
  function setModel(id: string, fn: (m: ProviderModel) => ProviderModel): void {
    onChange((cur) => ({ ...cur, models: cur.models.map((m) => (m.id === id ? fn(m) : m)) }));
  }
  function addModel(): void {
    const m = emptyModel();
    onChange((cur) => ({ ...cur, models: [...cur.models, m], selectedModelId: cur.selectedModelId || m.id }));
  }
  function removeModel(id: string): void {
    onChange((cur) => {
      const models = cur.models.filter((m) => m.id !== id);
      const selectedModelId = cur.selectedModelId === id ? (models[0]?.id ?? "") : cur.selectedModelId;
      return { ...cur, models, selectedModelId };
    });
  }

  return (
    <section
      className="stack governance-page provider-detail provider-detail-v2"
      style={{ "--provider-accent": visual.accent } as CSSProperties}
    >
      <header className="panel provider-detail-header">
        <button type="button" className="back-button" onClick={props.onBack} title={t.common.back} aria-label={t.common.back}><Icon name="back" size={15} /></button>
        <span className="provider-mark provider-detail-mark">{visual.initials}</span>
        <div>
          <p className="eyebrow">{props.isNew ? t.aiConfig.newProvider : t.aiConfig.editProvider}</p>
          <h1>{p.label || t.aiConfig.newProvider}</h1>
          <p>{preset?.description ?? t.aiConfig.customProviderHint}</p>
        </div>
        <span className={`key-badge ${p.keySet ? "set" : "not-set"}`}>{p.keySet ? t.aiConfig.keySet : t.aiConfig.keyNotSet}</span>
      </header>

      <main className="provider-detail-shell">
        <article className="panel provider-quick-connect">
          <div className="provider-quick-copy">
            <span className="provider-quick-icon"><Icon name="shield" size={18} /></span>
            <div>
              <p className="eyebrow">{t.aiConfig.quickConnect}</p>
              <h2>{t.aiConfig.apiKey}</h2>
              <p>{props.isNew && preset !== null ? t.aiConfig.quickConnectHint : t.aiConfig.replaceKeyHint}</p>
            </div>
          </div>
          <label className="provider-key-primary">
            <span>{t.aiConfig.apiKey}</span>
            <div className="api-key-input">
              <input
                autoFocus={props.isNew}
                type={showKey ? "text" : "password"}
                value={p.apiKey}
                onChange={(event) => setField("apiKey", event.target.value)}
                placeholder={t.aiConfig.apiKeyPlaceholder}
              />
              <button type="button" className="icon-action" onClick={() => setShowKey((value) => !value)} aria-label={t.aiConfig.toggleKey} title={t.aiConfig.toggleKey}><Icon name={showKey ? "eye-off" : "eye"} size={15} /></button>
            </div>
            <small>{p.keySet ? t.aiConfig.replaceKeyHint : t.aiConfig.apiKeyHint}</small>
          </label>
          <div className="provider-quick-options">
            <label className="provider-primary-model">
              <span>{t.aiConfig.selectModel}</span>
              <select
                aria-label={t.aiConfig.selectModel}
                value={p.selectedModelId}
                onChange={(event) => setField("selectedModelId", event.target.value)}
              >
                <option value="">{t.aiConfig.selectModelPlaceholder}</option>
                {p.models.map((model) => (
                  <option key={model.id} value={model.id}>{model.displayModel || model.requestModel}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="provider-quick-facts">
            <span><small>{t.aiConfig.endpoint}</small><strong>{endpointLabel(p.base_url)}</strong></span>
            <span><small>{t.aiConfig.activeModel}</small><strong>{selectedModel?.displayModel || selectedModel?.requestModel || "—"}</strong></span>
            <span><small>{t.aiConfig.apiFormat}</small><strong>{t.aiConfig.apiFormatLabels[p.api_format] ?? p.api_format}</strong></span>
          </div>
        </article>

        <details className="panel provider-advanced-settings">
          <summary>
            <span className="provider-settings-icon"><Icon name="settings" size={16} /></span>
            <span><strong>{t.aiConfig.advancedSettings}</strong><small>{t.aiConfig.advancedSettingsHint}</small></span>
            <Icon name="chevron-right" size={15} className="provider-settings-chevron" />
          </summary>
          <div className="provider-advanced-content form-grid form-grid-compact">
            <label>{t.aiConfig.provider}<input value={p.label} onChange={(event) => setField("label", event.target.value)} placeholder={t.aiConfig.providerPlaceholder} /></label>
            <label>{t.aiConfig.note}<input value={p.note} onChange={(event) => setField("note", event.target.value)} placeholder={t.aiConfig.notePlaceholder} /></label>
            <label className="span-2">{t.aiConfig.website}<input value={p.website} onChange={(event) => setField("website", event.target.value)} placeholder="https://" /></label>
            <label className="span-2">{t.aiConfig.baseUrl}<input value={p.base_url} onChange={(event) => setField("base_url", event.target.value)} placeholder="https://" /></label>
            <label>{t.aiConfig.apiFormat}
              <select value={p.api_format} onChange={(event) => setField("api_format", event.target.value as ApiFormat)}>
                {API_FORMATS.map((format) => <option key={format} value={format}>{t.aiConfig.apiFormatLabels[format] ?? format}</option>)}
              </select>
            </label>
          </div>
        </details>

        <details className="panel provider-advanced-settings provider-model-settings">
          <summary>
            <span className="provider-settings-icon"><Icon name="layers" size={16} /></span>
            <span><strong>{t.aiConfig.modelSettings}</strong><small>{t.aiConfig.modelSettingsHint}</small></span>
            <span className="provider-model-count">{p.models.length}</span>
            <Icon name="chevron-right" size={15} className="provider-settings-chevron" />
          </summary>
          <div className="provider-model-settings-content">
            <div className="provider-model-settings-head">
              <p>{t.aiConfig.modelMapping}</p>
              <button type="button" className="add-model-btn" onClick={addModel}><Icon name="plus" size={14} /> {t.aiConfig.addModel}</button>
            </div>
            <div className="model-mapping-list">
              {p.models.length === 0 ? <EmptyState icon="box" title={t.aiConfig.noModels} /> : null}
              {p.models.map((model) => (
                <div key={model.id} className="model-mapping-card">
                  <div className="model-mapping-head">
                    <label>{t.aiConfig.displayModel}<input value={model.displayModel} onChange={(event) => setModel(model.id, (current) => ({ ...current, displayModel: event.target.value }))} placeholder={t.aiConfig.displayModelPh} /></label>
                    <label>{t.aiConfig.requestModel}<input value={model.requestModel} onChange={(event) => setModel(model.id, (current) => ({ ...current, requestModel: event.target.value }))} placeholder={t.aiConfig.requestModelPh} /></label>
                    <button type="button" className="icon-action danger" onClick={() => removeModel(model.id)} title={t.common.delete} aria-label={t.common.delete}><Icon name="close" size={14} /></button>
                  </div>
                  <div className="pricing-grid">
                    <label className="pricing-cell">{t.aiConfig.inputCost}<input type="number" min={0} step={0.01} value={model.inputCost} onChange={(event) => setModel(model.id, (current) => ({ ...current, inputCost: Number(event.target.value) }))} /><span>$/M</span></label>
                    <label className="pricing-cell">{t.aiConfig.outputCost}<input type="number" min={0} step={0.01} value={model.outputCost} onChange={(event) => setModel(model.id, (current) => ({ ...current, outputCost: Number(event.target.value) }))} /><span>$/M</span></label>
                    <label className="pricing-cell">{t.aiConfig.cacheHitCost}<input type="number" min={0} step={0.01} value={model.cacheHitCost} onChange={(event) => setModel(model.id, (current) => ({ ...current, cacheHitCost: Number(event.target.value) }))} /><span>$/M</span></label>
                    <label className="pricing-cell">{t.aiConfig.cacheCreateCost}<input type="number" min={0} step={0.01} value={model.cacheCreateCost} onChange={(event) => setModel(model.id, (current) => ({ ...current, cacheCreateCost: Number(event.target.value) }))} /><span>$/M</span></label>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </details>
      </main>

      <footer className="provider-detail-footer provider-detail-footer-v2">
        <div>
          <span>{canSave ? endpointLabel(p.base_url) : t.aiConfig.completeRequiredFields}</span>
          <strong>{selectedModel?.requestModel ?? "—"}</strong>
        </div>
        <button type="button" className="secondary" onClick={props.onBack}>{t.common.cancel}</button>
        <button type="button" className="prominent-action" disabled={!canSave} onClick={props.onSave}><Icon name="check" size={14} /> {t.common.save}</button>
      </footer>
    </section>
  );
}

// ── 用量弹窗 ────────────────────────────────────────────────
interface UsageModalProps {
  provider: ProviderDraft;
  records: UsageRecord[];
  t: ReturnType<typeof useI18n>["t"];
  onClose: () => void;
}

function UsageModal(props: UsageModalProps) {
  const { provider: p, records, t } = props;
  const totalRequests = records.reduce((s, r) => s + r.requests, 0);
  const totalTokens = records.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
  const totalCost = records.reduce((s, r) => s + r.cost, 0);

  // 按模型聚合
  const byModel = new Map<string, { requests: number; tokens: number; cost: number }>();
  for (const r of records) {
    const cur = byModel.get(r.model) ?? { requests: 0, tokens: 0, cost: 0 };
    cur.requests += r.requests;
    cur.tokens += r.inputTokens + r.outputTokens;
    cur.cost += r.cost;
    byModel.set(r.model, cur);
  }
  // 按日期聚合（升序）
  const byDate = new Map<string, { requests: number; tokens: number; cost: number }>();
  for (const r of records) {
    const cur = byDate.get(r.date) ?? { requests: 0, tokens: 0, cost: 0 };
    cur.requests += r.requests;
    cur.tokens += r.inputTokens + r.outputTokens;
    cur.cost += r.cost;
    byDate.set(r.date, cur);
  }
  const dateRows = Array.from(byDate.entries()).sort(([a], [b]) => (a < b ? -1 : 1));
  const maxDayTokens = dateRows.reduce((m, [, v]) => Math.max(m, v.tokens), 1);

  return (
    <Modal
      open
      onClose={props.onClose}
      title={<>{p.label} · {t.aiConfig.usageStats}</>}
      closeLabel={t.common.cancel}
      wide
    >
      <div className="usage-modal-body">
        <div className="usage-overview">
          <article><strong>{fmt(totalRequests)}</strong><span>{t.aiConfig.requests}</span></article>
          <article><strong>{fmt(totalTokens)}</strong><span>{t.aiConfig.tokens}</span></article>
          <article><strong>${totalCost.toFixed(2)}</strong><span>{t.aiConfig.cost}</span></article>
          <article><strong>{records.length}</strong><span>{t.aiConfig.records}</span></article>
        </div>

        <div className="usage-section">
          <h3>{t.aiConfig.byModel}</h3>
          <div className="usage-table">
            <div className="usage-table-head">
              <span>{t.aiConfig.model}</span><span>{t.aiConfig.requests}</span><span>{t.aiConfig.tokens}</span><span>{t.aiConfig.cost}</span>
            </div>
            {Array.from(byModel.entries()).map(([model, v]) => (
              <div key={model} className="usage-table-row">
                <span>{model}</span><span>{fmt(v.requests)}</span><span>{fmt(v.tokens)}</span><span>${v.cost.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="usage-section">
          <h3>{t.aiConfig.byDay}（{t.aiConfig.last7Days}）</h3>
          <div className="usage-bars">
            {dateRows.map(([date, v]) => (
              <div key={date} className="usage-bar-row">
                <span className="usage-bar-date">{date.slice(5)}</span>
                <div className="usage-bar-track">
                  <div className="usage-bar-fill tokens" style={{ width: `${(v.tokens / maxDayTokens) * 100}%` }} />
                </div>
                <span className="usage-bar-val">{fmt(v.tokens)}</span>
                <span className="usage-bar-cost">${v.cost.toFixed(2)}</span>
              </div>
            ))}
          </div>
          <div className="usage-bar-legend">
            <span><i className="dot tokens" /> {t.aiConfig.tokens}</span>
          </div>
        </div>
      </div>
    </Modal>
  );
}
