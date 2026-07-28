# Runtime Context Glossary

## Canonical terms

| Term | Canonical meaning |
|---|---|
| `AgentProduct` | 一类外部 Agent 产品，例如 Codex、CodeBuddy Code 或 Cursor。 |
| `AgentProfile` | AgentProduct 的可复用执行配置，包含角色、模型、Skill、权限和参数。 |
| `Connector` | Hunter 与某种 AgentProduct 交互的能力实现。 |
| `ConnectorCapability` | Connector 可证明支持的原子能力，例如 launch、send、resume、observe、interrupt、approve。 |
| `ConnectorLevel` | 能力等级：L0 打开/交接，L1 可观察，L2 可控制，L3 可治理。 |
| `RuntimeProvider` | 提供一组可替换 Runtime 能力的组合入口；它与用户可见的 Workbench Host 是不同角色。 |
| `ExternalWorkbenchHost` | 承载原生工作区、终端、Diff、Browser 或 Agent 会话的外部产品，例如 Orca 或 Herdr；可链接 Hunter 控制页，但没有 Hunter canonical authority。 |
| `RuntimeObservation` | Provider/Host 报告的进程、终端、窗口、workspace 或 session 事实；只能驱动对账与注意事项，不能直接判定 Step 成功。 |
| `WorkspaceProvider` | 创建、查找和清理仓库工作区或 Git worktree 的能力；当前 gate 由 Hunter-owned Git 实现持有，外部 Host 只能附加已校验路径。 |
| `ProcessHost` | 管理进程、PTY、日志及生命周期的能力。 |
| `SessionObserver` | 将原生会话可证明的状态和事件映射为 Hunter 事件。 |
| `NativeSurfaceOpener` | 打开终端、Cursor 或其他原生操作界面的能力。 |
| `ArtifactCollector` | 从工作区、日志或协议事件收集 Artifact 和 Evidence 的能力。 |
| `NativeSessionRef` | 外部 Agent 中真实会话的引用；不等同于 WorkflowRun 或 StepAttempt。 |
| `SessionPolicy` | `reuse`、`resume_if_supported`、`new` 或 `manual` 的会话选择策略。 |
| `WorkspacePolicy` | `same`、`new_worktree` 或受控只读快照等工作区策略。 |
| `WorkspaceLease` | 在指定时间内授予一个执行者对工作区的读写权。 |
| `ControllerLease` | 串行化经过 Hunter Adapter 的输入控制者；无法强制阻止外部 UI/终端人工输入，观察到旁路输入时必须暂停并对账。 |
| `ProcessRef` | 受 ProcessHost 管理的进程树引用。 |

## Avoid

| Avoid | Use instead |
|---|---|
| 用一个含糊的 `agent_id` 表示产品、配置、会话和进程 | `AgentProduct`、`AgentProfile`、`NativeSessionRef`、`ProcessRef` |
| 把 Orca、Herdr 或任何 Host 当作权威状态或不可替换底座 | `RuntimeProvider` 契约与 Hunter canonical state |
| 把 ExternalWorkbenchHost 与 RuntimeProvider 合并成一个领域角色 | 分开表达用户界面承载与原子执行能力 |
| 把终端空闲、窗口打开或进程退出当作业务成功 | Flow 的 `Verifier` 与 OutputContract |
| 声称已控制无法可靠控制的 GUI 会话 | 标明 L0/L1，并进入人工确认或观察模式 |
| 默认跳过所有 Agent 权限 | 项目权限策略、工具白名单和 Human Gate |
| 继承 bypass、yolo、auto-approve 等 Host/Agent 预设 | Manual/fail-closed 配置；检测到危险参数即拒绝启动 |
| 并发写入共享工作目录 | 独立 `WorkspaceLease` 与 Git worktree |
