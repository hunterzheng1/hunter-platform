# Hunter Platform Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a crash-recoverable, secure Hunter modular-monolith foundation that owns canonical projects, immutable requirements and changes, executable workflow definitions, root/child run state, external-operation journaling, leases, policy decisions, and a durable local REST/SSE daemon.

**Architecture:** Hunter is an npm/TypeScript modular monolith. Domain and Flow code are pure and provider-neutral. Every state transition is committed through one SQLite command transaction. That transaction stores the command fingerprint, domain events, and any required external operation in a durable Outbox. External adapters only consume those operations and return facts/receipts; only `FlowEngine` may conclude a Step or Run. `hunterd` completes startup reconciliation before it listens on loopback, authenticates every non-health request, and serves SSE by tailing the durable Event Ledger rather than an in-memory event hub.

**Tech Stack:** Node.js 24 LTS, TypeScript 5, npm workspaces, Zod, built-in `node:sqlite`, Fastify 5, Vitest, fast-check, ESLint 9, and GitHub Actions on Windows and Linux.

---

## Execution contract

- Execute `docs/plans/2026-07-21-phase-0-runtime-validation.md` first. A provider result of `NOT_PROVEN`, `BLOCKED`, or `FAIL` does not block Fake-contract implementation; it only prevents enabling that provider in production.
- Run every command from the repository root. PowerShell examples are canonical on Windows; CI repeats the same scripts on Ubuntu.
- Keep `Project`, `Requirement`, `Change`, `Task`, `WorkflowStep`, `WorkflowRun`, `StepRun`, and `StepAttempt` distinct.
- Every command uses a caller-supplied `idempotencyKey`, an optimistic `expectedVersion`, and a server-computed request fingerprint. Reusing a key with different content is an error.
- No route, Connector, Provider, ProcessHost, terminal parser, GUI observer, recovery probe, or projection may append a success event directly. All conclusions pass through `FlowEngine`.
- No external side effect is invoked before its durable Outbox item and prerequisite Lease receipts commit. No uncertain side effect is replayed blindly.
- Paths, DeviceBindings, PolicySnapshots, budgets, Project scope, and run bindings are loaded on the server. Public commands never accept an arbitrary absolute path or a caller-authored policy/budget snapshot.
- The daemon must finish `StartupRecoveryCoordinator.run()` before `app.listen()`.

## Review correction precedence

This 2026-07-21 revision supersedes every earlier Foundation-plan example quoted by
`docs/reviews/2026-07-21-internal-design-review.md` and
`docs/reviews/2026-07-21-foundation-plan-review.md`. If an archived line reference
conflicts with this file, the locked boundaries and Tasks 4–13 below take precedence.
In particular, implementers must not restore direct `RunStarted` appends, in-memory
assignment/idempotency maps, a volatile SSE hub, provider calls outside the durable
operation journal, or an unauthenticated fixed-port loopback listener.

## Locked file map

The implementation may split a file after review, but it must not rename these shared boundaries during Foundation work because the first vertical slice consumes them.

```text
apps/daemon/
  src/app.ts                                  # Secure Fastify composition root
  src/main.ts                                 # Recovery-before-listen entry point
  src/auth/local-authenticator.ts             # Per-install local identity and authorization
  src/http/security-hooks.ts                  # Host/Origin/CSRF/CSP/rate/size/connection limits
  src/events/durable-event-stream.ts          # Authorized Event Ledger SSE tail
  src/routes/projects.ts                      # Project command/query API
  src/routes/runs.ts                          # Run command/query API
  src/services/sqlite-application-services.ts # Application/Flow wiring; no raw RunStarted append
  src/startup/startup-recovery-coordinator.ts # Ordered crash reconciliation
  test/app-security.test.ts
  test/durable-event-stream.test.ts
  test/startup-recovery.test.ts
packages/api-contracts/
  src/http.ts                                 # Shared Zod request/response schemas
  src/index.ts
packages/domain/
  src/ids.ts                                  # Branded canonical IDs
  src/project.ts                              # Project, RepositoryBinding, DeviceBinding
  src/requirement.ts                          # Immutable RequirementRevision
  src/change.ts                               # Complete immutable ChangeRevision
  src/task.ts                                 # Complete TaskGraph and ExecutionPlan
  src/workflow.ts                             # Executable WorkflowRevision graph/schema
packages/application/
  src/publish-change.ts                       # Cross-reference validation and atomic publish
  src/repositories.ts                         # Read ports used by application commands
  src/start-run.ts                            # Stable public StartRun command -> FlowEngine
packages/storage/
  src/migrations/001-core.sql                 # Events, receipts, Outbox, side effects, leases, views
  src/sqlite-operation-journal.ts             # Event+receipt+Outbox command transaction
  src/operation-worker.ts                     # Durable claim/dispatch/reconcile loop
  src/event-ledger-reader.ts                  # Position-based scoped reader/tailer
  src/lease-store.ts                          # Transactional lease state
  src/projection-runner.ts                    # Incremental/full rebuild
  src/hunter-projection.ts                    # Canonical query projection
packages/flow-engine/
  src/commands.ts                             # Discriminated Flow commands
  src/events.ts                               # Only authoritative Flow events
  src/run-binding.ts                          # Immutable root/child run snapshots
  src/run-budget.ts                           # Persistent counters and exhaustion rules
  src/state.ts                                # Pure WorkflowRun/StepRun reducer
  src/transition-table.ts                     # Explicit execution/verification/run transitions
  src/router.ts                               # Deterministic route and Loop activation
  src/flow-engine.ts                          # Command orchestration and invariants
packages/runtime-contracts/
  src/external-boundary.ts                    # Provider-neutral external facts/receipts
  src/operations.ts                           # Versioned durable operation envelopes
  src/leases.ts                               # Workspace/Writer/Controller lease contracts
  src/manifest.ts                             # Atomic capability evidence contract
packages/runtime-manager/
  src/runtime-operation-handler.ts            # Outbox handler backed by selected Provider
  src/lease-service.ts                        # Acquire/renew/release/recover leases
  src/runtime-manager.ts                      # Builds operations; has no in-memory authority
packages/policy/
  src/policy-engine.ts                        # allow/deny/require-approval decisions
packages/testkit/
  src/fake-runtime.ts                         # Deterministic idempotent external boundary
  src/fault-injector.ts                       # Named crash-point injector
  src/fixtures.ts                             # Complete valid aggregate fixtures
scripts/verify-rebuild.ts                     # Projection rebuild verifier
scripts/verify-recovery.ts                    # Restart/reconciliation verifier
.github/workflows/ci.yml                      # Windows/Linux Foundation gate
```

## Frozen storage names and operation contract

These names are part of the Foundation/vertical-slice boundary:

- Tables: `events`, `command_receipts`, `outbox`, `side_effect_receipts`, `lease_records`, `entity_views`, `projection_checkpoints`, and `storage_metadata`.
- `SqliteOperationJournal.commitCommand(...)` is the only transaction that accepts new domain events and Outbox operations.
- `OperationWorker` claims `outbox` rows and invokes an injected `ExternalOperationHandler.execute(operation)` with the original stable `operationId`.
- A handler returns an `ExternalOperationReceipt` or an observed `indeterminate` fact. It never mutates Flow state itself.
- SSE cursors are the durable integer `events.position`. In-memory notifications may wake a poller but are never the source of event data.

---

