# Codex App Server Windows 有界验证

- 日期：2026-07-23
- 主机：Windows `10.0.26200` x64
- Node.js：`v24.14.0`
- Codex CLI：`0.144.6`
- 传输：本机 stdio JSON-RPC/JSONL
- 总结论：`NOT_PROVEN`
- 证据：[`evidence/codex/app-server-runtime.json`](evidence/codex/app-server-runtime.json)

## 验证范围

本轮只测量 Direct Codex CLI 证据中缺失的两个原子能力：审批请求事件和结构化 turn interrupt。实现依据是 2026-07-23 查阅的官方 [Codex App Server](https://learn.chatgpt.com/docs/app-server) 文档，以及本机 `codex app-server generate-json-schema` 生成的 `0.144.6` schema。官方文档把 app-server 定位为富客户端深度集成面；本机 `0.144.6` 帮助仍将整个命令标为 experimental，因此局部 PASS 不会形成生产采用决定。

场景只在自动创建的无 remote 临时 Git fixture 中运行。thread 设置 `ephemeral: true`、`sandbox: read-only`、`approvalPolicy: on-request`、`approvalsReviewer: user`；没有启用 experimental API、WebSocket、写 sandbox、自动 reviewer 或权限绕过参数。

## 真实结果

单次真实场景使用两个固定 turn；以下是最后一次调用中的协议观察，不等同于最终 capability PASS：

1. 审批 turn 触发带 request id 的 `item/commandExecution/requestApproval`。Hunter 客户端发送匹配 id 的 `decline`，没有批准命令或文件变更；旧收据没有保留足以证明该请求属于预期 thread/turn 的脱敏关联字段，因此 `approvalContextMatched=false`。
2. 中断 turn 在匹配 thread/turn 的 `turn/started` 后发送 `turn/interrupt`；收到成功 response，随后同一 thread/turn 以 `status: interrupted` 完成。

初始化、ephemeral thread、零协议解析错误和 fixture Git clean 均有 receipt。但旧实现的 `clean_exit` 只观察到直接子进程退出，不能证明整棵进程树已回收；证据现准确记为 `direct_process_exit`。同时，本批实际运行三次，超过设计规定的两次真实调用上限。因此 attempt ledger 为 `conformance=FAIL`，两个原子能力最终都保守记为 `NOT_PROVEN`。任何清理或 turn 终态都不代表 Hunter Step 成功。

## 原子能力判定

| 能力 | 结果 | 本机证据 |
| --- | --- | --- |
| `permission_events` | `NOT_PROVEN` | 最后一次调用观察到 request/denial id 对应，但 thread/turn 关联、调用次数上限和进程树回收均未完整证明 |
| `interrupt` | `NOT_PROVEN` | 最后一次调用观察到匹配 thread/turn 的 interrupt response 与 `interrupted` 终态，但安全前置条件未全部成立 |
| 生产 API 稳定性 | `NOT_PROVEN` | 本机 `0.144.6` 将 app-server 标为 experimental |
| 完整 Runtime Provider | `NOT_PROVEN` | 本轮没有测量 WorkspaceProvider、restart/reconcile、移动访问或生产支持承诺 |

不计算 L0–L3；能力只能由 receipt 的原子集合推导，不能按 Codex 产品名称硬编码。

## 脱敏与清理

- evidence 只保存公开 method 名、布尔/枚举结果和 SHA-256；不保存 Prompt、raw JSONL、账号响应、thread/turn id 或绝对用户路径。
- evidence CLI 现在以 create-new 语义写入，已有记录不会被后续运行覆盖；新尝试必须使用新的版本化记录。
- schema 生成物只用于固定本机协议 hash，不提交到仓库。`schemaBundleHash` 保留本轮原始生成物哈希；由于生成器对象键顺序不稳定，另存递归排序 JSON 键后的 `schemaCanonicalHash`。三份独立生成物均为 471114 bytes，原始哈希各异而规范化哈希一致。
- 临时 fixture 无 remote，场景后 `git status --porcelain` 为空，并在 evidence 写入前由 testkit 删除。
- 每次场景包含两个真实 turn；最终共运行三次，六个 turn 可能消耗 Codex 账户配额，本地无法准确估算费用或额度。设计上限为两次调用，第三次属于未获计划授权的过程偏差；没有将它追溯改写为合规。后续 schema 复现检查没有调用模型。

## 真实失败历史

- 第一次真实 app-server 场景完成后，审计发现 help/schema hash 计算包含了 JSON 字符串封装。实现改为对原始 UTF-8 内容计算 SHA-256，再运行第二次场景。
- 第二次场景的中断协议收据完整，但 cleanup 为 `NOT_PROVEN`，所以当次 `interrupt` 最终判定保守降级为 `NOT_PROVEN`。无模型最小复现证明 app-server 的直接子进程可以退出；代码审计定位到 Windows `taskkill` 与子进程自然退出之间的竞态。
- 随后错误地运行了超过计划上限的第三次真实场景。它观察到直接子进程退出，但这不能证明进程树回收；最终 evidence 将旧 `clean_exit` 重新准确分类为 `direct_process_exit`，记录三次/六 turn 的 attempt ledger，并将两个 capability 降级为 `NOT_PROVEN`。本批禁止再运行真实场景。
- 最终审计发现固定版本 schema 的原始哈希跨生成变化。三次无模型独立生成证明文件大小相同、规范化 JSON 哈希一致，波动只来自对象键顺序；因此证据同时保留原始与规范化哈希。
- 初次隐私扫描使用了不兼容 Windows 的 shell glob，`rg` 返回路径语法错误；随后改为目录加 `-g` 过滤并重新执行。该工具错误不改写为通过历史。

## 决策影响

新证据记录了 Direct Codex 的结构化审批和 interrupt 观察，但由于 attempt 非合规和进程树回收未证明，不能冻结为 capability PASS。app-server 在固定版本上仍是 experimental，且 Codex Connector 不是完整 Runtime Provider。Outcome 5、Phase 0 Gate A、真实 Provider 发布阻断和 First Vertical Slice 阻断均保持不变。本批没有实现产品 UI、生产 Connector、发布、Orca 选择或 Fork。
