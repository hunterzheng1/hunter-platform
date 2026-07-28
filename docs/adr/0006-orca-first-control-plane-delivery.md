# ADR-0006: Orca-first control-plane delivery

- Status: Accepted
- Date: 2026-07-28
- Owners: Product / Architecture / Runtime
- Supersedes: ADR-0003 desktop/mobile delivery consequence, ADR-0004 multi-direct-Connector delivery order, and ADR-0005 post-Phase-0 provider direction

## Context

Hunter has implemented a substantial provider-neutral control-plane foundation:
versioned domain objects, deterministic Flow semantics, append-only attempts,
independent verification, durable operation receipts, recovery, policy, storage,
and Fake contract suites. It has not yet proved the daily user path through a
real Provider. The current Windows preview can install and start, but the
provider-dependent path is still `BLOCKED` or `NOT_PROVEN`.

Meanwhile, Orca already provides the daily surfaces Hunter would otherwise need
to duplicate: repositories and worktrees, terminals and PTYs, native coding
Agents, Diff, Browser, SSH, automation, and mobile access. Pi and Herdr provide
other strong Runtime surfaces. None of these products publicly defines Hunter's
canonical Requirement, Run, Attempt, Verification, Evidence, Policy, and
recovery semantics.

Continuing to build a complete Hunter desktop/terminal/mobile product before a
single real Agent slice proves user value reverses the validation order and
creates avoidable maintenance cost.

ADR-0005 correctly froze Phase 0 Outcome 5: no production Provider was proven.
The owner has since installed Orca and selected it as the preferred route for a
new bounded experiment. That owner choice establishes direction; it does not
retroactively create capability receipts or a production PASS.

## Options considered

1. Continue the full independent Hunter desktop, Runtime, mobile, and direct
   Connector roadmap.
2. Abandon Hunter and use Orca without a Hunter control plane.
3. Keep Hunter's governance core and use Orca as a replaceable external
   workbench/runtime host through a sidecar Adapter.
4. Fork Orca now and merge Hunter into its product shell.
5. Replace Orca with a Pi or Herdr base before proving one real slice.

## Decision

Choose Option 3 for one bounded five-working-day delivery gate.

### Product boundary

Hunter remains the canonical governance control plane for:

- Project, RequirementRevision, ChangeRevision, ExecutionPlan, WorkflowRevision;
- WorkflowRun, StepRun, StepAttempt, budgets, gates, and policies;
- ExternalOperation journal, idempotency fingerprints, receipts, and outbox;
- Workspace, Writer, and Controller leases;
- VerificationReceipt, HumanReceipt, Artifact, Evidence, Archive, and Knowledge.

Orca is the preferred first `ExternalWorkbenchHost` and Runtime Adapter target.
It owns its window layout, terminal/process state, native Agent session, and
repository/worktree registration. Hunter stores only provider-neutral external
references and observations. Git remains the source and commit fact source; the
operating-system credential store remains the secret fact source.

### User experience

The normal daily shell is Orca. Hunter supplies a narrow authenticated local Web
surface for Requirements, Changes, Attention, Runs, Attempts, Verification,
Evidence, Policy, and recovery. Orca may open that surface in a Browser tab;
opening it in a normal local browser remains a fallback.

Hunter does not build or duplicate an editor, terminal emulator, PTY host, Diff
viewer, general browser, worktree IDE, Agent chat, or new mobile shell during
this gate. Existing desktop/mobile/device-gateway code is retained only as
recoverable evidence and compatibility work; no new feature scope is assigned.

### Integration boundary

The Orca Adapter may use only documented public CLI, Skills, MCP, or another
explicit public contract. It may:

- probe a fixed Orca version and availability;
- attach or open a Hunter-validated isolated workspace;
- launch an Agent without bypass flags;
- send, observe, interrupt, reconcile, and clean up when those atomic
  capabilities are locally proven;
- translate Orca identifiers into opaque external references;
- open the Hunter local control surface without exposing a reusable secret.

It may not read/write Orca private databases, scrape GUI pixels, parse ambiguous
terminal text as structured completion, approve Requirements, alter policy,
run or forge a Verifier, issue a HumanReceipt, or mark a Step successful.

Hunter prepares and validates the exact Git worktree and owns its Lease. Orca
may attach/open only that existing path. If Orca's public interface cannot
target the exact worktree and clean up its registration without private-state
access, the gate is `BLOCKED`; Hunter does not silently let Orca create an
unknown workspace.

### Completion and permission authority

