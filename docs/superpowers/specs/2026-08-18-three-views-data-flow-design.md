# 三视图数据流修复设计

- 日期：2026-08-18
- 涉及仓库：`hunter-platform`（server / contracts）、`Hunter-Harness`（CLI / contracts）
- 状态：Stream A 已完成并验证；B / C / D 待实施（见文末「实施进度」）

## 1. 目标（用户原话）

1. **归档时**上传该分支变更文档（只上传有实际意义的，排除过程文件，减少上传压力）→ 页面在**分支文件**展示
2. **push 时**推送配置文件（仅在有更新时）→ 页面在**项目资料**展示，**只展示最新版本**
3. **sync 提供推送选项**
4. 无用/过程文件不上传；已上传的可清理

## 2. 现状：两条互不相通的写入管道

| 管道 | 触发 | 写入 | 供给视图 |
|---|---|---|---|
| proposal | `hunter-harness push` | `project_files_current` + `artifacts`，**并推进 `projects.latest_project_version`** | 无 |
| remote-sync | `hunter-harness harness-push --scope ...` | `branch_snapshots` + `branch_snapshot_files` + `branch_snapshot_blobs` + `remote_sync_branch_pointers` | `branch_files` ✅ / `project_materials`（锚点已断） |

`hunter-harness push` 在 `packages/cli/src/bin.ts:420` 的自述是"现有兼容入口：创建受治理的变更提案；Stage 03 Push 生产接线完成前继续使用本命令"——它是**自我声明的过渡入口**，不是长期形态。`harness-push` 才是目标形态，其 `--scope` 词表（`config,rules,architecture,instructions,branch_files,archive`）与 `viewPolicy` 的内容分类一一对应。

## 3. 三个根因（均已定位到行）

### 根因 1：`project_materials` 的锚点结构上不可满足

`apps/server/src/project-materials/pg-source.ts:316` 的 `#current()`：

```sql
LEFT JOIN branch_snapshots snapshot
  ON snapshot.project_version = project.latest_project_version
 AND snapshot.artifact_id     = project.latest_artifact_id
```

两侧的 id 来自两个互不知晓的生成器：

- proposal：`id("pv_")` / `id("art_")` 各自独立随机（`apps/server/src/repositories/postgres.ts:1321`）
- remote-sync：`pv_${suffix}` / `art_${suffix}` 共用同一个 `suffix = hash(prepare_id, payload_hash)`（`apps/server/src/remote-sync-pg/http-service.ts:929`）

生产数据印证：快照 `pv_bc38fe47…` / `art_bc38fe47…`（后缀相同），`projects.latest` 为 `pv_cee2b2e7…` / `art_65783ccf…`（后缀不同）。**全仓库（`.sql` + `.ts`）搜索确认 `latest_project_version` 的写方只有 `postgres.ts` 三处，无触发器**——没有任何生产路径会使两者相等。

因此该视图在生产中**从未工作过**：push 前 latest 为 NULL → `processing`；push 后 latest 指向永远无快照的版本 → 仍 `processing`。

> **测试为何是绿的**：`apps/server/test/project-materials-pg-source.integration.test.ts:87` 手动
> `UPDATE projects SET latest_project_version = <快照的 pv>`，伪造了一个生产代码不维护的不变量。
> 这是本次必须先写复现测试的直接原因——现有测试维护的是幻觉。

### 根因 2：归档文档被三道闸串行拦死

> 订正（实施时发现）：初稿只写了两道闸，实际最先生效、也最决定性的是**第三道**——
> `nonScannablePathPrefixes`（`content-sync.ts:1051`）里含 `.harness/archive`，
> `excludedPathReason` 在任何分类规则之前就把整棵归档树判为 `CONTENT_PATH_NON_SCANNABLE_KIND`。
> 下面两道闸只有在越过它之后才会被触及。

`packages/contracts/src/content-sync.ts` 的 `classifyContentPath`：

```
若 path 命中 .harness/project.yaml | .harness/config/ | .harness/rules/
             | .harness/codebase/map(-manifest.json) | AGENTS.md → 分类成功
若 isAtOrBelow(path, ".harness")            → CONTENT_PATH_UNDECLARED   ← 闸 1
若 source_kind === "branch_file"            → branch_file / explicit_source_only
否则                                         → CONTENT_PATH_UNCLASSIFIED
```

