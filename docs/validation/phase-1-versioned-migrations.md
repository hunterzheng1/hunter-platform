# Phase 1 versioned migrations and startup integrity

- 日期：2026-07-24
- 平台：Windows `10.0.26200`
- 分支：`codex/phase1-versioned-migrations`
- 基线：`main@dd97438eb11eb4956c14771f530fd472f09f7320`
- 证据范围：`contract_only`

## 实现边界

- SQLite schema 由连续的 `NNN-name.sql` 前向迁移驱动；
- `storage_migrations` 保存 version、name、SHA-256 checksum 和应用时间；
- `storage_migration_state` 保存事务外的 in-progress marker；
- 每次启动校验 schema version、migration ledger、checksum、WAL、
  foreign keys、`integrity_check` 和 `foreign_key_check`；
- legacy adoption 仅允许 schema v1，且必须与当前 001 的 table/index 结构指纹一致；
- versioned schema 在执行 pending migration 前后都必须与 migration 生成的完整结构
  指纹一致；非空且无版本的用户 schema 会被拒绝；
- migration SQL 不能自行控制 transaction/savepoint、执行 PRAGMA 或 attach database；
- migration SQL 不能读取或写入 runner-owned metadata/ledger/state，trigger/view 也不能
  引用这些对象；
- `UPDATE`、`DELETE`、`DROP`、`ALTER` 等破坏性动作必须收到与来源 schema version
  对应的 verified backup receipt；
- daemon 在 recovery 成功前不监听；未知 marker、未来 schema 和健康检查异常均
  fail closed；
- desktop sidecar 动态复制完整且连续的 SQL migration 集合，不再硬编码
  `001-core.sql`；
- 本批 002 不是破坏性迁移，因此没有生成 backup receipt；runner 已冻结显式
  receipt gate，实际备份服务与恢复演练属于 Task 4。

校验和只规范化 Git checkout 可能改变的 CRLF/LF，migration version、name 和 SQL
内容仍共同参与 fingerprint。测试证明相同内容跨平台一致，内容或名称漂移仍被拒绝。

## 兼容性与恢复事实

- 新库按顺序执行 001、002，并记录两个不可变 ledger row；
- 旧 schema v1 库在一个事务中补记 001 ledger row，只执行缺失的 002，并保留
  既有 Event；
- 002 将历史上由 daemon 构造器创建的 principal authorization table 纳入版本化
  schema，并增加 `events(project_id, position)` index，不改写历史 Event；
- migration SQL 失败会回滚 DDL/DML，不记录失败版本，也不遗留成功 marker；
- checksum/name 漂移、ledger gap、未来 schema 和未知/不匹配 marker 使用固定、
  非敏感错误拒绝启动；
- metadata version 与连续 ledger 长度不一致时不自动修复；
- integrity、foreign key 和 legacy marker 在待执行 migration 之前检查；
- 已知 rolled-back marker 会被记录为 recovery fact，然后执行待应用迁移；
- legacy `target_schema_version:1` marker 仍可有界清理；未知 legacy marker 原样保留，
  供人工恢复。

## RED → GREEN 记录

1. 新增 runner 测试后，精确测试因缺少 `migration-runner.js` 在 collection 阶段
   真实失败；实现最小 runner 后 7/7 通过。
2. 加入 repository migration loader、旧库升级和未来 schema 测试后 3 项真实失败；
   接入 journal 与 002 后 10/10 通过。
3. storage 与 daemon 联测首次有 3 项失败，原始差异是 startup receipt 仍硬编码
   schema version 1；改为使用 migration receipt 后相关测试通过。
4. daemon 先加入 schema v2 legacy marker 和未知 marker 负例，4 项真实失败；
   接入动态 schema version 与 fail-closed reconciliation 后 14/14 通过。
5. desktop resource 测试先因缺少 `migration-resources.js` 真实失败；实现连续资源复制
   后 2/2 通过。
