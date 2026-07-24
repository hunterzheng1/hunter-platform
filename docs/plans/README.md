# Implementation plans

Use these plans in gate order:

1. [Phase 0 runtime validation](2026-07-21-phase-0-runtime-validation.md)
2. [Platform foundation](2026-07-21-platform-foundation.md)
3. [First vertical slice](2026-07-21-first-vertical-slice.md)
4. [Phase 1 product hardening](2026-07-24-phase-1-product-hardening.md)

The [orchestration plan](2026-07-21-hunter-platform-phase-0-and-vertical-slice.md)
explains the gates between them. Phase 0 answers integration questions; it does
not silently commit the product to Orca or implement Phase 1 domain features.
After shared contracts are frozen, the external Provider spikes and
provider-neutral Foundation work may run in parallel against Fake contracts.
The first vertical slice cannot claim a real Provider until one passes Phase 0.
The Phase 1 hardening track can reach a `contract_only` candidate using the
deterministic Fake, but Gate A, real-device/project acceptance, signing,
distribution, and production release remain separate blocking gates.

The vertical-slice file preserves its original task numbers for review traceability.
Its normative internal order is Tasks 1–12, Task 13A Steps 1–4 (RED E2E
contract only), the release-blocking correction Tasks 14–19, and finally
Task 13B Steps 5–9 acceptance. The correction-precedence section inside that plan
overrides conflicting early samples.
