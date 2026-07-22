# Foundation Tasks 2–13 本机门禁证据

- 验证日期：2026-07-22（Asia/Shanghai）
- 分支：`codex/foundation-tasks-2-13`
- Foundation 基线：`66709c49da2fa7959b22bb07441b4b56c06c1b93`
- 仓库根基线：`8a78a63a95dc14405475bf8c465381259811e347`
- 验证范围：`docs/plans/2026-07-21-platform-foundation.md` Task 2–13
- Runtime 证明范围：`contract_only`（Fake Runtime）

本证据只证明 Hunter Foundation 的本地契约、持久化、恢复、授权和组合链路。它不证明任何真实 Provider、GUI/终端集成、远程访问、生产发布或产品 UI 可用。

## 提交链

| Task/修复簇 | 提交 | 说明 |
| --- | --- | --- |
| Task 2 | `564cf08` | 完整 Project/Requirement/Change/Task/ExecutionPlan 模型 |
| Task 3 | `46ab9de` | 可执行 WorkflowRevision 图与有界循环校验 |
| Task 4 | `8d07b07` | SQLite 事件账本、命令收据、Outbox、外部操作收据与崩溃收敛 |
| Task 5 | `6590289` | 可重建投影与持久游标 |
| Task 6 | `7b36704` | Change/ExecutionPlan 原子发布 |
| Task 7 | `5ef7d68` | 权威 FlowEngine、冻结绑定、路由与持久预算 |
| Task 8 | `1c48df0` | 能力、策略与 Lease 边界 |
| Task 9 | `ef3e47e` | 仅通过持久操作日志分配 Runtime 操作 |
| Task 10 | `11342ad` | 监听前恢复与对账 |
| Task 11 | `75701eb` | 严格认证、授权和 schema 校验的 loopback REST |
| Task 12 | `3da4f0b` | 持久、授权、可续传 SSE |
| Task 13 | `e77a06e` | 生产服务组合与 Windows/Ubuntu CI 定义 |
| 审查修复 | `9ef1d78` | 恢复、调度、重放和事件流权威边界 |
| 环境证据 | `6287168` | 刷新本机 Phase 0 环境清单 |
| 验收补强 | `918fcd9` | 权威任务图与文件型 Foundation 全链路 |
| 安全补强 | `4ea2cd2` | 本地会话资源限制与 SecretRef 边界 |
| 最终审查修复 | `6c4ad07` | 取消协议、恢复观测、动态授权、控制租约与投影缺口 |

## 最终本机结果

| 命令/检查 | 结果 | 真实输出摘要 |
| --- | --- | --- |
| `npm ci` | PASS | 首次在受限沙箱读取用户 npm cache 时出现 `EPERM`；以同一命令作窄范围授权重跑后安装 221 packages，审计 234 packages |
| Foundation 计划精确测试并集 | PASS | 24 个测试文件，156 个测试通过 |
| Phase 0 精确测试 | PASS | 5 个测试文件，15 个测试通过 |
| `npm run lint` | PASS | ESLint 退出 0 |
| `npm run typecheck` | PASS | TypeScript project references 退出 0 |
| `npm test` | PASS | 30 个测试文件，174 个测试通过 |
| `npm run verify:rebuild` | PASS | `status=PASS`、`projector=hunter`、`eventCount=3` |
| `npm run verify:recovery` | PASS | 确定性摘要 SHA-256 `e73ee7cafb4eb14e249bf8fb35b8adc3a8779983783479a56344ff6cbdaf1b78` |
| `npm run build` | PASS | `tsc -b` 退出 0 |
| `npm run verify:foundation` | PASS | lint、typecheck、30/174 tests、rebuild、recovery、build 全链通过 |
| `npm run spike:doctor` | PASS | 生成脱敏清单；DETECTED=3、BLOCKED=5、NOT_PROVEN=0 |
| Doctor 隐私扫描 | PASS | 无原始用户路径、原始工作区路径、凭据赋值、环境 dump 或用户私有 Prompt |
| 公共契约中立性扫描 | PASS | 生产公共契约未出现 Orca/Codex/CodeBuddy/Cursor/Goose 或 GUI/终端私有字段 |
| 权限绕过扫描 | PASS | 未出现 `dangerously-bypass`、`yolo`、`auto approve` |
| Fake 证明范围扫描 | PASS | Fake Runtime 与 contract suite 均显式保留 `contract_only` |
| CI matrix 静态检查 | PASS | workflow 同时定义 `windows-latest` 与 `ubuntu-latest` |
| `git diff --check` | PASS | 无 whitespace error；仅 Git 的 LF→CRLF 工作副本提示 |
| 允许路径审计 | PASS | 从 Foundation 基线累计 101 个变更文件（含本证据文件），边界外 0 个 |
| 基线祖先检查 | PASS | `66709c49` 是当前 HEAD 祖先；仓库根基线 `8a78a63a` 存在于历史中 |

