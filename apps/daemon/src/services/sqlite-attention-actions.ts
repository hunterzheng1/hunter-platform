import type { DatabaseSync } from "node:sqlite";

import {
  AttentionItemHttpSchema,
  type AttentionEvidenceRefHttp,
  type AttentionItemHttp,
} from "@hunter/api-contracts";
import {
  AttemptIdSchema,
  CapabilityProbeReceiptIdSchema,
  EventIdSchema,
  EvidenceIdSchema,
  OperationIdSchema,
  StepRunIdSchema,
  canonicalSha256,
  type RunId,
} from "@hunter/domain";
import {
  type FlowDefinitions,
  type FlowEngine,
  type FlowStore,
  type WorkflowRunState,
  deriveHumanGateId,
  currentRecoveryStep,
  recoveryAttemptBlockReason,
} from "@hunter/flow-engine";
import {
  ExternalOperationSchema,
  computeCapabilityManifest,
  decodeCapabilityProbeReceipt,
  type CapabilityProbeReceipt,
  type ExternalOperation,
} from "@hunter/runtime-contracts";
import type { SqliteOperationJournal } from "@hunter/storage";

import {
  AttentionActionService,
  type AttentionActionStatePort,
  type AttentionObservationPort,
} from "./attention-action-service.js";
import type { SqliteAttemptObservation } from "./sqlite-attempt-observation.js";

interface EvidenceRow {
  readonly evidence_id: string;
  readonly evidence_hash: string;
}

interface FlowEventEvidenceRow {
  readonly event_id: string;
  readonly event_data: string;
}

type ActiveStep = WorkflowRunState["steps"][number];
type ActiveAttempt = ActiveStep["attempts"][number];

function attentionEvidenceKey(reference: AttentionEvidenceRefHttp): string {
  return "evidenceId" in reference
    ? `evidence:${reference.evidenceId}`
    : `flow-event:${reference.eventId}`;
}

function humanReceiptEvidenceFields(reference: AttentionEvidenceRefHttp) {
  return "evidenceId" in reference
    ? { evidenceId: reference.evidenceId }
    : { sourceEventId: reference.eventId };
}

function attentionReason(
  attempt: ActiveAttempt,
): Pick<AttentionItemHttp, "reasonCode" | "requiredActor"> {
  if (attempt.executionStatus === "waiting_input") {
    return { reasonCode: "input_required", requiredActor: "human_operator" };
  }
  if (attempt.verificationStatus === "needs_human") {
    return {
      reasonCode: "human_verification_required",
      requiredActor: "human_operator",
    };
  }
  if (attempt.verificationStatus === "failed") {
    return { reasonCode: "verifier_failed", requiredActor: "hunter_verifier" };
  }
  if (attempt.verificationStatus === "error") {
    return { reasonCode: "verifier_error", requiredActor: "hunter_verifier" };
  }
  if (attempt.executionStatus === "stale") {
    return {
      reasonCode: "external_operation_indeterminate",
      requiredActor: "human_operator",
    };
  }
  if (
    attempt.executionStatus === "failed"
    || attempt.executionStatus === "needs_attention"
  ) {
    return {
      reasonCode: "recovery_attention_required",
      requiredActor: "hunter_runtime",
    };
  }
  throw new Error("ATTENTION_ATTEMPT_NOT_ACTIONABLE");
}

function recoveryAttemptAvailability(
  state: WorkflowRunState,
  step: ActiveStep,
  definitions: FlowDefinitions,
): AttentionItemHttp["actions"][number] {
  const attempt = step.attempts.at(-1);
  const workflow = definitions.getWorkflowRevision(
    state.binding.workflowRevisionId,
  );
  const definition = workflow?.steps.find(({ stepId }) =>
    stepId === step.stepId
  );
  if (attempt === undefined || definition === undefined) {
    return {
      action: "create_new_attempt",
      enabled: false,
      disabledReasonCode: "action_not_available",
    };
  }
  const blocked = recoveryAttemptBlockReason(
    state,
    definition,
    attempt.attemptNumber,
  );
  return blocked === null
    ? { action: "create_new_attempt", enabled: true }
    : {
        action: "create_new_attempt",
        enabled: false,
        disabledReasonCode: blocked,
      };
}

