# Hunter Platform 内部设计一致性审查

- 审查日期：2026-07-21（Asia/Shanghai）
- 审查方式：只读，按架构、安全、规范、兼容、测试、性能/可靠性六个维度交叉检查。
- 快照范围：报告写入前 `.tmp/hunter-platform-seed` 下全部 50 个 Markdown 文件；未修改产品文档，未执行 Git 操作。
- 机械检查：全部文件可按严格 UTF-8 解码；未发现替换字符/常见乱码；Markdown 相对链接缺失数为 0；代码围栏均成对。

## Verdict

**NO — 当前设计稿不能直接进入实现。**

领域方向与顶层边界已经基本统一，但实施计划仍存在 4 个 Critical 和 8 个 Important 缺口。前三个 Critical 会直接破坏“不可重复副作用、确定性 Flow、冻结运行依据”三项核心承诺；安全 Critical 会让本机代码执行边界在认证和路径校验完成前暴露。应先把下列最小修复补进设计、计划和验收，再开始产品编码。

## Critical findings

### C-01 外部副作用没有持久 Outbox/operation journal，崩溃后仍可能重复创建 worktree 或 Agent Session

证据：

- `docs/07-storage-security-and-remote-access.md:89-95` 要求 Event、幂等记录和 Outbox 同事务落盘；`docs/07-storage-security-and-remote-access.md:112-123` 要求重放 Outbox，并对不可安全重放的动作进入人工恢复。
- `docs/plans/2026-07-21-platform-foundation.md:646-675` 的首个 migration 只有 events、command receipts、views 和 checkpoints，没有 Outbox 或外部 operation 状态。
- `docs/plans/2026-07-21-platform-foundation.md:1521-1537` 只用进程内 `Map` 去重，并依次调用 `workspaceProvider.acquire()`、`agentConnector.launch()`，最后才把结果写进该 `Map`。
- `docs/plans/2026-07-21-first-vertical-slice.md:947-956` 的 Orca lease 也只在内存中；外部 `createWorktree` 成功、进程在本地记账前崩溃时，重启会再次创建。
- `docs/plans/2026-07-21-platform-foundation.md:1937-1941` 却把“不重复 native session”列为完成证据，计划与实现步骤不相符。

失败场景：Provider 已接受 launch，`hunterd` 在收到/保存 `NativeSessionRef` 前崩溃；重启后内存映射为空，同一 operation 再次 launch。上游若不提供原生幂等或按 key 查询，Hunter 无法证明只有一个 Session。

最小修复：

1. 在 foundation migration 中加入持久 operation journal/Outbox，保存 `operation_id`、幂等键、动作、目标、请求 fingerprint、状态（pending/dispatched/acknowledged/indeterminate/reconciled）、上游引用和重试信息。
2. Attempt 分配事件与 Outbox intent 同事务提交；Worker 只消费已提交 intent。收到回执后再以事务写 Event/Evidence 和 operation receipt。
3. 对不支持上游幂等/查询的 Provider，崩溃窗口必须进入 `indeterminate/needs_attention`，禁止盲目重放。
4. 把 `command_receipts` 增加请求 fingerprint；将 receipt/version 检查移入 `BEGIN IMMEDIATE` 后。当前 `docs/plans/2026-07-21-platform-foundation.md:700-716` 在加锁前读取，且相同 command ID 携带不同 payload 时会静默返回旧 receipt。
5. 增加故障注入：intent 后、上游接受后、receipt 前后分别崩溃；结果只能是一个外部执行或明确 `needs_attention`。

### C-02 FlowEngine 无法执行计划中发布的工作流回边和完整状态机

证据：

