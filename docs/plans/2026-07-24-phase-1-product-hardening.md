# Phase 1 product hardening implementation plan

- 日期：2026-07-24
- 基线：`main@83be7aece6c0cefe9b0cb077830c3eb2e95c48fe`
- 轨道：Fake-only / `contract_only`
- 目标：把已合并的 First Vertical Slice 收束为可恢复、可诊断、可迁移、
  有安全边界的 Phase 1 产品硬化候选。

## 1. 决策边界

本计划执行
[`ADR-0005`](../adr/0005-orca-runtime-integration.md) 的 2026-07-23
门禁澄清。该澄清允许确定性 Fake 驱动的开发、自动验收和未签名 Windows NSIS
测试打包继续；它没有改变 Outcome 5，也没有解除 Phase 0 Gate A。

因此本计划的最高可达结论是：

> Hunter 的 provider-neutral 契约、产品链路和本地运行边界达到
> `contract_only` 硬化候选；真实 Provider、真实移动设备、真实项目体验和生产发布
> 仍分别等待自己的证据门。

`docs/09-migration-and-roadmap.md` 5.5 是 2026-07-22 的历史快照，其中
“First Vertical Slice 保持阻断”的表述由较新的 ADR-0005 修订限定为
“真实 Provider 集成与验收保持阻断”。本计划不追溯改写该历史快照。

### 允许

- 复用现有根 `package.json`、TypeScript、Vitest、ESLint 和双平台 CI；
- 改进 Domain、Flow、Storage、Policy、Knowledge、Daemon、Workbench、PWA、
  Desktop 和测试工具；
- 使用 Fake Runtime、临时 Git fixture、故障注入和本地 loopback 进行自动验收；
- 生成未签名、不可分发的 Windows NSIS 测试产物；
- 形成版本化、脱敏、可重放的本地验证证据。

### 禁止

- 把 Fake 测试写成 Orca、Codex、CodeBuddy 或 Cursor 已验证；
- 选择 primary/fallback Provider、Fork Orca 或把 Provider 私有字段写入公共契约；
- 读取账号凭据、自动登录、开启远端暴露或运行未授权的真实 Agent 任务；
- 启用权限绕过、自动批准、任意 shell/IPC/fetch 或移动端完整终端；
- 签名、分发、发布、部署、让产品自动执行仓库 merge/push，或清理用户拥有的旧
  worktree；
- 把 Phase 2 的工作流市场、多仓复杂集成、团队/RBAC/云执行提前纳入。

## 2. 证据状态

所有验收项只能使用以下状态：

- `PASS`：本次版本、平台和命令有可复现的实际证据；
- `FAIL`：已运行且结果不满足契约，保留原始失败历史；
- `BLOCKED`：缺少安装、登录、授权、设备、费用或外部条件；
- `NOT_PROVEN`：时间盒结束或证据不足，不能推定成功；
- `NOT_RUN`：尚未执行，包含未触发的远端 CI；
- `CONTRACT_ONLY`：Fake/fixture 只证明 Hunter 自身契约。

工具可发现不等于 Provider 可采用，Agent return、process exit、terminal idle、
window opened 也不等于 Step success。只有 verifier result 或显式 human receipt
能完成 Step。

## 3. 总体门禁

| Gate | 目标 | 退出证据 |
|---|---|---|
| H0 | 新 worktree 可复现 | 无预构建 `dist` 时 install/lint/typecheck/test/build 通过 |
| H1 | 存储、迁移、备份和恢复可信 | 前向迁移、完整性校验、原子 manifest、恢复演练和故障矩阵 |
| H2 | 安全与可操作性可解释 | 脱敏诊断包、Attention action、知识注入防护、移动撤销 |
| H3 | 资源和桌面生命周期有界 | 日志分页/配额、性能基线、24h soak、升级/卸载演练 |
| H4 | Fake-only RC 证据完整 | 验收台账、黄金场景、Windows/Ubuntu CI、未签名打包 |
| R | 真实发布门 | Gate A、真实 Provider、真实设备/项目、签名和 owner Go/No-Go |

H0–H4 可自动推进。Gate R 不在本计划授权内，必须由用户完成或批准外部前置条件。

## 4. 工作方式

每个任务遵循 RED → GREEN → REFACTOR：

