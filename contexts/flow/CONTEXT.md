# Flow Context Glossary

## Canonical terms

| Term | Canonical meaning |
|---|---|
| `WorkflowTemplate` | 可复用工作流的稳定身份。 |
| `WorkflowRevision` | 已发布工作流结构、步骤契约、路由与预算的不可变版本。 |
| `ProjectWorkflowBinding` | Project 对某个 WorkflowRevision 的固定引用及允许的参数覆盖。 |
| `ExecutionPlan` | 针对一个 ChangeRevision 生成的不可变执行规划。 |
| `TaskGraph` | ExecutionPlan 中 Task 及依赖关系构成的有向无环图。 |
| `Task` | 可调度的工作单元，声明目标、目标仓库、依赖和验收条件。 |
| `TaskDependency` | Task 之间显式的 `depends_on` 关系。 |
| `WorkflowStep` | WorkflowRevision 中用于处理 Task 的流程节点定义。 |
| `WorkflowRun` | 对固定 ChangeRevision、RequirementRevision 集合和 WorkflowRevision 的一次逻辑执行；顶层 Run 编排 ExecutionPlan/TaskGraph。 |
| `ChildRun` | 带 `parent_run_id`、由顶层 Run 为 Task 或由 SubflowStep 创建的独立 WorkflowRun；Task 子 Run 必须绑定 TaskId。 |
| `StepRun` | WorkflowRun 中某个 WorkflowStep 的逻辑执行实例。 |
| `StepAttempt` | StepRun 的一次实际尝试；重试或 Loop 必须创建新 Attempt。 |
| `InputContract` | Step 开始前必须具备的结构化输入与前置条件。 |
| `OutputContract` | Step 被判定成功前必须产生并验证的结构化输出。 |
| `Verifier` | 根据 OutputContract、Evidence、Artifact 或人工确认作出验证结论的组件。 |
| `HumanGateStep` | 需要指定 Actor 明确批准、拒绝或补充输入的步骤。 |
| `LoopPolicy` | 定义回边、最大轮数、停止条件、重复失败策略和预算的有界循环策略。 |
| `RunBudget` | 对轮数、时间、成本或其他资源的上限。 |
| `HandoffPack` | 传递给新 Agent 或新 Session 的冻结需求、目标、知识、产物、Diff、证据和剩余预算集合。 |
| `ExecutionStatus` | StepAttempt 的执行状态，如 `pending`、`running`、`waiting_input` 或 `returned`。 |
| `VerificationStatus` | 与执行状态独立的验证状态，如 `pending`、`verifying`、`passed` 或 `failed`。 |

## Avoid

| Avoid | Use instead |
|---|---|
| 把 Task 和 WorkflowStep 当作同一对象 | Task 是做什么；WorkflowStep 是如何处理它 |
| Agent 返回即把步骤标为成功 | 先进入验证，再由 `Verifier` 或人工确认 |
| 重试时覆盖旧日志和状态 | 创建新的 `StepAttempt` |
| 无限 Loop 或隐式自循环 | 显式 `LoopPolicy` 与 `RunBudget` |
| 执行中修改 Workflow 结构 | 创建并使用新的 `WorkflowRevision` |
| 用颜色作为唯一状态信息 | 同时展示执行状态、验证状态、文字与图标 |
| 让 LLM 自由猜测下一条路由 | 使用结构化输出、验证结果与确定性条件 |