- `docs/04-workflow-and-loop-semantics.md:22-35` 要求每个 Step 具备输入/输出契约、执行器、能力、策略、Verifier、timeout/retry/backoff、预算和所有确定性路由。
- `docs/03-domain-model-and-state-machines.md:172-221` 定义独立的 Execution/Verification 状态及 StepRun 结论；`docs/04-workflow-and-loop-semantics.md:160-179` 要求进展、成本、重复失败等 Loop 停止语义。
- `docs/plans/2026-07-21-platform-foundation.md:526-545` 的 WorkflowStep 只有 `stepId/kind/next`，Loop 只有次数和时间。纵向计划在 `docs/plans/2026-07-21-first-vertical-slice.md:87-116` 写入 `outputContract/sessionPolicy`，但 `docs/plans/2026-07-21-first-vertical-slice.md:127-133` 仅用 TypeScript cast 后交给不会校验这些字段的 validator。
- `docs/plans/2026-07-21-platform-foundation.md:978-1079` 的 reducer 只有七类事件、三种 Step 结论，不推进 `currentStepId`，也没有 Gate、取消、等待、超时、stale、needs_attention、Run 结论或路由执行。
- 默认 Task workflow 在测试/评审失败后回到 Implement（`docs/plans/2026-07-21-first-vertical-slice.md:108-116`），但当前 StepRun 成功后没有重新激活/新 activation 语义；foundation 的 retry 只给“当前失败 Step”追加 Attempt。
- `LoopGuard` 在 `docs/plans/2026-07-21-first-vertical-slice.md:1454-1469` 是孤立工具，没有接入 reducer、路由或持久 RunBudget。

最小修复：

1. 先冻结可执行 WorkflowRevision schema 和完整 command/event transition table，再写 reducer；运行时必须校验未知/缺失字段，不能靠 cast。
2. 明确定义回边重入：要么每次路由激活产生新的 StepRun activation，要么规范 StepRun 如何从终态进入新 Attempt；二者必须保留旧 Attempt 且可重放一致。
3. 将 routing、HumanGate、timeout/cancel、Verifier 异常、Run/Step 双状态、LoopGuard 和冻结 RunBudget 纳入同一 FlowEngine，不由调用者传 `maxAttempts/nextAttemptId` 决定。
4. 增加状态模型/属性测试，至少覆盖 `docs/08-user-stories-and-acceptance.md:197-214` 的全部 12 类确定性场景。

### C-03 StartRun 绕过 FlowEngine，并丢失顶层/子 Run 的冻结绑定

证据：

- canonical model 要求顶层 Run 固定 Project、ChangeRevision、RequirementRevision 集合、ExecutionPlan、WorkflowRevision、Budget 和 Policy；子 Run 还必须满足 subject/parent/task 约束（`docs/03-domain-model-and-state-machines.md:141-159`）。
- foundation `RunState` 只有 run/parent/task/change/requirements/workflow/currentStep（`docs/plans/2026-07-21-platform-foundation.md:978-1008`），没有 ProjectId、ExecutionPlanId、subject kind、RunBudget、PolicySnapshot，也不验证 parent/task 组合。
- HTTP StartRun 只接收 `runId/changeRevisionId/workflowRevisionId`（`docs/plans/2026-07-21-platform-foundation.md:1700-1702`）。SQLite application service 在 `docs/plans/2026-07-21-platform-foundation.md:1829-1832` 直接 append `RunStarted`，把 `requirementRevisionIds` 写成空数组并硬编码 `entryStepId=plan`，没有调用 FlowEngine。
- Child scheduler 仅拼出 `parentRunId/taskId` 并调用抽象 start（`docs/plans/2026-07-21-first-vertical-slice.md:1440-1485`），没有证明 parent Run、ExecutionPlan、Task 或冻结 revision 存在。

最小修复：

1. StartRun application command 只接受稳定的计划引用和 expected version；服务端加载并验证 published ChangeRevision、approved RequirementRevision、ExecutionPlan、WorkflowRevision、Project、Policy 和 Budget，派生不可变绑定。
2. 所有 Run 创建与状态变化只能通过 FlowEngine command；删除直接 append `RunStarted` 的适配器路径。
3. 对 `subject_kind=change|task|subflow` 建立结构约束和存储约束；启动子 Run 时校验 parent、Task 属于同一 ExecutionPlan，并定义父子取消、失败、预算和终态汇总。
4. 添加负例：空 requirement 集、未发布 Change、错误 Project、孤儿 child、重复 Task child、父 Run 已终态。

