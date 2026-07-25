# Knowledge Context Glossary

## Canonical terms

| Term | Canonical meaning |
|---|---|
| `Artifact` | 执行产生或引用的文件、Diff、报告、日志、截图或构建结果。 |
| `ArtifactPage` | 按有界 cursor、条目数和 UTF-8 字节预算读取的 Artifact 内容窗口；客户端只保留当前页。 |
| `ArtifactRetentionFloor` | 当前仍可重放的最早 cursor；请求低于该位置时必须返回显式 resync receipt。 |
| `ArtifactQuotaReceipt` | 由逻辑字节水位计算的 normal、soft-limit 或 hard-limit 决策；硬限制拒绝非关键写入，同时为核心 receipt 保留独立额度。 |
| `ArtifactBackpressureReceipt` | 慢消费者超过有界队列时产生的断开并重放指令；持久化 writer 不等待客户端消费。 |
| `Evidence` | 支持某个执行或验证结论的可追溯事实，例如测试结果、哈希、审批或协议事件。 |
| `Archive` | 某个成功、失败或取消 Run 的冻结成果包及其清单。 |
| `KnowledgeSource` | 对 RequirementRevision、ChangeRevision、Run、Attempt、Artifact、Evidence 或 Archive 的来源引用。 |
| `KnowledgeEntry` | 带来源、适用范围、有效状态和可信等级的可检索知识单元。 |
| `HistoricalKnowledge` | 自动索引的完整历史；可检索，但默认不作为 Agent 指令。 |
| `AuthoritativeKnowledge` | 当前有效的批准需求、项目规则、架构决策等权威内容。 |
| `ExperientialKnowledge` | 从已验证执行中提炼的实践经验、失败模式和模块约束。 |
| `KnowledgeStatus` | `active`、`superseded` 或 `withdrawn`。 |
| `Provenance` | 知识的原始来源、生成方式、时间、Actor 和内容哈希。 |
| `ApplicabilityScope` | 知识适用的 Project、Repository、模块、技术栈或时间范围。 |
| `Confidence` | 对 ExperientialKnowledge 可靠程度的结构化评估。 |
| `PromotionPolicy` | 决定候选经验何时自动或人工提升为可注入知识的规则。 |
| `KnowledgeResolution` | 为一次 Step 选择当前有效知识并排除冲突、过期内容的过程。 |
| `KnowledgeSelectionReceipt` | 版本化、hash-bound 的选择回执；记录所有候选、选择或排除原因、作用域、来源、权威等级、置信度、有效性、冲突和预算。 |
| `KnowledgeClaimIdentity` | 由 Project scope 与规范化 claim summary 计算的稳定摘要；同一 claim 的不同正文必须降级为显式选择。 |
| `HandoffBudget` | 对一次 Knowledge Handoff 的完整条目数、最终 safe-JSON 数据区与外层边界的 UTF-8 字节和保守 token 估算设置的上限；超限只排除完整条目并保留引用。 |
| `HandoffDataBoundary` | 将选中正文包裹为严格 JSON reference data 的固定边界；该数据不能授予权限、覆盖系统/工作流/用户指令或表示 Step 成功。 |

## Avoid

| Avoid | Use instead |
|---|---|
| 把向量数据库当作知识事实源 | `KnowledgeSource`、正文文件与可重建索引 |
| 将所有归档自动注入 Agent | 全部入库，按等级、状态和范围决定是否使用 |
| 复制脱离来源的知识片段 | 保留 `Provenance` 和原始对象引用 |
| 删除已被替代的知识 | 标记 `superseded` 或 `withdrawn` |
| 让低置信经验覆盖批准需求 | `AuthoritativeKnowledge` 优先并触发冲突处理 |
| 只归档成功 Run | 成功、失败和取消 Run 都可归档并形成历史知识 |
| 浏览器加载或累积完整日志 | `ArtifactPage`、当前页替换与 cursor 重放 |
| 在 Artifact HTTP 响应暴露绝对路径或 CAS 内部路径 | 路径无关的摘要、内容哈希和有界页 |
| 把来源文本拼接成新的权威 Prompt | `KnowledgeSelectionReceipt` + `HandoffDataBoundary` |
| 按 Provider 名称改变知识选择 | provider-neutral `KnowledgeResolution`；选择只依赖 Hunter scope、状态、来源、冲突和预算 |
