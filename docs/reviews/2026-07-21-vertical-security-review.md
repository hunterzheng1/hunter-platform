# First Vertical Slice 安全与契约审查

## 范围与结论

- 审查对象：`docs/plans/2026-07-21-first-vertical-slice.md`
- 对照基线：`docs/06-runtime-provider-and-connectors.md`、`docs/07-storage-security-and-remote-access.md`、`docs/08-user-stories-and-acceptance.md`
- 结论：**Critical 5，Important 1**。以下仅列会破坏安全边界、恢复语义或能力真实性的 6 项；不含样式与一般可维护性建议。

## 1. [Critical] 外部路径与 ID 在进入信任域前没有统一 canonicalization

**位置：** `docs/plans/2026-07-21-first-vertical-slice.md:932-955, 1302-1306, 1322-1326`（同类 HTTP 边界还见 `:335-338, 491-503`）
**基线：** `docs/06-runtime-provider-and-connectors.md:194-196, 244-246, 263-265, 277-282`；`docs/07-storage-security-and-remote-access.md:161-170, 281`

`OrcaClient` 用 TypeScript 强制断言接收未校验的 `repoId/worktreeId/path/terminalId`，随后把 Orca 返回的路径直接写入 `WorkspaceLease`。Cursor 更把本应为不透明标识的 `workspaceRef` 当作路径，仅执行 `isAbsolute + resolve`；这既不会解析 junction/symlink，也不会证明路径属于当前 `DeviceBinding` 和已注册 Repository。`writeTaskPack` 还把未经 ID 语法校验的 `operationId` 拼进文件名。HTTP route 参数同样直接进入命令层。结果是受污染的 Provider/客户端输入可以替换目标对象、逃逸项目根目录，或让 Artifact/原生窗口指向错误仓库。

**最小修复：** 在 runtime-contracts 增加一个共享边界解码器：对所有上游 JSON 做 Zod schema、长度与 ID 字符集校验；对 Windows 路径执行 `realpath.native` 后按大小写/UNC/长路径规则生成 canonical key，并校验其精确匹配当前 Repository/DeviceBinding 或位于获权 workspace 内。Cursor 接口改为同时接收不透明 `workspaceRef` 与已验证 `workspacePath`，禁止自行把二者互换；文件名只使用解析后的 branded `OperationId`。补充 junction/symlink 逃逸、不同大小写/UNC、伪造外部 ID 与跨 Project ID 的拒绝测试。

## 2. [Critical] 四个适配器都没有可跨进程恢复的副作用幂等语义

**位置：** `docs/plans/2026-07-21-first-vertical-slice.md:876-901, 946-958, 1071-1081, 1196-1205, 1302-1307, 1322-1327`；计划自己的总检查项在 `:1975` 仍宣称所有真实动作都有幂等键
**基线：** `docs/06-runtime-provider-and-connectors.md:132-138, 267-284`；`docs/07-storage-security-and-remote-access.md:89-106, 108-123`；`docs/08-user-stories-and-acceptance.md:83-94, 148-149`

Orca 只用进程内 `Map` 去重；在 Orca 已创建 worktree、Hunter 尚未保存回执时崩溃，重建 Provider 后会再次创建。Codex 的 `operationId` 未送入启动协议或持久映射，CodeBuddy 的 `newSession` 没有幂等键，Cursor 重试会再次覆盖 task pack 并再次打开窗口。现有测试只覆盖同一实例内的顺序调用，无法满足“Core/Orca 重启后不重复 Session”的验收。

**最小修复：** 所有 `launch/create/send/interrupt/open` 统一以 `operationId` 作为持久幂等键，经 Core 的 Outbox/receipt store 记录 `operationId -> native ref/result`；上游支持 client request ID 时原样传入，不支持时用确定性标签先查询/attach，再决定创建，无法消歧则进入 `needs_attention` 而不是重放。增加故障注入契约测试：在外部创建成功、回执落库前崩溃，使用全新 adapter 实例重启后仍只存在一个 worktree/session/window handoff，并返回原 receipt。

## 3. [Important] CapabilityManifest 是硬编码营销标签，并与实际方法不一致

**位置：** `docs/plans/2026-07-21-first-vertical-slice.md:1066-1079, 1192-1205, 1319-1327, 1887-1895`
**基线：** `docs/06-runtime-provider-and-connectors.md:38-49, 51-84, 267-284`；`docs/07-storage-security-and-remote-access.md:285`；`docs/08-user-stories-and-acceptance.md:143-147, 181-195, 298`

Codex 和 CodeBuddy 无 `probe()`、登录/版本/协议协商，却固定声明 L3。Codex 声明 `approve` 但没有批准方法；CodeBuddy 声明 `observe`、`approve`，实现中既没有事件流也没有权限事件或完成回执；Cursor 声明 `collect_artifacts`，任务中没有 collector；Orca 也没有可供 Flow 决策的 manifest。真实 Provider E2E 只断言 Codex/CodeBuddy 的等级匹配 `L2|L3`，不能发现缺能力时仍报高等级。

