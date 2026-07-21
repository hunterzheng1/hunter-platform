# Hunter Platform 内部设计最终一致性复审

## 范围与判定口径

- 复审日期：2026-07-21（Asia/Shanghai）。
- 基线：[内部设计一致性审查](2026-07-21-internal-design-review.md) 的
  C-01..C-04、I-01..I-08，以及当前产品设计、Phase 0、Foundation、Vertical
  Slice 和研究索引。
- `closed`：当前文档已经给出一致的规范边界，并在实施计划中落为明确文件、
  RED 场景、实现约束、GREEN 命令或可核验完成证据。
- `needs_phase0`：设计闭环已成立，但上游产品的真实版本、协议、权限、恢复或
  Windows 行为必须靠本机 Phase 0 回执决定；这不是允许预填能力或跳过验收。
- `open`：规范与计划仍矛盾，或原 finding 的关键失败场景没有可执行闭环。

本报告只判断“设计是否足以交给 Fable5 继续审查”，不声称计划中的代码、测试或
真实 Provider 已经实现、运行或通过。

## 原 finding 逐项复核

| Finding | 状态 | 当前闭环证据与判断 |
|---|---|---|
| C-01 外部副作用缺少持久 journal | `closed` | [Foundation 计划](../plans/2026-07-21-platform-foundation.md) `L103-L111` 冻结唯一 journal/worker/receipt 契约；`L403-L529` 把 Event、command receipt、Outbox、side-effect receipt、fingerprint 和四个崩溃点落成同事务及文件库重启测试；`L815-L841` 禁止 RuntimeManager 直接调用适配器或以进程内 Map 为 authority；`L859-L896` 在 listen 前对不确定结果 fail closed。原“外部已成功、回执前崩溃后重复创建”的窗口已有唯一外部副作用或 `needs_attention` 的可执行判据。 |
| C-02 FlowEngine 不能执行完整图、回边和状态机 | `closed` | [Foundation 计划](../plans/2026-07-21-platform-foundation.md) `L287-L382` 冻结 strict WorkflowStep/Route/Loop schema，含 executor、AgentProfile selector、Step permission、retry backoff、图验证和顺序无关 fingerprint；`L692-L737` 把执行/验证双状态、Gate、timeout/cancel、持久预算、回边新 Attempt、fan-out/fan-in、父子汇总及 property tests 放入同一 FlowEngine；`L761-L797` 证明 Runtime/Policy 实际消费 published Step，调用方不能覆盖执行器、权限、重试或预算。此前最后一个 schema/消费残口也已关闭。 |
| C-03 StartRun 绕过 Flow 且冻结绑定不完整 | `closed` | [Foundation 计划](../plans/2026-07-21-platform-foundation.md) `L639-L684` 定义 `change|task|subflow` 判别绑定、空 Requirement/孤儿/重复 Task child/terminal parent 等负例，并要求服务端从 published/approved 对象派生 root binding；`L692-L713` 定义父子预算、取消、失败和终态汇总；[Vertical 计划](../plans/2026-07-21-first-vertical-slice.md) `L2272-L2288` 用真实 composition test 禁止 StartRun 绕过 Flow 或 child 丢失 root 冻结上下文。 |
| C-04 本机 API、Runtime 与移动身份没有安全边界 | `closed` | [Foundation 计划](../plans/2026-07-21-platform-foundation.md) `L920-L960` 先拒绝未认证/越权/跨 Origin/非法 payload/调用方 authority 和任何 Foundation 远程入口，默认随机 loopback 并由服务端派生路径、策略和预算；`L974-L1005` 对授权 Event Ledger SSE 做重启、gap、过滤和 race 测试。[Vertical 计划](../plans/2026-07-21-first-vertical-slice.md) `L2112-L2153` 收窄 Electron IPC 且不向 renderer 暴露 secret/origin，`L2155-L2210` 再以独立 TLS listener、持久设备身份、桌面确认、设备证明、短 access token、轮换 refresh、撤销和幂等命令补齐移动侧。 |
| I-01 canonical Change/Task 被实施模型删减 | `closed` | [Foundation 计划](../plans/2026-07-21-platform-foundation.md) `L195-L266` 保存完整 ChangeRevision、TaskDefinition、ExecutionPlan 字段、不可变性和 DAG 性质；`L588-L612` 在 application command 内验证 approved Requirement、Project/Repository、Change dependency、Workflow/Profile 与 fingerprint，并原子发布 ChangeRevision + ExecutionPlan。 |
| I-02 Connector 等级/CodeBuddy transport 被提前写死 | `needs_phase0`（设计闭合） | [Vertical 计划](../plans/2026-07-21-first-vertical-slice.md) `L21-L32` 明确废止旧 literal L3、固定 CodeBuddy URL 和适配器本地幂等样例，`L2065-L2103` 要求能力原子探测、版本/登录/schema 漂移 fail closed、等级只由 probe receipt 计算，并让副作用复用 Foundation journal。[Phase 0 计划](../plans/2026-07-21-phase-0-runtime-validation.md) `L336-L392` 才负责在固定真实版本上比较 CodeBuddy ACP/headless 并冻结 transport；`L19-L23` 明确只有本机输出能通过能力标准。故原“硬编码能力”设计缺口已关闭，但 Codex/CodeBuddy/Cursor/Orca 的真实等级与 CodeBuddy 生产 transport 仍必须保留为 Phase 0 未决事实。 |
| I-03 Writer/Controller Lease 与 worktree 不变量未落地 | `closed` | [Foundation 计划](../plans/2026-07-21-platform-foundation.md) `L767-L797` 定义 Workspace/Writer/Controller 三类持久 Lease、owner/generation/expiry、并发/漂移/恢复测试及 launch 前 receipt；[Vertical 计划](../plans/2026-07-21-first-vertical-slice.md) `L2028-L2056` 再以真实路径、两个 writer、stale generation、错误 DeviceBinding/worktree、HEAD drift 和进程重建契约约束所有适配器。 |
| I-04 SSE 仍是易失内存缓冲 | `closed` | [Foundation 计划](../plans/2026-07-21-platform-foundation.md) `L974-L1005` 明确只以 `events.position` 为 cursor，使用两个 app 实例和文件数据库验证 restart replay、授权过滤、retention gap、snapshot/resync 与 replay/live race；内存信号只能唤醒查询，不能提供事件数据（同文件 `L107-L111`）。 |
| I-05 Archive→Knowledge 不耐崩溃且丢 Project scope | `closed` | [Vertical 计划](../plans/2026-07-21-first-vertical-slice.md) `L2212-L2253` 定义 terminal Event 同事务 `archive_jobs`、三处故障注入、完整 versioned provenance/hash、必填 Project scope、幂等 projection 与按 Project 可重建索引；[领域设计](../03-domain-model-and-state-machines.md) `L268-L283` 则把全部终态 Archive 作为 HistoricalKnowledge，同时区分 Authoritative/Experiential 的提升与注入。 |
| I-06 Phase 0 BLOCKED/fallback 无法退出 | `closed` | [Phase 0 计划](../plans/2026-07-21-phase-0-runtime-validation.md) `L21-L23` 规定时间盒结束时 `BLOCKED -> NOT_PROVEN`、触发 fallback 且不阻塞 Fake Foundation；`L568-L621` 要求 Orca 的 `FAIL` 或 `BLOCKED/NOT_PROVEN` 进入同证据结构的 AO 比较，并允许最终选择“无生产 Provider 已证明，Foundation 仅对 Fake 继续”。不存在把缺登录误当 PASS 或永久卡住路线的路径。 |
| I-07 纵向 E2E 缺少 composition task/start:e2e | `closed` | [Vertical 计划](../plans/2026-07-21-first-vertical-slice.md) `L1817-L1928` 先建立可启动、已认证且能进入 owner story 的 13A RED scaffold：daemon 随机端口、Web/readiness 固定受锁端口、Playwright 显式加载受限 storage state，并以 `ProjectCreated`、`RequirementRevisionApproved` 后的 `RUN_COMPOSITION_NOT_WIRED` 排除假红；`L2255-L2309` 再新增生产 composition root、完整 API-chain RED 测试、Flow→Outbox→Runtime→Verifier→Archive→Knowledge/SSE wiring、恢复后 listen、升级同一 `start:e2e` launcher 及浏览器前 GREEN gate；`L23-L30` 明确单向 13A→14–19→13B release-blocking 顺序。 |
| I-08 旧 OpenClaw/Goose 路线仍像现行建议 | `closed` | [研究索引](../research/README.md) `L7-L32` 只把最新综合稿列为 current synthesis，并把 OpenClaw、Goose、旧多 Agent/资产路线放入 “Superseded decision investigations”。旧文件自身也在顶部声明建议失效，例如 [Goose 旧稿](../research/2026-07-21-goose-opencode-pi-fit-comparison.md) `L3-L5`、[旧资产复用图](../research/2026-07-21-hunter-existing-assets-reuse-map.md) `L3-L8` 和 [旧多 Agent 工作台稿](../research/2026-07-21-multi-agent-workbench-products.md) `L3-L8`。执行入口不会再把这些历史建议当规范。 |

