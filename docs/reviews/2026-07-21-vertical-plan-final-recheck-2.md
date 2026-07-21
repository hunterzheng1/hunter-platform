# First Vertical Slice I-07 最终复核（二）

- 复核对象：`docs/plans/2026-07-21-first-vertical-slice.md`、`docs/plans/README.md`
- 复核范围：I-07 的 13A→Tasks 14–19→13B 执行链与 RED/ GREEN 证据
- 复核方式：只读，不修改计划，不执行 Git

## Verdict

**REVISE — I-07 open。**

13A 的步骤编号、Playwright project 创建顺序和计划索引已经修正，原来的文件所有权循环也已消失；但 13A 的 RED 仍无法按文档要求“进入 owner story”，因为它调用的 `start:e2e` 脚本要到 Task 19 才创建。当前 Step 4 必然先在 Playwright webServer 启动阶段失败，不能作为计划声明的 owner-story RED 证据。

## 已关闭部分

- 总优先级明确 13A 只创建 RED contract，Task 19 负责 composition 与 `start:e2e`，13B 等 Task 19 API-chain test 变绿后才能开始（纵向计划 `:21-30`）。
- 正文给出单向依赖：Task 12→13A Steps 1–4→Tasks 14–19→13B Steps 5–9；Task 19 修改 13A 创建的文件，13B 不给 Task 19 提供输入（`:1817-1824`）。Task 14 入口重复同一顺序（`:1973-1975`）。
- 13A 现在按 spec→fixture shell→Playwright config 的顺序创建文件；`chromium` project 已在运行 RED 前定义（`:1834-1887`），随后 Step 4 才引用该 project（`:1890-1897`）。上一轮的 missing-project 假红已消失。
- Task 19 将 `playwright.config.ts` 与 fake fixture 标为 Modify，而非 Create（`:2224-2239`），与 13A 的文件所有权一致。
- `docs/plans/README.md:16-20` 已正确写成 Tasks 1–12→13A→Tasks 14–19→Task 13B，不再误写 “Task 19: 13B”。

## 仍然 open 的阻断点

13A Step 3 的 Playwright config 在 `:1883-1886` 配置：

`webServer.command = "npm run start:e2e"`

但纵向计划明确由 Task 19 才创建 `scripts/start-e2e.mjs`（`:2224-2239`），并在 Task 19 Step 3 才给根 `package.json` 增加 `"start:e2e": "node scripts/start-e2e.mjs"`（`:2261-2265`）。Foundation 计划也没有预先定义该脚本。

因此严格执行 13A Step 4 的 `npx playwright test ... --project=chromium`（`:1890-1892`）时，Playwright 会先启动 webServer，`npm` 随即以 missing `start:e2e` script 退出；浏览器测试体尚未执行。这与 `:1894-1897` 同时要求“FAIL inside the owner story”且“不能是 missing-config/project/syntax/import error”不相容。虽然缺脚本不属于列出的四种错误，它仍是 composition 之前的 launcher 配置错误，而不是 owner story 内的功能 RED。

## 最小关闭方式

若必须保留“RED 已进入 owner story”的要求，13A 需要先创建一个最小、仅测试用的 launcher 与根 `start:e2e` script：它只启动可加载的 Web 静态页面和 readiness，不伪造认证 daemon/composition；owner story 应在首次需要真实 application service 时以明确缺失能力失败。相应地：

1. 将 `scripts/start-e2e.mjs` 与根 `package.json` 加入 13A Files/实现/提交范围。
2. Task 19 将 `scripts/start-e2e.mjs` 从 Create 改为 Modify，并把最小 launcher 升级为完整 authenticated composition lifecycle。
3. 13A RED 断言测试体确实开始执行，并以预期的 application/composition 缺失码失败，而不是 webServer、配置、project、语法或 import 启动错误。

如果不愿在 13A 创建 launcher，则只能把 Step 4 的 Expected 改成“缺少 `start:e2e` 的契约级 RED”；但这不满足本轮明确要求的“必须进入 owner story”，不能据此关闭 I-07。

完成上述 launcher 所有权修订后，I-07 可标为 closed，整体纵向计划可进入 Ready。
