# 07. 本地存储、安全、恢复与远程访问

> 状态：Approved Design Draft
> 核心判断：开发机是执行与完整数据事实源；云端或中继只是可选连接层。

## 1. 数据所有权原则

Hunter 默认将以下内容留在本机：

- 源码仓库与 worktree。
- Agent 凭据和登录状态。
- Requirement、Change、Workflow、Archive 与 Knowledge 正文。
- 完整 Event、日志、Artifact 和 Evidence。
- Native Session 与本机路径映射。

远程设备只通过认证 API 访问 `hunterd`。首版不把 SQLite 文件放入网盘、不在设备之间复制正在使用的数据库，也不默认把源码上传到 Hunter 服务。

## 2. 事实源分层

| 存储层 | 保存内容 | 事实源角色 |
|---|---|---|
| SQLite WAL | 标识、关系、状态、事件账本、幂等键、查询投影 | 运行与索引事实源 |
| 版本化文件区 | 需求、工作流、计划、归档、知识正文 | 人可读内容事实源 |
| Content-addressed Store | 大日志、附件、截图、测试与构建产物 | 不可变二进制/大对象事实源 |
| Git / worktree | 源码、提交、分支、代码 Diff | 代码事实源 |
| 系统凭据库 | Token、设备私钥、Connector Secret | 机密事实源 |

重要内容不能只存在于 SQLite 的不可读字段中。SQLite 保存文件引用、内容哈希、版本、来源和状态；正文采用 Markdown、JSON、YAML 或原始附件，便于迁移、审查和备份。

## 3. 逻辑数据布局

具体系统目录由平台适配层决定：Windows 使用用户应用数据目录，Linux 遵循 XDG。逻辑布局如下：

```text
hunter-data/
├─ hunter.sqlite
├─ content/                    # 按哈希寻址的大对象
├─ projects/
│  └─ <project-id>/
│     ├─ requirements/
│     ├─ changes/
│     ├─ workflows/
│     ├─ archives/
│     └─ knowledge/
├─ runtime/
│  ├─ logs/
│  ├─ receipts/
│  └─ spool/
├─ exports/
└─ backups/
```

源码仓库不复制到该目录；这里只保存 `RepositoryIdentity` 和当前设备的 `DeviceBinding`。本地绝对路径不能进入可跨设备同步的内容文件。

## 4. 版本化内容规则

### 4.1 不可变版本

- 已批准的 `RequirementRevision` 不可覆盖。
- 已发布的 `WorkflowRevision` 不可覆盖。
- 已启动 Run 绑定的 `ChangeRevision` 和 `ExecutionPlan` 不可替换。
- Archive 一旦封存，只能追加纠正记录，不能原地重写证据。

### 4.2 身份与完整性

每个版本化对象至少包含：

```text
object_id
revision_id
schema_version
created_at
created_by
content_hash
source_refs
supersedes
```

Artifact 和 Evidence 使用内容哈希去重，但对象引用仍保留独立来源和权限，不能因为内容相同而丢失 provenance。

### 4.3 原子写入

文件先写入同卷临时文件、刷新并原子替换，再在数据库事务中登记最终哈希。若文件写入完成而数据库事务失败，启动时由孤儿扫描器回收或重新关联；若数据库已有引用而文件缺失，标记数据损坏并阻止相关验证通过。

## 5. 事件账本与投影

Hunter 使用 append-only Event Ledger 记录关键状态变化，并维护面向 UI 的查询投影。它不是要求所有正文都事件溯源，而是确保 Run 可以解释和恢复。

状态变化流程：

1. 验证命令的当前版本和权限。
2. 在同一事务中写入 Domain Event、幂等记录和必要投影。
3. 将外部副作用写入 Outbox。
4. Runtime Worker 使用幂等键执行外部动作。
5. 回执写回 Event 与 Evidence，再推进状态。

Event 至少包含全局顺序或流内版本、发生时间、记录时间、Actor、Correlation ID、Causation ID、Schema Version 和脱敏 Payload。

## 6. 幂等与并发控制

- API 命令、移动审批、启动 Session、发送 Prompt、暂停和继续都携带幂等键。
- Aggregate 使用乐观并发版本，过期写入返回冲突并要求刷新。
- 一个 Native Session 同时只有一个 Controller Lease。
- 一个可写 Workspace 同时只有一个 Writer Lease；并行 Task 必须用独立 worktree。
- 重复移动审批返回原 Receipt，不重复推进工作流。
- Connector 事件根据上游 Event ID 或 Hunter 去重键进行去重，但保存异常重复的审计信息。

