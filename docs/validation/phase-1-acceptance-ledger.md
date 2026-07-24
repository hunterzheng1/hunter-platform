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
- `npm install` 仍只报告 4 个 high severity 摘要，未运行 registry audit。

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
| S-03 | CONTRACT_ONLY | Archive/Evidence | [PR #5 readiness](first-vertical-slice-pr5-readiness.md) | H1 增加 CAS 缺失、hash 不符和恢复演练 | Storage |
| K-01 | CONTRACT_ONLY | Archive worker | [Vertical slice acceptance](vertical-slice-acceptance.md) | H4 覆盖所有终态 outcome 和 crash resume | Knowledge |
| K-02 | CONTRACT_ONLY | Knowledge resolver | [Vertical slice acceptance](vertical-slice-acceptance.md) | H2 加入冲突降级和 Prompt injection 语料 | Knowledge |
| M-01 | NOT_PROVEN | PWA contract/viewport only | [Task 17 evidence](first-vertical-slice-task17.md) | Gate R 在真实手机验证查看、锁屏、弱网和缓存时间 | Device |
| M-02 | CONTRACT_ONLY | Fake device security E2E | [Task 17 evidence](first-vertical-slice-task17.md) | Gate R 用真实设备验证审批、撤销和离线重复请求 | Device |
| SEC-01 | NOT_PROVEN | 局部安全测试 | [PR #5 readiness](first-vertical-slice-pr5-readiness.md) | H2 用 canary 扫描数据库、日志、导出、Prompt 和诊断包 | Security |
| SEC-02 | CONTRACT_ONLY | Policy/negative scan | [Foundation gate](foundation-local-gate.md) | Gate R 检查真实 Provider 默认权限和高危 Gate | Security |
| LNX-01 | PASS | `54f5d90` Ubuntu CI | [Phase 1 baseline](phase-1-hardening-baseline.md) | 每个后续 HEAD 继续运行 Ubuntu quality/vertical-slice | CI |
| GOLDEN-01 | CONTRACT_ONLY | Fake vertical slice | [Vertical slice acceptance](vertical-slice-acceptance.md) | Gate R 用真实 Codex/CodeBuddy 和非玩具 Change 验收 | Product |
| GOLDEN-02 | CONTRACT_ONLY | TaskGraph/临时 Git fixture | [Foundation gate](foundation-local-gate.md) | H4 增加两个 writer、显式 join 和冲突 E2E | Flow |
| GOLDEN-03 | CONTRACT_ONLY | Fake verifier/Loop | [Vertical slice acceptance](vertical-slice-acceptance.md) | H4 统一预算、失败 Evidence 和归档历史检查 | Flow |
| GOLDEN-04 | NOT_PROVEN | Cursor 未完成真实 handoff | [Phase 0 decision](phase-0-decision.md) | Gate R 需要 Windows workspace、人工修改和 verifier receipt | Connectors |
| GOLDEN-05 | CONTRACT_ONLY | Fake recovery | [Runtime reliability](runtime-reliability.md) | Gate R 强制重启真实 Provider 并证明无重复 Session | Runtime |
| GOLDEN-06 | NOT_PROVEN | Fake device only | [Task 17 evidence](first-vertical-slice-task17.md) | Gate R 在真实手机执行普通/高风险 Gate 与断网重放 | Device |
| NFR-REL-01 | CONTRACT_ONLY | Event actor/correlation | [Foundation gate](foundation-local-gate.md) | H4 对所有命令投影做覆盖检查 | Storage |
| NFR-REL-02 | CONTRACT_ONLY | Fault injection/Fake | [Runtime reliability](runtime-reliability.md) | Gate R 对真实 side effect 重复同一矩阵 | Runtime |
| NFR-REL-03 | NOT_PROVEN | 局部 fail-closed | [PR #5 readiness](first-vertical-slice-pr5-readiness.md) | H1 实现文件/CAS 一致性 manifest 与恢复拒绝 | Storage |
| NFR-REL-04 | NOT_RUN | 尚无 24h 证据 | [Phase 1 plan](../plans/2026-07-24-phase-1-product-hardening.md) | H3 固定 seed 运行 24h soak 并保留全部 attempt | Testkit |
| NFR-PERF-01 | NOT_RUN | Project/Run 页面未测量 | [Acceptance source](../08-user-stories-and-acceptance.md) | H3 冻结 dataset 并测量 1 秒可交互目标 | Performance |
| NFR-PERF-02 | NOT_RUN | Event 到 UI 未测量 | [Acceptance source](../08-user-stories-and-acceptance.md) | H3 测量本机 p50/p95 与小于 500ms 目标 | Performance |
| NFR-PERF-03 | NOT_RUN | 10 read + 4 active 未测量 | [Acceptance source](../08-user-stories-and-acceptance.md) | H3 运行固定并发 load fixture | Performance |
| NFR-PERF-04 | NOT_PROVEN | SSE 有界，日志分页未完成 | [Vertical slice acceptance](vertical-slice-acceptance.md) | H2/H3 实现大日志分页、配额与背压 | Storage/UI |
| NFR-PORT-01 | CONTRACT_ONLY | Archive 可读文件 | [Vertical slice acceptance](vertical-slice-acceptance.md) | H1 用恢复演练确认无需 Hunter 可读取 | Knowledge |
| NFR-PORT-02 | NOT_RUN | Export/Import 未产品化 | [Roadmap](../09-migration-and-roadmap.md) | 保持 Phase 2，除非 H1 备份恢复直接需要 | Product |
| NFR-PORT-03 | CONTRACT_ONLY | Provider-neutral Fake | [Foundation gate](foundation-local-gate.md) | Gate R 用第二个真实 Provider swap 验证 | Architecture |
| NFR-PORT-04 | CONTRACT_ONLY | 公共 schema/path 边界 | [Foundation gate](foundation-local-gate.md) | H4 重跑 Windows 路径中立性扫描 | Architecture |
| NFR-OBS-01 | CONTRACT_ONLY | Correlation ID | [Foundation gate](foundation-local-gate.md) | H4 从 Run 到 Archive 全链对账 | Observability |
| NFR-OBS-02 | NOT_PROVEN | 无产品化诊断包 | [Phase 1 plan](../plans/2026-07-24-phase-1-product-hardening.md) | H2 实现 allowlist + canary 脱敏诊断包 | Security |
| NFR-OBS-03 | CONTRACT_ONLY | Run/Attempt/证据 UI | [Vertical slice acceptance](vertical-slice-acceptance.md) | H2 增加 why waiting/failed、actor、input revision 和 action | Workbench |
| NFR-OBS-04 | CONTRACT_ONLY | 规范事件优先 | [PR #5 readiness](first-vertical-slice-pr5-readiness.md) | Gate R 关联真实原始事件 hash 而不暴露协议噪音 | Runtime |
| BLOCK-01 | CONTRACT_ONLY | verifier 才能成功 | [PR #5 readiness](first-vertical-slice-pr5-readiness.md) | Gate R 用真实 Agent return 重测 | Flow |
| BLOCK-02 | CONTRACT_ONLY | revision immutable | [Foundation gate](foundation-local-gate.md) | H4 保留覆盖负例 | Domain |
| BLOCK-03 | CONTRACT_ONLY | isolated worktree lease | [Vertical slice acceptance](vertical-slice-acceptance.md) | H4 执行并行 writer 冲突场景 | Runtime |
| BLOCK-04 | CONTRACT_ONLY | durable operation recovery | [Runtime reliability](runtime-reliability.md) | Gate R 在真实 Session 启动边界注入崩溃 | Storage |
| BLOCK-05 | CONTRACT_ONLY | canonical Hunter state | [ADR-0005](../adr/0005-orca-runtime-integration.md) | 持续扫描公共类型和持久层 Provider 私有字段 | Architecture |
| BLOCK-06 | NOT_PROVEN | Cursor 仅候选 | [Phase 0 decision](phase-0-decision.md) | 真实 receipt 前禁止宣传可控 Session | Product |
| BLOCK-07 | NOT_PROVEN | 未完成全输出 canary | [Phase 1 plan](../plans/2026-07-24-phase-1-product-hardening.md) | H2 完成 Secret scan 才可解除 | Security |
| BLOCK-08 | CONTRACT_ONLY | device scope/policy | [Task 17 evidence](first-vertical-slice-task17.md) | Gate R 用真实设备验证不能绕过高危策略 | Device |
| BLOCK-09 | CONTRACT_ONLY | Archive provenance | [PR #5 readiness](first-vertical-slice-pr5-readiness.md) | H1 增加缺失/hash 不符 fail-closed | Knowledge |
| BLOCK-10 | CONTRACT_ONLY | active/verified policy | [Vertical slice acceptance](vertical-slice-acceptance.md) | H2 增加 superseded/withdrawn、冲突和 injection 测试 | Knowledge |
| SUP-01 | NOT_PROVEN | npm install 摘要为 4 high | [Phase 1 baseline](phase-1-hardening-baseline.md) | 分类 production reachability、修复版本和破坏性升级风险 | Security |
| SUP-02 | NOT_RUN | registry audit 未授权 | [Phase 1 baseline](phase-1-hardening-baseline.md) | 用户明确授权发送依赖元数据后运行并保存脱敏摘要 | Owner/Security |

## 当前结论

- H0 的本地门禁和固定 SHA 双平台 CI 已有真实 PASS；
- 其余产品链路最高为 `CONTRACT_ONLY`；
- Orca 只有 runtime discovery 原子项通过，Provider 采用仍为 `NOT_PROVEN`；
- Codex、CodeBuddy、Cursor 和真实移动设备均没有完整 Phase 1 通过证据；
- 4 个 high severity 依赖项尚未分类，不能写成已修复或可利用；
- 生产 Provider、代码签名、分发和发布保持阻断。
