# Platform Foundation 修订计划复审

## 范围与判定规则

本次只读复审修订后的
[Platform Foundation 计划](../plans/2026-07-21-platform-foundation.md)，逐项回看
[Foundation 计划审查](2026-07-21-foundation-plan-review.md) 的 6 项 finding，
以及 [内部设计一致性审查](2026-07-21-internal-design-review.md) 的
C-01/C-02/C-03/C-04、I-01/I-03/I-04。

状态含义：

- `closed`：新稿包含明确 Files、先失败的测试、实现步骤、GREEN 验证命令与预期结果，不仅是术语或完成清单。
- `partially_closed`：核心方向已修，但原 finding 的一部分仍没有可执行 TDD 任务。
- `open`：没有实质修复，或只有目标/术语/checklist。

## 汇总结论

| 来源 | 项目 | 状态 |
|---|---|---|
| Foundation review | F-01 durable Outbox / side-effect receipt | `closed` |
| Foundation review | F-02 daemon 启动恢复 | `closed` |
| Foundation review | F-03 WorkflowGraph / 回边 | `closed` |
| Foundation review | F-04 root/child WorkflowRun | `closed` |
| Foundation review | F-05 localhost REST/SSE 安全 | `closed` |
| Foundation review | F-06 durable SSE cursor | `closed` |
| Internal review | C-01 外部副作用 journal | `closed` |
| Internal review | C-02 可执行 Workflow/Flow 状态机 | `partially_closed` |
| Internal review | C-03 StartRun 与父子 Run 冻结绑定 | `partially_closed` |
| Internal review | C-04 本机 API、Runtime、移动配对安全 | `partially_closed` |
| Internal review | I-01 canonical Change/Task/ExecutionPlan | `closed` |
| Internal review | I-03 Workspace/Writer/Controller Lease | `closed` |
| Internal review | I-04 durable SSE replay | `closed` |

合计：`closed=10`、`partially_closed=3`、`open=0`。

## Foundation review 六项复查

### F-01 — `closed`

新稿 Task 4 明确列出 migration、journal、worker、fault injector 与两组测试文件（计划 `L384-L396`）；原子 Event/receipt/Outbox、fingerprint 冲突和 Event/operation 元数据均有失败断言（`L398-L407`），schema 包含 `outbox` 与 `side_effect_receipts`（`L415-L479`），四个崩溃点使用文件数据库和新 worker 实例复测（`L499-L518`），并有 RED/GREEN 命令和结果（`L409-L413`, `L520-L524`）。Task 9 又以销毁/重建 manager 的测试证明没有内存 authority（`L787-L824`）。这不是术语修复。

### F-02 — `closed`

Task 10 有专用 coordinator、restart test 和 verifier 文件（`L831-L837`），先写 listen-order 与七类文件数据库重启场景（`L838-L852`），再实现八步恢复序列并要求所有结论经 Flow 命令持久化（`L860-L871`），最后验证二次运行幂等（`L873-L879`）。生产 composition 也明确 `await recovery.run()` 后才启动 worker/listen（`L1030-L1038`）。

### F-03 — `closed`

Task 3 有 example/property 两组测试（`L279-L285`），覆盖重复/悬空 ID、policy-route 一一对应、未声明环、排列不变性和完整 Loop 停止字段（`L337-L347`）。实现步骤明确“移除 Loop route 后 DFS/Kahn”，并禁止数组下标回边启发式（`L355-L367`）；RED/GREEN 命令和预期齐全（`L349-L353`, `L373-L377`）。

### F-04 — `closed`

Task 7 把 binding 定义为 `change|task|subflow` 判别联合并冻结 Project/Change/Requirement/Workflow/Policy/Budget（`L634-L671`）；失败测试覆盖非法 root/child 组合、孤儿、错误 Task、上下文和 revision 漂移（`L673-L673`）。公开 StartRun 只接收稳定引用，由服务端加载并派生 binding；child 只能走内部 Flow 命令，且测试禁止 raw `RunStarted` append（`L675-L685`）。Task 13 的全链路测试再创建 root 与经验证的 task child（`L1005-L1018`）。这足以关闭原 F-04 的“形状与血缘”范围。

