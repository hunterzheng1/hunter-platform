# Gate R-1 真实 Runtime / Connector 本机验证

- 日期：2026-07-26（Asia/Shanghai）
- 隔离分支：`codex/gate-r1-runtime-validation`
- 起始基线：`a901a9bd3120ea4f7b377401a939f5571682496f`
- 总体判定：`NOT_PROVEN`
- 证据范围：本机只读发现、临时无 remote Git fixture、原子 receipt 与
  receipt-derived manifest
- 公共 envelope：
  [`evidence/gate-r1/runtime-connectors.json`](evidence/gate-r1/runtime-connectors.json)
- 内容指纹：
  `6bba225fb463c68f806b7e048127114c02aa5c3d79bcc217324d0d9df9c50b1b`

## 执行元数据与原始结果

- 平台：Windows `10.0.26200` x64；Node.js `v24.14.0`
- 验证时源码 HEAD：`a901a9bd3120ea4f7b377401a939f5571682496f` 加本分支未提交
  Gate R diff；最终 commit/PR/CI 只能在提交后由外部 Git 状态报告。
- Orca preflight：`2026-07-26T14:47:48.107Z`；
  [`raw JSON`](evidence/orca/preflight.json)
- Doctor：`2026-07-26T14:52:35.201Z`；
  [`raw JSON`](environment-inventory.json)
- Codex direct：`2026-07-26T14:57:43.507Z`；
  [`raw JSON`](evidence/codex/direct-runtime.json)
- Orca launcher operator receipt：`2026-07-26T15:28:00.518Z`；
  [`raw JSON`](evidence/gate-r1/orca-open-attempt.json)
- 总 receipt/manifest：`2026-07-26T15:28:46.446Z`；
  [`raw JSON`](evidence/gate-r1/runtime-connectors.json)

本批源码与配置文件为 `scripts/gate-r-runtime-evidence.ts`、对应测试、
`spikes/testkit/src/evidence.*`、`spikes/orca/src/orca-client.*`、
`spikes/orca/src/scenario.*`、根 `package.json` 与 `tsconfig.e2e.json`；验证记录为
本文件、Phase 0/Phase 1 ledger、validation index、三个 canonical envelope 及
`evidence/gate-r1/` 下的 attempt ledger。

## 结论

Gate R-1 没有通过真实 Provider Gate A，也没有采用或 Fork Orca。Orca 当前只证明
`discover_runtime=PASS`；固定数值版本、fixture confinement、完整 repo registration
cleanup、terminal lifecycle、结构化 interrupt、restart/reconcile 和安全默认值仍为
`NOT_PROVEN`。

本轮把 Codex、CodeBuddy、Cursor 的本机事实转换为版本化
`CapabilityProbeReceipt`，再调用公共 `computeCapabilityManifest` 计算等级。三个结果均为
`NONE`，没有按产品名称硬编码 L0/L1/L2/L3：

| Connector | 本机事实 | receipt-derived level | 判定 |
| --- | --- | --- | --- |
| Codex | `0.144.6`、登录可用；真实 read-only create 超时，launch/send/interrupt 未证明 | `NONE` | `NOT_PROVEN` |
| CodeBuddy | 当前 shell 无可执行文件 | `NONE` | `BLOCKED` |
| Cursor | 外部 PowerShell 观察 `3.10.20`；Doctor 的 Node runner 对 `.cmd` 返回 `ENOENT`，未验证 login/workspace/handoff | `NONE` | `NOT_PROVEN` |

Cursor 的 PowerShell `version` / `help` 均退出 `0`，脱敏输出 SHA-256 分别为
`b263bead2799ea610f1b703ecfcd8246e9a4d7748de3174c2001dd6ff9a0dcaf` 和
`76971be25688ae2c1bdc1aa2338dc9c47f83a9f911d818fe4410a1056e7e494e`。
这只纠正“是否安装”的人工观察，不足以把 receipt 中的 protocol、login、workspace
targeting 或 handoff 升级为 supported，因此不改变 `NONE`。

## Orca Provider Gate A

当前 Orca `status --json` 报告 app running、runtime reachable、runtime state ready，
只读 preflight 指纹为
`98c55e25e03250cc47e5911275ae4c16920ddbe63c658211029247892940100c`。

真实迭代历史：

1. 初次状态未 ready，`discover_runtime=FAIL`，其余能力为 `NOT_PROVEN`；attempt 指纹
   `e17839cad29443e0a93a1e511f8832af9770e548e60368baa5b18b021efc1e31`；