function observeAvailability(
  state: WorkflowRunState,
  attempt: ActiveAttempt,
  journal: SqliteOperationJournal,
  capabilityReceiptFor:
    | ((operation: ExternalOperation) => CapabilityProbeReceipt | null)
    | undefined,
  now: () => Date,
): AttentionItemHttp["actions"][number] | undefined {
  const assignment = attempt.assignment;
  if (assignment === undefined) return undefined;
  const probeReceiptId = CapabilityProbeReceiptIdSchema.parse(
    assignment.capabilityProbeReceiptId,
  );
  const operationState = journal.findOperation(
    OperationIdSchema.parse(assignment.operationId),
  );
  if (operationState === null || capabilityReceiptFor === undefined) {
    return {
      action: "retry_external_check",
      enabled: false,
      capability: {
        probeReceiptId,
        status: "not_proven",
        reasonCode: "capability_receipt_missing",
      },
    };
  }
  try {
    const operation = ExternalOperationSchema.parse(operationState.operation);
    const receipt = capabilityReceiptFor(operation);
    if (receipt === null) throw new Error("CAPABILITY_RECEIPT_MISSING");
    const decoded = decodeCapabilityProbeReceipt(receipt);
    const observed = computeCapabilityManifest(decoded, now()).capabilities
      .find(({ capability }) => capability === "observe");
    if (observed?.status === "supported") {
      return {
        action: "retry_external_check",
        enabled: true,
        capability: {
          probeReceiptId: decoded.probeReceiptId,
          status: "supported",
          reasonCode: "capability_supported",
        },
      };
    }
    return {
      action: "retry_external_check",
      enabled: false,
      capability: {
        probeReceiptId: decoded.probeReceiptId,
        status: observed?.status === "unsupported"
          ? "unsupported"
          : "not_proven",
        reasonCode: observed?.status === "unsupported"
          ? "capability_unsupported"
          : "observe_not_proven",
      },
    };
  } catch {
    return {
      action: "retry_external_check",
      enabled: false,
      capability: {
        probeReceiptId,
        status: "not_proven",
        reasonCode: "capability_receipt_missing",
      },
    };
  }
}

function persistedEvidenceForAttempt(
  database: DatabaseSync,
  runId: RunId,
  attemptId: ActiveAttempt["attemptId"],
): readonly EvidenceRow[] {
  return database.prepare(
    `SELECT evidence_records.evidence_id, evidence_records.evidence_hash
       FROM evidence_records
       JOIN outbox
         ON outbox.operation_id = evidence_records.operation_id
      WHERE outbox.run_id = ?
        AND outbox.attempt_id = ?
      ORDER BY evidence_records.observed_at, evidence_records.evidence_id`,
  ).all(runId, attemptId) as unknown as readonly EvidenceRow[];
}

function flowEventEvidenceForAttempt(
  database: DatabaseSync,
  runId: RunId,
  attemptId: ActiveAttempt["attemptId"],
): AttentionItemHttp["evidence"][number] | null {
  const rows = database.prepare(
    `SELECT event_id, event_data
       FROM events
      WHERE aggregate_id = ?
        AND event_type = 'FlowEvent'
      ORDER BY position DESC`,
  ).all(`run:${runId}`) as unknown as readonly FlowEventEvidenceRow[];
  for (const row of rows) {
    const eventData = JSON.parse(row.event_data) as {
      readonly flowEvent?: {
        readonly attemptId?: unknown;
      };
    };
    if (eventData.flowEvent?.attemptId !== attemptId) continue;
    return {
      source: "flow_event",
      eventId: EventIdSchema.parse(row.event_id),
      contentHash: canonicalSha256(eventData.flowEvent),
    };
  }
  return null;
}