### F-05 — `closed`

Task 11 列出 shared Zod、local authenticator、security hooks、routes 和 security test 文件（`L888-L901`）；失败测试明确覆盖身份、scope、Host/Origin/CSRF、非法 authority 字段、payload/rate/concurrency/SSE 上限和 headers（`L903-L914`）。实现规定 OS credential-store SecretRef、短时本机 capability、随机 loopback port，以及服务端派生 scope/path/policy/budget（`L922-L936`），并有完整 GREEN 命令（`L938-L942`）。Task 12 另在 SSE 握手与持续授权变化上执行服务端认证/过滤测试（`L956-L967`）。

### F-06 — `closed`

Task 12 使用文件数据库和两个独立 app 实例，测试命令可见、`Last-Event-ID`、非法/过期 cursor、Project 隔离、撤权、连接上限和 replay/live race（`L949-L967`）。实现只从 `EventLedgerReader` 按 `events.position` 分页并在注册 wake 后重查消除竞态（`L975-L977`），过期 cursor 在发送 SSE headers 前返回显式 resync 响应（`L979-L981`），GREEN 命令覆盖 durable stream 与 API security（`L983-L987`）。

## Internal review 七项复查

### C-01 — `closed`

证据同 F-01。额外地，新稿把 duplicate lookup/version check 明确放进 `BEGIN IMMEDIATE`，并保存 server-computed request fingerprint（`L481-L497`）；不可证明的 Provider 结果进入 `indeterminate/needs_attention` 而不盲重放（`L508-L518`）。原 C-01 的五个最小修复点均有文件、失败用例、实现和 GREEN 命令。

### C-02 — `partially_closed`

已关闭部分：Task 3 补齐 Graph、Route、Loop 结构与严格验证（`L279-L377`）；Task 7 补齐双状态/Run transition、持久预算、确定性路由、Loop activation 和 property tests（`L687-L722`）。因此旧稿“不推进 currentStep、LoopGuard 孤立、调用者传 maxAttempts/nextAttemptId”的核心缺陷已成为可执行 TDD 工作。

未关闭部分：Task 3 声称冻结“fully executable” Step，但其规范接口 `WorkflowStep`（`L295-L307`）仍没有原 C-02 所要求的 executor/allowed implementation selector、AgentStep 的 AgentProfile selector、Step 级 Permission/Policy requirement；也未明确 `RetryPolicy` 必须含 backoff。全稿只在 TaskDefinition 保存 `defaultAgentProfileId`（`L217-L232`），不能替代 WorkflowStep 自身的执行选择契约。测试清单 `L337-L347` 也没有“缺少这些字段必须被 runtime schema 拒绝”的 RED 用例。此外，router 要求每次“Exactly one route”命中（`L702-L704`），但没有说明顶层 Task fan-out/fan-in 如何进入同一确定性 Flow；property 清单 `L708-L716` 也没有逐项覆盖原 C-02 所依据场景中的依赖失败 Skip/Block、RequirementRevision 变化后的继续/终止/重规划、resume 失败后的 Handoff。这里仍是契约和场景覆盖缺口，不应因 `L1090` 的完成证据声明而视为关闭。

最小补项：在 Task 3 的 `WorkflowStep` 与 strict schema 中加入 executor selector/allowed implementations、AgentProfile selector、Permission/Policy requirement 和显式 retry backoff；在 `workflow.test.ts` 为每个缺失/未知字段写 RED，用 Task 7 fixture 证明这些字段实际驱动 assignment/policy，而非只被序列化。再为 fan-out/fan-in 和上述缺失场景增加明确 transition/route tests，避免以笼统 property 结果代替验收表。

### C-03 — `partially_closed`

已关闭部分：判别 binding、服务端派生 StartRun、禁止 adapter raw append、父子上下文一致性和全链路 composition 均已有 TDD（`L634-L685`, `L1005-L1028`）。

