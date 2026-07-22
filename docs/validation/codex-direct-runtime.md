# Direct Codex Runtime 结构化链路验证

- 日期：2026-07-23（Asia/Shanghai）
- 固定候选：Codex CLI `0.144.6`
- 主机：Windows `10.0.26200` x64；Node.js `v24.14.0`
- Connector 判定：`NOT_PROVEN`
- 证明范围：`local_typed_scenario`
- 原始 envelope：[`evidence/codex/direct-runtime.json`](evidence/codex/direct-runtime.json)
- 内容指纹：`00094ae46c65670a9461c3e2acadcd1d769617ebeab2c591e0c5e62e97551a36`

## 结论

本机固定版本通过官方稳定非交互面 `codex exec --json`，在显式 `read-only`
sandbox 和自动创建的无 remote 临时 Git fixture 中完成了结构化 session 创建、Prompt
提交、JSONL 事件观察与同一 session identity 的恢复。`turn.completed` 被记录为结构化
终止回执，但它与 agent return、进程 exit `0` 一样只属于 Runtime 事实，不能直接完成
Hunter Step。

真实受控中断只证明了本场景创建的精确进程树被终止，没有得到结构化 session interrupt
回执；permission event 与 artifact export 也没有安全实测。因此 Direct Codex CLI 仍为
`NOT_PROVEN`，不计算或宣传 L2/L3，不改变 Phase 0 Outcome 5，也不成为生产 Provider。

## 固定公开面

| 公开面 | 本机结果 | SHA-256 |
| --- | --- | --- |
| `codex exec --help` | exit 0；包含 JSON 与 sandbox | `2623cfaf78083b7e0b74354c969c2c02812e91ef7d5db342271ff05b98ccccbd` |
| `codex exec resume --help` | exit 0；包含 resume/JSON | `e395e3a5716cd1a59985a8cef7c43ceb8dc93eea27962d29be3107f0022de6b3` |
| `codex app-server --help` | exit 0；只用于候选面观察，未启动 | `b55baa5e2cbd1288cdf57f5756236d070d29300dbd4125105f602405560a99f9` |
| `codex login status` | exit 0；输出被丢弃 | 空内容 hash，不保存账户信息 |

官方手册把 `codex exec` 标为 stable 非交互接口，把 app-server 标为 experimental 深度
集成接口。本轮只执行前者，没有启动 listener、stdio app-server 或远程控制。

## 原子能力收据

| 能力 | 结果 | 本机证据边界 |
| --- | --- | --- |
| discover | PASS | 固定 CLI 版本、exec JSON/help 与登录退出状态可用 |
| workspace targeting | PASS | 所有调用绑定到无 remote 临时 Git fixture；调用后 Git status 为空 |
| launch | PASS | JSONL 返回结构化 session identity |
| send | PASS | 固定无私密只读 Prompt 被接受 |
| observe | PASS | 结构化事件流可解析且无协议错误 |
| structured events | PASS | `thread.started`、turn/item/terminal 事件通过版本化 parser |
| permission events | NOT_PROVEN | 没有为了制造事件而请求危险权限或自动批准 |
| resume | PASS | 新 turn 返回与原 turn 相同的 session identity；原值未落盘 |
| interrupt | NOT_PROVEN | 只有精确进程树 timeout cleanup，没有结构化 session interrupt receipt |
| completion receipt | PASS | 存在结构化 turn terminal event；明确不等于 Hunter Step success |
| headless | PASS | 非交互 JSON 执行完成 |
| artifact export | NOT_PROVEN | 未单独验证 diff/file/artifact export contract |

## 安全与清理

- Windows 不通过 npm `.cmd`/PowerShell shim 或 shell 启动；场景解析官方 npm 包中的
  原生 `codex.exe`，使用 executable + argv 和 `shell: false`。
- 实际 argv 只包含 `exec`、`--json`、`--sandbox read-only`、`resume`、临时 session
  identity 与固定只读 Prompt；没有 bypass、yolo、full-auto、auto-approve 或 full-access。
- Prompt、session identity、账户输出、绝对用户路径和原始 JSONL 不进入 evidence；只保留
  占位符、状态和脱敏 hash。
- fixture 没有 Git remote；最终 `git status --porcelain` 为空；临时目录在 evidence 写入前
  完成受控删除。
- 没有 Git push、PR/issue、MCP/插件安装、web search、app-server listener 或远端仓库写入。

## 真实迭代历史

1. 第一次 preflight 使用 Windows npm `.cmd` shim，被 Node `shell:false` 一致拒绝为
   `EINVAL`；真实调用数为 0，未伪装为登录或 Codex 能力失败。
2. 增加原生 executable resolver 的 RED 测试后，第二次场景完成 3 个调用尝试并生成首份
   收据：create、resume、受控 interrupt。
3. 为补充真实 Git cleanliness receipt，第三次场景再次执行 3 个调用尝试；evidence 在进程
   完成后延迟可见，最终 envelope 记录 `repositoryCleanAfterScenario=true`。中断只保留为
   `NOT_PROVEN`，没有因为 cleanup 成功升级能力。

因此本轮共有 6 个真实 CLI 调用尝试；其中两轮 create/resume 均得到结构化回执，两轮
interrupt 均按 250ms 时间盒终止精确进程树。实际配额消耗由 Codex 服务决定，本证据不推测
具体 token 或费用。

## TDD 与复现

- `exec-client` RED：模块不存在；GREEN：6 tests passed。
- evidence RED：模块不存在；GREEN：6 tests passed。
- Windows launcher RED：`resolveCodexExecutable is not a function`；GREEN：7 tests passed。
- fixture cleanliness RED：字段缺失/dirty 未降级；GREEN：8 scenario tests passed。
- 最终精确 Codex suite：14 tests passed，现有 envelope 通过 Zod schema 与指纹复核。

复现入口：`npm run spike:codex`，且必须由调用者临时设置
`HUNTER_PHASE0_CODEX=allowed`。复现会产生真实模型服务调用；禁止在未授权环境中运行。

本轮没有完成产品 UI、生产 Connector、完整 Runtime Provider、真实远端控制或发布。
