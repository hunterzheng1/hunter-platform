# Herdr replacement control-plane implementation plan

- 日期：2026-07-28
- 决策：[`ADR-0007`](../adr/0007-herdr-replacement-control-plane-gate.md)
- 时间盒：继承原门禁，截止
  `2026-08-04T04:19:30.589Z`，不因更换候选而重置
- 平台：真实 Windows 主机；Linux 只执行 provider-neutral CI
- 固定候选：Herdr `0.7.5`
- 结果：`PASS` / `FAIL` / `BLOCKED` / `NOT_PROVEN`，不接受“基本可用”

## 1. Outcome

在一个真实、非玩具、无远端写入的 Git fixture/项目上证明：

```text
approved Requirement/Change
  → Hunter exact isolated worktree + leases
  → Herdr public worktree.open attaches exact existing path
  → one real Agent modifies a verifiable target
  → observations do not imply success
  → independent Verifier fails Attempt 1
  → recovery Attempt 2 passes
  → Hunter/isolated Herdr restart and reconcile
  → redacted Evidence + complete state-only Host cleanup
  → ordinary user completes/understands it in ten minutes
```

本计划继承 Orca Task 1 的真实 Stop 结果，不重跑或改写 Orca 证据。目标仍然
是回答：Hunter 的 Requirement/Attempt/Verifier/Evidence 治理是否比直接
使用成熟工具增加足够价值。

## 2. Frozen baseline and non-claims

- Phase 0 Outcome 5、Gate R、Orca Task 0/1 及全部历史
  `FAIL/BLOCKED/NOT_PROVEN/CONTRACT_ONLY` 保持只读。
- Herdr 官网、release、CLI 文档、安装成功、`ping`、pane idle、Agent
  returned、process exit 都不证明 Step success。
- 官方资料仅用于选择 probe；`PASS` 必须来自固定本机二进制、版本匹配
  schema、真实操作 receipt 和独立 Verifier/HumanReceipt。
- 尚未运行的本机步骤与 GitHub Actions 为 `NOT_RUN`，远端 CI 不因本地
  通过而推定。
- 不授权生产发布、签名、部署、远端写入、Herdr/Pi/Orca Fork。

## 3. Allowed scope

只在直接需要时修改：

- `packages/domain/**`
- `packages/application/**` / `packages/api-contracts/**`
- `packages/flow-engine/**`
- `packages/runtime-contracts/**`
- `packages/runtime-manager/**`
- 新的最小 `packages/provider-herdr/**`
- `packages/storage/**`
- `packages/policy/**`
- `packages/knowledge/**` 的最小 Evidence/Archive 路径
- `packages/testkit/**`
- `apps/daemon/**`
- `apps/web/**` 的窄控制页
- `scripts/**` 中本 gate 的版本化 probe/verification
- `docs/research/**`、`docs/validation/**` 的新记录
- 根 workspace/package/CI 中为新包和门禁直接需要的最小调整

保持冻结：

- `packages/provider-orca/**` 的新能力；旧代码和证据只读；
- Pi Adapter 或第三个 Provider；
- Hunter Desktop 新产品能力、移动/PWA、Device Gateway、remote relay；
- Hunter-owned terminal、PTY、Diff、Browser、worktree IDE；
- deep direct Codex/CodeBuddy/Cursor Connector；
- 额外 speculative capability 层、完整 Flow/UI、团队/云能力；
- Herdr private state、GUI automation、Fork 与 production distribution。

## 4. Safety invariants

1. Hunter 创建并校验 exact Git worktree/HEAD，持有 Workspace/Writer Lease；
   Herdr 只能 `worktree open --path` 该既存路径。
2. 正常路径禁止 `worktree create`、`worktree remove` 和 `--force`；Host
   cleanup 只能 `workspace close`，Git checkout/branch 由 Hunter 在独立
   安全检查后清理。
3. 只使用固定 binary 的公开 CLI、`api schema --json` 或 Windows named
   pipe；不读写 Herdr private session/config 文件。
4. 所有 Provider mutation 使用结构化 argv、`shell: false`、operation id
   和 payload fingerprint。