### Task 1: Bootstrap the npm monorepo and cross-platform quality gate

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `tsconfig.json`
- Create: `eslint.config.js`
- Create: `vitest.config.ts`
- Create: `packages/testkit/package.json`
- Create: `packages/testkit/tsconfig.json`
- Test: `packages/testkit/src/smoke.test.ts`

- [ ] **Step 1: Add a failing native-ESM smoke test**

```ts
// packages/testkit/src/smoke.test.ts
import { describe, expect, it } from "vitest";

describe("hunter workspace", () => {
  it("runs tests as native ESM", () => {
    expect(import.meta.url.startsWith("file:")).toBe(true);
  });
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run packages/testkit/src/smoke.test.ts`

Expected: FAIL with `Missing script: "test"`.

- [ ] **Step 3: Add workspace configuration and exact scripts**

The root package must be private ESM, require Node 24, include `apps/*` and `packages/*`, and expose:

```json
{
  "scripts": {
    "build": "tsc -b",
    "lint": "eslint .",
    "typecheck": "tsc -b --pretty false",
    "test": "vitest run",
    "verify:rebuild": "tsx scripts/verify-rebuild.ts",
    "verify:recovery": "tsx scripts/verify-recovery.ts",
    "verify:foundation": "npm run lint && npm run typecheck && npm test && npm run verify:rebuild && npm run verify:recovery && npm run build"
  }
}
```

Add `zod`, `fastify`, `fast-check`, Vitest, TypeScript, ESLint, `tsx`, and Node types at versions compatible with the Tech Stack. Enable `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, composite project references, and NodeNext ESM.

- [ ] **Step 4: Verify GREEN on Windows**

Run: `npm install`

Run: `npm test -- --run packages/testkit/src/smoke.test.ts`

Expected: `1 passed` and `package-lock.json` exists.

- [ ] **Step 5: Commit the workspace baseline**

```powershell
git add package.json package-lock.json tsconfig.base.json tsconfig.json eslint.config.js vitest.config.ts packages/testkit
git commit -m "工程：初始化 Hunter Platform npm 工作区"
```

### Task 2: Define complete canonical Project, Requirement, Change, Task, and ExecutionPlan models

**Files:**
- Create: `packages/domain/package.json`
- Create: `packages/domain/tsconfig.json`
- Create: `packages/domain/src/ids.ts`
- Create: `packages/domain/src/project.ts`
- Create: `packages/domain/src/requirement.ts`
- Create: `packages/domain/src/change.ts`
- Create: `packages/domain/src/task.ts`
- Create: `packages/domain/src/index.ts`
- Test: `packages/domain/src/domain.test.ts`
- Test: `packages/domain/src/task-graph.property.test.ts`

- [ ] **Step 1: Write failing canonical-field and immutability tests**

The fixtures must prove all of these fields survive a create/freeze/serialize cycle:

```ts
export interface ChangeRevision {
  readonly changeId: ChangeId;
  readonly revisionId: ChangeRevisionId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly goal: string;
  readonly nonGoals: readonly string[];
  readonly requirementRevisionIds: readonly RequirementRevisionId[];
  readonly repositoryIds: readonly RepositoryId[];
  readonly acceptanceCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly risks: readonly string[];
  readonly dependsOnChangeRevisionIds: readonly ChangeRevisionId[];
  readonly status: "draft" | "published" | "superseded" | "withdrawn";
  readonly publishedAt?: string;
}

export interface TaskDefinition {
  readonly taskId: TaskId;
  readonly title: string;
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly repositoryIds: readonly RepositoryId[];
  readonly moduleScopes: readonly string[];
  readonly dependsOn: readonly TaskId[];
  readonly readSet: readonly string[];
  readonly writeSet: readonly string[];
  readonly access: "read" | "write";
  readonly workflowRevisionId: WorkflowRevisionId;
  readonly defaultAgentProfileId: AgentProfileId;
  readonly sessionPolicy: SessionPolicy;
  readonly workspacePolicy: WorkspacePolicy;
}

export interface ExecutionPlan {
  readonly executionPlanId: ExecutionPlanId;
  readonly projectId: ProjectId;
  readonly changeRevisionId: ChangeRevisionId;
  readonly requirementRevisionIds: readonly RequirementRevisionId[];
  readonly tasks: readonly TaskDefinition[];
  readonly taskGraphFingerprint: string;
  readonly planFingerprint: string;
  readonly publishedAt: string;
}
```

Tests must also assert:

- `ProjectId` is not derived from a repository path.
- A Project can own one primary and multiple secondary `RepositoryBinding`s; paths appear only in `DeviceBinding`.
- Approved `RequirementRevision`, published `ChangeRevision`, and published `ExecutionPlan` are deeply frozen.
- Duplicate Task IDs, unknown Task dependencies, task cycles, empty acceptance criteria, and a write Task with an empty `writeSet` are rejected.
- Reordering a valid Task array does not change graph validity or its canonical fingerprint.

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run packages/domain/src/domain.test.ts packages/domain/src/task-graph.property.test.ts`

Expected: FAIL because the domain package and complete fields do not exist.

- [ ] **Step 3: Implement branded IDs, canonical JSON hashing, and deep immutability**

Use separate branded types for every ID, validate them at runtime, sort unordered ID sets before hashing, reject duplicates rather than silently dropping them, and expose a canonical SHA-256 helper for `taskGraphFingerprint` and `planFingerprint`. Do not freeze by shallow spread only; nested arrays and policy objects must be immutable copies.

- [ ] **Step 4: Implement graph/reference-local validation**

`validateTaskGraph` validates unique IDs, all dependency endpoints, DAG acyclicity with DFS/Kahn independent of serialization order, and read/write constraints. Cross-aggregate existence and approval checks deliberately remain in Task 6 application commands.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test -- --run packages/domain/src/domain.test.ts packages/domain/src/task-graph.property.test.ts`

Expected: all examples and generated graph cases pass.

```powershell
git add packages/domain
git commit -m "领域：冻结完整项目变更与任务计划模型"
```

### Task 3: Define and validate a fully executable WorkflowRevision graph

**Files:**
- Create: `packages/domain/src/workflow.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/src/workflow.test.ts`
- Test: `packages/domain/src/workflow.property.test.ts`

- [ ] **Step 1: Write failing schema and graph tests**

Freeze these concepts in `workflow.ts`:

```ts
type StepKind = "agent" | "command" | "verify" | "human_gate" | "context" | "subflow";
type RouteOutcome = "passed" | "failed" | "canceled" | "timed_out" | "rejected";

interface WorkflowStep {
  readonly stepId: StepId;
  readonly kind: StepKind;
  readonly inputContract: SchemaRef;
  readonly outputContract: SchemaRef;
  readonly executor: ExecutorSelector;
  readonly agentProfileSelector?: AgentProfileSelector;
  readonly requiredCapabilities: readonly AtomicCapability[];
  readonly permissionPolicy: StepPermissionPolicy;
  readonly verifier: VerifierDefinition;
  readonly retryPolicy: RetryPolicy;
  readonly timeoutPolicy: TimeoutPolicy;
  readonly budgetCost: BudgetCost;
  readonly sessionPolicy: SessionPolicy;
  readonly workspacePolicy: WorkspacePolicy;
}

interface RouteDefinition {
  readonly routeId: RouteId;
  readonly fromStepId: StepId;
  readonly outcome: RouteOutcome;
  readonly priority: number;
  readonly condition?: ConditionExpression;
  readonly toStepId: StepId | null;
}

