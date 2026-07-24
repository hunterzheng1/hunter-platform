# First Vertical Slice PR #5 readiness evidence

- 日期：2026-07-24
- 平台：Windows 10.0.26200
- 分支：`codex/first-vertical-slice`
- 范围：PR #5 最终复审修复与本机门禁；不代表真实 Provider 验证或生产发布。

## 最终复审修复

- 观察恢复会在 settlement/recovery 两个持久 operation 中优先复用已有
  `completed` receipt；`pending settlement + completed recovery` 不会再次触发
  native observation。
- desktop sidecar 双实例并行启动使用 owned-resource lifecycle；任何一端启动失败，
  已成功启动的进程和临时目录仍会被清理。
- sidecar shutdown 只有在真正完成后返回 `0`；失败返回 `1`，且只记录固定脱敏消息。
- packaged preload 暴露冻结的受控 `hunterAuthenticatedTransport`，只把 Workbench
  method/path 白名单映射到 schema-validated named IPC；不暴露 daemon origin、凭据、
  generic fetch、任意 IPC、文件系统或 shell。
- 正式 daemon composition 已接入持久 Project、Requirement、Change 服务、创建后动态
  Project 授权刷新，以及 Hunter 自有的 SQLite Archive manifest source。
- Flow state 会从持久 `VerificationChanged` 事件恢复每个 Attempt 的 verifier evidence
  fingerprint；Archive 只引用该验证证据并保留失败重试历史，缺失时 fail-closed，
  不会用 `session.launch` receipt 代替成功证明。
- packaged Runtime 与 Verifier 继续以 `PRODUCTION_*_NOT_CONFIGURED` fail-closed；
  本批没有选择或调用真实 Provider，也没有把 Fake 打入生产 bundle。

## 本机验证

| 命令 | 真实结果 |
| --- | --- |
| `npm run verify:foundation` | PASS；lint、typecheck、100 test files / 874 tests、rebuild、recovery、build 全部通过 |
| `npm run start:e2e -- --verify` | PASS；随机 loopback daemon、认证 health、owned cleanup |
| `npx playwright test e2e/vertical-slice.spec.ts --project=chromium` | PASS；1 passed |
| `npm run pack:win -w @hunter/desktop` | PASS；未签名 NSIS x64 生成 |
| packaged sidecar smoke | PASS；两个独立端口、认证 health、两个持久 Project→Requirement→Change 定义链 |
| packaged preload smoke | PASS；冻结 named API + 受控 transport，forbidden surface 为空 |
| `npx playwright test e2e/windows-real-providers.spec.ts --project=chromium` | SKIP；缺少 owner opt-in 与脱敏 receipt bundle，未调用真实 Provider |

## 证据边界

- 上述 E2E 使用确定性 Fake Runtime，只证明 Hunter 契约和产品链路。
- 真实 Provider Playwright 套件仍要求显式 owner opt-in 与脱敏 receipt bundle；
  缺少这些输入时必须 `SKIP`，不能提升为 PASS。
- 本文件创建时，本次新 HEAD 尚未推送；GitHub Actions 状态如实为 `PENDING`。
- 首次推送 `777a388` 后，Windows quality 在 run `30073463329` 与
  `30073464951` 中真实失败：源码安全测试硬编码 LF，而 Windows checkout 使用
  CRLF。后续提交把断言改为换行无关匹配；该失败历史不改写为 PASS。
- 未合并 `main`、未创建发布、未部署、未执行真实远端 Provider 操作。
