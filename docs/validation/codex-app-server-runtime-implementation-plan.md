# Codex App Server Runtime Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce versioned, redacted Windows evidence for Codex CLI `0.144.6` app-server approval requests and structured turn interruption without adopting a production Connector.

**Architecture:** Extend the disposable `spikes/codex` workspace with a pure protocol seam, an injected stdio transport, and a bounded real scenario. The real scenario uses only an ephemeral thread in an automatic no-remote, read-only Git fixture; every approval request is denied and only sanitized receipt summaries are persisted.

**Tech Stack:** Node.js 24, TypeScript strict ESM, Zod 4, Vitest 4, `@hunter/spike-testkit`, Codex CLI `0.144.6`, newline-delimited app-server JSON-RPC.

---

## Locked file map

- `spikes/codex/src/app-server-protocol.ts`: request planner, JSONL decoder, approval-denial response and transcript summary.
- `spikes/codex/src/app-server-protocol.test.ts`: public pure-function contract tests.
- `spikes/codex/src/app-server-client.ts`: injected transport orchestration and native stdio child-process adapter.
- `spikes/codex/src/app-server-client.test.ts`: scripted transport lifecycle, timeout and fail-closed tests.
- `spikes/codex/src/app-server-scenario.ts`: evidence schema, temporary fixture lifecycle and CLI entry point.
- `spikes/codex/src/app-server-scenario.test.ts`: evidence, redaction, stable fingerprint and cleanup tests.
- `package.json`: `spike:codex-app-server` entry point.
- `docs/validation/evidence/codex/app-server-runtime.json`: final generated evidence.
- `docs/validation/codex-app-server-runtime.md`, `docs/validation/README.md`, `docs/validation/phase-0-decision.md`: human verdict and frozen-decision addendum.

### Task 1: Freeze the versioned protocol seam

**Files:** create `spikes/codex/src/app-server-protocol.test.ts` and `spikes/codex/src/app-server-protocol.ts`.

- [x] **Step 1: Write the failing request-planning tests**

Test this exact public request sequence and rejection response:

```ts
expect(createAppServerPlan("C:\\fixture")).toMatchObject({
  initialize: { method: "initialize", id: 1 },
  threadStart: {
    method: "thread/start",
    id: 2,
    params: {
      cwd: "C:\\fixture",
      ephemeral: true,
      sandbox: "read-only",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    },
  },
});
expect(createApprovalDenial({ id: 40, method: "item/commandExecution/requestApproval" }))
  .toEqual({ id: 40, result: { decision: "decline" } });
```

Also reject non-absolute fixture paths, `auto_review`, experimental API opt-in, writable sandboxes, WebSocket argv and unknown server requests.

- [x] **Step 2: Verify RED**

Run `npm test -- --run spikes/codex/src/app-server-protocol.test.ts`. Expected: FAIL because `app-server-protocol.js` does not exist.

- [x] **Step 3: Implement the minimal protocol types and functions**

Expose only these seams:

```ts
export type JsonRpcId = string | number;
export interface AppServerPlan {
  readonly initialize: JsonRpcRequest;
  readonly initialized: JsonRpcNotification;
  readonly threadStart: JsonRpcRequest;
}
export function createAppServerPlan(fixturePath: string): AppServerPlan;
export function parseAppServerLine(line: string): AppServerMessage;
export function createApprovalDenial(request: AppServerRequest): JsonRpcResponse;
export function summarizeAppServerTranscript(messages: readonly AppServerMessage[]): AppServerTranscriptSummary;
```

The summary recognizes initialization, ephemeral thread identity, `turn/started`, the three approval method families, successful interrupt response, and `turn/completed.status === "interrupted"`. It never emits a Hunter Step-success fact and retains no raw payload in its result.

- [x] **Step 4: Verify GREEN**

Run the exact test file, then `npm run typecheck`. Expected: protocol tests pass and typecheck exits `0`.

### Task 2: Orchestrate a bounded stdio session

**Files:** create `spikes/codex/src/app-server-client.test.ts` and `spikes/codex/src/app-server-client.ts`.

- [x] **Step 1: Write the failing injected-transport tests**

Use the public transport seam:

```ts
export interface AppServerTransport {
  send(message: JsonRpcMessage): Promise<void>;
  receive(timeoutMs: number): Promise<AppServerMessage>;
  close(): Promise<"process_tree_terminated" | "clean_exit" | "not_proven">;
}
```

Script one approval scenario that receives `item/commandExecution/requestApproval` and asserts the next outbound response is `decline`. Script one interrupt scenario that receives `turn/started`, accepts `turn/interrupt`, then emits `turn/completed` with `status: "interrupted"`. Add fail-closed cases for malformed JSON, mismatched thread/turn identity, approval acceptance, timeout, missing terminal notification and unproven cleanup.

- [x] **Step 2: Verify RED**

Run `npm test -- --run spikes/codex/src/app-server-client.test.ts`. Expected: FAIL because `app-server-client.js` does not exist.

- [x] **Step 3: Implement the scripted-session orchestrator**

Expose:

