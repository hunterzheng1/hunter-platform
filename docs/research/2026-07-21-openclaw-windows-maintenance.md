# OpenClaw Windows 支持与维护活跃度核验

> **历史快照（已被取代）**：本文保留为 Windows 与维护状态证据，不定义
> Hunter Platform 的底座。当前结论见
> [`2026-07-21-hunter-platform-landscape-and-reuse.md`](2026-07-21-hunter-platform-landscape-and-reuse.md)。

> 核验日期：2026-07-21
> 数据快照：2026-07-21 06:10 UTC（北京时间 14:10）
> 范围：只使用 OpenClaw 官方 GitHub 仓库、官方文档、官方 Release 和 OpenClaw Foundation 页面。

## 结论先行

1. **“OpenClaw 创始人不积极更新”与仓库事实不符。**过去 30 天 `main` 上约有 9,953 个提交，其中 GitHub 归属于 Peter Steinberger（`@steipete`）的提交约 3,740 个，占 37.6%；其账号创建且后来合并的 PR 约 3,226 个。项目也在核验当天继续推送代码。
2. **但 OpenClaw 已经不是单纯的创始人个人项目。**Peter 的官方 GitHub 资料写明其目前在 OpenAI，并以 steward 身份维护 OpenClaw；OpenClaw Foundation 已有全职团队、27 名列名 Core Maintainers 和 2,782+ 名历史代码贡献者。Windows Hub 近期主要由 Scott Hanselman、Barbara Kudiess 等人推进，而不是 Peter 本人。
3. **Windows 支持是真实存在的，但成熟度分层明显。**原生 WinUI Windows Hub、签名的 x64/ARM64 安装包、原生 PowerShell CLI/Gateway、Windows Node 和本地 MCP 都已发布；但官方自己的成熟度评分把“Windows via WSL2”列为 M3 Beta，把“Native Windows”列为 M2 Alpha。
4. **对 Hunter 最稳妥的 Windows 路线是 Windows Hub + app-owned WSL2 Gateway。**纯原生 Windows Gateway 可以试用，但还不宜在未实测前作为 Hunter 的唯一基础运行时；ACP/ACPX 在 Windows 上尤其需要逐 Agent 验证。
5. **OpenClaw 可以作为可替换的执行与渠道底座，不能成为 Hunter 的唯一信任根。**原因不是停更，而是版本节奏极快、核心贡献仍集中、Windows 原生和 ACP 面尚未全部达到稳定级别。

## 一、项目究竟是否还在积极维护

### 1.1 滚动 30/90 天数据

| 指标 | 过去 30 天 | 过去 90 天 |
|---|---:|---:|
| `main` 可达 commits | **9,953** | **37,633** |
| merged PR | **7,076** | **12,518** |
| 公共 GitHub Releases | **14** | **124** |
| 稳定版 Releases | 3 | 30 |
| prerelease | 11 | 94 |

时间窗为：

- 30 天：`2026-06-21T06:10:00Z` 至 `2026-07-21T06:10:00Z`
- 90 天：`2026-04-22T06:10:00Z` 至 `2026-07-21T06:10:00Z`

可复核入口：

