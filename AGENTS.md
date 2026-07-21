# Hunter Platform contributor instructions

Hunter Platform is currently a documentation-first reset. Before changing the
product model or adding implementation code, read:

1. `docs/README.md`
2. `docs/11-decision-summary.md`
3. `CONTEXT-MAP.md` and the relevant `contexts/*/CONTEXT.md`
4. the applicable ADRs and implementation plan

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
- Orca is a replaceable Runtime Provider candidate. Do not make Hunter domain
  types, persistence, or workflow semantics depend on Orca internals.
- Do not reintroduce Goose Gate, Goose version pinning, the former three-arm
  pilot, or a 30-day vendor gate as product prerequisites.

## Delivery rules

- Follow the test-first task sequence in `docs/plans/`.
- Preserve user-authored changes and avoid editing unrelated files.
- Record volatile upstream capability claims in research with primary-source
  links and dates; record local proof under `docs/validation/`.
- Never place secrets, tokens, raw credential-bearing commands, or unredacted
  environment dumps in logs, artifacts, evidence, or commits.
- Add an ADR only for a hard-to-reverse architectural decision. Keep bounded
  context vocabulary in the matching `contexts/*/CONTEXT.md`.
- Update documentation and tests in the same change when a public contract or
  domain invariant changes.
