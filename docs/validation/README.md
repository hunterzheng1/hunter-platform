# Validation evidence

This directory is the destination for reproducible Phase 0 evidence. A claim in
research or upstream documentation is not a verified Hunter capability until a
dated validation record captures:

- the exact product and version;
- operating system and relevant environment inventory;
- redacted commands or protocol requests;
- observed outputs, exit reasons, logs, and artifacts;
- the expected result and the actual result;
- a pass, fail, or needs-attention conclusion;
- cleanup and recovery observations.

Do not commit access tokens, credentials, complete environment dumps, private
repository contents, or raw command lines that expose secrets. Large or
sensitive evidence belongs in the local content-addressed store; the Markdown
record should retain a hash and a safe summary.

Current records:

- [`codex-direct-runtime.md`](codex-direct-runtime.md) — bounded Windows Direct Codex CLI verdict, real JSONL/resume evidence, and explicit unproven interrupt boundary.
- [`evidence/codex/direct-runtime.json`](evidence/codex/direct-runtime.json) — versioned, redacted Direct Codex local receipt envelope.
- [`runtime-reliability.md`](runtime-reliability.md) — bounded path, permission, session-loss, idempotency, and process-tree validation.
- [`evidence/reliability/runtime-reliability.json`](evidence/reliability/runtime-reliability.json) — versioned contract-fixture reliability envelope.
- [`agent-orchestrator-upstream-research.md`](agent-orchestrator-upstream-research.md) — dated first-party research for the Agent Orchestrator fallback candidate; not local capability proof.
- [`agent-orchestrator-fallback.md`](agent-orchestrator-fallback.md) — bounded Windows AO fallback verdict and cleanup audit.
- [`evidence/agent-orchestrator/fallback.json`](evidence/agent-orchestrator/fallback.json) — versioned, redacted AO CLI receipt envelope.
- [`environment-inventory.json`](environment-inventory.json) — redacted Phase 0 Doctor envelope.
- [`phase-0-decision.md`](phase-0-decision.md) — frozen Runtime Provider decision and later evidence addenda.
- [`orca-windows-provider.md`](orca-windows-provider.md) — bounded Windows Orca preflight verdict.
- [`evidence/orca/preflight.json`](evidence/orca/preflight.json) — versioned atomic Orca preflight receipts.
