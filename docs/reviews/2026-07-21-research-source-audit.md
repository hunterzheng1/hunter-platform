# Hunter Platform 研究报告来源审计

- 审计日期：2026-07-21（Asia/Shanghai）
- 被审计文件：`docs/research/2026-07-21-hunter-platform-landscape-and-reuse.md`
- 行号口径：以上述文件在本次审计开始时的 680 行快照为准。
- 审计范围：只抽查会改变架构选择的主张：Orca、Agent Orchestrator、Codex、CodeBuddy、Cursor、ACP/MCP/A2A、Windows/Linux、许可证与维护活跃度。
- 方法：优先使用产品官方文档、canonical GitHub 仓库、LICENSE、官方 changelog/release；没有安装或运行第三方二进制，也没有做法律意见、流量抓包、Windows/WSL 实机兼容测试或源码级供应链审计。

## 结论

结论为 **REVISE（方向可保留，关键事实需先修正）**。

报告的核心边界——Hunter 持有 canonical state，外部 Runtime/Agent 只作可替换 Provider——是稳健的。Codex、CodeBuddy、ACP、Orca 的大部分能力描述也有当前一手来源支持。

但有三组足以影响实施顺序的漂移：

1. Agent Orchestrator 已迁到 `AgentWrapper/agent-orchestrator`，当前是 Apache-2.0，不是 MIT；当前主架构是 Electron/CLI 客户端连接长驻 Go daemon，npm 0.10.0 已冻结，新安装以桌面发行包为主。
2. Cursor CLI 的 “Beta” 与 “Windows 只能 WSL” 均是旧状态；2026-02 已有官方 native Windows PowerShell 安装路径。更重要的是，Cursor 2026-04 已发布第一方 `@cursor/sdk`，它比 raw CLI 更接近 Hunter 的结构化 Connector 候选，但仍为 public beta，按 Cursor 条款不应直接视为生产承诺。
3. MCP 2025-11-25 Tasks 的描述在 2026-07-21 仍属实。官方站点另有一篇日期为 2026-07-28 的 RC 预告，称新的 Tasks extension 与旧 experimental Tasks 不 wire-compatible；由于该日期晚于本次审计，它只能作为未来兼容性预警，不能当成审计日已经生效的规范。设计仍不应新绑定旧 Tasks wire shape。

因此，`Orca-first` 可以保留为 **有时限、可逆、未承诺依赖的 Phase 0 feasibility spike**，不能写成已经证明的“最小风险、最快”最终路线。

## Outdated（已过时或当前形态已改变）

### O-01 Agent Orchestrator 许可证错误

- 报告行：85、165。
- 报告主张：MIT。
- 当前事实：canonical 仓库 README 和根 LICENSE 均为 Apache License 2.0。
- 一手来源：
  - https://github.com/AgentWrapper/agent-orchestrator
  - https://github.com/AgentWrapper/agent-orchestrator/blob/main/LICENSE
- 影响：比较表、复用/分发评估与 SBOM 必须改为 Apache-2.0；仍需对发行资产和依赖另做审计。

### O-02 Agent Orchestrator 的架构和发行形态使用了旧主线描述

- 报告行：15、163、165、180、450、532、629-630。
- 仍正确的部分：worktree、Agent adapters、tmux/ConPTY runtime、CI/review/merge-conflict 反馈、Windows/Linux 桌面发行仍存在。
- 已变化的部分：当前架构文档把 AO 定义为长驻 Go daemon；桌面应用和 CLI 是其客户端，daemon 通过 adapter 管理 agent/runtime/workspace/SCM/tracker。README 明确 `@aoagents/ao` 0.10.0 为最后一个 npm 版本且已冻结，新安装推荐桌面包。GitHub 同时仍发布稳定版和 nightly 桌面资产，所以“有稳定/nightly”不能继续表述成 npm `latest`/`nightly` 分发策略。
- 一手来源：
  - canonical repo：https://github.com/AgentWrapper/agent-orchestrator
  - current architecture：https://github.com/AgentWrapper/agent-orchestrator/blob/main/docs/architecture.md
  - releases：https://github.com/AgentWrapper/agent-orchestrator/releases
  - current LICENSE：https://github.com/AgentWrapper/agent-orchestrator/blob/main/LICENSE
