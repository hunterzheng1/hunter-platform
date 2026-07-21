# Hunter Platform Phase 0 and Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the replaceable native-agent runtime on Windows, then deliver one recoverable Requirement → Change → Task → Workflow Run vertical slice with Codex, CodeBuddy Code, and Cursor.

**Architecture:** Hunter is a local-first modular monolith consisting of a React workbench, a Node.js daemon, a deterministic FlowEngine, SQLite-backed event and projection stores, readable versioned content files, and runtime adapters behind stable module interfaces. Orca is validated first as the workspace/process provider; Hunter retains all canonical project, workflow, evidence, archive, and knowledge state.

**Tech Stack:** Node.js 24 LTS, TypeScript, npm workspaces, React, Electron, SQLite, Zod, Vitest, Playwright, PowerShell 7 on Windows, and Git worktrees.

---

## Plan set

This product spans independent subsystems. Use the following gate order rather
than treating the entire platform as one change:

1. [Phase 0 runtime validation](2026-07-21-phase-0-runtime-validation.md)
2. [Platform foundation](2026-07-21-platform-foundation.md)
3. [First vertical slice](2026-07-21-first-vertical-slice.md)

Each plan must leave the repository in a working and testable state. Once the
shared runtime contracts are frozen, Phase 0 Provider spikes and
provider-neutral Foundation tasks may overlap; Foundation stays on Fake
contracts until a real Provider passes Gate A. A later plan may depend on a
prior plan's published Interface, but it may not reach into that module's
implementation.

## Planned repository shape

```text
hunter-platform/
├─ apps/
│  ├─ daemon/                 # Local command/event interface and process owner
│  ├─ desktop/                # Electron shell for Windows and Linux
│  └─ web/                    # React workbench and responsive mobile cockpit
├─ packages/
│  ├─ domain/                 # Project, Requirement, Change, Task, Workflow types
│  ├─ flow-engine/            # Commands, reducer, routing, loop, and recovery
│  ├─ storage/                # SQLite event/projection stores and content store
│  ├─ knowledge/              # Archive ingestion and trusted context resolution
│  ├─ runtime-contracts/      # Provider and Connector Interfaces
│  ├─ runtime-manager/        # Capability routing, leases, and reconciliation
│  ├─ provider-orca/          # Orca CLI/API adapter
│  ├─ connector-codex/        # Structured Codex adapter
│  ├─ connector-codebuddy/    # CodeBuddy ACP/headless adapter
│  ├─ connector-cursor/       # Cursor handoff and observation adapter
│  ├─ policy/                 # Permission, approval, and budget decisions
│  └─ testkit/                # Fakes, fixtures, and contract suites
├─ workflow-packs/
│  └─ hunter-default/         # Versioned default development workflow
├─ spikes/                    # Disposable Phase 0 probes; not product runtime
├─ docs/
│  ├─ validation/             # Reproducible Phase 0 evidence
│  └─ plans/                  # Executable implementation plans
└─ e2e/                       # Full vertical-slice scenarios
```

## Cross-plan gates

### Gate A — Runtime evidence

Phase 0 must answer all of the following with reproducible local evidence:

- Orca can create and recover a Windows worktree and terminal through a public,
  scriptable interface.
- Hunter can observe terminal loss without reporting false success.
- CodeBuddy Code can create, steer, cancel, and resume a session through ACP or
  an officially supported headless interface.
- Codex exposes a supported structured or headless integration suitable for a
  managed step.
- Cursor can reliably open the exact workspace, and any deeper capability is
  recorded separately rather than inferred.
- No required path depends on permission-bypass defaults.

If Orca fails or remains `NOT PROVEN` at the timebox, perform the recorded Agent
Orchestrator or direct-runtime fallback spike. Foundation work may continue with
Fake contracts, but Gate C cannot claim a real Provider until one passes. Do not
modify the product domain to accommodate any provider.

### Gate B — Foundation correctness

The foundation is accepted only when:

- every state transition is exercised through `FlowEngine` commands;
- SQLite can rebuild all query projections from the append-only event log;
- duplicate commands are idempotent;
- a stopped daemon can reconcile fake active, missing, and completed sessions;
- module contract tests pass on Windows and Linux CI;
- no UI or adapter writes storage tables directly.

### Gate C — Vertical-slice value

The first product slice is accepted only when one real project can:

1. approve immutable requirement revisions;
2. create a change linked to one or more revisions;
3. approve a serial/parallel task graph;
4. run the default plan → implement → test → review → archive workflow;
5. mix Codex, CodeBuddy Code, and Cursor according to their capability levels;
6. preserve every failed attempt during a bounded loop;
7. recover after application restart;
8. index the archive and retrieve only active trusted knowledge by default;
9. expose status, approval, pause, and resume from a narrow mobile viewport.

## Execution order

### Task 1: Complete the Phase 0 provider decision

**Files:**
- Follow: `docs/plans/2026-07-21-phase-0-runtime-validation.md`
- Produce: `docs/validation/phase-0-decision.md`
- Modify: `docs/adr/0005-orca-runtime-integration.md`

- [ ] **Step 1: Execute every Phase 0 task on Windows**