interface LoopPolicy {
  readonly loopId: LoopId;
  readonly routeId: RouteId;
  readonly fromStepId: StepId;
  readonly toStepId: StepId;
  readonly maxIterations: number;
  readonly maxElapsedMs: number;
  readonly maxCost?: number;
  readonly progressPredicate: ProgressPredicate;
  readonly stagnation: {
    readonly maxSameFailureFingerprint: number;
    readonly maxNoDiffIterations: number;
    readonly maxVerifierErrors: number;
  };
  readonly reuse: { readonly profile: boolean; readonly session: boolean; readonly workspace: boolean };
  readonly exhaustion: { readonly target: "paused" | "failed" | "needs_attention"; readonly notify: boolean };
}
```

The tests must cover:

1. Duplicate Step/Route/Loop IDs.
2. Missing entry Step and dangling route or Loop endpoints.
3. A LoopPolicy that does not identify exactly one real route or whose endpoints do not equal that route.
4. Invalid/zero retry, timeout, Loop, or budget values.
5. Ambiguous routing: duplicate priority/conditions or no deterministic default for a routable outcome.
6. A non-Loop cycle.
7. A graph whose declared Loop routes are removed and whose remaining graph is acyclic.
8. The same graph serialized in many Step/Route orders; every order has the same verdict and fingerprint.
9. Progress/no-Diff/repeated-failure/verifier-error/exhaustion fields are mandatory and validated.
10. Missing/unknown `executor`, `permissionPolicy`, retry `backoff`, or other strict-schema fields are rejected; an `agent` Step requires an `agentProfileSelector`, while non-Agent Steps may not smuggle an Agent profile unless their executor contract explicitly permits delegation.
11. Retry policy validates maximum Attempts, retryable error classes, fixed/exponential backoff, delay bounds, jitter policy, and the budget charged while waiting; callers cannot provide an ad-hoc retry delay at runtime.

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run packages/domain/src/workflow.test.ts packages/domain/src/workflow.property.test.ts`

Expected: FAIL because the executable graph contract does not exist.

- [ ] **Step 3: Implement validation without array-order heuristics**

Validation order is normative:

1. Validate runtime shape and unique IDs.
2. Validate entry Step and every route endpoint.
3. Validate each LoopPolicy and require a one-to-one match with an actual route.
4. Remove the routes declared as Loop edges.
5. Run DFS or Kahn topological detection on the remaining directed graph; any remaining cycle is `UNDECLARED_WORKFLOW_CYCLE`.
6. Validate reachability, deterministic route priorities/defaults, executor and AgentProfile selector compatibility, Step-level Permission/Policy requirements, contract references, retry/backoff/timeout/budget bounds, and Loop progress/stagnation/exhaustion semantics.
7. Canonicalize by IDs before hashing/freezing.

Do not infer a “back edge” by comparing array indices.

- [ ] **Step 4: Add state-machine-oriented route fixtures**

Include fixtures for Human Gate approval/rejection, timeout, cancel, verifier infrastructure error, terminal route, Subflow, and a test→implement declared Loop. These fixtures are reused by Task 7 Flow tests.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test -- --run packages/domain/src/workflow.test.ts packages/domain/src/workflow.property.test.ts`

Expected: all example and permutation/property tests pass.

```powershell
git add packages/domain/src/workflow.ts packages/domain/src/workflow.test.ts packages/domain/src/workflow.property.test.ts packages/domain/src/index.ts
git commit -m "流程：冻结可执行工作流图与有界循环契约"
```

### Task 4: Build the SQLite Event Ledger, command journal, durable Outbox, and side-effect receipts

**Files:**
- Create: `packages/storage/package.json`
- Create: `packages/storage/tsconfig.json`
- Create: `packages/storage/src/migrations/001-core.sql`
- Create: `packages/storage/src/sqlite-operation-journal.ts`
- Create: `packages/storage/src/event-ledger-reader.ts`
- Create: `packages/storage/src/operation-worker.ts`
- Create: `packages/storage/src/index.ts`
- Create: `packages/testkit/src/fault-injector.ts`
- Test: `packages/storage/src/sqlite-operation-journal.test.ts`
- Test: `packages/storage/src/operation-worker.fault.test.ts`

- [ ] **Step 1: Write failing atomicity and fingerprint tests**

Tests must prove:

- `commitCommand` atomically writes all Events, one `command_receipts` row, and zero or more `outbox` rows.
- Same `command_id` plus same server-computed `request_fingerprint` returns the original serialized receipt and positions without appending again.
- Same `command_id` plus different fingerprint throws `IDEMPOTENCY_KEY_REUSED`.
- Wrong aggregate version rolls back Events, receipt, and Outbox together.
- Each Event stores global `position`, aggregate version, `project_id`, actor, correlation/causation IDs, schema version, occurred/recorded timestamps, and redacted JSON payload.
- Each Outbox operation has a unique stable `operation_id`, request fingerprint, project/run/attempt scope, versioned operation type, payload, status, dispatch lease, retry metadata, and timestamps.

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run packages/storage/src/sqlite-operation-journal.test.ts`

Expected: FAIL because the migration and journal do not exist.

- [ ] **Step 3: Create the normative schema**

`001-core.sql` must enable foreign keys and WAL and create these minimum columns/constraints:

```sql
CREATE TABLE events (
  position INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  event_data TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  schema_version INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (aggregate_id, aggregate_version)
);

CREATE TABLE command_receipts (
  command_id TEXT PRIMARY KEY,
  request_fingerprint TEXT NOT NULL,
  project_id TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  first_position INTEGER,
  last_position INTEGER,
  response_json TEXT NOT NULL,
  committed_at TEXT NOT NULL
);

CREATE TABLE outbox (
  outbox_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT,
  attempt_id TEXT,
  operation_type TEXT NOT NULL,
  operation_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','in_flight','completed','indeterminate','needs_attention')),
  dispatch_owner TEXT,
  dispatch_generation INTEGER NOT NULL DEFAULT 0,
  dispatch_expires_at TEXT,
  delivery_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE side_effect_receipts (
  operation_id TEXT PRIMARY KEY REFERENCES outbox(operation_id),
  request_fingerprint TEXT NOT NULL,
  provider_kind TEXT NOT NULL,
  provider_receipt_json TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  observed_status TEXT NOT NULL CHECK (observed_status IN ('completed','indeterminate','needs_attention')),
  recorded_at TEXT NOT NULL
);
```

Also create `lease_records`, `entity_views`, `projection_checkpoints`, and `storage_metadata`. Migrations must be transactional and versioned; never interpolate identifiers or payloads into SQL.

- [ ] **Step 4: Implement `SqliteOperationJournal.commitCommand`**

```ts
interface CommitCommand {
  readonly commandId: string;
  readonly requestFingerprint: string;
  readonly projectId: ProjectId;
  readonly aggregateId: string;
  readonly expectedVersion: number;
  readonly actor: ActorContext;
  readonly events: readonly NewDomainEvent[];
  readonly operations: readonly ExternalOperation[];
  readonly response: unknown;
}
```

Use `BEGIN IMMEDIATE`; perform duplicate receipt lookup and version check inside the transaction; insert Events, command receipt, and Outbox items; then commit. A command producing only a response may have null event positions. Never call a Provider inside this transaction.

- [ ] **Step 5: Write named crash-point tests before implementing the worker**

`packages/testkit/src/fault-injector.ts` exposes deterministic points:

- `after_command_commit_before_provider_call`
- `after_provider_success_before_receipt_commit`
- `after_receipt_commit_before_outbox_complete`
- `during_duplicate_delivery`

