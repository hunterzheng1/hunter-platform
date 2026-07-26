# Phase 1 24 小时 soak 验证

- 日期：2026-07-25 至 2026-07-26
- 数据集：`phase1-fixed-v1`
- 证据范围：`contract_only`
- 完整 24 小时状态：`PASS`（三次未完成尝试均保留，第四次满足全部门槛）
- 完整 24 小时原始证据：
  [`evidence/phase1/soak-24h.json`](evidence/phase1/soak-24h.json)
- 完整 24 小时 SHA-256：
  `A1BEFD74AE6B5B3728A908C20E1A0B28F06C0EBB2753AE3644F26B504985BCAA`
- smoke 状态：`NOT_PROVEN`
- smoke 原始证据：
  [`evidence/phase1/soak-smoke.json`](evidence/phase1/soak-smoke.json)
- smoke SHA-256：
  `F87C80E624A54CF95F847689AA1B2F2D5D90817279E34C9C267AA11D883E23FB`
- 产品版本：`0.0.0`
- 基线 revision：`19f4870d7f72ae8e5abc4ba1fd2401a377facbd8`
- 源码 digest：
  `ac47e6fcb226e17f8864ceeb32304598d13e1b7d13b232cdf90c68a9f4a98b6d`

## 当前结论

短时 smoke 已真实运行 2,154 ms、4 个 cycle，并覆盖：

- 4 次 loop，新 Attempt 没有覆盖失败 Attempt；
- 2 次计划内独立子进程 restart workload、0 次恢复 restart：每次提交并由
  `OperationWorker` 执行一个持久化 canary operation，再与 receipt/Fake
  Provider effect 对账；
- 2 次 archive publication；
- 2 次 projection rebuild；
- 完整 12 项故障矩阵；
- 4 个 cycle operation + 2 个 restart operation，共 6 个 completed outbox、
  receipt、Provider invocation 和 Provider native effect；
- 无重复外部操作、无 false success、资源增长有界、状态可解释、失败历史保留。

这些检查全部为 true，但 smoke 不是 24 小时运行，因此其自身必须保持
`NOT_PROVEN`，不能写成 PASS。第四次 full 已满足完整 wall time、cycle、精确
调度、故障矩阵和五项检查，因此 `NFR-REL-04` 提升为 `CONTRACT_ONLY`。该状态
只证明冻结版本上的 Hunter + Fake/fixture，不证明真实 Provider、真实设备或生产
规模。

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

## 第三次长时尝试：检查点落后持久状态，保留为 NOT_PROVEN

第三次 full 进程使用 revision
`54c5d3a69aef58bdcf680484309f1e115fb35e76` 和源码 digest
`5e30c4f7f68cbb665fe1fc3d28b64fea636c4f518a0af7450f4c28005071ac5f`
运行至独立 checkpoint 的第 54 个 cycle：累计 3,182,859 ms、10 次计划重启、
5 次 archive、1 次 projection rebuild 和 54 次 loop，五项检查全部为 true。
但父进程随后以 `UNKNOWN_PHASE1_FAILURE` 退出；SQLite 完整性检查均为 `ok`。

进一步只读对账发现，两个数据库已持久化第 55 个 cycle 和计划重启 #11，而
checkpoint 仍停在 cycle 54、计划重启 10 次。恢复器基于旧 checkpoint 把 #11
误判为 recovery restart，并用 cycle 54 的 Fake 时间重放；Provider ledger 中
#11 已绑定 cycle 55 时间，因此正确拒绝为 `RESTART_PROBE_ID_REUSED`。该状态不能
在不推断或重写历史的前提下无损恢复，所以没有再次启动，也没有把已完成的 54 个
cycle 写成 PASS。

