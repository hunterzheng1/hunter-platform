# Hunter Platform 产品愿景

## 一句话定义

Hunter 是一个本地优先、面向多项目的 AI 开发控制台：它把已经确认的需求转化为可追踪、可验证、可恢复的工作流，并按能力等级调度 Codex、CodeBuddy、Cursor 等原生 Agent，同时统一管理产物、证据、归档和长期知识。

Hunter 不是新的“超级编程 Agent”，也不替代 Cursor、Codex 等工具自己的编辑器、终端、模型或 Agent Loop。它是这些工具之上的控制面。

## 要解决的问题

个人开发者可以同时使用多个快速演进的 AI 工具，但实际开发过程仍然割裂：

- 项目、需求、会话和工作目录分散在不同应用中。
- “Agent 说完成了”与“代码已经通过验证”常被混为一谈。
- 测试失败后的修复 Loop 缺少边界、预算和完整历史。
- 一个需求拆成多个并行任务后，工作区隔离、依赖和汇合主要靠人工记忆。
- 计划、Diff、测试、评审、归档和知识存在于不同目录或聊天记录中。
- 工具领先地位会变化，围绕单一 Agent 构建的工作方式容易被锁定。
- 移动端很难安全地查看进度、审批 Gate 或补充信息。

Hunter 的目标不是抹平各工具差异，而是让差异显式、让流程可验证，并让用户可以随时切换执行工具而不丢失产品级状态。

## 最终产品形态

用户安装一个 Hunter 客户端，创建多个逻辑 Project。每个 Project 可以绑定一个或多个 Git Repository，并同时维护多个 Requirement。

一次典型使用路径是：

1. 在需求中心编写、澄清并批准 RequirementRevision。
2. 将一个或多个 RequirementRevision 切成可交付的 ChangeRevision。
3. 规划阶段生成带依赖的 TaskGraph；可串行，也可有限并行。
4. 为 Change 选择已发布的 WorkflowRevision，并设置每一步的 AgentProfile、SessionPolicy、WorkspacePolicy、Verifier 和预算。
5. Hunter 启动 WorkflowRun，按条件调度 Codex、CodeBuddy Code、Cursor 或其他 Agent。
6. Run 页面以线路图展示当前 Task、Step、Attempt、会话、工作区、日志、产物和验证结果。
7. 测试或评审失败时，在显式 LoopPolicy 内创建新的 Attempt；不覆盖历史。
8. 需要深度操作时，一键打开正确的终端、Cursor 或其他原生工作界面。
9. Run 完成、失败或取消后均可归档；归档自动进入分级知识体系。
10. 手机或另一台设备可以查看、审批、补充输入、暂停和继续，但不能绕过项目安全策略。

## 四层业务语义

```text
Requirement -> Change -> Task -> Workflow Step
```

- **Requirement**：要解决什么、为什么、约束和验收标准是什么。
- **Change**：本次准备交付的一个有边界实现切片。
- **Task**：规划产生的具体工作单元，具有依赖、目标仓库和验收条件。
- **Workflow Step**：Task 如何被计划、实现、测试、评审和归档。

一个 Project 可以同时拥有多个 Requirement；一个 Requirement 可以由多个 Change 分期实现；一个 Change 也可以覆盖多个相关 RequirementRevision。Change 与 Task 都可以声明串并行关系。

## 产品组成

### Hunter Workbench

面向用户的项目与执行驾驶舱，包括：

- Project、Repository 和 DeviceBinding 管理
- Requirement、Change 和版本审核
- Workflow Template、项目覆盖与版本升级
- Run/Task/Step 执行线路
- Artifact、Evidence、Archive 和 Knowledge
- 原生 Agent 窗口快捷打开
- Windows 首发桌面端与移动 Web/PWA

### Hunter Flow

确定性的工作流内核，包括：

- Task 依赖调度与 Step 状态机
- 条件分支、有限并行、Human Gate
- 有上限的 Loop、重试、超时与预算
- Agent 路由、Handoff Pack 和会话策略
- 输出契约与完成验证
- 崩溃恢复、幂等和事件账本

### Hunter Runtime (`hunterd`)

本机执行与适配层，包括：

- Agent 探测、启动、连接、观察和中断
- PTY、进程树和原生窗口管理
- Workspace/worktree 与控制权 Lease
- Orca Provider 和 Direct Connector
- Artifact、日志和协议事件采集
- Windows 与 Linux 平台适配

