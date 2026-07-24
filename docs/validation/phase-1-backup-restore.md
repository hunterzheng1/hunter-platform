# Phase 1 consistent backup and isolated restore

- 日期：2026-07-24
- 平台：Windows `10.0.26200`
- 分支：`codex/phase1-backup-recovery`
- 基线：`main@4f9f0718a1dd5146d0f872e9f3d81174bf97e639`
- 证据范围：`contract_only`

## 实现边界

- 活动 `hunter.sqlite` 只通过 Node.js 24 `node:sqlite` 的在线 `backup()` API
  生成一致快照，不复制活动数据库文件；
- manifest schema 固定为 v1，覆盖 storage schema version、Event Ledger
  count/range，以及 SQLite、`content/`、`projects/`、`archives/` 中每个文件的
  scope、portable relative path、SHA-256 和字节数；
- 文件先进入 `.<backup-id>.incomplete` staging；文件与 manifest 刷新关闭后，
  用同卷目录原子重命名发布。发布前故障不会产生可被恢复器接受的最终目录；
- manifest 和文件列表严格解析、稳定排序并整体 hash；绝对路径、反斜杠、盘符、
  `.`/`..`、重复路径、scope/path 不一致及未来 manifest version 均 fail closed；
- source 和 restore 两侧均拒绝 symlink/junction/reparse escape，不跟随链接读取
  私有目录；
- `backupId` 在参与任何路径拼接前完成严格 schema 校验；活动数据库的
  hard-link 也不能伪装成普通 scope 文件进入备份；
- 备份在数据库快照前记录文件 scope 的完整 inventory，并在复制完成后按
  path、size、hash 与文件 identity 复核；备份期间新增、删除、替换或改变的
  文件均 fail closed，不发布混合时间点快照；
- CAS 文件的最终路径段必须等于复制字节的 SHA-256，错误命名的内容不会被发布为
  合法 content-addressed backup；
- restore 先逐文件验证存在性、类型、size 和 hash，再复制到独立
  restore 根并再次校验目标字节，期间以 `.restore.incomplete` marker 表示尚未
  发布；目标根通过 exclusive create 取得，已存在时固定拒绝，不覆盖用户数据；
- 恢复库重新执行 migration/schema/WAL/foreign-key/integrity 门禁并从 Event
  Ledger 重建 Hunter projection；
- 成功 manifest 同时派生 Task 3 破坏性迁移门禁可消费的 verified backup
  receipt；receipt 的 source schema version 与 manifest 一致，fingerprint 是
  manifest hash；
- 恢复后使用 `@hunter/knowledge` 的 canonical Archive manifest、verified
  receipt 和 Knowledge entry schema，对账 Event count/range/JSON、Project、
  Run、outcome、manifest schema/hash/ref、Artifact/Evidence CAS 引用；Archive
  只接受精确的 `archives/<manifest-hash>.json` 路径。缺文件、hash 漂移、无效
  content reference、provenance 漂移或孤儿引用均拒绝发布恢复根；
- `runtime/`、`exports/`、源码仓库、worktree 和系统凭据库不在本任务备份范围。
  本批没有把备份扩展为生产保留策略、加密介质或远端同步。

## RED → GREEN 记录

1. 首个精确测试在 collection 阶段真实失败：
   `Cannot find module './backup-manifest.js'`；随后实现最小 manifest 与 service。
2. 首次实现联测有 7 项真实失败，原因是测试 helper 错把 `mkdtempSync` 从
   `node:os` 导入；修正为 `node:fs` 后继续执行相同精确测试。
3. Windows 精确测试再次有 7 项真实失败，原始错误为只读文件句柄
   `fsync` 返回 `EPERM`；改用可刷新文件句柄后 8/8 通过。此差异保留为真实
   Windows 文件系统证据。
4. 增加未来 storage version、restore-side junction、有效
   Archive/Knowledge/Artifact/Evidence 对账和三个 pre-publication fault point
   后，精确测试 13/13 通过；再加入 CAS path/hash 一致性负例后 14/14 通过。
5. 首个定向 lint 真实发现一个未使用的 destructured manifest hash；改为显式构造
   future-version fixture 后定向 lint 通过。
6. `npm run typecheck -w @hunter/storage` 真实失败，因为 workspace 未定义该
   lifecycle script；这不是源码失败。随后定向 `tsc -b` 在 Codex 文件沙箱中因
   无法创建各 workspace `dist` 收到 `EPERM`；在同一 worktree 的宿主 Windows
   权限边界执行根 `npm run typecheck` 后通过。
