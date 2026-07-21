# 成熟多 Coding-Agent 工作台与编排产品调研

> **历史路线建议（已被取代）**：候选产品证据仍可参考，但本文的
> “OpenClaw 作为默认嵌入底座”结论已经失效。Hunter Platform 当前不以
> OpenClaw、Hermes、Goose、Orca 或任一 Agent/Gateway 作为 canonical Core；
> 当前路线见
> [`2026-07-21-hunter-platform-landscape-and-reuse.md`](2026-07-21-hunter-platform-landscape-and-reuse.md)。

> 检索日期：2026-07-21
> 范围：只采用项目官网、官方文档、官方 GitHub 仓库、许可证与公开 API/源码。这里的“原生 UI/会话”指保留上游 CLI/TUI 及其会话语义，而不只是能调用同一个模型。

## 结论先行

新增核验 OpenClaw 后，结论发生实质变化：**OpenClaw 是最高优先级成熟底座候选**。它是本轮唯一同时具备 MIT、正式 Gateway WebSocket/RPC、官方 child-process embedding 指南、原生 Windows Hub、iOS/Android、Feishu/Telegram、managed worktree、原生 Codex app-server 与外部 ACP/acpx harness 的候选。它不是一个专门的 coding-agent Kanban，但作为 Hunter 的运行时、远程控制面和渠道层，比桌面工作台更接近可长期嵌入的基础设施。

推荐优先级：

1. **默认路线：把 OpenClaw 作为受管 child runtime 嵌入 Hunter。** Hunter 保留产品壳、项目模型、策略和审计；OpenClaw 负责 Gateway、session、渠道、设备、Codex/ACP runtime 和 worktree。官方明确支持这种 supervision 模式，也明确要求外部宿主只走 Gateway RPC、不要读取其私有 state/SQLite/transcript。这条路线兼顾上游升级与 Hunter 差异化。
2. **需要深改 runtime 时：whole-fork OpenClaw。** MIT 允许 fork，且其 Windows/mobile/channel/coding-agent 纵向能力完整；代价是 7 万级提交的快速演进、Plugin SDK 迁移和多端发布维护，Hunter 会接手很大的上游同步面。
3. **低风险渐进路线：把 OpenClaw 做成 Hunter 的 optional provider。** 先用 Gateway RPC 接入已有 OpenClaw，提供 Codex/ACP、移动和渠道能力；没有安装 OpenClaw 时继续使用 Hunter/AgentAPI。覆盖较慢，但回退与可替换性最好。

**Orca** 降为“最快拿到 coding-workbench UI 的首选 fork/原型基座”：MIT、Windows/macOS/Linux、iOS/Android、原始 CLI 终端会话、worktree、SSH/headless runtime 与 JSON CLI 都很完整，但外部协议和权限边界明显弱于 OpenClaw。**Coder AgentAPI** 仍是最小化 Agent 适配器的好选择，适合不采用 OpenClaw runtime 时使用。次优桌面基座是 **Emdash**；**Nimbalyst** 适合参考视觉交互、扩展系统和移动协同。

不建议把 **Vibe Kanban、Crystal、Coder Tasks** 作为新基础：三者分别已关闭服务、停止维护、进入退役路径。**Conductor** 功能成熟但闭源且仅 macOS；**Superset** 受 ELv2、macOS 与云 relay 耦合限制；**Claude Squad** 很适合借鉴“tmux 保留原生会话”的机制，但 AGPL、TUI 形态和无 API 使其不适合作为 Hunter 的完整工作台基座。

## 一览表

