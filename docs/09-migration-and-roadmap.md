# 09. 迁移策略与实施路线

> 状态：Approved Design Draft
> 目标仓库：`hunterzheng1/hunter-platform`
> 产品结构：一个主产品 Monorepo + 一个独立的 Hunter Harness 内容/分发仓库

## 1. 迁移目标

现有 Hunter-Runtime 的早期实现验证了本机 Kernel、进程、安全实验与 Goose 接入，但首要产品问题已经改变：Hunter 不再以 Goose 或任何单一 Agent 为中心，而是构建“多项目 AI 开发控制台 + 确定性工作流编排 + 可替换原生执行层”。

迁移不是在旧类名上继续叠加功能，而是：

1. 用已批准的新领域模型建立 `hunter-platform` 主仓库。
2. 逐项审计并迁移真正通用的旧 Runtime 能力。
3. 保持 `Hunter-Harness` 为工作流、Skill、Archive/Knowledge 资产与可选分发仓库。
4. 删除 Goose 专用产品主线，不在新仓库长期保留废弃实验代码。
5. 先用技术 Spike 决定 Orca 的接入深度，再进入纵向产品实现。

## 2. 目标仓库边界

### 2.1 `hunter-platform`

主产品 Monorepo，拥有：

- Hunter Desktop 与共享 Web/PWA UI。
- `hunterd` 本机服务。
- Project、Requirement、Change、Task 领域。
- Flow Engine、Run、Step、Attempt、Loop、Gate。
- Storage、Artifact、Evidence、Archive 与 Knowledge Catalog。
- Runtime Contracts、Orca Provider 与 Agent Connectors。
- Policy、Device Gateway、测试工具与安装包。

建议逻辑结构：

```text
hunter-platform/
├─ apps/
│  ├─ desktop/
│  ├─ web/
│  └─ daemon/
├─ packages/
│  ├─ domain/
│  ├─ flow-engine/
│  ├─ knowledge/
│  ├─ storage/
│  ├─ runtime-contracts/
│  ├─ provider-orca/
│  ├─ connector-codex/
│  ├─ connector-codebuddy/
│  ├─ connector-cursor/
│  ├─ policy/
│  └─ testkit/
├─ workflow-packs/
│  └─ hunter-default/
└─ docs/
```

仓库初期采用模块化单体。目录表达边界，不意味着每个 Package 都必须立即拆成独立发布物或进程。

### 2.2 `Hunter-Harness`

保留为独立演化的内容与分发仓库：

- Harness Workflow Pack 与版本化模板。
- Agent Skill 的源文件、适配和安装/同步逻辑。
- Archive、Knowledge Ingest/Query 的可复用规则与内容格式。
- 项目规则/上下文资产。
- 可选 Registry 与分发能力。

旧 Hunter-Harness 中的 `Project` 与“首次 CLI Push 注册”不再定义 Hunter Platform 的 Project。旧对象重命名为 `HarnessInstallation`、`DistributionTarget` 或 `ProjectSnapshot`，防止跨上下文术语冲突。

### 2.3 不创建第三个 Kernel 仓库

Flow、Runtime Contracts 与本地治理是主产品内的深模块，不另建强耦合 Kernel 仓库。只有未来出现稳定公共协议和独立发布需求时，才评估拆包。

## 3. 旧 Hunter-Runtime 资产处理

### 3.1 迁移候选：先审计后复制

| 旧能力 | 新归属 | 迁移条件 |
|---|---|---|
| 强类型 ID | `packages/domain` 或 shared kernel | 不携带 Goose 语义；有序列化与碰撞测试 |
| Hash / Fingerprint 基础 | `packages/storage` | 泛化为内容完整性与 provenance，不作 Goose 产品 Gate |
| Clock 抽象 | `packages/flow-engine/testkit` | 支持确定性状态机与恢复测试 |
| Spool / Outbox | `packages/storage` | 改为通用副作用投递与离线事件，验证幂等 |
| Process Supervisor | Runtime 平台适配 | Windows Job Object、Linux process group 可替换 |
| Workspace Identity | `runtime-contracts` / Workbench | 改为 Project/Repository/Device/WorkspaceLease 语义 |
| 本地存储基础 | `packages/storage` | 通过新 Schema、迁移、崩溃与一致性测试 |
| CLI Doctor/探测框架 | `apps/daemon` / diagnostics | 泛化为 Provider/Connector 能力探测 |