5. 相同 operation id + fingerprint 返回原 receipt；相同 id + 不同 payload
   拒绝；未知协议/schema/version fail closed。
6. 测试只使用独立的 Hunter-owned named Herdr session；任何 unrelated
   workspace/pane/Agent 都不得被关闭、输入或重启。
7. Agent launch 为 Manual/fail-closed；检测
   `dangerously-bypass/yolo/auto-approve` 或等价参数即在 Provider I/O 前
   `BLOCKED`。
8. Agent/Herdr-facing tools 只能读取 frozen handoff、报告
   observation/artifact、请求 attention；不能 approve、mark success、
   运行/签发 Verifier 或修改 Policy。
9. Verifier definition、config、oracle 在 Agent 不可写边界；Verifier 在
   Agent session 外运行并绑定 Attempt/input/output/config hash。
10. retry/recovery 创建新 Attempt，历史只追加；每个临时
    workspace/pane/session/worktree/branch 都有结构化 cleanup receipt。

## 5. Evidence states and closeout

- `PASS`：固定版本真实命令得到可复现本机证据，schema/hash/privacy 均过。
- `FAIL`：已经运行且违反契约；保留原始失败并停止当前 gate。
- `BLOCKED`：缺安装、登录、授权或安全公开接口能力。
- `NOT_PROVEN`：证据不足或时间盒到期。
- `NOT_RUN`：尚未执行。
- `CONTRACT_ONLY`：Fake/fixture 只证明 Hunter 契约。

任何 Task 得到无法安全绕过的 `FAIL/BLOCKED`，或截止时仍
`NOT_PROVEN`，立即：

1. 停止新 Provider mutation；
2. inventory 并只清理本次 receipt 证明为 Hunter-owned 的 Herdr
   workspace/pane/Agent/named session；
3. 不调用 `worktree remove`，先保留 Git checkout 与失败历史；
4. 对 operation/outbox/provider effect、schema/hash/privacy/path/secret
   做对账；
5. 后续 Task 写为 `NOT_RUN`，提交准确 Closeout；
6. 确认 Git 独有工作已保存后，按分支规范清理临时资源。

同一阻断最多三轮有新证据的修复。每轮先读原始 stderr、结构化响应、
checkpoint、receipt/outbox 与 Git 状态；无新证据不得重复。

## 6. Working method

每个 Task 使用 RED → GREEN → REFACTOR：

1. 先建立稳定复现缺口的最小测试/probe；
2. 只实现让该测试通过的最小公共能力；
3. 先跑精确测试，再跑受影响 workspace 和全门禁；
4. 公共契约变化同步更新 schema、类型、contract suite 和文档；
5. 每个 Task 一个聚焦中文提交、PR、Windows/Ubuntu CI；
6. 合并后按 inventory 安全清理不再需要的 worktree、本地/远端分支；
7. 所有失败、跳过与旧证据保留，不改写为 PASS。

## 7. Task 0 — Freeze replacement inventory

**RED：**

- 主线/工作区有无关修改；
- Herdr 固定版本、资产来源、hash、公开命令/schema 或 Windows 状态未知；
- evidence schema 无法表达 `BLOCKED/NOT_PROVEN/NOT_RUN`；
- probe 会读取完整环境、credential 或用户私有路径。

**GREEN：**

- 继承原 source baseline 和 deadline，记录 replacement branch
  commit/digest；
- 以可恢复临时目录下载官方 Windows `0.7.5` 资产并校验发布 hash；
- 不使用 pipe-to-shell、PowerShell execution-policy bypass 或全局安装；
- 记录 Node/Git/Windows/Herdr/Codex detected/login，不读取 credential；
- 只读收集 `--version/help`、`api schema --json`、worktree/workspace/session/
  agent public inventory；
- RunBudget 仍为最多 2 Attempt、每 Attempt 1 session/4 send/20 分钟，
  累计真实执行 45 分钟、新增付费 0。

**硬门：** 资产缺失、hash 无法确认、Windows binary 无法启动、schema
不匹配或需要扩大权限时 `BLOCKED`，不进入 Task 1。

**提交：** `治理：冻结 Herdr 替代门禁基线与证据口径`

## 8. Task 1 — Public Herdr Adapter and launch-argv gate