The restart tests use a file-backed temporary SQLite database and a new `OperationWorker` instance after each injected crash. They must prove:

1. Commit-before-call is delivered after restart without losing the operation.
2. Provider-success-before-receipt retries with the same `operationId`; an idempotent/inspectable fake returns the same receipt without a second native side effect.
3. If the Provider cannot prove whether the effect occurred, the item becomes `indeterminate`, Flow receives a recovery fact, and the Attempt becomes `needs_attention`; the worker does not replay blindly.
4. Receipt-before-complete converges to completed without another Provider call.
5. Duplicate delivery with the same operation/fingerprint returns the stored receipt; different content under the same operation ID is rejected.

- [ ] **Step 6: Implement durable claim, dispatch, and receipt finalization**

`OperationWorker` claims an eligible row with owner/generation/expiry in a transaction, invokes `ExternalOperationHandler.execute(operation)` outside the transaction, then commits `side_effect_receipts` plus an `ExternalOperationObserved` Event and Outbox completion in one transaction. On timeout/crash it leaves recoverable journal state. Retry is permitted only if the operation contract declares replay safe or the handler can inspect by `operationId`; otherwise persist `indeterminate`/`needs_attention`.

- [ ] **Step 7: Verify fault convergence and commit**

Run: `npm test -- --run packages/storage/src/sqlite-operation-journal.test.ts packages/storage/src/operation-worker.fault.test.ts`

Expected: all transaction, duplicate, and four crash-point cases pass.

```powershell
git add packages/storage packages/testkit/src/fault-injector.ts
git commit -m "存储：实现事件事务外部操作日志与崩溃收敛"
```

### Task 5: Build deterministic projections and durable ledger reads

**Files:**
- Create: `packages/storage/src/projection-runner.ts`
- Create: `packages/storage/src/hunter-projection.ts`
- Modify: `packages/storage/src/event-ledger-reader.ts`
- Modify: `packages/storage/src/index.ts`
- Test: `packages/storage/src/projection-runner.test.ts`
- Test: `packages/storage/src/event-ledger-reader.test.ts`
- Create: `scripts/verify-rebuild.ts`

- [ ] **Step 1: Write failing rebuild and cursor tests**

Test incremental apply, full rebuild, idempotent replay, projector-version reset, global position ordering, `position > cursor`, Project-scope filtering, current high-water position, and a configured retention floor. A cursor below the retention floor must return `resync_required`; it must not return an empty list.

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run packages/storage/src/projection-runner.test.ts packages/storage/src/event-ledger-reader.test.ts`

Expected: FAIL because projection and ledger readers do not exist.

- [ ] **Step 3: Implement projections as rebuildable derivatives**

Project `Project`, Repository/Device bindings, RequirementRevision, ChangeRevision, ExecutionPlan/TaskGraph, WorkflowRun, StepRun/Attempt, Outbox status, Lease status, and recovery attention. Projection code may not call Flow or external boundaries. Store projection checkpoint and code/schema version in the same transaction as each projection batch.

- [ ] **Step 4: Implement the authoritative Event Ledger reader**

`EventLedgerReader.readAfter({ position, authorizedProjectIds, limit })` queries SQLite by global position and filters scope in SQL. `tail()` may use an in-process wake signal, but every emitted item must be reread from SQLite. Expose retention floor and high-water positions for SSE gap handling.

- [ ] **Step 5: Verify GREEN, rebuild twice, and commit**

Run: `npm test -- --run packages/storage/src/projection-runner.test.ts packages/storage/src/event-ledger-reader.test.ts`

Run: `npm run verify:rebuild`

Expected: identical snapshots after two clean rebuilds.

```powershell
git add packages/storage scripts/verify-rebuild.ts
git commit -m "存储：实现可重建投影与持久事件游标"
```

### Task 6: Publish Changes/ExecutionPlans with cross-reference validation

**Files:**
- Create: `packages/application/package.json`
- Create: `packages/application/tsconfig.json`
- Create: `packages/application/src/repositories.ts`
- Create: `packages/application/src/publish-change.ts`
- Create: `packages/application/src/index.ts`
- Test: `packages/application/src/publish-change.test.ts`

- [ ] **Step 1: Write failing application-command tests**

`PublishChangeCommand` accepts draft IDs, Task definitions, `expectedVersion`, and `idempotencyKey`; it does not accept pre-validated aggregate objects. The service loads referenced data and rejects:

- a RequirementRevision that is not `approved`, is missing, or belongs to another Project;
- a Repository that is not bound to the Project;
- a Change dependency that is missing, unpublished, or cross-Project;
- duplicate Task IDs, unknown dependencies, cycles, a Task Repository outside Change scope, or a missing WorkflowRevision/AgentProfile;
- a Change/ExecutionPlan fingerprint mismatch or an already published Revision with changed content.

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run packages/application/src/publish-change.test.ts`

Expected: FAIL because application repositories and command handler do not exist.

- [ ] **Step 3: Implement load/validate/freeze/persist in one command boundary**

The service loads Project, RepositoryBindings, approved RequirementRevisions, Change dependencies, published WorkflowRevisions, and AgentProfiles through read ports. It constructs the immutable published `ChangeRevision` and `ExecutionPlan` server-side, computes canonical fingerprints, and calls `SqliteOperationJournal.commitCommand` once with their Events and receipt. It must not publish the Change first and append the Plan later.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npm test -- --run packages/application/src/publish-change.test.ts`

Expected: all valid/missing/cross-Project/unapproved/duplicate/unknown-reference cases pass.

```powershell
git add packages/application packages/domain
git commit -m "应用：原子发布变更修订与执行计划"
```

### Task 7: Implement the authoritative FlowEngine, frozen Run bindings, routing, and persistent budgets

**Files:**
- Create: `packages/flow-engine/package.json`
- Create: `packages/flow-engine/tsconfig.json`
- Create: `packages/flow-engine/src/commands.ts`
- Create: `packages/flow-engine/src/events.ts`
- Create: `packages/flow-engine/src/run-binding.ts`
- Create: `packages/flow-engine/src/run-budget.ts`
- Create: `packages/flow-engine/src/state.ts`
- Create: `packages/flow-engine/src/transition-table.ts`
- Create: `packages/flow-engine/src/router.ts`
- Create: `packages/flow-engine/src/flow-engine.ts`
- Create: `packages/flow-engine/src/index.ts`
- Create: `packages/application/src/start-run.ts`
- Modify: `packages/application/src/index.ts`
- Test: `packages/flow-engine/src/flow-engine.test.ts`
- Test: `packages/flow-engine/src/flow-engine.property.test.ts`
- Test: `packages/application/src/start-run.test.ts`

- [ ] **Step 1: Write failing discriminated Run-binding tests**

Use a common immutable binding plus this discriminated union:

```ts
interface CommonRunBinding {
  readonly runId: RunId;
  readonly projectId: ProjectId;
  readonly changeRevisionId: ChangeRevisionId;
  readonly requirementRevisionIds: readonly RequirementRevisionId[];
  readonly workflowRevisionId: WorkflowRevisionId;
  readonly policySnapshot: PolicySnapshot;
  readonly initialBudget: RunBudgetLimit;
  readonly bindingFingerprint: string;
}

