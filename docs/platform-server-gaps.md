# 平台服务端缺口清单（hunter-platform / apps\server）

> 来源：2026-08-07 前端 UX 改造（分支监控 / 项目工作区 / 知识库 / 工作流 / 项目创建）。
> Hunter-Harness CLI 侧需要改的内容见 `docs/harness-cli-gaps.md`。
> 每项含：缺失什么 / 哪里修 / 方向 / 成果预期。按优先级排序。

## P0 — 安全

### S1. adm-zip 升级（0.5.18 → 0.6.x） — ✅ 已完成

- **缺失**：`adm-zip@0.5.18` 有高危漏洞 [GHSA-xcpc-8h2w-3j85]（构造 ZIP 触发 4GB 内存分配，zip 炸弹 DoS）。攻击面：技能/工作流上传包解压。
- **哪里修**：`apps/server/package.json` 依赖 `adm-zip`；解压调用点（skill draft 上传、workflow profile 上传链路）。
- **方向**：`npm install adm-zip@^0.6.0 -w apps/server`（breaking，0.6 的 entry 解析行为有变化），加 zip 大小/展开比上限。
- **成果**：`npm audit` 清零；构造的恶意 zip 被大小限制直接拒绝，回归测试覆盖上传链路。
- **前端侧已处理**：`postcss` 高危已通过根 `overrides` 升至 8.5.23。

## P1 — 功能（前端页面已就绪，等端点）

### S2. Web 端创建项目端点 — ✅ 已完成

- **缺失**：服务端没有 Web 创建项目的接口；项目只能由 CLI push 经 `resolveProject` 隐式创建。
- **前端状态**：✅ 已完成。项目列表页「新建项目」Modal → `createProject({ display_name })`（`apps/web/lib/api.ts`，POST `/api/v1/projects`，兼容 `{project}` 包裹或直接返回两种形态），404/405/501 时提示"端点落地中"。
- **哪里修**：`apps/server/src/app.ts` 项目路由组；复用 `resolveProject` 的建项逻辑。
- **方向**：`POST /api/v1/projects`，body `{ display_name: string }`，返回创建的 project；可选 `?withKey=true` 联动签发首把 API key（复用现有 `POST /projects/:id/api-keys`），响应附带一次性明文 key，前端直接展示 `hunter-harness connect <url> --key <key>` 完整命令。
- **成果预期**：用户全程不离开 Web：创建项目 → 复制 connect 命令 → 本机执行 → 项目开始同步。

### S3. 分支归档清单 + 文件内容端点 — ✅ 已完成

- **缺失**：服务端没有归档文件清单与内容（CLI 只上传 `summary-data.json`，见 harness-cli-gaps.md C1）。前端「归档文件」面板当前用 mock 数据（`apps/web/lib/mock-archive.ts`，与 CBM Forge 真实归档同构，带"示例数据"徽标）。
- **哪里修**：`apps/server/src/app.ts` + 存储层（`apps/server/src/storage/`、`repositories/postgres.ts`）。
- **方向**：
  - `GET /api/v1/projects/:id/changes/:changeKey/archive` → 返回 `{ changeKey, archivedAt, files: [{ path, sizeBytes, kind, tier }] }`（形状对齐 `mock-archive.ts` 的 `ChangeArchive`）；
  - `GET /api/v1/projects/:id/changes/:changeKey/archive/content?path=...` → 返回单文件文本内容（Markdown/JSON），供前端阅读器渲染；
  - 建立 artifact ↔ change 关联字段（`ArtifactSummary` 目前无 change 定位符）。
- **成果预期**：分支监控详情可浏览归档清单、点击即可阅读设计文档/计划全文；mock 数据源一行替换为真实 API。
- **实现备注**：无新表；过滤 `project_files` 路径前缀 `.harness/archive/<changeKey>/`；无数据时返回空清单，前端 mock 仅作兜底。

### S4. 服务端知识 ingest 与自动裁决（架构变更） — ✅ 已完成

- **缺失**：知识抽取与 candidate→active 裁决目前在本机 CLI（harness-knowledge-ingest 的 autoPromote/judge）；服务端只做投影。目标架构：CLI 随归档上传知识条目，服务端完成抽取、置信度裁决、自动投影。
- **前端状态**：✅ 全局知识库已移除「候选审核/候选条目」tab 与「待投影」banner，只保留跨项目搜索/浏览。
- **哪里修**：`apps/server/src/app.ts`（knowledge/entries 接收链路）、`apps/server/src/semantic/`（投影管线）。
- **方向**：
  1. ingest 管线接收归档上传的知识条目 → 裁决（移植 CLI 的置信度/autoPromote 逻辑，或 AI 裁决）→ 直接投影为 active；
  2. 文档级废弃端点 `POST /projects/:id/semantic/knowledge/:documentId/deprecate`（现有 `updateKnowledgeEntryStatus` 作用于 ingest entry，而前端展示的是投影 document，需要 document 级废弃并在投影/搜索中排除）；
  3. 覆盖语义：`deprecated` 不被后续 push 覆盖，需显式 revive（当前 `upsertKnowledgeEntry` 在内容变化时会以本地 status 覆盖，`postgres.ts:394-400`）。