- 建议替换措辞：

  > Agent Orchestrator 当前是以 Electron 桌面应用为主要控制面、由长驻 Go daemon 持有 session/worktree/terminal/反馈循环的 Agent IDE。它提供 23 个 Agent adapter，runtime 包含 tmux 与 ConPTY，并发布 macOS、Windows、Linux 桌面资产。新安装应使用桌面发行；`@aoagents/ao` npm 0.10.0 已冻结，只为既有 CLI 用户保留。项目采用 Apache-2.0；稳定版与 nightly 预发行资产见 GitHub Releases。

- 旧链接审计：报告中只有行 163 和 630 仍使用 `ComposioHQ/agent-orchestrator`。GitHub 目前会重定向，但两处都应改为 `AgentWrapper`。行 163 不宜继续把旧 `SETUP.md` 当作总架构依据；优先改引当前 README 与 `docs/architecture.md`。若只需佐证 Windows ConPTY，可使用 canonical URL `https://github.com/AgentWrapper/agent-orchestrator/blob/main/SETUP.md`，并避免引用其中已经落后的 npm 安装建议。

### O-03 Cursor CLI 不再应标记为 Beta

- 报告行：338。
- 报告依据是约十个月前抓取的旧 `docs.cursor.com/en/cli/overview` 文本。
- Cursor 官方人员 2026-01 明确表示 Beta 标记已于 2025-10 从文档移除；当前产品页也把 CLI 作为正式产品入口而未标 Beta。
- 一手/第一方来源：
  - 当前 CLI 文档路由：https://cursor.com/docs/cli/overview
  - Cursor 官方论坛人员说明：https://forum.cursor.com/t/cursor-cli-jan-16-2026/149172
  - 当前产品/下载页：https://cursor.com/download
- 建议：删除“当前标记 Beta”。CLI 的接口稳定性仍应通过版本固定与契约测试验证，但理由不能再建立在旧 Beta 标签上。

### O-04 Cursor CLI 的 Windows-only-via-WSL 结论已过时

- 报告行：342、353、521。
- 当前事实：Cursor 官方支持人员 2026-02 给出 native Windows PowerShell 安装命令 `irm 'https://cursor.com/install?win32=true' | iex`。2026-05 仍有 native Windows TUI/键盘问题记录，因此“原生可安装”不等于“已通过 Hunter 可靠性验收”。
- 第一方来源：
  - https://forum.cursor.com/t/native-windows-build-of-cursor-cli-without-wsl-requirement/150073
  - 当前安装文档：https://cursor.com/docs/cli/installation
  - 已知 Windows 问题：https://forum.cursor.com/t/cursor-cli-fresh-agent-session-freezes-keyboard-on-native-windows-terminal-after-redraw-agent-resume-ide-and-wsl-work/160132
- 建议：把测试矩阵改为 native Windows、WSL、Linux 三条路径，而不是把 Windows CLI 固定为 WSL。

### O-05 Cursor Connector 比较遗漏了第一方 SDK

- 报告行：24、338-353、519-521、603。
- 当前事实：Cursor 于 2026-04 发布 `@cursor/sdk` public beta，可用 TypeScript 以相同接口创建 local/cloud Agent，流式接收 run 事件，并使用 Cursor harness、MCP、skills、hooks、subagents；2026-06 又增加 custom tools、custom stores 与 auto-review。
- 一手来源：
  - SDK 发布：https://cursor.com/changelog/sdk-release
  - SDK 更新：https://cursor.com/changelog/sdk-updates-jun-2026
  - Cursor Terms（Beta Services 条款）：https://cursor.com/en-US/terms-of-service
- 影响：L0/L1 的保守承诺仍可保留，但 Phase 0 应把第一方 SDK 放在 raw CLI 之前或至少并行验证。因为 SDK 明确为 public beta，不能在未核对商业条款、版本兼容、权限/审批和 Windows 行为前升级为生产依赖。

## Unsupported（现有一手来源不足以支撑）

### U-01 Orca 已替 Hunter 解决“Windows ConPTY 兼容”

