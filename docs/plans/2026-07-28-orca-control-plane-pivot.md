# Orca-first control-plane pivot implementation plan

- 日期：2026-07-28
- 决策：[`ADR-0006`](../adr/0006-orca-first-control-plane-delivery.md)
- 时间盒：最多五个工作日
- 平台：真实 Windows 主机；Linux 继续执行 provider-neutral CI
- 结果：`PASS` / `FAIL` / `BLOCKED` / `NOT_PROVEN`，不接受“基本可用”

## 1. Outcome

在一个真实、非玩具、无远端写入的 Git fixture/项目上证明：

```text
approved Requirement/Change
  → Hunter exact isolated worktree + leases
  → Orca public Adapter attaches exact path
  → one real Agent modifies a verifiable target
  → observations do not imply success
  → independent Verifier fails Attempt 1
  → recovery Attempt 2 passes
  → Hunter/Orca restart and reconcile
  → redacted Evidence + complete cleanup
  → ordinary user completes/understands it in ten minutes
```

本计划的目标不是“接入更多 Agent”或“做完 Hunter UI”，而是回答一个
产品问题：Hunter 的 Requirement/Attempt/Verifier/Evidence 控制面是否比
直接使用 Orca 增加足够价值。

## 2. Frozen baseline and non-claims

- Phase 0 Outcome 5、Gate R、已有 `BLOCKED`/`NOT_PROVEN`/
  `CONTRACT_ONLY` 证据保持原样。
- `orca status`、安装成功、官方文档、Fake contract、terminal idle、
  process exit、window opened 都不证明真实执行能力或 Step success。
- 每次真实测量必须记录固定版本、平台、输入 hash、operation fingerprint、
  receipt、时间与脱敏结果。
- 尚未实际运行的 GitHub Actions 只能写 `PENDING`/`NOT_RUN`。
- 本计划不授权生产发布、签名、部署、真实远端写入或 Orca Fork。

## 3. Allowed scope

优先复用并仅在必要时修改：

- `packages/domain/**`
- `packages/application/**` / `packages/api-contracts/**`
- `packages/flow-engine/**`
- `packages/runtime-contracts/**`
- `packages/runtime-manager/**`
- `packages/provider-orca/**`
- `packages/storage/**`
- `packages/policy/**`
- `packages/knowledge/**` 的最小 Evidence/Archive 路径
- `packages/testkit/**`
- `apps/daemon/**`
- `apps/web/**` 的窄控制页
- `scripts/**` 中与本 gate 直接相关的最小脚本
- `docs/validation/**` 的新版本化证据

保持冻结：

- `apps/desktop/**` 的新产品能力；
- 自定义移动/PWA、Device Gateway、remote relay；
- Hunter-owned terminal、PTY、Diff、Browser、worktree IDE；
- deep direct Codex/CodeBuddy/Cursor Connector；
- 第二 Provider、额外 capability 层、完整 Flow/UI、团队/云能力；
- Orca private DB、GUI automation、whole/thin Fork。

如当前目录结构与上述名称不同，使用现有最小等价模块，不为目录整齐而迁移。

## 4. Safety invariants

1. Hunter 创建并校验 exact Git worktree 和 HEAD，持有 Workspace/Writer
   Lease；Orca 只能 attach/open 既存路径。
2. 所有 Provider mutation 使用结构化 argv、`shell: false`、operation id 和
   payload fingerprint。
3. 相同 operation id + fingerprint 返回原 receipt；相同 id + 不同 payload
   拒绝。
4. 不读取/写入 Orca private storage、token、cookie、完整环境或用户私有
   Prompt。
5. Hunter-owned Agent 运行使用 Manual/fail-closed。检测到
   `dangerously-bypass`、`yolo`、`auto-approve` 或等价参数即 `BLOCKED`。
6. worktree 解决 Git writer 隔离，不声称是 OS sandbox。
7. Agent/Orca-facing tools 只能读取 frozen handoff、报告 observation/
   artifact、请求 attention；不能 approve、mark success、运行/签发
   Verifier、修改 Policy。
8. Verifier definition、executable/config 和 expected oracle 位于 Agent
   不可写边界，或来自 Run 启动前固定 hash 的受信 CAS/commit；Verifier
   在 Agent session 外运行并绑定 Attempt、input/output/config hash。
   Agent 修改仓库内测试或 Verifier 输入时，不能靠自改测试绿灯，必须
   fail closed 或进入 Human Gate。
