# Phase 1 acceptance and supply-chain ledger

- 日期：2026-07-26
- 基线：`c17d85a77815e8e7205cc52ff699e81083491b97`
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
  smoke 保持 `NOT_PROVEN`。前三次未完成 full attempt 和第四次两次 Windows
  evidence rename 失败均按原始 envelope 保留；第四次通过两次合法 recovery
  restart 收敛后，在冻结 revision `19f4870` 上真实运行 86,410,499 ms、完成
  1,442 cycle。计划/恢复/总重启为 288/2/290，archive/rebuild/loop/fault
  matrix 为 144/48/1,442/24；288 个故障 attempt 全部通过且失败历史保留，
  receipt/outbox/Fake Provider effect 一一对账，五项检查全 true。六个精确
  测试文件 46/46 通过；`npm run verify:foundation` 在隔离外完整重跑
  129 files / 1,130 tests 及全部验证脚本、build 通过。NFR-REL-04 因而提升为
  `CONTRACT_ONLY`，不证明真实 Provider、真实设备或生产规模。
- Task 12 候选：P-02 Repository 追加/双 Project 隔离、W-01 WorkflowRevision
  迁移显式确认/幂等/重启重建、Golden-2 双 worktree join/conflict 和 Playwright
  suite-level cleanup 已通过；重放后的变更范围聚焦组为 14 files / 54 tests，
  最终审查修复聚焦组为 5 files / 28 tests，完整本机门禁为
  137 files / 1,153 tests，Chromium 5 PASS + 真实 Provider
  1 SKIP，mobile 1 PASS，未签名 Windows x64 测试打包 PASS。首次固定 SHA
  `612d69e` 的 Ubuntu 2 项和 Windows 基础门禁 PASS；Windows 垂直切片因同一
  物理目录的 Git 长路径与 Node 8.3 短路径字符串不相等而使 Golden-2 2 FAIL，
  另 3 PASS / 1 SKIP。真实路径规范化后本机 Golden-2 2/2、完整 Chromium
  5 PASS / 1 SKIP；修复 SHA `dc5f032` 的 GitHub Actions run `30201122272`
  四个 Windows/Ubuntu jobs 全部 PASS，含 Windows 完整 Vitest、完整 Chromium
  和未签名测试打包。Task 11 已完成 `CONTRACT_ONLY` 冻结，H4 自动部分现冻结为
  `CONTRACT_ONLY`。证据提交 `006fbbf83973a1178c3f4a2b319477a17eee81c9`
  的 push + PR 共 8 项 CI 全部 PASS；最终审查随后发现 StartRun 未校验
  ExecutionPlan 发布时冻结的根 WorkflowRevision。修复后的代码/测试提交
  `d31acabc485bd984504b51ecbee19f8d599b9058` 已在 push run
  `30203923871` 与 PR run `30203924995` 再次完成 8/8 CI。证据写回后的最终提交
  与 merge 不在提交内容中自证，必须以 PR #17 绑定最终 SHA 的外部状态为准。
  首次在沙箱内重跑 `verify:foundation` 时，前六段完成、Vitest 为
  1,151 PASS / 1 SKIP，最终 asset copy 因沙箱拒绝 Node 写入而 `EPERM`；
  同一 `npm run build` 及完整 `verify:foundation` 在沙箱外分别重跑通过，
  后者当时为 1,152/1,152 tests。沙箱外生成 `dist` 后，沙箱内 typecheck
  也因不能覆盖这些生成文件而 `EPERM`；最终审查重放修复后的沙箱外完整门禁为
  1,153/1,153 tests。环境失败均保留，不改写为 PASS。
- Gate R-1：Orca ready 状态只使 `discover_runtime=PASS`，公开接口仍不能同时证明
  创建前 fixture confinement 与完整 repo registration cleanup；`open --json` 启动
  launcher 超过 90 秒未返回的历史保留。Codex `0.144.6` 在临时无 remote read-only
  fixture 中复测时 create 超时，launch/send/interrupt 继续 `NOT_PROVEN`。CodeBuddy
  executable 缺失；Cursor `3.10.20` 只完成外部 version/help 发现，未完成
  login/workspace/handoff receipt。三者 manifest 均由公共 receipt 算法得到 `NONE`，
  真实 Provider Gate A 保持 `NOT_PROVEN`。

## 逐项台账