- 报告行：118。
- 已证实：Orca 提供 Windows 安装器、终端、worktree、Agent 进程和 CLI。
- 未证实：抽查的官方产品/安装/CLI 文档没有把 Windows terminal backend 明确承诺为 ConPTY，也没有给出 Unicode、resize、进程树、重连与长期 session 的兼容保证。
- 来源：https://www.onorca.dev/docs/install 、https://www.onorca.dev/docs/cli/reference
- 建议：把“Windows ConPTY 兼容”改成“Windows 终端能力候选”，保留报告行 464-489 的实机验收门槛。

### U-02 Orca 的公开 CLI 是稳定的嵌入接口

- 报告没有直接这样声称，行 128 已正确提示风险；但行 22、133-150 的 sidecar 方案实际上依赖该假设。
- CLI 能力本身有文档支持，但官方设置路径仍是 `Experimental -> CLI`，未找到公开的语义版本兼容政策、长期支持承诺、事件重放/幂等保证或嵌入 SLA。
- 来源：https://www.onorca.dev/docs/cli/reference
- 建议：在 Phase 0 通过版本 pin、CLI schema snapshot、错误码/超时/并发/重启契约测试后，才把它列为可依赖 Provider API。

### U-03 “最低风险、最快”是未经比较实验支持的事实语气

- 报告行：14、608-610。
- Orca 的能力覆盖很广，但未完成 Orca CLI 稳定性、Windows PTY、权限、remote auth、移动链路、许可证边界、升级兼容的实测；同时 Cursor SDK 未纳入比较，AO 的事实又已漂移。
- 建议：删除“当前最小风险、最快”的确定语气，改为“当前最值得优先做可逆验证的候选假设”。

## Checked（当前一手来源支持）

### Orca

- 报告行 108、112-116：多 Agent/worktree/terminal/browser、Windows 与 Linux 发行、JSON CLI、Remote Server Beta、移动 Companion 能力均有官方文档支持。
- 报告行 124-131：OSC title 状态、runtime-scoped terminal handle、默认 bypass 参数、移动端以桌面为事实源且无 cloud relay、遥测开关与数据范围，均与当前官方文档一致。
- 报告行 84、116、129：根仓库为 MIT；报告没有错误地把 MIT 外推到品牌/服务/素材，许可证 caveat 合理。
- 一手来源：
  - https://www.onorca.dev/docs
  - https://www.onorca.dev/docs/install
  - https://www.onorca.dev/docs/cli/reference
  - https://www.onorca.dev/docs/remote-servers
  - https://www.onorca.dev/docs/mobile
  - https://www.onorca.dev/docs/model/agents-sessions
  - https://www.onorca.dev/docs/agents/supported
  - https://www.onorca.dev/docs/telemetry
  - https://github.com/stablyai/orca
  - https://github.com/stablyai/orca/blob/main/LICENSE

### Codex

- 报告行 294、307、309：app-server 的双向 JSON-RPC 风格协议、Thread/Turn/Item、start/resume/fork、流式通知、server-initiated approval、版本匹配的 TS/JSON Schema、Apache-2.0 与 Windows 安装脚本，均与当前官方仓库一致。
- 报告行 311 的“直接 Connector”属于设计推断，但证据充分。新增门槛：app-server README 说明企业集成应联系 OpenAI 注册可识别 client name，以便 compliance log 识别；WebSocket transport 仍为 experimental，首版应优先验证 stdio。
- 一手来源：
  - https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
  - https://github.com/openai/codex/blob/main/README.md
  - https://github.com/openai/codex/blob/main/LICENSE

### CodeBuddy

- 报告行 317-323：headless json/stream-json、session resume、JSON Schema、`--acp`、client-side fs/terminal、HTTP API Beta、daemon 与三平台 service、非交互 `-y` 风险，均有当前官方文档支持。
- 报告行 334 可保留为窄结论：本次没有找到 CodeBuddy 核心的公共开源授权，官方存在软件许可/服务协议；这不排除单独商业授权。
- 一手来源：
  - https://www.codebuddy.ai/docs/cli/headless
  - https://www.codebuddy.cn/docs/cli/acp
  - https://www.codebuddy.ai/docs/cli/http-api
  - https://www.codebuddy.ai/docs/cli/daemon
  - https://cloud.tencent.com/document/product/301/106125

