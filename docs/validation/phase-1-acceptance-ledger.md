# Phase 1 acceptance and supply-chain ledger

- 日期：2026-07-24
- 基线：`b187c4954f8ad6c72fd2d5d0e5680a3a2d356904`
- 适用计划：
  [`Phase 1 product hardening`](../plans/2026-07-24-phase-1-product-hardening.md)
- 证据范围：除显式写为 `PASS` 的固定 SHA CI 外，现有自动产品证据均为
  `CONTRACT_ONLY`。

## 状态规则

- `PASS` 只表示链接证据中的固定版本、平台和命令已实际满足该项；
- `CONTRACT_ONLY` 只证明 Hunter + Fake/fixture，不证明真实 Provider 或真实设备；
- `NOT_PROVEN` 表示已有部分事实但不足以通过；
- `NOT_RUN` 表示尚未运行；
- `BLOCKED` 表示缺少安装、登录、授权、设备、费用或外部输入；
- `FAIL` 保留已运行且不符合契约的历史。

本台账不根据产品名称推定 Capability 等级。Agent return、process exit、terminal idle
和 window opened 都不是 Step success。

## RED → GREEN 记录

- RED：台账文件不存在时，精确测试 3/3 真实失败；
- 测试夹具修正：首版 parser 误把 Markdown 表头 `ID` 当作验收项，1/3 失败；
- GREEN：修正 parser 后精确测试 3/3 通过；
- 根门禁：`npm run verify:foundation` PASS，102 test files / 878 tests；
- Task 2 基线的 `npm install` 报告 4 个 high severity 摘要；Task 3 精确升级
  Electron 后当时锁文件报告 3 个；Task 11 当前 `npm install` 的 registry 摘要
  报告 22 个 high severity，尚未分类 production reachability 或修复风险。
- Task 4：在线 SQLite snapshot、版本化 manifest、CAS/path/hash 负例与隔离恢复
  演练 19/19 通过；根门禁 106 files / 932 tests 通过。该结果仍为
  `CONTRACT_ONLY`，未在真实用户数据或灾备介质上运行。
- Task 5：版本化 redaction、allowlist diagnostic bundle 与五输出 Secret canary
  精确测试 23/23 通过；根门禁 108 files / 955 tests 通过。该结果为
  `CONTRACT_ONLY`，不代表真实生产数据库、Agent 日志或用户 Prompt 已全量扫描。
- Task 6：provider-neutral Attention/EvidenceRef、生产 SQLite RunView、
  receipt-bound action、人工观察/人工 verifier 审计、真实 ledger 幂等重放和
  append-only recovery Attempt 已通过本机全量 114 files / 1004 tests。该结果为
  `CONTRACT_ONLY`，不代表真实 Provider 的 observe/retry 已通过。
- Task 7：有界 Artifact 分页、retention resync、逻辑配额、核心 receipt reserve
  和慢消费者背压已通过固定 10+4 Fake 负载；真实规模性能仍为 `NOT_RUN`。
- Task 8：active/superseded/withdrawn、failed Archive、冲突显式选择、三维预算、
  hash-bound receipt、恶意正文数据边界和 Workbench 来源展示已通过精确 fixture。
  根门禁沙箱内首轮因 Windows `EPERM` 阻断；审查修正后同命令沙箱外重跑
  123 files / 1051 tests 及全部验证脚本、build 通过。该结果为
  `CONTRACT_ONLY`，不证明真实
  Agent 抗 Prompt Injection。
- Task 9：默认关闭的 TLS/device identity 远程边界、撤销/过期/refresh/proof
  重放负例、带时间和 expected version 的未确认 outbox、retention gap 原子
  snapshot resync、Gate permission allowlist 与 Provider-neutral 移动投影已通过
  Fake device 和浏览器 fixture。真实手机仍为 `NOT_PROVEN`。
- Task 10：unsigned NSIS 元数据、临时 packaged-app 启动/退出、迁移和 backup
  gate、保留 user data 的卸载策略及 owned sidecar cleanup 已通过 Windows
  lifecycle fixture；签名、SmartScreen、真实升级安装和发布仍未证明。