1. 先写一个能稳定复现缺口的最小测试或验证脚本并保存真实 RED；
2. 实现最小公共能力，不扩展产品模型；
3. 运行精确测试，再运行受影响 workspace 测试；
4. 每个 Gate 结束运行根门禁，更新脱敏证据；
5. 失败先读原始输出，同一阻断最多三轮且每轮必须有新证据；
6. 每个提交只覆盖一个变更簇，中文提交消息说明结果而非愿望。

任何公共契约变更必须同时更新 schema、类型测试、contract suite 和文档。迁移不得
原地改写历史 Event/Attempt/Evidence；恢复不得盲目重放未知外部副作用。

## 5. Task 1：新 worktree 可复现基线

**目的：** 消除测试依赖此前构建产物的隐式顺序，冻结 H0。

**文件：**

- 修改：`vitest.config.ts`
- 新增：`scripts/vitest-config.test.ts`
- 新增：`docs/validation/phase-1-hardening-baseline.md`

**RED：**

在全新 worktree 执行 `npm install` 后、任何 build/typecheck 前运行
`npm test`。若 workspace import 依赖不存在的 `dist`，测试必须真实失败。

**GREEN：**

- 每个测试期 workspace package 都显式解析到 `src/index.ts`；
- 删除生成的 `packages/*/dist` 后，裸 `npm test` 仍通过；
- `npm run lint`、`npm run typecheck`、`npm test`、`npm run build` 全通过；
- 新分支 GitHub Actions 在实际运行前记为 `NOT_RUN/PENDING`。

**提交：** `工程：固定 Phase 1 新工作树可复现基线`

## 6. Task 2：Phase 1 验收与供应链台账

**目的：** 把 `docs/08-user-stories-and-acceptance.md` 中 P-01 至 LNX-01、
Golden-1 至 Golden-6、非功能目标和发布阻断项逐条映射到证据。

**文件：**

- 新增：`docs/validation/phase-1-acceptance-ledger.md`
- 新增：`scripts/phase1-acceptance-ledger.test.ts`
- 可选新增：`scripts/phase1-acceptance-ledger.ts`

**RED：**

- 台账遗漏验收 ID、证据链接、平台、范围或状态时测试失败；
- `CONTRACT_ONLY` 记录若被写成真实 Provider `PASS` 时测试失败；
- 生产 release blocker 未关联 owner/next action 时测试失败。

**GREEN：**

- 当前已由 PR #5 证明的条目链接到既有 evidence；
- 真实 Provider、真实设备、真实项目体验保持 `BLOCKED/NOT_PROVEN`；
- 记录 `npm install` 报告的依赖风险数量，但不推断生产影响；
- 详细 `npm audit` 只有在用户明确批准向 registry 发送依赖元数据后运行；
- 生成本地依赖清单/SBOM 时不得包含环境变量或 registry credential。

**提交：** `治理：建立 Phase 1 验收与供应链台账`

## 7. Task 3：版本化迁移与启动完整性检查

**目的：** 用显式 schema 版本和迁移账本替代“构造 journal 时重复执行单一 SQL”。

**文件：**

- 新增：`packages/storage/src/migration-runner.ts`
- 新增：`packages/storage/src/migration-runner.test.ts`
- 新增：`packages/storage/src/migrations/002-*.sql`
- 修改：`packages/storage/src/sqlite-operation-journal.ts`
- 修改：`apps/daemon/src/startup/startup-recovery-coordinator.ts`
- 修改：`packages/storage/src/index.ts`

**RED：**

- 新库按顺序迁移；旧库只执行缺失迁移；
- checksum、版本跳跃、半完成 marker、`foreign_key_check` 或 `integrity_check`
  异常必须 fail closed；
- 迁移失败不得开始监听，也不得留下被当作成功的新 schema 版本；
- 不支持的未来 schema 返回固定非敏感错误。

**GREEN：**

实现 transactional migration ledger、版本/checksum 校验、WAL/foreign key 检查和
可测试的 startup receipt。破坏性迁移必须另设显式备份前置条件。

**提交：** `存储：引入版本化迁移与启动完整性门禁`

## 8. Task 4：一致性 Manifest、备份与恢复演练

**目的：** 关闭 SQLite、Archive、Artifact/CAS 和可读文件之间的 R-11 风险。

