import type { DatabaseSync } from "node:sqlite";
import { accessSync, constants, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, join } from "node:path";

import { PublishChangeService, StartRunService, type PublishChangeRepositories, type StartRunRepositories } from "@hunter/application";
import type { ExecutionPlan, NativeSessionId, ProjectId, TaskId, WorkflowRevision, WorktreeId } from "@hunter/domain";
import { ControllerLeaseIdSchema, LeaseOwnerIdSchema, OperationIdSchema, ProjectIdSchema, WorkspaceLeaseIdSchema, WriterLeaseIdSchema, canonicalSha256, createProject } from "@hunter/domain";
import { FlowEngine, reduceFlowEvents, type FlowCommandReceipt, type FlowCommit, type FlowDefinitions, type FlowEvent, type FlowStore, type WorkflowRunState } from "@hunter/flow-engine";
import { ArchiveJobWorker, ArchiveWriter, SqliteArchiveJobStore, SqliteKnowledgeCatalog, type ArchiveJobFaultPoint, type ArchiveManifestSource } from "@hunter/knowledge";
import { ExternalOperationReceiptSchema, LeaseSchema, computeCapabilityManifest, createExternalOperation, createWorkspacePathBoundary, decodeCapabilityProbeReceipt, decodeExternalOperationReceipt, type CapabilityProbeReceipt, type ExternalOperation, type ExternalOperationHandler, type Lease, type VerifiedWorkspacePath } from "@hunter/runtime-contracts";
import { deriveStepPolicy } from "@hunter/policy";
import { LeaseService, RuntimeManager, RuntimeOperationHandler } from "@hunter/runtime-manager";
import { EventLedgerReader, HunterProjection, OperationWorker, ProjectionRunner, SqliteOperationJournal } from "@hunter/storage";

import { LocalAuthenticator } from "../auth/local-authenticator.js";
import { DurableEventStream } from "../events/durable-event-stream.js";
import { StartupRecoveryCoordinator, type RecoveryFact } from "../startup/startup-recovery-coordinator.js";
import { SqliteDefinitionRepository } from "./sqlite-definition-repository.js";
import { SqliteAttemptObservation } from "./sqlite-attempt-observation.js";
import { RunCoordinator } from "./run-coordinator.js";

interface ReceiptRow {
  readonly request_fingerprint: string;
  readonly response_json: string;
}

interface FlowEventRow {
  readonly aggregate_id: string;
  readonly event_data: string;
}