- **闸 1**：归档文档位于 `.harness/archive/<change>/{plans,spec,reports}/…`，被 `CONTENT_PATH_UNDECLARED` 拒绝。
- **闸 2**：`branch_file` 分支要求显式传入 `source_kind: "branch_file"`，但工作区遍历的调用点
  `packages/cli/src/push-pull-adapter/remote-http.ts:337` 的 `classifyWorkspacePath` 只传 `{schema_version, path}`。
  故遍历阶段**没有任何文件能被判成 `branch_file`**。

两闸叠加解释了 `push.ts:225` 走查 `spec/` + `plans/` 后 36 个文件全被 policy-never 跳过，
以及 `change_records` 三条记录 `document_refs: []`。

### 根因 3：知识提取停在 ready

三条 change_record 均为 `knowledge_extraction_status: "ready"`，但 `project_knowledge` 为 0、
`knowledge query` 四关键词全 `count=0`。`ready` 与"已入库可检索"之间缺一步。

> 本根因与根因 1/2 正交，独立成 Stream D，不阻塞前三个目标。

## 4. 设计决策

### 决策 1：`project_materials` 改锚 `remote_sync_branch_pointers`（原方案 B）

**放弃的备选**：

- **A（proposal 也写快照）**：快照主键需 `branch_name` + `commit_sha`，而 `finalizeProposalSchema`
  （`packages/contracts/src/protocol.ts:92`）两者皆无 → 需要 contracts + CLI + server 三处有版本的线上协议变更；
  再叠加把 `ArtifactStorage` 的 CAS 字节复制进 `branch_snapshot_blobs`，等于合并两套存储模型。
  代价与收益不匹配，且方向是给待退役管道加固。
- **C（视图改读 `project_files_current`）**：会把视图绑死在自我声明要退役的 proposal 管道上，方向相反。

**采纳 B**，但锚点不是"按 `uploaded_at` 取最新快照"，而是 `remote_sync_branch_pointers`——
该表每分支一行，随 `push:commit` 事务原子更新，带 `generation` 单调栅栏，是 remote-sync 自己的权威
"当前快照"指针（`http-service.ts:456` 的 `currentPointer` 即读它）。以它为锚：

- "只展示最新版本"由指针语义天然保证，无需在视图层排序去重
- 与 `branch_files` 共享同一事实来源，两视图不会各自漂移
- 完全不触碰 `projects.latest_project_version`，proposal 管道退役时无需回改

**多分支消歧**：`project_materials` 是项目级视图，而指针是分支级的。规则：取项目默认分支的指针；
默认分支缺失时，按 `generation` 最大者，同 generation 按 `branch_name` COLLATE "C" 升序取第一，
保证确定性（沿用 `#current()` 现有的 `ORDER BY … COLLATE "C"` + 歧义抛错风格）。

### 决策 2：归档文档作为 `branch_file` 上传，分类闸开一道有界的口子

`viewPolicy` 已定 `branch_files→["branch_file"]`，故归档文档应以 `content_kind: "branch_file"` 入库。

在 `classifyContentPath` 的**闸 1 之前**插入一条**白名单**规则，只放行有实际意义的归档文档：

```
.harness/archive/<change-key>/plans/**     → branch_file，group=PLAN
.harness/archive/<change-key>/spec/**      → branch_file，group=SPEC
.harness/archive/<change-key>/reports/**   → branch_file，group=REPORT
.harness/archive/<change-key>/docs/**      → branch_file，group=DOCS
```

**排除**（目标 1 与 4 的"过程文件"）：`state/`、`runtime/`、`cache/`、`operations/`、
`*.tmp`、`*.log`、`execution-log*`、`attempts/`，以及 `reports/` 下非 `final/` 的中间产物。
排除规则集中在一处常量，便于后续调整与审计。

`group` 由路径段推导，不新增字段；页面按 `PLAN/SPEC/REPORT/DOCS` 分组即读该段。

同时修复闸 2：归档上传路径显式传 `source_kind: "branch_file"`。
**不改动**工作区遍历的默认行为——普通仓库源码仍需显式 `explicit_source_only`，避免误传整个仓库。

### 决策 3：`sync` 增加推送选项

