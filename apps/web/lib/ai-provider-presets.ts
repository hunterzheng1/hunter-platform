export interface AiProviderPresetModel {
  id: string;
  displayModel: string;
  requestModel: string;
  inputCost: number;
  outputCost: number;
  cacheHitCost: number;
  cacheCreateCost: number;
}

export interface AiProviderPreset {
  id: string;
  label: string;
  initials: string;
  description: string;
  note: string;
  website: string;
  baseUrl: string;
  apiFormat: "openai";
  accent: string;
  models: readonly AiProviderPresetModel[];
}

function model(id: string, displayModel: string, requestModel: string): AiProviderPresetModel {
  return {
    id,
    displayModel,
    requestModel,
    // 厂商价格变化频繁，预设不写死价格；用户可在高级设置中按实际账单维护。
    inputCost: 0,
    outputCost: 0,
    cacheHitCost: 0,
    cacheCreateCost: 0
  };
}

/**
 * 仅收录当前服务端能直接调用的 OpenAI-compatible 接口。
 * 地址与模型选项来自各厂商官方兼容文档；预设不会替用户选择模型。
 */
export const AI_PROVIDER_PRESETS = [
  {
    id: "openai",
    label: "OpenAI",
    initials: "OA",
    description: "OpenAI 官方 API，适合通用分析与结构化总结。",
    note: "官方 OpenAI-compatible 接口",
    website: "https://platform.openai.com",
    baseUrl: "https://api.openai.com/v1",
    apiFormat: "openai",
    accent: "#10a37f",
    models: [
      model("gpt-5.6-sol", "GPT-5.6 Sol", "gpt-5.6-sol"),
      model("gpt-5.6-terra", "GPT-5.6 Terra", "gpt-5.6-terra"),
      model("gpt-5.6-luna", "GPT-5.6 Luna", "gpt-5.6-luna")
    ]
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    initials: "DS",
    description: "中文表现稳定，兼容 OpenAI Chat Completions。",
    note: "DeepSeek 官方 OpenAI-compatible 接口",
    website: "https://platform.deepseek.com",
    baseUrl: "https://api.deepseek.com",
    apiFormat: "openai",
    accent: "#4d6bfe",
    models: [
      model("deepseek-v4-flash", "DeepSeek V4 Flash", "deepseek-v4-flash"),
      model("deepseek-v4-pro", "DeepSeek V4 Pro", "deepseek-v4-pro")
    ]
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    initials: "OR",
    description: "通过一个密钥使用多家模型，可选择自动路由或 OpenAI 最新旗舰别名。",
    note: "OpenRouter 聚合接口",
    website: "https://openrouter.ai",
    baseUrl: "https://openrouter.ai/api/v1",
    apiFormat: "openai",
    accent: "#7c5cff",
    models: [
      model("openrouter-auto", "OpenRouter 自动选择", "openrouter/auto"),
      model("openai-latest", "OpenAI 最新旗舰", "~openai/gpt-latest")
    ]
  },
  {
    id: "kimi",
    label: "Kimi",
    initials: "KM",
    description: "Moonshot 官方兼容接口，适合中文与长文本任务。",
    note: "Kimi / Moonshot 官方接口",
    website: "https://platform.kimi.ai",
    baseUrl: "https://api.moonshot.ai/v1",
    apiFormat: "openai",
    accent: "#6f5cff",
    models: [
      model("kimi-k3", "Kimi K3", "kimi-k3"),
      model("kimi-k2.7-code", "Kimi K2.7 Code", "kimi-k2.7-code"),
      model("kimi-k2.7-code-highspeed", "Kimi K2.7 Code 高速版", "kimi-k2.7-code-highspeed"),
      model("kimi-k2.6", "Kimi K2.6", "kimi-k2.6")
    ]
  },
  {
    id: "gemini",
    label: "Gemini",
    initials: "GM",
    description: "Google Gemini 的 OpenAI 兼容入口，可直接复用现有调用方式。",
    note: "Google AI OpenAI-compatible 接口",
    website: "https://aistudio.google.com",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiFormat: "openai",
    accent: "#4285f4",
    models: [
      model("gemini-3.6-flash", "Gemini 3.6 Flash", "gemini-3.6-flash"),
      model("gemini-3.5-flash", "Gemini 3.5 Flash", "gemini-3.5-flash"),
      model("gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite", "gemini-3.5-flash-lite")
    ]
  }
] as const satisfies readonly AiProviderPreset[];

export function findAiProviderPreset(id: string): AiProviderPreset | null {
  return AI_PROVIDER_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function createProviderId(presetId: string, existingIds: readonly string[]): string {
  const taken = new Set(existingIds);
  if (!taken.has(presetId)) return presetId;
  let suffix = 2;
  while (taken.has(`${presetId}-${suffix}`)) suffix += 1;
  return `${presetId}-${suffix}`;
}
