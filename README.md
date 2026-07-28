# Hunter Platform

> [!IMPORTANT]
> Hunter Platform is archived. Active product development stopped on
> 2026-07-28 after the bounded Orca and Herdr public-interface gates both
> reached their planned Task 1 Stop. This repository preserves source,
> contracts, tests, and evidence; it is not a supported daily-use product or
> production release. See [ADR-0008](docs/adr/0008-archive-hunter-platform.md).

Hunter was designed as a local-first, Windows-first governance control plane
around native coding agents. It owns versioned requirements, runs,
verification, evidence, policy, and recovery state without making a preferred
Provider authoritative.

The product does not replace Codex, CodeBuddy, Cursor, Claude Code, OpenCode,
Pi, Goose, or future tools. It owns the continuity around them: projects,
requirements, changes, task graphs, workflow runs, evidence, archives, and
long-term knowledge.

## Current status

- Product direction: archived by owner decision on 2026-07-28.
- Repository state: provider-neutral control-plane foundations and deterministic
  Fake contracts are preserved as historical evidence.
- Runtime status: no production Provider was proven. Orca and Herdr stopped at
  their exact-worktree public-interface hard gates; their Tasks 2–8 are
  `NOT_RUN`.
- Active work: none. Pi is not an automatically active fallback.
- Remote state: GitHub is made read-only only after the final archival PR,
  actual Windows/Ubuntu CI, merge, and branch cleanup complete.

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
7. [Archive decision](docs/adr/0008-archive-hunter-platform.md)
8. [Terminal Herdr Task 1 evidence](docs/validation/herdr-public-adapter-gate.md)

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

This repository is the archived Hunter control-plane monorepo. Existing
desktop, mobile, direct-Connector, terminal, browser, and Provider experiments
are retained without active maintenance. Reactivation requires an explicit
owner decision and the gate in ADR-0008. No production Provider, product
release, or mobile product is claimed by this repository state.
