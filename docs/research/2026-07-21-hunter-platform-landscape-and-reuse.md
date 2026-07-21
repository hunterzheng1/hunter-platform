# Hunter Platform 竞品、协议与复用路线调研

> 调研日期：2026-07-21
> 调研范围：只采用项目官网、官方文档、官方仓库、规范与许可证等一手来源。本文中的“支持”表示上游公开承诺或文档化能力，不等于已经通过 Hunter 在本机的兼容性、安全性或稳定性验收。所有易变化的产品状态均在相邻文字中附上官方链接。

## 1. 结论先行

Hunter 要做的不是另一个 OpenClaw、Hermes、Goose 或 OpenCode，也不是把多个终端摆在一个窗口里。已确认的产品本质是：

> **本地优先、Windows 优先的多项目 AI 开发控制台：把已冻结的需求转化为可视、可循环、可验证、可恢复的开发工作流；每个任务或步骤可以交给同一或不同原生 Coding Agent；需求、执行、产物、证据、归档和长期知识由 Hunter 连续管理。**

公开产品已经分别证明这件事的各个局部可行，但没有一个产品完整拥有 Hunter 所需的领域模型：

- **Orca** 已经把 Windows/Linux 桌面端、多仓库、Git worktree、多 Agent 终端、Diff、SSH、远程 Runtime、移动 Companion 和可脚本化 JSON CLI 组合在一起，是当前最值得优先做有时限、可逆可行性验证的执行底盘候选。[Orca 产品说明](https://www.onorca.dev/docs)、[CLI Reference](https://www.onorca.dev/docs/cli/reference)、[移动 Companion](https://www.onorca.dev/docs/mobile)
- **Agent Orchestrator** 当前以 Electron 桌面应用连接长驻 Go daemon，通过 adapter 管理 Agent、Runtime、Workspace、SCM 和 Tracker；它包含 Windows ConPTY、worktree 与 CI/Review 反馈能力，是 Orca 不合格时值得重新比较的 Runtime 候选，而非已证明的无缝替代。[官方仓库](https://github.com/AgentWrapper/agent-orchestrator)、[当前架构](https://github.com/AgentWrapper/agent-orchestrator/blob/main/docs/architecture.md)
- **Microsoft Conductor** 已经证明 YAML、确定性路由、并行、Loop、人工 Gate 和实时 DAG“线路亮灯”可以组成一个轻量流程内核，但它当前主要直接驱动模型 SDK，并不管理 Codex、CodeBuddy、Cursor 的原生会话。[官方仓库](https://github.com/microsoft/conductor)
- **OpenADE、OpenWork、Conductor.build、strIDEterm、Vibe Kanban** 分别提供需求/计划评审、工作台与产物、成熟 Workspace UX、Worker/Judge Loop、一体化任务执行等参考实现，但都不能单独成为 Hunter 的完整底座。

推荐路线是：

1. **Hunter 自己拥有 canonical state**：`Project → RequirementRevision(s) → ChangeRevision → Task Graph → WorkflowRun → StepRun → StepAttempt → Artifact/Evidence/Archive/Knowledge`。
2. **Phase 0 对 Orca 进行有时限、可逆的进程外 Runtime Provider/sidecar feasibility spike**，只通过公开 CLI、远程 Runtime 和文档化接口交互；不读写 Orca 私有数据库，不先 fork，也不预先承诺 Phase 1 采用。
3. **Codex 与 CodeBuddy 使用直接结构化 Connector**，尽量保留 thread/session、审批和事件；Orca 负责 worktree、PTY、终端窗口、Git 和接管界面。
4. **Cursor 首版按能力降级**：桌面应用负责原生编辑体验，Hunter 至少保证打开正确工作区、传递 Handoff Pack、观察 Git/Artifact 并人工确认；Phase 0 优先或并行验证第一方 `@cursor/sdk` public beta 与 CLI 的结构化执行，未通过条款、版本、权限和 Windows 契约测试前不提升承诺等级。
5. **Orca 的状态灯不等于 Hunter 的完成判定**。Orca 文档说明很多 Agent 状态来自终端 OSC title；Hunter 必须再用协议完成事件、Step Receipt、验证器或人工确认决定 Step 是否成功。[Orca Agent 状态说明](https://www.onorca.dev/docs/model/agents-sessions)
6. **只有 Phase 0 证明旁路方式无法实现一个统一客户端时，才评估薄 Orca Fork**。即使 fork，Requirement、Flow、Archive、Knowledge 与事件账本仍由 Hunter Core 持有。

这条路线可以概括为：

```text
Hunter Workbench + Hunter Flow + Hunter Canonical Store
                         |
                 Runtime / Connector Ports
             ┌───────────┼───────────────┐
             │           │               │
        Orca Provider  Codex Direct   CodeBuddy Direct
             │                           │
      PTY/worktree/Git/UI              ACP/HTTP
             │
      Cursor / generic CLI / other agents
```

## 2. 已批准的 Hunter 产品边界

本次对竞品的评价使用以下已经冻结的产品要求，而不是用“功能多不多”来评分。

### 2.1 产品与用户边界

- 首版是**单用户、多项目、多设备**，不是团队协作 SaaS。
- Windows 是首发硬验收平台；Linux 从领域模型、路径、进程与安装结构上保持同构并在后续正式验收。
- 一个 `Project` 是一个逻辑产品或目标，可以绑定多个仓库；首版重点跑通单仓库，多仓库能力从模型上保留。
- 一个 Project 同时拥有多个 Requirement；一个 Requirement 可以拆成多个 Change，一个 Change 也可以关联多个冻结的 RequirementRevision。
- 规划产生带依赖关系的 Task Graph；Task 可以串行或有限并行，Workflow Step 描述每个 Task 如何计划、实现、测试、Review 和归档。
- Hunter 是控制台和控制平面，不重做 Codex、Cursor、CodeBuddy 的模型、编辑器或 Agent Loop。
- 桌面端是完整操作台；移动端是远程驾驶舱，负责查看、审批、补充输入、暂停、继续和通知。

### 2.2 工作流边界

- 支持顺序、有限并行、条件分支、人工 Gate、失败重试、有界 Loop、超时和预算。
- 每个 Run 永久绑定不可变的 `RequirementRevision(s)`、`ChangeRevision` 和 `WorkflowRevision`。
- Agent 返回不等于步骤成功；成功必须来自结构化完成、Step Receipt、验证器或人工确认。
- 每轮 Loop 创建新的 `StepAttempt`，不能覆盖 Prompt、Session、Diff、证据和失败原因。
- 并发写入默认使用独立 worktree；非 Git 目录首版是单写者。
- 同一 Agent 被拆成 `AgentProduct`、`AgentProfile`、`NativeSessionRef`、`SessionPolicy` 和执行设备，避免“同一个 Agent”语义不清。

### 2.3 内容、归档与知识边界

- Markdown/JSON/附件等可读文件是重要内容的事实源；SQLite 保存索引、关系、事件、运行状态和查询投影。
- 每次 Run 归档后自动进入知识体系；需求版本也是正式 `KnowledgeSource`。
- 历史知识全部可检索；当前有效的权威知识和已验证经验才默认注入新 Run。
- 每条知识保留来源、适用范围、状态、置信度、替代关系和失效条件。
- Git/worktree 是代码事实源；Hunter 不另造代码网盘。

### 2.4 Connector 边界

- 允许不同 Agent 具有不同控制等级，UI 必须明确显示降级。
- 首个纵向版本冻结为：**Codex 深度 Connector、CodeBuddy Code 深度 Connector、Cursor 原生界面/Handoff Connector**。
- OpenCode、Goose、Pi、Claude Code、Hermes、Grok Build 等按同一契约后续接入；不再为 Goose 保留特殊 Gate、版本 Pin 或产品决策权。

## 3. 市场一览

| 产品/协议 | 最强部分 | Windows | Linux | 移动/远程 | 流程与 Loop | 许可证/可复用性 | 对 Hunter 的结论 |
|---|---|---|---|---|---|---|---|
| Orca | 多 Agent IDE、worktree、PTY、Git、SSH、CLI | 原生安装器 | AppImage/.deb | iOS/Android Companion、Remote Server（Beta） | 任务/终端编排，不是 Hunter 业务流程 | MIT 仓库；先 sidecar | **首轮有时限 Runtime feasibility spike** |
| Agent Orchestrator | Electron/CLI 客户端 + Go daemon + adapters、CI/Review Loop | 原生 ConPTY | tmux | 桌面发行；远程边界需实测 | issue→PR 反馈循环 | Apache-2.0 | **Runtime 备选/代码参考** |
| Microsoft Conductor | YAML、条件、并行、Loop、Gate、DAG | PowerShell 安装 | 原生 CLI | Web Dashboard | 强，但主要驱动模型 SDK | MIT | **Flow 语义与代码 Spike** |
| strIDEterm | 跨平台终端 IDE、Worker/Judge | 原生安装器 | AppImage/.deb | LAN/Cloudflare Web、Telegram | 固定 Worker/Judge | MIT | **一体化原型与 UX 参考** |
| OpenADE | Plan→Revise→Execute、快照回滚 | 官方标记 experimental | 支持 | 未见正式移动端 | 固定线性流程 | MIT | **需求/计划评审 UX 参考** |
| OpenWork | 工作台、Skills、模板、产物、权限、远程 Client | 官方仓库称需付费支持路径 | 支持 | Web/cloud/mobile client 架构 | 依赖 OpenCode；持久流程不完整 | MIT 核心 | **外壳/资产 UX 参考** |
| Vibe Kanban | Kanban、workspace、diff、preview、多 Agent | 有本地包/历史支持 | 有 | 原云远程已关闭 | task/workspace，不是任意 Flow | Apache-2.0；项目已 sunset | **只取材，不依赖维护** |
| Conductor.build | 成熟多 Agent Workspace UX | 不支持 | 不支持 | 无正式移动客户端 | 产品固定流程 | 专有、未公开 fork 许可 | **商业 UX 标杆** |
| Agent Deck | tmux 会话池、Skill/MCP、Conductor Agent | 仅 WSL | 一等支持 | Web、Telegram/Slack | LLM Conductor 自主调度 | MIT | **会话/通知参考** |
| Agent of Empires | tmux、worktree、Web/PWA、真实终端 | 仅 WSL2 | 一等支持 | 手机浏览器、Tunnel | 无确定性 DAG | MIT | **终端/移动接管参考** |
| OpenClaw | 常驻 Gateway、渠道、设备、Codex/ACP runtime | CLI/Gateway 原生可用，WSL2 更稳；无 Windows companion | 支持 | iOS/Android 节点、聊天渠道 | 通用 Agent/session，不是开发治理流 | MIT | **可选 Channel/Agent Provider** |
| Hermes | 单 Agent、学习/记忆、消息 Gateway、编程接口 | Native Windows 仍标 early beta | 支持 | Telegram 等渠道；Termux 路径 | Agent 自主 Loop | MIT | **可选 Agent/Channel Provider** |
| Goose | 通用 Agent、MCP、Recipe、subagent、可定制发行版 | 桌面/CLI | 桌面/CLI | 可通过 API 自建 | Recipe/Agent 驱动 | Apache-2.0 | **普通 Agent Connector，不做底座** |
| OpenCode | 开源 Agent、Server/SDK、TUI/Desktop | 可原生运行，官方仍推荐 WSL | 支持 | Web/server 可远程 | 单 Agent session | MIT | **第二批深度 Connector** |
| ACP | 编辑器/客户端 ↔ Coding Agent | 平台无关 | 平台无关 | 远程能力仍在演进 | 管会话和交互，不定义业务流程 | Apache-2.0 项目 | **优先通用 Agent Connector 协议** |
| MCP | Agent/Host ↔ Tool/Resource/Prompt | 平台无关 | 平台无关 | stdio/Streamable HTTP | 不定义 Coding Session 或 Flow | 开放规范 | **Hunter 能力暴露与上下文接口** |
| A2A | 独立远程 Agent ↔ Agent | 平台无关 | 平台无关 | 面向网络服务 | Task/Message/Artifact，不管理本机 IDE | Apache-2.0 | **远期远程 Provider 协议** |

平台和维护状态来源见各节与文末官方来源索引。表中的“未见”仅表示官方公开资料未给出稳定承诺，不证明内部完全没有相关实现。

## 4. Orca：首个有时限、可逆的验证候选，不是 Hunter 的事实源

### 4.1 已经解决的困难部分

Orca 的产品定位就是在一个桌面 IDE 中并排运行多个 Coding Agent。官方文档明确每个任务可拥有独立 Git worktree、Agent terminal 和 browser tab，支持 Codex、Cursor CLI、OpenCode 等真实 CLI；Git、Diff、提交、PR、SSH 也在同一工作区内。[产品说明](https://www.onorca.dev/docs)、[Worktree 模型](https://www.onorca.dev/docs/model/worktrees)

平台覆盖与远程形态也最接近 Hunter：

- 官方提供 Windows 安装器、Linux AppImage/.deb 和 macOS 包。[安装文档](https://www.onorca.dev/docs/install)
- iOS/Android Companion 可以查看工作树与 Agent 状态、读取终端 scrollback、回复等待输入、浏览文件、Review/Stage/Commit，并接收完成通知；官方明确它是远程控制器而不是完整编辑器。[移动文档](https://www.onorca.dev/docs/mobile)
- `orca serve` 可让远端机器持有仓库、worktree、终端和 Agent 进程，桌面、浏览器、手机或后端连接；该能力当前标为 Beta。[Remote Orca Servers](https://www.onorca.dev/docs/remote-servers)
- Orca CLI 有 `--json` 输出，可创建/检查 worktree，创建/读取/发送/等待终端，打开文件和 Diff，管理远端 environment，并可从外部自动化启动 Agent。[CLI Reference](https://www.onorca.dev/docs/cli/reference)
- 根仓库采用 MIT 许可证，官方仓库与 Releases 页面持续公开版本；安装文档说明 stable 与 RC 更新通道，RC 可能高频发布。[官方仓库](https://github.com/stablyai/orca)、[Releases](https://github.com/stablyai/orca/releases)、[更新说明](https://www.onorca.dev/docs/install#updates)

这些能力让 Hunter 有机会避免在第一天重做终端 UI、多窗口、worktree 管理、SSH、Diff、移动终端和 Agent 进程启动。Orca 的 Windows 终端后端、Unicode、resize、进程树和长时间稳定性仍是 Phase 0 实测项，不能从安装器与功能清单推断为已经解决的 ConPTY 兼容。

### 4.2 不能直接继承的语义

Orca 的核心对象是 repo、worktree、terminal/tab 和 agent session，不是 Hunter 的 Requirement、Change、Task、WorkflowRun、StepAttempt、Evidence 与 Knowledge。具体风险包括：

1. **状态灯不是完成证据。** Orca 文档说明状态主要来自 Agent 发出的终端 OSC title，`working → idle` 会触发完成通知；没有 OSC 的 Agent 就没有状态点。[Agents & Sessions](https://www.onorca.dev/docs/model/agents-sessions) 因此 Orca 的 idle 只能投影成 `runtime_observation`，不能直接写成 `StepRun.succeeded`。
2. **终端句柄不是长期业务 ID。** CLI 文档明确 terminal handle 只在当前 Runtime 内有效，Orca 重启或句柄 stale 后需要重新列举并获取新 handle。[CLI Reference](https://www.onorca.dev/docs/cli/reference#terminals) Hunter 必须保存自己的 `NativeSessionRef`、重连选择器和事件历史。
3. **默认权限策略与 Hunter 相反。** Orca 为很多 Agent 预填绕过审批参数，包括 Codex 的 `--dangerously-bypass-approvals-and-sandbox` 和 Cursor 的 `--yolo`；虽然用户可切换 Manual，但 Hunter 不能继承 Yolo 默认值。[Supported Agents](https://www.onorca.dev/docs/agents/supported)
4. **移动端当前只理解 Orca Runtime。** 官方说明桌面端是移动 Companion 的事实源，关闭桌面连接即断开，当前没有云 relay。[移动文档](https://www.onorca.dev/docs/mobile) 它不会自动展示 Hunter Requirement、DAG、Gate 和 Knowledge；首版可能仍需 Hunter PWA，统一移动客户端要在后续 fork/扩展中验证。
5. **公开 CLI 不等于稳定、版本化的嵌入 API。** CLI 功能很广，但必须实测错误码、并发、版本兼容、鉴权和事件丢失；不能直接读取 Orca 私有存储来“补接口”。
6. **许可证范围仍需审计。** 根仓库为 MIT，但正式分发前还要逐项核对移动端、品牌、第三方组件、更新服务和托管资源的许可证/条款，不能把根 LICENSE 自动外推到所有服务和素材。

Orca 的匿名遥测可在设置或 `DO_NOT_TRACK=1`/`ORCA_TELEMETRY_DISABLED=1` 下关闭；文档声称不上传 Prompt、终端、文件、路径或仓库名称。Hunter 的开发、测试和分发配置仍应默认关闭，并通过抓包/源码审计验证。[Privacy & Telemetry](https://www.onorca.dev/docs/telemetry)

### 4.3 推荐集成方式

```text
Phase 0：进程外 Provider feasibility spike（推荐先验证）
Hunter Core ── documented CLI/remote runtime ── Orca

Phase 1：仅在公开契约、Windows、恢复、安全和许可证门槛通过后采用

后续若需要统一桌面导航：
Hunter Core ── stable internal API ── thin Orca shell/fork
```

初期由 Hunter 调用：

- `orca repo add/list/show --json`
- `orca worktree create/show/list --json`
- `orca terminal create/read/send/wait --json`
- `orca environment ... --json`

Hunter 保存请求幂等键、自己的 ID、期望状态和验证结果；Orca 返回的 repo/worktree/terminal 标识只作为 Provider Reference。任何 CLI 返回“idle/done”后，Hunter 仍进入 `verifying`。

只有以下情况经过实测成立，才值得薄 Fork：

- 不能通过公开接口把 Hunter Run/Step 状态嵌入客户端导航。
- 两个独立客户端造成明显且不可接受的上下文切换。
- Orca 上游愿意提供或接受稳定扩展点，且同步成本可控。
- 对 Windows/Linux/移动发布链、品牌与许可证已经完成审计。

## 5. 其他可复用产品

### 5.1 Agent Orchestrator：Runtime 备选

Agent Orchestrator 当前由 Electron 桌面应用或 CLI 连接长驻 Go daemon；daemon 通过 adapter 管理 Agent、Runtime、Workspace、SCM、Tracker 和反馈循环。官方架构包含 tmux 与 Windows ConPTY Runtime、独立 worktree、branch/PR，以及 CI、Review 和合并冲突反馈。[官方仓库](https://github.com/AgentWrapper/agent-orchestrator)、[当前架构](https://github.com/AgentWrapper/agent-orchestrator/blob/main/docs/architecture.md)、[Windows Setup](https://github.com/AgentWrapper/agent-orchestrator/blob/main/SETUP.md)

它采用 Apache-2.0。新安装以桌面发行资产为主；`@aoagents/ao` npm 0.10.0 已冻结，仅为既有 CLI 用户保留，稳定版与 nightly 预发行资产见 GitHub Releases。[许可证](https://github.com/AgentWrapper/agent-orchestrator/blob/main/LICENSE)、[Releases](https://github.com/AgentWrapper/agent-orchestrator/releases)

适合复用：

- Windows ConPTY/process Runtime。
- Agent/Runtime/Workspace 插件边界。
- 多项目、worktree、Web terminal。
- CI、Review、合并冲突反馈到现有 Session 的 reaction 模型。

不适合直接成为 Hunter Core：

- 核心语义是 issue/session/PR，而不是 Requirement→Change→Task→Workflow Step。
- reaction 不是任意 Workflow DAG、人工 Gate 或有证据的 Attempt。
- 没有 Hunter 的 Archive/Knowledge 生命周期。

建议把它保留为 `AgentOrchestratorProvider` Spike 或代码参考。如果 Orca 在 Windows、接口稳定性或权限策略上不合格，应按 AO 当前 daemon/API 与发行形态重新验证同一 Runtime Contracts；无论结果如何，都不推倒 Hunter Workbench/Flow。

### 5.2 Microsoft Conductor：Flow 语义与实现参考

Microsoft Conductor 采用 MIT 许可证，用版本化 YAML 定义 Agent、Prompt、输出和路由；支持静态/动态并行、子工作流、Script、Set、Wait、Terminate、条件路由、Loop、最大迭代、超时和 Human-in-the-loop。它的 Web Dashboard 有实时 DAG、动画执行边、节点详情、Log/Activity/Output 和浏览器 Gate；官方同时提供 PowerShell 与 macOS/Linux 安装路径。[官方仓库](https://github.com/microsoft/conductor)

它与 Hunter 的“执行线路亮灯”高度吻合，但当前 provider 主要是 GitHub Copilot SDK 与 Anthropic，尚不是 Codex、CodeBuddy、Cursor 的真实原生会话控制层。[Provider 说明](https://github.com/microsoft/conductor#providers)

推荐 Spike：

- 用 Hunter 的 `NativeAgentStepExecutor` 替换内置模型调用。
- 检查 route-back Loop 是否能按 Attempt 保存，而非覆盖节点输出。
- 检查断电/进程崩溃后的 durable recovery。
- 检查 Dashboard/事件能否作为库嵌入，而不是另起一个 canonical state。

在结果出来前，它应是**流程语义和测试用例的参考实现**，不是已经决定采用的持久化引擎。

### 5.3 strIDEterm：一体化 Loop 原型

strIDEterm 是 MIT Electron 桌面应用，官方提供 Windows NSIS/portable、Linux AppImage/.deb 与 macOS 包。它有真实 Agent 终端、Git/worktree、PR review、多 workspace，并提供 Agent Task Runner：Worker 从 `TASK.md` 实现，确定性 test/lint/build 在轮次之间运行，独立 Judge 根据 Git diff 决定继续或完成；Worker/Judge 可来自不同 CLI Agent。它还支持 LAN/Cloudflare 远程 Web 和 Telegram 控制。[官方站点与 Task Runner](https://strideterm.com/)、[官方仓库](https://github.com/jstradej/strideterm)

它证明“跨平台桌面 + 异构 Agent + 有验证的 Loop + 手机接管”技术上可行。缺口是流程固定为 Worker/Judge、状态协议偏终端/文件、没有 Requirement/Change/Knowledge，且项目治理与维护承载能力需要源码级审计。适合作为验收对照样机和 UX/实现取材，不适合未经审计直接押注。

### 5.4 OpenADE：需求到计划的交互参考

OpenADE 的核心是 `Plan → Revise → Execute`：先生成计划，用户对文件、Diff 和 Agent 输出进行评论，锁定后线性执行；同时提供 Git snapshot/rollback、worktree、终端和多 Agent HyperPlan。它本地运行、采用 MIT 许可证，并主要支持 Claude Code/Codex。[官方产品页](https://openade.ai/)、[官方仓库](https://github.com/bearlyai/OpenADE)

官方明确把 Windows 标为 experimental、尚未充分测试，并建议更稳定时使用 WSL，因此不能作为 Windows-first 底座。[Windows 状态](https://openade.ai/#download)

Hunter 应借鉴需求澄清、计划行内评审、锁定后执行和快照回滚，而不是复用它的固定执行模型。

### 5.5 OpenWork：Workbench 与 Artifact 参考

OpenWork 是 MIT 的 Tauri 桌面/Web/Server 产品，核心由 OpenCode 驱动。官方公开能力包括 Host/Client、Session 与 SSE、OpenCode Todo 时间线、权限回应、模板、Skills/Plugins/MCP、Artifact 预览/编辑/下载，以及本地与远程 Worker。其架构文档强调 App 作为 Server API 的客户端、文件写操作通过 Server 统一授权与审计，并描述 Web/cloud/mobile client 连接同一远端 Worker 的模式。[官方仓库](https://github.com/different-ai/openwork)、[架构文档](https://github.com/different-ai/openwork/blob/dev/ARCHITECTURE.md)

限制：

- canonical agent loop 仍绑定 OpenCode，不是多原生 Agent 中立层。
- 模板与 Todo 时间线不等于可恢复的 Requirement→Change→Task DAG。
- 官方仓库当前写明 macOS/Linux 可直接下载，而 Windows 走付费支持路径；不能据其他宣传推断免费的一等 Windows 支持。[README/Quick Start](https://github.com/different-ai/openwork#quick-start)

应复用信息架构和交互思想：Artifact、Skill、Permission、远端 Client、Server-first filesystem mutation；不直接采用为 Hunter Runtime。

### 5.6 Vibe Kanban：代码仍有价值，产品已经 sunset

Vibe Kanban 曾提供任务看板、worktree workspace、多 Agent Session、terminal、Diff comment、preview 和 PR，支持包括 Codex、Cursor、OpenCode 在内的多种 Agent。[官方仓库](https://github.com/BloopAI/vibe-kanban)、[Workspace Interface](https://www.vibekanban.com/docs/workspaces/interface)

但官方于 2026-04-10 宣布公司关闭：本地 workspace 继续工作，远程云服务移除，项目转社区维护。[关闭公告](https://www.vibekanban.com/blog/shutdown) 代码采用 Apache-2.0。[许可证](https://github.com/BloopAI/vibe-kanban/blob/main/LICENSE)

结论：可以研究 executor、workspace、diff、preview 组件；不能把 Hunter 依赖在已关闭团队的远程服务或维护承诺上。

### 5.7 Conductor.build：成熟 UX 标杆，不是底座

Conductor.build 支持 Claude Code、Codex、Cursor、OpenCode；每个 workspace 绑定独立 worktree/branch/files/terminal/diff/check/PR，也可在同一 workspace 内运行多个 Session。[Harness Overview](https://www.conductor.build/docs/reference/harnesses)、[Parallel Agents](https://www.conductor.build/docs/concepts/parallel-agents)

官方仍将产品定位为 Mac App，安装与安全文档都围绕 macOS；未发现可 fork 的官方开源仓库或公开许可证。[官网](https://www.conductor.build/)、[安装文档](https://www.conductor.build/docs/installation)、[安全说明](https://www.conductor.build/docs/reference/security-and-permissions) 它适合成为 Workspace、Open-in-tool、Review/PR/Archive 的 UX 标杆，不是 Windows/Linux 代码底座。

### 5.8 Agent Deck 与 Agent of Empires：会话与移动终端参考

Agent Deck 是 MIT 的 tmux/TUI/Web Session Manager，支持多 Agent、worktree、Docker sandbox、Skill/MCP，并可建立常驻 Conductor Agent，通过 Telegram/Slack 监控其他 Session。官方 Windows 路径是 WSL。[官方仓库](https://github.com/asheshgoplani/agent-deck)

Agent of Empires 同样采用 MIT，使用 tmux 保持真实 Agent Session，提供 worktree、Docker、Diff、Web Dashboard/PWA、手机远程控制和 Session resume；官方明确原生 Windows 不支持，只能 WSL2。[官方仓库](https://github.com/njbrake/agent-of-empires)

二者值得借鉴：

- Session 与宿主终端解耦，客户端关闭后继续运行。
- running/waiting/idle/error 的统一投影。
- 手机接入、Tunnel、二维码与通知。
- worktree setup 与忽略文件复制策略。

但两者的“Conductor”是 LLM Session 监控其他 LLM，不是确定性、可审计、可重放的 Hunter Flow；也不能满足原生 Windows 硬约束。

## 6. 为什么 OpenClaw、Hermes、Goose、OpenCode 都不是最终产品底座

### 6.1 OpenClaw

OpenClaw 官方将其定义为运行在用户设备上的个人 AI Assistant，Gateway 是控制平面，聊天渠道与常驻 Agent 才是产品中心。[官方仓库](https://github.com/openclaw/openclaw)

它的优势是真实 Gateway、移动节点、聊天渠道、设备配对和 Agent Runtime：Codex 可走 native app-server，Claude Code、OpenCode、Cursor 等外部 Harness 可走 ACP/acpx。[Agent Runtimes](https://docs.openclaw.ai/concepts/agent-runtimes) 但这仍围绕通用 Assistant/Session，而不是 Requirement、Change、Task、Workflow、Evidence 和 Knowledge 的开发控制面。

Windows 方面，官方现在支持 native CLI/Gateway，但仍明确 WSL2 更稳定且推荐获得完整体验；Windows companion app 尚未提供。[Windows 文档](https://docs.openclaw.ai/platforms/windows) 因此它可以以后作为 `ChannelProvider`、`RemoteAgentProvider` 或某类 Connector，不能重新定义 Hunter 产品。

### 6.2 Hermes

Hermes 的官方定位是可自我学习、跨 Session 记忆、可通过 Telegram/Discord/Slack/WhatsApp 等渠道访问的单一通用 Agent；它还提供 subagent、scheduler 与多种 terminal backend。[官方仓库](https://github.com/nousresearch/hermes-agent)

Hermes 已公开 ACP、TUI Gateway JSON-RPC 和 OpenAI-compatible HTTP API；JSON-RPC 包含 session create/list/activate/interrupt/branch、approval/clarify 等，技术上可作为 Hunter 的一个深度 Agent Connector。[Programmatic Integration](https://github.com/nousresearch/hermes-agent/blob/main/website/docs/developer-guide/programmatic-integration.md)

平台文档的细节比首页宣传更保守：Native Windows 指南仍标记 Early Beta，POSIX PTY 的 Dashboard chat pane 需要 WSL2；Linux/WSL 是更成熟路径。[Windows Native Guide](https://github.com/nousresearch/hermes-agent/blob/main/website/docs/user-guide/windows-native.md)、[平台支持](https://hermes-agent.nousresearch.com/docs/getting-started/platform-support)

结论：Hermes 可成为 Agent/Channel Provider，但不能成为 Hunter 的需求和工作流事实源。

### 6.3 Goose

Goose 是 Apache-2.0 的通用本地 Agent，提供 Windows/Linux/macOS 桌面、CLI、API、多 Provider、MCP 扩展、Recipe、sub-recipe/subagent 和自定义发行版指南。[官方仓库](https://github.com/aaif-goose/goose)、[Custom Distributions](https://github.com/aaif-goose/goose/blob/main/CUSTOM_DISTROS.md)

它适合：

- 作为一个普通 Agent 执行某个 Hunter Step。
- 通过 ACP/REST 接入。
- 借鉴 Recipe 与 MCP 扩展。

它不适合继续拥有特殊架构地位：Recipe 和 subagent 的路由仍由 Goose/模型上下文驱动，不能替代 Hunter 的 Requirement/Change/Task、持久 Attempt、外部 Agent 分配、证据验证和分级知识。原 Goose Gate、版本 Pin 与 30 天三臂实验没有必要迁入 Hunter Platform。

### 6.4 OpenCode

OpenCode 是 MIT 的开源 Coding Agent，提供 TUI、Desktop、IDE Extension 和 headless server；CLI 能恢复/fork/export Session，Server 提供 API，Windows 可直接安装但官方仍推荐 WSL 取得更完整兼容。[官方文档](https://opencode.ai/docs)、[CLI/Server](https://dev.opencode.ai/docs/cli/)、[Windows/WSL](https://opencode.ai/docs/de/windows-wsl/)、[许可证](https://github.com/anomalyco/opencode/blob/dev/LICENSE)

OpenCode 是优秀的深度 Connector 或 Agent Runtime，但以它为核心会让 Hunter 再次绑定单一 Agent。首版已经选择 CodeBuddy Code 作为第二个深度 Connector；OpenCode 应排在第二批，同时保留通过 Orca 启动的基础支持。

## 7. 首批三个 Agent 的真实接入证据

### 7.1 Codex：目标 L3 深度 Connector

Codex `app-server` 是官方用于构建丰富客户端的接口，使用双向 JSON-RPC 风格消息；核心对象是 Thread、Turn、Item，支持 `thread/start`、`thread/resume`、`thread/fork`，并持续推送 thread/turn/item 事件。命令与文件修改审批通过 server-initiated request 返回给宿主 UI。[Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)

这与 Hunter 的映射很自然：

| Codex | Hunter |
|---|---|
| Thread ID | `NativeSessionRef.external_id` |
| Turn | 一个 StepAttempt 中的一次 Agent turn |
| Item/事件 | Raw Runtime Event / Evidence 候选 |
| Approval Request | PolicyEngine + Approval |
| thread/resume | `SessionPolicy=resume_if_supported` |
| thread/fork | 从固定历史边界创建新 Session/Attempt |

app-server 可生成与当前 Codex 版本精确匹配的 TypeScript/JSON Schema，因此 Hunter 应固定已验证版本并在升级时重新生成 Schema、运行契约测试，而不是手写长期漂移的类型。[Schema 生成说明](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#message-schema)

Codex CLI 官方仓库采用 Apache-2.0，并已提供 Windows 安装脚本与本地 CLI；但 Windows/WSL、Desktop 与 sandbox 的实际差异仍需 Phase 0 分别验证。[Codex README](https://github.com/openai/codex/blob/main/README.md)、[许可证](https://github.com/openai/codex/blob/main/LICENSE)

推荐：Hunter 直接拥有 Codex app-server Connector；Orca 只承担 worktree、终端和打开原生界面。不要把结构化事件降级成终端文本解析。

### 7.2 CodeBuddy Code：目标 L2/L3 Connector

CodeBuddy Code 官方提供三个有价值的集成面：

1. Headless `--print`，支持 `json`/`stream-json`、Session ID、`--resume`/`--continue` 和 JSON Schema 结构化输出。[Headless Mode](https://www.codebuddy.ai/docs/cli/headless)
2. 原生 ACP Server：`codebuddy --acp`，可由客户端代理文件与终端操作，并推送 Slash command 与 Agent Teams 状态扩展。[ACP Integration](https://www.codebuddy.cn/docs/cli/acp)
3. `--serve`/Daemon 的 REST、SSE、ACP、PTY、Worker、Run 与 Session API；官方明确 HTTP API 为 Beta。[HTTP API Beta](https://www.codebuddy.ai/docs/cli/http-api)、[Daemon](https://www.codebuddy.ai/docs/cli/daemon)

它公开支持 macOS、Linux 和 Windows，Daemon service 分别映射 launchd、systemd user service 与 Windows Task Scheduler。[Quick Start](https://www.codebuddy.ai/docs/cli/quickstart)、[Daemon Platform Support](https://www.codebuddy.ai/docs/cli/daemon#platform-support)

风险必须写进产品而不是藏起来：官方 Headless 文档说明非交互执行涉及文件、命令或网络时需要 `-y/--dangerously-skip-permissions`，而 Daemon background session 也可能以跳过确认方式运行。[Headless Mode](https://www.codebuddy.ai/docs/cli/headless)、[Daemon Background Sessions](https://www.codebuddy.ai/docs/cli/daemon#background-sessions) Hunter 不应默认采用该路径；应优先验证 ACP 的 client-side permissions、受限 tools/permission mode，无法安全表达时就降级为人工 Gate。

推荐顺序：

```text
CodeBuddy ACP
  → documented daemon ACP/REST（固定 Beta 版本 + 契约测试）
    → headless stream-json
      → Orca PTY
```

CodeBuddy 是外部产品 Connector，不是准备 fork 的开源底座；公开文档未给出可把其核心代码纳入 Hunter 的开源许可证承诺。

### 7.3 Cursor：首版 L0/L1，SDK/CLI 深度能力单独验证

Cursor Desktop 官方提供 Windows、Linux 与 macOS 版本。[下载页](https://cursor.com/download) Cursor Agent CLI 支持交互模式、`--print`、JSON/stream-json、Session list/resume、MCP 和 Rules；stream-json 有 init、tool/event 与终止 result，失败时可能提前结束且没有 result。[CLI Overview](https://cursor.com/docs/cli/overview)、[Output Format](https://cursor.com/docs/cli/reference/output-format)

Cursor 还发布了第一方 `@cursor/sdk` public beta，可用 TypeScript 创建本地或云 Agent 并流式消费 Run 事件。它比 raw CLI 更接近结构化 Connector 候选，但仍需核对 Beta 条款、版本兼容、权限/审批、Windows local runtime 与 Session 映射，不能直接当成生产承诺。[SDK 发布](https://cursor.com/changelog/sdk-release)、[SDK 更新](https://cursor.com/changelog/sdk-updates-jun-2026)、[服务条款](https://cursor.com/en-US/terms-of-service)

重要边界：

- Cursor CLI 已提供 native Windows 安装路径，同时仍可在 WSL 使用；native Windows、WSL 与 Linux 必须分别验收，不能把“可安装”写成“可靠性已通过”。[CLI Installation](https://cursor.com/docs/cli/installation)、[Desktop Download](https://cursor.com/download)
- `--force` 会允许 Headless 直接修改文件；Hunter 不能把它设成默认。[Headless Mode](https://cursor.com/docs/cli/headless)
- `cursor-agent --resume` 能恢复 CLI chat，不代表 Hunter 能打开 Cursor Desktop 内任意既有 Composer Session。

所以首版应承诺：

- 在正确 worktree 打开 Cursor Desktop。
- 生成并传递 Task/Handoff Pack。
- 观察 Git diff、声明产物和验证器。
- 用户在 Cursor 完成后人工确认或提交 Step Receipt。

只有 Phase 0 实测证明 Cursor SDK 或 CLI 在 native Windows/WSL/Linux 的 Session 映射、事件完整性、权限和条款足够稳定，才把某些 Cursor Step 提升到 L2。

## 8. ACP、MCP、A2A 各自该放在哪里

三个协议互补，不应抽象成一个万能协议。

### 8.1 ACP：Coding Agent 会话控制协议

Agent Client Protocol 面向编辑器/客户端与 Coding Agent。官方架构使用双向 JSON-RPC，客户端按需启动 Agent 子进程，单连接可承载多个 Session；Agent 通过 notification 流式更新 UI，也可反向请求权限、文件和终端能力。[ACP Architecture](https://agentclientprotocol.com/get-started/architecture)

ACP 已覆盖或持续稳定化 session create/load/resume/close、Prompt、流式更新、文件、终端和权限，项目采用 Apache 许可证。[ACP 官方项目](https://github.com/agentclientprotocol/agent-client-protocol)、[协议更新](https://agentclientprotocol.com/updates)

对 Hunter：

- 是最优先的通用 `AgentConnector` 协议。
- 适合 CodeBuddy、Goose、OpenCode 等支持者。
- 远程 Agent 支持仍在演进，官方文档明确完整 remote support 是 work in progress。[ACP Introduction](https://agentclientprotocol.com/get-started/introduction)
- 不定义 Requirement、Task DAG、Loop、Archive 或 Knowledge，因此不能替代 Hunter Flow。

### 8.2 MCP：工具和上下文协议

MCP Server 向 Host/Agent 暴露 Prompt、Resource 和 Tool；标准传输是 stdio 与 Streamable HTTP，协议使用 JSON-RPC。HTTP Server 需要 Origin 校验、localhost 默认绑定与认证，以避免 DNS rebinding。[Server Primitives](https://modelcontextprotocol.io/specification/2025-06-18/server/index)、[Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

对 Hunter：

- Hunter 可以作为 MCP Server 暴露 `query_requirement`、`get_step_context`、`submit_receipt`、`publish_artifact`、`query_knowledge` 等受策略保护的工具/资源。
- Hunter 也可作为 MCP Client 连接项目外部能力。
- MCP 2025-11-25 加入的 durable task 仍标 experimental，不能据此替代 Hunter 的 WorkflowRun/StepAttempt；Hunter 必须固定协议版本和 capability，不能把实验 wire shape 当稳定合同。[2025-11-25 Changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog)
- MCP 不负责原生 Coding Session 的 resume、IDE UI、PTY 或 worktree；这些由 Agent Connector/Runtime Provider 负责。

### 8.3 A2A：远程独立 Agent 间协作协议

A2A 是 Linux Foundation 下的 Apache-2.0 开放协议，面向独立、可能不透明的远程 Agent。核心对象包括 Agent Card、Message、Task、Part 和 Artifact，支持能力发现、任务生命周期与多种传输绑定。[A2A Specification](https://a2a-protocol.org/latest/specification)、[官方仓库](https://github.com/a2aproject/A2A)

对 Hunter：

- 适合未来接远程托管 Agent、企业 Agent 服务或另一个 Hunter Node。
- A2A Task 可以映射为 `ExternalExecutionRef`，但不能直接等同 Hunter Task/Step，因为 Hunter 还要拥有 Requirement、预算、验证器、WorkspaceLease 与审计。
- 首版本地 Windows Agent 不需要先引入 A2A；等远程 Provider 成为真实需求再做。

### 8.4 推荐协议优先级

```text
厂商正式结构化接口（Codex app-server）
  → 通用 Agent 协议（ACP）
    → 官方 Headless JSON/SSE/REST
      → 受管 PTY/OSC（Orca/AO）
        → Native App Handoff + 人工确认

MCP：贯穿各层提供工具与上下文，不承担 Flow
A2A：远期连接远程独立 Agent，不承担本机 Workspace/PTY
```

## 9. Hunter 与 Orca 的 canonical state 分工

### 9.1 Hunter 永久持有

- `Project`、`RepositoryBinding`、`DeviceBinding`
- `Requirement`、`RequirementRevision`、`Approval`、`RequirementAmendment`
- `Change`、`ChangeRevision`、`ExecutionPlan`、`Task`、`TaskDependency`
- `WorkflowTemplate`、`WorkflowRevision`、`ProjectWorkflowBinding`
- `WorkflowRun`、`StepRun`、`StepAttempt`
- `AgentProduct`、`AgentProfile`、`AgentAssignment`、Connector Capability Manifest
- `NativeSessionRef`、`WorkspaceLease`、Provider Reference
- `Artifact`、`Evidence`、`Archive`、`KnowledgeSource`、`KnowledgeEntry`
- 事件账本、验证结果、审批、预算、幂等键和策略决定

### 9.2 Orca 暂时持有并由 Hunter引用

- Orca repo/worktree 标识
- PTY/terminal/tab 和 scrollback
- Agent 进程生命周期与可观察状态
- Orca UI 布局、Diff、Git 操作与 SSH Runtime
- Orca mobile/remote Runtime 会话

### 9.3 其他事实源

- Git 仓库与 worktree：源码、commit、branch 和 diff 的事实源。
- Codex/CodeBuddy/Cursor：各自 native thread/session/transcript 的事实源。
- 版本化资料区：需求、工作流、计划、归档、知识正文。
- Hunter SQLite/Event Log：状态、关系、事件、索引和查询投影。

### 9.4 同步不变量

1. Orca worktree 消失时，Hunter 标记 `workspace_missing/needs_attention`，不删除 Run 历史。
2. terminal handle stale 时重新发现；不以 handle 作为长期主键。
3. Orca idle 只结束“可观察执行”，不能自动通过验证。
4. Native Session 无法 resume 时创建新 Session 与 Handoff Pack，并记录降级原因。
5. Hunter 重启后先读事件账本，再与 Orca/Connector 对账；不从第三方 UI 猜测历史。
6. 手机、桌面、原生终端争夺输入时由 Hunter/Runtime Lease 保证一个 Controller。
7. Provider 的私有数据库、缓存和 transcript 不由 Hunter 直接修改。

## 10. Sidecar、复用、Fork 的明确取舍

| 候选 | 现在怎么用 | 何时升级 | 不做什么 |
|---|---|---|---|
| Orca | **进程外 sidecar/Provider**，调用公开 CLI/Remote Runtime | 统一客户端需要且扩展点/同步成本通过验证后，薄 Fork | 不把 Hunter 数据写入 Orca 私有 DB；不一开始 whole-fork |
| Agent Orchestrator | Runtime 备选；复用插件/ConPTY/worktree 思路 | Orca 接口、安全或 Windows 验收失败 | 不采用 issue/PR 作为 Hunter 领域模型 |
| Microsoft Conductor | Flow 语义、测试用例、可嵌入性 Spike | durable recovery、自定义 executor、事件模型全部合格后选择性复用 | 不让它直接拥有 Hunter Requirement/Knowledge |
| strIDEterm | 对照样机与 Worker/Judge UX/测试参考 | 只有代码、安全、bus-factor 通过审计后取小模块 | 不押注整个产品 |
| OpenADE/OpenWork/Vibe/Conductor.build | UX、组件、交互和错误场景参考 | 只按许可证选择性移植小模块 | 不直接 fork 为 Hunter |
| OpenClaw/Hermes/Goose/OpenCode | 普通 Connector、Channel 或远程 Provider | 用户真实采用率证明价值后深化 | 不再定义 Hunter 产品或拥有 canonical state |

这不是“把 Orca 改名成 Hunter”。让 Orca 先进入有时限 Spike，只是尽早验证能否复用昂贵基础设施，不代表预先选择它；Hunter-owned 的含义是：即使验证失败或明天换掉 Orca，需求、流程、Run、证据、归档和知识仍完整存在。

## 11. Phase 0 必须实测的未知项

官方文档不能替代以下测试；每项都应形成可复现命令、结果、日志、版本、截图和 Go/No-Go 结论。

### 11.1 Orca

**Windows/Linux 与进程：**

- Windows 10/11 下 PowerShell、CMD、Git Bash、WSL repo 的实际 PTY/Unicode/ANSI/路径空格稳定性。
- App/Runtime/Agent 分别崩溃或重启时，worktree、terminal、scrollback 和 Agent 进程如何恢复。
- Windows Job Object 或等价进程树管理是否存在；终止 Agent 是否遗留子进程。
- Linux AppImage/.deb 与 Windows 的 CLI/remote runtime 行为是否同构。

**公开契约：**

- `--json` 输出 Schema、错误码、退出码、并发语义、超时与取消。
- `orca serve` 的鉴权、Token 撤销、版本协商、TLS/私网要求和网络断连恢复。
- terminal handle stale 后的稳定重发现键是什么。
- 同时从 Hunter、Orca UI 和手机发送输入时是否会竞态；能否实施单 Controller Lease。
- 是否有文档化事件流，还是必须轮询 CLI；轮询成本和丢事件边界。

**状态与完成：**

- Codex、CodeBuddy、Cursor、OpenCode 等每种 Agent 的 OSC/hook 状态准确率。
- waiting、idle、crash、rate limit、approval、正常退出是否可可靠区分。
- “终端 idle”与 Agent 的真实 turn complete 有多少误报/漏报。
- Hunter Verifier 与 Orca notification 冲突时，以 Hunter 为最终状态是否可实现。

**权限与隐私：**

- 能否全局和逐 Agent 禁用预填 Yolo 参数，并保证升级后不被重新写回。
- Agent 能否越过 worktree 访问其他目录、凭据和其他项目；worktree 不能被误称为安全 sandbox。
- 遥测开关、网络请求、诊断包、自动更新和本地凭据存储的源码/抓包审计。
- 根 MIT 对 Desktop、Mobile、品牌资产和发布链的实际覆盖；第三方 notices 是否满足再分发。

**移动与产品整合：**

- Companion 在桌面关闭、网络切换、手机后台、Token 撤销时的行为。
- 当前无 cloud relay 的情况下，Tailscale/WireGuard/LAN 是否满足真实使用。
- Hunter PWA 与 Orca Companion 双入口是否可接受；若不可接受，薄 Fork 的最小修改面是什么。

### 11.2 Codex Connector

- 固定版本生成 TypeScript/JSON Schema，并建立升级差异审查。
- native Windows、WSL2、Linux 下 app-server 的 start/resume/fork/interrupt/approval/event 行为。
- Hunter 重启后能否仅凭 Thread ID 恢复并继续订阅事件。
- 同一 Thread 是否可被两个客户端同时控制；冲突与 Lease 语义。
- app-server、Codex Desktop 与 CLI 是否能安全共享登录和 Session，而不直接读取私有凭据。
- “Open in Codex”能否定位同一 Thread；做不到时明确降级为打开目录/恢复命令。
- Windows 路径大小写、UNC、`\\?\`、WSL 映射与 workspace identity。

### 11.3 CodeBuddy Connector

- ACP 的 initialize/newSession/prompt/cancel/resume/permission/fs/terminal 能力矩阵与标准偏差。
- `session_info_update._meta` 等扩展在版本升级时如何协商和忽略未知字段。
- HTTP API Beta 的版本、Auth、CORS、SSE reconnect、幂等和错误码。
- Daemon 在 Windows Task Scheduler 下的崩溃恢复、升级、日志和进程树。
- 不使用 `-y` 时能否通过 ACP permission 或 allowed tools 完成可控文件修改；不能则该路径降级。
- Git Bash 缺失时 PowerShell fallback 对 worktree、脚本与路径的影响。
- CodeBuddy CLI Session 与 CodeBuddy IDE Session 是否可互相打开/恢复；官方资料不足，不能预设。

### 11.4 Cursor Connector

- `@cursor/sdk` public beta 与 CLI 的能力、条款、事件、权限和版本稳定性比较；优先选择可验证且可降级的结构化路径。
- Cursor Desktop、SDK local runtime、CLI 在 native Windows/WSL/Linux 的工作区映射。
- `stream-json` 事件、失败时缺失终止 event、Session ID 与 resume 的兼容测试。
- 不使用 `--force` 时哪些步骤可自动化；使用权限配置时能否限制 Git/网络/目录。
- 是否存在正式、稳定的 deep link/API 打开指定 Composer/Agent Session；若无，只承诺打开目录。
- CLI Session 能否在 Desktop 中无损接管；不能则保持两个 `NativeSessionRef`。

### 11.5 Flow Engine 与备选 Runtime

- Microsoft Conductor 进程/机器重启后的恢复位置、事件持久化和 Attempt 历史。
- 自定义 NativeAgent executor 是否可完全绕开内置模型 provider。
- Dashboard 是否可作为组件/事件源嵌入 Hunter，而非独立服务器事实源。
- Agent Orchestrator 的 Windows ConPTY、Unicode、长时间 Session、外部 API 和已有 Session attach。
- AO/Orca Provider 契约能否通过同一 Fake Provider test suite。

## 12. Phase 0 推荐验收门槛

### 12.1 Phase 0 必须形成的技术证据

1. 在原生 Windows 的一次性 Git fixture 中，通过 Orca 公开接口创建、发现和清理 worktree/terminal；不要求先有正式 Hunter UI。
2. Codex app-server 在固定版本下产生可关联的 Session、Turn、Approval、completion/cancel 与重连证据。
3. CodeBuddy 的 ACP、Headless、HTTP 候选分别探测；至少明确一条不默认绕过权限的可用路径，或诚实记录未证明。
4. Cursor Desktop Handoff 必须定位正确 worktree；`@cursor/sdk` public beta 与 CLI 只做条款、事件、权限、Session 和 Windows 契约比较，不预设 L2。
5. Provider/Hunter/Agent 在 intent、外部接受、receipt 前后的崩溃窗口不会产生虚假成功；不能证明唯一副作用时进入 `indeterminate/needs_attention`。
6. Orca 和备选 Provider 都只能通过相同 Runtime Contracts；Requirement、Flow、Run、Evidence、Archive 与 Knowledge 不依赖其私有模型。
7. 危险默认参数、遥测、remote auth、凭据、公开接口版本与许可证均有明确 Pass/Fail/Not-Proven 记录。
8. 时间盒结束必须产出 Provider 决策：采用、拒绝或“尚无生产 Provider 被证明”；最后一种不阻止 Fake contracts 下的 Foundation 开发，但阻止真实 Provider 的 Phase 1 发布。

多项目 UI、完整失败 Loop、移动驾驶舱、Archive/Knowledge 和混合 Agent 的端到端产品验收属于 Phase 1，统一以 [`../08-user-stories-and-acceptance.md`](../08-user-stories-and-acceptance.md) 为准，不塞进 1–2 周的 Phase 0 Spike。

### 12.2 Orca Go/No-Go

**Go：**

- 公开接口足以稳定创建/发现/控制 worktree 与 terminal。
- Windows 与重启恢复通过。
- 可关闭危险默认参数和遥测。
- Hunter 能独立保存所有 canonical state。
- 旁路集成的用户体验可以接受。

**No-Go / 时间盒后仍 Not-Proven / 启动备选 Spike：**

- 必须读写 Orca 私有数据库才能恢复。
- CLI/Runtime 接口无法做版本与契约测试。
- Windows 进程/PTY 长时间不稳定。
- 权限 bypass 不能可靠关闭。
- 许可证或品牌条款阻止目标分发。
- 必需可执行文件、账号、登录或公开接口在时间盒内无法取得；对“采用该 Provider”按未通过处理，但保留阻塞证据。

**考虑薄 Fork：**

- Sidecar 技术上通过，但统一导航/移动体验仍是决定性缺口。
- 修改面可以限制在 UI shell、扩展点和 Provider wiring。
- 有明确的上游同步、自动化 rebase、许可证与全平台发布预算。

## 13. 最终建议

### 13.1 产品选择

不直接采用任何一个现有产品作为 Hunter 的全部：

- 不把 OpenClaw/Hermes 当主产品。
- 不把 Goose/OpenCode/CodeBuddy/Codex 当工作流事实源。
- 不把 Microsoft Conductor 的模型节点当原生 Agent Session。
- 不把 Orca 的 terminal/worktree 状态当 Requirement/Step 状态。

Hunter 应保持一个主产品 Monorepo，内部是模块化单体：

```text
Hunter Workbench
  Project / Requirement / Change / Task / Workflow / Run / Artifact / Knowledge

Hunter Flow
  DAG / Step / Attempt / Loop / Gate / Verify / Recovery / Budget

Hunter Runtime Contracts
  WorkspaceProvider / ProcessHost / AgentConnector / SessionObserver
  NativeSurfaceOpener / ArtifactCollector / CompletionVerifier

Providers
  OrcaProvider（首个有时限候选）
  AgentOrchestratorProvider（备选）
  DirectCodexConnector
  DirectCodeBuddyConnector
  CursorHandoffConnector / CursorSdkConnector（验证后可选）
```

### 13.2 一句话取舍

> **Phase 0 先进行有时限、可逆的 Orca sidecar feasibility spike。只有公开 CLI 契约、Windows 终端/进程与重启恢复、权限/审批、remote auth、遥测、许可证及版本升级门槛全部通过后，才把 Orca 提升为产品 Runtime 依赖；Cursor 同时验证第一方 SDK。无论 Provider 选择如何，Hunter 始终持有 Requirement、Flow、Run、Evidence、Archive 与 Knowledge 的 canonical state。**

## 14. 官方来源索引

### Orca

- [官方仓库与 MIT 许可证入口](https://github.com/stablyai/orca)
- [官方 Releases](https://github.com/stablyai/orca/releases)
- [产品与 Worktree IDE 定位](https://www.onorca.dev/docs)
- [Windows/Linux 安装与更新](https://www.onorca.dev/docs/install)
- [CLI Reference](https://www.onorca.dev/docs/cli/reference)
- [Remote Orca Servers](https://www.onorca.dev/docs/remote-servers)
- [Mobile Companion](https://www.onorca.dev/docs/mobile)
- [Agent 状态与 Session](https://www.onorca.dev/docs/model/agents-sessions)
- [Supported Agents 与权限默认值](https://www.onorca.dev/docs/agents/supported)
- [Privacy & Telemetry](https://www.onorca.dev/docs/telemetry)

### Workbench、Runtime 与 Flow 候选

- [Agent Orchestrator](https://github.com/AgentWrapper/agent-orchestrator)
- [Agent Orchestrator 架构](https://github.com/AgentWrapper/agent-orchestrator/blob/main/docs/architecture.md)
- [Agent Orchestrator Windows Setup](https://github.com/AgentWrapper/agent-orchestrator/blob/main/SETUP.md)
- [Agent Orchestrator Apache-2.0 许可证](https://github.com/AgentWrapper/agent-orchestrator/blob/main/LICENSE)
- [Microsoft Conductor](https://github.com/microsoft/conductor)
- [strIDEterm 官网](https://strideterm.com/)
- [strIDEterm 仓库](https://github.com/jstradej/strideterm)
- [OpenADE 官网](https://openade.ai/)
- [OpenADE 仓库](https://github.com/bearlyai/OpenADE)
- [OpenWork 仓库](https://github.com/different-ai/openwork)
- [OpenWork 架构](https://github.com/different-ai/openwork/blob/dev/ARCHITECTURE.md)
- [Vibe Kanban 仓库](https://github.com/BloopAI/vibe-kanban)
- [Vibe Kanban 关闭公告](https://www.vibekanban.com/blog/shutdown)
- [Conductor.build Harnesses](https://www.conductor.build/docs/reference/harnesses)
- [Conductor.build 安装平台](https://www.conductor.build/docs/installation)
- [Agent Deck](https://github.com/asheshgoplani/agent-deck)
- [Agent of Empires](https://github.com/njbrake/agent-of-empires)

### 其他 Agent/Harness

- [OpenClaw 仓库](https://github.com/openclaw/openclaw)
- [OpenClaw Agent Runtimes](https://docs.openclaw.ai/concepts/agent-runtimes)
- [OpenClaw Windows](https://docs.openclaw.ai/platforms/windows)
- [Hermes Agent](https://github.com/nousresearch/hermes-agent)
- [Hermes Programmatic Integration](https://github.com/nousresearch/hermes-agent/blob/main/website/docs/developer-guide/programmatic-integration.md)
- [Hermes Native Windows Guide](https://github.com/nousresearch/hermes-agent/blob/main/website/docs/user-guide/windows-native.md)
- [Goose](https://github.com/aaif-goose/goose)
- [Goose Custom Distributions/Recipes/Subagents](https://github.com/aaif-goose/goose/blob/main/CUSTOM_DISTROS.md)
- [OpenCode](https://github.com/anomalyco/opencode)
- [OpenCode CLI/Server](https://dev.opencode.ai/docs/cli/)
- [OpenCode Windows/WSL](https://opencode.ai/docs/de/windows-wsl/)

### 首批 Connector

- [Codex app-server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Codex CLI](https://github.com/openai/codex/blob/main/README.md)
- [CodeBuddy Headless](https://www.codebuddy.ai/docs/cli/headless)
- [CodeBuddy ACP](https://www.codebuddy.cn/docs/cli/acp)
- [CodeBuddy HTTP API Beta](https://www.codebuddy.ai/docs/cli/http-api)
- [CodeBuddy Daemon](https://www.codebuddy.ai/docs/cli/daemon)
- [Cursor CLI Overview](https://cursor.com/docs/cli/overview)
- [Cursor CLI Output Format](https://cursor.com/docs/cli/reference/output-format)
- [Cursor CLI Installation](https://cursor.com/docs/cli/installation)
- [Cursor Desktop Download](https://cursor.com/download)
- [Cursor SDK 发布](https://cursor.com/changelog/sdk-release)
- [Cursor SDK 2026-06 更新](https://cursor.com/changelog/sdk-updates-jun-2026)
- [Cursor 服务条款](https://cursor.com/en-US/terms-of-service)

### 协议

- [ACP Introduction](https://agentclientprotocol.com/get-started/introduction)
- [ACP Architecture](https://agentclientprotocol.com/get-started/architecture)
- [ACP 官方仓库](https://github.com/agentclientprotocol/agent-client-protocol)
- [MCP 2025-11-25 Specification](https://modelcontextprotocol.io/specification/2025-11-25)
- [MCP Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [A2A 最新规范](https://a2a-protocol.org/latest/specification)
- [A2A 官方仓库](https://github.com/a2aproject/A2A)
