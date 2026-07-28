# Orca-first control-plane Task 0 baseline

- 状态：`PASS`（仅 Task 0 freeze/inventory）
- 整体 Orca-first gate：`NOT_PROVEN`
- 本机平台：Windows x64
- 时间盒开始：`2026-07-28T04:19:30.589Z`
  （Asia/Shanghai `2026-07-28 12:19:30.589+08:00`）
- 时间盒截止：`2026-08-04T04:19:30.589Z`
  （Asia/Shanghai `2026-08-04 12:19:30.589+08:00`）
- 当前 Evidence：
  [`evidence/orca-control-plane/baseline.json`](evidence/orca-control-plane/baseline.json)

## Frozen source and budget

当前 Evidence 绑定生成器源码提交
`7773c38e27d1f318f41d450bb439bf2ba4086b2d`，源码摘要为
`06af5f0d2fc2a306a337bd457ae9499eb24c2f858682113367746592f34ed49b`。
摘要使用 `sha256-path-content-v1`，Evidence 文件自身不属于 source
pathspec，因此提交 Evidence 不会改变被冻结源码。

真实执行预算固定为：

- 最多 2 个 Attempt；
- 每个 Attempt 最多 1 个真实 session、4 次 send、20 分钟；
- 真实执行累计最多 45 分钟；
- 新增付费额度为 0。

重试不会重置五工作日时间盒。Task 0 的三个真实 probe attempt 均沿用首次
`startedAt`。

## Tool inventory

| Tool | 安装/可执行 | 版本 | 登录 |
|---|---|---:|---|
| Node.js | `DETECTED` | `24.14.0` | 不需要，`DETECTED` |
| Git | `DETECTED` | `2.50.1.windows.1` | 不需要，`DETECTED` |
| Orca | `DETECTED` | `1.4.159` | `NOT_PROVEN` |
| Codex | `DETECTED` | `0.144.6` | `DETECTED` |

Orca 版本来自公开 `status --json` 的数值 `runtime.appVersion`。Codex 通过
系统发现的 PowerShell CLI script，以固定 `-NoLogo -NoProfile
-NonInteractive -File` 前缀、`shell: false` 运行；Evidence 不保存 script
绝对路径或登录输出。

## Public interface and capability boundary

本次只运行 version/login-status/status/help 等只读命令，
`mutationAttempted=false`。当前事实是：

- `discover_runtime=PASS`：公开状态报告 app running、runtime reachable 且
  state 为 ready；
- `fixed_version=PASS`：公开状态返回数值 Orca 版本；
- repo add、worktree create/remove、terminal create/list/send/read/wait/close
  仅为 `DETECTED`，表示 help inventory 中存在对应入口；
- `workspace_attach_existing=NOT_PROVEN`；
- `resource_cleanup=NOT_PROVEN`；
- `security_defaults=NOT_PROVEN`。

`DETECTED` 不等同于 capability `PASS`。Task 1 必须在自动创建、无远端的
临时 Git fixture 中分别测量 exact existing-worktree attach、完整
deregister/cleanup、幂等性和 Manual/fail-closed permission receipt。

## Preserved failure history

失败历史没有改写为成功：

1. schema v1 attempt 在同一时刻并行启动多个 CLI probe，Orca 命令超时，
   Codex 启动失败；原文件已按内容哈希归档。
2. schema v2 attempt 改为严格串行后，Orca 恢复 `DETECTED`，Codex 原生
   WindowsApps executable 仍因当前自动化身份无法启动而 `BLOCKED`；原文件
   已按内容哈希归档。
3. 当前 schema v2 attempt 使用已验证的 PowerShell script fallback；
   Orca 与 Codex 只读命令全部成功。

两个历史文件位于
`evidence/orca-control-plane/baseline.attempts/`。它们只保存脱敏状态、
退出结果和输出 hash，不保存 token、cookie、原始登录内容、完整环境或用户
私有路径。

## Non-claims

- Task 0 `PASS` 只证明基线冻结和只读 inventory 完成。
- 整体 Provider、existing-worktree attach、cleanup、真实 Agent mutation、
  independent verification、restart/reconcile 与十分钟价值验收仍为
  `NOT_PROVEN` 或 `NOT_RUN`。
- Agent return、terminal idle、process exit、window state 与 Orca status
  仍不能表示 Step success。
- 本记录不代表 Hunter Desktop/mobile、Orca Fork、第二 Provider 或生产发布。
- Task 0 分支的远端 CI 尚未运行，在 PR 实际完成前保持 `NOT_RUN`。
