import type { DatabaseSync } from "node:sqlite";

import { StartRunService, type StartRunRepositories } from "@hunter/application";
import type { ExecutionPlan, ProjectId, TaskId, WorkflowRevision } from "@hunter/domain";
import { canonicalSha256 } from "@hunter/domain";
import { FlowEngine, reduceFlowEvents, type FlowCommandReceipt, type FlowCommit, type FlowDefinitions, type FlowEvent, type FlowStore, type WorkflowRunState } from "@hunter/flow-engine";
import type { ExternalOperationHandler } from "@hunter/runtime-contracts";
import { LeaseService, RuntimeManager, RuntimeOperationHandler } from "@hunter/runtime-manager";
import { EventLedgerReader, OperationWorker, SqliteOperationJournal } from "@hunter/storage";

import { LocalAuthenticator } from "../auth/local-authenticator.js";
import { DurableEventStream } from "../events/durable-event-stream.js";
import { StartupRecoveryCoordinator } from "../startup/startup-recovery-coordinator.js";

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
  ) {}

  public loadRun(runId: string): WorkflowRunState | null {
    const rows = this.database.prepare(
      "SELECT aggregate_id, event_data FROM events WHERE aggregate_id = ? AND event_type = 'FlowEvent' ORDER BY aggregate_version",
    ).all(`run:${runId}`) as unknown as FlowEventRow[];
    if (rows.length === 0) return null;
    return reduceFlowEvents(null, rows.map((row) => (JSON.parse(row.event_data) as { flowEvent: FlowEvent }).flowEvent));
  }

  public activeTaskIds(parentRunId: string): readonly TaskId[] {
    const rows = this.database.prepare(
      "SELECT aggregate_id, event_data FROM events WHERE event_type = 'FlowEvent' ORDER BY aggregate_id, aggregate_version",
    ).all() as unknown as FlowEventRow[];
    const grouped: Record<string, FlowEvent[]> = {};
    for (const row of rows) (grouped[row.aggregate_id] ??= []).push((JSON.parse(row.event_data) as { flowEvent: FlowEvent }).flowEvent);
    return Object.values(grouped)
      .map((events) => reduceFlowEvents(null, events))
      .filter((state) => state.binding.subjectKind === "task" && state.binding.parentRunId === parentRunId && !["succeeded", "failed", "canceled"].includes(state.status))
      .flatMap((state) => state.binding.subjectKind === "task" ? [state.binding.taskId] : []);
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
    const recordedAt = new Date().toISOString();
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
      operations: [],
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

export interface SqliteServiceRepositories extends StartRunRepositories, FlowDefinitions {
  getExecutionPlan(executionPlanId: string): Readonly<ExecutionPlan> | null;
  getWorkflowRevision(workflowRevisionId: string): Readonly<WorkflowRevision> | null;
}

export function createSqliteApplicationServices(input: {
  readonly database: DatabaseSync;
  readonly repositories: SqliteServiceRepositories;
  readonly externalHandler: ExternalOperationHandler;
  readonly installSecret: string;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
}) {
  const journal = new SqliteOperationJournal(input.database);
  const flowStore = new SqliteFlowStore(input.database, journal);
  const flowEngine = new FlowEngine(flowStore, input.repositories);
  const eventReader = new EventLedgerReader(input.database);
  const leaseService = new LeaseService(input.database);
  const runtimeManager = new RuntimeManager(input.database, journal);
  const operationHandler = new RuntimeOperationHandler(input.externalHandler);
  const operationWorker = new OperationWorker(input.database, operationHandler, { ownerId: "hunterd", replayPolicy: () => "inspectable" });
  const authenticator = new LocalAuthenticator(input.installSecret);
  const eventStream = new DurableEventStream(eventReader);
  const startRun = new StartRunService(input.repositories, flowEngine);
  const recovery = new StartupRecoveryCoordinator({
    validateStorage: async () => {
      const integrity = input.database.prepare("PRAGMA integrity_check").get() as { integrity_check?: string };
      if (integrity.integrity_check !== "ok") throw new Error("STORAGE_INTEGRITY_FAILED");
      return [];
    },
    reconcileMigration: async () => [],
    reconcileOutbox: async () => [],
    enumerateActiveAttempts: async () => [],
    probeExternalState: async () => [],
    reconcileLeasesAndWorkspace: async () => [],
    validateProjections: async () => [],
    submitRecoveryConclusions: async (facts) => ({ commandId: `recovery:${canonicalSha256(facts)}`, facts: facts.length }),
  });
  return {
    journal,
    flowStore,
    flowEngine,
    eventReader,
    eventStream,
    leaseService,
    runtimeManager,
    operationWorker,
    authenticator,
    recovery,
    startRun,
    allowedHosts: input.allowedHosts,
    allowedOrigins: input.allowedOrigins,
  };
}