- **成果预期**：知识"上传即生效"，无人工审核环节；用户可在 Web 端废弃过时知识；harness-knowledge-query 直接查服务端。

### S5. 工作流族来源关联与版本同步 — ✅ 已完成

- **缺失**：`WorkflowFamily` 无来源字段，无法关联 npm 包 / GitHub 仓库；版本更新只能手工上传。前端已有「检查更新」按钮（端点缺失时显示占位提示，`workflow-center.tsx` → `api.syncWorkflowFamily`）。
- **哪里修**：`apps/server/src/registry/workflow-family-store.ts`（模型加 `source`）、`apps/server/src/external/fetchers.ts`（已有 GitHub fetcher 可复用模式）、npm registry 版本比对。
- **方向**：family 增加 `source: { type: "npm" | "github", ref: string }`；`POST /registry/workflow-families/:slug/sync` 比对来源最新版本 → 有新版则拉取 bundle 生成 draft（或直接发布），响应 `{ updated: boolean, version?: string }`。
- **成果预期**：工作流页点「检查更新」即可同步 hunter-harness 这类 npm 分发的工作流新版本；CLI `sync/update` 可拉到新 bundle。
- **实现备注**：同步默认只写 draft，不自动 publish。

## P1 — 性能

### S6. 语义知识/运行列表服务端分页 — ✅ 已完成

- **缺失**：`GET .../semantic/knowledge` 全量返回（含 body 全文）；`GET .../runs` 全量返回且排序未约定。
- **前端临时方案**：并行拉取 + 客户端分页（知识 20/页）。
- **方向**：两接口支持 `limit`/`cursor` 并返回 `total`；知识列表项不含 body（详情单取）；runs 服务端保证按开始时间倒序 + 可选 `status` 过滤。
- **成果预期**：知识库/分支监控首屏与条目数解耦；大项目不再卡顿。

## P2 — 增强

### S7. project_id 漂移防护（服务端部分） — ✅ 已完成

- **缺失**：`resolveProject` 按 `local_project_key` 命中已归档/已有项目时静默新建/改绑 → 平台上出现多个"同一项目"。CLI 侧触发点见 harness-cli-gaps.md C2。
- **方向**：resolve 命中已有项目时返回冲突标记而非静默新建；项目列表接口附 `local_project_key` 便于前端去重提示。
- **成果预期**：同一本地仓库在平台上始终只有一个项目；改绑需显式确认。
- **实现备注**：purge 后保留 binding 作为 tombstone；再次 resolve 返回 `PROJECT_PURGED` + `recreate_required`；需 `recreate: true` 才新建。

### S8. SSE 断线重连 / 断点续传 — ✅ 已完成

- **缺失**：`/runs/:id/stream` 断开后无恢复语义，前端只能降级轮询。
- **方向**：支持 `Last-Event-ID`（或 `after_cursor`）断点续传；事件按 `server_cursor` 幂等（前端已按 `event_id` 去重）。
- **成果预期**：弱网/重启后监控不断流，轮询仅作兜底。

### S9. Run 阶段结构化（可选增强） — ✅ 已完成

- **现状**：前端已基于 harness 固定阶段模板渲染（6 基础阶段 + package/apidoc 条件阶段），基本满足。
- **可选方向**：`RunSummary.phases[]` 携带 per-phase 起止时间与耗时（事件流里已有数据，聚合即可），前端进度条可显示每阶段耗时。

### S10. 跨项目运行聚合（可选）

- **背景**：全局 /runs 页已下线（监控内置于项目）。如未来要做全局运行墙：`GET /api/v1/runs?status=running` 跨项目聚合，避免前端 N+1。
- **状态**：明确不做（本轮范围外）。

### S11. Platform Information 视图未开箱可用（密钥 + 数据源双层缺口）

