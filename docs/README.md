# Hunter Platform documentation

This documentation set is the canonical design baseline created after the
2026-07-21 product reset and narrowed by the owner-approved 2026-07-28
Orca-first delivery pivot. When an older target-product section conflicts with
ADR-0006 or the 2026-07-28 section of the decision summary, the newer decision
controls. Historical validation is never rewritten by that precedence.

## Product and architecture

| Document | Purpose |
|---|---|
| [01 — Product vision](01-product-vision.md) | Product identity, boundaries, principles, and success definition |
| [02 — System architecture](02-system-architecture.md) | Workbench, Flow, Runtime, providers, storage, and deployment topology |
| [03 — Domain model](03-domain-model-and-state-machines.md) | Canonical objects, relationships, invariants, and lifecycle states |
| [04 — Workflow and loop semantics](04-workflow-and-loop-semantics.md) | Step types, task graphs, handoff, verification, retry, and bounded loops |
| [05 — Client information architecture](05-client-information-architecture.md) | Narrow Hunter control surface inside an external workbench; deferred desktop/mobile surfaces |
| [06 — Runtime providers and connectors](06-runtime-provider-and-connectors.md) | Orca-first public Adapter boundary, replaceability, and tiered capabilities |
| [07 — Storage, security, and remote access](07-storage-security-and-remote-access.md) | Local-first persistence, permissions, recovery, and device access |
| [08 — User stories and acceptance](08-user-stories-and-acceptance.md) | Concrete workflows, edge cases, and verification criteria |
| [09 — Migration and roadmap](09-migration-and-roadmap.md) | Existing-asset disposition and current five-day value gate |
| [10 — Risk register](10-risk-register.md) | Product, integration, security, and maintenance risks |

## Decisions and language

- [Context map](../CONTEXT-MAP.md) routes each bounded context to its glossary.
- [Architecture decisions](adr/README.md) record hard-to-reverse choices and their trade-offs.
- [Decision summary](11-decision-summary.md) is the compact list of owner-approved product decisions.
- [ADR-0006](adr/0006-orca-first-control-plane-delivery.md) is the active delivery-host decision.

## Research, planning, and review

- [Research index](research/README.md) distinguishes current synthesis from supporting and superseded investigations.
- [Implementation plans](plans/README.md) identifies the single active Orca-first plan and preserves older plans as historical baselines.
- [Validation evidence](validation/README.md) separates locally reproduced facts from upstream claims.
- [Review disposition](reviews/2026-07-21-review-disposition.md) maps every internal finding to its current resolution or Phase 0 evidence gate.
- [Review guide](reviews/fable5-review-guide.md) tells Fable5 what to challenge and what evidence is still missing.
- [Legacy reset note](history/2026-07-21-runtime-reset.md) records the clean-history reset and its local recovery boundary.

## Status language

- **Approved product decision** means the owner explicitly confirmed it.
- **Target capability** means the design requires it but no implementation exists yet.
- **Officially documented capability** means an upstream project claims it in a primary source.
- **Verified capability** means Hunter reproduced it in a recorded local test.

Official documentation is not treated as local verification. Phase 0 exists to
turn the most important target capabilities into evidence.
