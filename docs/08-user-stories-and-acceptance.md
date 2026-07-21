# 08. 用户故事与验收标准

> 状态：Approved Design Draft
> 首版目标用户：单用户、多项目、多设备的个人开发者
> 首发验收平台：Windows；核心契约从第一天在 Linux CI 运行。

## 1. 验收原则

- 验收围绕真实工作流，不以“页面存在”或“接口返回 200”代替结果。
- Agent 返回与步骤成功分开验收。
- 每个关键结果必须能定位到 RequirementRevision、ChangeRevision、Task、StepAttempt、Session、Workspace、Artifact 和 Evidence。
- 自动测试验证确定性语义；真实 Agent 集成测试验证上游能力；用户体验验收验证是否真正可用。
- 任何上游能力无法证明时，产品必须显式降级，而不是放宽验收标准。

## 2. 核心用户旅程

### Journey A：建立项目并确认需求

作为个人开发者，我希望在一个客户端里创建多个逻辑项目，为每个项目绑定仓库、工作流和 Agent 配置，并同时维护多个需求，以便不同产品不会混在一个 Agent 会话里。

```gherkin
Given 本机存在两个 Git 仓库
When 用户创建 Project A 与 Project B 并分别绑定仓库
Then 项目列表显示两个独立 Project
And 每个 Project 拥有独立的 Requirement、Change、Run 和 Knowledge 空间
And 本地路径只记录在当前 DeviceBinding
```

```gherkin
Given Project A 存在两个 draft Requirement
When 用户批准 Requirement 1 的 Revision 3
Then Revision 3 变为 approved 且正文不可覆盖
And Requirement 2 保持独立状态
When 用户修改 Requirement 1
Then 系统创建新的 draft Revision 4
And 已运行工作仍引用 Revision 3
```

### Journey B：把需求切成可执行变更与任务

作为开发者，我希望把一个或多个已批准需求规划为有边界的 Change，再拆成串并行 Task，以便多个 Agent 安全协作而不混淆业务目标和流程步骤。

```gherkin
Given 两个 approved RequirementRevision
When 用户创建覆盖两者的 draft ChangeRevision、发布该精确版本并运行规划
Then ExecutionPlan 生成 Task A、B、C
And C depends on A and B
And Task 与 Workflow Step 在界面和 API 中是不同对象
And 对 DAG 环依赖的保存被拒绝并说明环路径
And 已发布 ChangeRevision 不可覆盖；范围变化会创建新的 draft Revision
```

### Journey C：混合 Agent 执行并可接管

作为开发者，我希望计划交给 Codex、实现交给 CodeBuddy、某个局部修改在 Cursor 中人工接管，同时仍在一个 Run 里看到统一状态与产物。

```gherkin
Given Codex 与 CodeBuddy Connector 已通过 L2 能力探测
And Cursor Connector 只提供 L0/L1
When WorkflowRun 执行计划、实现和人工接管步骤
Then Codex 与 CodeBuddy 步骤可由 Hunter 启动并观察结构化事件
And Cursor 步骤打开正确 worktree 和 Handoff Pack
And Cursor 页面明确显示“等待人工完成”
And 三类步骤的 Artifact 与 Evidence 都关联到对应 StepAttempt
```

### Journey D：验证失败并有界 Loop

作为开发者，我希望测试失败时自动回到实现步骤，但保留每次尝试并受轮次、时间和预算限制。

```gherkin
Given 实现 Attempt 1 的 Agent 已返回
When VerifyStep 执行测试并失败
Then 实现 Step 不显示成功
And Run 创建实现 Attempt 2
And Attempt 1 的 Prompt、Session、Diff、日志与测试 Evidence 仍可查看
And Attempt 2 收到包含失败证据的 Handoff Pack
When 达到最大 Loop 轮次
Then Run 暂停并进入 needs_attention
And 不再自动启动新的 Agent Session
```

### Journey E：崩溃后可信恢复

作为开发者，我希望 Hunter 或执行底盘重启后，运行状态不会丢失，也不会重复启动 Agent 或误报成功。

