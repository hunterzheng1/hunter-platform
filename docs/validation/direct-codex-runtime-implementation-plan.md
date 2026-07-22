# Direct Codex Runtime Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce versioned, redacted Windows evidence for the installed Codex CLI through a bounded Direct Runtime spike without enabling a production Provider or weakening Hunter permissions.

**Architecture:** A disposable `spikes/codex` package plans fixed `codex exec` argv and normalizes JSONL through public seams. An injected `CommandRunner` keeps fixture tests deterministic; the real scenario runs only inside `withTemporaryGitFixture`, stores hashes instead of raw private output, and never turns a Codex/process observation into Hunter Step success.

**Tech Stack:** Node.js 24, TypeScript strict ESM, Zod 4, Vitest 4, `@hunter/spike-testkit`, Codex CLI `0.144.6`.

---

## Locked file map

- `spikes/codex/src/exec-client.ts`: safe argv planner and tolerant JSONL normalizer.
- `spikes/codex/src/scenario.ts`: evidence schema, bounded fixture execution and CLI entry point.
- `spikes/codex/src/*.test.ts`: public seam, fail-closed, fingerprint and cleanup tests.
- `spikes/codex/package.json`, `spikes/codex/tsconfig.json`, root manifests: workspace wiring.
- `docs/validation/evidence/codex/direct-runtime.json`: generated redacted evidence.
- `docs/validation/codex-direct-runtime.md`: human verdict and true test history.
- `docs/validation/README.md`, `docs/validation/phase-0-decision.md`: dated links/addendum without rewriting frozen Outcome 5 text.

### Task 1: Freeze safe command planning and JSONL normalization

**Files:** create `spikes/codex/package.json`, `spikes/codex/tsconfig.json`, `spikes/codex/src/exec-client.test.ts`, and `spikes/codex/src/exec-client.ts`; modify `tsconfig.json`.

- [x] **Step 1: Write the failing public-seam tests**

The first literal verifies this exact plan:

```ts
expect(createCodexExecPlan({ mode: "new", prompt: "Read README.md and return its first heading. Do not modify files." })).toEqual({
  executable: "codex",
  args: ["exec", "--json", "--sandbox", "read-only", "Read README.md and return its first heading. Do not modify files."],
});
```

The second fixture contains `thread.started`, `turn.started`, an `agent_message`, and `turn.completed`; assert `sessionIdentityPresent: true`, `terminalOutcome: "returned"`, and no Step-success fact. Add independent tests for approval/waiting, tool failure, interrupted/failed turn, malformed JSON, unknown future event retained as raw, resume argv, and every forbidden flag family.

- [x] **Step 2: Verify RED**

Run `npm test -- --run spikes/codex/src/exec-client.test.ts`. Expected: FAIL because `exec-client.js` does not exist.

- [x] **Step 3: Add minimal implementation**

Implement these public seams:

```ts
export type CodexExecMode =
  | { readonly mode: "new"; readonly prompt: string }
  | { readonly mode: "resume"; readonly sessionId: string; readonly prompt: string };
export interface CodexExecPlan { readonly executable: "codex"; readonly args: readonly string[]; }
export function createCodexExecPlan(input: CodexExecMode): CodexExecPlan;
export function parseCodexJsonLines(stdout: string): CodexEventStream;
```

Recognize public event discriminators with a raw fallback. Never emit Step success. Reject empty inputs and argv containing `dangerously`, `--yolo`, `--full-auto`, `danger-full-access`, or approval-disable overrides.

- [x] **Step 4: Verify GREEN**

Run `npm test -- --run spikes/codex/src/exec-client.test.ts`, then `npm run typecheck`. Expected: all cases pass and typecheck exits `0`.

### Task 2: Build a redacted, fail-closed evidence envelope

**Files:** create `spikes/codex/src/scenario.test.ts` and `spikes/codex/src/scenario.ts`.

- [x] **Step 1: Write the failing evidence tests**

Use an injected boundary runner and assert:

