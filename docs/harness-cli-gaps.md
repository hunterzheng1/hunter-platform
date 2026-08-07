# Hunter-Harness CLI 缺口清单（E:\MyProject\AI Related\Hunter-Harness）

> 来源：2026-08-07 hunter-platform 前端 UX 改造中识别出的 CLI 侧待办。
> 平台服务端（hunter-platform/apps/server）的缺口见 `docs/platform-server-gaps.md`。
> 每项含：缺失什么 / 哪里修 / 方向 / 成果预期。

## C1. 归档核心内容随 push 上传（分级清单）

- **缺失**：push 目前只上传归档的 `reports/final/summary-data.json`（`packages/core/src/push/push.ts` 的 `ARCHIVE_SUMMARY_PATH` 过滤），设计文档、计划、知识条目等核心内容不上传 → 平台无法展示/阅读归档。
- **哪里修**：`packages/core/src/push/push.ts` 的受管文件集（`ARCHIVE_SUMMARY_PATH` 附近）。
- **方向**：按分级清单上传，平衡价值与推送压力（参照 CBM Forge 真实归档树）：

  | 级别 | 文件 | 说明 |
  | --- | --- | --- |
  | **必传（核心）** | `spec/*-design.md`、`plans/*-plan.md`、`-implementation-detail.md`、`-test-scenarios.md` | 设计与计划是最重要的归档资产，供日后查阅"当时怎么设计的" |
  | **必传（核心）** | `knowledge/entries/**`（active 及候选条目 JSON） | 配合服务端 ingest/裁决（platform-server-gaps.md S4） |
  | **必传（核心）** | `reports/final/summary-data.json` | 现有行为保留（归档记录数据源） |
  | **可选（辅助）** | `reports/review/*`、`reports/test/*`、`meta/archive-meta.md`、`meta/change-context.json` | 评审/测试报告与归档元信息，体积小有参考价值 |
  | **不传（诊断）** | `evidence/**`、`events.ndjson`、`logs/**`、`runtime/**`、`*.html` | 证据包/日志/事件流体积大、查阅频率低；事件流已由 events-sync 单独上报 |

- **成果预期**：单个归档上传增量约 50–80KB（仅核心+辅助），平台"归档文件"面板可列出清单并在线阅读设计/计划全文；诊断类内容仍在本机可查。

## C2. project_id 漂移防护（CLI 部分）

- **缺失**：两处会静默改绑 project_id —— `connect` 用 API key 对应的 project_id 覆写 `project.yaml`（`packages/cli/src/commands/connect.ts:62-77`）；push 时 `project_id === null` 会按 `local_project_key` 重新解析/新建并原子回写（`packages/core/src/push/push.ts:564-591, 719-731`）。换 key 或清空配置后，平台出现重复项目。
- **哪里修**：`packages/cli/src/commands/connect.ts`、`packages/core/src/push/push.ts`。
- **方向**：
  - connect/push 检测到本地 `project_id` 与服务端绑定不一致时，打印双方项目名并要求显式 `--rebind` 才允许改绑；
  - push 的静默新建路径在终端明确提示"将创建新项目 <name>"并二次确认（非交互模式 `--yes` 跳过）。
- **成果预期**：同一仓库不会因误操作在平台裂变成多个项目；改绑是有意识的显式动作。

## C3. change 生命周期自动上报（监控启停）

- **缺失**：events-sync（`harness/scripts/harness_events_sync.py`）需手动/外部触发；目标流程是"创建 change 自动开始监控，归档自动上传并结束监控"。
- **哪里修**：`harness/harness-run/SKILL.md`（change 创建钩子）、`harness/harness-archive/SKILL.md`（归档完成钩子）、`harness_events_sync.py`。
- **方向**：harness-run 创建 change 时自动启动 events-sync（注册 run、上报 `run_status: running`）；harness-archive 完成后上传归档核心内容（C1）并上报终态（succeeded/failed + `ended_at`）。
- **成果预期**：平台分支监控零手工干预：开 change 即见运行，归档即见完整归档文件与终态。

## C4. 知识 ingest 退化为本地上传、query 改查服务端

- **缺失**：知识抽取/裁决目前全在本地（`harness/harness-knowledge-ingest/`，SQLite FTS MVP）；目标架构是服务端裁决（platform-server-gaps.md S4）。
- **哪里修**：`harness/harness-knowledge-ingest/SKILL.md` + 脚本、`harness/harness-knowledge-query/`。
- **方向**：ingest 保留本地抽取（产出条目 JSON），但裁决/投影交给服务端——条目随归档上传（C1 清单）；query 默认走服务端语义搜索，本地索引仅作离线回退。
- **成果预期**：多机/多人共享同一知识库裁决结果；本地无 SQLite 维护负担；平台知识库与 CLI 查询结果一致。

## 已完成记录

- **生成内容语言约定（2026-08-07）**：`harness/shared/p0-trust.md` 新增"生成内容语言约定"（文档/规则/知识/架构优先中文，标识符与字段名保持原文），`harness-knowledge-ingest/SKILL.md` 已引用。
