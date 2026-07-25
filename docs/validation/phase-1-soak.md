# Phase 1 24 小时 soak 验证

- 日期：2026-07-25
- 数据集：`phase1-fixed-v1`
- 证据范围：`contract_only`
- 完整 24 小时状态：`NOT_PROVEN`（两次尝试均保留，修复门禁判定后需从零重跑）
- smoke 状态：`NOT_PROVEN`
- smoke 原始证据：
  [`evidence/phase1/soak-smoke.json`](evidence/phase1/soak-smoke.json)
- smoke SHA-256：
  `7972B3227AC106652093E5C3DDFDEBC724B498263E9F2698ED2DDFA24FB5AAC2`
- 产品版本：`0.0.0`
- 基线 revision：`0087fe4736580fadd6a47b338bd16f8cc2869df7`
- 源码 digest：
  `40efe43fe9e40c5b1d9c789fa28621cb883a1acc292476e43be1170ec08df1f0`

## 当前结论

短时 smoke 已真实运行 1,705 ms、4 个 cycle，并覆盖：

- 4 次 loop，新 Attempt 没有覆盖失败 Attempt；
- 2 次独立子进程 restart workload：每次提交并由 `OperationWorker` 执行一个
  持久化 canary operation，再与 receipt/Fake Provider effect 对账；
- 2 次 archive publication；
- 2 次 projection rebuild；
- 完整 12 项故障矩阵；
- 4 个 cycle operation + 2 个 restart operation，共 6 个 completed outbox、
  receipt、Provider invocation 和 Provider native effect；
- 无重复外部操作、无 false success、资源增长有界、状态可解释、失败历史保留。

这些检查全部为 true，但 smoke 不是 24 小时运行，因此必须保持
`NOT_PROVEN`，不能写成 PASS。真实 24 小时命令尚未完成前，
`NFR-REL-04` 保持 `NOT_PROVEN`。

## 第一次长时尝试：保留为 NOT_PROVEN

第一次 full 进程在第 24 个 durable cycle 后、进入第 25 个 cycle 的边界停止。
停止前的两个 SQLite 文件均通过 `integrity_check=ok`，没有外键错误；Hunter
ledger 保留 104 个 event、28 个 completed outbox 和 28 个 receipt，独立 Fake
Provider ledger 保留 28 个 invocation/effect，另有 4 个跨进程 restart canary 和
2 次 archive。所有已提交 operation ID 一一对应，没有发现重复 Provider effect。

旧实现把失败 envelope 写回唯一的 latest checkpoint，且安全错误映射只留下
`UNKNOWN_PHASE1_FAILURE`，因此无法从证据中恢复更精确的瞬时触发点。现有事实只
能定位到 cycle 外的 evidence/checkpoint 边界；不能据此虚构具体根因或 PASS。
失败 envelope 已按内容哈希保留在
[`soak-24h.attempts/288f9219743788ff1532af963b94ac04fad5eb255f9bf82f5759dfa5cd8135ff.json`](evidence/phase1/soak-24h.attempts/288f9219743788ff1532af963b94ac04fad5eb255f9bf82f5759dfa5cd8135ff.json)，
SHA-256 为
`288F9219743788FF1532AF963B94AC04FAD5EB255F9BF82F5759DFA5CD8135FF`。

修复后，full 模式先把可恢复 checkpoint 原子写入独立的
`.json.state/checkpoint.json`，再更新 latest evidence；Windows 上的原子 rename
对 `EACCES`、`EBUSY`、`EPERM` 做有界退避重试。即使 latest evidence 写入失败，
下一进程仍可从独立 checkpoint 恢复，失败 envelope 也会在新 attempt 前归档。
这些修复已经通过注入 evidence sink 失败后的持久状态恢复测试；既有跨进程
强制终止演练也证明 runner 能从匹配 checkpoint 恢复，但完整 24 小时时钟必须从零
重新开始。

另在当前源码上执行了短时实机恢复演练：独立 full 进程写出首个 checkpoint 后被
强制终止，第二个 Node 进程从同一 JSON 与 `.state` 恢复。恢复后的安全摘要为
`status=NOT_PROVEN`、`cycles=3`、`restarts=1`、`restartOperations=1`，
receipt、Provider invocation、Provider native effect 和 outbox 均为 4；
`noDuplicateExternalOperations=true`、`allStatesExplainable=true`。原始临时目录
包含绝对本机路径，因此只保留此脱敏摘要，且没有把该演练写成 24 小时 PASS。

## 第二次长时尝试：门禁审计主动停止

