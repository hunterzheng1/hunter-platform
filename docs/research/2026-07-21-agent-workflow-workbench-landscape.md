# 多原生 Coding Agent 工作流工作台竞品与复用调研

> **支持性快照**：本文保留候选广度与 UX/实现证据；Agent Orchestrator
> 的当前许可证、Go-daemon 架构和最终优先级以
> [`2026-07-21-hunter-platform-landscape-and-reuse.md`](2026-07-21-hunter-platform-landscape-and-reuse.md)
> 为准。

> 调研日期：2026-07-21
> 目标：寻找最接近“多项目工作台 + 可配置 Hunter 工作流 + 同/异 Agent 分步执行 + 可视化线路与状态 + 产物/知识/需求统一管理 + Windows/Linux”的现有产品或开源底座。
> 证据范围：只采用项目官方文档、官方仓库、许可证、官方发布记录与官方公告。产品宣传中的能力视为“官方声称”，没有本机验证的部分不视为已经通过 Hunter 的可用性验证。

## 1. 结论先行

用户描述的最终产品，不是 OpenClaw 或 Hermes 那类“一个长期运行的通用 Agent”，也不只是一个多终端管理器。它实际是三个产品类别的交集：

1. **项目与知识工作台**：管理多个项目、需求、工作流模板、归档、知识、产物和执行历史。
2. **确定性工作流控制平面**：知道当前走到哪一步，按条件分支、循环、并行、审批、失败重试，并为每一步保存输入、输出和证据。
3. **原生 Coding Agent 会话平面**：真正启动、恢复、观察和切换 Codex、Claude Code、Cursor Agent、OpenCode、Pi 等工具，并尽可能保留各自优势。

截至 2026-07-21，**没有一个成熟产品同时把这三层做好**。最接近的能力已经分别存在：

