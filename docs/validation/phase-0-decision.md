# Phase 0 Runtime Provider 决策

- 决策日期：2026-07-22
- 决策结果：**Outcome 5 — 尚无生产 Runtime Provider 得到证明**
- Provider 采用状态：`NOT_PROVEN`
- Foundation 验证范围：`contract_only`（Fake Runtime）
- 适用平台证据：Windows 本机；Windows/Ubuntu GitHub-hosted runners

## 决策摘要

本轮不采用 Orca sidecar、不建立薄 Fork、不采用 Agent Orchestrator，也不把 Direct Runtime 视为已经通过。Orca、Codex、CodeBuddy Code、Cursor 和 Agent Orchestrator 的本机 executable 或安全非交互登录条件均未满足，因此没有真实 Provider/Connector 能力收据可以支持生产选择。

Hunter Foundation 已通过 provider-neutral contracts、确定性 Fake Runtime、崩溃恢复和 Windows/Ubuntu CI。这些结果只证明 Hunter 自己的契约与失败语义，不证明任何真实 Provider。Outcome 5 只允许继续 Foundation 的维护和 Fake contract 验证；Phase 0 Gate A、fallback typed scenario、First Vertical Slice 和真实 Provider 发布均保持阻断，直到计划要求的证据齐备。

## 状态解释

[`environment-inventory.json`](environment-inventory.json) 记录探针当时的即时状态：缺少或不可安全调用的 executable/login 为 `BLOCKED`。Phase 0 时间盒结束时，计划要求把这种阻断转换为**采用判定** `NOT_PROVEN`。因此 Doctor 汇总中的 `notProven=0` 与本决策不矛盾：前者是单次环境探针状态，后者是时间盒结束后的产品采用结论。

## Gate A 判定

| Gate A 条件 | 本机证据 | 判定 | 契约补充 |
| --- | --- | --- | --- |
| Orca 通过公开、可脚本化接口创建并恢复 Windows worktree 与 terminal | Orca executable/login 均为 BLOCKED；没有可执行场景或恢复收据 | NOT_PROVEN | 无 |
| Hunter 能观察 terminal 丢失且不误报成功 | 真实 terminal 未运行 | NOT_PROVEN | [Foundation recovery suite](foundation-local-gate.md) 已证明 Hunter 契约不会因 session missing/process exit 成功 |
| CodeBuddy 可通过 ACP/官方 headless 创建、steer、cancel、resume | CodeBuddy executable/login 均为 BLOCKED；没有 transport/version receipt | NOT_PROVEN | 无 |
| Codex 暴露适合托管 Step 的受支持结构化/headless 接口 | Codex CLI executable missing or unusable，登录不可验证；没有固定版本 capability receipt | NOT_PROVEN | 无 |
| Cursor 可可靠打开准确 workspace，深层能力单独记录 | Cursor executable/login 均为 BLOCKED；没有 workspace-open receipt | NOT_PROVEN | 无 |
| 必需路径不依赖权限绕过默认值 | 没有真实 Provider launch path 可供验证 | NOT_PROVEN | [Foundation 门禁](foundation-local-gate.md) 只证明 Hunter 实现和 Fake contract 没有 bypass/yolo/auto-approve 参数 |

## Provider 决策矩阵

本轮没有对候选固定版本执行上游声明采集与核验，因此该列统一记录“未收集”，并把计划要求改写成下一次测试假设。它不是上游事实，也不用于推导 L0–L3。

