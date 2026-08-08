import { canonicalJson } from "@hunter-harness/contracts";
import { scanSensitiveFiles, sha256Bytes } from "@hunter-harness/core";
import { z } from "zod";

import type { ServerRepository } from "../repositories/interfaces.js";
import { ServerDomainError } from "../repositories/interfaces.js";
import type { ArtifactStorage } from "../storage/interface.js";

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

export const instructionProposalRequestSchema = z.object({
  schema_version: z.literal(1),
  language: z.literal("zh-CN").default("zh-CN"),
  project_profile: z.string().min(1).max(100),
  adapters: z.array(z.enum(["codex", "claude-code", "cursor", "codebuddy"])).max(4),
  documents: z.array(z.object({
    path: z.enum([
      "AGENTS.md",
      "CLAUDE.md",
      "CODEBUDDY.md",
      ".harness/rules/project-guidance.md",
      ".cursor/rules/project-guidance.mdc",
      "package.json",
      "pom.xml",
      "build.gradle",
      "build.gradle.kts",
      "pyproject.toml"
    ]),
    content: z.string().max(512 * 1024),
    content_sha256: sha256Schema
  }).strict()).max(16),
  codebase_map: z.object({
    status: z.enum(["missing", "stale", "fresh"]),
    content: z.string().max(512 * 1024)
  }).strict(),
  recent_changes: z.array(z.object({
    change_key: z.string().min(1).max(160),
    summary: z.string().max(10_000),
    decisions: z.array(z.string().min(1).max(2_000)).max(50)
  }).strict()).max(20)
}).strict();

export type InstructionProposalRequest = z.infer<typeof instructionProposalRequestSchema>;
export type InstructionRecentChange = InstructionProposalRequest["recent_changes"][number];

const LEGACY_MANAGED_BLOCK = /<!--[ \t]*hunter-harness:start\b[^>]*-->[\s\S]*?<!--[ \t]*hunter-harness:end\b[^>]*-->/giu;

function trimDocument(content: string): string {
  return content.replace(LEGACY_MANAGED_BLOCK, "").replace(/\n{3,}/gu, "\n\n").trim();
}

function demoteHeadings(content: string): string {
  return content.replace(/^(#{1,6})[ \t]+/gmu, (match, hashes: string) =>
    "#".repeat(Math.min(6, hashes.length + 2)) + " "
  );
}

function sectionContent(content: string, heading: string): string | null {
  const lines = content.replace(/\r\n/gu, "\n").split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##[ \t]+/u.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end)
    .join("\n")
    .replace(/^\s*以下内容(?:来自|从)[^\n]*\n/u, "")
    .trim();
}

function preserveProjectContent(content: string, currentHeading: string, legacyHeading?: string): string {
  const trimmed = trimDocument(content);
  if (trimmed === "") return "- 暂无额外项目约定；新增内容应具体、可执行且可验证。";
  const current = sectionContent(trimmed, currentHeading);
  if (current !== null) return current;
  if (legacyHeading !== undefined) {
    const legacy = sectionContent(trimmed, legacyHeading);
    if (legacy !== null) return demoteHeadings(legacy);
  }
  return demoteHeadings(trimmed);
}

function parseScripts(documents: Map<string, string>): Array<{ name: string; command: string }> {
  const raw = documents.get("package.json");
  if (raw === undefined) return [];
  try {
    const parsed = JSON.parse(raw) as {
      packageManager?: unknown;
      scripts?: Record<string, unknown>;
    };
    const declaredManager = typeof parsed.packageManager === "string"
      ? parsed.packageManager.split("@", 1)[0]
      : "npm";
    const manager = declaredManager === "pnpm" || declaredManager === "yarn" ||
      declaredManager === "bun" ? declaredManager : "npm";
    return Object.entries(parsed.scripts ?? {})
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .filter(([name]) => /^(?:check|test|lint|typecheck|build|dev|start)$/u.test(name))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name]) => ({
        name,
        command: manager === "npm" && (name === "test" || name === "start")
          ? `npm ${name}`
          : `${manager} run ${name}`
      }));
  } catch {
    return [];
  }
}

function proposedFile(
  path: string,
  content: string,
  current: Map<string, { content: string; hash: string }>
) {
  const existing = current.get(path);
  return {
    path,
    operation: existing === undefined ? "add" as const : "modify" as const,
    base_content_sha256: existing?.hash ?? null,
    content_sha256: sha256Bytes(content),
    content
  };
}

