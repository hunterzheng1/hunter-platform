# 06. Runtime Provider 与 Agent Connector 设计

> 状态：Approved Design Draft
> 首批范围：Orca Provider、Codex、CodeBuddy Code、Cursor
> 核心判断：不同 Agent 可以具有不同控制深度；Hunter 必须能力协商并诚实降级。

## 1. 设计目标

Runtime 层负责把 Hunter Flow 的逻辑执行请求映射到本机的仓库、worktree、进程、PTY、Agent 会话和原生窗口，同时向 Flow 返回可验证的事件与产物。

它不负责：

- 定义 Requirement、Change 或 Workflow 语义。
- 决定某一步业务上是否成功。
- 保存 Hunter 的权威运行状态。
- 将所有 Agent 伪装成同一种会话协议。
- 用屏幕自动化猜测 GUI 工具内部状态。

Hunter Core 持有工作流事实；Runtime Provider 和 Connector 是可替换的执行适配层。

## 2. 能力拆分

不定义一个包办所有职责的万能 `RuntimeProvider`。首版使用八个可组合端口：

| 端口 | 职责 |
|---|---|
| `AgentDiscovery` | 发现安装、登录、版本、可执行入口和动态能力 |
| `WorkspaceProvider` | 创建/绑定仓库、branch、worktree、隔离空间和 Lease |
| `ProcessHost` | 启动进程、PTY、日志流、信号与进程树生命周期 |
| `AgentConnector` | 启动或连接 Agent、发送 Prompt、恢复、Steer、中断、审批 |
| `SessionObserver` | 观察 Session、原始事件、心跳与等待原因 |
| `NativeSurfaceOpener` | 打开 Cursor、终端或其他原生操作界面 |
| `ArtifactCollector` | 采集 Diff、文件、日志、测试报告与协议输出 |
| `CompletionVerifier` | 根据输出契约产生验证结果与 Evidence |

Orca 可以同时实现多个端口，但端口契约归 Hunter 所有。这样可以单独替换 WorkspaceProvider、直接使用某个 Agent 的结构化协议，或在 Orca 不可用时回退到其他 ProcessHost。

## 3. Connector 能力等级

### 3.1 等级定义

| 等级 | 名称 | 最低能力 | Hunter 的承诺 |
|---:|---|---|---|
| L0 | Launch / Handoff | 检测安装、打开应用或终端、定位工作区、准备任务包 | 只能确认已完成交接 |
| L1 | Observe | L0 + 观察进程、Git、文件、日志或 Artifact | 能展示外部变化，不能保证知道 Agent 内部状态 |
| L2 | Control | L1 + 官方 CLI/ACP/RPC/API 的启动、发送、中断、结果事件 | 能自动执行并控制受支持会话 |
| L3 | Govern | L2 + 权限事件、结构化工具事件、可靠恢复、完成回执、策略钩子 | 能执行细粒度 Gate、审计和恢复 |

等级不是产品营销标签，而是启动时协商出的 `CapabilityManifest`。同一 Agent 在不同版本、登录状态、启动模式或操作系统上可能处于不同等级。

### 3.2 关键能力字段

Manifest 至少包含：

```text
discover
launch
attach
send
interrupt
resume
steer
structured_events
permission_events
completion_receipt
workspace_targeting
artifact_export
native_surface
headless
mobile_control
```

每项同时记录：支持状态、来源、版本约束和最近一次探测时间。UI 与 Flow 根据 Manifest 选择合法操作，不能依赖硬编码的 Agent 名称。

## 4. 首批接入组合

| 接入对象 | 首版用途 | 目标等级 | Phase 0 必须验证 |
|---|---|---:|---|
| Orca | Workspace、Git、终端、PTY、Agent 进程与移动终端基础 | L1/L2 基础设施 | Windows 安装、JSON CLI/API、worktree、恢复、移动配对、安全默认值 |
| Codex | 第一条深度自动执行链 | L2/L3 | 启动/恢复/Steer/中断、事件、审批、完成回执、版本兼容 |
| CodeBuddy Code | 第二条供应商独立的深度执行链 | L2/L3 | ACP、Headless 或 HTTP 的实际稳定接口、Session 恢复、取消、权限与流式事件 |
| Cursor | GUI 原生操作与分级降级范例；SDK/CLI 作为升级候选 | L0/L1 | 打开指定 workspace、任务包交接、进程/Git/Artifact 观察、人工完成回执；并行比较 `@cursor/sdk` public beta 与 CLI 的事件、权限、条款和 Windows 稳定性 |

这里的等级是目标，不是未经验证的事实。Phase 0 通过实机契约测试后，为具体版本生成兼容矩阵；未通过的能力必须降级。

OpenCode、Claude Code、Pi、Goose、Grok Build 等进入后续 Connector 队列。Goose 不再具有特殊 Gate、版本 Pin 或产品决策地位，只能按普通 Agent 契约接入。

## 5. 接入优先级

每个 Connector 采用固定优先级：