原始失败 envelope 保留在
[`soak-24h.attempts/7d2d4c9082b1e8cad141cbaabfe8aa3c9ad55b515c315f3c84fc8c722608eee3.json`](evidence/phase1/soak-24h.attempts/7d2d4c9082b1e8cad141cbaabfe8aa3c9ad55b515c315f3c84fc8c722608eee3.json)，
SHA-256 为
`7D2D4C9082B1E8CAD141CBAABFE8AA3C9AD55B515C315F3C84FC8C722608EEE3`；
最后一个可验证 checkpoint 保留在
[`soak-24h.attempts/855c4a6a98566b0bfd94599452c33b53fc4b4da398daff06650f54f8308f4a51.json`](evidence/phase1/soak-24h.attempts/855c4a6a98566b0bfd94599452c33b53fc4b4da398daff06650f54f8308f4a51.json)，
SHA-256 为
`855C4A6A98566B0BFD94599452C33B53FC4B4DA398DAFF06650F54F8308F4A51`；
被拒绝的恢复 envelope 保留在
[`soak-24h.attempts/0272b5ddfdd395aed259c2eeb31fa0b12b88d6bc74308e7bd725dbc5f7b5a37f.json`](evidence/phase1/soak-24h.attempts/0272b5ddfdd395aed259c2eeb31fa0b12b88d6bc74308e7bd725dbc5f7b5a37f.json)，
SHA-256 为
`0272B5DDFDD395AED259C2EEB31FA0B12B88D6BC74308E7BD725DBC5F7B5A37F`。

修复先在每个计划重启前持久化 cycle checkpoint；恢复时先按
`floor(cycle/restartEveryCycles)` 幂等补齐计划重启并单独 checkpoint，再执行
recovery canary 并再次 checkpoint。针对“计划重启已持久化但 checkpoint 未更新”
和“恢复过程再次中断”分别建立了真实 RED，再转为 GREEN；独立复审结论为
Critical 0、Important 0、Minor 0、READY。

## 第四次长时尝试：24 小时 PASS（contract_only）

第四次 full 进程于 2026-07-25 18:29:30 +08:00 从空状态启动，使用 revision
`19f4870d7f72ae8e5abc4ba1fd2401a377facbd8` 和源码 digest
`ac47e6fcb226e17f8864ceeb32304598d13e1b7d13b232cdf90c68a9f4a98b6d`。
首个计划重启边界的 checkpoint 为 `status=NOT_PROVEN`、`cycle=5`、
`scheduledRestartCount=1`、`recoveryRestartCount=0`、`restartCount=1`；
五项检查全部为 true。它仍需满足真实 86,400,000 ms 和至少 1,440 个 cycle，
当前不得声明 PASS。

首进程在 checkpoint 已完成 cycle 18 后，latest evidence 的 Windows 原子替换耗尽
有界重试并以 `PHASE1_EVIDENCE_RENAME_FAILED` 退出。独立 checkpoint 的 schema、
build、dataset 和 execution 均匹配；两个 SQLite 的 `integrity_check` 与
`quick_check` 均为 `ok`。数据库只领先一个已完成的幂等 cycle 19：22 个 outbox、
receipt 和 Fake Provider effect 一一对应，restart 仍为 3 次，因此保留失败
envelope 后用同一命令恢复。

该失败 envelope 保留在
[`soak-24h.attempts/5fb9b857d4082be467e318ef15eb91e7978032f7cfb25aaaa48ef0bdddaabc54.json`](evidence/phase1/soak-24h.attempts/5fb9b857d4082be467e318ef15eb91e7978032f7cfb25aaaa48ef0bdddaabc54.json)，
SHA-256 为
`5FB9B857D4082BE467E318EF15EB91E7978032F7CFB25AAAA48EF0BDDDAABC54`。

恢复进程先写入独立 recovery restart canary，再幂等重放 cycle 19；cycle 20
checkpoint 已重新满足 `scheduledRestartCount=4`、
`recoveryRestartCount=1`、`restartCount=5`、archive 2 次、loop 20 次和五项
检查全 true。此次恢复属于同一 attempt #4，不重置 elapsed、不覆盖失败历史，也
不能提前升级为 PASS。

第一次恢复进程随后在 checkpoint 已完成 cycle 41 后再次遇到同一
`PHASE1_EVIDENCE_RENAME_FAILED`。原始 stderr 未出现其他错误；checkpoint 仍通过
严格 schema 校验，build、dataset、execution 与冻结源码完全匹配，两个 SQLite 的
`integrity_check` 与 `quick_check` 仍为 `ok`。数据库只领先一个已完成的幂等
cycle 42：51 个 outbox、receipt 和 Fake Provider effect 一一对应，所有 Provider
invocation count 均为 1，event high-water 与 projection position 均为 186。

