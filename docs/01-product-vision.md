# Hunter Platform 产品愿景

## 一句话定义

Hunter 是一个本地优先、面向多项目的 AI 开发治理控制面：它把已经确认的需求转化为可追踪、可验证、可恢复的工作流，并通过可替换的外部 Runtime/Workbench Host 使用原生 Agent，同时统一管理尝试、验证、证据、归档和长期知识。

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

用户可以继续把 standalone Orca 作为成熟的日常桌面工作台；Hunter 当前
真实价值门则在普通本机浏览器打开一个窄而深的控制页，并以 Herdr 作为
可替换的候选 Runtime/terminal Host。`hunterd` 持有 canonical state；
Hunter 不复制 Orca 或 Herdr 已有的开发界面。

用户在 Hunter 中创建多个逻辑 Project。每个 Project 可以绑定一个或多个 Git Repository，并同时维护多个 Requirement。

一次典型使用路径是：

1. 在需求中心编写、澄清并批准 RequirementRevision。
2. 将一个或多个 RequirementRevision 切成可交付的 ChangeRevision。
3. 规划阶段生成带依赖的 TaskGraph；可串行，也可有限并行。
4. 为 Change 选择已发布的 WorkflowRevision，并设置每一步的 AgentProfile、SessionPolicy、WorkspacePolicy、Verifier 和预算。
5. Hunter 启动 WorkflowRun，通过 Herdr Adapter 把冻结 Handoff 交给一个 Herdr 承载的真实 Agent。
6. Run 页面以线路图展示当前 Task、Step、Attempt、会话、工作区、日志、产物和验证结果。
7. 测试或评审失败时，在显式 LoopPolicy 内创建新的 Attempt；不覆盖历史。
8. 需要深度操作时，打开已定位的 Herdr terminal/Agent 会话，或使用 standalone Orca/Codex 等原生界面检查 Git 与 Diff。
9. Run 完成、失败或取消后均可归档；归档自动进入分级知识体系。
10. 自定义 Hunter 移动端在当前阶段冻结；任何 Orca/Herdr 外部入口都不能绕过 Hunter 的验证与策略。

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
- 从 Run/Attempt 精确定位 Herdr workspace、terminal 与 Agent 会话
- 在普通本机浏览器运行的最小 Web 控制面

当前控制面只优先实现 Requirement、Change、Attention、Run/Attempt、
Verification、Evidence 和 Policy。完整 Hunter Desktop、移动 PWA、
终端、编辑器、Diff 和 Browser 均不在当前交付范围。

### Hunter Flow

确定性的工作流内核，包括：

- Task 依赖调度与 Step 状态机
- 条件分支、有限并行、Human Gate
- 有上限的 Loop、重试、超时与预算
- Agent 路由、Handoff Pack 和会话策略
- 输出契约与完成验证
- 崩溃恢复、幂等和事件账本

### Hunter Runtime (`hunterd`)

本机 canonical state 与适配层，包括：

- Agent/External Host 原子能力探测、ExternalOperation、Receipt 与对账
- Workspace、Writer 与 Controller Lease
- 独立 Verifier、Artifact、日志和协议事件采集
- Herdr 公共 CLI/socket Adapter
- Windows 与 Linux 平台边界

Herdr 0.7.5 是 Orca Stop 后唯一正在验证的候选 Runtime/terminal Host。
PTY、pane、进程树和 Agent 会话由 Herdr 负责；Hunter 不读取 Herdr 私有
状态，也不把 Host 事件当作业务成功。standalone Orca 可继续承担成熟
桌面体验，但已停止的 Orca Adapter 不在本 gate 扩展。Pi 或其他 Runtime
只能在新决策和相同公共契约下以新证据接入。

## 核心原则

1. **本地执行为事实源**：仓库、凭据、工作区和完整产物默认留在开发机。
2. **Hunter 持有产品状态**：外部 Agent、Host 或终端消失时，需求、工作流和历史仍可恢复。
3. **原生优先**：保留各家工具的界面和独特能力；Hunter 提供统一驾驶舱，而非复制所有体验。
4. **分级兼容**：协议完整的 Agent 自动执行；GUI 工具可以先采用打开、观察和人工确认。
5. **验证优先于自述**：Agent 返回不等于 Step 成功，必须通过 Verifier 或人工确认。
6. **不可变修订**：批准后的需求、发布后的 Change 与 Workflow 不覆盖修改。
7. **有界自治**：所有自动 Loop 都有轮数、时间、预算和停止条件。
8. **并发隔离**：并发写入使用独立 worktree；非 Git 目录首版单写者。
9. **开放且可替换**：Connector 与 Provider 通过能力契约接入，不绑定今天领先的单一工具。
10. **知识可追溯**：全部归档自动入库，但只有有效权威知识和已验证经验自动注入。

## 第一条真实执行路径

当前只验证一个 Herdr 承载的真实 Agent，不同时建设 Codex、CodeBuddy 和
Cursor 的深度 Direct Connector。具体 Agent 产品由本机可用性和用户选择
决定，其 Capability 等级只能由原子 probe receipt 计算，不能因产品名称
推定。Pi、恢复 Orca Adapter 或其他 Provider 必须在本 gate 结束后另行
决策，不能并行铺开。

## 知识愿景

所有 Run 归档后自动成为 `KnowledgeSource`，但知识按用途分级：

- **历史知识**：完整记录，可搜索、可追溯，默认不直接指导 Agent。
- **权威知识**：当前有效的批准需求、架构决策和项目规则，可自动注入。
- **经验知识**：从有证据的执行中提炼；只有满足 PromotionPolicy 且无冲突时自动提升。

RequirementRevision 自身就是正式知识来源，而不是复制进一个失去版本关系的向量库。过期知识保留但标记 `superseded` 或 `withdrawn`。

## 首版目标用户与平台

当前价值门面向**单用户、多项目、单台 Windows 开发机**：

- Windows 为首发和硬验收平台。
- Linux 从接口、路径、进程与打包设计第一天支持，并在后续阶段正式验收。
- 当前 gate 由 Herdr 承担 workspace、terminal 与 Agent Host；standalone
  Orca、编辑器和 Diff 工具仍可独立日用，但不拥有 Hunter canonical state。
- Hunter 的窄 Web 控制页承担治理、验证和证据；自定义移动/PWA 后置。
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

五个工作日的首个真实纵向版本至少应证明：

- 一个已批准 Requirement/Change 能启动真实非玩具 Run。
- Hunter 创建并校验精确的隔离 worktree；Herdr 只附加该路径。
- 一个 Herdr 承载的 Agent 能在无 bypass/yolo/auto-approve 参数下修改代码。
- Agent return、terminal idle 和 process exit 不会绕过独立 Verifier。
- 故意失败的 Attempt 1 被保留，恢复后的 Attempt 2 才能通过。
- Hunter 与本次隔离 Herdr session 各重启一次后不重复发送或产生重复副作用。
- 全部 Receipt/Evidence 脱敏、可复现，并能在十分钟内被普通用户理解。
- Herdr 私有状态消失或替换 Provider 时，Hunter canonical history 仍成立。

未在时间盒内全部证明，或用户认为相对直接使用 Orca 没有明显价值，
即停止扩建 Hunter，而不是继续增加 UI、Provider 或抽象。
