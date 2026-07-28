# Hunter Platform 系统架构

## 架构结论

Hunter Platform 当前采用**本地优先的模块化控制面 + 可替换外部工作台**：
一个本地服务 `hunterd`、一个窄 Web 控制面，以及一个 Orca Adapter。
Orca 是首选外部 Workbench/Runtime Host；它和 Hunter Web/CLI 都只能通过
受认证应用接口访问 Hunter 能力，不能绕过模块直接修改数据库。

逻辑上分为 Workbench、Flow 和 Runtime 三层，物理上先在一个 Monorepo 和一个本地服务中演进。只有出现明确的独立伸缩、隔离或团队部署需求时才拆服务。

## 系统视图

```mermaid
flowchart TB
    OrcaUI["Orca<br/>worktree / terminal / diff / browser / agent"]
    Web["Hunter Web control surface<br/>Requirement / Run / Verify / Evidence"]
    CLI["Narrow Hunter CLI / Agent tools"]
    API["Authenticated Application API"]

    OrcaUI -->|"public CLI / Skills / MCP"| Adapter["Orca Adapter"]
    OrcaUI -->|"opens loopback page"| Web
    Web --> API
    CLI --> API

    subgraph Core["hunterd - Hunter canonical state"]
        WB["Workbench<br/>Projects and Requirements"]
        Flow["Flow Engine<br/>Tasks, Runs, Steps, Loops"]
        Runtime["Runtime Manager<br/>operations, leases, observations"]
        Knowledge["Knowledge Catalog<br/>Archive and Resolution"]
        Policy["Policy Engine<br/>Permissions, Gates, Budgets"]
        Verifier["Independent Verifier<br/>receipts and output contracts"]
    end

    API --> WB
    API --> Flow
    API --> Knowledge
    Flow --> Policy
    Flow --> Runtime
    Flow --> Knowledge
    Flow --> Verifier

    Runtime --> Port["Runtime capability ports"]
    Port --> Adapter
    Adapter --> OrcaUI
    OrcaUI --> Agent["One real native coding Agent"]
    Port -.-> Future["Future Pi / Herdr / other Adapter"]

    Core --> SQLite["SQLite WAL<br/>events, state, indexes"]
    Core --> Files["Versioned files<br/>requirements, workflows, knowledge"]
    Core --> CAS["Content-addressed store<br/>logs and large artifacts"]
    Runtime --> Git["Git repositories<br/>Hunter-created worktrees and leases"]
    Policy --> Secrets["OS credential store"]
```

## 模块边界

| Module | 稳定接口职责 | 隐藏的复杂性 |
|---|---|---|
| `ProjectCatalog` | 创建 Project、绑定 Repository/Device、查询项目投影 | 多仓库身份、设备路径映射 |
| `Requirements` | 起草、审核、批准、修订 Requirement 与 Change | 不可变 Revision、覆盖关系、状态转换 |
| `FlowEngine` | 发布 Workflow、规划 Task、启动/控制/查询 Run | DAG 调度、Loop、幂等、重试、恢复 |
| `RuntimeManager` | 选择已证明能力、分配 Lease、记录操作/观察并对账 | 外部 Provider 引用、幂等、能力降级 |
| `ArtifactRepository` | 注册、寻址和读取 Artifact/Evidence | 文件哈希、去重、来源与生命周期 |
| `KnowledgeCatalog` | 归档入库、知识提升、冲突与上下文解析 | 等级、替代关系、范围、置信度 |
| `PolicyEngine` | 返回 allow、deny 或 require-approval | 项目规则、工具权限、风险、预算 |
| `Verifier` | 在 Agent 会话外运行冻结验证定义并签发收据 | 输出契约、哈希绑定、重跑与人工 Gate |

`DeviceGateway`、Hunter Desktop 与自定义移动端保留为冻结兼容模块，不是当前价值门的交付依赖。

模块之间使用命令、查询、稳定 ID 和领域事件。数据库事务可以在单体内部保证一致性，但调用方不能依赖另一个模块的表结构。

## Runtime 能力端口

`RuntimeProvider` 不是一个包办一切的万能对象，而是以下可组合端口：

- `AgentDiscovery`：发现安装、登录和版本状态。
- `WorkspaceProvider`：准备 Repository、branch、worktree 或只读快照。
- `ProcessHost`：抽象进程、PTY、输出和生命周期；当前 gate 的目标设计是
  通过已证明的 Orca 公共接口委托，尚未形成 production implementation。
- `AgentConnector`：launch、send、resume、interrupt、approve 等结构化动作。
- `SessionObserver`：接收协议或可证明的会话状态。
- `NativeSurfaceOpener`：打开终端、Cursor 或其他原生界面。
- `ArtifactCollector`：收集文件、Diff、测试报告和日志。
- `CompletionVerifier`：由 Hunter 在 Agent 会话外运行，为 Flow 提供机器验证结果；它不属于 Orca Adapter。

每个实现发布 Capability Manifest。Flow 根据步骤要求选择实现，不按产品名猜能力。

接入优先级为：

```text
正式结构化协议
  -> 官方 Headless JSON
    -> 受管 PTY
      -> 原生应用 Handoff
```

## Connector 能力等级

| Level | 可证明能力 | Hunter 行为 |
|---|---|---|
| L0 Manual/Launch | 打开正确应用或工作区，准备任务包 | 等待用户操作与人工完成确认 |
| L1 Observable | L0 + 进程、Git、文件、日志或 Artifact 观察 | 显示可观察状态，仍不声称完整控制 |
| L2 Controllable | 官方 CLI、ACP、app-server 或 RPC 的启动、发送、中断、结果 | 可自动执行并接收结构化返回 |
| L3 Governed | L2 + 权限事件、工具事件、可靠恢复、完成回执 | 可受 Policy/Gate 治理并高可信恢复 |

