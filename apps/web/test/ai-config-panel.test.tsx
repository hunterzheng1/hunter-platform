// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiProviderConfig, AiQuotaUsage, CodexConnectionState } from "@hunter-harness/contracts";

import { AiConfigPanel } from "../components/ai-config-panel";
import { ToastProvider } from "../components/ui/Toast";

// mock browserApi：可写 mock（listAiProviders 返回多模型 providers；各 mutation 返回成功）
const { api } = vi.hoisted(() => {
  const mockProviders: AiProviderConfig[] = [
    {
      provider_id: "deepseek", label: "DeepSeek", base_url: "https://api.deepseek.com",
      model: "deepseek-chat", enabled: true, is_default: true, api_key_env: "secret-file",
      revision: 1, daily_request_limit: null, daily_token_limit: null,
      created_at: "2026-06-25T00:00:00Z", updated_at: "2026-06-25T00:00:00Z",
      models: [
        { id: "ds-chat", display_model: "DeepSeek Chat", request_model: "deepseek-chat", input_cost: 0.27, output_cost: 1.1, cache_hit_cost: 0.07, cache_create_cost: 0.27 },
        { id: "ds-reasoner", display_model: "DeepSeek Reasoner", request_model: "deepseek-reasoner", input_cost: 0.55, output_cost: 2.19, cache_hit_cost: 0.14, cache_create_cost: 0.55 }
      ],
      api_format: "openai", note: "主力供应商", website: "https://platform.deepseek.com", selected_model_id: "ds-chat", sort_order: 0
    },
    {
      provider_id: "openai", label: "OpenAI", base_url: "https://api.openai.com",
      model: "gpt-4o", enabled: false, is_default: false, api_key_env: "secret-file",
      revision: 1, daily_request_limit: null, daily_token_limit: null,
      created_at: "2026-06-25T00:00:00Z", updated_at: "2026-06-25T00:00:00Z",
      models: [{ id: "o4o", display_model: "GPT-4o", request_model: "gpt-4o", input_cost: 2.5, output_cost: 10, cache_hit_cost: 1.25, cache_create_cost: 0 }],
      api_format: "openai", note: "", website: "https://platform.openai.com", selected_model_id: "o4o", sort_order: 1
    },
    {
      provider_id: "anthropic", label: "Anthropic", base_url: "https://api.anthropic.com",
      model: "claude-sonnet-4-6", enabled: false, is_default: false, api_key_env: "secret-file",
      revision: 1, daily_request_limit: null, daily_token_limit: null,
      created_at: "2026-06-25T00:00:00Z", updated_at: "2026-06-25T00:00:00Z",
      models: [{ id: "sonnet", display_model: "Claude Sonnet 4.6", request_model: "claude-sonnet-4-6", input_cost: 3, output_cost: 15, cache_hit_cost: 0.3, cache_create_cost: 3.75 }],
      api_format: "anthropic", note: "", website: "https://console.anthropic.com", selected_model_id: "sonnet", sort_order: 2
    }
  ];
  const mockUsage: AiQuotaUsage[] = [
    { provider_id: "deepseek", date: "2026-07-01", model: "deepseek-chat", requests: 38, tokens: 440000, input_tokens: 280000, output_tokens: 160000, cache_hit_tokens: 40000, cache_create_tokens: 0, cost: 0.27 },
    { provider_id: "deepseek", date: "2026-07-01", model: "deepseek-reasoner", requests: 12, tokens: 400000, input_tokens: 180000, output_tokens: 220000, cache_hit_tokens: 0, cache_create_tokens: 0, cost: 0.58 }
  ];
  const api = {
    listAiProviders: vi.fn(async () => ({
      items: mockProviders.map((p) => ({ ...p, key_set: p.provider_id === "deepseek", models: p.models.map((m) => ({ ...m })) })),
      default_provider: "deepseek"
    })),
    getCodexConnection: vi.fn(async (): Promise<CodexConnectionState> => ({
      status: "connected" as const,
      auth_mode: "chatgpt" as const,
      email: "owner@example.com",
      plan_type: "plus",
      enabled: false,
      selected_model: "gpt-5.6-sol",
      models: [
        { id: "gpt-5.6-sol", display_name: "GPT-5.6 Sol", is_default: true, reasoning_efforts: ["medium", "high"] },
        { id: "gpt-5.6-terra", display_name: "GPT-5.6 Terra", is_default: false, reasoning_efforts: ["medium", "high"] }
      ],
      error: null
    })),
    startCodexLogin: vi.fn(async () => ({ login_id: "login_01", verification_url: "https://auth.openai.com/codex/device", user_code: "ABCD-EFGH" })),
    cancelCodexLogin: vi.fn(async () => ({ cancelled: true })),
    updateCodexConnection: vi.fn(async (input: { selected_model?: string | null; enabled?: boolean }) => ({
      status: "connected" as const, auth_mode: "chatgpt" as const, email: "owner@example.com", plan_type: "plus",
      enabled: input.enabled ?? false,
      selected_model: input.selected_model ?? "gpt-5.6-sol",
      models: [
        { id: "gpt-5.6-sol", display_name: "GPT-5.6 Sol", is_default: true, reasoning_efforts: ["medium", "high"] },
        { id: "gpt-5.6-terra", display_name: "GPT-5.6 Terra", is_default: false, reasoning_efforts: ["medium", "high"] }
      ],
      error: null
    })),
    disconnectCodex: vi.fn(async () => ({ disconnected: true })),
    testCodexConnection: vi.fn(async () => ({ ok: true, model: "gpt-5.6-sol" })),
    createAiProvider: vi.fn(async (input: Record<string, unknown>) => ({ is_default: false, daily_request_limit: null, daily_token_limit: null, created_at: "2026-07-02T00:00:00Z", updated_at: "2026-07-02T00:00:00Z", models: [], api_format: "openai", note: "", website: "", selected_model_id: null, sort_order: 0, ...input, revision: 1 } as unknown as AiProviderConfig)),
    updateAiProvider: vi.fn(async (id: string, rev: number, patch: Record<string, unknown>) => {
      const base = mockProviders.find((p) => p.provider_id === id) ?? mockProviders[0];
      return { ...base, ...patch, revision: rev + 1 } as AiProviderConfig;
    }),
    deleteAiProvider: vi.fn(async (id: string) => ({ provider_id: id, deleted: true })),
    testAiProvider: vi.fn(async (id: string) => ({ provider_id: id, ok: true, model: "deepseek-chat" })),
    setAiProviderKey: vi.fn(async (id: string) => ({ provider_id: id, key_set: true })),
    getAiUsage: vi.fn(async () => mockUsage.map((u) => ({ ...u }))),
    reorderAiProviders: vi.fn(async (ids: string[]) => ({ provider_ids: ids }))
  };
  return { api };
});