function mapLines(content: string): string[] {
  return content.split(/\r?\n/gu)
    .map((line) => line.trim().replace(/^[-*][ \t]+/u, ""))
    .filter((line) => line.length > 0 && line.length <= 240)
    .filter((line) => /(?:^|[`\s(])(?:\.?[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.*-]+/u.test(line))
    .slice(0, 12);
}

function oneLine(value: string, maxLength: number): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, maxLength);
}

function projectTypeGuidance(profile: string): string[] {
  const normalized = profile.toLowerCase();
  if (normalized.includes("typescript") || normalized.includes("javascript") ||
      normalized.includes("node")) {
    return [
      "- 保持工作区包边界清晰；跨包调用只走公开导出，不引用其他包的内部文件。",
      "- 公共类型、命令参数或 JSON 协议变化必须同步更新类型、调用方和契约测试。",
      "- 合并前按项目脚本运行类型检查、lint 和相关测试；不要用跳过类型检查掩盖错误。"
    ];
  }
  if (normalized.includes("java") || normalized.includes("jvm") ||
      normalized.includes("gradle") || normalized.includes("maven")) {
    return [
      "- 保持模块、包与领域边界一致；跨模块依赖通过公开接口表达。",
      "- 数据库、配置或序列化模型变化必须提供兼容迁移与集成测试。",
      "- 优先使用仓库自带的 Maven/Gradle Wrapper 运行测试和静态检查。"
    ];
  }
  if (normalized.includes("python")) {
    return [
      "- 保持包边界和公开导入稳定；新增公共接口应补类型标注与行为测试。",
      "- 依赖、格式化、lint 和测试命令以 pyproject.toml 的实际配置为准。",
      "- 不提交虚拟环境、解释器缓存、覆盖率缓存或本机生成文件。"
    ];
  }
  return [
    "- 尊重现有模块边界；跨模块修改前确认调用方、数据所有权和兼容要求。",
    "- 项目类型不明确时，以仓库清单、CI 和现有测试为准，不猜测工具链。"
  ];
}

function summaryText(record: Record<string, unknown>, changeKey: string): string {
  for (const value of [
    record.summary,
    record.finalSummary,
    record.final_summary,
    record.title,
    record.changeName
  ]) {
    if (typeof value === "string" && value.trim() !== "") return value.trim().slice(0, 10_000);
  }
  return `已归档变更 ${changeKey}`;
}

function summaryDecisions(record: Record<string, unknown>): string[] {
  if (!Array.isArray(record.decisions)) return [];
  return record.decisions.flatMap((value) => {
    if (typeof value === "string" && value.trim() !== "") return [value.trim().slice(0, 2_000)];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const decision = value as Record<string, unknown>;
      const text = decision.decision ?? decision.summary ?? decision.note;
      if (typeof text === "string" && text.trim() !== "") return [text.trim().slice(0, 2_000)];
    }
    return [];
  }).slice(0, 50);
}

/**
 * Load recent change evidence from server-owned archive summaries. This makes
 * instruction audits independent of a client's local archive surviving.
 */
export async function loadServerRecentChanges(input: {
  actorId: string;
  projectId: string;
  repository: ServerRepository;
  storage: ArtifactStorage;
  limit?: number;
}): Promise<InstructionRecentChange[]> {
  const pattern = /^\.harness\/archive\/([^/]+)\/reports\/final\/summary-data\.json$/u;
  const files = (await input.repository.listProjectFiles(input.actorId, input.projectId))
    .flatMap((file) => {
      const match = pattern.exec(file.path);
      return match?.[1] === undefined ? [] : [{ file, changeKey: match[1] }];
    })
    .sort((left, right) => right.file.updatedAt.localeCompare(left.file.updatedAt))
    .slice(0, input.limit ?? 20);
  const changes: InstructionRecentChange[] = [];
  for (const { file, changeKey } of files) {
    try {
      if (!await input.storage.hasBlob(file.contentSha256)) continue;
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
        await input.storage.getBlob(file.contentSha256)
      )) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const record = parsed as Record<string, unknown>;
      changes.push({
        change_key: changeKey,
        summary: summaryText(record, changeKey),
        decisions: summaryDecisions(record)
      });
    } catch {
      // A corrupt derived summary is skipped; the original ZIP remains the recovery source.
    }
  }
  return changes;
}

export function mergeRecentChanges(
  serverChanges: readonly InstructionRecentChange[],
  clientChanges: readonly InstructionRecentChange[]
): InstructionRecentChange[] {
  const merged = new Map<string, InstructionRecentChange>();
  for (const change of [...serverChanges, ...clientChanges]) {
    if (!merged.has(change.change_key)) merged.set(change.change_key, change);
  }
  return [...merged.values()].slice(0, 20);
}

export function buildInstructionProposal(input: {
  projectId: string;
  projectName: string;
  request: InstructionProposalRequest;
}) {
  const request = input.request;
  const current = new Map<string, { content: string; hash: string }>(request.documents.map((document) => [document.path, {
    content: document.content,
    hash: document.content_sha256
  }]));
  for (const document of request.documents) {
    if (sha256Bytes(document.content) !== document.content_sha256) {
      throw new ServerDomainError(
        422,
        "INSTRUCTION_EVIDENCE_HASH_MISMATCH",
        "instruction evidence hash mismatch",
        { path: document.path }
      );
    }
  }
  const security = scanSensitiveFiles({
    ...Object.fromEntries(request.documents.map((document) => [document.path, document.content])),
    "instruction-evidence/codebase-map.txt": request.codebase_map.content,
    ...Object.fromEntries(request.recent_changes.map((change, index) => [
      `instruction-evidence/recent-change-${index + 1}.txt`,
      [change.change_key, change.summary, ...change.decisions].join("\n")
    ]))
  });
  if (security.blocked) {
    throw new ServerDomainError(
      422,
      "SENSITIVE_CONTENT_BLOCKED",
      "instruction evidence contains sensitive content",
      { finding_count: security.findings.length }
    );
  }

  const findings: Array<{
    code: string;
    severity: "info" | "warning";
    path: string;
    message: string;
  }> = [];
  for (const path of ["AGENTS.md", "CLAUDE.md", "CODEBUDDY.md"]) {
    const content = current.get(path)?.content;
    if (content !== undefined && LEGACY_MANAGED_BLOCK.test(content)) {
      findings.push({
        code: "LEGACY_MANAGED_BLOCK",
        severity: "warning",
        path,
        message: "发现旧式 hunter-harness 托管标记，提案将迁移为普通 Markdown。"
      });
      LEGACY_MANAGED_BLOCK.lastIndex = 0;
    }
  }
  const existingAgents = trimDocument(current.get("AGENTS.md")?.content ?? "");
  if (existingAgents === "") {
    findings.push({
      code: "AGENTS_MISSING_OR_EMPTY",
      severity: "warning",
      path: "AGENTS.md",
      message: "缺少可复用的项目级 Agent 指令。"
    });
  } else if (existingAgents.split(/\r?\n/gu).length > 200) {
    findings.push({
      code: "AGENTS_TOO_LONG",
      severity: "warning",
      path: "AGENTS.md",
      message: "AGENTS.md 超过 200 行，建议把按需知识迁移到规则或技能。"
    });
  }

  const scripts = parseScripts(new Map(request.documents.map((item) => [item.path, item.content])));
  const commandLines = scripts.length > 0
    ? scripts.map((script) => `- \`${script.command}\`：执行 ${script.name}。`)
    : ["- 从项目清单和 CI 配置确认命令；不要凭空猜测。"];
  const extractedNavigation = mapLines(request.codebase_map.content);
  const navigation = request.codebase_map.status === "missing"
    ? ["- 尚无 codebase map；首次调查后补充稳定的模块边界，不要记录逐文件清单。"]
    : extractedNavigation.length === 0
      ? ["- Codebase Map 已存在；需要模块信息时读取 `.harness/codebase/map`，不要复制整份地图。"]
      : extractedNavigation.map((line) => `- ${line}`);
  const recent = request.recent_changes.slice(0, 5).map((change) =>
    `- \`${change.change_key}\`：${oneLine(change.summary, 500)}`
  );
  const projectGuidance = projectTypeGuidance(request.project_profile);
  const preservedAgents = preserveProjectContent(
    existingAgents,
    "项目特定约定",
    "已有项目约定（保留并待复核）"
  );
  const agentsContent = [
    "# 项目协作指南",
    "",
    "## 项目概览",
    "",
    `- 项目：${input.projectName}`,
    `- 类型：${request.project_profile}`,
    "- 默认使用中文编写项目知识、规则、归档总结和 Agent 文档。",
    "",
    "## 仓库导航",
    "",
    ...navigation,
    "",
    "## 常用命令",
    "",
    ...commandLines,
    "",
    "## 工作约束",
    "",
    "- 先读取距离目标文件最近的 AGENTS.md；更深层文档覆盖上层约定。",
    "- 优先复用 codebase map、现有模块接口和远端知识查询，避免重复扫描整个仓库。",
    "- 修改协议、持久化结构或公共接口时，必须同时补迁移、兼容策略和契约测试。",
    "- 不把日志、临时报告、缓存或本地密钥当作长期项目知识。",
    "",
    "## 项目类型约束",
    "",
    ...projectGuidance,
    "",
    "## 验证要求",
    "",
    "- 先运行与改动最接近的测试，再按风险运行 lint、类型检查和完整测试。",
    "- 完成时报告实际执行的验证及已知基线失败，不把未执行的检查描述为通过。",
    "",
    "## 安全与提交",
    "",
    "- 不提交令牌、凭据、本机绝对路径或可恢复的敏感内容。",
    "- 保留用户已有改动；高风险、不可逆或扩大范围的操作必须先获得明确授权。",
    "",
    "## 文档与规则演进",
    "",
    "- 变更结束后只提交有证据、可执行、可验证的规则候选；候选默认不自动生效。",
    "- 删除已失效、可从代码直接推断或重复的说明，保持常驻指令简短。",
    ...(recent.length === 0 ? [] : ["", "## 最近归档线索", "", ...recent]),
    "",
    "## 项目特定约定",
    "",
    "以下内容从现有文档保留；应用提案前应确认仍然有效。",
    "",
    preservedAgents,
    ""
  ].join("\n");

  const preservedRules = preserveProjectContent(
    current.get(".harness/rules/project-guidance.md")?.content ?? "",
    "项目特定规则"
  );
  const rulesContent = [
    "# 项目规则",
    "",
    "## 适用原则",
    "",
    "- 规则必须具体、可执行、可验证，并注明适用范围。",
    "- 能由格式化器、lint、类型系统或测试强制的约束，优先交给工具执行。",
    "- 只在至少一次归档证据支持且人工确认后提升规则候选。",
    "",
    "## 架构与接口",
    "",
    ...projectGuidance,
    "- 公共协议与持久化格式的变更必须保留版本、迁移与回滚路径。",
    "",
    "## 测试与质量",
    "",
    "- 新行为先补会失败的测试，再实现最小变更使其通过。",
    "- 测试替身只用于系统边界，不得用 mock 验证自己编造的行为。",
    "",
    "## 项目特定规则",
    "",
    "以下内容从现有规则保留；规则候选不会自动写入这里。",
    "",
    preservedRules,
    ""
  ].join("\n");
  const files = [
    proposedFile("AGENTS.md", agentsContent, current),
    proposedFile(
      ".harness/rules/project-guidance.md",
      rulesContent,
      current
    )
  ];
  if (request.adapters.includes("claude-code")) {
    files.push(proposedFile(
      "CLAUDE.md",
      "@AGENTS.md\n@.harness/rules/project-guidance.md\n",
      current
    ));
  }
  if (request.adapters.includes("cursor")) {
    files.push(proposedFile(
      ".cursor/rules/project-guidance.mdc",
      [
        "---",
        "description: 项目级架构、验证与安全约束",
        "globs:",
        "alwaysApply: true",
        "---",
        "",
        "遵循 @AGENTS.md 与 @.harness/rules/project-guidance.md。",
        ""
      ].join("\n"),
      current
    ));
  }
  if (request.adapters.includes("codebuddy")) {
    files.push(proposedFile(
      "CODEBUDDY.md",
      "请遵循 AGENTS.md 与 .harness/rules/project-guidance.md 中的项目约定。\n",
      current
    ));
  }

  const groupedCandidates = new Map<string, {
    content: string;
    evidence: Array<{ change_key: string; summary: string }>;
  }>();
  for (const change of request.recent_changes) {
    for (const rawDecision of change.decisions) {
      const content = oneLine(rawDecision, 2_000);
      if (content === "") continue;
      const key = content.toLocaleLowerCase("zh-CN");
      const candidate = groupedCandidates.get(key) ?? { content, evidence: [] };
      if (!candidate.evidence.some((item) => item.change_key === change.change_key)) {
        candidate.evidence.push({
          change_key: change.change_key,
          summary: oneLine(change.summary, 10_000)
        });
      }
      groupedCandidates.set(key, candidate);
    }
  }
  const ruleCandidates = [...groupedCandidates.values()]
    .sort((left, right) => left.content.localeCompare(right.content, "zh-CN"))
    .map((candidate) => ({
      candidate_id: "rc_" + sha256Bytes(candidate.content).slice(7, 23),
      content: candidate.content,
      evidence: candidate.evidence,
      evidence_count: candidate.evidence.length,
      auto_apply: false,
      recommendation: candidate.evidence.length >= 2 ? "promote" as const : "review" as const
    }));
  const proposalHash = sha256Bytes(canonicalJson({
    project_id: input.projectId,
    request,
    files: files.map((file) => ({ path: file.path, content_sha256: file.content_sha256 }))
  }));
  return {
    schema_version: 1 as const,
    proposal_id: "ipr_" + proposalHash.slice(7, 31),
    project_id: input.projectId,
    language: "zh-CN" as const,
    mode: "audit-propose" as const,
    applied: false,
    generated_at: new Date().toISOString(),
    findings,
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
    rule_candidates: ruleCandidates,
    basis: [
      "https://agents.md/",
      "https://openai.com/index/unrolling-the-codex-agent-loop/",
      "https://code.claude.com/docs/en/best-practices",
      "https://docs.cursor.com/context/rules"
    ]
  };
}