### Cursor 的其余窄事实

- 报告行 338 中 Desktop 的 Windows/macOS/Linux 支持、CLI 的交互/print/结构化输出/session resume/MCP/rules 能力仍有官方资料支持。
- 报告行 343 的 headless 写权限风险与行 344 的“CLI resume 不等于任意 Desktop Composer session 可打开”仍是合理边界；后者是对未公开能力的谨慎推断，不是官方保证。
- 当前来源：https://cursor.com/download 、https://cursor.com/docs/cli/overview 、https://cursor.com/docs/cli/reference/output-format

### ACP、MCP、A2A

- ACP（报告行 98、361、363、369）：v1 当前明确使用 stdio 上的双向 JSON-RPC、多 session、notification、反向 permission/fs/terminal；`session/new/load/resume/close` 已在 v1 文档中，其中 load/resume/close 受 capability 协商控制；项目为 Apache-2.0；完整 remote support 仍为 WIP。ACP 同时已有 v2 Draft，必须 pin `protocolVersion` 与 capabilities。
  - https://agentclientprotocol.com/get-started/architecture
  - https://agentclientprotocol.com/protocol/v1/session-setup
  - https://agentclientprotocol.com/get-started/introduction
  - https://github.com/agentclientprotocol/agent-client-protocol
  - https://github.com/agentclientprotocol/agent-client-protocol/blob/main/LICENSE
- MCP（报告行 99、374、380）：Prompts/Resources/Tools、JSON-RPC、stdio/Streamable HTTP 以及 HTTP 的 Origin/localhost/auth 安全要求有规范支持。2025-11-25 Tasks 在当前稳定规范中确为 experimental。官方站点未来日期为 2026-07-28 的 RC 预告称 Tasks 将改为不兼容 extension；审计日尚不能把它视为现行规范，但足以说明新代码不应固化旧 experimental shape。
  - https://modelcontextprotocol.io/specification/2025-11-25
  - https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
  - https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks
  - https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/
  - https://modelcontextprotocol.io/extensions/tasks/overview
- A2A（报告行 100、385、390-391）：Linux Foundation 项目、Apache-2.0、Agent Card/Message/Task/Part/Artifact 与网络 Agent 协作定位均正确。当前 latest 已是 v1.0，包含多协议 binding、版本协商和相对 v0.3 的 breaking changes；实现时必须 pin 版本，不能只链接 `/latest/`。
  - https://a2a-protocol.org/latest/specification/
  - https://a2a-protocol.org/latest/announcing-1.0/
  - https://github.com/a2aproject/A2A
  - https://github.com/a2aproject/A2A/blob/main/LICENSE

## Inference（设计判断，不应伪装为来源事实）

- 报告行 22、133-150、152-157：Orca sidecar、Provider Reference、fork gates 是合理设计推断，不是 Orca 官方支持的 Hunter 集成架构。
- 报告行 180：AO 是 Orca 失败后的优先替代，是推断；当前 AO 的 daemon API、数据模型和 Windows lifecycle 是否满足 Hunter 仍需独立 spike，不能称为 drop-in Runtime replacement。
- 报告行 311：Codex app-server 直接 Connector 是证据充分的推断；仍需 version pin、reconnect/cancel/approval 和 enterprise client-name gate。
- 报告行 325-334：CodeBuddy 以 ACP 优先、HTTP Beta 为备选是合理推断；需要验证其 ACP 扩展与标准 v1 的偏差。
- 报告行 346-353：Cursor 首版 L0/L1 是产品风险判断，不是能力上限；纳入 public-beta SDK 后应重新比较 L1/L2。
- 报告行 393-404：ACP/MCP/A2A 的职责分层是合理架构判断，协议本身不会替 Hunter 定义这些领域边界。
- 报告行 445-456、608-610：canonical-state 分离是稳健设计；“Orca 一定最快/最低风险”则没有足够证据。

## 维护活跃度快照

以下只证明截至审计日“仍有公开维护信号”，不等于稳定性、支持 SLA 或未来兼容承诺：

