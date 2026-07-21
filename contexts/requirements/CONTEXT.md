# Requirements Context Glossary

## Canonical terms

| Term | Canonical meaning |
|---|---|
| `Requirement` | 一个长期业务意图、问题或能力目标的身份容器；本身不等同于一次开发执行。 |
| `RequirementRevision` | Requirement 在某时刻的不可变正文、背景、约束和验收标准快照。 |
| `RequirementStatus` | RequirementRevision 的生命周期：`draft`、`in_review`、`approved`、`superseded` 或 `withdrawn`。 |
| `Approval` | 指定 Actor 对某个不可变 RequirementRevision 的确认记录。 |
| `RequirementAmendment` | 对已批准需求提出的变更；被接受后产生新的 RequirementRevision，不覆盖旧版本。 |
| `Change` | 一次有边界、可交付、可验证的实现切片的身份容器。 |
| `ChangeRevision` | Change 的不可变范围快照，包含目标、非目标、验收条件及所覆盖的 RequirementRevision。 |
| `ChangeRevisionStatus` | ChangeRevision 内容生命周期：`draft`、`published`、`superseded` 或 `withdrawn`；只有 published 可进入 ExecutionPlan。 |
| `RequirementCoverage` | ChangeRevision 与一个或多个 RequirementRevision 之间的可追溯关系。 |
| `ChangeDependency` | 两个 Change 之间显式的先后或阻塞关系。 |

## Avoid

| Avoid | Use instead |
|---|---|
| 批准后原地编辑需求 | 创建 `RequirementAmendment` 和新 `RequirementRevision` |
| 用 `ChangeRequest` 同时表示需求修订和实现切片 | 需求修订用 `RequirementAmendment`；交付切片用 `Change` |
| 把 Requirement 当成一次 Run | `ChangeRevision` 进入 `WorkflowRun` |
| 把 Change 当成具体执行步骤 | `Task` 与 `Workflow Step` |
| 假定一个 Change 只能覆盖一个 Requirement | 使用 `RequirementCoverage` 关联一个或多个 Revision |
| 删除被替代的需求版本 | 标记为 `superseded`，保留历史与引用 |
| 覆盖已发布或被 Run 固定的 ChangeRevision | 创建新的 Draft ChangeRevision，重新发布与规划 |