**文件：**

- 新增：`packages/storage/src/backup-manifest.ts`
- 新增：`packages/storage/src/backup-service.ts`
- 新增：`packages/storage/src/backup-service.test.ts`
- 新增：`scripts/verify-backup-restore.ts`
- 修改：根 `package.json`
- 新增：`docs/validation/phase-1-backup-restore.md`

**RED：**

- 禁止复制正在写入的裸数据库文件；
- backup 必须使用 SQLite 在线备份/一致快照，列出 schema、文件 hash、大小和范围；
- 缺文件、hash 不符、路径穿越、symlink escape、未来版本、孤儿引用均拒绝恢复；
- 恢复必须写入新临时根并完整验证，不能覆盖当前用户数据；
- crash 任意点只留下可识别的 incomplete staging，不留下“成功” manifest。

**GREEN：**

用 staging + fsync/close + atomic rename 形成版本化 manifest；恢复演练在临时目录
重建投影并对账 Event、Artifact、Archive 和 Knowledge 引用。

**提交：** `恢复：建立一致性备份清单与隔离恢复演练`

## 9. Task 5：脱敏诊断包与 Secret canary

**目的：** 让用户能报告故障，同时证明数据库、日志、导出、Prompt 和诊断包不泄密。

**文件：**

- 新增：`packages/policy/src/redaction.ts`
- 新增：`packages/policy/src/redaction.test.ts`
- 新增：`apps/daemon/src/services/diagnostic-bundle.ts`
- 新增：`apps/daemon/test/diagnostic-bundle.test.ts`
- 新增：`scripts/verify-diagnostic-bundle.ts`
- 修改：根 `package.json`

**RED：**

- 注入 token、cookie、API key、authorization header、私有绝对路径和 Prompt canary；
- 所有输出逐字节扫描，任一 canary 出现即失败；
- 未知对象、循环引用、超大字段和二进制内容 fail closed；
- 诊断包默认不包含 SQLite、完整源码、原始 Agent 事件或凭据文件。

**GREEN：**

诊断包只包含 allowlist manifest、版本、固定错误码、hash、计数和脱敏摘要；每个过滤
规则有 schema version，且不记录完整环境变量。

**提交：** `安全：加入版本化脱敏诊断包与 Secret 扫描`

## 10. Task 6：Attention action 与恢复可操作性

**目的：** UI 不只显示“需要处理”，还要解释原因、证据和允许的下一动作。

**文件：**

- 修改：`packages/api-contracts/src/http.ts`
- 新增或修改：`packages/api-contracts/src/attention*.test.ts`
- 修改：`apps/daemon/src/routes/runs.ts`
- 修改：`apps/daemon/src/services/application-services.ts`
- 修改：`apps/web/src/pages/run-page.tsx`
- 新增：`apps/web/src/components/attention-panel.tsx`
- 新增/修改对应测试

**RED：**

- waiting/failed/stale/needs_attention 必须给出固定 reason code、actor、input revision、
  evidence ref 和允许动作；
- 未知外部结果只能人工确认、重试检查或创建新 Attempt，不能标记成功；
- 重复 action 使用 idempotency key + expected version；
- 历史 Attempt 永不被 UI 或 API 改写；
- capability 不足的动作 disabled，并展示 receipt-derived reason。

**GREEN：**

增加 provider-neutral `AttentionItem` 投影和窄命令，不暴露原始 Provider payload、
任意 path 或任意 terminal control。

**提交：** `运维：让待处理状态提供可审计恢复动作`

## 11. Task 7：日志、Artifact 分页、配额与背压

**目的：** 防止大日志拖垮 UI 或无限占满磁盘。

**文件：**

- 修改/新增：`packages/storage/src/artifact-catalog*.ts`
- 修改/新增：`packages/api-contracts/src/artifacts*.ts`
- 修改：`apps/daemon/src/routes/*`
- 修改：`apps/web/src/components/step-detail.tsx`
- 新增：`scripts/verify-resource-bounds.ts`

**RED：**

- 大日志只能通过有界 cursor/page 读取，浏览器不加载完整内容；
- cursor 低于 retention floor 返回显式 resync；
- quota 达到 soft limit 时告警，hard limit 时拒绝新非关键内容并保留核心 receipt；
- 删除策略不得删除被当前 Evidence/Archive 引用的内容；
- 慢客户端不得阻塞 durable writer，断线后从 ledger 重读。

