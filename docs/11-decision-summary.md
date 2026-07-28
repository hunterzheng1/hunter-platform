# Approved decision summary

Date: 2026-07-21

The owner explicitly approved the following product decisions during the design
interview.

1. Hunter is an agent development control plane, not a new super-agent.
2. Different agents expose different, honestly reported control levels.
3. A Project is a logical product and may bind multiple repositories; the first
   version optimizes for one primary repository.
4. Approved requirement revisions are immutable.
5. The canonical work hierarchy is Requirement → Change → Task → Workflow Step.
6. A Change may satisfy slices of several requirements, and a requirement may
   be delivered by several changes.
7. Task and Change dependencies may be serial or bounded-parallel.
8. Workflow templates are versioned, shared, project-overridable, and pinned by
   every run.
9. Workflow graphs support sequence, limited parallelism, conditions, human
   gates, retry, timeout, budget, and bounded loops—not arbitrary BPMN.
10. Agent Product, Agent Profile, Connector, native session, and execution device
    are distinct concepts.
11. Agent return is not step success; verification or explicit human confirmation
    is mandatory.
12. Concurrent writers use isolated worktrees; non-Git projects are single-writer
    in the first version.
13. Hunter provides one cockpit while preserving optional native agent windows.
14. Mobile is a remote cockpit for status, approvals, short steering, pause, and
    resume—not a full mobile IDE.
15. Execution and credentials remain local; cloud capabilities are optional
    discovery, notification, relay, and metadata functions.
16. The first version is single-user and multi-device, not a team product.
17. Important content is stored as readable versioned files; SQLite stores live
    state, events, relations, and indexes.
18. All archives automatically enter the knowledge system; trust level determines
    whether knowledge is injected into future runs.
19. Orca is the first runtime candidate, but Hunter owns canonical state and can
    replace Orca.
20. The first connector set is Codex, CodeBuddy Code, and Cursor.
21. Windows is the first acceptance platform; Linux compatibility is designed
    from the first module interface.
22. The main product becomes the `hunter-platform` monorepo; Hunter Harness remains
    a separate workflow/Skill pack and distribution concern.
23. Goose Gate, Goose pinning, the three-arm pilot, and the 30-day Goose gate are
    removed from the active product baseline.

## 2026-07-28 delivery pivot

The owner approved the following decisions after evaluating Hunter against
current Pi, Orca, and Herdr capabilities. These decisions supersede conflicting
delivery assumptions in items 13, 14, 19, and 20 without changing the domain
invariants in items 1–12 or rewriting historical validation.

24. Hunter remains a product-level governance control plane; it does not become
    another IDE, terminal multiplexer, worktree manager, browser, or Agent loop.
25. Orca is the preferred first, replaceable external workbench/runtime host.
    Hunter uses only public CLI, Skills, MCP, or other documented integration
    surfaces and never reads or writes Orca private storage.
26. Hunter keeps canonical Requirement, Change, Workflow, Run, Attempt,
    Verification, Evidence, Policy, Lease, Archive, and Knowledge state. Orca
    keeps its own window, terminal, worktree-registration, and native-session
    state; Hunter stores only provider-neutral external references and
    observations.
27. The first user surface is a narrow authenticated Hunter Web control page
    opened in an Orca browser tab or a normal browser. New Hunter desktop,
    terminal, editor, browser, mobile/PWA, and device-gateway work is frozen.
28. Deep direct Codex, CodeBuddy, and Cursor Connectors, a second production
    Provider, and additional speculative capability abstractions are deferred.
    The first real path uses one Orca-hosted Agent behind Hunter contracts.
29. Agent return, terminal idle, process exit, window state, and Orca status are
    observations only. Only a Hunter-run independent Verifier or an exact,
    auditable Human Receipt may complete a Step.
30. Hunter-owned runs use Manual/fail-closed permission settings. Any
    dangerously-bypass, yolo, auto-approve, or equivalent preset blocks the
    operation instead of being silently inherited.
31. Delivery starts with one five-working-day, non-toy vertical slice:
    approved Requirement → Hunter-isolated worktree → Orca-hosted Agent →
    deliberate failed Attempt → recovery Attempt → independent verification →
    redacted Evidence. If this cannot be completed safely or adds no practical
    value over direct Orca use, Hunter expansion stops.
32. No Orca fork is authorized. A thin fork requires a separately approved ADR
    after the sidecar path passes and a material user-experience gap cannot be
    solved through public integration surfaces.
33. Topic branches and linked worktrees are cleaned after merge or explicit
    abandonment only when they are clean, have no unique work, have no open PR,
    and are not current, protected, or shared branches.