Foundation 计划精确测试并集由 Task 1 smoke 基线，以及 Task 2–13 最终 GREEN 命令中的 domain、workflow、storage、application、flow-engine、runtime-contracts、policy、runtime-manager、daemon/API/SSE/全链测试文件去重组成。它与全量 `npm test` 分开执行，以证明计划指定入口没有被全量结果掩盖。

## Phase 0 Doctor 本机事实

来源：`docs/validation/environment-inventory.json`。状态只表示当前受限本机探针结果，不使用官方兼容性声明替代本机证明。

| 工具 | 状态 | 版本/阻断原因 |
| --- | --- | --- |
| Windows | DETECTED | `10.0.26200` |
| Node.js | DETECTED | `v24.14.0` |
| Git | DETECTED | `git version 2.50.1.windows.1` |
| Codex CLI | BLOCKED | executable missing or unusable；无法安全验证登录 |
| CodeBuddy Code | BLOCKED | executable missing or unusable；无法验证登录 |
| Cursor | BLOCKED | executable missing or unusable；无安全非交互登录探针 |
| Orca | BLOCKED | executable missing or unusable；无法验证登录 |
| Agent Orchestrator 备选 Runtime | BLOCKED | executable missing or unusable；无安全非交互登录探针 |

Doctor 没有读取 token、cookie、API key、完整环境变量或私有 Prompt。缺少 executable/登录能力被记录为 BLOCKED，没有伪造 PASS；本轮没有触发时间盒型 NOT_PROVEN。

## RED → GREEN 历史

以下失败均保留为真实开发历史，未改写为成功：

- 早期 Task 图/Subflow/文件仓储测试暴露 TypeError、TypeScript 缩窄和 skip 回归；增加严格 schema、图校验及文件型实现后转绿。
- 第一次 Foundation 链路审查新增测试后出现 4 个 RED：根 Run 过早成功、未持久化 assignment、取消未等 interrupt receipt、子预算未计入；修复权威 TaskGraph 状态与持久收据后转绿。
- 本轮 typecheck 首先暴露 worktree 联合类型错误，lint 暴露未使用 launch 变量；按原始诊断修复后转绿。
- `ExecutionFailed` 投影、Loop `paused` 穷尽语义、SSE 每事件动态授权、v2 控制租约 payload/dispatch-time authority、持久项目授权 setter 均先以聚焦 RED 测试固定缺口，再实现 GREEN。
- 文件型全链恢复最初暴露 ControllerLease 缺失和非法状态转换；改为从持久 launch receipt 恢复 NativeSessionId、续租并写入 journaled `session.observe` 后转绿。
- `npm ci` 的第一次失败是受限沙箱无法读取用户 npm cache（`EPERM`），不是依赖或测试失败；相同命令在窄范围授权下成功。
- 提交后的第一次 Phase 0 精确命令仍引用计划早期路径 `spikes/testkit/src/index.test.ts`；该文件在共享骨架重构后不存在，Vitest 未将缺失参数报错，实际只执行 4 个文件/14 个测试。改用现有 `packages/testkit/src/smoke.test.ts` 后重新执行，真实结果为 5 个文件/15 个测试通过。
- Doctor 隐私扫描的第一条 PowerShell 表达式有解析错误，未执行扫描；修正表达式后扫描通过。

最终独立代码审查结论为 **Ready**，没有未关闭的 Critical 或 Important 发现。

## 已知风险、PENDING 与未验证项

- `npm audit --json` 返回退出码 1：Fastify 直接依赖存在 1 个 high 严重度审计项，`fixAvailable=false`。没有运行盲目或破坏性的 audit fix；进入后续交付前应跟踪上游可用修复并重新评估受影响接口。
- GitHub Actions 的 Windows 和 Ubuntu job 仅完成静态定义，远端 CI **PENDING**，本轮没有 push，因此没有真实远端运行结果。
- 真实 Codex、CodeBuddy、Cursor、Orca/备选 Runtime 的 executable、登录、会话恢复、取消和 GUI/终端行为均未验证；其状态保持 BLOCKED 或未进入证明范围。
- Windows 本机 Foundation 门禁已运行；Ubuntu 只由 CI matrix 覆盖，真实 Ubuntu 执行 **PENDING**。
- 没有实现产品 UI、Workbench、Electron、移动 PWA、真实 Provider/Connector、生产发布或远程访问。
- Fake Runtime 只证明 Hunter 公共契约和确定性；不能解释为真实 Provider 已通过验证。

## 建议的下一步

保持 Foundation 边界不变，先让本分支在远端 Windows/Ubuntu CI 上获得真实结果，并单独处理 Fastify 无现成修复的审计风险。完成这些外部验证后，再依据批准计划评审下一阶段；未经新的明确授权，不进入 First Vertical Slice、不选择/Fork Orca，也不接入真实 Provider。