**GREEN：**

冻结页大小、最大字段、摘要策略、磁盘水位、保留优先级和 backpressure receipt；
用 10 个只读/等待 Step、4 个活跃 Fake Step 和大日志 fixture 测量。

**提交：** `资源：为日志与证据加入分页配额和背压`

## 12. Task 8：Knowledge 与 Handoff 注入防护

**目的：** 关闭 R-14/R-15，不让失败、过期或恶意文本自动变成权威 Prompt。

**文件：**

- 修改：`packages/knowledge/src/resolver.ts`
- 修改：`packages/knowledge/src/contracts.ts`
- 新增：`packages/knowledge/src/prompt-injection.test.ts`
- 修改：Connector 的 Handoff builder 与测试
- 修改：Workbench Knowledge 来源展示

**RED：**

- superseded/withdrawn 默认不注入；
- failed Archive 只能成为带来源的历史/经验候选；
- 冲突知识降级并要求显式选择；
- 外部内容、源码指令和历史 Prompt 用数据边界包裹，不能提升工具权限；
- Handoff 有 token/byte/item 预算，截断可解释且保留引用；
- Provider 替换不改变选择结果。

**GREEN：**

输出稳定的 selection receipt：候选、排除原因、scope、authority、confidence、
validity、hash 和预算；默认 UI 展示来源而非协议噪音。

**提交：** `知识：隔离 Handoff 来源并阻断自动知识投毒`

## 13. Task 9：移动离线、撤销与重新同步硬化

**目的：** 保持 Host 为事实源，并让离线摘要和高风险命令不会误导用户。

**文件：**

- 修改：`packages/device-gateway/src/*`
- 修改：`apps/daemon/src/routes/mobile-*.ts`
- 修改：`apps/web/src/mobile/*`
- 修改：`apps/web/src/pages/mobile-cockpit.tsx`
- 新增对应 fault/security E2E

**RED：**

- 远端监听默认关闭；未配置 TLS/设备身份时不可启动；
- revoked device、过期 access token、旧 refresh family、重放命令均拒绝；
- 离线队列必须展示缓存时间、expected version 和未确认状态；
- reconnect 时 gap/retention floor 触发 snapshot resync；
- 高风险 Gate 和超出 Project scope 的 Artifact 永不下发；
- 移动端不接受任意 shell、路径、URL 或 Provider 私有操作。

**GREEN：**

用本地 TLS fixture 和 Fake device 测试；真实手机体验仍为 `NOT_PROVEN`，不得由
Playwright viewport 替代。

**提交：** `移动：强化离线命令撤销与事件重同步`

## 14. Task 10：Windows 安装、升级、卸载与 sidecar 生命周期

**目的：** 验证未签名测试安装包不会在升级、双开、崩溃或卸载时损坏用户数据。

**文件：**

- 修改：`apps/desktop/package.json`
- 新增：`apps/desktop/scripts/verify-install-lifecycle.mjs`
- 新增：`apps/desktop/src/install-lifecycle*.test.ts`
- 新增：`docs/validation/phase-1-windows-install-lifecycle.md`

**RED：**

- 安装路径和数据路径含空格/中文；
- 首次启动、双实例、daemon 启动失败、renderer crash、正常退出均回收 owned process；
- 升级保留兼容数据并先通过 migration/backup gate；
- 卸载默认保留用户数据，显式删除必须二次确认且不由自动测试触碰真实目录；
- packaged preload 保持 named API allowlist，正式 bundle 不含 Fake Runtime；
- artifact 未签名、未发布、未上传。

**GREEN：**

在自动创建的临时安装/数据根运行 smoke；保存 installer hash、大小、版本和清理记录。
真实 SmartScreen、签名、分发和生产升级保持 `BLOCKED`。

**提交：** `桌面：验证未签名安装包升级与进程生命周期`

## 15. Task 11：性能、故障矩阵与 24 小时 soak

**目的：** 用测量冻结 Phase 1 的本机目标，不把一次单测通过等同长期可靠。

**文件：**

