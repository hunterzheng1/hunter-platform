# Architecture decision records

ADRs record hard-to-reverse choices and their consequences. They do not replace
the product model or implementation plans.

Current decisions:

- [0001 — Hunter is a control plane](0001-hunter-is-a-control-plane.md)
- [0002 — Hunter owns canonical state](0002-hunter-owns-canonical-state.md)
- [0003 — Local-first modular monolith](0003-local-first-modular-monolith.md)
- [0004 — Tiered native-agent connectors](0004-tiered-native-agent-connectors.md)
- [0005 — No production Runtime Provider proven](0005-orca-runtime-integration.md)

Phase 0 produced Outcome 5: no production Runtime Provider is proven yet.
Foundation and deterministic acceptance remain on Fake contracts while real
Provider adoption and release stay blocked pending local atomic receipts.