### C-04 本机 API、Runtime 分配和移动配对没有形成可执行的认证/授权边界

证据：

- `docs/07-storage-security-and-remote-access.md:145-170` 明确所有浏览器/移动参数均不可信；`docs/07-storage-security-and-remote-access.md:203-217,247-255` 要求受认证本机通道、桌面确认、设备身份/有效期/撤销、Origin/CSRF/CSP、限流和服务端授权。
- `buildApp` 在 `docs/plans/2026-07-21-platform-foundation.md:1683-1734` 直接注册写 API 和 SSE，没有认证、授权、Origin/CSRF、请求 schema/大小限制或项目过滤。
- PolicyEngine 仅检查调用方提供的 `tool/consumedAttempts/maxAttempts`（`docs/plans/2026-07-21-platform-foundation.md:1385-1407`）；RuntimeManager 接受调用方提供的任意 `repositoryPath/prompt/tool/budget` 并取得可写 workspace 后 launch（`docs/plans/2026-07-21-platform-foundation.md:1493-1537`）。
- 任意调用者可请求配对码（`docs/plans/2026-07-21-first-vertical-slice.md:1702-1711`）。设备 token 在 `docs/plans/2026-07-21-first-vertical-slice.md:1674-1695` 只有名称与 scope，没有 device ID、issuer/audience、签发/过期时间、jti、撤销或 key rotation；`desktopDeviceId` 实际被忽略。

最小修复：

1. 在任何写 API/事件流前实现认证中间件：本机桌面使用进程持有的短时随机凭据或 IPC；浏览器/PWA 使用设备身份、短时 access token 和可撤销 refresh 机制。
2. 配对码只能由已认证桌面会话创建，并要求桌面确认设备、权限和有效期；token 带 `sub/device_id/aud/iat/exp/jti`，服务端检查撤销和 key generation。
3. 使用运行时 schema 校验、payload 限额、严格 Host/Origin/CSRF/CSP；SSE 按设备授权过滤 Project/Run。
4. RuntimeManager 只接收领域 ID；仓库路径、工具权限、预算和 workspace policy 均由服务端从 DeviceBinding、StepDefinition、AgentProfile 和 PolicySnapshot 派生。解析路径后检查 canonical path、junction/symlink 和项目根范围。
5. 增加 localhost 跨源、未认证写入、越权项目、过期/撤销 token、路径逃逸和重放安全测试。

## Important findings

### I-01 实施数据模型删掉了 canonical Change/Task 语义，无法保证追溯和调度

证据：canonical ChangeRevision 包含目标/非目标、Project/Repository 范围、约束/风险和 Change 依赖（`docs/03-domain-model-and-state-machines.md:79-94`）；Task 至少包含目标/验收、Repository/模块、依赖、读写、Workflow 和 Agent/Session/Workspace 默认策略（`docs/03-domain-model-and-state-machines.md:114-128`）。foundation 的 Change/Task/ExecutionPlan 仅保留少数字段（`docs/plans/2026-07-21-platform-foundation.md:369-411`）。Change route 直接 cast 请求并发布（`docs/plans/2026-07-21-first-vertical-slice.md:487-503`），没有校验 RequirementRevision 已批准、属于 Project 或引用存在。

最小修复：扩充领域对象和 ExecutionPlan fingerprint；用 application command 加载并校验跨域引用，在同一事务发布 ChangeRevision 与不可变 ExecutionPlan；增加跨 Project、未批准 Revision、重复 Task ID、未知依赖和缺失 Repository 的负例。

### I-02 Connector 能力等级被提前写死为 L3，且 CodeBuddy 传输形态未经 Phase 0 证明