第二次 full 进程使用 revision
`0087fe4736580fadd6a47b338bd16f8cc2869df7` 和源码 digest
`40efe43fe9e40c5b1d9c789fa28621cb883a1acc292476e43be1170ec08df1f0`
从零运行 4,200,533 ms，完成 71 个 durable cycle、14 次 restart、7 次 archive、
2 次 projection rebuild、71 次 loop 和 1 轮完整故障矩阵。85 个 completed
outbox、receipt、Provider invocation 和 Provider native effect 一一对应；
high-water position 与 projection position 均为 312，false success 为 0，
五项检查全部为 true。

该进程跨过了第一次尝试的停止边界，但在收尾审计中发现 resolver 层的 `PASS`
判定只要求 restart、archive、rebuild、loop 和 fault matrix 各至少一次，没有按
冻结的 cycle/interval 调度核对计划次数。外层 evidence schema 已有精确计数
refinement，因此不会落盘错误 `PASS`；但两层判定不一致会让 resolver 先选择
`PASS`、随后被 schema 拒绝，使本应可判定的 24 小时运行以失败 envelope 结束。
因此主动停止并保持 `NOT_PROVEN`，不能用已通过的 71 个 cycle 代替完整 24 小时。
证据按内容哈希保留在
[`soak-24h.attempts/b14cd8e77fabbfa988278b5b6a2cddf4e62e3ce19f904c0b92be8ade8ef3c920.json`](evidence/phase1/soak-24h.attempts/b14cd8e77fabbfa988278b5b6a2cddf4e62e3ce19f904c0b92be8ade8ef3c920.json)，
SHA-256 为
`B14CD8E77FABBFA988278B5B6A2CDDF4E62E3CE19F904C0B92BE8ADE8EF3C920`。

修复后的 full 判定按实际 cycle 数推导计划内次数：archive、rebuild、loop 和
fault matrix 必须精确匹配；restart 分为 `scheduledRestartCount` 和
`recoveryRestartCount`，总数必须等于两者之和，计划重启必须精确匹配调度，进程
恢复产生的额外 canary 只计入恢复重启，并继续由 operation、receipt 和 Provider
effect 对账。修复已通过“缺少一次”“重复一次”和“恢复重启掩盖计划重启缺口”的
真实 RED，再完成精确回归；新的 24 小时窗口必须使用修复后的源码身份从零开始。

## 固定长时配置

- 实际 monotonic wall time：86,400,000 ms；
- 每 60 秒一个持久化 operation cycle，预计约 1,440 个 cycle；
- 每 5 cycle 重启、每 10 cycle 归档、每 30 cycle 重建 projection；
- 每个 cycle 创建一个新 loop Attempt；
- 每 60 cycle 运行完整故障矩阵；
- Fake domain clock 与随机 seed 固定，主机 wall clock 只用于 24 小时门禁；
- 每个 cycle 的 PASS/FAIL attempt 都保留；首个失败立即停止，不自动重跑成 PASS；
- SIGINT/SIGTERM 只生成 `NOT_PROVEN`，不能推定 PASS；
- full 模式被中断时退出码非 0；smoke 的明确 `NOT_PROVEN` 才允许作为 smoke
  命令成功退出；
- 只有 wall time、最少 1,440 cycle、计划内机制按实际 cycle/interval 精确对账、
  全部 fault matrix 和所有五项检查同时达标才能生成 `PASS`；合法进程恢复产生的
  额外 restart canary 必须单独计数，并与 operation、receipt 和 Provider effect
  一一对应；
- heap growth 上限 256 MiB、RSS growth 上限 512 MiB、database 绝对上限
  512 MiB、archive 64 MiB、checkpoint 16 MiB；另保留每 cycle 256 KiB 的
  增长上限。

将 cycle 间隔固定为 60 秒可保留每次 attempt，同时避免每秒生成约 8.6 万条证据
和持续重写无界增长的 checkpoint 文件。

## 复现

短时门禁：

```powershell
npm run verify:phase1-soak-smoke
```

真实 24 小时门禁：

```powershell
npm run soak:phase1
```

长时命令会先原子写入 `NOT_RUN` envelope，运行后把可恢复 checkpoint 写入独立
`.json.state/checkpoint.json`，再把 latest evidence 更新为 `NOT_PROVEN`。稳定的
`.json.state` 目录保存 Hunter SQLite、独立 Provider effect SQLite 和归档；新进程
只在 build、dataset、execution 配置都匹配时恢复同一运行。
每次恢复也执行一个持久化 restart canary，并将 receipt/outbox/provider IDs 重新
对账。只有完整结束且所有不变量满足才写入 `PASS`。旧 latest 在新 attempt 前按
内容 SHA-256 归档。Fake Runtime 只证明 Hunter 契约，不验证真实 Provider。