| ID | 状态 | 范围 | 证据 | 缺口 / 下一动作 | Owner |
|---|---|---|---|---|---|
| P-01 | CONTRACT_ONLY | Fake E2E | [H4 candidate](phase-1-contract-only-candidate.md) | Gate R 用非玩具双 Project 补人工体验 | Workbench |
| P-02 | CONTRACT_ONLY | Domain/API/SQLite E2E | [H4 candidate](phase-1-contract-only-candidate.md) | Gate R 用真实多仓项目验证路径、权限和交互 | Domain |
| R-01 | CONTRACT_ONLY | SQLite/API | [H4 candidate](phase-1-contract-only-candidate.md) | Gate R 在非玩具 Project 重跑双 Requirement | Requirements |
| R-02 | CONTRACT_ONLY | Domain/API | [H4 candidate](phase-1-contract-only-candidate.md) | Gate R 以真实审批流程重跑 immutable revision 负例 | Requirements |
| R-03 | CONTRACT_ONLY | Flow/pinned Run | [H4 candidate](phase-1-contract-only-candidate.md) | Gate R 在真实运行中演练继续、终止和新计划 | Flow |
| C-01 | CONTRACT_ONLY | Domain/API | [H4 candidate](phase-1-contract-only-candidate.md) | Gate R 用非玩具多 Requirement Change 验收 | Planning |
| T-01 | CONTRACT_ONLY | Domain/property/E2E | [H4 candidate](phase-1-contract-only-candidate.md) | Gate R 用真实工作负载验证串行、并行和 Join | Flow |
| T-02 | CONTRACT_ONLY | 临时 Git worktree fixture | [H4 candidate](phase-1-contract-only-candidate.md) | Gate R 用真实 Provider writer 处置 merge conflict | Runtime |
| W-01 | CONTRACT_ONLY | Domain/HTTP/SQLite E2E | [H4 candidate](phase-1-contract-only-candidate.md) | Gate R 验证真实项目迁移预览、确认和运行体验 | Workflow |
| W-02 | CONTRACT_ONLY | Flow matrix | [H4 candidate](phase-1-contract-only-candidate.md) | Gate R 用真实 Provider 重跑六类 Step 组合 | Workflow |
| W-03 | CONTRACT_ONLY | Fake clock/budget | [H4 candidate](phase-1-contract-only-candidate.md) | Gate R 以真实耗时和预算重跑停止条件 | Flow |
| W-04 | CONTRACT_ONLY | Deterministic Fake | [H4 candidate](phase-1-contract-only-candidate.md) | Gate R 对真实 Provider Evidence 重放做一致性对账 | Flow |
| A-01 | CONTRACT_ONLY | Event/SQLite/Archive | [H4 candidate](phase-1-contract-only-candidate.md) | Gate R 证明真实失败 Attempt 在重启和归档后仍可查 | Storage |
| A-02 | CONTRACT_ONLY | Independent verifier | [PR #5 readiness](first-vertical-slice-pr5-readiness.md) | Gate R 用真实 Connector 重复同一语义 | Flow |
| X-01 | NOT_PROVEN | Gate R-1 Codex receipt-derived `NONE`；create 超时，interrupt 未证明 | [Gate R-1 runtime](gate-r1-runtime-connectors.md) | 固定受支持接口并补 structured launch/interrupt、权限和 cleanup 收据 | Runtime |
| X-02 | NOT_PROVEN | Gate R-1 CodeBuddy receipt-derived `NONE`；executable 缺失 | [Gate R-1 runtime](gate-r1-runtime-connectors.md) | 用户完成合法安装/login 后运行 ACP/headless 原子场景 | Connectors |
| X-03 | NOT_PROVEN | Gate R-1 Cursor receipt-derived `NONE`；仅 version/help 发现 | [Gate R-1 runtime](gate-r1-runtime-connectors.md) | Windows 实机执行 login、workspace open、Handoff、Artifact 和 human receipt | Connectors |
| X-04 | CONTRACT_ONLY | Capability receipt/UI | [Vertical slice acceptance](vertical-slice-acceptance.md) | Gate R 由真实 capability receipt 验证降级文案 | Runtime |
| O-01 | NOT_PROVEN | Gate R-1 `discover_runtime` 通过；launcher hang 与其余缺口保留 | [Gate R-1 runtime](gate-r1-runtime-connectors.md) | 等公开 fixture confinement、registration cleanup 与 restart 接口后重测 | Runtime |
| S-01 | CONTRACT_ONLY | Durable operation/Fake | [Runtime reliability](runtime-reliability.md) | Gate R 在真实 Provider 启动前后注入崩溃 | Storage |
| S-02 | CONTRACT_ONLY | Startup recovery/Fake | [PR #5 readiness](first-vertical-slice-pr5-readiness.md) | Gate R 重连真实 session 或保持 needs_attention | Storage |
| S-03 | CONTRACT_ONLY | 临时 SQLite/文件/CAS fixture | [Task 4 backup/restore](phase-1-backup-restore.md) | Gate R 用脱敏真实规模数据重跑隔离恢复 | Storage |
| K-01 | CONTRACT_ONLY | Archive worker/crash resume | [H4 candidate](phase-1-contract-only-candidate.md) | Gate R 用真实终态 outcome 重跑归档恢复 | Knowledge |
| K-02 | CONTRACT_ONLY | Knowledge selection receipt + Handoff data boundary | [Task 8 Knowledge safety](phase-1-knowledge-handoff-safety.md) | Gate R 用真实 Connector 验证来源呈现、预算和 verifier 行为 | Knowledge |
| M-01 | NOT_PROVEN | PWA contract/viewport、带时间的离线 Run cache；Artifact 摘要未实现 | [Task 9 mobile safety](phase-1-mobile-offline-safety.md) | Gate R 在真实手机验证查看、锁屏、弱网、缓存时间和 Artifact 摘要 | Device |
| M-02 | CONTRACT_ONLY | Fake device security E2E、Gate allowlist、幂等 outbox | [Task 9 mobile safety](phase-1-mobile-offline-safety.md) | Gate R 用真实设备验证审批、撤销和离线重复请求 | Device |
| SEC-01 | CONTRACT_ONLY | 临时 database/log/export/prompt/diagnostic fixture | [Task 5 diagnostics](phase-1-diagnostic-bundle.md) | Gate R 对真实生产输出逐字节重跑 canary | Security |
| SEC-02 | CONTRACT_ONLY | Policy/negative scan | [Foundation gate](foundation-local-gate.md) | Gate R 检查真实 Provider 默认权限和高危 Gate | Security |
| LNX-01 | PASS | `54f5d90` Ubuntu CI | [Phase 1 baseline](phase-1-hardening-baseline.md) | 每个后续 HEAD 继续运行 Ubuntu quality/vertical-slice | CI |
| GOLDEN-01 | CONTRACT_ONLY | Fake vertical slice | [Vertical slice acceptance](vertical-slice-acceptance.md) | Gate R 用真实 Codex/CodeBuddy 和非玩具 Change 验收 | Product |
| GOLDEN-02 | CONTRACT_ONLY | 两个真实临时 Git worktree | [H4 candidate](phase-1-contract-only-candidate.md) | Gate R 用真实 Provider writer 重跑 join/conflict | Flow |
| GOLDEN-03 | CONTRACT_ONLY | Fake verifier/Loop/Archive | [H4 candidate](phase-1-contract-only-candidate.md) | Gate R 用真实失败 Evidence 和预算重跑 | Flow |
| GOLDEN-04 | NOT_PROVEN | Cursor 未完成真实 handoff | [Phase 0 decision](phase-0-decision.md) | Gate R 需要 Windows workspace、人工修改和 verifier receipt | Connectors |
| GOLDEN-05 | CONTRACT_ONLY | Fake recovery | [Runtime reliability](runtime-reliability.md) | Gate R 强制重启真实 Provider 并证明无重复 Session | Runtime |
| GOLDEN-06 | NOT_PROVEN | Fake device + 浏览器 fixture；未知/高风险 Gate 默认不下发 | [Task 9 mobile safety](phase-1-mobile-offline-safety.md) | Gate R 在真实手机执行普通/高风险 Gate 与断网重放 | Device |
| NFR-REL-01 | CONTRACT_ONLY | Event actor/correlation | [H4 candidate](phase-1-contract-only-candidate.md) | Gate R 对真实运行的全部命令投影做覆盖检查 | Storage |
| NFR-REL-02 | CONTRACT_ONLY | Fault injection/Fake | [Runtime reliability](runtime-reliability.md) | Gate R 对真实 side effect 重复同一矩阵 | Runtime |
| NFR-REL-03 | CONTRACT_ONLY | 一致性 manifest/隔离恢复 fixture | [Task 4 backup/restore](phase-1-backup-restore.md) | Gate R 验证真实规模、介质故障和保留策略 | Storage |
| NFR-REL-04 | CONTRACT_ONLY | 三次未完成 full attempt 均保留；第四次在冻结源码上运行 86,410,499 ms、1,442 cycle，精确调度、24 轮故障矩阵和五项检查全部通过 | [Task 11 soak](phase-1-soak.md) | Gate R 用真实 Provider、真实设备和生产规模重复长时故障与恢复矩阵 | Testkit |
| NFR-PERF-01 | CONTRACT_ONLY | JSDOM + 固定 64 Projects / 14 Steps，p95 分别 26.035 / 9.960 ms | [Task 11 performance](phase-1-performance.md) | Gate R 在真实浏览器和生产规模重跑 1 秒目标 | Performance |
| NFR-PERF-02 | CONTRACT_ONLY | ledger → reader → durable SSE → 本地 JSDOM UI，p95 114.431 ms | [Task 11 performance](phase-1-performance.md) | Gate R 在真实浏览器、真实设备和真实 Provider 重跑 500ms 目标 | Performance |
| NFR-PERF-03 | CONTRACT_ONLY | 128 历史 Runs + 固定 10 read/wait + 4 端到端关联 active Fake，p95 13.404 ms | [Task 11 performance](phase-1-performance.md) | Gate R 用真实 Provider 和持续负载验证吞吐、延迟及公平性 | Performance |
| NFR-PERF-04 | CONTRACT_ONLY | 大日志有界分页、逻辑配额、保留点和慢客户端背压 | [Task 7 resource bounds](phase-1-resource-bounds.md) | Gate R 验证真实规模、磁盘水位和长时慢客户端恢复 | Storage/UI |
| NFR-PORT-01 | CONTRACT_ONLY | 可读文件 + manifest 恢复 | [Task 4 backup/restore](phase-1-backup-restore.md) | Gate R 在独立安装环境验证读取与迁移 | Knowledge |
| NFR-PORT-02 | NOT_RUN | Export/Import 未产品化 | [Roadmap](../09-migration-and-roadmap.md) | 保持 Phase 2，除非 H1 备份恢复直接需要 | Product |
| NFR-PORT-03 | CONTRACT_ONLY | Provider-neutral Fake | [Foundation gate](foundation-local-gate.md) | Gate R 用第二个真实 Provider swap 验证 | Architecture |
| NFR-PORT-04 | CONTRACT_ONLY | 公共 schema/path/双平台门禁 | [H4 candidate](phase-1-contract-only-candidate.md) | Gate R 在实际 Windows/Linux 安装路径重跑 | Architecture |
| NFR-OBS-01 | CONTRACT_ONLY | Run 到 Archive correlation | [H4 candidate](phase-1-contract-only-candidate.md) | Gate R 用真实 Provider 全链对账 | Observability |
| NFR-OBS-02 | CONTRACT_ONLY | schema v1 allowlist diagnostic bundle | [Task 5 diagnostics](phase-1-diagnostic-bundle.md) | Phase 2 产品化用户预览；Gate R 验证真实故障数据 | Security |
| NFR-OBS-03 | CONTRACT_ONLY | Run/Attempt/Attention/Evidence UI | [Task 6 Attention actions](phase-1-attention-actions.md) | Gate R 用真实 Provider receipt 验证 action 可用性和恢复结果 | Workbench |
| NFR-OBS-04 | CONTRACT_ONLY | 规范事件优先 | [PR #5 readiness](first-vertical-slice-pr5-readiness.md) | Gate R 关联真实原始事件 hash 而不暴露协议噪音 | Runtime |
| BLOCK-01 | CONTRACT_ONLY | verifier 才能成功 | [PR #5 readiness](first-vertical-slice-pr5-readiness.md) | Gate R 用真实 Agent return 重测 | Flow |
| BLOCK-02 | CONTRACT_ONLY | revision immutable/pinned Run | [H4 candidate](phase-1-contract-only-candidate.md) | Gate R 用真实审批和运行重测覆盖负例 | Domain |
| BLOCK-03 | CONTRACT_ONLY | isolated worktree/join conflict | [H4 candidate](phase-1-contract-only-candidate.md) | Gate R 用真实 Provider 并行 writer 重测 | Runtime |
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
- Codex、CodeBuddy、Cursor 的 Gate R-1 manifest 均为 receipt-derived `NONE`；真实移动
  设备也没有完整 Phase 1 通过证据；
- 当前 registry 摘要的 22 个 high severity 依赖项尚未分类，不能写成已修复或可利用；
- Task 11 的 24h 与固定 SHA 双平台 CI 已完成，NFR-REL-04 仅冻结为
  `CONTRACT_ONLY`；
- H4 本机候选已覆盖 P-02、W-01 和 Golden-2 等自动缺口，完整门禁和未签名
  Windows 打包已通过；`006fbbf` 与最终审查修复后的 `d31acabc` 均完成
  push + PR 8/8 CI。证据写回后的最终提交 CI 与 merge 必须以 PR #17 外部状态
  核验，不能从旧 SHA 外推；
- 生产 Provider、代码签名、分发和发布保持阻断。
