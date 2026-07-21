# Hunter Platform

Hunter is a local-first, Windows-first development control plane for running
versioned Harness workflows across interchangeable native coding agents.

The product does not replace Codex, CodeBuddy, Cursor, Claude Code, OpenCode,
Pi, Goose, or future tools. It owns the continuity around them: projects,
requirements, changes, task graphs, workflow runs, evidence, archives, and
long-term knowledge.

## Current status

- Product direction: approved by the owner on 2026-07-21.
- Repository state: documentation-first platform reset.
- Review state: independent internal findings and their dispositions are recorded; the corrected baseline is ready for Fable5 review.
- Implementation: not started; provider-dependent delivery waits for Phase 0 evidence, while provider-neutral Foundation work may proceed against Fake contracts.

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
7. [Implementation plan](docs/plans/2026-07-21-hunter-platform-phase-0-and-vertical-slice.md)
8. [Fable5 review guide](docs/reviews/fable5-review-guide.md)

## Product modules

- **Hunter Workbench** — desktop and responsive web control surface.
- **Hunter Flow** — deterministic workflow, loop, gate, and recovery engine.
- **Hunter Runtime (`hunterd`)** — local process, workspace, and connector host.
- **Hunter Harness** — versioned workflow and Skill packs, maintained separately.

The user receives one Hunter product even though these names describe distinct
internal modules.

## Repository intent

This repository is the main Hunter product monorepo. The first implementation
will add desktop, web, daemon, domain, flow, knowledge, storage, provider, and
connector packages only after the Phase 0 technical decisions are evidenced.