7. 后续一次精确 Vitest 在 Codex 文件沙箱写
   `node_modules/.vite-temp` 时收到 `EPERM`；使用相同源码、同一 worktree 和
   相同精确测试在宿主 Windows 权限边界重跑后 13/13 通过。随后增加的 CAS
   path/hash 负例也在该边界 14/14 通过。该失败未归类为测试
   PASS。
8. 为压缩全量测试日志首次尝试 `--reporter=basic`，Vitest 4 将 `basic` 当作
   不存在的自定义 reporter 并在 startup 阶段真实失败；改用内置 JSON reporter
   后机器可读结果为 106 files / 927 tests，全部通过且无 skipped/pending。
9. 首轮代码审查发现七个重要边界：未预校验 `backupId`、活动数据库 hard-link、
   文件与数据库混合时间点、破坏性迁移备份循环依赖、restore copy 后 TOCTOU、
   Archive/Knowledge 临时结构校验，以及 POSIX 可覆盖空目标目录。逐项增加回归
   测试并修复；引入 canonical fixture 时因 fixture ID 不满足 schema 真实出现
   7 项失败，修正 fixture 后精确测试 18/18 通过。
10. 第二轮审查发现 Archive 可落到嵌套目录、Knowledge 未完整核对
    Run/outcome/schema version，以及证据计数过期。增加 provenance/path 负例并
    修复后，精确测试 19/19、全量测试 932/932 通过。

失败历史未重写为 PASS；每次重试都有新的原始错误或边界证据。

## 恢复演练

`npm run verify:backup-restore` 只使用自动创建并最终清理的临时目录，构造：

- 1 条 Event；
- 1 个已完成 Archive 引用；
- 1 个 historical Knowledge 引用；
- 1 个同时作为 Artifact 与 Evidence 的内容寻址对象；
- 1 个版本化可读 Requirement 文件。

实际安全输出：

```json
{"status":"PASS","manifestSchemaVersion":1,"storageSchemaVersion":2,"fileCount":4,"manifestHash":"7f2c4a6161cbe0fb12835163556368d43562c6fe6c8c3fdffb01d054a9aa7424","isolatedRestore":true,"projectionsRebuilt":true,"reconciliation":{"eventCount":1,"archiveReferenceCount":1,"knowledgeReferenceCount":1,"artifactReferenceCount":1,"evidenceReferenceCount":1,"contentReferenceCount":1}}
```

该输出不包含临时绝对路径、环境变量、凭据、私有 Prompt 或真实用户内容。

## 本机验证

| 命令 | 结果 |
|---|---|
| `npm install` | PASS；新增 worktree 安装 594 packages；npm 摘要报告 3 个 high severity，未据此推断生产可利用性 |
| 基线 `npm test` | PASS；105 files / 913 tests |
| `npx vitest run packages/storage/src/backup-service.test.ts` | PASS；1 file / 19 tests |
| `npm run verify:backup-restore` | PASS；4 files，Event/Archive/Knowledge/Artifact/Evidence 对账均为 1 |
| 定向 `npx eslint` | PASS |
| 根 `npm run typecheck` | PASS；在宿主 Windows 权限边界运行 |
| `npm test`（JSON reporter） | PASS；106 files / 932 tests；0 failed，0 pending |
| `npm run verify:rebuild` | PASS；3 events |
| `npm run verify:recovery` | PASS；receipt `e73ee7cafb4eb14e249bf8fb35b8adc3a8779983783479a56344ff6cbdaf1b78` |
| `npm run build` | PASS |
| `npm run verify:foundation` | PASS；lint、typecheck、全量测试、rebuild、recovery、backup/restore 与 build 完成 |

`git diff --check` 将在提交前再次运行；PR head GitHub Actions 尚未运行，不得
继承旧 SHA 的结论，远端 CI 为 `PENDING`。

## 结论边界

- 本证据证明 Hunter 自有 backup/restore 契约与临时恢复演练，不证明真实用户数据
  已备份，也不等同于生产灾备；
- Provider 状态未改变：真实 Provider 仍为 `NOT_PROVEN`，Fake Runtime 仍为
  `CONTRACT_ONLY`；
- 未选择或 Fork Orca，未运行真实 Provider、真实设备、远端恢复、代码签名或生产
  发布。
