# 10. 风险登记与决策门禁

> 状态：Living Document
> 使用方式：每个 Phase 启动、架构决策和发布前更新；风险不是备注，而是范围与 Go/No-Go 的输入。

## 1. 评分方法

- 可能性 `L`：1 极低，2 低，3 中，4 高，5 极高。
- 影响 `I`：1 可忽略，2 局部，3 重要，4 严重，5 产品级失败。
- 风险分 `R = L × I`。
- `15–25`：红色，进入当前 Phase 的明确去风险工作，未降级不得发布。
- `8–14`：黄色，必须有 Owner、监测信号和缓解计划。
- `1–7`：绿色，记录并例行监测。

Owner 表示负责关闭证据的人，不意味着单人承担全部实施。

## 2. 当前风险总表

| ID | 风险 | L | I | R | 早期信号 | 缓解与决策门 | Owner/Phase |
|---|---|---:|---:|---:|---|---|---|
| R-01 | Orca 公开接口不足或不稳定，无法可靠充当 Sidecar | 4 | 5 | 20 | Schema 漂移、缺少稳定 Session ID、只能解析终端文本 | Phase 0 固定版本契约测试；Sidecar/薄 Fork/放弃三选一；Core 不依赖其数据模型 | Runtime / P0 |
| R-02 | Orca 上游维护、许可证、遥测或供应链不符合要求 | 3 | 5 | 15 | 更新停滞、不可审计二进制、强制云服务、依赖异常 | 源码/许可证/SBOM/遥测审计；版本固定；可替换 Provider；不满足即回退 | Security / P0 |
| R-03 | 不同 Agent 无法提供统一可靠的 Session 与完成语义 | 5 | 5 | 25 | “返回”只能从文本猜测、Resume 指向错误工作区 | L0–L3 能力分级；输出契约验证；人工 Receipt；禁止伪造统一能力 | Runtime+Flow / P0-P1 |
| R-04 | Codex/CodeBuddy/Cursor 升级导致 Connector 失效 | 4 | 4 | 16 | CLI 参数、ACP/API Schema 或登录流改变 | 版本探测、兼容矩阵、契约测试、Fail Closed、降级 Handoff | Connectors / 持续 |
| R-05 | Windows PTY、Job Object、路径与 GUI 启动器不稳定 | 4 | 4 | 16 | 进程树残留、中文/空格路径失败、取消无效 | Windows 实机矩阵；结构化 argv；故障注入；Phase 0 硬门 | Runtime / P0 |
| R-06 | Linux 被“接口兼容”掩盖，最终仍需大改 | 3 | 4 | 12 | Core 引用 Windows API、路径写入领域对象 | 平台端口隔离；Linux CI 从 Day 1；Phase 2 真实安装验收 | Architecture / P0-P2 |
| R-07 | Flow 模型扩张成通用 BPMN，拖慢核心产品 | 4 | 4 | 16 | 动态任意图、无限 Loop、UI 画布成为主工作 | 冻结六类 Step 与有界图；新控制流必须有用户故事和 ADR | Product+Flow / P1 |
| R-08 | Requirement、Change、Task、Workflow Step 术语再次混用 | 4 | 4 | 16 | API/页面都叫 task；Run 直接绑定可变需求 | Context Map、类型隔离、评审检查、迁移时重命名旧 Project | Domain / P0 |
| R-09 | 并行 Agent 修改同一工作区造成覆盖或错误合并 | 4 | 5 | 20 | 同一路径多 Writer、外部修改未检测 | WorkspaceLease；并发写独立 worktree；显式 Merge/Integration Step | Runtime+Flow / P1 |
| R-10 | 崩溃恢复重复启动 Agent 或误报成功 | 3 | 5 | 15 | 重启后出现双 Session、状态无回执跳转 | Event+Outbox+幂等键；故障注入；stale/needs_attention；发布阻断 | Storage+Flow / P0-P1 |
| R-11 | SQLite 与文件/CAS 不一致导致证据丢失 | 3 | 5 | 15 | 引用缺文件、孤儿对象、备份不可恢复 | 原子写协议、哈希校验、孤儿扫描、一致性 Manifest、恢复演练 | Storage / P0-P1 |
| R-12 | 远程访问扩大本机代码与 Agent 权限攻击面 | 3 | 5 | 15 | 服务监听公网、长期共享 Token、手机可执行任意命令 | 默认 loopback、设备密钥、最小 Scope、E2E 加密、撤销、PolicyEngine | Security / P1-P3 |
| R-13 | Secret 经日志、Prompt、命令行或导出泄露 | 3 | 5 | 15 | Token 出现在 Event/诊断包、argv 可见 | 系统凭据库、句柄注入、脱敏扫描、导出排除、安全测试 | Security / P0-P1 |
| R-14 | 自动知识入库造成过期信息或错误经验污染后续 Agent | 4 | 5 | 20 | superseded 需求仍被注入、失败结论成为规则 | 历史/权威/经验分级；active 过滤；来源/置信度/失效条件；冲突降级 | Knowledge / P1 |
| R-15 | Handoff Pack 过大、噪音多或含 Prompt Injection | 4 | 4 | 16 | Token 膨胀、Agent忽略当前要求、外部文档改变行为 | 作用域检索、预算、引用隔离、来源标记、可解释选取、注入测试 | Knowledge+Security / P1 |
| R-16 | 单客户端目标诱发深 Fork Orca，形成不可维护产品 | 3 | 5 | 15 | 为 UI 统一改写上游核心、领域逻辑进入 Fork | 证据通过后才按 Sidecar-first 评估；五项薄 Fork 门槛；Fork 预算与退出 ADR | Architecture / P0 |
| R-17 | Provider 可替换只存在于图上，实际 Flow 依赖 Orca 特性 | 4 | 4 | 16 | 领域对象出现 Orca ID、测试只跑真实 Orca | Fake Provider 契约；规范事件；Provider Swap E2E；禁止泄漏类型 | Architecture / P0-P1 |
| R-18 | 移动 PWA 范围膨胀成完整 IDE/终端 | 3 | 3 | 9 | 开始实现完整终端、Diff 编辑和工作流画布 | 冻结驾驶舱范围；高危操作回桌面；独立立项原生 App | Product / P1 |
| R-19 | 本地优先导致多设备状态冲突或用户误解离线摘要 | 3 | 4 | 12 | 离线审批重放、旧状态看似实时、路径同步失败 | Host 事实源；Event Cursor；幂等命令；缓存时间标记；路径仅 DeviceBinding | Device / P1 |
| R-20 | 大日志、Artifact 与事件流拖垮 UI/磁盘 | 4 | 3 | 12 | 页面内存上升、数据库膨胀、磁盘无界增长 | 流式分页、CAS、摘要、保留策略、磁盘配额与背压 | Storage+UI / P1 |
| R-21 | 自动 Loop 造成费用失控、无效反复或破坏性操作 | 4 | 5 | 20 | 相同失败重复、无有效 Diff、额度快速消耗 | 轮次/时间/成本预算；停滞检测；危险 Gate；全局 Kill Switch | Flow+Policy / P1 |
| R-22 | 实现 Agent 同时担任 Review 导致自我确认 | 3 | 4 | 12 | Review 复用同一 Session 且无独立验证 | 默认新 Profile/Session；验证器优先；项目覆盖需显式说明 | Workflow / P1 |
| R-23 | 旧 Hunter-Harness Project/Push 语义污染新 Workbench | 4 | 3 | 12 | 新 UI 仍要求 CLI 首次 Push 注册 | Context Map；旧对象重命名；Pack/Distribution 独立上下文 | Migration / P0 |
| R-24 | 旧 Runtime 代码整体复制，Goose 假设潜入新核心 | 3 | 4 | 12 | Goose 包成为通用依赖、旧 Pilot 再次阻塞开发 | 先契约后提取；逐组件迁移；明确删除清单；代码评审扫描 | Migration / P0 |
| R-25 | 清空并重建远端导致有价值历史无法恢复 | 2 | 4 | 8 | 旧 HEAD/标签未记录、无 Bundle | 执行前记录 HEAD、远端与 Bundle；新旧历史明确隔离 | Repository / 初始化 |
| R-26 | 团队/云端/插件生态提前进入范围导致 Phase 1 失焦 | 4 | 4 | 16 | 账号 RBAC、计费、Marketplace 先于纵向流程 | 首版单用户多设备；非目标清单；新范围需用户证据与设计评审 | Product / P1 |
| R-27 | 上游 Agent 条款或账号授权限制自动化使用 | 3 | 5 | 15 | 自动化违反服务条款、登录无法非交互恢复 | 仅用官方接口；法律/条款核验；用户授权 Gate；提供替代 Connector | Product+Legal / P0 |
| R-28 | Artifact/Knowledge 中含第三方或敏感源码，远程预览越权 | 3 | 5 | 15 | 手机看到未授权文件、通知泄露内容 | 内容分级、设备 Scope、服务端授权、通知最小化、导出审计 | Security / P1 |

