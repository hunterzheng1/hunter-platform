# Hunter Platform contributor instructions

Hunter Platform is an archived documentation-led control-plane project.
ADR-0008 supersedes ADR-0007 as the current repository-state decision.
Before interpreting the product model or historical implementation, read:

1. `docs/README.md`
2. `docs/11-decision-summary.md`
3. `CONTEXT-MAP.md` and the relevant `contexts/*/CONTEXT.md`
4. `docs/adr/0008-archive-hunter-platform.md`

## Archived repository policy

- Do not begin implementation, Provider probes, releases, or scope expansion
  without an explicit owner decision that reactivates the repository and adds
  a new ADR.
- There is no active implementation plan. Orca and Herdr Tasks 2–8 remain
  `NOT_RUN`; do not automatically start Pi or resume an older plan.
- Preserve source, Evidence, failure history, schemas, and the unique
  `codex/windows-pc-daily-preview` work. Archiving is not authorization to
  delete or rewrite them.
- Read-only inspection, reproducibility checks, and narrowly scoped security or
  preservation work are allowed when explicitly requested.
- Do not interpret installation, login, status, idle, process exit, old CI, or
  Fake contracts as a production Provider or product PASS.

## Product invariants

- Hunter is a control plane around native coding agents, not another coding
  agent and not a wrapper around one preferred vendor.
- Hunter owns canonical Project, Requirement, Change, Task, Workflow, Run,
  Evidence, Archive, and Knowledge state. Provider-private identifiers are only
  external references.
- Approved Requirement revisions and revisions pinned by a run are immutable.
- Agent return, process exit, terminal idle, and window close are observations;
  only a verifier result or an explicit human receipt may complete a step.
- Retry and loop create new attempts. Never rewrite failed history into success.
- Every loop is bounded by iterations, time, budget, and a deterministic stop
  condition.
- Concurrent writers use isolated Git worktrees. The initial non-Git path is
  single-writer.
- Remote access is disabled by default. Credentials and complete source remain
  local unless an explicit policy says otherwise.
- Windows is the first hard acceptance platform. Keep platform behavior behind
  interfaces that can be implemented and tested on Linux.
- Orca is the preferred first external workbench/runtime host, but remains
  replaceable. Do not make Hunter domain types, persistence, workflow semantics,
  or success criteria depend on Orca internals.
- Orca and Agent permission presets must be Manual/fail-closed for Hunter-owned
  runs. Reject bypass, yolo, auto-approve, or equivalent unsafe defaults.
- Do not reintroduce Goose Gate, Goose version pinning, the former three-arm
  pilot, or a 30-day vendor gate as product prerequisites.

## Delivery rules

- Historical work followed the test-first task sequence in `docs/plans/`; no
  plan there is currently active.
- Preserve user-authored changes and avoid editing unrelated files.
- Record volatile upstream capability claims in research with primary-source
  links and dates; record local proof under `docs/validation/`.
- Never place secrets, tokens, raw credential-bearing commands, or unredacted
  environment dumps in logs, artifacts, evidence, or commits.
- Add an ADR only for a hard-to-reverse architectural decision. Keep bounded
  context vocabulary in the matching `contexts/*/CONTEXT.md`.
- Update documentation and tests in the same change when a public contract or
  domain invariant changes.
- Clean up topic branches and linked worktrees after their PR is merged or the
  work is explicitly abandoned/superseded. Before deletion, verify the worktree
  is clean, the branch is not current/protected/shared, no open PR depends on it,
  and it has no unique unpushed or unmerged commits. Remove the linked worktree
  first, then the local branch, and only then a no-longer-needed remote branch.
  Never delete `main`, active work, or unique history without a recoverable
  reference and explicit owner confirmation.
