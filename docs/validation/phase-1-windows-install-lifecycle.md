# Phase 1 Task 10 Windows 安装与 sidecar 生命周期验证

- 日期：2026-07-25
- 平台：Windows `10.0.26200` / x64
- 分支：`codex/phase1-windows-install-lifecycle`
- 基线：`main@2811643`
- 验证源：本证据文件所在的不可变 Git 提交；最终 commit SHA 与同 SHA 的 CI
  结果记录在 PR 中
- 范围：未签名 NSIS 测试产物、packaged layout、临时安装/数据根、桌面主进程和
  Hunter-owned sidecar
- 证据性质：`CONTRACT_ONLY`；未签名、未发布、未上传

## 冻结边界

1. Desktop 在启动任何 owned work 前申请单实例锁。第二实例只通知并聚焦第一
   窗口，然后退出；它不创建第二个 sidecar。
2. daemon 启动失败、真实 renderer crash 和正常退出都通过同一个幂等 lifecycle
   coordinator 回收 owned sidecar。停止收据必须等待 child `close`；5 秒无响应时
   请求 `SIGKILL`，再等待 5 秒仍未关闭才返回固定 timeout，并允许后续重试。
   正常关闭已开始后出现的 renderer termination 或启动 rejection 只是后续观察，
   不得把正常退出覆写为失败。
3. lifecycle smoke 只使用 `mkdtemp()` 创建的
   `hunter-install-lifecycle-*` fixture；安装和数据子目录包含空格及中文。任何根
   不在该 fixture 内或安装/数据根重叠时 fail closed。
4. packaged app 的首次启动、第二实例、缺失 daemon entry、强制 renderer crash
   和 `app.quit()` 正常退出都在复制到临时安装根的 `win-unpacked` layout 上实际
   运行。清理只针对本轮拥有的子进程和 fixture。
5. 兼容升级先用正式 migration runner 构造 schema v2 数据库，验证 ledger 并通过
   在线 SQLite 一致性备份生成 verified manifest hash；只有门禁收据通过后才启动
   packaged app，让 daemon 实际迁移到 schema v3。任一迁移或备份收据缺失、
   目标版本非递增或最终 schema 不是 v3 时不得返回成功。
6. NSIS 配置固定 `deleteAppDataOnUninstall: false`。默认卸载 smoke 删除临时安装
   根后仍逐字节读取用户数据；显式删除要求两次确认，且只删除自动 fixture 的
   数据根。
7. preload 仍只暴露冻结的 named API allowlist；packaged daemon bundle 扫描不到
   Fake Runtime fixture marker。该结论不证明任何真实 Provider。

## RED → GREEN 记录

1. 初始 RED：精确 Vitest 因 `install-lifecycle.js` 不存在而失败，packaging 配置的
   `deleteAppDataOnUninstall` 为 `undefined`。加入严格临时根、单实例、幂等回收、
   升级门禁和卸载决策后，桌面聚焦套件通过。
2. 第一轮整包命令在受限沙箱中因 Vite 写入 `node_modules/.vite-temp` 得到
   `EPERM`，未形成打包结论；读取原始错误后在正常本机权限下运行。
3. 首轮真实 packaged-app smoke 暴露正常 page close 被
   `render-process-gone` 误判为 crash，退出码为 1。新增 `clean-exit` 回归测试并
   区分正常与异常 renderer observation。
4. 后续运行发现关闭发生在主进程 `await loadURL()` 收尾前。脱敏序列为
   `before-quit → quit(1)`，没有 renderer crash；readiness 收紧到 renderer
   `load` 完成并让主进程完成启动后，正常序列稳定为
   `before-quit → quit(0)`；sidecar `close` 在 `app.exit(0)` 前已完成。
5. 一轮临时卸载清理因 Windows 对 `ffmpeg.dll` 的短暂 `EPERM` 失败，原失败保留。
   清理改为只对已校验 fixture 做最多 20 次、每次 250ms 的有界重试；最终整包
   验证中 install/data/fixture 都在第 1 次删除成功。
6. 最终 `pack:win` 从资源构建、sidecar、preload、NSIS 到 lifecycle smoke
   整体退出码为 0。
7. 独立审查 RED：升级只验证当前 schema、sidecar 在 child close 前即声称
   stopped、启动 rejection 可覆盖正常退出。加入真实 schema v2→v3 packaged
   迁移、在线备份前置、异步 close/强制终止门禁、失败可重试及并发退出测试后，
   5 个桌面文件 / 42 tests 通过。

## 最终本机结果

| 命令 / 场景 | 结果 |
| --- | --- |
| 桌面聚焦 Vitest：install lifecycle、daemon supervisor、sidecar cleanup、packaging、IPC | PASS；5 files / 42 tests |
| `npm run verify:foundation` | PASS；lint、typecheck、124 files / 1092 tests、rebuild、recovery、backup/restore、diagnostics、resources 和 build 全通过 |
| `npm run pack:win -w @hunter/desktop` | PASS；Web build、desktop build、2 个独立 sidecar、sandbox preload、Windows x64 NSIS 和 packaged lifecycle 全通过 |
| 首次 packaged 启动 | PASS；临时中文/空格 install/data roots，renderer load 完成 |
| 双实例 | PASS；第二实例退出 0，第一实例继续运行，无第二个 owned sidecar |
| daemon entry 缺失 | PASS；应用退出 1，临时进程最终均可清理 |
| renderer crash | PASS；通过 Electron main-process API 强制 renderer crash，应用退出 1，owned sidecar 可清理 |
| 正常退出 | PASS；`before-quit → quit(0)`，child close 先于最终退出 |
| 升级 migration/backup gate | PASS；正式 runner 构造 schema v2，在线备份 manifest hash 通过后 packaged daemon 实际迁移到 schema v3 |
| 兼容数据与卸载 | PASS；升级和默认卸载后内容 hash 保持；显式删除要求双确认且仅触碰临时 fixture |
| Authenticode / PE security directory | PASS；`NotSigned`，证书与时间戳证书均为空 |
| 生产 bundle | PASS（`CONTRACT_ONLY`）；preload named allowlist 通过，Fake fixture marker 缺失 |
| GitHub Windows / Ubuntu CI | `PENDING / NOT_RUN`；当前提交尚未推送 |

## 最终未签名产物

- 文件名：`Hunter Platform Setup 0.1.0.exe`
- 版本：`0.1.0`
- 大小：`98,578,535` bytes
- SHA-256：`9a866ff4477ba625aae39ee7e2d2baa874dae07a9b1b8297e3ea90b609c5ce92`
- 签名：`unsigned`
- 发布 / 上传：`false / false`
- 临时 fixture 清理：`removed`，install/data/root 均第 1 次成功
- 真实用户路径：未读取、未修改、未删除

## 尚未证明或仍阻断

- NSIS 安装向导本体、Add/Remove Programs 注册和真实旧版本覆盖安装未在用户机器
  路径执行；本轮运行的是 NSIS 生成的 packaged layout 与临时 fixture：
  `NOT_PROVEN`。
- SmartScreen 声誉、代码签名证书、时间戳服务、正式分发渠道和生产发布：
  `BLOCKED`。
- 真实规模用户数据、跨既有生产版本升级、回滚、系统重启中断和杀毒软件矩阵：
  `NOT_PROVEN`。
- Orca、Codex、CodeBuddy、Cursor 或任何真实 Provider：本任务未调用、未验证，
  capability 未提升。
