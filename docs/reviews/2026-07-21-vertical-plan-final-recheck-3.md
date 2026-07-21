# First Vertical Slice I-07 最终复核（三）

- 复核对象：`docs/plans/2026-07-21-first-vertical-slice.md`、`docs/plans/README.md`
- 复核重点：依赖是否单向、13A owner-story RED 是否可达、计划入口顺序是否一致
- 复核方式：只读，不修改计划，不执行 Git

## Verdict

**REVISE — I-07 open。**

上一轮的 missing `start:e2e` 阻断已经关闭：13A 现在拥有最小 launcher 与 root script，Task 19 只升级它；任务顺序和 README 也一致。但当前 Playwright config 没有消费 launcher 写出的认证 storage state，并同时把 Web 地址固定为 4173、与 launcher 的“OS-assigned ports”描述冲突。因而计划仍不能证明 Step 4 会通过认证 Project/Requirement 阶段并在第一个未接通的 Run/verification transition 才失败。

## 已关闭部分

- 13A Files 已加入 Create `scripts/start-e2e.mjs` 和 Modify `package.json`（纵向计划 `:1826-1834`）。
- 13A Step 3 要求创建可运行、使用 Foundation 认证边界的 RED scaffold，启动 daemon/Web、完成 readiness，并加入根 `start:e2e` script；它只故意缺少 Flow→Runtime→Verifier→Archive→Knowledge（`:1876-1890`）。这消除了 missing-script 启动失败。
- 13A Step 4 明确要求 web server、readiness、认证 Project/Requirement 和 `chromium` project 均成功，并排除 script/config/project/syntax/import/auth/startup 假红（`:1906-1914`）。
- Task 19 将 launcher 标为 Modify（`:2241-2256`），并明确“升级 13A scaffold、保留 root script”，而不是重新创建第二套 launcher（`:2278-2282`）。文件所有权和升级关系已成为单向。
- `docs/plans/README.md:16-20` 与正文 `:1817-1824, 1973-1975` 都给出 Tasks 1–12→13A→Tasks 14–19→13B 的同一顺序。

## 仍然 open 的 RED 可达性

### 1. launcher 写了 storage state，但 Playwright 没有加载

13A Step 3 在 `:1881-1883` 要求 launcher provision test-scoped local principal，并写 restricted readiness/storage state。然而完整的 Playwright config 在 `:1892-1903` 中只设置：

- `use.baseURL`
- `use.trace`
- `webServer`
- projects

它没有 `use.storageState`、project-level `storageState`、global setup 或任何从 readiness manifest 读取认证状态的机制。owner story 本身也只从 `page.goto("/")` 开始（`:1836-1860`），没有认证 bootstrap。Foundation 的本机 API 明确拒绝缺失 credential/CSRF 的浏览器写请求；仅在磁盘上“写出” storage state 不会自动把它装入 Playwright browser context。因此 Project/Requirement 命令可能先以未认证失败，与 `:1910-1914` 要求的 RED 原因不符。

### 2. Web 端口契约相互矛盾

`:1878-1881` 说 daemon 和 current web assets 都使用 OS-assigned loopback ports，但 config 在 `:1899-1901` 把 `baseURL` 与 readiness URL 固定为 `127.0.0.1:4173`。若 launcher真的使用 OS-assigned Web 端口，Playwright 会等待错误地址；若 Web 固定使用 4173，则计划应明确只有 daemon 使用随机端口、4173 是 test-only asset/readiness 端口。当前两种实现都能从文档中得到，不能保证 readiness 可达。

## 最小关闭方式

1. 冻结一个明确机制把认证状态交给 Playwright。例如规定 launcher 在已知受限路径写 storage state，并让 `playwright.config.ts` 的 `use.storageState` 明确读取该路径；或用等价的 global setup/fixture，在 browser context 创建前装入同一认证与 CSRF 状态。
2. 冻结 Web 地址策略：最简单的是明确 daemon 使用 OS-assigned random port，而 test-only Web/readiness 固定为 4173；或者让 config 通过一个在求值时可用的、定义清楚的 manifest/环境机制取得动态 Web URL。
3. 在 13A Step 4 的 RED 证据中记录测试体已完成 Project 创建和 Requirement 批准，随后以指定的“Run composition not wired”错误失败。这样才能证明不是认证、端口或 readiness 假红。

完成这三处同属一个 RED-scaffold 契约的小修订后，I-07 可标为 closed，纵向计划可判 Ready。
