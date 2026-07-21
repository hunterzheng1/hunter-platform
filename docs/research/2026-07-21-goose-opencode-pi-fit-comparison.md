# Goose、OpenCode、Pi 与 Hunter Runtime 适配性复核

> **历史快照（已被取代）**：本文针对旧 `Approved v1` 的宿主选择进行复核，
> 不再定义 Hunter Platform 的产品或 Phase 0。当前结论见
> [`2026-07-21-hunter-platform-landscape-and-reuse.md`](2026-07-21-hunter-platform-landscape-and-reuse.md)。

> 调研日期：2026-07-21
> 事实范围：仅采用项目官方文档、官方 GitHub 仓库/源码和官方安全说明；版本、功能与限制均绑定本日期。
> 判断范围：标注为“分析”或“建议”的内容是基于官方事实与 Hunter Runtime `Approved v1` 架构的推论，不是三个项目的官方承诺。
> 安全口径：工具权限、审批提示、Hook 和 OS 隔离是不同层级；本文不会把前三者宣传成 Sandbox。

## 0. 结论

Goose、OpenCode 和 Pi 不是同一层产品：

- **Goose 是可直接使用、也明确允许做定制发行版的通用本地 Agent 平台。** 它已经提供 Windows 原生 Desktop/CLI、API、会话、模型 Provider、MCP、Recipes、权限界面和 ACP 双向集成面。
- **OpenCode 是 coding-first 的完整产品与强插件宿主。** 它的编程体验、Client/Server、OpenAPI/SDK、细粒度权限和 `tool.execute.before` 对 Hunter 很有吸引力，但官方 Windows 最佳体验仍是 WSL，并且它的 ACP 官方能力是“把 OpenCode 暴露给 ACP 客户端”，不是已证实的“把 Codex/Claude/Pi 当作下游 Agent Provider”。
- **Pi 是最适合自行组装 Agent Harness 的 TypeScript 工具箱。** 它提供 AgentSession、RPC、SDK、树形 JSONL 会话和极强 Extension 事件面；代价是核心刻意不内建权限弹窗、MCP、子 Agent 或 Plan mode，默认继承启动用户权限，产品化责任更多落在 Hunter 身上。

因此，Hunter Runtime Phase 0 选择 Goose 的准确理由不是“Goose 每一项都比另外两个强”，而是：

> **Goose 最适合验证“能否把通用 Agent 基础设施交给上游，只保留薄 Hunter Kernel”这个架构假设。**

这个选择是有条件、可逆的：

1. 如果 Goose 的 Hook/权限可见度、Windows 路径与进程语义、Session 映射或关键动作独占做不到，转向 **OpenCode + Hunter plugin/sidecar**。
2. 如果 Hunter 必须精确控制 Agent loop、每次工具调用、事件顺序和会话生命周期，并愿意承担更多实现，转向 **Pi + Hunter Kernel**。
3. 如果三者接入后 Hunter 的治理增量都不值维护成本，则退回原生 Codex/Claude/OpenCode/Pi + 极薄 Skills/MCP，而不是继续扩大自研 Runtime。

## 1. 先用通俗语言区分三者

| 项目 | 通俗比喻 | 最自然的使用方式 | Hunter 需要自己补什么 |
|---|---|---|---|
| Goose | 已装修好的通用工作室，允许做自己的品牌发行版 | 直接用 Desktop/CLI；通过 MCP、Hooks、Recipes 和 ACP 接能力 | 关键动作的强门禁、Evidence、Ledger、Windows 隔离验证 |
| OpenCode | 已装修好的专业编程工作室，前后端接口很完整 | 直接用 TUI/Desktop/IDE；用 TS 插件或 HTTP/SDK 嵌入 Hunter | 跨其他 Agent 的统一入口、Hunter 证据语义、外部隔离 |
| Pi | 建工作室的高质量零件与施工图 | 用 CLI，也可把 `AgentSession` 嵌入自己的 Node/TS 产品 | 权限产品、MCP/子 Agent/Plan、发行 UI、治理和隔离 |

“Goose 更合适”只针对当前 Hunter 的目标成立：**先证明薄 Kernel 能否成立，并尽量不再自研会话、Provider、Agent loop、Desktop/TUI 和通用插件系统。**

## 2. 研究对象与版本快照

### 2.1 Goose

