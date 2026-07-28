# Orca-first control-plane Task 1 public Adapter gate

- 状态：`BLOCKED`
- 测量时间：`2026-07-28T05:30:54.658Z`
- Orca：`1.4.159`，`DETECTED`
- 证据：
  [`evidence/orca-control-plane/public-adapter-gate.json`](evidence/orca-control-plane/public-adapter-gate.json)
- Task 0 基线：
  [`evidence/orca-control-plane/baseline.json`](evidence/orca-control-plane/baseline.json)
- mutation：未执行
- cleanup：`NOT_REQUIRED`，没有创建 Provider resource

## Frozen source and baseline

当前证据绑定源码提交
`104e3257d5cced42b9dbbf733b6b13ff2df25214`，源码摘要为
`538ae0226e46f32e07954e34376e713a4cbf88be1a5b074fab1c1afdd48f88c0`。
它引用的 Task 0 baseline SHA-256 为
`3f6be678a66c8348583935f664fcfa04bfe752d6ad903a32b1e6023fcf83777d`。
五工作日时间盒没有重置，仍为
`2026-07-28T04:19:30.589Z` 至 `2026-08-04T04:19:30.589Z`。

## Observed public surface

本次按 Orca 1.4.159 自身提供的版本匹配 `orca-cli` guide，串行执行：

- `status --json`
- `repo --help`
- `repo add --help`
- `worktree --help`
- `worktree create --help`
- `worktree set --help`
- `worktree rm --help`

全部命令退出码为 0。Evidence 只保存安全 argv、状态和脱敏输出 hash，不保存
runtime id、PID、可执行文件路径、原始 stdout/stderr、token、cookie 或环境。

公开命令表的本机事实为：

1. `worktree create` 明确创建新的 checkout，不是附加 Hunter 已创建的 exact
   worktree；
2. `worktree set` 只更新已由 Orca 管理的 worktree metadata；
3. `worktree rm` 明确同时从 Orca 和 Git 删除 worktree，不能作为无损
   deregister；
4. `repo` 只有 list/add/show/set-base-ref/search-refs，没有 remove/rm/
   deregister；
5. 版本匹配 guide 也只列出 create/set/rm，没有 existing-worktree attach
   或 non-destructive detach。

因此：

| Capability | 状态 | 原因 |
|---|---|---|
| fixed version | `PASS` | `status --json` 返回数值版本 `1.4.159` |
| exact existing-worktree attach | `BLOCKED` | 公开 CLI 只创建新 checkout 或更新已管理 metadata |
| non-destructive cleanup | `BLOCKED` | 没有 deregister；`worktree rm` 会删除 Git worktree |
| forbidden permission argument gate | `CONTRACT_ONLY` | 本地 Adapter 测试拒绝 bypass/yolo/auto-approve 等参数 |
| real Manual/fail-closed defaults | `NOT_PROVEN` | 因 attach/cleanup 前置门已阻断，未启动真实 session |

`DETECTED` help entry 不等于 capability `PASS`。执行 `repo add` 会创建当前公开
CLI 无法证明可完整清理的注册，因此没有为了“试一下”而留下 Provider 私有状态。

## Preserved execution history

失败历史没有改写：

1. 沙箱身份下四个并行只读 help 命令均返回 `orca` 不在 PATH；这与 Task 0
   已记录的自动化身份差异一致，没有重复同一失败命令。
2. 切换为已配置、但不输出路径的 `ORCA_CLI_COMMAND` 后，依次读取 public
   help 成功。
3. 按 `orca-cli` 技能要求，从 Orca 二进制读取版本匹配 guide，并再次确认
   `status --json`；没有使用缓存命令表推断能力。
4. 正式 gate generator 的 7 个只读命令全部成功，schema/hash/privacy/source
   校验仍需在提交前完成；结论保持 `BLOCKED`。

## Budget, cleanup, and stop

- 真实 Agent Attempt：0 / 2；
- 真实 session：0；
- send：0；
- 新增付费：0 USD；
- Provider mutation：0；
- Provider-owned resource：0；
- cleanup：`NOT_REQUIRED`。

按实施计划的 Task 1 硬门，Task 2–8 均为 `NOT_RUN`。继续需要 owner 做产品方向
决策，不能由实现阶段自行假设：

1. 修改不变量，允许 Orca 创建/拥有工作树，再由 Hunter 验证和租赁；
2. 保持 Hunter-owned exact worktree，等待/推动 Orca 提供 public attach 与
   non-destructive deregister；
3. 保持不变量并改测另一个支持这两个原子能力的 Runtime Provider。

在该决策前，不得读取 Orca private DB、用 GUI automation 模拟 attach、调用
`worktree rm --force` 删除 Hunter worktree，或继续 Task 2。

## Non-claims

- 本记录不证明真实 Agent mutation、Manual permission、Verifier、restart/
  reconcile 或十分钟价值验收。
- `permission_argument_gate=CONTRACT_ONLY` 只证明 Hunter Adapter 契约。
- 本记录没有实现 Workbench、产品 UI、移动端、Orca Fork 或生产发布。
- Task 1 PR 的 Windows/Ubuntu GitHub Actions 在实际运行前保持 `NOT_RUN`。
