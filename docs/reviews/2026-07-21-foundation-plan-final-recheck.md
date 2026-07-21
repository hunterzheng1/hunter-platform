# Platform Foundation 最终复审

## 范围

本次只读复核当前
[Platform Foundation 计划](../plans/2026-07-21-platform-foundation.md)，仅判断
[上一轮复审](2026-07-21-foundation-plan-recheck.md) 中 C-02、C-03、C-04
三个 `partially_closed` 项。按本轮要求只使用 `closed` / `open`：任一旧残口仍未进入明确测试与实现任务，即判 `open`。

## 结果

### C-02 可执行 Workflow/Flow 状态机 — `open`

新稿已实质补齐上一轮指出的调度场景：

- 普通 Step 单路由与 root TaskGraph fan-out/fan-in 被明确区分，ready Task 集合、单 Task 单 active child 和依赖失败的 block/skip、compensation、waiver、terminate 均进入实现语义（计划 `L702-L706`）。
- 父子预算、取消、失败汇总、resume→Handoff、RequirementRevision supersede 后的 continue/terminate/replan 决策均进入 transition 语义（`L708-L708`）。
- 对应 property/state-transition 场景被逐项列入 RED 后的测试任务（`L710-L726`），并由同一 GREEN 命令验收（`L728-L732`）。

但上一轮 C-02 还有一个独立 schema 残口尚未修改：规范性的 `WorkflowStep` 接口仍只有 `stepId/kind`、输入输出、capability、verifier、retry/timeout、budget、session/workspace（`L295-L307`），没有 executor/allowed-implementation selector、AgentStep 的 AgentProfile selector、Step 级 Permission/Policy requirement，也没有明确 `RetryPolicy` 必须包含 backoff。schema/graph 测试清单 `L337-L347` 仍没有这些字段缺失或未知字段的拒绝用例。全稿中的 `defaultAgentProfileId` 仍只属于 TaskDefinition（`L217-L232`），不能证明 WorkflowStep 的执行选择契约已经冻结并被 Runtime/Policy 消费。

因此新增的 fan-out/fan-in 和恢复场景不能关闭这个接口缺口；按二元规则，C-02 为 `open`。

### C-03 StartRun 与父子 Run 冻结绑定 — `closed`

新稿现在把旧残口写成可执行 TDD：

- Run-binding RED 清单补入空 Requirement 集、同 Task 第二个 active child、terminal parent 后创建 child，以及既有的孤儿/Task/Plan/Revision/context 负例（`L634-L673`）；公开 StartRun 仍由服务端加载 published/approved/frozen 依赖并只经 Flow 创建（`L675-L685`）。
- root TaskGraph fan-out/fan-in、失败依赖策略、父取消传播、child 失败汇总、父子预算事务 roll-up 与 root 终态约束都有明确实现语义（`L702-L708`）。
- 测试逐项覆盖重复调度、依赖等待/失败策略、取消/失败/预算耗尽、terminal parent、重复 child completion、Requirement supersede 与 resume Handoff（`L710-L726`），并有具体 GREEN 命令和预期结果（`L728-L732`）。

错误 Project/Change/Requirement 不再由公开命令作为 authority 传入；`StartRunService` 通过 ExecutionPlan 加载并派生 Project、published Change、approved Requirement 和 frozen policy/budget（`L675-L679`），因此旧的直接 append/调用方替换冻结绑定路径保持不可表达。C-03 判定 `closed`。

### C-04 本机 API、Runtime、移动配对安全边界 — `closed`

这里的关闭是明确的 scope closure，不是声称 Foundation 已实现移动身份：

- Task 11 的失败测试现在必须拒绝非 loopback listen、任何 remote/mobile pairing 或 device-token route，以及启用 remote listener 的尝试（`L913-L925`）；这些拒绝发生在 application service 调用前，并有 RED 命令（`L927-L931`）。
- 实现任务明确 Foundation 不暴露 pairing/token endpoint 或远程 listener，相关请求固定 denial/404；设备身份、桌面确认配对、短 access token、轮换 refresh、撤销与 device-key proof 被划给 Vertical 的独立 authenticated TLS listener（`L937-L943`）。
- GREEN 命令要求全部安全负例在 domain mutation 前被拒绝（`L949-L953`）。

Foundation 现在既不实现也不能意外暴露移动配对能力，并以测试守住交付边界；设备身份的正向实现由 Vertical 计划负责。因此对 Foundation 当前范围，C-04 判定 `closed`。

## Verdict

**Revise**

三项中 `closed=2`、`open=1`。C-03、C-04 已关闭；C-02 仍需把 executor/AgentProfile/Permission-Policy/backoff 写入 `WorkflowStep` strict schema、缺失字段 RED 用例及 Runtime/Policy 消费测试，之后才可判 `Ready`。

## 写入边界

仅创建本报告；未修改计划，未执行 Git。