迁移规则：不直接复制整包。为每项能力先写新端口和契约测试，再提取最小实现；任何会把旧 Goose Pilot 状态带入新领域的依赖都要切断。

### 3.2 明确移除

以下内容不进入新产品主线，也不保留为长期实验模块：

- Goose 专用 Gate 或 MCP 包装。
- Goose 版本 Pin 与升级门禁。
- 三臂 A/B/C Pilot。
- 30 天 Goose 决策流程。
- 将 Goose 指纹/Hook 测试作为 Workbench 开发前置条件的规则。
- 以观察 Goose Session 作为 `WorkflowRun` 起点的模型。
- 任何默认跳过 Agent 权限的启动配置。

如果未来需要 Goose，通过普通 CLI Agent Connector/Orca 适配，与其他 Agent 适用同一 CapabilityManifest 和验证规则。

### 3.3 历史保全

在对旧仓库进行清空或重初始化前，应在受控位置记录旧 HEAD、远端、标签和必要时生成 Git Bundle；该备份只用于审计和提取通用实现，不应重新成为产品分支。新 `main` 以当前批准设计为基线，避免旧 Phase 0 文档继续被误认为现行架构。

## 4. Hunter-Harness 资产迁移

### 4.1 可复用能力

- `harness-sync / plan / run / test / review / archive` 的工作流意图。
- Archive 元数据、Evidence 组织和知识索引经验。
- Knowledge Query/Ingest 的来源追溯规则。
- Codex、Cursor、CodeBuddy 等 Skill/指令适配资产。
- 现有项目/工作流/Skill 页面中的可用交互模式。
- 上下文索引和项目规则发现能力。

### 4.2 必须重新建模

| 旧概念 | 新概念 |
|---|---|
| Registry Project | `HarnessInstallation` / `DistributionTarget` |
| 固定线性 Harness 顺序 | 版本化 `WorkflowTemplate` + 有界图 |
| 一次 Harness 执行 | `WorkflowRun → StepRun → StepAttempt` |
| 技能文件即运行状态 | Skill/Pack 是资产；Run 状态属于 Flow |
| Archive 结束即停止 | Archive 自动进入分级 Knowledge Pipeline |
| 单仓库身份 | 逻辑 Project + Repository + DeviceBinding |

### 4.3 集成方式

首版将默认 Harness 流程发布为 `workflow-packs/hunter-default`：

```text
需求确认 → 计划 → 实现 → 测试 → Review → 归档 → 知识入库
```

Hunter-Harness 仍可独立发布 Pack/Skill；Platform 通过显式版本和内容哈希导入。运行中的 WorkflowRevision 不随源仓库更新而变化。

## 5. Phase 0：技术去风险与架构决策

### 5.1 目标

用 1–2 周级别的时间盒回答高风险技术问题，不追求正式 UI 或功能广度。

### 5.2 工作包

1. **新骨架**：建立 Monorepo、模块边界、核心领域术语和 ADR。
2. **Flow Slice**：Fake Provider 下跑通 RequirementRevision → ChangeRevision → Task → StepAttempt → Verify → Archive。
3. **Orca Audit/Spike**：验证 Sidecar 接入、Windows ConPTY、worktree、重启、CLI/API、移动和安全边界。
4. **Codex Spike**：冻结可用控制/事件/恢复能力等级。
5. **CodeBuddy Spike**：在 ACP、Headless、HTTP 中选择稳定接入点并冻结能力等级。
6. **Cursor Spike**：先证明 L0/L1 的打开、Handoff、观察与人工 Receipt；并行比较 `@cursor/sdk` public beta 与 CLI，只有条款、事件、权限、Session 和 Windows 契约通过才升级能力等级。
7. **Storage Spike**：SQLite WAL + Event/Outbox + 版本化文件 + Content Store 的故障恢复。
8. **UX Prototype**：多项目、Task DAG、Run 线路、Step Artifact 与移动审批的可用性验证。