```text
正式结构化协议
  → 官方 Headless JSON
    → 受管 PTY
      → 原生应用 Handoff
```

选择低层级方式只能因为更高层级不可用或不可靠，并记录降级原因。禁止以脆弱的终端文本正则或 GUI 像素识别冒充结构化协议。

## 6. 核心契约草案

以下是语义示例，不冻结具体语言或序列化格式：

```ts
interface ConnectorDescriptor {
  connectorId: string;
  agentProduct: string;
  supportedPlatforms: Array<"windows" | "linux">;
  probe(): Promise<CapabilityManifest>;
}

interface AgentDiscovery {
  discover(product: string, host: ExecutionHost): Promise<DiscoveryResult>;
  probe(candidate: DiscoveredAgent): Promise<CapabilityManifest>;
}

interface AgentConnector {
  prepare(request: ExecutionRequest): Promise<PreparedExecution>;
  start(prepared: PreparedExecution, idempotencyKey: string): Promise<NativeSessionRef>;
  attach(session: NativeSessionRef): Promise<SessionSnapshot>;
  send(session: NativeSessionRef, input: AgentInput): Promise<InputReceipt>;
  interrupt(session: NativeSessionRef, reason: string): Promise<ControlReceipt>;
  observe(session: NativeSessionRef, afterCursor?: string): AsyncIterable<RuntimeEvent>;
}

interface CompletionVerifier {
  verify(contract: OutputContract, attempt: AttemptSnapshot): Promise<VerificationResult>;
}
```

契约约束：

- 所有有副作用的调用携带幂等键。
- `start()` 成功只表示外部执行已创建，不表示 Step 成功。
- 原始上游事件保存在 Evidence 中；Flow 使用版本化的规范事件。
- Connector 不直接修改 `WorkflowRun` 或 `StepRun` 状态。
- Connector 失败返回结构化原因：未安装、未登录、不兼容、额度耗尽、权限拒绝、会话丢失、协议错误或未知。

## 7. 执行生命周期

```text
Flow 调度 StepAttempt
  → RuntimeManager 解析 AgentProfile 与能力要求
  → WorkspaceProvider 获取 WorkspaceLease
  → Connector probe / 能力协商
  → 准备 Handoff Pack 与权限策略
  → 幂等启动或连接 Native Session
  → 采集 RuntimeEvent、日志、Git 与 Artifact
  → Agent 返回或人工提交完成回执
  → CompletionVerifier 验证输出契约
  → Flow 决定成功、失败、Retry、Loop 或 Gate
```

可靠完成信号按可信度排序：

1. 官方协议的结构化完成事件。
2. Hunter 签发并关联 Attempt 的 Step Receipt。
3. 自动验证器：测试、构建、文件、Diff、内容哈希或输出 Schema。
4. 用户明确人工确认。

PTY 空闲、窗口关闭、进程退出码为 0 或 Agent 文本中出现“完成”都不能单独使 Step 变为成功。

## 8. Agent、Profile 与 Session 语义

“同一个 Agent”拆成四个维度：

- `AgentProduct`：Codex、CodeBuddy、Cursor。
- `AgentProfile`：模型、角色、权限、Skills、参数。
- `NativeSessionRef`：上游工具中的真实会话。
- `ExecutionHost`：具体设备与进程实例。

每个 AgentStep 显式配置：

```text
executor_selector
agent_profile
session_policy: reuse | resume_if_supported | new | manual
device_selector
workspace_policy: same | new_worktree | read_only_snapshot
required_capabilities
fallback_policy
```

`resume_if_supported` 失败时，Hunter 创建新会话并注入 Handoff Pack，同时在 UI 标识“新会话接续”，不能伪装成原会话。

## 9. Workspace 与并发写入

- 串行写入步骤默认复用同一 Workflow worktree。
- 并行写入 Task 必须使用独立 worktree 或受控副本。
- 只读分析可共享冻结源码快照。
- 合并、冲突解决、集成测试是显式 Step。
- 非 Git 项目首版只允许一个写入 Lease。
- Native Session 必须绑定其原 Workspace；恢复会话时不能静默切换路径。

`WorkspaceLease` 至少包含 Project、Repository、Device、绝对路径、Git HEAD、分支、读写模式、持有者和过期/回收状态。

## 10. Orca 集成策略

Orca 是 Phase 0 首个有时限、可逆的执行底盘候选，不是已采用依赖、Hunter 的事实源或不可替换内核。

### 10.1 阶段 A：旁路 Sidecar

优先通过公开 JSON CLI/API 接入，Hunter Core 独立保存全部业务状态。需要验证：

- Windows 上真实安装、升级和卸载。
- 仓库、worktree、终端与 Agent 生命周期。
- JSON 输出的 Schema、错误语义和向后兼容。
- Hunter 重启、Orca 重启、会话失联后的重新关联。
- ConPTY、路径空格、非 ASCII 路径、长路径和进程树。
- 移动配对与权限边界。
- 遥测、凭据、默认危险参数和许可证。