第二次失败 envelope 已按内容哈希保留在
[`soak-24h.attempts/a9158a76b7ce0fdd44932223da68b060f98becc705643969c67eb2c435913309.json`](evidence/phase1/soak-24h.attempts/a9158a76b7ce0fdd44932223da68b060f98becc705643969c67eb2c435913309.json)，
SHA-256 为
`A9158A76B7CE0FDD44932223DA68B060F98BECC705643969C67EB2C435913309`。
第二次恢复先新增独立 recovery restart canary，再幂等收敛 cycle 42；恢复后的
checkpoint 为 `scheduledRestartCount=8`、`recoveryRestartCount=2`、
`restartCount=10`、archive 4 次、rebuild 1 次、loop 42 次、fault matrix 0 次，
52 个 receipt、outbox、Fake Provider effect 完全对账，五项检查全 true。该状态
仍是同一 attempt #4 的 `NOT_PROVEN`；若本 attempt 第三次出现同类 rename 失败，
将停止恢复并按 TDD 扩大 Windows rename 耐久窗口，然后以新冻结身份从零重跑。

cycle 60 首次同时跨过计划重启、归档、projection rebuild 和 fault matrix 边界。
checkpoint 精确记录 `scheduledRestartCount=12`、
`recoveryRestartCount=2`、`restartCount=14`、archive 6 次、rebuild 2 次、
loop 60 次和 fault matrix 1 次。首轮 matrix 的 12 个 scenario
（commit/dispatch/receipt 三组 crash 前后、projection loss、archive
interrupted、disk full、read only、SSE gap、mobile replay）各产生一个独立
attempt，全部为 `PASS`；每个 attempt 的注入失败、预期拒绝或观察结果及后续恢复
历史均保留，duplicate external operation 与 false success 均为 0。主 workload
的 receipt、outbox、Fake Provider effect 均为 74，event high-water 与 projection
position 均为 268，五项检查全 true。该里程碑只证明当前时点的内部一致性，真实
elapsed 仍未达到 86,400,000 ms，因此总体状态继续为 `NOT_PROVEN`。

cycle 120 的第二轮故障矩阵审计继续对账：真实 elapsed 为 7,022,195 ms，
`scheduledRestartCount=24`、`recoveryRestartCount=2`、
`restartCount=26`、archive 12 次、rebuild 4 次、loop 120 次和 fault matrix
2 次。12 个 scenario 各保留 2 个独立 attempt，共 24 个，全部为 `PASS`；
receipt、completed outbox、Provider invocation 与 Fake Provider effect 均为
146，event high-water 与 projection position 均为 532，duplicate external
operation 与 false success 均为 0，五项检查全 true。Hunter 与 Provider 两个
SQLite 文件的 `integrity_check` 和 `quick_check` 均为 `ok`；peak heap、RSS、
database、archive 与 checkpoint 分别为 69,911,352、203,104,256、
3,274,600、48,243 与 58,737 bytes，仍在固定边界内。本轮证据、checkpoint 与
本文的隐私回归扫描未发现用户绝对路径、凭据赋值、环境 dump 或私有 Prompt，
冻结源码 pathspec 也保持无变化。该状态仍只证明中途一致性，总体继续为
`NOT_PROVEN`。

cycle 160 的计划重启与归档复合边界继续严格对账：真实 elapsed 为
9,421,622 ms，`scheduledRestartCount=32`、`recoveryRestartCount=2`、
`restartCount=34`、archive 16 次、rebuild 5 次、loop 160 次和 fault matrix
2 次；计划重启仍等于 `floor(cycle / 5)`，总重启仍等于计划重启与恢复重启之和。
receipt、completed outbox、Provider invocation 与 Fake Provider effect 均为
194，event high-water 与 projection position 均为 708，false success 为 0，
五项检查全 true。随后 cycle 162 的隐私复查对六类用户路径、凭据词、环境赋值和
私有 Prompt 模式的命中数仍全部为 0；peak heap/RSS/database/archive/checkpoint
仍分别低于 256 MiB growth、512 MiB growth、512 MiB、64 MiB 和 16 MiB 的固定
边界。冻结 revision、source digest 与源码 pathspec 保持不变，两个历史 rename
失败也没有增加。该状态仍未达到 86,400,000 ms 和 1,440 cycle，因此继续为
`NOT_PROVEN`。

