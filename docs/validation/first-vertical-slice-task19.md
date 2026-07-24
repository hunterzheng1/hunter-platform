# First Vertical Slice Task 19 本机验证证据

- 日期：2026-07-24
- 平台：Windows
- 结论范围：仅证明 Hunter 的生产 composition root、确定性 Fake Runtime 契约、认证 E2E 启动器和浏览器纵向切片。
- 非结论：不证明任何真实 Provider、Orca/Codex/CodeBuddy/Cursor 生产能力，不证明远端 CI，不构成发布验收。

## Composition graph

```text
认证 HTTP
  -> Application composition
  -> StartRun / FlowEngine
  -> Event + command receipt + Outbox
  -> OperationWorker
  -> provider-neutral Runtime port
  -> side-effect receipt + Evidence
  -> CompletionVerifier
  -> Flow transition / bounded retry
  -> terminal Archive job
  -> project-scoped Knowledge projection
  -> authenticated Event Ledger replay
```

生产入口 `apps/daemon/src/main.ts` 和测试 fixture 均调用
`createApplicationComposition(...)`。Fake Runtime 与浏览器辅助代码位于测试目录；
桌面 sidecar 构建会扫描并拒绝包含确定性 fixture 标记的生产 bundle。

## RED -> GREEN 历史

| 变更簇 | RED（保留真实结果） | GREEN |
| --- | --- | --- |
| Composition/restart | 缺少 ApplicationServices、StartRun、Archive/Knowledge 恢复接线 | 重建所有进程内对象后继续同一 Run；无重复 launch/manifest |
| 多 Task 浏览器执行 | 初始 driver 只处理一个 Task，三节点 DAG 返回 `E2E_TEST_SERVER_ERROR` | 迭代 fan-out/reconcile，依赖节点在前置成功后运行 |
| 动态 readiness | Playwright fixture 首版因参数未使用对象解构而失败 | readiness fixture 动态读取版本化文件，Chromium 通过 |
| Windows ACL | 沙箱内创建 `.hunter-e2e/active.lock` 返回 `EPERM` | 在当前用户边界外重跑；文件应用真实 SID ACL，启动器通过 |
| Knowledge UI | 首次 Chromium 到达 Knowledge 页面但显示 `No Knowledge entries yet.` | 定位到代理丢失 `?includeHistorical=true`；加入精确查询白名单并转发后通过 |
| 客户端 schema | RED 测试证明 `passthrough` 会接受伪造 Provider 私有字段 | 改为严格判别联合、Project scope 与 manifest ref/hash 一致性验证 |

没有删除、伪装或改写上述失败；每次修复都基于对应原始错误或页面快照。

## 认证 API 摘要（已脱敏）

测试客户端只记录领域结果，不记录 session、CSRF、cookie 或原始请求头：

1. `POST /api/v1/projects` -> `201`
2. `POST /api/v1/projects/{projectId}/requirements` -> `201`
3. `POST .../requirement-revisions/{revisionId}/approve` -> `200`
4. `POST /api/v1/projects/{projectId}/changes` -> `201`
5. `POST /runs` -> `200`
6. `GET /api/v1/projects/{projectId}/knowledge?includeHistorical=true` -> `200`
7. `GET /events?once=1&cursor={savedPosition}` -> `200`，包含 `RunConcluded`

所有 Project 路由都使用认证 principal 的 Project 授权集合；浏览器代理只放行
owner story 的精确 method/path/query 组合。

## 两次重启与故障注入

1. 在第一个 `session.launch` durable receipt 后关闭应用和 SQLite，重新创建
   composition、Fake Runtime、Verifier 与数据库连接。启动恢复只提交已观察事实，
   原 operation 的外部 native effect 计数保持为 1。
2. 在 Archive receipt 已持久化、Knowledge 尚未投影处注入
   `INJECTED_AFTER_ARCHIVE_RECEIPT`，再次关闭并重建应用。租约到期后恢复 worker，
   最终得到 3 个 completed Archive jobs 和 3 个同 Project Knowledge entries。

最终 root/child Run 共 3 个，全部 `succeeded`；两个 child 的 Attempt 数为 `[1, 2]`；
`session.launch` Outbox 数为 3，没有因重启重复 launch。执行返回、进程退出或
terminal idle 均未直接完成 Step；只有 verifier receipt 产生成功转换。

## 启动器与浏览器

`npm run start:e2e -- --verify`：

```json
{"status":"ready","webOrigin":"http://127.0.0.1:4173","daemonPortMode":"random_loopback","authenticatedHealth":"pass","playwrightState":"created_then_cleanup","cleanup":"owned_resources_only"}
```

readiness 只包含 schema version、loopback origin 和相对 storage-state 路径；
不包含 token、cookie、CSRF、绝对用户路径或环境变量。启动器清理自己拥有的状态、
监听器、临时数据目录和锁，不接触开发者数据。

`npx playwright test e2e/vertical-slice.spec.ts --project=chromium`：

- 最终结果：1 passed（7.1s）
- 页面验证：Project -> Requirement approval -> parallel Change DAG -> Run
  -> failed verifier -> fresh retry -> success -> Archive -> Knowledge
- Knowledge 页面实际显示 `historical · active`、`archive · run_*` 和
  `sha256:<64 lowercase hex>`

## 本机门禁

| 命令 | 结果 |
| --- | --- |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm test` | PASS，92 files / 842 tests |
| `npm run build` | PASS |
| `npm run build -w @hunter/desktop` | PASS；生产 sidecar 不含 E2E fixture 标记 |
| Task 19 精确 Vitest 集 | PASS，7 files / 40 tests |
| `npm run start:e2e -- --verify` | PASS |
| Chromium vertical slice | PASS，1 test |
| `git diff --check` | PASS |

## 远端 CI

本文件初次创建时 Task 19 尚未推送，Windows/Ubuntu GitHub Actions 如实记录为
`PENDING`。推送提交 `75882c07fed0cd91d238a07694080eaea5cae136`
后，两类触发均已核对为 `PASS`：

| 触发 | Run | Ubuntu | Windows |
| --- | --- | --- | --- |
| push | `30062362687` | PASS（1m02s） | PASS（1m50s） |
| pull_request | `30062364290` | PASS（59s） | PASS（2m04s） |

四个 job 的 `npm ci`、lint、typecheck、unit、rebuild、recovery 和 build
步骤均成功。GitHub 对 `actions/checkout@v4`、`actions/setup-node@v4`
给出 Node 20 deprecation 注释，同时明确这些 action 已被强制在 Node 24
执行；该注释不是失败，但后续应在 action 发布兼容版本时升级。

真实 Provider、真实凭据、生产签名、商店发布和远端部署均未运行。