9. retry/recovery 创建新 Attempt，失败历史只追加不改写。
10. 每个临时 repo/worktree/branch/terminal/session/registration 都必须有
    结构化 cleanup receipt。

## 5. Evidence states

- `PASS`：本次固定版本和命令有可复现的本机证据，且 schema 校验通过。
- `FAIL`：已经运行且违反契约；保留原始错误和失败历史，停止当前 gate。
- `BLOCKED`：缺安装、登录、授权或公开接口能力，不能安全继续。
- `NOT_PROVEN`：时间盒到期或证据不足；绝不从官方宣传推断通过。
- `NOT_RUN`：命令、CI 或实机步骤尚未执行。
- `CONTRACT_ONLY`：Fake/fixture 只证明 Hunter 自身契约。

同一阻断最多三轮有新证据的修复尝试。每轮先读原始 stdout/stderr、
checkpoint、receipt/outbox 和 Git 状态；无新证据不得重复命令。

任何 Task 得到 `FAIL`、无法安全绕过的 `BLOCKED`，或到期
`NOT_PROVEN` 时，立即停止后续 Task 并执行统一 Closeout：

1. 停止新的外部 mutation，不重复失败 operation；
2. inventory 并只清理本次 receipt 证明为 Hunter-owned 的
   terminal/session/registration/worktree/branch；
3. 保留原始错误、失败 Attempt、checkpoint 与 receipt/outbox/provider
   effect 历史；
4. 运行 schema/hash/privacy/path/secret 检查，敏感原始数据不得提交；
5. 将后续 Task 标为 `NOT_RUN`，形成聚焦失败证据提交和准确最小后续动作；
6. 报告哪些资源已清理、哪些因安全原因保留，不继续扩大权限或范围。

## 6. Working method

每个 Task 使用 RED → GREEN → REFACTOR：

1. 先提交/保存能稳定复现缺口的最小测试或 probe；
2. 只实现让该测试通过的最小公共能力；
3. 运行精确测试，再运行受影响 workspace 门禁；
4. 公共契约变化同时更新 schema、类型、contract suite 和文档；
5. 每个提交只包含一个聚焦变更簇，使用中文提交信息；
6. 每个 Task 结束更新真实状态，不能把旧 FAIL 从历史中删除。

## 7. Task 0 — Freeze and inventory

**目的：** 确认源码、工具和证据起点，防止在测量中漂移。

**RED：**

- 若工作区有不相关修改、源码 digest 不稳定、Orca/Agent 版本未知或
  evidence schema 无法表达全部状态，停止。

**GREEN：**

- 在 Asia/Shanghai 记录 `timeboxStartedAt`、按明确工作日日历计算的
  `timeboxDeadlineAt`；截止后未完成只能是 `NOT_PROVEN`；
- 记录 source commit/digest、Node/Git/Windows、Orca 与所选 Agent 版本；
- 记录 install/login 为 detected/blocked，不读取 credential；
- 保存 public interface inventory 与当前 atomic capability receipts；
- 明确旧 Phase 0/Gate R 证据只读。
- 冻结 `RunBudget`：最多 2 个 Attempt、每 Attempt 最多 1 个真实 session、
  4 次 send、20 分钟，真实执行累计不超过 45 分钟；新增付费额度上限为
  0，除非 owner 另行批准明确数值。Provider 无法报告 token/cost 时仍由
  session/send/time hard stop 约束。

**验证：**

- evidence schema 精确测试；
- privacy/path/secret 扫描；
- `git diff --check` 与 allowed-path audit。

**提交：** `治理：冻结 Orca 纵向切片基线与证据口径`

## 8. Task 1 — Public Orca Adapter and permission gate

**目的：** 先证明安全、原子、可幂等的 public interface，不先做 UI。

**RED：**

- Adapter 对 duplicate/mismatched operation 处理错误；
- argv 中出现危险权限词仍启动；
- 需要 shell 拼接、private DB 或 GUI automation；
- probe 把 detected/status 写成 capability PASS。

**GREEN：**

- 固定版本 probe receipt；
- public operations 的 typed request/receipt 与 redaction；
- Manual/fail-closed configuration receipt；
- unknown schema/version fail closed；
- exact cleanup capability 单独测量。

若 public interface 无法 attach exact existing worktree 并完整 deregister，
本 gate 立即 `BLOCKED`，不进入 Task 2。

**提交：** `运行时：建立 Orca 公共适配与权限硬门`

## 9. Task 2 — Authenticated Hunter control surface in Orca

