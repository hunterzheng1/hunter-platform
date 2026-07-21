# Harness Distribution Context Glossary

## Canonical terms

| Term | Canonical meaning |
|---|---|
| `HarnessPack` | 可安装的 Hunter 工作方式内容包，可聚合 Workflow、Skill、规则和模板。 |
| `WorkflowPack` | 包含一个或多个 WorkflowTemplate/Revision 及其元数据的发布单元。 |
| `SkillPackage` | 面向某类 Agent 的 Skill 源文件、适配描述和版本元数据。 |
| `DistributionRelease` | 经过版本化、校验和签名的可分发内容快照。 |
| `HarnessInstallation` | 某个 DistributionRelease 在一个 Project、Device 或 Agent 环境中的安装记录。 |
| `ProjectSnapshot` | 为同步、诊断或发布生成的 Project Harness 元数据快照；不是 Workbench Project。 |
| `RegistryEntry` | 可选远端 Registry 中对 DistributionRelease 的目录记录。 |
| `AdapterWorkingCopy` | 安装到具体 Agent 目录、允许按适配规则更新的 Skill 工作副本。 |
| `CompatibilityRange` | DistributionRelease 声明兼容的 Hunter、Agent 和平台版本范围。 |

## Avoid

| Avoid | Use instead |
|---|---|
| 用 `Project` 表示首次 Push 的注册记录 | `HarnessInstallation`、`ProjectSnapshot` 或 `RegistryEntry` |
| 要求先 Push 到 Registry 才能在客户端创建 Project | Workbench 创建 Project；Distribution 是可选能力 |
| 让 Registry 成为本地执行依赖 | 本地缓存和版本固定；Registry 可离线 |
| 发布后原地修改内容 | 新建 `DistributionRelease` |
| 把 Agent 安装目录里的文件当作唯一源 | `SkillPackage` 为发布源，`AdapterWorkingCopy` 为适配副本 |
| 让 Harness 包修改正在运行的 WorkflowRevision | 显式预览并升级到新 Revision |
