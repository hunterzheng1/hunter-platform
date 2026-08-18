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

**Stream B 剩余：投递层**

分类层已允许交付物成为 `branch_file`，但**还需接通"归档时触发推送"**：

- `harness-push --scope archive --change <key>` 目前走归档包发布路径，
  需确认它是否连带把交付物文档作为 branch_file 推送；若否，在归档收尾处触发一次
  `--scope branch_files` 的定向推送
- 端到端验证：归档一次 → `branch_files` 出现文档；过程文件不出现
- 页面分组 PLAN/SPEC/REPORT/DOCS 由路径第 4 段推导（`segments[3]`），无需新增契约字段

### Stream C / D — 待实施

接手要点（已查实，不必重推）：

- 闸 1 在 `packages/contracts/src/content-sync.ts` 的 `classifyContentPath`：
  `isAtOrBelow(path, ".harness")` → `CONTENT_PATH_UNDECLARED`，归档文档撞的就是这条
- 闸 2 在 `packages/cli/src/push-pull-adapter/remote-http.ts:337` 的 `classifyWorkspacePath`：
  调用 `classifyContentPath` 时没传 `source_kind`，故遍历阶段无文件能判成 `branch_file`
- 两仓库各有一份 contracts，`content-sync.ts` 需同步改动
- `hunter-harness push`（proposal）是自我声明的过渡入口（`packages/cli/src/bin.ts:420`），
  `harness-push` 才是目标形态；Stream C 的 `sync --push` 应复用 `runPushPull("push", …)`
- web 侧已有归档文档阅读 UI（commit `d984af3 feat(web): improve archived branch document reading`）
