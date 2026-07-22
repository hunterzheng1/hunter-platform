# ADR-0005: 尚无生产 Runtime Provider 得到证明

- Status: Accepted
- Date: 2026-07-22
- Decision outcome: Phase 0 Outcome 5

## Context

Hunter 需要一个可替换的 Runtime Provider 来管理 workspace、worktree、process/terminal 和 native session，并通过分级 Connector 使用 Codex、CodeBuddy Code 与 Cursor。Orca 是首个候选，但 ADR-0001、ADR-0002 和 ADR-0004 要求 Hunter 保持控制面身份、拥有权威状态，并仅从版本化原子能力收据计算能力等级。

Phase 0 Doctor 在 Windows 上检测到 host、Node.js 与 Git，但 Orca、Agent Orchestrator、Codex、CodeBuddy 和 Cursor 的 executable 或安全登录条件均不可用。没有产生真实 workspace、terminal、session、restart、cancel 或 structured-event receipt。Foundation 的 Fake Runtime 与 Windows/Ubuntu CI 已通过，但证明范围明确是 `contract_only`。

## Options considered

1. 通过公开 CLI/API 采用 Orca sidecar。
2. 采用薄 Orca Fork，同时保持 Hunter Core 独立。
3. 采用 Agent Orchestrator Provider。
4. 实现最小 Direct Hunter Runtime。
5. 暂不采用生产 Provider，Foundation 和自动验收继续使用 Fake contracts。

Options 1–4 都缺少本机固定版本与原子能力证据。Option 2 还未满足“sidecar 已证明、存在不可绕过的产品阻断、Fork 成本可量化”等前置条件。

## Decision

选择 Option 5：**no production provider proven yet**。

- 不指定 primary 或 fallback Provider。
- 不采用 Orca sidecar，不创建或计划薄 Fork。
- Orca 仍只是下一次有界测量的首个候选，不是产品依赖。
- Agent Orchestrator 和 Direct Runtime 只是相同契约下的 fallback spike 选项，不是已采用方案。
- Codex、CodeBuddy 和 Cursor 不获得推定的 L0–L3；等级只能由未来版本化的原子能力收据生成 `CapabilityManifest` 后计算。
- 仅 Foundation 维护和 Fake contract 验证可以继续；Phase 0 Gate A、First Vertical Slice 与真实 Provider 发布保持阻断。

完整矩阵和 Gate A 判定见 [`phase-0-decision.md`](../validation/phase-0-decision.md)。

## Scope and version

- Host evidence: Windows `10.0.26200`
- Node.js: `v24.14.0`
- Git: `2.50.1.windows.1`
- Candidate versions: unavailable; adoption status `NOT_PROVEN`
- Fake proof scope: `contract_only`

本 ADR 不批准安装、登录、产生费用、读取凭据、远端写入、真实 Provider 实现或产品发布。

## Consequences

### Positive

- 不会把上游宣传、缺失 executable 或 Fake 结果伪装成真实 Provider 通过。
- Hunter 领域、Flow、Storage 和 API 继续保持 provider-neutral。
- 避免在 sidecar 证据出现前承担 Orca Fork 和上游同步成本。
- Foundation 可以继续保持可验证基线，同时真实 Provider 风险仍被显式阻断。

### Negative

- 当前不能运行、恢复或控制真实 Agent session。
- Connector capability level、兼容矩阵和真实 Windows PTY 行为仍未知。
- 任何真实 Provider 的演示、发布或产品承诺都必须等待下一轮证据。

## Residual risks and compensating controls

- Risk IDs: R-01、R-02、R-04、R-05、R-16、R-17、R-27。
- Evidence: [`environment-inventory.json`](../validation/environment-inventory.json)、[`foundation-local-gate.md`](../validation/foundation-local-gate.md) 与 [`phase-0-decision.md`](../validation/phase-0-decision.md)。
- Fallback evidence: [`agent-orchestrator-fallback.md`](../validation/agent-orchestrator-fallback.md)；typed scenario 因 executable 不可用而保持 NOT_PROVEN。
- Residual risk: Provider API、Windows 生命周期、安全默认值、条款和维护成本均未证明。
- Controls: Fake contract suite、provider-neutral schemas、durable outbox/receipts、Policy/Lease、fail-closed capability negotiation、独立 verifier，以及真实 Provider release block。
- Monitoring signal: Provider 私有字段进入公共类型、未附 receipt 的 L2/L3、真实测试被 Fake 结果替代、权限绕过参数或未经授权的安装/login。
- Revisit trigger: 用户明确授权并完成候选安装/login，或任何变更需要声明真实 Provider 能力。
- Revisit deadline: 2026-08-05 或 First Vertical Slice 真实 Provider 验收开始前，以较早者为准。
- Owner: Runtime / Phase 0。
- Rollback/block trigger: 任一真实 Provider 变更缺少固定版本、脱敏原子收据、临时 fixture 清理证据或权限/条款审计时，拒绝合入或发布。

## Next bounded spike

执行 `P0-RUNTIME-01 Windows candidate enablement and atomic receipt`：最多 1 个工作日、每个候选最多 4 小时。它只测量公开接口和相同 Hunter contract，不修改领域模型；详细范围见 Phase 0 决策文件。