type WorkflowRunBinding =
  | (CommonRunBinding & {
      readonly subjectKind: "change";
      readonly parentRunId: null;
      readonly taskId: null;
      readonly executionPlanId: ExecutionPlanId;
      readonly taskGraphFingerprint: string;
    })
  | (CommonRunBinding & {
      readonly subjectKind: "task";
      readonly parentRunId: RunId;
      readonly taskId: TaskId;
      readonly executionPlanId: ExecutionPlanId;
    })
  | (CommonRunBinding & {
      readonly subjectKind: "subflow";
      readonly parentRunId: RunId;
      readonly taskId: null;
      readonly executionPlanId: ExecutionPlanId;
      readonly parentStepRunId: StepRunId;
    });
```

Tests must reject root-with-parent/task, a root with an empty RequirementRevision set, orphan child, task child without Task, subflow with Task, a Task not in the parent ExecutionPlan/TaskGraph, a child with different Project/Change/Requirement/Plan/Policy context, a cross-Revision child, a second active child for the same Task, and any child start after the parent is terminal.

- [ ] **Step 2: Write failing server-derived StartRun tests**

The public root command contains only `runId`, `executionPlanId`, selected published `workflowRevisionId`, `expectedVersion`, and `idempotencyKey`. `StartRunService` loads Project, published ChangeRevision, approved RequirementRevisions, immutable ExecutionPlan/TaskGraph, published WorkflowRevision, effective PolicySnapshot, and budget limits. It derives the binding and invokes `FlowEngine.handle(StartRun)`.

Task/Subflow child commands are internal Flow commands containing parent/Task or parent/Step references; callers cannot supply replacement Project, Requirement, Change, policy, budget, or paths. Tests must prove there is no application path that appends `RunStarted` directly.

- [ ] **Step 3: Verify RED for Run creation**

Run: `npm test -- --run packages/application/src/start-run.test.ts packages/flow-engine/src/flow-engine.test.ts`

Expected: FAIL because bindings and Flow commands do not exist.

- [ ] **Step 4: Define explicit dual-state and Run transition tables**

Persist, reduce, and test at least:

- Execution: `queued -> assigned -> running -> waiting_input|returned|failed|canceled|stale`; `stale -> running|needs_attention`.
- Verification: `pending -> verifying -> passed|failed|error|needs_human`.
- Step conclusion: success only when execution facts permit verification and verification is `passed` or an explicit Human Gate receipt satisfies the fixed content hash.
- Run: `created -> running -> waiting_approval|paused|succeeded|failed|canceled|needs_attention` with only declared transitions.

Late, duplicate, out-of-order, and stale expected-version facts must be idempotent or rejected; they must never regress a terminal conclusion or create two active Attempts.

- [ ] **Step 5: Implement persistent `RunBudget` consumption**

Persist per Run and Loop: Attempt count, elapsed allocation, cost/token consumption, Loop iteration count, last progress fingerprint, repeated failure fingerprint count, no-Diff count, and Verifier infrastructure-error count. Every transition that allocates work emits a budget-consumption Event in the same Flow command transaction. Callers never pass `nextAttemptId`, `maxAttempts`, or remaining budget as authority; Flow derives them from frozen workflow/policy/run state.

- [ ] **Step 6: Implement deterministic routing and Loop activation**

After a Step conclusion, `router.ts` evaluates routes for the exact outcome against fixed inputs and Evidence. An ordinary Step selects exactly one deterministic route; zero/ambiguous matches produce `needs_attention`. A root TaskGraph dispatch transition instead derives a stable set of all ready Tasks, creates at most one active child Run per Task, and records the complete fan-out decision as one Flow event. Fan-in advances only after every required child has an accepted terminal conclusion. A failed dependency follows the frozen ExecutionPlan policy—block/skip, compensation Task, explicit human waiver, or terminate—and is never guessed from array order.

For a Loop route, Flow checks elapsed/iteration/cost/progress/stagnation policy, consumes budget, creates a new `StepAttempt`, and preserves all earlier Attempts. On exhaustion it applies the declared target and notification. Human Gate, timeout, cancel, verifier error, terminal route, Subflow completion, Task fan-out/fan-in, and integration conclusion use the same transition table.

Parent/child semantics are explicit: a child inherits a bounded allocation from the parent's frozen budget; consumption rolls up transactionally; parent cancel requests propagate idempotently to non-terminal children; child failure is summarized according to the ExecutionPlan dependency policy; and the parent cannot become terminal until every required child and integration Step has an auditable terminal conclusion. If resume fails, SessionPolicy chooses `needs_attention` or a new-session Handoff with the full frozen context. A newer RequirementRevision is only a notification fact: the current Run must record an explicit continue-old-input, terminate, or create-new-plan decision and never swaps revisions in place.

- [ ] **Step 7: Add property/state-transition tests**

Use `fast-check` command sequences to assert:

- no Step success without verification or fixed Human receipt;
- no transition bypasses the table;
- terminal states remain terminal under late facts;
- every retry/Loop creates a new Attempt and monotonically consumes budget;
- bounded workflows always terminate, pause, or require attention by their declared bound;
- graph serialization order does not change route outcome;
- crash/replay of the same Flow command yields the original receipt and one transition.
- two independent ready Tasks fan out together, a dependency fan-in waits, and duplicate scheduling never creates a second active child;
- dependency failure deterministically exercises block/skip, compensation, waiver, and terminate policies;
- parent cancel/failure/budget exhaustion rolls up across children without orphan work or double consumption;
- a terminal parent rejects a new child, and a completed child cannot be counted twice;
- a superseding RequirementRevision forces an explicit continue/terminate/replan decision while the original binding remains byte-identical;
- failed Session resume follows the frozen Handoff policy and never reports success.

- [ ] **Step 8: Verify GREEN and commit**

Run: `npm test -- --run packages/flow-engine/src/flow-engine.test.ts packages/flow-engine/src/flow-engine.property.test.ts packages/application/src/start-run.test.ts`

Expected: all root/child, transition, gate, timeout, cancel, retry, Loop, budget, and replay cases pass.

```powershell
git add packages/flow-engine packages/application
git commit -m "流程：实现权威运行状态路由与持久预算"
```

### Task 8: Freeze external operation, capability, policy, and Lease boundaries

**Files:**
- Create: `packages/runtime-contracts/package.json`
- Create: `packages/runtime-contracts/tsconfig.json`
- Create: `packages/runtime-contracts/src/external-boundary.ts`
- Create: `packages/runtime-contracts/src/operations.ts`
- Create: `packages/runtime-contracts/src/leases.ts`
- Create: `packages/runtime-contracts/src/manifest.ts`
- Create: `packages/runtime-contracts/src/index.ts`
- Create: `packages/policy/src/policy-engine.ts`
- Create: `packages/runtime-manager/src/lease-service.ts`
- Create: `packages/testkit/src/fake-runtime.ts`
- Test: `packages/runtime-contracts/src/contracts.test.ts`
- Test: `packages/runtime-manager/src/lease-service.test.ts`
- Test: `packages/policy/src/policy-engine.test.ts`

- [ ] **Step 1: Write failing provider-neutral operation contract tests**

`ExternalOperation` is a versioned discriminated envelope containing stable `operationId`, fingerprint, Project/Run/Attempt scope, requested atomic capabilities, DeviceBinding/Workspace references, and redacted payload. It must not contain Orca-, Codex-, CodeBuddy-, Cursor-, Goose-, window-title-, or raw arbitrary-path-specific fields. `ExternalOperationReceipt` records the same operation/fingerprint, Provider kind/version, stable native references, structured facts, Evidence ID/hash, and observation time.

The Fake must prove same `operationId`+fingerprint is idempotent and different payload is rejected. Capability level is derived from versioned probe receipts for atomic capabilities; a manifest declaration alone is not evidence.

- [ ] **Step 2: Write failing Lease concurrency/recovery tests**

Freeze three leases:

- `WorkspaceLease`: DeviceBinding, canonical workspace reference/path, repository, baseline commit, allowed mode, owner, generation, expiry.
- `WriterLease`: one write owner per canonical workspace/worktree scope, with owner/generation/expiry.
- `ControllerLease`: one input owner per native Session, with owner/generation/expiry.

All support transactional `acquire`, `renew`, `release`, `inspect`, and expired-lease recovery. Tests cover two parallel writers, two controllers, renewal by stale generation, expiry then generation increment, wrong worktree, `realpath.native` mismatch, HEAD drift, and restart recovery. A Provider launch must be rejected until required durable Lease receipts exist.

The contract tests also load a published WorkflowStep and prove Runtime/Policy derive the executor, AgentProfile selector, atomic capabilities, permission requirements, retry/backoff, timeout, WorkspacePolicy, and budget cost from that frozen definition. A request that tries to replace any of them is rejected before an Outbox item is created.

- [ ] **Step 3: Verify RED**

Run: `npm test -- --run packages/runtime-contracts/src/contracts.test.ts packages/runtime-manager/src/lease-service.test.ts packages/policy/src/policy-engine.test.ts`

Expected: FAIL because contracts, policy, and Lease service do not exist.

- [ ] **Step 4: Implement server-side scope and Policy decisions**

Resolve the published WorkflowStep, Project Repository, and DeviceBinding first; select its declared executor and AgentProfile; then canonicalize with `realpath.native`, verify the resolved path is inside the bound repository/worktree, and derive capabilities, WorkspacePolicy, Step permission requirements, retry/backoff, timeout, and budget from stored Project/Workflow/Policy state. The policy result is `allow`, `deny`, or `require_approval`, includes a reason and snapshot hash, and is committed as a Flow fact. Never let a request body override the executor, profile, path, Project, policy, lease owner, generation, retry timing, timeout, or remaining budget.

- [ ] **Step 5: Implement transactional Lease acquisition**

`LeaseService` updates `lease_records` with optimistic generation in SQLite and writes Lease receipts/events before Flow creates the launch Outbox item. Renewal/release is owner+generation guarded. Expired or mismatched Leases become recovery facts; they do not imply the native Session stopped.

- [ ] **Step 6: Verify GREEN and commit**

Run: `npm test -- --run packages/runtime-contracts/src/contracts.test.ts packages/runtime-manager/src/lease-service.test.ts packages/policy/src/policy-engine.test.ts`

Expected: all idempotency, scope, policy, concurrent writer/controller, expiry, drift, and recovery cases pass.

```powershell
git add packages/runtime-contracts packages/runtime-manager/src/lease-service.ts packages/policy packages/testkit/src/fake-runtime.ts
git commit -m "运行时：冻结外部操作能力策略与租约边界"
```

### Task 9: Dispatch Runtime operations only through the durable journal

**Files:**
- Create: `packages/runtime-manager/package.json`
- Create: `packages/runtime-manager/tsconfig.json`
- Create: `packages/runtime-manager/src/runtime-operation-handler.ts`
- Create: `packages/runtime-manager/src/runtime-manager.ts`
- Create: `packages/runtime-manager/src/index.ts`
- Test: `packages/runtime-manager/src/runtime-manager.test.ts`
- Test: `packages/runtime-manager/src/runtime-operation-handler.fault.test.ts`

- [ ] **Step 1: Write failing no-memory-authority tests**

Tests instantiate a manager, schedule an Attempt, destroy the manager, create a new one over the same database, and finish the operation. Assert there is no assignments/leases/receipts `Map`; duplicate assignment returns the command receipt; policy denial/approval creates no launch operation; missing capability fails closed; and launch cannot occur without current Workspace/Writer/Controller Lease receipts.

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run packages/runtime-manager/src/runtime-manager.test.ts packages/runtime-manager/src/runtime-operation-handler.fault.test.ts`

