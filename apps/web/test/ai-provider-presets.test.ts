import { describe, expect, it } from "vitest";

import { AI_PROVIDER_PRESETS } from "../lib/ai-provider-presets";

describe("AI provider official pricing presets", () => {
  it("prefills current fixed-price provider models without user input", () => {
    const openai = AI_PROVIDER_PRESETS.find((preset) => preset.id === "openai");
    const deepseek = AI_PROVIDER_PRESETS.find((preset) => preset.id === "deepseek");
    const kimi = AI_PROVIDER_PRESETS.find((preset) => preset.id === "kimi");
    const gemini = AI_PROVIDER_PRESETS.find((preset) => preset.id === "gemini");

    expect(openai?.models.find((model) => model.id === "gpt-5.6-sol")).toMatchObject({ inputCost: 5, outputCost: 30, cacheHitCost: 0.5, cacheCreateCost: 6.25 });
    expect(deepseek?.models.find((model) => model.id === "deepseek-v4-flash")).toMatchObject({ inputCost: 0.14, outputCost: 0.28, cacheHitCost: 0.0028 });
    expect(kimi?.models.map((model) => model.requestModel)).toEqual(["kimi-k2.6"]);
    expect(gemini?.models.find((model) => model.id === "gemini-3.6-flash")).toMatchObject({ inputCost: 1.5, outputCost: 7.5, cacheHitCost: 0.15 });
  });

  it("marks OpenRouter auto routing as dynamic instead of inventing a fixed price", () => {
    const openrouter = AI_PROVIDER_PRESETS.find((preset) => preset.id === "openrouter");
    expect(openrouter?.pricingLabel).toContain("动态计价");
    expect(openrouter?.models[0]).toMatchObject({ inputCost: 0, outputCost: 0, cacheHitCost: 0 });
  });
});
