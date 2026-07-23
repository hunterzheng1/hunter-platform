# First Vertical Slice Task 17 本机验证

- 日期：2026-07-24
- 平台：Windows
- 范围：Hunter 移动设备身份、轮换令牌、TLS 远程边界、幂等控制命令与 PWA 合同
- 证据性质：仅证明 Hunter 自有契约与本机测试夹具；不证明任何真实 Runtime Provider、生产主机或公网部署

## 验证矩阵

| 边界 | 本机结果 | 证据 |
| --- | --- | --- |
| 配对挑战 | PASS | 仅认证桌面通道可创建；SQLite 只保存挑战摘要、创建主体、过期与消费状态；重启后仍可验证 |
| 手机设备证明 | PASS | 非导出 P-256 私钥保存在 IndexedDB；注册和完成领取都要求同一私钥签名 |
| 桌面确认 | PASS | 命名 IPC 严格校验请求；确认主体必须与挑战创建主体一致；Project 越权被拒绝 |
| 凭据领取 | PASS | 手机凭设备证明一次领取；签发刷新族与领取标记位于同一 SQLite 事务，注入故障会回滚 |
| Access claims | PASS | `iss`、`aud`、`sub`、`iat`、`nbf`、`exp`、`jti`、scope、Project、设备版本与 `cnf` 均被校验 |
| Refresh rotation | PASS | 每次使用轮换；旧值重放会撤销整个 family；服务端只保存摘要 |
| 设备撤销 | PASS | 设备版本更新和全部 refresh family 撤销在同一事务；故障注入会整体回滚 |
| 命令幂等 | PASS | 相同 idempotency key + 相同 fingerprint 返回原 receipt；不同 payload、旧版本和跨对象重放被拒绝 |
| Flow 语义 | PASS | 手机命令进入 canonical Flow；agent return、process exit、terminal idle、window opened 均不完成 Step |
| Remote boundary | PASS | 默认关闭；显式启用要求 TLS 1.3、Host/Origin allowlist、bearer + device proof、限流/并发/体积限制；SSE 按 Project 过滤 |
| PWA 凭据边界 | PASS | access token 仅在 Runtime 内存；refresh 仅在 IndexedDB vault；service worker 绕过 API、auth、pairing、events 与 command |
| 390px 移动轨迹 | PASS | Playwright `mobile` 项目在 Pixel 7 viewport 完成 fail-closed 路径，未发出敏感 API 请求，也未生成凭据存储 |

## 实际命令与结果

| 命令 | 结果 |
| --- | --- |
| `npm install` | PASS；lockfile 已同步；审计报告 4 个 high，未自动改写依赖 |
| Task 17 扩展精确 Vitest 套件 | PASS；12 files、129 tests；覆盖 device、daemon、vault、outbox、Runtime、React composition、desktop IPC、Flow 与 journal |
| `npx.cmd playwright test e2e/mobile-security.spec.ts --project=mobile` | PASS；1 passed |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm test` | 首轮 811/814，通过断言无失败但 3 个 Git fixture 超过默认 5 秒；保留该失败历史。将该集成测试时间盒明确为 20 秒后复跑，并在新增安全负例后最终 PASS：87 files、816 tests |
| `npm run build` | PASS |
| `npm run build -w @hunter/web` | 首轮发现浏览器包错误引入 Node `crypto` 并失败；改为 browser-safe contracts + WebCrypto 后复跑 PASS |

## 尚未证明

- GitHub Actions 的 Windows/Ubuntu 远端运行：PENDING，提交推送后观察真实结果。
- 公网域名、正式证书、反向代理、NAT、防火墙和真实手机跨设备链路：NOT_PROVEN。
- 生产签名、安装器发布、应用商店与生产发布：NOT_PROVEN，且不在本任务授权范围。
- Orca、Codex、CodeBuddy、Cursor 等真实 Provider 的移动控制能力：NOT_PROVEN；Fake/本机契约结果不得提升其能力等级。