| 产品 | 截至 2026-07-21 的状态 | 许可证 | 原生 Agent / 会话 | 并行隔离 | 控制面 | Windows | 远程 / 移动 | 对 Hunter 的判断 |
|---|---|---|---|---|---|---|---|---|
| [OpenClaw](https://github.com/openclaw/openclaw) | 极活跃；[v2026.7.1，2026-07-13](https://docs.openclaw.ai/releases/2026.7.1) | MIT | 原生 Codex app-server；ACP/acpx 真实外部 harness；session catalog + PTY resume | managed worktree、session/task；sandbox 边界按 runtime 不同 | **正式 Gateway WS/RPC + embedding 指南 + Plugin SDK** | 原生 Windows Hub/CLI，亦支持 WSL2 | iOS/Android、Web、Feishu/Telegram 等 | **最高优先级；首选 embedded child** |
| [Orca](https://github.com/stablyai/orca) | 活跃；[v1.4.147，2026-07-20](https://github.com/stablyai/orca/releases/tag/v1.4.147) | MIT | 运行原始 CLI/TUI，终端与 scrollback 可恢复 | worktree 原生，多 Agent 扇出 | 公开 JSON CLI；无正式外部 HTTP/OpenAPI | 是 | SSH/headless；iOS/Android | **首选 fork/原型基座** |
| [Emdash](https://github.com/generalaction/emdash) | 活跃；[v1.1.40，2026-07-17](https://github.com/generalaction/emdash/releases/tag/v1.1.40) | Apache-2.0 | 官方 CLI/PTTY；tmux 可跨重启恢复 | 每任务 worktree | 内部 Electron RPC/Hook；无稳定外部 API | 是 | SSH/SFTP；无官方移动端 | **次选 fork 基座** |
| [Coder AgentAPI](https://github.com/coder/agentapi) | 活跃；[v0.12.2，2026-05-27](https://github.com/coder/agentapi/releases/tag/v0.12.2) | MIT | 包装原始进程，但 API 输出为解析后的终端快照 | 无任务/worktree 编排 | **OpenAPI + SSE** | 未见一等官方支持 | 可由宿主远程暴露；自身无移动 UI | **最佳可嵌入 Agent 适配层** |
| [Coder Agents](https://coder.com/docs/ai-coder/agents) | Beta，长期方向；Coder 仓库持续发布 | AGPL-3.0 核心 + 企业许可功能 | 自有 Go agent loop，不保留 Claude Code/Codex 原生会话 | 每聊天独立 Coder workspace | 实验性 REST + WebSocket | 客户端可用浏览器；服务端依赖部署环境 | 强远程 Web；移动浏览器可访问 | 企业部署可直接用，不适合轻量 fork |
| [Nimbalyst](https://github.com/nimbalyst/nimbalyst) | Crystal 后继；[v0.59.2，2026-05-07](https://github.com/nimbalyst/nimbalyst/releases/tag/v0.59.2) | 桌面/iOS 仓库 MIT；同步后端需另查 | 自定义 transcript；可导入/续接部分原生会话，不保留原 TUI | worktree、多会话、看板 | Extension SDK + 内部 IPC/MCP；无稳定外部 REST | 是 | iOS + 同步服务 | 值得二次尽调，尤其 UX/扩展系统 |
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) | 公司于 2026-04 关闭；[v0.1.44](https://github.com/BloopAI/vibe-kanban/releases/tag/v0.1.44) 后转社区维护 | Apache-2.0 | 统一渲染 Agent 行为，不保留原 TUI | workspace/worktree 并行 | 内部 HTTP/实时日志/MCP；无稳定公开控制 API | 有 MSI/EXE | 原云远程服务已宣布移除 | 只借鉴代码与交互，不直接依赖 |
| [Crystal](https://github.com/stravu/crystal) | [2026-02 宣布弃用](https://github.com/stravu/crystal#crystal-is-deprecated)，[v0.3.5](https://github.com/stravu/crystal/releases/tag/v0.3.5) | MIT | 自定义输出/终端，可持久化与恢复 | 每会话 worktree；可同 worktree 多 Agent | 内部 REST/IPC，非稳定外部契约 | 仅源码构建说明 | 本地桌面；无官方移动/远程 | 可读源码，不宜成为新依赖 |
| [Superset](https://github.com/superset-sh/superset) | 活跃；[v1.11.3，2026-05-24](https://github.com/superset-sh/superset/releases/tag/v1.11.3) | **ELv2，非 OSI 开源许可** | 终端模式运行官方 CLI；聊天模式为自定义 UI | worktree 与并行 Agent | MCP v2、Alpha TS SDK、Beta CLI/host server | [官方仍称即将支持](https://docs.superset.sh/overview) | Pro 远程 workspace + 云 relay；无官方移动端 | 可直接评估，不适合作为 Hunter fork 基座 |
| [Conductor](https://www.conductor.build/) | 活跃；[0.76.0，2026-07-16](https://www.conductor.build/changelog) | 专有；未找到公开源码许可 | 集成聊天/检查点，不保留原 TUI | worktree；同 workspace 或多 workspace 并行 | 仅 deep link，未见公开 REST/事件 API | 否，仅 macOS | 本机应用，无官方移动/托管 IDE | 产品参考，不可 fork/嵌入 |
| [Claude Squad](https://github.com/smtg-ai/claude-squad) | 活跃；[v1.0.18，2026-05-23](https://github.com/smtg-ai/claude-squad/releases/tag/v1.0.18) | AGPL-3.0 | **tmux 直接附着原始 Agent TUI，会话保真最好** | worktree + tmux 并行 | CLI/TUI + JSON 配置，无网络 API | 无原生支持；官方安装链依赖 tmux/bash | 可自行 SSH；无移动产品 | 适合借鉴原生会话机制，不是完整 Web 工作台 |

> “未找到公开 API/许可”仅表示在本次检索的官方文档与仓库中没有发现稳定、对外承诺的接口或许可，并不等于产品内部不存在相关实现。

## 1. OpenClaw：最高优先级成熟底座候选

### 成熟度、许可与产品覆盖

- **活跃度与许可。** 官方仓库已有约 7 万次提交，根许可证明确为 [MIT License](https://github.com/openclaw/openclaw/blob/main/LICENSE)，并单列第三方 notices。最新可核实稳定发布是 [v2026.7.1（2026-07-13）](https://docs.openclaw.ai/releases/2026.7.1)；该版本继续交付 Control UI、Windows、iOS/Android、Codex supervision、terminal 和安全策略能力。它的体量与变化速度同时意味着“成熟能力多”和“上游同步成本高”。
- **定位差异。** OpenClaw 是 self-hosted Gateway/个人 Agent 平台，不是以 GitHub issue 为中心的 Kanban 工作台。它的优势在于长驻控制面、session、设备、渠道、runtime、审批和插件生态；Hunter 仍要保留自己的项目/任务/计划/知识/审查产品模型。

### Gateway embedding API：可嵌入契约明显强于桌面候选

- [Embedding OpenClaw](https://docs.openclaw.ai/gateway/embedding)是明确的宿主集成规范：宿主监督已安装的 `openclaw` 可执行程序，把 Gateway 当可替换 child process，以 WebSocket 协议做控制面；官方给出 `OPENCLAW_DISABLE_BONJOUR`、`OPENCLAW_NO_RESPAWN`、`OPENCLAW_EXEC_SHELL_SNAPSHOT`、`OPENCLAW_SKIP_CHANNELS` 等 embedding preset，并要求 Electron 宿主使用真实 Node runtime。
- [Gateway integrations for external apps](https://docs.openclaw.ai/reference/openclaw-sdk-api-design)明确把 dashboard、CI、IDE 和其他进程路由到 Gateway WS/RPC，可启动 Agent、流式接收事件、等待、取消、查询 session/task/model/tool/artifact/approval。`agent` + `agent.wait` 适合执行，`sessions.*` 管理持久会话。
- [Gateway protocol](https://docs.openclaw.ai/gateway/protocol)是带 JSON Schema、协议版本、握手、role/scope 和 server-push event 的统一控制面；operator、node、CLI、Web、桌面与手机共用。`@openclaw/gateway-protocol` 和 `@openclaw/gateway-client` 正处于随 release train 发布的初期，官方同时提醒包在首轮发布时可能尚未出现在 npm。**因此 wire protocol/RPC 可视为 ready，npm client 的可得性仍须在锁定版本时实测，不能把源码中的未来 client package 当既成依赖。**
- 官方要求宿主通过 `sessions.list/patch/delete`、`chat.history`、`usage.cost`、`models.authStatus`、`config.get/patch` 等 RPC 工作，**禁止**直接读写 `~/.openclaw` 的文件、SQLite、transcript 或 cache；这些是私有布局。这个边界很适合 Hunter：只要 pin OpenClaw 版本并对 RPC 做契约测试，升级可与 Hunter state 解耦。

### Plugin SDK：有正式契约，但还在快速收敛

- [Plugin SDK overview](https://docs.openclaw.ai/plugins/sdk-overview)将 SDK 定义为插件与 core 之间的 typed contract，能注册 provider、channel、CLI backend、embedding/speech provider、tool/hook、session workflow，以及实验性的 native agent harness。外部 App 不应导入它，而应使用 Gateway RPC。
- SDK 已从宽泛的 `openclaw/plugin-sdk`、`extension-api` 等入口迁移到窄 subpath；[SDK migration](https://docs.openclaw.ai/plugins/sdk-migration)显示 2026-07 已移除多批旧 barrel/bridge。官方[兼容策略](https://docs.openclaw.ai/plugins/compatibility)要求新旧契约经过 adapter、诊断、文档和最长约三个月的弃用窗口，不能同版直接替换。
- 这说明 SDK **已建立治理，但不是低频稳定 ABI**。Provider/channel/tool 等常规能力可用文档化窄 subpath；`registerAgentHarness` 仍标为 experimental，部分 Codex task/session helper 是 repo-local private，不应作为 Hunter 插件依赖。Hunter 应优先在进程外走 Gateway RPC，只有必须参与 OpenClaw 内部生命周期的能力才做插件。

### Coding Agent、原生 Codex 与原生会话保留

- [Agent runtimes](https://docs.openclaw.ai/concepts/agent-runtimes)明确区分两族：OpenClaw 进程内 embedded harness（内建 loop、Codex、Copilot 等插件）与外部 CLI/ACP harness。对 Codex，默认优先使用原生 app-server，而非终端抓屏或文本 provider。
- [Codex harness](https://docs.openclaw.ai/plugins/sdk-agent-harness)让 Codex 自己拥有 native thread id、resume、compaction 和 app-server execution；OpenClaw 拥有渠道、可见 transcript mirror、工具策略、审批和 session 选择。显式 runtime 失败时 fail closed，不偷偷降级成另一个 runtime。
- [Codex session catalog](https://docs.openclaw.ai/plugins/codex-harness-runtime)只读发现非归档 native threads，不会因列表操作隐式 resume 或回答审批。它支持从固定快照 “Continue as branch”，保留原 thread 的历史边界；[Codex supervision](https://docs.openclaw.ai/plugins/codex-supervision)还能从本机/配对 node 列 resumable CLI session，并通过 allowlisted `codex.terminal.resume.v1` 在所属 host 运行 `codex resume <thread-id>`、中继真实 PTY。也就是说：**普通聊天 UI 是 transcript mirror，不是 Codex TUI；需要原生交互时可以安全地回到真实 Codex terminal/session。**
- [Codex harness reference](https://docs.openclaw.ai/plugins/codex-harness-reference)表明 `sessionCatalog` 默认开启、supervision 默认关闭；让 Hunter 查看历史与让 Agent 修改/控制 native session 是两个独立授权面。`experimental.sandboxExecServer` 仅是让 Codex app-server 接 OpenClaw sandbox backend 的 preview opt-in，不能当默认安全保证。

### ACP/acpx：广泛 Agent 适配，同时是必须显式标注的安全断层

- [ACP agents](https://docs.openclaw.ai/tools/acp-agents)通过官方 `@openclaw/acpx` runtime plugin 支持 Claude Code、Codex、Gemini CLI、OpenCode、Copilot、Cursor、Droid、Kimi、Qwen 等真实外部 harness。ACP session 支持 spawn、bind、steer、cancel、close、model、cwd、permission profile、session/load resume、background task 和 thread binding。
- Codex 通过 ACP 只是显式 fallback；正常 Codex bind/resume/steer 应走 native app-server。Claude Code 等则走 ACP/acpx。ACP harness 自己拥有 provider login、model catalog、文件行为和 native tools；OpenClaw 负责路由、任务状态、绑定、policy 与 delivery。
- **关键边界：官方明确写明 ACP session 当前运行在 host runtime，OpenClaw sandbox 不会包裹它。** 外部 harness 可以按自身 CLI 权限和选定 `cwd` 读写；sandboxed requester 反而会被阻止 spawn ACP，且 `runtime:"acp"` 不支持 `sandbox:"require"`。OpenClaw 仍会执行 allowed agent、session ownership、channel binding 与 delivery policy，但这不是文件系统/进程隔离。Hunter 若把 ACP 作为企业 coding-agent 后端，必须用独立 OS 用户、容器/VM 或受限远端 workspace 提供真正隔离。

### Worktree、Windows、移动与渠道

- [Managed worktrees](https://docs.openclaw.ai/concepts/managed-worktrees)为每个 Agent task 创建独立 branch/checkout，位于 OpenClaw state 目录下的专用 `worktrees/` 树而非源 repo 内；Control UI、iOS 和 Android 都能创建 worktree-backed session。它还处理 base branch、ignored-file provision、清理前快照等生命周期。worktree 仍是 Git 冲突隔离，不是安全沙箱。
- [Windows](https://docs.openclaw.ai/platforms/windows)已不只是 WSL 文档：官方提供 Windows 10 20H2+/Windows 11 的原生 WinUI **Windows Hub**、签名 x64/ARM64 安装器、本地 app-owned WSL Gateway、一键 setup、tray/chat/Command Center、Windows node、MCP server，以及本地/远端/SSH tunnel Gateway 连接。CLI/Gateway 亦有 PowerShell/native Windows 支持，WSL2 仍是 Linux 兼容性最佳路径。
- [iOS/Android](https://docs.openclaw.ai/platforms/android)是官方 companion node，通过 Gateway WS/device pairing 工作；v2026.7.1 已加入移动 chat、离线 session/transcript、审批、workspace terminal 等。手机不是 Gateway host，因此移动可用性取决于自托管 Gateway 的可达性与设备认证。
- [Feishu](https://docs.openclaw.ai/channels/feishu)官方插件已标为 production-ready，默认 WebSocket、支持 DM/群、streaming card、文档/wiki/drive/Bitable，并有 pairing/allowlist/group policy 与动态 per-user agent/workspace。 [Telegram](https://docs.openclaw.ai/channels/telegram)支持 DM/群/topic、流式预览、inline exec approval、Mini App、owner allowlist 和 session isolation。两者都能直接成为 Hunter 的移动/协作入口，但频道 allowlist 不能替代 Gateway/OS 隔离。

### 身份与权限边界

- [Operator scopes](https://docs.openclaw.ai/gateway/operator-scopes)把客户端分为 `operator` 与 `node`，并有 `operator.read/write/approvals/questions/pairing/.../admin` 等 scope；设备配对、token、server-side trusted context 和 SecretRef/敏感配置脱敏形成了真实控制面边界。
- 同一官方文档也明确：这些 scope 是**单个受信 Gateway operator domain 内的 guardrail，不是敌对多租户隔离**。需要团队/机器之间强隔离时，应运行不同 Gateway，并置于不同 OS 用户或 host。Hunter 不能简单把一个 OpenClaw Gateway 映射成多租户 SaaS 后端。
- Agent runtime 的权限并不统一：OpenClaw native subagent 可以受 sandbox 约束；Codex 原生 app-server 是否进 sandbox 取决于 preview 配置；ACP/acpx 明确不受 OpenClaw sandbox 包裹；terminal resume 是 allowlisted PTY relay 而非通用 shell。这些差异必须进入 Hunter 的 capability/policy UI，不能用单一“已沙箱”徽标概括。

### 与 Hunter Workbench / Kernel 的重叠与保留边界

- OpenClaw 已有三层编排能力：[Background Tasks / Task Flow](https://docs.openclaw.ai/automation/taskflow)提供可跨 Gateway 重启的 task ledger、多步骤 flow、revision conflict、等待/阻塞/取消与 ACP/subagent mirrored flow；[Lobster](https://docs.openclaw.ai/tools/lobster)提供小型确定性 DSL、结构化管道、显式审批与 resume token；[Skill Workshop](https://docs.openclaw.ai/tools/skill-workshop)以 proposal → scan → apply/reject/quarantine → rollback 的治理路径创建 workspace skills。它还原生发现 `<workspace>/.agents/skills`、`~/.agents/skills`、workspace 与 managed roots，并支持 per-agent skill allowlist（[Skills](https://docs.openclaw.ai/tools/skills)）。
- 这些能力与 Hunter Kernel 的“执行编排、状态恢复、审批、技能加载”明显重叠。**不要维护两套同级状态机。** 推荐让 OpenClaw 成为 provider-owned execution kernel：OpenClaw task/flow 是执行事实，Hunter 只保存 `gatewayId/flowId/taskId/revision/nativeSessionId` 映射、产品级状态与归档摘要；Lobster 只承担某一步内部的确定性/可恢复 side-effect pipeline，不替代 Hunter 的需求计划、变更簇、TDD、审查和知识闭环。
- Hunter Workbench 继续拥有跨项目 portfolio、需求/设计/测试场景、代码审查、知识库、归档和企业策略；OpenClaw 负责 session/runtime/worktree/device/channel/approval 的实时执行。这样 OpenClaw 升级或切换 provider 时，Hunter 的业务事实不会被私有 transcript/SQLite 绑死。
- `.agents/skills` 建议继续作为 repo 内的可审查源，Hunter 的 harness skills 仍由项目版本控制；OpenClaw 只按标准路径加载并执行。Skill Workshop 默认仅用于生成 pending proposal，`autonomous.enabled` 保持关闭，`approvalPolicy` 设为 `pending`；proposal 经 Hunter review 后再合入 repo，避免 OpenClaw 的 curator/自学习流程直接成为生产技能的第二写入口。Skill Workshop 当前只写 workspace skills，本来也不会修改 bundled、managed、personal-agent 或 system skills，这使该边界可实施。

### 三种采用方式

| 方式 | 架构 | 优点 | 代价 / 风险 | 适用判断 |
|---|---|---|---|---|
| **Whole fork** | Hunter fork 整个 monorepo，直接改 Gateway、Control UI、Windows Hub、mobile、plugins | MIT；可深改 runtime、品牌、协议和多端；所有能力在一仓内 | 上游约 7 万提交且快速迁移；要维护 Node/TS、WinUI、Swift、Android、渠道插件和发布链；容易依赖 repo-local 私有 helper | 只有 Hunter 的产品形态与 OpenClaw 高度一致、愿意长期维护大 fork 时选择 |
| **Embedded child（推荐）** | Hunter 安装并监督固定版本 `openclaw gateway`，通过 WS/RPC；必要时另装小型 Hunter plugin | 官方专门支持；进程/state 边界清楚；能独立升级/回滚；复用原生 Windows/mobile/channel/Codex/ACP | 要处理安装、Node runtime、ready/restart、协议兼容；Gateway scope 不是多租户边界；某些深层 hook 仍需 plugin | **最符合 Hunter：保留上层产品，复用成熟 runtime/control plane** |
| **Optional provider** | Hunter 把“已有 OpenClaw Gateway”当一种可选 execution/channel provider；无它时走 AgentAPI/本地 runtime | 风险和耦合最低；可渐进交付；用户可用自己的 Gateway/凭据；容易 A/B 与回退 | 两套 session/task/capability 语义；Hunter 难以保证 OpenClaw 版本和插件；跨 provider 迁移、审计与 UI 一致性工作大 | 适合第一阶段兼容或对 OpenClaw 依赖仍有顾虑时 |

**判断：** OpenClaw 已超过 Orca 成为本轮最高优先级底座，但推荐的是 **embedded child**，不是立即 whole-fork。它解决 runtime、移动、渠道、Windows 与协议的大部分问题；Hunter 仍必须补上敌对多租户隔离、统一 coding-task 模型、跨 Gateway 治理，以及 ACP 的 OS 级安全边界。

## 2. Orca：当前最接近 Hunter coding-workbench 目标形态

- **活跃度与许可。** 官方仓库采用 [MIT License](https://github.com/stablyai/orca/blob/main/LICENSE)，最新可核实版本为 [v1.4.147（2026-07-20）](https://github.com/stablyai/orca/releases/tag/v1.4.147)。发布频率、提交量与跨平台安装包在候选中最强。
- **Agent 与原生会话。** 官方支持列表覆盖 Claude Code、Codex、Cursor CLI、GitHub Copilot、OpenCode、Amp 等大量 CLI，也允许配置[任意自定义 CLI Agent](https://www.onorca.dev/docs/agents/custom-cli)。Orca 是在自己的看板外壳中启动原始终端程序，保留 Agent 的 TUI、终端 scrollback、项目内 `.claude`/`.codex` 配置与会话行为；这比把消息重新渲染成统一聊天卡片更接近“原生”。
- **任务与 worktree。** [Worktree 模型](https://www.onorca.dev/docs/model/worktrees)将每个任务放在独立分支、文件树和终端，可把同一提示扇出到多个 Agent 并行比较。它提供任务状态、diff、浏览器与合并流程。
- **API / 事件面。** [CLI Reference](https://www.onorca.dev/docs/cli/reference)提供 JSON 输出，可创建/查看 worktree、启动 Agent、读取/发送终端、按 cursor 等待输出、操作浏览器、环境、自动化与 Hook。这是很好的可编程控制面，但当前官方没有承诺稳定的外部 REST/OpenAPI 或通用事件流；Hunter 若 fork，应把 CLI 内部 runtime service 固化成版本化协议，而不是长期依赖命令行抓取。
- **Windows、远程与移动。** [下载页](https://www.onorca.dev/download)提供 Windows、macOS、Linux 和 iOS/Android。[Remote Servers](https://www.onorca.dev/docs/remote-servers)支持 SSH worktree、`orca serve` headless runtime 与配对 URL；官方建议通过 Tailscale/VPN，而非直接暴露端口。[移动端](https://www.onorca.dev/docs/mobile)可查看工作树、终端 scrollback、回复提示、文件/diff、暂存/提交与预览。
- **身份与权限边界。** Agent 继承本地或 SSH 用户的文件、网络、凭据权限，worktree 是冲突隔离，不是安全沙箱。尤其需注意官方[支持矩阵](https://www.onorca.dev/docs/agents/supported)说明默认会为多个 Agent 预填 permission-bypass/yolo 类参数，用户可在设置中改成 Manual；这与企业 Hunter 的最小权限默认值相反。配对 URL 也是可访问 runtime 的 bearer secret，应增加短期令牌、设备撤销、细粒度权限与审计。官方[遥测说明](https://www.onorca.dev/docs/telemetry)称不采集代码、提示和终端内容且可关闭，但移动配对文档对“账户”的表述仍在演进，不能据此推定成熟 RBAC。
- **嵌入/fork 程度。** MIT 允许 Hunter fork 和商业改造；桌面、移动、runtime、终端与 worktree 已形成完整纵向切片。主要工程风险是上游快速变化、控制协议未正式化，以及安全默认值需要反转。

**判断：** 若目标是 4–8 周内验证“Hunter 多 Agent 工作台”，这是首选代码基座；若目标是多租户企业控制面，应把它视为 UI/runtime 参考，而不是原样部署。

## 3. Emdash：最稳妥的传统桌面 fork 候选

- **活跃度与许可。** 官方仓库为 [Apache-2.0](https://github.com/generalaction/emdash/blob/main/LICENSE)，最新可核实发布为 [v1.1.40（2026-07-17）](https://github.com/generalaction/emdash/releases/tag/v1.1.40)。
- **Agent 与会话。** [Provider 列表](https://emdash.sh/docs/providers)覆盖约 30 种 CLI Agent，并逐项声明 resume、hook、auto-approve 能力。Agent 作为真实 PTY 进程运行；启用 [tmux sessions](https://emdash.sh/docs/tmux-sessions) 后，进程能跨 Emdash 重启、SSH 断线继续，重新连接时再附着。Windows 本机缺少 tmux，因此本地 Windows 的会话持久性弱于 Unix/远程主机。
- **任务与 worktree。** 每任务独立 worktree、分支、终端和对话，可并行开发、查看 diff、提交与合并；自动化支持 cron 和历史记录。
- **API / 事件面。** 官方文档公开的是桌面应用能力、生命周期 Hook 和 MCP 配置管理，源码使用 Electron RPC controller；未找到受支持的外部 REST/WebSocket/OpenAPI 或可作为产品契约的 CLI 控制层。Hunter fork 可以复用内部 RPC，但需要自行抽象、版本化和补测试。
- **Windows、远程与移动。** [安装文档](https://emdash.sh/docs/installation)提供 Windows/macOS/Linux。[Remote Projects](https://emdash.sh/docs/remote-development/remote-projects)通过 SSH/SFTP 在远端创建 worktree、启动 Agent 与 PTY；[SSH 连接](https://emdash.sh/docs/remote-development/ssh-connections)支持密钥、agent 和主机配置。没有找到官方 Web/移动客户端。
- **身份与权限边界。** 本地使用可不登录，GitHub 账户是可选集成；远程进程具有 SSH 用户权限。应用会用系统凭据存储/加密保存连接信息，但 Agent 本身仍可访问该 OS 用户能访问的范围；项目根目录校验不等同于 Agent 沙箱。SSH agent forwarding 也会把签名能力带到远端，官方文档对此有安全提醒。
- **嵌入/fork 程度。** Apache-2.0 清晰、桌面端完整、Windows 成熟，适合 Hunter fork。短板是没有移动端和稳定外部 API，意味着 Hunter 要承担控制面重构。

**判断：** 若 Hunter 更重视可维护桌面代码、SSH 开发和宽松许可证，而不把移动端作为近期硬需求，Emdash 是 Orca 之外最值得做技术 Spike 的候选。

## 4. Coder AgentAPI：最适合抽成 Hunter 的 Agent 驱动层

- **活跃度与许可。** [官方仓库](https://github.com/coder/agentapi)使用 MIT，最新版本 [v0.12.2（2026-05-27）](https://github.com/coder/agentapi/releases/tag/v0.12.2)。支持 Claude Code、Codex、Gemini、GitHub Copilot、OpenCode、Aider、Goose、Amp 等。
- **原生 Agent 与 UI。** AgentAPI 启动真实终端进程，在内存终端模拟器中发按键并解析屏幕，再通过 `/messages` 等接口输出结构化快照。它保留原进程和 CLI 会话语义，但 API 消费者看到的是解析后的消息；内置 `/chat` 也是自定义 Web UI，而非原生 TUI 像素级嵌入。
- **任务/worktree。** 它只负责一个 Agent 进程的通信、状态与上传，不提供任务队列、Git/worktree、并行调度、合并或跨 Agent 协作。Hunter 必须自己补齐这些层。
- **公开 API / 事件流。** [OpenAPI 文件](https://github.com/coder/agentapi/blob/main/openapi.json)明确包含 `GET /messages`、`POST /message`、`GET /status`、`GET /events` SSE 和上传接口；SSE 事件包括消息更新、状态变化和 Agent 错误，初始事件可重建当前状态。这是本次调研里最适合作为稳定适配器起点的接口。
- **Windows、远程和移动。** 官方安装脚本与说明主要面向 Unix/容器，没有找到 Windows 一等支持承诺。它可被 Coder workspace 或其他宿主远程暴露，前端自然可做响应式移动页面，但项目自身不提供远程配对或移动产品。
- **身份与权限边界。** 默认只允许 localhost Host，`--allowed-hosts` 是 Host header 白名单，不是用户认证或授权。官方 OpenAPI 未声明认证方案。Agent 继承容器/主机用户权限。因此不得把裸 AgentAPI 暴露到不可信网络；至少需要反向代理身份认证、每任务短期 token、网络策略和进程/文件系统隔离。
- **嵌入/fork 程度。** MIT + 小而专一 + OpenAPI/SSE，使它比完整桌面工作台更适合嵌入 Hunter。最大风险是终端屏幕解析天然受上游 CLI 输出变化影响，需契约测试、Agent 版本矩阵和降级为 raw terminal 的通道。

**判断：** 推荐作为“统一 Agent 驱动协议”的起点，不应被误当成现成工作台。

## 5. Coder Tasks 与 Coder Agents：企业平台强，但方向已分叉

### Coder Tasks（退役路线）

- [Tasks 文档](https://coder.com/docs/ai-coder/tasks)已明确：2026-06-02 起进入 12 个月 ESR 的付费支持阶段，并计划从 Coder v2.37（2026-09-01）移除，官方推荐迁移到 Coder Agents。
- Tasks 在完整 Coder workspace 中运行原生 CLI Agent，并由 AgentAPI 向 Web Task UI、VS Code 扩展和通知系统暴露状态。隔离单位是可由容器、VM、Kubernetes 等模板创建的 workspace，不是普通 Git worktree；若模板和 Agent 支持持久化，可以暂停/恢复。
- [核心原则](https://coder.com/docs/ai-coder/tasks-core-principles)和[安全文档](https://coder.com/docs/ai-coder/security)强调默认以已认证开发者身份工作，自动化可用服务账号或 GitHub App；workspace 网络策略、独立 scoped key，以及付费治理能力可进一步收紧边界。

**判断：** 能力成熟但生命周期已定，不应成为 Hunter 新依赖。其“每任务 workspace + 身份继承 + scoped credential”值得借鉴。

### Coder Agents（长期方向）

- [Coder Agents](https://coder.com/docs/ai-coder/agents)是运行在 Coder control plane 的自有 Go agent loop，接入 Anthropic、OpenAI、Google、Azure、Bedrock、OpenAI-compatible 等模型。它**不是** Claude Code/Codex CLI 的包装，因此不保留这些原生 Agent 的 UI、插件、hooks 和会话格式。
- 每个聊天可以创建隔离 workspace，agent 操作以当前 Coder 用户身份执行，沿用用户权限与服务端管理员控制；模型密钥可留在控制面，不必进入开发 workspace。这是候选中最接近成熟企业身份边界的方案。
- [Getting Started](https://coder.com/docs/ai-coder/agents/getting-started)公开实验性 Chats REST API 和 WebSocket 流，例如创建 chat 与订阅 chat stream，但文档明确标为 Beta/experimental，不能视为长期稳定契约。
- Coder 核心仓库为 [AGPL-3.0，并含企业许可部分](https://github.com/coder/coder)。Web 化意味着 Windows 或手机可通过浏览器访问，但部署、模板、身份提供商、模型网关和治理复杂度明显高于桌面工具。

**判断：** 若 Hunter 的真实目标是企业远程开发平台，可考虑直接部署/集成 Coder Agents；若目标是保留 Claude Code/Codex 的原生能力并做轻量工作台，则方向不匹配，也不是低成本 fork。

## 6. Nimbalyst：Crystal 的活跃继任者，UX 与扩展值得重点借鉴

- **状态与许可。** [官方仓库](https://github.com/nimbalyst/nimbalyst)是 Crystal 的继任项目，桌面/iOS 代码为 MIT；最新可核实发布为 [v0.59.2（2026-05-07）](https://github.com/nimbalyst/nimbalyst/releases/tag/v0.59.2)。相比 Orca/Emdash，检索日前两个月没有新 release，仍需结合 issue/commit 活跃度判断团队投入。
- **Agent 与会话。** 支持 Codex、Claude Code，OpenCode/Copilot 处于 alpha。它通过 Claude Agent SDK、Codex ACP/SDK 等方式形成统一 transcript，并能导入/续接部分 Claude CLI 会话；因此会话连续性较好，但显示的是 Nimbalyst UI，不保留上游 TUI。
- **任务与 worktree。** 提供 worktree、多会话、看板、终端、diff、编辑器、搜索与恢复。其编辑器/面板以扩展实现，Extension SDK 是比一般 Electron 内部 RPC 更明确的二次开发缝隙。
- **API / 事件面。** 官方源码与 release note 可看到 Electron IPC、内部 MCP 工具以及 transcript/session streaming 事件，但未找到对外承诺的 REST/OpenAPI。Extension SDK 更适合扩 UI/编辑器，不等同于远程任务控制 API。
- **Windows、远程与移动。** 支持 Windows 10+、macOS、Linux AppImage，并有原生 iOS 客户端与同步体验。当前仓库说明协作同步服务器是另一个项目；本次未能从同一官方仓库确认该服务当前完整源码、许可和自托管成熟度，不能把“客户端 MIT”外推为“整套移动协同栈都可自由 fork”。
- **身份与权限边界。** 发布记录显示登录/session refresh 与 Stytch、内部 MCP token 加固，但没有找到完整多租户 RBAC、设备授权、Agent OS 沙箱的正式安全模型。Agent SDK 的审批能力不等于操作系统隔离。
- **嵌入/fork 程度。** 客户端 MIT、跨平台、移动端和扩展模型很有吸引力；同步服务、Agent 协议耦合、身份服务依赖需要在 fork 前做代码与部署尽调。

**判断：** 推荐进入第二轮源码 Spike，重点验证离线运行、同步服务替代、Codex/Claude 会话迁移与扩展 API；不建议仅凭客户端 README 就决定全面 fork。

## 7. Vibe Kanban：源码仍有价值，但产品服务已经终止

- **状态与许可。** [官方关闭公告](https://vibekanban.com/blog/shutdown)称公司在 2026-04-10 关闭，云端远程服务约 30 天后移除，本地 workspace 可继续使用，项目转社区维护。仓库为 [Apache-2.0](https://github.com/BloopAI/vibe-kanban/blob/main/LICENSE)，最后可核实 release 为 [v0.1.44（2026-04-24）](https://github.com/BloopAI/vibe-kanban/releases/tag/v0.1.44)。
- **Agent 与 UI。** 支持 Claude Code、Codex、Gemini CLI、Copilot、Amp、Cursor、OpenCode、Droid、CCR、Qwen 等，通过统一 UI 把命令、文件操作、工具调用、Agent 回复与状态标准化展示；[执行监控](https://www.vibekanban.com/docs/core-features/monitoring-task-execution)不是原始 TUI。审批支持范围也曾因 Agent 而异。
- **任务/worktree。** 看板任务对应 workspace/分支，支持并行 Agent、终端、开发服务器、diff 评论、预览和 PR。
- **API / 事件面。** 源码有后端 HTTP、实时执行日志与 MCP 配置，但官方文档没有给出稳定的外部任务控制 OpenAPI。停服后更不能把原云 API 当作可靠依赖。
- **Windows、远程与身份。** release 提供 Windows MSI/EXE；原[远程访问](https://vibekanban.com/docs/remote-access)依赖隧道/云配对，[云认证](https://www.vibekanban.com/docs/cloud/authentication)使用 GitHub/Google OAuth，但这些说明已被关闭公告实质性取代。本地 Agent 仍继承本机用户权限，worktree 不是安全沙箱。
- **嵌入/fork 程度。** Apache-2.0 适合复用，但必须删除/替换已终止的云服务、鉴权、远程配对和项目数据路径，同时承担社区维护风险。

**判断：** 可借鉴统一执行日志、任务看板、diff review 组件；不应“直接套用”或依赖其 SaaS 路径。

## 8. Crystal：清晰易读的 MIT 先驱，但已经冻结

- [官方 README](https://github.com/stravu/crystal#crystal-is-deprecated)明确声明 2026-02 起 Crystal 被 Nimbalyst 取代且不再更新；最后 release 为 [v0.3.5（2026-02-26）](https://github.com/stravu/crystal/releases/tag/v0.3.5)，许可为 [MIT](https://github.com/stravu/crystal/blob/main/LICENSE)。
- 支持 Claude Code 和 Codex；每会话独立 worktree，后期版本允许一个 worktree 内多个 Agent。SQLite 保存 session/history，Electron 通过 PTY 提供输出、终端、diff 和编辑器。
- [源码架构说明](https://github.com/stravu/crystal/blob/main/CLAUDE.md)列出 sessions/projects/prompts 等 REST 路由和 IPC 实时输出，但这是项目内部架构，不是版本化公共 API。
- macOS 有主要分发路径；Windows 仅有从源码构建与 Visual Studio 依赖说明，没有成熟官方安装器。没有官方远程/移动体验、服务端认证或 OS 级沙箱；进程继承桌面用户权限。

**判断：** MIT 使它可 fork，但基于冻结代码新建产品会立即继承维护债；应优先评估 Nimbalyst，或只抽取小型 worktree/session 实现。

## 9. Superset：功能全面，但许可证和平台限制显著

- **状态与许可。** 官方仓库最新可核实版本为 [v1.11.3（2026-05-24）](https://github.com/superset-sh/superset/releases/tag/v1.11.3)。代码采用 [Elastic License 2.0](https://github.com/superset-sh/superset/blob/main/LICENSE.md)，它允许使用和修改，但禁止把产品作为托管服务提供给第三方、绕过许可密钥等；不能按常规 MIT/Apache 开源基座理解。
- **Agent 与会话。** [Agent Integration](https://docs.superset.sh/agent-integration)支持 Amp、Claude、Codex、OpenCode、Pi、Gemini CLI、Cursor、Kimi。终端模式直接运行官方 CLI，保留原生终端行为；聊天模式使用 Superset UI。提供 inline approval 和 Agent 访问 workspace 外路径时的 sandbox 提示。
- **任务/worktree。** 原生并行 workspace/worktree、终端、编辑器、diff、自动化和远程 host。
- **API / 事件面。** [MCP v2](https://docs.superset.sh/mcp)通过 OAuth 2.1 或 API key 管理 task、workspace、automation、project、host；[TypeScript SDK](https://docs.superset.sh/sdk/getting-started)与[参考文档](https://docs.superset.sh/sdk/reference)能创建 workspace 并启动 Agent，但官方明确标记 early alpha、可能破坏或移除。[CLI/host server](https://docs.superset.sh/cli/host-server)仍为 beta，流量通过云 API/relay。API key 拥有完整组织访问权限，需要独立保管。
- **Windows、远程与移动。** [Overview](https://docs.superset.sh/overview)仍将 Windows/Linux 写为 coming soon，当前桌面端仅 macOS。[Remote Workspaces](https://docs.superset.sh/remote-workspaces)为 Pro 能力，通过注册 host 与 relay 工作，角色主要是 owner/member；官方建议使用专用 host。没有官方移动客户端。
- **身份与权限边界。** 组织 OAuth、API key、host membership 形成基本边界，但 Agent 进程仍使用 host 上的 CLI/GitHub 凭据。API key 是组织级高权限，远程 host 暴露范围与云 relay 是 Hunter 需要单独接受的信任假设。
- **嵌入/fork 程度。** 功能上很接近成熟产品，但 ELv2、macOS 限制、云控制面耦合及 alpha SDK 使其不适合作为 Hunter 可自由演进的 fork。若 Hunter 只是内部工具而非对外托管，也仍应由法务确认 ELv2 使用边界。

**判断：** 可作为交互与远程 host 设计参考；在 Windows 优先、未来可能产品化的前提下不列为首选。

## 10. Conductor：优秀的 macOS 产品参照，无法作为代码基座

- 官方 [changelog](https://www.conductor.build/changelog)截至检索日显示 0.76.0（2026-07-16），产品持续更新；但没有找到官方公开源码仓库或允许 fork/再分发的许可证。
- [Harnesses](https://www.conductor.build/docs/reference/harnesses)支持 Claude Code、Codex、Cursor、OpenCode，既可用受管理版本，也可选择系统 executable。其聊天、checkpoint、plan/review 是 Conductor 自定义 UI，不是原 Agent TUI。
- [Parallel Agents](https://www.conductor.build/docs/concepts/parallel-agents)与 [Git Worktrees](https://www.conductor.build/docs/concepts/git-worktrees)支持多 workspace 或同 workspace 多 Agent，并通过 worktree 隔离文件改动。
- 公开集成仅见[本机 deep links](https://www.conductor.build/docs/reference/deep-links)，可传 prompt、path、Linear 等；没有找到公共 REST/OpenAPI/WebSocket/事件流。设置 schema 和 MCP 配置不等于工作台控制 API。
- [安全与权限](https://www.conductor.build/docs/reference/security-and-permissions)说明 Agent 在用户 Mac 上运行；[FAQ](https://www.conductor.build/docs/faq)进一步说明它们直接在系统运行、与 macOS 用户权限相同，没有额外沙箱。聊天数据主要留在本机，但这也意味着没有成熟的多租户服务端边界。仅 macOS，无官方 Windows、移动或托管 IDE。

**判断：** 适合借鉴 workspace/agent mode/checkpoint 的产品设计；闭源、Mac-only、无控制 API，排除 fork 与深度嵌入。

## 11. Claude Squad：原生会话保真标杆，不是图形化控制平台

- 官方仓库采用 [AGPL-3.0](https://github.com/smtg-ai/claude-squad/blob/main/LICENSE)，最新可核实版本为 [v1.0.18（2026-05-23）](https://github.com/smtg-ai/claude-squad/releases/tag/v1.0.18)。
- 支持 Claude Code、Codex、Gemini、Aider、OpenCode、Amp 和自定义 program profile。它以 tmux 启动并附着真实 Agent TUI，自己的 TUI 只做 session 列表、状态和 diff；detach 后 Agent 继续运行，再 attach 时完整恢复。因此它是本次候选中“保留原生 UI/会话”最直接的实现。
- 每任务独立 git worktree 和 tmux session，可后台并行、review diff、checkout/push。没有 Web、公共 HTTP API 或事件流，主要入口是 CLI/TUI 与 JSON 配置。
- 官方安装路径依赖 Homebrew 或 bash/tmux，没有声明原生 Windows 支持；通过 WSL 使用是合理推断，但不是官方 Windows 产品承诺。远程可自行 SSH 到 tmux，但没有配对、浏览器或移动 UX。
- 身份就是运行进程的 OS 用户与其 Git/Agent 凭据；worktree 只隔离 Git 文件变更。实验性 yolo/autoyes 会绕过确认，应默认关闭。无多用户认证、RBAC、审计或网络沙箱。
- AGPL 允许 fork，但若 Hunter 将修改版通过网络提供给用户，需要遵守相应源码提供义务，且仍需从头构建图形 UI、API 与 Windows 支持。

**判断：** 借鉴“tmux 是会话宿主，工作台只是控制器/观察器”的架构；不把它当完整 Hunter 基座。

## 补充候选：更偏移动遥控，而非完整工作台

- [Yep Anywhere](https://github.com/kzahel/yepanywhere)（MIT；[v0.4.28，2026-04-16](https://github.com/kzahel/yepanywhere/releases/tag/v0.4.28)）专注通过端到端加密的 Web/移动界面遥控 Claude Code/Codex，会话连续性强，但不提供成熟的 worktree 任务隔离和完整桌面编排。适合参考配对、加密、移动消息流。
- [Paseo](https://github.com/getpaseo/paseo)采用 AGPL，提供桌面/CLI/移动取向的 coding-agent 控制，并有 worktree 选项；成熟度和生态体量低于 Orca/Emdash。本轮不把它列入首选，但其远程控制协议值得在移动专题中继续核实。

## 推荐采用路径

### 路径 A：OpenClaw embedded child（推荐）

```text
Hunter UI / Task / Knowledge / Policy / Audit
                     │
        versioned Gateway WS/RPC adapter
                     │
       supervised OpenClaw Gateway child
          ┌──────────┼──────────┐
   Codex app-server  ACP/acpx   channels/nodes
          │           │          │
   native threads   Claude/...  Win/iOS/Android/
                                Feishu/Telegram
```

1. Hunter 管理 OpenClaw 版本、真实 Node runtime、child PID、readiness、restart/shutdown 与日志；先固定 v2026.7.1，不追随 `main`。
2. 外部功能只走文档化 Gateway RPC；不读 OpenClaw state 文件。建立 protocol schema、RPC method、event family 与错误码的契约测试。
3. Hunter 身份映射到专用 Gateway/device/operator scope；不同不信任团队使用不同 Gateway + OS 用户/host，不在一个 Gateway 上模拟敌对租户。
4. Codex 首选 native app-server，Claude Code/其他 CLI 走 ACP；UI 显示每个 runtime 的真实 sandbox/approval/session 能力。
5. ACP task 必须进入 Hunter 管理的容器、VM、受限 OS 用户或隔离 remote workspace，不能只指定 `cwd`。
6. 优先复用官方 Windows Hub、mobile 与渠道；Hunter 自己的 Web/桌面 UI只实现差异化的计划、归档、知识、审查和多项目视图。

### 路径 B：OpenClaw optional provider（最低迁移风险）

- 在 Hunter 增加 `OpenClawGatewayProvider`，通过 URL + device/operator credential 发现 capabilities、sessions、tasks、models 和 nodes。
- 本地没有 OpenClaw 时维持现有 Hunter/AgentAPI runtime；装好 OpenClaw 时开放 native Codex、ACP、mobile/channel 与 managed worktree。
- 不承诺把 OpenClaw session 无损迁移到其他 provider；用统一 artifact/task summary 做跨 provider 归档，把 native thread id 作为 provider-owned reference。
- 适合先做一到两个 release 的兼容层，再依据实际采用率决定是否进入 embedded child。

### 路径 C：Whole-fork OpenClaw（只在必须深改时）

- fork 前先列出 Gateway/Control UI/Windows/iOS/Android/渠道中必须改 core 的项目；若多数需求能由 RPC + Plugin SDK 实现，就不要 whole-fork。
- 对不得不 fork 的部分建立每月上游 rebase/merge、Plugin SDK migration、第三方 notices、安全公告和全平台 release lane。
- 不从仓库内部 import private-local `plugin-sdk` helper；Hunter 自有模块只依赖公开窄 subpath 或 Gateway protocol。

### 路径 D：Orca / AgentAPI 备选

- 若核心需求是原始 CLI TUI 的桌面 Kanban 和快速 UI 验证，fork Orca；先反转 yolo 权限默认值并补稳定控制协议。
- 若核心需求是最小、MIT、OpenAPI/SSE 的单 Agent 适配层，采用 AgentAPI，并由 Hunter 自建 task/worktree/sandbox/control plane。
- 若“企业远程开发环境与治理”比保留原生 CLI 更重要，可直接评估 Coder Agents，但接受完整平台与许可依赖。

## 建议的下一轮验证门槛

先对 **OpenClaw embedded child** 安排 3–5 天 Spike；Orca、Emdash、Nimbalyst 作为 UI/fork 对照各安排 1–2 天，并使用同一验收表：

1. Windows Hub + app-owned WSL 与 native CLI 两条路径各运行 Codex、Claude Code，各创建 5 个 managed worktree，测试 Hunter/Gateway/Hub 分别重启、崩溃、审批与上下文恢复。
2. 断网与上游 CLI 升级时验证会话是否仍可进入 raw terminal，数据是否可导出。
3. 检查 Agent 是否能越过 worktree 读取用户主目录、SSH key、浏览器凭据和其他任务目录；确认产品真实隔离边界。
4. 捕获完整 Gateway 控制链路，确认 WS/RPC 能实现创建任务、发送输入、订阅增量输出、取消、审批、归档与恢复；实测 npm gateway client 是否已发布，不可用时基于 protocol schema 生成 Hunter client。
5. 对桌面、移动、同步服务、扩展、品牌资产分别做许可证清单；不能只看仓库根 LICENSE。
6. 用一个非管理员 Windows 用户和一个受限 SSH 用户测试，记录所需端口、Gateway/device/operator credentials、日志中的敏感信息和撤销路径；分别验证 `operator.read/write/approvals/admin`。
7. 在 sandboxed native subagent、native Codex、ACP Claude、ACP Codex 四条路径执行同一越界用例，证明 UI 能准确显示不同安全边界，且 ACP 被放入外部 OS/容器隔离。
8. 从 Feishu 与 Telegram 各发起任务、接收增量输出和审批，再从 iOS/Android 恢复同一 session；验证 sender/channel identity 不会意外获得 Gateway 管理权限。

若 Spike 只选一个，选 **OpenClaw embedded child**。若它的 Gateway/session 语义无法映射 Hunter，再退到 **AgentAPI + Hunter 自建控制面**；只有在产品必须以原始 CLI TUI/Kanban 为中心时，才把 **Orca fork** 提到首位。
