# ADR-0004: 原生 Agent 采用分级 Connector

- Status: Accepted
- Date: 2026-07-21

## Context

Hunter 需要支持 Codex、CodeBuddy、Cursor，并在以后接入 Claude Code、OpenCode、Pi、Goose、Grok Build 等工具。这些产品暴露的接口差异显著：有的提供 ACP、app-server、Headless JSON 或可恢复 Session；有的主要是 GUI，只能可靠打开工作区、观察 Git 与 Artifact；不同版本的能力也会变化。

若强行提供统一的“完全自动控制”接口，系统只能依赖脆弱的终端文本或 GUI 自动化，并会错误显示执行状态。若只支持能力最完整的 Agent，又违背保留原生工具优势和避免供应商锁定的目标。

## Options considered

### Option A: 所有 Agent 必须完全自动化

不满足启动、发送、恢复、审批和 completion 的 Agent 不接入。

优点：工作流语义统一。缺点：排除 Cursor 等重要工具，迫使系统使用不可靠的非正式控制方式。

### Option B: 统一到最低公共能力

Hunter 只负责打开终端/窗口和人工确认。

优点：适配简单、覆盖广。缺点：浪费 Codex、CodeBuddy 等结构化能力，无法实现有价值的自动 Loop 和恢复。

### Option C: 分级能力与显式降级

Connector 发布原子 Capability 和 L0-L3 摘要等级。Step 声明所需能力，Flow 在满足时自动执行，不满足时选择允许的降级路径或停止。UI 明确展示控制深度与验证来源。

## Decision

选择 Option C。

能力等级定义为：

| Level | 定义 |
|---|---|
| L0 Manual/Launch | 打开正确应用/工作区并准备任务包；人工执行和确认 |
| L1 Observable | L0 + 观察进程、Git、文件、日志或 Artifact |
| L2 Controllable | 通过官方 CLI、ACP、app-server 或 RPC 启动、发送、中断和接收结果 |
| L3 Governed | L2 + 权限/工具事件、可靠 resume、Gate 和完成回执 |

调度以原子能力为准，等级仅用于产品展示与默认策略。

首批实现：

- Codex：目标 L2/L3 深度 Connector。
- CodeBuddy Code：目标 L2/L3，优先 ACP/Headless/HTTP 的稳定接口。
- Cursor：目标 L0/L1，打开正确 worktree、传递 Handoff、观察产物并人工确认。

Runtime 接入优先级：正式结构化协议，其次官方 Headless JSON，再次受管 PTY，最后原生应用 Handoff。不得使用脆弱 GUI 屏幕自动化或普通终端文本解析来伪装高等级。

Orca 是 Phase 0 首个有时限、可逆的 Provider 候选，验证 worktree、终端、Git、进程与移动控制基础；它在证据通过前不是产品依赖。Hunter 先通过公开 CLI/API 旁路接入，必要时才评估薄 Fork。Agent Orchestrator 和 Direct Connector 可以通过相同能力端口替代或补充 Orca。

## Consequences

### Positive

- 能同时利用深度协议 Agent 和重要 GUI 工具。
- 用户能看到真实控制能力、等待原因与人工介入点。
- 新 Agent 可以先以 L0/L1 快速接入，再逐步升级。
- Workflow 可以为关键步骤要求 L2/L3，并在不满足时拒绝不安全降级。
- Provider 与 Agent 的替换不会改变 Flow 核心语义。

### Negative

- UI、测试和调度必须处理能力矩阵，而不是一个简单 Adapter 接口。
- 相同 Workflow 在不同 Agent 上可能具有不同自动化程度。
- Connector 版本升级需要 Capability Manifest、Pin 与契约回归测试。
- L0/L1 步骤需要可靠的 Step Receipt 和人工交互体验。

### Follow-up constraints

- Connector 不得直接把 StepRun 标为成功；它只报告执行和观察事实。
- Agent 返回后必须经过 OutputContract 验证或人工确认。
- 同一 NativeSession 同时只能有一个 ControllerLease。
- 并行写入必须使用隔离 worktree。
- 默认不得继承 `--dangerously-skip-permissions` 或同类权限绕过参数。
- Capability Manifest 必须包含版本、平台、发现结果和经过测试的能力。
- OpenCode、Claude Code、Pi、Goose 等后续接入遵循同一契约，不获得专用架构特例。
