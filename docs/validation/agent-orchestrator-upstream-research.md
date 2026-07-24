# Agent Orchestrator 上游能力研究

- 研究日期：2026-07-22
- 研究对象：AgentWrapper/agent-orchestrator 当前稳定桌面产品与公开 CLI
- 本地执行状态：未安装、未启动、未登录、未创建 workspace/session
- 证据性质：仅证明上游公开资料所声明或源码所暴露的能力，不构成 Hunter 本机 capability receipt

## 结论

**值得请求用户安装一次官方桌面版 `v0.10.3`，以继续一个严格有界的 Phase 0 typed scenario；不得改用 npm 包作为当前产品证据。**

理由是 `v0.10.3` 已公开 Windows x64 安装包、同版本 Apache-2.0 源码以及薄 `ao` CLI。CLI 能通过固定在 `127.0.0.1` 的 Go daemon 注册/删除 project、创建/查询/终止/恢复 session，并为主要读取命令提供 JSON。`AO_DATA_DIR` 可被隔离到临时 Git fixture，生产 wiring 会把 worktree 放到该目录的 `worktrees` 子目录，因此上游设计具备满足 Hunter 写入边界的可能性。

但安装不会预先证明 Gate A。当前公开 CLI 没有 raw terminal read/input/interrupt 命令；文档只描述浏览器使用的 terminal WebSocket 架构，没有把精确 wire schema 声明为稳定第三方契约。daemon 重启后的 session identity/reconcile、Windows ConPTY 实际行为、安装器是否把 `ao` 放入外部 PowerShell 的 PATH、无远端 fixture 的完整 cleanup 也都必须本机实测。任何缺失项只能是 `NOT_PROVEN` 或 `FAIL`。

## 已证实的上游事实

### 1. 稳定发行、安装包与许可证

