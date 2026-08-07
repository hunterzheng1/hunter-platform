/**
 * 分支归档文件的 mock 数据源。
 * 形状与内容参照真实项目 E:\MyProject\CBM Forge\.harness\archive\<change>\ 的归档树。
 * 待服务端归档清单/内容端点落地后替换为真实 API（见 docs/platform-server-gaps.md）。
 */

export interface ArchiveFileEntry {
  path: string;
  sizeBytes: number;
  kind: "design" | "plan" | "report" | "evidence" | "meta" | "log" | "knowledge";
  /** 核心=设计/计划/知识/摘要；辅助=评审/测试/元信息；诊断=证据/日志/事件流 */
  tier: "core" | "supporting" | "diagnostic";
  /** 可阅读内容（mock 仅核心文件有正文） */
  content?: string;
}

export interface ChangeArchive {
  changeKey: string;
  archivedAt: string;
  files: ArchiveFileEntry[];
}

const DESIGN_CONTENT = `# 空间治理生产发布 — 设计文档

## 背景与目标

生产环境的空间治理策略需要支持按租户隔离的配额模型，并在发布前完成远程候选验证（remote-attested）。

## 方案

1. **配额模型**：租户级配额表 + 继承默认策略；超限走人工审批而非硬阻断。
2. **验证链路**：candidate run 在隔离环境产出证据包（environmentHash + productTreeHash），平台侧校验后进入 releaseDecision。
3. **回滚**：保留上一版策略快照，发布动作幂等。

## 关键决策

- 选择"远程证据 + 本地台账"双写，而非仅本地记录 —— 满足审计要求。
- 门禁策略阈值首周人工抽查 10%，避免误拦截。

## 风险

- 租户配额表迁移期间存在约 2 分钟的双写窗口，需运维通告。
`;

const PLAN_CONTENT = `# 空间治理生产发布 — 实施计划

## 阶段拆解

| 步骤 | 内容 | 验证 |
| --- | --- | --- |
| 1 | 配额表 schema + 迁移脚本 | 单测覆盖迁移正反路径 |
| 2 | 候选验证证据采集 | evidence/candidate-* 回执完整 |
| 3 | 发布门禁接入 releaseDecision | 策略单测 + 集成冒烟 |
| 4 | 回滚快照与演练 | 演练记录入档 |

## 测试场景

- 配额超限 → 进入人工审批队列
- 证据包 hash 不匹配 → 发布阻断并告警
- 迁移中断 → 幂等重放
`;

const SUMMARY_CONTENT = JSON.stringify({
  schemaVersion: "2.3",
  changeName: "spatial-governance-production-release",
  businessGoal: "生产环境空间治理策略发布，含远程候选验证。",
  finalStatus: "OK",
  archiveIntent: "release-candidate",
  verification: {
    unitTests: { status: "OK", passRate: "100%" },
    apiTests: { status: "OK", passRate: "98.6%" },
    dbCompatibility: { status: "OK" }
  },
  reviewSummary: { status: "ADVISORY" },
  knownRisks: ["配额表迁移存在约 2 分钟双写窗口"],
  gitFacts: { filesChanged: 14, insertions: 862, deletions: 210 }
}, null, 2);

const KNOWLEDGE_CONTENT = JSON.stringify({
  schemaVersion: 1,
  type: "decision",
  status: "active",
  title: "配额超限走人工审批而非硬阻断",
  summary: "空间治理配额超限时不直接拒绝写入，而是进入人工审批队列，避免阻塞正常业务抖动。",
  confidence: { score: 0.86, level: "high" }
}, null, 2);

/** 与真实归档同构的示例文件清单（服务端端点未落地前的占位数据）。 */
export function mockChangeArchive(changeKey: string): ChangeArchive {
  const files: ArchiveFileEntry[] = [
    { path: `spec/${changeKey}-design.md`, sizeBytes: 24_832, kind: "design", tier: "core", content: DESIGN_CONTENT },
    { path: `plans/${changeKey}-plan.md`, sizeBytes: 12_108, kind: "plan", tier: "core", content: PLAN_CONTENT },
    { path: `plans/${changeKey}-implementation-detail.md`, sizeBytes: 18_455, kind: "plan", tier: "core", content: PLAN_CONTENT },
    { path: `plans/${changeKey}-test-scenarios.md`, sizeBytes: 9_214, kind: "plan", tier: "core" },
    { path: `knowledge/entries/active/${changeKey}.decision.a1b2c3d4e5.json`, sizeBytes: 3_102, kind: "knowledge", tier: "core", content: KNOWLEDGE_CONTENT },
    { path: `knowledge/entries/active/${changeKey}.requirement.f6e5d4c3b2.json`, sizeBytes: 2_548, kind: "knowledge", tier: "core" },
    { path: "reports/final/summary-data.json", sizeBytes: 31_744, kind: "report", tier: "core", content: SUMMARY_CONTENT },
    { path: "reports/review/review-findings.json", sizeBytes: 7_906, kind: "report", tier: "supporting" },
    { path: `reports/test/test-report-${changeKey}.md`, sizeBytes: 5_633, kind: "report", tier: "supporting" },
    { path: "reports/final/final-summary.html", sizeBytes: 58_320, kind: "report", tier: "diagnostic" },
    { path: "meta/archive-meta.md", sizeBytes: 1_280, kind: "meta", tier: "supporting" },
    { path: "meta/change-context.json", sizeBytes: 2_048, kind: "meta", tier: "supporting" },
    { path: "meta/worktree.json", sizeBytes: 512, kind: "meta", tier: "diagnostic" },
    { path: "evidence/verification-ledger.json", sizeBytes: 11_008, kind: "evidence", tier: "diagnostic" },
    { path: "evidence/db-compatibility.json", sizeBytes: 4_096, kind: "evidence", tier: "diagnostic" },
    { path: "events.ndjson", sizeBytes: 45_056, kind: "log", tier: "diagnostic" },
    { path: "logs/execution-log.md", sizeBytes: 38_912, kind: "log", tier: "diagnostic" }
  ];
  return {
    changeKey,
    archivedAt: new Date(Date.now() - 36 * 3_600_000).toISOString(),
    files
  };
}
