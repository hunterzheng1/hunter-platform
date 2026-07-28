# Implementation plans

## Archived — no active implementation plan

The owner accepted ADR-0008 after both bounded Provider experiments reached
their planned Task 1 Stop. Hunter has no active implementation plan. No older
plan, Pi fallback, Provider probe, product feature, or release may resume
without an explicit owner reactivation decision and a new ADR.

## Historical plans

These files preserve implemented contract history, review traceability, and
unmet gates. Their evidence remains valid, but every delivery direction is
superseded by ADR-0008:

1. [Herdr replacement control-plane gate](2026-07-28-herdr-control-plane-replacement.md) — stopped at Task 1; Tasks 2–8 `NOT_RUN`
2. [Stopped Orca-first gate](2026-07-28-orca-control-plane-pivot.md) — stopped at Task 1; Tasks 2–8 `NOT_RUN`
3. [Phase 0 runtime validation](2026-07-21-phase-0-runtime-validation.md)
4. [Platform foundation](2026-07-21-platform-foundation.md)
5. [First vertical slice](2026-07-21-first-vertical-slice.md)
6. [Phase 1 product hardening](2026-07-24-phase-1-product-hardening.md)
7. [Original orchestration plan](2026-07-21-hunter-platform-phase-0-and-vertical-slice.md)

Phase 0 Outcome 5, Gate R `NOT_PROVEN`, and the Orca Task 1 `BLOCKED` result are
not changed by the replacement route. Fake-only results remain
`CONTRACT_ONLY`; signing, distribution, production release, custom mobile,
deep direct Connectors, Pi, and additional Providers remain outside the active
repository state.
