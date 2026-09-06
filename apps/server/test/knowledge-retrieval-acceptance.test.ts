import { describe, expect, it } from "vitest";

import {
  rankLexical,
  relevanceTokens,
  type LexicalDocument
} from "../src/knowledge-pipeline/search-rank.js";

/**
 * 检索验收问题集（冻结）——审查报告《验收与退出条件》第 1/2 条的可执行雏形。
 *
 * 语料取自 2026-09-05 报告内容审阅引用的真实条目与真实 design 示例，按三个
 * 伪项目组织；问题集覆盖报告要求的六类：普通问题、历史原因、兼容约束、
 * 无答案（含领域相邻的困难负例）、过期（已修复保留历史身份）、冲突（同主题
 * 多条并存、合并阅读）。
 *
 * 冻结纪律：语料与问题集一经提交不再按失败样本调整；排序器参数不在本会话
 * 修改。报告提议的"前三覆盖 ~80%"门槛属于未来独立项目验证轮，这里只记录
 * 当前实现的实测覆盖率作为回归下限（COVERAGE_FLOOR）。
 *
 * 边界：rankLexical 是纯检索模型；项目隔离/适用范围过滤发生在 SQL 预筛层
 * （E4），此处不重复验证。检索命中 ≠ 问题可答（报告：有对应风险不等于有
 * 完整修复方法）。
 */

interface CorpusDoc extends LexicalDocument {
  project: string;
  id: string;
}

const doc = (project: string, id: string, overrides: Partial<CorpusDoc>): CorpusDoc => ({
  display_title: "",
  summary: "",
  project,
  id,
  ...overrides
});

// 冻结语料：三个项目，条目 = 报告内容审阅 A/B 档真实示例 + design 真实章节。
const CORPUS: CorpusDoc[] = [
  // --- 项目 usage-report（用量上报） ---
  doc("usage-report", "exit-code", {
    display_title: "上报失败不改变业务退出码",
    summary: "事件上报失败时业务命令的退出码保持不变，遥测失败不改变退出码",
    body: "遥测/上报服务不可用时只记录告警，业务命令退出码保持原值。",
    keywords: ["退出码", "上报", "遥测", "failure_behavior"]
  }),
  doc("usage-report", "address-priority", {
    display_title: "上报服务地址配置优先级",
    summary: "上报服务地址取值顺序为 config 优先，其次 kb-state.api，再次 env，最后默认值",
    body: "完整优先顺序：config > kb-state.api > env > 默认。",
    keywords: ["优先级", "配置", "上报", "地址"]
  }),
  doc("usage-report", "append-pending", {
    display_title: "并发追加用量事件的数据丢失风险",
    summary: "并发追加用量事件时 appendPending 存在竞态，本地队列可能丢失数据",
    body: "历史风险：appendPending 竞态导致部分事件未落盘；修复方法需补写盘时序。",
    keywords: ["并发", "appendPending", "队列", "丢失"]
  }),
  // --- 项目 access-control（权限平台） ---
  doc("access-control", "tenant-visibility-scope", {
    display_title: "管理员租户可见性边界",
    summary: "管理员只可见本租户上下文，跨租户管理操作需要显式切换租户",
    body: "管理员可见性按租户隔离；越权读取返回空集而非报错。",
    keywords: ["管理员", "租户", "可见性", "边界"]
  }),
  doc("access-control", "tenant-visibility-version", {
    display_title: "权限版本变化对模型可见上下文的影响",
    summary: "权限版本变化会清空模型可见上下文，但保留业务槽位数据",
    body: "权限版本 bump：可见上下文清空、业务槽位保留。",
    keywords: ["管理员", "权限版本", "上下文", "槽位"]
  }),
  doc("access-control", "perm-version-compat", {
    display_title: "权限版本字段兼容边界",
    summary: "旧记录没有 perm_version 字段时按版本 1 处理，不受新逻辑影响",
    body: "兼容边界：缺失 perm_version 视为 v1，不清空上下文。",
    keywords: ["兼容", "perm_version", "旧记录", "api-contract"]
  }),
  // --- 项目 agent-platform（Agent 平台） ---
  doc("agent-platform", "agent-scope-serialization", {
    display_title: "AgentScope 序列化契约升级约束",
    summary: "AgentScope 序列化契约升级前需要重跑存储契约测试",
    body: "升级 AgentScope 前：先跑存储契约测试，确认读写双向兼容。",
    keywords: ["AgentScope", "序列化", "契约", "升级"]
  }),
  doc("agent-platform", "quick-entry-tradeoff", {
    display_title: "否决独立快速入口的取舍",
    summary: "否决独立 /opsx-quick-simple 入口，因为会制造第二入口、与现有流程分裂",
    body: "取舍：统一走既有 propose 流程，在流程内加标记，不建第二入口。",
    keywords: ["取舍", "否决", "入口", "decision", "tradeoff"]
  }),
  doc("agent-platform", "git-diff-failure", {
    display_title: "git diff 失败时的行为契约",
    summary: "git/diff 失败跳过规模判定、不阻断 propose",
    body: "失败行为：diff 不可用时跳过规模判定，propose 继续推进。",
    keywords: ["git", "diff", "失败", "failure_behavior", "propose"]
  }),
  doc("agent-platform", "autoscale-compat", {
    display_title: "旧 proposal 的 auto-scale 兼容边界",
    summary: "旧 proposal 没有 auto-scale 字段时不受新逻辑影响",
    body: "兼容边界：无 auto-scale 字段的旧 proposal 走原路径。",
    keywords: ["兼容", "auto-scale", "proposal", "api-contract"]
  }),
  // 过期/环境类（报告 C 档示例，保留历史身份，不作当前有效展示）
  doc("agent-platform", "mvn-gitbash", {
    display_title: "本机 Git Bash 下 mvn 启动故障（已修复，历史记录）",
    summary: "本机 Git Bash 环境曾出现 mvn 启动故障，后经环境调整修复",
    body: "单次环境问题，已修复；保留为历史线索，不作为当前行为结论。",
    keywords: ["mvn", "Git Bash", "环境", "历史"]
  })
];

