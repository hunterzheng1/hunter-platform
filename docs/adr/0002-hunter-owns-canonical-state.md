# ADR-0002: Hunter 持有权威业务状态

- Status: Accepted
- Date: 2026-07-21

## Context

Hunter 会调用或打开多个外部 Agent，也可能使用 Orca 管理终端、worktree 和移动会话。这些系统拥有自己的会话和进程状态，但不理解 Hunter 的不可变需求、Change、TaskGraph、Workflow Revision、验证契约和知识生命周期。

如果把 Orca、某个 Agent 的聊天历史、终端文本或 Git 分支当作 Hunter 的唯一状态，外部工具重启、升级或被替换时将无法可靠恢复 Run，也无法区分“Agent 返回”“验证通过”和“已归档”。同时，需求、工作流和知识若只存在数据库或向量索引中，会失去人工可读性、版本化和迁移能力。

## Options considered

### Option A: Runtime Provider 持有状态

直接使用 Orca 或其他 Provider 的 Project、Session 和 Workspace 模型作为 Hunter 核心。

优点：初期代码少。缺点：绑定上游语义；Provider 不拥有需求、验证和知识；替换与崩溃恢复困难。

### Option B: Git 与文件系统隐式表达全部状态

通过目录、分支、Markdown 和日志推断运行状态，不建立专门状态存储。

优点：可读、可版本化。缺点：并发、Lease、幂等、事件去重、等待状态和设备控制难以可靠表达。

### Option C: 所有内容只存关系数据库

需求、工作流、正文、Artifact 和运行状态全部写入数据库。

优点：事务和查询统一。缺点：重要内容不可直接阅读和版本控制；迁移和 Agent 文件访问更困难；大文件成本高。

### Option D: Hunter 持有混合权威状态

Hunter 使用不可变 Revision 和事件账本持有业务状态。SQLite 保存关系、事件、动态状态和索引；版本化文件保存可读正文；Content-addressed Store 保存大产物；Git 继续保存源码；系统凭据库存秘密。

## Decision

选择 Option D。

权威归属如下：

| 内容 | 权威位置 |
|---|---|
| Project、Revision 关系、Run/Step/Attempt、Lease、事件 | Hunter SQLite WAL 与领域模块 |
| Requirement、Change、Workflow、Plan、Archive、Knowledge 正文 | Hunter 管理的版本化文件区 |
| 大日志、附件、截图、测试/构建产物 | Content-addressed Store |
| 源代码和提交历史 | Git Repository/worktree |
| Token 与密钥 | OS Credential Store |
| 外部真实会话/进程 | Provider/Agent；Hunter 保存稳定 Ref、能力快照与观察事件 |

WorkflowRun 永久绑定 RequirementRevision、ChangeRevision 和 WorkflowRevision。外部 Session 的空闲、退出或 completion 只更新执行事实；Step 是否成功由 Hunter Flow 根据 OutputContract、Evidence、Verifier 或人工确认决定。

所有 Archive 自动成为 KnowledgeSource。HistoricalKnowledge 默认只可检索；当前有效的 AuthoritativeKnowledge 和通过 PromotionPolicy 的 ExperientialKnowledge 才可自动注入。

## Consequences

### Positive

- Orca 或 Agent 被替换、重启、失联时，产品状态仍然完整。
- 执行、验证、归档和知识可以分别审计。
- 正文可人工阅读、Git 化、迁移和由 Agent 安全引用。
- 动态状态获得事务、幂等、Lease 和可靠恢复能力。
- 向量或搜索索引可以从源文件与关系重建，不成为事实源。

### Negative

- 需要维护文件、数据库、CAS 和 Git 之间的引用完整性。
- 状态写入必须定义事务边界、事件版本和崩溃恢复流程。
- Provider 状态与 Hunter 投影之间需要持续对账。
- 内容变更、哈希和索引更新需要清晰的原子性策略。

### Follow-up constraints

- UI、CLI 和移动端不得直接修改数据库表。
- 所有外部启动/控制命令必须携带幂等键。
- 找不到外部会话时标记 `stale/needs_attention`，不得猜测成功。
- 已批准或已发布 Revision 不允许原地修改。
- KnowledgeEntry 必须保留 Provenance、适用范围和有效状态。