Expected: FAIL because journal-backed Runtime handling does not exist.

- [ ] **Step 3: Implement scheduling as a Flow command transaction**

`RuntimeManager.requestAssignment` validates evidence-backed atomic capabilities and stored policy/leases, then asks Flow to commit `AttemptAssigned` plus a versioned launch operation through `SqliteOperationJournal`. It never invokes an adapter directly and never treats Provider return, process exit, idle, or GUI open as success.

- [ ] **Step 4: Implement the injected external handler**

`RuntimeOperationHandler` consumes the Foundation `ExternalOperationHandler` port, maps a selected Phase 0 adapter to atomic operations, uses the original stable `operationId`, and returns only structured receipts/facts. Inspection of a missing or unprovable Session yields `indeterminate`/`needs_attention`. Receipt recording is delegated to `OperationWorker`; the handler does not append events.

- [ ] **Step 5: Re-run shared crash tests with Runtime operations**

Cover create workspace/worktree, launch, attach/inspect, send input, cancel, and release. For any operation whose adapter cannot prove idempotency or inspect by operation ID, external-success-before-receipt must stop for attention instead of calling it again.

- [ ] **Step 6: Verify GREEN and commit**

Run: `npm test -- --run packages/runtime-manager/src/runtime-manager.test.ts packages/runtime-manager/src/runtime-operation-handler.fault.test.ts packages/storage/src/operation-worker.fault.test.ts`

Expected: all journal, crash, Lease, and no-false-success cases pass.

```powershell
git add packages/runtime-manager
git commit -m "运行时：通过持久操作日志分配并对账会话"
```

### Task 10: Implement ordered startup recovery before the daemon listens

**Files:**
- Create: `apps/daemon/src/startup/startup-recovery-coordinator.ts`
- Create: `apps/daemon/test/startup-recovery.test.ts`
- Create: `scripts/verify-recovery.ts`

- [ ] **Step 1: Write a failing listen-order test**

Use spies to prove `buildApp().listen()` is not called until recovery completes. A migration/recovery failure exits non-zero or exposes only a non-sensitive local diagnostic path; the command API never opens in a partially recovered state.

- [ ] **Step 2: Write file-backed restart scenarios**

Persist a `running`/`assigned` Attempt, close all objects, then create a new coordinator and cover:

1. Matching Session alive: reattach/observe, renew valid Leases, remain non-terminal.
2. Session missing: record a `stale` fact then `needs_attention`; never infer failure or success from absence alone.
3. Process exited with a verifiable structured receipt: record the receipt and enter verification, not success.
4. External operation outcome unprovable: mark Outbox `indeterminate` and Attempt `needs_attention`, without blind replay.
5. Workspace realpath, worktree, baseline HEAD, or unexpected write drift: record drift and stop for attention.
6. Expired Writer/Controller Lease: reconcile generation/ownership without stealing control from a possibly live Session.
7. Projection checkpoint mismatch: rebuild and compare before serving queries.

- [ ] **Step 3: Verify RED**

Run: `npm test -- --run apps/daemon/test/startup-recovery.test.ts`

Expected: FAIL because the coordinator does not exist.

- [ ] **Step 4: Implement the mandatory recovery sequence**

`StartupRecoveryCoordinator.run()` executes in this order and records timings/results:

