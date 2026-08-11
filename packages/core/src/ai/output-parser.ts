import {
  externalSkillSummaryContentSchema,
  skillCheckResultSchema,
  type ExternalSkillSummaryContent,
  type SkillCheckResult
} from "@hunter-harness/contracts";

// 解析 LLM 输出为 SkillCheckResult；失败降级为 AI_PARSE_FAILED yellow（不抛错，保证 draft 可继续）
export function parseAiCheckResult(raw: string): SkillCheckResult {
  const fallbackCheckedAt = new Date().toISOString();
  try {
    const text = stripMarkdownFence(raw);
    const jsonText = extractJsonObject(text);
    if (jsonText !== null) {
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;
      // LLM 可能漏 checkedAt 或加额外字段；schema 已 .strip() 容错多余字段，checkedAt 缺则补当前时间
      const checkedAt = typeof parsed.checkedAt === "string" ? parsed.checkedAt : fallbackCheckedAt;
      const candidate = {
        ...parsed,
        items: Array.isArray(parsed.items)
          ? parsed.items.map((item) => normalizeAiCheckItem(item, checkedAt))
          : parsed.items,
        checkedAt
      };
      const result = skillCheckResultSchema.safeParse(candidate);
      if (result.success) {
        return result.data;
      }
    }
  } catch {
    // fall through to degrade
  }
  return degrade(fallbackCheckedAt);
}

const DIRECTLY_WRITABLE_SUGGESTION_TARGETS = new Set(["examples", "instructions", "description"]);

function normalizeAiCheckItem(value: unknown, generatedAt: string): unknown {
  if (!isRecord(value)) return value;
  if (value.status === "green") {
    return { ...value, fixable: false, suggestion: null };
  }
  if (!isRecord(value.suggestion)) return value;
  const rawSuggestion = value.suggestion;
  const suggestion = {
    ...rawSuggestion,
    generatedAt,
    applicationState: "ready",
    appliedAt: null
  };
  const suggestedContent = rawSuggestion["suggestedContent"];
  const appliesTo = rawSuggestion["appliesTo"];
  const directlyWritable = typeof suggestedContent === "string" &&
    suggestedContent.trim().length > 0 &&
    typeof appliesTo === "string" &&
    DIRECTLY_WRITABLE_SUGGESTION_TARGETS.has(appliesTo);
  return { ...value, fixable: value.fixable === true && directlyWritable, suggestion };
}

// 剥离 LLM 常见的 markdown 围栏（```json ... ``` 或 ``` ... ```）
function stripMarkdownFence(raw: string): string {
  const trimmed = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fence === null ? trimmed : fence[1] ?? "";
}

// 从可能含前导/尾随说明文字的输出中提取第一个完整 JSON 对象（按花括号深度 + 字符串字面量计数）
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  let i = -1;
  for (const ch of text) {
    i++;
    if (i < start) continue;
    if (inStr) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inStr = false;
      }
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

function degrade(checkedAt: string): SkillCheckResult {
  return {
    items: [
      {
        id: "AI_PARSE_FAILED",
        label: "AI 分析结果解析失败",
        status: "yellow",
        message: "AI 返回内容无法解析为检查结果，请重试或检查供应商配置",
        filePath: null,
        fixable: false
      }
    ],
    summary: { green: 0, yellow: 1, red: 0 },
    checkedAt
  };
}

// #1 AI 生成发布变更信息：解析 LLM 纯文本 release note；空/失败返回 null（路由层据 null 降级，不抛错）
export function parseReleaseNote(raw: string): string | null {
  const trimmed = raw.trim();
  // 剥离任意语言标识的 markdown 围栏（```lang ... ``` 或 ``` ... ```）；stripMarkdownFence 只剥 json，release note 是纯文本需剥任意 lang
  const fence = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const text = (fence === null ? trimmed : (fence[1] ?? "")).trim();
  return text.length === 0 ? null : text;
}

