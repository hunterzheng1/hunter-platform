# 原生 Coding Agent、远程控制与移动入口调研

> **历史路线建议（已被取代）**：本文保留移动/远程候选证据，但其中的
> Goose-only Phase 0、旧 Channels/Pocket 拆分和宿主优先级不再执行。Cursor
> native Windows CLI 与 `@cursor/sdk` public beta 等后续一手来源修订，以
> [`2026-07-21-hunter-platform-landscape-and-reuse.md`](2026-07-21-hunter-platform-landscape-and-reuse.md)
> 为准。

> 调研日期：2026-07-21
> 目标：判断 Hunter Channels / Pocket 如何接入 Codex、Claude Code、Cursor、OpenCode、Goose、Pi，同时尽量保留各产品的原生能力。
> 证据口径：仅采用产品官方文档、官方仓库和本项目自有仓库；文中“判断/建议”均与可核验事实分开。
> 状态提醒：Codex Remote 已正式发布；Claude Code Remote Control、Claude Channels、Cursor Agent CLI / Background Agent API、Happier 等仍有 GA、Beta、Research Preview 或 Alpha 差异，实施前必须重新核验版本。

## 1. 一句话结论

**Hunter 不应把所有 agent 都强行塞进 Goose，也不应重新实现 Codex、Claude Code 已经做好的原生远程体验。最合适的产品形态是“原生入口继续保留，Hunter 负责统一编排和补齐跨 agent 能力”。**

具体来说：

1. 用户只想在手机上继续当前 Codex / Claude Code 工作时，优先使用其官方 Remote；这最能保留原生 session、工具、审批和本机环境。
2. Hunter 需要跨 agent 统一启动、恢复、中断、监听和审批时，应直接接每个 agent 最稳定的原生控制面：Codex app-server、OpenCode HTTP/SSE、Pi RPC；Claude Code 使用官方 CLI 流或 Agent SDK，并把官方 Remote / Channels 当作并行原生入口。
3. Goose 适合作为 Hunter 的一个“可用 runtime / agent 发行版”，尤其适合快速获得 MCP、Recipe、调度和模型兼容能力；但通过 Goose 的 ACP/CLI provider 调用 Codex、Claude、Pi，并不等于保留它们的桌面端、移动端和原生 session 体验。
4. Hunter Pocket 应先做移动优先 Web/PWA；飞书等聊天入口作为 Channels，负责通知、窄命令、低风险审批和跳转。它们都只是同一 Hunter session/run 的投影，不拥有真正的会话状态。
5. `lark-coding-agent-bridge` 很适合拆成 Hunter 的飞书 Channel 适配器；不宜继续承担跨 agent runtime 和 session 真相源。

## 2. 先把“保留原生能力”说清楚

“接入某 agent”至少有三种不同含义，不能混为一谈：

| 层次 | 实际保留的东西 | 典型方式 |
|---|---|---|
| 保留订阅/模型访问 | 复用用户已有 Codex、Claude、Cursor 等登录或订阅 | Goose ACP Provider、部分 CLI wrapper |
| 保留 agent runtime | 仍由原 agent 执行工具、上下文压缩、子任务等 | Codex app-server、Claude Agent SDK/CLI、Pi RPC、Goose ACP Provider |
| 保留原生产品体验 | 同一个原生 session、原生桌面/手机 UI、审批、截图、diff、终端状态均可连续使用 | Codex Remote、Claude Code Remote Control；其他 wrapper 通常做不到完整等价 |

因此，“Goose 能调用 Codex”只证明它可以复用 Codex agent/runtime，并不证明 Goose session 能无损出现在 Codex 桌面端或 Codex Remote 中。Hunter 应明确区分：

- `NativeSession`：供应商原生会话；
- `HunterRun`：Hunter 发起的一次执行；
- `Surface`：Codex App、Claude App、Hunter Pocket、飞书卡片等交互入口。

三者可以映射，但不应假装是同一个对象。

## 3. 横向能力矩阵