2. 调用公开 `open --json` 后，Orca 实际进入 ready，但 launcher 超过 90 秒未返回；
   精确 launcher 被终止，Orca app 保持运行。window opened/runtime ready 不能被改写为
   lifecycle PASS 或 Hunter Step success；该 FAIL/timeout/cleanup receipt 的指纹为
   `b59bb1cfd1b5965e167c81109e4de3a05994b37a0570b8477f14df4e0291d144`；
3. ready 状态下重跑只读 preflight，`discover_runtime=PASS`；公开
   `worktree create` 仍没有创建前固定 checkout 到 Hunter 临时根目录的目标参数，
   `repo` 仍没有完整 deregistration/remove 路径。

因此没有执行 `repo add`、`worktree create`、terminal mutation、restart 或真实远端写入。
当前 Orca guide 虽提供 worktree 删除命令，但它不能替代 repo registration cleanup，也不能
补足创建前的 fixture confinement。

## Codex Connector 真实复测

`spike:codex` 只在自动创建、无 remote 的临时 Git fixture 中运行，并显式使用
`--sandbox read-only`。本轮最多三次真实模型调用；Prompt、账户输出、session identity、
绝对用户路径和 raw JSONL 均未写入证据。最终 fixture `git status` 为空并已删除。

本轮指纹为
`95f5144aff690b751ccc17619aca615f62856266bf6052e526ecfd1c934d5491`：

- `discover`、`workspace_targeting`、`observe`、`structured_events`、`resume` 为
  `PASS`；
- create 在 60 秒时间盒内超时，cleanup 为 `not_proven`；因此 `launch`、`send`、
  `completion_receipt`、`headless` 为 `NOT_PROVEN`；
- timeout cleanup 不是结构化 session interrupt receipt，`interrupt` 保持
  `NOT_PROVEN`；
- 未制造 permission event，未验证 artifact export；
- 复测结束后检查不到精确匹配的遗留 Codex CLI 进程，但这不能追溯改写原始 cleanup
  结果。

先前较完整的 Phase 0 attempt 指纹
`00094ae46c65670a9461c3e2acadcd1d769617ebeab2c591e0c5e62e97551a36`
仍保留在 `evidence/gate-r1/codex-direct.attempts/`。新失败/降级结果不会被旧 PASS 覆盖，
也不会把 Agent return、process exit 或 terminal event 解释为 Step success。

## Doctor 启动兼容性

Doctor 通过 `shell:false` 启动命令。本机 Windows App Execution Alias 的 Codex
在 Node 子进程中返回 `EPERM`，Cursor `.cmd` 返回 `ENOENT`；外部 PowerShell 的只读
版本命令均成功。Codex 随后由 spike 中经过测试的原生 executable resolver 验证；
Cursor 没有等价的受控 protocol/login/handoff receipt，因此只记录人工发现事实，不升级
manifest。

这段差异属于 probe launcher 兼容性，不能伪装为产品未安装，也不能反向推定 Connector
能力。

## RED → GREEN 与复现

- RED：当前 Orca `status` 的 `pid:null` / `runtimeId:null` 被隐私检查误拒；
- GREEN：允许缺失 runtime identifier 为 JSON `null`，真实标识仍必须脱敏；
- RED：当前 Orca detached status 缺少 `desktopWindowStatus`，schema 拒绝；
- GREEN：该观察字段改为 optional，ready 判定仍要求 running/reachable/state；
- RED：Gate R receipt 转换器不存在，精确 suite 失败；
- GREEN：5/5 Gate R converter tests 通过，三个等级完全由 atomic receipt 计算；
  Doctor/Orca source envelope 也会拒绝 content fingerprint 未重算的篡改。

复现顺序：

1. `npm run spike:doctor`
2. 设置调用者本地的 `ORCA_CLI_COMMAND` 后运行 `npm run spike:orca`
3. 明确允许真实只读 Codex 调用后运行 `npm run spike:codex`
4. `npm run verify:gate-r-runtime`

`spike:codex` 会产生真实模型服务调用；不得在未授权环境运行。`spike:orca` 当前仍是
只读 preflight，不能声称 Provider mutation 已验证。

## 后续 Gate

Gate R-1 的最小后续动作是等待 Orca 或另一候选提供可固定版本、可限制到调用者创建 fixture、
可完整清理 registration/worktree/terminal 并带结构化 restart/reconcile receipt 的公开面。
在此之前，真实 Provider、CodeBuddy ACP、Cursor handoff、真实设备、非玩具项目、
registry audit、代码签名、分发和生产发布均未完成。
