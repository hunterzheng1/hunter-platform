# Hermes Agent 与 OpenClaw：作为 Hunter 底座的适配性比较

> **历史快照（已被取代）**：本文只保留为候选基座比较证据。Hunter Platform
> 已明确不以 OpenClaw、Hermes 或任何单一 Agent/Gateway 作为产品底座；当前
> 结论见 [`2026-07-21-hunter-platform-landscape-and-reuse.md`](2026-07-21-hunter-platform-landscape-and-reuse.md)。

> 调研日期：2026-07-21
> 范围：NousResearch/Hermes Agent 与 OpenClaw。只引用官方 GitHub、官方文档及官方发布记录。
> 说明：本文中的 “Hermes” 指 [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)，不是同名模型、区块链项目或其他 Hermes 产品。

## 结论摘要

Hermes 不是一个应该被忽略的次级候选。以 2026-07-21 的官方能力看，它已经具备原生 Windows、桌面应用、消息网关、持久会话、自学习记忆、Agent Skills、MCP、ACP Server、多 Agent Profile、持久 Kanban、worktree、插件和可扩展 Dashboard。若目标是得到一个统一、长期学习、由自己选择模型的个人 Agent，Hermes 很可能比 OpenClaw 更贴近需求。

但 Hunter 当前更关键的目标不是“选择一个最好的新 Agent”，而是：

- 继续使用 Codex、Claude Code、Cursor、OpenCode、Pi 等各自的原生能力；
- 在它们之上增加统一任务、会话、移动端控制、审批、证据和工作流；
- 今天更换领先工具时，不必更换整个 Hunter 底座。

对这个目标，OpenClaw 目前仍然更合适。决定性差异不是渠道数量、记忆或聊天体验，而是 **OpenClaw 已把不同 coding agent 当作可被管理的 runtime/session**：Codex 有原生 app-server runtime，Claude Code、Cursor、OpenCode、Pi 等通过 ACP/acpx 进入统一会话控制面。Hermes 的主产品仍然是自己的 `AIAgent`；ACP 的稳定产品面主要是“把 Hermes 暴露给编辑器”，外部 coding CLI 目前主要通过 Skill + PTY 调用，通用 ACP Client 仍处在提案/PR 路径。

因此建议不是排除 Hermes，而是把 Phase 0 改成真正的双底座 bake-off：

1. `OpenClaw + 最薄 Hunter Bridge`；
2. `Hermes + 最薄 Hunter Plugin/Dashboard Extension`；
3. 用 Codex、Claude Code、Cursor/OpenCode/Pi 中至少三个代表性 Agent 跑同一组启动、继续、停止、审批、移动端、worktree、证据和恢复测试。

若测试目标仍是“多原生 Agent 联邦”，OpenClaw 是默认领先者；若测试后发现日常工作实际上可以收敛到 Hermes 自身 Agent + 多模型 + Hermes Profiles，Hermes 可能是更简单、更适合 Windows 的最终产品。

## 一、两者在产品层级上不是同一种东西

### Hermes：一个完整的主 Agent