当前不按 Codex、CodeBuddy 或 Cursor 名称设定目标等级。第一条 Orca-hosted
路径只启用本机原子 probe receipt 已证明的能力；任何能力缺失都显式降级
或阻断，不得通过解析模糊终端文本伪造 L2/L3。

## Orca 集成策略

Orca 是首选但可替换的外部 Workbench/Runtime Host。当前只实施旁路
Adapter：

1. 仅使用公开 CLI、Skills、MCP 或其他明确公开契约，不修改 Orca。
2. Hunter 先用 Git 创建、校验并租赁精确 worktree；Orca 只能附加该路径。
3. Hunter Core、数据库、Workflow、Verifier 与知识规则永不存入 Orca
   私有模型，Adapter 不读写 Orca 私有数据库。
4. Orca 的 idle、exit、window、terminal、session 状态只生成
   `RuntimeObservation`，不能完成 Step。
5. Hunter-owned run 必须使用 Manual/fail-closed 配置；发现 bypass、yolo、
   auto-approve 等危险参数立即拒绝启动。
6. 只有 sidecar 通过且公共扩展点无法解决实质 UX 阻断时，才以新 ADR
   评估薄 Fork；当前未授权任何 Fork。

## 数据架构

### SQLite WAL

保存：

- ID、关系和当前运行投影
- Append-only domain event
- 幂等键、Lease、重试与恢复元数据
- 可重建的查询索引

数据库不保存秘密，也不作为需求、工作流或知识正文的唯一载体。

### 版本化文件区

保存可读、可迁移正文：

- RequirementRevision 和 ChangeRevision
- WorkflowRevision 和项目覆盖
- ExecutionPlan、Archive manifest 与 KnowledgeEntry 正文

文件是内容事实源；SQLite 是关系、事件、索引和动态状态事实源。

### Content-addressed store

按内容哈希保存大日志、附件、截图、测试报告和构建产物。数据库只保存引用、媒体类型、大小、来源和保留策略。

### Git/worktree

源码的事实源仍是 Git Repository。Hunter 管理 WorkspaceLease 和 worktree，但不复制为私有代码网盘。

### 凭据

Token 和密钥存入 Windows Credential Manager 或 Linux Secret Service。数据库和版本化文件只保存 SecretRef。

## 执行和恢复

1. 状态变化先追加领域事件，再在同一事务中更新查询投影。
2. 所有外部启动和控制命令携带幂等键。
3. Runtime 为 Session、Process、Workspace 和 Controller 保存独立引用与 Lease。
4. `hunterd` 重启后向 Provider 和 Connector 重新对账。
5. 无法证明原会话仍存在时标记 `stale` 或 `needs_attention`，不猜测成功。
6. Verifier 必须可安全重跑；有副作用步骤必须声明恢复或人工处置策略。
7. 外部事件使用去重 ID，晚到和重复事件不能让状态机倒退。

## 并发与工作区

- 顺序写步骤默认沿用同一个 Workflow worktree。
- 只读 Task 可以共享固定 Commit 的快照。
- 并行写 Task 必须获得不同 WorkspaceLease，并使用独立 Git worktree。
- 汇合、冲突解决和集成测试是显式 Task/Step。
- 同一 NativeSession 必须绑定原 Workspace；切换 Workspace 时创建新 Session 或受支持的显式迁移。
- 非 Git 目录首版实行单写者，不自研文件合并系统。

## 本地与远程访问

- `hunterd` 默认只监听本机。
- Orca Browser tab、本机浏览器和窄 CLI 使用同一受认证应用 API。
- `hunterd` 继续默认仅监听 loopback；Orca 不能获得安装级长期 Secret。
- 自定义移动/PWA、设备配对、中继和远程控制在当前 gate 冻结。

## 平台策略

- Windows 是 Phase 0 和 Phase 1 的硬验收环境：路径、ConPTY、Job Object、凭据库、进程树和原生应用启动都需真实测试。
- Linux 的路径、process group、Secret Service 和包格式在接口层保持同构；Phase 2 完成正式安装包验收。
- 平台差异封装在 ProcessHost、WorkspaceProvider、SecretStore 和 NativeSurfaceOpener 内，不泄漏到 Flow 领域模型。

## 推荐 Monorepo 形态

```text
hunter-platform/
├─ apps/
│  ├─ web/                     # narrow control surface
│  ├─ daemon/                  # canonical local control plane
│  └─ desktop/                 # frozen compatibility/recovery asset
├─ packages/
│  ├─ domain/
│  ├─ flow-engine/
│  ├─ knowledge/
│  ├─ storage/
│  ├─ runtime-contracts/
│  ├─ provider-orca/           # active bounded Adapter
│  ├─ connector-codex/         # frozen direct path
│  ├─ connector-codebuddy/     # frozen
│  ├─ connector-cursor/        # frozen
│  ├─ policy/
│  └─ testkit/
├─ workflow-packs/
│  └─ hunter-default/
└─ docs/
```

Hunter-Harness 继续作为 Workflow/Skill 内容包与可选分发仓库；旧 Registry 不定义 Hunter Platform 的 Project，也不是本地执行依赖。Goose 专用 Gate、版本 Pin 和 30 天 Pilot 不迁入主产品。