Orca 是 Phase 0 首个有时限、可逆的 Runtime Provider 可行性候选，不是已采用底座，也不是 Hunter 的数据事实源。Agent Orchestrator 或 Hunter 自研能力可在相同契约下替换或补充它。

## 核心原则

1. **本地执行为事实源**：仓库、凭据、工作区和完整产物默认留在开发机。
2. **Hunter 持有产品状态**：外部 Agent、Orca 或终端消失时，需求、工作流和历史仍可恢复。
3. **原生优先**：保留各家工具的界面和独特能力；Hunter 提供统一驾驶舱，而非复制所有体验。
4. **分级兼容**：协议完整的 Agent 自动执行；GUI 工具可以先采用打开、观察和人工确认。
5. **验证优先于自述**：Agent 返回不等于 Step 成功，必须通过 Verifier 或人工确认。
6. **不可变修订**：批准后的需求、发布后的 Change 与 Workflow 不覆盖修改。
7. **有界自治**：所有自动 Loop 都有轮数、时间、预算和停止条件。
8. **并发隔离**：并发写入使用独立 worktree；非 Git 目录首版单写者。
9. **开放且可替换**：Connector 与 Provider 通过能力契约接入，不绑定今天领先的单一工具。
10. **知识可追溯**：全部归档自动入库，但只有有效权威知识和已验证经验自动注入。

## 首批 Agent

首个纵向版本冻结三种代表性接入：

- **Codex**：目标 L2/L3，验证结构化执行、恢复、Steer 与审批事件。
- **CodeBuddy Code**：目标 L2/L3，验证 ACP、Headless 或 HTTP 接入以及非 OpenAI 深度 Connector。
- **Cursor**：目标 L0/L1，验证打开正确工作区、传递任务、观察 Git/产物和人工完成确认。

OpenCode、Claude Code、Pi、Goose、Grok Build 等以后按相同 Connector 契约接入。Goose 不再享有专用 Gate、版本 Pin 或产品架构地位。

## 知识愿景

所有 Run 归档后自动成为 `KnowledgeSource`，但知识按用途分级：

- **历史知识**：完整记录，可搜索、可追溯，默认不直接指导 Agent。
- **权威知识**：当前有效的批准需求、架构决策和项目规则，可自动注入。
- **经验知识**：从有证据的执行中提炼；只有满足 PromotionPolicy 且无冲突时自动提升。

RequirementRevision 自身就是正式知识来源，而不是复制进一个失去版本关系的向量库。过期知识保留但标记 `superseded` 或 `withdrawn`。

## 首版目标用户与平台

首版面向**单用户、多项目、多设备**：

- Windows 为首发和硬验收平台。
- Linux 从接口、路径、进程与打包设计第一天支持，并在后续阶段正式验收。
- 桌面端承担配置、Diff、日志和深度操作。
- 响应式 Web/PWA 是移动端远程驾驶舱；原生 App 与聊天机器人后置。
- 团队组织、成员权限、计费和多人同时编辑不属于首版。

## 非目标

首版不建设：

- 新的通用自主编程 Agent 或模型网关
- Cursor/Codex 的替代编辑器
- 任意 GUI 屏幕自动化
- 无边界自主 Loop
- 任意 BPMN 或低代码平台
- 团队协作与企业组织权限
- 默认自动 Merge、Push、发布或部署
- 完整原生移动 App
- 依赖云端才能运行的执行中心

## 成功标准

首个纵向版本至少应证明：

- 两个以上 Project 可独立运行，且一个 Project 可维护多个 Requirement。
- Requirement 可拆成 Change 和串并行 TaskGraph。
- Codex、CodeBuddy、Cursor 可在同一个 Change 的不同步骤中按能力等级协作。
- 执行状态和验证状态不会混淆。
- 测试或评审失败能够创建新 Attempt，并在预算内返回实现。
- 并行写 Task 具有独立 worktree，集成是显式步骤。
- Hunter 或 Provider 重启后能够恢复或诚实标记 `needs_attention`。
- 成功、失败、取消的 Run 都可归档，且知识来源、状态和适用范围可追溯。
- 手机可安全查看、审批、补充、暂停和继续。
- Orca 被替换为 Fake 或备选 Provider 时，Hunter 的核心业务状态和测试仍然成立。