### 5.3 决策门

Phase 0 结束必须形成书面决定：

- Runtime Provider：Orca Sidecar / 薄 Fork / Agent Orchestrator / Direct Runtime，或 Outcome 5“尚无生产 Provider 得到证明”。
- Codex、CodeBuddy、Cursor 的实测 CapabilityManifest。
- 桌面壳：以 Electron 作为当前默认方案，验证 Windows Sidecar、安装、升级与进程生命周期；只有出现阻断证据时才用 ADR 重新比较 Tauri 等替代方案。
- Storage Schema 和崩溃恢复是否满足 Phase 1。
- 默认 Workflow Pack 的最小步骤和验证契约。

### 5.4 退出标准

- 不是以“能启动进程”为通过，而是完整运行一次带验证的 StepAttempt。
- Core 与 Provider 任意一方重启不会产生虚假成功或重复 Session。
- 三个首批 Agent 都有真实等级和降级路径。
- 如果 Orca 不通过，替代路径已在同一 Contract 下跑通最小 Spike。
- Fable5 评审的 Blocker 已关闭或由明确 ADR 接受。

### 5.5 当前决策状态（2026-07-22）

ADR-0005 采用 Outcome 5：尚无生产 Runtime Provider 得到证明。Orca、Agent Orchestrator、Codex、CodeBuddy 和 Cursor 的 executable/login 本机探针均为 BLOCKED，时间盒结束后的采用判定为 NOT_PROVEN；不指定 primary/fallback，不选择 Sidecar 或 Fork。

Foundation、Fake contract suite 和 Windows/Ubuntu CI 已通过；Outcome 5 只允许继续 Foundation 维护和 Fake contract 验证。Agent Orchestrator fallback typed scenario 与上面的真实 Provider 退出标准仍未满足，因此 Phase 0 Gate A 和 Phase 1/First Vertical Slice 保持阻断。任何后续阶段、真实 Provider 演示、集成承诺或发布都必须等待 `P0-RUNTIME-01` 产生固定版本、脱敏的原子能力收据并重新评审 Gate A。

## 6. Phase 1：首个完整纵向版本

### 6.1 用户能力

- 一个 Windows 安装包和 Hunter Desktop。
- 创建多个逻辑 Project；每个 Project 可有多个 Requirement。
- RequirementRevision 冻结、Change 规划、串并行 Task DAG。
- 默认 Hunter Harness Workflow 完整运行。
- Codex、CodeBuddy、Cursor 分级接入。
- Run 线路、Attempt、Session、Workspace、日志、Artifact、Evidence 与验证状态。
- 测试/Review 失败后的有界 Loop。
- Core/Provider 重启恢复。
- Archive 自动进入分级 Knowledge。
- 手机 PWA 查看、审批、补充、暂停和继续。

### 6.2 限制

- 单用户、多设备。
- 单仓库体验优先；模型允许多仓，复杂跨仓集成后置。
- 工作流表单与线路预览，不做任意画布。
- 移动端不是终端或 IDE。
- 不默认自动 Merge、Push 或部署。

### 6.3 退出标准

通过 `08-user-stories-and-acceptance.md` 中全部 Phase 1 发布阻断项和黄金场景；在真实 Windows 开发机完成至少一个非玩具项目 Change。

## 7. Phase 2：可配置产品与 Linux 正式支持

- Workflow Template 库、项目覆盖、版本升级和差异预览。
- 多仓库 Change 与 Repository 级 Task 路由。
- 更完整的并行 Change/Task、合并和冲突处理。
- Requirement Amendment、影响分析与重新规划。
- Knowledge 替代、冲突、作用域和上下文策略 UI。
- Linux 桌面/Daemon 正式安装包与端到端验收。
- 更多 Connector：OpenCode、Claude Code、Pi、Goose 等按实际价值排序。
- 导出/导入、备份恢复和数据迁移的产品化。

