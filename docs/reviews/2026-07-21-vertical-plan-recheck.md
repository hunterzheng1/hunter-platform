# First Vertical Slice 修订后复审

- 复审对象：`docs/plans/2026-07-21-first-vertical-slice.md`
- 对照：`docs/reviews/2026-07-21-vertical-security-review.md` 的 6 项，以及 `docs/reviews/2026-07-21-internal-design-review.md` 的 I-02、I-03、I-05、I-07
- 复审方式：只读计划，不修改计划或执行 Git；逐项检查文件范围、RED、最小实现、GREEN 命令/预期与完成证据

## Verdict

**REVISE — 7 项 closed，3 项 partially_closed，0 项 open。**

Tasks 14–19 已经不是口号式补丁：六个 Task 都具备明确 Files、RED 失败契约、最小实现边界、GREEN 命令与预期、完成证据，且总优先级规则明确宣布旧样例失效（计划 `:21-32`）。但两个原 Critical 安全项仍各有一个可实现性缺口，Task 13/19 还有一个真实的执行顺序环；在这三处修正前不能标为 Ready。

## Tasks 14–19 可执行性检查

| Task | Files | RED | 最小实现 | GREEN 命令/预期 | 完成证据 | 结论 |
|---|---|---|---|---|---|---|
| 14 Boundary / Operations / Leases | `:1967-1980` | `:1982-1992` | `:1994-2004` | `:2006-2010` | `:2017` | 五要素齐全 |
| 15 Capability probes | `:2021-2033` | `:2035-2047` | `:2049-2051` | `:2053-2057` | `:2064` | 五要素齐全 |
| 16 Local Electron/API security | `:2068-2078` | `:2080-2088` | `:2090-2094` | `:2096-2100` | `:2107` | 五要素齐全 |
| 17 Device/mobile security | `:2111-2127` | `:2129-2145` | `:2147-2149` | `:2151-2155` | `:2162` | 五要素齐全；密钥语义仍需修正 |
| 18 Archive/Knowledge | `:2166-2176` | `:2178-2186` | `:2188-2192` | `:2194-2198` | `:2205` | 五要素齐全 |
| 19 Composition/E2E | `:2209-2222` | `:2224-2232` | `:2234-2248` | `:2250-2254` | `:2261` | 五要素齐全；前置文件顺序未闭合 |

## 逐项复审

### VS-01 外部路径与 ID canonicalization — partially_closed

已关闭的部分：

- Task 14 要求按前缀构造 Zod branded IDs，限制长度与字符集，并以 `realpath.native` 处理 Windows drive、UNC、extended path、junction 与 Linux symlink，随后按 Repository/DeviceBinding/Project 做 segment-aware scope 校验（`:1982-1984, 1994-1998`）。
- RED 覆盖伪造跨 Project ID、路径逃逸、大小写/UNC/长路径别名、`workspaceRef` 与路径混用、未品牌化 `operationId` 文件名；GREEN 明确要求在 dispatch 前拒绝（`:1982-1992, 2008-2010`）。

未关闭的部分：Task 14 的 Files 只列 domain、runtime-contracts、runtime-manager、Orca 与 Cursor（`:1967-1980`），没有列出仍直接转发原始字符串的 `apps/daemon/src/routes/requirements.ts` 与 `apps/daemon/src/routes/changes.ts`。旧样例仍在 `:344-360, 503-529` 直接把 Fastify params/body 送入命令或用 `String(...)`/cast。总优先级虽在 `:25` 宣布这些写法无效，Task 16 的测试却只覆盖通用 malformed/oversized JSON、Host/Origin/auth（`:2080-2088`），没有一个具体 HTTP 领域路由测试证明 branded ID 与跨 Project 拒绝发生在 command call 前。因此执行者没有被指派去改这些文件，也没有对应 GREEN 证据。

最小剩余修复：把所有领域 route/schema 文件及一个 authenticated HTTP boundary 集成测试加入 Task 14 Files；RED/GREEN 必须逐个断言非法 route param、伪造 Project/Revision/Run 关系在 application command 调用前被拒绝。

### VS-02 跨进程副作用幂等 — closed

Task 14 把所有 `create/launch/send/resume/interrupt/open/write/release` 统一放进 Foundation `SqliteOperationJournal`、Outbox 与 `side_effect_receipts`，并禁止 adapter-local Map 充当恢复机制（`:1986-2004`）。测试重建数据库客户端、worker 和 adapter，分别覆盖可 attach/reconcile 与不可消歧时 `indeterminate/needs_attention`、零盲目重放（`:1988-1992`）；Task 15 又把 Codex/CodeBuddy 的 session 动作纳入相同 `ExternalOperationHandler` 契约（`:2041-2047`）。GREEN 与完成证据明确要求 fresh process 下仍只有一次外部副作用和持久回执（`:2008-2017`）。