export function attentionEvidenceForAttempt(input: {
  readonly database: DatabaseSync;
  readonly run: WorkflowRunState;
  readonly step: ActiveStep;
  readonly attempt: ActiveAttempt;
}): AttentionItemHttp["evidence"] {
  const persisted = persistedEvidenceForAttempt(
    input.database,
    input.run.binding.runId,
    input.attempt.attemptId,
  ).map(({ evidence_id, evidence_hash }) => ({
    evidenceId: EvidenceIdSchema.parse(evidence_id),
    contentHash: evidence_hash,
  }));
  const stateRequiresFlowEvent =
    input.attempt.verificationStatus === "needs_human"
    || input.attempt.executionStatus === "waiting_input";
  if (persisted.length > 0 && !stateRequiresFlowEvent) {
    return persisted;
  }
  const flowEvent = flowEventEvidenceForAttempt(
    input.database,
    input.run.binding.runId,
    input.attempt.attemptId,
  );
  if (flowEvent === null) {
    if (persisted.length > 0) return persisted;
    throw new Error("ATTENTION_EVIDENCE_REFERENCE_MISSING");
  }
  return [flowEvent, ...persisted];
}

export function projectAttentionItem(input: {
  readonly database: DatabaseSync;
  readonly run: WorkflowRunState;
  readonly step: ActiveStep;
  readonly attempt: ActiveAttempt;
  readonly definitions: FlowDefinitions;
  readonly journal: SqliteOperationJournal;
  readonly capabilityReceiptFor:
    | ((operation: ExternalOperation) => CapabilityProbeReceipt | null)
    | undefined;
  readonly now: () => Date;
  readonly current: boolean;
}): AttentionItemHttp {
  const reason = attentionReason(input.attempt);
  const actions: AttentionItemHttp["actions"][number][] = [];
  const evidence = attentionEvidenceForAttempt(input);
  const canonicalEvidence = evidence.find(
    (reference): reference is Extract<
      typeof reference,
      { readonly evidenceId: unknown }
    > => "evidenceId" in reference,
  );
  if (input.step.conclusion !== "active") {
    actions.push(
      recoveryAttemptAvailability(input.run, input.step, input.definitions),
    );
  } else if (reason.reasonCode === "input_required") {
    actions.push({ action: "submit_input", enabled: true });
  } else if (reason.reasonCode === "human_verification_required") {
    actions.push({ action: "record_human_receipt", enabled: true });
  } else if (reason.reasonCode === "external_operation_indeterminate") {
    actions.push(canonicalEvidence === undefined
      ? {
          action: "confirm_external_result",
          enabled: false,
          disabledReasonCode: "action_not_available",
        }
      : { action: "confirm_external_result", enabled: true });
    const observe = observeAvailability(
      input.run,
      input.attempt,
      input.journal,
      input.capabilityReceiptFor,
      input.now,
    );
    if (observe !== undefined) actions.push(observe);
    actions.push(
      recoveryAttemptAvailability(input.run, input.step, input.definitions),
    );
  } else {
    const observe = observeAvailability(
      input.run,
      input.attempt,
      input.journal,
      input.capabilityReceiptFor,
      input.now,
    );
    if (observe !== undefined) actions.push(observe);
    actions.push(
      recoveryAttemptAvailability(input.run, input.step, input.definitions),
    );
  }
  const projectedActions = input.current
    ? actions
    : actions.map((action) => ({
        ...action,
        enabled: false,
        disabledReasonCode: "action_not_available" as const,
      }));
  return AttentionItemHttpSchema.parse({
    ...reason,
    inputRevision: {
      changeRevisionId: input.run.binding.changeRevisionId,
      workflowRevisionId: input.run.binding.workflowRevisionId,
      requirementRevisionIds: input.run.binding.requirementRevisionIds,
      fixedContentHash: input.step.fixedContentHash,
    },
    evidence,
    actions: projectedActions,
  });
}

