# OpenClaw 作为 Hunter 成熟底座的采用评估

> **历史快照（已被取代）**：本文保留为 OpenClaw 候选评估证据，不定义当前
> Hunter Platform 架构。当前结论见
> [`2026-07-21-hunter-platform-landscape-and-reuse.md`](2026-07-21-hunter-platform-landscape-and-reuse.md)。

- 调研日期：2026-07-21
- 调研范围：OpenClaw Core、Gateway、Plugin SDK、ACP/ACPX、Codex 原生运行时、Windows/移动端、消息渠道、原生会话目录、安全和升级兼容性
- 来源原则：只引用 OpenClaw 官方仓库、官方文档和官方发布页
- 结论用途：供 Hunter Runtime / Workbench 新版架构决策使用，不构成对 OpenClaw 的安全审计或生产验收

## 1. 执行结论

OpenClaw 是目前最值得 Hunter **直接复用**的成熟底座，但不应成为 Hunter 的产品内核或唯一真相源。

推荐形态是：

> **Hunter 保留自己的 Workbench、治理 Kernel、项目/工作流/证据模型；把未经修改的 OpenClaw 作为可替换的 Runtime Provider，负责 Gateway、远程连接、移动端、消息渠道、设备配对、会话投影和多 Agent 进程编排。Hunter 管理发行版可固定并监管一个 OpenClaw 子进程，并按需安装一个很薄的 Hunter Bridge 插件。**

具体判断：

1. **不建议 fork OpenClaw。** 它虽然是 MIT，但源码规模、提交和发布节奏都非常快，fork 会把 Hunter 变成追赶上游的发行版维护项目。
2. **建议首版采用“受管子进程 + 公共 Gateway 协议”。** 这是 OpenClaw 官方明确支持的嵌入方式：宿主监管已安装的 `openclaw` 可执行文件，把子进程视作可替换运行时，并通过 WebSocket/RPC 操作，而不是读取其私有文件或数据库。
3. **长期架构按“未经修改的可选 Provider”设计。** 用户已有独立 OpenClaw 时，Hunter 应能直接连接；不希望安装 OpenClaw 时，Hunter 仍能通过其他 Provider 运行。受管子进程只是部署方式，不是领域模型依赖。
4. **Hunter Bridge 插件只补缺口，不成为唯一安全边界。** 插件可提供运行标签、会话扩展、UI 描述、事件订阅和工具前置策略，但 OpenClaw 插件运行在 Gateway 进程内；普通 hook 超时后，OpenClaw 会停止等待并继续主流程。Hunter 的强门禁、证据账本和安全隔离不能只依赖插件回调。
5. **Goose 不再是 Hunter 的主宿主。** Goose、Codex、Claude Code、Cursor、OpenCode、Pi 等应是可选择的 Agent Surface。OpenClaw 已提供 ACP/ACPX 多 Agent 通路，同时对 Codex 提供更深的原生 app-server 通路。

一句话产品边界：

> OpenClaw 负责“把 Agent 跑起来、接到手机和聊天软件、把会话带回来”；Hunter 负责“为什么跑、按什么流程跑、能不能继续、证据是否充分、怎样跨 Agent 交接”。

## 2. 为什么它已经接近 Hunter 原先要造的 Runtime 外壳

### 2.1 许可证允许采用和改造

OpenClaw 根仓库使用 MIT License，允许使用、复制、修改、合并、发布、分发、再许可和销售，但分发时需要保留版权与许可文本。仓库的第三方声明目前还列出了源自 Pi / pi-mono 的 MIT 代码。法律上可以 fork、嵌入或分发，但 Hunter 管理发行版仍应保留 `LICENSE` 与 `THIRD_PARTY_NOTICES.md`，并对实际打包依赖做独立 SBOM/许可证扫描。

