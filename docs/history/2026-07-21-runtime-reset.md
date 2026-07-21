# 2026-07-21 Hunter Runtime repository reset

## What happened

The repository previously implemented an early Goose-centered security kernel
and pilot scaffold. Product discovery showed that the desired product is instead
a multi-project workbench, deterministic workflow control plane, and replaceable
native-agent execution layer.

The working tree was therefore cleared and re-seeded as Hunter Platform.

## What was intentionally removed from the active tree

- Goose-specific Gate and MCP integration.
- Goose version pinning and distribution responsibility.
- A/B/C pilot and benchmark scaffolding.
- The rule that Workbench development had to wait for a 30-day Goose decision.
- The former approved design documents whose central product assumption was Goose.

## History reset and recovery boundary

At the owner's explicit request, the renamed remote repository is restarted from
a new root commit and its former remote branches are removed. The new remote Git
history therefore does not retain the superseded files or commits.

The previous local `Hunter-Runtime` checkout is intentionally left untouched as
the recovery source. Recovery is a deliberate local operation; old assumptions
must not be merged back into the new `main` by accident.

Recovery inventory captured before the force replacement:

- local checkout: `E:\MyProject\AI Related\Hunter-Runtime`
- former remote URL in that checkout: `https://github.com/hunterzheng1/hunter-runtime.git`
- former remote `main`: `003021420f6e43b7b6c180bc07e2a4e21ee5f71d`
- former remote `codex/fable5-round3-revision`: `a36314d320ee993953dd59d941932c4296b26998`
- former remote tags: none

Both recorded commits were verified as reachable in the local checkout before
the remote rewrite.

## What may be reimplemented generically

The old implementation contained useful ideas—stable identifiers, hashing,
clock handling, offline spool, Windows process-tree supervision, workspace
identity, and crash recovery. They are candidates for selective reimplementation
behind the new module interfaces. They are not copied wholesale because their
old types and assumptions were coupled to the superseded model.
