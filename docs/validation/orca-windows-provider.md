# Orca Windows Runtime Provider 预检证据

- 日期：2026-07-22（Asia/Shanghai）
- 分支：`codex/phase0-orca-spike`
- 基线：`b4d75e13f786d1adc6bdddb32dae5b5b184f65e3`
- Spike：`P0-RUNTIME-01 Windows candidate enablement and atomic receipt`
- 总体判定：`NOT_PROVEN`
- 证明范围：`local_preflight_only`
- 真实写操作：未执行

## 结论

安装后的 Orca 可以通过公开 CLI 返回可解析的 `status --json`。Doctor 因此把 Orca 的 executable availability 与非交互状态可用性记录为 `DETECTED`，preflight 把原子能力 `discover_runtime` 记录为 `PASS`。

这两个结果只证明本机 Runtime 可发现且状态端点可达，不证明 Orca 已满足 Hunter Runtime Provider 契约，也不构成 Sidecar、Fork、primary Provider 或 fallback Provider 的采用决定。

当前公开 CLI 仍缺少两个执行安全场景所需的前置条件：

1. `worktree create --help` 没有可在调用前把新 checkout 固定到 Hunter 自动创建临时根目录的目标路径参数；
2. `repo --help` 没有公开的 repo deregistration/remove 命令，无法形成完整 repo registration cleanup receipt。

由于 Hunter 的安全约束要求所有会写仓库的探针只能作用于已验证的临时 Git fixture，不能在调用后才检查 Orca 把 worktree 建到了哪里。本轮因此没有调用 `repo add`、`worktree create`、`terminal create/send/read/wait/close`，也没有关闭或重启 Orca。缺少的结果全部保持 `NOT_PROVEN`，不伪造 PASS。

## 本机原始证据

- [环境 Doctor envelope](environment-inventory.json)
- [Orca preflight envelope](evidence/orca/preflight.json)
- preflight 内容指纹：`98c55e25e03250cc47e5911275ae4c16920ddbe63c658211029247892940100c`（连续两次真实运行一致）
- Orca CLI help SHA-256：`6eb858c68b4062692ddd276c43168e18841d348f2cadace39563019b8c1ff300`

Doctor 真实观察：

| 项目 | 结果 | 说明 |
| --- | --- | --- |
| executable availability | `DETECTED` | `status --json` 可由非 shell runner 调用 |
| Runtime status availability | `DETECTED` | 状态端点退出 0；没有读取或记录凭据 |
| 登录可用性 | `NOT_PROVEN` | `status --json` 不证明账户登录，未调用登录或凭据接口 |
| 精确版本 | `NOT_PROVEN` | `--version` 返回 usage/help 形态输出，没有数值版本 |
| help hash | `DETECTED` | 已对脱敏 help 输出计算 SHA-256 |

preflight 的四个只读命令均为退出码 0、无超时、无 spawn error：

| 操作 | 输出 SHA-256 |
| --- | --- |
| status（去除 request/runtime identity 与 PID 后的规范化状态） | `5f7f4bf2424c3d9809884d19ca47687d3bcbc2e703aab46e91499fb4b0e7126f` |
| repo help | `58e8536a32df60026a4aec35a985633c9daf372e4b527f0cc5e4bce092b66bbe` |
| worktree create help | `f464cff94743c8bdafcaa55abf07bf339f76ba534999e486344c408ce5e3780b` |
| terminal create help | `c2ada738842cf1fc6b1c94730dec4a5689841da13f3063d91e69b1ab9a4804da` |

## 原子能力判定

| 能力 | 判定 | 原因 |
| --- | --- | --- |
| discover runtime | `PASS` | 状态 JSON 报告 app running、runtime reachable 且 state ready |
| fixed version | `NOT_PROVEN` | 公共 CLI 没有返回可记录的数值版本 |
| workspace create | `NOT_PROVEN` | 没有 fixture destination 参数；未执行写操作 |
| resource cleanup | `NOT_PROVEN` | 没有公开 repo remove 命令；未制造待清理注册项 |
| terminal launch | `NOT_PROVEN` | workspace fixture confinement 未证明 |
| terminal observe | `NOT_PROVEN` | terminal 未创建 |
| terminal interrupt | `NOT_PROVEN` | terminal 未创建 |
| restart/reconcile | `NOT_PROVEN` | native session 未创建，未关闭或重启 Orca |
| workspace/session identity | `NOT_PROVEN` | 没有真实 worktree/session receipt |
| security defaults | `NOT_PROVEN` | 设置未通过版本化非交互接口形成收据 |
| mobile pairing | `NOT_PROVEN` | 未开启或测试远程配对 |

`terminal idle`、process exit、window opened、Provider return 或 session missing 即使未来被观察到，也只能是 Runtime observation，不能表示 Hunter Step success。

## 上游参考与本机证据边界

- [Orca CLI Reference](https://www.onorca.dev/docs/cli/reference)
- [Orca Worktrees](https://www.onorca.dev/docs/model/worktrees)

上游文档说明 Orca 使用真实 Git worktree，并提供创建与删除工作树的产品流程；本机判定只依据当前安装版本的非交互命令与哈希。上游文档没有替代本机 receipt，也没有证明 Hunter 所需的 fixture 目标路径、repo cleanup、重启恢复或安全默认值。

## 后续最小动作

Orca 只有在公开、可脚本化接口同时提供以下能力后，才值得重跑 mutating scenario：

1. 在创建前指定并验证 worktree/checkout 的绝对目标根目录；
2. 删除本轮创建的 repo registration、worktree、branch 与 terminal，并返回结构化 cleanup receipt；
3. 返回精确版本或稳定 build identity；
4. 对 restart/reconcile、stale handle 和 interrupt 提供结构化可复现结果。

在这些条件出现前，Outcome 5 保持不变：不选择或 Fork Orca，不进入 First Vertical Slice，不宣称真实 Provider 已验证。
