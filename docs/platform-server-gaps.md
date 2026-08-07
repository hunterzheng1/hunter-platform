# 平台服务端缺口清单（hunter-platform / apps\server）

> 来源：2026-08-07 前端 UX 改造（分支监控 / 项目工作区 / 知识库 / 工作流 / 项目创建）。
> Hunter-Harness CLI 侧需要改的内容见 `docs/harness-cli-gaps.md`。
> 每项含：缺失什么 / 哪里修 / 方向 / 成果预期。按优先级排序。

## P0 — 安全

### S1. adm-zip 升级（0.5.18 → 0.6.x）

- **缺失**：`adm-zip@0.5.18` 有高危漏洞 [GHSA-xcpc-8h2w-3j85]（构造 ZIP 触发 4GB 内存分配，zip 炸弹 DoS）。攻击面：技能/工作流上传包解压。
- **哪里修**：`apps/server/package.json` 依赖 `adm-zip`；解压调用点（skill draft 上传、workflow profile 上传链路）。
- **方向**：`npm install adm-zip@^0.6.0 -w apps/server`（breaking，0.6 的 entry 解析行为有变化），加 zip 大小/展开比上限。
- **成果**：`npm audit` 清零；构造的恶意 zip 被大小限制直接拒绝，回归测试覆盖上传链路。
- **前端侧已处理**：`postcss` 高危已通过根 `overrides` 升至 8.5.23。

## P1 — 功能（前端页面已就绪，等端点）

### S2. Web 端创建项目端点

- **缺失**：服务端没有 Web 创建项目的接口；项目只能由 CLI push 经 `resolveProject` 隐式创建。
- **前端状态**：✅ 已完成。项目列表页「新建项目」Modal → `createProject({ display_name })`（`apps/web/lib/api.ts`，POST `/api/v1/projects`，兼容 `{project}` 包裹或直接返回两种形态），404/405/501 时提示"端点落地中"。
- **哪里修**：`apps/server/src/app.ts` 项目路由组；复用 `resolveProject` 的建项逻辑。
- **方向**：`POST /api/v1/projects`，body `{ display_name: string }`，返回创建的 project；可选 `?withKey=true` 联动签发首把 API key（复用现有 `POST /projects/:id/api-keys`），响应附带一次性明文 key，前端直接展示 `hunter-harness connect <url> --key <key>` 完整命令。
- **成果预期**：用户全程不离开 Web：创建项目 → 复制 connect 命令 → 本机执行 → 项目开始同步。

### S3. 分支归档清单 + 文件内容端点

- **缺失**：服务端没有归档文件清单与内容（CLI 只上传 `summary-data.json`，见 harness-cli-gaps.md C1）。前端「归档文件」面板当前用 mock 数据（`apps/web/lib/mock-archive.ts`，与 CBM Forge 真实归档同构，带"示例数据"徽标）。
- **哪里修**：`apps/server/src/app.ts` + 存储层（`apps/server/src/storage/`、`repositories/postgres.ts`）。
- **方向**：
  - `GET /api/v1/projects/:id/changes/:changeKey/archive` → 返回 `{ changeKey, archivedAt, files: [{ path, sizeBytes, kind, tier }] }`（形状对齐 `mock-archive.ts` 的 `ChangeArchive`）；
  - `GET /api/v1/projects/:id/changes/:changeKey/archive/content?path=...` → 返回单文件文本内容（Markdown/JSON），供前端阅读器渲染；
  - 建立 artifact ↔ change 关联字段（`ArtifactSummary` 目前无 change 定位符）。
- **成果预期**：分支监控详情可浏览归档清单、点击即可阅读设计文档/计划全文；mock 数据源一行替换为真实 API。

### S4. 服务端知识 ingest 与自动裁决（架构变更）

