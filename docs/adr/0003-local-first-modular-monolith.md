# ADR-0003: 本地优先的模块化单体

- Status: Accepted
- Date: 2026-07-21

## Context

Hunter 首版服务单用户、多项目、多设备，必须可靠支持 Windows，Linux 后续正式验收。Agent、Repository、凭据、worktree 和完整 Artifact 通常位于开发机。本地进程、PTY、原生窗口和工作区操作无法由纯云端服务可靠代替。

与此同时，用户希望有简单桌面客户端，并能从手机或另一台设备查看线路、审批 Gate、补充输入、暂停和继续。如果首版直接拆分云服务、同步服务、工作流服务和 Runtime 服务，将提前引入账号、权限、网络分区、分布式事务和运维成本。

## Options considered

### Option A: 云端执行中心

所有项目、状态和 Agent 调度以云端为中心，本机仅作为 Worker。

优点：天然远程访问和团队协作。缺点：源码/凭据上传压力、离线不可用、本机原生工具接入更复杂，与首版单用户目标不匹配。

### Option B: 首版微服务架构

将项目、需求、Flow、Runtime、Knowledge、Gateway 拆成独立服务。

优点：部署边界清晰、未来可独立扩展。缺点：过早增加协议、部署、版本、观测和一致性成本，妨碍验证核心体验。

### Option C: 本地模块化单体

一个安装包包含 Desktop、共享 Web UI 和一个本地 `hunterd`。业务上使用清晰模块边界和端口，物理上共享一个进程与本地事务。移动端通过认证 API 访问主机；中继为可选后续能力。

## Decision

选择 Option C。

首版产品由以下部署单元组成：

- Hunter Desktop：Windows 首发，Linux 结构兼容。
- `hunterd`：本地应用服务，包含 Workbench、Requirements、Flow、Runtime、Knowledge、Policy 和 DeviceGateway 模块。
- Hunter Web：桌面与移动 PWA 共用界面。
- SQLite WAL、版本化文件区、Content-addressed Store 和 OS Credential Store。

服务默认仅监听本机。移动端通过一次性设备配对、局域网或用户已有的 Tailscale/WireGuard 连接；可选加密中继后置。主机离线时只允许查看已同步摘要。

代码位于一个 `hunter-platform` Monorepo。当前 Hunter-Harness 保持为独立 Workflow/Skill 内容与分发仓库。不会创建第三个 Kernel 仓库。

## Consequences

### Positive

- 最短路径验证多项目、工作流、Agent 接入和恢复体验。
- 可使用本地事务保证核心状态一致性，减少分布式失败模式。
- Repository、凭据和完整产物默认留在开发机。
- Windows 原生进程、ConPTY、Job Object 和应用启动可以直接实现与测试。
- 清晰模块接口为未来拆服务、替换 Provider 和 Linux 适配保留边界。

### Negative

- `hunterd` 需要承担多个业务模块，必须严守模块边界避免大泥球。
- 主机离线时移动端无法执行真实控制。
- 多设备的权威执行仍以绑定主机为中心，不是无缝多主复制。
- 团队、云端调度与企业隔离能力不能直接从首版架构获得。

### Follow-up constraints

- 模块接口同时作为测试入口；UI 不得直接访问数据库。
- 平台差异封装在 ProcessHost、WorkspaceProvider、SecretStore 和 NativeSurfaceOpener。
- Windows 是 Phase 0/1 硬验收平台；Linux 不能被 Windows 专有路径或进程模型阻断。
- 只有出现可测量的独立伸缩、隔离或部署需求时才拆微服务。
- 远程设备具有独立密钥和权限，可撤销；手机不能绕过 PolicyEngine。