- Task 11：固定数据集本机 benchmark 的四项阈值和 12 项故障矩阵通过；
  smoke 覆盖 loop、跨进程 restart workload、archive、rebuild 和持久 Provider
  effect 对账，且严格保持 `NOT_PROVEN`。第一次 full 尝试在 24 个 durable cycle
  后中断并保留失败 envelope；独立 checkpoint 与 Windows 原子写重试修复已通过
  注入失败恢复测试。第二次 full 尝试跨过原停止点并完成 71 个 cycle，但收尾审计
  发现 resolver 与 evidence schema 的调度计数判定不一致，且计划重启与恢复重启
  尚未独立分账，因此主动停止并保留 `NOT_PROVEN` 证据；统一判定并加入重启分账后
  的 24 小时窗口尚未完成，所以 NFR-REL-04 仍为 `NOT_PROVEN`。

## 逐项台账

| ID | 状态 | 范围 | 证据 | 缺口 / 下一动作 | Owner |
|---|---|---|---|---|---|
| P-01 | CONTRACT_ONLY | Fake E2E | [PR #5 readiness](first-vertical-slice-pr5-readiness.md) | H4 重跑双 Project 隔离并补人工体验 | Workbench |
| P-02 | CONTRACT_ONLY | Domain/API | [Vertical slice acceptance](vertical-slice-acceptance.md) | H4 增加 Repository 追加和单仓无退化验收 | Domain |
| R-01 | CONTRACT_ONLY | SQLite/API | [Task 19 evidence](first-vertical-slice-task19.md) | H4 运行同 Project 双 Requirement E2E | Requirements |
| R-02 | CONTRACT_ONLY | Domain/API | [Vertical slice acceptance](vertical-slice-acceptance.md) | H4 保留 approved revision 覆盖负例 | Requirements |
| R-03 | CONTRACT_ONLY | Flow | [Foundation gate](foundation-local-gate.md) | H4 增加运行中新增 revision 的继续/终止/新计划 E2E | Flow |
| C-01 | CONTRACT_ONLY | Domain/API | [Task 19 evidence](first-vertical-slice-task19.md) | H4 增加多 RequirementRevision Change | Planning |
| T-01 | CONTRACT_ONLY | Domain/property | [Foundation gate](foundation-local-gate.md) | H4 汇总串行、并行、Join 和环拒绝证据 | Flow |
| T-02 | CONTRACT_ONLY | 临时 Git fixture | [Vertical slice acceptance](vertical-slice-acceptance.md) | H4 增加并行 writer 与显式 merge conflict E2E | Runtime |
| W-01 | CONTRACT_ONLY | Domain/Flow | [Foundation gate](foundation-local-gate.md) | H4 增加模板升级显式确认 E2E | Workflow |
| W-02 | CONTRACT_ONLY | Flow | [Foundation gate](foundation-local-gate.md) | H4 对六类 Step 组合形成单一矩阵 | Workflow |
| W-03 | CONTRACT_ONLY | Fake clock | [Foundation gate](foundation-local-gate.md) | H4 重跑轮次、时间、预算和停滞四类停止条件 | Flow |
| W-04 | CONTRACT_ONLY | Deterministic Fake | [Foundation gate](foundation-local-gate.md) | H4 增加同一 Evidence 重放一致性摘要 | Flow |
| A-01 | CONTRACT_ONLY | Event/SQLite | [Vertical slice acceptance](vertical-slice-acceptance.md) | H4 证明失败 Attempt 在重启和归档后仍可查 | Storage |
| A-02 | CONTRACT_ONLY | Independent verifier | [PR #5 readiness](first-vertical-slice-pr5-readiness.md) | Gate R 用真实 Connector 重复同一语义 | Flow |
| X-01 | NOT_PROVEN | Direct/app-server 有界 spike | [Phase 0 decision](phase-0-decision.md) | 固定受支持接口并补 structured interrupt、权限和 cleanup 收据 | Runtime |
| X-02 | NOT_PROVEN | 无完整固定版本收据 | [Phase 0 decision](phase-0-decision.md) | 用户完成合法安装/login 后运行 ACP/headless 原子场景 | Connectors |
| X-03 | NOT_PROVEN | 无完整真实 workspace/handoff 收据 | [Phase 0 decision](phase-0-decision.md) | Windows 实机执行 workspace open、Handoff、Artifact 和 human receipt | Connectors |
| X-04 | CONTRACT_ONLY | Capability receipt/UI | [Vertical slice acceptance](vertical-slice-acceptance.md) | Gate R 由真实 capability receipt 验证降级文案 | Runtime |
| O-01 | NOT_PROVEN | discover_runtime 通过，其余不足 | [Orca preflight](orca-windows-provider.md) | 等公开 fixture confinement、cleanup 与 restart 接口后重测 | Runtime |
| S-01 | CONTRACT_ONLY | Durable operation/Fake | [Runtime reliability](runtime-reliability.md) | Gate R 在真实 Provider 启动前后注入崩溃 | Storage |
| S-02 | CONTRACT_ONLY | Startup recovery/Fake | [PR #5 readiness](first-vertical-slice-pr5-readiness.md) | Gate R 重连真实 session 或保持 needs_attention | Storage |
| S-03 | CONTRACT_ONLY | 临时 SQLite/文件/CAS fixture | [Task 4 backup/restore](phase-1-backup-restore.md) | Gate R 用脱敏真实规模数据重跑隔离恢复 | Storage |
| K-01 | CONTRACT_ONLY | Archive worker | [Vertical slice acceptance](vertical-slice-acceptance.md) | H4 覆盖所有终态 outcome 和 crash resume | Knowledge |
| K-02 | CONTRACT_ONLY | Knowledge selection receipt + Handoff data boundary | [Task 8 Knowledge safety](phase-1-knowledge-handoff-safety.md) | Gate R 用真实 Connector 验证来源呈现、预算和 verifier 行为 | Knowledge |
| M-01 | NOT_PROVEN | PWA contract/viewport、带时间的离线 Run cache；Artifact 摘要未实现 | [Task 9 mobile safety](phase-1-mobile-offline-safety.md) | Gate R 在真实手机验证查看、锁屏、弱网、缓存时间和 Artifact 摘要 | Device |
| M-02 | CONTRACT_ONLY | Fake device security E2E、Gate allowlist、幂等 outbox | [Task 9 mobile safety](phase-1-mobile-offline-safety.md) | Gate R 用真实设备验证审批、撤销和离线重复请求 | Device |
| SEC-01 | CONTRACT_ONLY | 临时 database/log/export/prompt/diagnostic fixture | [Task 5 diagnostics](phase-1-diagnostic-bundle.md) | Gate R 对真实生产输出逐字节重跑 canary | Security |
| SEC-02 | CONTRACT_ONLY | Policy/negative scan | [Foundation gate](foundation-local-gate.md) | Gate R 检查真实 Provider 默认权限和高危 Gate | Security |
| LNX-01 | PASS | `54f5d90` Ubuntu CI | [Phase 1 baseline](phase-1-hardening-baseline.md) | 每个后续 HEAD 继续运行 Ubuntu quality/vertical-slice | CI |
| GOLDEN-01 | CONTRACT_ONLY | Fake vertical slice | [Vertical slice acceptance](vertical-slice-acceptance.md) | Gate R 用真实 Codex/CodeBuddy 和非玩具 Change 验收 | Product |
| GOLDEN-02 | CONTRACT_ONLY | TaskGraph/临时 Git fixture | [Foundation gate](foundation-local-gate.md) | H4 增加两个 writer、显式 join 和冲突 E2E | Flow |
| GOLDEN-03 | CONTRACT_ONLY | Fake verifier/Loop | [Vertical slice acceptance](vertical-slice-acceptance.md) | H4 统一预算、失败 Evidence 和归档历史检查 | Flow |
| GOLDEN-04 | NOT_PROVEN | Cursor 未完成真实 handoff | [Phase 0 decision](phase-0-decision.md) | Gate R 需要 Windows workspace、人工修改和 verifier receipt | Connectors |
| GOLDEN-05 | CONTRACT_ONLY | Fake recovery | [Runtime reliability](runtime-reliability.md) | Gate R 强制重启真实 Provider 并证明无重复 Session | Runtime |
| GOLDEN-06 | NOT_PROVEN | Fake device + 浏览器 fixture；未知/高风险 Gate 默认不下发 | [Task 9 mobile safety](phase-1-mobile-offline-safety.md) | Gate R 在真实手机执行普通/高风险 Gate 与断网重放 | Device |
| NFR-REL-01 | CONTRACT_ONLY | Event actor/correlation | [Foundation gate](foundation-local-gate.md) | H4 对所有命令投影做覆盖检查 | Storage |
| NFR-REL-02 | CONTRACT_ONLY | Fault injection/Fake | [Runtime reliability](runtime-reliability.md) | Gate R 对真实 side effect 重复同一矩阵 | Runtime |
| NFR-REL-03 | CONTRACT_ONLY | 一致性 manifest/隔离恢复 fixture | [Task 4 backup/restore](phase-1-backup-restore.md) | Gate R 验证真实规模、介质故障和保留策略 | Storage |
| NFR-REL-04 | NOT_PROVEN | smoke 通过；两次 full attempt 均保留，第二次 71 cycle 因 resolver/schema 不一致与重启分账缺口而主动停止 | [Task 11 soak](phase-1-soak.md) | 在统一精确调度判定并加入重启分账的冻结源码上从零重跑完整 24h | Testkit |
| NFR-PERF-01 | CONTRACT_ONLY | JSDOM + 固定 64 Projects / 14 Steps，p95 分别 17.835 / 6.271 ms | [Task 11 performance](phase-1-performance.md) | Gate R 在真实浏览器和生产规模重跑 1 秒目标 | Performance |
| NFR-PERF-02 | CONTRACT_ONLY | ledger → reader → durable SSE → 本地 JSDOM UI，p95 125.228 ms | [Task 11 performance](phase-1-performance.md) | Gate R 在真实浏览器、真实设备和真实 Provider 重跑 500ms 目标 | Performance |
| NFR-PERF-03 | CONTRACT_ONLY | 128 历史 Runs + 固定 10 read/wait + 4 端到端关联 active Fake，p95 19.913 ms | [Task 11 performance](phase-1-performance.md) | Gate R 用真实 Provider 和持续负载验证吞吐、延迟及公平性 | Performance |
| NFR-PERF-04 | CONTRACT_ONLY | 大日志有界分页、逻辑配额、保留点和慢客户端背压 | [Task 7 resource bounds](phase-1-resource-bounds.md) | Gate R 验证真实规模、磁盘水位和长时慢客户端恢复 | Storage/UI |
| NFR-PORT-01 | CONTRACT_ONLY | 可读文件 + manifest 恢复 | [Task 4 backup/restore](phase-1-backup-restore.md) | Gate R 在独立安装环境验证读取与迁移 | Knowledge |
| NFR-PORT-02 | NOT_RUN | Export/Import 未产品化 | [Roadmap](../09-migration-and-roadmap.md) | 保持 Phase 2，除非 H1 备份恢复直接需要 | Product |
| NFR-PORT-03 | CONTRACT_ONLY | Provider-neutral Fake | [Foundation gate](foundation-local-gate.md) | Gate R 用第二个真实 Provider swap 验证 | Architecture |
| NFR-PORT-04 | CONTRACT_ONLY | 公共 schema/path 边界 | [Foundation gate](foundation-local-gate.md) | H4 重跑 Windows 路径中立性扫描 | Architecture |
| NFR-OBS-01 | CONTRACT_ONLY | Correlation ID | [Foundation gate](foundation-local-gate.md) | H4 从 Run 到 Archive 全链对账 | Observability |
| NFR-OBS-02 | CONTRACT_ONLY | schema v1 allowlist diagnostic bundle | [Task 5 diagnostics](phase-1-diagnostic-bundle.md) | H2 增加用户预览；Gate R 验证真实故障数据 | Security |
| NFR-OBS-03 | CONTRACT_ONLY | Run/Attempt/Attention/Evidence UI | [Task 6 Attention actions](phase-1-attention-actions.md) | Gate R 用真实 Provider receipt 验证 action 可用性和恢复结果 | Workbench |
| NFR-OBS-04 | CONTRACT_ONLY | 规范事件优先 | [PR #5 readiness](first-vertical-slice-pr5-readiness.md) | Gate R 关联真实原始事件 hash 而不暴露协议噪音 | Runtime |
| BLOCK-01 | CONTRACT_ONLY | verifier 才能成功 | [PR #5 readiness](first-vertical-slice-pr5-readiness.md) | Gate R 用真实 Agent return 重测 | Flow |
| BLOCK-02 | CONTRACT_ONLY | revision immutable | [Foundation gate](foundation-local-gate.md) | H4 保留覆盖负例 | Domain |
| BLOCK-03 | CONTRACT_ONLY | isolated worktree lease | [Vertical slice acceptance](vertical-slice-acceptance.md) | H4 执行并行 writer 冲突场景 | Runtime |
| BLOCK-04 | CONTRACT_ONLY | durable operation recovery + append-only recovery Attempt | [Task 6 Attention actions](phase-1-attention-actions.md) | Gate R 在真实 Session 启动边界注入崩溃并执行恢复 action | Storage |
| BLOCK-05 | CONTRACT_ONLY | canonical Hunter state | [ADR-0005](../adr/0005-orca-runtime-integration.md) | 持续扫描公共类型和持久层 Provider 私有字段 | Architecture |
| BLOCK-06 | NOT_PROVEN | Cursor 仅候选 | [Phase 0 decision](phase-0-decision.md) | 真实 receipt 前禁止宣传可控 Session | Product |
| BLOCK-07 | CONTRACT_ONLY | 五类临时输出逐字节 canary | [Task 5 diagnostics](phase-1-diagnostic-bundle.md) | Gate R 扫描真实数据库、日志、导出和 Prompt 路径 | Security |
| BLOCK-08 | CONTRACT_ONLY | device scope、proof replay、Gate permission allowlist、任意移动 operation 拒绝 | [Task 9 mobile safety](phase-1-mobile-offline-safety.md) | Gate R 用真实设备验证不能绕过高危策略 | Device |
| BLOCK-09 | CONTRACT_ONLY | Archive/Knowledge/CAS 对账 | [Task 4 backup/restore](phase-1-backup-restore.md) | Gate R 用真实归档重跑 hash/缺失故障矩阵 | Knowledge |
| BLOCK-10 | CONTRACT_ONLY | 状态过滤、冲突降级、预算和 untrusted-data boundary | [Task 8 Knowledge safety](phase-1-knowledge-handoff-safety.md) | Gate R 用真实 Agent/Connector 重跑恶意来源与权限负例 | Knowledge |
| SUP-01 | NOT_PROVEN | 2026-07-25 `npm install` registry 摘要为 22 high，未分类可达性 | [Task 11 performance](phase-1-performance.md) | 分类 production reachability、修复版本和破坏性升级风险；禁止无评估 force fix | Security |
| SUP-02 | NOT_RUN | 未运行详细 registry audit；`npm install` 的摘要不能替代逐项审计 | [Phase 1 baseline](phase-1-hardening-baseline.md) | 用户明确授权发送依赖元数据后保存无凭据逐项摘要并由 Security 评估，不自动执行破坏性升级 | Owner/Security |

## 当前结论

- H0 的本地门禁和固定 SHA 双平台 CI 已有真实 PASS；
- 其余产品链路最高为 `CONTRACT_ONLY`；
- Orca 只有 runtime discovery 原子项通过，Provider 采用仍为 `NOT_PROVEN`；
- Codex、CodeBuddy、Cursor 和真实移动设备均没有完整 Phase 1 通过证据；
- 当前 registry 摘要的 22 个 high severity 依赖项尚未分类，不能写成已修复或可利用；
- 生产 Provider、代码签名、分发和发布保持阻断。
