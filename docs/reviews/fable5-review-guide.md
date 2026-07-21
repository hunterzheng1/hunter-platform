# Fable5 独立设计评审指南

> 评审对象：Hunter Platform 2026-07-21 产品重置设计
> 评审目标：寻找会导致产品方向错误、不可实现、状态不可信、安全失控或迁移失败的问题，而不是进行措辞润色。

## 1. 评审者任务

请把自己当作准备否决该项目的独立架构评审者。不要默认对话中的已批准选择在技术上必然正确；逐条核对这些选择是否：

- 在所有文档中语义一致。
- 有可以实现和测试的边界。
- 不依赖未经验证的上游能力。
- 在 Windows 上可落地，并没有破坏 Linux 兼容。
- 保留各原生 Agent 的优势，而不是暗中建设另一个 Agent。
- 在 Provider、Agent、应用或主机崩溃时仍然诚实。
- 对本地源码、凭据、移动访问和自动 Loop 有足够安全控制。
- 能从旧 Hunter-Runtime/Hunter-Harness 迁移，而不是把旧假设换名保留。

优先报告反例、缺失不变量、错误的边界、不可测试的承诺与相互矛盾。不要因为“未来可以补”而降低严重度。

## 2. 建议阅读顺序

### 第一遍：产品与不可变决定

1. [`../01-product-vision.md`](../01-product-vision.md)
2. [`../11-decision-summary.md`](../11-decision-summary.md)
3. [`../adr/0001-hunter-is-a-control-plane.md`](../adr/0001-hunter-is-a-control-plane.md)
4. [`../adr/0002-hunter-owns-canonical-state.md`](../adr/0002-hunter-owns-canonical-state.md)
5. [`../adr/0003-local-first-modular-monolith.md`](../adr/0003-local-first-modular-monolith.md)
6. [`../adr/0004-tiered-native-agent-connectors.md`](../adr/0004-tiered-native-agent-connectors.md)

### 第二遍：模型与执行正确性

1. [`../02-system-architecture.md`](../02-system-architecture.md)
2. [`../03-domain-model-and-state-machines.md`](../03-domain-model-and-state-machines.md)
3. [`../04-workflow-and-loop-semantics.md`](../04-workflow-and-loop-semantics.md)
4. [`../06-runtime-provider-and-connectors.md`](../06-runtime-provider-and-connectors.md)
5. [`../07-storage-security-and-remote-access.md`](../07-storage-security-and-remote-access.md)

### 第三遍：用户、交付与证据

1. [`../05-client-information-architecture.md`](../05-client-information-architecture.md)
2. [`../08-user-stories-and-acceptance.md`](../08-user-stories-and-acceptance.md)
3. [`../09-migration-and-roadmap.md`](../09-migration-and-roadmap.md)
4. [`../10-risk-register.md`](../10-risk-register.md)
5. [`../plans/2026-07-21-hunter-platform-phase-0-and-vertical-slice.md`](../plans/2026-07-21-hunter-platform-phase-0-and-vertical-slice.md)
6. [`../plans/2026-07-21-phase-0-runtime-validation.md`](../plans/2026-07-21-phase-0-runtime-validation.md)
7. [`../plans/2026-07-21-platform-foundation.md`](../plans/2026-07-21-platform-foundation.md)
8. [`../plans/2026-07-21-first-vertical-slice.md`](../plans/2026-07-21-first-vertical-slice.md)

如需验证产品对比和上游能力，再阅读 [`../research/README.md`](../research/README.md) 路由的当前研究。官方文档声称不等于 Hunter 已在本机验证。

## 3. 已批准但仍需检验的产品不变量

以下是 Owner 已确认的产品边界。评审可以指出其后果不可接受或彼此冲突，但不要仅因个人偏好建议恢复旧方向：

