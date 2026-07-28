# Pi / Herdr public Adapter 有界替换门

- 日期：2026-07-28
- 触发原因：Orca v1.4.159 的公开接口不能同时完成 Hunter-owned exact
  existing worktree attach 与 non-destructive deregister，已触发
  ADR-0006 的 Stop 条件。
- 研究范围：只读官方仓库、官方文档、官方 Release 和公开协议；未安装、
  登录、调用模型、启动 session、修改 Provider 状态或产生费用。

## 口径

本文沿用 Hunter Evidence 状态：

- `PASS`：固定版本在 Hunter 本机真实运行且留下可复现收据；
- `BLOCKED`：公开接口或本机前置条件明确不能安全满足；
- `NOT_PROVEN`：只有官方声明、尚未本机运行，或证据不足。

因此下文即使确认“存在公开接口”，其 Hunter 本机状态仍是
`NOT_PROVEN`，不是 `PASS`。官方接口静态上不存在明显矛盾时写
“可进入 gate”；只有固定版本本机 probe 才能把原子能力提升为 `PASS`。

截至本次查阅，官方 GitHub `latest` 分别指向 Pi
[`v0.82.1`](https://github.com/earendil-works/pi/releases/tag/v0.82.1)
（2026-07-25，commit `b4f2936`）与 Herdr
[`v0.7.5`](https://github.com/ogulcancelik/herdr/releases/tag/v0.7.5)
（2026-07-21，commit `ef4c23f`）。版本号是上游发布事实，不是本机安装
或运行事实。

## 结论

**只进入 Herdr v0.7.5 的本机 Task 0/1 gate；不并行安装或验证 Pi。**

决定性原因不是 Herdr 功能更多，而是它当前公开接口直接覆盖了 Orca
失败的两个原子边界：

1. `herdr worktree open --path PATH` / `worktree.open` 可以按绝对路径打开
   existing checkout，并在已打开时返回 `already_open`；
2. `herdr workspace close` 只关闭 Herdr state；只有显式
   `worktree remove` 才执行 `git worktree remove`。因此 Hunter 可以保留
   worktree 和 branch，同时清掉 Herdr workspace registration。

这些语义由 Herdr 的
[CLI reference](https://herdr.dev/docs/cli-reference/#worktrees) 与
[Socket API](https://herdr.dev/docs/socket-api/#what-you-can-control) 明确
记录，静态上没有重现 Orca 的所有权冲突。它们仍必须在 Windows beta
本机 fixture 上验证为真实 receipt。

Pi 的 RPC/SDK 控制面更细，也能把 `cwd` 精确绑定到 Hunter worktree；
但 Pi 是 Agent harness，不是外部 workbench/session Host，而且官方明确
说明没有内建权限系统、默认继承启动进程的全部权限。用 Pi 进入真实切片
前，Hunter 必须先自建和证明工具 allowlist、路径边界、交互批准与进程
隔离，这会把本次“替换 Host 的最小 gate”扩大为新的 Agent Runtime
实现簇。Pi 保留为 Herdr 失败后的第二候选。

## 同口径对比

| Hunter 关心的边界 | Pi Agent Harness v0.82.1 | Herdr v0.7.5 |
|---|---|---|
| 产品角色 | 可嵌入 Agent runtime / coding CLI，不是 workbench fleet host。[Coding Agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md) | Agent-aware terminal/workspace/session Host，拥有 workspace、pane、PTY 和 Agent observation。[Concepts](https://herdr.dev/docs/concepts/) |
| Windows | 官方支持 Windows，但要求 Bash；依次查自定义 shell、Git Bash、PATH 上的 Bash。[Windows setup](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/windows.md) 本机：`NOT_PROVEN` | 原生 Windows 是 preview-only beta，使用 ConPTY；官方列出 startup cwd、Agent discovery、Git/worktree detection、plugins 等 beta/preview 项。[Windows beta](https://herdr.dev/docs/windows-beta/) 本机：`NOT_PROVEN` |
| exact existing path | SDK 的 `createAgentSession({ cwd })` 明确绑定调用方给定 cwd，所选 built-in tools 也按该 cwd 构造。[SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md#directories) 不存在“附加 Host workspace”的概念。本机：`NOT_PROVEN` | `worktree open --path PATH` 接收 existing checkout 的绝对路径；`worktree.open` 打开或返回 already-open workspace。[CLI](https://herdr.dev/docs/cli-reference/#worktrees) / [Socket](https://herdr.dev/docs/socket-api/#what-you-can-control) 本机：`NOT_PROVEN` |
| Provider 注册与无损注销 | Pi 进程直接在 cwd 运行，不要求 repo/worktree registration。持久 session 可指定 manager/directory，或 `--no-session`。是否完全无残留仍需本机证明：`NOT_PROVEN` | opening checkout 会创建 Herdr workspace registration；`workspace close` 只关闭 Herdr state，不删除 checkout/branch；`worktree remove` 才删 checkout，Hunter-owned gate 必须禁止后者。[CLI](https://herdr.dev/docs/cli-reference/#worktrees) 本机：`NOT_PROVEN` |
| 结构化 public control | `pi --mode rpc` 是 stdin/stdout strict JSONL；有 request id、response 与异步 event；TS 可直接用 `AgentSession` SDK。[RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md) | CLI 返回 JSON；raw API 是本机 NDJSON socket，Windows 使用 named pipe；安装的 binary 能导出覆盖 request/response/error/event 的 JSON Schema。[Socket API](https://herdr.dev/docs/socket-api/) |
| launch / send | 启动 RPC 子进程或 SDK session；`prompt` 接收消息并以 request id 关联响应。[RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md#prompting) | `agent start` 在 existing available pane 启动已支持 Agent，不改变 topology；`agent prompt` 原子提交文本和 Enter。[Agent automation](https://herdr.dev/docs/agent-automation/) |
| observe | 流式 Agent/turn/message/tool/retry/compaction events；`get_state`、`get_messages`、`get_entries`，entry id 可作跨重启 cursor。[RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md#get_entries) | `agent.get/list/read`、`session.snapshot`、event subscription、read-only terminal observe；snapshot 用于重连重建 cache。[Socket API](https://herdr.dev/docs/socket-api/) |
| interrupt | RPC 有语义 `abort` 与 `abort_bash`。[RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md#abort) 本机：`NOT_PROVEN` | 公共面提供 `agent send-keys`（如 `esc`、`ctrl+c`）和 pane/process close，但未发现 provider-neutral semantic abort receipt；本机应判 `NOT_PROVEN`，不能从按键发送推断已中断。 |
| resume / reconcile | `switch_session`、SDK `SessionManager.open/continueRecent`；`get_state` 与 append-only `get_entries(since)` 可重建投影。[SDK session management](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md#session-management) | detach/reattach 保留原进程；冷重启恢复 layout，只有 current official integration 上报的 native session ref 才恢复 Agent。API 提供 `session.snapshot`，断线后应重新 snapshot 再订阅。[Session restore](https://herdr.dev/docs/session-state/) 本机：`NOT_PROVEN` |
| cleanup | 终止 Hunter-owned RPC process；session 若持久化，只能清理 Hunter 明确创建的 session directory/file。公开文档未给通用“注销”命令，本机：`NOT_PROVEN` | `workspace close` 是无损 deregister；pane/workspace/session cleanup 有公开命令。只能清理本次 receipt 创建的 ID，严禁对 Hunter-owned checkout 调用 `worktree remove`。本机：`NOT_PROVEN` |
| 权限默认值 | 官方明确：无内建 filesystem/process/network/credential permission system，默认继承用户/进程权限。[仓库 Permissions](https://github.com/earendil-works/pi#permissions--containerization) 静态风险高。 | Herdr 是 terminal/PTY Host，不替底层 Agent 定义权限。`agent start` 会把 `--` 后参数原样传给 Agent。[Agent automation](https://herdr.dev/docs/agent-automation/#agent-identity-and-launch) Manual/fail-closed 本机：`NOT_PROVEN` |
| 可构建的 fail-closed 门 | SDK 可只启用显式 tools 或禁用全部/built-in tools；Extension `tool_call` 可 block，且 handler error 会 fail-safe 地 block tool。[SDK tools](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md#tools) / [Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#tool_call) 这仍是 Hunter 待实现能力，不是 Pi 默认 PASS。 | Hunter Adapter 可在启动前拒绝 `dangerously-bypass`、`yolo`、`auto-approve` 等 argv，并固定一个底层 Agent 的 Manual 配置；但 Herdr 文档没有声明自身提供 permission policy。未留下配置 receipt 前为 `NOT_PROVEN`。 |
| 私有状态边界 | RPC/SDK 和公开 session API 足够做控制与对账；Hunter 不应读取 `auth.json` 或任意 credential/env。官方 session JSONL 有公开格式，但本 gate 仍优先协议而非直接读文件。 | Hunter 只用 CLI/socket/schema 和 opaque external refs，不读 `session.json`、logs 或 private config。官方 integration 的 install/uninstall 是公开 mutation，可单独计 receipt；Adapter 不直接改 Agent 配置文件。 |
| session / worktree / terminal 所有权 | Hunter 拥有 exact worktree/Lease 和 RPC child process；Pi 拥有 Agent loop/session，默认不拥有 terminal fleet 或 Git checkout。 | Hunter 拥有 Git worktree/branch/Lease；Herdr 拥有 workspace/tab/pane/PTY/registration；native Agent 拥有 conversation session；Hunter只保存 opaque refs 和 observations。 |
| 安装 / 认证 / 费用 | MIT；npm/installer 安装。模型 Provider 需要 OAuth subscription 或 API key，可能按订阅、credits 或 token 计费。[Providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md) 本轮均未验证。 | Apache-2.0；Windows 只有 preview installer/binary。[Install](https://herdr.dev/docs/install/) 官方启动路径未要求 Herdr account；底层 Agent 的安装、登录和费用仍独立，均 `NOT_PROVEN`。 |

## 权限与成功权威

两者都不能改变 Hunter 的完成语义：

- Pi `agent_settled`、`agent_end`、RPC response success 只证明 loop/event
  状态；
- Herdr `idle` / `done` 是交互生命周期状态，官方还明确
  `unknown` 不表示成功；`agent prompt --wait` 不跟踪单个 turn；
- 进程退出、pane close、terminal idle、Agent return 都只能生成
  `RuntimeObservation`；
- 只有绑定 frozen Attempt/input/output/config hash 的独立
  `VerificationReceipt`，或绑定精确内容 hash/Actor 的 `HumanReceipt`，可以完成
  Step。

Herdr 的 local socket/named-pipe 文档没有给出可供 Hunter 依赖的认证或
ACL 保证。Task 1 必须在本机检查 named pipe 的 same-user access、named
session 隔离和 unknown protocol fail-closed；在此之前控制面安全是
`NOT_PROVEN`。

## 推荐的 Herdr Task 0/1 gate

只用临时、no-remote Git fixture 和独立 Herdr named session；固定
v0.7.5，不安装任何 Agent integration、不登录模型、不发送真实 prompt，
先验证 Host 原子接口。

### Task 0 — 只读 inventory

1. 检测 `herdr.exe`、固定版本、Windows build/channel；未安装且没有
   owner 对固定、可校验、临时目录下载的预授权时为 `BLOCKED`。当前 owner
   已预授权按推荐下载，因此可只下载官方 v0.7.5 资产到临时目录；不得使用
   pipe-to-shell、execution-policy bypass 或全局安装。
2. 只读导出 `herdr api schema --json`，验证协议版本、schema hash 和
   unknown-version fail-closed。
3. 记录 named-session/named-pipe 可用性与访问边界；不读取 Herdr private
   files、完整环境或日志。
4. 冻结 source commit/digest、操作预算、privacy/path/secret 规则。

### Task 1 — 最小、可回滚 public mutation

1. Hunter 创建 exact temporary Git worktree 并固定 canonical path、HEAD、
   branch 与 Lease。
2. 在隔离 named session 中执行一次 `worktree open --path <exact>`，核对
   returned workspace cwd/worktree provenance。
3. 重复同一 Hunter operation id + fingerprint 必须返回原 receipt；相同
   id + 不同 path 必须在 Adapter 内拒绝。Herdr request id 只做 correlation，
   不假定 Provider 自带幂等。
4. 验证 `agent start` argv gate：危险参数拒绝；未能形成一个明确的
   Manual/fail-closed 底层 Agent 配置 receipt 时保持 `NOT_PROVEN`，不启动
   Agent。
5. 仅调用 `workspace close` 清除 Herdr registration；确认 Git worktree、
   branch、HEAD 与文件仍存在且不变。绝不调用 `worktree remove`。
6. 关闭并删除只属于本次 gate 的 named session；复查
   workspace/tab/pane/registration/process 无残留，Git checkout 仍归 Hunter。

## 明确 Stop 条件

任一条件成立即 closeout 为 `BLOCKED` 或 `FAIL`，不进入真实 Agent Task：

1. v0.7.5 Windows binary/schema 不提供或不接受 exact absolute
   `worktree open --path`；
2. `workspace close` 删除/修改 checkout、branch 或 HEAD，或 registration
   不能完全消失；
3. cleanup 必须使用 `worktree remove --force`、private state、GUI
   automation 或非本次 receipt 所有的 external ref；
4. named pipe/session 不能隔离，未知协议/schema 不 fail closed，或重复
   operation 产生第二 workspace/pane/provider effect；
5. 底层 Agent 只能靠 bypass/yolo/auto-approve 启动，或无法形成
   Manual/fail-closed configuration receipt；
6. 需要全局/系统安装、登录、提供凭据、产生费用、扩大权限或影响用户
   现有 Herdr session 才能继续；已预授权的官方固定资产临时下载不计入；
7. Host observation 能伪造 Verifier/Human authority；
8. Windows beta 本机行为与官方公开契约不一致，且三轮有新证据的修复后
   仍不能安全闭环。

若 Herdr Task 0/1 命中 Stop，再评估 Pi；不得同时铺第二 Provider，也不得
为追求通过而放宽 Hunter-owned worktree、独立验证或 Manual/fail-closed
不变量。

## 非声明

- 没有声明 Pi 或 Herdr 已安装、已登录、已付费或在本机可用；
- 没有声明 Herdr Windows beta、named-pipe ACL、restart、resume、
  interrupt 或 cleanup 已通过 Hunter 验证；
- 没有声明 Pi Extension 等同于内建 sandbox/permission system；
- 没有选择生产 Provider，没有运行真实 Agent，没有发布或远端写入；
- 本文只推荐下一项有界 gate，不授权继续原 Orca Task 2–8。
