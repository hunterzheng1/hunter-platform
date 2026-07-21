# 05. 客户端信息架构与交互体验

> 状态：Approved Design Draft
> 适用范围：Hunter Platform Desktop、共享 Web UI、移动 PWA
> 核心判断：Hunter 是项目与工作流驾驶舱，不是另一个聊天窗口，也不替代原生 Agent 的专业界面。

## 1. 体验目标

Hunter 的客户端必须让用户在不理解 Runtime、Connector、Session 等内部术语的前提下，回答五个问题：

1. 我有哪些项目正在推进？
2. 每个项目有哪些已确认需求与待交付变更？
3. 当前执行到了哪一步，为什么停在这里？
4. 哪个 Agent、哪个会话、哪个工作区产生了什么结果？
5. 我现在需要批准、补充信息、接管，还是无需操作？

首版采用“一个安装包、一个主要客户端”的产品体验。桌面端在后台启动本机 `hunterd`，用户不需要分别管理 Workbench、Flow、Runtime。手机或其他电脑通过响应式 Web/PWA 访问同一个 Hunter Core，只提供远程驾驶所需能力。

## 2. 体验原则

### 2.1 工作项优先，而非 Agent 优先

主导航以 `Project → Requirement → Change → Task → Workflow Run` 为主线。Agent 是执行资源，不是信息架构中心。用户不需要先进入某个 Agent 的聊天列表才能找到工作。

### 2.2 状态必须可证明

“Agent 已返回”不等于“任务成功”。界面始终分开显示：

- 执行状态：是否已分配、运行、等待输入、返回或失联。
- 验证状态：是否待验证、验证中、通过、失败或等待人工确认。
- 工作项结论：是否满足步骤输出契约，是否可以继续下一步。

### 2.3 原生能力保留

Hunter 提供统一状态、上下文、产物和控制，但不复制 Cursor、Codex、CodeBuddy 的完整编辑、终端、Diff 或聊天体验。需要深度操作时，用户可以从当前 Step 一键打开正确的应用、仓库、worktree 或会话。

### 2.4 降级必须显式

当 Connector 只能打开 GUI、观察 Git 变化并等待人工确认时，界面显示其真实能力等级，不显示不可用的“暂停会话”“精确恢复”等按钮，也不把“窗口已打开”误报为“执行中”。

### 2.5 一个项目可以同时推进多条工作线

一个 Project 可以拥有多个 Requirement；Requirement 可以形成多个 Change；Change 可以具有串行或并行 Task DAG。项目页面不能只展示单一“当前任务”，而应展示全部活跃 Change、依赖关系、资源占用和待处理事项。

## 3. 核心对象在界面中的表达

| 对象 | 用户看到的名称 | 页面中的职责 |
|---|---|---|
| `Project` | 项目 | 一个产品或目标，可绑定多个仓库与设备路径 |
| `Requirement` | 需求 | 要解决什么、为什么、验收标准是什么 |
| `RequirementRevision` | 需求版本 | 已确认后不可变的执行依据 |
| `Change` | 变更 | 一次有边界、可交付、可验证的实现切片 |
| `Task` | 任务 | 规划生成的工作单元，组成依赖图 |
| `WorkflowRun` | 执行 | 某个冻结 Change 按工作流运行的实例 |
| `StepRun` | 步骤 | 计划、实现、测试、Review、归档等流程阶段 |
| `StepAttempt` | 尝试 | 一次实际执行；Loop 不覆盖旧尝试 |
| `Artifact` | 产物 | 文档、Diff、日志、报告、构建物等输出 |
| `Evidence` | 证据 | 测试、验证器、审批或协议回执等可信依据 |

界面文案要避免把 Task 与 Workflow Step 混称为“任务”。Task 是“做什么”，Workflow Step 是“以什么流程做并验证它”。

## 4. 全局信息架构

```text
Hunter
├─ 需要我处理
│  ├─ 等待输入
│  ├─ 等待审批
│  ├─ 验证失败
│  └─ Runtime/Agent 异常
├─ 项目
│  └─ Project
│     ├─ 概览
│     ├─ 需求
│     ├─ 变更与任务
│     ├─ 执行
│     ├─ 工作流
│     ├─ 产物与归档
│     ├─ 知识
│     └─ 设置
├─ 全局运行中心
├─ 工作流模板
├─ 知识检索
└─ 设置
   ├─ Agent 与 Profile
   ├─ Runtime Provider
   ├─ 设备与远程访问
   ├─ 权限与预算
   └─ 数据与备份
```

默认首页是“需要我处理”，而不是统计大屏。没有待处理事项时，再展示活跃项目、最近完成和快速创建入口。