export function parseExternalSkillSummary(raw: string): ExternalSkillSummaryContent | null {
  try {
    const text = stripMarkdownFence(raw);
    const jsonText = extractJsonObject(text);
    if (jsonText === null) return null;
    const parsed: unknown = JSON.parse(jsonText);
    const source = unwrapExternalSummary(parsed);
    if (source === null) return null;
    const quickStart = normalizedQuickStart(
      pickSummaryValue(source, ["quick_start", "quickStart", "workflow", "典型工作流"]),
      6
    );
    const result = externalSkillSummaryContentSchema.safeParse({
      overview: normalizedSummaryText(pickSummaryValue(source, ["overview", "what_it_is", "whatIsIt", "是什么"])),
      use_cases: normalizedSummaryList(pickSummaryValue(source, ["use_cases", "useCases", "use_case", "scenarios", "适用场景"]), 6),
      capabilities: normalizedSummaryList(pickSummaryValue(source, ["capabilities", "core_capabilities", "coreCapabilities", "features", "核心功能"]), 8),
      ...(quickStart.length === 0 ? {} : { quick_start: quickStart }),
      getting_started: normalizedSummaryList(pickSummaryValue(source, ["getting_started", "gettingStarted", "快速开始"]), 6),
      caveats: normalizedSummaryList(pickSummaryValue(source, ["caveats", "limitations", "warnings", "使用前注意", "注意事项"]), 6)
    });
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapExternalSummary(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  let current = value;
  for (let depth = 0; depth < 3; depth++) {
    if (["overview", "what_it_is", "whatIsIt", "是什么", "use_cases", "useCases", "capabilities", "features"]
      .some((key) => current[key] !== undefined)) break;
    const nested = ["summary", "result", "data"]
      .map((key) => current[key])
      .find(isRecord);
    if (nested === undefined) break;
    current = nested;
  }
  return current;
}

function pickSummaryValue(source: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined) return source[key];
  }
  return undefined;
}

function normalizedSummaryText(value: unknown): unknown {
  return typeof value === "string" ? value.trim() : value;
}

function normalizedSummaryList(value: unknown, limit: number): unknown {
  const values = typeof value === "string" ? [value] : value;
  if (!Array.isArray(values)) return [];
  const normalized = values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().replace(/^(?:[-*•]\s+|\d+[.)]\s+)/, ""))
    .filter((item) => item.length > 0);
  return [...new Set(normalized)].slice(0, limit);
}

function normalizedQuickStart(value: unknown, limit: number): Array<{
  title: string;
  instruction: string;
  commands: string[];
}> {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((step) => ({
      title: normalizedSummaryText(pickSummaryValue(step, ["title", "name", "step", "步骤"])),
      instruction: normalizedSummaryText(pickSummaryValue(step, ["instruction", "description", "action", "说明"])),
      commands: normalizedCommandList(pickSummaryValue(step, ["commands", "command", "命令"]), 8)
    }))
    .filter((step): step is { title: string; instruction: string; commands: string[] } =>
      typeof step.title === "string" && step.title.length > 0 &&
      typeof step.instruction === "string" && step.instruction.length > 0)
    .slice(0, limit);
}

function normalizedCommandList(value: unknown, limit: number): string[] {
  const values = typeof value === "string" ? [value] : value;
  if (!Array.isArray(values)) return [];
  const commands = values.flatMap((item) => typeof item === "string" ? item.split(/\r?\n/) : [])
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && !/^```/.test(item))
    .map((item) => item.replace(/^\$\s+/, "").replace(/^`+|`+$/g, "").trim())
    .filter((item) => item.length > 0);
  return [...new Set(commands)].slice(0, limit);
}

// #2 appliesTo 白名单（与 contracts/src/fix.ts fixPlanItemSchema.appliesTo 对齐）
const FIX_APPLIES_TO_WHITELIST = ["examples", "allowed_capabilities", "instructions", "description", "tags"] as const;

export type FixAppliesTo = (typeof FIX_APPLIES_TO_WHITELIST)[number];

export interface FixSuggestionParse {
  suggestedContent: string;
  explanation: string;
  appliesTo: FixAppliesTo | null;
}

// #2 AI 生成修复内容：解析 LLM JSON {suggestedContent,explanation,appliesTo}；appliesTo 非白名单归 null；失败返回 null（路由层降级回退 message-only）
export function parseFixSuggestionResult(raw: string): FixSuggestionParse | null {
  try {
    const text = stripMarkdownFence(raw);
    const jsonText = extractJsonObject(text);
    if (jsonText === null) return null;
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    if (typeof parsed.suggestedContent !== "string" || typeof parsed.explanation !== "string") return null;
    const appliesTo = typeof parsed.appliesTo === "string" && (FIX_APPLIES_TO_WHITELIST as readonly string[]).includes(parsed.appliesTo)
      ? (parsed.appliesTo as FixAppliesTo)
      : null;
    return { suggestedContent: parsed.suggestedContent, explanation: parsed.explanation, appliesTo };
  } catch {
    return null;
  }
}