- [OpenClaw 仓库 API](https://api.github.com/repos/openclaw/openclaw)
- [30 天 commits API](https://api.github.com/repos/openclaw/openclaw/commits?sha=main&since=2026-06-21T06%3A10%3A00Z&until=2026-07-21T06%3A10%3A00Z&per_page=1)
- [90 天 commits API](https://api.github.com/repos/openclaw/openclaw/commits?sha=main&since=2026-04-22T06%3A10%3A00Z&until=2026-07-21T06%3A10%3A00Z&per_page=1)
- [30 天 merged PR 查询](https://api.github.com/search/issues?q=repo%3Aopenclaw%2Fopenclaw%20is%3Apr%20is%3Amerged%20merged%3A2026-06-21T06%3A10%3A00Z..2026-07-21T06%3A10%3A00Z&per_page=1)
- [90 天 merged PR 查询](https://api.github.com/search/issues?q=repo%3Aopenclaw%2Fopenclaw%20is%3Apr%20is%3Amerged%20merged%3A2026-04-22T06%3A10%3A00Z..2026-07-21T06%3A10%3A00Z&per_page=1)
- [官方 Releases](https://github.com/openclaw/openclaw/releases)

该规模说明 OpenClaw 处于**极高强度开发期**，不存在停止维护或低活跃的迹象。不过，“提交多”不等于“稳定”：每天大量合入和高比例 prerelease 同时意味着较高的升级回归风险。

### 1.2 创始人本人是否还在写

| 主体 | 30 天 commits | 90 天 commits | 30 天 authored merged PR | 90 天 authored merged PR |
|---|---:|---:|---:|---:|
| Peter `@steipete` | **3,740（37.6%）** | **16,609（44.1%）** | **3,226（45.6%）** | **3,966（31.7%）** |
| Vincent `@vincentkoc` | **1,741（17.5%）** | **7,531（20.0%）** | **473（6.7%）** | **1,020（8.1%）** |
| 两人合计占项目 | **55.1% commits** | **64.1% commits** | **52.3% PR** | **39.8% PR** |

判断：

- 说 Peter “不积极更新”并不准确；至少从 GitHub 归属数据看，他仍是过去 30 天第一大提交者。
- 最近 30 天 Peter 与 Vincent 的合计提交占比低于 90 天窗口，说明贡献面正在扩散。
- 但过半提交仍来自两位核心人物，**bus factor 风险没有完全消失**。
- 这些数字表示 GitHub 的作者归属。OpenClaw 大量使用 Agent 辅助开发，不能把每个 commit 等同为纯手写工作量；但仍能证明 Peter 的账号和维护流程持续参与项目。

Peter 的[官方 GitHub 主页](https://github.com/steipete)写明他目前在 OpenAI，并在 “stewarding OpenClaw as open and independent”；当前 [`CODEOWNERS`](https://github.com/openclaw/openclaw/blob/main/.github/CODEOWNERS) 仍包含 `@steipete`。最新稳定版是 [`v2026.7.1`](https://github.com/openclaw/openclaw/releases/tag/v2026.7.1)，最新公开预发布版是 [`v2026.7.2-beta.3`](https://github.com/openclaw/openclaw/releases/tag/v2026.7.2-beta.3)。

### 1.3 是否已经转为团队维护

是，但仍处于从“创始人主导”向“基金会团队主导”的过渡期。

[OpenClaw Foundation People 页面](https://www.openclaw.org/people)列出：

- 7 名 Product & Engineering/Community 全职成员，其中 Vincent Koc 为 Chief Architect；
- 27 名来自 NVIDIA、Microsoft、OpenAI、Tencent、Atlassian、Red Hat 等组织或独立身份的 Core Maintainers；
- 2,782+ 名已向 OpenClaw 提交代码的社区贡献者。

Peter 没有列在当前 Foundation 全职团队或 Core Maintainers 名单中，这与其加入 OpenAI、转向 steward 角色一致；但提交数据表明他并未退出日常代码贡献。[Foundation 官方说明](https://www.openclaw.org/)称项目由独立非营利基金会维护，不由单一公司控制。

因此更准确的表述是：

> 创始人的组织角色已经变化，但他仍高度活跃；与此同时，项目正在建立不依赖创始人个人的全职团队和跨公司维护网络。

## 二、Windows 支持到底处于什么水平

### 2.1 已经真实交付的原生 Windows 能力

[官方 Windows 文档](https://docs.openclaw.ai/platforms/windows)和[官方 Windows Hub 仓库](https://github.com/openclaw/openclaw-windows-node)确认以下能力已经发布，而不是路线图：

- 原生 WinUI Windows Hub，支持 Windows 10 20H2+ 和 Windows 11；
- Azure 签名的 x64 与 ARM64 安装包；
- 系统托盘、登录启动、内嵌 WebView2 Chat、Command Center、会话/用量/渠道/节点诊断；
- 连接本机、WSL、远程或 SSH Tunnel Gateway；
- Windows Node：`system.run`、通知、屏幕、摄像头、Canvas、设备状态、语音等；
- 本地 loopback MCP Server，可供 Claude Desktop、Claude Code、Cursor 等 MCP 客户端调用 Windows 能力；
- PowerShell 安装的原生 Windows CLI 与 Gateway；
- Gateway 可通过 Windows Scheduled Task 后台启动，失败时回退到用户 Startup Folder。

最新公开 Windows Hub 稳定版为 [`v0.6.12`](https://github.com/openclaw/openclaw-windows-node/releases/tag/v0.6.12)，发布时间为 2026-06-30，提供 x64、ARM64 安装包和 portable zip。

### 2.2 官方推荐的其实仍是 WSL2

Windows Hub 的默认“Set up locally”并不是把完整 Gateway 全部安装成 WinUI 进程，而是：

1. 创建 app-owned `OpenClawGateway` WSL distro；
2. 在该 WSL 环境内安装并运行 Gateway；
3. 将原生 Windows Hub 作为 operator/node 与 Gateway 配对。

官方文档明确说 WSL2 是“most Linux-compatible Gateway runtime”。其[成熟度评分](https://docs.openclaw.ai/maturity/scorecard)也给出了相同信号：

| 官方 Surface | 等级 | Quality | Completeness |
|---|---|---:|---:|
| Windows via WSL2 | **M3 Beta** | 69%（Alpha） | 79%（Beta） |
| Native Windows | **M2 Alpha** | 58%（Alpha） | 66%（Alpha） |

因此，“OpenClaw 支持 Windows”的准确解释是：

- **Windows 用户体验层**：已有真正的原生 Hub；
- **最稳的核心运行层**：仍建议放在 WSL2；
- **纯原生 Windows Gateway**：官方支持安装和运行，但项目自己仍把它评为 Alpha。

### 2.3 当前明确限制

- Windows Hub 与核心 CLI/Gateway 独立发布，Hub 的 pinned build 可能落后于 standalone Hub release。
- Windows Hub 对外部 Gateway 进程的完整 start/stop/restart 还没有达到 macOS parity；当前主要能重启由 Hub 管理的 SSH tunnel。
- WSL 开机常驻受 WSL 2.6.1+ idle termination 问题影响，官方给出了 `dbus-launch true` 与 per-user Scheduled Task workaround。
- WSL 的 IP 在重启后可能变化；向局域网暴露服务时需要更新 Windows port proxy。
- Remote Web Chat 要求 HTTPS、localhost 或 SSH tunnel；自签证书需要加入 Windows 信任库。
- 摄像头、屏幕录制、麦克风等能力需要 Windows 权限，并且敏感命令必须显式加入 Gateway allowlist。
- Windows Node 的 `system.run` 同时受 Gateway allowlist 和本地 `%LOCALAPPDATA%\OpenClawTray\exec-policy.json` 约束；这比无约束执行安全，但仍需 Hunter 自己记录 Evidence 和 Gate。

### 2.4 Windows Hub 是否仍在维护

对官方 `openclaw/openclaw-windows-node` 的浅历史核验结果：

| 指标 | 过去 30 天 | 过去 90 天 |
|---|---:|---:|
| commits | **169** | **990** |
| 非 bot 作者名（近似值） | **22** | **38** |
| 有提交的自然日 | **27** | **78** |
| Peter authored commits | 5 | 11 |
| commit message 带 PR 编号 | 128 | 265 |

近 30 天主要作者包括 Scott Hanselman、Barbara Kudiess、Caleb Eden、Karen、Andy Ye 等。最新提交在 2026-07-21 仍继续进入该仓库。

这说明 Windows Hub 不是 Peter 的个人支线，也没有停更；它已经形成独立维护群体。需要注意的是，最近稳定安装包仍停在 6 月 30 日，说明“主干很活跃”和“用户可安全升级的稳定版本”不是一回事。

统计复核方式：

```powershell
git clone --filter=blob:none --no-checkout `
  --shallow-since='2026-04-21T00:00:00Z' `
  https://github.com/openclaw/openclaw-windows-node.git <temp-dir>

git -C <temp-dir> log `
  --since='2026-06-21T06:10:00Z' `
  --until='2026-07-21T06:10:00Z' `
  --format='%H%x09%cI%x09%an%x09%ae%x09%s'
```

## 三、ACP、Codex 与其他 Harness 在 Windows 上的真实边界

[ACP Agents 官方文档](https://docs.openclaw.ai/tools/acp-agents)说明，ACP/ACPX 会在 **Gateway 所在 host runtime** 上启动外部 harness，而且当前 ACP session 不受 OpenClaw sandbox 包裹。

由此得到一个重要推论：

- 若采用 Windows Hub 默认的 app-owned WSL Gateway，Claude Code、Cursor、OpenCode、Pi 或 Codex ACP 也应按 **WSL 环境中的安装、认证、路径和工作区** 来管理；不能假设它会自动接管 Windows 原生客户端的会话。
- 若采用原生 Windows Gateway，ACPX 与各 Agent 的 `.cmd`/PowerShell wrapper、路径转义和凭据继承就进入 Windows 原生兼容面；官方没有给出“所有 ACP Agent × Native Windows”的稳定兼容矩阵。
- Windows Hub 的 Local MCP mode 是“让 MCP 客户端调用 Windows Node 能力”，并不等于 OpenClaw 已经能结构化管理所有 Windows 原生 Agent 会话。

官方仓库曾记录过原生 Windows 上 ACPX wrapper/`spawn EINVAL`、Codex ACP `acpx exited with code 1` 等问题；对应 [Windows Codex ACP issue #60672](https://github.com/openclaw/openclaw/issues/60672)目前已关闭。另一个[Windows Gateway 综合问题 #49865](https://github.com/openclaw/openclaw/issues/49865)也已关闭。这说明项目确实处理 Windows 问题，但“issue 已关闭”仍不能替代在当前稳定版上的端到端验证。

所以对 Hunter 来说，必须分别测试：

1. Windows Hub + WSL Gateway + WSL 内 Codex/Claude/OpenCode/Pi；
2. Native Windows Gateway + Windows 原生 Agent CLI；
3. Codex native app-server 与 Codex ACP 两条路径；
4. 含空格、中文和跨盘符工作区；
5. Agent 重启、Gateway 重启和 WSL 重启后的 session resume；
6. 手机/飞书发出的 stop、steer、approval 能否正确回到对应 Agent session。

## 四、维护活跃度对 Hunter 架构的含义

### 正面信号

- 更新强度高，创始人、Chief Architect、Foundation 全职团队和跨公司 Maintainers 同时参与；
- Windows 已有独立官方仓库和非创始人维护群体；
- 稳定版、beta、release evidence 和成熟度 scorecard 均公开；
- Foundation 降低了“创始人加入某家公司后项目立即消失”的风险。

### 风险信号

- 30 天内 9,953 commits、14 个 releases 是高变化率，不是传统意义上的低风险稳定节奏；
- Peter 与 Vincent 仍占 55.1% 的近期 commits，核心知识和合入权仍明显集中；
- 官方整体 maturity score 只有 68%，Agent Runtime/Plugins 为 Beta，Native Windows 为 Alpha；
- Windows Hub、核心 Gateway、ACP plugin 和 Agent adapter 分属不同发布节奏，组合升级可能出现兼容窗口；
- OpenClaw 文档和功能变化非常快，旧文章或旧 issue 很容易失效，必须锁定具体版本复验。

## 五、给 Hunter 的建议

1. **不要因为“创始人可能不维护”而排除 OpenClaw；现有证据不支持该担忧。**
2. **也不要因为项目活跃就把 Hunter Kernel 写死在 OpenClaw 内部。**采用公开 Gateway/RPC、Plugin SDK、ACP/MCP 边界，保留直接 Agent Adapter 回退路径。
3. Phase 0 的 Windows 首选组合应为：
   - 签名的 Windows Hub stable；
   - Hub 管理的 app-owned WSL2 Gateway；
   - 在 WSL 内安装并登录需要的 managed Agent CLI；
   - Windows 原生 Codex Desktop/Cursor 等继续作为 native surface，不强行纳入同一 ACP session。
4. 原生 Windows Gateway 作为第二组实验，而不是默认生产路径。
5. 固定一个经过 Hunter 验证的 stable 版本；beta 只用于兼容性实验，不自动跟随 `latest`。
6. 建立升级资格门：Windows 安装、Gateway 启停、ACP spawn/resume/stop、飞书/移动端回路、工作区路径、审批与 Evidence 全部通过后才升级。
7. 若 OpenClaw 在 2 个连续稳定版上不能通过关键 Windows/ACP 用例，则 Hunter 应降级为“可选 Channel/Session Provider”，核心调度改走直接 ACP 或 Agent 原生 API。

最终判断：

> OpenClaw 在 Windows 上已经达到“值得实机试点”的程度，但尚未达到“不经验证即可作为唯一 Runtime”的程度。项目维护非常积极，真正的风险是高速演进、组合复杂度和局部成熟度，而不是创始人停更。

## 六、统计局限

- Commit 数只统计快照时可从默认分支 `main` 到达的提交；merge、squash、direct commit 均可能计入。
- GitHub `author=` 依赖账号与邮箱关联，co-author、旧邮箱和 bot attribution 可能造成偏差。
- PR Search API 的 `total_count` 可以超过 1,000，但无法据此枚举所有唯一作者，因此没有伪造“滚动 30/90 天精确 contributor 数”。
- Windows 作者数按 Git author name 去重，是近似值；同一人使用不同姓名可能被重复计数。
- Release 数只表示公开 GitHub Releases，不含 draft。
- 高提交量和高发布量证明活跃度，不直接证明质量、兼容性或生产稳定性。
