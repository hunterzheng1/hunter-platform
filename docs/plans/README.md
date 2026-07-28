# Implementation plans

## Stopped plan — product decision pending

[Herdr replacement control-plane gate](2026-07-28-herdr-control-plane-replacement.md)
stopped at Task 1 after three evidence-bearing attempts reached the exact
existing-worktree hard gate. Tasks 2–8 are `NOT_RUN`; the closeout is recorded
in [Herdr public Adapter Task 1 closeout](../validation/herdr-public-adapter-gate.md).
No older plan, Pi fallback, or later Herdr task may be resumed automatically.

## Historical plans

These files preserve implemented contract history, review traceability, and
unmet gates. Their evidence remains valid, but their former breadth and order
are superseded by ADR-0007:

1. [Stopped Orca-first gate](2026-07-28-orca-control-plane-pivot.md)
2. [Phase 0 runtime validation](2026-07-21-phase-0-runtime-validation.md)
3. [Platform foundation](2026-07-21-platform-foundation.md)
4. [First vertical slice](2026-07-21-first-vertical-slice.md)
5. [Phase 1 product hardening](2026-07-24-phase-1-product-hardening.md)
6. [Original orchestration plan](2026-07-21-hunter-platform-phase-0-and-vertical-slice.md)

Phase 0 Outcome 5, Gate R `NOT_PROVEN`, and the Orca Task 1 `BLOCKED` result are
not changed by the replacement route. Fake-only results remain
`CONTRACT_ONLY`; signing, distribution, production release, custom mobile,
deep direct Connectors, Pi, and additional Providers remain outside the active
plan.