## 5. 主要页面

### 5.1 项目列表与创建向导

创建 Project 时只要求最少信息：

1. 项目名称与可选说明。
2. 绑定一个主仓库或本地目录。
3. 选择默认 Workflow Template。
4. 检测本机可用 Agent 与建议 Profile。
5. 选择安全策略预设。

首版 UI 重点做好单仓库，但模型和页面允许追加仓库。每个仓库通过 `DeviceBinding` 保存该设备上的路径；跨设备同步时不传播本地绝对路径。

项目卡片显示：活跃 Change 数、正在运行/等待的 Step、最近验证结果、绑定仓库健康状态和需要用户处理的事项。

### 5.2 项目概览

项目概览聚合而不替代各专门页面：

- 活跃 Requirement 与最近批准版本。
- 活跃 Change、Task DAG 进度与阻塞关系。
- 当前 Workflow Run 的线路摘要。
- Agent/Runtime 可用性。
- 最近 Artifact、Archive 和新增 Knowledge。
- 当前设备缺失的仓库绑定或凭据。

### 5.3 需求中心

需求中心支持同一项目并存多个需求，并按 `draft / in_review / approved / superseded / withdrawn` 过滤。

需求详情包含：

- 问题、目标、非目标、验收标准和限制。
- 澄清记录及关键决策。
- 版本时间线与版本 Diff。
- 当前权威版本及替代关系。
- 关联 Change、Workflow Run、Archive 和 Knowledge。
- “创建修订版”“发起 Requirement Amendment”“规划为 Change”操作。

批准后不能覆盖正文。编辑动作总是创建新的 Draft Revision；正在执行的 Run 继续显示其冻结依据，并提示已有新版本可重新规划。

### 5.4 变更与 Task DAG

Change 是交付看板的主卡片。一个 Change 可以关联多个 RequirementRevision，一个 RequirementRevision 也可以由多个 Change 分期交付。

ChangeRevision 先以 Draft 编辑，发布前展示范围、覆盖需求与验收条件的固定
摘要。只有已发布 Revision 可生成 ExecutionPlan；发布后不能覆盖正文，调整
范围会创建新的 Draft Revision，并让用户选择是否重新规划尚未启动的工作。

Change 详情呈现：

- 交付范围、验收标准、关联需求版本。
- Execution Plan 版本。
- Task DAG，含依赖、目标仓库、工作区策略、Agent 绑定和状态。
- Task 的并行资格及冲突风险。
- 关联 Workflow Run 与集成/合并状态。

DAG 首版以自动布局的只读图和表格编辑为主，不建设任意自由画布。依赖关系可通过表单设置；非法环依赖在保存前拒绝。

### 5.5 工作流中心

工作流中心区分：

- 全局、版本化 `WorkflowTemplate`。
- 项目固定引用的 `WorkflowRevision`。
- 项目级参数、步骤、Agent/Profile 与验证器覆盖。
- 正在运行实例实际使用的冻结版本。

升级模板时先显示差异与兼容性提示，不自动影响现有 Run。首版用步骤表单与线路预览表达顺序、有限并行、条件、Gate、Retry 和有界 Loop。

### 5.6 Run 页面：执行线路是视觉中心

```text
需求确认 ─ 计划 ─┬─ Task A / 实现 ─ 测试 ─┐
  ✓        ✓    ├─ Task B / 实现 ─ 测试 ─┼─ 集成 ─ Review ─ 归档
                 └─ Task C / 等待 A ──────┘
```

每个节点同时显示图标、文字与颜色，不能只依赖颜色：

- `○ 未开始`
- `◌ 等待依赖`
- `● 运行中`
- `! 等待输入/审批`
- `↻ 正在验证或将进入新 Attempt`
- `✓ 已验证通过`
- `× 验证失败`
- `? 会话失联，需处理`

页面顶部固定显示：冻结 RequirementRevision、ChangeRevision、WorkflowRevision、整体预算、已用轮次、当前工作区和 Runtime 健康状态。

选中节点后打开 Step 详情，而不是离开线路。并行分支与 Loop 必须可展开查看每个 Attempt，默认只显示当前尝试和历史计数，避免线路过度拥挤。

### 5.7 Step 详情与产物

Step 详情至少分为以下页签：

| 页签 | 内容 |
|---|---|
| 概览 | 目标、输入/输出契约、状态、预算、等待原因 |
| 执行 | AgentProduct、Profile、Connector 等级、Session、Workspace、实时输出 |
| 产物 | 本 Attempt 产生的文档、Diff、日志、报告、构建物 |
| 证据 | 协议回执、测试结果、验证器结论、人工审批 |
| 历史 | 所有 Attempt、重试、Loop、Steer、暂停和恢复事件 |

