# Herdr replacement control-plane Task 0 baseline

- 状态：`PASS`（仅 Task 0 freeze/read-only inventory）
- 整体 Herdr replacement gate：`NOT_PROVEN`
- 本机平台：Windows x64
- 时间盒开始：`2026-07-28T04:19:30.589Z`
- 时间盒截止：`2026-08-04T04:19:30.589Z`
- 当前 Evidence：
  [`evidence/herdr-control-plane/baseline.json`](evidence/herdr-control-plane/baseline.json)
- 当前 Evidence SHA-256：
  `25a9259828ce1fbcc6ab5e8408e9fa9e43e0d2264e9b1063df7c4e2cf1bb02af`

## Frozen release, asset, and source

官方 stable release `v0.7.5` 固定到 commit
`ef4c23f5775bb8cfec05f05d0844226ff959a07a`。该 stable release 没有
Windows asset，因此本次 Windows 本机清点使用官方 preview release
`preview-2026-07-21-0f10e1453a7f` 的精确资产；它固定到 commit
`0f10e1453a7f9fda357352bb65ce17fa26fda447`，相对 stable 仅多两个
docs-only commit。此处没有把 preview 宣称为 stable 或生产可用。

资产只保存在可恢复临时目录，没有全局安装、pipe-to-shell 或 PowerShell
execution-policy bypass。实际大小 `19,981,312` bytes，实际 SHA-256
`75c85763db0ca5fd13b485d0728cc3e9ea1152964a4e976e1d49f2e86b01a92b`，
与官方 release metadata 完全一致。

当前 Evidence 绑定生成器源码提交
`9d7b88bef48787db791d309bcd448e3c3b07d0c5`，源码摘要为
`3420e5a02913d2d7e35f13a9882e43fccc8512d9a6e4a76988c32ebbd6055949`。
Evidence 路径不属于 source pathspec，因此提交 Evidence 不会改变被冻结源码。

## Tool and public-interface inventory

| Tool | 安装/可执行 | 版本 | 登录 |
|---|---|---|---|
| Node.js | `DETECTED` | `24.14.0` | 不需要，`DETECTED` |
| Git | `DETECTED` | `2.50.1.windows.1` | 不需要，`DETECTED` |
| Herdr | `DETECTED` | `0.7.5-preview.2026-07-21-0f10e1453a7f` | 不需要，`DETECTED` |
| Codex | `DETECTED` | `0.144.6` | `DETECTED` |

版本化脚本严格串行执行 version、login status、root/worktree/workspace/
session/agent help 和 `api schema --json`。所有 11 个命令退出码均为 0。
Evidence 只保存安全逻辑 argv、状态和脱敏输出 hash，不保存可执行文件绝对路径、
原始 stdout/stderr、账号内容、token、cookie、完整环境或用户私有路径。

公开 schema 必须同时满足 protocol `17`、schema version `1`、严格顶层和五个
非空 schema，并匹配完整规范化 SHA-256
`7cb5b7086f5dd04adb8b7b2069042afd7214da87f6bca66e2b07ff8aa95f6f6f`。
help inventory 不只检查退出码，还必须包含 existing worktree open、state-only
workspace close、named session 与 Agent start/prompt/wait 等入口。

## Capability boundary

| Capability | 状态 | 本机证据边界 |
|---|---|---|
| asset integrity | `PASS` | 临时资产的 exact SHA-256 与 size 匹配 |
| Windows binary launch | `PASS` | Windows x64 本机返回固定版本 |
| fixed version | `PASS` | 精确 preview version/commit 匹配 |
| public schema | `PASS` | 完整规范化 schema hash 匹配 |
| public inventory | `PASS` | 所需只读 help 内容均存在 |
| existing-worktree attach | `NOT_PROVEN` | Task 1 尚未执行 mutation |
| resource cleanup | `NOT_PROVEN` | Task 1 尚未执行 state-only close |
| security defaults | `NOT_PROVEN` | 尚未启动真实 Agent |

Task 0 `PASS` 只证明固定二进制、资产、schema 和只读公开接口 inventory。
`DETECTED` 不能替代真实 capability receipt，整体 Provider 仍固定为
`NOT_PROVEN`。

## Preserved execution history

首次正式 execution 绑定源码提交
`dedaae65cfa7ce4df677f7cd9e814c0a8b77e7d2`。资产、版本、Windows 启动和
help inventory 均通过，但共享命令执行器的默认 64 KiB 捕获上限截断约
258 KiB 的公开 schema，因此准确得到 `public_schema=BLOCKED` 和
`task0Verdict=BLOCKED`。

修复没有放宽默认限制：只有 schema probe 显式请求 512 KiB，执行器仍以
1 MiB 为绝对上限。首次失败 Evidence 已按内容 SHA-256 归档到
`evidence/herdr-control-plane/baseline.attempts/`：

- `bc5d373655867df5c9de58d7a08e59fa31daf1fa7e3c43ed63a04c3120da2973.json`

第二次 execution 完整捕获并校验 schema 后得到 `PASS`。但是后续 replay
验证发现，该生成器用对象身份实现 release literal；文件写出后重新解析会失败，
因此该 `PASS` 不能作为最终 Evidence。它也已按内容 SHA-256 归档：

- `57c156862fa19bf196b2da018f0391d083aa273330e3a8169e32ffd5c35906e9.json`

第三次 execution 使用逐字段严格字面量 release schema；当前文件与两个归档
文件均已通过 JSON round-trip、完整 schema、content fingerprint 和脱敏断言。
失败历史没有被改写或删除。

## Budget and non-claims

- 真实 Agent Attempt：0 / 2；
- Herdr mutation/session/send：0；
- 新增付费：0 USD；
- cleanup：`NOT_REQUIRED`，因为本 Task 没有创建 Provider resource；
- Task 1–8：`NOT_RUN`；
- GitHub Actions：PR 尚未创建，Windows/Ubuntu CI 均为 `NOT_RUN`。

本记录不证明 existing-worktree attach、state-only cleanup、真实 Agent
mutation、Manual/fail-closed 权限、independent Verifier、restart/reconcile
或十分钟价值验收。Agent return、process exit、terminal idle 或 window state
仍不能表示 Step success。本批没有完成 Hunter Desktop/mobile、Pi/多
Provider、Herdr Fork 或生产发布。