| 产品/控制面 | 保留自身原生 runtime | 外部启动 / 恢复 | 语义中断 | 事件监听 | 稳定 session 标识 / API | Windows | 官方移动形态 | 对 Hunter 的适合度 |
|---|---:|---|---|---|---|---|---|---|
| Codex app-server | 是 | 是：thread start/resume/fork | 是：turn/interrupt | 是，细粒度通知 | thread/turn id；JSON-RPC | 是 | 不直接提供；另有 Codex Remote | **很高：Codex 首选适配层** |
| Codex Remote | 是，且保留原生产品体验 | 手机可启动/继续 | 手机审批；公开文档未承诺第三方中断 API | 原生 UI 实时呈现 | 有内部配对/会话；无公开第三方 Remote API/deep link 契约 | 是 | ChatGPT iOS/Android Remote | **作为原生旁路保留，不应重造** |
| Claude Code CLI / Agent SDK | 是 | `--resume <id>` / SDK | CLI 可进程终止；SDK 能力按版本核验 | `stream-json` / SDK 流 | session id；SDK/CLI | 原生 Windows，亦支持 WSL | 另有官方 Remote | **高，但需单独适配** |
| Claude Remote Control | 是，且保留本机工具/MCP/配置 | CLI 启动，URL/QR 进入 | 原生 UI 审批；无公开跨产品控制 API | 原生 UI | session URL/名称；CLI session id | 是 | Claude iOS/Android/Web | **原生旁路最佳；不宜作为 Hunter API** |
| Claude Channels | 是 | 事件进入现有本机 session | 可回传部分权限 verdict | MCP stdio 双向事件 | MCP request/session 语义；preview | 是 | Telegram/Discord/iMessage 等 channel | **可借鉴；Claude 专属且仍预览** |
| Cursor Agent CLI | 是 | 是，`--resume` / session list | 未见稳定的逐 turn 中断 RPC；可终止进程 | `stream-json` | session UUID，CLI | 官方推荐 WSL | 本地 CLI 无官方通用手机入口 | **中：能包裹，但控制面偏弱** |
| Cursor Background API | 是 Cursor agent，但运行在云 VM | 是，创建/跟进远程 agent | API 能管理 background agent，精确能力依版本 | API/网页 | REST API / agent id | 与本地 Windows 无关 | 官方 Web/PWA | **适合云任务，不保留本地 CLI session** |
| OpenCode Server/SDK | 是 | REST 可创建、读取、fork、revert 等 | 是：session abort | SSE | session id；OpenAPI/SDK | 官方更推荐 WSL | 官方 Web，可自行做 PWA/反代 | **很高：最容易嵌入的现成开放控制面** |
| Goose ACP Server | 是 Goose | ACP session lifecycle | ACP 客户端可控制，细节需实测 | ACP 消息/工具/diff | ACP session；stdio 或 HTTP/WS | 是 | 当前无正式移动客户端 | **高：适合作为 Hunter runtime 之一** |
| Goose ACP Provider | 保留下游 agent runtime 的一部分 | 可以启动 provider；Goose 不支持对 ACP provider 的 resume/fork | 取决于 ACP/provider | ACP | Goose 与 provider session id 不同 | 是 | Goose 无正式移动端 | **中：快速复用，不宜承担统一 session 真相** |
| Pi RPC | 是 | 是，含 switch/fork/clone | 是：abort | 极细 JSONL events | session id、entry id、leaf id | 是 | 无 | **很高：最干净的可定制底层协议，但工程量大** |
| Happy Coder | 包装 Codex/Claude；会话连续性依赖 wrapper/provider | 支持启动/恢复 | 支持移动控制，内部语义需审计 | 是 | 未见公开稳定第三方 API | 有 Windows 修复记录 | iOS/Android/Web | **优秀参考/可复用候选，不宜直接成为真相源** |
| Happier | 声称支持多 agent、既有 session attach/takeover | 声称完整支持 | 声称支持 | 是 | 自有 daemon/relay/session | 是 | iOS/Android/Web/桌面 | **架构最接近 Hunter，但仍 Alpha，应做受限 spike** |
| lark-coding-agent-bridge | 以一次性 CLI 子进程运行 Codex/Claude | 可按保存的 id resume | `/stop` 为 SIGTERM/SIGKILL，非 provider 语义中断 | 解析 JSONL 并更新卡片 | 本地 catalog 保存 native id | 是 | 飞书即移动入口 | **非常适合改造成 `channel-feishu`** |

注：矩阵中的“未见”表示截至调研日，所列官方资料没有给出稳定公开承诺，不等于内部绝对不存在。

## 4. 各方案详解

### 4.1 Codex：应同时保留 Remote，并用 app-server 做 Hunter 适配

#### 已核验事实

- Codex App 已支持 Windows。Codex Remote 于 2026-06-25 GA，可从 ChatGPT iOS/Android 的 Remote 区域连接 Mac/Windows 主机；采用一对一 QR 配对，主机需保持在线并运行 Codex。
- Remote 可在手机上发起或继续任务、查看进度、批准操作；本机项目上下文、插件、截图、终端输出、diff、测试等仍在主机执行，文件和凭据不搬到手机，连接通过安全 relay，不要求打开公网端口。
- Codex `app-server` 是公开的 JSON-RPC 2.0 控制面，默认通过 stdio JSONL，也提供 Unix socket WebSocket；TCP WebSocket 文档明确标为实验性/不支持。
- app-server 支持 `thread/start`、`thread/resume`、`thread/fork`、`thread/list`、`thread/read`，以及 `turn/start`、`turn/steer`、`turn/interrupt`，并推送 thread/turn/item、审批、工具和状态通知。thread id 与 turn id 可用于精确寻址。

#### 判断

