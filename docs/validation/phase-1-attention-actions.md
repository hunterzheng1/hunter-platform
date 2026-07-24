# Phase 1 Attention action 与恢复可操作性

- 日期：2026-07-24
- 平台：Windows `10.0.26200`
- 分支：`codex/phase1-attention-actions`
- 基线：`main@40d0613299170e98ab7e23490bf38890df57b5e3`
- 证据范围：`contract_only`

## 实现边界

- API 增加 provider-neutral `AttentionItem`：固定 reason code、required actor、
  Change/Workflow/Requirement revision、固定输入 hash、canonical Evidence
  ID/hash 或 durable Flow event ID/hash 引用和允许动作；
- waiting、failed、stale、needs_attention 以及 verifier failed/error/needs_human
  的 Run view 必须携带 Attention，正常 Attempt 禁止夹带 Attention；
- action 请求是严格判别联合，只接受固定字段、`expectedVersion` 和
  `idempotencyKey`；不存在任意 path、任意 terminal control、原始 Provider
  payload 或“标记成功”命令；
- daemon 的 `GET /api/v1/runs/:runId` 从 SQLite Flow ledger 生成严格 RunView，
  包含 `aggregateVersion`、projection position、完整 Attempt 历史与 Attention；
- 外部结果确认会验证 Evidence ID 属于当前 Attempt 且 content hash 与 durable
  Evidence 一致，再把人工 actor、Evidence ID 和 hash 写入
  `ExternalObservationRecorded` 历史；
- waiting input 和 human verifier 可引用 ledger 中真实存在且内容 hash 可复算的
  Flow event；投影不再 mint 未写入 `evidence_records` 的 `evd_*`。人工 verifier
  收据把 branded `sourceEventId` 和 hash 写入 Flow 历史，外部结果确认仍只接受
  canonical `evidence_records`；
- agent return、structured process exit、session running/missing 都只是观察；
  response 只能写 `unchanged` 或 `verifier_required`，不能宣称 Step 成功；
- 人工 verifier 收据分别审计 Evidence hash 与 acknowledged fixed-input hash，
  不混淆两个内容域；人工通过可以产生 verifier success，但外部观察不能；
- “创建新 Attempt”由 FlowEngine 与投影共享同一恢复守卫，校验当前 Attempt、
  retry limit、已预留 child budget、attempt/elapsed/cost/token/loop 全部预算；
  即使 Run 已失败也只追加 `StepActivated` 并保留旧 Attempt，不覆写失败历史；
- “重新检查”只有在该 action 的 CapabilityProbeReceipt 对 `observe` 给出
  `supported` 时才可用；请求显式绑定展示的 receipt ID，执行和 Flow 事件审计
  同一 ID，unsupported/unknown/缺失收据会禁用并展示 receipt-derived reason；
- SQLite 重查由 action idempotency key 生成新 observe operation：同 key 重放
  同一检查，新 key 执行新的有界观察，不会永久复用 settlement 旧结果；
- 每个 Attention action 会先以完整 API payload 建立 durable reservation；
  相同 key 改 action、text、Evidence hash 或 acknowledged hash 均冲突。真实
  `SqliteFlowStore` 测试覆盖 multi-event receipt 中的目标事件重放；
- Web 使用当前 `aggregateVersion` 发动作；传输结果不明确时保留相同
  idempotency key，成功文案明确提示仍需 verifier 或状态未直接完成。

本批没有新增真实 Provider 私有字段、任意终端控制、生产 Provider 验证、产品
发布或把 Fake/fixture 结论升级为真实能力。

## RED → GREEN 记录

1. Attention schema 首次测试 3/3 真实失败：schema 未定义，Run view 也接受缺少
   Attention 的失败状态；实现严格 schema 后转绿。
2. 旧 Run/client/page fixture 因新增 Attention 和 aggregate version 真实出现
   4 个失败及 collection 错误；补齐显式状态后 4 files / 19 tests 通过。
3. daemon service 首次在 collection 阶段失败：
   `Cannot find module '../src/services/attention-action-service.js'`；最小服务后
   幂等、version、disabled action 和历史 Attempt 负例转绿。
4. route 首次两个请求均返回 404；加入 Run scope 授权和 strict request/
   response 校验后 2/2 通过。
5. Web client 首测因 `executeAttentionAction` 不存在失败；实现 pending-command
   重放后，同一逻辑动作在不明确传输失败后复用原 body/key。
6. Attention Panel 首次 collection 失败；实现后先暴露未配置 `jest-dom`，再因
   文本被 code 节点分割而失败；改用原生 disabled 状态和结构匹配后转绿。
7. Run 页面首次找不到“重新检查外部状态”按钮；接入 StepDetail 后旧测试因新增
   可见原因/Evidence 出现重复匹配，收紧断言后 UI 2 files / 10 tests 通过。
8. Flow/daemon 新 RED 分别显示人工观察收据为 `undefined`、创建新 Attempt 返回
   `ATTENTION_ACTION_NOT_IMPLEMENTED`；加入审计事件与恢复命令后
   2 files / 57 tests 通过。
9. strict typecheck 真实发现 human receipt 校验误插入 cancel command，以及一处
   旧 state fixture 缺新字段；移动到 observation 边界并更新 fixture 后通过。
10. durable observe Attention 测试加入 running/missing/returned 映射后
    1 file / 11 tests 通过。
11. SQLite 适配器首测 2/2 失败，原因是测试从错误 package 导入
    `createWorkflowRunBinding`；修正导入后 2/2 通过。