1. Validate storage schema version, migration state, WAL mode, foreign keys, database integrity, and content-directory readability.
2. Finish or roll back an interrupted transactional migration.
3. Reconcile Outbox: finalize rows with stored side-effect receipts; reclaim expired dispatch leases; replay only provably safe pending operations with the same `operationId`; mark unknown effects indeterminate.
4. Enumerate active `assigned/running/waiting_*/verifying/stale` Attempts.
5. Probe Provider/Process/Session using stable references and collect facts.
6. Reconcile Workspace/Writer/Controller Leases, DeviceBinding realpaths, worktree identity, Git baseline/HEAD, and unexpected writes.
7. Validate/rebuild projections and their checkpoints from the Event Ledger.
8. Submit every reconciliation conclusion as an idempotent recovery command to `FlowEngine`; do not append conclusion events or edit projections directly.

- [ ] **Step 5: Verify recovery is replay-safe**

Run: `npm test -- --run apps/daemon/test/startup-recovery.test.ts`

Run: `npm run verify:recovery`

Expected: running the coordinator twice yields the same receipts/state; no scenario produces unverified success.

- [ ] **Step 6: Commit recovery**

```powershell
git add apps/daemon/src/startup apps/daemon/test/startup-recovery.test.ts scripts/verify-recovery.ts
git commit -m "恢复：在监听前完成外部状态租约与投影对账"
```

### Task 11: Expose a strictly authenticated local REST API with shared runtime schemas

**Files:**
- Create: `packages/api-contracts/package.json`
- Create: `packages/api-contracts/tsconfig.json`
- Create: `packages/api-contracts/src/http.ts`
- Create: `packages/api-contracts/src/index.ts`
- Test: `packages/api-contracts/src/http.test.ts`
- Create: `apps/daemon/src/auth/local-authenticator.ts`
- Create: `apps/daemon/src/http/security-hooks.ts`
- Create: `apps/daemon/src/routes/projects.ts`
- Create: `apps/daemon/src/routes/runs.ts`
- Create: `apps/daemon/src/app.ts`
- Test: `apps/daemon/test/app-security.test.ts`

- [ ] **Step 1: Write failing schema/authentication/authorization tests**

Tests must reject before an application service is called:

- missing/invalid/expired local credential;
- unauthorized Project/Run scope;
- malformed/branded IDs, unknown fields, and wrong expected versions;
- caller-supplied absolute path, DeviceBinding path, policy snapshot, remaining budget, actor, or Project scope;
- invalid Host, Origin, content type, or missing/invalid CSRF proof on browser write requests;
- body above the configured byte limit, rate above the per-principal limit, too many concurrent requests, or too many SSE connections.
- every non-loopback listen request, every remote/mobile pairing or device-token route, and every attempt to enable a remote listener in the Foundation build; those capabilities do not exist until the authenticated TLS/device work in the vertical-slice plan is installed.

Test strict security headers including CSP, `nosniff`, no-referrer, and no-store for sensitive responses. `/health` may be unauthenticated but returns only `{status}`.

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run apps/daemon/test/app-security.test.ts`

Expected: FAIL because schemas and security hooks do not exist.

- [ ] **Step 3: Freeze shared Zod command envelopes**

Every mutating schema includes `idempotencyKey` and `expectedVersion`, uses strict objects and branded ID refinements, and is parsed at the HTTP boundary. Root StartRun accepts `runId`, `executionPlanId`, and `workflowRevisionId` only; the server derives all other bindings. Routes convert the authenticated principal into `ActorContext`; request fields can never become actor/scope authority.

- [ ] **Step 4: Implement local identity as a real security boundary**

The desktop main process owns a per-install credential referenced from an OS credential store; SQLite stores only `SecretRef`/metadata. It exchanges that secret for a short-lived random process/session capability over a narrow local bootstrap/IPC path. The renderer never receives the install secret. Use constant-time verification and redact credentials from logs/errors. Foundation exposes neither pairing/token endpoints nor a remote listener; attempts return a fixed denial/404 and are covered by the negative tests above. The vertical-slice plan must add remote/mobile access only through a separate authenticated TLS listener with persistent device identity, desktop-confirmed pairing, short access tokens, rotating refresh credentials, revocation, and device-key proof.

- [ ] **Step 5: Configure strict loopback HTTP controls**

Bind an OS-assigned random loopback port by default. Enforce generated Host and explicit local-app Origin allowlists, CSRF bound to the authenticated browser session for state changes, request/response schemas, payload/rate/concurrency/SSE limits, timeouts, and security headers. `127.0.0.1` is defense in depth, not caller identity.

- [ ] **Step 6: Wire routes only to application/Flow commands**

`projects.ts` and `runs.ts` call injected application services. `runs.ts` must never construct a `RunStarted` Event. Application services load authorized resources and server-owned path/policy/budget state before calling Flow. Return original idempotency receipts for exact replays and `409` for version/key conflicts.

- [ ] **Step 7: Verify GREEN and commit**

Run: `npm test -- --run apps/daemon/test/app-security.test.ts packages/api-contracts/src/http.test.ts`

Expected: authorized requests pass; every negative security case is rejected before domain mutation.

```powershell
git add packages/api-contracts apps/daemon/src/auth apps/daemon/src/http apps/daemon/src/routes apps/daemon/src/app.ts apps/daemon/test/app-security.test.ts
git commit -m "安全：发布认证授权且严格校验的本地接口"
```

### Task 12: Stream authorized events from the durable Event Ledger

**Files:**
- Create: `apps/daemon/src/events/durable-event-stream.ts`
- Modify: `apps/daemon/src/app.ts`
- Test: `apps/daemon/test/durable-event-stream.test.ts`

- [ ] **Step 1: Write failing durable replay and restart tests**

Use a file-backed database and two separate app instances. Tests must prove:

- a command committed through application services appears in SSE with `id: events.position`;
- reconnecting to the second app with `Last-Event-ID` returns every later authorized Event exactly once and in order;
- a query cursor is accepted only as a documented compatibility path; conflicting header/query cursors are rejected;
- malformed, negative, future, or below-retention-floor cursors receive an explicit `EVENT_CURSOR_INVALID` or `EVENT_CURSOR_RESYNC_REQUIRED` response before streaming;
- a principal cannot receive another Project's Event even if it guesses its position/Run ID;
- authentication is required at handshake and authorization changes/revocation close or filter the stream;
- the configured per-principal/global connection cap is enforced;
- the replay-to-live handoff cannot lose an Event committed in the race window.

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run apps/daemon/test/durable-event-stream.test.ts`

Expected: FAIL because no durable SSE adapter exists.

- [ ] **Step 3: Implement replay then gap-free live tail**

Authenticate and derive authorized Project IDs first. Resolve cursor and retention/high-water bounds. Query `events.position > cursor` in bounded pages with SQL scope filtering. For the live phase, register a wake signal and immediately requery from the last emitted position before waiting; every emitted Event comes from `EventLedgerReader`, so restart or notification loss cannot lose data. Send keepalives without allocating event IDs and clean up subscriptions on disconnect.

- [ ] **Step 4: Implement explicit resync behavior**