关键操作根据能力动态显示：

- 查看实时输出。
- 补充指令或回答 Agent 提问。
- 暂停、继续、取消。
- 打开 Cursor、独立终端或原生 Agent。
- 运行/重跑验证器。
- 人工确认或驳回。
- 查看本次 Handoff Pack。

Artifact 必须显示来源对象、生成时间、内容哈希、关联 Attempt 和验证状态。日志预览允许截断，但原文件可下载或在本机打开。

### 5.8 全局运行中心

跨项目展示：

- 正在运行。
- 等待用户输入。
- 等待审批。
- 验证失败。
- Connector/Runtime 失联。
- 达到预算或 Loop 上限。

用户可以按 Project、Agent、设备和风险等级过滤。首版不提供跨项目拖拽式资源调度，但会提示同一工作区 Lease 或本机并发上限造成的排队。

### 5.9 归档与知识

归档页面按 Requirement、Change、Run、Task、模块和时间检索。每次归档自动进入历史知识索引；需求本身也是正式 KnowledgeSource。

知识详情必须呈现：

- 等级：历史、权威、经验。
- 状态：active、superseded、withdrawn 或 candidate。
- 来源及证据链。
- 适用范围和失效条件。
- 被哪些后续 Handoff Pack 使用。

“自动入库”不等于“自动注入”。客户端要让用户看见某条知识为何被选入上下文，以及如何排除或替代它。

## 6. 原生窗口交接

“打开原生工具”操作携带明确 Handoff，而不是只启动可执行文件：

- 正确 Project、Repository 和 Worktree。
- 当前 Requirement/Change/Task/Step 标识。
- Handoff Pack 文件位置或可复制 Prompt。
- 已知 NativeSessionRef；若无法精确定位则明确提示。

对 Cursor 等 L0/L1 Connector，流程为：

1. Hunter 准备工作区和 Handoff Pack。
2. 打开正确的 Cursor workspace。
3. 用户在原生界面执行。
4. Hunter 观察 Git、文件、日志和 Artifact 变化。
5. 用户提交完成回执，随后由验证器决定是否通过。

界面绝不把第 2 步标记为“Agent 已完成”。

## 7. 移动 PWA：远程驾驶舱

移动端首版只支持：

- 项目、Requirement、Change 与 Run 列表。
- 执行线路和当前 Step 摘要。
- Artifact、Evidence 与 Diff 摘要预览。
- 审批 Gate、回答问题、补充短指令。
- 暂停、继续和终止 Run。
- 通知与“一键回桌面处理”。

移动端首版不支持：

- 完整终端或 IDE。
- 大型 Diff Review。
- 工作流结构编辑。
- Agent/Profile 高危权限配置。
- 绕过 PolicyEngine 的命令执行。

高风险操作即使在策略上允许，也要显示目标项目、设备、工作区和具体影响，并要求二次确认。主机离线时页面明显显示“缓存摘要”，禁用实时控制。

## 8. 响应式与无障碍要求

- 状态不能只用红绿区分，必须配合图标和文字。
- 所有核心操作可通过键盘完成。
- 日志和线路图提供列表视图。
- 等待、失败、失联与取消使用不同语义。
- 时间显示本地时间，并能查看原始时区与事件序号。
- 桌面宽屏支持线路与 Step 详情并排；窄屏按层级逐页展开。

## 9. 首版体验验收

客户端达到首版可用的最低标准：

1. 用户可在 5 分钟内创建两个 Project 并绑定不同仓库。
2. 同一 Project 可同时看到至少两个 Requirement 和两个活跃 Change。
3. Task DAG 能正确表达串行、并行与等待依赖。
4. 任一运行节点都能在两次点击内定位到 Agent、Session、Workspace、Artifact 和 Evidence。
5. Agent 返回但测试失败时，线路明确显示“执行返回、验证失败、未完成”。
6. Cursor 降级流程不会出现虚假的自动控制按钮。
7. 应用重启后能回到相同 Run 线路，并将失联执行标成待处理。
8. 手机可以安全完成审批、补充输入、暂停和继续。
9. 归档后可以从 Requirement 或 Change 反向找到全部产物与知识。

## 10. 明确非目标

- 不建设新的通用聊天客户端。
- 不复刻 Cursor/Codex/CodeBuddy 的编辑器。
- 不以统计大屏取代工作处理入口。
- 不以终端是否空闲推断步骤是否成功。
- 不在首版建设自由拖拽 BPMN/DAG 编辑器。
- 不在移动端复刻完整桌面开发环境。