```gherkin
Given 一个 StepAttempt 正在运行
When hunterd 在发出启动命令后崩溃并重启
Then 相同幂等键不会创建第二个 Native Session
And Hunter 尝试重新 Attach 原 Session
And 无法证明存活的 Session 标记 stale/needs_attention
And 用户可以验证现有产物、恢复或创建新 Session 接续
```

### Journey F：归档自动进入知识体系

作为开发者，我希望每次 Run 归档后自动可检索，并让有效需求和经过验证的经验帮助后续工作，而不被过期信息污染。

```gherkin
Given 一个成功 Run 和一个失败 Run 已归档
When Knowledge Ingest 完成
Then 两者都作为 historical KnowledgeSource 可检索
And active RequirementRevision 作为 authoritative KnowledgeSource
And superseded RequirementRevision 默认不注入新 Handoff Pack
And 失败 Run 中自动提炼的结论不会未经规则验证升级为权威知识
And 每个注入项可追溯到来源与适用范围
```

### Journey G：手机远程驾驶

作为离开电脑的开发者，我希望从手机查看进度、回答问题和批准 Gate，但不让手机成为无边界远程终端。

```gherkin
Given 用户已在桌面端启用远程访问并配对手机
When Step 进入 waiting_approval
Then 手机收到最小化通知并可查看目标、风险和 Evidence 摘要
When 用户批准一次
Then Step 只推进一次
And 重复或离线重放审批返回原 Receipt
When 主机离线
Then 手机显示缓存时间并禁用实时控制
```

## 3. 功能验收矩阵

| ID | 能力 | 必须通过的结果 | 主要验证方式 |
|---|---|---|---|
| P-01 | 多项目 | 创建至少 2 个 Project，状态与资产完全隔离 | E2E + 人工体验 |
| P-02 | 多仓库模型 | 一个 Project 可追加 Repository；首版单仓流程无退化 | Domain/API Test |
| R-01 | 多需求 | 同项目至少 2 个 Requirement 可独立版本化 | E2E |
| R-02 | 需求冻结 | approved Revision 不能覆盖；修改创建新 Revision | Domain Test |
| R-03 | 需求变更 | 执行中新增 Revision 不偷换现有 Run 依据 | E2E |
| C-01 | Change 映射 | Change 可关联一个或多个 RequirementRevision | Domain Test |
| T-01 | Task DAG | 支持串行、有限并行、Join；拒绝环 | Property/Domain Test |
| T-02 | 工作区隔离 | 并发写 Task 使用不同 worktree | Real Git Integration |
| W-01 | 模板版本 | 项目固定 WorkflowRevision；模板升级需显式确认 | E2E |
| W-02 | 步骤类型 | Agent、Command、Verify、HumanGate、Context、Subflow 可组合 | Flow Test |
| W-03 | 有界 Loop | 最大轮次、时间或预算达到后停止 | Model/Clock Test |
| W-04 | 条件路由 | 路由由结构化结果/验证器决定，可重放一致 | Flow Test |
| A-01 | Attempt 历史 | Loop/Retry 新建 Attempt，不覆盖输入输出 | Storage Test |
| A-02 | 状态真实性 | Agent 返回但验证失败时不显示成功 | E2E |
| X-01 | Codex | 固定版本通过启动、事件、中断、恢复与完成契约 | Real Connector Test |
| X-02 | CodeBuddy | 固定版本通过 ACP/Headless 选定接口契约 | Real Connector Test |
| X-03 | Cursor | 打开正确 workspace、交接任务、观察结果、人工确认 | Windows E2E |
| X-04 | 能力降级 | 缺失能力时禁用操作并展示原因 | Contract/UI Test |
| O-01 | Orca Sidecar | 不修改 Orca 即可完成首选 Runtime Spike，或输出可复现失败证据 | Windows Spike |
| S-01 | 幂等启动 | Core 崩溃重试不会重复创建 Session | Fault Injection |
| S-02 | 恢复 | 重启后重连或标记待处理，不猜测成功 | Fault Injection |
| S-03 | Artifact | 文件、Diff、日志与报告具备哈希和 provenance | Storage/E2E |
| K-01 | 自动入库 | 所有 Archive 自动成为历史知识源 | E2E |
| K-02 | 分级使用 | 仅 active 权威知识与已验证经验默认注入 | Knowledge Policy Test |
| M-01 | 移动查看 | 手机可查看项目、线路、Step、Artifact 摘要 | Real Device/PWA |
| M-02 | 移动控制 | 审批、输入、暂停、继续、终止受权限和幂等保护 | Security E2E |
| SEC-01 | Secret | 数据库、日志、导出与 Prompt 不泄露测试 Secret | Security Scan |
| SEC-02 | 权限 | 默认不使用 skip-permissions；高危动作要求 Gate | Policy/E2E |
| LNX-01 | Linux 兼容 | Domain/Flow/Storage/Contract 测试在 Linux CI 通过 | CI |