**RED：**

- duplicate/mismatched operation 重复 effect；
- dangerous permission argv 仍启动；
- 需要 shell 拼接、private state 或 terminal/GUI scraping；
- detected/ping/idle 被写成 capability PASS；
- cleanup 需要 `worktree remove` 或 force。

**GREEN：**

- typed public request/receipt、strict JSON schema、redaction；
- fixed-version/protocol receipt，unknown fail closed；
- `worktree open --path` exact existing checkout receipt；
- duplicate open 返回同一或 `already_open` 可对账结果；
- `workspace close` state-only cleanup receipt，Git path/HEAD/branch 保留；
- isolated named session inventory 证明 unrelated resources 未触碰；
- Manual/fail-closed argv gate 在 Provider I/O 前拒绝危险参数。

**硬门：** exact open、state-only close、isolated session、stable structured
IDs 或 launch-argv gate 任一无法证明，立即 `BLOCKED`，Task 2–8
`NOT_RUN`。

**提交：** `运行时：建立 Herdr 公共适配与权限硬门`

## 9. Task 2 — Authenticated Hunter control surface

使用普通 loopback 浏览器作为第一入口，不要求 Herdr 内嵌 Browser 或持久
plugin：

- random loopback port；
- URL 不含长期 Secret 或写能力；
- 一次性启动标识 + same-user rendezvous/短码确认；
- `HttpOnly`、`SameSite=Strict` session、CSRF、Project/Run scope；
- 页面只展示 Requirement/Change、Attention、Run/Attempt、
  Verification/Evidence、Policy/Recovery；
- 未认证写、replay、跨 scope 或绕过独立验证均为 RED。

**提交：** `界面：安全打开 Herdr 承载运行的 Hunter 控制页`

## 10. Task 3 — Hunter worktree ownership and Herdr attach

- Hunter 在临时 no-remote fixture 创建 exact worktree；
- canonical path/HEAD/branch/Lease receipt；
- symlink/path escape、错误 HEAD、第二 Writer、provider-selected path 拒绝；
- Herdr 只 open 既存 path，external ref 与 Lease 对账；
- 重复 attach 幂等，payload mismatch 拒绝；
- `workspace close` 后 Git worktree/branch 仍存在且内容未变；
- Hunter 最后按 clean/unique/archive 检查清理 Git 资源。

**提交：** `工作区：由 Hunter 租赁并让 Herdr 附加精确 worktree`

## 11. Task 4 — Narrow Agent-facing tools

只允许：

- `read_pinned_handoff`
- `register_artifact` / `report_observation`
- `request_attention`
- 可选只读 `read_run_projection`

必须证明 capability 为短时、可撤销、Attempt-scoped；Agent 不能 mark
success、approve、alter policy、run/sign verifier 或跨 scope；每次调用有
actor/correlation/idempotency receipt。

**提交：** `安全：收窄 Herdr Agent 可见的 Hunter 工具权限`

## 12. Task 5 — Real Agent execution and observations

- 在任何真实 Attempt 前，先在自动创建的 no-remote 临时 fixture 中放置
  worktree 外的 sibling target，让所选 Agent 尝试创建一个无害文件；必须
  得到结构化拒绝或显式 approval-required，且 sibling target 保持不变；
- 该负向探针只能触碰自动 fixture，receipt 绑定 canonical worktree、
  sibling target、Agent profile/config hash 与结果；不得读取或尝试写入
  用户文件；
- 若 Agent 实际写出 worktree 外、静默放行，或无法形成可审计的拒绝/审批
  结果，立即 `BLOCKED`，本 Task 的真实 Attempt 与 Task 6–8 `NOT_RUN`；
- 使用透明两阶段 fixture：最终 OutputContract 要求 A+B；Attempt 1 只实现
  A，Attempt 2 根据失败 Evidence 实现 B；
- 真实 Agent 在 exact worktree 修改文件；
- launch/prompt/observe/wait/interrupt/reconcile receipts 完整；
- Agent returned、pane idle、process exit、wait success 都只能更新
  observation，VerificationStatus 仍 pending；
- duplicate operation 不重复 prompt/session/effect；
- 两次 Attempt 使用同一 Run 启动前冻结、Agent 不可写的 Verifier。