6. desktop 首次单 workspace build 因全新 worktree 尚无依赖 workspace 的 `dist`
   declaration 真实失败；根 `npm run typecheck` 生成依赖声明后，相同 desktop build
   通过。该失败是构建顺序证据，不改写为 migration 失败或 PASS。
7. CRLF/LF checksum 测试先得到两个不同 hash 并真实失败；只规范化行尾后，
   精确测试 1/1、runner 11/11 通过。
8. 多行 `integrity_check` 负例先因实现只读取第一行而真实失败；要求结果严格等于
   单一 `ok` row 后，连同真实 orphan foreign-key fixture 在内 runner 13/13 通过。
9. 非幂等 legacy fixture 证明旧实现会重新执行 001，精确测试真实失败；加入
   transactional ledger adoption 后只执行缺失的 002，runner 14/14 通过。
10. 独立审阅用 metadata-only v2、metadata/ledger 跳跃和 migration 内 `COMMIT`
    复现三个 fail-closed 缺口；对应负例真实失败后，加入 v1 结构指纹、ledger
    congruence 和 SQLite authorizer，部分提交不再可能伪装成成功。
11. 既有 orphan foreign key 和预置未知 legacy marker 的负例证明旧实现会先执行
    002；将完整性与 marker preflight 前移后，002 不再落库且未知 marker 原样保留。
12. runtime loader 与 desktop packager 对 `003_bad.sql` 的测试先真实失败并静默忽略；
    修复后任何畸形 `.sql` 名称都会在复制或执行前被拒绝。
13. 破坏性 `UPDATE` 在无 receipt 时先真实执行；加入 verified backup receipt gate
    后，无 receipt 会回滚，来源 schema version 与 fingerprint 匹配时才允许执行。
14. 复审证明 migration 可伪造 runner ledger、`INSERT OR REPLACE` 可绕过备份门，
    legacy subset 指纹可接受额外 trigger；三个负例先真实失败，再由 runner-owned
    object deny、existing-table INSERT gate 和 exact schema fingerprint 关闭。
15. exact fingerprint 首次联测暴露 daemon 仍在构造器创建 principal authorization
    table，导致重启真实失败；该 DDL 已移入 002，共享 manifest parser 也消除了
    runtime/desktop 的文件名规则重复。非空 unversioned schema 与 versioned drift
    负例均先 RED、后 GREEN。
16. 最终审阅分别用 `CREATE TABLE IF NOT EXISTS` + replace 和只改变 DEFAULT
    字面量空白复现 authorizer/指纹边界；执行前 table snapshot 与 token-aware SQL
    规范化完成后，精确 runner 29/29 通过。

## 本机验证

| 命令 | 结果 |
|---|---|
| `npx vitest run packages/storage/src/migration-runner.test.ts` | PASS；1 file / 29 tests |
| `npx vitest run packages/storage/src apps/daemon/test/sqlite-application-services.test.ts apps/desktop/src/migration-resources.test.ts` | PASS；7 files / 72 tests |
| `npm run build -w @hunter/desktop` | PASS；sidecar 含 001、002 |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm test` | PASS；104 files / 912 tests |
| `npm run build` | PASS |
| `npm run verify:foundation` | PASS；在宿主 Windows 权限边界运行，含 lint、typecheck、104 files / 912 tests、rebuild、recovery、build |
| `git diff --check` | PASS |

desktop 构建产物检查只观察到：

- `001-core.sql`；
- `002-events-project-position.sql`。

未读取或记录环境变量、凭据、绝对用户数据路径或私有 Prompt。

## 远端与产品状态

- 本分支 GitHub Actions 尚未运行，状态为 `PENDING`；
- Ubuntu checkout 的 checksum 可移植性有自动测试，但 Ubuntu CI 尚未实际验证本
  HEAD；
- Fake Runtime、真实 Provider、真实设备和代码签名状态不因本任务改变；
- Provider 仍为 `NOT_PROVEN`，Fake 仍为 `CONTRACT_ONLY`；
- 未发布、未签名、未部署，未运行生产升级或真实用户数据迁移。