## 4. Phase 0 技术去风险验收

Phase 0 不是“做出一些 Demo”，而是回答可导致架构转向的问题。

### 4.1 Orca Spike

必须提交可复现报告和自动化脚本，覆盖：

- Windows 安装与固定版本探测。
- CLI/API 的结构化输出与错误语义。
- 创建仓库 workspace/worktree 并启动一个无害 Agent 任务。
- Core 与 Orca 分别重启后的重连结果。
- ConPTY、中文/空格路径、取消与进程树回收。
- 移动配对的数据路径与权限。
- 默认 Agent 参数、遥测、凭据处理、许可证和更新机制。

退出结果必须是下列之一：

1. **Sidecar 通过**：可以作为 Phase 1 Provider。
2. **Sidecar 有界缺口**：满足薄 Fork 决策门槛并给出维护预算。
3. **不通过**：切换 Agent Orchestrator 或最小 Direct Runtime，不阻塞 Hunter Core。

### 4.2 首批 Connector Spike

Codex 与 CodeBuddy 各自至少证明：

- 固定版本可探测。
- 可启动最小任务并接收可解析事件。
- 可取消或超时终止。
- 能分辨完成、失败、等待输入和权限请求，或明确降级。
- Session 恢复能力经过实际测试，而不是仅根据文档推断。

Cursor 至少证明：

- 打开指定仓库/worktree。
- 不依赖不稳定的屏幕自动化传递 Handoff。
- 能观察 Git/Artifact，并通过人工 Receipt 进入验证。

## 5. Flow Engine 确定性测试

状态机使用 Fake Clock、Fake Provider 和可记录的 ID Generator，至少覆盖：

1. 顺序步骤。
2. 并行 Fan-out/Fan-in。
3. 依赖失败后的 Skip/Block 策略。
4. Human Gate 审批、驳回、超时和重复命令。
5. Retry 与 Loop 的区别。
6. 最大轮次、最长时间和预算三种停止条件。
7. RequirementRevision 变更后的继续、终止与重新规划。
8. Session resume 失败后的 Handoff 新会话。
9. 验证器失败与验证器自身异常的不同状态。
10. Event 重放产生相同查询投影。
11. Outbox 重放不重复执行外部动作。
12. 应用重启时每个非终态 Attempt 的恢复分支。

可用属性测试生成合法 DAG，验证：无任务在依赖未成功时进入 ready；任何 Run 在有限预算下最终进入终态或 needs_attention；终态 Attempt 不会被再次启动。

## 6. 真实端到端黄金场景

Phase 1 发布前至少在 Windows 实机完成以下黄金场景：

### Golden-1 / E2E-001：单任务完整流程

```text
批准需求 → 创建 Change → Codex 计划 → CodeBuddy 实现
→ CommandStep 测试 → 独立 Review → 归档 → 知识入库
```

期望：全链路对象可追溯，Artifact/Evidence 完整，重开客户端后可浏览。

### Golden-2：并行 Task 与汇合

```text
Task A / Codex ─┐
                 ├→ 显式合并 → 集成测试 → Review
Task B / CodeBuddy ─┘
```

期望：两个写入 worktree 隔离；合并冲突不会被隐式吞掉；集成测试只在汇合成功后运行。

### Golden-3：失败 Loop

第一次实现造成测试失败，系统自动创建第二 Attempt 并注入失败证据；第二次通过后继续。期望：Attempt 1 永久可查，Loop 次数与预算准确。

