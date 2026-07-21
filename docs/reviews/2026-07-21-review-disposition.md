# 2026-07-21 review disposition

This file is the canonical disposition ledger for the internal reviews made
during the Hunter Platform reset. An earlier review remains immutable evidence
of what was wrong at that snapshot; a later recheck records whether the
correction is sufficient.

Status meanings:

- `accepted / closed` — the finding was technically valid and now has a named
  contract, RED test, implementation task, GREEN command, and completion
  evidence in the current plan.
- `needs_phase0` — the design is closed, but an upstream product capability
  cannot honestly be called verified until a fixed-version local probe passes.
- `rejected` — the finding was not valid for this product; none were rejected
  in this review cycle.

## Internal design review

| Finding | Disposition | Current resolution |
|---|---|---|
| C-01 durable side effects | accepted / closed | Foundation Tasks 4, 9, and 10 define the transactional command fingerprint, Event + Outbox intent, durable side-effect receipt, four crash points, indeterminate state, and startup reconciliation. |
| C-02 executable Flow | accepted / closed | Foundation Tasks 3 and 7 freeze strict WorkflowStep/Route/Loop schemas, executor/Profile/Policy/backoff selectors, RunBudget, dual states, Task fan-out/fan-in, bounded reactivation, recovery, and property/state tests. |
| C-03 frozen StartRun | accepted / closed | Foundation Task 7 makes root/task/subflow a discriminated binding, derives root state from published/approved server-side sources, validates parent/Task ancestry, and routes every transition through FlowEngine. |
| C-04 API/mobile boundary | accepted / closed | Foundation Tasks 8, 11, and 12 secure local scope/path/API/SSE and prohibit remote routes; Vertical Tasks 14, 16, and 17 add canonical HTTP boundaries, narrow Electron IPC, persistent device identity, TLS, revocation, and replay-safe commands. |
| I-01 complete Change/Task model | accepted / closed | Foundation Tasks 2 and 6 preserve canonical fields, fingerprints, immutability, approval, Project/Repository scope, and cross-reference validation. |
| I-02 honest connectors | needs_phase0 | Vertical Task 15 computes L0–L3 only from versioned atomic probe receipts and fails closed on drift. The actual Codex/CodeBuddy/Cursor/Orca level and CodeBuddy transport remain Phase 0 evidence, not a documentation claim. |
| I-03 leases | accepted / closed | Foundation Task 8 and Vertical Task 14 define durable Workspace/Writer/Controller leases, owner/generation/expiry, worktree isolation, Git baseline checks, and recovery tests. |
| I-04 durable SSE | accepted / closed | Foundation Tasks 5 and 12 use Event Ledger positions, authenticated Project filters, `Last-Event-ID`, gap-free replay/live handoff, and explicit resync. |
| I-05 Archive to Knowledge | accepted / closed | Vertical Task 18 schedules a persistent terminal-Run archive job, verifies a versioned scoped manifest, resumes every crash boundary, and rebuilds Project knowledge deterministically. |
| I-06 Phase 0 dead end | accepted / closed | The Phase 0 and orchestration plans convert time-boxed `BLOCKED` to `NOT_PROVEN`, trigger fallback comparison, and allow provider-neutral Foundation work to continue against Fake contracts. |
| I-07 missing composition | accepted / closed | Vertical Task 13A creates a valid authenticated owner-story RED scaffold, Task 19 wires the production-equivalent chain and upgrades `start:e2e`, and Task 13B runs final CI/real-provider acceptance. |
| I-08 superseded research | accepted / closed | The research index and old route-specific investigations now mark their recommendations superseded and route execution decisions to the current synthesis, ADRs, and plans. |

Primary evidence:

- [Original internal design review](2026-07-21-internal-design-review.md)
- [Foundation final recheck 2](2026-07-21-foundation-plan-final-recheck-2.md)
- [Vertical final recheck 4](2026-07-21-vertical-plan-final-recheck-4.md)
- [Overall final recheck](2026-07-21-internal-design-final-recheck.md)

## Foundation review crosswalk

| Original Foundation finding | Disposition |
|---|---|
| 1. no durable Outbox/receipt | accepted / closed by C-01 resolution |
| 2. no startup recovery | accepted / closed by Foundation Task 10 |
| 3. array-order loop validation | accepted / closed by Foundation Task 3 graph validation/property tests |
| 4. invalid root/task/subflow shape | accepted / closed by C-03 resolution |
| 5. loopback treated as identity | accepted / closed by Foundation Task 11 and Vertical Tasks 16–17 |
| 6. volatile SSE | accepted / closed by I-04 resolution |

Review trail:

- [Original Foundation review](2026-07-21-foundation-plan-review.md)
- [First Foundation recheck](2026-07-21-foundation-plan-recheck.md)
- [Foundation final recheck](2026-07-21-foundation-plan-final-recheck.md)
- [Foundation final recheck 2 — Ready](2026-07-21-foundation-plan-final-recheck-2.md)

## Vertical security review crosswalk

| Original Vertical finding | Disposition |
|---|---|
| 1. path and ID canonicalization | accepted / closed by Task 14, including authenticated domain-route tests |
| 2. adapter-local idempotency | accepted / closed by Tasks 14–15 consuming the Foundation journal/receipts |
| 3. hard-coded capability levels | accepted / needs_phase0 through Task 15 probe receipts |
| 4. Electron/browser boundary | accepted / closed by Task 16 and the separate TLS device listener in Task 17 |
| 5. non-revocable device token | accepted / closed by Task 17 persistent challenge/device/refresh family and non-exportable private-key proof |
| 6. UI-only mobile commands | accepted / closed by Task 17's transactional versioned idempotent command envelope |

Review trail:

- [Original Vertical security review](2026-07-21-vertical-security-review.md)
- [First Vertical recheck](2026-07-21-vertical-plan-recheck.md)
- [Vertical final recheck](2026-07-21-vertical-plan-final-recheck.md)
- [Vertical final recheck 2](2026-07-21-vertical-plan-final-recheck-2.md)
- [Vertical final recheck 3](2026-07-21-vertical-plan-final-recheck-3.md)
- [Vertical final recheck 4 — Ready](2026-07-21-vertical-plan-final-recheck-4.md)

## Research source audit

The audit's product-shaping corrections were accepted: Orca is a time-boxed,
reversible candidate rather than a proven base; Agent Orchestrator is described
from its current Electron/Go architecture and license; Cursor's native Windows
CLI and public-beta SDK are compared without calling either a verified Hunter
integration; unstable MCP Tasks are not treated as a stable dependency.

Upstream feature and maintenance facts remain dated claims linked to primary
sources. Local operability, login, protocol behavior, error handling, recovery,
and exact capability levels remain `needs_phase0` until reproducible evidence
is written under `docs/validation/`.

See [research source audit](2026-07-21-research-source-audit.md) and the
[current research synthesis](../research/2026-07-21-hunter-platform-landscape-and-reuse.md).

## Release decision

The documentation baseline may proceed to Fable5 review. This is not permission
to label any real Provider or Connector as production-ready: Phase 0 evidence
must still select and pin each real transport before provider-dependent release
acceptance can pass.