### VS-03 CapabilityManifest 真实性 — closed

Task 15 定义逐原子、版本化、带来源/摘要/版本/login/probedAt 的 probe receipt，以及严格的 L0–L3 前缀计算规则（`:2035-2039`）。CodeBuddy 传输必须等于 Phase 0 选定 receipt，版本或 digest 漂移在网络调用前失败；Codex/CodeBuddy crash-after-create 也纳入持久动作测试（`:2041-2047`）。未知版本、schema drift、缺登录、缺 permission/observe/completion/recovery 均 fail closed，真实 E2E 比较完整 fixed-version matrix 而非宽松 `L2|L3`（`:2049-2064`）。

### VS-04 Electron、本机 API 与远程边界 — closed

Task 16 将 renderer 收窄为具名且双向 schema 校验的 IPC；main 生成每次启动 256-bit capability，经继承 pipe 交给随机 loopback 端口 daemon，renderer 不获得 origin、token、generic fetch、文件或 shell 能力（`:2080-2094`）。负例覆盖错误 Host/Origin、跨端口 POST、无 capability、cookie fallback、未认证 SSE、明文非 loopback、secret 泄漏；Event Ledger SSE 还带授权过滤、`Last-Event-ID` 与 gap/resync（`:2084-2100`）。Task 17 把非 loopback 模式隔离为显式 TLS 1.3 listener，要求 Origin allowlist、CSP、限制、bearer 加设备证明并拒绝 cookie fallback（`:2135-2145`）。旧 fixed port、`HUNTER_WEB_URL` 和 renderer HTTP 样例已由 `:28, 1531` 明确作废。

### VS-05 Pairing、Token 与设备绑定 — partially_closed

已关闭的部分：Task 17 要求 SQLite 持久 challenge hash/expiry/consumed、桌面确认、设备签名证明、五分钟 access token、30 天以内且每次轮换的 refresh family、reuse family revocation、设备 version/revocation 检查，以及 `iss/aud/sub/iat/nbf/exp/jti/scopes/projectIds/cnf`（`:2129-2133, 2147-2149`）。测试覆盖 daemon restart、边界过期、refresh replay、撤销、错误 audience、跨 Project 与 copied-token-on-another-key；服务端 signing key 走 OS credential store（`:2131-2133`）。

未关闭的部分：`:2131` 写成“non-extractable WebCrypto P-256 **public key**”。公钥必须能够导出/传给服务端；应不可导出的是设备**私钥**。计划也没有明确 PWA 如何持久保存这个 `extractable:false` 私钥句柄，以及 refresh credential 在客户端的受保护载体；`:2133` 的 “stored hashed” 只解决服务端记录，`:2149` 只说明 service worker 不缓存凭据，不能替代客户端持久化契约。按原审查要求，这会让设备持有证明的实现者得到相互矛盾的指令。

最小剩余修复：把模型改为“私钥以 `extractable:false` 生成并持久为 WebCrypto `CryptoKey`；只导出 public JWK”；在 Files/RED/GREEN 中明确客户端 key/refresh carrier、登出擦除、重装/丢 key、复制 refresh 无私钥证明失败等契约。

### VS-06 移动控制命令账本 — closed

Task 17 冻结完整 envelope：`projectId/runId/stepRunId|gateId/expectedVersion/idempotencyKey/action/payload`，并要求同一 SQLite 事务校验 device scope、对象关系、aggregate version，写 command receipt、Event 与 Outbox（`:2135-2139`）。同 key 同 fingerprint 返回原 receipt，同 key 不同对象/动作拒绝，stale 返回 409；双击、离线重放、撤销后重放、跨 Project/Step 与重复审批只推进一次均有 RED/GREEN 验证，客户端把稳定 key 留在 IndexedDB 直到终态 receipt（`:2137-2155`）。

### I-02 Connector 等级与 CodeBuddy 传输 — closed

结论同 VS-03。Task 15 不再按产品名或目标等级赋 L3，完整原子集合决定 level；CodeBuddy 的 kind/endpoint/protocol/version/digest 必须来自 Phase 0 选定证据，变化即在 I/O 前失败（`:2035-2057`）。旧实现由总优先级 `:27` 和 Task 15 明确覆盖。

### I-03 Workspace/Writer/Controller lease — closed