```ts
expect(evidence).toMatchObject({
  schemaVersion: 1,
  evidenceType: "phase0_direct_codex_runtime",
  connector: "direct_codex_cli",
  installedVersion: "0.144.6",
  proofScope: "local_typed_scenario",
  modelServiceCallAttempted: true,
  remoteRepositoryWriteAttempted: false,
});
expect(JSON.stringify(evidence)).not.toContain("thread-1");
expect(JSON.stringify(evidence)).not.toMatch(/[A-Z]:\\Users\\/u);
```

Add cases for unavailable login, malformed JSONL, mismatched resume identity, unproven interrupt cleanup, and exit `0` without a terminal JSON event. Each must produce `BLOCKED`, `FAIL`, or `NOT_PROVEN`, never a false PASS.

- [x] **Step 2: Verify RED**

Run `npm test -- --run spikes/codex/src/scenario.test.ts`. Expected: FAIL because `scenario.js` does not exist.

- [x] **Step 3: Implement schema and collector**

Expose `collectDirectCodexEvidence(options): Promise<DirectCodexEvidence>` and `executeDirectCodexScenario(options): Promise<DirectCodexEvidence>`. Receipts keep only operation, redacted/fixed args, exit/timeout/spawn status and SHA-256 hashes. Hash session IDs for create/resume comparison and never serialize them raw. Canonical fingerprints omit `generatedAt` and volatile identities. Require an active temporary Git fixture and empty `git remote` output.

- [x] **Step 4: Verify GREEN and cleanup**

Run `npm test -- --run spikes/codex/src/scenario.test.ts`, then both exact Codex test files. Expected: schema, fail-closed, redaction, stable fingerprint and fixture-removal tests pass.

### Task 3: Run the bounded real Windows scenario

**Files:** modify `package.json` and `package-lock.json`; create `docs/validation/evidence/codex/direct-runtime.json`.

- [x] **Step 1: Install and freeze the public surface**

Run `npm install`. Expected: lockfile includes `spikes/codex`. The scenario records `codex --version`, help hashes, and only the exit status of `codex login status`; account output is discarded.

- [x] **Step 2: Execute at most three read-only calls**

Run `$env:HUNTER_PHASE0_CODEX='allowed'; npm run spike:codex; Remove-Item Env:HUNTER_PHASE0_CODEX`. New/resume calls use only JSON, read-only sandbox and fixed harmless prompts. The interrupt call uses the same plan plus exact-process-tree timeout. No MCP, plugin, search, remote Git, bypass, auto-approve or broader sandbox is allowed.

Expected: evidence is written only after fixture cleanup. Missing or ambiguous capabilities remain `BLOCKED`/`NOT_PROVEN`.

- [x] **Step 3: Audit evidence**

Scan `spikes/codex` and `docs/validation/evidence/codex` for secret/private-path patterns and forbidden executed argv. Expected: no unredacted material and no forbidden command receipt.

### Task 4: Record verdict, verify and update the Draft PR

**Files:** create `docs/validation/codex-direct-runtime.md`; modify `docs/validation/README.md` and `docs/validation/phase-0-decision.md`.

- [x] **Step 1: Write the verdict and dated addendum**

Record version, host, help hashes, call count, create/resume/interrupt outcomes, cleanup and every atomic capability. State that `turn.completed`, agent return and exit `0` are observations only. Append after the frozen decision; do not rewrite it. If Gate A might change, stop before ADR-0005 and request an owner decision.

- [x] **Step 2: Run complete verification**

Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, the exact spike/testkit/runtime-contract/Fake tests, `git diff --check`, and `git status --short`. Expected: every local gate exits `0`; status contains only planned files.

- [x] **Step 3: Commit and update the existing Draft PR**

Stage only root manifests, `spikes/codex`, and directly related validation files. Commit as `验证：评估 Direct Codex Runtime 结构化链路`, push `codex/phase0-runtime-reliability`, then inspect actual Windows/Ubuntu checks. Report pending until GitHub completes.
