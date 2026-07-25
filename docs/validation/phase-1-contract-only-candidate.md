# Phase 1 H4 contract-only candidate

- 日期：2026-07-26
- 基线：`c17d85a77815e8e7205cc52ff699e81083491b97`
- 计划：
  [`Phase 1 product hardening — Task 12`](../plans/2026-07-24-phase-1-product-hardening.md#16-task-12fake-only-黄金场景与-h4-候选证据)
- 当前判定：`CONTRACT_ONLY`
- 证明范围：`CONTRACT_ONLY`

## 判定边界

本文件是 H4 候选草案，不是发布结论。Hunter + Fake/fixture 的黄金场景已形成
可重复的本机证据，重放后的完整本机门禁和未签名 Windows 测试打包也已通过。
Task 11 已在冻结 revision 上完成 24 小时窗口、8/8 双平台 CI，并通过 PR #16
合并。路径规范化修复提交 `dc5f0328c850890675e1a3334ac79ed0d12c1e10`
对应的 GitHub Windows/Ubuntu 四个 push jobs 也已全部通过，因此 H4 自动部分冻结为
`CONTRACT_ONLY`。审查修复后的代码/测试提交
`d31acabc485bd984504b51ecbee19f8d599b9058` 的 push + PR 共 8 项
Windows/Ubuntu CI 也全部通过；这仍不是产品发布 `PASS`。

即使上述门禁之后通过，结论也只会是 `CONTRACT_ONLY`：不证明真实 Provider、
真实 Connector、真实移动设备、生产证书、签名、分发或发布。Phase 0 Outcome 5
和 Gate A 保持不变。

## H4 自动黄金场景

| 场景 | 当前状态 | 本机证据 | 仍未证明 |
|---|---|---|---|
| Golden-1 | CONTRACT_ONLY | `e2e/vertical-slice.spec.ts`；`apps/daemon/test/vertical-slice-composition.test.ts` 覆盖独立 verifier、Archive crash resume、Knowledge 重建和重开 | 真实 Provider 与非玩具 Change |
| Golden-2 | CONTRACT_ONLY | `e2e/phase1-golden-2.spec.ts` 在自动创建的临时 Git fixture 中使用两个真实 worktree，并把真实 Git join/conflict 结果交给 `deriveTaskFanOut` 契约验证集成允许/拒绝，2/2 PASS | Hunter workspace lease/receipt 的完整产品 E2E、真实 Provider writer 与用户冲突处置体验 |
| Golden-3 | CONTRACT_ONLY | `packages/flow-engine/src/flow-engine.test.ts`、`loop-guard.test.ts` 验证新 Attempt、有界 Loop、预算和旧失败历史；Archive/Knowledge 组合测试保留 crash 历史 | 真实 Agent 失败、预算和人工恢复 |
| Golden-4 | NOT_PROVEN | `packages/connector-cursor/src/cursor-handoff.test.ts` 只证明 provider-neutral L0/L1 handoff 契约，打开窗口仍为 observation，不能完成 Step | Cursor 实机窗口、人工修改和 verifier receipt |
| Golden-5 | CONTRACT_ONLY | `scripts/phase1-persistent-fake-runtime.test.ts` 与 Task 11 smoke 验证同 operation receipt、持久 native effect 和重建后无重复 side effect | 真实 Provider restart/reconcile |
| Golden-6 | NOT_PROVEN | `apps/daemon/test/mobile-command-security.test.ts` 与 `e2e/mobile-security.spec.ts` 验证 Fake device scope、拒绝、撤销和离线幂等；移动 Playwright 1/1 PASS | 真实手机、锁屏、弱网和网络切换 |

P-02 与 W-01 的新增 H4 垂直证据位于
`e2e/phase1-workflow-migration.spec.ts`：

- 双 Project 从单仓起步，只给 Project A 追加 secondary Repository；幂等重放后
  重启 SQLite，A 保持两仓且 Project B 仍为单仓、binding version 0；
- 读取当前 `ProjectWorkflowBinding`，预览候选 `WorkflowRevision` 的结构 diff，
  对 entry/step/route/loop 语义变化给出固定 compatibility reason，再以 preview
  fingerprint + expected version 显式确认并幂等重放；
- 重启 SQLite 后新 Project planning default 仍指向候选 revision；

`apps/daemon/test/desktop-definition-services.test.ts` 进一步在生产组合服务 seam 证明：
初始 binding 随 `ProjectCreated` 持久化；迁移前已经启动的 Run 和已发布
  ExecutionPlan 继续固定旧 revision；ExecutionPlan 发布事件显式冻结当时的根
WorkflowRevision（事件 schema v2），迁移后旧计划仍可按该 revision 启动，但不能
换成任意其他已发布 revision；已发布计划的精确重放也必须携带同一根 revision，
不同的有效 revision 以 `PUBLISHED_CONTENT_MISMATCH` 拒绝。迁移后若新 Change
试图绕过 binding 直接使用旧 revision，会在写入 draft/plan 前以固定错误拒绝。
Task 子流程 revision 与根 Run revision 分别冻结，不能互相代替。

## 本轮 RED → GREEN 历史

- Playwright 集合生命周期：最初 Chromium 后留下 `active.lock`，移动套件不能可靠
  接续；将凭据捕获和清理移到 suite-level lifecycle 后，Chromium 与 mobile 可连续
  运行，锁、readiness 文件、监听端口和子进程均归零。
- Golden-2：精确 spec 起初不存在；首个实现又分别暴露 `path.resolve` callback
  参数误用和 Windows `core.autocrlf` fixture 差异。修正 fixture 后 2/2 PASS。
- W-01：精确 Playwright spec 起初返回 `No tests found`；增加真实 SQLite +
  生产 HTTP route 组合后 2/2 PASS（含 P-02）。
- H4 台账：新增“next action 不得再延期到 H0–H4”结构门禁后，首个失败项为 P-01；
  本提交逐项把已完成工作链接到本候选，把真实系统缺口保留到 Gate R 或 Phase 2。
- 提交前双轴审查发现并用 RED 验证：Change 发布可绕过 Project Workflow
  binding、同数量 route/loop 变化缺少 compatibility、初始 binding 未持久化和
  第 51 个 Repository 可落账；修复后均由严格 schema/ledger 回归覆盖。
- 首次全量 Vitest 为 135 files PASS、2 files FAIL：桌面 IPC mock 缺少新增
  Repository 字段，Foundation fixture 使用非规范 Project aggregate。对齐测试
  fixture 后同两文件 12/12 PASS，随后全量 137 files / 1,150 tests PASS。
- 计划中的 `npm run verify:backup` 首次因 alias 不存在而真实失败；加入只转发
  `verify:backup-restore` 的根脚本后，隔离恢复命令 PASS。
- Task 11 的 full soak 失败/中止尝试仍完整保留在
  [`phase-1-soak.md`](phase-1-soak.md) 和版本化 attempt envelope 中；不会用当前运行
  覆盖过去失败；最终 attempt 在冻结 revision 上达到 86,410,499 ms / 1,442 cycle，
  NFR-REL-04 只提升为 `CONTRACT_ONLY`。
- 首次固定 SHA `612d69e5239579cef609258e0472cf69de3067d7` 的 Windows
  垂直切片暴露 Windows Git 长路径与 Node 临时目录 8.3 短路径指向同一目录却被
  字符串判为不同，Golden-2 两个场景真实失败；改为比较文件系统真实路径后，
  Golden-2 2/2 和完整 Chromium 5 PASS + 1 SKIP 本机重跑通过。失败 run 未重跑
  或改写为 PASS。
- 最终审查发现 StartRun 只验证调用方所选 revision 已发布，没有证明它属于
  ExecutionPlan。回归测试先真实失败为“expected function to throw”；随后由
  发布事件冻结根 revision，StartRun 进行严格匹配。Foundation 链路同时使用不同的
  根/Task revision，迁移后的旧计划仍能按旧根 revision 启动，而改用新 revision
  以 `EXECUTION_PLAN_WORKFLOW_REVISION_MISMATCH` 拒绝。
- 同次审查发现本文件和验收台账仍把已经完成的 `006fbbf` 8/8 CI 写成
  `NOT_RUN`；先保留该真实 PASS，再由审查修复后的 `d31acabc` 重新完成
  push + PR 8/8 CI。证据文档写回会形成新的、仅含证据变化的提交；其状态必须
  以 PR #17 的外部检查为准，不能在提交内容中自证。
- 复审继续发现已发布计划重放会接受另一个有效根 revision，虽然后续 StartRun
  会拒绝，造成不一致。双有效 revision 回归先真实失败为
  “expected function to throw”；`PublishChangeRepositories` 读取已冻结 pin 后，
  不一致重放以 `PUBLISHED_CONTENT_MISMATCH` 拒绝，聚焦组 28/28 通过。
- 审查修复后的首次沙箱内 `verify:foundation` 已完成 lint、typecheck、
  1,151 PASS / 1 SKIP tests、rebuild、recovery、backup、diagnostics 和
  resources，但最终 workflow asset copy 被沙箱以 `EPERM` 拒绝。新目标文件复制
  也同样失败，说明不是旧文件占用或内容差异；同一 `npm run build` 及完整
  `verify:foundation` 在沙箱外重跑通过。随后沙箱内 typecheck 也无法覆盖沙箱外
  生成的 `dist` 文件并出现同类 `EPERM`；最终重放修复后的沙箱外完整门禁为
  1,153/1,153 tests。失败历史保留。

## 当前本机结果

| 命令 | 结果 |
|---|---|
| `npm ci` | PASS；安装 596 packages；registry 摘要仍为 22 high |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm test -- --configLoader native --no-file-parallelism --testTimeout 60000` | 137 files / 1,153 tests PASS |
| 重放后变更范围聚焦 Vitest（14 files） | 54/54 PASS |
| 最终审查修复聚焦 Vitest（5 files） | 28/28 PASS |
| `npx playwright test e2e/phase1-workflow-migration.spec.ts --project=chromium` | 2/2 PASS |
| `npx playwright test --project=chromium` | 5 PASS、1 个真实 Provider 场景 SKIP |
| `npx playwright test --project=mobile` | 1/1 PASS |
| Playwright 收尾检查 | active lock 0、readiness 0、4173 listener 0 |
| `npm run verify:foundation` | PASS；含 rebuild、recovery、backup/restore、diagnostics、resources、build |
| `npm run verify:backup` | PASS；manifest schema 1、storage schema 3、隔离恢复/投影重建通过 |
| `npm run verify:diagnostics` | PASS；5 个输出、1,573 bytes、7 次替换、fingerprint `a9d75119968bbed59fc05881bd6abed59829e807acab884642ca8df63ce8e95b` |
| `npm run pack:win -w @hunter/desktop` | PASS；x64 NSIS 98,585,358 bytes，SHA-256 `e891f07b0c956aad14522ecbaf2e74e2cde065d197265e1b5bce734a083ae204`，unsigned/not uploaded/not published |

## 固定 SHA CI 历史

GitHub Actions run `30200742439` 绑定
`612d69e5239579cef609258e0472cf69de3067d7`：

| Job | 结果 |
|---|---|
| Node 24 / ubuntu-latest | PASS |
| Vertical slice / ubuntu-latest | PASS |
| Node 24 / windows-latest | PASS |
| Vertical slice / windows-latest | FAIL；Golden-2 2 FAIL，另 3 PASS / 1 SKIP；根因为同一物理路径的长路径/8.3 短路径表示不一致 |

GitHub Actions run `30201122272` 绑定修复提交
`dc5f0328c850890675e1a3334ac79ed0d12c1e10`：

| Job | 结果 |
|---|---|
| Node 24 / ubuntu-latest | PASS；job `89791118087` |
| Vertical slice / ubuntu-latest | PASS；job `89791118061` |
| Node 24 / windows-latest | PASS；job `89791118070` |
| Vertical slice / windows-latest | PASS；job `89791118047`；完整 Vitest、完整 Chromium 与未签名 Windows 测试打包均通过 |

证据提交 `006fbbf83973a1178c3f4a2b319477a17eee81c9`
在 push run `30201484087` 和 PR run `30201497768` 上共 8 项全部 PASS：

| Job | push / PR 结果 |
|---|---|
| Node 24 / ubuntu-latest | PASS；`89792056417` / `89792095219` |
| Vertical slice / ubuntu-latest | PASS；`89792056410` / `89792095212` |
| Node 24 / windows-latest | PASS；`89792056477` / `89792095213` |
| Vertical slice / windows-latest | PASS；`89792056386` / `89792095232` |

最终审查修复后的代码/测试提交
`d31acabc485bd984504b51ecbee19f8d599b9058` 在 push run
`30203923871` 和 PR run `30203924995` 上共 8 项全部 PASS：

| Job | push / PR 结果 |
|---|---|
| Node 24 / ubuntu-latest | PASS；`89798577064` / `89798580579` |
| Vertical slice / ubuntu-latest | PASS；`89798577083` / `89798580559` |
| Node 24 / windows-latest | PASS；`89798577096` / `89798580573` |
| Vertical slice / windows-latest | PASS；`89798577093` / `89798580593`；完整 Vitest、完整 Chromium 与未签名 Windows 测试打包均通过 |

四个 jobs 仅有 `actions/checkout@v4`、`actions/setup-node@v4` 的 Node 20
deprecated annotation；GitHub runner 实际强制这些 action 使用 Node 24。本轮没有
把 annotation 写成失败，也没有据此声称生产供应链已通过。

证据写回后的最终提交 SHA、其 GitHub Windows/Ubuntu push + PR jobs，以及
PR #17 的 merge 结果不在本提交中自证；合并前必须以 GitHub 上绑定最终 SHA 的
外部状态为准。不得从 `d31acabc` 或局部命令外推最终提交的 CI/merge 结果。

## 必须保留的非通过项

- `NOT_PROVEN`：真实 Provider、Codex/CodeBuddy/Cursor 完整 Connector、Orca
  Provider、真实手机、真实项目演练；
- `NOT_PROVEN`：当前 registry 摘要的 high severity 依赖尚未做 production
  reachability 分类；
- `NOT_RUN`：需要明确授权发送依赖元数据的详细 registry audit；
- `BLOCKED`：生产签名、分发和发布，直到用户单独决定证书、渠道、隐私、许可证、
  备份和 Go/No-Go；
- `FAIL` 历史：Phase 0 非合规真实 Connector 尝试、Task 11 已归档 full attempts
  、首次固定 SHA 的 Windows Golden-2 长/短路径失败，以及本文件列出的 RED
  运行均保留，未改写为 PASS。

## 冻结 H4 前的最小后续动作

1. amend 单一聚焦提交并 force-with-lease 推送，等待新固定 SHA 的 push + PR
   共 8 项 Windows/Ubuntu CI；
2. 只有最终固定 SHA 没有新 `FAIL` 时，才可合并 H4 `CONTRACT_ONLY` 候选。