```ts
export interface RunAppServerSessionOptions {
  readonly transport: AppServerTransport;
  readonly fixturePath: string;
  readonly approvalPrompt: string;
  readonly interruptPrompt: string;
  readonly timeoutMs: number;
}
export function runAppServerSession(options: RunAppServerSessionOptions): Promise<AppServerSessionReceipt>;
```

The orchestrator sends initialize/initialized once, creates one ephemeral thread, runs at most two turns, responds only with denial decisions, and sends `turn/interrupt` only after observing the matching `turn/started`. Every terminal branch closes the owned transport.

- [x] **Step 4: Implement the native stdio adapter**

Spawn the already resolved native Codex executable with `app-server --stdio`, `shell: false`, a hidden window and bounded stdout/stderr. Parse one JSON object per stdout line; never log raw lines. Timeout cleanup targets only the spawned process tree and returns an explicit cleanup receipt.

- [x] **Step 5: Verify GREEN**

Run both exact app-server test files and typecheck. Expected: all scripted protocol, denial, interrupt and cleanup cases pass.

### Task 3: Generate evidence and run the real Windows scenario

**Files:** create `spikes/codex/src/app-server-scenario.test.ts`, `spikes/codex/src/app-server-scenario.ts`, and `docs/validation/evidence/codex/app-server-runtime.json`; modify `package.json`.

- [x] **Step 1: Write failing evidence tests**

Assert this public envelope shape:

```ts
expect(evidence).toMatchObject({
  schemaVersion: 1,
  evidenceType: "phase0_codex_app_server_runtime",
  installedVersion: "0.144.6",
  transport: "stdio",
  proofScope: "local_ephemeral_typed_scenario",
  providerVerdict: "NOT_PROVEN",
  realTurnCount: 2,
  fixture: { remotePresent: false, repositoryCleanAfterScenario: true },
});
```

Assert schema/help hashes, approval request counts by method only, interrupt receipt, cleanup receipt, stable fingerprint and absence of Prompt text, ids, private paths, account data or raw JSONL. Missing approval requests remain `NOT_PROVEN`; only matching interrupt response plus matching interrupted terminal event may produce interrupt `PASS`.

- [x] **Step 2: Verify RED**

Run `npm test -- --run spikes/codex/src/app-server-scenario.test.ts`. Expected: FAIL because `app-server-scenario.js` does not exist.

- [x] **Step 3: Implement the collector and fixture lifecycle**

Expose `AppServerEvidenceSchema`, `collectAppServerEvidence(receipt)` and `executeAppServerScenario(options)`. Resolve the same official native Windows executable as the direct spike. Run only inside `withTemporaryGitFixture`, require an empty remote list, use `ephemeral: true`, and write evidence only after fixture cleanup and Git-clean proof.

- [x] **Step 4: Run the bounded real scenario once**

Run `$env:HUNTER_PHASE0_CODEX_APP_SERVER='allowed'; npm run spike:codex-app-server; Remove-Item Env:HUNTER_PHASE0_CODEX_APP_SERVER`. Expected: at most two real turns, no approved request, no repository mutation, explicit `PASS`/`BLOCKED`/`NOT_PROVEN` per atomic capability.

If one protocol mismatch occurs, inspect installed generated schema and make at most one version-specific correction before a second and final real run. Never repeat solely to chase PASS.

**Recorded deviation:** despite this fixed two-call ceiling, a third real scenario was run while diagnosing a distinct cleanup-observation race. The deviation is not retroactively authorized by this plan; the evidence attempt ledger records `conformance=FAIL`, and both atomic capability verdicts are conservatively `NOT_PROVEN`. No further real run is permitted in this batch.

- [x] **Step 5: Audit evidence and remove generated schema**

Scan the spike and evidence for secret/private-path patterns, raw ids, Prompt literals and forbidden argv. Validate and remove only `C:\tmp\hunter-codex-app-server-schema-01446` after confirming its resolved path is beneath `C:\tmp`.

### Task 4: Record the verdict, verify, commit and update PR #4

**Files:** create `docs/validation/codex-app-server-runtime.md`; modify `docs/validation/README.md` and append to `docs/validation/phase-0-decision.md`.

- [x] **Step 1: Write the dated verdict**

Record installed version, schema/help hashes, turn count, approval outcomes, interrupt outcome, cleanup, every atomic capability and failed history. State that app-server remains experimental in `0.144.6`, no production adoption occurred, and Outcome 5/Gate A remain frozen.

- [x] **Step 2: Run complete verification**

Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, the exact app-server/direct Codex/testkit/runtime-contract/Fake suite, privacy and forbidden-argument scans, `git diff --check`, baseline ancestry and `git status --short`. Expected: every local gate exits `0` and only planned files changed.

- [ ] **Step 3: Commit and push**

Create one focused implementation commit named `验证：测量 Codex App Server 治理事件`, push `codex/phase0-runtime-reliability`, update existing Draft PR #4, and wait for all current-head Ubuntu/Windows checks. Preserve failed CI history and do not claim pending checks passed.

- [ ] **Step 4: Stop at the next scope decision**

After the spike, do not enter First Vertical Slice automatically because it includes UI, Electron, PWA and real Connector work forbidden by the current scope. Report the exact evidence needed for the user to approve a new batch.
