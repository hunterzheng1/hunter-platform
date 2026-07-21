# Hunter Platform Context Map

本文档定义 Hunter Platform 的限界上下文、权威术语归属与跨域关系。各上下文只通过公开契约协作，不共享内部模型，也不以数据库表作为跨域接口。

## 产品级主链

```text
Project
  -> RequirementRevision(s)
    -> ChangeRevision
      -> ExecutionPlan / TaskGraph
        -> WorkflowRun (Change orchestration)
          -> Task -> Child WorkflowRun
            -> StepRun / StepAttempt
            -> NativeSessionRef + WorkspaceLease
              -> Artifact + Evidence
                -> Archive -> KnowledgeEntry
```

`Requirement -> Change -> Task -> Workflow Step` 是产品的四层业务语义：

- Requirement 描述要解决什么以及为何解决。
- Change 描述一次有边界、可交付、可验证的实现切片。
- Task 是规划产生、可调度且带依赖的工作单元。
- Workflow Step 描述一个 Task 如何经过计划、实现、测试、评审和归档等过程。

## 限界上下文

| Context | 权威对象 | 不负责 |
|---|---|---|
| Workbench | `Project`、`Repository`、`DeviceBinding` | 需求版本、执行状态、原生 Agent 会话 |
| Requirements | `Requirement`、`RequirementRevision`、`RequirementAmendment`、`Change`、`ChangeRevision` | Task 调度、工作流状态机 |
| Flow | `ExecutionPlan`、`TaskGraph`、`Task`、`WorkflowRevision`、`WorkflowRun`、`StepRun`、`StepAttempt` | 操作 PTY、解释 Agent 私有状态 |
| Runtime | `AgentProduct`、`AgentProfile`、`Connector`、`NativeSessionRef`、`WorkspaceLease` | 判定业务步骤成功、保存需求正文 |
| Knowledge | `Artifact`、`Evidence`、`Archive`、`KnowledgeSource`、`KnowledgeEntry` | 调度 Agent、修改冻结需求 |
| Harness Distribution | `HarnessPack`、`WorkflowPack`、`SkillPackage`、`DistributionRelease`、`HarnessInstallation` | 定义 Workbench Project、成为本地执行前置依赖 |

## 跨域引用

- 跨域引用使用稳定 ID 和不可变 Revision ID，不复制对方的可变内部状态。
- `WorkflowRun` 必须固定引用一个 `ChangeRevision`、一组 `RequirementRevision` 和一个 `WorkflowRevision`。
- `StepAttempt` 可引用 Runtime 返回的 `NativeSessionRef`，但会话状态不能直接决定步骤是否成功。
- Knowledge 通过 `KnowledgeSource` 引用需求、Change、Run、Attempt、Artifact 与 Evidence；来源对象仍由原上下文持有。
- Harness Distribution 可以发布 Flow 可导入的工作流包和 Runtime 可安装的适配资产，但不能修改正在运行的 Revision。
- `DeviceBinding` 保存某个 Repository 在某台设备上的路径；本地路径不是跨设备身份。

## 产品边界

- Hunter 是项目、需求、工作流、执行证据和知识的控制面，不是新的超级编程 Agent。
- Codex、CodeBuddy、Cursor、Orca 及未来工具都是可替换执行能力，不持有 Hunter 的权威业务状态。
- 一个 `Project` 可以绑定一个或多个 Repository；首版优先做好单仓库体验，但领域模型不得收窄为“一仓库一项目”。
- 已批准的 RequirementRevision、已发布的 ChangeRevision 和 WorkflowRevision 不可覆盖修改。
- Loop、重试、并行和自动推进必须受显式策略、预算与验证器约束。
- 文件保存可读、可版本化的正文；数据库保存关系、索引、事件与运行投影。

## 术语冲突处理

如果旧 Hunter-Harness 文档或 Registry 使用 `Project` 表示一次 CLI Push 注册，本产品不沿用该语义。对应对象应改称 `HarnessInstallation`、`ProjectSnapshot` 或 `RegistryEntry`。任何跨域新术语必须先在所属 Context 的 `CONTEXT.md` 中定义，再进入接口或持久化模型。