Task 14 将三类 lease 的 Project、Repository、Device、canonical workspace、Git HEAD、branch、owner Run/Attempt、generation、mode、expiry、revocation 纳入公共契约，且只有 Foundation lease service 可以 acquire/renew/release/recover，adapter 必须在 durable lease receipt 后 launch（`:1994-1998`）。RED 覆盖两个并行 writer 的独立 worktree、同路径冲突、错误 DeviceBinding/worktree、过期/stale generation 与恢复时 HEAD drift（`:1986-1992`），完成证据要求 `LEASE-01..06`（`:2017`）。计划入口同时要求 Foundation 先完成（`:13-17`），没有再建第二套 lease registry（`:1965`）。

### I-05 Archive 到 Knowledge — closed

Task 18 用 terminal Event 同事务创建持久 `archive_jobs`，覆盖 manifest 发布前、发布后 receipt 前、Archive receipt 与 Knowledge projection 之间三处崩溃，并在重建进程后断言唯一 manifest/entry（`:2178-2186`）。manifest 包含完整 Project/Revision/Plan/Workflow/root-child Run/Task/Attempt/Agent/session/lease/Git/Event/Artifact/Evidence provenance 与 hash；Knowledge 强制 Project scope，可按 Project 从验证过的 Archive 和 authoritative Requirement 确定性重建（`:2180-2198`）。旧同进程样例被 `:729` 与总优先级 `:29` 明确降为无效 RED 示例。

### I-07 Composition task 与 `start:e2e` — partially_closed

已关闭的部分：Task 19 新增真实 application services、StartRun、composition root、startup recovery、API-chain test 与 `scripts/start-e2e.mjs`（`:2209-2222`）；RED/实现明确连通 Flow→Outbox→Runtime→Verifier→Archive→Knowledge→durable SSE，包含两处 restart fault，并要求 fake 与 production 使用相同注入端口（`:2224-2242`）。`start:e2e` 使用隔离数据目录、随机端口、真实认证/设备证明、受限 storage state 和清理流程，且 production bundle 排除 fixture（`:2244-2261`）。

未关闭的部分：执行顺序形成环。`:30` 明确写“Task 13 cannot start”直到 Task 19 API test 为绿，`:1965` 也要求完成 14→19 后再回到 Task 13；但 Task 19 的 Files 把 `playwright.config.ts` 和 `e2e/fixtures/fake-runtime-scenario.ts` 标为 **Modify**（`:2219-2222`），它们实际要由 Task 13 `:1819-1824` 先 Create，Task 19 的 GREEN 还直接运行由 Task 13 Step 1 创建的 `e2e/vertical-slice.spec.ts`（`:1827-1851, 2250-2254`）。严格按计划执行时，Task 19 缺少前置文件；若先跑 Task 13，又违反 `:30`。

最小剩余修复：把 Task 13 拆成 13A“先写 owner-story RED/config/fixture shell”和 13B“Task 19 后的最终 CI/真实 Provider/验收报告”，或把三份 E2E 文件的创建完全移入 Task 19，并让 Task 13 只执行最终 acceptance。二者任选其一，确保单向依赖。

## 旧样例覆盖检查

- 总优先级 `:23-32` 明确 Tasks 14–19 是 release-blocking 且覆盖 Tasks 2–13；Archive、Electron、Pairing 还分别在 `:729, 1531, 1642` 有局部醒目声明。
- Task 6 的 raw Orca request 在 `:970-978` 已标注必须由 Task 14 的 branded IDs、DeviceBinding、Foundation leases 与 durable receipts 替换；Task 15 则直接修改 Codex/CodeBuddy/Cursor 文件并重新计算 manifest。
- 最终 completion evidence `:2263-2279` 与修订语义一致，没有重新允许内存幂等、固定 L3、明文远程入口或空 Project scope。
- 但优先级声明不能自动补齐未列入 Files/测试的 HTTP route 改造，也不能消除 Task 13/19 的文件创建环；这两项仍需结构化修订。

## Ready 条件

完成以下三处最小修订后，可再次复审为 Ready：

1. 给 Task 14 增加具体 daemon 领域路由文件和 authenticated HTTP branded-ID/cross-Project 边界测试。
2. 更正 Task 17 的 WebCrypto 私钥/公钥可导出语义，并冻结 PWA 私钥与 refresh credential 的客户端持久化和丢失/复制测试。
3. 拆开 Task 13/19，确保 E2E spec、fixture 与 Playwright config 在 Task 19 使用前已经由唯一、合法的前置 Task 创建。
