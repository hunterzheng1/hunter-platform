# Implementation plans

## Active plan

[Orca-first control-plane pivot](2026-07-28-orca-control-plane-pivot.md) is the
only active implementation plan. It is a five-working-day Go/Stop gate for one
real Orca-hosted vertical slice. No older plan may be resumed automatically.

## Historical plans

These files preserve implemented contract history, review traceability, and
unmet gates. Their evidence remains valid, but their former breadth and order
are superseded by ADR-0006:

1. [Phase 0 runtime validation](2026-07-21-phase-0-runtime-validation.md)
2. [Platform foundation](2026-07-21-platform-foundation.md)
3. [First vertical slice](2026-07-21-first-vertical-slice.md)
4. [Phase 1 product hardening](2026-07-24-phase-1-product-hardening.md)
5. [Original orchestration plan](2026-07-21-hunter-platform-phase-0-and-vertical-slice.md)

Phase 0 Outcome 5 and Gate R `NOT_PROVEN` are not changed by the new preferred
Orca route. Fake-only results remain `CONTRACT_ONLY`; signing, distribution,
production release, custom mobile, deep direct Connectors, and additional
Providers remain outside the active plan.
