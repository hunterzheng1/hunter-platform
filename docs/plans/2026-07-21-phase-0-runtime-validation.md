# Phase 0 Native Runtime Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce reproducible Windows evidence for Orca, Codex, CodeBuddy Code, and Cursor, then freeze the first Hunter Runtime Provider decision without building product features on an unverified assumption.

**Architecture:** Disposable TypeScript probes call only public upstream commands and protocols through an injected `CommandRunner`. Every probe writes a versioned, redacted evidence envelope; product packages may later reuse conclusions and contract fixtures but never import spike implementation code.

**Tech Stack:** Node.js 24 LTS, TypeScript, npm workspaces, Zod, Vitest, PowerShell 7, Git, Orca CLI, Codex CLI, CodeBuddy Code CLI/ACP, Cursor Desktop/CLI, the public-beta `@cursor/sdk` as a measured candidate, and optionally the current AgentWrapper desktop/Go-daemon release for fallback evidence.

---

## Safety and evidence rules

- Run mutating probes only inside a generated temporary Git repository.
- Never pass an agent's permission-bypass flag.
- Never print API keys, authentication tokens, pairing URLs, cookies, or full
  environment dumps.
- Upstream documentation may justify a test, but only local output can pass a
  Hunter capability criterion.
- A missing executable or login is initially `BLOCKED`, not `PASS`. At the end
  of the timebox it becomes `NOT_PROVEN` for provider adoption and triggers the
  fallback comparison; it does not block Fake-contract Foundation work.
- Delete temporary worktrees only after resolving and validating their absolute
  paths beneath the probe root.

### Task 1: Scaffold the disposable spike workspace

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `spikes/testkit/package.json`
- Create: `spikes/testkit/tsconfig.json`
- Create: `spikes/testkit/src/index.ts`
- Test: `spikes/testkit/src/index.test.ts`

- [ ] **Step 1: Write the failing smoke test**

```ts
// spikes/testkit/src/index.test.ts
import { describe, expect, it } from "vitest";
import { evidenceSchemaVersion } from "./index.js";

describe("spike testkit", () => {
  it("pins the evidence schema", () => {
    expect(evidenceSchemaVersion).toBe(1);
  });
});
```

- [ ] **Step 2: Create the workspace manifests**

```json
{
  "name": "hunter-platform",
  "private": true,
  "type": "module",
  "workspaces": ["spikes/*"],
  "engines": { "node": ">=24" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -b",
    "spike:doctor": "node --enable-source-maps spikes/doctor/dist/main.js"
  },
  "devDependencies": {
    "@types/node": "latest",
    "typescript": "latest",
    "vitest": "latest",
    "zod": "latest"
  }
}
```

Create `tsconfig.base.json` with `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `module` and `moduleResolution` set to `NodeNext`,
and `target` set to `ES2024`. Root `tsconfig.json` references every spike package.

- [ ] **Step 3: Run the test and verify the intended failure**

```powershell
npm install
npm test -- --run spikes/testkit/src/index.test.ts
```

Expected: FAIL because `spikes/testkit/src/index.ts` does not exist.

- [ ] **Step 4: Add the minimal implementation**

```ts
// spikes/testkit/src/index.ts
export const evidenceSchemaVersion = 1 as const;
```

- [ ] **Step 5: Verify and commit**

```powershell
npm test -- --run spikes/testkit/src/index.test.ts
npm run typecheck
git add package.json package-lock.json tsconfig.base.json tsconfig.json vitest.config.ts spikes/testkit
git commit -m "验证：建立 Runtime Spike 证据工作区"
```

Expected: test and typecheck exit `0`.

### Task 2: Implement redacted command evidence

**Files:**
- Create: `spikes/testkit/src/command-runner.ts`
- Create: `spikes/testkit/src/evidence.ts`
- Create: `spikes/testkit/src/redact.ts`
- Modify: `spikes/testkit/src/index.ts`
- Test: `spikes/testkit/src/evidence.test.ts`

- [ ] **Step 1: Write failing redaction and evidence tests**

```ts
import { describe, expect, it } from "vitest";
import { createEvidence, redact } from "./index.js";