vi.mock("../lib/api", () => ({ browserApi: () => api }));

const EDIT = /编辑|Edit/;
const ADD_PROVIDER = /新增供应商|Add provider/;
const CHOOSE_PROVIDER = /选择 AI 供应商|Choose an AI provider/;
const CUSTOM_PROVIDER = /自定义供应商|Custom provider/;
const ADD_MODEL = /新增模型|Add model/;
const DUPLICATE = /复制|Duplicate/;
const TEST_CONN = /测试连通性|Test connection/;
const USAGE = /^用量$|^Usage$/;
const REQUEST_MODEL_PH = /如 deepseek-chat/i;
const ENABLED = /^已启用$|^Enabled$/;
const DISABLED = /^未启用$|^Disabled$/;

afterEach(cleanup);

function btn(name: RegExp | string): HTMLElement {
  const el = screen.getAllByRole("button", { name })[0];
  if (el === undefined) throw new Error(`button ${String(name)} not found`);
  return el;
}

async function renderLoaded(): Promise<void> {
  render(<ToastProvider><AiConfigPanel /></ToastProvider>);
  await waitFor(() => expect(screen.getByText("DeepSeek")).toBeInTheDocument());
}

describe("AiConfigPanel 接后端 API (T11, I-01~I-06)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("I-01 列表态 listAiProviders 加载并渲染后端 providers", async () => {
    await renderLoaded();
    expect(screen.getByText("DeepSeek")).toBeInTheDocument();
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(api.listAiProviders).toHaveBeenCalledTimes(1);
    expect(api.getAiUsage).toHaveBeenCalledTimes(1);
  });

  it("I-02 拖拽 drop → reorderAiProviders 调用 + 顺序变", async () => {
    const { container } = render(<AiConfigPanel />);
    await waitFor(() => expect(screen.getByText("DeepSeek")).toBeInTheDocument());
    const handle = container.querySelectorAll(".drag-handle")[0];
    const targetRow = container.querySelectorAll(".provider-row")[1];
    if (handle === undefined || targetRow === undefined) throw new Error("missing drag rows");
    fireEvent.dragStart(handle);
    fireEvent.dragOver(targetRow);
    fireEvent.drop(targetRow);
    await waitFor(() => expect(api.reorderAiProviders).toHaveBeenCalledTimes(1));
    expect(api.reorderAiProviders.mock.calls[0]?.[0]).toEqual(["openai", "deepseek", "anthropic"]);
  });

  it("I-03 用量弹窗 getAiUsage per-model 维度", async () => {
    await renderLoaded();
    fireEvent.click(btn(USAGE));
    expect(screen.getByRole("heading", { name: /DeepSeek.*使用统计/i })).toBeInTheDocument();
    expect(screen.getByText(/^按模型$|^By model$/)).toBeInTheDocument();
    // per-model：deepseek-chat + deepseek-reasoner 都展示
    expect(screen.getByText("deepseek-chat")).toBeInTheDocument();
    expect(screen.getByText("deepseek-reasoner")).toBeInTheDocument();
  });

  it("I-04 详情保存 updateAiProvider 含 models（已存在 provider）", async () => {
    await renderLoaded();
    fireEvent.click(btn(EDIT));
    fireEvent.click(screen.getByRole("button", { name: /^保存$|^Save$/ }));
    await waitFor(() => expect(api.updateAiProvider).toHaveBeenCalledTimes(1));
    const [, , patch] = api.updateAiProvider.mock.calls[0] ?? [];
    expect(patch).toHaveProperty("models");
    expect((patch as { models: unknown[] }).models).toHaveLength(2);
  });

  it("I-05 启用单选 → updateAiProvider enabled 后后端单选（其他 false）", async () => {
    await renderLoaded();
    // 初始 deepseek enabled，openai/anthropic disabled
    expect(screen.getAllByRole("button", { name: ENABLED }).length).toBe(1);
    fireEvent.click(btn(DISABLED)); // 启用 openai
    await waitFor(() => expect(api.updateAiProvider).toHaveBeenCalledTimes(1));
    // 后端单选：await 后只剩一个 enabled
    await waitFor(() => expect(screen.getAllByRole("button", { name: ENABLED }).length).toBe(1));
  });

  it("I-KEY-01 选择预设后必须选择模型，API 供应商不再包含 Codex 绑定", async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: ADD_PROVIDER }));
    expect(screen.getByRole("dialog", { name: CHOOSE_PROVIDER })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /DeepSeek/i }));
    expect(screen.getByDisplayValue("DeepSeek")).toBeInTheDocument();
    expect(screen.getByDisplayValue("https://api.deepseek.com")).toBeInTheDocument();
    const modelSelect = screen.getByRole("combobox", { name: /选择模型|Choose model/i });
    expect(modelSelect).toHaveValue("");
    expect(within(modelSelect).getByRole("option", { name: /DeepSeek V4 Flash/i })).toBeInTheDocument();
    expect(within(modelSelect).getByRole("option", { name: /DeepSeek V4 Pro/i })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/^sk-\.\.\.$/i), { target: { value: "sk-new-01" } });
    expect(screen.getByRole("button", { name: /^保存$|^Save$/ })).toBeDisabled();
    fireEvent.change(modelSelect, { target: { value: "deepseek-v4-pro" } });
    expect(screen.queryByRole("checkbox", { name: /绑定到 Codex|Bind to Codex/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^保存$|^Save$/ }));
    await waitFor(() => expect(api.createAiProvider).toHaveBeenCalledTimes(1));
    const [input] = api.createAiProvider.mock.calls[0] ?? [];
    expect(input).toHaveProperty("api_key", "sk-new-01");
    expect(input).toMatchObject({
      provider_id: "deepseek-2",
      label: "DeepSeek",
      base_url: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      selected_model_id: "deepseek-v4-pro"
    });
    expect(input).not.toHaveProperty("bind_codex");
  });

  it("Codex 授权连接与 API 厂商统一在模型来源列表展示", async () => {
    const { container } = render(<ToastProvider><AiConfigPanel /></ToastProvider>);
    await waitFor(() => expect(screen.getByText("DeepSeek")).toBeInTheDocument());
    const codexRow = container.querySelector('[data-model-source="codex"]');
    expect(codexRow).not.toBeNull();
    expect(screen.getByText(/owner@example\.com/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Codex 默认模型" }))
      .toHaveClass("codex-model-select");
    expect(screen.getByRole("combobox", { name: "Codex 默认模型" }))
      .toHaveValue("gpt-5.6-sol");
    expect(container.querySelector(".ai-connection-grid")).toBeNull();
  });

  it("未连接时从新增供应商选择 Codex，并在独立弹窗完成官方设备码授权", async () => {
    api.getCodexConnection.mockResolvedValueOnce({
      status: "disconnected",
      auth_mode: null,
      email: null,
      plan_type: null,
      enabled: false,
      selected_model: null,
      models: [],
      error: null
    });
    render(<ToastProvider><AiConfigPanel /></ToastProvider>);
    await waitFor(() => expect(screen.getByText("DeepSeek")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: ADD_PROVIDER }));
    const picker = screen.getByRole("dialog", { name: CHOOSE_PROVIDER });
    fireEvent.click(within(picker).getByRole("button", { name: /Codex.*ChatGPT 账号/i }));
    await waitFor(() => expect(api.startCodexLogin).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("dialog", { name: "连接 Codex" })).toBeInTheDocument();
    expect(await screen.findByText("ABCD-EFGH")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开授权页面" })).toHaveAttribute("href", "https://auth.openai.com/codex/device");
  });

  it("Codex 与 API 厂商全局单选启用，启用行的模型即平台默认模型", async () => {
    const { container } = render(<ToastProvider><AiConfigPanel /></ToastProvider>);
    await waitFor(() => expect(screen.getByText("DeepSeek")).toBeInTheDocument());
    const codexRow = container.querySelector('[data-model-source="codex"]');
    if (codexRow === null) throw new Error("missing Codex row");
    fireEvent.click(within(codexRow as HTMLElement).getByRole("button", { name: DISABLED }));
    await waitFor(() => expect(api.updateCodexConnection).toHaveBeenCalledWith({ enabled: true }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: ENABLED })).toHaveLength(1));
    expect(within(codexRow as HTMLElement).getByText("默认模型")).toBeInTheDocument();
  });

  it("I-KEY-02 编辑已有 provider 填 apiKey 保存 → updateAiProvider patch 含 api_key (I-02)", async () => {
    await renderLoaded();
    fireEvent.click(btn(EDIT));
    fireEvent.change(screen.getByPlaceholderText(/^sk-\.\.\.$/i), { target: { value: "sk-edit-02" } });
    fireEvent.click(screen.getByRole("button", { name: /^保存$|^Save$/ }));
    await waitFor(() => expect(api.updateAiProvider).toHaveBeenCalledTimes(1));
    const [, , patch] = api.updateAiProvider.mock.calls[0] ?? [];
    expect(patch).toHaveProperty("api_key", "sk-edit-02");
  });

  it("I-KEY-03 列表态显示'已设置'徽标（keySet=true）(I-03)", async () => {
    await renderLoaded();
    expect(screen.getAllByText(/^已设置$|^Key set$/i).length).toBeGreaterThan(0);
  });

  it("I-KEY-04 列表态显示'未设置'徽标（keySet=false）(I-04)", async () => {
    await renderLoaded();
    expect(screen.getAllByText(/^未设置$|^Key not set$/i).length).toBeGreaterThan(0);
  });

  it("I-KEY-05 详情态无'保存 Key'按钮 (I-05)", async () => {
    await renderLoaded();
    fireEvent.click(btn(EDIT));
    expect(screen.queryByRole("button", { name: /保存 Key|Save key/i })).toBeNull();
  });

  it("I-KEY-06 saveDetail 失败 → toast saveFailed（非 keySaveFailed）(I-06)", async () => {
    await renderLoaded();
    vi.mocked(api.updateAiProvider).mockRejectedValueOnce(new Error("fail"));
    fireEvent.click(btn(EDIT));
    fireEvent.click(screen.getByRole("button", { name: /^保存$|^Save$/ }));
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
    const toast = screen.getByRole("status");
    expect(toast).toHaveTextContent(/保存失败|Save failed/i);
    expect(toast).not.toHaveTextContent(/保存 Key 失败|Failed to save key/i);
  });

  it("I-KEY-07 眼睛 toggle 显示输入值 (I-07)", async () => {
    await renderLoaded();
    fireEvent.click(btn(EDIT));
    const keyInput = screen.getByPlaceholderText(/^sk-\.\.\.$/i) as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: "sk-visible-07" } });
    expect(keyInput.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: /显示\/隐藏 Key|Show\/hide key/i }));
    expect(keyInput.type).toBe("text");
  });

  it("I-KEY-08 新建 provider 填 apiKey 保存成功 → 列表态该 provider 显示'已设置'徽标（keySet 乐观更新 false→true，Y6）", async () => {
    await renderLoaded();
    const beforeSet = screen.getAllByText(/^已设置$|^Key set$/i).length;
    fireEvent.click(screen.getByRole("button", { name: ADD_PROVIDER }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: CUSTOM_PROVIDER }));
    fireEvent.change(screen.getByPlaceholderText(/供应商名称|Provider name/i), { target: { value: "NewKeySetProvider" } });
    fireEvent.change(screen.getByLabelText(/连接地址 \/ 会话|Base URL \/ Session/i), { target: { value: "https://example.com/v1" } });
    fireEvent.change(screen.getByPlaceholderText(REQUEST_MODEL_PH), { target: { value: "example-chat" } });
    fireEvent.change(screen.getByPlaceholderText(/^sk-\.\.\.$/i), { target: { value: "sk-keyset-08" } });
    fireEvent.click(screen.getByRole("button", { name: /^保存$|^Save$/ }));
    await waitFor(() => expect(api.createAiProvider).toHaveBeenCalledTimes(1));
    // 保存成功后回到列表态，新建 provider 因 apiKey 非空 → nextKeySet 乐观更新为 true → 显示"已设置"徽标
    await waitFor(() => expect(screen.getAllByText(/^已设置$|^Key set$/i).length).toBe(beforeSet + 1));
  });

  it("复制供应商调 createAiProvider 持久化 + 生成副本", async () => {
    await renderLoaded();
    fireEvent.click(btn(DUPLICATE));
    await waitFor(() => expect(api.createAiProvider).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/DeepSeek 副本/i)).toBeInTheDocument());
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("测试连通性调 testAiProvider + toast", async () => {
    await renderLoaded();
    fireEvent.click(btn(TEST_CONN));
    await waitFor(() => expect(api.testAiProvider).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/连通性测试通过/i)).toBeInTheDocument());
  });

  it("删除供应商确认后调 deleteAiProvider", async () => {
    await renderLoaded();
    fireEvent.click(btn(/^删除$|^Delete$/));
    expect(screen.getByText(/确认删除供应商 DeepSeek/i)).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^删除$|^Delete$/ }));
    await waitFor(() => expect(api.deleteAiProvider).toHaveBeenCalledTimes(1));
  });

  it("点击编辑进入详情态展示模型映射", async () => {
    await renderLoaded();
    fireEvent.click(btn(EDIT));
    expect(screen.getByDisplayValue("deepseek-chat")).toBeInTheDocument();
    expect(screen.getByDisplayValue("deepseek-reasoner")).toBeInTheDocument();
  });

  it("详情态新增模型", async () => {
    await renderLoaded();
    fireEvent.click(btn(EDIT));
    const before = screen.getAllByPlaceholderText(REQUEST_MODEL_PH).length;
    fireEvent.click(screen.getByRole("button", { name: ADD_MODEL }));
    expect(screen.getAllByPlaceholderText(REQUEST_MODEL_PH).length).toBe(before + 1);
  });

  it("新增供应商先进入预设选择器，自定义配置仍可用", async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: ADD_PROVIDER }));
    expect(screen.getByRole("dialog", { name: CHOOSE_PROVIDER })).toBeInTheDocument();
    expect(screen.getByRole("dialog").querySelectorAll(".provider-preset-card")).toHaveLength(6);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: CUSTOM_PROVIDER }));
    expect(screen.getByRole("heading", { name: /新建供应商|New provider/i })).toBeInTheDocument();
  });

  it("预设详情默认收起高级参数，把 API Key 作为主要输入", async () => {
    const { container } = render(<ToastProvider><AiConfigPanel /></ToastProvider>);
    await waitFor(() => expect(screen.getByText("DeepSeek")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: ADD_PROVIDER }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /OpenRouter/i }));

    expect(screen.getByText(/填写 API Key.*选择.*模型|Enter an API Key.*choose/i)).toBeInTheDocument();
    const keyInput = screen.getByPlaceholderText(/^sk-\.\.\.$/i);
    expect(screen.getByRole("button", { name: /^保存$|^Save$/ })).toBeDisabled();
    fireEvent.change(keyInput, { target: { value: "sk-openrouter" } });
    expect(screen.getByRole("button", { name: /^保存$|^Save$/ })).toBeDisabled();
    fireEvent.change(screen.getByRole("combobox", { name: /选择模型|Choose model/i }), { target: { value: "openrouter-auto" } });
    expect(screen.getByRole("button", { name: /^保存$|^Save$/ })).toBeEnabled();
    const details = container.querySelectorAll(".provider-advanced-settings");
    expect(details.length).toBeGreaterThan(0);
    expect(Array.from(details).every((item) => !(item as HTMLDetailsElement).open)).toBe(true);
  });

  it("模型来源列表共享固定操作列，API 与 Codex 操作按钮从同一位置开始", () => {
    const css = readFileSync(resolve(process.cwd(), "apps/web/app/globals.css"), "utf8");

    expect(css).toContain("--provider-actions-width: 240px");
    expect(css).toContain("110px auto var(--provider-actions-width)");
    expect(css).toMatch(/\.provider-row-actions\s*\{\s*justify-content:\s*flex-start;/);
  });
});