- **现象**：项目详情的「分支文件 / 项目资料 / 项目知识（平台信息版）/ 变更记录」页报 `PLATFORM_INFORMATION_UNAVAILABLE`（"… adapter is not configured"）。
- **第一层（配置）**：~~四个视图适配器仅在对应游标签名密钥存在时才组合，未配置即 503~~。**已于 2026-08-08 修复**：`production.ts` 的密钥解析改为 环境变量 → `*_FILE` → **进程内临时密钥兜底**（base64url 24 字节=32 字符，满足 SECRET_BYTES=32 与 ≥16 不重复字节约束；仅在有 pg pool 时启用，无 pool 仍保持 fail-closed；console.warn 提示多实例生产应显式配置共享密钥）。测试 `platform-information-production.test.ts` 6/6、`platform-information-routes.test.ts` 31/31 通过。`.env.example` 已补录 4 个密钥的显式配置方式；docker-compose 仍可后续补 secrets 下发（多实例场景）。
- **第二层（数据源）**：~~roadmap 阶段 13 明示"仍未接入"~~。**2026-08-08 代码审计更正——文档已滞后于代码**：branch snapshot 生产写入者已接入 push commit 事务（`main.ts:79` + `remote-sync-pg/http-service.ts:851`）；项目知识真相源 `knowledge_ingest_entries` 与变更记录 `change_archive_packages` 均有真实写入路径；导出 HTTP create/download 也已接路由（`routes.ts:433/500`）。
- **仍存缺口（2026-08-08 审计 + 修复后更新）**：
  - ~~branchVersion 适配器从未被生产组合~~ → **已修复（同日）**：`production.ts` 在 pool 可用时即组合 `createBranchVersionQueryAdapter(createBranchSnapshotModule(...))`（PgBranchSnapshotPort 兼任 repository/blob/cursor-verifier，恢复冲突端口诚实返回空集）。「分支文件」「版本记录」列表因此可用。测试 production 7/7 + routes 31/31 + adapter 12/12 通过；server 全量套件 1045 通过（仅 1 个需测试库的集成套件因缺 `HUNTER_HARNESS_TEST_DATABASE_URL` 环境跳过失败，与本改动无关）。
  - `branch_files` / `version_records` 的**详情路由仍 503**（"trusted detail locator is not wired"，`platform-information/routes.ts:561`）。**工作包分解（已勘察）**：
    1. page item 投影缺 `detail_id` 与完整 identity（无 manifest_hash）——需改 `packages/contracts` 的 page item schema（增量字段）；
    2. 服务端定位方案二选一：a) 按 `(project_id, branch_name, project_version, artifact_id, commit_sha)` 反查快照重建 identity（repository 加 `getSnapshotByVersionRef`，不改契约但 detail_id 规则要冻结）；b) list 投影时用 cursor authority 的 HMAC 签发签名 locator（更贴现有 fail-closed 风格）；
    3. 路由移除 503、按视图走 `adapter.diff` / `adapter.detail`；
    4. 前端 `VersionRecordsInformationPanel` 用 item 的 detail_id 打开 diff 视图；branch_files 的文件内容还需先暴露 files 列表子路由（`adapter.listFiles` 已实现但无 HTTP 路由）。
  - 06A 知识队列**完整链路勘察结论**（不是"start 一下"，缺 4 环）：
    1. **生产者缺失**：归档上传路由（`archive/package-ingest.ts` → `putChangeArchivePackage`）不调 `pipeline.acceptArchive`，队列永远为空——需在路由侧事务入队；
    2. **dequeue 缺失**：`JobRepository` 只有按 job_id claim，无 `listQueued*`（ports + pg + memory 三处实现）；
    3. **调度器缺失**：需要 poll 循环（批量取队列 → `worker-host.run`，lease/ack 已在 worker 内部）+ main.ts 启停；
    4. **extractor 缺失**：`KnowledgeExtractorPort` 无任何生产实现，知识 job 会无限重试 `KNOWLEDGE_EXTRACTOR_UNAVAILABLE`——调度器 v1 应只跑 change projection 队列，或先实现 extractor（可复用 `semantic/knowledge-*` 的裁决逻辑）。另缺 `ArchiveValidationEvidencePort` 生产实现。
    生产投影仍走旧 in-process 全量重建（可用，非阻塞）。
  - roadmap 阶段 14（回填迁移脚本、平台 CI、端到端验收）**整体仍是仅文档**。
- **方向**：① ~~运维侧配齐 4 个密钥~~（已修复）；② ~~branchVersion 组合~~（已修复）；③ 按上面分解实施详情 locator 工作包；④ 按 4 环分解实施知识队列投产工作包；⑤ 短期演示可用 `NEXT_PUBLIC_HUNTER_HARNESS_DEMO=true`。

## 已决策记录

- **归档摘要展示**：前端已移除「归档摘要」区块（用户判断信息密度低）。**数据收集保留**：`summary-data.json` 是归档记录与知识抽取（S4）的唯一来源，上传管线不变——不展示 ≠ 不收集。
- **阶段模板**：前端硬编码 harness 阶段契约（注释标注出处）；若 `PHASE_ORDER` 演进，建议挪入 `@hunter-harness/contracts` 共享。