## 3. Phase 0 红色风险关闭标准

### R-01 / R-02：Orca 可采用性

关闭证据：

- 固定版本与官方来源。
- Windows 实机端到端记录。
- API/CLI Schema 契约测试。
- 进程、worktree、恢复和移动数据流说明。
- 许可证、遥测、更新与默认参数审计。
- Sidecar、薄 Fork 或放弃的 ADR。

如果证据不足，默认不是“暂时通过”，而是限制为实验 Provider 或放弃。

#### 2026-07-22 Outcome 5 处置

ADR-0005 冻结“尚无生产 Runtime Provider 得到证明”。R-01、R-02、R-04、R-05 和 R-27 没有关闭或降级：候选 executable/login 不可用，因而不存在固定版本、Windows 生命周期、API/schema、安全默认值、许可证/条款或维护证据。Phase 0 Gate A、First Vertical Slice、真实 Provider 集成与发布保持阻断。

R-16 通过“本轮不 Fork、sidecar 未证明前禁止评估 Fork”获得补偿控制，但风险分暂不降低。R-17 已由 provider-neutral contracts、Fake contract suite 和双平台 CI 证明 Hunter 架构边界，真实 Provider swap 仍为 NOT_PROVEN，风险分同样保持不变。

下一关闭动作是 `P0-RUNTIME-01 Windows candidate enablement and atomic receipt`，最多 1 个工作日、单候选最多 4 小时；只有用户明确授权并自行完成安装/login 后才能启动。任何未在时间盒内获得原子能力收据的候选继续为 NOT_PROVEN。

