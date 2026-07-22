import type { DatabaseSync } from "node:sqlite";

import { PublishChangeService, StartRunService, type PublishChangeRepositories, type StartRunRepositories } from "@hunter/application";
import type { ExecutionPlan, ProjectId, TaskId, WorkflowRevision } from "@hunter/domain";
import { canonicalSha256 } from "@hunter/domain";
import { FlowEngine, reduceFlowEvents, type FlowCommandReceipt, type FlowCommit, type FlowDefinitions, type FlowEvent, type FlowStore, type WorkflowRunState } from "@hunter/flow-engine";
import { LeaseSchema, type CapabilityProbeReceipt, type ExternalOperation, type ExternalOperationHandler, type Lease } from "@hunter/runtime-contracts";
import { deriveStepPolicy } from "@hunter/policy";
import { LeaseService, RuntimeManager, RuntimeOperationHandler } from "@hunter/runtime-manager";
import { EventLedgerReader, HunterProjection, OperationWorker, ProjectionRunner, SqliteOperationJournal } from "@hunter/storage";

import { LocalAuthenticator } from "../auth/local-authenticator.js";
import { DurableEventStream } from "../events/durable-event-stream.js";
import { StartupRecoveryCoordinator } from "../startup/startup-recovery-coordinator.js";
import { SqliteDefinitionRepository } from "./sqlite-definition-repository.js";

interface ReceiptRow {
  readonly request_fingerprint: string;
  readonly response_json: string;
}

interface FlowEventRow {
  readonly aggregate_id: string;
  readonly event_data: string;
}

export class SqliteFlowStore implements FlowStore {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly journal: SqliteOperationJournal,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public loadRun(runId: string): WorkflowRunState | null {
    const rows = this.database.prepare(
      "SELECT aggregate_id, event_data FROM events WHERE aggregate_id = ? AND event_type = 'FlowEvent' ORDER BY aggregate_version",
    ).all(`run:${runId}`) as unknown as FlowEventRow[];
    if (rows.length === 0) return null;
    return reduceFlowEvents(null, rows.map((row) => (JSON.parse(row.event_data) as { flowEvent: FlowEvent }).flowEvent));
  }

  public activeTaskIds(parentRunId: string): readonly TaskId[] {
    return this.allRuns()
      .filter((state) => state.binding.subjectKind === "task" && state.binding.parentRunId === parentRunId && !["succeeded", "failed", "canceled"].includes(state.status))
      .flatMap((state) => state.binding.subjectKind === "task" ? [state.binding.taskId] : []);
  }

  public childRuns(parentRunId: string): readonly WorkflowRunState[] {
    return this.allRuns().filter((state) => state.binding.parentRunId === parentRunId);
  }

  public allRuns(): readonly WorkflowRunState[] {
    const rows = this.database.prepare(
      "SELECT aggregate_id, event_data FROM events WHERE event_type = 'FlowEvent' ORDER BY aggregate_id, aggregate_version",
    ).all() as unknown as FlowEventRow[];
    const grouped: Record<string, FlowEvent[]> = {};
    for (const row of rows) (grouped[row.aggregate_id] ??= []).push((JSON.parse(row.event_data) as { flowEvent: FlowEvent }).flowEvent);
    return Object.values(grouped).map((events) => reduceFlowEvents(null, events));
  }

  public getReceipt(commandId: string, requestFingerprint: string): FlowCommandReceipt | null {
    const row = this.database.prepare(
      "SELECT request_fingerprint, response_json FROM command_receipts WHERE command_id = ?",
    ).get(commandId) as unknown as ReceiptRow | undefined;
    if (row === undefined) return null;
    if (row.request_fingerprint !== requestFingerprint) throw new Error("IDEMPOTENCY_KEY_REUSED");
    return JSON.parse(row.response_json) as FlowCommandReceipt;
  }

  public commit(input: FlowCommit): FlowCommandReceipt {
    const recordedAt = this.now().toISOString();
    const receipt = this.journal.commitCommand({
      commandId: input.commandId,
      requestFingerprint: input.requestFingerprint,
      projectId: this.projectId(input),
      aggregateId: `run:${input.runId}`,
      expectedVersion: input.expectedVersion,
      actor: { actorId: "flow-engine", correlationId: input.commandId },
      events: input.events.map((flowEvent, index) => ({
        eventId: `evt_flow_${canonicalSha256({ commandId: input.commandId, index }).slice(0, 24)}`,
        eventType: "FlowEvent",
        eventData: { flowEvent },
        schemaVersion: 1,
        occurredAt: recordedAt,
      })),
      operations: input.operations ?? [],
      response: { commandId: input.commandId, response: input.response },
    });
    return receipt.response as FlowCommandReceipt;
  }

