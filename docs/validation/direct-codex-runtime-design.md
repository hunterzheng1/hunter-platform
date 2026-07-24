# Direct Codex Runtime 有界验证设计

- 日期：2026-07-23
- 候选：本机 Codex CLI `0.144.6`
- 决策边界：Phase 0 Outcome 5 保持不变，直到版本化本机原子能力收据足以支持新决策
- 证明范围：`local_typed_scenario`，不是生产 Provider 集成

## 目标与非目标

本 spike 验证 Hunter 能否通过 Codex 官方非交互 CLI 获得结构化 session、事件、恢复与中断观察，且始终由 Hunter 的 verifier 决定 Step 是否成功。

本 spike 不实现产品 UI、生产 Connector、默认 Provider 选择、远端仓库写入、凭据管理或发布；也不把 Codex 产品名称硬编码为 L2/L3。

## 方案比较

### A. `codex exec --json`（采用）

使用已安装 CLI 的稳定非交互 JSONL 面，以显式 `--sandbox read-only` 在自动创建、无 remote 的临时 Git fixture 中执行。优点是表面积小、版本和帮助面可固定、结构化事件可逐行保留、与 Phase 0 Task 6 一致。缺点是治理事件可能不如 app-server 完整。

### B. `codex app-server`（暂缓）

官方文档把 app-server 定位为深度集成面，提供 thread/turn、steer、interrupt、approval 和流式事件；但当前命令参考仍标为 experimental。它适合作为 CLI 收据显示缺口后的下一轮候选，不在本 spike 冻结为 Hunter 公共依赖。

### C. 交互式 TUI/终端文本（拒绝）

解析交互式终端文本无法形成稳定结构化契约，且可能把 idle、窗口或进程退出误判为成功，违反 Hunter 不变量。

## 组件与边界

新增 `spikes/codex/`，不修改 provider-neutral 领域模型：

- `exec-client.ts`：构造固定 argv，拒绝 bypass、auto-approve、full-access 和 shell 拼接；逐行解析 JSONL，保留未知原始事件。
- `scenario.ts`：只在 `withTemporaryGitFixture` 内执行本机探针，确认 fixture 没有 remote，记录版本/help hash、登录可用性、create/resume/interrupt 的独立结果与清理收据。
- `scenario.test.ts`：验证 evidence schema、脱敏、指纹稳定性、能力 fail-closed 和临时 fixture 清理。
- `exec-client.test.ts`：覆盖正常完成、approval/waiting、tool failure、显式中断、畸形 JSON 行、未知未来事件以及“exit 0 不等于 Step success”。

公共测试缝只有四个：命令规划、JSONL 事件归一化、版本化证据 envelope、临时 fixture 生命周期。测试不读取 Codex 私有状态、用户配置、凭据或完整环境。

## 数据流

1. 无配额 preflight 读取 `--version`、`exec --help`、`exec resume --help`、`app-server --help` 和 `login status` 的退出结果。
2. 真实场景在临时无 remote Git fixture 中执行最多三次只读调用：创建、按返回的 session identity 恢复、受控中断。
3. JSONL 行通过严格 envelope + 宽容 raw event 解析器归一化；畸形行成为协议错误事实，未知事件原样保留。
4. evidence 只保存固定 argv 占位、hash、状态和能力收据；明确区分真实模型服务调用与“没有远端仓库写入”，不保存 Prompt 正文、session ID、绝对用户路径或原始账户输出。
5. Connector/Agent return、`turn.completed`、进程 exit 0 和 cleanup PASS 都只是 Runtime 事实，不能完成 Hunter Step。

## 安全、错误与停止条件

- 只允许 `read-only` sandbox；禁止 `danger-full-access`、`full-auto`、`--yolo`、任何 `dangerously-*` 与自动批准。
- 使用 executable + argv、`shell: false`；任何可写探针必须在 testkit 创建的临时 Git fixture 内。
- 每次真实调用最长 60 秒，总调用数最多三次；超时只终止本场景创建的精确进程树。
- 登录失效、协议漂移、无法确认 session identity、无法证明中断或恢复时记录 `BLOCKED`/`NOT_PROVEN`，不重试冒险命令。
- 真实调用不会访问远端 Git、创建 PR/issue、push、安装插件或使用 MCP/连接器；环境中已有的非必要扩展不得成为 PASS 前提。
- evidence 写入前运行脱敏与绝对隐私路径扫描；cleanup 未证明时整体不得 PASS。

## 验证与提交

按垂直 RED→GREEN 切片实现：先命令/事件，再 evidence schema，再真实场景。最小门禁为精确 spike 测试、lint、typecheck、全量测试、build、`git diff --check` 和敏感/危险参数扫描。

实现形成一个聚焦中文提交，并更新现有功能分支与 Draft PR。远端 CI 只有实际完成后才能报告通过；Outcome 5 只有另一次明确决策才能改变。

## 官方接口依据

- Codex CLI 本机帮助：`codex-cli 0.144.6`，`exec --json`、`--sandbox`、`exec resume` 与 `app-server` 均存在；帮助 hash 写入本机 evidence。
- [Codex 非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)：`codex exec`、JSONL 事件与显式 sandbox。
- [Codex CLI 命令参考](https://learn.chatgpt.com/docs/developer-commands?surface=cli)：`codex exec` 为 stable，`codex app-server` 为 experimental。
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)：深度集成、thread/turn/interrupt 与结构化事件面，仅作为后续升级候选。
