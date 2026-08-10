import { describe, expect, it } from "vitest";

import {
  AI_PROVIDER_PRESETS,
  createProviderId,
  findAiProviderPreset
} from "../lib/ai-provider-presets";

describe("AI 供应商预设", () => {
  it("只提供当前服务端真正支持的 OpenAI-compatible 供应商", () => {
    expect(AI_PROVIDER_PRESETS.map((preset) => preset.id)).toEqual([
      "openai",
      "deepseek",
      "openrouter",
      "kimi",
      "gemini"
    ]);
    expect(AI_PROVIDER_PRESETS.every((preset) => preset.apiFormat === "openai")).toBe(true);
    expect(AI_PROVIDER_PRESETS.map((preset) => String(preset.id))).not.toContain("anthropic");
  });

  it("每个预设只固定供应商接入信息，并提供多个模型选项而不替用户默认选择", () => {
    for (const preset of AI_PROVIDER_PRESETS) {
      expect(() => new URL(preset.baseUrl)).not.toThrow();
      expect(preset.models.length).toBeGreaterThan(1);
      expect("defaultModelId" in preset).toBe(false);
      expect(preset.models.every((model) => model.requestModel.trim() !== "")).toBe(true);
      expect(new Set(preset.models.map((model) => model.id)).size).toBe(preset.models.length);
      expect(preset.models.every((model) => model.inputCost === 0 && model.outputCost === 0)).toBe(true);
      expect("apiKey" in preset).toBe(false);
    }
  });

  it("模型选项与 2026-08-10 厂商官方目录一致", () => {
    const modelsOf = (providerId: string) =>
      findAiProviderPreset(providerId)?.models.map((item) => item.requestModel);

    expect(modelsOf("openai")).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna"
    ]);
    expect(modelsOf("deepseek")).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro"
    ]);
    expect(modelsOf("openrouter")).toEqual([
      "openrouter/auto",
      "~openai/gpt-latest"
    ]);
    expect(modelsOf("kimi")).toEqual([
      "kimi-k3",
      "kimi-k2.7-code",
      "kimi-k2.7-code-highspeed",
      "kimi-k2.6"
    ]);
    expect(modelsOf("gemini")).toEqual([
      "gemini-3.6-flash",
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite"
    ]);
  });

  it("按 id 查询预设，未知 id 返回 null", () => {
    expect(findAiProviderPreset("deepseek")?.label).toBe("DeepSeek");
    expect(findAiProviderPreset("missing")).toBeNull();
  });

  it("生成不会覆盖现有供应商的稳定 id", () => {
    expect(createProviderId("deepseek", [])).toBe("deepseek");
    expect(createProviderId("deepseek", ["deepseek"])).toBe("deepseek-2");
    expect(createProviderId("deepseek", ["deepseek", "deepseek-2"])).toBe("deepseek-3");
  });
});
