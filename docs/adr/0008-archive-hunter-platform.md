# ADR-0008: Archive Hunter Platform

- Status: Accepted
- Date: 2026-07-28
- Owners: Product / Architecture
- Supersedes: ADR-0007 as an active delivery direction

## Context

ADR-0006 tested Orca as a replaceable external workbench/runtime host. Its
public interface could not both attach the exact existing Hunter-owned Git
worktree and later deregister it without deleting that checkout. The bounded
experiment therefore stopped at Task 1 with Tasks 2–8 `NOT_RUN`.

ADR-0007 preserved the ownership invariant and authorized one bounded Herdr
replacement gate. Three evidence-bearing Task 1 attempts proved fixed binary
identity, operation idempotency, and pre-I/O permission-argument rejection in a
temporary fixture. The public exact existing-worktree attach still returned
`needs_attention`; state-only close, complete session isolation, and complete
resource cleanup remained `BLOCKED`. Tasks 2–8 again remained `NOT_RUN`.

Neither experiment reached a real Agent Attempt or independent Verifier. The
results do not prove that Hunter's governance model is wrong, but they do prove
that continuing the product would require another Provider experiment,
weakening a core ownership invariant, or building more Runtime surface before
the value hypothesis has passed. The owner accepted the recommendation to stop
that investment and archive the project.

## Options considered

1. Start the documented Pi fallback immediately.
2. Weaken Hunter worktree ownership and let a host create or own the checkout.
3. Continue Provider-neutral UI/Foundation work while waiting for a Provider.
4. Archive Hunter while preserving all source, contracts, evidence, and history.

## Decision

Choose Option 4.

After this decision's focused PR passes local verification and actual
Windows/Ubuntu CI, is merged, and its topic resources are cleaned, the GitHub
repository is archived read-only.

Archiving:

- stops active Hunter product development and leaves no active implementation
  plan;
- does not delete source, Evidence, or history;
- preserves every `PASS`, `FAIL`, `BLOCKED`, `NOT_PROVEN`, `NOT_RUN`, and
  `CONTRACT_ONLY` result without reinterpretation;
- preserves the `codex/windows-pc-daily-preview` branch and worktree because
  they contain unique commits and uncommitted work;
- does not automatically start Pi, resume Orca/Herdr Tasks 2–8, run new
  Provider probes, or publish a product;
- permits standalone Orca and other tools to continue independently without
  implying Hunter integration.

The archived repository is a recoverable engineering record, not a supported
daily-use product or production release. Existing packages, desktop artifacts,
tests, and Fake Runtime contracts remain historical implementation evidence.

## Non-claims and known open state

- No production Runtime Provider was proven.
- No real two-Attempt Agent/Verifier slice or ten-minute value acceptance ran.
- Desktop/mobile artifacts are unsigned compatibility evidence, not a release.
- The recorded dependency-install summary still reports 22 high-severity
  findings whose production reachability was not classified. Archiving is not
  security remediation.
- The GitHub archive action is an external repository-state receipt and must be
  reported from the actual API result; this ADR alone does not prove it ran.

## Reactivation gate

Implementation may resume only after an explicit owner decision that:

1. unarchives the repository and creates a new ADR;
2. defines one falsifiable user-value hypothesis, a bounded time/budget, and
   terminal Go/Stop conditions;
3. either preserves exact-worktree ownership with new public atomic receipts
   for exact attach and non-destructive cleanup, or explicitly changes that
   invariant with consequences;
4. re-runs dependency/security triage and a fresh Windows/Ubuntu baseline;
5. names allowed Provider operations, permission boundaries, cleanup, evidence,
   and branch-hygiene rules.

Official upstream claims, installation, login, status, idle, process exit, or
old CI cannot satisfy this gate.

## Consequences

### Positive

- Stops further investment after two bounded Provider experiments reached the
  same critical boundary.
- Keeps the domain contracts, failure history, and evidence available for
  research or a future evidence-backed restart.
- Prevents old plans or the Pi fallback from being resumed implicitly.
- Makes repository status unambiguous to users and future Agents.

### Negative

- Hunter does not become a daily-use control-plane product.
- Existing implementation and PC preview work receive no active maintenance.
- Known dependency findings and unproven runtime capabilities remain open
  historical facts.
- Future work requires the deliberate overhead of unarchiving and a new
  decision.

## Revisit triggers

Revisit only when the owner explicitly requests reactivation and at least one
material fact has changed: a Provider publishes and locally proves the missing
atomic workspace operations, the owner approves a different ownership model,
or a new value hypothesis justifies a bounded experiment.