### R-03：完成语义不统一

关闭方式不是要求所有 Agent 达到 L3，而是证明：

- CapabilityManifest 能准确降级。
- Agent Return 和 Verify 是不同状态。
- L0/L1 可以通过 Step Receipt + Verifier 安全完成。
- 恢复失败能转为新 Session + Handoff，而不丢历史。

### R-09 / R-10：并发写与恢复

Phase 1 前必须通过故障注入：

- 两个并行 Writer 无法获得同一 WorkspaceLease。
- Core 在启动请求前后任意时点崩溃都不创建重复 Session。
- Provider 失联不产生自动成功。
- Git HEAD 外部变化阻止自动推进。

### R-14 / R-15：知识污染

必须有：

- active/superseded/withdrawn 过滤测试。
- 失败 Archive 的经验提升策略。
- 冲突知识降级路径。
- Handoff Pack 来源展示与预算。
- Prompt Injection 测试语料。

### R-21：无人值守 Loop

任何自动 Loop 必须同时拥有轮次、时间、预算和停滞条件。未配置时 Flow 拒绝发布 WorkflowRevision，而不是使用无限默认值。

## 4. 安全威胁场景

| 威胁 | 攻击路径 | 必须的控制 |
|---|---|---|
| 恶意仓库指令 | README/Skill 诱导 Agent 读取凭据或越界执行 | Prompt 来源隔离、PolicyEngine、工具范围、人工 Gate |
| 路径穿越 | Connector/Artifact 返回 `../` 或外部绝对路径 | canonicalize 后验证 Workspace 根；拒绝 symlink escape |
| Shell 注入 | 文件名或 Prompt 拼入命令字符串 | 结构化 argv；禁用未经审计 Shell 拼接 |
| 移动令牌窃取 | 设备丢失或 Token 被复制 | 设备私钥、短时令牌、撤销、最小 Scope |
| 重放审批 | 离线或攻击者重复发送 approve | 幂等键、预期版本、一次性 Gate 状态 |
| Provider 伪造完成 | 上游返回错误/恶意完成事件 | 独立 CompletionVerifier、Evidence、契约校验 |
| 供应链替换 | Orca/Connector 自动更新到恶意版本 | 固定版本、签名/校验和、SBOM、升级 Gate |
| 日志泄密 | Agent 输出环境变量、Token 或源码 | 流式脱敏、内容分级、远程权限、保留策略 |
| 知识投毒 | 失败结论或外部文本自动成为权威知识 | 分级提升、来源、冲突检测、active 状态 |

## 5. 监控指标

发布后至少跟踪：

- Connector 探测失败率、降级率和版本分布。
- Native Session 启动成功率、重复启动防止次数和失联率。
- Step 在 `waiting_* / stale / verifying` 的停留时间。
- 自动 Loop 的平均轮次、预算停止率和无有效 Diff 比例。
- Workspace 冲突与外部修改次数。
- Event/Projection 不一致、Artifact 缺失和恢复失败次数。
- 移动端重复命令、撤销设备访问和授权拒绝。
- Knowledge 注入命中、用户排除、冲突与 superseded 误用次数。
- Orca/Agent 上游升级导致的契约失败。

指标默认保存在本机。任何外部遥测都需要显式选择和字段公开。

## 6. 风险接受模板

无法立即消除但希望继续的风险必须以 ADR 记录：

```text
Risk ID:
Decision:
Scope / Version:
Evidence:
Residual Risk:
Compensating Controls:
Monitoring Signal:
Expiry / Revisit Date:
Owner:
Rollback Trigger:
```

不得以“以后处理”作为风险接受；必须有补偿控制、触发信号和重新评估条件。

## 7. 发布 Go/No-Go

满足以下条件才可 Go：

- 所有红色风险已降级、关闭或通过 ADR 明确接受。
- 没有“完成状态不可信”“重复外部副作用”“Secret 泄露”类未关闭问题。
- Orca 决策有实机证据且保留替换路径。
- Codex、CodeBuddy、Cursor 的支持等级与产品文案一致。
- Windows 黄金场景和恢复演练通过。
- Linux CI 未被平台代码破坏。
- Archive/Knowledge 的来源、有效性与冲突策略通过测试。
- 远程访问默认关闭，设备撤销与命令幂等通过安全测试。