function withoutLeaseGeneration<T extends Lease>(
  lease: T,
): Omit<T, "generation"> {
  const { generation, ...template } = lease;
  void generation;
  return template;
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
  readonly leaseRecoveryObservationFor?: ((lease: Lease) => {
    readonly worktreeId?: WorktreeId | undefined;
    readonly nativeSessionId?: NativeSessionId | undefined;
  } | null) | undefined;
  readonly verifiedWorkspacePathForLease?: ((lease: Lease) => VerifiedWorkspacePath | null) | undefined;
  readonly resolveAuthorizedProjectIds?: ((principalId: string) => readonly ProjectId[] | undefined) | undefined;
  readonly now?: (() => Date) | undefined;
  readonly contentDirectory?: string | undefined;
  readonly archive?: {
    readonly root: string;
    readonly source: ArchiveManifestSource;
    readonly ownerId: ReturnType<typeof LeaseOwnerIdSchema.parse>;
    readonly leaseDurationMs?: number | undefined;
    readonly fault?: ((point: ArchiveJobFaultPoint) => void) | undefined;
  } | undefined;
}) {
  const now = input.now ?? (() => new Date());
  const archiveJobStore = input.archive === undefined
    ? undefined
    : new SqliteArchiveJobStore(input.database);
  const journal = new SqliteOperationJournal(input.database, {
    scheduleTerminalRunArchive: archiveJobStore === undefined
      ? undefined
      : (schedule) => {
          archiveJobStore.schedule(schedule);
        },
  });
  const knowledgeCatalog = input.archive === undefined
    ? undefined
    : new SqliteKnowledgeCatalog(input.database, now);
  const archiveWorker = input.archive === undefined || archiveJobStore === undefined || knowledgeCatalog === undefined
    ? undefined
    : new ArchiveJobWorker({
        store: archiveJobStore,
        writer: new ArchiveWriter(join(input.archive.root, "archives")),
        catalog: knowledgeCatalog,
        source: input.archive.source,
        ownerId: input.archive.ownerId,
        now,
        ...(input.archive.leaseDurationMs === undefined
          ? {}
          : { leaseDurationMs: input.archive.leaseDurationMs }),
        ...(input.archive.fault === undefined
          ? {}
          : { fault: input.archive.fault }),
      });
  input.database.exec(`CREATE TABLE IF NOT EXISTS principal_project_authorizations (
    principal_id TEXT PRIMARY KEY,
    project_ids_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`);
  const defaultAuthorizationResolver = (principalId: string): readonly ProjectId[] | undefined => {
    const row = input.database.prepare("SELECT project_ids_json FROM principal_project_authorizations WHERE principal_id = ?").get(principalId) as { project_ids_json: string } | undefined;
    return row === undefined ? undefined : ProjectIdSchema.array().parse(JSON.parse(row.project_ids_json));
  };
  const setPrincipalProjectAuthorization = (principalId: string, projectIds: readonly ProjectId[]) => {
    const normalizedPrincipalId = principalId.trim();
    if (normalizedPrincipalId.length === 0) throw new Error("PRINCIPAL_ID_REQUIRED");
    const normalizedProjectIds = ProjectIdSchema.array().parse([...new Set(projectIds)].sort());
    input.database.prepare(`INSERT INTO principal_project_authorizations(principal_id, project_ids_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(principal_id) DO UPDATE SET project_ids_json = excluded.project_ids_json, updated_at = excluded.updated_at`)
      .run(normalizedPrincipalId, JSON.stringify(normalizedProjectIds), now().toISOString());
  };
  const repositories: SqliteServiceRepositories = input.repositories ?? new SqliteDefinitionRepository(input.database);
  const flowStore = new SqliteFlowStore(input.database, journal, now);
  const flowEngine = new FlowEngine(flowStore, repositories, now);
  const runCoordinator = new RunCoordinator({
    store: flowStore,
    definitions: repositories,
    commands: flowEngine,
  });
  const reconcileCancellationRequests = async () => {
    const receipts: FlowCommandReceipt[] = [];
    for (let round = 0; round < 100; round += 1) {
      let progressed = false;
      const attemptCancellations = flowStore.allRuns().filter((state) => !["succeeded", "failed", "canceled"].includes(state.status) && state.attemptCancellation !== null);
      for (const state of attemptCancellations) {
        const pending = state.attemptCancellation!;
        const launchRow = input.database.prepare("SELECT operation_json FROM outbox WHERE operation_id = ?").get(pending.assignmentOperationId) as { operation_json: string } | undefined;
        const launchReceiptRow = input.database.prepare("SELECT provider_receipt_json FROM side_effect_receipts WHERE operation_id = ? AND observed_status = 'completed'").get(pending.assignmentOperationId) as { provider_receipt_json: string } | undefined;
        if (launchRow === undefined || launchReceiptRow === undefined) continue;
        const launch = JSON.parse(launchRow.operation_json) as ExternalOperation;
        if (launch.runId !== state.binding.runId || launch.attemptId !== pending.attemptId || launch.operationType !== "session.launch") {
          throw new Error("CANCELLATION_LAUNCH_SCOPE_MISMATCH");
        }
        const launchReceipt = ExternalOperationReceiptSchema.parse(JSON.parse(launchReceiptRow.provider_receipt_json));
        const session = launchReceipt.nativeReferences.find((reference) => reference.kind === "session");
        if (session === undefined) continue;
        const controllerRows = input.database.prepare("SELECT receipt_json FROM lease_records WHERE lease_kind = 'controller' AND expires_at > ?").all(now().toISOString()) as Array<{ receipt_json: string }>;
        const controller = controllerRows.map((row) => LeaseSchema.parse(JSON.parse(row.receipt_json))).find((lease) => lease.kind === "controller" && lease.scope.nativeSessionId === session.referenceId);
        if (controller === undefined) continue;
        const interruptOperationId = OperationIdSchema.parse(`opn_${canonicalSha256({ runId: state.binding.runId, attemptId: pending.attemptId, sessionId: session.referenceId, action: "interrupt" }).slice(0, 24)}`);
        const interrupt = createExternalOperation({ schemaVersion: 1, operationId: interruptOperationId, projectId: state.binding.projectId, runId: state.binding.runId, attemptId: pending.attemptId, operationVersion: 2, operationType: "session.interrupt", requestedCapabilities: ["interrupt"], payload: { nativeSessionId: session.referenceId, reason: "hunter_run_canceled", controllerLeaseId: controller.leaseId, controllerLeaseOwnerId: controller.ownerId, controllerLeaseGeneration: controller.generation } });
        const aggregateId = `cancellation:${state.binding.runId}`;
        const version = (input.database.prepare("SELECT COALESCE(MAX(aggregate_version), 0) AS version FROM events WHERE aggregate_id = ?").get(aggregateId) as { version: number }).version;
        journal.commitCommand({ commandId: `schedule-interrupt:${state.binding.runId}:${pending.attemptId}`, requestFingerprint: canonicalSha256(interrupt), projectId: state.binding.projectId, aggregateId, expectedVersion: version, actor: { actorId: "flow-cancellation-reconciler", correlationId: `cancel:${state.binding.runId}` }, events: [], operations: [interrupt], response: { operationId: interrupt.operationId } });
        for (let delivery = 0; delivery < 1_000; delivery += 1) {
          const status = input.database.prepare("SELECT status FROM outbox WHERE operation_id = ?").get(interrupt.operationId) as { status: string } | undefined;
          if (status !== undefined && !["pending", "in_flight"].includes(status.status)) break;
          if (await operationWorker.runOnce() === "idle") break;
        }
        const interruptReceiptRow = input.database.prepare("SELECT provider_receipt_json FROM side_effect_receipts WHERE operation_id = ? AND observed_status = 'completed'").get(interrupt.operationId) as { provider_receipt_json: string } | undefined;
        if (interruptReceiptRow === undefined) continue;
        const interruptReceipt = ExternalOperationReceiptSchema.parse(JSON.parse(interruptReceiptRow.provider_receipt_json));
        const current = flowStore.loadRun(state.binding.runId);
        if (current === null || current.attemptCancellation === null) continue;
        receipts.push(flowEngine.handle({ type: "AcknowledgeAttemptCancellation", runId: current.binding.runId, interruptOperationId: interrupt.operationId, evidenceFingerprint: interruptReceipt.evidence.evidenceHash, expectedVersion: current.version, idempotencyKey: `ack-interrupt-${interrupt.operationId}`, actor: { actorId: "flow-cancellation-reconciler", correlationId: `cancel:${current.binding.runId}` } }));
        progressed = true;
      }
      const parents = flowStore.allRuns().filter((state) => !["succeeded", "failed", "canceled"].includes(state.status) && state.cancellationRequestedChildRunIds.length > 0);
      for (const parent of parents) {
        for (const childRunId of parent.cancellationRequestedChildRunIds) {
          const child = flowStore.loadRun(childRunId);
          if (child !== null && !["succeeded", "failed", "canceled"].includes(child.status) && child.cancellationRequestedChildRunIds.length === 0) {
            receipts.push(flowEngine.handle({ type: "CancelRun", runId: child.binding.runId, expectedVersion: child.version, idempotencyKey: `cascade-cancel-${parent.binding.runId}-${child.binding.runId}`, actor: { actorId: "flow-cancellation-reconciler", correlationId: `cancel:${parent.binding.runId}` } }));
            progressed = true;
          }
        }
      }
      for (const parent of parents) {
        const current = flowStore.loadRun(parent.binding.runId);
        if (current === null || ["succeeded", "failed", "canceled"].includes(current.status)) continue;
        if (current.cancellationRequestedChildRunIds.every((childRunId) => {
          const child = flowStore.loadRun(childRunId);
          return child !== null && ["succeeded", "failed", "canceled"].includes(child.status);
        })) {
          receipts.push(flowEngine.handle({ type: "ReconcileChildCancellations", runId: current.binding.runId, expectedVersion: current.version, idempotencyKey: `cascade-reconcile-${current.binding.runId}`, actor: { actorId: "flow-cancellation-reconciler", correlationId: `cancel:${current.binding.runId}` } }));
          progressed = true;
        }
      }
      if (!progressed) return receipts;
    }
    throw new Error("CHILD_CANCELLATION_RECONCILIATION_LIMIT");
  };
  const eventReader = new EventLedgerReader(input.database);
  const projectionRunner = new ProjectionRunner(input.database, [new HunterProjection()]);
  const leaseService = new LeaseService(input.database, now);
  const deterministicLeaseId = (
    prefix: "wsl" | "wrl" | "ctl" | "own",
    value: unknown,
  ): string => `${prefix}_${canonicalSha256(value).slice(0, 24)}`;
  const persistedDeviceBindingFor = (
    operation: Extract<ExternalOperation, { operationType: "workspace.prepare" }>,
  ) => {
    const rows = input.database.prepare(
      `SELECT event_data
         FROM events
        WHERE aggregate_id = ? AND event_type = 'ProjectCreated'
        ORDER BY position DESC`,
    ).all(`project:${operation.projectId}`) as Array<{ event_data: string }>;
    for (const row of rows) {
      try {
        const eventData = JSON.parse(row.event_data) as {
          readonly projectId?: unknown;
          readonly project?: unknown;
        };
        const project = createProject(eventData.project);
        if (
          project.projectId !== operation.projectId
          || eventData.projectId !== operation.projectId
          || !project.repositoryBindings.some(
            ({ repositoryId }) =>
              repositoryId === operation.payload.repositoryId,
          )
        ) {
          continue;
        }
        const binding = project.deviceBindings.find(
          ({ deviceBindingId }) =>
            deviceBindingId === operation.payload.deviceBindingId,
        );
        if (
          binding === undefined
          || binding.repositoryId !== operation.payload.repositoryId
          || binding.availability !== "available"
          || !isAbsolute(binding.localPath)
        ) {
          continue;
        }
        return binding;
      } catch {
        continue;
      }
    }
    throw new Error("PERSISTED_DEVICE_BINDING_SCOPE_REQUIRED");
  };
  const inspectGitWorkspace = (
    workspacePath: string,
    args: readonly string[],
  ): string => {
    try {
      return execFileSync("git", ["-C", workspacePath, ...args], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5_000,
      }).trim();
    } catch {
      throw new Error("GIT_WORKSPACE_INSPECTION_FAILED");
    }
  };
  const acquireWorkspaceLease = async (
    operation: ExternalOperation,
  ) => {
    if (operation.operationType !== "workspace.prepare") {
      throw new Error("WORKSPACE_PREPARE_OPERATION_REQUIRED");
    }
    if (operation.runId === null || operation.attemptId === null) {
      throw new Error("WORKSPACE_LEASE_RUN_SCOPE_REQUIRED");
    }
    const binding = persistedDeviceBindingFor(operation);
    const boundary = createWorkspacePathBoundary(
      new Map([[operation.payload.repositoryId, binding.localPath]]),
    );
    const verifiedRepositoryPath = boundary.verify(
      operation.payload.repositoryId,
      binding.localPath,
    );
    const topLevel = inspectGitWorkspace(
      verifiedRepositoryPath,
      ["rev-parse", "--show-toplevel"],
    );
    const verifiedTopLevel = boundary.verify(operation.payload.repositoryId, topLevel);
    const gitHead = inspectGitWorkspace(
      verifiedRepositoryPath,
      ["rev-parse", "HEAD"],
    );
    if (gitHead !== operation.payload.baselineRevision) {
      throw new Error("WORKSPACE_BASELINE_MISMATCH");
    }
    const branch = inspectGitWorkspace(
      verifiedRepositoryPath,
      ["branch", "--show-current"],
    );
    const acquiredAt = now();
    return leaseService.acquireNext({
      schemaVersion: 2,
      projectId: operation.projectId,
      repositoryId: operation.payload.repositoryId,
      deviceBindingId: operation.payload.deviceBindingId,
      canonicalWorkspaceKey: boundary.canonicalKey(verifiedTopLevel),
      gitHead,
      branch,
      ownerRunId: operation.runId,
      ownerAttemptId: operation.attemptId,
      kind: "workspace",
      leaseId: WorkspaceLeaseIdSchema.parse(deterministicLeaseId("wsl", operation)),
      ownerId: LeaseOwnerIdSchema.parse(deterministicLeaseId("own", {
        runId: operation.runId,
        attemptId: operation.attemptId,
        workspaceId: operation.payload.workspaceId,
      })),
      mode: operation.payload.mode,
      acquiredAt: acquiredAt.toISOString(),
      expiresAt: new Date(acquiredAt.getTime() + 30 * 60_000).toISOString(),
      revokedAt: null,
      revocationReason: null,
      scope: { workspaceId: operation.payload.workspaceId },
    });
  };
  const activeLeasesFor = (operation: ExternalOperation): readonly Lease[] =>
    (input.database.prepare(
      "SELECT receipt_json FROM lease_records WHERE expires_at > ?",
    ).all(now().toISOString()) as Array<{ receipt_json: string }>).flatMap(
      (row) => {
        try {
          const lease = LeaseSchema.parse(JSON.parse(row.receipt_json));
          return lease.revokedAt === null ? [lease] : [];
        } catch {
          return [];
        }
      },
    ).filter((lease) =>
      lease.projectId === operation.projectId
      && lease.ownerRunId === operation.runId
      && lease.ownerAttemptId === operation.attemptId
    );
  const runtimeManager = new RuntimeManager(input.database, flowEngine, {
    resolve: (operation) => {
      if (operation.runId === null) throw new Error("ASSIGNMENT_RUN_SCOPE_REQUIRED");
      const run = flowStore.loadRun(operation.runId);
      if (run === null) throw new Error("ASSIGNMENT_RUN_NOT_FOUND");
      const workflow = repositories.getWorkflowRevision(run.binding.workflowRevisionId);
      const active = [...run.steps].reverse().find(({ conclusion }) => conclusion === "active");
      const step = workflow?.steps.find(({ stepId }) => stepId === active?.stepId);
      if (step === undefined) throw new Error("ASSIGNMENT_STEP_NOT_FOUND");
      if (active?.attempts.at(-1)?.attemptId !== operation.attemptId) throw new Error("ASSIGNMENT_ATTEMPT_MISMATCH");
      if (operation.operationType !== "session.launch" || step.kind !== "agent" || step.executor.kind !== "runtime_agent") throw new Error("ASSIGNMENT_OPERATION_TYPE_MISMATCH");
      if (run.binding.subjectKind !== "task") throw new Error("ASSIGNMENT_TASK_SCOPE_REQUIRED");
      const plan = repositories.getExecutionPlan(run.binding.executionPlanId);
      const task = plan?.tasks.find(({ taskId }) => taskId === run.binding.taskId);
      if (task === undefined) throw new Error("ASSIGNMENT_TASK_NOT_FOUND");
      if (!step.agentProfileSelector?.agentProfileIds.includes(task.defaultAgentProfileId)) throw new Error("ASSIGNMENT_PROFILE_NOT_ALLOWED_BY_STEP");
      if (canonicalSha256(task.workspacePolicy) !== canonicalSha256(step.workspacePolicy)) throw new Error("ASSIGNMENT_WORKSPACE_POLICY_MISMATCH");
      const policy = deriveStepPolicy(step, { policyVersion: run.binding.policySnapshot.policyVersion, deniedPermissions: [] });
      const capabilityReceipt = input.capabilityReceiptFor?.(operation);
      if (capabilityReceipt === undefined || capabilityReceipt === null) throw new Error("CAPABILITY_RECEIPT_NOT_CONFIGURED");
      const rows = input.database.prepare("SELECT receipt_json FROM lease_records WHERE expires_at > ?").all(now().toISOString()) as unknown as Array<{ receipt_json: string }>;
      const leases = rows.map((row) => LeaseSchema.parse(JSON.parse(row.receipt_json))) as Lease[];
      const workspaceCandidates = leases.flatMap((lease) =>
        lease.kind === "workspace"
        && lease.revokedAt === null
        && lease.projectId === operation.projectId
        && lease.ownerRunId === operation.runId
        && lease.ownerAttemptId === operation.attemptId
        && task.repositoryIds.includes(lease.repositoryId)
          ? [lease]
          : [],
      );
      if (workspaceCandidates.length !== 1) throw new Error("ASSIGNMENT_AUTHORITATIVE_WORKSPACE_REQUIRED");
      const workspaceId = workspaceCandidates[0]!.scope.workspaceId;
      const scoped = leases.filter((lease) => lease.kind !== "controller" && lease.scope.workspaceId === workspaceId);
      const workspaceOwner = scoped.find((lease) => lease.kind === "workspace")?.ownerId;
      const requiredLeaseIds = scoped.filter((lease) => workspaceOwner === undefined || lease.ownerId === workspaceOwner).map(({ leaseId }) => leaseId);
      const expectedMode = step.workspacePolicy.mode === "write" ? "write" : "read_only";
      if (workspaceCandidates[0]!.mode !== expectedMode) throw new Error("ASSIGNMENT_WORKSPACE_MODE_MISMATCH");
      const writerLeases = scoped.flatMap((lease) => lease.kind === "writer" && lease.ownerId === workspaceOwner ? [lease] : []);
      if (step.workspacePolicy.isolation === "worktree" && (writerLeases.length !== 1 || writerLeases[0]!.scope.worktreeId === null)) throw new Error("ASSIGNMENT_WORKTREE_LEASE_REQUIRED");
      const usedLeaseIds = new Set(flowStore.allRuns().filter((candidate) => !["succeeded", "failed", "canceled"].includes(candidate.status)).flatMap((candidate) => candidate.steps.flatMap(({ attempts }) => attempts.flatMap((attempt) => attempt.assignment === undefined || attempt.attemptId === operation.attemptId || ["failed", "canceled", "returned", "stale"].includes(attempt.executionStatus) ? [] : attempt.assignment.leaseIds))));
      if (requiredLeaseIds.some((leaseId) => usedLeaseIds.has(leaseId))) throw new Error("ASSIGNMENT_LEASE_ALREADY_BOUND");
      return {
        policyDecision: policy.decision,
        capabilityReceipt,
        requiredLeaseIds,
        now: now(),
        expected: {
          projectId: run.binding.projectId,
          runId: run.binding.runId,
          attemptId: active.attempts.at(-1)!.attemptId,
          operationType: "session.launch" as const,
          requestedCapabilities: step.requiredCapabilities,
          agentProfileId: task.defaultAgentProfileId,
          workspaceId,
          repositoryIds: task.repositoryIds,
        },
      };
    },
  });
  const operationHandler = new RuntimeOperationHandler(input.externalHandler);
  const operationWorker = new OperationWorker(input.database, operationHandler, {
    ownerId: "hunterd",
    now,
    replayPolicy: () => "inspectable",
    dispatchAuthority: (operation) => {
      const activeLeases = (input.database.prepare(
        "SELECT receipt_json FROM lease_records WHERE expires_at > ?",
      ).all(now().toISOString()) as Array<{ receipt_json: string }>).flatMap((row) => {
        try {
          const lease = LeaseSchema.parse(JSON.parse(row.receipt_json));
          return lease.revokedAt === null ? [lease] : [];
        } catch {
          return [];
        }
      }).filter((lease) =>
        lease.projectId === operation.projectId
        && lease.ownerRunId === operation.runId
        && lease.ownerAttemptId === operation.attemptId
      );
      if (
        operation.operationType === "session.observe"
        || operation.operationType === "session.send"
        || operation.operationType === "session.interrupt"
        || operation.operationType === "session.resume"
      ) {
        if (operation.operationVersion !== 2) return { allowed: false, reason: "controller_lease_authority_version_required" };
        const controller = activeLeases.find((lease) =>
          lease.kind === "controller"
          && lease.leaseId === operation.payload.controllerLeaseId
          && lease.ownerId === operation.payload.controllerLeaseOwnerId
          && lease.generation === operation.payload.controllerLeaseGeneration
          && lease.scope.nativeSessionId === operation.payload.nativeSessionId
        );
        return controller === undefined
          ? { allowed: false, reason: "controller_lease_dispatch_authority_missing" }
          : { allowed: true };
      }
      const workspaceId = operation.payload.workspaceId;
      const workspace = activeLeases.find((lease) =>
        lease.kind === "workspace" && lease.scope.workspaceId === workspaceId
      );
      if (workspace === undefined) {
        return { allowed: false, reason: "workspace_lease_dispatch_authority_missing" };
      }
      if (operation.operationType === "workspace.release") return { allowed: true };
      if (
        operation.operationType === "workspace.prepare"
        && (
          workspace.repositoryId !== operation.payload.repositoryId
          || workspace.deviceBindingId !== operation.payload.deviceBindingId
          || workspace.mode !== operation.payload.mode
          || workspace.gitHead !== operation.payload.baselineRevision
        )
      ) {
        return { allowed: false, reason: "workspace_lease_dispatch_authority_mismatch" };
      }
      const requiresWriter =
        operation.operationType === "session.launch"
        || operation.operationType === "task_pack.write"
        || operation.operationType === "native_surface.open";
      if (!requiresWriter) return { allowed: true };
      const writer = activeLeases.find((lease) =>
        lease.kind === "writer"
        && lease.scope.workspaceId === workspaceId
        && lease.repositoryId === workspace.repositoryId
        && lease.deviceBindingId === workspace.deviceBindingId
        && lease.ownerId === workspace.ownerId
      );
      return writer === undefined
        ? { allowed: false, reason: "writer_lease_dispatch_authority_missing" }
        : { allowed: true };
    },
    prepareReceiptTransaction: (operation, receiptInput) => {
      const receipt = decodeExternalOperationReceipt(receiptInput);
      if (
        receipt.operationId !== operation.operationId
        || receipt.fingerprint !== operation.fingerprint
      ) {
        throw new Error("OPERATION_RECEIPT_IDENTITY_MISMATCH");
      }
      if (receipt.operationStatus !== "completed") return;
      if (operation.operationType === "workspace.prepare" && operation.payload.mode === "write") {
        const prepared = receipt.workspaceResult;
        if (prepared === undefined) {
          throw new Error("PREPARED_WORKSPACE_IDENTITY_NOT_PROVEN");
        }
        const binding = persistedDeviceBindingFor(operation);
        const boundary = createWorkspacePathBoundary(
          new Map([[
            operation.payload.repositoryId,
            binding.localPath,
          ]]),
        );
        const verifiedWorkspacePath = boundary.verify(
          operation.payload.repositoryId,
          prepared.reportedWorkspacePath,
        );
        const topLevel = inspectGitWorkspace(
          verifiedWorkspacePath,
          ["rev-parse", "--show-toplevel"],
        );
        const verifiedTopLevel = boundary.verify(operation.payload.repositoryId, topLevel);
        const gitHead = inspectGitWorkspace(
          verifiedWorkspacePath,
          ["rev-parse", "HEAD"],
        );
        if (gitHead !== operation.payload.baselineRevision) {
          throw new Error("PREPARED_WORKSPACE_BASELINE_MISMATCH");
        }
        const branch = inspectGitWorkspace(
          verifiedWorkspacePath,
          ["branch", "--show-current"],
        );
        const canonicalWorkspaceKey = boundary.canonicalKey(verifiedTopLevel);
        return () => {
          const workspace = activeLeasesFor(operation).find((lease) =>
            lease.kind === "workspace"
            && lease.scope.workspaceId === operation.payload.workspaceId
            && lease.repositoryId === operation.payload.repositoryId
            && lease.deviceBindingId === operation.payload.deviceBindingId
          );
          if (workspace === undefined) {
            throw new Error("WORKSPACE_LEASE_RECEIPT_AUTHORITY_MISSING");
          }
          const workspaceTemplate = withoutLeaseGeneration(workspace);
          leaseService.acquireNext({
            ...workspaceTemplate,
            kind: "writer",
            leaseId: WriterLeaseIdSchema.parse(deterministicLeaseId("wrl", operation)),
            canonicalWorkspaceKey,
            gitHead,
            branch,
            mode: "write",
            scope: {
              workspaceId: operation.payload.workspaceId,
              worktreeId: prepared.worktreeId,
            },
          }, { transaction: "existing" });
        };
      }
      if (operation.operationType === "session.launch") {
        const session = receipt.nativeReferences.find((reference) => reference.kind === "session");
        if (session === undefined) throw new Error("NATIVE_SESSION_RECEIPT_REQUIRED");
        return () => {
          const writer = activeLeasesFor(operation)
            .flatMap((lease) => lease.kind === "writer" ? [lease] : [])
            .find((lease) => lease.scope.workspaceId === operation.payload.workspaceId);
          if (writer === undefined) {
            throw new Error("WRITER_LEASE_RECEIPT_AUTHORITY_MISSING");
          }
          const writerTemplate = withoutLeaseGeneration(writer);
          leaseService.acquireNext({
            ...writerTemplate,
            kind: "controller",
            leaseId: ControllerLeaseIdSchema.parse(deterministicLeaseId("ctl", operation)),
            scope: {
              workspaceId: writer.scope.workspaceId,
              worktreeId: writer.scope.worktreeId,
              nativeSessionId: session.referenceId,
            },
          }, { transaction: "existing" });
        };
      }
      return;
    },
  });
  const attemptObservation = new SqliteAttemptObservation(
    input.database,
    journal,
    operationWorker,
    leaseService,
    input.capabilityReceiptFor,
    now,
  );
  const authenticator = new LocalAuthenticator(input.installSecret, () => false, input.resolveAuthorizedProjectIds ?? defaultAuthorizationResolver);
  const eventStream = new DurableEventStream(eventReader, undefined, undefined, (authorizedProjectIds) => {
    projectionRunner.runIncremental();
    const allowed = new Set<string>(authorizedProjectIds);
    const checkpoint = input.database.prepare("SELECT last_position FROM projection_checkpoints WHERE projector_name = 'hunter'").get() as { last_position?: number } | undefined;
    return { projectionVersion: 1, cursor: checkpoint?.last_position ?? 0, entities: projectionRunner.snapshot("hunter").filter(({ projectId }) => allowed.has(projectId)) };
  });
  const startRun = new StartRunService(repositories, flowEngine);
  const publishChange = new PublishChangeService(repositories, journal, now);
  const recovery = new StartupRecoveryCoordinator({
    validateStorage: async () => {
      const integrity = input.database.prepare("PRAGMA integrity_check").get() as { integrity_check?: string };
      if (integrity.integrity_check !== "ok") throw new Error("STORAGE_INTEGRITY_FAILED");
      const foreignKeys = input.database.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number };
      if (foreignKeys.foreign_keys !== 1) throw new Error("STORAGE_FOREIGN_KEYS_DISABLED");
      const journalMode = input.database.prepare("PRAGMA journal_mode").get() as { journal_mode?: string };
      if (journalMode.journal_mode?.toLowerCase() !== "wal" && journalMode.journal_mode?.toLowerCase() !== "memory") throw new Error("STORAGE_WAL_DISABLED");
      const schema = input.database.prepare("SELECT metadata_value FROM storage_metadata WHERE metadata_key = 'schema_version'").get() as { metadata_value?: string } | undefined;
      if (schema?.metadata_value !== "1") throw new Error("STORAGE_SCHEMA_VERSION_UNSUPPORTED");
      if (input.contentDirectory !== undefined) accessSync(input.contentDirectory, constants.R_OK | constants.W_OK);
      return [];
    },
    reconcileMigration: async () => {
      const marker = input.database.prepare("SELECT metadata_value FROM storage_metadata WHERE metadata_key = 'migration_in_progress'").get() as { metadata_value?: string } | undefined;
      if (marker !== undefined) {
        if (marker.metadata_value !== "target_schema_version:1") throw new Error("INTERRUPTED_MIGRATION_REQUIRES_MANUAL_RECOVERY");
        input.database.exec("BEGIN IMMEDIATE");
        try {
          input.database.prepare("DELETE FROM storage_metadata WHERE metadata_key = 'migration_in_progress'").run();
          input.database.exec("COMMIT");
        } catch (error) {
          input.database.exec("ROLLBACK");
          throw error;
        }
        return [{ kind: "migration", status: "rolled_back", schemaVersion: 1 }];
      }
      return [{ kind: "migration", status: "complete", schemaVersion: 1 }];
    },
    reconcileOutbox: async () => {
      const timestamp = now().toISOString();
      input.database.prepare(
        `UPDATE outbox
            SET status = (SELECT observed_status FROM side_effect_receipts WHERE side_effect_receipts.operation_id = outbox.operation_id),
                dispatch_owner = NULL, dispatch_expires_at = NULL, updated_at = ?
          WHERE EXISTS (SELECT 1 FROM side_effect_receipts WHERE side_effect_receipts.operation_id = outbox.operation_id)
            AND status <> (SELECT observed_status FROM side_effect_receipts WHERE side_effect_receipts.operation_id = outbox.operation_id)`,
      ).run(timestamp);
      for (let index = 0; index < 1_000; index += 1) {
        if (await operationWorker.runOnce() === "idle") break;
        if (index === 999) throw new Error("OUTBOX_RECOVERY_LIMIT_EXCEEDED");
      }
      const rows = input.database.prepare(
        "SELECT operation_id, run_id, attempt_id, status FROM outbox WHERE status IN ('indeterminate','needs_attention') ORDER BY operation_id",
      ).all() as unknown as Array<{ operation_id: string; run_id: string | null; attempt_id: string | null; status: "indeterminate" | "needs_attention" }>;
      return rows.map((row) => ({ kind: "operation", status: row.status, reason: "reconciled_external_operation_not_proven", operationId: row.operation_id, runId: row.run_id, attemptId: row.attempt_id }));
    },
    resumeArchiveAndKnowledge: async () => {
      if (archiveWorker === undefined) return [];
      let completed = 0;
      for (let index = 0; index < 1_000; index += 1) {
        const result = await archiveWorker.runOnce();
        if (result === "idle") {
          return completed === 0
            ? []
            : [{ kind: "archive", status: "completed", completed }];
        }
        if (result === "needs_attention") {
          return [{
            kind: "archive",
            status: "needs_attention",
            reason: "archive_or_knowledge_projection_not_proven",
            completed,
          }];
        }
        completed += 1;
      }
      throw new Error("ARCHIVE_RECOVERY_LIMIT_EXCEEDED");
    },
    enumerateActiveAttempts: async () => flowStore.allRuns()
      .filter((state) => !["succeeded", "failed", "canceled"].includes(state.status))
      .flatMap((state) => state.steps.filter(({ conclusion }) => conclusion === "active").flatMap((step) => {
        const attempt = step.attempts.at(-1);
        return attempt === undefined ? [] : [{ kind: "attempt", runId: state.binding.runId, stepRunId: step.stepRunId, attemptId: attempt.attemptId, executionStatus: attempt.executionStatus, operationId: attempt.assignment?.operationId ?? null, leaseIds: attempt.assignment?.leaseIds ?? [] }];
      })),
    probeExternalState: async (attempts) => await Promise.all(attempts.map(async (attempt) => {
      if (typeof attempt.operationId !== "string") return { kind: "session", runId: attempt.runId, attemptId: attempt.attemptId, status: "missing", reason: "runtime_assignment_missing", flowObservation: "session_missing" };
      const row = input.database.prepare("SELECT operation_json, status FROM outbox WHERE operation_id = ?").get(attempt.operationId) as { operation_json: string; status: string } | undefined;
      if (row === undefined) return { kind: "session", runId: attempt.runId, attemptId: attempt.attemptId, status: "missing", reason: "operation_journal_missing", flowObservation: "session_missing" };
      const launchOperation = JSON.parse(row.operation_json) as ExternalOperation;
      const receiptRow = input.database.prepare("SELECT provider_receipt_json FROM side_effect_receipts WHERE operation_id = ?").get(attempt.operationId) as { provider_receipt_json: string } | undefined;
      if (receiptRow === undefined) return { kind: "session", runId: attempt.runId, attemptId: attempt.attemptId, status: "indeterminate", reason: "launch_receipt_not_proven" };
      const launchReceipt = ExternalOperationReceiptSchema.parse(JSON.parse(receiptRow.provider_receipt_json));
      if (launchReceipt.operationId !== launchOperation.operationId || launchReceipt.fingerprint !== launchOperation.fingerprint) return { kind: "session", runId: attempt.runId, attemptId: attempt.attemptId, status: "indeterminate", reason: "launch_receipt_identity_mismatch" };
      const session = launchReceipt.nativeReferences.find((reference) => reference.kind === "session");
      if (session === undefined) return { kind: "session", runId: attempt.runId, attemptId: attempt.attemptId, status: "indeterminate", reason: "native_session_reference_missing" };
      let controller = await leaseService.findActiveController(
        launchOperation.projectId,
        session.referenceId,
      );
      if (controller === null) return { kind: "session", runId: attempt.runId, attemptId: attempt.attemptId, status: "needs_attention", reason: "controller_lease_not_available", nativeSessionId: session.referenceId };
      const renewalFloor = new Date(now().getTime() + 5 * 60_000);
      if (Date.parse(controller.expiresAt) < renewalFloor.getTime()) {
        const renewed = await leaseService.renew({ leaseId: controller.leaseId, ownerId: controller.ownerId, generation: controller.generation, expiresAt: renewalFloor.toISOString() });
        if (renewed.kind !== "controller") throw new Error("CONTROLLER_LEASE_KIND_CHANGED");
        controller = renewed;
      }
      const observeOperationId = OperationIdSchema.parse(`opn_${canonicalSha256({ runId: attempt.runId, attemptId: attempt.attemptId, nativeSessionId: session.referenceId, action: "recovery-observe" }).slice(0, 24)}`);
      const observe = createExternalOperation({ schemaVersion: 1, operationId: observeOperationId, projectId: launchOperation.projectId, runId: launchOperation.runId, attemptId: launchOperation.attemptId, operationVersion: 2, operationType: "session.observe", requestedCapabilities: ["observe"], payload: { nativeSessionId: session.referenceId, controllerLeaseId: controller.leaseId, controllerLeaseOwnerId: controller.ownerId, controllerLeaseGeneration: controller.generation } });
      const capability = input.capabilityReceiptFor?.(observe);
      if (capability === undefined || capability === null) return { kind: "session", runId: attempt.runId, attemptId: attempt.attemptId, status: "needs_attention", reason: "session_observe_capability_not_configured", nativeSessionId: session.referenceId };
      const probe = decodeCapabilityProbeReceipt(capability);
      const observedAt = now().getTime();
      const manifest = computeCapabilityManifest(probe, new Date(observedAt));
      const observeSupported = manifest.capabilities.some(({ capability: atomicCapability, status }) => atomicCapability === "observe" && status === "supported");
      if (!observeSupported) return { kind: "session", runId: attempt.runId, attemptId: attempt.attemptId, status: "needs_attention", reason: "session_observe_capability_not_proven", nativeSessionId: session.referenceId };
      const aggregateId = `recovery-session:${attempt.attemptId}`;
      const version = (input.database.prepare("SELECT COALESCE(MAX(aggregate_version), 0) AS version FROM events WHERE aggregate_id = ?").get(aggregateId) as { version: number }).version;
      journal.commitCommand({ commandId: `recovery-observe:${attempt.attemptId}`, requestFingerprint: observe.fingerprint, projectId: observe.projectId, aggregateId, expectedVersion: version, actor: { actorId: "startup-recovery", correlationId: `recovery:${attempt.runId}` }, events: [], operations: [observe], response: { operationId: observe.operationId } });
      for (let delivery = 0; delivery < 1_000; delivery += 1) {
        const status = input.database.prepare("SELECT status FROM outbox WHERE operation_id = ?").get(observe.operationId) as { status: string } | undefined;
        if (status !== undefined && !["pending", "in_flight"].includes(status.status)) break;
        if (await operationWorker.runOnce() === "idle") break;
      }
      const observedRow = input.database.prepare("SELECT provider_receipt_json FROM side_effect_receipts WHERE operation_id = ?").get(observe.operationId) as { provider_receipt_json: string } | undefined;
      if (observedRow === undefined) {
        const status = (input.database.prepare("SELECT status FROM outbox WHERE operation_id = ?").get(observe.operationId) as { status?: string } | undefined)?.status;
        return { kind: "session", runId: attempt.runId, attemptId: attempt.attemptId, status: status === "needs_attention" ? "needs_attention" : "indeterminate", reason: "session_observation_not_proven", operationId: observe.operationId };
      }
      const observed = ExternalOperationReceiptSchema.parse(JSON.parse(observedRow.provider_receipt_json));
      const sessionState = observed.facts.find((fact) => fact.kind === "session_observed")?.state;
      const flowObservation = sessionState === "missing"
        ? "session_missing"
        : sessionState === "running" || sessionState === "created" || sessionState === "waiting_input"
          ? "session_running"
          : sessionState === "returned" || observed.facts.some((fact) => fact.kind === "agent_returned")
            ? "agent_returned"
            : observed.facts.some((fact) => fact.kind === "process_exited")
              ? "structured_process_exit"
              : undefined;
      const missing = flowObservation === "session_missing";
      return { kind: "session", runId: attempt.runId, attemptId: attempt.attemptId, status: missing ? "needs_attention" : "observed", reason: `session_observation_receipt:${observe.operationId}:${observed.evidence.evidenceHash}`, operationId: observe.operationId, nativeSessionId: session.referenceId, flowObservation };
    })),
    reconcileLeasesAndWorkspace: async (attempts) => {
      const rows = input.database.prepare("SELECT lease_id, lease_kind, expires_at, receipt_json FROM lease_records ORDER BY lease_id").all() as unknown as Array<{ lease_id: string; lease_kind: string; expires_at: string; receipt_json: string }>;
      const projects = (input.database.prepare("SELECT event_data FROM events WHERE event_type = 'ProjectCreated' ORDER BY position DESC").all() as Array<{ event_data: string }>).flatMap((row) => {
        try { return [createProject((JSON.parse(row.event_data) as { project: unknown }).project)]; } catch { return []; }
      });
      const facts: RecoveryFact[] = [];
      const recordForAffectedRuns = (leaseId: string, fact: RecoveryFact) => {
        const affected = attempts.filter((attempt) => Array.isArray(attempt.leaseIds) && attempt.leaseIds.includes(leaseId));
        if (affected.length === 0) facts.push(fact);
        else for (const attempt of affected) facts.push({ ...fact, runId: attempt.runId, attemptId: attempt.attemptId });
      };
      for (const row of rows) {
        if (Date.parse(row.expires_at) <= now().getTime()) {
          recordForAffectedRuns(row.lease_id, { kind: "lease", leaseId: row.lease_id, leaseKind: row.lease_kind, status: "expired", reason: "lease_expired" });
          continue;
        }
        let lease = LeaseSchema.parse(JSON.parse(row.receipt_json));
        const affected = attempts.filter((attempt) => Array.isArray(attempt.leaseIds) && attempt.leaseIds.includes(row.lease_id));
        if (lease.revokedAt !== null) {
          recordForAffectedRuns(lease.leaseId, { kind: "lease", leaseId: lease.leaseId, leaseKind: lease.kind, status: "expired", reason: "lease_revoked" });
          continue;
        }
        const binding = projects.flatMap(({ deviceBindings }) => deviceBindings).find(({ deviceBindingId }) => deviceBindingId === lease.deviceBindingId);
        if (binding === undefined || !existsSync(binding.localPath)) {
          await leaseService.quarantine(lease.leaseId, "device_binding_path_missing");
          recordForAffectedRuns(lease.leaseId, { kind: "workspace", leaseId: lease.leaseId, status: "missing", reason: "device_binding_path_missing" });
          continue;
        }
        try {
          const externalObservation = input.leaseRecoveryObservationFor?.(lease) ?? null;
          if (lease.kind !== "workspace" && externalObservation === null) {
            await leaseService.quarantine(lease.leaseId, "lease_external_identity_not_proven");
            recordForAffectedRuns(lease.leaseId, { kind: "lease", leaseId: lease.leaseId, leaseKind: lease.kind, status: "needs_attention", reason: "lease_external_identity_not_proven" });
            continue;
          }
          const bindingBoundary = createWorkspacePathBoundary(new Map([[lease.repositoryId, binding.localPath]]));
          const workspacePath = lease.kind === "workspace"
            ? bindingBoundary.verify(lease.repositoryId, binding.localPath)
            : input.verifiedWorkspacePathForLease?.(lease) ?? null;
          if (workspacePath === null) {
            await leaseService.quarantine(lease.leaseId, "leased_worktree_path_not_proven");
            recordForAffectedRuns(lease.leaseId, { kind: "lease", leaseId: lease.leaseId, leaseKind: lease.kind, status: "needs_attention", reason: "leased_worktree_path_not_proven" });
            continue;
          }
          const workspaceBoundary = createWorkspacePathBoundary(new Map([[lease.repositoryId, workspacePath]]));
          const topLevel = execFileSync("git", ["-C", workspacePath, "rev-parse", "--show-toplevel"], { encoding: "utf8", windowsHide: true }).trim();
          const head = execFileSync("git", ["-C", workspacePath, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim();
          const changes = execFileSync("git", ["-C", workspacePath, "status", "--porcelain"], { encoding: "utf8", windowsHide: true }).trim();
          const verifiedTopLevel = workspaceBoundary.verify(lease.repositoryId, topLevel);
          await leaseService.recoverLease(lease.leaseId, {
            deviceBindingId: binding.deviceBindingId,
            canonicalWorkspaceKey: workspaceBoundary.canonicalKey(verifiedTopLevel),
            gitHead: head,
            worktreeId: externalObservation?.worktreeId,
            nativeSessionId: externalObservation?.nativeSessionId,
          });
          if (lease.kind === "workspace" && changes !== "") {
            await leaseService.quarantine(lease.leaseId, "workspace_unexpected_writes");
            recordForAffectedRuns(lease.leaseId, { kind: "workspace", leaseId: lease.leaseId, status: "drift", reason: "workspace_unexpected_writes" });
            continue;
          }
          const renewalFloor = new Date(now().getTime() + 5 * 60_000);
          if (affected.length > 0 && Date.parse(lease.expiresAt) < renewalFloor.getTime()) {
            lease = await leaseService.renew({ leaseId: lease.leaseId, ownerId: lease.ownerId, generation: lease.generation, expiresAt: renewalFloor.toISOString() });
          }
          if (lease.kind === "workspace") {
            recordForAffectedRuns(lease.leaseId, { kind: "workspace", leaseId: lease.leaseId, status: "observed", reason: "workspace_identity_confirmed" });
          } else {
            recordForAffectedRuns(lease.leaseId, { kind: "lease", leaseId: lease.leaseId, leaseKind: lease.kind, status: "observed", reason: "lease_identity_confirmed" });
          }
        } catch {
          await leaseService.quarantine(lease.leaseId, "workspace_identity_or_head_drift");
          recordForAffectedRuns(lease.leaseId, { kind: lease.kind === "workspace" ? "workspace" : "lease", leaseId: lease.leaseId, leaseKind: lease.kind, status: "drift", reason: "workspace_identity_or_head_drift" });
        }
      }
      return facts;
    },
    validateProjections: async () => {
      const checkpoint = input.database.prepare("SELECT COALESCE(MAX(last_position), 0) AS position FROM projection_checkpoints").get() as { position: number };
      if (checkpoint.position > eventReader.highWaterPosition()) throw new Error("PROJECTION_CHECKPOINT_AHEAD_OF_LEDGER");
      projectionRunner.rebuild("hunter");
      return [];
    },
    submitRecoveryConclusions: async (facts) => {
      const receipts: unknown[] = [...await reconcileCancellationRequests()];
      for (const state of flowStore.allRuns()) {
        const runFacts = facts.filter((fact) => fact.runId === state.binding.runId && (fact.status === "observed" || fact.status === "indeterminate" || fact.status === "needs_attention"));
        if (runFacts.length === 0) continue;
        for (const fact of runFacts) {
          if (fact.flowObservation !== "session_running" && fact.flowObservation !== "session_missing" && fact.flowObservation !== "agent_returned" && fact.flowObservation !== "structured_process_exit") continue;
          const current = flowStore.loadRun(state.binding.runId);
          const active = current?.steps.find(({ conclusion }) => conclusion === "active");
          if (current === null || current === undefined || active === undefined || ["succeeded", "failed", "canceled"].includes(current.status)) continue;
          const desired = fact.flowObservation === "session_running" ? "running" : fact.flowObservation === "session_missing" ? "stale" : "returned";
          if (active.executionStatus === desired) continue;
          receipts.push(flowEngine.handle({ type: "RecordExternalObservation", runId: current.binding.runId, fact: fact.flowObservation, expectedVersion: current.version, idempotencyKey: `recovery-observation-${canonicalSha256({ runId: current.binding.runId, attemptId: fact.attemptId, observation: fact.flowObservation, operationId: fact.operationId }).slice(0, 32)}`, actor: { actorId: "startup-recovery", correlationId: `recovery:${current.binding.runId}` } }));
        }
        const current = flowStore.loadRun(state.binding.runId);
        if (current === null || ["succeeded", "failed", "canceled"].includes(current.status)) continue;
        const normalized = runFacts.map((fact) => ({ kind: fact.kind, status: fact.status as "observed" | "indeterminate" | "needs_attention", reason: typeof fact.reason === "string" ? fact.reason : "recovery_attention" }));
        const newFacts = normalized.filter((fact) => !current.recoveryFacts.some((stored) => canonicalSha256(stored) === canonicalSha256(fact)));
        if (newFacts.length === 0) continue;
        receipts.push(flowEngine.handle({
          type: "RecordRecoveryFacts",
          runId: current.binding.runId,
          facts: newFacts,
          expectedVersion: current.version,
          idempotencyKey: `recovery-${canonicalSha256({ runId: current.binding.runId, facts: newFacts }).slice(0, 32)}`,
          actor: { actorId: "startup-recovery", correlationId: `recovery:${current.binding.runId}` },
        }));
      }
      return receipts;
    },
  });
  return {
    journal,
    archiveJobStore,
    archiveWorker,
    knowledgeCatalog,
    flowStore,
    flowEngine,
    runCoordinator,
    eventReader,
    projectionRunner,
    eventStream,
    leaseService,
    acquireWorkspaceLease,
    runtimeManager,
    operationWorker,
    attemptObservation,
    authenticator,
    setPrincipalProjectAuthorization,
    recovery,
    startRun,
    publishChange,
    repositories,
    reconcileCancellationRequests,
    allowedHosts: input.allowedHosts,
    allowedOrigins: input.allowedOrigins,
  };
}