`sync` 当前是本地元数据体检（`--check` / `--apply`），与远端无关。
增加 `--push[=<scopes>]`，在体检通过后复用 `runPushPull("push", …)`，默认 scope 为
`config,rules,architecture,instructions`（即"配置文件有更新才推"）。
沿用 `harness-push` 既有的 `no_changes` 短路——无更新时不产生快照，满足目标 2 的"如果有更新"。

## 5. 工作流

| Stream | 内容 | 落点 |
|---|---|---|
| A | `#current()` 改锚 `remote_sync_branch_pointers` + 多分支消歧 | hunter-platform / server |
| B | 归档文档白名单分类 + `source_kind` 修复 + 排除规则 | 两仓库 contracts + Harness CLI |
| C | `sync --push` | Harness CLI |
| D | 知识提取 ready → 入库（根因 3） | hunter-platform / server |

依赖：A 与 B 互不依赖，可并行；C 依赖 B 的 scope 语义；D 独立。

## 6. 测试策略（TDD，先红后绿）

**Stream A**
1. 先写复现测试：种一个 `remote_sync_branch_pointers` + 对应快照，**不**设置
   `projects.latest_project_version`（即真实生产形态）→ 断言 `project_materials` 返回 items。当前必红。
2. 修正现有集成测试：删掉 `integration.test.ts:87` 那句伪造 `UPDATE`——它是根因 1 长期隐身的原因。
3. 补一条 push（proposal）推进 `latest_project_version` **不应**影响视图的回归测试。

**Stream B**
1. `classifyContentPath` 单测：归档 `plans/spec/reports/docs` 下的文件 → `branch_file`；
   `state/runtime/cache/operations/*.log` 等 → 仍被拒。
2. 端到端：归档一次 → `branch_files` 出现文档且带正确 group；过程文件不出现。

**Stream C**：`sync --push` 在无更新时短路为 `no_changes`，有更新时产生一次快照。

**Stream D**：待 A/B/C 落地后单独定测试。

**门禁**：`node node_modules/vitest/vitest.mjs run apps/server/test`（1074 测试）+
`npm run lint && npm run typecheck`。PG 集成套件需 `HUNTER_HARNESS_TEST_DATABASE_URL`，
用 Docker 起 PG（`$env:SERVER_PORT="3012"; docker compose -p hh-verify up -d postgres server`，一律用 `127.0.0.1`）。

## 7. 清理（目标 4）

已上传的无用文件通过 remote-sync 的 delete operation 清理：对当前快照中命中排除规则的路径生成
一次 `harness-push` 的删除操作。**先只读列出待清理路径供确认，不自动执行删除**。

## 8. 待确认

- ~~多分支消歧中"项目默认分支"的取值来源~~ → 已定：`projects` 表无默认分支字段，
  直接按 `generation DESC, branch_name COLLATE "C" ASC` 取一，无需新增字段
- Stream D 的具体缺口尚未定位到行，实施前需单独探针

## 9. 实施进度

### Stream A — 已完成（2026-08-18）

**改动**

- `apps/server/src/project-materials/pg-source.ts` — `#current()` 改锚
  `remote_sync_branch_pointers`（LEFT JOIN LATERAL 取 `generation DESC, branch_name COLLATE "C" ASC`
  的唯一指针），彻底移除对 `projects.latest_project_version` / `latest_artifact_id` 的依赖。
  语义细化：指针缺失 → `processing`（尚未推送）；指针在而快照缺失 → `PROJECT_MATERIALS_SNAPSHOT_INVALID`
  （同事务写入，不一致只可能是损坏，不再静默降级）。
- `apps/server/test/project-materials-pg-source.integration.test.ts` — 删掉伪造
  `latest_project_version` 的那句 UPDATE，改种 `remote_sync_versions` + `remote_sync_branch_pointers`；
  并额外插入一条真实 proposal artifact 让 `latest_*` 指向它，证明视图与 proposal 管道互相独立。
- `apps/server/test/project-materials-pg-source.test.ts` — 假 pool 行改为新查询形态；
  新增一条 fail-closed 测试锁住"指针在、快照无 → INVALID"。

**TDD 证据**

1. 基线（含伪造 UPDATE）：1 passed
2. 改成生产形态后：**RED** —— 期望 4 条材料，实得 `[]`（与生产 `page_state: processing` 同因）
3. 修 `#current()` 后：**GREEN** —— 1 passed
4. 单测：9 passed

**门禁**

