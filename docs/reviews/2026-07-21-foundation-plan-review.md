# Platform Foundation 计划审查

## 结论

**不建议按当前计划直接进入实现。** 本次仅将
`docs/plans/2026-07-21-platform-foundation.md` 对照以下规范审查：

- `docs/02-system-architecture.md`
- `docs/03-domain-model-and-state-machines.md`
- `docs/04-workflow-and-loop-semantics.md`
- `docs/07-storage-security-and-remote-access.md`

共发现 **4 条 Critical、2 条 Important**。以下位置均为当前文件的精确行号；修复建议只描述需要回填到计划的最小任务、契约和测试，不要求在本次审查中修改实现。

## Findings

### 1. Critical — `command_receipts` 不能替代 durable outbox 与外部副作用回执

**计划位置：** `2026-07-21-platform-foundation.md:657-662, 700-718, 1192, 1521-1538`
**规范依据：** `07-storage-security-and-remote-access.md:91-95, 101-106`；`03-domain-model-and-state-machines.md:302-303`

Task 4 的 schema 只有事件位置范围的 `command_receipts`，事务也只写 Event 与该回执；它没有 durable outbox。Task 9 则在进程内直接 `acquire`/`launch`，成功结果最后才写入内存 `assignments`。`ObservedSession.receipt` 虽在接口出现，却没有进入 Event、Evidence 或任何持久存储。

因此在“已提交 Hunter 状态、尚未调用 Provider”处崩溃会永久漏执行；在“Provider 已产生副作用、尚未执行 `assignments.set`”处崩溃会丢失回执并可能重发。计划末尾 `:1939` 关于“不产生重复 native session”的完成声明也没有跨进程证据。命令去重回执只证明命令曾追加哪些 Event，不能证明外部动作是否执行以及返回了什么。

**最小修复：** 在 Task 4 增加 `outbox` 与 `side_effect_receipts`（或等价表/端口），让 Domain Event、命令幂等记录、必要投影和 Outbox 项在一个 SQLite 事务提交；增加 worker 以持久化的稳定 `operationId` 执行动作，并在确认 Outbox 前把 Provider 回执写成 Event + Evidence。补三类测试：提交后调用前崩溃、外部成功后回执前崩溃、同一 Outbox 项重复投递；三者都必须最终收敛且不丢回执。

### 2. Critical — daemon 启动路径没有实现任何崩溃恢复编排

**计划位置：** `2026-07-21-platform-foundation.md:1541-1545, 1849-1853`
**规范依据：** `02-system-architecture.md:154-162`；`07-storage-security-and-remote-access.md:108-134`

`RuntimeManager.reconcile` 只接受调用方传入的一组 session 并执行一次 `inspect`；计划中没有组件从 SQLite 枚举活跃 Attempt，也没有调用该方法。生产入口只是打开数据库、构造服务并立即监听。它没有校验/恢复 migration 与 WAL、重放 Outbox、核对 Process/Connector、校验 Workspace/Lease/Git HEAD、验证/重建投影，或将不可证明存活的执行持久化为 `stale/needs_attention`。

这意味着重启后 daemon 会先对外服务旧投影，而内存 assignment 已全部丢失；`running / assigned / waiting_* / verifying` Attempt 不会被恢复或降级，违反“不可猜测成功”的恢复边界。

**最小修复：** 在 Task 11 增加 `StartupRecoveryCoordinator`，在 `listen` 前按规范 `07:112-121` 的顺序完成 schema/migration 检查、未完成 Outbox 重放、活跃 Attempt 枚举、Provider/Process/Workspace/Lease 对账和投影检查；恢复结论必须通过 Flow 命令写回事件。增加“持久化 running Attempt 后重建进程”的集成测试，覆盖 session 存活、缺失、无可靠回执和 Workspace 漂移，且任何分支都不能直接推断成功。

### 3. Important — Workflow 回边判定依赖数组顺序，而不是 WorkflowGraph

**计划位置：** `2026-07-21-platform-foundation.md:550-563`
**规范依据：** `03-domain-model-and-state-machines.md:110, 128`；`04-workflow-and-loop-semantics.md:162-171`

验证器用 `steps` 的声明下标判断“回边”。同一张图仅重排序列化顺序就可能从合法变为 `UNBOUNDED_BACK_EDGE`；例如步骤顺序 `[B, A]`、路由 `A -> B` 是 DAG，却会被拒绝。反过来，`LoopPolicy` 的端点不要求存在，也不要求对应真实 route；策略本身只校验两个正数，并未表达规范要求的有效进展、重复失败/无 Diff 停止、耗尽目标和复用策略。