  private projectId(input: FlowCommit): ProjectId {
    const started = input.events.find((event) => event.type === "RunStarted");
    if (started?.type === "RunStarted") return started.binding.projectId;
    const state = this.loadRun(input.runId);
    if (state === null) throw new Error("FLOW_RUN_NOT_FOUND");
    return state.binding.projectId;
  }
}

export interface SqliteServiceRepositories extends StartRunRepositories, PublishChangeRepositories, FlowDefinitions {
  getExecutionPlan(executionPlanId: string): Readonly<ExecutionPlan> | null;
  getWorkflowRevision(workflowRevisionId: string): Readonly<WorkflowRevision> | null;
}

export function createSqliteApplicationServices(input: {
  readonly database: DatabaseSync;
  readonly repositories?: SqliteServiceRepositories | undefined;
  readonly externalHandler: ExternalOperationHandler;
  readonly installSecret: string;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly capabilityReceiptFor?: ((operation: ExternalOperation) => CapabilityProbeReceipt | null) | undefined;
  readonly now?: (() => Date) | undefined;
}) {
  const now = input.now ?? (() => new Date());
  const journal = new SqliteOperationJournal(input.database);
  const repositories: SqliteServiceRepositories = input.repositories ?? new SqliteDefinitionRepository(input.database);
  const flowStore = new SqliteFlowStore(input.database, journal, now);
  const flowEngine = new FlowEngine(flowStore, repositories);
  const eventReader = new EventLedgerReader(input.database);
  const projectionRunner = new ProjectionRunner(input.database, [new HunterProjection()]);
  const leaseService = new LeaseService(input.database);
  const runtimeManager = new RuntimeManager(input.database, flowEngine, {
    resolve: (operation) => {
      if (operation.runId === null) throw new Error("ASSIGNMENT_RUN_SCOPE_REQUIRED");
      const run = flowStore.loadRun(operation.runId);
      if (run === null) throw new Error("ASSIGNMENT_RUN_NOT_FOUND");
      const workflow = repositories.getWorkflowRevision(run.binding.workflowRevisionId);
      const active = [...run.steps].reverse().find(({ conclusion }) => conclusion === "active");
      const step = workflow?.steps.find(({ stepId }) => stepId === active?.stepId);
      if (step === undefined) throw new Error("ASSIGNMENT_STEP_NOT_FOUND");
      const policy = deriveStepPolicy(step, { policyVersion: run.binding.policySnapshot.policyVersion, deniedPermissions: [] });
      const capabilityReceipt = input.capabilityReceiptFor?.(operation);
      if (capabilityReceipt === undefined || capabilityReceipt === null) throw new Error("CAPABILITY_RECEIPT_NOT_CONFIGURED");
      const rows = input.database.prepare("SELECT receipt_json FROM lease_records WHERE expires_at > ?").all(now().toISOString()) as unknown as Array<{ receipt_json: string }>;
      const leases = rows.map((row) => LeaseSchema.parse(JSON.parse(row.receipt_json))) as Lease[];
      const workspaceId = operation.operationType === "session.launch" ? operation.payload.workspaceId : null;
      const scoped = workspaceId === null ? leases : leases.filter((lease) => lease.kind === "controller" || lease.scope.workspaceId === workspaceId);
      const workspaceOwner = scoped.find((lease) => lease.kind === "workspace")?.ownerId;
      const requiredLeaseIds = scoped.filter((lease) => workspaceOwner === undefined || lease.ownerId === workspaceOwner).map(({ leaseId }) => leaseId);
      return { policyDecision: policy.decision, capabilityReceipt, requiredLeaseIds, now: now() };
    },
  });
  const operationHandler = new RuntimeOperationHandler(input.externalHandler);
  const operationWorker = new OperationWorker(input.database, operationHandler, { ownerId: "hunterd", replayPolicy: () => "inspectable" });
  const authenticator = new LocalAuthenticator(input.installSecret);
  const eventStream = new DurableEventStream(eventReader);
  const startRun = new StartRunService(repositories, flowEngine);
  const publishChange = new PublishChangeService(repositories, journal, now);
  const recovery = new StartupRecoveryCoordinator({
    validateStorage: async () => {
      const integrity = input.database.prepare("PRAGMA integrity_check").get() as { integrity_check?: string };
      if (integrity.integrity_check !== "ok") throw new Error("STORAGE_INTEGRITY_FAILED");
      const foreignKeys = input.database.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number };
      if (foreignKeys.foreign_keys !== 1) throw new Error("STORAGE_FOREIGN_KEYS_DISABLED");
      return [];
    },
    reconcileMigration: async () => [],
    reconcileOutbox: async () => {
      const timestamp = now().toISOString();
      const rows = input.database.prepare(
        "SELECT operation_id, run_id FROM outbox WHERE status = 'in_flight' AND dispatch_expires_at <= ?",
      ).all(timestamp) as unknown as Array<{ operation_id: string; run_id: string | null }>;
      for (const row of rows) input.database.prepare(
        "UPDATE outbox SET status = 'indeterminate', dispatch_owner = NULL, dispatch_expires_at = NULL, updated_at = ? WHERE operation_id = ?",
      ).run(timestamp, row.operation_id);
      return rows.map((row) => ({ kind: "operation", status: "indeterminate", reason: "expired_dispatch_outcome_unproven", operationId: row.operation_id, runId: row.run_id }));
    },
    enumerateActiveAttempts: async () => flowStore.allRuns()
      .filter((state) => !["succeeded", "failed", "canceled"].includes(state.status))
      .map((state) => ({ kind: "run", runId: state.binding.runId, status: state.status, version: state.version })),
    probeExternalState: async (attempts) => attempts.map((attempt) => ({
      kind: "session",
      runId: attempt.runId,
      status: "needs_attention",
      reason: "external_state_not_proven",
    })),
    reconcileLeasesAndWorkspace: async () => {
      const rows = input.database.prepare(
        "SELECT lease_id, lease_kind FROM lease_records WHERE expires_at <= ?",
      ).all(now().toISOString()) as unknown as Array<{ lease_id: string; lease_kind: string }>;
      return rows.map((row) => ({ kind: "lease", leaseId: row.lease_id, leaseKind: row.lease_kind, status: "needs_attention", reason: "lease_expired" }));
    },
    validateProjections: async () => {
      const checkpoint = input.database.prepare("SELECT COALESCE(MAX(last_position), 0) AS position FROM projection_checkpoints").get() as { position: number };
      if (checkpoint.position > eventReader.highWaterPosition()) throw new Error("PROJECTION_CHECKPOINT_AHEAD_OF_LEDGER");
      projectionRunner.rebuild("hunter");
      return [];
    },
    submitRecoveryConclusions: async (facts) => {
      const receipts: unknown[] = [];
      for (const state of flowStore.allRuns()) {
        const runFacts = facts.filter((fact) => fact.runId === state.binding.runId && (fact.status === "indeterminate" || fact.status === "needs_attention"));
        if (runFacts.length === 0) continue;
        const normalized = runFacts.map((fact) => ({ kind: fact.kind, status: fact.status as "indeterminate" | "needs_attention", reason: typeof fact.reason === "string" ? fact.reason : "recovery_attention" }));
        if (normalized.every((fact) => state.recoveryFacts.some((stored) => canonicalSha256(stored) === canonicalSha256(fact)))) continue;
        receipts.push(flowEngine.handle({
          type: "RecordRecoveryFacts",
          runId: state.binding.runId,
          facts: normalized,
          expectedVersion: state.version,
          idempotencyKey: `recovery-${canonicalSha256({ runId: state.binding.runId, facts: normalized }).slice(0, 32)}`,
          actor: { actorId: "startup-recovery", correlationId: `recovery:${state.binding.runId}` },
        }));
      }
      return receipts;
    },
  });
  return {
    journal,
    flowStore,
    flowEngine,
    eventReader,
    projectionRunner,
    eventStream,
    leaseService,
    runtimeManager,
    operationWorker,
    authenticator,
    recovery,
    startRun,
    publishChange,
    repositories,
    allowedHosts: input.allowedHosts,
    allowedOrigins: input.allowedOrigins,
  };
}