describe("spike evidence", () => {
  it("redacts common credentials", () => {
    expect(redact("Authorization: Bearer abc123 CODEBUDDY_API_KEY=secret"))
      .toBe("Authorization: Bearer [REDACTED] CODEBUDDY_API_KEY=[REDACTED]");
  });

  it("records command identity without shell interpolation", () => {
    const evidence = createEvidence({
      probe: "doctor",
      executable: "orca",
      args: ["status", "--json"],
      cwd: "C:\\probe",
      exitCode: 0,
      stdout: "{}",
      stderr: "",
      startedAt: "2026-07-21T00:00:00.000Z",
      finishedAt: "2026-07-21T00:00:01.000Z"
    });
    expect(evidence.schemaVersion).toBe(1);
    expect(evidence.command.args).toEqual(["status", "--json"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```powershell
npm test -- --run spikes/testkit/src/evidence.test.ts
```

Expected: FAIL because the exports do not exist.

- [ ] **Step 3: Implement the deep evidence interface**

Implement one `CommandRunner.run({ executable, args, cwd, timeoutMs })` method
using `spawn(executable, args, { shell: false })`. Return exit code, stdout,
stderr, start/end timestamps, timeout status, and spawn error. Implement
`createEvidence` so every string passes through `redact`; redact bearer tokens,
`*_API_KEY`, `*_AUTH_TOKEN`, pairing query values, and cookie headers.

```ts
export interface CommandRequest {
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
}

export interface CommandRunner {
  run(request: CommandRequest): Promise<CommandResult>;
}
```

- [ ] **Step 4: Verify, scan, and commit**

```powershell
npm test -- --run spikes/testkit/src/evidence.test.ts
npm run typecheck
rg -n "Bearer [A-Za-z0-9]|API_KEY=[^[]|AUTH_TOKEN=[^[]" spikes
git add spikes/testkit
git commit -m "验证：增加可脱敏的命令证据封装"
```

Expected: tests pass and `rg` returns no secret-like fixture outside explicit
redaction input strings.

### Task 3: Inventory installed runtime capabilities

**Files:**
- Create: `spikes/doctor/package.json`
- Create: `spikes/doctor/tsconfig.json`
- Create: `spikes/doctor/src/probes.ts`
- Create: `spikes/doctor/src/main.ts`
- Test: `spikes/doctor/src/probes.test.ts`
- Produce: `docs/validation/environment-inventory.json`

- [ ] **Step 1: Write the failing capability projection test**

The fixture runner returns version/help output for `git`, `orca`, `codex`,
`codebuddy`, `cursor`, `pwsh`, and `node`. Assert that the projection returns
`available`, `versionEvidence`, and `helpHash`; an unavailable executable must
return `available: false` with its spawn error and never throw away other probe
results.

- [ ] **Step 2: Verify the test fails**

```powershell
npm test -- --run spikes/doctor/src/probes.test.ts
```

- [ ] **Step 3: Implement fixed, non-shell probe commands**

Use these requests exactly:

```text
git --version
orca --version
orca --help
codex --version
codex --help
codex app-server --help
codebuddy --version
codebuddy --help
cursor --version
cursor --help
pwsh --version
node --version
```

Hash full redacted help output with SHA-256 while retaining only the first 40
lines in the human-readable inventory.

- [ ] **Step 4: Run the real inventory**

```powershell
npm run typecheck
node --enable-source-maps spikes/doctor/dist/main.js --output docs/validation/environment-inventory.json
```

Expected: command exits `0` even when optional tools are unavailable; required
`git`, `node`, and `pwsh` are recorded as available.

- [ ] **Step 5: Commit**

```powershell
git add spikes/doctor docs/validation/environment-inventory.json package.json package-lock.json tsconfig.json
git commit -m "验证：记录本机 Agent 与 Runtime 能力清单"
```

### Task 4: Validate Orca as workspace and process provider

**Files:**
- Create: `spikes/orca/package.json`
- Create: `spikes/orca/tsconfig.json`
- Create: `spikes/orca/src/orca-client.ts`
- Create: `spikes/orca/src/scenario.ts`
- Test: `spikes/orca/src/orca-client.test.ts`
- Produce: `docs/validation/orca-windows-provider.md`
- Produce: `docs/validation/evidence/orca/*.json`

- [ ] **Step 1: Write failing command-mapping tests**

Test that `OrcaClient` maps typed calls to these public JSON commands without
using a shell:

```text
orca status --json
orca repo add --path <absolute-repo> --json
orca worktree create --repo id:<repo-id> --name hunter-phase0 --agent codex --setup skip --json
orca terminal list --worktree id:<worktree-id> --json
orca terminal create --worktree id:<worktree-id> --title hunter-probe --command pwsh --json
orca terminal send --terminal <terminal-handle> --text "Write-Output HUNTER_READY" --enter --json
orca terminal read --terminal <terminal-handle> --cursor <cursor> --limit 1000 --json
orca terminal wait --terminal <terminal-handle> --for tui-idle --timeout-ms 300000 --json
```

Assert that paths, IDs, text, and commands are distinct argument values and are
never concatenated into one command string.

- [ ] **Step 2: Run the test and implement `OrcaClient`**

```powershell
npm test -- --run spikes/orca/src/orca-client.test.ts
```

Expected before implementation: FAIL. Implement `status`, `addRepo`,
`createWorktree`, `listTerminals`, `createTerminal`, `send`, `read`, and `wait`;
parse JSON with Zod and preserve unknown upstream fields under `raw`.

- [ ] **Step 3: Create the isolated real scenario**

The scenario must:

1. create a unique directory under the OS temporary directory;
2. resolve it to an absolute non-reparse-point path;
3. initialize a Git repository and first commit;
4. ensure Orca is running with `orca open --json` or record `BLOCKED`;
5. create the Orca repo, worktree, and PowerShell terminal;
6. send and read the `HUNTER_READY` marker;
7. record terminal and worktree identifiers;
8. close only resources created by the scenario;
9. remove only the verified temporary root.

- [ ] **Step 4: Run the Windows scenario**

```powershell
$env:HUNTER_PHASE0_MUTATION='allowed'
node --enable-source-maps spikes/orca/dist/scenario.js --output docs/validation/evidence/orca
Remove-Item Env:HUNTER_PHASE0_MUTATION
```

Expected: evidence contains repo, worktree, terminal, send/read/wait, and cleanup
receipts. If Orca requires login or installation, report `BLOCKED` and stop this
task without changing the verdict.

- [ ] **Step 5: Record restart and stale-handle behavior**

With no destructive work in the worktree, close and reopen Orca, reacquire the
worktree and terminal using public selectors, and record whether the original
terminal handle is stale. Expected: Hunter can distinguish reattached,
recreated, and missing sessions; none is treated as successful work.

- [ ] **Step 6: Write and commit the verdict**

`docs/validation/orca-windows-provider.md` must separately score workspace,
terminal, session observation, restart reconciliation, Windows Unicode paths,
mobile pairing, security defaults, public interface stability, and thin-fork
need.

```powershell
git add spikes/orca docs/validation/orca-windows-provider.md docs/validation/evidence/orca
git commit -m "验证：评估 Orca Windows Provider 主路径"
```

### Task 5: Validate CodeBuddy Code as a structured connector

**Files:**
- Create: `spikes/codebuddy/package.json`
- Create: `spikes/codebuddy/tsconfig.json`
- Create: `spikes/codebuddy/src/headless-client.ts`
- Create: `spikes/codebuddy/src/acp-client.ts`
- Create: `spikes/codebuddy/src/scenario.ts`
- Test: `spikes/codebuddy/src/headless-client.test.ts`
- Test: `spikes/codebuddy/src/acp-client.test.ts`
- Produce: `docs/validation/codebuddy-connector.md`
- Produce: `docs/validation/evidence/codebuddy/*.json`

- [ ] **Step 1: Write failing headless command tests**

Assert argument arrays for new and resumed turns:

```text
codebuddy -p --output-format stream-json --permission-mode default --max-turns 1 "Read README.md and return its first heading. Do not modify files."
codebuddy -r <session-id> -p --output-format stream-json --permission-mode default --max-turns 1 "Return the same heading again. Do not modify files."
```

The parser must extract a session ID, structured messages, terminal outcome, and
raw events without assuming undocumented fields are stable.

- [ ] **Step 2: Write failing ACP transport tests**

Use a local fake SSE/HTTP server. Assert `initialize`, `newSession`, `prompt`,
`cancelRun`, and disconnect behavior over the public `/api/v1/acp` interface.
Unknown notifications must be retained as raw events, not crash the stream.

- [ ] **Step 3: Implement and verify both clients**

```powershell
npm test -- --run spikes/codebuddy/src/headless-client.test.ts spikes/codebuddy/src/acp-client.test.ts
npm run typecheck
```

Expected: all fixture tests pass.

- [ ] **Step 4: Run the read-only real scenario**

Run in a temporary Git repository containing only a committed `README.md`.
First validate headless create/resume, then start `codebuddy --serve` on a
loopback-only chosen port and validate ACP create/prompt/cancel. Do not use
`--dangerously-skip-permissions`; a blocked action is valid permission evidence.

```powershell
$env:HUNTER_PHASE0_CODEBUDDY='allowed'
node --enable-source-maps spikes/codebuddy/dist/scenario.js --output docs/validation/evidence/codebuddy
Remove-Item Env:HUNTER_PHASE0_CODEBUDDY
```

- [ ] **Step 5: Record and commit the verdict**

The verdict must distinguish documented Beta HTTP behavior from tested ACP and
headless behavior, and record the exact installed version.

```powershell
git add spikes/codebuddy docs/validation/codebuddy-connector.md docs/validation/evidence/codebuddy
git commit -m "验证：评估 CodeBuddy ACP 与 Headless Connector"
```

### Task 6: Validate Codex as a structured connector

**Files:**
- Create: `spikes/codex/package.json`
- Create: `spikes/codex/tsconfig.json`
- Create: `spikes/codex/src/exec-client.ts`
- Create: `spikes/codex/src/scenario.ts`
- Test: `spikes/codex/src/exec-client.test.ts`
- Produce: `docs/validation/codex-connector.md`
- Produce: `docs/validation/evidence/codex/*.json`

- [ ] **Step 1: Freeze the installed public surface**

Read `docs/validation/environment-inventory.json`. The spike may use only
commands present in the recorded `codex --help` or `codex app-server --help`.
Record a `BLOCKED` result if neither structured exec output nor app-server is
present; do not scrape the interactive TUI.

- [ ] **Step 2: Write failing command and event tests**

For an installed CLI exposing exec JSON, map a read-only prompt to separate
arguments equivalent to:

```text
codex exec --json --sandbox read-only "Read README.md and return its first heading. Do not modify files."
```

Fixture events must cover normal completion, approval request, tool failure,
interruption, malformed JSON line, and an unknown future event.

- [ ] **Step 3: Implement the parser and preserve raw events**

Return `NativeSessionRef`, normalized event kind, terminal outcome, and raw event
for each line. Do not map process exit `0` directly to Hunter step success.

- [ ] **Step 4: Run the read-only real scenario**

```powershell
$env:HUNTER_PHASE0_CODEX='allowed'
node --enable-source-maps spikes/codex/dist/scenario.js --output docs/validation/evidence/codex
Remove-Item Env:HUNTER_PHASE0_CODEX
```

Expected: the installed version, public command surface, session identity,
structured events, cancellation behavior, and resume capability each receive a
separate verdict.

- [ ] **Step 5: Commit**

```powershell
git add spikes/codex docs/validation/codex-connector.md docs/validation/evidence/codex
git commit -m "验证：评估 Codex 结构化 Connector"
```

### Task 7: Validate Cursor handoff and compare SDK/CLI without false control claims

**Files:**
- Create: `spikes/cursor/package.json`
- Create: `spikes/cursor/tsconfig.json`
- Create: `spikes/cursor/src/handoff.ts`
- Test: `spikes/cursor/src/handoff.test.ts`
- Create: `spikes/cursor/src/sdk-probe.ts`
- Test: `spikes/cursor/src/sdk-probe.test.ts`
- Produce: `docs/validation/cursor-handoff.md`
- Produce: `docs/validation/evidence/cursor/*.json`

- [ ] **Step 1: Write failing launch-plan tests**

Given an absolute workspace path, assert that `createCursorHandoff` returns a
display name, executable, separate argument list, task-pack path, and declared
capabilities. The initial manifest must declare `openProjectSurface: true` and
`openExactSession: false`.

- [ ] **Step 2: Implement validation and launch planning**

Reject missing, relative, reparse-point, and non-directory paths. Generate a
task pack containing requirement revision, change revision, task, constraints,
artifacts, evidence, and completion instructions; do not place secrets in it.

- [ ] **Step 3: Verify the actual executable and manual handoff**

```powershell
cursor --version
cursor-agent --version
npm view @cursor/sdk version dist-tags --json
```

Record Desktop launcher, native Windows CLI, WSL CLI, and SDK as separate
surfaces. A missing executable or inaccessible package is evidence, not a reason
to silently substitute another surface. If the SDK is available, record the
exact version and inspect its official type declarations before writing the
probe; never install an unpinned moving tag in the product workspace.

Only after the user allows a visible application launch, open the generated
temporary workspace and confirm that Cursor displays that exact directory.
Record whether Cursor exposes any supported session-level interface separately.

- [ ] **Step 4: Compare the public-beta SDK and CLI contracts**

Use fake transports to test `sdk-probe.ts` normalization first. Then, only with
an exact recorded SDK version and accepted terms, run one local disposable-repo
probe. Compare event completeness, cancellation, approvals, filesystem scope,
session identity, resume, native Windows behavior, and ability to degrade back
to handoff. Keep the product manifest at L0/L1 unless every promoted capability
has reproducible evidence; public beta status alone never qualifies a production
dependency.

- [ ] **Step 5: Commit**

```powershell
git add spikes/cursor docs/validation/cursor-handoff.md docs/validation/evidence/cursor
git commit -m "验证：确认 Cursor 交接并比较 SDK 与 CLI 边界"
```

### Task 8: Validate permission, path, and process failure boundaries

**Files:**
- Create: `spikes/reliability/package.json`
- Create: `spikes/reliability/tsconfig.json`
- Create: `spikes/reliability/src/scenario.ts`
- Test: `spikes/reliability/src/scenario.test.ts`
- Produce: `docs/validation/runtime-reliability.md`
- Produce: `docs/validation/evidence/reliability/*.json`

- [ ] **Step 1: Write failing scenario-planning tests**

Cover a Unicode-and-space workspace path, child process tree, forced provider
exit, stale session reference, duplicate command idempotency key, and a denied
permission request. Assert that every scenario has an expected observable state
and cleanup target.

- [ ] **Step 2: Implement the bounded scenarios**

On Windows, create and terminate a harmless child process tree in the temporary
workspace. On Linux CI, execute the equivalent process-group fixture. No
scenario may kill by executable name or enumerate unrelated processes.

- [ ] **Step 3: Run and record**

```powershell
node --enable-source-maps spikes/reliability/dist/scenario.js --output docs/validation/evidence/reliability
npm test -- --run spikes/reliability/src/scenario.test.ts
```

Expected: missing sessions become `needs_attention`; denied permissions become
`waiting_approval`; no failure becomes `succeeded`.

- [ ] **Step 4: Commit**

```powershell
git add spikes/reliability docs/validation/runtime-reliability.md docs/validation/evidence/reliability
git commit -m "验证：覆盖 Runtime 路径、权限与失联场景"
```

### Task 9: Run Agent Orchestrator fallback only if Orca fails

**Files:**
- Create if required: `spikes/agent-orchestrator/`
- Create if required: `docs/validation/agent-orchestrator-fallback.md`

- [ ] **Step 1: Evaluate the Orca blocking criteria**

Run:

```powershell
npm test
npm run typecheck
```

Read the Orca verdict. Execute this task if a required workspace, process,
Windows, public-interface, or security criterion is `FAIL` or remains
`BLOCKED/NOT_PROVEN` at the timebox; a merely nicer AO feature is not sufficient.

- [ ] **Step 2: Repeat the same typed scenario against AO**

Use the current AgentWrapper desktop/CLI plus resident Go-daemon architecture,
its documented Windows ConPTY runtime, and a temporary Git repo. Pin the exact
release, record Apache-2.0, and do not use the frozen npm 0.10.0 path as evidence
for the current product. Record project registration, isolated workspace,
terminal/session control, restart observation, and the externally supported
daemon integration surface using the same evidence schema as Orca. If the daemon
API is not a supported external contract, record `FAIL` rather than reading its
private state.

- [ ] **Step 3: Commit or record a skipped decision**

If not required, add one line to the Phase 0 decision stating `SKIPPED: Orca did
not trigger fallback criteria`. If required, commit the spike and evidence with:

```powershell
git add spikes/agent-orchestrator docs/validation/agent-orchestrator-fallback.md
git commit -m "验证：执行 Agent Orchestrator Runtime 备选评估"
```

### Task 10: Freeze the Phase 0 decision

**Files:**
- Create: `docs/validation/phase-0-decision.md`
- Create: `docs/adr/0005-orca-runtime-integration.md`
- Modify: `docs/10-risk-register.md`
- Modify: `docs/09-migration-and-roadmap.md`

- [ ] **Step 1: Build the decision matrix**

Rows must cover Windows, Linux design fit, worktree, terminal, structured state,
restart, mobile, security, API stability, upstream maintenance, fork burden, and
provider replaceability. Columns must show official claim, local evidence,
verdict, and evidence link.

- [ ] **Step 2: Select exactly one primary integration shape**

Choose one of the following evidence outcomes:

1. Orca sidecar through public CLI/API;
2. thin Orca fork plus independent Hunter Core;
3. Agent Orchestrator provider;
4. direct Hunter implementation.
5. no production provider proven yet; continue Foundation only against Fake
   contracts and keep real-provider Phase 1 release blocked.

For outcomes 1–4, name one fallback. Do not select a hybrid with unclear state
ownership. Outcome 5 must name the next bounded spike and cannot be presented as
a provider success.

- [ ] **Step 3: Run the Phase 0 final gate**

```powershell
npm ci
npm run typecheck
npm test
rg -n "dangerously-skip|bypassPermissions|--yolo" spikes docs/validation
```

Expected: build/tests pass. Any matching dangerous flag appears only in a quoted
upstream-risk explanation, never an executed command or launch default.

- [ ] **Step 4: Self-review the evidence**

Confirm every `PASS` links to raw local evidence, every credential is redacted,
every mutation used a temporary repo, and cleanup receipts exist.

- [ ] **Step 5: Commit the decision**

```powershell
git add docs/validation docs/adr/0005-orca-runtime-integration.md docs/09-migration-and-roadmap.md docs/10-risk-register.md
git commit -m "决策：冻结 Hunter Runtime Provider 首选路线"
```