**最小修复：** 校验 StepId 唯一、route 与 LoopPolicy 端点存在，且每个 LoopPolicy 必须匹配一条真实 route；移除已声明 loop edge 后，对剩余有向图做 DFS/拓扑环检测，而不是比较数组下标。把 `LoopPolicy` 补到规范 `04:164-171` 的最小字段，并增加“重排后的同图仍合法、悬空 policy、重复 StepId、未声明环、无进展/停止策略”的测试。

### 4. Critical — `WorkflowRun` 不能强制 root/task/subflow 结构与父子血缘

**计划位置：** `2026-07-21-platform-foundation.md:943-946, 979, 994, 1053-1055`
**规范依据：** `03-domain-model-and-state-machines.md:134-159`；`04-workflow-and-loop-semantics.md:50-55`

`RunStarted`/`RunState` 仅提供可选 `parentRunId?`、`taskId?`，缺少 `subject_kind` 和顶层 Run 必需的 `ExecutionPlanId`，也没有强制 root 的 `parent=null/task=null`、task child 的 parent+task、subflow child 的 parent+无 task。测试甚至未创建 `run_root` 就创建 child；`startRun` 不检查父 Run 是否存在、Task 是否属于父 Run 的 ExecutionPlan/TaskGraph，或子 Run 是否沿用父 Run 固定的 Project/Requirement/Change 上下文。

结果是孤儿 child、跨 Change 父子关系、root 携带 TaskId、task child 缺 TaskId 都可落账，而且顶层 Run 无法拥有规范要求的 TaskGraph 调度历史。

**最小修复：** 将 `RunStarted` 与 `RunState` 改为 `subjectKind` 判别联合：`change` 必须有 `executionPlanId` 且禁止 parent/task；`task` 必须有 parent+task；`subflow` 必须有 parent 且禁止 task。所有变体固定保存 Project、Requirement/Change/Workflow Revision、初始预算与 PolicySnapshot。创建 child 前加载父 Run，校验相同冻结上下文；task child 还要校验 Task 属于父 ExecutionPlan/TaskGraph。测试必须先创建父 Run，并覆盖所有非法组合、孤儿和跨 revision child。

### 5. Critical — loopback 监听被当成了本地 API/SSE 的安全边界

**计划位置：** `2026-07-21-platform-foundation.md:1681-1703, 1723-1734, 1853`
**规范依据：** `02-system-architecture.md:173-177`；`07-storage-security-and-remote-access.md:203-217, 247-254`

所有 REST 路由与 `/api/v1/events` 都没有认证、授权、Origin 或 CSRF 检查；SSE 会把 hub 中的全部事件原样发给任意连接者。生产入口虽绑定 `127.0.0.1`，但 loopback 只限制网络接口，不提供调用者身份：任意本机进程，以及可访问 localhost 的恶意浏览器页面，都可能读取运行事件或提交状态变更。计划也没有速率、Payload、连接上限和 SSE 逐资源授权测试。

**最小修复：** 在 Task 10 的路由注册前增加统一的本地认证/授权端口（每安装凭据或 OS 认证通道，持久层只保存 `SecretRef`），浏览器请求采用严格 Origin allowlist 和写请求 CSRF 防护；SSE 在握手时认证，并按 Project/Run capability 在服务端过滤。为无凭据、错误 Origin、缺 CSRF、无权项目 SSE、过量 Payload/连接增加拒绝测试；保留 `127.0.0.1` 作为额外防线而非认证替代品。

### 6. Important — “可续传 SSE”既未连接 Event Ledger，也不能跨重启续传

**计划位置：** `2026-07-21-platform-foundation.md:1657-1670, 1723, 1728-1732, 1819-1835`
**规范依据：** `07-storage-security-and-remote-access.md:85-97, 239-245`

`SseHub` 的 sequence 从进程内 `0` 开始，历史仅保存在有界数组；重启会重置 sequence 并丢失缓存。更直接的是，生产 `buildApp` 创建了一个新 hub，但 SQLite application services 从未向它发布 Event，因此真实 Project/Run 命令不会出现在 SSE。客户端携带旧 `after` cursor 时可能静默漏事件或把重启后的相同数字误认为旧序列，和“从最近确认的 Event Cursor 续传”不兼容。

**最小修复：** 让 SSE 的 `id` 直接使用 durable Event Ledger 的全局 `position`；连接时先从 SQLite 查询 `position > cursor`，再无缝切换到 live tail。支持 `Last-Event-ID`（可同时兼容 query cursor），对过旧/非法 cursor 返回明确的 resync 信号，不能静默给空结果。增加跨两个 app 实例的重启续传测试、命令后 SSE 可见测试，以及超过保留窗口后的 resync 测试。

## 审查边界

本报告只审查计划与上述四份规范的一致性；未修改计划、产品文档或 Git 状态，也未执行实现与测试。
