# Herdr public Adapter Task 1 closeout

- 日期：2026-07-28
- 固定候选：Herdr `0.7.5-preview.2026-07-21-0f10e1453a7f`
- Task 1 结论：`BLOCKED`
- Task 2–8：`NOT_RUN`
- 适用范围：本机公开 CLI、自动创建的无远端临时 Git fixture

## 结论

Task 1 在三轮均有新证据的正式尝试后触发计划硬门。固定二进制身份、
危险权限参数 I/O 前拒绝和相同 operation receipt 的确定性复用得到
`PASS`。公开 `worktree open` 对 Hunter 已创建的 exact checkout 未返回
完成收据，而是确定性 `needs_attention`，所以不能证明：

- exact existing worktree attach；
- `workspace close` 的 state-only cleanup；
- 目标 session 与 unrelated resources 的完整隔离；
- Provider 与 Hunter 临时 Git 资源的完整正常路径清理。

Agent return、进程退出、pane idle、Herdr status 或产品文档均未被当作
Step success。Task 2–8 不会启动，也不会用第 4 次探针覆盖失败历史。

## 三次正式尝试

| 尝试 | source commit / digest | Evidence | 结果 |
| --- | --- | --- | --- |
| 1 | `e80121236280070f650bda16f9e01e2dfb80b813` / `baa677901a96333c34d652d837a7a2fcb2d77e9ec21596b40bb00cac2b65a81d` | `public-adapter-gate.attempts/6f5fae3e42f22fe01a53d51aacaedada632cf16d68927117245d70c801da05c1.json` | `BLOCKED / TEMP_GIT_COMMAND_FAILED`：本机 Git 不接受探针使用的长 `--branch` 参数；Provider mutation 尚未开始。 |
| 2 | `1be7ebf6b20fde6dc83702ed14403db882ef8d49` / `25f3726bf9c560dcb93911c2a3ff806d8bed908b307692127ebd364a038e9461` | `public-adapter-gate.attempts/8dd969b0731326b72303f9b86f3a7569cb20dafea2a4f7eeeb1d952c08dafc6f.json` | `BLOCKED / HERDR_WORKSPACE_BINDING_NOT_FOUND`：公开 handler 要求新 session 提供 workspace identity 或 `cwd`；临时 Git worktree/branch 已清理。 |
| 3 | `1ecb5e50157c8f54fd7b6dd28ca1e996ea37a7a5` / `06efa2ae69d3569c6e373ae77385389560f5db532d4abe924ee64b2284c2d160` | `public-adapter-gate.json` | `BLOCKED / HERDR_PREPARE_NOT_COMPLETED`：补齐公开 `--cwd` 后 prepare 仍为 `needs_attention`；重复 operation 返回同一 receipt，未重复副作用。 |

当前 canonical Evidence 的原始文件 SHA-256 为
`bca4ea87fbd958a9d3736973d4d7b9a56133b2aa2898de90e7b5ef64cd74d4f4`。
前两次归档文件名分别等于各自原始文件 SHA-256，失败历史保持只追加。

## 当前收据与资源

- `fixed_version`：`PASS`
- `operation_idempotency`：`PASS`
- `permission_argument_gate`：`PASS`
- `workspace_attach_existing`：`BLOCKED`
- `state_only_cleanup`：`BLOCKED`
- `isolated_session`：`BLOCKED`
- `resource_cleanup`：`BLOCKED`
- target session：运行前 `absent`，最终清理后 `absent`
- unrelated inventory digest：运行前与最终清理后一致
- Hunter 临时 Git worktree/branch：均已移除
- Agent starts：`0`
- sends：`0`
- 新增付费：`0`

`workspace close` 未运行，因为 prepare 没有达到可安全释放的完成状态。
target close 后状态和 unrelated close 后摘要没有形成证明，因此即使最终
inventory 与 Git cleanup 良好，也不得把隔离或正常 state-only cleanup
写成 `PASS`。

## 非声明

本结果不声明 Herdr 是生产 Provider，也不说明其 Agent、恢复或 Windows
beta 已验证。本批未实现 Hunter UI、移动端、Pi、第二 Provider、Fork、
真实 Agent Attempt 或生产发布。未实际完成的 Windows/Ubuntu GitHub
Actions 在远端结果出现前保持 `PENDING/NOT_RUN`。

依据替代计划和决策 41，下一步是产品方向选择：归档 Hunter，或另行批准
新的受限方向。Herdr Stop 不会自动启动 Pi，也不会放宽 exact-worktree、
Lease、独立验证和权限硬门。