- `node node_modules/vitest/vitest.mjs run apps/server/test`（配 PG）：
  **1098 passed / 7 failed**，其中 6 个为预存红（干净树上同样 6 failed，见下），1 个为本次
  假 pool 形态失配，已随改动修正。
- `npm run lint`：通过
- `npm run typecheck`：通过（`apps/web` 曾因 node_modules 陈旧缺 `react-markdown`/`remark-gfm` 报错，
  `npm install` 从既有 lockfile 同步后消除，lockfile 无实际变更）

**预存红（与本次改动无关，干净树上复现）**

- `platform-information-export-pg-records.integration.test.ts` × 1
- `postgres.integration.test.ts` × 4（含 `client_id` `invalid_format` 的 schema 校验失败）
- `remote-content-upload-pg.integration.test.ts` × 1

**验证环境**

```
docker run -d --name hh-tdd-pg -e POSTGRES_PASSWORD=tdd -e POSTGRES_USER=tdd \
  -e POSTGRES_DB=tdd -p 55432:5432 postgres:17-alpine
HUNTER_HARNESS_TEST_DATABASE_URL=postgresql://tdd:tdd@127.0.0.1:55432/tdd
```

### Stream B — 分类层已完成（2026-08-18），投递层待接

**已完成：三道闸全部打通，且只为交付物开口**

- `packages/contracts/src/content-sync.ts`（**两仓库逐字节镜像**）
  - 新增 `isArchiveDeliverableDocument`：仅匹配
    `.harness/archive/<change-key>/{plans|spec|reports|docs}/**` 下的具体文件；
    变更目录名以 `.` 开头的（如 `.publication-staging`）不放行
  - `excludedPathReason` 的 `nonScannablePathPrefixes` 判定加 `&& !isArchiveDeliverableDocument(...)`，
    **放在 credentials / env / state / runtime / `*.log` 之后**，所以那些安全规则对交付物目录依然生效
  - `classifyContentPath` 在 `.harness` UNDECLARED 之前放行交付物为
    `branch_file / branch_files / explicit_source_only / required`（复用既有相关约束元组，schema 无需改）
  - 新导出 `mayContainArchiveDeliverables`：判断目录是否可能含交付物
- `packages/cli/src/push-pull-adapter/remote-http.ts`（Harness）
  - `walkFiles` 的剪枝改为 `excludedWorkspacePath(path) && !(entry.isDirectory() && mayContainArchiveDeliverables(path))`。
    不改这里的话，遍历在 `.harness/archive` 第一层就被剪枝，交付物永远走不到分类
- `packages/contracts/test/schemas.test.ts`（platform）
  - content-sync 字节锁由 `b1d1964e…` 更新为 `45b7ab01…`（守卫按设计要求有意识更新，非绕过）

**过滤效果（kld-sdd 三个变更实测）**

| | 文件数 | 字节 |
|---|---|---|
| 交付物（plans/spec/reports） | 47 | 730 KB |
| 过程文件（evidence/meta/logs/runtime/fixback/.publication-staging） | ~179 | ~1.65 MB |

约削减 79% 文件数、69% 字节——即目标 4 的"减少上传压力"。

**门禁**

- Harness `packages/contracts` + `packages/cli`：**800 passed / 0 failed**
- platform `packages/contracts`：回到仅剩 3 个预存红（干净树上同样 3 个），本次零新增
- 两仓库 `lint` + `typecheck`：全绿

**投递层也已完成**

归档收尾的 `auto_push_managed_snapshot`（`harness/scripts/harness_archive.py`）
此前调 legacy `hunter-harness push`（proposal 管道）——那条路不产生分支快照，
两个视图都读不到，交付物还会被 policy-never 跳过。这正是 `document_refs` 长期为空的原因。

- 改走 `harness-push --scope config,rules,architecture,instructions,branch_files`。
  显式列五项而非 `all`，含义固定不随 `all` 展开定义漂移
- 回执解析改为 `summary.applied`（legacy 用 `submitted`）；
  `unchanged` 改判 `outcome == "no_changes"`——即"仅在有更新时推送"
- 顺带修掉同函数里 `subprocess.run` 缺 `encoding=` 的隐患（中文 Windows 按 cp936
  解码 UTF-8 会静默损坏输出并可能让 `json.loads` 失败）
- `--scope archive` 与其他 scope 互斥、走归档包 ZIP 的独立路由，不受影响

