# ADR-0007: Herdr replacement control-plane gate

- Status: Accepted
- Date: 2026-07-28
- Owners: Product / Architecture / Runtime
- Supersedes: ADR-0006 active delivery-host selection and execution order after
  its planned Stop result

## Context

ADR-0006 selected Orca for one bounded, public-interface-only vertical slice.
Task 0 froze the environment and Task 1 then reproduced a terminal `BLOCKED`
result on Orca 1.4.159: the public interface cannot attach the exact existing
Hunter-owned Git worktree and later deregister it without deleting the Git
checkout. The closeout performed no Provider mutation and left Tasks 2–8
`NOT_RUN`.

That result is the experiment working as designed. It does not justify reading
Orca private state, automating its GUI, letting Orca silently replace Hunter
workspace ownership, or weakening cleanup. It also does not prove that Hunter's
governance slice has no value; no real Agent Attempt reached the independent
Verifier.

After the Stop result, the owner authorized the recommended bounded second-host
evaluation without another review gate. Current primary-source research shows:

- Herdr 0.7.5 publishes a structured CLI and local socket protocol, using a
  Windows named pipe;
- `worktree open --path` targets an existing checkout and reports whether it
  was already open;
- `workspace close` closes Herdr state only, while the separate
  `worktree remove` operation is the checkout-deletion path;
- Herdr 0.7.5 exposes named Agent start, prompt, wait, pane inspection, event,
  and session lifecycle operations;
- native Windows support is still an experimental beta and therefore requires
  local proof rather than adoption by documentation.

Pi 0.82.1 exposes a strong SDK/RPC and can run in an exact current working
directory. However, Pi intentionally leaves permission and sandbox product
policy to its host and requires a Bash shell on Windows. Selecting Pi now would
move more Agent-loop and tool-runtime responsibility into Hunter than is needed
to test the current control-plane hypothesis.

Official documentation is discovery evidence only. Neither Herdr nor Pi gains
a Hunter capability `PASS` until a fixed local binary produces a versioned,
redacted receipt.

## Options considered

1. Change the invariant and let Orca own the Git worktree.
2. Wait for Orca to add exact existing-worktree attach and non-destructive
   deregistration.
3. Replace the stopped Orca Adapter experiment with a bounded Pi SDK/RPC gate.
4. Replace the stopped Orca Adapter experiment with a bounded Herdr public
   CLI/socket gate.
5. Archive Hunter and use standalone Orca only.

## Decision

Choose Option 4 for the remainder of the original five-working-day value
timebox.

Herdr 0.7.5 is a candidate `ExternalWorkbenchHost` and Runtime Adapter, not a
production Provider and not a new canonical state owner. Standalone Orca may
continue to be used independently for daily work, but the stopped Orca Adapter
is not extended during this gate. Pi remains a documented fallback and is not
implemented in parallel.

The original timebox deadline remains
`2026-08-04T04:19:30.589Z`. Replacing the candidate does not reset the clock or
erase the Orca Stop history.

### Ownership and integration boundary

Hunter continues to:

- create and validate the exact isolated Git worktree and HEAD;
- own Workspace, Writer, and Controller leases;
- own Requirement, Change, Workflow, Run, Attempt, Policy, Verification,
  Evidence, Archive, and Knowledge state;
- run the frozen independent Verifier outside the Agent session;
- journal every external operation before effect and reconcile it by receipt.

The Herdr Adapter may use only a fixed public CLI, the version-matched public
JSON Schema, or the documented local socket protocol. It may:

- discover the binary, fixed version, protocol version, and Windows support;
- start one fixture-scoped named Herdr session;
- open the exact Hunter-owned existing worktree path;
- create and control only panes and Agent sessions carrying Hunter receipts;
- send, observe, wait, interrupt, reconcile, and close resources when each
  atomic capability is locally proven;
- translate Herdr identifiers into opaque external references.

It may not:

- call `worktree create` for a Hunter-owned run;
- call `worktree remove`, force-remove, or delete a Hunter Git checkout;
- inspect or edit Herdr private session/config files as an integration API;
- scrape terminal pixels or parse ambiguous screen text as Step success;
- inherit or add bypass, yolo, auto-approve, dangerously-bypass, or equivalent
  Agent arguments;
- approve Requirements, change Policy, run or forge a Verifier, issue a
  HumanReceipt, or mark a Step successful.

Normal cleanup closes the Hunter-created Herdr workspace, pane, Agent, and
fixture-scoped named session through public operations. Hunter removes its Git
worktree only after Git, Lease, archive, and uniqueness checks pass. A Herdr
observation, process exit, pane idle state, Agent return, or successful prompt
acknowledgement remains non-authoritative.

### Permission boundary

