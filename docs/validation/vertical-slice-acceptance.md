# Hunter 首个纵向切片验收

- 验收日期：2026-07-24
- 本机平台：Windows x64 / Node.js 24
- 验收范围：确定性 Fake Runtime 驱动的 Hunter 产品链路和未签名 Windows 测试打包
- Provider 结论：`contract_only`；Phase 0 Outcome 5 保持不变

## 纵向结果

认证 owner story 已贯通：

```text
Project
  -> immutable RequirementRevision approval
  -> Change + parallel/dependent Task DAG
  -> root WorkflowRun + one child WorkflowRun per Task
  -> runtime return
  -> verifier failure
  -> fresh retry Attempt
  -> verifier pass
  -> terminal root/child tree
  -> durable Archive jobs
  -> authoritative + historical Knowledge
  -> authenticated Event Ledger replay
```

API composition/restart 测试中的稳定结果：

- root/child Run：3 个，全部 `succeeded`
- child Attempt 数：`[1, 2]`
- `session.launch` durable Outbox：3 个；两次重启后没有重复 launch
- completed Archive jobs：3 个
- 同 Project Knowledge：4 个，其中 1 个 RequirementRevision
  `authoritative` 来源、3 个 Archive `historical` 来源
- Event stream：从保存的 cursor 重连后包含 `RunConcluded`

Agent return、process exit、terminal idle、window opened 均未作为 Step success；
成功只来自 CompletionVerifier receipt。Fake Runtime 只证明 Hunter 契约，不证明
任何真实 Provider。

## RED -> GREEN 追加历史

13B 保留了以下真实失败：

1. authoritative Knowledge RED：Archive 后只有 3 个 historical entries，缺少批准的
   RequirementRevision。
2. rebuild RED：生产 HunterProjection 保存 nested `requirementRevision`，旧 rebuild
   测试仅覆盖扁平 seed，实际返回 `KNOWLEDGE_REQUIREMENT_STATUS_INVALID`。
3. Windows pack RED：sidecar smoke 通过，但 preload smoke 的冻结分组允许列表遗漏
   Task 17 的 `devices`。
4. mobile RED：Task 19 移除 hardcoded Playwright origin 后，mobile spec 未切换到
   readiness fixture，`page.goto("/mobile")` 因无 base URL 失败。
5. 两个失败/全跳过 Playwright run 各留下一个 ACL 保护的 stale lock；每次均先读取
   精确 owner PID 并确认进程不存在，再只删除该 lock。启动器没有自动接管未知锁。

修复后，rebuild 严格解析 canonical nested RequirementRevision，确定性重建
authoritative/historical Knowledge；preload smoke 继续拒绝
`fetch/shell/filesystem/ipcRenderer/apiOrigin/token`；mobile 与 vertical spec
共同消费版本化 readiness 文件。

## Windows 本机门禁

| 命令 | 结果 |
| --- | --- |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm test` | PASS，92 files / 842 tests |
| `npm run build` | PASS |
| `npx playwright test e2e/vertical-slice.spec.ts --project=chromium` | PASS，1 test |
| `npx playwright test e2e/mobile-security.spec.ts --project=mobile` | PASS，1 test，Pixel 7 viewport ≤ 430px |
| `npx playwright test e2e/windows-real-providers.spec.ts --project=chromium` | SKIP，1 test；未提供完整脱敏 receipt bundle，未调用真实 Agent |
| `npm run pack:win -w @hunter/desktop` | PASS |
| `git diff --check` | PASS |

Windows 测试安装器：

- 文件：`Hunter Platform Setup 0.1.0.exe`
- 大小：92,997,087 bytes
- Authenticode：`NotSigned`
- SHA-256：`115b44b090da9824aa9eff03593c56b2077e4a8636b3208fc6545ed9299520e0`

该文件位于忽略的本机构建目录，未提交、未上传、未发布，也没有生产签名。

## 真实 Provider 状态

| 候选 | 13B 验收 | 原因 |
| --- | --- | --- |
| Codex | SKIP / NOT_PROVEN | 现有 Phase 0 收据不足以组成当前完整 Connector acceptance bundle |
| CodeBuddy | SKIP / NOT_PROVEN | 无当前脱敏版本化 capability receipt |
| Cursor | SKIP / NOT_PROVEN | 无当前脱敏版本化 capability receipt |
| Orca | SKIP / NOT_PROVEN | discover 已有局部证据，但 workspace/session/recovery 原子收据不完整 |

opt-in 测试只有同时满足 Windows、`HUNTER_REAL_AGENTS=1` 和仓库
`docs/validation/evidence/` 内的严格 receipt bundle 才会运行。它重新计算 capability
level，拒绝 `NONE` 和非 `local_probe`/`phase0_evidence` 的支持声明；不按产品名称
硬编码 L2/L3。

## CI 状态

首次提交本证据时，新增的 `Vertical slice / windows-latest` 与
`Vertical slice / ubuntu-latest` 尚未在远端运行，因此当时如实记录为
`PENDING`。提交 `dbda138c6ad3031a211746215d52ef1efde512fd` 后，两种触发器的
八个 job 均已真实完成：

| 触发器 | Run | Job | 结果 |
| --- | --- | --- | --- |
| push | [30063276704](https://github.com/hunterzheng1/hunter-platform/actions/runs/30063276704) | Node 24 / Windows | PASS（1m37s） |
| push | [30063276704](https://github.com/hunterzheng1/hunter-platform/actions/runs/30063276704) | Node 24 / Ubuntu | PASS（56s） |
| push | [30063276704](https://github.com/hunterzheng1/hunter-platform/actions/runs/30063276704) | Vertical slice / Windows | PASS（6m50s） |
| push | [30063276704](https://github.com/hunterzheng1/hunter-platform/actions/runs/30063276704) | Vertical slice / Ubuntu | PASS（1m33s） |
| pull_request | [30063279098](https://github.com/hunterzheng1/hunter-platform/actions/runs/30063279098) | Node 24 / Windows | PASS（1m46s） |
| pull_request | [30063279098](https://github.com/hunterzheng1/hunter-platform/actions/runs/30063279098) | Node 24 / Ubuntu | PASS（59s） |
| pull_request | [30063279098](https://github.com/hunterzheng1/hunter-platform/actions/runs/30063279098) | Vertical slice / Windows | PASS（6m30s） |
| pull_request | [30063279098](https://github.com/hunterzheng1/hunter-platform/actions/runs/30063279098) | Vertical slice / Ubuntu | PASS（1m21s） |

两种触发器的 Windows vertical job 都实际安装 Chromium、运行
lint/typecheck/unit/browser，并成功生成未签名 Windows 安装包。Ubuntu vertical
job 实际通过 Chromium browser 门禁，`pack:win` 按平台条件明确 `SKIPPED`。

CI 同时产生非阻断警告：`actions/checkout@v4` 与 `actions/setup-node@v4`
声明的 Node.js 20 runtime 已弃用，GitHub runner 当前强制它们运行在 Node.js 24。
这不是门禁失败，但后续应在官方 action 发布兼容版本后升级。

## 未完成与发布边界

- 没有真实 Provider 纵向 Run，没有真实 Connector adoption。
- 没有生产签名、上传、发布、商店分发或远端部署。
- 没有把 Orca 选为单一 Provider，也没有 Fork Orca。
- 本批完成的是首个可验证 Fake-only 产品切片，不是生产发布。