| 项目 | 2026-07-21 可见信号 | 判断 |
|---|---|---|
| Orca | GitHub Releases 显示 v1.4.147（2026-07-20），安装文档有 stable/RC 通道 | 活跃，高频发布本身也要求 pin 与回归 |
| Agent Orchestrator | stable v0.10.3（2026-07-12）；2026-07-20 仍有 v0.10.4 nightly；npm 0.10.0 已冻结 | 活跃，但发行渠道已转桌面资产 |
| Codex | 官方 Releases 有 2026-07 的 stable/alpha 更新 | 活跃；必须按 app-server 版本生成 schema |
| CodeBuddy | 当前文档导航显示 2.119.x 系列，并持续维护 CLI/ACP/daemon 文档 | 有维护信号；未核验公开源码提交历史 |
| Cursor | 下载页当前列 3.12，2026-07-17 changelog 仍更新；SDK 2026-06 有新增能力 | 活跃；CLI/SDK 契约仍需 pin |
| ACP | schema v1.19.1 于 2026-07-20 发布，v2 为 Draft | 活跃且正在演进 |
| MCP | 当前稳定版为 2025-11-25；官方站点存在未来日期 2026-07-28 的 RC 预告 | 活跃；旧 experimental Tasks 不宜成为新依赖 |
| A2A | latest 为 v1.0，官方说明相对 v0.3 有 breaking changes | 活跃；必须版本协商 |

## Orca-first sidecar 的谨慎度评估

**结构边界足够谨慎，选择置信度仍过高。**

做得好的部分：

- 行 22、26、128-129 明确只用公开接口、不碰私有 DB、不先 fork，并保留替换能力。
- 行 124-127 正确区分 OSC/idle 与 Hunter completion，记录 runtime-scoped handle、危险默认权限和移动端事实源限制。
- 行 458-572 已列 Phase 0 未知项、Go/No-Go 与 fork gate。

仍需收紧的部分：

- sidecar 的关键 CLI 仍从 Experimental 设置启用，且没有公开兼容政策。
- Remote Server 和 Mobile 都是 Beta；remote pairing URL 是 secret，官方建议私网，不能把它们当首版安全边界已解决。
- Windows terminal/进程树、runtime 重启、取消、并发、事件丢失、版本升级尚未实测。
- AO fallback 的许可证与架构已漂移；Cursor 第一方 SDK 被遗漏。
- 行 608-610 用比较结论语气超过了现有证据。

建议用以下结论替换行 608-610：

> Phase 0 先进行有时限、可逆的 Orca sidecar feasibility spike。只有公开 CLI 契约、Windows 终端/进程与重启恢复、权限/审批、remote auth、遥测、许可证及版本升级门槛全部通过后，才把 Orca 提升为产品 Runtime 依赖。Cursor 同时优先评估第一方 SDK；若 Orca 不通过，应依据当前 AO 桌面/Go-daemon 架构重新比较，而不是预设 AO 可无缝替换。无论 Provider 选择如何，Hunter 始终持有 Requirement、Flow、Run、Evidence、Archive 与 Knowledge 的 canonical state。

## 未知项与审计边界

- 未安装 Orca/AO/Codex/CodeBuddy/Cursor，也未执行 native Windows、WSL 或 Linux smoke test。
- 未验证第三方二进制签名、自动更新、依赖许可证、品牌/素材、托管服务或移动商店条款。
- 未获得 Orca CLI 的兼容承诺，也未验证 schema、退出码、并发、取消、重放、认证与重启恢复。
- 未验证 AO 当前 daemon API 是否被承诺为外部集成面，也未测试 ConPTY 的 Unicode/resize/长时运行/进程树。
- 未验证 Codex enterprise client-name 注册流程、app-server 兼容周期或 Desktop “open by thread id”。
- 未验证 CodeBuddy ACP 扩展与 ACP v1 的互操作、商业再分发/嵌入权利。
- 未验证 Cursor SDK 的 production SLA、商业嵌入边界、Windows local runtime、Desktop/CLI/SDK session 映射与 deeplink。
- 协议结论没有替代具体实现的 capability negotiation、conformance test 与版本 pin。