cycle 180 触发第三轮完整故障矩阵；紧随其后的 cycle 181 checkpoint 记录真实
elapsed 10,681,430 ms，`scheduledRestartCount=36`、
`recoveryRestartCount=2`、`restartCount=38`、archive 18 次、rebuild 6 次、
loop 181 次和 fault matrix 3 次，全部精确满足由 cycle 推导的计数。12 个故障
scenario 各保留 3 个独立 attempt，共 36 个，全部为 `PASS`；每组 duplicate
external operation 与 false success 均为 0，36 个 attempt 均保留失败或预期拒绝
历史。receipt、completed/total outbox、Provider invocation 与 Fake Provider
effect 均为 219，event high-water 与 projection position 均为 800，五项检查全
true。Hunter 与 Provider SQLite 的 `integrity_check`、`quick_check` 均为 `ok`；
18 个持久化 Archive manifest 通过冻结源码 schema 与内容 hash 校验，文件名与
manifest hash 一致。六类隐私模式命中均为 0，peak heap、RSS、database、archive
和 checkpoint 分别为 69,911,352、203,104,256、4,206,024、72,369 与 86,820
bytes，仍在固定边界内。冻结源码无变化，历史 rename 失败仍为 2 次，stderr 只含
Node SQLite experimental warning。该中途结果仍未满足真实 24 小时和 1,440 cycle，
总体继续为 `NOT_PROVEN`。

cycle 360 再次同时跨过计划重启、归档、projection rebuild 和完整故障矩阵边界。
真实 elapsed 为 21,424,392 ms，`scheduledRestartCount=72`、
`recoveryRestartCount=2`、`restartCount=74`、archive 36 次、rebuild 12 次、
loop 360 次和 fault matrix 6 次，全部精确匹配冻结调度。12 个故障 scenario
各保留 6 个独立 attempt，共 72 个，全部为 `PASS`，且 duplicate external
operation、false success 均为 0，失败或预期拒绝历史全部保留。outbox、receipt
与 Fake Provider effect 的 operation 集合均为 434 个，fingerprint 完全一致，
所有 outbox 已完成且每个 Provider invocation 恰好一次；event high-water 与
projection position 均为 1,588，`ExecutionFailed` 历史为 360 条，restart probe
为 74 条。36 个 Archive manifest 全部通过 schema、内容 hash 和文件名校验，无
临时文件；Hunter 与 Provider SQLite `quick_check` 均为 `ok`。peak heap、RSS、
database、archive 与 checkpoint 分别为 69,911,352、203,104,256、6,864,672、
144,747 与 169,940 bytes，仍在固定边界内。五项检查全 true，冻结源码身份未变，
历史 rename 失败仍为 2 次，stderr 仍只含 Node SQLite experimental warning。
该复合边界仍未满足真实 24 小时，整体继续为 `NOT_PROVEN`。

cycle 600 的整百边界完成第十轮完整故障矩阵。真实 elapsed 为 35,826,158 ms，
`scheduledRestartCount=120`、`recoveryRestartCount=2`、
`restartCount=122`、archive 60 次、rebuild 20 次、loop 600 次和 fault matrix
10 次，全部精确匹配冻结调度。12 个故障 scenario 各保留 10 个独立 attempt，
共 120 个，全部为 `PASS`，失败或预期拒绝历史完整，duplicate external operation
与 false success 均为 0。outbox、receipt 与 Fake Provider effect 均为 722，
restart probe 为 122；event high-water 与 projection position 均为 2,644，
`ExecutionFailed` 历史为 600 条。60 个 Archive manifest 全部通过 schema、内容
hash 和文件名校验，无临时文件；两个 SQLite `quick_check` 均为 `ok`。peak heap、
RSS、database、archive 与 checkpoint 分别为 69,911,352、203,104,256、
10,632,144、241,251 与 281,138 bytes，仍在固定边界内。19 个公开历史 envelope
文件名 hash 全部正确，latest evidence 与独立 checkpoint 完全一致，四类凭据、
用户路径、环境赋值和私有 Prompt 扫描均 0 命中；冻结源码身份未变，历史 rename
失败仍为 2 次，stderr 未增长。该里程碑仍未满足真实 24 小时和 1,440 cycle，
整体继续为 `NOT_PROVEN`。