汇总：`closed=11`、`needs_phase0=1`、`open=0`。

## 重点语义与产品边界复核

### Orca 仍只是有时限、可逆候选 — `needs_phase0`

[Runtime/Connector 设计](../06-runtime-provider-and-connectors.md) `L198-L236` 明说 Orca
不是已采用依赖或 Hunter 事实源，只先走公开接口的 Sidecar spike，并列出薄 Fork 前提与
退出顺序。[迁移路线](../09-migration-and-roadmap.md) `L143-L175` 把它放进 1–2 周时间盒，
结束时必须选择 Sidecar / 薄 Fork / 放弃；[Phase 0 计划](../plans/2026-07-21-phase-0-runtime-validation.md)
`L608-L621` 还允许正式记录“没有生产 Provider 被证明”。因此 Sidecar 是优先验证形态，
不是预先采用结论；实际结果必须由 Phase 0 决定。

### WorkflowRun 与 ChangeRevision — `closed`

[领域设计](../03-domain-model-and-state-machines.md) `L79-L94` 将 ChangeRevision 的正文
生命周期固定为 `draft -> published -> superseded|withdrawn`，只有 published 可进入
ExecutionPlan，发布后不可覆盖；`L114-L159` 区分 TaskGraph 与 WorkflowGraph，并用同一
WorkflowRun 类型表达 `subject_kind=change` 的 root 和 `task|subflow` child。父子 Run
继承固定 Project、Requirement/Change、ExecutionPlan、Workflow、Policy 与 Budget，
与 Foundation 的判别绑定和负例一致。