## 7. 崩溃恢复

### 7.1 启动恢复流程

`hunterd` 启动后依次执行：

1. 校验数据库 Schema、WAL 和内容目录可读性。
2. 完成或回滚中断的 Storage Migration。
3. 重放未处理 Outbox，使用原幂等键。
4. 枚举 `running / assigned / waiting_* / verifying` Attempt。
5. 向 ProcessHost、Orca 和 Agent Connector 重新探测会话。
6. 校验 Workspace 路径、Lease、Git HEAD 和外部修改。
7. 重建查询投影或校验投影版本。
8. 将无法证明仍存活的会话标记 `stale / needs_attention`。

禁止在找不到进程、终端或 Session 时猜测成功。验证器应设计为可重跑；有外部副作用且无法安全重放的 Step 必须进入人工恢复 Gate。

### 7.2 恢复结果

| 外部状态 | Hunter 处理 |
|---|---|
| Session 存活且身份匹配 | 重新 Attach，继续采集事件 |
| 进程退出且有结构化完成回执 | 进入验证 |
| 进程退出但无可靠回执 | 标记待处理，允许验证或人工判定 |
| Session 不存在但支持 Resume | 在确认 Workspace 后恢复 |
| Session 不存在且不支持 Resume | 新建 Session + Handoff Pack，显式降级 |
| Workspace HEAD/文件意外变化 | 冻结自动推进，要求检查外部修改 |

## 8. 备份、导出与迁移

- SQLite 使用在线备份 API 或受控 checkpoint 后复制，不能直接同步活动文件。
- 内容区与数据库备份必须共享一个 Manifest 和一致性时间点。
- 项目可以导出自包含 Bundle：版本化内容、对象关系、事件摘要、哈希清单和可选大对象；源码只保存 Git Remote/Commit 引用，除非用户明确选择包含。
- 导入先执行 Schema、哈希、路径和权限验证，再生成本设备 DeviceBinding。
- 自动备份默认保留最近恢复点，具体保留策略可配置。
- 恢复演练是发布验收的一部分；“能生成备份”不等于“能恢复”。

## 9. 信任边界

```text
移动/浏览器客户端
        │ 受认证 API
        ▼
Hunter Core ── PolicyEngine ── Runtime Manager
        │                         │
        │                         ├─ Orca / ProcessHost
        │                         ├─ Agent Connector
        │                         └─ Native App
        ├─ SQLite / Content
        ├─ Project Files
        └─ Credential Store
```

下列输入都视为不可信：

- Agent 文本、工具调用和协议事件。
- 仓库内配置、Skill、脚本和依赖。
- 上游 Connector 返回路径。
- 浏览器与移动端参数。
- 导入的 Workflow Pack、Archive 和 Knowledge。
- Orca 或其他 Provider 的版本与配置。

跨边界时必须执行 Schema、大小、路径范围、权限、内容类型和版本验证。

## 10. 凭据与敏感信息

- Windows 使用 Credential Manager；Linux 使用 Secret Service 或经批准的系统安全存储。
- SQLite、Event、日志、Prompt、Artifact 和崩溃报告不得保存明文 Token。
- Secret 通过短生命周期句柄传入 Connector；不得拼接到命令行，因为命令行可能被其他进程读取。
- 日志管道执行可配置脱敏，至少覆盖已注册 Secret 与常见授权头。
- 数据导出默认排除凭据、登录缓存、本机路径和完整环境变量。
- 设备私钥不可经 Hunter 同步；撤销设备后服务端立即拒绝其新请求。

## 11. PolicyEngine

PolicyEngine 在 Project、Workflow Step、AgentProfile、工具和设备五个范围合并策略，输出：

```text
allow
deny
require_approval
```

默认需要人工 Gate 的高风险动作：

- 访问项目范围外的文件。
- 获取未声明凭据。
- 删除、覆盖或批量移动文件。
- 安装系统级软件或提升权限。
- Push、Merge、发布、部署或修改远端资源。
- 绕过 Agent 自身权限机制。
- 从移动端发起高危命令。

