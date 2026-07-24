# Agent Orchestrator Runtime 备选评估

- 日期：2026-07-22
- 触发原因：Orca 在 Phase 0 时间盒结束时仍为 `NOT_PROVEN`
- 固定候选：官方 GitHub Release `v0.10.3`，tagged source 为 Apache-2.0
- 本机 Provider 判定：`NOT_PROVEN`
- 原始 envelope：[`evidence/agent-orchestrator/fallback.json`](evidence/agent-orchestrator/fallback.json)
- 上游研究：[`agent-orchestrator-upstream-research.md`](agent-orchestrator-upstream-research.md)

## 安装与启动观察

官方 Windows 安装器大小为 `92,067,256` bytes，实测 SHA-256 为
`6b1b328d37e2e66d2a9849fad065f1a004925208fda764e24a02b5c7563fe024`，与
GitHub Release API 一致。Windows Authenticode 检查为 `NotSigned`。第一次可见启动无
窗口、无 CPU 进展且未落盘，按精确 PID 终止；随后使用 NSIS `/S` 加显式当前用户安装
目录成功，未使用权限绕过或系统级安装。

安装目录内公开 CLI 存在，但未进入当前 PowerShell PATH。安装包固定为 `v0.10.3`，
`ao --version` 却返回 `ao version dev`，因此固定版本能力为 `FAIL`，不得用文件名替代
CLI version receipt。

公开 `ao start --json` 未识别已安装 app，重新下载约 87.8 MiB 后退出；隔离
`status --json` 仍为 `stopped`。直接启动同一安装目录的桌面 executable 后，隔离 daemon
才报告 `ready`。这是人工 preflight 观察，不伪装成 envelope 内的自动命令收据。

清理时，公开 `ao stop --json --timeout 10s` 返回 exit 1，并报告 daemon 未在时间盒内停止；
数秒后同一隔离 `status --json` 才报告 `stopped`。该延迟退出保留为失败历史，不计为 restart
或 shutdown PASS。随后只按已验证的桌面根 PID 终止其精确子进程树；运行数据与安装器下载
临时目录已删除，已安装 AO 主程序保留。

## Typed scenario 边界

- daemon state、run file 和端口全部限定在 `<AO_PHASE0_ROOT>`；未使用默认用户数据目录运行场景；
- repository mutation 只发生在 testkit 自动创建、验证且最终删除的临时 Git fixture；
- fixture 没有 remote，未执行 GitHub、PR、issue、push 或网络 tracker 操作；
- 未执行 `spawn`，未启动 Codex/Claude agent，未产生 agent 调用费用；
- 未使用 `--skip-agent-check`、`--yes`、auto、accept-edits、bypass 或类似参数；
- project 删除通过 stdin 输入精确 project id 完成人工授权语义，evidence 只记录
  `exact_project_id`，不保存实际 id；
- 未读取 SQLite、未调用未承诺稳定性的 HTTP/WS 私有接口。

## 自动收据

| 观察 | 结果 | 说明 |
| --- | --- | --- |
| `--version` | FAIL | exit 0，但报告 `dev`，无法与固定 release 绑定 |
| `status --json` + `doctor --json` | PASS | 隔离 daemon ready/healthy；doctor failures=0 |
| cached agent catalog | 历史观察 | 初次读取为 supported=23、installed=0、authorized=0 |
| catalog refresh | PASS（最终场景） | 初次人工 refresh 曾超时；最终 typed scenario 返回结构化 catalog，失败历史保留 |
| temporary project add/get | PASS | 无 remote Git fixture 注册并结构化读回 |
| session list | PASS（观察面） | JSON 可解析且 session 数为 0；不证明 session control |
| stale session get | PASS（失败语义） | 缺失 session 返回预期 `session not found`；超时、spawn error 或其他错误均 fail closed |
| root/session help | FAIL（terminal contract） | 无 raw terminal read/input/interrupt 公共 CLI |
| project remove/get-after-remove | PASS | remove 返回目标 id，随后 lookup 返回预期 `project not found` |
| cleanup audit | PASS（目标资源） | 目标 project 不再可读且临时 fixture 已删除；未采集最终全局 project/session 计数 |

## Capability 判定

| 能力 | 结果 | 原因 |
| --- | --- | --- |
| discover runtime | PASS | status ready 且 doctor ok |
| fixed version | FAIL | release CLI 报告 `dev` |
| project registration | PASS | 临时 project 注册并读回 |
| resource cleanup | PASS | 目标 project 精确删除且后续 lookup 为 `project not found` |
| agent readiness | NOT_PROVEN | 最终 catalog 未证明场景实际配置的 `codex` 同时 installed 与 authorized；原始身份清单不写入 evidence |
| workspace create/find | BLOCKED | 未证明配置 Agent readiness，未创建 session worktree |
| process/terminal launch | BLOCKED | 未证明配置 Agent readiness，禁止冒险 spawn |
| observe | BLOCKED | 没有经过 readiness 证明的 live session |
| interrupt | FAIL | 公开 CLI 缺少 raw terminal interrupt |
| restart/reconcile | NOT_PROVEN | 没有 native session identity 可对账 |
| workspace/session identity | NOT_PROVEN | 没有 native session identity receipt |
| daemon external contract | PASS | 受支持 CLI JSON 面返回结构化收据；不代表私有 API 稳定 |
| security defaults | NOT_PROVEN | listener/telemetry 默认值没有版本化本机 receipt |
| mobile pairing | NOT_PROVEN | 未启用或测试 LAN/mobile listener |

## 结论

AO 证明了 Windows 上的隔离 daemon、临时 project registration、结构化 CLI 读取和精确
cleanup。它没有证明固定 CLI 版本、配置的 `codex` Agent readiness、session/worktree 生命周期、
raw terminal 控制或 restart reconcile。`providerVerdict` 因此保持 `NOT_PROVEN`，Outcome 5 与
Gate A 不变。

本轮没有完成真实 Provider 集成、产品 UI、Electron 产品开发或生产发布。若要继续 session
验证，必须先由用户完成或确认配置 Agent 的安装/登录，再另行确认真实 agent 调用的配额/费用；
不得改用 `--skip-agent-check` 绕过。