**端到端实测（kld-sdd，dry-run 只读）**

31 个文件全部判为 `branch_file`，全在 `plans/` `spec/` `reports/{final,review,test}` 下，
零过程文件。逐项核对：plans 11 + spec 2 + reports/final 3 + review 10 + test 5 = 31，
与预览完全吻合。改动前此处为 0（整棵归档树在遍历第一层就被剪枝）。

被正确排除的还包括 `runtime/staging/plans/**` 与
`.publication-staging/<...>/plans/**` 下的 16 个**重复副本**——只取正本。
（此前 spec 里写的"47 个交付物"是被这些副本灌水的计数，实际正本为 31。）

**门禁**

- Harness vitest：**155 文件 / 2137 测试全过**
- Python harness safe profile：归档相关全过；`test_harness_test_guard.py` 在全量跑时
  出现 `PermissionError [WinError 5]`，单独复跑 48 个全过，属临时目录争抢的环境问题
- `lint` + `typecheck`：全绿

**页面分组**：PLAN/SPEC/REPORT/DOCS 由路径第 4 段推导（`segments[3]`），无需新增契约字段。

### Stream C — 已完成（2026-08-18）

`sync` 新增 `--push [scopes]`：省略值时推 `config,rules,architecture,instructions`
（与 push 自身省略 `--scope` 时的默认范围一致），带值时按显式列表推。

判定抽成纯函数 `planSyncPush`（`packages/cli/src/commands/sync.ts`），与体检流程解耦、可单测：

- WARN（退出码 5）放行——最常见的 WARN 是架构地图略陈旧，卡在这里会让选项没法用
- BLOCKED(7) / FAIL(1) 拒推——项目状态本身不可用，推上去只是把坏状态同步到平台
- `--check` / `--dry-run` 保持纯只读，即便带 `--push` 也不推
- 跳过时经 stderr 回显 reasonCode，不静默吞掉

编排放在 `bin.ts` 组合根：sync 退出码先定，推送只在状态可用时追加，两个命令契约不变。

门禁：vitest **156 文件 / 2144 测试全过**；lint + typecheck 全绿。

> ⚠️ 本 Stream 在 `0.2.84` 发布**之后**完成，已发布的 CLI 不含 `sync --push`，需下次发版。

### Stream D — 根因已定位，待实施

原以为是"提取停在 ready"，实测是**两个互相独立的缺陷**，且都不在提取本身。

#### D1：`change_records` 视图把三个字段硬编码成空

`apps/server/src/change-records-query/pg-source.ts:213` 与 `:298`：

```ts
document_refs: [], document_snapshots: [], candidate_refs: []
```

该 source（`PgChangeArchiveSource`，经 `platform-information/production.ts:211` 装配，
是**唯一**生产数据源）只读 legacy 的 `change_archive_packages` 表，**从不查询**
`knowledge_pipeline_change_documents` 与 `knowledge_pipeline_project_candidates`。
所以 `document_refs` 与 `candidate_count` 与管道实际产出无关，结构上恒为空——
与根因 1 同一个家族：视图接在了 legacy 数据源上。

`knowledge_extraction_status` 同样取自 `change_archive_packages.knowledge_status`，
而非真实的管道作业状态，所以"ready"也不代表提取真的产出了东西。

#### D2：知识管道是闭环，从不桥接到可检索的知识库

`project_knowledge` 视图读 `knowledge_ingest_entries`（`project-knowledge-query/pg-source.ts:256`）。
该表的唯一写入方是 `repositories/postgres.ts:525` 的 `upsertKnowledgeEntry`，
其调用点只有两处 HTTP 路由（`app.ts:2613` 的 `POST /knowledge/ingest`
与 `app.ts:2789` 的 revive）。

而知识管道的产出落在 `knowledge_pipeline_results` / `knowledge_pipeline_project_candidates`，
这些表**只在 `knowledge-pipeline/pg.ts` 内部读写**，外部无任何消费方。
两侧之间没有桥。

**这是 bug 不是设计**：`harness/harness-knowledge-ingest/SKILL.md` 明确写
"知识 ingest 完全由 Hunter Platform 负责……服务端收到后保存原包、安全解包、
发布核心文件，并根据其中的 Markdown 与摘要重建项目语义索引"，且要求客户端
不得生成本地索引。即服务端自动入库是既定契约，缺的是实现。