证据：L3 要求权限事件、可靠恢复、完成回执和策略钩子（`docs/06-runtime-provider-and-connectors.md:40-49`），Manifest 每项还应保存来源、版本约束和探测时间（`docs/06-runtime-provider-and-connectors.md:51-73`）。foundation contract 与两条浅测试不覆盖这些能力（`docs/plans/2026-07-21-platform-foundation.md:1153-1219`），Fake 只实现 launch/observe/interrupt 却声明 L3（`docs/plans/2026-07-21-platform-foundation.md:1245-1274`）。Codex 声明 `approve/observe` 但没有对应治理/订阅实现（`docs/plans/2026-07-21-first-vertical-slice.md:1066-1083`）；CodeBuddy 硬编码未由证据选择的 `http://127.0.0.1:4096/api/v1/acp`，并同样声明 L3（`docs/plans/2026-07-21-first-vertical-slice.md:1169-1206`）。

最小修复：由原子 capability 的实测 receipt 计算等级；Phase 0 冻结具体传输和版本后再实现独立 ACP/Headless/HTTP adapter；不具备 permission、completion、attach/recovery 的实现降级到实际等级。共享 contract suite 必须逐能力验证，而不是只测 launch/missing。

### I-03 WriterLease/ControllerLease 与独立 worktree 不变量没有落到公共契约

证据：canonical 要求 WorkspaceLease 和 ControllerLease 且并行写入独立 worktree（`docs/03-domain-model-and-state-machines.md:245-250`、`docs/04-workflow-and-loop-semantics.md:181-203`）。foundation `WorkspaceLease` 只有 ref/path/id/mode/expiry，没有 Project/Repository/Device/HEAD/branch/owner/generation，也没有 ControllerLease（`docs/plans/2026-07-21-platform-foundation.md:1188-1208`）。RunCoordinator 虽传 `workspacePolicy=new_worktree`，但下游 start/RuntimeManager 并不消费该策略（`docs/plans/2026-07-21-first-vertical-slice.md:1472-1485`；`docs/plans/2026-07-21-platform-foundation.md:1493-1537`）。

最小修复：把 WorkspacePolicy、WriterLease、ControllerLease、owner/generation 和固定 Git 基线加入 Runtime contract；在事务中取得/续租/释放，Provider 只能在 lease receipt 后 launch。用两个并行 writer、lease 过期、错误 worktree、恢复时 HEAD 漂移做集成测试。

### I-04 “可重放 SSE”实际上是易失内存缓冲，重启或容量溢出会静默丢事件

证据：`docs/07-storage-security-and-remote-access.md:239-254` 要求 Event Cursor 续传和授权过滤。foundation `SseHub` 的 sequence/events 只存在内存并按容量丢头部（`docs/plans/2026-07-21-platform-foundation.md:1657-1669`），endpoint 直接从该数组发送（`docs/plans/2026-07-21-platform-foundation.md:1728-1734`）；客户端只把该易失 sequence 放进 sessionStorage（`docs/plans/2026-07-21-first-vertical-slice.md:632-641`）。计划也没有把已提交 domain event 发布到 hub 的 wiring。

最小修复：以 Event Ledger 全局 position 作为 cursor，只发送已提交事件；按设备/Project 过滤；当 cursor 早于保留窗口时返回显式 gap 并要求 snapshot/rebuild。测试 daemon 重启、容量压缩、断线重连和未授权 Run。

### I-05 Archive→Knowledge 只有孤立单测，既不耐崩溃也会丢失 Project scope

证据：ArchiveWriter 与 ingest 只在同一单测中手工串联（`docs/plans/2026-07-21-first-vertical-slice.md:727-736`），没有终态 Run application wiring。Archive manifest 缺少 Project、Change、Workflow、Task/Step/Attempt 等完整绑定（`docs/plans/2026-07-21-first-vertical-slice.md:765-777`）；Knowledge 文件直接覆盖写，archive ingest 写入 `scope: {}`（`docs/plans/2026-07-21-first-vertical-slice.md:790-803`），会破坏项目隔离并在 archive 成功、ingest 崩溃时漏索引。

最小修复：定义带完整 provenance/hash 的 versioned manifest；终态 Run 通过持久 archival job/outbox 幂等执行；Knowledge 索引可从 Archive 全量重建且 Project scope 必填。测试 archive/ingest 间崩溃、重复 ingest、hash 篡改、失败/取消 Run 和跨 Project 查询。