Agent return, terminal idle, process exit, window close/open, and Orca status
are `RuntimeObservation` values only. They may change execution state to
`returned` or request attention. They cannot change verification to `passed`.

A Verifier runs outside the Agent session against the frozen
VerifierDefinition and OutputContract. Its immutable receipt binds the
StepAttempt plus input, output, and configuration hashes. A HumanReceipt must
bind an exact content hash and Actor. Only one of those receipts may complete a
Step.

Hunter-owned runs require Manual/fail-closed permission settings. Detection of
`dangerously-bypass`, `yolo`, `auto-approve`, or an equivalent unsafe preset
rejects the operation. An Orca worktree is isolation from concurrent Git
writers, not an operating-system security sandbox.

### Current scope

Retain and deepen only the modules needed by the real slice:

- domain/requirements, application API, Flow, runtime contracts/manager;
- storage, event/outbox/receipt recovery, policy, minimal archive/knowledge;
- testkit, daemon, and a narrow Web control surface;
- one Orca Adapter.

Freeze:

- Hunter desktop-shell expansion and custom mobile/PWA/device-gateway work;
- Hunter-owned terminal, PTY, worktree IDE, Diff, and browser work;
- deep direct Codex/CodeBuddy/Cursor Connectors and second Providers;
- new capability abstractions without two real implementations;
- production signing, distribution, and release claims.

No Orca fork is authorized. A thin fork requires a separate ADR after the
sidecar slice passes and demonstrates a material usability gap that public
integration cannot solve, with an upstream-sync budget and an exit plan.

## Five-working-day gate

One Windows, no-remote, non-toy fixture must prove:

1. an approved and frozen Requirement/Change starts a Run;
2. Hunter creates and verifies the exact isolated Git worktree and Lease;
3. Orca attaches that path and starts one real Agent with no bypass preset;
4. the Agent changes a verifiable target while observations remain
   non-authoritative;
5. Attempt 1 deliberately fails the independent Verifier;
6. Attempt 2 recovers and passes without rewriting Attempt 1;
7. Hunter and Orca each restart once and reconcile without duplicate sends or
   external effects;
8. all receipts and Evidence are versioned, reproducible, and redacted;
9. terminal/session/registration/worktree/branch cleanup leaves no residue;
10. an ordinary user can understand and complete the path within ten minutes.

The result is `PASS` only when local evidence proves every item. Missing
installation/login or interface capability is `BLOCKED`; an elapsed time box
without proof is `NOT_PROVEN`.

## Stop conditions

Stop the gate and do not expand Hunter when any of the following is required:

- private Orca storage access, GUI automation, or a permission-bypass preset;
- an exact Hunter worktree cannot be attached and completely deregistered;
- Agent/Provider output can forge verification or human authority;
- local browser bootstrap leaks or unauthenticated writes are possible;
- retries/recovery duplicate a send or other external side effect;
- five working days elapse without the full slice;
- the user finds no material value beyond direct Orca use.

After a Stop result, continue using standalone Orca and separately decide
whether to try a bounded Pi/Herdr Adapter or archive Hunter. Do not compensate by
adding more interfaces, Providers, UI, or Fake-only features.

## Consequences

### Positive

- Daily work benefits from Orca now instead of waiting for Hunter to recreate
  mature Runtime and UI infrastructure.
- Hunter concentrates engineering on its differentiating governance semantics.
- The first new work produces a falsifiable value result rather than another
  speculative foundation layer.
- Provider-private state remains outside Hunter's domain and persistence.

### Negative

- The user operates two logical products even if Hunter opens inside Orca.
- Orca public interfaces and upstream changes remain a high-risk dependency.
- Some existing Hunter desktop/mobile/direct-Connector work enters maintenance
  mode and may never ship.
- The gate may conclude that Hunter should stop.

## Evidence and non-claims

- ADR-0005 and all files under `docs/validation/`, `docs/reviews/`, and
  `docs/history/` remain unchanged historical evidence.
- Choosing Orca as the preferred host does not prove any L0–L3 capability,
  production safety, mobile path, recovery behavior, or release readiness.
- Fake Runtime results continue to prove only Hunter contracts.
- Current local/remote CI and production release status must be reported
  separately from this design decision.

## Revisit triggers

Revisit this decision only after the five-day gate, an Orca public-interface
change blocks the Adapter, a second real Provider is justified by user demand,
or a passed sidecar exposes a material unfixable UX gap. Any Fork, production
Provider declaration, or scope re-expansion requires new evidence and an
explicit owner decision.
