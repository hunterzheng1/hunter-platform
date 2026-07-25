# Phase 1 性能与故障矩阵验证

- 日期：2026-07-25
- 数据集：`phase1-fixed-v1`
- 证据范围：`contract_only`
- 本机：Windows 10.0.26200、x64、Node.js v24.14.0、16 logical cores
- 原始证据：
  [`evidence/phase1/performance.json`](evidence/phase1/performance.json)
- SHA-256：
  `EF7ACE4AF5DF3036552989539F35FE4B543C9AF71C1BFA87F34C93104363B479`
- 产品版本：`0.0.0`
- 基线 revision：`0087fe4736580fadd6a47b338bd16f8cc2869df7`
- 源码 digest：
  `40efe43fe9e40c5b1d9c789fa28621cb883a1acc292476e43be1170ec08df1f0`

## 结论

固定数据集的本机基准为 `PASS`。这只证明 Hunter 的 JSDOM 页面、
SQLite 路径和确定性 Fake Runtime 在本次固定环境中满足契约阈值，不证明任何真实
Provider、真实浏览器或生产规模。

| 指标 | 固定负载 | p95 | 阈值 | 结果 |
|---|---|---:|---:|---|
| Project 列表可交互 | 64 Projects | 17.835 ms | < 1,000 ms | PASS |
| Run 页面可交互 | 14 Steps（10 read/wait + 4 active Fake） | 6.271 ms | < 1,000 ms | PASS |
| Event 到本地 UI 可见 | ledger → reader → durable SSE → RunPage | 125.228 ms | < 500 ms | PASS |
| 并发工作负载 | 128 历史 Runs + 10 read/wait + 4 active Fake | 19.913 ms | < 500 ms | PASS |

每项包含 5 次 warmup 和 30 次 measured sample；报告同时保留
min、p50、p95 和 max。阈值由验收规范固定，运行器不能因未达标而降低阈值。
schema 同时要求每项恰有 30 个样本，且 `min <= p50 <= p95 <= max`。

Event 测量由真实本地 `SqliteOperationJournal` 写入 ledger，经
`EventLedgerReader`、`DurableEventStream` 和 React `RunPage` 刷新后停止计时。
并发测量先写入固定 seed 生成的 128 个历史 Run 事件，再让 4 个
`OperationWorker` 共用一个确定性 Fake Runtime，同时渲染 10 个只读/等待 Step
和 4 个活跃 Step。4 个活跃 Attempt 在 UI、`AttemptAssigned` ledger event、
outbox operation、side-effect receipt 和 Fake Provider effect 中使用同一组 ID；
`linkedActiveStepCount=4`，各层 operation/receipt/effect 计数均为 4。

## 故障矩阵

以下 12 个独立场景均为 `PASS`，每个失败注入和恢复观察均保留为单独、有序的
history entry：

1. commit 前崩溃；
2. commit 后崩溃；
3. dispatch 前崩溃；
4. dispatch 后崩溃；
5. receipt 前崩溃；
6. receipt 后崩溃；
7. projection 丢失与 ledger rebuild；
8. archive publication 中断；
9. SQLite disk full；
10. SQLite read-only；
11. SSE retention gap；
12. mobile command replay。

`crash_after_dispatch` 的不可安全重放路径收敛为 `needs_attention`，没有推定成功；
可检查路径恢复时外部操作最多一次。disk-full 场景还暴露并修复了一个真实错误：
SQLite 已自动结束事务时，journal 的无条件 `ROLLBACK` 会覆盖原始
`SQLITE_FULL`。回归测试现在要求保留原始存储错误，再由显式恢复动作继续。
commit 前/后场景使用 journal 事务边界 fault injection，并关闭、重新打开 SQLite
连接后检查持久事件和 receipt：commit 前为 0 条，commit 后为 1 条且重放不增加。

所有场景的 duplicate external operation 和 false success 均为 0。Agent return、
process exit、terminal idle、window opened 仍只是事实，不能完成 Step。

## RED → GREEN 历史

- RED：load fixture、benchmark 与 soak 模块不存在，精确测试真实失败；
- RED：首个 fault matrix 揭示 operation version/fingerprint 重用错误；
- RED：disk-full 注入真实得到 `SQLITE_FULL`，但被二次 rollback 错误覆盖；
- RED：正式 benchmark 首次运行因 JSX 执行环境缺少全局 React，
  `ReferenceError: React is not defined`；
- RED：复核发现 Event/UI 与 10+4 最初没有贯穿真实 ledger/SSE/UI，且三层
  Attempt ID 不一致；
- RED：对抗 schema 发现样本数、分位数单调性和 fault matrix 集合仍可构造矛盾
  PASS；
- GREEN：使用固定 schema、独立 operation fingerprint、事务状态检查和明确的
  React/JSDOM 测量边界后，再加入真实 ledger/SSE/UI、共享 Fake Runtime、
  端到端 ID 对账和严格 schema，正式命令退出码为 0，四项指标和 12 个故障场景
  通过。

失败历史没有删除或改写成 PASS。`performance.json` 是当前 attempt；每次重跑前，
旧文件按内容 SHA-256 移入 `performance.attempts/`，因此旧 FAIL、NOT_PROVEN 或
superseded PASS 均可追溯。

## 复现

```powershell
npm run verify:phase1-performance
```

该命令先构建所需 workspace，归档旧 attempt，再原子写入版本化 JSON。报告只记录 allowlist
主机摘要，不包含 hostname、用户名、绝对用户路径、环境变量、token、cookie、
API key 或私有 Prompt。

## 依赖摘要

同一 worktree 的 `npm install` 退出码为 0、lockfile 已同步；registry 摘要报告
22 个 high severity。该数字尚未经过 production reachability、修复版本或破坏性
升级风险分类，因此保持 `NOT_PROVEN`，没有运行 `npm audit fix` 或
`npm audit fix --force`。