### 10.2 阶段 B：是否需要薄 Fork

只有同时满足以下条件才进入薄 Fork：

1. Sidecar 已证明核心运行能力可靠。
2. 单客户端体验存在无法通过公开扩展点解决的明确缺口。
3. 缺口对首版核心用户故事构成阻塞，而不是视觉偏好。
4. Fork 能保持 Hunter Core、数据库和领域模型独立。
5. 已评估上游同步成本、许可证和安全维护责任。

薄 Fork 只允许增加 Hunter 页面入口、启动/认证桥或稳定扩展点；不把 Flow、Requirement、Knowledge 逻辑塞进 Orca 内部。

### 10.3 回退条件

出现任一情况，应停止深度依赖 Orca：

- Windows 基础能力或恢复稳定性不达标。
- 公开接口不足且 Fork 维护成本不可接受。
- 安全默认值无法可靠覆盖。
- 许可证、遥测或供应链风险不能接受。
- 上游不兼容变化频繁，契约测试无法隔离。

回退顺序是：替换单个端口 → Direct Connector → 按 Agent Orchestrator 当前桌面/Go-daemon 架构做条件 Spike → Hunter 自研最小 Runtime。AO 不是已证明的无缝 Provider；禁止因为已投入研究成本而继续锁定。

## 11. Windows 首发与 Linux 兼容

### 11.1 Windows 首发验收

- 使用 ConPTY 或经验证的等价实现承载交互进程。
- 使用 Job Object 管理整棵进程树和取消行为。
- 路径传递使用结构化参数，不拼接 Shell 字符串。
- 验证盘符、UNC、空格、中文、长路径、符号链接和大小写差异。
- 原生应用启动器显式验证 executable、workspace 与参数。
- 凭据进入 Windows Credential Manager 或等价系统安全存储。

### 11.2 Linux 兼容边界

- Core 领域、Flow、Storage 和 Connector Contract 不依赖 Windows API。
- 平台能力通过 `ProcessHost`、`NativeSurfaceOpener`、`CredentialStore` 等端口隔离。
- Linux 使用 PTY、process group；需要时再增强到 cgroup/systemd user service。
- 遵循 XDG 数据目录与 Secret Service。
- CI 从 Phase 0 起执行 Linux 单元、存储迁移和 Connector Contract 测试；正式安装包在 Phase 2 验收。

## 12. 权限与安全

- 不默认使用任何 Agent 的跳过全部权限参数。
- AgentProfile 声明工具权限与资源边界；PolicyEngine 返回 allow、deny 或 require_approval。
- 凭据只由 Connector 在需要时解析，不能写入 Prompt、日志、Artifact 或 Event Payload。
- 进程命令以参数数组传递，避免 Shell 注入。
- NativeSurfaceOpener 只允许已注册应用和已验证工作区。
- 外部协议事件视为不可信输入，必须进行 Schema、大小和路径验证。
- Connector 插件以后如支持第三方分发，必须有签名、权限清单和隔离策略；首版不开放任意插件安装。

## 13. Connector 契约测试

所有 Connector 必须通过相同测试包：

1. 未安装与未登录探测。
2. 能力 Manifest 与版本变化。
3. 幂等启动，不重复创建 Session。
4. Prompt 输入和流式事件顺序。
5. 中断、超时、取消和进程树回收。
6. Session 恢复与不支持恢复时的显式降级。
7. 工作区路径与 Git HEAD 绑定。
8. 大日志、非 UTF-8、异常退出和协议截断。
9. Artifact 与 Evidence 来源关联。
10. 权限请求、拒绝、批准和重复审批。
11. Core/Provider 重启后的重连。
12. 上游版本未知或 Schema 漂移时 fail closed。

Fake Provider 是 CI 的确定性基线；真实 Orca、Codex、CodeBuddy、Cursor 在受控机器执行集成测试。通过 Fake 不代表真实 Connector 可发布。

## 14. 参考与验证入口

以下上游仅作为 Phase 0 验证入口，具体能力以实机与固定版本契约测试为准：

- [Orca 官方仓库](https://github.com/stablyai/orca)
- [Orca CLI Reference](https://www.onorca.dev/docs/cli/reference)
- [Orca Mobile](https://www.onorca.dev/docs/mobile)
- [Orca Supported Agents](https://www.onorca.dev/docs/agents/supported)
- [CodeBuddy CLI Reference](https://www.codebuddy.ai/docs/cli/cli-reference)
- [CodeBuddy ACP](https://www.codebuddy.cn/docs/cli/acp)
- [Agent Orchestrator](https://github.com/AgentWrapper/agent-orchestrator)
- [Agent Orchestrator 当前架构](https://github.com/AgentWrapper/agent-orchestrator/blob/main/docs/architecture.md)
- [Codex app-server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Cursor CLI](https://cursor.com/docs/cli/overview)
- [Cursor SDK 发布说明](https://cursor.com/changelog/sdk-release)
- [Cursor 服务条款](https://cursor.com/en-US/terms-of-service)
