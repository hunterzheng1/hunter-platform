# First Vertical Slice Task 18 本机验证

- 日期：2026-07-24
- 平台：Windows
- 范围：持久归档任务、原子清单、Project 级 Knowledge 投影与重建
- 证据性质：只证明 Hunter 自有契约和本机 Fake/fixture 组合；不证明任何真实 Runtime Provider 或生产发布

## RED → GREEN 记录

| 变更簇 | RED | GREEN |
| --- | --- | --- |
| 归档清单与崩溃恢复 | 初始 11/11 失败，归档 API 尚不存在 | 13/13 通过；覆盖三处崩溃、三种终态、嵌套 Task Run、损坏 receipt |
| Project 级重建 | 初始 5/5 失败，目录持久化与重建 API 尚不存在 | 5/5 通过；重复重建字节与 digest 稳定，Project B 不受影响 |
| 应用组合与同事务调度 | 初始 2/3 失败，终态事件没有创建 `archive_jobs` | 3/3 通过；调度冲突会同时回滚终态事件和 command receipt |

## 最终本机命令

| 命令 | 结果 |
| --- | --- |
| `npm install` | PASS；lockfile 已同步；审计报告 4 个 high，未自动执行破坏性升级 |
| Task 18 三组精确测试 | PASS；3 files、21 tests |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm test` | PASS；90 files、837 tests |
| `git diff --check` | PASS |
| GitHub Actions push（run `30056133465`） | PASS；Ubuntu 1:03、Windows 1:59 |
| GitHub Actions PR（run `30056135436`） | PASS；Ubuntu 1:05、Windows 2:05 |

## 真实失败历史

- 一次沙箱内 `typecheck` 因无法覆盖 `apps/daemon/dist` 返回 `EPERM`；同一命令在受控沙箱外通过。
- 一次精确 Vitest 启动因无法写入 `node_modules/.vite-temp` 返回 `EPERM`；同一命令在受控沙箱外通过。
- 第一次全仓测试有 1 个既有 `RunPage` 测试在 5 秒超时，隔离运行 8/8 通过。
- 第二次全仓测试有另外 2 个 Web 组合测试在约 5.1 秒超时。将全仓有限时间盒调整为 10 秒后，90 files、837 tests 全部通过。

## 已证明边界

- `succeeded | failed | canceled` 的 Run 终态事件与持久 `archive_jobs` 位于同一 SQLite 事务。
- 清单是版本化、严格校验、内容寻址且不可覆盖的；发布使用同目录临时文件、fsync、原子 rename 和最终重读校验。
- 三处崩溃重启后只产生一个清单和一个 Knowledge 条目；失败历史不被改写。
- 损坏或未知清单/receipt 会 fail closed 为 `needs_attention`。
- Knowledge 查询和重建必须指定合法 Project；只替换该 Project 的 rebuildable 索引。
- superseded/withdrawn 条目保留可搜索，但默认 handoff resolution 只返回 active 且不注入历史条目。

## 尚未证明

- Task 18 实现与测试时间盒提交的 GitHub Actions Windows/Ubuntu：PASS；仅证明上述提交和工作流。
- 真实 Orca、Codex、CodeBuddy、Cursor Provider 能力：NOT_PROVEN。
- 生产凭据、公网链路、真实移动设备、签名、商店和生产发布：NOT_PROVEN，且不在本任务范围内。
