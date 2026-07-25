# Phase 1 Task 9 移动离线与重同步安全验证

- 日期：2026-07-25
- 平台：Windows
- 分支：`codex/phase1-mobile-offline-hardening`
- 范围：Fake device、本地 TLS 1.3 fixture、移动命令 outbox、事件 cursor、
  Project-scoped 远程 HTTP 边界和窄屏浏览器安全场景
- 证据性质：`CONTRACT_ONLY`；不证明真实手机、生产证书、公网链路或真实 Provider

## 冻结边界

1. 远程监听默认关闭；显式开启仍要求 TLS material、Token/Pairing、
   DeviceGateway、EventStream 和投影服务。缺少 TLS 或设备身份服务时 fail closed。
2. access token、refresh family、设备版本/撤销和每请求设备签名沿用 Task 17
   持久边界。重复 proof nonce 被拒绝；同一业务幂等键和同一 fingerprint
   返回原 receipt，不重复推进。两者不是同一种“重放”。
3. 离线 outbox 暴露的只读条目固定包含原始严格 command、缓存时间和
   `unconfirmed`；UI 同时展示 command 的 expected version。
4. Event Cursor gap 或 retention floor 触发完整 Run 投影重载。只有重载成功后
   才推进到服务端 high-water；重载失败保留旧 cursor，以便下次重试。
5. 网络断开时保留最近成功快照，转换为带缓存时间的 `offline` 投影并禁用命令；
   不把缓存摘要描述为主机当前事实。
6. Gate 只有在其全部 permission 位于显式
   `allowedGatePermissions` 时才生成移动审批命令；同一规则也在
   `DeviceGateway` 的 immediate transaction 内重新授权。未知或未列入的 Gate
   即使由已认证设备直接构造并签名提交，也不会产生移动命令 receipt 或 Run/
   domain mutation。设备 proof nonce 的安全重放状态会在此之前正常推进。
   allowlist 只接受 canonical low/medium-risk catalog；已知高风险或未知权限会在
   daemon 组合阶段 fail closed。
7. 移动投影只下发 `agent / command / verify / human_gate / context / subflow`
   六类步骤，不下发 executor selector、路径、URL 或 Provider 私有 operation。
8. 远程 app 不注册桌面 Artifact 路由，也不注册任意 shell、path、URL 或
   Provider 路由。Project 外 Artifact 因而不会从该边界下发；移动 Artifact
   摘要预览仍未实现，不能把“全部拒绝”写成 M-01 已通过。

## RED → GREEN 记录

1. 离线队列 RED：2 个精确文件中 3 项失败，原 `pending()` 只返回 command，
   页面没有缓存时间、expected version 或未确认状态。加入稳定 pending view 和
   生产 composition 接线后，3 文件 / 9 tests 通过；Web 类型检查通过。
2. 重同步 RED：3 个精确文件中 3 项失败。离线 projection 不要求缓存时间，
   snapshot 加载失败直接抛错，而且 gap high-water 会在 snapshot 成功前写入。
   改为严格 online/offline 联合、网络失败只读快照和延迟 cursor commit 后，
   3 文件 / 15 tests 通过；根 typecheck 通过。
3. 安全投影 RED：5 个精确文件中 5 项失败。`currentStep` 接受任意字符串，
   Provider selector 被下发，未知 Gate 仍生成批准/拒绝命令。改为六类步骤、
   Gate permission allowlist 和 UI 友好标签后，5 文件 / 41 tests 通过。
4. 设备身份 RED：远程 app 在传入空设备服务时仍可构造，精确 HTTP 套件
   1/18 失败。加入启动期设备身份服务检查后，18/18 通过。
5. 浏览器 E2E 首轮在 sandbox 因 Playwright `.last-run.json` 写入 `EPERM`
   被阻断，未形成测试结论。正常本机权限首轮 1/2：第一条通过，第二条因首条
   `afterEach` 已关闭唯一 readiness fixture 失败；合并为单夹具场景后又发现本地
   Web fallback 对未知 `/api` 返回 SPA HTML 200，而远程 HTTPS app 的同一路径
   为 JSON 404。最终断言修正为“不作为 JSON operation 接受且不回显 payload”，
   精确 E2E 1/1 通过。失败历史未改写。