### I-06 Phase 0 的 BLOCKED/fallback 与顺序门会造成无法退出的路线

证据：计划要求依序执行 Phase 0→foundation→slice（`docs/plans/README.md:3-9`）。Phase 0 把缺少 executable/login 定义为 `BLOCKED`（`docs/plans/2026-07-21-phase-0-runtime-validation.md:13-23`），但 AO fallback 只在 Orca criterion 为 `FAIL` 时触发（`docs/plans/2026-07-21-phase-0-runtime-validation.md:551-579`）；因此没有安装/凭据既不能通过 Gate，也不会走 fallback。与此同时，当前研究稿把完整多项目 UI、移动、Loop、Archive/Knowledge 列成 Phase 0 必须通过（`docs/research/2026-07-21-hunter-platform-landscape-and-reuse.md:540-553`），与 roadmap 的 1–2 周、非正式 UI 技术 spike（`docs/09-migration-and-roadmap.md:143-175`）冲突。

最小修复：时间盒结束后的 `BLOCKED/NOT_PROVEN` 对“采用该 Provider”视为不通过并触发 fallback，但不阻塞 Fake contract 下的 Core/Foundation；允许 foundation 与外部 spike 并行。把研究稿 12.1 的产品级条目迁到 Phase 1，Phase 0 只保留可复现实机能力证据。

### I-07 纵向 E2E 没有对应 composition task，计划按现状不可执行

证据：E2E 期待“启动工作流”、失败后 Attempt 2、归档状态和 Knowledge 页面（`docs/plans/2026-07-21-first-vertical-slice.md:1826-1844`），但这些文案/控件只在该测试出现；fake runtime factory 在 `docs/plans/2026-07-21-first-vertical-slice.md:1853-1863` 从未注入应用，且把 `verify` 动态挂在不含该 port 的 Provider 上。Playwright 调用未在计划中定义的 `npm run start:e2e`（`docs/plans/2026-07-21-first-vertical-slice.md:1866-1878`）。前述 Archive、Flow、SSE 也没有 composition wiring。

最小修复：在 E2E 前增加明确的 composition task：实现真实 application services、路由注册、Web router/Run/Knowledge 页面、StartRun command、Flow↔Runtime↔Verifier↔Storage↔Archive wiring、SSE publish 和 `start:e2e`；通过构造参数注入 Fake Provider/Verifier。先做 API 级完整链路测试，再运行浏览器故事。

### I-08 研究索引仍把已否决的 OpenClaw/Goose/多仓库路线当作“支持性调查”而非失效建议

证据：`docs/research/README.md:12-20` 将这些文件列为 supporting investigations；`docs/research/2026-07-21-multi-agent-workbench-products.md:8-16` 仍推荐 OpenClaw embedded child；`docs/research/2026-07-21-hunter-existing-assets-reuse-map.md:10-23` 仍推荐分立 Workbench/Runtime 与 OpenClaw adapter；`docs/research/2026-07-21-native-agent-remote-mobile.md:306-336` 仍保留 Goose-only Phase 0 建议。这些与当前“一主产品 monorepo、Orca 仅可替换 spike、OpenClaw/Goose 非基础”决定相冲突。

最小修复：将这些文档移入 superseded decision investigations，或在文件顶部加醒目的“证据可用、路线建议失效”声明并链接 current synthesis；任何执行入口只链接 current synthesis、ADRs 和 plans。

## 解除 NO verdict 的最短顺序

1. 先修 C-02/C-03，冻结可执行 Workflow/Run/父子生命周期与完整 transition tests。
2. 同步修 C-01，加入 Outbox/operation journal 和崩溃边界测试。
3. 在开放 daemon 写接口前修 C-04，并把 I-03/I-04 纳入同一安全与恢复 gate。
4. 补齐 I-01、I-02、I-05 的公共契约与持久化语义。
5. 修正 Phase 0 门和 E2E composition（I-06/I-07），再按黄金场景验收。

完成上述 Critical 且每项有对应 fault/security/model test，Important 均关闭或由明确 ADR 接受后，结论可复审为 **WITH FIXES**；当前不是 Ready。
