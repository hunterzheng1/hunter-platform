# First Vertical Slice I-07 最终复核（四）

- 复核对象：`docs/plans/2026-07-21-first-vertical-slice.md`、`docs/plans/README.md`、`.gitignore`
- 复核重点：单向依赖、launcher 所有权、认证状态交接、RED 原因可达、最终 GREEN
- 复核方式：只读，不修改计划，不执行 Git

## Verdict

**READY — I-07 closed。**

13A→Tasks 14–19→13B 已成为单向且可执行的依赖链。13A 能启动安全的最小测试组合、完成认证 Project/Requirement 路径，并以领域事件位置和明确错误码证明 RED 发生在尚未接通的 Run composition；Task 19 随后升级同一个 launcher 并完成 API-chain 与浏览器 GREEN。上一轮所有残口均已关闭。

## 关闭证据

### 1. 依赖与文件所有权单向

- 正文规定 Task 12→13A Steps 1–4→Tasks 14–19→13B Steps 5–9，并明确 Task 19 只修改 13A 创建的文件，13B 不向 Task 19 提供输入（纵向计划 `:1817-1824`）。
- 13A Files 创建 `scripts/start-e2e.mjs` 并修改根 `package.json`、Playwright config 与 `.gitignore`（`:1826-1835`）。
- Task 19 将 launcher、package 与 Playwright config 全部标为 Modify（`:2255-2270`），没有再创建第二套启动器。
- `docs/plans/README.md:16-20` 与正文、Task 14 入口采用相同的 Tasks 1–12→13A→14–19→13B 顺序。

### 2. 端口和并发占用契约唯一

- 13A 明确只有 daemon 使用 OS-assigned random loopback port；test-only Web/readiness 固定在 loopback `4173`，并由 `.hunter-e2e/active.lock` 独占（`:1877-1884`）。
- Playwright 的 `baseURL` 与 readiness URL 同样固定为 `127.0.0.1:4173`（`:1898-1913`），不存在随机 Web 端口与硬编码 URL 的冲突。
- Task 19 保留相同的 4173 Web/readiness + exclusive lock，同时继续让 daemon 使用随机端口（`:2292-2296`）。

### 3. 认证状态在 readiness 前完成安全交接

- 13A launcher 通过 Foundation authentication port provision test-scoped principal，在 readiness 前原子写 `.hunter-e2e/playwright-state.json`，内容包括限定 session cookie/origin 与 CSRF bootstrap；Windows ACL/POSIX mode 限制为当前用户，退出时删除 state/lock（`:1883-1888`）。
- Playwright config 显式以 `use.storageState` 加载同一文件（`:1905-1910`），owner story 不再依赖未声明的认证 bootstrap。
- `.hunter-e2e/` 已加入仓库 `.gitignore:5`，计划同时禁止凭据或状态文件被 stage/package（纵向计划 `:1893-1896`）。
- Task 19 原子替换同一 storage-state handoff 为 device-bound session，并明确 Web 客户端不得回退到未认证请求（`:2292-2296`）。

### 4. RED 原因可达且不可伪造

- 13A Step 3 的最小组合能渲染 Project 页面并接受 Project/Requirement commands，只故意不连接 Flow→Runtime→Verifier→Archive→Knowledge（`:1877-1892`）。
- Step 4 要求 web server、readiness、认证 Project/Requirement 与 `chromium` project 全部先成功（`:1916-1924`）。
- 有效 RED 必须先出现已提交的 `ProjectCreated` 与 `RequirementRevisionApproved` positions，随后才得到 `RUN_COMPOSITION_NOT_WIRED`；`401`、CSRF 或任何更早失败均被定义为无效 RED，必须先修复（`:1925-1928`）。这使测试确实进入 owner story，而不是在 launcher、配置或认证边界假红。

### 5. Task 19 提供完整 GREEN 与完成证据

- Task 19 的 API-chain RED 明确枚举 ApplicationServices、StartRun、Flow→Runtime→Verifier、terminal→Archive、Archive→Knowledge 与 EventLedger→SSE 的缺失边（`:2272-2280`）。
- composition root 与 startup recovery 接通完整事务、Outbox、外部回执、Verifier、Archive、Knowledge 和授权事件流（`:2282-2290`）。
- 升级后的 launcher 使用同一认证 handoff，保留安全边界并完成完整 composition（`:2292-2296`）。
- GREEN 同时运行 composition test、`start:e2e --verify` 与 Chromium owner story，并要求两个 Attempts、唯一 native session、终态父子 Run、验证过的 Archive、Project-scoped Knowledge 和重启后可重放事件（`:2298-2309`）。

## Final status

I-07 无剩余 open 项；纵向计划可按规范顺序进入实现与最终验收。