- GitHub 将 `v0.10.3` 标为 Latest、非 prerelease，发布时间为 2026-07-12；截至本研究日期，后续可见构建均为 nightly/pre-release。[v0.10.3 release](https://github.com/AgentWrapper/agent-orchestrator/releases/tag/v0.10.3)
- Windows 稳定安装包为 [`Agent.Orchestrator.Setup.0.10.3.exe`](https://github.com/AgentWrapper/agent-orchestrator/releases/download/v0.10.3/Agent.Orchestrator.Setup.0.10.3.exe)，大小 `92,067,256` bytes，GitHub Release API 给出的摘要为 `sha256:6b1b328d37e2e66d2a9849fad065f1a004925208fda764e24a02b5c7563fe024`。[官方 Release API](https://api.github.com/repos/AgentWrapper/agent-orchestrator/releases/tags/v0.10.3)
- `v0.10.3` 源码的许可证是 Apache License 2.0。[tagged LICENSE](https://github.com/AgentWrapper/agent-orchestrator/blob/v0.10.3/LICENSE)
- 官方安装页把桌面下载列为新安装路径，并说明桌面 app 会启动 daemon；Git、一个 agent CLI 是必需项，GitHub 项目还需已认证的 `gh`，Node.js 20+ 只用于 legacy/source 安装。[Installation](https://aoagents.dev/docs/installation/)

### 2. npm 元数据存在上游不一致

2026-07-22 对官方 npm registry 进行了只读元数据查询，没有安装包：

- `@aoagents/ao` 的 `dist-tags.latest` 为 `0.10.3`，`nightly` 为 `0.10.4-nightly.202607211413`，CLI bin 为 `ao -> bin/ao.js`；包元数据的 license 为 `MIT`。[npm package](https://www.npmjs.com/package/@aoagents/ao) · [registry document](https://registry.npmjs.org/%40aoagents%2Fao)
- 与此同时，官方安装页和仓库 README 声称 `0.10.0` 是 npm 最终版本且该包已冻结，并要求新安装使用桌面发行。[Installation](https://aoagents.dev/docs/installation/) · [README](https://github.com/AgentWrapper/agent-orchestrator#install)

这两组第一方资料互相冲突，且 npm license 与 `v0.10.3` 源码的 Apache-2.0 也不一致。因此，npm 路径不能承担当前桌面产品的 Phase 0 版本/许可证证据；本轮候选只能固定 GitHub Release `v0.10.3` 及其 tagged source。

官方站点的部分 CLI/architecture 页面仍描述旧 Node/plugin 产品（例如 `ao dashboard`、旧 config 目录和旧 session 命令），而 `v0.10.3` tagged source 描述的是 Go daemon、`/api/v1` 和新的 project/session 命令。凡涉及精确命令、JSON flag、存储路径或 daemon 边界，本报告以同版本 tagged source 为准；站点内容只作为产品声明和安装导航，不能替代本机 `--help`/schema hash。

### 3. Windows 支持与前置条件

- 官方稳定 `v0.10.3` 提供 Windows x64 installer；官方平台页将 Windows 标记为 supported。[release](https://github.com/AgentWrapper/agent-orchestrator/releases/tag/v0.10.3) · [Platforms](https://aoagents.dev/docs/platforms/)
- Windows 使用 native ConPTY/process runtime；不需要 tmux，tmux attach 与 iTerm2 不适用。浏览器 dashboard terminal 是 Windows 的公开交互面。[Platforms](https://aoagents.dev/docs/platforms/) · [v0.10.3 architecture](https://github.com/AgentWrapper/agent-orchestrator/blob/v0.10.3/docs/architecture.md#terminal-multiplexing)
- Git 用于 worktree、branch、commit 和 cleanup。对纯本地、无远端临时 Git fixture，官方资料没有要求必须登录 `gh`；但要使用 GitHub issue/PR/CI 功能就必须安装并授权 `gh`。启动 worker 还需要一个已安装并可用的 agent CLI。[Installation](https://aoagents.dev/docs/installation/)

### 4. 当前 CLI 与 machine-readable 输出

`v0.10.3` 的公开命令名是 `ao`。它是 Go/Cobra 薄客户端，通过 `running.json` 握手和 loopback HTTP 调用 daemon，不应直接读 SQLite 或在进程内调用 runtime/workspace/agent adapter。[tagged CLI contract](https://github.com/AgentWrapper/agent-orchestrator/blob/v0.10.3/docs/cli/README.md)

公开命令覆盖：

- daemon：`ao start`、`ao stop`、`ao status`、`ao doctor`、`ao version`；
- project：`ao project add|ls|get|set-config|rm`；
- session：`ao spawn`、`ao session ls|get|kill|restore|rename|cleanup|claim-pr`；
- agent/session communication：`ao agent ls`、`ao send`。

主要 JSON 面：

| 命令 | 上游证据 |
| --- | --- |
| `ao status --json`、`ao doctor --json` | tagged CLI 文档明确列出 |
| `ao agent ls --json` / `--refresh` | tagged CLI 文档明确列出 raw inventory JSON |
| `ao project ls|get|set-config|rm --json` | `v0.10.3` CLI source 定义对应 `--json` flag |
| `ao session ls|get --json` | `v0.10.3` CLI source 定义对应 `--json` flag |
| `ao spawn`、`session kill|restore|cleanup` | 公开 CLI source 未定义 `--json` flag；必须随后用 `session ls|get --json` 形成观察收据 |

直接来源：[CLI contract](https://github.com/AgentWrapper/agent-orchestrator/blob/v0.10.3/docs/cli/README.md) · [`project.go`](https://github.com/AgentWrapper/agent-orchestrator/blob/v0.10.3/backend/internal/cli/project.go) · [`session.go`](https://github.com/AgentWrapper/agent-orchestrator/blob/v0.10.3/backend/internal/cli/session.go) · [`spawn.go`](https://github.com/AgentWrapper/agent-orchestrator/blob/v0.10.3/backend/internal/cli/spawn.go)

### 5. daemon 外部边界

- `ao` CLI 文档公开了它使用的 `/api/v1/projects`、`/api/v1/sessions`、`/api/v1/agents` 等 route 映射；当前受支持的第三方自动化入口应优先视为 CLI，而不是 Hunter 自行依赖 SQLite 或未版本化的内部状态。[tagged CLI contract](https://github.com/AgentWrapper/agent-orchestrator/blob/v0.10.3/docs/cli/README.md)
- daemon 主监听器固定绑定 `127.0.0.1:3001`，CLI 和桌面 app 共用。loopback listener 没有认证，但不对网络暴露；`v0.10.3` 架构将“daemon 只绑定 127.0.0.1”和“CLI 必须保持薄客户端”列为 load-bearing rules。[v0.10.3 architecture](https://github.com/AgentWrapper/agent-orchestrator/blob/v0.10.3/docs/architecture.md#multi-listener-architecture-loopback--lan)
- `AO_PORT`、`AO_RUN_FILE`、`AO_DATA_DIR`、`AO_REQUEST_TIMEOUT`、`AO_SHUTDOWN_TIMEOUT` 是公开的隔离/控制参数。手工 smoke 示例也把 run file 和 data dir 放进临时目录。[tagged CLI contract](https://github.com/AgentWrapper/agent-orchestrator/blob/v0.10.3/docs/cli/README.md#configuration)
- `v0.10.3` 的 REST/SSE/terminal WebSocket 是 daemon 架构的一部分，但公开文档没有承诺 HTTP/WS wire schema 的兼容期限。Hunter 不应绕过 CLI 读取 SQLite，也不应把浏览器内部协议当成已冻结 Provider contract。[v0.10.3 architecture](https://github.com/AgentWrapper/agent-orchestrator/blob/v0.10.3/docs/architecture.md#http-layer)

### 6. workspace、session、restart 与 cleanup

- `ao project add --path` 接收绝对本地 Git repo 路径，`project rm` 提供对应 deregistration；`spawn` 创建 session，允许指定 project、branch、prompt 和 agent harness。[`project.go`](https://github.com/AgentWrapper/agent-orchestrator/blob/v0.10.3/backend/internal/cli/project.go) · [`spawn.go`](https://github.com/AgentWrapper/agent-orchestrator/blob/v0.10.3/backend/internal/cli/spawn.go)
- production wiring 将 managed worktree root 固定为 `filepath.Join(AO_DATA_DIR, "worktrees")`。worktree adapter 会拒绝越出 managed root 的路径。[`lifecycle_wiring.go`](https://github.com/AgentWrapper/agent-orchestrator/blob/v0.10.3/backend/internal/daemon/lifecycle_wiring.go) · [`workspace.go`](https://github.com/AgentWrapper/agent-orchestrator/blob/v0.10.3/backend/internal/adapters/workspace/gitworktree/workspace.go)
- 普通 cleanup 遇到 dirty worktree 时会拒绝删除；架构把“never force-delete dirty worktrees”列为规则。spawn rollback 另有 force-destroy 路径，因此 typed scenario 必须同时记录正常 cleanup 与失败回滚的真实收据，不能只看命令 exit。[`workspace.go`](https://github.com/AgentWrapper/agent-orchestrator/blob/v0.10.3/backend/internal/adapters/workspace/gitworktree/workspace.go) · [architecture rules](https://github.com/AgentWrapper/agent-orchestrator/blob/v0.10.3/docs/architecture.md#load-bearing-rules)
- `ao session restore <id>` 是公开命令，目标是重新启动已终止 session；`ao start/stop/status` 提供 daemon 生命周期入口。[tagged CLI contract](https://github.com/AgentWrapper/agent-orchestrator/blob/v0.10.3/docs/cli/README.md)

### 7. terminal/session 控制的公开缺口

- Windows runtime 是 ConPTY，浏览器通过 daemon terminal WebSocket attach、接收 binary output 并发送 input。[v0.10.3 terminal architecture](https://github.com/AgentWrapper/agent-orchestrator/blob/v0.10.3/docs/architecture.md#terminal-multiplexing)
- `ao send` 是向 agent session 发送经过验证的消息，不等价于通用 terminal stdin；`ao session kill` 是 session 终止，不等价于可验证的 process interrupt。[tagged CLI contract](https://github.com/AgentWrapper/agent-orchestrator/blob/v0.10.3/docs/cli/README.md)
- 当前公开 CLI 命令表没有 raw terminal read、generic input、Ctrl-C/interrupt 或 terminal-idle receipt 命令。WebSocket 的精确 endpoint、帧 schema、版本兼容承诺也没有作为第三方 contract 发布。

因此，Phase 0 可通过 CLI 测 `spawn/send/status/kill/restore`，但不得把它们推断为 raw terminal `read/input/interrupt` 已通过；缺少受支持入口时应记录 `NOT_PROVEN` 或按既定计划记录 `FAIL`。

### 8. 安全默认值与远端写入风险

- loopback daemon 默认不对网络暴露。Connect Mobile 是显式 opt-in 的第二监听器，绑定 LAN、使用 bearer-password 和按来源锁定；流量仍是家庭网络内的明文 HTTP。typed scenario 应保持该功能关闭。[v0.10.3 architecture](https://github.com/AgentWrapper/agent-orchestrator/blob/v0.10.3/docs/architecture.md#multi-listener-architecture-loopback--lan)
- 同一份 architecture 后文又把“daemon 只绑定 `127.0.0.1`，永不网络暴露”列为 load-bearing rule，与前述 opt-in LAN listener 不完全一致。安全判定必须采用更保守解释：默认 loopback 可以作为待验证声明，任何 LAN/mobile 能力都保持关闭且不计为通过。[architecture rules](https://github.com/AgentWrapper/agent-orchestrator/blob/v0.10.3/docs/architecture.md#load-bearing-rules)
- 桌面 renderer 默认向 PostHog 发送匿名 usage events，并启用 session recording；发送前会脱敏绝对路径、本地 URL，并散列 project ID。官方文档说明只有构建时把 `VITE_AO_POSTHOG_KEY` 设为空才能禁用传输。[v0.10.3 telemetry](https://github.com/AgentWrapper/agent-orchestrator/blob/v0.10.3/docs/telemetry.md)
- worktree 默认隔离代码，但 agent 权限仍由所选 agent tool 决定。公开配置允许 `default`，也允许 `accept-edits`、`auto` 和 `bypass-permissions` 等扩大权限模式；本项目禁止使用后三类自动批准/绕过模式。[`project.go`](https://github.com/AgentWrapper/agent-orchestrator/blob/v0.10.3/backend/internal/cli/project.go)
- AO 的 worker 能编辑代码；当项目接入 GitHub 且 `gh` 已授权时，工作流能够创建 branch、push、PR 并读取 CI。默认 merge-ready 行为是通知而不是合并，但 CI failure、review comments 和 merge conflicts 的默认 reaction 会自动向 agent 发送恢复指令。[Installation](https://aoagents.dev/docs/installation/) · [Reactions](https://aoagents.dev/docs/configuration/reactions/)
- 对 Hunter typed scenario，应只注册自动创建、无 remote 的临时 Git fixture；设置独立 `AO_RUN_FILE`、`AO_DATA_DIR`、`AO_PORT`；显式使用 agent 的正常权限；禁用自动 recovery、notifier、mobile/LAN、tracker intake；不得使用 `--skip-agent-check`、`--yes`、auto/bypass permission 或任何真实远端操作。

## 推断（不是上游已验证事实）

1. `AO_DATA_DIR=<fixture>/ao-data` 加上 `project add --path <fixture>/repo`，理论上可把 daemon state 与 managed worktree 都限制在自动创建的临时根目录；必须在 Windows 实测所有 resolved path 和 cleanup 后残留。
2. `project/session ... --json` 足以构造 project registration、workspace identity、session identity、kill/restore 的 Hunter evidence envelope；对于无 JSON 的 mutation，可用前后两次 JSON read 做观察收据，但这不能单独证明 operation idempotency。
3. 安装 `v0.10.3` 可能让外部 PowerShell 获得 `ao`，但官方安装页只说桌面使用“不需要 CLI”；PATH 注册与 CLI 可执行位置必须在安装后探测，不能预设。
4. 由于 terminal WebSocket 不是清晰冻结的第三方协议，AO 可能最多证明 project/worktree/session control，而无法满足 Hunter 对 raw terminal atomic control 的全部 Gate A 条件。

## 仍未知、必须本机测量的项目

- Windows installer 是否安装并注册 `ao.exe`/launcher，以及 `ao --version` 是否精确返回 `0.10.3`；
- `ao status --json`、`doctor --json`、project/session JSON 的真实 schema、稳定字段和退出码；
- 无 remote 临时 Git fixture 是否能在不要求 `gh` 的情况下注册、spawn 与 cleanup；
- `AO_DATA_DIR`、`AO_RUN_FILE`、`AO_PORT` 在已安装桌面版下是否完整隔离第二个 daemon，是否干扰用户现有 AO 实例；
- Windows ConPTY 启动、输出观察、消息发送、终止和关闭收据；
- raw terminal read/input/interrupt 是否存在受支持且可版本化的公开入口；
- daemon stop/start 后同一 session ID、worktree、runtime handle 如何 reconcile，`session restore` 是否可重复；
- clean、dirty、spawn failure 三种 cleanup/rollback 后的 Git worktree、branch、AO project/session metadata 残留；
- 默认 agent permission 的实际启动参数，及不使用 auto/bypass 时是否会等待人工批准；
- 默认遥测在当前 binary 中的实际网络行为，以及是否有无需自编译的关闭选项。

## 建议的下一步边界

若用户同意安装，只请求其安装上述官方 `v0.10.3` Windows installer，不要求登录或提供任何凭据。安装后先执行只读 preflight：定位 `ao`、核对版本/摘要、运行 `status --json` 与 `doctor --json`、读取 `agent ls --refresh --json`。只有这些收据证明 CLI 与一个 agent 都可用，才创建自动临时 Git fixture，并显式使用独立 `AO_DATA_DIR`/`AO_RUN_FILE`/`AO_PORT` 进入 typed scenario。

一旦需要 agent 登录、发现只能调用未文档化 WebSocket/SQLite、无法限制 worktree 路径、需要自动批准/绕过权限、或会访问真实 remote，立即暂停并记录准确的 `BLOCKED`、`NOT_PROVEN` 或 `FAIL`。