## 8. Phase 3：生态与可选远程能力

- 可选端到端加密中继、设备发现和通知。
- Agent Orchestrator Provider 或其他 Runtime Provider。
- 飞书、Telegram 等通知与轻审批 Channel。
- Pack/Connector SDK、签名与权限清单。
- 根据真实需求评估团队空间、角色权限和远程 Sandbox。
- 只有本地 Flow 的可靠性/扩展性被证据证明不足时，才评估 Temporal 等服务端引擎。

团队协作、云端执行和原生手机 App 不因进入 Phase 3 就自动立项，仍需独立用户证据和安全评审。

## 9. Orca 决策门槛矩阵

下表是未来有本机证据后选择集成形态的门槛，不是当前测量结果。Outcome 5 下所有 Orca 能力仍为 NOT_PROVEN。

| 维度 | Sidecar 采用门槛 | 薄 Fork 采用门槛 | 放弃/替换触发条件 |
|---|---|---|---|
| 公开接口覆盖核心能力 | 充分 | 有少量关键缺口 | 明显不足 |
| Windows 稳定性 | 通过 | 通过 | 不通过 |
| 恢复与身份关联 | 可由 API 完成 | 需小扩展点 | 需重写内部核心 |
| 单客户端体验 | 可接受 | 明确阻塞且可薄改 | Fork 仍无法解决 |
| 安全默认值 | 可覆盖 | 可通过小改覆盖 | 无法可靠控制 |
| 上游同步成本 | 低 | 可预算 | 高且持续 |
| Hunter 数据独立 | 是 | 是 | 若否则禁止采用 |

Sidecar 是 Orca 获得本机证据后的首个评估形态，不是默认采用结果。当前 Outcome 5 不选择任何生产 Provider。薄 Fork 必须有 sidecar 通过证据、独立 ADR、维护责任人、上游同步策略和退出计划；“想统一品牌”不是 Fork 理由。

## 10. 实施顺序与依赖

```text
领域词汇/契约
  ├─ Flow + Fake Provider ─────────┐
  ├─ Storage/Event/Recovery ───────┼→ Phase 1 Vertical Slice
  ├─ Orca/Connector Spikes ────────┤
  └─ UX Prototype ─────────────────┘
                                      ↓
                             Windows 真实项目验收
                                      ↓
                         可配置工作流 + Linux 正式支持
                                      ↓
                           可选远程/生态/团队能力
```

UI 不等待所有 Connector 完成才开始，但 UI 使用 Fake Provider 和稳定领域 Contract；Connector 也不能自行发明 Run 状态绕过 Flow。

## 11. 迁移安全与回滚

- 清空/重初始化旧远端前，记录旧 HEAD 并创建可恢复备份。
- 新仓库第一次提交只包含设计、上下文和最小工程治理，不混入未经审计旧代码。
- 每个迁移组件以独立 PR/Change 引入，附旧来源、许可证、测试与删除清单。
- Storage Migration 必须有前向验证和备份恢复，不承诺从实验 Schema 无损原地升级；必要时提供显式导入器。
- Orca 与 Agent Connector 都通过 Feature Flag/Provider 选择器切换，失败不要求回滚整个产品数据库。
- 删除 Goose 主线后，如需查阅只从历史备份提取，不在 `main` 恢复废弃模块。

## 12. 路线治理

每个 Phase 结束时更新：

- 已验证能力与未知项。
- 风险登记及触发指标。
- Capability Compatibility Matrix。
- 决策 ADR 与被否决路线。
- 自动/人工验收证据。
- 下一 Phase 的范围和明确非目标。

不能以“某上游产品功能很多”替代 Hunter 自己的验收，也不能因上游迭代而把尚未验证的能力写成已支持。