Before writing SSE headers, return `409` with `{code, retentionFloor, highWaterPosition, snapshotUrl}` for an expired cursor. The snapshot endpoint is authenticated/scope-filtered and returns a projection version plus the cursor from which streaming may resume. Never silently return an empty stream for a gap.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test -- --run apps/daemon/test/durable-event-stream.test.ts apps/daemon/test/app-security.test.ts`

Expected: all restart, command visibility, race, resync, auth, scope, and connection-limit cases pass.

```powershell
git add apps/daemon/src/events apps/daemon/src/app.ts apps/daemon/test/durable-event-stream.test.ts
git commit -m "事件：从持久账本提供授权可续传流"
```

### Task 13: Compose production services, prove recovery-before-listen, and add Windows/Linux CI

**Files:**
- Create: `apps/daemon/src/services/sqlite-application-services.ts`
- Create: `apps/daemon/src/main.ts`
- Test: `apps/daemon/test/sqlite-application-services.test.ts`
- Test: `apps/daemon/test/foundation-chain.test.ts`
- Modify: `tsconfig.json`
- Modify: `package.json`
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write a failing full application-chain test**

With file-backed SQLite, Fake Runtime, Fake Verifier, and a real `OperationWorker`, execute:

1. Create Project/Repository/Device bindings.
2. Approve RequirementRevision.
3. Publish ChangeRevision plus ExecutionPlan atomically.
4. Start a root `subjectKind=change` Run through `StartRunService`.
5. Start one Task child through Flow after parent/Task validation.
6. Acquire Workspace/Writer/Controller Leases and commit a launch Outbox item.
7. Dispatch with the Fake, record receipt/Evidence, receive Agent `returned`, run verification, and route to the next Step.
8. Restart before a second operation, run recovery, reconnect SSE from the old position, and finish without duplicate effects.

Assert all Run bindings/fingerprints remain frozen, each external effect has one durable receipt, and no success predates verification.

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run apps/daemon/test/foundation-chain.test.ts apps/daemon/test/sqlite-application-services.test.ts`

Expected: FAIL until every Foundation service is wired.

- [ ] **Step 3: Compose services without bypasses**

`createSqliteApplicationServices` constructs repositories, journal, projections, policy, leases, FlowEngine, RuntimeManager, OperationWorker, recovery ports, auth, and EventLedgerReader. Public commands call application services; Flow alone creates Run/Step conclusion Events. The Fake/production external handler is injected at composition. No composition code appends `RunStarted`, `StepSucceeded`, or `RunSucceeded` directly.

- [ ] **Step 4: Implement `main.ts` with explicit startup order**

1. Resolve the data directory and SecretRefs without logging secrets.
2. Open SQLite and run storage initialization.
3. Build services and `StartupRecoveryCoordinator`.
4. `await recovery.run()`.
5. Start `OperationWorker` supervision.
6. Build the secure app and `await app.listen({host: "127.0.0.1", port: 0})`.
7. Publish the chosen port only over the authenticated desktop bootstrap channel.

On shutdown, stop accepting requests, drain workers, release only owned Lease generations, checkpoint projections, close the database, and preserve unconfirmed operations for recovery.

- [ ] **Step 5: Add the complete CI matrix**

Windows and Ubuntu jobs use Node 24 and run these as separate steps:

```powershell
npm ci
npm run lint
npm run typecheck
npm test
npm run verify:rebuild
npm run verify:recovery
npm run build
```

The test command must include property tests, file-backed crash tests, API security tests, durable SSE restart tests, and the full Foundation chain. Upload redacted failure artifacts only; never upload the SQLite database or credentials by default.

- [ ] **Step 6: Run the local complete gate**

Run: `npm run verify:foundation`

Expected: exit `0`; rebuild and recovery verifiers report stable fingerprints/receipts; no open handle remains.

- [ ] **Step 7: Inspect forbidden bypasses and secrets**

Run: `rg -n "new Map|RunStarted|StepSucceeded|RunSucceeded|HUNTER_.*SECRET|Authorization|absolutePath" apps packages`

Expected: every hit is a test, pure event declaration/reducer, redaction/auth implementation, or server-side DeviceBinding resolution. There is no in-memory authority, route/composition success append, hard-coded credential, or public arbitrary-path field.

- [ ] **Step 8: Commit the completed Foundation**

```powershell
git add apps/daemon package.json package-lock.json tsconfig.json scripts .github/workflows/ci.yml
git commit -m "工程：贯通安全可恢复的 Hunter Foundation"
```

---

## Foundation completion evidence

Foundation is complete only when all evidence below is attached to the implementation review:

- `npm run verify:foundation` exits `0` on a clean Windows checkout; GitHub Actions passes on Windows and Ubuntu.
- The Event Ledger recreates Project, RequirementRevision, ChangeRevision, ExecutionPlan/TaskGraph, root/child WorkflowRun, StepRun/Attempt, Outbox/receipt, Lease, and recovery projections.
- Same command key/fingerprint and operation ID/fingerprint return original receipts; different fingerprints are rejected.
- Events, command receipt, and Outbox commit atomically. Named crash injection at command-before-call, provider-success-before-receipt, receipt-before-complete, and duplicate delivery converges without lost receipts or blind duplicate effects.
- `StartupRecoveryCoordinator` runs before listen and persists every recovery conclusion through Flow. Alive, missing, unprovable, and workspace-drift scenarios never infer success.
- A root Run owns its ExecutionPlan/TaskGraph; task/subflow children satisfy the discriminated parent/Task rules and inherit the exact frozen context.
- Workflow validation is independent of array order, removes declared Loop routes before cycle detection, and rejects dangling/ambiguous/unbounded graphs.
- Flow tests cover conditions, Human Gate, timeout, cancel, retry, verifier error, persistent budget, back-edge progress/stagnation, and dual execution/verification state.
- Two concurrent writers/controllers, stale generations, expiry, wrong worktree, Git drift, and restart Lease recovery are tested.
- Every non-health REST/SSE request is authenticated and authorized; strict Zod, Host/Origin/CSRF/CSP, payload/rate/concurrency/connection limits, and server-derived path/policy/budget tests pass.
- SSE replays by durable `events.position` across app restart, provides explicit gap/resync, and filters Project/Run scope on the server.
- Provider/agent return produces `execution=returned` and `verification=pending`; only Flow after evidence-based verification can succeed.

## Self-review checklist

- [ ] Every Foundation invariant is implemented by a named task, exact file, failing test, passing command, and commit boundary.
- [ ] Complete Change/Task/ExecutionPlan fields and cross-Project/reference/approval negative tests are present.
- [ ] `WorkflowRunBinding` is a `change|task|subflow` discriminated union; root/child lineage and Task ownership cannot be represented incorrectly.
- [ ] Public StartRun cannot provide frozen domain bindings, paths, policy, or budget; the server derives and hashes them.
- [ ] `FlowEngine` is the only writer of Run/Step conclusions; routes and composition cannot append success.
- [ ] Workflow routes, conditions, gates, timeout/cancel, retries, declared Loop edges, progress/stagnation, and persistent budgets share one executable state machine.
- [ ] Graph validation uses endpoint checks plus “remove Loop edges, then DFS/Kahn”; it never compares array positions.
- [ ] `command_receipts` include request fingerprints; `outbox` and `side_effect_receipts` are durable and transactionally reconciled.
- [ ] Unknown external outcomes are visible as `indeterminate/needs_attention`; no unsafe side effect is blindly replayed.
- [ ] Workspace/Writer/Controller Leases include owner, scope, generation, expiry, renew/release, and restart recovery.
- [ ] Startup checks schema/WAL/migration, Outbox, active Attempts, Provider/Session, Workspace/Lease/Git, and projections before listen.
- [ ] REST/SSE authenticate and authorize the caller; browser entry enforces Host/Origin/CSRF/CSP and resource limits.
- [ ] SSE reads durable Event Ledger positions, supports `Last-Event-ID`, and emits explicit resync instead of silent gaps.
- [ ] Phase 0 provider evidence selects adapters without changing canonical domain, Flow, journal, Lease, API, or SSE contracts.
- [ ] Public contracts contain no vendor-specific field, hard-coded secret, arbitrary path authority, or in-memory source of truth.
