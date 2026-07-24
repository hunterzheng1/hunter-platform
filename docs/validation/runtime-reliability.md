# Runtime 路径、权限与失联边界验证

- 日期：2026-07-22（Asia/Shanghai）
- 分支：`codex/phase0-runtime-reliability`
- 基线：`7ad8b89c54b3d2b9db9df559211bfae927973667`
- 证据类型：`phase0_runtime_reliability` schema v1
- 证明范围：`hunter_contract_fixture`
- Node：`v24.14.0`
- 总体结果：`PASS`（6 PASS / 0 FAIL / 0 NOT_PROVEN）

## 结论

Hunter 的本地契约 fixture 已覆盖 Unicode 与空格路径、受控子进程树、
Provider 强制退出、过期会话引用、重复幂等键和权限拒绝六个边界。进程退出与
会话缺失均进入 `needs_attention`，权限拒绝进入 `waiting_approval`；只有显式
verifier receipt 才能产生 `succeeded`。

本记录不证明任何真实 Runtime Provider 的行为或可靠性，也不提升任何
Connector capability level。它只证明 Hunter 自己的场景规划、状态映射和受控
fixture 机制。

## 场景结果

| 场景 | 期望/实测状态 | 结果 | 清理目标与收据 |
| --- | --- | --- | --- |
| Unicode 与空格 workspace | `succeeded` / `succeeded` | PASS | 自动临时 Git fixture；回调返回后经验证删除 |
| harmless Node 子进程树 | `succeeded` / `succeeded` | PASS | 仅清理由 fixture 创建并记录的 PID/handle；Windows `windows_exact_pid_handles` |
| Provider 强制退出（exit 23） | `needs_attention` / `needs_attention` | PASS | `NodeCommandRunner` 回收精确 child handle |
| stale native session reference | `needs_attention` / `needs_attention` | PASS | 释放 fixture 内的失效引用 |
| 重复 command idempotency key | `succeeded` / `succeeded` | PASS | 两次请求复用同一 verifier receipt，仅 dispatch 一次 |
| permission denied | `waiting_approval` / `waiting_approval` | PASS | 释放 fixture 内的 pending request；未自动批准 |

Linux CI 使用同一 Node fixture，并以该 fixture 创建的 process-group ID 终止整个
组。其他平台或无法确认精确清理时必须记录 `NOT_PROVEN`，不得伪造 PASS。

## 安全边界

- 所有会写文件或创建进程的探针均在 `withTemporaryGitFixture` 自动创建且由
  `assertProbeWorkspace` 验证的临时 Git 仓库中运行；实际子目录名包含 Unicode
  和空格。
- 所有顶层命令均通过 `NodeCommandRunner` 使用 executable + argv、
  `shell: false` 启动。fixture 内部的 harmless Node helper 同样使用 executable +
  argv 和 `shell: false`。
- Windows 只使用本场景保留的精确 PID/handle；Linux 只使用本场景创建的精确
  process-group ID。没有按 executable name 杀进程，也没有枚举无关进程。
- 未使用 bypass、yolo 或 auto-approve 参数；未读取 token、cookie、credential、
  完整环境或 private prompt。
- evidence 不包含临时绝对路径或运行时 PID；命令正文以固定占位符记录。

## TDD 运行记录

严格按垂直 RED→GREEN 切片执行，以下为本轮真实命令和结果。

1. 场景规划契约：
   - RED：`npm.cmd test -- --run spikes/reliability/src/scenario.test.ts`
     首次因 `./scenario.js` 尚不存在而失败；加入最小空实现后再次运行，断言得到
     `expected [] to deeply equal [...]`（1 failed）。
   - GREEN：同一命令，1 passed。
2. 状态映射边界：
   - RED：同一命令，`resolveObservableState is not a function`（1 failed / 1 passed）。
   - GREEN：同一命令，2 passed。
3. 真实受控执行与 evidence envelope：
   - RED：同一命令，`executeReliabilityScenarios is not a function`
     （1 failed / 2 passed）。
   - GREEN：同一命令，3 passed；真实 Windows 子进程树场景包含 2 个 descendant，
     清理确认后退出。
4. 子进程树启动后故障的清理边界：
   - RED：同一命令，注入故障参数尚未生效，实际错误返回
     `succeeded` / `PASS`（1 failed / 3 passed）。
   - GREEN：同一命令，4 passed；注入故障返回 `needs_attention` / `FAIL`，同时
     精确 process-tree cleanup receipt 保持 PASS。
5. stateful cleanup receipt 与运行时版本：
   - RED：同一命令，`host.nodeVersion` 为 `undefined`（1 failed / 3 passed）。
   - GREEN：同一命令，4 passed；所有场景均记录 `remainingResources: 0`，stale
     reference、permission request 与 idempotency record 均在 fixture 中真实创建并释放。
6. evidence envelope 完整性：
   - RED：同一命令，重复 scenario ID 仍被 schema 接受（1 failed / 4 passed）。
   - GREEN：同一命令，5 passed；schema 拒绝重复/缺失 ID、不一致 summary 与被篡改
     fingerprint。

## 复现

```powershell
npm.cmd run build --workspace @hunter/spike-reliability
node --enable-source-maps spikes/reliability/dist/scenario.js --output docs/validation/evidence/reliability
npm.cmd test -- --run spikes/reliability/src/scenario.test.ts
```

版本化原始收据：
[`evidence/reliability/runtime-reliability.json`](evidence/reliability/runtime-reliability.json)，
内容指纹为
`f1b47010837dbd592788aa396b989b6ff299e117f8e42261a97836e6aea7f49b`。