// 冻结问题集：expected 为"目标来源进前三"的验收断言对象。
interface FrozenQuestion {
  category: "普通问题" | "历史原因" | "兼容约束" | "无答案" | "过期" | "冲突";
  question: string;
  expectedInTop3: readonly string[];
}

const QUESTIONS: readonly FrozenQuestion[] = [
  { category: "普通问题", question: "使用事件上报失败时是否应该改变业务命令的退出码？", expectedInTop3: ["exit-code"] },
  { category: "普通问题", question: "上报服务地址的配置优先级是什么？", expectedInTop3: ["address-priority"] },
  { category: "普通问题", question: "并发追加用量事件时如何防止本地队列丢失数据？", expectedInTop3: ["append-pending"] },
  { category: "普通问题", question: "共享测试库 tearDown 会删除哪些数据？", expectedInTop3: [] }, // 语料未收录该条（报告真实空缺），预期无法检索——记录为已知空缺
  { category: "历史原因", question: "为什么不新增独立的 Simple 快速入口？", expectedInTop3: ["quick-entry-tradeoff"] },
  { category: "历史原因", question: "git diff 失败时应该阻断 propose 吗？", expectedInTop3: ["git-diff-failure"] },
  { category: "兼容约束", question: "旧 proposal 没有 auto-scale 字段，会受新逻辑影响吗？", expectedInTop3: ["autoscale-compat"] },
  { category: "兼容约束", question: "旧记录缺少 perm_version 字段会怎样？", expectedInTop3: ["perm-version-compat"] },
  { category: "过期", question: "本机 Git Bash 下 mvn 启动失败是什么问题？", expectedInTop3: ["mvn-gitbash"] },
  { category: "冲突", question: "管理员租户可见性的边界是什么？", expectedInTop3: ["tenant-visibility-scope", "tenant-visibility-version"] }
];

// 无答案（含报告原负例 + 领域相邻困难负例）：检索层必须零返回。
const NO_ANSWER_QUESTIONS: readonly string[] = [
  "肯尼亚旅行签证需要什么材料？",
  "电商订单怎样申请退款？",
  "如何优化数据库索引提升查询速度？"
];

function top3Ids(question: string): string[] {
  return rankLexical(relevanceTokens(question), CORPUS)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((entry) => (entry.doc as CorpusDoc).id);
}

describe("frozen knowledge retrieval acceptance set", () => {
  it("returns nothing for no-answer questions instead of a nearest-neighbor guess", () => {
    for (const question of NO_ANSWER_QUESTIONS) {
      expect(top3Ids(question), question).toEqual([]);
    }
  });

  it("finds expected sources in the top 3 for answerable questions", () => {
    const failures: string[] = [];
    const answerable = QUESTIONS.filter((question) => question.expectedInTop3.length > 0);
    for (const question of answerable) {
      const ids = top3Ids(question.question);
      const missing = question.expectedInTop3.filter((expected) => !ids.includes(expected));
      if (missing.length > 0) failures.push(`${question.category}「${question.question}」缺 ${missing.join(",")}，实际前三 ${ids.join(",") || "空"}`);
    }
    // 回归下限 = 首轮实测（见 git blame 时的值）；报告的 ~80% 门槛留给
    // 独立项目验证轮。任何低于下限的退化都会让本测试失败。
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("documents known coverage gaps instead of hiding them", () => {
    // tearDown 问题在当前语料中确无来源（报告记录的真实空缺）：
    // 检索层对它返回空是正确行为，不能为了好看硬凑语料。
    const gap = QUESTIONS.find((question) => question.expectedInTop3.length === 0);
    expect(gap?.question).toContain("tearDown");
    expect(top3Ids(gap?.question ?? "")).toEqual([]);
  });
});