- 新增：`packages/testkit/src/phase1-load-fixture.ts`
- 新增：`scripts/benchmark-phase1.ts`
- 新增：`scripts/soak-phase1.ts`
- 新增：`docs/validation/phase-1-performance.md`
- 新增：`docs/validation/phase-1-soak.md`

**RED/测量前置：**

- 固定 dataset、seed、Fake clock、硬件/OS 摘要和输出 schema；
- 覆盖 commit 前后 crash、dispatch 前后 crash、receipt 前后 crash、projection loss、
  Archive 中断、磁盘满/只读、SSE gap、移动重放；
- 失败不能自动重跑成 PASS；每个 attempt 单独保留。

**GREEN：**

- Project list/Run page 本地目标 1 秒内可交互；
- Event 到本机 UI 目标小于 500ms；
- 10 个只读/等待和 4 个活跃 Fake Step 时无 UI/ledger 饥饿；
- 24 小时包含多次 Loop、重启、归档和重建，不出现重复外部 operation、虚假成功、
  无界资源增长或不可解释状态。

目标未达到时记录 `FAIL/NOT_PROVEN` 和观测值，不调低阈值来制造通过。

**提交：** `验证：建立 Phase 1 性能故障矩阵与长稳测试`

## 16. Task 12：Fake-only 黄金场景与 H4 候选证据

**目的：** 汇总 Golden-1 至 Golden-6 的自动部分，形成可审阅的 H4 结论。

**文件：**

- 修改/新增：`e2e/phase1-*.spec.ts`
- 新增：`docs/validation/phase-1-contract-only-candidate.md`
- 修改：`docs/validation/phase-1-acceptance-ledger.md`

**RED：**

- Golden-1：单任务链路、独立 verifier、归档与重开；
- Golden-2：并行 worktree、显式 join/merge conflict；
- Golden-3：失败后新 Attempt、有界 Loop、旧失败可查；
- Golden-4：只验证 Cursor L0/L1 handoff 契约；真实窗口/人工确认为 `NOT_PROVEN`；
- Golden-5：Hunter/Fake Provider 重启无重复 side effect；
- Golden-6：Fake device 的 scope、拒绝、离线幂等；真实手机为 `NOT_PROVEN`。

**GREEN：**

运行：

```text
npm ci
npm run lint
npm run typecheck
npm test
npm run verify:foundation
npm run verify:backup
npm run verify:diagnostics
npx playwright test --project=chromium
npm run pack:win -w @hunter/desktop
git diff --check
```

GitHub Windows/Ubuntu jobs 只有在对应 SHA 实际完成后才能写 `PASS`。H4 evidence 必须
列出所有 `FAIL`、`BLOCKED`、`NOT_PROVEN`、`NOT_RUN` 和失败重试历史。

**提交：** `验收：冻结 Phase 1 contract-only 硬化候选`

## 17. Gate R：必须由用户参与或另行授权

以下事项不由本计划自动执行：

1. **真实 Provider Gate A**：固定版本、安装来源、登录、原子 capability receipt、
   workspace confinement、terminal/session lifecycle、restart/reconcile、security
   defaults 和 cleanup。
2. **真实 Connector**：Codex、CodeBuddy、Cursor 的支持等级必须从 receipt 计算；
   不按产品名称硬编码 L2/L3。
3. **真实设备**：手机配对、撤销、弱网、锁屏和体验验收。
4. **真实项目**：至少一个非玩具 Change，包含人工接管和恢复演练。
5. **供应链网络审计**：向 registry 发送依赖元数据前需要明确批准。
6. **生产发布**：代码签名证书、分发渠道、遥测/隐私、许可证、备份策略和
   Go/No-Go 都需要独立决策。

Gate R 未完成时，产品文案不得声称支持任何真实 Provider，不得把未签名测试包分发
给生产用户，也不得声明 Phase 1 已完成。

## 18. 完成报告

每个 Gate 的报告至少包含：

- base/head SHA、提交列表和修改文件；
- RED 与 GREEN 的原始命令、结果、平台和时间；
- 本机、CI、Fake、真实 Provider、真实设备证据边界；
- acceptance ledger 的状态变化；
- 未关闭风险、最小后续动作和需要用户参与的 Gate；
- 明确声明未完成的真实 Provider、签名、发布和超范围功能。