1. Hunter 是控制面，不是新的超级 Agent。
2. 不同 Agent 允许 L0–L3 不同控制等级，降级必须诚实。
3. Project 是逻辑产品，可绑定多仓；首版优化单主仓。
4. `Requirement → Change → Task → Workflow Step` 是四层语义。
5. approved RequirementRevision 和运行绑定的 Revision 不可覆盖。
6. 工作流支持顺序、有限并行、条件、Gate、Retry 与有界 Loop，不做任意 BPMN。
7. Agent 返回不等于 Step 成功，必须验证或人工确认。
8. 并发 Writer 使用独立 worktree；非 Git 首版单 Writer。
9. Hunter 提供统一驾驶舱，但保留原生 Agent 窗口。
10. 移动端是 PWA 驾驶舱，不是完整 IDE。
11. 本机是执行和完整数据事实源；云/中继是可选连接层。
12. 首版单用户、多项目、多设备。
13. 文件保存重要正文；SQLite 保存运行、关系、事件与索引。
14. 所有 Archive 自动入知识体系，但只有有效权威知识与已验证经验默认注入。
15. Orca 只是 Phase 0 首个有时限、可逆的验证候选，不是已采用或不可替换的底座。
16. 首批 Connector 是 Codex、CodeBuddy Code、Cursor。
17. Windows 首发，Linux 从端口与 CI 开始兼容。
18. 主仓库为 `hunter-platform`；Hunter-Harness 是独立内容/分发上下文。
19. Goose Gate、版本 Pin、三臂 Pilot 和 30 天 Gate 从现行设计移除。

## 4. 必答评审问题

### 4.1 产品边界

1. 有没有任何模块实际上重新实现了 Agent 的规划、代码编辑或模型 Loop，从而与“控制面”定位矛盾？
2. 用户主线是否确实是 Project/Requirement/Change/Task/Run，而不是隐藏的 Session/Chat 主线？
3. “一个客户端”是否只是体验承诺，还是错误地要求所有 Runtime 必须与 UI 同进程？
4. 首版范围是否仍然包含团队、云执行、原生手机 App、通用 BPMN 或插件市场等非目标？

### 4.2 领域模型

1. Requirement、Change、Task、Workflow Step 的所有关系是否明确？是否存在无法表达的真实开发场景？
2. 一个 Change 覆盖多个 RequirementRevision、一个 Requirement 分多次 Change 的可追溯性是否完整？
3. Task DAG 与 Workflow Graph 是否被重复建模或职责重叠？
4. `StepRun` 与 `StepAttempt` 是否能表达 Retry、Loop、Resume、新 Session 和人工接管而不覆盖历史？
5. AgentProduct、AgentProfile、Connector、NativeSessionRef、ExecutionHost、WorkspaceLease 是否真正分离？
6. 旧 Hunter-Harness 的 Project/Push 术语是否还在任何地方污染新模型？

### 4.3 状态机与 Flow

1. 每个状态是否有合法入口、出口、终态和恢复规则？
2. Agent Return、Process Exit、Verification 和 Step Success 是否在所有文档中严格区分？
3. Retry 与业务 Loop 是否有清楚区别？每次是否新建 Attempt？
4. 并行 Fan-out/Fan-in、失败传播、Skip/Cancel 和 Join 是否确定？
5. Requirement 产生新 Revision 时，运行中的 Run 有哪些合法选择，是否会偷换输入？
6. Loop 是否在所有路径都有轮次、时间、预算与停滞上限？
7. Human Gate、移动端重复命令和恢复后重放是否幂等？

### 4.4 Runtime 与 Connector

1. `WorkspaceProvider`、`ProcessHost`、`AgentConnector`、`SessionObserver`、`NativeSurfaceOpener`、`ArtifactCollector`、`CompletionVerifier` 的边界是否足够深且不互相泄漏？
2. CapabilityManifest 是否足以驱动 UI、Flow 和安全策略？还缺哪些能力字段？
3. L0/L1 Cursor 流程是否在产品文案中被误称为自动执行？
4. Codex/CodeBuddy 的 L2/L3 目标是否被错误写成已验证事实？
5. 完成信号的可信度顺序是否存在反例？退出码、人工 Receipt、Verifier 冲突时谁优先？
6. Session 恢复后如何证明仍绑定原 Workspace、Profile 和需求上下文？
7. Connector Schema 漂移时是否 Fail Closed，并允许用户继续使用降级路径？