首版不继承 Orca 或任何 Agent 预填的“跳过全部权限”默认参数。项目可以配置更严格策略；放宽策略必须记录审批人、范围和有效期。

## 12. 远程访问模型

### 12.1 默认模式

- `hunterd` 默认仅监听 loopback。
- 桌面 UI 使用本机受认证通道。
- 用户显式启用远程访问后才开放配对。

### 12.2 设备配对

1. 桌面端生成短时、一次性配对挑战。
2. 手机在本地扫描二维码或输入短码。
3. 双方完成密钥证明，Hunter 为设备签发独立身份和最小权限。
4. 用户在桌面确认设备名称、权限与有效期。
5. 设备可随时单独撤销；配对码不能重复使用。

首版优先支持局域网与用户自有 Tailscale/WireGuard。可选加密中继在 Phase 3 评估，只承担设备发现、连接转发与通知，不成为运行或源码事实源。

### 12.3 远程权限范围

移动驾驶舱默认允许：

- 查看已授权项目的状态与摘要。
- 查看经策略允许的 Artifact/Evidence 预览。
- 回答等待输入。
- 批准低/中风险 Gate。
- 暂停、继续或终止 Run。

默认禁止：

- 浏览完整源码或未授权日志。
- 修改 Workflow、AgentProfile 和权限策略。
- 下载 Secret 或完整环境。
- 直接打开任意终端执行命令。
- 绕过桌面端要求的高风险审批。

## 13. 离线行为

- 主机在线时，移动端通过 Event Cursor 增量更新。
- 短暂断线后从最近确认的 Cursor 续传，并对命令使用幂等键。
- 主机离线时只展示明确标记时间的缓存摘要。
- 离线设备不能预先批准尚未产生的高风险 Gate。
- 可选通知服务只收到最小化摘要和不透明标识，不接收 Prompt、源码或完整 Artifact。

## 14. 网络与 API 安全

- 所有非本机连接强制加密和双向设备认证。
- API 采用短生命周期访问令牌与设备绑定刷新机制。
- 重要命令包含 Project、Run、Step、预期版本和幂等键，防止跨对象重放。
- 速率限制、Payload 大小限制和连接上限适用于本地与远程客户端。
- WebSocket/SSE 只发送设备获权的数据；服务端重新做授权，不能依赖前端过滤。
- 浏览器入口设置严格 Origin、CSRF、CSP 和下载响应头。
- 中继无法解密内容；若无法做到端到端加密，就不得传输敏感 Payload。

## 15. 知识安全与污染防护

所有 Archive 自动进入历史知识索引，但自动注入受以下约束：

- 权威需求只注入 `active` Revision。
- `superseded / withdrawn` 仍可检索，但默认不进入 Handoff Pack。
- 自动提炼的经验先带置信度、来源和适用范围；冲突时降级为 candidate。
- 来自失败 Run、外部文档或未信任 Agent 的结论不能自动升级为权威知识。
- Prompt injection 风险内容以引用材料身份注入，并与系统规则隔离。
- 每个 Handoff Pack 记录选用了哪些 KnowledgeEntry 以及选择策略。

## 16. 审计、隐私与遥测

- 权限决定、远程控制、Session 启停、知识提升、导入导出和策略变更进入审计账本。
- 审计记录不得包含 Secret；对 Prompt 正文可采用引用和哈希。
- 产品遥测默认关闭；如以后加入，必须显式选择、字段公开且可本地查看。
- 崩溃报告默认在本机生成预览，由用户决定是否发送。
- 日志保留期和大对象清理策略可按项目配置，删除前显示引用影响。

## 17. 安全验收基线

1. 未启用远程访问时，从其他设备无法连接。
2. 配对码不可重放，撤销设备立即失效。
3. 重复审批不会重复推进 Step。
4. Connector 无法从 Project 外路径采集 Artifact。
5. 日志和导出中不出现注册过的 Secret。
6. Core 或 Orca 崩溃后不产生重复 Agent Session。
7. 数据库损坏或 Artifact 丢失时 fail closed，不把 Step 标为通过。
8. 不支持权限事件的 Connector 自动降级，不能获得 L3 标识。
9. 活动 SQLite 从不通过文件同步机制跨设备复制。
10. 从备份恢复后，Requirement/Change/Run/Artifact/Knowledge 的引用和哈希完整。