未关闭部分：`L673` 的 child 负例没有原 C-03 要求的“同一 Task 重复创建 child”和“父 Run 已终态仍创建 child”；StartRun 测试描述 `L675-L679` 没有点名空 Requirement 集、未发布 Change、错误 Project 的拒绝用例。更重要的是，transition/router 工作 `L687-L704` 只列通用 Run/Step 状态，没有定义或测试父取消如何传递、child 失败如何汇总、父子预算如何分配、所有 child 终态如何决定 root 终态。`L1088` 只是 completion evidence，不是 RED/GREEN 任务。

最小补项：在 Task 7 的 `start-run.test.ts`/`flow-engine.test.ts` 增加上述五类启动负例，并增加父取消、child 失败、预算分配/耗尽、fan-out/fan-in 终态汇总的明确 transition table 与 property/example tests。

### C-04 — `partially_closed`

已关闭部分：本机 REST/SSE 的认证授权由 Task 11/12 以安全负例驱动（`L888-L987`）；Runtime path、权限、预算和 lease authority 在 Task 8/9 由服务端状态派生，并有路径逃逸、并发 Lease、重启与无内存 authority 测试（`L746-L780`, `L798-L824`）。

未关闭部分：原 C-04 还包含移动设备配对、桌面确认、device-bound access/refresh token、`sub/device_id/aud/iat/exp/jti`、撤销和 key generation。新稿只用一句“later remote/mobile access uses a separate authenticated TLS listener”（`L928`）延期；没有对应 Files、RED test、实现步骤或 GREEN 命令。若 Foundation 明确不承载远程 listener，这可以是合理范围切分，但不能据此宣称复合 C-04 已关闭。

最小补项：要么在本计划增加移动身份/配对契约的 TDD Task；要么把 C-04 正式拆为“Foundation local/runtime（closed）”与“vertical mobile pairing（deferred）”，并从本计划链接下游计划中包含精确文件、桌面确认、token claim/expiry/revocation/key-rotation 负例和验证命令的命名 Task。仅保留 `L928` 不足。

### I-01 — `closed`

Task 2 给出完整 ChangeRevision、TaskDefinition、ExecutionPlan 字段与序列化/不可变/图性质测试（`L181-L272`）。Task 6 再用 application command 对未批准/跨 Project Requirement、Repository scope、Change dependency、Workflow/Profile 和 fingerprint 做失败测试，并在单一 journal command 中原子发布 Change+Plan（`L573-L607`）。

### I-03 — `closed`

Task 8 明确 Workspace/Writer/Controller 三种 Lease 的 scope、owner、generation、expiry 和事务 acquire/renew/release/recovery，并覆盖并发 writer/controller、stale generation、错误 worktree、realpath、HEAD drift 与 restart（`L729-L780`）。Task 9 要求 launch 前存在当前 durable Lease receipts，且 manager 重建后仍从 SQLite 完成 operation（`L787-L824`）；Task 10 把 Lease/Git 对账纳入启动恢复（`L842-L879`）。

### I-04 — `closed`

证据同 F-06。尤其 `L958-L967` 是跨 app restart、retention gap、scope authorization 和 race window 的失败测试，而 `L975-L981` 明确 Event Ledger 查询与 resync 实现；不是以 volatile hub 改名冒充 durable stream。

## Verdict

**Revise**

修订稿已实质关闭全部 6 个 Foundation findings，并把 Outbox、恢复、Graph、Lease、local API 和 SSE 都改成了可执行 TDD 工作；但 internal C-02、C-03、C-04 仍各有一段只被省略、概括或延期。应先补齐上述三个最小补项，再复审为 `Ready`。

## 自检

- UTF-8：报告与修订计划均可按严格 UTF-8 解码。
- 链接：本报告的 3 个相对 Markdown 链接目标均存在。
- 围栏：本报告代码围栏数量为 0；修订计划代码围栏成对。
- 写入边界：只创建本复审文件；未修改计划，未执行 Git。
