# ADR-0001: Hunter 是多 Agent 开发控制面

- Status: Accepted
- Date: 2026-07-21

## Context

用户会在 Codex、Cursor、CodeBuddy、Claude Code、OpenCode、Pi、Goose 等工具之间切换，甚至在同一个 Change 中组合使用。各工具持续迭代，今天领先的产品明天可能被替代。Hunter 需要统一管理多项目、需求版本、Change、Task、Harness 工作流、执行线路、产物、归档和知识，同时保留各原生工具自己的编辑器、模型、终端和交互优势。

以 OpenClaw、Hermes、Goose 或任意单一 Agent 作为 Hunter 产品底座，会让 Hunter 的领域模型、能力边界和发布节奏依附该工具。反过来，如果 Hunter 重做一个大一统编程 Agent，则会重复模型 Loop、编辑器、终端和工具生态，并很难持续追上每家产品。

## Options considered

### Option A: 构建新的超级编程 Agent

Hunter 自己持有模型 Loop、工具调用、编辑器和执行环境，再把其他 Agent 当次要插件。

优点：理论上体验最统一。缺点：范围巨大，重复成熟工具能力，难以保留原生优势，并形成新的锁定。

### Option B: 选择一个现有 Agent 作为产品底座

以 OpenClaw、Hermes、Goose、OpenCode 或类似产品为核心，在其上加入项目和流程功能。

优点：首期功能多。缺点：产品身份、状态模型、平台支持和维护风险由上游定义；难以对其他原生 Agent 做对等接入。

### Option C: 将 Hunter 定义为控制面

Hunter 拥有项目、需求、工作流、运行、证据与知识的权威状态；外部 Agent 与 Runtime Provider 通过能力契约接入。原生工具仍是专业操作台，Hunter 是统一驾驶舱。

优点：符合多工具实际使用，能显式表达能力差异，核心数据可持续演进。缺点：必须建设可靠的工作流、Connector 与状态对账体系，部分 GUI 工具只能半自动。

## Decision

选择 Option C。

Hunter 的产品主链是：

```text
Project
  -> RequirementRevision(s)
    -> ChangeRevision
      -> TaskGraph / Task
        -> WorkflowRun / WorkflowStep
          -> Agent execution
            -> Artifact / Evidence / Archive / Knowledge
```

Hunter Workbench 提供项目、需求、执行线路和知识体验；Hunter Flow 提供确定性调度、验证和有界 Loop；Hunter Runtime 连接原生 Agent、终端、工作区和可替换 Provider。

Codex、CodeBuddy、Cursor、Orca、Agent Orchestrator 及未来工具都不是 Hunter 的业务事实源。Goose 专用 Gate、版本 Pin 和 Pilot 不进入主产品；需要 Goose 时按普通 Agent Connector 接入。

## Consequences

### Positive

- 可以按 Change/Step 选择最合适 Agent，并保留原生工具优势。
- 外部工具升级或被替代时，Hunter 的需求、工作流、归档和知识不丢失。
- 产品可以诚实展示自动、可观察和人工模式，而非伪造统一能力。
- Workbench、Flow、Runtime 的职责清晰，可独立测试和演进。
- Hunter-Harness 可专注 Workflow/Skill 内容和分发，不再定义产品 Project。

### Negative

- 需要为每类 Agent 维护 Connector 契约测试与版本兼容性。
- GUI 工具的首版体验可能需要人工确认，自动化深度不一致。
- Hunter 必须解决状态对账、会话/工作区身份和完成验证等困难问题。
- 统一 UI 只能覆盖共同控制面，不能复制每个 Agent 的全部交互。

### Follow-up constraints

- 新功能不得把某个 Agent 私有概念提升为核心领域概念。
- 任何外部 Provider 都必须可由 Fake 实现通过相同契约测试。
- “Agent 返回”不得直接驱动 Step 成功。
- 原生界面通过快捷打开和 Handoff 保留，不纳入不可靠屏幕自动化。