**目的：** 在不暴露长期 Secret 的情况下，从 Orca 打开最小 Hunter 页面。

**RED：**

- 未认证请求可写；
- credential/bootstrap 出现在 query、fragment、process argv/log、Browser
  history、Orca comment 或 Evidence；
- token 可重放、跨 Project/Run 使用或超过短时有效期；
- Host/Origin/CSRF 校验可绕过。

**GREEN：**

- random loopback port；
- Orca 打开的 URL 只含无授权能力的 launch identifier；
- 通过经证明的非 argv same-user rendezvous，或页面内一次性短码/明确用户
  确认，建立 Project/Run-scoped write session；
- `HttpOnly` / `SameSite=Strict` session 与 CSRF；
- Orca Browser tab 和普通本机浏览器回退都可用；
- 页面只展示 Requirement/Change、Attention、Run/Attempt、
  Verification/Evidence、Policy/Recovery。

**提交：** `界面：从 Orca 安全打开 Hunter 治理控制页`

## 10. Task 3 — Hunter worktree ownership and Orca attach

**目的：** 确保路径、HEAD、writer isolation 和 cleanup 由 Hunter 证明。

**RED：**

- Orca 自行选择/创建未知 worktree；
- symlink/path escape、错误 HEAD 或第二 Writer 能获得 Lease；
- attach 后无法把 Orca external ref 与 Hunter Lease 对账；
- cleanup 遗留 terminal/session/registration/worktree/branch。

**GREEN：**

- Hunter 在临时 no-remote Git fixture 创建 exact worktree；
- canonical path/HEAD/branch/lease receipt；
- Orca 只 attach/open 该既存路径；
- 重复 attach 幂等，payload mismatch 拒绝；
- cleanup 顺序和每一项 receipt 可验证。

**提交：** `工作区：由 Hunter 租赁并让 Orca 附加精确 worktree`

## 11. Task 4 — Narrow Agent-facing tools

**目的：** 给真实 Agent 足够上下文，不授予成功或策略权威。

允许的最小能力：

- `read_pinned_handoff`
- `register_artifact` / `report_observation`
- `request_attention`
- 可选只读 `read_run_projection`

**RED：**

- Agent 可 mark success、approve、alter policy、run/sign verifier；
- tool scope 可跨 Project/Run/Attempt；
- artifact path/hash 未校验或可泄露 Prompt/Secret。

**GREEN：**

- 短时、可撤销、Attempt-scoped capability；
- 默认只读，stdio/本机通道优先；
- every call 有 actor/correlation/idempotency receipt；
- adversarial contract tests 证明权限不可扩宽。

**提交：** `安全：收窄 Agent 可见的 Hunter 工具权限`

## 12. Task 5 — Real Agent execution and non-authoritative observations

**目的：** 真正修改一个可验证目标，同时证明返回/idle/exit 不会成功。

**RED：**

- 固定一个透明、确定性的两阶段 fault fixture：最终 OutputContract 同时
  要求条件 A+B；Attempt 1 handoff 明确标为 recovery exercise，只实现 A，
  因而固定 Verifier 必然报告缺 B；Attempt 2 根据该 Evidence 实现 B。
  Requirement 对这两阶段公开，不欺骗 Agent；
- Agent return、terminal idle、process exit、window state 任一信号能把 Step
  置为 success，测试必须失败；
- duplicate send 产生第二次外部 effect。

**GREEN：**

- Agent 在 exact worktree 修改真实文件；
- launch/send/observe/interrupt/reconcile receipt 完整；
- RuntimeObservation 只更新 execution/attention；
- Agent 返回后 VerificationStatus 仍为 pending；
- duplicate operation 不重复 effect。
- Attempt 1/2 使用同一个 Run 启动前冻结且 Agent 不可写的
  VerifierDefinition/config/oracle；只有目标文件变化能让 FAIL 转为 PASS。

**提交：** `执行：接通一个 Orca 承载的真实 Agent Attempt`

## 13. Task 6 — Independent failure and recovery

**目的：** 证明 Hunter 的核心差异化语义。

**RED：**

- Attempt 1 的独立 Verifier 必须真实 FAIL；
- 若失败历史被覆盖、Agent 能修改 receipt、重试复用错误 id/fingerprint 或
  自动绿灯，测试失败。

**GREEN：**

- immutable VerificationReceipt 绑定 Attempt 1 并保留失败 Evidence；
- bounded loop 创建 Attempt 2；
- Handoff 包含精确失败证据，不包含隐私内容；
- Attempt 2 修改后由同一冻结 verifier PASS；
- UI 同时显示两个 Attempt 与 authority 来源。

