# Architecture decision records

ADRs record hard-to-reverse choices and their consequences. They do not replace
the product model or implementation plans.

Current decisions:

- [0001 — Hunter is a control plane](0001-hunter-is-a-control-plane.md)
- [0002 — Hunter owns canonical state](0002-hunter-owns-canonical-state.md)
- [0003 — Local-first modular monolith](0003-local-first-modular-monolith.md)
- [0004 — Tiered native-agent connectors](0004-tiered-native-agent-connectors.md)
- [0005 — No production Runtime Provider proven](0005-orca-runtime-integration.md) — historical Phase 0 evidence decision
- [0006 — Orca-first control-plane delivery](0006-orca-first-control-plane-delivery.md) — active delivery-host decision

Phase 0 produced Outcome 5: no production Runtime Provider is proven yet.
ADR-0006 does not turn that historical result into PASS. It selects Orca as the
preferred external host for the next bounded experiment while real Provider
adoption and release remain blocked pending local atomic receipts.