6. 独立审查 RED：签名设备可绕过隐藏按钮直接批准未 allowlist 的 Gate；
   已配对手机在断网冷启动时被误呈现为未配对，持久 outbox 因而不可见。新增
   HTTP 负例和冷启动恢复用例后，Gate 在服务端事务内返回 403，且无移动命令
   receipt 或 Run/domain mutation；paired binding 保持 `offline`
   并继续呈现缓存时间、expected
   version 和 `unconfirmed`。Task 9 精确套件 7 files / 60 tests 通过。
7. 二次审查 RED：任意字符串可被配置进 allowlist；HTTP 429/503 会把已配对设备
   误呈现为未配对；Gate policy denial 没有审计账本记录。加入 canonical mobile
   risk catalog、retryable HTTP 分类和脱敏 `DevicePermissionDecisionRecorded`
   事件后，高风险配置启动失败，签名高风险 Gate 返回 403，429/503 保持 paired
   offline，且拒绝只记录安全审计、不产生移动命令 receipt 或 Run/domain mutation。
8. 最终浏览器重跑首轮在 Chromium context setup 超时，原始日志显示 Network
   Service crash，测试体未执行；第二轮读取到 `E2E_ACTIVE_LOCK_HELD`。锁内 PID
   已不存在，确认是崩溃遗留后只删除该生成锁文件；第三轮同一精确场景
   1/1 通过。失败与清理历史均保留。
9. 最终复审 RED：access token 在 command 或 event poll 时过期会永久重试旧
   token，且界面仍显示已连接。回归测试证明命令和事件请求在 401 后各完成一次
   refresh/re-sign retry，并使用旋转后的 access token、不同 nonce 和不同 proof；
   参数化命令场景证明 refresh 再返回 401/403 时删除本地 binding/key、切换为
   unpaired，并由 application 立即回到配对页；独立业务 403 场景证明 Gate/scope
   拒绝不会误撤销设备。

## 当前验证结果

| 命令 / 场景 | 结果 |
| --- | --- |
| Task 9 精确 Vitest：device contracts/security、daemon HTTP/TLS、outbox、runtime、application、cockpit | PASS；7 files / 68 tests |
| `npm run typecheck` | PASS |
| `npm run verify:foundation`（sandbox） | BLOCKED；123 files / 1065 tests 与专项脚本通过，最终 copy asset 因生成目录 `EPERM` 失败 |
| `npm run verify:foundation`（正常本机权限，最终代码） | PASS；123 files / 1073 tests，rebuild/recovery/backup-restore/diagnostics/resources/build 全通过 |
| `npx playwright test e2e/mobile-security.spec.ts --project=mobile`（sandbox） | BLOCKED；Playwright 结果文件写入 `EPERM` |
| 同一 E2E（正常本机权限，最终重跑） | PASS；1/1，Pixel 7 viewport fixture；历史三轮为 context crash → stale lock → PASS，令牌修复后再跑 1/1 PASS |
| `npm run pack:win -w @hunter/desktop` | PASS；本地 Windows x64 NSIS 测试产物完成，未发布、未上传 |
| Fake device 撤销、access 边界过期、旧 refresh family reuse、device proof replay | PASS；本地持久 SQLite/crypto fixture |
| TLS 1.3 非 loopback listener | PASS；本地临时证书 fixture |
| 高风险/未知 Gate | PASS；风险 catalog 在启动期拒绝不安全 allowlist；签名设备直接构造时服务端返回 403、记录脱敏 denial audit，且无移动命令 receipt 或 Run/domain mutation |
| 冷启动临时不可用 | PASS；TypeError、HTTP 429 和 503 保持 paired offline，并继续显示持久 outbox |
| Project 外 Artifact 与任意操作路由 | PASS；远程设备 app 返回 404，不下发内容 |

## 尚未证明

- 真实手机配对、锁屏、弱网、网络切换、撤销后的浏览器存储清理与人工体验：
  `NOT_PROVEN`。Playwright viewport 不能替代实机。
- 公网域名、生产 CA 证书、反向代理、NAT、防火墙、Tailscale/WireGuard 和生产
  速率边界：`NOT_PROVEN`。
- 移动 Artifact/Evidence 摘要预览：`NOT_PROVEN`；本任务只证明远程边界不会
  泄露 Project 外 Artifact。
- Orca、Codex、CodeBuddy、Cursor 或其他真实 Provider 的移动控制：
  `NOT_PROVEN`。本任务没有提升任何 Provider capability。
- 生产签名、分发和发布：未执行。
