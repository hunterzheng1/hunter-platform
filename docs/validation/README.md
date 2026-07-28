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

- [`herdr-control-plane-baseline.md`](herdr-control-plane-baseline.md) — Herdr replacement Task 0 fixed stable/Windows-preview identities, exact asset/schema hashes, read-only public inventory, preserved `BLOCKED` attempt, and explicit Provider `NOT_PROVEN`.
- [`orca-public-adapter-gate.md`](orca-public-adapter-gate.md) — Orca-first Task 1 public CLI attach/cleanup hard gate, version-matched local help receipts, zero-mutation `BLOCKED` closeout, and Task 2–8 `NOT_RUN`.
- [`orca-control-plane-baseline.md`](orca-control-plane-baseline.md) — Orca-first Task 0 frozen source/timebox/budget, read-only public-interface inventory, redacted local tool receipts, and preserved failed probe attempts.
- [`gate-r1-runtime-connectors.md`](gate-r1-runtime-connectors.md) — Gate R-1 real local Orca/Codex/CodeBuddy/Cursor receipts, receipt-derived `NONE` levels, preserved launcher/timeout failure history, and explicit Provider Gate A boundary.
- [`phase-1-soak.md`](phase-1-soak.md) — Task 11 fixed-seed smoke/24-hour soak protocol, preserved cycle attempts, bounded resources, and honest NOT_RUN/NOT_PROVEN/PASS rules.
- [`phase-1-contract-only-candidate.md`](phase-1-contract-only-candidate.md) — Task 12 H4 candidate ledger for Golden-1 through Golden-6, P-02/W-01 E2E, preserved RED/failure history, and remaining NOT_PROVEN/NOT_RUN gates.
- [`phase-1-performance.md`](phase-1-performance.md) — Task 11 fixed dataset, JSDOM/Fake performance thresholds, complete failure matrix, and original failure history.
- [`phase-1-windows-install-lifecycle.md`](phase-1-windows-install-lifecycle.md) — Task 10 unsigned NSIS artifact metadata, temporary packaged-app lifecycle, verified migration/backup gate, user-data-preserving uninstall policy, and owned sidecar cleanup evidence.
- [`phase-1-mobile-offline-safety.md`](phase-1-mobile-offline-safety.md) — Task 9 device revocation/replay regression, timed offline outbox, atomic retention resync, mobile Gate allowlist, and provider-neutral remote surface.
- [`phase-1-knowledge-handoff-safety.md`](phase-1-knowledge-handoff-safety.md) — Task 8 provider-neutral selection receipts, conflict/budget policy, untrusted-data Handoff boundary, Cursor contract-only fixture, and provenance display.
- [`phase-1-resource-bounds.md`](phase-1-resource-bounds.md) — Task 7 bounded Artifact pages, retention resync, logical quotas, protected evidence, slow-client backpressure, and fixed 10+4 Fake workload evidence.
- [`phase-1-attention-actions.md`](phase-1-attention-actions.md) — Task 6 provider-neutral Attention projection, receipt-derived recovery actions, audited human observations, and append-only recovery Attempt evidence.
- [`phase-1-diagnostic-bundle.md`](phase-1-diagnostic-bundle.md) — Task 5 versioned redaction, allowlisted diagnostic bundle, fail-closed input bounds, and five-output Secret canary evidence.
- [`phase-1-backup-restore.md`](phase-1-backup-restore.md) — Task 4 online SQLite snapshot, versioned manifest, fail-closed reference reconciliation, and isolated restore drill evidence.
- [`phase-1-versioned-migrations.md`](phase-1-versioned-migrations.md) — Task 3 versioned SQLite ledger, fail-closed startup integrity, legacy v1 compatibility, and desktop migration resource evidence.
- [`phase-1-acceptance-ledger.md`](phase-1-acceptance-ledger.md) — test-enforced Phase 1 functional, Golden, non-functional, release-blocker, and supply-chain status ledger.
- [`phase-1-hardening-baseline.md`](phase-1-hardening-baseline.md) — PR #5 merge fact, fresh-worktree RED/GREEN evidence, supply-chain permission boundary, and the Phase 1 provider status boundary.
- [`vertical-slice-acceptance.md`](vertical-slice-acceptance.md) — Fake-only 首个产品纵向切片、双来源 Knowledge、移动安全与未签名 Windows 打包验收；真实 Provider 仍为 NOT_PROVEN。
- [`first-vertical-slice-task19.md`](first-vertical-slice-task19.md) — 生产 composition root、两次重启、认证启动器与 Chromium 证据。
- [`first-vertical-slice-task17.md`](first-vertical-slice-task17.md) — Task 17 本机设备身份、TLS、幂等命令与 PWA 安全验证；不代表真实 Provider 或公网生产验证。
- [`codex-app-server-runtime.md`](codex-app-server-runtime.md) — bounded Windows Codex app-server approval/interrupt verdict; experimental surface, not production adoption.
- [`evidence/codex/app-server-runtime.json`](evidence/codex/app-server-runtime.json) — versioned, redacted ephemeral stdio protocol receipts.
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