来源：[OpenClaw LICENSE](https://github.com/openclaw/openclaw/blob/main/LICENSE)、[第三方声明](https://github.com/openclaw/openclaw/blob/main/THIRD_PARTY_NOTICES.md)

### 2.2 项目活跃且功能完整，但变化速度也是风险

截至调研日，官方仓库页面显示约 70,939 次提交、226 个 GitHub Releases，最新稳定版为 `2026.7.1`（2026-07-13）。仓库创建于 2025-11-24，说明其在较短时间内形成了非常大的功能面。官方同时维护 stable、beta、dev 和 extended-stable 更新通道。

这证明它不是停滞的原型，但不能把“热门、提交多”直接等同于“接口稳定”。相反，官方文档明确指出：

- Agent harness 插件契约仍为 experimental；
- Gateway operator/UI 客户端当前必须使用准确的当前协议版本，只有 Node 有 N-1 兼容窗口；
- Plugin SDK 存在持续废弃和移除计划；
- Gateway client npm 包处于随发行列车发布的初期阶段，文档甚至提示某些时点可能还未发布到 registry。

因此，Hunter 应固定经验证版本，禁止生产环境自动追 `latest`，并以契约测试决定升级，而不是直接跟随 OpenClaw 的发布节奏。

来源：[官方仓库](https://github.com/openclaw/openclaw)、[Releases](https://github.com/openclaw/openclaw/releases)、[更新机制](https://docs.openclaw.ai/install/updating)、[Gateway 客户端版本规则](https://docs.openclaw.ai/gateway/clients)、[Agent harness 插件](https://docs.openclaw.ai/plugins/sdk-agent-harness)

### 2.3 Gateway 已经是完整的本地控制平面

OpenClaw Gateway 是单一常驻进程和统一端口，承载 WebSocket 控制/RPC、HTTP API、插件 HTTP 路由、Control UI、渠道连接和 hooks。Gateway 协议提供：

- JSON WebSocket 请求、响应和事件；
- 连接握手、设备身份、token、角色和细粒度 operator scopes；
- `sessions.list`、`chat.history`、run 事件、任务、审批、节点、配置等控制面；
- 每个 run 独立的序列号和断线重连后的权威历史恢复；
- side-effect 方法的幂等键；
- 协议版本协商和结构化错误；
- 节点与客户端能力协商。

这正好覆盖 Hunter 原计划中成本很高、但产品差异化较低的部分：daemon、远程 transport、事件流、设备配对、会话列表、断线恢复、审批 UI 和多端同步。

来源：[Gateway runbook](https://docs.openclaw.ai/gateway)、[Gateway protocol](https://docs.openclaw.ai/gateway/protocol)、[Building a Gateway client](https://docs.openclaw.ai/gateway/clients)、[Architecture](https://docs.openclaw.ai/concepts/architecture)

### 2.4 官方支持“作为子进程嵌入”，而且边界很清楚

官方 Embedding 指南要求宿主：

- 监管通过正常包管理器安装的 `openclaw` 可执行文件；
- 指向真实 Node 运行时，尤其不要错误使用 Electron 自己的 `process.execPath`；
- 可用环境变量禁用 Bonjour、自动 respawn、shell snapshot 或渠道；
- 根据退出码区分配置错误，并使用 `doctor` 修复；
- 通过 RPC 操作会话、历史、用量、认证状态和配置；
- **不得**直接读取或修改 `~/.openclaw` 下的文件、SQLite、transcript 或 cache；
- **不得**只复制 `dist` 或把包拍扁到应用 bundle。

这为 Hunter 管理发行版提供了官方支持的集成路径，避免 fork 和私有存储耦合。

来源：[Embedding OpenClaw](https://docs.openclaw.ai/gateway/embedding)

## 3. 可直接复用的能力评估

### 3.1 ACP / ACPX 多 Agent 执行

官方 `@openclaw/acpx` 插件可把 OpenClaw 接到 Claude Code、Codex、Cursor、Copilot、OpenCode、Gemini CLI、Droid、Pi 等 ACP harness。它支持：

- 一次性或持久会话；
- 当前聊天或子线程绑定；
- start、status、steer、cancel、close；
- cwd、模型、thinking、permission profile、timeout 等能力协商；
- 后台任务和父任务通知；
- 使用 `resumeSessionId` 调用 ACP `session/load` 恢复上游会话；
- 明确区分 OpenClaw 会话 key 与上游 harness resume id。

这已经满足 Hunter “同一工作项可选择不同 Agent、可在移动端继续、可保留 Agent 自身运行时”的大部分基础需求。

但限制同样重要：

- ACP harness 在 Gateway 主机执行，**不被 OpenClaw sandbox 包裹**；
- OpenClaw 只负责路由、绑定、任务和部分策略，外部 harness 仍按自己的 CLI 权限读写文件；
- 非交互运行的 native permission prompt 可能不可用，写/执行型任务往往需要较宽的 ACPX permission profile；
- 模型、权限、resume 等能力只有目标 harness 实际声明时才可用；
- 部分适配器首次使用会通过 `npx`/`uvx` 下载，离线和供应链环境必须预热并锁定版本。

Hunter 因此应把 ACP 连接标记为“可控但默认未隔离”，不能把 ACP 当作安全沙箱。

来源：[ACP agents](https://docs.openclaw.ai/tools/acp-agents)、[ACPX plugin](https://docs.openclaw.ai/plugins/reference/acpx)

### 3.2 Codex 原生 app-server 通路

OpenClaw 对 Codex 不是只走 ACP。官方 `@openclaw/codex` 插件直接管理 Codex app-server：

- Codex 保留 native thread id、resume、compaction、code mode、原生工具和 app-server 事件；
- OpenClaw 保留渠道、会话镜像、动态工具、审批和媒体交付；
- 支持 stdio、Unix socket 和经过认证的 WebSocket app-server；
- 可选择 agent 隔离的 `CODEX_HOME`，也可显式使用 `homeScope: "user"` 与 Codex Desktop/CLI 分享 `$CODEX_HOME`；
- 对 app-server 版本范围做握手验证，拒绝过旧、过新未验证、预发布或无版本的 server；
- 对原生 Codex `PreToolUse`/`PostToolUse`/`PermissionRequest`/`Stop` 建立桥接，能阻止原生工具，但不能重写原生工具参数或任意修改 native transcript；
- 开启 OpenClaw sandbox 时，稳定默认会关闭某些 Codex 主机原生执行面，实验性的 sandbox exec-server 才能把执行送入 OpenClaw sandbox。

这说明 OpenClaw 确实能“保留 Codex 自身优势”，但也证明 Hunter 不应把所有 Agent 强行压成同一种最低公分母协议。新版 Hunter Adapter 应允许同一 Agent 产品有多个 Surface：Codex Desktop/CLI 原生会话、Codex app-server 深度受管、Codex ACP 兼容通路。

来源：[Codex harness](https://docs.openclaw.ai/plugins/codex-harness)、[Codex harness runtime](https://docs.openclaw.ai/plugins/codex-harness-runtime)、[Codex harness reference](https://docs.openclaw.ai/plugins/codex-harness-reference)

### 3.3 原生会话目录与恢复

OpenClaw 已经提供远超普通 ACP launcher 的 native session catalog：

- Codex：Gateway 本机和授权 Node 的非归档 thread，支持只读历史；本机存储/idle thread 可创建独立、模型锁定的 Chat 分支；远程节点目前受 streaming 生命周期限制，多为只读或终端 resume；
- Claude：发现 Claude CLI 和 Claude Desktop 会话；本机可导入有限历史并用 `--fork-session` 继续，保留源 transcript；某些 headless Node 可选择开启 continuation；
- OpenCode：通过官方 `opencode --pure db` 和 `--pure export` 读取只读目录；
- Pi：读取其公开 JSONL session 格式；
- 当匹配 CLI 可用时，OpenCode/Pi/Codex/Claude 可通过受限 PTY relay 在拥有会话的终端重新打开。

因此，Hunter 无需从零实现“跨电脑看到会话”的第一版。但必须区分：

- **catalog/view** 不等于结构化控制；
- **terminal resume** 不等于 Hunter 可验证的 managed run；
- **adopt/fork** 不等于接管源会话；
- native session 的活动状态有时对另一个进程不可知。

Hunter UI 应明确显示 `observed`、`terminal-resumable`、`adoptable`、`managed`、`guarded` 等能力等级，不能统一显示成“已受 Hunter 管理”。

来源：[Nodes：Codex/Claude/OpenCode/Pi sessions](https://docs.openclaw.ai/nodes)、[Codex supervision](https://docs.openclaw.ai/plugins/codex-supervision)、[OpenCode plugin](https://docs.openclaw.ai/plugins/reference/opencode)、[Anthropic plugin](https://docs.openclaw.ai/plugins/reference/anthropic)、[ACPX Pi catalog](https://docs.openclaw.ai/plugins/reference/acpx)

### 3.4 Windows、移动端和消息渠道

#### Windows

官方 Windows Hub 是签名的 WinUI 应用，支持 Windows 10 20H2+ / Windows 11、x64 / ARM64，包含：

- tray 与开机启动；
- app-owned WSL Gateway 一键设置；
- 本地、远程和 SSH tunnel Gateway；
- 原生 Chat 与浏览器 Control UI；
- sessions、usage、channels、nodes、pairing、repair diagnostics；
- Windows node mode；
- 给 Claude Desktop、Claude Code、Cursor 等本地客户端使用的 loopback MCP mode。

Gateway 也可以原生 Windows CLI/Scheduled Task 运行，但官方仍称 WSL2 为兼容性最好的 Windows Gateway 环境。对 Hunter 来说，这意味着无需首版重写 tray、daemon 安装和 WSL 引导；可以优先验证 Hunter Workbench 与 Windows Hub 并存或深链跳转。

来源：[Windows Hub / Windows](https://docs.openclaw.ai/platforms/windows)

#### iOS / Android

iOS 和 Android 都是 Gateway operator/client + node。官方移动端已提供会话列表、聊天、run 活动、断线恢复、节点能力；iOS 还有按 Gateway 隔离的离线 transcript cache 和最多 50 条离线 outbox，Android/Wear OS 可查看会话、发消息、终止 active run。远程连接推荐 Tailscale Serve 或其他 WSS/TLS 入口，设备通过签名身份和 scopes 配对。

这足以覆盖 Hunter 首版“手机查看状态、继续对话、发指令、终止运行”的大多数需要，避免一开始独立开发原生 App。Hunter Pocket PWA 仍可保留为专门的工作项/审批/证据 UI，但不必复制完整聊天和设备连接栈。

限制包括：iOS 背景连接受系统暂停；官方 App Store push 使用 OpenClaw 托管 relay，定制 relay 需要单独构建；移动端是 OpenClaw 产品表面，Hunter 专属工作项和证据需要插件 UI 或 Hunter 自己的 Pocket 页面。

来源：[iOS app](https://docs.openclaw.ai/platforms/ios)、[Android app](https://docs.openclaw.ai/platforms/android)、[Gateway protocol](https://docs.openclaw.ai/gateway/protocol)

#### 飞书与 Telegram

官方 Feishu 插件声明 bot DM 和群聊 production-ready，默认使用 WebSocket，无需公网 webhook；支持 streaming card、文档/Wiki/Drive/Bitable 工具，并对关键消息做 restart-safe durable queue 与 event-id 去重。官方 Telegram 渠道同样声明 DM/群聊 production-ready，默认 long polling，支持 pairing、allowlist、群组策略和 Dashboard Mini App。

因此 Hunter 不应重新实现 `lark-coding-agent-bridge` 已覆盖或 OpenClaw 已覆盖的通用 bot transport。更合理的是：

- OpenClaw 负责连接、身份、消息耐久性、卡片/按钮和 channel thread；
- Hunter 负责把“创建工作项、选择 Agent、查看 Gate、批准/拒绝、查看证据”注册成命令、审批和 UI surface；
- `lark-coding-agent-bridge` 可保留为不部署 OpenClaw 时的轻量 Provider，或作为行为/兼容性测试样本，而不是第二套默认飞书栈。

来源：[Feishu](https://docs.openclaw.ai/channels/feishu)、[Telegram](https://docs.openclaw.ai/channels/telegram)、[Channels](https://docs.openclaw.ai/channels)

### 3.5 Plugin SDK 能覆盖 Hunter Bridge 的大部分需求

Plugin SDK 当前公开能力包括：

- 注册 HTTP route、Gateway RPC、CLI、后台 service；
- session extension，把插件状态投影进 Gateway session；
- exactly-once next-turn injection；
- agent event subscription 和 run-local context；
- session/run/settings/tab 等 Control UI descriptor；
- session action 与命令；
- `before_agent_run`、`before_tool_call`、`before_agent_finalize`、session lifecycle 等 hooks；
- manifest 声明并显式启用的 trusted tool policy；
- external session catalog；
- experimental native agent harness。

这意味着一个薄的 `@hunter/openclaw-bridge` 可以实现：

- 把 `HunterWorkItemId / RunId / GateState` 投影到 OpenClaw session；
- 在 Control UI 显示“由 Hunter 管理”的 badge、状态和深链；
- 将 OpenClaw run/工具/审批事件规范化后送入 Hunter evidence intake；
- 在开始 run 前验证 admission token；
- 对 Hunter 管理 run 安装工具 policy、审批和 finalize gate；
- 提供 `/hunter status`、`/hunter approve` 等渠道命令。

但不建议首版使用 experimental Agent Harness SDK 自己重写整个运行器。Hunter 应优先使用 Gateway RPC、官方 ACPX 和官方 Codex harness，把插件限制在工作流与治理补充层。

来源：[Plugin SDK overview](https://docs.openclaw.ai/plugins/sdk-overview)、[Plugin hooks](https://docs.openclaw.ai/plugins/hooks)、[Plugin entry points](https://docs.openclaw.ai/plugins/sdk-entrypoints)、[Agent harness plugins](https://docs.openclaw.ai/plugins/sdk-agent-harness)、[Plugin HTTP architecture](https://docs.openclaw.ai/plugins/architecture-internals)

## 4. 安全边界：可以借，但不能误判

### 4.1 OpenClaw 明确是单信任域，不是敌对多租户平台

官方安全模型假设一个 Gateway 对应一个可信 operator 边界。共享一个 Gateway 的 authenticated operator 是控制面可信角色，`sessionKey` 只是路由选择器而不是授权 token。多名互不信任用户需要拆分 Gateway，最好同时拆 OS user 或 host。

这和 Hunter 当前个人开发工作台的目标相容，但 Hunter 若未来支持团队/组织，不应在单 Gateway 上追加一层“租户 id”就声称隔离；应使用每用户/每信任域独立 Gateway cell。

来源：[Gateway Security](https://docs.openclaw.ai/gateway/security)、[SECURITY.md](https://github.com/openclaw/openclaw/blob/main/SECURITY.md)

### 4.2 默认姿态偏向个人助理便利性

官方 README 明确：main session 的工具默认可直接在 host 运行；受信任单 operator 的 exec 默认可为 `security="full"`, `ask="off"`。sandbox 是可选的，通常由 Docker、SSH 或 OpenShell 提供。安全审计可检查开放 DM、工具爆炸半径、网络暴露、插件 allowlist、文件权限和 sandbox drift。

Hunter 管理发行版必须提供自己的 hardened profile，而不是沿用默认个人助理配置：

- Gateway 默认 loopback；远程只走 Tailscale/WSS；
- 一人一 Gateway；
- 渠道默认 pairing/allowlist；
- 插件显式 allowlist；
- Hunter managed run 默认 workspace-scoped；
- 高风险命令要求审批或隔离；
- 每次配置/版本变化后运行 `security audit --deep` 与 `doctor --lint`。

来源：[Gateway Security](https://docs.openclaw.ai/gateway/security)、[Sandboxing](https://docs.openclaw.ai/gateway/sandboxing)、[Sandbox CLI](https://docs.openclaw.ai/sandbox)

### 4.3 ACP 不受 OpenClaw sandbox 包裹

这是采用决策中最重要的限制之一。官方 ACP 文档明确：外部 harness 当前在 host runtime 执行，OpenClaw sandbox 不包住它；sandboxed requester 甚至不能 spawn ACP。目标 harness 按自己的 cwd 和 CLI 权限读写。

Hunter 必须把这类 session 的隔离能力显示为目标 harness 自己声明和实测的结果。需要强隔离时，可选方案是：

- 把整个 OpenClaw Runtime Provider 放进受控 VM/容器/专用 OS 用户；
- 让外部 Agent 在专用远程节点/worktree 上运行；
- 使用支持自身 sandbox 的 native deep adapter；
- 或放弃 ACP，使用 Hunter 能独立证明隔离边界的 Provider。

来源：[ACP agents：Sandbox compatibility](https://docs.openclaw.ai/tools/acp-agents)

### 4.4 普通插件 hook 不是不可绕过的信任根

普通决策 hook 有时间预算；超时后 OpenClaw 停止等待并继续，未完成的插件异步工作仍可能继续。插件也与 Gateway 同进程运行，应被视为完全可信代码。`before_tool_call` 可以阻止调用或请求批准，Codex native PreToolUse 也能被桥接，但工具参数重写和 native transcript 修改有明确限制。

因此：

- 普通 hook 可用于 UX、审计、软策略和批准流程；
- manifest-gated trusted tool policy 可用于更高信任的 host policy，但仍是 OpenClaw 进程内组件；
- Hunter 强 Gate 应在 `start/resume` admission 时由 Hunter Kernel 独立作出，并通过短期签名 admission token 交给 Provider；
- 如果必须做逐工具硬拦截，Provider capability 必须先通过故障注入验证；插件未加载、版本不匹配或健康证明失败时，Hunter 必须把运行降级为 `unmanaged/observed` 或拒绝启动；
- 安全隔离仍依赖 OS/container/VM，不依赖模型 prompt 或 session 标签。

来源：[Plugin hooks](https://docs.openclaw.ai/plugins/hooks)、[Plugin permission requests](https://docs.openclaw.ai/plugins/plugin-permission-requests)、[Plugin security](https://docs.openclaw.ai/gateway/security#plugins)、[Codex harness runtime](https://docs.openclaw.ai/plugins/codex-harness-runtime)

## 5. 三种采用方式比较

| 方式 | 优点 | 主要代价/风险 | 结论 |
|---|---|---|---|
| Fork OpenClaw | 可改所有 UI、Gateway、协议和运行时；可做完全 Hunter 品牌发行 | 上游约八个月已有 226 个 release、7 万级 commit；安全修复、渠道、移动端和协议升级都需要长期手工合并；容易让 Hunter 的核心价值被上游维护吞没 | **不采用**。除非未来 OpenClaw 停止维护且 Hunter 已有专职发行团队 |
| Embedded child（固定版本的受管子进程） | 官方支持；Hunter 可做一键安装、启动、健康检查、升级回滚；通过公开 WS/RPC 解耦；适合 Windows 管理发行版 | Hunter 要承担 Node/OpenClaw 包安装、进程监管、状态目录和版本矩阵；若同时装 Bridge 插件，仍需跟踪 SDK | **首版部署推荐**。作为本机默认 Provider，而非 Hunter 内核 |
| Unmodified optional provider / plugin（连接已有 OpenClaw） | 耦合最低；OpenClaw 可独立升级/替换；用户能继续使用官方 Hub/App/渠道；Hunter 不复制 Gateway | 安装体验不如一体化；不同 OpenClaw 版本/配置导致 capability 差异；无 Hunter Bridge 时只能实现公共 RPC 可见的能力 | **长期架构推荐**。与 embedded child 使用同一个 Provider 接口；Bridge 是可选增强 |

最终推荐不是在后二者中二选一，而是：

> **架构上使用“未修改的可选 Provider”；Hunter 管理发行版默认用“固定版本 embedded child”来交付这个 Provider。**

这样既有开箱即用体验，又不会把领域模型绑在 OpenClaw 上。用户也可以把 Provider 配置切到自己现有的 Gateway。

## 6. Hunter 应复用、保留和明确不依赖的边界

### 6.1 直接复用 OpenClaw

- Gateway 进程、WS/RPC、认证、设备 pairing、scopes、重连协议；
- Windows Hub、iOS/Android、WebChat/Control UI；
- Feishu、Telegram 及其他 channel transport；
- Node pairing、远程节点和有限 PTY relay；
- ACP/ACPX Agent 启动、绑定、steer/cancel/close/resume；
- 官方 Codex app-server 深度 adapter；
- Codex、Claude、OpenCode、Pi native session catalog；
- 现成 approval/question UI 与消息渠道回传；
- `doctor`、security audit、日志、健康探针、更新与回滚基础设施。

### 6.2 Hunter 自己保留为唯一真相源

- Project、WorkItem、Run、Attempt/Engagement 的身份和生命周期；
- workflow 定义、Gate 状态机和每个 Gate 的通过依据；
- skills/workflows/rules 的 canonical registry 与多 Agent 投影；
- Agent Product / Installation / Surface / CapabilityManifest；
- Handoff Package 与跨 Agent 上下文摘要；
- append-only evidence ledger、artifact hash、测试/审查结果和 provenance；
- policy 决策、风险分级、预算和谁批准了什么；
- Provider 独立的设备/项目绑定；
- 对 OpenClaw session key、ACP resume id、Codex thread id 等外部标识的映射。

OpenClaw transcript 可以是展示和恢复来源，但不是 Hunter 的证据账本；OpenClaw session 也不是 Hunter Run。

### 6.3 Hunter 不应依赖

- `~/.openclaw` 的文件、SQLite 表、transcript 路径和 cache 布局；
- Gateway 未公开的内部 TypeScript 模块；
- experimental Agent Harness SDK 作为 Hunter 的唯一 adapter API；
- 普通 hook 的顺序、副作用完成时间或超时行为作为强安全保证；
- `sessionKey` 作为授权凭据；
- ACP 的 permission profile 作为 OS sandbox 证明；
- 自动升级到 `latest`；
- OpenClaw 内置 session/task 模型能完整表达 Hunter WorkItem/Run/Gate；
- 对 native transcript 做任意改写；
- 所有 Agent 都能达到 Codex app-server 相同的控制深度；
- 官方移动 App 一定能呈现 Hunter 专属业务 UI。

## 7. 推荐的新版组合架构

```text
Hunter Workbench / Hunter Pocket
        |
        | Hunter Control API（WorkItem / Run / Gate / Evidence）
        v
Hunter Governance Kernel  <---->  Hunter Canonical Store
        |
        | RuntimeProvider SPI + capability attestation
        v
Hunter OpenClaw Provider
  |- 外部模式：连接用户已有 Gateway
  `- 受管模式：监管固定版本 OpenClaw child
        |
        | 公共 Gateway WS/RPC
        v
Unmodified OpenClaw Gateway
  |- official Codex native app-server plugin
  |- official ACPX -> Claude/Cursor/OpenCode/Pi/...
  |- Feishu / Telegram / Web / mobile apps
  |- Windows / headless nodes
  `- optional @hunter/openclaw-bridge plugin

Native Agent Apps（Codex Desktop / Cursor / Claude Code / ...）
  `- 继续独立使用；Hunter/OpenClaw 通过 catalog、resume、adopt 或 handoff 连接
```

### 7.1 Hunter OpenClaw Provider 的最小公共接口

建议 Provider 只依赖公开协议，至少实现：

- `probe()`：Gateway/version/protocol/plugin/channel/node/Agent surface 能力；
- `start()`：创建或绑定 OpenClaw/ACP/native session；
- `observe()`：订阅 sessions/messages/run/task/approval 事件；
- `control()`：send/steer/cancel/close/resume；
- `catalog()`：读取可见 native sessions；
- `link()`：保存 Hunter Run 与外部 session/native id 映射；
- `health()`：Gateway、Agent backend、Bridge plugin 和安全 profile 证明；
- `shutdown()`：只在 managed 模式监管子进程。

每个返回结果都必须携带 capabilities，而不能以 Agent 名称猜功能。

### 7.2 建议的能力等级

| 等级 | 含义 | 例子 |
|---|---|---|
| `observed` | 只能发现/读取会话或状态 | 远程 OpenCode/Pi catalog |
| `resumable` | 可在原生终端或 Agent 中继续，但 Hunter 不控制逐步执行 | terminal resume |
| `controlled` | 可 send/steer/cancel/close，能收到结构化事件 | ACP session |
| `guarded` | Hunter admission 和工具/finalize gate 已实测有效 | 固定 OpenClaw + 健康 Bridge + 支持 hook relay 的 Codex |
| `isolated` | 除 guarded 外，还有经实测的 OS/container/VM 边界 | 专用 VM/容器/OS user Provider |

Hunter UI 必须显示实际等级。一个 native app 中由用户直接开启的会话通常只能是 `observed` 或 `resumable`，不能冒充 `guarded`。

## 8. 升级与兼容策略

### 8.1 固定版本与升级列车

Hunter 管理发行版应：

1. 固定 OpenClaw core、官方 plugins、ACPX 和 Hunter Bridge 的精确版本；
2. 默认关闭 OpenClaw auto-update；
3. 提供 `current` 与 `previous-known-good` 两套版本元数据；
4. 先在 compatibility lane 运行契约测试，再切换用户 Runtime；
5. 升级 Gateway 后再升级 nodes；
6. 每次升级执行 `doctor --lint --json`、`security audit --deep --json`、Gateway/Bridge smoke tests；
7. 对协议大版本变更同时升级 Hunter Gateway client；
8. 不自动迁移或修改用户自有 OpenClaw 安装；外部模式只提示支持矩阵。

### 8.2 只依赖发布契约

优先依赖：

- Gateway WS/RPC 与已发布 schema/client；
- Plugin SDK 明确列出的 subpath；
- 官方 ACPX/Codex/Anthropic/OpenCode plugin；
- OpenClaw CLI 的 JSON 输出；
- 官方 embedding 生命周期和退出码。

不要依赖：源代码内部 import、state 文件、数据库 schema、Control UI DOM 或 human-readable log 文本。

来源：[Embedding OpenClaw](https://docs.openclaw.ai/gateway/embedding)、[Gateway protocol](https://docs.openclaw.ai/gateway/protocol)、[Gateway clients](https://docs.openclaw.ai/gateway/clients)、[Updating](https://docs.openclaw.ai/install/updating)、[Nodes version skew](https://docs.openclaw.ai/nodes)

## 9. Phase 0 采用验证清单

在把 OpenClaw 写入 Hunter 正式架构前，建议做一个两周内可完成的可丢弃 bake-off。验证对象必须用固定版本和独立测试 profile。

### A. 安装与生命周期

- [ ] Windows 11 x64 上用普通用户安装固定 OpenClaw；
- [ ] 分别验证 native Windows Gateway 与 app-owned WSL Gateway；
- [ ] Hunter 能按官方 embedding 模式启动、停止、重启 child；
- [ ] 配置错误退出码、`doctor` 修复、crash recovery 可观测；
- [ ] stdout/stderr 不堵塞，进程树能完整回收；
- [ ] Hunter 不读取 `~/.openclaw` 私有状态；
- [ ] current → candidate → previous-known-good 的升级与回滚可用。

### B. Gateway 协议与断线恢复

- [ ] 设备身份、pairing、`operator.read/write/approvals` 最小 scopes；
- [ ] session list、history、subscribe、run stream、approval resolve；
- [ ] WS 断开后根据权威 history 恢复，不重复 event；
- [ ] 幂等键阻止重复 start/send；
- [ ] 协议版本不兼容时明确 fail closed；
- [ ] 外部已有 Gateway 与 managed child 共用同一个 Provider 契约。

### C. Agent Surface 矩阵

- [ ] Codex native app-server：start/resume/steer/cancel、原生 code mode、模型切换、审批；
- [ ] Codex user-home session catalog：只读、fork/adopt、原生 Desktop/CLI 并发冲突提示；
- [ ] Claude ACP：persistent session、resumeSessionId、permission failure；
- [ ] Cursor ACP：本机已有认证、模型/权限能力探测；
- [ ] OpenCode ACP + native catalog；
- [ ] Pi ACP + JSONL native catalog；
- [ ] 至少一个不支持 model switch/session load 的负面样例，确保 capability 不被臆测；
- [ ] Gateway 重启后 ACP metadata、native resume id 和 Hunter Run 映射仍一致。

### D. 移动与渠道

- [ ] Windows Hub 连接本机/WSL Gateway；
- [ ] iOS 或 Android 完成查看 session、发 follow-up、取消 active run；
- [ ] Tailscale Serve/WSS 下的设备配对和 token rotation；
- [ ] Feishu DM：pairing/allowlist、streaming card、重启后消息不重放；
- [ ] Telegram DM：allowlist、approval/button、Dashboard Mini App（可选）；
- [ ] 手机消息能精确路由到 Hunter Run 所绑定的 Agent session；
- [ ] Hunter Bridge 不可用时，渠道命令显示明确降级，而不是静默绕过 Gate。

### E. Hunter Bridge 与 Gate

- [ ] plugin id/version/manifest contract/health 可由 Provider 证明；
- [ ] session extension 正确投影 Hunter WorkItemId/RunId/Gate；
- [ ] `before_agent_run` 可拒绝无 admission token 的 managed run；
- [ ] Codex native PreToolUse 与 OpenClaw dynamic tool 都能触发策略；
- [ ] hook timeout、plugin throw、plugin disable、Gateway restart 的故障注入；
- [ ] 任一故障都不会把 `guarded` 错报为有效；
- [ ] Gate 未通过时 start/resume fail closed；
- [ ] 工具层若不能 fail closed，则能力降级到 `controlled`，强隔离交给外部沙箱。

### F. 安全与证据

- [ ] loopback 默认；公网/LAN 暴露检查；
- [ ] DM/group pairing + allowlist；
- [ ] plugins allowlist；
- [ ] OpenClaw security audit 与 Hunter 独立 policy audit；
- [ ] ACP host execution 被正确标为 non-isolated；
- [ ] transcript、Gateway events 和 Hunter evidence ledger 的 hash/provenance 对账；
- [ ] OpenClaw 删除/reset session 不会删除 Hunter canonical evidence；
- [ ] Hunter 删除链接不会误删 native Agent session；
- [ ] secret 只保存 SecretRef/ownership，不复制明文到 Hunter 日志或 evidence。

### 通过门槛

只有同时满足以下条件，才把 OpenClaw Provider 升为默认：

- Windows 日常开发稳定运行一周；
- Codex native + 两个 ACP Agent 通过完整控制矩阵；
- 手机/飞书至少一个远程入口达到查看、follow-up、取消、审批；
- 断线/重启/升级不会丢 Hunter Run 绑定；
- Bridge 故障不会造成 Gate 静默放行；
- 用户可关闭/卸载 OpenClaw Provider，Hunter canonical data 仍完整可用。

## 10. 对 Hunter 产品路线的直接调整建议

1. **暂停自研 Hunter Node、Channels 和完整 Pocket Chat。** 先由 OpenClaw 供应；Hunter Pocket 聚焦 WorkItem、Gate、审批和 evidence。
2. **把当前 Goose-only Phase 0 改成 Provider bake-off。** Goose 保留为一个 Agent Surface，不再决定架构。
3. **Workbench 继续开发，不并入 OpenClaw Control UI。** Workbench 是 Hunter 的领域产品；可通过深链、session UI descriptor 和 Dashboard widget 与 OpenClaw 互跳。
4. **Runtime 仓库保留，但缩小职责。** 它实现 Governance Kernel、Provider SPI、OpenClaw Provider、Hunter Bridge 和 canonical store，不复制 Gateway。
5. **优先支持三类入口：** native app 继续原生使用；Hunter Workbench 发起受管任务；手机/飞书通过 OpenClaw 控制已绑定任务。
6. **对能力诚实分级。** 允许一个任务在 native app 中发挥最新工具优势，即使 Hunter 只能观察；需要强门禁时，明确切换到 guarded/isolated surface。

## 11. 最终建议

OpenClaw 已经实现了 Hunter 原设计中最昂贵、最容易重复造轮子的 60%～70% 基础设施：Gateway、渠道、移动端、节点、会话、ACP 和 Codex 深度接入。Hunter 若继续自行实现这些，会付出高维护成本，还很难跟上各 Agent 与移动平台变化。

但 OpenClaw 并没有替代 Hunter 的核心价值：它的 session/task 是运行与沟通模型，不是项目级 WorkItem/Run/Gate/Evidence 模型；它的插件 hook 和个人助理安全边界也不足以单独构成 Hunter 的强治理承诺。

因此建议采用：

> **Hunter Workbench + 独立 Governance Kernel + 可替换 Runtime Provider；首个默认 Provider 是受管但不修改的 OpenClaw，配一个可选薄 Bridge 插件。**

这条路线同时满足四个目标：

- 保留 Codex、Cursor、Claude Code、OpenCode、Pi 等各自迭代优势；
- 获得现成移动端与飞书/Telegram 能力；
- 避免 fork 和单一 Agent 锁定；
- 让 Hunter 把工程投入集中在工作流、知识、证据、跨 Agent handoff 和可信治理上。

## 12. 主要官方来源索引

- [OpenClaw 官方仓库](https://github.com/openclaw/openclaw)
- [MIT License](https://github.com/openclaw/openclaw/blob/main/LICENSE)
- [Gateway protocol](https://docs.openclaw.ai/gateway/protocol)
- [Embedding OpenClaw](https://docs.openclaw.ai/gateway/embedding)
- [Building a Gateway client](https://docs.openclaw.ai/gateway/clients)
- [Plugin SDK overview](https://docs.openclaw.ai/plugins/sdk-overview)
- [Plugin hooks](https://docs.openclaw.ai/plugins/hooks)
- [ACP agents](https://docs.openclaw.ai/tools/acp-agents)
- [Codex harness](https://docs.openclaw.ai/plugins/codex-harness)
- [Codex harness runtime](https://docs.openclaw.ai/plugins/codex-harness-runtime)
- [Nodes and native session catalogs](https://docs.openclaw.ai/nodes)
- [Windows Hub](https://docs.openclaw.ai/platforms/windows)
- [iOS app](https://docs.openclaw.ai/platforms/ios)
- [Android app](https://docs.openclaw.ai/platforms/android)
- [Feishu channel](https://docs.openclaw.ai/channels/feishu)
- [Telegram channel](https://docs.openclaw.ai/channels/telegram)
- [Gateway Security](https://docs.openclaw.ai/gateway/security)
- [Updating](https://docs.openclaw.ai/install/updating)