- 官方仓库：[`aaif-goose/goose`](https://github.com/aaif-goose/goose)
- 官方定位：运行在本机的通用 Agent，提供 Desktop、CLI、API；Rust 实现；支持 15+ Provider 和 MCP 扩展。[官方 README](https://github.com/aaif-goose/goose#readme)
- 治理/许可证：AAIF/Linux Foundation 项目，Apache-2.0。[官方仓库](https://github.com/aaif-goose/goose)
- 本次快照可见最新 Release：`v1.43.0`（2026-07-14）。[官方 Releases](https://github.com/aaif-goose/goose/releases)

### 2.2 OpenCode

- 官方活跃仓库：[`anomalyco/opencode`](https://github.com/anomalyco/opencode)
- 官方定位：开源 AI coding agent，提供终端界面、Desktop 和 IDE extension。[官方 Intro](https://opencode.ai/docs/)
- 许可证：MIT。[官方仓库](https://github.com/anomalyco/opencode)
- 本次快照可见最新 Release：`v1.18.4`（2026-07-20）。[官方 Releases](https://github.com/anomalyco/opencode/releases)

### 2.3 Pi

- 本文的 Pi 指 **Pi Agent Harness**，当前官方仓库为 [`earendil-works/pi`](https://github.com/earendil-works/pi)；旧地址 `badlogic/pi-mono` 当前重定向到该仓库。
- 官方包边界包括 `pi-ai`（多 Provider LLM API）、`pi-agent-core`（tool calling 与状态）、`pi-coding-agent`（CLI）、`pi-tui`。[官方 README](https://github.com/earendil-works/pi#readme)
- 许可证：MIT。[官方仓库](https://github.com/earendil-works/pi)
- 本次快照可见最新 Release：`v0.80.10`（2026-07-16）。[官方 Releases](https://github.com/earendil-works/pi/releases)

版本号只是本次事实快照，不是适配评分依据。三者都在快速更新，Phase 0 必须固定实际试点版本并运行兼容性测试。

## 3. 逐项能力比较

下表的“事实”均可由表内链接直接核验；“Hunter 判断”是适配性推论。

| 维度 | Goose | OpenCode | Pi |
|---|---|---|---|
| 核心定位 | 通用本地 Agent 平台，Desktop/CLI/API；不只面向代码。[仓库](https://github.com/aaif-goose/goose) | coding-first Agent，TUI/Desktop/IDE。[Intro](https://opencode.ai/docs/) | Agent toolkit + 可自扩展 coding CLI。[仓库](https://github.com/earendil-works/pi) |
| 主要实现 | Rust core，另有 TypeScript UI。[仓库语言与源码](https://github.com/aaif-goose/goose) | TypeScript/Bun 单仓，Client/Server。[Server](https://opencode.ai/docs/server/) | TypeScript 多包 SDK/runtime/TUI。[仓库](https://github.com/earendil-works/pi) |
| 模型接入 | 15+ 原生 Provider；ACP Provider 可调用 Claude Code、Codex、Pi 等外部 Agent，并把 Goose MCP 扩展传给下游 Agent。[仓库](https://github.com/aaif-goose/goose) · [ACP Providers](https://goose-docs.ai/docs/guides/acp-providers/) | 官方称支持 75+ LLM Provider 与本地模型；官方 ACP 文档证明 `opencode acp` 可把 OpenCode 暴露为 ACP Agent。[Providers](https://opencode.ai/docs/providers/) · [ACP](https://opencode.ai/docs/acp/) | `pi-ai` 提供统一多 Provider API；CLI 支持 API key 和部分现有订阅登录。[仓库](https://github.com/earendil-works/pi) · [coding-agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md) |
| MCP | 原生核心扩展面；本地/远端扩展，ACP Provider 会把扩展作为 MCP 传给下游 Agent。[ACP Providers](https://goose-docs.ai/docs/guides/acp-providers/) | 原生支持本地和远端 MCP、远端 OAuth，并可按 Agent/权限管理工具。[MCP servers](https://opencode.ai/docs/mcp-servers/) | **核心刻意不内建 MCP**；可用 Extension 或第三方包实现。[coding-agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#philosophy) |
| 扩展与工作流 | MCP extensions、Hooks、Skills、Recipes/subrecipes；官方支持 Custom Distribution。[Hooks](https://goose-docs.ai/docs/guides/context-engineering/hooks/) · [Recipes](https://goose-docs.ai/docs/guides/recipes/) · [Custom Distributions](https://goose-docs.ai/docs/guides/custom-distributions/) | JS/TS Plugin、Custom tools、Skills、MCP；插件可订阅 session/message/permission/tool 等事件。[Plugins](https://opencode.ai/docs/plugins/) · [Skills](https://opencode.ai/docs/skills/) | Extension 可注册/覆盖工具、命令、UI、Provider，拦截事件，嵌入 SDK/RPC；Pi package 可打包 Extension/Skill/Prompt/Theme。[Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) · [SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md) |
| 子 Agent/Plan | Recipes/subrecipes 可形成工作流与并行子任务。[Recipes](https://goose-docs.ai/docs/guides/recipes/) | 内建 Build/Plan 主 Agent 和 General/Explore/Scout 子 Agent，可配置 task 权限。[Agents](https://opencode.ai/docs/agents/) | 核心明确不内建 subagents 和 plan mode；使用 Extension、外部进程或第三方包自行实现。[coding-agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#philosophy) |
| 会话 | 本地 SQLite；Desktop/CLI 共用，支持 resume/fork/export/import 与自动压缩。[Session Management](https://goose-docs.ai/docs/guides/sessions/session-management/) · [Context](https://goose-docs.ai/docs/guides/sessions/smart-context-management/) | Server/SDK 提供 session create/list/children/fork/diff/revert/summarize 等接口。[Server](https://opencode.ai/docs/server/) | JSONL 树形会话，`id/parentId` 支持原位分支；resume/fork/clone/compaction；SDK 直接提供 `SessionManager`。[README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#sessions) · [SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md#session-management) |
| 程序化集成 | `goose serve`、API、`goose acp`，也可让 Goose 作为 ACP Agent 或使用其他 ACP Agent 为 Provider。[Custom Distribution](https://github.com/aaif-goose/goose/blob/main/CUSTOM_DISTROS.md) · [ACP Clients](https://goose-docs.ai/docs/guides/acp-clients/) | Headless HTTP Server、OpenAPI 3.1、SSE、类型安全 JS/TS SDK；`opencode acp` 可作为 ACP Agent。[Server](https://opencode.ai/docs/server/) · [SDK](https://opencode.ai/docs/sdk/) · [ACP](https://opencode.ai/docs/acp/) | 同进程 SDK、JSON/print、严格 JSONL RPC；适合 Node/TS 嵌入或跨语言子进程集成。[SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md) · [RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md) |
| 权限 UX | 工具级 Always Allow / Ask Before / Never Allow。[Tool Permissions](https://goose-docs.ai/docs/guides/managing-tools/tool-permissions/) | `allow/ask/deny`，可按命令、路径、外部目录、Agent、MCP 工具细分；默认大部分权限为 allow。[Permissions](https://opencode.ai/docs/permissions/) | 核心无 permission popups；可用 Extension `tool_call` 自建 Gate 或用工具 allowlist 禁用工具。[README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#philosophy) · [Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) |
| Pre-tool 拦截 | `PreToolUse` 可 block；**Hook 失败、超时或没有有效 block 信号时 fail-open**。[Hooks](https://goose-docs.ai/docs/guides/context-engineering/hooks/#blocking-a-tool-call) | `tool.execute.before` 可改参数或抛异常阻止执行；插件文档以保护 `.env` 为例。[Plugins](https://opencode.ai/docs/plugins/#env-protection) | Extension `tool_call` 在执行前可 block/改参数；官方说明 `tool_call` handler 报错时阻断该工具，但一般 Extension 错误只记录并继续。[Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) |
| OS Sandbox | 官方内建完整方案是可选 **macOS Desktop** sandbox；Windows 不能据此宣称隔离。[Sandbox](https://goose-docs.ai/docs/guides/sandbox/) | 官方安全模型明确：**不 sandbox Agent**；权限是 UX，不提供安全隔离，真实隔离应使用 Docker/VM。[SECURITY.md](https://github.com/anomalyco/opencode/security) | 官方明确：不内建文件、进程、网络或凭据权限系统；默认继承启动用户/进程权限，强边界需容器或 Sandbox。[官方 README](https://github.com/earendil-works/pi#permissions--containerization) |
| Windows | 官方提供原生 Windows Desktop/CLI。[仓库](https://github.com/aaif-goose/goose) | 可原生运行，但官方推荐 WSL 获取最佳性能和兼容性。[Windows](https://opencode.ai/docs/windows-wsl/) | Node/TS CLI 有 Windows 说明与 PowerShell 测试脚本；真正兼容性仍需 Hunter 实机验证。[README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md) |
| 做 Hunter 发行版 | 官方明确支持 Provider、扩展、品牌、Prompt、Recipe、ACP/UI 的 Custom Distribution。[Custom Distributions](https://goose-docs.ai/docs/guides/custom-distributions/) | 可通过配置、Plugin、Server/SDK 构建衍生产品，但官方文档没有与 Goose 同等的组织发行版产品面；使用 OpenCode 名称还要求声明非官方关联。[仓库](https://github.com/anomalyco/opencode#building-on-opencode) | 最可嵌入、最可改造；但这意味着 Hunter 自己成为产品集成者，而不是只发布薄配置层。[SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md) |

## 4. 三者的关键事实与不能夸大的地方

### 4.1 Goose：平台能力最完整，但 Hook 不是安全边界

#### 已验证事实

1. Goose 官方定位是通用本地 Agent，提供原生 Desktop、CLI、API，支持 Windows，并支持 15+ Provider 和 MCP。[官方仓库](https://github.com/aaif-goose/goose)
2. 官方明确支持 Custom Distribution，可预配置 Provider、打包 MCP Extension、修改 Prompt/品牌、用 Recipes 分发工作流，并通过 `goose serve` 或 `goose acp` 构建新界面。[Custom Distributions](https://goose-docs.ai/docs/guides/custom-distributions/)
3. Goose 可处于 ACP 两侧：
   - 作为 ACP **客户端/上层宿主**，把 Claude Code、Codex、Pi 等 Agent 当 Provider；Goose 扩展会作为 MCP 传给下游 Agent。[ACP Providers](https://goose-docs.ai/docs/guides/acp-providers/)
   - 通过 `goose acp` 作为 ACP **Agent** 供编辑器/客户端调用。[ACP Clients](https://goose-docs.ai/docs/guides/acp-clients/)
4. Goose 原生 Session 位于本地 SQLite；Desktop 与 CLI 共用会话，支持恢复、复制/分叉和导入导出。[Session Management](https://goose-docs.ai/docs/guides/sessions/session-management/)
5. 工具权限有 Always Allow、Ask Before、Never Allow 三档。[Tool Permissions](https://goose-docs.ai/docs/guides/managing-tools/tool-permissions/)
6. `PreToolUse` 能阻断工具调用，但 Hook 启动失败、超时或没有给出规定的 block 信号时，Goose 会记录后继续，即 **fail-open**。[Hooks](https://goose-docs.ai/docs/guides/context-engineering/hooks/#blocking-a-tool-call)
7. 当前 Hook 不发出 `SubagentStart`/`SubagentStop`，不能仅靠 Hook 完整观察子 Agent 生命周期。[Hooks](https://goose-docs.ai/docs/guides/context-engineering/hooks/)
8. ACP Provider 当前不支持 Goose Session 的 resume/fork，且 ACP session ID 与 Goose session ID 不同。[ACP Providers](https://goose-docs.ai/docs/guides/acp-providers/#limitations)
9. Goose 的官方 OS sandbox 当前依赖 macOS `sandbox-exec`；它不能为 Hunter 的 Windows v0.1 提供现成的 OS 隔离保证。[Sandbox](https://goose-docs.ai/docs/guides/sandbox/)
10. Goose 权限模式包含 Autonomous、Manual、Smart、Chat；Autonomous 是默认模式。Manual/Smart 对工具风险的分类由模型 Provider 解释，官方称其为 best-effort，不能作为确定性的强制策略。[Goose Permissions](https://goose-docs.ai/docs/guides/goose-permissions/)
11. 官方 2026-04-08 路线说明称 ACP Server 已达到 production-ready，同时新的 TypeScript TUI 与 Tauri Desktop 仍在迁移，旧 `goosed`/Rust CLI 计划被替换。这意味着 ACP 核心方向明确，但 Phase 0 必须固定版本并把客户端层升级纳入兼容测试。[Goose 2.0 update](https://goose-docs.ai/blog/2026/04/08/goose-acp-and-new-tui/)
12. Goose 当前 Desktop 已移除通过 secure tunnel 的 Mobile Access；官方 Telegram Gateway 仍标记为实验性，并要求 Desktop 保持打开、电脑保持唤醒。[Mobile Access](https://goose-docs.ai/docs/experimental/remote-access/mobile-access/) · [Telegram Gateway](https://goose-docs.ai/docs/experimental/remote-access/telegram-gateway/)

#### Hunter 分析

- Goose 适合承担“日常 Agent 平台”，不适合被当成 Hunter 的唯一可信安全边界。
- Hunter Guard/Hook 适合快速检查和观测；push、merge、publish、archive close 等关键动作必须只暴露为 Hunter Kernel 受管工具，由 Kernel 自己 fail-closed。
- ACP 是长期减少多 Adapter 数量的机会，但 Phase 0 不应依赖它：当前 resume/fork 与双 ID 关联限制会污染最小试验。
- Goose 的优势来自“可以少造很多基础设施”，不是来自“已经解决 Windows Sandbox”。
- Goose 的权限 UX 也不是 Hunter Policy Engine：Phase 0 应显式固定 Manual/Smart，但所有 critical action 仍必须由 Kernel 做确定性判定。
- Goose 当前没有可依赖的正式移动端控制面，且客户端正在 2.0 迁移；这两点应转化为版本固定、兼容测试和停止条件，而不是被选择性忽略。

### 4.2 OpenCode：编程宿主和插件面更直接，但不是跨 Agent 聚合层

#### 已验证事实

1. OpenCode 是完整 coding agent，提供 TUI、Desktop 和 IDE extension。[Intro](https://opencode.ai/docs/)
2. 它采用 Client/Server：TUI 也是 Server 的客户端；Server 提供 OpenAPI 3.1、SSE，官方 JS/TS SDK 的类型由规范生成。[Server](https://opencode.ai/docs/server/) · [SDK](https://opencode.ai/docs/sdk/)
3. Server/SDK 的 Session API 包括 create、children、fork、diff、revert、summarize、permission reply 等，适合做外部控制与观察。[Server](https://opencode.ai/docs/server/#sessions)
4. Plugin 是 JS/TS Module；`tool.execute.before` 可修改工具参数或抛异常阻断执行，并可监听 session、message、permission、file、tool 等事件。[Plugins](https://opencode.ai/docs/plugins/)
5. 权限为 `allow/ask/deny`，可按具体 Bash 命令、文件路径、外部目录、Agent、子 Agent 类型、Skill 和 MCP 工具设置；但官方也明确默认大部分权限是 `allow`。[Permissions](https://opencode.ai/docs/permissions/)
6. Agent Skills 直接发现 `.opencode/skills`、`.claude/skills` 和 `.agents/skills`，迁移 Hunter 现有 Skill 资产较顺。[Skills](https://opencode.ai/docs/skills/)
7. OpenCode 原生支持本地/远端 MCP 和远端 OAuth。[MCP servers](https://opencode.ai/docs/mcp-servers/)
8. `opencode acp` 把 OpenCode 启动为通过 stdio JSON-RPC 通信的 ACP Agent，可供 Zed/JetBrains 等客户端使用；官方页面没有声明它能把 Codex/Claude/Pi 作为下游 ACP Provider。[ACP](https://opencode.ai/docs/acp/)
9. Windows 可以原生运行，但官方推荐 WSL；Desktop 也可连接 WSL 内的 OpenCode Server。[Windows](https://opencode.ai/docs/windows-wsl/)
10. 官方威胁模型明确说明 OpenCode 不 sandbox Agent；权限系统是帮助用户知晓动作的 UX 功能，不是安全隔离；真正隔离应使用 Docker/VM。[SECURITY.md](https://github.com/anomalyco/opencode/security)
11. 官方 Provider 文档称支持 75+ LLM Provider 与本地模型。[Providers](https://opencode.ai/docs/providers/)

#### Hunter 分析

- 如果 Hunter 的主要目标收缩成“在一个优秀 coding agent 里加入治理与证据”，OpenCode 可能比 Goose 更直接：插件是 TS、before hook 更自然，权限粒度也更细。
- OpenCode 的 Server/SDK 特别适合 Workbench 或 Pocket 做受控的本地 Client，但不能把 Server 直接暴露到公网；官方要求在启用 Server 时设置密码，Hunter 目标架构仍应只允许 Runtime 主动出站连接。[Server](https://opencode.ai/docs/server/) · [SECURITY.md](https://github.com/anomalyco/opencode/security)
- 因而，若未来进入 Workbench/Pocket 阶段，OpenCode 的 OpenAPI、SSE、SDK、`attach`/Web Client 会比 Goose 当前移动端现状更值得优先做替换 Spike。不过 Approved v1 已把移动端排除在 Phase 0 之外，这项优势不足以单独推翻当前 Goose-only 试点。
- OpenCode ACP 的已验证方向是“OpenCode 作为 Agent”，不能据此声称它与 Goose 一样可统一复用 Codex/Claude/Pi 的现有 Agent runtime/订阅。
- 细粒度权限降低了接入摩擦，但仍不等于抵抗同用户任意代码、Shell 绕行、恶意 Plugin 或 Prompt Injection 的 OS 边界。

### 4.3 Pi：控制力最大，但“缺的功能”正是 Hunter 要承担的产品责任

#### 已验证事实

1. Pi 官方仓库包含多 Provider LLM API、Agent runtime、coding CLI 和 TUI，采用 MIT 许可证。[官方仓库](https://github.com/earendil-works/pi)
2. Pi 可用四种形态：interactive、print/JSON、RPC 和 SDK；SDK 的核心工厂是 `createAgentSession()`。[coding-agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md) · [SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
3. Session 是 JSONL 树，每个 Entry 有 `id/parentId`；支持 resume、fork、clone、树导航和 compaction。[Sessions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#sessions)
4. Extension 可注册或覆盖工具、命令、快捷键、Provider 和 UI；能监听完整的 Agent/Turn/Tool/Session 事件。`tool_call` 在工具执行前触发，可以修改参数或返回 block。[Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
5. 官方错误语义说明：普通 Extension 错误会记录、Agent 继续；但 `tool_call` handler 错误会阻断该工具。这个语义比 Goose 的 Hook fail-open 更有利于自建强 Gate，但仍须由 Hunter 自己实现并做对抗测试。[Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#error-handling)
6. Pi 核心明确不内建 MCP、subagents、permission popups、plan mode 或 background bash；这些能力交给 Extension、外部进程或第三方包。[Philosophy](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#philosophy)
7. Pi 官方明确没有内建文件、进程、网络或凭据访问控制，默认以启动用户/进程权限运行；需要强边界时必须容器化或 Sandbox。[Permissions & Containerization](https://github.com/earendil-works/pi#permissions--containerization)
8. Pi Package 和 Extension 运行在完整系统权限下，安装第三方包前必须审查源码。[coding-agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#pi-packages)

#### Hunter 分析

- Pi 最适合的情况不是“想少写代码”，而是“想让 Hunter 真正拥有 Agent runtime”。
- `AgentSession`、树形会话、RPC/SDK 和 `tool_call` fail-safe 给 Hunter 最干净的深集成点；可以更准确地把 Run、Turn、ToolEvent、Gate 和 Evidence 建在一个事件模型内。
- 代价是 Hunter 需要自行决定权限 UX、MCP、Plan/Subagent、桌面/远程 Surface、包信任、默认配置、升级兼容和 Sandbox 组合。这样做很容易重新走回“独立全栈 Harness”的高维护路线。
- 因此 Pi 应是“当上游扩展边界证明不足时的控制力回退”，而不是 Phase 0 的默认起点。

## 5. 为什么 Hunter Phase 0 首选 Goose

### 5.1 原因一：它最能验证 Hunter 的核心架构假设

Hunter 当前要验证的不是“能否再做一个 Agent loop”，而是：

> 把模型、会话、普通工具、UI、MCP、工作流和 Provider 交给成熟上游后，Hunter 只保留策略、Gate、Evidence、Ledger 和 Artifact Provenance，是否仍有足够价值？

Goose 已经覆盖最广的上游职责，并且官方明确支持 Custom Distribution，所以最适合做这个实验。若直接选 Pi，Hunter 会先补齐大量通用产品功能，试验结果无法区分“治理 Kernel 是否有价值”和“我们自己做的 Agent 产品是否好用”。

### 5.2 原因二：它符合当前用户环境

当前试点是单台 Windows、Local-only、固定版本、Goose-only：

- Goose 官方提供原生 Windows Desktop/CLI。[官方仓库](https://github.com/aaif-goose/goose)
- OpenCode 虽可原生运行，但官方最佳实践仍是 WSL，会引入路径、文件系统和进程边界差异。[Windows](https://opencode.ai/docs/windows-wsl/)
- Pi 能在 Windows 上运行，但若采用 Pi，Hunter 还需自行定义用户产品 Surface 和权限体验。

这不是说 Goose 的 Windows 安全能力更强；它只是对“原生 Windows 日常使用”摩擦更小。OS 隔离仍由 Hunter Phase 0 独立 Spike。

### 5.3 原因三：它允许 Hunter 成为发行配置，而不是长期 Fork

Goose 官方 Custom Distribution 明确覆盖：

- Provider 默认值；
- MCP Extension；
- System Prompt；
- 品牌；
- Recipe/Subagent 工作流；
- `goose serve` / `goose acp` 新 UI。

这让 Hunter 可以先采用“固定 Goose 版本 + Distribution 配置 + Guard + MCP + Kernel”，并把差异尽量留在外部适配层，而不是 Fork Goose core。[Custom Distributions](https://goose-docs.ai/docs/guides/custom-distributions/)

### 5.4 原因四：长期有机会减少多 Agent Adapter

Goose 的 ACP Provider 能把 Codex、Claude Code、Pi 等 Agent 作为 Provider，并把 Goose Extension 作为 MCP 传给下游 Agent。[ACP Providers](https://goose-docs.ai/docs/guides/acp-providers/)

**分析：**如果 ACP 成熟，Hunter 可以让 Goose 负责一部分跨 Agent 接入，而不是自己分别维护每个 Agent 的完整 loop/会话适配。不过当前 ACP resume/fork 和双 Session ID 限制仍存在，所以 Approved v1 正确地把 ACP 排除在 Phase 0 依赖之外。

### 5.5 原因五：失败可以清楚归因并回退

Phase 0～2 的 A/B/C 设计是：

- A：当前 Hunter + 当前宿主；
- B：stock Goose；
- C：Goose + Hunter。

B 与 C 可以固定同一 Goose、模型、Provider、Prompt、仓库和 Knowledge 快照，直接观察 Hunter 的增量价值和回归。若改用 Pi 并同时自建大量运行时/UX，C-B 的差异会混入产品实现差异，归因更差。

### 5.6 选择 Goose 不代表接受这些风险

以下任一项无法在不 Fork core 的条件下解决，就应停止深迁：

- 关键工具不能真正独占到 Hunter Kernel；
- Hook fail-open 导致高风险动作可能绕过；
- Session/Run/Evidence ID 无法可靠关联；
- Windows 路径、junction/worktree 或进程树不稳定；
- 升级频繁破坏 Hook/权限合同；
- 维护成本接近自有 Runtime；
- 用户需要 A2/远程 critical 安全，但 Windows 隔离路线都不可接受。

这些停止条件来自已被重置的旧版 `04-分期实施与迁移.md`，也是当时让“Goose 首选”保持诚实的必要部分；该文档不属于当前 Platform 基线。

补充边界：2026-07-21 的新事实——Goose 客户端层正在迁移、正式 secure-tunnel 移动入口已移除，而 OpenCode 有更清晰的 Server/API 集成面——都提高了版本固定和未来宿主复评的重要性；但它们没有改变 Approved v1 的 Phase 0 目标。若要把移动端或 Workbench 提前为当前主目标，应通过新的 ADR/用户决策重排宿主，而不是由本调研静默改写冻结设计。

## 6. 哪些条件下 OpenCode 更合适

应优先选择 **OpenCode + Hunter plugin/sidecar**，当且仅当你的优先级变为：

1. **日常编程体验优先于通用 Agent/跨 Agent 汇聚。** 主要任务就是代码、终端、LSP、Diff、Plan/Build、子 Agent。
2. **可以接受 WSL 是 Windows 主运行环境。** 仓库、路径、工具链和进程都能稳定迁入 WSL。
3. **希望用 TypeScript Plugin 直接拦截工具。** `tool.execute.before`、permission 事件和 Server/SDK 比 Goose 的外部 Hook 更适合快速接入 Hunter。
4. **希望 Workbench/Pocket 控制一个稳定 HTTP Agent Server。** OpenAPI、SSE、Session/permission API 是成熟的集成面。
5. **不再要求 Goose 式“把 Codex/Claude/Pi 当下游 Agent Provider”。** 允许 OpenCode 自己成为主 Agent，只把多模型 Provider 作为后端。
6. **愿意外加真正的隔离。** OpenCode 官方明确无 Sandbox，因此 Docker/VM/受限 OS 账户或其他隔离仍是独立工程。

OpenCode 不是“安全版 Goose”。它的权限更细、Hook 更顺手，但官方明确说权限是 UX，不是隔离；而且默认大部分权限是 allow。[Permissions](https://opencode.ai/docs/permissions/) · [SECURITY.md](https://github.com/anomalyco/opencode/security)

## 7. 哪些条件下 Pi 更合适

应选择 **Pi + Hunter Kernel**，当且仅当你的优先级变为：

1. **Hunter 必须拥有 Agent loop。** 不能容忍宿主 Hook 看不到或控制不了关键生命周期。
2. **必须在同一 TypeScript 进程里拿到 AgentSession 和事件。** Run/Turn/Tool/Gate/Evidence 需要严格关联。
3. **需要自己定义会话、分支、压缩、远程执行或 UI。** Pi 的 SDK/RPC/Extension 是构建平台的原材料。
4. **愿意实现或选择权限产品。** 包括确认 UI、路径/命令规则、策略存储、默认值、Headless 行为与审计。
5. **愿意实现 MCP、Subagent、Plan 等组合。** 或接受这些不是核心、从第三方包选择并承担供应链审查。
6. **愿意承担完整产品维护。** Provider 兼容、升级、包信任、Windows、Surface、Sandbox 和用户支持不再由 Goose/OpenCode 完整吸收。

Pi 的 `tool_call` fail-safe 是非常重要的技术优势，但不能从这一点推导出“Pi 更安全”：Pi 官方同时明确它默认以用户权限运行，且没有内建权限系统。只有 Hunter 把 Gate、默认策略和外部隔离全部实现并验证后，才能形成更强边界。

## 8. 决策表

| 你真正最在意什么 | 首选 | 原因 | 必须接受的代价 |
|---|---|---|---|
| 少维护基础设施，先验证薄 Kernel | Goose | 平台职责最全、原生 Windows、Custom Distribution、MCP/ACP | Hook fail-open、Windows 无现成 Sandbox、ACP Session 限制、客户端迁移中 |
| 最好的 coding-first 宿主与 TS 插件接入 | OpenCode | TUI/Desktop/IDE、OpenAPI/SDK、细权限、before hook、75+ Provider | Windows 推荐 WSL；无 OS Sandbox；跨 Agent 聚合目标缩小 |
| 完整拥有 Agent loop 与事件模型 | Pi | AgentSession/SDK/RPC/Extension 最干净 | 权限、MCP、子 Agent、Plan、Surface 和隔离更多由 Hunter 自己建设 |
| 不想维护统一宿主 | 原生 Agent + 薄 Skills/MCP | 最低维护成本 | 放弃统一会话/路由/运行时，只保留关键 Gate/Knowledge |

### 8.1 当前建议

维持 Approved v1 的顺序：

```text
Goose Phase 0/1/2 可逆试点
    ├─ 通过：保留 Goose + 薄 Hunter Kernel
    ├─ coding 宿主/Hook 更关键：OpenCode + Hunter plugin/sidecar
    ├─ 必须完整掌控 loop：Pi + Hunter Kernel
    └─ 治理增量不值成本：原生 Agent + 极薄 Skills/MCP
```

不要同时维护 Goose、OpenCode、Pi 三个正式一级集成。Phase 0 应先把 Goose 的停止条件测清楚；需要换宿主时，使用同一批任务、同一 Gate/Evidence 合同和同一 Windows fixtures 做替换 Spike。

## 9. 对 Hunter Phase 0 的具体含义

### 9.1 必须验证，而不能由文档推定

1. Goose `PreToolUse` 失败、超时、异常输出时，关键动作是否仍只能走 Hunter MCP/Kernel。
2. Goose 的 `timeout/cancel/retry` 是否产生重复 Gate 或重复副作用。
3. Goose Session ID、cwd、Hunter Run ID 和 Evidence 是否能稳定关联。
4. Windows PowerShell、长路径、非 ASCII、junction、subst/UNC、linked worktree、进程树是否可靠。
5. Goose 小版本升级是否只需修改 Distribution/Adapter/fixtures，而不需 Fork core。
6. restricted token、AppContainer、独立 OS/服务账户哪一种能在安全覆盖、Goose 兼容、凭据和维护成本之间达到可接受平衡。
7. 固定试点版本后，Goose 2.0 的 TUI/Desktop 迁移是否破坏 Session、Hook、Distribution 或 ACP 合同；迁移前后必须跑同一套 compatibility fixtures。

### 9.2 建议保留的宿主替换 Spike

如果 Goose 触发停止条件，再做两个有界 Spike，而不是全面迁移：

- **OpenCode Spike：**同一关键 action 合同，用 `tool.execute.before` + permission API 验证 fail-closed、远程 approval 回传、WSL/Windows 路径和 Session Evidence。
- **Pi Spike：**同一关键 action 合同，用 `AgentSession` + `tool_call` 验证事件完整性、错误 fail-safe、会话恢复与 Hunter 自建权限/隔离的最小成本。

比较的不是“Demo 能否跑起来”，而是同一组 A1/A2、安全、证据、性能和维护阈值。

## 10. 研究限制

- 本报告核验的是截至 2026-07-21 的官方声明和公开源码接口；不替代同机安装后的行为测试。
- 三个项目更新很快，尤其是 OpenCode 文档在 2026-07-20 仍有更新；实施时必须固定 Release/commit，并保存配置与协议 fixture。
- “官方文档没有声明某能力”不等于源码永远没有；本文对 OpenCode 跨 Agent ACP 的表述仅限当前官方文档可证明的方向。
- Hook/Plugin/Extension 的可阻断语义仍可能被其他执行路径、Shell、子 Agent、用户代码或配置绕开；只有 Hunter 管理的工具面可以做 A1 结论。
- Goose macOS sandbox、OpenCode permissions、Pi Extension Gate 都不能自动满足 Hunter 的 Windows A2 威胁模型。

## 11. 一手来源索引

### Goose

- [官方仓库与 README](https://github.com/aaif-goose/goose)
- [Custom Distributions](https://goose-docs.ai/docs/guides/custom-distributions/)
- [完整 Custom Distribution 指南](https://github.com/aaif-goose/goose/blob/main/CUSTOM_DISTROS.md)
- [ACP Providers](https://goose-docs.ai/docs/guides/acp-providers/)
- [ACP Clients](https://goose-docs.ai/docs/guides/acp-clients/)
- [Hooks 与 fail-open 语义](https://goose-docs.ai/docs/guides/context-engineering/hooks/)
- [Tool Permissions](https://goose-docs.ai/docs/guides/managing-tools/tool-permissions/)
- [Goose Permissions / Autonomous、Manual、Smart、Chat](https://goose-docs.ai/docs/guides/goose-permissions/)
- [Session Management](https://goose-docs.ai/docs/guides/sessions/session-management/)
- [Smart Context Management](https://goose-docs.ai/docs/guides/sessions/smart-context-management/)
- [Logging / SQLite Sessions](https://goose-docs.ai/docs/guides/logs/)
- [macOS Sandbox](https://goose-docs.ai/docs/guides/sandbox/)
- [Recipes](https://goose-docs.ai/docs/guides/recipes/)
- [Goose 2.0 / ACP 与新 TUI、Desktop 迁移](https://goose-docs.ai/blog/2026/04/08/goose-acp-and-new-tui/)
- [已移除的 Secure-tunnel Mobile Access](https://goose-docs.ai/docs/experimental/remote-access/mobile-access/)
- [实验性 Telegram Gateway](https://goose-docs.ai/docs/experimental/remote-access/telegram-gateway/)

### OpenCode

- [官方仓库与 README](https://github.com/anomalyco/opencode)
- [Intro](https://opencode.ai/docs/)
- [Server / OpenAPI / SSE](https://opencode.ai/docs/server/)
- [JS/TS SDK](https://opencode.ai/docs/sdk/)
- [Plugins](https://opencode.ai/docs/plugins/)
- [Agents](https://opencode.ai/docs/agents/)
- [Permissions](https://opencode.ai/docs/permissions/)
- [官方 Security / No Sandbox](https://github.com/anomalyco/opencode/security)
- [Agent Skills](https://opencode.ai/docs/skills/)
- [MCP servers](https://opencode.ai/docs/mcp-servers/)
- [ACP Support](https://opencode.ai/docs/acp/)
- [Providers](https://opencode.ai/docs/providers/)
- [Windows / WSL](https://opencode.ai/docs/windows-wsl/)

### Pi

- [官方仓库与 README](https://github.com/earendil-works/pi)
- [Coding Agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)
- [SDK / AgentSession / SessionManager](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [RPC 协议](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)
- [Extensions / Tool Events / Error Handling](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Containerization](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md)

---

本报告是旧设计的研究证据，不替代当前的
[`01-product-vision.md`](../01-product-vision.md) 至
[`11-decision-summary.md`](../11-decision-summary.md)。若未来宿主能力变化导致结论变化，应新增 ADR/评审记录，不静默改写本报告的时间快照。