**最小修复：** 每个适配器实现版本化 `probe()`，逐项返回 support 状态、证据来源、版本约束和探测时间；等级由已验证能力的最低集合计算，未知版本/schema 漂移 fail closed。删除未实现 capability，只有权限事件、可靠恢复、完成回执和策略钩子均通过真实契约测试时才授予 L3。E2E 改为按实际固定版本断言逐项 capability，并加入缺登录、缺方法、未知版本和 schema 漂移的降级测试。

## 4. [Critical] Electron 与浏览器 API 边界没有本地认证 secret，也没有远程 TLS/Origin/CSRF 契约

**位置：** `docs/plans/2026-07-21-first-vertical-slice.md:1551-1552, 1567-1579, 1699-1711, 1875-1877`
**基线：** `docs/07-storage-security-and-remote-access.md:172-179, 203-219, 247-255`

桌面端以固定端口启动 daemon，并把固定 HTTP API origin 暴露给 renderer；没有每次启动的本地认证、Host/Origin 限制或 CSRF 机制。`HUNTER_WEB_URL` 还能令窗口加载任意来源，而 preload 仍暴露本地 API 地址。移动任务只添加两个裸 route，测试仍以 loopback HTTP 模拟“mobile”，没有定义显式开启远程监听、非本机 TLS/双向设备认证或浏览器安全头。这样任何本机恶意页面/进程都可能驱动 API；若为手机直接开放端口，则会得到未加密、缺 Origin/CSRF 约束的控制面。

**最小修复：** desktop renderer 改走窄化的 preload IPC，由 main 持有高熵本地 capability 并代签请求；secret 通过受保护的进程间通道/系统凭据库传递，禁止放入 URL、环境变量、preload 对象和日志。daemon 默认随机端口且仅 loopback，严格校验 Host/Origin；远程模式必须显式启用独立 HTTPS listener，并要求设备双向证明。cookie 场景使用 `HttpOnly + Secure + SameSite=Strict` 和 CSRF token，bearer 场景拒绝 cookie 回退并仍执行 Origin allowlist/CSP。增加“无本地 token、恶意 Origin、跨站 POST、明文非 loopback、未认证 SSE”均拒绝的集成测试。

## 5. [Critical] Pairing/Token 不是可撤销、可过期、设备绑定的持久身份

**位置：** `docs/plans/2026-07-21-first-vertical-slice.md:1639-1646, 1673-1695, 1705-1710, 1799-1803`
**基线：** `docs/07-storage-security-and-remote-access.md:172-179, 211-219, 247-251, 278-280`；`docs/08-user-stories-and-acceptance.md:110-123, 153-155`

配对码仅存在内存；`desktopDeviceId` 被忽略，签发无需双方密钥证明或桌面确认。token payload 只有可变 `name` 与 scopes，没有 `deviceId/sub`、`exp/iat`、`jti`、issuer/audience、项目授权或设备公钥绑定，也没有 refresh rotation、持久设备表和撤销检查；只要签名 key 不变，token 永久有效。计划也未规定签名 key 和手机 token 的安全持久化。单测只证明“同一进程里 code 用一次”和“缺一个 scope”，无法证明重启、撤销、过期或跨设备盗用安全。

**最小修复：** 在 SQLite 事务中持久化配对 challenge 的哈希/expiry/consumed 状态和独立 Device 记录；pair 时验证设备非导出公钥的 challenge proof，并要求已认证桌面会话确认名称、权限和有效期。签发数分钟访问 token（含 `sub=deviceId, exp, iat, jti, aud, scopes, projectIds`）和轮换 refresh credential，每次授权查询设备 revocation/version 并验证设备持有证明；服务端 key 放系统凭据库，PWA 使用 WebCrypto 非导出私钥与受保护的 refresh 载体。增加 daemon 重启、过期边界、旧 refresh 重放、单设备撤销立即生效和把 token 拷到另一设备失败的测试。

## 6. [Critical] 移动控制只有 UI callback，没有带 expected version 与幂等账本的服务端命令

**位置：** `docs/plans/2026-07-21-first-vertical-slice.md:1617-1630, 1702-1711, 1724-1727, 1799-1803, 1946`
**基线：** `docs/07-storage-security-and-remote-access.md:89-106, 221-237, 247-254`；`docs/08-user-stories-and-acceptance.md:110-123, 153-155, 251-253`

Task 12 唯一新增的 daemon route 是配对；批准、补充输入、暂停、继续、终止都只是接收 `runId` 的 React callback。计划没有定义移动命令 API、Actor/设备审计、Project/Run/Step/Gate 绑定、`expectedVersion` 或 `idempotencyKey`，也没有原 receipt 返回语义。因而双击、断线重试或离线重放可能重复推进 Step，过期页面还可能控制新版本状态；相同 ID/令牌也缺少跨对象重放防护。最终 acceptance 只记录 390px UI，未验证 Journey G。

**最小修复：** 增加统一 authenticated command envelope：`projectId, runId, stepRunId/gateId, expectedVersion, idempotencyKey, action, payload`。服务端在同一事务中验证设备 scope、对象关系和 aggregate version，写幂等记录/Event/Outbox；相同 key+相同命令返回原 receipt，相同 key+不同对象拒绝，旧版本返回 409 并要求刷新。客户端为一次用户动作生成稳定 key，并持久到收到终态 receipt，重试不得生成新 key。补充双击、断网重放、旧版本、撤销后重放、跨 Project/Step 重放及重复审批只推进一次的 Security E2E。