Herdr is a terminal/process host, not an operating-system sandbox and not
Hunter's approval authority. A Hunter-owned Agent launch is Manual/fail-closed:

- the Adapter accepts structured argv and uses no shell command composition;
- an allowlist defines the executable and permitted native arguments;
- forbidden permission words or unknown presets reject before Provider I/O;
- the exact worktree is the only Hunter-authorized project write scope; actual
  filesystem confinement remains `NOT_PROVEN` until the selected Agent rejects
  a write to a sibling path in an automatically created temporary fixture;
- Agent-facing Hunter tools remain Attempt-scoped and cannot complete a Step.

The first real Agent candidate is the already detected Codex CLI, but its Herdr
launch, authentication, workspace write, and permission defaults remain
`NOT_PROVEN` until the replacement gate records local receipts.

### Product surface

The user-facing Hunter surface remains the narrow authenticated local Web page.
Herdr does not need to embed a browser. The normal local browser is the first
entry for this gate; any Herdr command or plugin shortcut is optional and may
not become a prerequisite or leave persistent registration.

Hunter still does not build an editor, terminal emulator, PTY, Diff viewer,
general browser, mobile shell, remote relay, or second simultaneous Provider.

## Replacement gate

One Windows, no-remote, non-toy fixture must prove:

1. the fixed Herdr binary and protocol schema are locally detected;
2. a Hunter-owned exact existing worktree opens through the public interface;
3. public cleanup removes only Hunter-owned Herdr state and preserves the Git
   checkout and branch;
4. one real Agent launches with no dangerous permission preset and a bounded
   negative fixture proves that an out-of-worktree write is denied or held for
   explicit approval;
5. Agent return and Herdr observations do not complete the Step;
6. Attempt 1 fails the immutable independent Verifier;
7. Attempt 2 recovers and passes without rewriting Attempt 1;
8. Hunter and an isolated Herdr session each restart and reconcile without
   duplicate send, session, or other provider effect;
9. receipts and Evidence are versioned, reproducible, and redacted, and all
   Hunter-owned external resources are cleaned;
10. an ordinary user can understand and complete the path within ten minutes.

The result is `PASS` only when local receipts prove every item. Installation or
authentication missing is `BLOCKED`; incomplete or time-boxed evidence is
`NOT_PROVEN`; deterministic Fake results remain `CONTRACT_ONLY`.

## Stop conditions

Stop without entering later tasks if any of these is required or observed:

- Windows beta cannot reliably start an isolated named session;
- the fixed binary lacks `worktree open --path`, state-only `workspace close`,
  JSON/protocol schema, or exact resource identifiers;
- cleanup would require `worktree remove`, `--force`, private-state edits, or
  deletion of a Hunter Git checkout;
- public session isolation cannot prove unrelated user resources are untouched;
- Agent control requires terminal scraping, GUI automation, or a bypass preset;
- unknown protocol/schema/version cannot fail closed;
- retries or restart can duplicate a prompt, session, or external effect;
- the independent Verifier or HumanReceipt authority can be forged;
- the remaining original timebox expires without the complete slice;
- the user finds no material value beyond standalone Orca/Herdr.

After a Stop, do not try Pi automatically. Record the evidence and separately
decide whether to archive Hunter.

## Consequences

### Positive

- Preserves Hunter worktree ownership instead of weakening an invariant to fit
  Orca.
- Tests the same governance value hypothesis with a public interface that
  explicitly exposes exact open and state-only close operations.
- Keeps PTY, terminal layout, process hosting, and Agent session surfaces outside
  Hunter.
- Reuses the Provider-neutral operation, receipt, Lease, and verification
  contracts already implemented.

### Negative

- Herdr's Windows implementation is beta and may immediately fail the local
  gate.
- The daily user may still prefer Orca's richer desktop, Diff, Browser, and
  mobile experience.
- Herdr and the selected Agent have separate lifecycle and permission surfaces
  that Hunter must reconcile.
- A second candidate adds bounded integration maintenance even if the final
  result is Stop.

## Evidence and non-claims

- ADR-0005 Outcome 5, ADR-0006, Orca Task 0/1 receipts, and all prior
  `BLOCKED`, `NOT_PROVEN`, `FAIL`, and `CONTRACT_ONLY` records remain immutable
  historical evidence.
- Choosing Herdr does not prove installation, Windows stability, workspace
  targeting, Agent authentication, permission safety, recovery, user value, or
  production readiness.
- No Herdr fork, Pi Adapter, production release, remote access, or new
  Desktop/mobile work is authorized.

## Revisit triggers

Revisit after the replacement gate reaches Go/Stop, the original deadline
expires, Herdr public protocol changes, or the user rejects the added operating
cost. Any production Provider declaration, fork, Pi implementation, or scope
re-expansion requires new evidence and a separate decision.