#### D1 — 已完成（2026-08-18）

列表与详情共用同一段 lateral 聚合，避免两个入口给出不一致的 refs：

- 文档取自 `knowledge_pipeline_change_documents`，按 `change_key` 过滤、按 `document_id` 定序。
  契约要求 `document_snapshots` 与 `document_refs` 等长同序，故只产出快照数组、
  refs 由其派生——两者不可能再走偏
- 候选表按项目而非变更分区，只能经 `knowledge_pipeline_results.source_change_keys`
  反查 `source_candidate_ids`
- 上限（文档 20 / 候选 100）在 SQL 与解析两侧各兜一次
- 形状不合的条目整条丢弃：宁可少给，也不把脏数据送进视图

**补了一条集成测试**：此前该 source 只有假 pool 的单测，SQL 字符串从未被 Postgres
解析过——语法错误、列名笔误、lateral 作用域问题都只会在生产暴露。新测试
（`change-records-pg-source.integration.test.ts`）对真实库执行两条查询，
并验证 refs 确实来自管道。发现并修正了 seed 缺列（`manifest_sha256` 等）后跑通。

门禁：lint + typecheck 通过；`apps/server/test` + `packages/contracts`
**1268 passed / 9 failed**，9 个全部为预存红，本次零新增。

#### D2 — 阻塞：提取契约缺字段，无法忠实映射

原以为只需接一条 `knowledge_pipeline_results` → `knowledge_ingest_entries` 的桥。
实际查下来，**要写入的目标形状里有一半字段在管道中根本不存在**。

目标 `knowledgeIngestEntrySchema`（`packages/contracts/src/knowledge.ts:137`）要求：
`type`（7 值枚举）、`title`、`summary`、`body`、`keywords`、
`source{archive,summaryData,summarySha256,sourceCommit,baseCommit,changeName,finalStatus}`、
`scope.sourceFiles`、`lifecycle{...}`。

而管道端能提供的，从 LLM 抽取草稿一路到落库都只有这些
（`KnowledgeResultDraft`，`knowledge-pipeline/types.ts:175`）：

```
source_candidate_id, content_hash, display_title, summary,
reusability_scope, source_refs, confidence
```

**不是入库时被裁掉的——抽取契约本身就没产出过 `type` / `body` / `keywords`。**

于是任何"现在就接上"的实现都必须凭空捏造：

| 缺失字段 | 只能怎么办 | 代价 |
|---|---|---|
| `type` | 从 7 值里挑一个默认值 | 纯捏造，分类失真 |
| `body` | 拿 `summary` 顶替 | 勉强可辩护 |
| `keywords` | 空数组 | 检索质量下降 |
| `source.sourceCommit` / `baseCommit` / `summarySha256` / `finalStatus` | 无任何来源 | **伪造溯源**——知识条目的可信度正是靠溯源 |

##### 为什么"写个残缺 payload"也不成立

`project_knowledge` 视图只读 `knowledge_ingest_entries`，确实只需要
`id/title/status/lifecycle/content_sha256`，残缺 payload 能让**这个视图**出数据。

但 `knowledge query` 走的是语义库，而投影函数
`knowledgeEntryDocument`（`semantic/knowledge-projection.ts:31`）会
`knowledgeIngestEntrySchema.safeParse(payload)`，失败即 `return null` → 条目被跳过。
所以残缺 payload 只能点亮一半，另一半仍然为空，且失败是静默的。

##### 两处自我更正（继续查证后推翻了上一版结论）

**更正 1：溯源字段不需要捏造，全部有真实来源。**
`reports/final/summary-data.json`（本就在归档 ZIP 内，服务端也已解包成
`change_summary` 类型文档）含：

```
changeName  = usage-stats-cli-reporting
baseCommit  = 54a1f26fb33695d2d0e6c06e9d1743bd17115169
finalStatus = WARN
finalCommit / archiveCommit / gitFacts / archiveIntegrity ...
```

`summarySha256` 可对该文件直接计算，`archive` 用 `archive_id`。
所以 `source{archive,summaryData,summarySha256,sourceCommit,baseCommit,changeName,finalStatus}`
**七个字段全部可如实填充**。上一版"伪造溯源"的判断是错的。

