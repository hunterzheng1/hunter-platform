# Platform Foundation C-02 最终复审（二）

## 范围

本次只读复核当前
[Platform Foundation 计划](../plans/2026-07-21-platform-foundation.md)，仅判断
[上一轮最终复审](2026-07-21-foundation-plan-final-recheck.md) 中唯一仍为 `open`
的 C-02“可执行 Workflow/Flow 状态机”。本报告判断的是计划是否已具备可执行 TDD 闭环，不代表实现测试已经运行。

## C-02 — `closed`

### 1. WorkflowStep 执行与策略契约已进入规范 schema

`WorkflowStep` 现在明确保存 `executor`、可选且受 Step kind 约束的
`agentProfileSelector`、`requiredCapabilities`、Step 级 `permissionPolicy`，以及
retry/timeout/budget/session/workspace policy（计划 `L287-L310`）。这关闭了上一轮指出的
“只有 TaskDefinition 默认 Profile、WorkflowStep 自身无法固定执行选择与权限要求”缺口。

### 2. 缺失、未知和不兼容字段已有明确 RED 用例

schema/graph 测试必须拒绝缺失或未知的 executor、permissionPolicy、retry backoff
等 strict-schema 字段；AgentStep 必须有 AgentProfile selector，非 Agent Step 不得偷带
不兼容 Profile（`L340-L352`）。同一测试还冻结最大 Attempt、retryable error classes、
fixed/exponential backoff、delay bounds、jitter 和等待期间预算扣费，并禁止调用方提供临时
retry delay（`L351-L352`）。RED 命令与预期位于 `L354-L358`。

### 3. 实现步骤验证兼容性和完整 retry 边界

validator 的规范步骤现在要求校验 executor/AgentProfile selector 兼容性、Step 级
Permission/Policy、retry/backoff/timeout/budget 边界及既有 Graph/Loop 不变量
（`L360-L372`）。对应 example/property GREEN 命令与预期位于 `L378-L382`。

### 4. Runtime/Policy 必须消费 published Step，不能只序列化字段

Task 8 的 contract 测试加载 published WorkflowStep，证明 Runtime/Policy 从冻结定义派生
executor、AgentProfile、atomic capabilities、permission、retry/backoff、timeout、
WorkspacePolicy 和 budget；请求覆盖任一值必须在创建 Outbox 前被拒绝（`L746-L777`）。
实现步骤明确先解析 published Step，再做 executor/Profile 选择、路径校验和 Policy 决策，
并禁止请求覆盖 executor、profile、policy、retry timing、timeout 或预算（`L785-L791`）。
该跨层契约有独立 RED/GREEN 命令和预期（`L779-L783`, `L793-L797`）。

上述内容与已在前一轮关闭的 fan-out/fan-in、父子预算/终态、Requirement supersede、
resume→Handoff 和 property/state-transition 场景共同形成完整可执行计划。因此 C-02
判定为 `closed`。

## Verdict

**Ready**

此前所有 Foundation plan review 项均已关闭；当前计划可以进入实现阶段。此结论仅表示
计划具备明确 Files、RED、实现步骤与 GREEN 验证，实际完成仍以实施后的测试证据为准。

## 写入边界

仅创建本报告；未修改计划，未执行 Git。
