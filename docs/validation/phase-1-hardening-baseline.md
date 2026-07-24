# Phase 1 product hardening baseline

- 日期：2026-07-24
- 平台：Windows `10.0.26200`
- 分支：`codex/phase1-product-hardening-plan`
- 基线：`main@83be7aece6c0cefe9b0cb077830c3eb2e95c48fe`
- 证据范围：`contract_only`

## PR #5 合并事实

- PR：`https://github.com/hunterzheng1/hunter-platform/pull/5`
- 状态：`MERGED`
- 合并时间：`2026-07-24T08:22:24Z`
- merge commit：`83be7aece6c0cefe9b0cb077830c3eb2e95c48fe`
- 合并前 head CI：Windows/Ubuntu quality 与 vertical-slice 共 8 项实际成功。
- feature branch 保留；未删除旧 worktree，未发布、未签名、未部署。

## 新 worktree RED

在从最新 `origin/main` 创建的全新隔离 worktree 中：

1. `npm install` 成功，新增 601 packages，审计 627 packages；
2. npm 摘要报告 4 个 high severity vulnerability；
3. 未运行 build/typecheck，直接运行 `npm test`；
4. 9 个 suite 在 collection 阶段失败，91 files / 829 tests 通过；
5. 原始错误显示 `@hunter/knowledge` 的 package export 指向不存在的
   `packages/knowledge/dist/index.js`。

旧 worktree 残留的 `packages/knowledge/dist/index.js` 掩盖了该顺序依赖。随后运行
`npm run typecheck` 生成该文件，相同的
`apps/daemon/test/archive-composition.test.ts` 立即通过 3/3，确认根因。

## 修复与 GREEN

- RED 测试：`npx vitest run scripts/vitest-config.test.ts`
- RED 结果：缺少 `@hunter/knowledge` source alias；
- 实现：`vitest.config.ts` 将 `@hunter/knowledge` 解析到
  `packages/knowledge/src/index.ts`；
- 精确 GREEN：配置测试 1/1 通过；
- 删除本 worktree 内生成的 `packages/knowledge/dist` 后重新运行裸 `npm test`；
- GREEN 结果：101 test files / 875 tests 全部通过。

这项结果只证明测试入口不再依赖预构建 Knowledge `dist`；它不证明真实 Provider。

## 本机门禁

| 命令 | 结果 |
|---|---|
| `npx vitest run scripts/vitest-config.test.ts` | PASS；1 file / 1 test |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm test` | PASS；101 files / 875 tests |
| `npm run build` | PASS |
| `npm run verify:rebuild` | PASS；3 events |
| `npm run verify:recovery` | PASS；receipt `e73ee7cafb4eb14e249bf8fb35b8adc3a8779983783479a56344ff6cbdaf1b78` |
| `npm run verify:foundation` | PASS；在宿主 Windows 权限边界运行 |
| `git diff --check` | PASS |

`verify:foundation` 在 Codex 文件沙箱内运行两次，均在 lint/typecheck 通过后由 Vitest
写 `node_modules/.vite-temp` 临时配置时收到 Windows `EPERM`。检查显示目录为空且
ACL 允许 sandbox user 修改；同一时段单独的 `npm test`、rebuild 和 recovery 均
通过。随后使用相同 worktree、相同源码和相同命令在宿主 Windows 权限边界运行，
完整门禁通过。两次沙箱失败保留为真实执行历史，不追溯改写为 PASS。

## 远端 CI

PR #6 的计划 head `54f5d90` 因 push 与 pull request 事件产生两组门禁，实际结果
共 8/8 PASS：

- run `30079919557`：Windows/Ubuntu quality 与 vertical-slice 全部通过；
- run `30079942556`：Windows/Ubuntu quality 与 vertical-slice 全部通过；
- Ubuntu 的 Windows packaging step 按 workflow 条件真实 `SKIPPED`；
- Windows vertical-slice 实际完成 Chromium E2E 与未签名 NSIS 打包。

后续 evidence head `b187c49` 也产生两组实际门禁并 8/8 PASS：

- run `30080423836`：Windows/Ubuntu quality 与 vertical-slice 全部通过；
- run `30080426524`：Windows/Ubuntu quality 与 vertical-slice 全部通过。

本文件不让一个 commit 自证自己的 CI。包含证据编辑本身的最终 HEAD 必须以 PR 的
GitHub checks 作为外部事实源；未完成时是 `PENDING`，完成后按真实 conclusion
报告，不继承前一 SHA 的 PASS，也不为此递归改写证据文件。

## 供应链与权限边界

`npm install` 的摘要只证明 npm 报告了 4 个 high severity 项，尚未证明它们是否进入
生产依赖、是否可利用或是否已有安全升级路径。详细 `npm audit --json` 会向 registry
发送本私有仓库的依赖元数据；该网络审计在没有本次明确授权时保持 `NOT_RUN`，不通过
变体命令绕过。

## Provider 状态

| 候选 | 本机已观察 | 当前结论 |
|---|---|---|
| Orca | executable/status 可发现；`discover_runtime` receipt 为 PASS | Provider 仍 `NOT_PROVEN` |
| Agent Orchestrator | typed fallback 有部分本机证据 | Provider 仍 `NOT_PROVEN` |
| Direct Codex | launch/event/resume 有有界证据 | structured interrupt 等仍 `NOT_PROVEN` |
| Codex app-server | experimental，attempt conformance FAIL | Connector 仍 `NOT_PROVEN` |
| CodeBuddy | 无完整固定版本原子收据 | `NOT_PROVEN` |
| Cursor | 无完整 workspace/handoff/人工 receipt | `NOT_PROVEN` |
| Fake Runtime | contract suite 与产品链路通过 | `CONTRACT_ONLY` |

本记录不选择或 Fork Orca，不计算任何真实候选的 L0–L3，不解除 Phase 0 Gate A。

## 尚未运行

- Phase 1 迁移、备份恢复、诊断包、资源配额、24h soak；
- 真实 Provider、真实手机、真实项目体验、代码签名和生产发布。