### 4.5 Orca 选择

1. 现有证据是否只足以把 Orca 列为“首个有时限、可逆的可行性候选”，而不足以列为“已采用”？
2. Sidecar 是否能覆盖 Windows worktree、PTY、Session、恢复和移动边界？哪些仍必须实测？
3. 薄 Fork 的五个决策门是否可量化，还是容易被主观绕过？
4. Orca 数据、标识或事件是否泄漏进 Hunter 领域模型？
5. 如果 Orca 被弃用，Fake、Direct 或 Agent Orchestrator Provider 是否能在不迁移业务数据的情况下接管？
6. 上游许可证、遥测、默认跳过权限、更新和供应链责任是否有明确验收证据？

### 4.6 数据、恢复与安全

1. SQLite、版本化文件、CAS、Git 与 Credential Store 的事实边界是否有双写或孤儿风险？
2. “先事件、后副作用”的 Transaction/Outbox 方案是否能防止重复 Agent Session？
3. Core、Orca、Agent、系统分别在各个时间点崩溃时，是否都有诚实状态？
4. 活动 SQLite 是否可能被错误地跨设备同步？
5. 远程访问是否默认关闭？设备密钥、Scope、撤销和重复审批是否充分？
6. 是否存在 Secret 进入 argv、日志、Prompt、Event、Artifact、通知或导出的路径？
7. 路径 canonicalization 是否考虑 symlink/junction、UNC、大小写与跨盘？
8. 备份是否经过真实恢复验证，而不只是文件复制？

### 4.7 Knowledge

1. Archive 自动入库与自动注入是否被清楚分离？
2. RequirementRevision 作为 KnowledgeSource 时是否保留 active/superseded/withdrawn 状态？
3. 失败 Run 中提炼的经验是否可能被错误提升？
4. 冲突知识、适用范围、置信度和失效条件是否足以阻止污染？
5. Handoff Pack 是否能解释为何选择某条知识，并受 Token/大小预算限制？
6. 来自仓库/外部文档的 Prompt Injection 是否跨越系统规则边界？

### 4.8 客户端与移动端

1. 用户能否在两次点击内解释一个 Step 为什么等待或失败？
2. 执行状态与验证状态是否同时使用文字、图标和颜色？
3. 多 Requirement、多 Change、并行 Task 是否在项目页面可理解，还是退化成单一当前任务？
4. 原生窗口打开失败、无法定位 Session、用户在外部修改 worktree 时，UI 如何提示？
5. 移动端是否严格保持查看、审批、短输入和 Run 控制，而没有隐式任意命令接口？
6. 主机离线时是否可能让缓存摘要看似实时？

### 4.9 迁移与交付

1. 旧 Runtime 哪些组件真正通用，哪些仍携带 Goose 假设？
2. Goose Gate/pin/pilot 是否在文档、计划或代码迁移表中仍被当作前置条件？
3. Hunter-Harness 的复用是否基于 Pack/格式/经验，而不是复制旧 Registry 领域？
4. Phase 0 是否能在 1–2 周级时间盒内回答架构问题，还是已经偷偷实现 Phase 1？
5. Phase 1 的黄金场景是否足以证明产品价值与可靠性？
6. Linux 是否有从 Day 1 的 CI 和端口约束，而不是一句“以后支持”？
7. 清空旧远端前是否有可恢复的旧 HEAD/Bundle，并避免旧设计继续出现在新 `main`？

## 5. 强制反例演练

请至少逐步推演以下故障，指出文档中每一步由哪个对象、事件、端口和 UI 状态负责：

