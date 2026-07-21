# Workbench Context Glossary

## Canonical terms

| Term | Canonical meaning |
|---|---|
| `Project` | 用户管理的一个完整产品、目标或长期工作空间；可包含多个 Requirement，并绑定一个或多个 Repository。 |
| `ProjectId` | Project 的稳定、与路径及仓库地址无关的全局标识。 |
| `Repository` | 受 Project 管理的源码或文档版本库；一个 Project 可有一个主仓库和多个附属仓库。 |
| `RepositoryBinding` | Project 与 Repository 的关系，包含角色、默认分支和是否为主仓库等元数据。 |
| `Device` | 运行 Hunter Runtime 的一台 Windows 或 Linux 主机。 |
| `DeviceBinding` | Repository 在某台 Device 上的本地可用性及路径绑定。 |
| `LocalPathRef` | 仅在指定 DeviceBinding 内有效的本地路径引用。 |
| `ProjectEnvironment` | Project 在某台 Device 上运行所需的非秘密环境配置引用。 |
| `ProjectDashboard` | 聚合 Project 的 Requirement、Change、Run、Artifact 和待处理事项的只读投影。 |

## Avoid

| Avoid | Use instead |
|---|---|
| 用 `Project` 表示单个 Git 仓库 | `Repository`；Project 可绑定多个 Repository |
| 用 `Project` 表示一次 CLI Push 注册 | `HarnessInstallation` 或 `ProjectSnapshot` |
| 把本地绝对路径作为 Project 或 Repository 的身份 | `ProjectId`、Repository identity 与 `DeviceBinding` |
| 假定所有设备具有相同路径 | 每台 Device 独立的 `DeviceBinding` |
| 让 UI 直接修改 Workbench 数据表 | 通过 Workbench 模块接口或命令 |
| 在 Workbench 中保存 Agent 私有 Session 状态 | Runtime 的 `NativeSessionRef` |