- **若目标是“不丢 Codex 桌面/手机原生能力”，使用 Codex Remote 是最短路径。** Hunter 只需保存可选的原生入口信息并做 handoff/提示，不应代理或仿制其私有 relay。
- **若目标是“Hunter 统一控制 Codex”，app-server 是正确边界。** 它比解析 `codex exec --json` 更稳定、支持语义中断和丰富事件，也更接近 Codex 自身界面使用的控制层。
- 不能据此推断 Codex App 的所有 UI 专属能力都已公开给 app-server。电脑控制、浏览器交互、插件 UI 等是否完整等价，需通过能力探测测试，而非写死承诺。
- 尚未找到面向第三方的 Codex Remote 公共 API 或稳定 deep-link scheme。Hunter 可以保存 `native_session_id`，但“从 Pocket 一键跳到某个 Codex Remote thread”应标记为待供应商公开或实测的可选增强。

官方资料：[app-server 协议](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)、[Codex MCP interface](https://github.com/openai/codex/blob/main/codex-rs/docs/codex_mcp_interface.md)、[Codex Remote 发布说明](https://openai.com/index/work-with-codex-from-anywhere/)、[ChatGPT Release Notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)、[Codex App](https://openai.com/index/introducing-the-codex-app/)、[ChatGPT Work 与 Codex](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex)

### 4.2 Claude Code：Remote 保留原生体验，SDK/CLI 承担 Hunter 集成

#### 已核验事实

- Claude Code Remote Control 是 Research Preview。`claude remote-control` 可作为服务器显示 URL/QR；`claude --remote-control` 可在交互会话中开启，现有会话也可通过 `/remote-control` 携带上下文进入远程模式。
- Remote 的执行仍留在本地 CLI：文件系统、MCP server、工具和项目配置均保留；手机端支持 Claude iOS/Android，浏览器使用 `claude.ai/code`。
- 连接仅需出站 HTTPS，不开放入站端口；Anthropic 文档说明采用 TLS 及多个短期、用途受限凭据。
- Remote 仅支持 claude.ai OAuth 订阅；API key、setup-token 以及 Bedrock/Vertex/Foundry 等第三方 provider 不受支持。Team/Enterprise 默认需管理员开启。
- CLI 支持 `--resume <session-id>`，`-p --output-format stream-json` 可输出结构化流，并在结果中提供 session id。官方也提供 Agent SDK 作为可嵌入接口。
- Claude Channels 是本地 stdio MCP channel，可从 Telegram、Discord、iMessage 或 webhook 等把事件送入会话。受信任双向 channel 可转发 Bash/Write/Edit 权限请求，且 channel 与本地/Remote 的首个 verdict 生效；它仍是 Research Preview。
- Claude Code 原生支持 Windows，但原生 Windows sandbox 当前不支持；如需 sandbox，官方建议 WSL2。

#### 判断

- Claude 官方 Remote 最能保留原生 Claude 能力，Hunter Pocket 不应强制替代它。
- Hunter 通用 runtime 不应把 Remote Control 当公开 API。可用 CLI `stream-json` 或 Agent SDK 建立 Claude adapter；Remote URL/QR 作为用户可选的原生 handoff。
- Claude Channels 的安全模型和“channel 是本地 MCP server”的接口值得借鉴，但它是 Claude 专属、预览能力，不能直接充当跨 agent Channels 基础协议。
- CLI transcript/session 文件格式被官方视为内部实现时，不应直接解析作为长期数据契约；只使用 CLI/SDK 暴露的 session id 和事件。

官方资料：[Remote Control](https://code.claude.com/docs/en/remote-control)、[Channels](https://code.claude.com/docs/en/channels-reference)、[CLI](https://code.claude.com/docs/en/cli-usage)、[Sessions](https://code.claude.com/docs/en/sessions)、[安装与 Windows](https://code.claude.com/docs/en/installation)

### 4.3 Cursor：本地 CLI 与云 Background Agent 是两种不同产品边界

#### 已核验事实

- Cursor Agent CLI 仍为 Beta，支持交互和 `-p/--print`；`--output-format stream-json` 输出 system init、消息 delta、tool call、result 等 NDJSON，并包含 session UUID。
- CLI 支持 `--resume [chatId]`、`cursor-agent resume`、`cursor-agent ls`。官方安装文档对 Windows 推荐 WSL。
- 公开文档未描述一个类似 Codex app-server 的本地常驻服务，也未给出逐 turn 的稳定中断 RPC。Hunter 可以管理进程，但进程终止不等于供应商语义级中断。
- Cursor Web/Mobile PWA 主要控制 Background Agents。Background Agent 运行在 Cursor 云端 Ubuntu VM，连接 GitHub 分支并可访问互联网；官方 Background Agent API 为 Beta，支持以 Bearer API key 创建、管理和继续 agent。

#### 判断

- Cursor 本地 CLI 可接入 Hunter Node，实现启动、恢复和事件消费，但能力应诚实标为“进程级取消”，不要宣称已有可靠 turn interrupt。
- Cursor Background API 适合 Hunter 的云任务通道，却不能保留用户本地 Windows/WSL 进程、文件、凭据和 session；它必须作为另一种 execution target 展示。
- Background Agent 自动执行终端且可访问网络，官方也强调 prompt injection / 数据外泄风险，因此高权限任务需更严格 policy 和仓库隔离。

官方资料：[Agent CLI Overview](https://docs.cursor.com/en/cli/overview)、[CLI Using](https://docs.cursor.com/en/cli/using)、[参数](https://docs.cursor.com/en/cli/reference/parameters)、[输出格式](https://docs.cursor.com/en/cli/reference/output-format)、[认证](https://docs.cursor.com/en/cli/reference/authentication)、[安装](https://docs.cursor.com/en/cli/installation)、[Background Agent API](https://docs.cursor.com/background-agent/api/overview)、[Web 与 Mobile](https://docs.cursor.com/en/background-agent/web-and-mobile)

### 4.4 OpenCode：现成产品中最容易嵌入 Hunter 的开放控制面

#### 已核验事实

- OpenCode 原生采用 client/server。`opencode serve` 暴露 HTTP server、OpenAPI 3.1 文档 `/doc` 和 `/event`、`/global/event` SSE。
- API 支持 session 创建、列表、状态、读取、children、fork、diff、revert、summarize、abort、share 以及 permission reply。官方 JS/TS SDK 从 OpenAPI 生成，既可拉起本地 server，也可连接已有 server。
- `opencode web` 提供浏览器 UI，并与同一 server/session 工作；TUI 也可 attach 到 server。
- server 默认绑定 `127.0.0.1`。绑定网络地址时可用 `OPENCODE_SERVER_PASSWORD` 配置 HTTP Basic，默认用户名为 `opencode`；如果没有密码，服务无认证。官方同时提供 `0.0.0.0`、mDNS 和 CORS 配置。
- 官方称 Windows 最佳体验为 WSL。

#### 判断

- OpenCode 是当前最适合直接嵌入 Hunter Pocket/Workbench 的现成 agent：API 面宽、session 可寻址、支持 abort 和 SSE，省去了大量 wrapper 协议维护。
- OpenCode 的 Web 也可作为开发期应急移动 UI，但**不能把只带 Basic Auth 的服务直接暴露公网**。Hunter 应保持 Node 只建立出站连接，由 Hunter relay 负责 TLS、设备身份、短期 token、授权和审计。
- OpenCode 是一个独立 agent/runtime；接入它不会自动保留 Codex/Claude 的原生 session 或桌面功能。
- 官方资料未承诺稳定的移动 deep link；Hunter 应依赖 session id/API，而非猜测 URL 路由。

官方资料：[Server API](https://opencode.ai/docs/server/)、[Web](https://opencode.ai/docs/web/)、[SDK](https://opencode.ai/docs/sdk/)、[CLI](https://opencode.ai/docs/cli/)、[Windows/WSL](https://opencode.ai/docs/windows-wsl/)

### 4.5 Goose：最像“可发行的通用 agent runtime”，但不是所有原生产品的无损外壳

#### 已核验事实

- Goose 可作为 ACP client，使用 Claude、Codex、Pi 等 ACP provider，从而复用用户已有订阅和下游 agent 的内置工具；Goose extensions 会作为 MCP server 提供给下游 agent。
- ACP provider 模式目前的明确限制包括：Goose 不支持 resume/fork ACP provider session；provider session id 与 Goose session id 不同。
- Goose 的 Claude/Codex/Gemini CLI providers 已标记 deprecated；Cursor CLI provider 仍列出。CLI provider 主要使用下游 CLI 内置工具，并不完整获得 Goose extension 生态，兼容能力也有限。
- Goose 自身可运行 `goose acp` 作为 stdio ACP server，由 client 负责生命周期；也可 `goose serve` 提供 HTTP/WebSocket ACP。远程部署要求 secret，文档建议 TLS、证书指纹/TOFU；`--dangerously-unauthenticated` 仅适合明确的危险场景。
- ACP v1 才是当前稳定 latest：其标准传输是 JSON-RPC 2.0、UTF-8 NDJSON over stdio；`session/cancel` 与 `session/request_permission` 是正式语义。Streamable HTTP/WebSocket 和更完整的 durable/background prompt lifecycle 仍处在 RFD/v2 draft 阶段。因此 Goose 的 HTTP/WS 服务能力不能被误写成所有 ACP agent 都天然兼容的稳定网络协议。
- Goose 曾提供 secure-tunnel Mobile Access，但官方页面说明已从当前构建移除。Telegram Gateway 仍是实验能力，并要求主机/Goose Desktop 保持运行和唤醒。

#### 判断

- Goose 的核心优势不是“比所有 agent 都更聪明”，而是**把模型、MCP 扩展、Recipe、工具执行和 ACP 客户端/服务器组合成一个相对完整的可发行 runtime**。这与“Hunter 管理发行版”的目标匹配。
- Goose ACP Provider 对快速兼容 Codex/Claude/Pi 很有价值，但它保留的是下游 agent 的执行能力与订阅，不是供应商完整 UX。由于 resume/fork 和双 session id 限制，不能把 Goose session 当原生 session 的透明替身。
- ACP 官方组织提供的 `codex-acp`、`claude-agent-acp` 或 Pi bridge/adapter 是协议适配层，不等同于各供应商的原生 wire protocol；对 Hunter 而言必须记录 adapter 名称与版本，不能只记录 `provider=codex` 后就假设能力完全相同。
- 如果 Hunter Phase 0 采用 Goose-only，是降低首版复杂度的合理取舍；Gate A 之后要保留原生能力，应新增直连 Codex app-server、OpenCode server、Pi RPC、Claude SDK/CLI 的适配器，而不是继续在 Goose wrapper 上堆补丁。
- Goose 目前没有可直接依赖的正式移动端，因此 Hunter Pocket/Channels 仍需自己建设。

官方资料：[ACP Providers](https://goose-docs.ai/docs/guides/acp-providers/)、[CLI Providers](https://goose-docs.ai/docs/guides/cli-providers/)、[ACP Clients](https://goose-docs.ai/docs/guides/acp-clients/)、[CLI Commands](https://goose-docs.ai/docs/guides/goose-cli-commands/)、[Remote Goose Server](https://goose-docs.ai/docs/guides/remote-goose-server/)、[Session Management](https://goose-docs.ai/docs/guides/sessions/session-management/)、[已移除的 Mobile Access](https://goose-docs.ai/docs/experimental/remote-access/mobile-access/)、[Telegram Gateway](https://goose-docs.ai/docs/experimental/remote-access/telegram-gateway/)、[ACP v1 Agents](https://agentclientprotocol.com/get-started/agents)、[ACP v1 Prompt Turn](https://agentclientprotocol.com/protocol/prompt-turn)、[ACP v2 Prompt Lifecycle RFD](https://agentclientprotocol.com/rfds/v2/prompt)

### 4.6 Pi：控制协议最干净，适合薄 Kernel，但需要 Hunter 自己补齐产品层

#### 已核验事实

- `pi --mode rpc` 使用 stdin/stdout JSONL，既接受 command/response，也持续推送 agent、turn、message delta、tool execution、queue、compaction、retry、extension error 等事件。
- RPC 支持 prompt、steer、follow-up、abort、new session、switch session、fork/clone；`get_state` 返回 model、streaming、session file、session id/name 和计数。
- Pi session 是 JSONL append-only tree，entry 有稳定 id/parentId。`get_entries` 支持以 entry id 为持久游标的 `since`，即使 client 重启也能继续消费；`leafId` 表示当前分支。
- Pi 同时提供 SDK 与 extensions。RPC 本身不附带网络传输、认证、设备配对、push 或移动 UI。

#### 判断

- 在“自己做一个薄 Hunter Kernel”的路线中，Pi 是最合适的底层之一：协议小、事件细、session tree 清楚、可语义 abort，易于构建可靠的状态镜像。
- 代价是 Hunter 必须自己实现进程监督、网络 relay、设备配对、鉴权、审批、移动 UI、升级兼容和恢复策略。它不是开箱即用产品。
- Pi 适合被 Hunter 作为专用高可控 runtime；不应该为了使用 Pi 而失去 Codex/Claude 已有的原生入口。两类 adapter 可以并存。

官方资料：[Pi Coding Agent](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)、[RPC Protocol](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)、[SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)、[Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)

## 5. 可复用的移动/聊天入口

### 5.1 Happy Coder

Happy Coder 是 MIT 项目，提供 Expo 构建的 iOS/Android/Web 客户端、CLI wrapper、agent 与 relay，并强调端到端加密；服务端只看到密文，密钥留在设备。它可通过 `happy claude`、`happy codex` 从手机控制 Claude Code/Codex，并支持 push 和键盘接管。

但官方 README 也明确提示：进入 remote mode 时 wrapper 可能重启 agent session。因此它证明了“跨端 UI + E2EE relay + CLI wrapper”路线可行，却不能自动保证 attach 到原进程或所有原生能力无损。当前 release 已将 Codex 迁移到 app-server，值得审计复用；公开资料未给出面向第三方的稳定 API/deep-link 契约。

建议：把它作为 Pocket UI、push、E2EE pairing 和 Codex adapter 的实现参考，或做受限代码复用；不要直接让它成为 Hunter 的第二套 session/control plane。

官方资料：[项目主页](https://happy.engineering/)、[官方仓库](https://github.com/slopus/happy)、[MIT License](https://github.com/slopus/happy/blob/main/LICENSE)、[Releases](https://github.com/slopus/happy/releases)

### 5.2 Happier

Happier 是 MIT 的多 agent 移动/桌面控制项目，架构上已包含 machine daemon、relay、E2EE、自托管、iOS/Android/Web/Windows，并声称支持 Claude、Codex、OpenCode、Pi、Cursor 和自定义 ACP；其功能描述涵盖既有 session 的浏览、follow/takeover、attach、fork/replay、handoff、队列、steering、审批及精确通知路由。

它是公开项目中**最接近 Hunter Pocket + Channels + Node** 的实现，但官方也明确标为 Alpha Preview，移动商店可用性仍有限。直接采用整个 Happier 会与 Hunter Workbench/Kernel 大面积重叠，并把 Hunter 绑定到尚不稳定的产品模型。

建议做一个 1～2 周有明确退出标准的 spike：只验证协议模型、设备 linking、E2EE relay、通知路由、Codex/OpenCode/Pi adapters 是否能独立复用。通过后按模块吸收；不要先 fork 全栈再改名。

官方资料：[官方仓库](https://github.com/happier-dev/happier)、[官方文档](https://docs.happier.dev/)、[Device Linking](https://docs.happier.dev/features/device-linking-and-restore)、[Security](https://docs.happier.dev/security)、[MIT Licence](https://github.com/happier-dev/happier/blob/main/LICENCE)

### 5.3 lark-coding-agent-bridge

截至提交 `975e4bf76f8f4d708c77f9c71d802d4c4612a963`，该项目已经验证了飞书长连接、卡片流式更新、命令、媒体、task scheduler、本地 session catalog 和 Windows 后台运行：

- Codex adapter 运行 `codex exec --json` / `exec resume --json`，并通过 app-server `thread/list` 辅助发现历史；
- Claude adapter 运行 `claude -p --output-format stream-json --verbose --resume <sessionId>`；
- `/stop` 对子进程发送 SIGTERM，宽限期后 SIGKILL，因此是进程级停止，不是 provider 语义级 interrupt；
- catalog 以 scope、agent、真实 cwd 与 policy fingerprint 绑定 session，并采用原子持久化；
- 访问策略默认 owner-only，但允许群组后，普通群成员的细粒度身份边界需要重新设计；`full` 权限会映射到 Claude bypassPermissions 或 Codex danger-full-access，工作目录校验本身不是 sandbox。

建议保留的模块：飞书 SDK 长连接、卡片/流式渲染、媒体、命令路由、owner/admin 身份处理、Windows 服务化经验。建议替换的模块：agent 子进程拉起、CLI 参数/事件解析、catalog 真相源、进程级 stop。重构后它应成为 `Hunter Channel: Feishu`，所有 run/session/approval 都调用 Hunter Node API。

项目资料：[README](https://github.com/hunterzheng1/lark-coding-agent-bridge/blob/975e4bf76f8f4d708c77f9c71d802d4c4612a963/README.md)、[Codex adapter](https://github.com/hunterzheng1/lark-coding-agent-bridge/blob/975e4bf76f8f4d708c77f9c71d802d4c4612a963/src/agent/codex/adapter.ts)、[Codex argv](https://github.com/hunterzheng1/lark-coding-agent-bridge/blob/975e4bf76f8f4d708c77f9c71d802d4c4612a963/src/agent/codex/argv.ts)、[Session catalog](https://github.com/hunterzheng1/lark-coding-agent-bridge/blob/975e4bf76f8f4d708c77f9c71d802d4c4612a963/src/session/catalog.ts)、[Active runs](https://github.com/hunterzheng1/lark-coding-agent-bridge/blob/975e4bf76f8f4d708c77f9c71d802d4c4612a963/src/bot/active-runs.ts)、[Access policy](https://github.com/hunterzheng1/lark-coding-agent-bridge/blob/975e4bf76f8f4d708c77f9c71d802d4c4612a963/src/policy/access.ts)、[Run executor](https://github.com/hunterzheng1/lark-coding-agent-bridge/blob/975e4bf76f8f4d708c77f9c71d802d4c4612a963/src/runtime/run-executor.ts)、[飞书 Node SDK](https://github.com/larksuite/node-sdk)、[飞书长连接说明](https://github.com/larksuite/node-sdk/blob/main/docs/channel.md)

## 6. Hunter 推荐产品形态

```text
                 ┌──────────────────────────────┐
                 │ 原生入口（继续保留）         │
                 │ Codex Remote / Claude Remote │
                 └──────────────┬───────────────┘
                                │ native handoff / 并行观察
┌──────────────┐       ┌────────▼────────┐       ┌───────────────────┐
│ Hunter Pocket│◄─────►│ Hunter Relay    │◄─────►│ Hunter Node       │
│ Web / PWA    │ E2EE  │ 配对/推送/路由  │ 出站  │ 本机策略与执行     │
└──────────────┘       └────────┬────────┘       └─────────┬─────────┘
                               │                           │
┌──────────────┐               │                ┌──────────▼──────────┐
│ Channels     │◄──────────────┘                │ Agent Adapters       │
│ 飞书/Telegram│ 通知/窄命令/低风险审批         │ Codex app-server     │
└──────────────┘                                │ Claude SDK/CLI       │
                                                │ OpenCode HTTP/SSE    │
                                                │ Goose ACP            │
                                                │ Pi RPC / Cursor CLI  │
                                                └─────────────────────┘
```

核心原则：

1. **Node 是本机唯一执行与授权边界。** Relay 不直接拿项目文件或长期供应商凭据。
2. **Pocket 和 Channels 都是投影。** 它们不各自维护一套 session catalog；断线重连后按事件游标补齐。
3. **原生入口是并行的一等公民。** Hunter 展示“在 Codex/Claude 原生端继续”的 handoff；如果供应商没有稳定 deep link，只展示明确步骤/二维码，不伪造链接。
4. **能力探测替代最低公分母。** 每个 adapter 声明能否 start、resume、fork、steer、semantic interrupt、stream events、approve、attach existing、native handoff。
5. **Run 与 session 分离。** 一次失败或被杀的 subprocess 不应毁掉长期 session 映射。

建议最小数据契约：

```ts
type NativeSessionRef = {
  provider: 'codex' | 'claude' | 'cursor' | 'opencode' | 'goose' | 'pi'
  hostId: string
  nativeSessionId: string
  cwdFingerprint: string
  nativeSurfaceUrl?: string       // 只有供应商明确支持时才保存
  capabilities: AdapterCapabilities
  lastSeenAt: string
}

type AdapterCapabilities = {
  start: boolean
  resume: boolean
  fork: boolean
  steer: boolean
  semanticInterrupt: boolean
  eventStream: boolean
  approval: boolean
  attachExisting: boolean
  nativeHandoff: boolean
}
```

## 7. 移动端选择：PWA 为主，聊天机器人为辅

### 推荐形态

- **Hunter Pocket Web/PWA**：跨 agent 会话列表、事件流、diff、审批、运行控制、项目/设备切换。这是唯一适合承载完整统一工作台的移动入口。
- **原生供应商 App**：Codex/Claude 用户继续使用官方 Remote，以获得最完整的原生体验。
- **飞书/Telegram 等 Channels**：push 通知、`/status`、`/resume`、`/stop`、低风险审批、Pocket/native deep link；不承担复杂 diff、文件编辑、设备管理和高风险授权。
- **不先做原生 Hunter App**：首版 PWA 足够验证需求。只有 push 可靠性、系统分享、相机/二维码、后台连接或企业 MDM 成为硬要求时，再用 Expo/React Native 封装。

这比“只做机器人”更通用，也比“一开始做原生 App”成本低；并且不会与 Codex/Claude 已经很成熟的原生移动入口正面重复。

## 8. 认证与安全边界

### 必须满足的底线

1. Hunter Node 只建立出站连接；不要直接把 OpenCode、Goose 或自制 RPC 端口暴露公网。
2. 设备使用一次性二维码/短期 pairing code 绑定；每台设备有独立身份与可撤销密钥，不共享一个永久 bearer token。
3. Relay 只做密文转发和最小元数据路由；条件允许时采用设备到 Node 的 E2EE，并把 push 内容最小化。
4. 每次高风险审批都绑定 `run_id + action_hash + nonce + expires_at`，避免聊天消息重放或把旧批准套到新命令。
5. 渠道身份映射到 Hunter principal：群聊“允许此 chat”不能自动等价为“群内每个人都有执行权”。至少区分 owner、operator、approver、viewer。
6. 高风险动作（绕过 sandbox、写敏感目录、发布、删除、凭据操作）默认要求 Pocket 或本机确认；聊天 channel 只允许预定义的低风险范围。
7. Adapter 必须把“语义中断”和“杀进程”分开报告；后者可能丢事件、破坏会话恢复或留下子进程。

### 各产品特有风险

- OpenCode：官方网络认证仅明确到 HTTP Basic；缺省无认证，不能直接公网暴露。
- Pi：RPC 无网络/auth；安全完全由 Hunter 进程与 relay 包装承担。
- Goose：secret + TLS 解决连接认证/传输，但不自动等于细粒度项目、工具和审批授权。
- Codex/Claude Remote：供应商 relay 的安全边界相对完整；Hunter 不应把用户凭据或配对 token 导出到自己的控制面。
- Cursor Background Agent：云 VM 具网络和仓库访问，需防 prompt injection、秘密外泄和不受控自动命令。
- 聊天平台：发送者名称不可信，必须使用平台不可变 user id / tenant id / chat id；卡片 callback 要验签、防重放并校验 action 与当前 run。

## 9. 分阶段实施建议

### Phase 0：保持当前 Goose-only 决策

- 不为了移动端提前扩散 runtime 范围。
- 只在数据模型里预留 `NativeSessionRef`、adapter capability 和 surface/channel 投影，避免未来迁移重写。
- Goose adapter 直接表达其 ACP resume/fork 限制，不伪装为透明原生 session。

### Gate A 之后，按价值排序

1. **P0：Codex app-server adapter + 原生 Codex Remote handoff。** 用户价值最高，Windows 与移动原生路径都成熟。
2. **P0：Hunter Pocket PWA + Node/Relay pairing。** 建立统一跨 agent 控制面。
3. **P0：将 lark-coding-agent-bridge 收敛为 Feishu Channel。** 复用卡片、长连接、推送和 Windows 运维，移除 runtime/session 真相职责。
4. **P1：OpenCode HTTP/SSE adapter。** 以最小成本验证完整 start/resume/abort/event/approval 抽象。
5. **P1：Claude CLI/SDK adapter + Claude Remote/Channels handoff。** 尊重订阅认证和 preview 边界。
6. **P1：Pi RPC adapter。** 在需要高可控自有 Kernel 时启用，而非首版同时铺开。
7. **P2：Cursor CLI + Background API 分成 local/cloud 两个 target。** 不混淆本机会话和云 VM。
8. **探索项：Happier/Happy 受限 spike。** 只复用通过安全、许可证、协议稳定性和架构独立性审查的模块。

## 10. 最终决策建议

如果“最适合我”同时意味着 Windows、本机项目、手机可控、跨设备/agent 管理、又不丢 Codex/Claude 原生能力，那么不是在 Goose、OpenCode、Pi 三者中选一个赢家，而是采用分层组合：

- **Goose**：首发默认 runtime / 管理发行版，负责快速交付完整 agent 能力；
- **OpenCode**：未来最容易加入的开放式完整 agent；
- **Pi**：需要打造 Hunter 自有、薄而可控 Kernel 时的底层候选；
- **Codex/Claude 原生 adapter + Remote**：保留供应商强项和用户现有工作流；
- **Pocket + Channels**：统一项目、设备、agent、skill、workflow、通知和审批，但不篡夺 native session 的事实来源。

因此，不建议“为了统一而统一”：

- 不建议所有原生 agent 都经 Goose provider 才能进入 Hunter；
- 不建议直接公开 OpenCode/Goose server 端口作为移动方案；
- 不建议让飞书 bot 成为唯一工作台或 session 真相源；
- 不建议首版重做 Codex/Claude Remote；
- 不建议在 Happier 仍为 Alpha 时整套改名接管。

**推荐答案是：Goose 先落地，Hunter 保持薄；随后用能力化 adapter 逐步直连原生控制面，并让官方 Remote、Hunter Pocket、飞书 Channel 同时存在。**

## 11. 尚未确认、必须在实现前做 spike 的事项

1. Codex app-server 对 Codex App 各项桌面专属工具/插件/电脑控制的实际能力对等程度。
2. Codex Remote 是否会公开稳定 thread deep link 或第三方 API；当前不要依赖猜测 URL。
3. Claude Remote session URL 是否允许长期保存/外部应用安全唤起，以及过期/权限语义。
4. Claude Agent SDK 当前版本对 resume、interrupt、approval hook 的精确 API 与 Windows 行为。
5. Cursor CLI 的无交互写权限文档在不同页面存在措辞差异，应锁定版本做安全测试；`--force` 行为不能靠印象决定。
6. OpenCode Web 的路由是否可作为稳定 session deep link；应优先使用 API/session id。
7. Goose ACP HTTP/WS 在 Windows 守护、断线恢复、并发 session 和审批方面的生产级行为。
8. Pi RPC 子进程异常退出、compaction、entry cursor 和大 tool output 在 relay 重连后的恢复完整性。
9. Happy/Happier 对“attach 既有原生进程”的真实语义、E2EE 威胁模型、升级兼容和模块可拆性。

## 12. 主要官方来源索引

- OpenAI Codex：[app-server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)、[Remote](https://openai.com/index/work-with-codex-from-anywhere/)、[Codex App](https://openai.com/index/introducing-the-codex-app/)
- Anthropic Claude Code：[Remote Control](https://code.claude.com/docs/en/remote-control)、[Channels](https://code.claude.com/docs/en/channels-reference)、[CLI](https://code.claude.com/docs/en/cli-usage)
- Cursor：[Agent CLI](https://docs.cursor.com/en/cli/overview)、[Background Agent API](https://docs.cursor.com/background-agent/api/overview)、[Web/Mobile](https://docs.cursor.com/en/background-agent/web-and-mobile)
- OpenCode：[Server](https://opencode.ai/docs/server/)、[Web](https://opencode.ai/docs/web/)、[SDK](https://opencode.ai/docs/sdk/)
- Goose：[ACP Providers](https://goose-docs.ai/docs/guides/acp-providers/)、[Remote Server](https://goose-docs.ai/docs/guides/remote-goose-server/)、[Mobile Access 状态](https://goose-docs.ai/docs/experimental/remote-access/mobile-access/)
- ACP：[v1 Agents](https://agentclientprotocol.com/get-started/agents)、[Prompt Turn](https://agentclientprotocol.com/protocol/prompt-turn)、[v2 Prompt Lifecycle RFD](https://agentclientprotocol.com/rfds/v2/prompt)
- Pi：[RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)、[SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- Happy Coder：[仓库](https://github.com/slopus/happy)、[Releases](https://github.com/slopus/happy/releases)
- Happier：[仓库](https://github.com/happier-dev/happier)、[文档](https://docs.happier.dev/)、[Security](https://docs.happier.dev/security)
- 飞书：[Node SDK](https://github.com/larksuite/node-sdk)、[长连接](https://github.com/larksuite/node-sdk/blob/main/docs/channel.md)