12. EvidenceRef/能力约束首轮 7 files / 30 tests 有 5 个真实失败：旧 fixture
    缺 hash、UI 仍读取 `evidenceIds`、retry 未带 receipt；补齐公共引用和表单后转绿。
13. fresh recheck 复审发现旧 deterministic settlement receipt 会永久遮蔽新状态；
    将 action key 纳入 observation ID 后，同 key 重放/new key 新观察测试转绿。
14. 人工 receipt 复审发现 Evidence hash 与 fixed input hash 被错误等同；拆分
    `evidenceContentHash` 与 `acknowledgedInputHash` 后 Flow/adapter/UI 转绿。
15. 生产 RunView RED 暴露 daemon 缺 GET、failed 终态找不到 active Step、恢复预算
    投影遗漏 child/token/loop；加入 SQLite projector、终态 append-only recovery 和
    共享 guard 后，7 类 required Attention 状态矩阵通过。
16. 全量门禁首次 lint 因测试 double 未使用参数失败；第一次修复又触发 TypeScript
    zero-argument mock tuple 错误；保留参数并显式 `void` 后全量转绿。
17. 最终独立复审指出 failed 终态 UI 无法恢复、终态可能先执行外部重检、Loop
    back-edge 选错 Step、未持久化 `evd_*` 占位和详细 version conflict 落入 500；
    新增的 5 files / 87 tests 首轮有 6 个真实失败。收窄终态动作、由服务端
    enabled action 控制 UI、优先定位 active Step、引入 branded durable Flow
    event ref，并固定冲突映射后，精确套件 12 files / 134 tests 转绿。
18. `npm run verify:foundation` 的首次最终串联在 lint/typecheck 通过后，因 Windows
    对 Vite 临时配置写入返回一次 `EPERM` 而真实失败。检查 `.vite-temp` 已为空且
    无本轮残留 Node 进程后，单独重跑 `npm test` 为 114 files / 1003 tests PASS；
    rebuild、recovery、backup/restore、diagnostics 和 build 随后分别 PASS。该失败
    历史保留，最终串联结果见下表。
19. 第二轮独立复审进一步覆盖 Loop back-edge 后 earlier Step 直接 terminal
    failure 的组合，首轮真实返回 `RECOVERY_ATTEMPT_NOT_CURRENT`。Flow state
    增加 branded `lastActivatedAttemptId`，Flow command、RunView 和 action state
    共享 `currentRecoveryStep`；RunView 还投影全 Run 唯一的 server-authoritative
    `isCurrent`，Web 不再按 Step 数组顺序推断。新增回归后精确套件为
    12 files / 135 tests，全量为 114 files / 1004 tests。
20. 最终串联第二次在相同 `.vite-temp` 写入边界复现 `EPERM`；系统化对照显示
    default bundle loader 需要该临时写入，而紧接 typecheck 的 Vite `runner` 和
    Node 24 `native` loader 均可完成全套。并行 native 运行会让一个 Windows
    实机 path 边界测试因资源竞争按设计标为 `NOT_PROVEN` skip；关闭 file
    parallelism 后 1004 项全部执行。Foundation 因此只在串联内使用
    `--configLoader native --no-file-parallelism`，常规 `npm test` 保持原命令；
    这避免用 sleep、重试或 skip 掩盖 Windows 文件锁。修改后最终
    `npm run verify:foundation` 串联 exit 0。

所有失败历史均保留，没有把 404、collection、断言、类型或导入错误改写为 PASS。

## 当前精确验证

| 命令 | 结果 |
|---|---|
| `npx vitest run packages/api-contracts/src/attention.test.ts packages/api-contracts/src/run-view.test.ts packages/flow-engine/src/flow-engine.test.ts workflow-packs/hunter-default/src/flow-engine-contract.test.ts apps/daemon/test/attention-action-service.test.ts apps/daemon/test/attention-actions-route.test.ts apps/daemon/test/sqlite-attention-actions.test.ts apps/daemon/test/sqlite-attempt-observation.test.ts apps/daemon/test/sqlite-run-view.test.ts apps/web/src/api/run-client.test.ts apps/web/src/components/attention-panel.test.tsx apps/web/src/pages/run-page.test.tsx` | PASS；12 files / 135 tests |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm test` | PASS；114 files / 1004 tests |
| `npm run build` | PASS |
| `npm run verify:foundation` | PASS；lint、typecheck、114 files / 1004 tests（native config loader、no file parallelism）、rebuild、recovery、backup/restore、diagnostics、build 全部完成；此前两次 bundle-loader `EPERM` 失败历史保留 |

`git diff --check` 将在提交前运行。
PR head GitHub Actions 尚未运行，因此远端 Windows/Ubuntu CI 为 `PENDING`，不能
继承 PR #10 或旧 SHA 的结论。

## 结论边界

- 本证据证明 Hunter Attention contract、Flow history、SQLite fixture、路由和
  Web 行为，不证明真实 Runtime Provider 的 observe/retry 能力；
- Capability 状态只由输入的 probe receipt 计算，未按 Orca、Codex、
  CodeBuddy、Cursor 或其他产品名称硬编码；
- Fake Runtime 与测试 receipt 仍是 `CONTRACT_ONLY`；真实 Provider 均保持
  `NOT_PROVEN`；
- 未执行真实 Agent 写操作、真实移动设备、签名、分发或生产发布。