Hermes 官方把产品定义为会随使用持续学习的自主 Agent。CLI、Gateway、ACP、API Server、Desktop 都驱动同一个 `AIAgent` 核心；模型供应商可以替换，但会话、工具循环、记忆、Skill 和子 Agent 仍由 Hermes 主导。[架构](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture)、[产品说明](https://hermes-agent.nousresearch.com/docs/)

Hermes 的优势是纵向完整：

- 自己拥有 Agent loop、SQLite/FTS5 会话历史、记忆和用户模型；
- `delegate_task` 创建 Hermes 子 Agent，可为子 Agent 配置不同模型；
- 持久 Kanban 以独立 SQLite 状态机协调多个具名 Profile，支持依赖、重试、人工介入、评论、审计轨迹和 worktree；
- Desktop Projects 已提供项目、仓库、lane、review 与 worktree 的 coding cockpit；
- `/goal`、完成契约和验证证据已经接近 Hunter Loop 的部分目标。

来源：[Session Storage](https://hermes-agent.nousresearch.com/docs/developer-guide/session-storage)、[Delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation)、[Kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban)、[v0.19.0 发布记录](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.7.20)

### OpenClaw：个人 Agent 加多 runtime 控制基础设施

OpenClaw 也有自己的 embedded agent loop，但当前正式架构明确区分 Provider、Model、Agent Runtime 和 Channel。它允许一次会话由不同 runtime 执行：OpenClaw embedded runtime、Codex app-server harness、Claude CLI backend，以及通过 ACP/acpx 管理的外部 coding agent。[Agent runtimes](https://docs.openclaw.ai/concepts/agent-runtimes)

这使 OpenClaw 更像 Hunter 所需的“联邦控制底座”：

- Codex：原生 app-server thread，支持 bind、resume、steer、stop；
- Claude Code、Cursor、OpenCode、Pi 等：ACP/acpx 持久 session；
- Channel、Control UI、移动 App 和 Gateway 复用同一会话控制面；
- 外部宿主可以把 Gateway 当作可替换子进程，通过 WebSocket/RPC 管理，不需要读取其私有数据库。

来源：[Agent runtimes](https://docs.openclaw.ai/concepts/agent-runtimes)、[ACP agents](https://docs.openclaw.ai/tools/acp-agents)、[Embedding OpenClaw](https://docs.openclaw.ai/gateway/embedding)

一句话概括：

- Hermes 更像“一个能力很全、会成长的主 Agent”。
- OpenClaw 更像“一个主 Agent，同时逐步变成其他 Agent 的 session/runtime 控制总线”。

## 二、Coding Agent 编排能力

| 能力 | Hermes | OpenClaw | Hunter 影响 |
|---|---|---|---|
| 自有 Agent loop | 成熟主路径 | 成熟主路径 | 两者都能直接完成编码任务 |
| Codex 原生 runtime | 可选 Codex app-server；保留 Codex 工具和 sandbox，但部分 Hermes 工具在该 runtime 不可用 | 原生 app-server harness；线程 bind/resume/steer/stop 与镜像状态是明确产品面 | 两者都能保留 Codex runtime，OpenClaw 的远程控制契约更完整 |
| Claude Code/Cursor/OpenCode/Pi | 内置 Skills 主要经 PTY/子进程调用；可做任务委派 | ACP/acpx 作为正式 managed session 路径 | 需要统一会话生命周期时 OpenClaw 更强 |
| ACP 角色 | 已实现 ACP Server：编辑器把 Hermes 当 coding agent | 主要作为 ACP Client/控制方管理外部 Agent | 方向正好相反 |
| 通用外部 Agent DAG | Hermes 自身 Profile/Kanban 很强；跨外部 CLI 的通用 ACP client/混合 workflow 仍有公开提案 | 外部 ACP session、thread binding 和 remote coding session 已进入发布能力 | Hunter 的多原生 Agent 联邦更适合 OpenClaw |
| 持久任务板 | Hermes Kanban 很强，具备 DB 状态机、依赖、人类介入、重试和 Profile dispatcher | Task Flow、Automation、Control UI session/tasks；更偏统一 runtime 与 channel | Hunter Workbench 若想少做任务板，Hermes 更有现成价值 |
| 原生客户端保留 | 可从 Skill 启动外部 CLI；不会自动等同于保留其桌面 UI | managed runtime 与用户直接打开原生 UI 是两条并存路径 | 两者都无法“把任意原生 GUI 变成完全可控”；Hunter 必须标注治理等级 |

Hermes 外部 CLI 的当前边界可从官方仓库问题看得很清楚：官方 issue 将现有 `claude-code`、`codex` Skill 描述为 PTY/子进程调用，并指出跨外部 CLI 的并行、DAG 和上下游传递仍是 gap；另一个通用 ACP Client 提案也明确说 Hermes 当前 ACP 主要是 Server。[Cross-CLI orchestration issue](https://github.com/NousResearch/hermes-agent/issues/413)、[Generalized ACP client issue](https://github.com/NousResearch/hermes-agent/issues/5257)

这不代表 Hermes 不能调用其他 coding agent；它可以，而且内置了 Codex、Claude Code 和 OpenCode Skills。[Skills catalog](https://hermes-agent.nousresearch.com/docs/reference/skills-catalog/) 但“Agent 能在终端里调用另一个 CLI”和“控制平面拥有结构化、持久、可恢复的外部 Agent session”是不同成熟度。

## 三、Windows 支持

### Hermes Windows

Hermes 把 Windows 10/11 x86_64 与 ARM64 列为 Tier 1。官方支持原生 PowerShell 安装和 Hermes Desktop，不要求 WSL、Cygwin 或 Docker。安装器按需配置 Python 3.11、Node 22、PortableGit、bash 和浏览器依赖；CLI、TUI、消息 Gateway、Cron、浏览器、MCP、本地模型和 Dashboard 都可原生运行。[Platform Support](https://hermes-agent.nousresearch.com/docs/getting-started/platform-support)、[Windows Native Guide](https://hermes-agent.nousresearch.com/docs/user-guide/windows-native)

已公开的主要原生限制是 Dashboard 的 `/chat` 内嵌终端 pane 依赖 POSIX PTY，原生 Windows 不支持；其余 Dashboard 可用。需要这一终端 pane 或标准 Linux `fork`/watcher 语义时再选择 WSL2。

这是一条相当清晰、对 Windows 用户友好的路径：**Hermes 的核心运行方式原生可用，WSL 是选项，不是默认架构依赖。**

### OpenClaw Windows

OpenClaw 现在并非“不支持 Windows”。官方已提供：

- Windows 10 20H2+/Windows 11 原生 WinUI Windows Hub；
- 无管理员权限、签名的 x64/ARM64 安装器；
- 原生 PowerShell CLI/Gateway；
- Scheduled Task 后台启动；
- Windows Node 模式，提供 screen、camera、notifications、device、talk 和受控 `system.run`；
- 本机 loopback MCP Server，可供 Claude Desktop、Claude Code 和 Cursor 使用；
- 远程、SSH tunnel、本机和 WSL Gateway 连接。

来源：[Windows](https://docs.openclaw.ai/platforms/windows)、[Gateway runbook](https://docs.openclaw.ai/gateway)

不过 OpenClaw 官方推荐的 Windows Hub 首次本地设置，会创建一个 app-owned `OpenClawGateway` WSL distro；文档仍称 WSL2 是“最兼容 Linux 的 Gateway runtime”。原生 Gateway 是正式支持路径，但最完整、最少平台差异的路径仍偏向 WSL2。

因此 Windows 判断应是：

- “能不能用”：两者都能，OpenClaw 已有正式原生 CLI/Gateway 和 WinUI Hub。
- “纯原生是否最简单”：Hermes 当前更直接。
- “桌面设备能力、手机和远程节点是否完整”：OpenClaw 更全面。
- “是否要避免 WSL”：Hermes 更有优势；OpenClaw 应专门验证 Native Gateway，而不能默认 WSL 路径一定可接受。

## 四、移动端和消息渠道

Hermes 的移动策略主要是消息 Gateway：Telegram、Discord、Slack、WhatsApp、Signal、飞书/Lark、企微、微信、QQ、Teams 等 20+ 平台；Android Termux 是 Tier 2。它有 Desktop，但官方材料没有显示与 OpenClaw 同等级的原生 iOS/Android companion。[Messaging Gateway](https://hermes-agent.nousresearch.com/docs/user-guide/messaging)、[Platform Support](https://hermes-agent.nousresearch.com/docs/getting-started/platform-support)

OpenClaw 同样有丰富渠道，并额外提供官方 iOS/Android companion/node。移动 App 可连接自有 Gateway，承载聊天、审批、设备能力和自动化；近期发布记录还在持续补齐移动 Automations、Android Voice Wake 和 remote coding session。[Platforms](https://docs.openclaw.ai/platforms)、[v2026.7.2 beta 发布记录](https://github.com/openclaw/openclaw/releases/tag/v2026.7.2-beta.3)

若“移动端”只意味着飞书/Telegram 发消息、看状态、人工 unblock，Hermes 已经足够。若还要求原生手机 App、设备配对、远程审批、移动自动化和节点能力，OpenClaw 更成熟。

## 五、Skills、MCP、ACP 与扩展契约

### 共同点

- 两者均为 MIT License：[Hermes LICENSE](https://github.com/NousResearch/hermes-agent/blob/main/LICENSE)、[OpenClaw LICENSE](https://github.com/openclaw/openclaw/blob/main/LICENSE)。
- 两者都支持 Agent Skills、MCP、消息渠道、Hooks 和插件。
- 两者都可在不 fork 核心代码的情况下加入 Hunter 功能。

### Hermes 扩展面

Hermes Python 插件可以注册工具、生命周期 hook、Slash Command、CLI Command 和 Skill；Shell hook 可在 `pre_tool_call` 阻止危险工具调用。Dashboard 可以通过 UI plugin 注册新 tab、替换页面、注入 slot，并配套 FastAPI router。[Plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins/)、[Event Hooks](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks/)、[Extending the Dashboard](https://hermes-agent.nousresearch.com/docs/user-guide/features/extending-the-dashboard)

外部程序还可以通过三种正式协议驱动 Hermes：ACP over stdio、TUI Gateway JSON-RPC over stdio/WebSocket，以及 HTTP/SSE API；Desktop 自身也以 `hermes serve` JSON-RPC/WebSocket 后端工作。[Programmatic Integration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration)、[Desktop](https://hermes-agent.nousresearch.com/docs/user-guide/desktop)

这足以实现一个 Hunter 插件与 Workbench 页面。需要注意的是，Hermes 当前插件主要围绕自己的 Agent loop；若 Hunter 要接管外部 ACP coding agent，仍要自建或等待通用 ACP Client。

### OpenClaw 扩展面

OpenClaw 的 TypeScript Plugin SDK 提供更细的宿主契约：Gateway RPC/HTTP、后台 Service、session extension、exactly-once next-turn injection、trusted tool policy、Control UI descriptor、runtime lifecycle、Agent event subscription、per-run state、session action、MCP resolver 和 security audit collector。[Plugin SDK](https://docs.openclaw.ai/plugins/sdk-overview)

官方还单独定义了外部嵌入方式：宿主监督已安装的 `openclaw` 子进程，以 Gateway WebSocket/RPC 为控制面，通过协议 readiness、shutdown/restart 事件和 RPC 管理，而不是导入内部包或读取状态文件。[Embedding OpenClaw](https://docs.openclaw.ai/gateway/embedding)

对 Hunter 的 Gate、Evidence、Approval、Session Projection 与独立 Workbench 来说，OpenClaw 的契约更贴近“宿主/控制平面”而非“给一个 Agent 加工具”。

## 六、维护活跃度与创始人风险

### “OpenClaw 创始人不积极更新”目前没有官方证据支持

截至 2026-07-21，官方证据反而显示 Peter Steinberger 仍非常活跃：

- `CONTRIBUTING.md` 仍列 Peter 为 Benevolent Dictator，同时列出多位按子系统分工的 maintainer；[Maintainers](https://github.com/openclaw/openclaw/blob/main/CONTRIBUTING.md)
- 官方 GitHub Activity 在本次调研时显示 Peter 在数十分钟内向 `main` 推送/合并多个 Codex、CLI、session/runtime 相关提交；[Repository Activity](https://github.com/openclaw/openclaw/activity)
- 2026.7.2 的多个 beta tag/commit 由 Peter 签名，2026.7.1 stable 则由另一 maintainer Vincent Koc 发布；[Releases](https://github.com/openclaw/openclaw/releases)
- 2026.7.1 stable 发布记录称该版本汇集 532 位贡献者的 3,063 项 contribution；最新 beta 继续增加 remote coding sessions、mobile automation、Gateway recovery 和外部 supervision。[v2026.7.1](https://github.com/openclaw/openclaw/releases/tag/v2026.7.1)、[v2026.7.2-beta.3](https://github.com/openclaw/openclaw/releases/tag/v2026.7.2-beta.3)
- 代码许可版权主体已经写为 OpenClaw Foundation，而不是 Peter 个人。[LICENSE](https://github.com/openclaw/openclaw/blob/main/LICENSE)

所以“项目停止维护”或“创始人已经不管”是不准确的。更准确的风险描述是：

1. 治理仍明确是 BDFL 模式，关键产品方向存在创始人集中度；
2. 项目规模和变更速度极高，API churn、回归和依赖变化比“没人维护”更值得担心；
3. 官方自评总体 maturity 约 68%，虽然 CLI/Gateway 为 Stable，Agent Runtime、Session、Channel、Plugins 和 Security 多为 Beta，App SDK 仍是 Alpha；[Maturity Scorecard](https://docs.openclaw.ai/maturity/scorecard)
4. 稳定版本、beta、dev 与 extended-stable 多条发布线说明维护流程很活跃，但 Hunter 必须 pin 版本、跑兼容测试并准备回退。[Release Policy](https://docs.openclaw.ai/reference/RELEASING)

### Hermes 同样极其活跃，也同样年轻

Hermes 当前最新正式版是 v0.19.0，发布于 2026-07-20；官方发布记录称它自 v0.18.0 以来合入约 2,245 commits、1,065 PR 和 450+ contributors。此前 v0.18.0 为 2026-07-01，v0.17.0 为 2026-06-19。[Hermes Releases](https://github.com/NousResearch/hermes-agent/releases)

Hermes 因此也不存在“不活跃”问题，而且由 Nous Research 组织维护、release 由 Teknium 签名。反过来，`0.19.0` 版本号和同样巨大的短期变更量也说明它不是一个低变更、可盲目依赖的成熟企业底座。官方没有像 OpenClaw 那样的量化 maturity scorecard，不能因此推断它更稳定；稳定性仍必须通过本机 bake-off 证明。

### 风险判断

| 风险 | Hermes | OpenClaw |
|---|---|---|
| 无人维护 | 低 | 低 |
| 创始人/核心团队集中 | Nous Research/Teknium 集中 | BDFL 明示，但已有多 maintainer 和 Foundation 版权主体 |
| 高速变化/API churn | 高 | 很高 |
| 官方成熟度透明度 | 没有量化 scorecard | 有 scorecard，但总体仍在 Alpha/Beta 区间 |
| Hunter 的依赖隔离需求 | 需要 | 更需要 |

无论选择谁，都不应把 Hunter Domain Model 写进对方私有数据库，也不应直接 fork。应 pin 版本、经公开协议/插件契约接入、保留 Provider Port，并维护跨版本 contract tests。

## 七、什么情况下选 Hermes

下列目标成立时，建议优先 Hermes：

1. 想要的是一个统一的个人 Agent，而不是多个原生 coding agent 的控制台；
2. 希望 Agent 长期学习个人偏好、自动形成和改进 Skill、跨会话搜索记忆；
3. 可以把 Claude/GPT/Gemini/Grok 主要视为“模型”，由 Hermes 自己的 loop 统一使用；
4. 多 Agent 主要指多个 Hermes Profile、角色和模型，而不是多个供应商 CLI 的原生 session；
5. 重视 Windows 纯原生、少依赖 WSL 的运行体验；
6. 希望直接复用持久 Kanban、dispatcher、worktree、任务依赖、人工 unblock 和 Dashboard；
7. 移动端以飞书/Telegram/Discord 等消息入口为主，不强求原生 iOS/Android 控制 App；
8. 愿意让 Hunter 缩减成 Hermes 插件、Policy Hook、Dashboard tab 与外部资产同步器。

这条路线可能比 OpenClaw 更简单：`Hermes + Hunter Governance Plugin + Hunter Workbench（可选）`。

## 八、什么情况下选 OpenClaw

下列目标成立时，建议优先 OpenClaw：

1. Codex、Claude Code、Cursor、OpenCode、Pi 等都要继续存在，不能被统一成同一个 Agent loop；
2. 需要从飞书、手机或 Web 绑定、继续、steer、stop 不同工具的原生/ACP session；
3. 需要 Codex app-server 与其他 Agent ACP session 共存；
4. 需要官方 iOS/Android App、设备 pairing、remote node 和移动审批；
5. Hunter 要作为独立控制面嵌入/监督底座，而非只给主 Agent 加几个工具；
6. 需要 typed Plugin SDK 的 session extension、trusted policy、Control UI 和 Gateway RPC；
7. 能接受 pin 稳定版本、跑 WSL/native 两条 Windows 验证并承担较快的上游变化。

这条路线仍是：`Stock OpenClaw + Hunter Bridge/Kernel + Hunter Workbench（可选）`。

## 九、对 Hunter 最新方案的修正建议

### 不应做的事

- 不应把 Hermes 简单归类为普通 Agent Adapter；它已经拥有 Hunter 原计划中的工作台、任务板、记忆、Loop 与渠道能力。
- 不应仅凭 OpenClaw 功能广度就锁定底座；Windows 纯原生体验和实际稳定性必须实测。
- 不应因为创始人个人观感而认定 OpenClaw 不活跃；应依据 release、activity、maintainer 和兼容性测试。
- 不应 fork 任一项目；两者都在高速变化，长期合并成本会吞掉 Hunter 的价值。

### 新 Phase 0：双底座实测

建议 5–7 天内运行以下统一场景：

| 场景 | Hermes 路径 | OpenClaw 路径 | 通过条件 |
|---|---|---|---|
| Windows 安装/升级/回退 | 原生 Desktop + CLI | WinUI Hub + Native Gateway；另测 WSL Gateway | 不破坏现有工具；可 pin/回滚 |
| Codex | Codex app-server runtime | Codex native app-server runtime | 登录、启动、恢复、停止、工具与 sandbox 正常 |
| Claude/OpenCode/Pi | Skill + PTY，记录会话能力缺口 | ACP/acpx | 至少两种工具能继续/停止/恢复 |
| 持久 Loop | Hermes Kanban + completion contract | Task Flow/session + Hunter Gate | 重启后继续，失败可重试，人工可 unblock |
| 飞书/移动 | Hermes Feishu Gateway | OpenClaw Feishu + iOS/Android/Control UI | 看状态、补充指令、启动、停止、审批 |
| Worktree | Hermes `-w`/Kanban workspace | OpenClaw runtime/workspace | 并行任务不污染主工作区 |
| Hunter Gate/Evidence | Python/Shell Hook + Dashboard plugin | Trusted policy/session extension + Bridge | Gate 可阻断；Evidence 可验证、不可只靠模型声明 |
| 外部嵌入 | `hermes serve` JSON-RPC/WS + HTTP | supervised Gateway + WS/RPC | Hunter 不读私有 DB，可探活、重连和升级 |

### 决策门

- 若 Hermes 在实际日常里可以替代 80% 以上的原生工具切换，并且 Kanban/记忆带来的价值高于原生 Agent 差异：选择 Hermes-first。
- 若必须经常保留并远程继续各工具自己的 session：选择 OpenClaw-first。
- 若两者都只有部分合格：Hunter 保留 provider-neutral Kernel，OpenClaw 作为 Managed Session Provider，Hermes 作为 Self-Learning Agent Provider；不要让二者同时拥有 Hunter 的 canonical WorkItem/Gate/Evidence 状态。

## 最终判断

基于用户已明确的目标——开发环境会在 Codex、Cursor、Claude Code、CodeBuddy、WorkBuddy、Pi、Grok Build、OpenCode 等之间变化，并希望统一管理但保留各工具自身优势——**OpenClaw 仍应是当前首选底座，Hermes 应成为 Phase 0 的强制对照组，而不是被排除。**

若用户进一步确认：实际上接受让 Hermes 成为主要 Agent，只需要偶尔通过 Skill 委派其他 CLI，那么推荐会反转为 Hermes，因为它的 Windows 原生路径、学习循环、持久 Kanban、Profiles 和 Dashboard 能显著减少 Hunter 自研量。

最重要的设计修正是：先决定 Hunter 要解决的是“一个会成长的主 Agent”还是“多个原生 Agent 的联邦控制”。Hermes 在前者更强，OpenClaw 在后者更强。
