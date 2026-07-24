# Phase 1 Task 7：Artifact 分页、配额与背压验证

- 日期：2026-07-24
- 结论：`CONTRACT_ONLY`
- proof scope：`contract_only`
- 实现范围：Hunter SQLite/CAS Artifact catalog、HTTP contract、daemon route、Web 当前页读取和确定性 Fake Runtime fixture

## 冻结边界

| 边界 | 值 |
|---|---:|
| 默认页条目数 | 20 |
| 最大页条目数 | 32 |
| 单条最大 UTF-8 字节数 | 65,536 |
| 单页最大内容字节数 | 262,144 |
| 摘要最大字符数 | 500 |
| 单客户端最大通知容量 | 128 |
| Phase 1 软水位 | 2 GiB |
| Phase 1 硬水位 | 4 GiB |
| 核心 receipt 保留额度 | 64 MiB |

HTTP 与 storage 使用同一分页数值。HTTP schema 不输出绝对路径、
`relativePath` 或 `contentRef`。配额按 Artifact 逻辑字节计量；CAS 的物理去重
不降低逻辑配额占用。quota receipt 同时记录写入前 `usedBytes` 与本次
`projectedBytes`；projected bytes 达到硬水位即拒绝非关键写入。

## RED → GREEN 记录

1. Storage RED：Artifact catalog 模块不存在；补齐 v3 migration、CAS 完整性、
   cursor page、retention floor、配额、引用保护和同步有界 feed 后转绿。
2. API/daemon RED：分页 schema 与 route 不存在，真实 loopback 请求返回 404；
   加入严格 schema、Project scope 和生产 composition 后转绿。
3. Web RED：Step Detail 没有按需加载入口；加入当前页替换、显式 retention
   resync 和 RunPage composition 后转绿。
4. Resource fixture RED：验证脚本不存在；加入固定负载后转绿。首次 CLI 运行
   暴露 workspace dist 尚未构建，脚本现先构建所需包再执行。
5. 审查 RED：未来 cursor 曾产生 500、feed 无法释放、Artifact CAS 缺失仍可
   restore；加入 409 receipt、自动/显式 feed close 和备份引用对账后转绿。

失败历史未改写为成功。

## 资源 fixture

命令：`npm run verify:resources`

固定负载：

- 10 个通过严格 HTTP schema 的已完成只读 Step projection；
- 4 个并行 Fake Runtime `session.observe` operation，以及仍为
  `active/running` 的严格 Step projection（receipt 观察不完成 Step）；
- 42 条、每条 4,096 字节的确定性大日志；
- 容量为 1 的故意慢消费者；
- 独立的软水位、硬水位和核心 receipt reserve fixture。

结果：

| 检查 | 结果 |
|---|---|
| 42 条日志分两页读取，最大 32 条/页 | PASS |
| 最大观测页内容 131,072 字节，小于 262,144 字节上限 | PASS |
| cursor 低于 retention floor 返回显式 resync | PASS |
| 软水位返回 warning；硬水位拒绝非关键写入 | PASS |
| 核心 receipt 可使用独立 reserve | PASS |
| Evidence 引用阻止 retention 删除 | PASS |
| 慢客户端收到 disconnect-and-replay receipt | PASS |
| writer 在慢客户端溢出时仍持久化到 high-water cursor 42 | PASS |
| 断开后从 durable ledger 重读两条缺失记录 | PASS |
| 4 个 Fake receipt 均为 `contract_only`，观察事实均不能完成 Step | PASS |
| 输出不含凭据、用户路径、CAS 内部路径或环境内容 | PASS |

## 生产组合与恢复检查

命令：

```text
npm test -- --run apps/daemon/test/sqlite-application-services.test.ts apps/daemon/test/sqlite-run-view.test.ts apps/daemon/test/sqlite-archive-manifest-source.test.ts apps/daemon/test/archive-composition.test.ts packages/storage/src/backup-service.test.ts
```

结果：

| 检查 | 结果 |
|---|---|
| 生产 OperationWorker 写入路径无关的核心 receipt Artifact，并由 RunView 投影 | PASS |
| manifest 构建不提前保护 Artifact；Archive receipt 与保护引用在同一事务原子提交 | PASS |
| Artifact CAS 引用缺失时备份恢复 fail closed | PASS |

完整的 `npm run verify:foundation` 也覆盖这些测试，但它不是
`verify:resources` 固定负载的一部分。

## 证明边界

本记录只证明 Hunter 自身契约和固定本机 fixture。它不证明真实 Provider、
真实大仓库吞吐、24 小时 soak、真实磁盘耗尽恢复、生产容量或跨设备性能。
Fake Runtime 不代表 Orca、Codex、CodeBuddy、Cursor 或任何真实 Provider 已验证。
本 fixture 未采集吞吐、p50 或 p95，因此 `NFR-PERF-03` 仍为 `NOT_RUN`。
