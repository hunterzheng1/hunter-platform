# Architecture decision records

ADRs record hard-to-reverse choices and their consequences. They do not replace
the product model or implementation plans.

Current decisions:

- [0001 — Hunter is a control plane](0001-hunter-is-a-control-plane.md)
- [0002 — Hunter owns canonical state](0002-hunter-owns-canonical-state.md)
- [0003 — Local-first modular monolith](0003-local-first-modular-monolith.md)
- [0004 — Tiered native-agent connectors](0004-tiered-native-agent-connectors.md)

The Phase 0 runtime evidence will produce ADR 0005. It must record the measured
decision (Orca sidecar, a fallback provider, a thin fork, or rejection) rather
than assuming Orca adoption in advance.