- **缺失**：知识抽取与 candidate→active 裁决目前在本机 CLI（harness-knowledge-ingest 的 autoPromote/judge）；服务端只做投影。目标架构：CLI 随归档上传知识条目，服务端完成抽取、置信度裁决、自动投影。
- **前端状态**：✅ 全局知识库已移除「候选审核/候选条目」tab 与「待投影」banner，只保留跨项目搜索/浏览。
- **哪里修**：`apps/server/src/app.ts`（knowledge/entries 接收链路）、`apps/server/src/semantic/`（投影管线）。
- **方向**：
  1. ingest 管线接收归档上传的知识条目 → 裁决（移植 CLI 的置信度/autoPromote 逻辑，或 AI 裁决）→ 直接投影为 active；
  2. 文档级废弃端点 `POST /projects/:id/semantic/knowledge/:documentId/deprecate`（现有 `updateKnowledgeEntryStatus` 作用于 ingest entry，而前端展示的是投影 document，需要 document 级废弃并在投影/搜索中排除）；
  3. 覆盖语义：`deprecated` 不被后续 push 覆盖，需显式 revive（当前 `upsertKnowledgeEntry` 在内容变化时会以本地 status 覆盖，`postgres.ts:394-400`）。
- **成果预期**：知识"上传即生效"，无人工审核环节；用户可在 Web 端废弃过时知识；harness-knowledge-query 直接查服务端。

### S5. 工作流族来源关联与版本同步

- **缺失**：`WorkflowFamily` 无来源字段，无法关联 npm 包 / GitHub 仓库；版本更新只能手工上传。前端已有「检查更新」按钮（端点缺失时显示占位提示，`workflow-center.tsx` → `api.syncWorkflowFamily`）。
- **哪里修**：`apps/server/src/registry/workflow-family-store.ts`（模型加 `source`）、`apps/server/src/external/fetchers.ts`（已有 GitHub fetcher 可复用模式）、npm registry 版本比对。
- **方向**：family 增加 `source: { type: "npm" | "github", ref: string }`；`POST /registry/workflow-families/:slug/sync` 比对来源最新版本 → 有新版则拉取 bundle 生成 draft（或直接发布），响应 `{ updated: boolean, version?: string }`。
- **成果预期**：工作流页点「检查更新」即可同步 hunter-harness 这类 npm 分发的工作流新版本；CLI `sync/update` 可拉到新 bundle。

## P1 — 性能

### S6. 语义知识/运行列表服务端分页

- **缺失**：`GET .../semantic/knowledge` 全量返回（含 body 全文）；`GET .../runs` 全量返回且排序未约定。
- **前端临时方案**：并行拉取 + 客户端分页（知识 20/页）。
- **方向**：两接口支持 `limit`/`cursor` 并返回 `total`；知识列表项不含 body（详情单取）；runs 服务端保证按开始时间倒序 + 可选 `status` 过滤。
- **成果预期**：知识库/分支监控首屏与条目数解耦；大项目不再卡顿。

## P2 — 增强

### S7. project_id 漂移防护（服务端部分）

- **缺失**：`resolveProject` 按 `local_project_key` 命中已归档/已有项目时静默新建/改绑 → 平台上出现多个"同一项目"。CLI 侧触发点见 harness-cli-gaps.md C2。
- **方向**：resolve 命中已有项目时返回冲突标记而非静默新建；项目列表接口附 `local_project_key` 便于前端去重提示。
- **成果预期**：同一本地仓库在平台上始终只有一个项目；改绑需显式确认。

### S8. SSE 断线重连 / 断点续传

- **缺失**：`/runs/:id/stream` 断开后无恢复语义，前端只能降级轮询。
- **方向**：支持 `Last-Event-ID`（或 `after_cursor`）断点续传；事件按 `server_cursor` 幂等（前端已按 `event_id` 去重）。
- **成果预期**：弱网/重启后监控不断流，轮询仅作兜底。

### S9. Run 阶段结构化（可选增强）

- **现状**：前端已基于 harness 固定阶段模板渲染（6 基础阶段 + package/apidoc 条件阶段），基本满足。
- **可选方向**：`RunSummary.phases[]` 携带 per-phase 起止时间与耗时（事件流里已有数据，聚合即可），前端进度条可显示每阶段耗时。

### S10. 跨项目运行聚合（可选）

- **背景**：全局 /runs 页已下线（监控内置于项目）。如未来要做全局运行墙：`GET /api/v1/runs?status=running` 跨项目聚合，避免前端 N+1。

## 已决策记录

- **归档摘要展示**：前端已移除「归档摘要」区块（用户判断信息密度低）。**数据收集保留**：`summary-data.json` 是归档记录与知识抽取（S4）的唯一来源，上传管线不变——不展示 ≠ 不收集。
- **阶段模板**：前端硬编码 harness 阶段契约（注释标注出处）；若 `PHASE_ORDER` 演进，建议挪入 `@hunter-harness/contracts` 共享。
