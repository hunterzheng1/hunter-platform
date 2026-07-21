# First Vertical Slice 最终复审

- 复审对象：`docs/plans/2026-07-21-first-vertical-slice.md` 与其执行入口 `docs/plans/README.md`
- 复审范围：上一轮留下的 HTTP 领域边界、PWA 设备凭据、Task 13/19 执行依赖三项
- 复审方式：只读，不修改计划，不执行 Git

## Verdict

**REVISE — 2 项 closed，1 项 open。**

两个原 Critical 安全残口已经形成 Files→RED→实现→GREEN→提交/证据闭环。Task 13/19 原先的文件所有权循环也已经拆成单向依赖，但 13A 内部仍在 Playwright project 被创建前引用它，且计划索引把最终阶段误标为 Task 19；严格按当前顺序无法得到计划声明的 RED 证据。因此暂不标为 Ready。

## 1. Task 14 的 HTTP 领域路由边界 — closed

修订已覆盖上一轮缺口：

- Files 明确加入 `packages/api-contracts/src/http.ts`、Requirement/Change/Run 三组 daemon routes，以及 `apps/daemon/test/domain-route-boundary.test.ts`（计划 `:1974-1992`）。这些文件也进入最终 `git add` 范围（`:2024-2026`）。
- RED 要求 authenticated HTTP 测试逐组覆盖非法 branded ID、unknown field、跨 Project RequirementRevision、Change/ExecutionPlan 不匹配和 Run/Project 不匹配，并证明在 mocked application command 被调用前拒绝（`:1994-1996`）。RED 命令确实包含该集成测试（`:2002-2004`）。
- 最小实现规定 `packages/api-contracts` 持有严格 request/response schema，每条 route 先 parse params/body、加载 authenticated Project relation，再调用 application command（`:2006-2008`）。
- GREEN 命令再次包含 route boundary 测试，预期所有非法 path/ID 均在 dispatch 前拒绝；提交范围包含 contracts、全部 routes 与测试（`:2018-2026`）。

结论：原 VS-01 已关闭。

## 2. Task 17 的 WebCrypto 私钥与客户端 refresh carrier — closed

修订已覆盖上一轮缺口：

- Files 新增 `apps/web/src/mobile/credential-vault.ts` 及其独立测试（`:2123-2141`），两者也被 `apps/web/src/mobile` 的提交范围包含（`:2171-2173`）。
- RED 明确由 PWA 以 WebCrypto `extractable: false` 生成 P-256 **private key**，在 IndexedDB 持久化 `CryptoKey` handle，只导出 public JWK；配对要求对应私钥签名（`:2143-2145`）。
- refresh credential 在客户端与不可导出私钥 handle 绑定，不进入应用状态、缓存、URL、日志、导出或任务内容；logout/revocation 擦除，reinstall/丢 key 必须重新经桌面确认配对，复制 access/refresh 到另一 key 必须证明失败（`:2147`）。
- RED/GREEN 均运行 `credential-vault.test.ts`，实现步骤也逐项要求 non-exportable private-key persistence、public-JWK export、protected refresh rotation、擦除和 lost-key re-pair（`:2157-2169`）。

结论：原 VS-05 已关闭。

## 3. Task 13A→14–19→13B 执行依赖 — open

已修正的主体结构：

- 总优先级把 Task 13 拆为 13A/13B，明确 13A 只创建 RED contract，13B 必须等 Task 19 API-chain composition 变绿（`:21-30`）。
- Task 13 正文给出单向顺序：Task 12→13A Steps 1–4→Tasks 14–19→13B Steps 5–9，并明确 Task 19 只修改 13A 创建的文件，13B 不向 Task 19 提供输入（`:1817-1824`）。
- Task 14 重复相同顺序（`:1970-1972`）；Task 19 对 `playwright.config.ts` 和 fake fixture 使用 Modify，符合 13A 先 Create 的所有权（`:2221-2236`）。原文件创建环已经消失。

仍未闭合的执行问题：

1. 13A Step 2 在 `:1861-1865` 运行 `npx playwright test ... --project=chromium`，但 `chromium` project 直到后续 13A Step 4 的 `playwright.config.ts` 才在 `:1880-1893` 创建。严格按步骤运行时，RED 会先因“Project(s) chromium not found”失败，而不是 `:1865` 声明的 seeded project/runtime scenario 缺失；测试尚未触达 owner story，不能作为有效 RED 证据。
2. `docs/plans/README.md:17-19` 的规范顺序写成“Tasks 14–19, and finally Task 19: 13B Steps 5–9”。这里应为“finally Task 13B Steps 5–9”；当前文本给同一个 Task 19 赋予两个阶段名称，与纵向计划正文不一致。

最小修复：将 13A 调整为“创建 spec→创建 fixture shell→创建 Playwright config→运行 RED”，并把 RED 预期改成配置完成后真实触达的缺失 composition/`start:e2e` 原因；同时将计划索引改为 “finally Task 13B Steps 5–9”。修正后，13A→14–19→13B 才能按文档顺序得到可解释且唯一的 RED/ GREEN 证据。

## Ready 条件

仅剩一项：修复上述 13A RED 执行顺序与 `docs/plans/README.md` 的 Task 编号。HTTP 边界与设备凭据两项无需再次扩展。
