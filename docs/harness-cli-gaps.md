# Hunter-Harness CLI 缺口清单（E:\MyProject\AI Related\Hunter-Harness）

> 来源：2026-08-07 hunter-platform 前端 UX 改造中识别出的 CLI 侧待办。
> 平台服务端（hunter-platform/apps/server）的缺口见 `docs/platform-server-gaps.md`。
> 每项含：缺失什么 / 哪里修 / 方向 / 成果预期。

## C1. 归档核心内容随 push 上传（分级清单） — ✅ 已完成

- **状态**：核心四件套（spec/plans/summary-data + knowledge entries）此前已落地；**可选辅助档**已于本轮补齐。
- **已实现**：
  - `packages/core/src/push/push.ts` `walkArchiveSummaries`：核心 + `reports/review/*`、`reports/test/*`、`meta/archive-meta.md`、`meta/change-context.json`
  - `packages/core/src/policy/file-policy.ts`：上述路径标为 `GENERATED_REVIEWABLE`
  - `harness/scripts/harness_archive.py` `collect_archive_core_paths`：并行清单同步
- **仍不传**：`evidence/**`、`events.ndjson`、`logs/**`、`runtime/**`、`*.html`（如 final-summary.html）等诊断类内容

## C2. project_id 漂移防护（CLI 部分） — ✅ 已完成

- **状态**：静默改绑已禁止。
- **已实现**：
  - `connect`：本地 `project_id` 与 Key 的 `project_id` 不一致时要求 `--rebind`（`--yes`  alone 不够）；交互模式可显式确认改绑
  - `push`：`project_id === null` 将解析/创建时打印项目名；交互确认；非交互需 `--yes`（`allowCreateProject`）
- **平台侧配套**：见 `platform-server-gaps.md` S7（purge 后不再静默新建等）

## C3. change 生命周期自动上报（监控启停） — ✅ 已完成

- **状态**：best-effort 钩子已挂到 gate begin / archive finalize（失败只告警）。
- **已实现**：
  - `harness_gate.py begin` → `harness_events_sync.auto_events_sync`（注册 run / heartbeat → `running`）
  - `harness_archive.py finalize`：在 auto-push 后 sync，沿用归档前 change 路径的 `run_id` + 原 `change_key`，使平台 `phase.end`/`archive` 推导 succeeded/failed + `ended_at`
  - SKILL：`harness-run`、`harness-archive` 已注明钩子说明
- **手动兜底**：`hunter-harness events-sync [--change-dir …]`

## C4. 知识 ingest 远程优先、query 查服务端 — ✅ 文档已对齐

- **状态**：代码路径（条目随 push 上传、CLI 远程 query 能力）此前已有；本轮对齐 skill 文档。
- **已实现（文档）**：
  - `harness-knowledge-ingest/SKILL.md`：本地抽取 + 平台裁决/投影；本地 SQLite/judge 仅离线回退
  - `harness-knowledge-query/SKILL.md`：默认远程语义搜索，离线回退本地索引
- **依赖**：平台 S4（ingest 裁决 / deprecate）落地后，多机共享裁决结果才完整

## 已完成记录

- **生成内容语言约定（2026-08-07）**：`harness/shared/p0-trust.md` 新增"生成内容语言约定"（文档/规则/知识/架构优先中文，标识符与字段名保持原文），`harness-knowledge-ingest/SKILL.md` 已引用。
- **C1–C4（2026-08-08）**：见上各节；CLI/workflow 发版与双仓 commit 属后续收尾阶段。