### Golden-4：Cursor 人工接管

Hunter 打开正确 Cursor workspace，用户完成修改并提交 Step Receipt。期望：Cursor 只显示 L0/L1，随后仍由测试验证器决定结果。

### Golden-5：故障恢复

在 Agent 运行时强制重启 Hunter，在验证前强制重启 Orca。期望：无重复 Session、无虚假绿灯、可继续或显式待处理。

### Golden-6：移动审批

手机批准普通 Gate、拒绝高风险 Gate、断网后重复请求。期望：授权范围正确，命令幂等，离线状态明显。

## 7. 非功能验收

### 7.1 可靠性

- 所有状态转换有 Event 和 Actor。
- 发布测试中注入崩溃后，不产生重复外部副作用。
- 数据库或文件不一致时 fail closed。
- 连续运行 24 小时且包含多次 Agent/验证 Loop，不出现不可解释的 Run 状态。

### 7.2 性能

首版以个人开发机为目标：

- 典型项目列表和 Run 页面本地读取在 1 秒内可交互。
- 事件到 UI 的本机可见延迟目标小于 500ms；远程网络不计入硬保证。
- 10 个并发只读/等待步骤和 4 个活跃执行步骤下，UI 不因日志流阻塞。
- 单个大日志采用流式和分页，不载入浏览器全部内存。

这些是目标基线，Phase 0/1 以基准结果冻结最终阈值。

### 7.3 可迁移性

- 重要内容无需 Hunter 即可用普通编辑器读取。
- Project Export/Import 保留对象身份、版本、来源与哈希。
- Provider 替换测试无需修改 Flow/Requirement/Knowledge 模块。
- Windows 路径不出现在跨设备逻辑对象中。

### 7.4 可观测性

- 每个 Run 有 Correlation ID。
- 能导出不含 Secret 的诊断包。
- UI 能解释“为什么等待”“为什么失败”“谁批准”“使用了哪版输入”。
- Connector 原始事件和规范事件可关联，但默认 UI 不暴露无用协议噪音。

## 8. 发布阻断条件

存在任一情况时，Phase 1 不可声明完成：

- Agent 返回后未经验证直接亮绿灯。
- RequirementRevision 或 WorkflowRevision 被运行时覆盖。
- 并发 Agent 写同一工作区。
- Core 重启可能重复启动 Agent。
- Orca 成为唯一不可替换的数据或领域事实源。
- Cursor 被宣传为可控会话，但实际上只完成了窗口打开。
- Secret 出现在数据库、日志、导出或诊断包。
- 移动端能绕过桌面策略执行高风险操作。
- Archive 已创建但无法追溯到输入版本、Attempt 和 Evidence。
- 所有知识自动进入 Prompt，未处理 superseded/withdrawn 状态。

## 9. 测试职责

Agent 可以完成：

- 单元、状态机、存储、迁移和契约测试。
- Fake Provider 与本地端到端测试。
- Orca/Codex/CodeBuddy/Cursor 的安装探测和技术效果检查。
- 故障注入、日志检查、Artifact/Evidence 对账。

需要用户参与：

- 第一次账号登录、订阅授权和可能暴露数据的外部连接。
- 允许高风险权限或安装系统组件。
- 最终体验验收：信息是否清楚、接管路径是否符合真实开发习惯。

用户不需要手工承担全部测试；涉及个人账号与主观体验时才进入人工 Gate。

## 10. Definition of Done

一个 Change 只有同时满足下列条件才可以显示“完成”：

1. 绑定的 RequirementRevision 与 ChangeRevision 未发生偷换。
2. 必需 Task 按 DAG 完成，Join 条件满足。
3. 每个必需 Step 的最新有效 Attempt 通过输出契约验证。
4. 合并/集成状态明确，无未解决 Workspace 冲突。
5. Artifact 和 Evidence 可访问、哈希一致且来源完整。
6. 所有强制 Human Gate 已由有权限 Actor 批准。
7. Archive 已封存并自动进入 Knowledge 历史索引。
8. 未决高风险异常为零；非阻断警告已记录。