**提交：** `执行：接通一个 Herdr 承载的真实 Agent Attempt`

## 13. Task 6 — Independent failure and recovery

- Attempt 1 的独立 Verifier 必须真实 FAIL；
- immutable VerificationReceipt 绑定 Attempt 1 并保留 Evidence；
- bounded loop 创建 Attempt 2，Handoff 只含精确脱敏失败证据；
- Attempt 2 由同一 Verifier PASS；
- UI 同时显示两个 Attempt 与 authority；
- Agent/Host 输出、自改测试或旧 receipt 不能绿灯。

**提交：** `验证：保留失败并由独立收据完成 Herdr 恢复 Attempt`

## 14. Task 7 — Restart, reconcile, Evidence, cleanup

只重启本次 receipt 创建的 isolated named Herdr session，不得停止默认或
用户 session。故障矩阵至少覆盖：

- Hunter intent 后、receipt 前重启；
- Herdr 在 Agent returned、verify 前重启；
- Agent/pane/workspace present/missing/unknown；
- outbox pending/receipt written/provider effect exists；
- worktree HEAD unchanged/externally changed。

必须证明：

- operation/outbox/provider effect 三方对账；
- unknown → `needs_attention`，不猜 success；
- 无 duplicate prompt/session/effect；
- 旧失败只追加 observation/receipt；
- workspace/pane/Agent/named session cleanup 完整；
- Git checkout 只由 Hunter 在最终安全检查后清理；
- Evidence schema/hash/privacy/reproducibility 通过。

**提交：** `恢复：对账 Herdr 副作用并封存脱敏真实证据`

## 15. Task 8 — Ten-minute value Go/Stop

从 Hunter 控制页启动一个普通任务到查看最终 Evidence 计时。用户应能回答：

- 需求依据是什么；
- Agent 做了什么；
- 为什么 returned/idle 仍未完成；
- Attempt 1 为什么失败；
- Attempt 2 依据什么通过；
- 现在是否需要处理。

### Go

- 十分钟内完成并正确理解；
- 用户认为治理/验证/证据价值超过额外操作；
- 无 private state、危险权限、duplicate effect 或残留资源；
- 全门禁和实际 Windows/Ubuntu CI 通过。

### Stop

- Herdr Windows beta、public API、权限或恢复不可靠；
- 需要 private state/scraping/bypass/force removal；
- deadline 前无法完整贯通；
- Hunter UI 只是重复 standalone Orca/Herdr；
- 维护成本高于控制面价值。

**提交：** `决策：记录 Herdr 纵向切片 Go Stop 结果`

## 16. Verification commands

每簇先运行精确测试；最终至少：

```text
npm install
npm run lint
npm run typecheck
npm test
npm run build
npm run verify:foundation
<exact Herdr Adapter contract tests>
<exact browser authentication tests>
<exact workspace/lease/state-only-cleanup tests>
<exact real vertical-slice verifier test>
<evidence schema/hash/privacy/path/secret scan>
git diff --check
git status --short
```

真实 Herdr/Agent 命令只能从版本化脚本运行，输出脱敏 envelope；远端 CI
实际完成前为 `PENDING/NOT_RUN`。

## 17. Completion report

列出：

- 每个提交 SHA、修改文件、PR 与实际 CI；
- 每个命令的真实状态；
- Herdr/Agent fixed version、install/login/capability receipts；
- Attempt 1/2、restart、operation/outbox/effect、cleanup；
- Evidence 路径/schema/hash/privacy；
- 十分钟验收与 Go/Stop；
- 未运行平台、设备、production gate；
- 明确没有完成 Hunter Desktop/mobile、Pi/多 Provider、Fork 或生产发布。

## 18. Branch hygiene

每个 PR 合并或 Task 明确 Stop 后：

1. fetch/prune 并 inventory local/remote branch、worktree、open PR；
2. 不处理 current/main/protected/shared；
3. worktree 必须 clean，branch 无独有未保存工作；
4. 先移除 linked worktree，再删 local topic branch；
5. 仅删 merged/closed 且不再需要的 remote topic branch；
6. 报告删除、保留及原因。