- [Agent Orchestrator](https://github.com/AgentWrapper/agent-orchestrator) 最接近“多项目、原生 Agent、会话、worktree、PR/CI 反馈”的执行底盘。
- [Microsoft Conductor](https://github.com/microsoft/conductor) 最接近“可配置工作流、循环/并行/审批、线路亮灯、逐节点输出”的流程内核。
- [strIDEterm](https://github.com/jstradej/strideterm) 是最接近用户完整想象的小型一体化原型：跨平台客户端、多个项目、真实终端、Worker/Judge 异构 Agent 循环、进度页、移动访问；但它只有固定 Worker/Judge 流程，项目规模和治理成熟度都不足以直接押注。
- [OpenADE](https://github.com/bearlyai/OpenADE) 最接近“先形成可审核计划，再执行”的需求/计划体验，但流程固定、仅重点支持 Claude Code 与 Codex，Windows 仍标注实验性。
- [OpenWork](https://github.com/different-ai/openwork) 最接近“工作台、Skills、模板、产物、权限、远程客户端”的产品外壳，但底层绑定 OpenCode，真正的持久多步工作流、重试、移动端仍在路线图中。

因此，推荐路线不是再选一个 OpenClaw/Hermes 替代品，而是：

> **Hunter Workbench（产品与治理） + Hunter Flow（确定性工作流） + Native Agent Runtime（可替换执行适配层）**

首轮技术验证应优先评估：

- 用 Agent Orchestrator 的项目、会话、worktree、Agent 插件和 Windows ConPTY 能力作为 Native Agent Runtime 的参考实现或可复用底盘。
- 用 Microsoft Conductor 的 YAML 工作流、路由、循环、人类审批、事件流和实时 DAG 页面作为 Hunter Flow 的参考实现或可复用内核。
- Hunter 自己持有 Requirement、Workflow、Run、Step、Artifact、Evidence、Knowledge 等规范数据，不让任何第三方运行时成为事实来源。

这条路线与用户最新设想高度一致，也能解释为什么 OpenClaw/Hermes 让人感觉“形态不对”：它们解决的是 Agent runtime/gateway 问题，而不是一个面向开发过程的、可审计的项目工作流工作台。

## 2. 用户需求被重新抽象成什么

### 2.1 必须满足的产品能力

| 能力 | 用户可见结果 | 不能偷换成什么 |
|---|---|---|
| 多项目 | 客户端里创建、切换、搜索很多项目 | 只是在不同目录启动多个终端 |
| 项目级 Harness | 每个项目选择或定制自己的流程模板 | 只有全局固定 Prompt |
| 需求与实现隔离 | 需求先确认、版本化；实现 Run 引用一个确认版本 | 把用户一句 Prompt 当成永久需求 |
| 同/异 Agent 分步执行 | 规划、编码、测试、审查可用同一工具，也可分别绑定 Codex/Cursor/Claude/OpenCode/Pi | 只允许一个主 Agent 自己调用子 Agent |
| 真正的 Loop | Gate 不通过时回到指定步骤，并保存每次尝试 | Agent 自己在一轮对话里“多想几次” |
| 可视化路线 | 当前节点亮起，已完成、等待、失败、跳过、阻塞一目了然 | 只有一条不断滚动的终端日志 |
| 逐步产物 | 点击步骤看到计划、测试报告、审查结果、diff、日志、归档等 | 只有最终聊天答案 |
| 原生工具优势 | 尽可能保留 Codex、Cursor、Claude Code 等自身模型、工具、Skill、登录和会话能力 | 仅调用相同厂商模型 API |
| 快速接管 | 可从工作台跳转到真实终端、IDE 或原生工具处理 | 在工作台里重做每个 IDE |
| Windows 优先 | 原生 Windows 可安装、可执行、可恢复；Linux 最好同构 | “Windows 支持”实际只指 WSL |
| 可恢复执行 | 客户端重启后仍知道 Run 到哪一步、哪些 Agent 仍在运行 | 仅保留 UI 快照 |
| 移动查看/操作 | 手机看状态、批准、补充信息、暂停/继续；不要求手机本地跑 Agent | 只把桌面完整界面硬塞进手机 |

### 2.2 建议采用的核心领域对象

没有竞品完整提供以下模型，这恰恰是 Hunter 的差异化：

- Project：项目及仓库、环境、默认策略。
- Requirement：原始需求及澄清记录。
- RequirementRevision：不可变的需求版本。
- RequirementApproval：确认人、确认时间和确认范围。
- WorkflowTemplate：可版本化流程定义。
- WorkflowRun：某个需求版本的一次实现运行。
- StepDefinition：步骤目的、输入契约、输出契约、Gate 和允许的执行器。
- StepRun：一次具体尝试及状态、起止时间、重试关系。
- AgentBinding：此步骤绑定哪个 Agent、模型、配置、权限和运行方式。
- NativeSessionRef：上游工具的真实 session/thread/process 标识。
- WorkspaceRef：仓库、branch、worktree、容器或远程 workspace。
- Artifact：计划、设计、代码 diff、报告、图片、构建物等可查看产物。
- Evidence：命令、退出码、测试结果、审查结论、来源哈希等可验证证据。
- Approval：人类批准、拒绝或补充输入。
- KnowledgeCandidate：本次 Run 产生、等待提升为知识的内容。
- KnowledgeEntry：已经审核并可被后续 Run 检索的知识。

关键边界是：**RequirementRevision 与 WorkflowRun 分离**。需求确认后生成不可变版本；实现 Run 只能引用该版本。需求变化时创建新版本或变更单，不直接改写已经在执行的 Run 的历史依据。

## 3. 一览矩阵

符号：● 直接具备；◐ 部分具备或固定形态；○ 未见正式能力。

| 产品 | 多项目/客户端 | 原生外部 Agent | 可配置流程/Loop | 状态线路 | worktree/session | 需求/产物/知识 | Windows/Linux | 对 Hunter 的判断 |
|---|---:|---:|---:|---:|---:|---:|---|---|
| Agent Orchestrator | ● | ● | ◐ | ◐ | ● | ○ | Windows 原生 ConPTY；Linux tmux | **首选执行底盘候选** |
| Microsoft Conductor | ○ | ○/◐ | ● | ● | ○ | ◐ 输出，无项目资产模型 | Windows/Linux | **首选工作流内核候选** |
| strIDEterm | ● | ● | ◐ 固定 Worker/Judge | ◐ 轮次 Dashboard | ● | ◐ TASK/规则/日志 | Windows/Linux/macOS | **最接近的一体化原型，成熟度风险高** |
| OpenADE | ◐ | ◐ Claude/Codex | ◐ Plan→Revise→Execute | ◐ 线性 | ● | ◐ 计划/diff/快照 | Linux/macOS；Windows 实验性 | **需求到计划 UX 参考** |
| OpenWork | ● | ○，核心绑定 OpenCode | ◐ 模板；持久流程仍在路线图 | ◐ Todo 时间线 | ◐ Session | ● 产物/Skills/权限 | 文档对 Windows 状态不一致；Linux 可用 | **工作台与产物 UX 参考** |
| Conductor.build | ● | ● | ◐ 任务到 PR 的固定流程 | ◐ | ● | ◐ | 仅 macOS | **最佳商业 UX 标杆，不可作为跨平台开源底座** |
| Vibe Kanban | ● | ● | ○ | ◐ Kanban/执行状态 | ● | ◐ issue/diff/preview | Windows/Linux 可本地运行 | **已 sunset，只适合取材或审慎 fork** |
| Agent Deck | ● 分组/TUI/Web | ● | ◐ 由 Conductor Agent 自主调度 | ◐ 会话状态 | ● | ◐ Skill/MCP/日志 | Windows 仅 WSL；Linux/macOS | **会话与远程控制参考，不是确定性流程引擎** |
| Agent of Empires | ● | ● | ○ | ◐ 会话状态 | ● | ○ | Linux/macOS；Windows 非一等公民 | **终端编排参考** |
| OpenHands | ◐ | ◐ ACP 委派 | ◐ SDK 子 Agent | ◐ | ◐ Sandbox/Conversation | ○ | Linux；Windows 要 WSL | **Agent SDK，不是目标工作台** |
| Omnara | ◐ | ◐ 当前重点 Claude/Codex | ○ | ◐ | ◐ | ○ | Windows 客户端、Linux CLI；移动/Web | **移动接管参考；旧开源仓库已归档** |
| Coder | ● | ◐ | ◐ | ◐ | ● 远程 workspace | ○ | 浏览器跨平台 | **远程开发基础设施，不是本地工作流产品** |
| Daytona | ○ | ○ | ○ | ○ | ● Sandbox | ○ | Linux/Windows VM | **可选隔离执行基础设施** |
| Temporal | ○ | ○ | ● 代码式持久流程 | 运维型 | ○ | ○ | 服务端跨平台 | **以后需要高可靠时再评估，V1 过重** |
| Conductor OSS | ○ | ○，需自建 Worker | ● | ● 运维型 | ○ | ◐ 步骤 I/O | Java/Docker 跨平台 | **强持久引擎备选，产品适配量大** |
| n8n | ● Web/项目 | ○，需命令或自定义节点 | ● | ● | ○ | ◐ 通用执行数据 | 跨平台部署 | **外部自动化集成，不应做 Coding Agent 核心** |
| Dagster | ● | ○ | ● | ● | ○ | ◐ 数据资产 | 跨平台部署 | **数据工程语义误匹配** |

## 4. 最接近的五个产品

### 4.1 Agent Orchestrator：最接近 Native Agent Runtime

官方仓库将其定位为并行 Coding Agent 的 orchestration layer：每个 issue 创建隔离 git worktree、分支和 PR；CI 失败、review comment、合并冲突可以反馈给原会话继续处理。它有本地 Web Dashboard，并通过插件槽拆分 Agent、Runtime、Workspace、Tracker、SCM、Notifier、Terminal。

官方当前列出的关键能力包括：

- 多项目配置和本地 Dashboard。
- Agent 插件：Claude Code、Codex、Aider、Cursor、OpenCode、Kimi 等。
- macOS/Linux 默认 tmux；Windows 默认 process runtime，使用原生 ConPTY，不强制 tmux/WSL。
- worktree/clone workspace。
- GitHub、Linear、GitLab 等 tracker/SCM 适配。
- CI failed、changes requested 等 reaction，可自动回送 Agent。
- 通过 Web Terminal 查看真实会话。

为什么非常接近：

- 它已经解决了 Hunter 最容易低估的脏活：进程生命周期、PTY、Windows 路径、worktree、会话状态、PR/CI 反馈和多项目。
- 插件边界比 fork 一个大一统 Agent runtime 更贴近“工具会变化，Hunter 保持中立”的要求。
- 原生 CLI Agent 仍保留自己的登录、模型和工具，而不是被替换成一个统一模型 API。

关键缺口：

- 核心抽象是 issue/session/PR，而不是版本化 WorkflowRun/StepRun。
- reaction 是围绕 CI/Review 的固定反馈，不等于任意 DAG、条件分支、人工 Gate 和跨步骤产物契约。
- 没有正式的 Requirement、Artifact、Evidence、Knowledge Promotion 模型。
- “运行某 Agent CLI”不等于“复用 Codex Desktop 或 Cursor IDE 的全部 UI”。工作台需要另外做 handoff/open-in-native 能力。

复用判断：

> **直接进入技术 Spike。优先考虑把它作为独立可替换 runtime provider，或复用其插件/PTY/worktree 思路；不要把 Hunter 的 canonical 状态写进它的私有数据模型。**

来源：[官方仓库与 README](https://github.com/AgentWrapper/agent-orchestrator)、[当前项目配置与插件说明](https://github.com/AgentWrapper/agent-orchestrator#configuration)。

### 4.2 Microsoft Conductor：最接近 Hunter Flow

Microsoft Conductor 是 MIT 许可的 YAML 多 Agent 工作流工具。它的核心不是让一个主 Agent 自由决定下一步，而是用确定性规则运行流程：

- Agent、Prompt、输入输出和 route 均在 YAML 中版本化。
- 支持条件路由、静态/动态并行、子工作流、script、set、wait、terminate。
- 可通过 route-back 构造循环，并有最大迭代和超时。
- 支持 human-in-the-loop Gate。
- Web Dashboard 有可交互 DAG，执行中的边会动画高亮。
- 点击节点可看 Prompt、模型、token/cost、activity 和 output。
- 有 Log、Activity、Output 三类视图。
- 提供 Windows PowerShell 安装和 Windows 开发说明。

它几乎逐字实现了用户说的“执行线路亮灯”和“看到每一步产物”。

关键缺口：

- 当前 Agent 主要是 GitHub Copilot SDK、Anthropic SDK 或兼容模型端点，并不是 Codex/Cursor/OpenCode/Pi 的真实 native session。
- 没有项目组合、git worktree、终端、IDE、PR 工作区生命周期。
- 节点 output 是流程上下文，不是 Hunter 所需的可治理 Artifact/Evidence/Knowledge。
- 官方材料证明了 background mode、日志和事件，但不能据此假定它已具备 Temporal/Conductor OSS 级别的跨崩溃长周期持久执行；必须实测。

复用判断：

> **直接进入技术 Spike。最值得尝试的是新增 NativeAgentStepExecutor：工作流节点不直接调用模型 SDK，而是向 Agent Runtime 请求一个真实会话，并把 session、artifact 和 evidence 写回 Hunter。**

来源：[官方仓库、功能与 Dashboard 说明](https://github.com/microsoft/conductor)、[许可证](https://github.com/microsoft/conductor/blob/main/LICENSE)。

### 4.3 strIDEterm：最接近完整想象，但不是稳妥底座

strIDEterm 是 MIT 许可 Electron 客户端，官方提供 Windows 签名安装器、Linux AppImage/deb 和 macOS 包。它支持：

- 多 workspace、profile、多窗口、拆分布局。
- Shell、Claude Code、Codex、Gemini CLI、Copilot CLI、OpenCode 和自定义命令模板。
- git/worktree、真实终端、文件管理、浏览器、PR Review。
- Agent Task Runner：Worker 和 Judge 可分别选择不同 CLI Agent；在每轮之间跑确定性检查，Judge 看 git diff，直到通过。
- TASK.md、WORKER.md、TODO/WORK_LOCK 协议和逐轮 Dashboard。
- LAN/Cloudflare 远程 Web、手机响应式界面、Telegram 启动/暂停/恢复 Agent、截图和取文件。

它证明了用户设想在 Windows/Linux 桌面端上完全可行，而且无需先造一个 OpenClaw/Hermes 式主 Agent。

关键缺口：

- Workflow 只有固定 Worker/Judge 形态，不能表达需求确认→规划→实现→测试→审查→归档→知识提升等任意图。
- 状态协议仍高度依赖文件与 CLI 行为；跨 Agent 的结构化事件深度有限。
- 仓库社区体量很小。官方页面显示约 12 stars、单一主仓库但有大量提交；功能广度相对于维护者规模意味着必须做源码、安全、升级和 bus-factor 审计。
- 没有正式需求版本和知识治理。

复用判断：

> **适合做安装体验和一体化 Loop 的对照样机，也可审计后取材；不建议仅凭功能清单把 Hunter 建在它上面。**

来源：[官方仓库、功能、平台与 Task Runner](https://github.com/jstradej/strideterm#features)、[Agent Task Runner 说明](https://github.com/jstradej/strideterm#agent-task-runner)。

### 4.4 OpenADE：最接近需求/计划确认体验

OpenADE 的核心交互是 Plan → Revise → Execute：

- 先让 Agent 形成详细计划。
- 用户可对计划、文件、diff 和 Agent 消息做行内评论。
- HyperPlan 可让多个 Agent 跨 provider 并行规划，再 ensemble 或 cross-review 汇总。
- 计划确认后线性执行。
- 支持 Claude Code/Codex、worktree、git patch 快照与回滚、文件/diff/terminal/process。

这为 Hunter 的“需求先确认、实现后开始”提供了很好的交互参考。

关键缺口：

- Plan 不等于独立的 Requirements 系统；缺少需求版本、批准记录、变更单和跨 Run 追踪。
- 执行流固定，不能自由绑定任意步骤和 Agent。
- 重点支持 Claude Code/Codex。
- 官方明确把 Windows 标为 experimental、largely untested，并建议更可靠时使用 WSL，因此不满足“Windows 必须稳”的底座条件。

复用判断：

> **借鉴 Requirement Draft、Plan Review、锁定后执行、快照回滚的 UX；不作为 Windows 主底座。**

来源：[官方仓库 README](https://github.com/bearlyai/OpenADE)、[官方下载与 Windows 状态](https://github.com/bearlyai/OpenADE#download)。

### 4.5 OpenWork：最接近工作台和资产外壳

OpenWork 是 MIT 许可、Tauri 桌面 + Web/Server 形态，核心由 OpenCode 驱动。已公开能力包括：

- 本地 Host 与远程 Client。
- Session、SSE 流、OpenCode Todo 时间线和权限响应。
- 工作流模板、Skills/Plugins/MCP 管理。
- 产物预览、编辑、下载和再次打开。
- 组织、成员、角色、能力目录。
- 通过 MCP 把 OpenWork 能力暴露给 Codex、Claude、Cursor、OpenCode。

它的产品壳非常接近 Hunter Workbench，但“通过 MCP 给其他 Agent 提供 OpenWork 能力”并不等于“管理这些 Agent 的真实会话”。

关键缺口：

- canonical execution loop 仍是 OpenCode，不是中立的多原生 Agent runtime。
- 路线图截至本次调研仍把 persistent hosted workspaces、long-running/background tasks 标为 Building，把 scheduled workflows、mobile、human approvals/resumable runs、retries/logs/run history 标为 Next。
- 官方仓库 README 与产品路线图对 Windows 可用状态存在不一致表述：仓库称 Windows 通过付费支持方案获取，而路线图/发布材料另有“live”描述。不能把它当成已验证的一等 Windows 基础。

复用判断：

> **借鉴 Workbench、Artifact、Skill、Permission、Remote Client 的信息架构；除非其 runtime 抽象真正解耦，否则不直接采用为多 Agent 核心。**

来源：[官方仓库](https://github.com/different-ai/openwork)、[官方路线图](https://openworklabs.com/docs/roadmap)。

## 5. 其他重要产品：能借什么、为什么不直接选

### 5.1 Conductor.build：最成熟的 UX 标杆

[Conductor.build](https://www.conductor.build/docs) 是商业 macOS App，支持 Claude Code、Codex、Cursor、OpenCode；每个 workspace 有独立 worktree、branch、files、terminal、diff、checks、PR 和 archive，也支持同 workspace 多 Agent 或多 workspace 并行。

它非常接近 Hunter 工作台的日常使用感，但：

- [官方安装文档](https://www.conductor.build/docs/installation) 明确目前只有 macOS，没有 Windows/Linux。
- 没有对外开源底座。
- 它的“workflow”是从任务到 workspace/PR 的产品流程，不是可任意配置的 DAG。

判断：**作为 UI、workspace、open-in-tool、review/merge/archive 的标杆，不是可复用底座。**

### 5.2 Vibe Kanban：历史上很接近，当前维护风险决定不能押注

[Vibe Kanban](https://github.com/BloopAI/vibe-kanban) 有 Kanban、workspace/branch/terminal/dev server、diff comments、preview、PR，以及 Claude Code、Codex、Gemini CLI、Copilot、Amp、Cursor、OpenCode 等 10+ Agent。

但公司在 [2026-04-10 官方公告](https://www.vibekanban.com/blog/shutdown) 中宣布关闭，项目转为社区维护，远程服务在 30 天后移除，只有本地 workspace 继续。官方仓库最新发布停在 2026-04-24 附近。

判断：**Apache-2.0 代码仍值得研究 executor、workspace、diff 和 preview；不应把 Hunter 的未来依赖其原团队持续维护。**

### 5.3 Agent Deck：很强的会话层，但不是可审计流程

[Agent Deck](https://github.com/asheshgoplani/agent-deck) 是 tmux/TUI/Web 会话管理器：

- 多 Agent 状态：running、waiting、idle、error。
- session fork/resume、worktree、Docker sandbox、MCP/Skill manager。
- “Conductor”是一个常驻 Claude/Codex 会话，监控其他会话、在有把握时回复、否则升级给人。
- Telegram/Slack 远程控制、watcher 和状态通知。

它值得借鉴会话池、状态检测、父子 session、移动通知和 agent-neutral Skill 管理。但其 Conductor 本质仍是“让一个 LLM Agent 自主当管理者”，不是定义明确、可重放、逐步产物有契约的工作流引擎；Windows 官方路径是 WSL。

判断：**可借会话和远程控制，不作为 Hunter Flow。**

### 5.4 Agent of Empires：真实终端编排器

[Agent of Empires](https://github.com/njbrake/agent-of-empires) 将 tmux、Agent 状态、worktree、Docker、Web Dashboard、手机访问和 diff 放在一起。它证明“保留原生 TUI + 统一状态”是可行的。

缺口仍是无需求模型、无任意工作流图、Windows 不是一等路径。判断：**终端编排参考。**

### 5.5 OpenHands：可用 SDK/ACP，但产品形态不匹配

[OpenHands Software Agent SDK](https://docs.openhands.dev/sdk/index) 有 Python/REST API、Agent Server、持久 conversation、子 Agent 委派和恢复；[ACPAgent](https://docs.openhands.dev/sdk/guides/agent-acp) 可启动 ACP server 并以 JSON-RPC 委派。

但其默认产品仍围绕 OpenHands 自身 Agent loop；没有现成的多项目 Hunter 流程、原生 Agent 窗口、需求/知识/归档工作台。[官方 CLI 文档](https://docs.openhands.dev/openhands/usage/cli/quick-start) 也明确 Windows 需要 WSL。

判断：**适合当某类 Agent Provider 或 SDK 参考，不适合直接变成 Hunter 产品。**

### 5.6 Omnara：移动端经验很有价值，但旧开源路线已经证明 wrapper 成本

[Omnara 旧开源仓库](https://github.com/omnara-ai/omnara) 曾把 Claude Code/Codex 的终端会话同步到 Web、iOS、Android，并支持远程启动和人类输入。仓库已于 2026-02-02 归档；官方说明称持续追随 Claude Code CLI 更新的 wrapper 难以维护，因此转向基于自有 Agent SDK 的新平台。

这个案例有双重价值：

- 移动端最好做“状态、审批、补充输入、暂停/继续”，而不是手机本地运行开发环境。
- 仅靠抓 CLI/UI 来深度复刻原生 Agent，长期维护成本很高；Hunter 必须采用结构化协议优先、PTY 兜底的分层适配。

判断：**移动 Companion 设计参考；不依赖旧代码或当前闭源平台。**

### 5.7 新兴小项目观察名单

- [charannyk06/conductor-oss](https://github.com/charannyk06/conductor-oss)：本地 Dashboard、真实 PTY、worktree、Markdown Board、Codex/Claude/Gemini/Cursor/OpenCode/Pi 等大量适配，甚至提供 MCP/ACP server；形态很接近。但它不是 Netflix-origin Conductor，项目社区和治理规模很小，流程只是 Board lifecycle，不是任意 DAG。应做安全与代码来源审计后再考虑取材。
- [Agent Workspace](https://github.com/web3dev1337/agent-workspace)：多项目、Windows/Linux 客户端、worktree、终端网格、diff、任务板；仍缺确定性工作流和资产契约，适合作为布局参考。
- [CORAL](https://github.com/Human-Agent-Society/CORAL)：让 Claude/Codex/Cursor/OpenCode 等在各自 worktree 中运行，以共享目录、grader 和 manager heartbeat 做长期搜索/演化。它的“评估驱动 Loop”和共享状态值得借鉴，但定位是 autoresearch，不是通用开发工作台。

这些项目说明市场正在快速向用户设想的方向收敛，但也说明不应只看功能数量：小项目往往通过 PTY 和文件约定快速覆盖很多 Agent，结构化状态、权限、安全、升级兼容和崩溃恢复才是长期难点。

## 6. 通用工作流与基础设施产品

### 6.1 Temporal：可靠，但 V1 明显过重

[Temporal](https://docs.temporal.io/) 的优势是 crash-proof execution：进程、网络或基础设施失败后，数秒到数年仍能恢复到原位置。它适合长周期、强可靠、跨服务工作流。

缺点是：

- 没有 Coding Agent、worktree、终端、artifact、requirement 语义。
- 工作流 UI 偏运维历史，不是用户想要的可视化工作台。
- 本地个人桌面产品一开始引入完整 Temporal Server/Worker 会显著增加部署和开发复杂度。

判断：**先用本地 SQLite event log + 幂等 Step Executor 验证产品；当真正出现跨机器、长周期、企业级可靠性需求，再评估 Temporal。**

### 6.2 Conductor OSS：比 Temporal 更声明式，但仍是服务器引擎

[Netflix-origin Conductor OSS](https://github.com/conductor-oss/conductor) 是 Apache-2.0 持久工作流引擎，支持 SWITCH、DO_WHILE、FORK_JOIN、SUB_WORKFLOW、HUMAN、重试、超时、步骤 I/O、重放和内置 UI，也增加了 LLM/MCP task。

它的优势是声明式图和完整执行历史，缺点是：

- Java/Docker/数据库服务体量明显大于 Microsoft Conductor。
- 必须为每个 native coding agent 自建 Worker/adapter。
- UI 是通用流程运维 UI，不是多项目开发工作台。

判断：**如果 Microsoft Conductor 的持久恢复实测不合格、且 Hunter 很早就需要真正 durable execution，它是比从零造状态机更稳的备选；否则不是 V1 首选。**

### 6.3 n8n：适合作为外围自动化，不是核心

[n8n](https://docs.n8n.io/) 有可视化流程、项目、分支/循环/wait、执行历史、失败重试、人工审批和大量 SaaS 连接器，适合把 Hunter 与飞书、Telegram、GitHub、日历、邮件等连接。

但它不知道 native Agent session、worktree、IDE、diff、技能和项目知识；通过 Execute Command 启动 CLI 只得到低层进程，不会自动变成可靠 Coding Agent adapter。其源码受 [Sustainable Use License](https://docs.n8n.io/sustainable-use-license/) 约束，也不是普通宽松开源底座。

判断：**把它当外部事件/通知集成器，不让它持有 Hunter Run 的 canonical state。**

### 6.4 Dagster：语义误匹配

[Dagster](https://docs.dagster.io/) 明确是为数据工程设计的 asset、lineage 和数据可观测性 orchestrator。虽然它也能画图、重试和调度，但将 Requirement、Code Change、Review、Knowledge 硬映射成数据资产会扭曲领域模型。

判断：**不采用。**

### 6.5 Coder 与 Daytona：可选远程/隔离执行层

[Coder Tasks](https://coder.com/docs/ai-coder/tasks) 曾提供每任务一个隔离 Coder workspace、Agent 日志与暂停恢复，支持 Claude/Aider/Goose/自定义 MCP Agent；但官方已宣布从 v2.37 开始移出普通发行，转 ESR，并推荐 [Coder Agents](https://coder.com/docs/ai-coder/agents)。Coder Agents 又是 Coder 自己的 Agent loop，不是原生 Codex/Cursor 会话。

[Daytona Sandboxes](https://www.daytona.io/docs/en/sandboxes/) 提供 Linux 容器、Linux VM、Windows VM、快照、fork、pause/resume 和 API。

判断：

- 它们都能成为 Hunter 的 RemoteWorkspaceProvider 或 SandboxProvider。
- 它们不能替代 Workbench、Flow 或 Native Agent Adapter。
- 本地 Windows V1 不应为了“未来可能远程”先绑定其中一个；接口先留出即可。

## 7. 三种“Agent 接入”必须明确区分

用户要求保留各工具优势，不能只写一个统一 Agent 接口就宣称完成。建议每个 Adapter 声明能力等级：

### Level A：结构化原生协议

例如 app-server、SDK、ACP、正式 JSON/SSE/WebSocket API。

可获得：

- 真实 session/thread id。
- 结构化消息、工具调用、审批、token、状态。
- 可靠 resume/steer/cancel。
- 更容易把步骤产物和证据绑定到源事件。

这是优先级最高的接入。

### Level B：受管 Headless CLI

通过官方 CLI 非交互模式、JSON 输出、hook 和退出码运行。

可获得：

- 比 PTY 更稳定的输入输出。
- 适合无人值守的 Step。
- 通常仍能使用上游登录、模型和 Skill。

但可能失去部分交互式 UI 能力。

### Level C：真实 PTY/TUI

在 ConPTY、tmux 或 PTY 中运行原生工具，完整保留交互体验，并允许用户接管。

优点是覆盖面最广；缺点是：

- waiting/running/completed 状态常靠 hook、窗口标题、静默时间或文本规则推断。
- 上游 UI 变化会破坏解析。
- 很难可靠提取工具调用、审批和产物。

因此 PTY 应是兼容兜底，不应成为 Hunter Flow 判断步骤成功的唯一证据。

### Native App Handoff：单独一项能力

“快捷打开 Codex/Cursor 窗口”与“Hunter 自动控制该会话”是两件事。Adapter 应分别声明：

- canLaunchManagedSession
- canResumeManagedSession
- canOpenNativeUI
- canAttachExistingSession
- canStreamStructuredEvents
- canAcceptSteering
- canCollectArtifacts

如果上游没有稳定 deep link/session API，Hunter 至少可以：

- 在正确 worktree 打开系统终端并启动/恢复 CLI。
- 在 Cursor/VS Code 打开正确目录。
- 展示需复制的 session id 和恢复命令。

绝不能把“能打开应用”误报成“能无损接管应用内部现有会话”。

## 8. 推荐的最终产品边界

### 8.1 Hunter Workbench

用户每天直接使用的客户端：

- 项目首页和全局运行中心。
- Requirements Inbox、澄清、版本、批准和变更。
- Workflow Designer/Template Library。
- Run 页面：DAG 线路、当前亮灯节点、并行分支、Gate、重试次数。
- Step 页面：输入、Agent、会话、日志、diff、Artifact、Evidence、成本。
- Artifact/Archive/Knowledge 浏览器。
- Agent/Model/Skill/Policy 配置。
- “Open in Codex/Cursor/Terminal/Explorer”。
- 手机 Web/消息入口：查看、审批、补充、暂停/继续。

建议技术形态是 **本地 Web-first UI + 可选 Tauri 桌面壳**：同一个 UI 可在 Windows/Linux 桌面、浏览器和手机使用；本地 daemon 才拥有进程、PTY、文件和 worktree 权限。首版不需要单独开发原生手机 App。

### 8.2 Hunter Flow

可测试、确定性的流程内核：

- versioned workflow definition。
- sequence、parallel、condition、loop、subflow、human gate。
- 每步重试、超时、取消、补偿和幂等键。
- 事件日志和崩溃恢复。
- Step input/output schema。
- Artifact/Evidence contract。
- 同一 Agent 连续执行或不同 Agent handoff。
- WorkflowRun 引用不可变 RequirementRevision。

### 8.3 Native Agent Runtime

可替换的执行 provider：

- 管理 project/workspace/worktree。
- 探测 Agent 安装和登录状态。
- 启动、恢复、steer、cancel、attach、open native UI。
- 结构化协议优先，Headless/PTY 兜底。
- 统一状态投影，但保留 provider 原始事件。
- Adapter 契约测试，避免某个上游更新悄悄破坏 Loop。

### 8.4 Artifact 与 Knowledge 平面

不要把 terminal transcript 当知识库。需要区分：

- Raw Event：不可变原始事件。
- Log：供人阅读的执行日志。
- Artifact：步骤声明交付物。
- Evidence：可验证成功依据。
- Archive：一次 Run 的冻结快照。
- KnowledgeCandidate：从 Archive 提取、等待审核的候选。
- KnowledgeEntry：正式知识，带来源、适用范围、失效条件。

## 9. 推荐复用策略

### 9.1 直接进入 Spike

1. **Agent Orchestrator**
   - 验证 Windows ConPTY、Codex/Claude/OpenCode/Cursor adapters。
   - 验证多项目、worktree、resume、真实终端、API/事件边界。
   - 判断是进程外 provider、复用 package，还是仅取架构。

2. **Microsoft Conductor**
   - 用一个五步 Hunter 流程验证 DAG、loop、gate、并行、恢复。
   - 实现最小 NativeAgentStepExecutor，调用 AO 或 Hunter mock runtime。
   - 验证 Dashboard 是否可嵌入、事件模型是否能投影到 Hunter StepRun。

3. **strIDEterm**
   - 安装 Windows 包，实际跑 Codex Worker + Claude/OpenCode Judge。
   - 验证移动 Web/Telegram。
   - 用它测量“现成一体化体验”与 Hunter 目标的差距。

### 9.2 主要借鉴，不直接作为核心

- OpenADE：需求草稿、计划行内评审、锁定后执行、快照回滚。
- OpenWork：Artifact、Skill/Plugin、Permission、Remote Client、组织能力。
- Conductor.build：workspace、native harness controls、diff/check/PR/archive UX。
- Vibe Kanban：Kanban、executor、diff comments、preview、open-in-editor。
- Agent Deck：会话状态、parent/child session、remote conductor、watcher。
- Omnara/strIDEterm：移动状态、审批、补充输入和远程接管。

### 9.3 不作为核心底座

- OpenClaw/Hermes：产品中心仍是一个通用 Agent/Gateway，而不是开发过程控制平面；可以以后作为某个 AgentProvider 或 ChannelProvider。
- OpenHands：自有 Agent SDK/runtime，不是多原生工具工作台。
- Coder/Daytona：workspace/sandbox 基础设施。
- n8n：外围自动化。
- Dagster：领域语义错误。
- Temporal/Conductor OSS：除非可靠性需求已经证明，否则 V1 复杂度过高。

## 10. 最大的市场空白，也是 Hunter 的机会

现有产品普遍擅长以下某一段：

- 让很多 CLI Agent 同时跑。
- 给每个任务创建 worktree。
- 用 Kanban 看 issue/session。
- 显示终端、diff、PR。
- 用一个主 Agent 监控其他 Agent。
- 用通用工作流引擎画 DAG。

但普遍缺少：

1. **需求与实现的正式隔离和追踪。**
2. **可配置的开发治理流程，而不是固定 task→code→PR。**
3. **每步 Artifact 与 Evidence 契约。**
4. **同一个流程中自由混用原生 Codex/Cursor/Claude/OpenCode/Pi。**
5. **结构化协议、headless、PTY 和 native handoff 的分级接入。**
6. **Archive→Knowledge 的受控提升。**
7. **一个能在 Windows 真正稳定运行，同时又能从手机监督的本地优先客户端。**

这意味着 Hunter 不需要和 Codex、Cursor、Claude Code 竞争“谁写代码最好”。Hunter 的产品价值是：

> **让需求、流程、Agent 会话、证据和知识保持连续，而执行工具可以每天更换。**

## 11. 建议的最小可行版本

为了避免再次做成“大而全 Gateway”，首版只做一条可证明价值的竖切：

1. Windows 本地 daemon + Web UI，可选 Tauri 壳。
2. 创建/导入多个本地 Git 项目。
3. 一个版本化 Workflow：需求确认 → 计划 → 实现 → 测试 → 审查 → 归档。
4. 每步可绑定 Codex、Claude Code、OpenCode 中任一个；同一 Agent 连续或混用均可。
5. 每个 Run 一个受管 worktree。
6. DAG 页面显示 pending/running/waiting/blocked/failed/succeeded/skipped。
7. 点击节点看真实会话、日志、Artifact、Evidence 和 diff。
8. Test/Review 不通过能沿显式路线回到 Implement，尝试记录不覆盖。
9. 一键在正确目录打开终端、Cursor/VS Code；能恢复的 Agent 使用真实 session id。
10. 手机浏览器只做状态、审批、补充输入、暂停/继续。
11. Run 完成后生成 Archive，并让用户选择哪些内容提升为 Knowledge。

只有这条竖切跑通后，再加入：

- 图形化 Workflow Designer。
- 独立 Requirements 模块。
- 更多 Agent 和深层 native protocol。
- 飞书/Telegram。
- Remote workspace/sandbox。
- 团队权限和跨设备同步。
- Temporal/Conductor OSS 级 durable engine。

## 12. 必须用实测回答的问题

官方资料不足以替代下列本机验证：

### Agent Orchestrator

- Windows ConPTY 长时间运行、重启恢复和 Unicode/ANSI 是否稳定？
- Codex、Claude Code、OpenCode、Cursor 插件分别保留多少原生能力？
- 是否有足够稳定的外部 API/event stream，还是必须 fork/嵌入 package？
- 一个 Workflow Step 如何绑定已有 session，而不是每次开新会话？

### Microsoft Conductor

- 进程崩溃、机器重启后 Run 能否从安全位置恢复？
- route-back loop 的每次尝试是否都能完整保留，而不是覆盖节点 output？
- Dashboard 组件和事件是否容易嵌入另一个产品？
- 自定义 executor 是否能完全绕开内置 SDK Agent？

### strIDEterm

- Worker/Judge 在 Windows 上实际稳定性、状态检测准确率和权限行为。
- Telegram 与远程 Web 的安全边界。
- 源码结构、依赖供应链、自动更新、密钥存储和单维护者风险。

### 原生应用 Handoff

- Codex Desktop、Cursor、Claude Code、OpenCode 各自是否有正式 deep link、session attach/resume 或 app-server/ACP。
- 哪些只能“打开目录”，哪些可以“打开同一会话”。

## 13. 最终判断

对用户最新设想，最合理的不是继续在 OpenClaw 与 Hermes 之间二选一，也不是把 Hunter Harness 变成另一个 Agent。

更准确的产品定义是：

> **Hunter 是本地优先、Windows 优先的多项目 Agent Development Control Plane：它把已确认需求变成可视化、可循环、可审计的开发工作流；每个步骤可以交给不同原生 Coding Agent；所有会话、产物、证据、归档和知识统一追踪，同时允许用户随时回到原生工具。**

推荐组合是：

1. **Hunter 自己拥有产品模型和 UI。**
2. **优先验证 Microsoft Conductor 作为流程内核。**
3. **优先验证 Agent Orchestrator 作为 native session/worktree runtime。**
4. **用 OpenADE、OpenWork、Conductor.build、strIDEterm 的成熟交互补齐 Workbench。**
5. **保持 Provider Ports；任何第三方均可替换，不让上游产品拥有 Hunter 的事实状态。**

如果两项 Spike 都合格，Hunter 不必从零发明 PTY/worktree 或 DAG；如果其中一项不合格，也只替换对应层，不推倒整个产品。

## 14. 官方来源索引

### Coding Agent 工作台与会话管理

- [Agent Orchestrator 官方仓库](https://github.com/AgentWrapper/agent-orchestrator)
- [strIDEterm 官方仓库](https://github.com/jstradej/strideterm)
- [OpenADE 官方仓库](https://github.com/bearlyai/OpenADE)
- [OpenWork 官方仓库](https://github.com/different-ai/openwork)
- [OpenWork 官方路线图](https://openworklabs.com/docs/roadmap)
- [Conductor.build 官方文档](https://www.conductor.build/docs)
- [Conductor.build 平台支持](https://www.conductor.build/docs/installation)
- [Conductor.build Harness 列表](https://www.conductor.build/docs/reference/harnesses)
- [Vibe Kanban 官方仓库](https://github.com/BloopAI/vibe-kanban)
- [Vibe Kanban 关闭公告](https://www.vibekanban.com/blog/shutdown)
- [Agent Deck 官方仓库](https://github.com/asheshgoplani/agent-deck)
- [Agent of Empires 官方仓库](https://github.com/njbrake/agent-of-empires)
- [Omnara 旧开源仓库与迁移公告](https://github.com/omnara-ai/omnara)

### Agent SDK、工作流与执行基础设施

- [Microsoft Conductor 官方仓库](https://github.com/microsoft/conductor)
- [OpenHands SDK](https://docs.openhands.dev/sdk/index)
- [OpenHands ACP Agent](https://docs.openhands.dev/sdk/guides/agent-acp)
- [OpenHands Windows/CLI 说明](https://docs.openhands.dev/openhands/usage/cli/quick-start)
- [Temporal 官方文档](https://docs.temporal.io/)
- [Conductor OSS 官方仓库](https://github.com/conductor-oss/conductor)
- [n8n 官方文档](https://docs.n8n.io/)
- [n8n Sustainable Use License](https://docs.n8n.io/sustainable-use-license/)
- [Dagster 官方文档](https://docs.dagster.io/)
- [Coder Tasks 官方文档与退役计划](https://coder.com/docs/ai-coder/tasks)
- [Coder Agents 官方文档](https://coder.com/docs/ai-coder/agents)
- [Daytona Sandboxes 官方文档](https://www.daytona.io/docs/en/sandboxes/)

### 新兴项目观察

- [charannyk06/conductor-oss](https://github.com/charannyk06/conductor-oss)
- [Agent Workspace](https://github.com/web3dev1337/agent-workspace)
- [CORAL](https://github.com/Human-Agent-Society/CORAL)