### 移动端、归档和知识 — `closed`

[客户端设计](../05-client-information-architecture.md) `L258-L277` 把移动 PWA 限定为远程
驾驶舱，不复制完整 IDE/终端/高危配置；[远程安全设计](../07-storage-security-and-remote-access.md)
`L203-L255` 要求默认 loopback、显式开启、桌面确认配对、最小 Project scope、加密和
服务端重授权。知识侧同文件 `L257-L266` 明确“全部 Archive 自动入历史索引”不等于
“全部自动注入”，失效/低信任内容保留来源但默认不进 Handoff。Vertical 的持久设备、
命令 envelope 和 Archive job 已将这些边界落成测试计划。

## 机械校验

对最新文档树中的 63 个 Markdown 文件执行了全树检查：

- 严格 UTF-8 解码错误：0。
- 缺失的相对 Markdown 链接目标：0。
- 奇数/未配对的反引号或波浪线代码围栏文件：0。

## Verdict

**READY_FOR_FABLE5**

原 4 个 Critical 和 8 个 Important 中没有仍开放的设计缺口。I-02 以及 Orca 采用结论
保留 `needs_phase0` 是正确的证据边界：Fable5 可以审查契约、失败语义和计划完整性，
但不能把尚未运行的本机探测写成上游能力事实。这个 verdict 也不等于允许跳过 Phase 0、
Foundation/Vertical 的 RED→GREEN、故障注入、安全测试或真实版本验收。