| 维度 | 上游声明/测试假设 | 本机证据 | 判定 | 证据 |
| --- | --- | --- | --- | --- |
| Windows | 未收集；假设：候选应在固定 Windows 版本暴露可调用入口 | 仅 Windows host、Node、Git 被检测；候选 executable/login 均 BLOCKED | NOT_PROVEN | [环境清单](environment-inventory.json) |
| Linux 设计适配 | 未收集；假设：同一 Provider 端口应可在 Linux 实现 | Ubuntu CI 通过公共契约和 Fake；没有真实候选安装或会话 | NOT_PROVEN | [Foundation 门禁](foundation-local-gate.md) |
| Worktree | 未收集；假设：候选应提供公开、稳定的 workspace/worktree contract | 只有临时 Git fixture 与 Fake Workspace/Lease 契约得到验证 | NOT_PROVEN | [环境清单](environment-inventory.json) |
| Terminal/进程 | 未收集；假设：候选应提供受支持的 ProcessHost/terminal contract | 没有真实 PTY、进程树、terminal loss 或 cancel receipt | NOT_PROVEN | [环境清单](environment-inventory.json) |
| 结构化状态 | 未收集；假设：Connector 应提供受支持的结构化/headless transport | 无固定 executable/version/transport/login，不能生成 capability receipt | NOT_PROVEN | [环境清单](environment-inventory.json) |
| Restart/reconcile | 未收集；假设：候选应提供可恢复 native identity | Foundation 对 Fake active/missing/process-exit 的重启对账通过；真实 native session 未创建 | NOT_PROVEN | [Foundation 门禁](foundation-local-gate.md) |
| Mobile | 未收集；假设：任何移动控制路径都必须经过受支持接口与 Hunter 授权 | 未安装候选 Runtime，未执行真实移动配对或 Runtime 控制 | NOT_PROVEN | [环境清单](environment-inventory.json) |
| Security | 未收集；假设：候选默认权限、凭据、遥测和进程边界必须可审计 | Hunter 脱敏、SecretRef、Policy/Lease 与无 bypass 扫描通过；候选默认值未审计 | NOT_PROVEN | [Foundation 门禁](foundation-local-gate.md) |
| API stability | 未收集；假设：固定版本必须提供可哈希 help/schema 与稳定错误契约 | 候选没有可记录版本或 help hash | NOT_PROVEN | [环境清单](environment-inventory.json) |
| Upstream maintenance | 未收集；假设：固定候选版本必须完成来源、许可证、SBOM、遥测和升级审计 | 没有针对固定候选版本的本机来源/SBOM/升级验证 | NOT_PROVEN | [Runtime 设计](../06-runtime-provider-and-connectors.md) |
| Fork burden | 未收集；假设：只有 sidecar 已通过且存在不可绕过缺口时才评估薄 Fork | Sidecar 尚未证明，无法量化合法最小 Fork；本轮明确不 Fork | NOT_PROVEN | [ADR-0005](../adr/0005-orca-runtime-integration.md) |
| Provider replaceability | 未收集；假设：真实候选应通过与 Fake 相同的公共 contract suite | provider-neutral contracts、Fake contract suite、Windows/Ubuntu CI 与中立性扫描通过；没有真实 Provider swap | NOT_PROVEN | [Foundation 门禁](foundation-local-gate.md) |

## 工具与采用状态

| 候选 | Doctor 状态 | 采用状态 | Capability 等级 |
| --- | --- | --- | --- |
| Orca Runtime | BLOCKED | NOT_PROVEN | 未计算 |
| Agent Orchestrator fallback | BLOCKED | NOT_PROVEN | 未计算 |
| Codex Connector | BLOCKED | NOT_PROVEN | 未计算 |
| CodeBuddy Connector | BLOCKED | NOT_PROVEN | 未计算 |
| Cursor Connector | BLOCKED | NOT_PROVEN | 未计算 |

没有任何等级按产品名称硬编码。只有未来版本化、脱敏的原子能力收据才能生成 `CapabilityManifest` 并计算 Connector capability level。

## 下一次有界 Spike

名称：`P0-RUNTIME-01 Windows candidate enablement and atomic receipt`

- 触发条件：用户明确授权并自行完成至少一个候选 Runtime/Connector 的安装和登录；Hunter 不接收、读取或记录凭据。
- 时间盒：最多 1 个工作日；其中任何单一候选最多 4 小时。超过时间盒仍缺少 executable、登录或稳定公共接口时，保持 NOT_PROVEN。
- 测量顺序：先按已批准设计测量 Orca 的公开 sidecar 接口；若不可用或失败，再对 Agent Orchestrator 或最小 Direct Runtime 做同一契约的 fallback spike。该顺序不是生产采用选择。
- 固定输入：Windows 版本、候选精确版本、公开命令/协议、登录可用性和 help/schema hash。
- 必测原子能力：discover、workspace create/find、process/terminal launch、observe、interrupt、restart/reconcile，以及 workspace/session identity 绑定。
- 安全条件：所有写操作只在自动创建的临时 Git fixture；禁止 shell 拼接、权限绕过、自动批准、真实远端写入和凭据输出。
- 退出结果：每个原子能力只能是 PASS、FAIL 或 NOT_PROVEN；只有完整收据集通过后才能另行提出 primary/fallback ADR 变更。

## 发布与开发约束

- 仅 Foundation 维护和 Fake contract 验证可以继续。
- Phase 0 Gate A、First Vertical Slice、真实 Provider/Connector 集成、能力宣传、打包和发布继续阻断。
- Fake Runtime 证据始终标记 `contract_only`。
- Provider return、process exit、terminal idle、window opened 或 session missing 永远不能完成 Step。
- 未经新证据，不新增 Provider 私有领域字段，不选择或 Fork Orca，不把 fallback 视为已采用。

## 证据自审

- 本决策没有真实 Provider PASS；Hunter contract-only 结果明确与采用判定分离。
- Doctor envelope 已应用 schema v1 脱敏；扫描未发现 token、cookie、API key、完整环境变量、私有 Prompt 或绝对用户隐私路径。
- 本轮没有执行真实 Provider 写操作，因此没有 Provider fixture 清理收据；Foundation 中会写仓库的测试只使用自动创建的临时 Git fixture。
- 没有安装、登录、付费、权限扩大、远端 Provider 写入或权限绕过命令。
