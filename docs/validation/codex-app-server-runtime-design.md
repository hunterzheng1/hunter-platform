# Codex App Server 有界验证设计

- 日期：2026-07-23
- 候选：本机 Codex CLI `0.144.6` 的 `app-server` stdio 协议
- 决策边界：只补充 Phase 0 原子能力证据，不采用生产 Connector，不改变 Outcome 5 或 Gate A
- 授权依据：用户已明确授权睡眠期间按推荐方案继续，包括有界真实 Codex 调用、提交、推送和 CI

## 目标与非目标

本轮验证 Hunter 能否通过版本固定的双向 JSON-RPC/JSONL 协议观察审批请求并结构化中断一个正在执行的 Codex turn。成功只形成 `permission_events` 和 `interrupt` 的候选 probe receipts；`turn/completed`、进程退出和 agent return 仍不能完成 Hunter Step。

本轮不实现生产 Connector、Provider、Workbench、Electron、PWA、远程监听、WebSocket、凭据管理或发布；不把 Codex 私有字段加入 `packages/domain` 或 `packages/runtime-contracts`。

## 方案比较

### A. 固定版本 stdio JSON-RPC 客户端（采用）

从本机 `codex app-server generate-json-schema` 生成与 `0.144.6` 匹配的临时 schema，使用默认 stdio 传输执行 `initialize -> initialized -> thread/start -> turn/start`。线程必须设置 `ephemeral: true`、`cwd` 为自动临时无 remote Git fixture、`sandbox: read-only`、`approvalPolicy: on-request`、`approvalsReviewer: user`。客户端对任何审批请求只返回 `decline` 或 `cancel`，绝不批准。

优点是能直接测量双向请求、通知和 `turn/interrupt`；缺点是整个本机命令仍标为 experimental，因此只能作为版本固定的 Phase 0 证据。

### B. 内置 debug test client（不采用）

`codex debug app-server send-message-v2` 可快速跑通 thread/turn，但不能精确控制审批响应和中断时序，也难以证明清理边界。

### C. Codex SDK（不采用）

官方建议自动化/CI 优先使用 SDK，但 SDK 会验证另一层抽象，不能回答本轮 app-server 审批与结构化 interrupt 的协议问题。

## 公共测试缝与组件

- `app-server-protocol.ts`：只处理请求规划、JSONL 解码、已知事件归一化、审批拒绝响应和证据摘要。公共测试缝是纯函数输入/输出。
- `app-server-client.ts`：拥有一个明确的子进程和 stdio 连接；按请求 id 关联响应，遇到审批请求立即拒绝，按时序发送 `turn/interrupt`，超时只终止自己创建的精确进程树。
- `app-server-scenario.ts`：在 `withTemporaryGitFixture` 中运行预检与最多两个真实 turn；检查无 remote、fixture 最终 Git clean、ephemeral thread、服务进程回收和脱敏证据。
- `*.test.ts`：通过公共协议缝和注入的进程边界验证 fail-closed 行为，不读取账号、token、完整 Prompt、原始 session/thread/turn id 或私有路径。

测试缝已按用户的默认授权确认：协议纯函数、注入的 app-server transport、最终 evidence schema 和临时 Git fixture 生命周期。

## 数据流

1. 记录 `codex-cli 0.144.6`、app-server help hash、非 experimental schema bundle hash 和本机 schema 中所需 method/field 的存在性。
2. 启动 stdio app-server，完成一次连接初始化。
3. 创建 `ephemeral: true`、read-only、无 remote fixture 的 thread。
4. 运行审批场景：固定 Prompt 请求一次本地写操作；若收到 command/file/permission approval request，客户端只拒绝并记录方法名，不保存 payload。未收到请求则记 `NOT_PROVEN`。
5. 运行中断场景：启动固定等待 Prompt，收到 `turn/started` 后发送 `turn/interrupt`；只有 interrupt response 成功且同一 turn 最终 `status: interrupted` 才记 `PASS`。
6. 检查 fixture clean，结束 app-server，验证进程树回收，删除 fixture 后才写 evidence。

## 安全与错误处理

- 禁止 `danger-full-access`、`--yolo`、`--full-auto`、任何 `dangerously-*`、`approvalsReviewer: auto_review`、WebSocket 和非 loopback listener。
- 真实调用总数最多两个，每个场景最长 60 秒；没有新证据不重试。
- 任何审批请求一律拒绝；审批 payload、Prompt、账号响应、thread/turn id、绝对用户路径和 raw JSONL 不写入 evidence。
- schema 漂移、初始化失败、身份不一致、缺少终态、清理未证明均为 `BLOCKED`、`FAIL` 或 `NOT_PROVEN`，绝不补写 PASS。
- 生成的上游 schema 只存在于已验证的临时目录，记录 hash 后删除，不提交大体积生成物。

## 验证与停止条件

按 RED→GREEN 垂直切片实现协议规划、审批拒绝、结构化中断和 evidence。运行精确测试、lint、typecheck、全量 test、build、隐私/禁止参数扫描、`git diff --check`，提交并推送当前分支，等待 Windows/Ubuntu CI 实际终态。

无论局部结果如何，Outcome 5 与 Gate A 保持冻结。完成本 spike 后，下一正式阶段是 First Vertical Slice；其 UI、Electron、PWA 与真实 Connector 超出此前明确范围，必须在进入前由用户重新决定范围。