1. `start()` 已发送但 Receipt 写入前 `hunterd` 崩溃。
2. Orca 仍在运行，但返回的 Session ID 在升级后改变格式。
3. CodeBuddy 已返回“完成”，测试失败，自动 Loop 第二轮又产生完全相同 Diff。
4. 用户在 Cursor 中修改了错误 worktree，并点击人工完成。
5. 两个并行 Task 都需要修改同一文件，汇合产生冲突。
6. 手机断线时提交 Approve，重连后再次提交。
7. approved Requirement 被 superseded，但旧 Run 尚在 Review。
8. 失败 Archive 提炼出一条与 active 架构决策冲突的经验。
9. SQLite 引用一个已被外部清理的测试报告。
10. Windows 主机重启后 Native Session 消失，但源码已经有部分修改。
11. Orca 上游停止维护或许可证变化，必须在下一个版本移除。
12. 恶意仓库 Skill 诱导 Agent 读取系统凭据并把内容写入 Artifact。

如果任一反例只能靠“Agent 应该会处理”“用户应该知道”或“以后再加判断”回答，应至少记为 Major。

## 6. 严重度定义

| 级别 | 定义 | 示例 |
|---|---|---|
| Blocker | 会使核心产品定位、数据正确性、安全或可恢复性失败；Phase 0/1 不可继续 | 虚假成功、重复 Agent 副作用、远程未授权、领域事实依赖 Orca |
| Major | 关键用户故事无法完成、模型明显缺失或阶段计划不可执行 | Task/Step 混淆、无可靠降级、恢复路径缺失 |
| Minor | 不阻断核心方案，但会造成歧义、维护成本或局部体验问题 | 状态文案不一致、非关键交叉引用缺失 |
| Question | 需要证据或 Owner 决定，尚不能判定为缺陷 | Orca 某版本具体能力待实测 |

风格偏好、措辞或未来可选优化不应标成 Blocker/Major，除非它掩盖了语义或安全问题。

## 7. 评审输出格式

请将结果写为一个日期化文件，例如：

```text
docs/reviews/2026-07-xx-fable5-design-review.md
```

每条 Finding 使用：

```markdown
## F-001 — [Blocker] 简短标题

- 文档与位置：
- 违反的不变量：
- 具体反例：
- 影响：
- 建议修正：
- 需要补充的验证证据：
```

结尾给出：

```markdown
## Verdict

- Product boundary: Pass / Revise / Fail
- Domain and flow correctness: Pass / Revise / Fail
- Runtime feasibility: Pass / Needs Phase 0 evidence / Fail
- Storage and recovery: Pass / Revise / Fail
- Security and remote access: Pass / Revise / Fail
- Migration and roadmap: Pass / Revise / Fail
- Overall: Go to Phase 0 / Revise before Phase 0 / Stop
```

## 8. 处置规则

评审提交后，每个 Finding 必须单独记录：

- `accepted`：设计或计划已调整，并链接变更。
- `rejected`：给出可检验证据，不以偏好反驳。
- `deferred`：说明目标 Phase、补偿控制和触发条件。
- `needs-evidence`：进入 Phase 0 Spike，并写明通过/失败标准。

Blocker 不能无期限 deferred。涉及上游能力的 Question 不应通过文档推断关闭，必须由固定版本实测或明确降级来关闭。

## 9. 明确禁止的回归

发现以下任一回归，请直接报告 Blocker 或 Major：

- 把 Hunter 改回 Goose、OpenClaw、Hermes、Orca 或单一 Agent 的壳。
- 把“Agent 返回”“终端空闲”“窗口关闭”直接映射为 Step Success。
- 把重要需求/知识正文只锁在数据库或向量库中。
- 让 Orca 成为 Requirement、Run 或 Knowledge 的唯一事实源。
- 让并行 Agent 直接写同一工作目录。
- 允许 approved RequirementRevision 原地修改。
- 把 Change、Task 和 Workflow Step 合并为同一个含糊对象。
- 允许无限 Loop 或无预算自动执行。
- 在首版默认启用远程访问或跳过权限。
- 为追求“一个客户端”而把 Hunter 领域逻辑深嵌入不可维护的 Orca Fork。
- 将 Goose Gate、Goose Pin、三臂 Pilot 或 30 天 Gate 恢复为主线前置条件。