**提交：** `验证：保留失败历史并由独立收据完成恢复 Attempt`

## 14. Task 7 — Restart, reconcile, evidence, cleanup

**目的：** 在真实外部状态下证明恢复不重复副作用。

**隔离前置：**

- 优先使用 public interface 支持的 disposable、Hunter-owned Orca
  registration/runtime scope；
- 重启前 inventory 所有 repo/worktree/terminal/session，确认测试不会影响
  非 Hunter-owned external refs；
- 若无法隔离且存在用户无关活跃 session，Orca restart 子项为 `BLOCKED`，
  不得关闭或重启用户正在使用的 Orca；
- cleanup 只能操作由本次 receipt 创建/登记的 exact external refs。

**故障矩阵：**

- Hunter 在 operation intent 后、receipt 前重启；
- Orca 只在 Agent returned、独立 verify 开始前的固定边界重启一次；
- session present/missing/unknown；
- outbox pending/receipt written/provider effect already exists；
- worktree HEAD unchanged/externally changed。

**GREEN：**

- 所有 recovery branch 产生新 observation/receipt，不改写旧历史；
- operation、outbox、provider effect 三方对账；
- unknown 进入 `needs_attention`，不猜成功；
- 无 duplicate send/session/effect；
- terminal/session/registration/worktree/branch 全部清理；
- Evidence envelope schema、hash、privacy、reproducibility 检查通过。

**提交：** `恢复：对账 Orca 副作用并封存脱敏真实证据`

## 15. Task 8 — Ten-minute value Go/Stop

**目的：** 不只判断技术可行，也判断是否值得继续。

使用一个普通用户任务，从 Orca 打开 Hunter 到查看最终 Evidence 计时。
用户只需理解：

- 需求依据是什么；
- Agent 当前做了什么；
- 为什么 returned 仍未完成；
- 为什么 Attempt 1 失败；
- Attempt 2 依据什么通过；
- 现在是否需要用户处理。

### Go

- 十分钟内完成并能正确回答上述问题；
- 用户明确认为治理/验证/证据价值超过额外操作成本；
- 没有 private interface、危险权限、重复 effect 或残留资源；
- 全门禁和双平台 CI 实际通过。

### Stop

- 用户真正只需要 Orca 的 worktree/status/Diff/Browser/mobile；
- 五日仍无法完整贯通；
- 需要 Fork/private DB/GUI automation/bypass；
- Hunter UI 只是重复 Orca；
- 维护成本明显高于控制面价值。

**提交：** `决策：记录 Orca 纵向切片 Go Stop 结果`

## 16. Verification commands

每个变更簇运行精确测试；最终至少运行：

```text
npm install
npm run lint
npm run typecheck
npm test
npm run build
npm run verify:foundation
<exact Orca Adapter contract tests>
<exact browser authentication tests>
<exact workspace/lease/cleanup tests>
<exact real vertical-slice verifier test>
git diff --check
git status --short
```

真实 Doctor/Orca/Agent 命令必须从版本化脚本运行并输出脱敏 envelope，不在
本文硬编码 credential-bearing command。远端 CI 在实际完成前保持
`PENDING/NOT_RUN`。

## 17. Completion report

最终报告必须列出：

- 提交 SHA、修改文件与 PR/CI 状态；
- 每个命令的真实 PASS/FAIL/BLOCKED/NOT_PROVEN/NOT_RUN；
- Orca 与 Agent 的 fixed version、detected/login/capability 状态；
- Attempt 1/2、restart/reconcile、operation/outbox/provider effect、cleanup；
- Evidence 路径、schema/hash/privacy 检查；
- 用户十分钟验收与 Go/Stop；
- 尚未执行的 CI、平台、设备与 production gate；
- 明确声明未完成 Hunter Desktop/mobile、direct multi-Agent Provider、Fork
  或生产发布。

## 18. Branch hygiene

每个 PR 合并或任务被明确放弃后：

1. fetch/prune 并列出 local/remote branch、worktree、open PR；
2. 确认目标不是 current/main/protected/shared；
3. 确认 worktree clean，且 target branch 已包含全部提交；如有独有工作，
   必须保留，或先按 owner 决定建立可恢复引用；
4. 先移除 linked worktree，再删 local topic branch；
5. 仅删除已 merged/closed 且无其他使用者的 remote topic branch；
6. 在交付报告中列出已删除、保留及原因。