cycle 700 的整百边界记录真实 elapsed 41,825,723 ms，
`scheduledRestartCount=140`、`recoveryRestartCount=2`、
`restartCount=142`、archive 70 次、rebuild 23 次、loop 700 次和 fault matrix
11 次，全部精确匹配冻结调度。outbox、receipt、Provider invocation 与 Provider
effect 均为 842，event high-water 与 projection position 均为 3,084，
`ExecutionFailed` 历史为 700 条，false success 为 0，五项检查全 true。第十一轮
故障矩阵累计 12 个 scenario 各 11 个独立 attempt，共 132 个，全部为 `PASS`，
且每条失败、预期拒绝或恢复历史均保留。70 个 Archive manifest 全部通过 schema、
内容 hash 和文件名校验，无临时文件；两个 SQLite 的 `quick_check` 与
`integrity_check` 均为 `ok`。19 个公开历史 envelope 文件名 hash 全部正确，
latest evidence 与独立 checkpoint 完全一致；凭据值、用户路径、环境赋值和 Prompt
payload 扫描均 0 命中。冻结源码 identity 重新计算完全一致，source pathspec
差异仍为 0，历史 rename 失败仍为 2 次，stderr 仍只含 Node SQLite experimental
warning。该里程碑仍未满足真实 24 小时和 1,440 cycle，整体继续为
`NOT_PROVEN`。

cycle 720 达到最低 1,440 cycle 门槛的一半，但真实 elapsed 为 43,027,594 ms，
仍略低于 12 小时，因此不能把 cycle 半程写成时间半程。
`scheduledRestartCount=144`、`recoveryRestartCount=2`、
`restartCount=146`、archive 72 次、rebuild 24 次、loop 720 次和 fault matrix
12 次，全部精确匹配冻结调度。第十二轮矩阵累计 12 个 scenario 各 12 个独立
attempt，共 144 个，全部为 `PASS`；duplicate external operation 与 false success
均为 0，失败、预期拒绝和恢复历史全部保留。outbox、receipt、Provider invocation
与 Provider effect 均为 866，所有 invocation count 均为 1，event high-water 与
projection position 均为 3,172。72 个 Archive manifest 全部通过 schema、内容
hash 和文件名校验，无临时文件；两个 SQLite 的 `quick_check` 与
`integrity_check` 均为 `ok`。peak heap、RSS、database、archive 与 checkpoint
分别为 69,911,352、203,104,256、12,334,192、289,503 与 336,740 bytes，仍在
固定边界内。五项检查全 true，冻结源码和两次 rename 失败历史均未变化；整体继续
为 `NOT_PROVEN`。

最终进程于 2026-07-26 18:39:54 +08:00 正常完成并清理可恢复 `.state`，最终
envelope 为 `status=PASS`、真实 elapsed 86,410,499 ms、cycle 1,442。
`scheduledRestartCount=288`、`recoveryRestartCount=2`、
`restartCount=290`，严格满足计划重启等于 `floor(cycle / 5)` 且总重启等于
计划重启与恢复重启之和；archive 144 次、projection rebuild 48 次、loop
1,442 次、fault matrix 24 次也都与固定调度精确一致。

24 轮矩阵中的 12 个 scenario 各保留 24 个独立 attempt，共 288 个；全部为
`PASS`，attempt ID 全部唯一，duplicate external operation 与 false success
均为 0，失败、预期拒绝和恢复历史全部保留。主 workload 的 receipt、completed
outbox、Provider invocation 与 Fake Provider effect 均为 1,732，restart probe
为 290；event high-water 与 projection position 均为 6,348。144 个 Archive
manifest 全部通过冻结源码 schema、内容 hash 与文件名校验；完成前两个 SQLite
文件的 `quick_check` 与 `integrity_check` 均为 `ok`。

最终 peak heap、RSS、database、archive 与 checkpoint 分别为 69,911,352、
203,104,256、19,689,288、579,060 与 671,903 bytes，全部低于固定边界。
Phase 1 JSON 证据的凭据、用户绝对路径、worktree 路径、敏感环境赋值和私有
Prompt 扫描均为 0 命中，冻结 revision 与 source digest 重新计算完全一致，
source pathspec 无修改或未跟踪文件。五项检查全部为 true；stderr 只保留 Node
SQLite experimental warning。

原始 PASS envelope 保留在
[`soak-24h.json`](evidence/phase1/soak-24h.json)，SHA-256 为
`A1BEFD74AE6B5B3728A908C20E1A0B28F06C0EBB2753AE3644F26B504985BCAA`。
前三次未完成尝试、第四次的两次 `PHASE1_EVIDENCE_RENAME_FAILED` 和两次合法
recovery restart 仍按原始历史保留，没有被最终 PASS 覆盖或改写。该结果仅为
`CONTRACT_ONLY`；Fake Runtime 不能证明真实 Provider 已验证。

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