Run each command from the detailed plan and attach raw output under
`docs/validation/evidence/`. Expected: every executed command has a timestamp,
tool version, exit code, and redacted output.

- [ ] **Step 2: Review the evidence against Gate A**

Expected: each criterion is marked `PASS`, `FAIL`, or `NOT PROVEN`; no criterion
is marked passed from upstream documentation alone.

- [ ] **Step 3: Freeze the provider decision**

Record sidecar, thin fork, Agent Orchestrator fallback, direct implementation,
or `no production provider proven` in ADR 0005. Expected: an adopted primary and
fallback are named only when evidence passes; otherwise the ADR freezes the next
bounded spike while Foundation remains on Fake contracts.

- [ ] **Step 4: Commit the evidence and decision**

```powershell
git add docs/validation docs/adr/0005-orca-runtime-integration.md spikes
git commit -m "验证：冻结 Phase 0 Runtime Provider 决策"
```

Expected: a commit containing only the spike, evidence, and decision.

### Task 2: Build and verify the platform foundation

**Files:**
- Follow: `docs/plans/2026-07-21-platform-foundation.md`
- Create: `apps/daemon/`
- Create: `packages/domain/`
- Create: `packages/flow-engine/`
- Create: `packages/storage/`
- Create: `packages/runtime-contracts/`
- Create: `packages/runtime-manager/`
- Create: `packages/policy/`
- Create: `packages/testkit/`

- [ ] **Step 1: Execute the foundation plan test-first**

Expected: each task creates a failing test, a minimal implementation, passing
tests, and a focused commit.

- [ ] **Step 2: Run the complete foundation gate**

```powershell
npm ci
npm run lint
npm run typecheck
npm test
```

Expected: all commands exit `0` on Windows; Linux CI reports the same result.

- [ ] **Step 3: Rebuild projections from an empty projection database**

```powershell
npm run verify:rebuild
```

Expected: rebuilt Project, Requirement, Change, Task, Run, and Step views match
the checked fixture snapshot byte-for-byte.

- [ ] **Step 4: Commit the working foundation**

```powershell
git add apps/daemon packages package.json package-lock.json tsconfig*.json vitest.config.ts
git commit -m "实现：建立 Hunter Platform 可恢复执行基础"
```

### Task 3: Deliver the first end-to-end product slice

**Files:**
- Follow: `docs/plans/2026-07-21-first-vertical-slice.md`
- Create: `apps/web/`
- Create: `apps/desktop/`
- Create: `packages/knowledge/`
- Create: `packages/provider-orca/`
- Create: `packages/connector-codex/`
- Create: `packages/connector-codebuddy/`
- Create: `packages/connector-cursor/`
- Create: `workflow-packs/hunter-default/`
- Create: `e2e/`

- [ ] **Step 1: Execute the vertical-slice plan test-first**

Expected: each user-visible capability is first proven against fake connectors,
then against the approved real provider where credentials are available.

- [ ] **Step 2: Run the full local gate**

```powershell
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
```

Expected: every command exits `0`; the Electron package is produced for Windows.

- [ ] **Step 3: Execute the owner acceptance story**

Use `docs/08-user-stories-and-acceptance.md` scenario `E2E-001`. Expected: the
Run reaches `archived`, retains at least one failed Attempt, and creates active
knowledge with links back to the requirement revision and evidence.

- [ ] **Step 4: Commit the vertical slice**

```powershell
git add apps packages workflow-packs e2e package.json package-lock.json
git commit -m "实现：贯通 Hunter 多 Agent 工作流纵向切片"
```

### Task 4: Perform release-readiness review

**Files:**
- Read: `docs/10-risk-register.md`
- Read: `docs/reviews/fable5-review-guide.md`
- Create: `docs/reviews/<date>-vertical-slice-review.md`
- Create: `docs/validation/release-readiness.md`

- [ ] **Step 1: Run an independent standards and design review**

Expected: findings include severity, evidence, affected Interface, and proposed
disposition; praise-only review is rejected.

- [ ] **Step 2: Re-run all gates after accepted fixes**

```powershell
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
```

Expected: every command exits `0` from a clean checkout.

- [ ] **Step 3: Record known limitations honestly**

Expected: release readiness names every L0/L1 connector limitation, every manual
Gate, unsupported Linux feature, and unverified mobile network topology.

- [ ] **Step 4: Commit the review evidence**

```powershell
git add docs/reviews docs/validation
git commit -m "文档：记录 Hunter 首个纵向版本验收证据"
```

## Self-review checklist

- [ ] Every approved decision in `docs/11-decision-summary.md` maps to a plan task
  or an explicit non-goal.
- [ ] Every later plan uses the exact canonical terms defined by `CONTEXT-MAP.md`.
- [ ] No task treats agent completion as verified step success.
- [ ] No task depends on Goose Gate, Goose pinning, or the former pilot.
- [ ] No adapter-specific field leaks into Project, Requirement, Change, Task,
  WorkflowRun, StepRun, Artifact, Evidence, Archive, or KnowledgeEntry.
- [ ] Every external mutation is idempotent or requires a recorded recovery path.
- [ ] All paths and commands are valid on PowerShell; Linux alternatives belong in
  the relevant detailed plan rather than being assumed.
