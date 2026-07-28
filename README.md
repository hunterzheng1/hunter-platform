# Hunter Platform

Hunter is a local-first, Windows-first governance control plane around native
coding agents. Orca is the preferred first external workbench/runtime host;
Hunter owns versioned requirements, runs, verification, evidence, policy, and
recovery state.

The product does not replace Codex, CodeBuddy, Cursor, Claude Code, OpenCode,
Pi, Goose, or future tools. It owns the continuity around them: projects,
requirements, changes, task graphs, workflow runs, evidence, archives, and
long-term knowledge.

## Current status

- Product direction: narrowed by the owner on 2026-07-28 to an Orca-first,
  sidecar/Adapter delivery path.
- Repository state: provider-neutral control-plane foundations and deterministic
  Fake contracts exist; historical validation remains evidence-scoped.
- Runtime status: Orca is the preferred bounded integration route, not a proven
  production Provider. Existing Phase 0 and Gate R `NOT_PROVEN` results remain
  authoritative until replaced by new local receipts.
- Active work: a five-working-day real vertical slice. If it cannot add
  measurable value over direct Orca use, Hunter expansion stops.

The former Goose-centered Hunter Runtime design is intentionally superseded.
The owner requested a clean remote history, so this repository starts from a
new root commit. A separate local `Hunter-Runtime` checkout is retained only as
a recovery source; Goose Gate, version pinning, and the three-arm pilot are not
part of the new product baseline.

## Start here

1. [Documentation map](docs/README.md)
2. [Product vision](docs/01-product-vision.md)
3. [System architecture](docs/02-system-architecture.md)
4. [Domain model](docs/03-domain-model-and-state-machines.md)
5. [Workflow semantics](docs/04-workflow-and-loop-semantics.md)
6. [Migration and roadmap](docs/09-migration-and-roadmap.md)
7. [Current implementation plan](docs/plans/2026-07-28-orca-control-plane-pivot.md)
8. [Orca-first architecture decision](docs/adr/0006-orca-first-control-plane-delivery.md)

## Product modules

- **Hunter Workbench** — a narrow local Web control surface, opened from Orca
  or a browser, for requirements, attention, runs, verification, and evidence.
- **Hunter Flow** — deterministic workflow, loop, gate, and recovery engine.
- **Hunter Runtime (`hunterd`)** — local canonical state, policy, receipts, and
  provider-neutral orchestration behind a thin Orca Adapter.
- **Hunter Harness** — versioned workflow and Skill packs, maintained separately.

Orca supplies the daily desktop/worktree/terminal/browser experience. Hunter
does not duplicate those surfaces and never treats Orca idle/exit as success.

## Repository intent

This repository is the main Hunter control-plane monorepo. Existing desktop,
mobile, direct-Connector, terminal, browser, and second-Provider expansion is
frozen while the Orca sidecar vertical slice is evaluated. No production
Provider, product release, or mobile product is claimed by this repository
state.
