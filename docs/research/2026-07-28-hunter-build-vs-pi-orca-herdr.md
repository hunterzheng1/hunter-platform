# Hunter 是否应继续自研：Pi、Orca、Herdr 的复用边界

> 调研日期：2026-07-28
>
> 事实范围：项目官网、官方文档、官方 GitHub 仓库、许可证和 Release。
>
> 状态口径：官方声明不是 Hunter 本机验证；本机能力仍以
> `docs/validation/` 的固定版本 receipt 为准。
>
> 名称说明：本文的 Herdr 指 [`herdr.dev`](https://herdr.dev/) /
> [`ogulcancelik/herdr`](https://github.com/ogulcancelik/herdr)。

## 结论

1. 如果目标只是尽快日常并行使用 Coding Agent，完整自研 Hunter 没有
   经济性；直接使用 Orca 更成熟。
2. 如果目标是 Provider-neutral、可审计、可恢复、由独立验证决定成功的
   本地控制面，Pi、Orca、Herdr 都没有公开定义 Hunter 的全部治理语义。
3. Hunter 应保留薄而深的 control plane，停止重造 Agent loop、PTY、
   worktree IDE、Diff、Browser 和移动壳。
4. 当前优先用 Orca 作为外部日常 Workbench/Runtime Host；Pi 是以后需要
   嵌入 Agent loop 时的候选；Herdr 是终端/SSH/session Host 候选。
5. 不立即 Fork。先用公共接口完成一条真实纵向路径；五个工作日仍不能
   证明价值则停止扩建 Hunter。

## 产品所在层不同

| 产品 | 核心层 | 已成熟复用点 | 不天然负责 |
|---|---|---|---|
| Pi | 可嵌入 Agent harness / SDK / CLI | 多模型、Agent loop、tools、session、extensions | 多项目桌面、worktree fleet、Hunter Requirement/Run/Evidence |
| Orca | 多 CLI Agent 桌面 IDE / Runtime | worktree、PTY、Diff、Browser、SSH、移动、自动化 | 不可变 Requirement、Verifier-owned success、统一 receipt/evidence ledger |
| Herdr | Agent-aware terminal multiplexer | 持久 PTY、remote attach、Agent status、socket/plugin | 完整桌面 Workbench、产品领域状态、独立验证 |
| Hunter | governance control plane | Requirement/Workflow/Attempt/Verifier/Evidence/Policy/Recovery | 不应拥有通用 Agent loop、终端或 IDE 基础设施 |

直接问“谁最强”会混淆产品层。Orca 最接近日常成品；Pi 最适合嵌入；
Herdr 最接近 Agent-aware tmux；Hunter 只有保持治理边界才不是重复建设。

## Pi

官方资料显示：

- Pi 提供 interactive、print/JSON、RPC 与 SDK 模式，并明确支持嵌入应用。
- `pi-ai` 统一多模型 Provider；Extension 可注册工具、命令和事件。
- session 是本地 JSONL 树，公开 `SessionManager`。
- 核心刻意不内建权限系统，默认继承进程权限；Windows 通常需要 Bash。

判断：

- Pi 很适合成为以后一个 Hunter AgentRuntime Adapter。
- 使用 Pi 的 OpenAI 模型 Provider 不等于运行原生 Codex CLI。
- 以 Pi 为产品底座仍需自建 Workbench、worktree、durable workflow、
  Evidence、Verifier、Policy 与用户界面。

## Orca

官方资料显示：

- Orca 是 Windows/macOS/Linux 本地桌面 Agent IDE，每个任务可有独立
  worktree、Agent terminal 和 browser tab。
- 它提供 CLI、Skills/MCP、automation、Diff、SSH、移动 Companion 与
  session restore。
- 它能承载任意 CLI Agent，并有预配置产品列表。
- Orca 是 MIT 项目，更新频繁。

与 Hunter 的关键差距：

- Orca 的 finished/idle 适合通知与工作台状态，但不能等于 Hunter 的
  `VerificationStatus=passed`。
- worktree 是 Git writer 隔离，不是 OS sandbox。
- Orca 为部分 Agent 提供 bypass 类默认参数；可切 Manual，但 Hunter
  Adapter 必须 fail-closed，不能继承危险 preset。
- session/PTY restore 不等于 operation idempotency、durable outbox、
  receipt 与追加式 Attempt recovery。
- 公开资料未把不可变 Requirement、版本化 WorkflowRun、独立 Verifier、
  append-only failed Attempt 定义为 canonical domain。

判断：

- 若目标是现在日常使用，直接用 Orca。
- 若继续 Hunter，先做 public sidecar/Adapter，让 Orca 承担 UI/Runtime，
  Hunter 独立保存 canonical governance state。
- MIT 许可不等于 Fork 维护便宜；高频上游的跨平台合并、签名、发布和安全
  回归仍是持续成本。

## Herdr

官方资料显示：

- Herdr 是单一 Rust binary 的终端 Agent multiplexer，支持真实 terminal
  pane、detach/reattach、SSH、Agent status、CLI/socket 与 plugin。
- 支持 Pi、Codex、Claude Code、Cursor Agent CLI、OpenCode 等。
- session server 可恢复布局并利用 Agent 原生 session reference 续接。
- Windows native 支持仍标为 experimental beta，部分功能缺失。

判断：

- Herdr 是很好的 terminal/session/remote Adapter 候选。
- 它的 status/hook/screen 信号仍是 observation，不是独立验证。
- Windows-first 日常 Workbench 目标下，当前优先级低于 Orca。

## 同口径能力矩阵

| Hunter 所需能力 | Pi | Orca | Herdr | Hunter 是否仍需 |
|---|---|---|---|---|
| Agent loop / tools | 原生 | 通过 CLI Agent | 通过 terminal Agent | 不应重写 |
| Git worktree | 可扩展 | 原生 | 原生/API | 不应重写 |
| Desktop/Diff/Browser | 非核心 | 原生 | 非核心 | 优先复用 Orca |
| 持久 PTY/session | 非核心 | 原生 daemon | 核心 | 不应重写 |
| Mobile | 无 | Companion | SSH/mobile terminal | 当前不自研 |
| Embedded SDK | SDK/RPC 强 | public CLI/Skills/MCP | CLI/socket/plugin | 按 Adapter 需要选择 |
| Immutable Requirement/Change | 未见同等公开契约 | 未见同等公开契约 | 未见同等公开契约 | 是 |
| WorkflowRun/StepAttempt | 未见同等公开契约 | automation 不等同 | 未见同等公开契约 | 是 |
| Independent Verifier | 可扩展 | 可外接 | 可外接 | 是 |
| Idempotent operation receipt | 可扩展 | 未见统一契约 | 未见统一契约 | 是 |
| Append-only failure/recovery | session tree 非 workflow | session restore 非 attempt | pane restore 非 attempt | 是 |
| Fail-closed policy | 默认进程权限 | 部分 preset 有 bypass | 继承进程权限 | 是 |
| Windows-first daily UI | 需 Bash | 正式桌面 | experimental beta | Orca 最适合 |

“未见公开契约”不证明产品绝对没有能力，只表示 Hunter 不能在没有固定版本
本机证据时依赖或宣传它。

## Build / Buy / Base-on

### 目标是个人效率

停止等待完整 Hunter，直接用 Orca；偏终端可评估 Herdr；需要定制 Agent
loop 可评估 Pi。

### 目标是新的多 Agent IDE

优先在 Orca 生态中工作，而不是从零建设 Hunter Desktop。只有真实用户
证明统一品牌/导航决定价值，且公共扩展点确实无法解决，才评估薄 Fork。

### 目标是可审计本地 control plane

继续 Hunter，但只保留：

- immutable Requirement/Change/Workflow revision；
- Run/Step/Attempt、bounded loop、Policy/Lease；
- independent VerificationReceipt/HumanReceipt；
- operation fingerprint/outbox/receipt/reconcile；
- Evidence/Archive/Knowledge provenance。

Runtime/UI 通过 provider-neutral Adapter 委托给 Orca，未来可委托 Pi 或
Herdr。只有一个 Fake 实现时，replaceable seam 仍是假设；真实 Adapter
vertical slice 是下一步唯一进度指标。

## 止损试验

在扩大开发前只做：

1. approve/freeze 一条真实 Requirement；
2. Hunter 创建 exact isolated worktree；
3. Orca public Adapter attach 并启动一个真实 Agent；
4. Agent return/idle/exit 只记录 observation；
5. 独立 Verifier 故意 FAIL Attempt 1；
6. Attempt 2 recovery PASS，保留两次历史；
7. Hunter/Orca restart 后不重复副作用；
8. 生成脱敏 Evidence 并完整 cleanup；
9. 普通用户十分钟内完成并认为比直接 Orca 有实际价值。

### Go

- 不读上游私有数据库；
- 不使用 bypass/yolo/auto-approve；
- Provider 替换不丢 canonical history；
- 用户认可治理/证据价值；
- 维护成本可接受。

### Stop

- 实际需求只是 Orca 已有的并行 worktree/status/Diff/Browser/mobile；
- 必须大改 Orca 内部或解析 GUI；
- 五日仍无法受控写入、验证、恢复、清理；
- Hunter UI 只是复制 Orca；
- 用户不愿承担额外治理操作。

## 官方来源

### Pi

- [Official repository](https://github.com/earendil-works/pi)
- [Coding Agent README / SDK / RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)
- [Providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md)
- [Session format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md)
- [Containerization](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md)
- [Windows setup](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/windows.md)

### Orca

- [Official repository](https://github.com/stablyai/orca)
- [Product documentation](https://www.onorca.dev/docs)
- [Worktrees](https://www.onorca.dev/docs/model/worktrees)
- [Agents and status](https://www.onorca.dev/docs/model/agents-sessions)
- [Session restore](https://www.onorca.dev/docs/model/session-restore)
- [CLI overview](https://www.onorca.dev/docs/cli/overview)
- [Skills and MCP](https://www.onorca.dev/docs/cli/skills)
- [Supported agents and permission presets](https://www.onorca.dev/docs/agents/supported)
- [Privacy and telemetry](https://www.onorca.dev/docs/telemetry)

### Herdr

- [Official site](https://herdr.dev/)
- [Official repository](https://github.com/ogulcancelik/herdr)
- [Agents](https://herdr.dev/docs/agents/)
- [Socket API](https://herdr.dev/docs/socket-api/)
- [Session state](https://herdr.dev/docs/session-state/)
- [Windows beta](https://herdr.dev/docs/windows-beta/)