**更正 2：抽取器不是 LLM 调用。**
`knowledge-pipeline/extractor.ts` 只是读取归档包里**客户端已冻结的**
`archive.knowledge_candidates`，按置信度阈值 0.82 过滤后原样转成草稿
（注释明写"不重新打分——候选置信度由归档生产侧的提取器计算并随包冻结"）。
因此"改抽取 prompt"这条路不存在——要补字段得改**客户端候选生成器**。

##### 真正的缺口：只剩 `type` / `body` / `keywords`

`knowledgeCandidateSchema`（`content-sync.ts:667`）字段为：
`schema_version, source_change_key, content_hash, confidence, provenance,
candidate_id, source_refs, summary, reusability_scope, status`。

`reusability_scope` 是自由文本（实测取值 `none` / `server` / `x`），
**无法映射到 `type` 的 7 值枚举**。`body` 与 `keywords` 同样无来源。

##### 两条路（均满足"运行期无需人工操作"）

**路线 A —— 扩展候选契约（推荐）**

让客户端候选生成器产出 `entry_type` / `body` / `keywords`，沿链路传到入库。
层次：

1. Harness 客户端候选生成器（归档时写入 `knowledge_candidates`）
2. `knowledgeCandidateSchema`（**两仓库逐字节镜像 ＋ 字节锁**）
3. `KnowledgeResultDraft` ＋ `extractor.ts`
4. `KnowledgeResult` ＋ `knowledge_pipeline_results` 建表（**需 migration**）
5. 桥：results ＋ change_summary 文档 → `upsertKnowledgeEntry` ＋ `projectPendingKnowledge`

新字段设为**可选**可避免协调发布：老归档缺字段时走降级，新归档走完整路径。
代价：跨两仓库 5 层 ＋ 一次 migration ＋ 一次 Bundle 发布。

**路线 B —— 放宽消费端**

`knowledgeIngestEntrySchema` 是**旧的客户端知识文件格式**
（投影里的 `source_path` 仍写 `.harness/knowledge/entries/<status>/<id>.json`），
而 `harness-knowledge-ingest/SKILL.md` 已明确"客户端不得生成 `.harness/knowledge`……
本地知识处理脚本已从分发包移除"。即该 schema 描述的是已退役的产物形态。

故可让 `knowledgeEntryDocument` 识别管道原生形态，不再强行套旧 schema。
代价：这批条目在语义检索里没有 `type` / `keywords` 分面，检索质量下降。

##### 取舍点

`type` 与 `keywords` 直接影响知识检索质量。若知识库要长期可用，A 更正确；
若只要三个视图先通、检索质量后续再补，B 一次改动即可。

**这是产品语义取舍，不是接线问题，未擅自选择。**

### 待决：归档 ZIP 边界与分支文件边界不一致

`harness-knowledge-ingest/SKILL.md` 规定归档 **ZIP 包**只许含
`reports/final/summary-data.json`、`spec/**/*.md`、`plans/**/*.md`、`archive-meta.md`、
`change-context.json`，并明确"测试报告、审查报告……不得进入归档包"。

而 Stream B 放行进**分支文件**的范围包含 `reports/review/**` 与 `reports/test/**`。

两者是不同通道——ZIP 喂知识管道（关心体积与核心性），分支文件供人在平台上阅读——
所以不冲突。但如果希望两条边界一致，需要把 `archiveDeliverableGroups` 收窄为
`plans` / `spec` + `reports/final`。**此项未擅自改动，留待确认**（Stream B 已随 0.2.84 发布）。

接手要点（已查实，不必重推）：

- 闸 1 在 `packages/contracts/src/content-sync.ts` 的 `classifyContentPath`：
  `isAtOrBelow(path, ".harness")` → `CONTENT_PATH_UNDECLARED`，归档文档撞的就是这条
- 闸 2 在 `packages/cli/src/push-pull-adapter/remote-http.ts:337` 的 `classifyWorkspacePath`：
  调用 `classifyContentPath` 时没传 `source_kind`，故遍历阶段无文件能判成 `branch_file`
- 两仓库各有一份 contracts，`content-sync.ts` 需同步改动
- `hunter-harness push`（proposal）是自我声明的过渡入口（`packages/cli/src/bin.ts:420`），
  `harness-push` 才是目标形态；Stream C 的 `sync --push` 应复用 `runPushPull("push", …)`
- web 侧已有归档文档阅读 UI（commit `d984af3 feat(web): improve archived branch document reading`）