export function createSqliteAttentionActionService(input: {
  readonly database: DatabaseSync;
  readonly flowStore: FlowStore;
  readonly flowEngine: FlowEngine;
  readonly definitions: FlowDefinitions;
  readonly journal: SqliteOperationJournal;
  readonly attemptObservation: SqliteAttemptObservation;
  readonly capabilityReceiptFor:
    | ((operation: ExternalOperation) => CapabilityProbeReceipt | null)
    | undefined;
  readonly now: () => Date;
}): AttentionActionService {
  const state: AttentionActionStatePort = {
    load: (runId) => {
      const run = input.flowStore.loadRun(runId);
      if (run === null) return null;
      const step = currentRecoveryStep(run);
      const attempt = step?.attempts.at(-1);
      if (step === undefined || attempt === undefined) return null;
      return {
        runId,
        version: run.version,
        attempts: step.attempts.map((candidate) => ({
          attemptId: candidate.attemptId,
          executionStatus: candidate.executionStatus,
        })),
        attention: projectAttentionItem({
          database: input.database,
          run,
          step,
          attempt,
          definitions: input.definitions,
          journal: input.journal,
          capabilityReceiptFor: input.capabilityReceiptFor,
          now: input.now,
          current: true,
        }),
      };
    },
  };

  const observations: AttentionObservationPort = {
    replay: async ({ runId, command, actor }) => {
      const reservationCommandId =
        `AttentionAction:${command.idempotencyKey}`;
      const observationCommandId =
        `RecordExternalObservation:${command.idempotencyKey}`;
      const recoveryCommandId =
        `CreateRecoveryAttempt:${command.idempotencyKey}`;
      const controlCommandId = `ApplyRunControl:${command.idempotencyKey}`;
      const requestFingerprint = canonicalSha256({
        schemaVersion: 1,
        runId,
        command,
        actorId: actor.actorId,
      });
      const reservation = input.database.prepare(
        `SELECT request_fingerprint
           FROM command_receipts
          WHERE command_id = ?`,
      ).get(reservationCommandId) as {
        readonly request_fingerprint: string;
      } | undefined;
      if (
        reservation !== undefined
        && reservation.request_fingerprint !== requestFingerprint
      ) {
        throw new Error("ATTENTION_IDEMPOTENCY_CONFLICT");
      }
      if (reservation === undefined) {
        const run = input.flowStore.loadRun(runId);
        if (run === null) return null;
        input.journal.commitCommand({
          commandId: reservationCommandId,
          requestFingerprint,
          projectId: run.binding.projectId,
          aggregateId: `attention-action:${runId}`,
          expectedVersion: input.journal.aggregateVersion(
            `attention-action:${runId}`,
          ),
          actor: {
            actorId: actor.actorId,
            correlationId: command.idempotencyKey,
          },
          events: [],
          operations: [],
          response: { status: "reserved" },
        });
      }
      const existing = input.database.prepare(
        `SELECT command_id
           FROM command_receipts
          WHERE command_id IN (?, ?, ?)`,
      ).all(
        observationCommandId,
        recoveryCommandId,
        controlCommandId,
      ) as unknown as readonly { readonly command_id: string }[];
      if (existing.length === 0) return null;
      const expectedCommandId = command.action === "create_new_attempt"
        ? recoveryCommandId
        : command.action === "submit_input"
            || command.action === "record_human_receipt"
          ? controlCommandId
        : command.action === "confirm_external_result"
            || command.action === "retry_external_check"
          ? observationCommandId
          : null;
      if (
        expectedCommandId === null
        || existing.some(({ command_id }) => command_id !== expectedCommandId)
      ) {
        throw new Error("ATTENTION_IDEMPOTENCY_CONFLICT");
      }
      if (command.action === "create_new_attempt") {
        const flowCommand = {
          type: "CreateRecoveryAttempt" as const,
          runId,
          priorAttemptId: command.attemptId,
          expectedVersion: command.expectedVersion,
          idempotencyKey: command.idempotencyKey,
          actor,
        };
        const receipt = input.flowStore.getReceipt(
          recoveryCommandId,
          canonicalSha256(flowCommand),
        );
        if (receipt === null) {
          throw new Error("ATTENTION_RECEIPT_INCOMPLETE");
        }
        return {
          runId,
          attemptId: command.attemptId,
          action: command.action,
          status: "accepted",
          effect: "new_attempt_requested",
          stepCompletion: "unchanged",
        };
      }
      if (
        command.action === "submit_input"
        || command.action === "record_human_receipt"
      ) {
        const run = input.flowStore.loadRun(runId);
        if (run === null) throw new Error("ATTENTION_RUN_NOT_FOUND");
        const rows = input.database.prepare(
          `SELECT events.event_data
             FROM command_receipts
             JOIN events
               ON events.position BETWEEN command_receipts.first_position
                                      AND command_receipts.last_position
            WHERE command_receipts.command_id = ?
              AND events.event_type = 'FlowEvent'
            ORDER BY events.position`,
        ).all(controlCommandId) as unknown as readonly {
          readonly event_data: string;
        }[];
        const flowEvents = rows.map(({ event_data }) => {
          const eventData = JSON.parse(event_data) as {
            readonly flowEvent?: {
              readonly type?: unknown;
              readonly stepRunId?: unknown;
              readonly humanReceipt?: {
                readonly evidenceId?: unknown;
                readonly sourceEventId?: unknown;
              };
            };
          };
          return eventData.flowEvent;
        });
        const replayEvent = command.action === "submit_input"
          ? flowEvents.find(({ type } = {}) =>
              type === "SupplementalInputRecorded"
            )
          : flowEvents.find(({ type, humanReceipt } = {}) =>
              type === "VerificationChanged"
              && (
                "evidenceId" in command.receipt.evidenceRef
                  ? humanReceipt?.evidenceId
                    === command.receipt.evidenceRef.evidenceId
                  : humanReceipt?.sourceEventId
                    === command.receipt.evidenceRef.eventId
              )
            );
        if (replayEvent === undefined) {
          throw new Error("ATTENTION_RECEIPT_INCOMPLETE");
        }
        const replayStepRunId = StepRunIdSchema.parse(replayEvent.stepRunId);
        const flowCommand = command.action === "submit_input"
          ? {
              type: "ApplyRunControl" as const,
              projectId: run.binding.projectId,
              runId,
              action: "supplement" as const,
              target: {
                kind: "step" as const,
                stepRunId: replayStepRunId,
              },
              payload: { text: command.input.text },
              expectedVersion: command.expectedVersion,
              idempotencyKey: command.idempotencyKey,
              actor,
            }
          : {
              type: "ApplyRunControl" as const,
              projectId: run.binding.projectId,
              runId,
              action: "approve" as const,
              target: {
                kind: "gate" as const,
                gateId: deriveHumanGateId(
                  runId,
                  replayStepRunId,
                ),
              },
              payload: {
                humanReceipt: {
                  ...humanReceiptEvidenceFields(
                    command.receipt.evidenceRef,
                  ),
                  evidenceContentHash:
                    command.receipt.evidenceRef.contentHash,
                  acknowledgedInputHash:
                    command.receipt.acknowledgedInputHash,
                },
              },
              expectedVersion: command.expectedVersion,
              idempotencyKey: command.idempotencyKey,
              actor,
            };
        const receipt = input.flowStore.getReceipt(
          controlCommandId,
          canonicalSha256(flowCommand),
        );
        if (receipt === null) {
          throw new Error("ATTENTION_RECEIPT_INCOMPLETE");
        }
        return command.action === "submit_input"
          ? {
              runId,
              attemptId: command.attemptId,
              action: command.action,
              status: "accepted",
              effect: "input_recorded",
              stepCompletion: "unchanged",
            }
          : {
              runId,
              attemptId: command.attemptId,
              action: command.action,
              status: "recorded",
              effect: "human_receipt_recorded",
              stepCompletion: "human_verified",
            };
      }
      const row = input.database.prepare(
        `SELECT events.event_data
           FROM command_receipts
           JOIN events
             ON events.position BETWEEN command_receipts.first_position
                                    AND command_receipts.last_position
          WHERE command_receipts.command_id = ?
            AND events.event_type = 'FlowEvent'
          ORDER BY events.position
          LIMIT 1`,
      ).get(observationCommandId) as { readonly event_data?: string } | undefined;
      if (row?.event_data === undefined) {
        throw new Error("ATTENTION_RECEIPT_INCOMPLETE");
      }
      const eventData = JSON.parse(row.event_data) as {
        readonly flowEvent?: {
          readonly type?: unknown;
          readonly fact?: unknown;
          readonly capabilityProbeReceiptId?: unknown;
        };
      };
      if (eventData.flowEvent?.type !== "ExternalObservationRecorded") {
        throw new Error("ATTENTION_RECEIPT_EVENT_INVALID");
      }
      const fact = command.action === "confirm_external_result"
        ? command.observation.fact
        : eventData.flowEvent.fact;
      if (
        fact !== "agent_returned"
        && fact !== "session_missing"
        && fact !== "session_running"
        && fact !== "structured_process_exit"
      ) {
        throw new Error("ATTENTION_RECEIPT_FACT_INVALID");
      }
      const flowCommand = {
        type: "RecordExternalObservation" as const,
        runId,
        fact,
        ...(command.action === "confirm_external_result"
          ? {
              humanReceipt: {
                evidenceId: command.observation.evidenceId,
                contentHash: command.observation.contentHash,
                actorId: actor.actorId,
              },
            }
          : {}),
        ...(command.action === "retry_external_check"
          ? {
              capabilityProbeReceiptId:
                CapabilityProbeReceiptIdSchema.parse(
                  eventData.flowEvent.capabilityProbeReceiptId,
                ),
            }
          : {}),
        expectedVersion: command.expectedVersion,
        idempotencyKey: command.idempotencyKey,
        actor,
      };
      const receipt = input.flowStore.getReceipt(
        observationCommandId,
        canonicalSha256(flowCommand),
      );
      if (receipt === null) throw new Error("ATTENTION_RECEIPT_INCOMPLETE");
      const stepCompletion =
        fact === "agent_returned" || fact === "structured_process_exit"
          ? "verifier_required" as const
          : "unchanged" as const;
      return command.action === "confirm_external_result"
        ? {
            runId,
            attemptId: command.attemptId,
            action: command.action,
            status: "recorded",
            effect: "observation_recorded",
            stepCompletion,
          }
        : {
            runId,
            attemptId: command.attemptId,
            action: command.action,
            status: "recorded",
            effect: "recheck_requested",
            stepCompletion,
          };
    },
    submitInput: async (command) => {
      if (canonicalSha256(command.text) !== command.contentHash) {
        throw new Error("ATTENTION_INPUT_HASH_MISMATCH");
      }
      const run = input.flowStore.loadRun(command.runId);
      const step = run?.steps.find(({ conclusion }) => conclusion === "active");
      const attempt = step?.attempts.at(-1);
      if (
        run === null
        || step === undefined
        || attempt?.attemptId !== command.attemptId
      ) {
        throw new Error("ATTENTION_ATTEMPT_NOT_CURRENT");
      }
      input.flowEngine.handle({
        type: "ApplyRunControl",
        projectId: run.binding.projectId,
        runId: command.runId,
        action: "supplement",
        target: { kind: "step", stepRunId: step.stepRunId },
        payload: { text: command.text },
        expectedVersion: command.expectedVersion,
        idempotencyKey: command.idempotencyKey,
        actor: command.actor,
      });
    },
    recordHumanReceipt: async (command) => {
      const run = input.flowStore.loadRun(command.runId);
      const step = run?.steps.find(({ conclusion }) => conclusion === "active");
      const attempt = step?.attempts.at(-1);
      if (
        run === null
        || step === undefined
        || attempt?.attemptId !== command.attemptId
      ) {
        throw new Error("ATTENTION_ATTEMPT_NOT_CURRENT");
      }
      const evidence = attentionEvidenceForAttempt({
        database: input.database,
        run,
        step,
        attempt,
      }).find((reference) =>
        attentionEvidenceKey(reference)
        === attentionEvidenceKey(command.evidenceRef)
      );
      if (
        evidence?.contentHash !== command.evidenceRef.contentHash
        || step.fixedContentHash !== command.acknowledgedInputHash
      ) {
        throw new Error("ATTENTION_EVIDENCE_HASH_MISMATCH");
      }
      input.flowEngine.handle({
        type: "ApplyRunControl",
        projectId: run.binding.projectId,
        runId: command.runId,
        action: "approve",
        target: {
          kind: "gate",
          gateId: deriveHumanGateId(command.runId, step.stepRunId),
        },
        payload: {
          humanReceipt: {
            ...humanReceiptEvidenceFields(command.evidenceRef),
            evidenceContentHash: command.evidenceRef.contentHash,
            acknowledgedInputHash: command.acknowledgedInputHash,
          },
        },
        expectedVersion: command.expectedVersion,
        idempotencyKey: command.idempotencyKey,
        actor: command.actor,
      });
    },
    record: async (command) => {
      const run = input.flowStore.loadRun(command.runId);
      const step = run?.steps.find(({ conclusion }) => conclusion === "active");
      const attempt = step?.attempts.at(-1);
      if (
        run === null
        || step === undefined
        || attempt?.attemptId !== command.attemptId
      ) {
        throw new Error("ATTENTION_ATTEMPT_NOT_CURRENT");
      }
      const evidence = attentionEvidenceForAttempt({
        database: input.database,
        run,
        step,
        attempt,
      }).find((reference) =>
        "evidenceId" in reference
        && reference.evidenceId === command.evidenceId
      );
      if (evidence?.contentHash !== command.contentHash) {
        throw new Error("ATTENTION_EVIDENCE_HASH_MISMATCH");
      }
      input.flowEngine.handle({
        type: "RecordExternalObservation",
        runId: command.runId,
        fact: command.fact,
        ...(command.source === "human_confirm"
          ? {
              humanReceipt: {
                evidenceId: command.evidenceId,
                contentHash: command.contentHash,
                actorId: command.actor.actorId,
              },
            }
          : {}),
        ...(command.capabilityProbeReceiptId === undefined
          ? {}
          : {
              capabilityProbeReceiptId:
                command.capabilityProbeReceiptId,
            }),
        expectedVersion: command.expectedVersion,
        idempotencyKey: command.idempotencyKey,
        actor: command.actor,
      });
      return { fact: command.fact };
    },
    retry: async (command) => {
      const run = input.flowStore.loadRun(command.runId);
      const attempt = run?.steps
        .flatMap(({ attempts }) => attempts)
        .find(({ attemptId }) => attemptId === command.attemptId);
      if (attempt?.assignment === undefined) {
        throw new Error("ATTENTION_ASSIGNMENT_REQUIRED");
      }
      const observed = await input.attemptObservation.observeForAttention({
        runId: command.runId,
        attemptId: command.attemptId,
        operationId: OperationIdSchema.parse(attempt.assignment.operationId),
        recheckId: command.idempotencyKey,
        probeReceiptId: command.capabilityProbeReceiptId,
      });
      return {
        fact: observed.fact,
        evidenceId: observed.evidenceId,
        contentHash: observed.evidenceHash,
        capabilityProbeReceiptId:
          command.capabilityProbeReceiptId,
      };
    },
    createAttempt: async (command) => {
      const receipt = input.flowEngine.handle({
        type: "CreateRecoveryAttempt",
        runId: command.runId,
        priorAttemptId: command.priorAttemptId,
        expectedVersion: command.expectedVersion,
        idempotencyKey: command.idempotencyKey,
        actor: command.actor,
      });
      const response = receipt.response as { readonly attemptId?: unknown };
      return {
        attemptId: AttemptIdSchema.parse(response.attemptId),
      };
    },
  };
  return new AttentionActionService(state, observations);
}
