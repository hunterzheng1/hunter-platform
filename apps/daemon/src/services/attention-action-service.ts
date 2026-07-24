import {
  AttentionActionHttpRequestSchema,
  AttentionActionHttpResponseSchema,
  AttentionItemHttpSchema,
  type AttentionActionHttpRequest,
  type AttentionActionHttpResponse,
  type AttentionEvidenceRefHttp,
  type AttentionItemHttp,
} from "@hunter/api-contracts";
import {
  AttemptIdSchema,
  RunIdSchema,
  type AttemptId,
  type EvidenceId,
  type RunId,
} from "@hunter/domain";

export interface AttentionActionActor {
  readonly actorId: string;
  readonly correlationId: string;
}

export interface AttentionActionStatePort {
  load(runId: RunId): {
    readonly runId: RunId;
    readonly version: number;
    readonly attempts: readonly {
      readonly attemptId: AttemptId;
      readonly executionStatus: string;
    }[];
    readonly attention: AttentionItemHttp;
  } | null;
}

type ExternalObservationFact =
  | "agent_returned"
  | "session_missing"
  | "session_running"
  | "structured_process_exit";

interface ObservationCommand {
  readonly runId: RunId;
  readonly attemptId: AttemptId;
  readonly fact: ExternalObservationFact;
  readonly evidenceId: EvidenceId;
  readonly contentHash: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly actor: AttentionActionActor;
  readonly source: "human_confirm" | "runtime_recheck";
  readonly capabilityProbeReceiptId?: string | undefined;
}

export interface AttentionObservationPort {
  replay(input: {
    readonly runId: RunId;
    readonly command: AttentionActionHttpRequest;
    readonly actor: AttentionActionActor;
  }): Promise<AttentionActionHttpResponse | null>;
  submitInput(command: {
    readonly runId: RunId;
    readonly attemptId: AttemptId;
    readonly text: string;
    readonly contentHash: string;
    readonly expectedVersion: number;
    readonly idempotencyKey: string;
    readonly actor: AttentionActionActor;
  }): Promise<void>;
  recordHumanReceipt(command: {
    readonly runId: RunId;
    readonly attemptId: AttemptId;
    readonly evidenceRef: AttentionEvidenceRefHttp;
    readonly acknowledgedInputHash: string;
    readonly expectedVersion: number;
    readonly idempotencyKey: string;
    readonly actor: AttentionActionActor;
  }): Promise<void>;
  record(command: ObservationCommand): Promise<{
    readonly fact: ExternalObservationFact;
  }>;
  retry(command: {
    readonly runId: RunId;
    readonly attemptId: AttemptId;
    readonly expectedVersion: number;
    readonly idempotencyKey: string;
    readonly actor: AttentionActionActor;
    readonly capabilityProbeReceiptId: string;
  }): Promise<{
    readonly fact: ExternalObservationFact;
    readonly evidenceId: EvidenceId;
    readonly contentHash: string;
    readonly capabilityProbeReceiptId: string;
  }>;
  createAttempt(command: {
    readonly runId: RunId;
    readonly priorAttemptId: AttemptId;
    readonly expectedVersion: number;
    readonly idempotencyKey: string;
    readonly actor: AttentionActionActor;
  }): Promise<{
    readonly attemptId: AttemptId;
  }>;
}

function completionFor(
  fact: ExternalObservationFact,
): "unchanged" | "verifier_required" {
  return fact === "agent_returned" || fact === "structured_process_exit"
    ? "verifier_required"
    : "unchanged";
}

function evidenceReferenceKey(reference: AttentionEvidenceRefHttp): string {
  return "evidenceId" in reference
    ? `evidence:${reference.evidenceId}`
    : `flow-event:${reference.eventId}`;
}

export class AttentionActionService {
  public constructor(
    private readonly state: AttentionActionStatePort,
    private readonly observations: AttentionObservationPort,
  ) {}

  public async execute(
    runIdInput: string,
    commandInput: AttentionActionHttpRequest,
    actor: AttentionActionActor,
  ): Promise<AttentionActionHttpResponse> {
    const runId = RunIdSchema.parse(runIdInput);
    const command = AttentionActionHttpRequestSchema.parse(commandInput);
    const replay = await this.observations.replay({
      runId,
      command,
      actor,
    });
    if (replay !== null) return AttentionActionHttpResponseSchema.parse(replay);
    const state = this.state.load(runId);
    if (state === null || state.runId !== runId) {
      throw new Error("ATTENTION_RUN_NOT_FOUND");
    }
    if (state.version !== command.expectedVersion) {
      throw new Error("ATTENTION_VERSION_CONFLICT");
    }
    const attemptId = AttemptIdSchema.parse(command.attemptId);
    const currentAttempt = state.attempts.at(-1);
    if (currentAttempt?.attemptId !== attemptId) {
      throw new Error("ATTENTION_ATTEMPT_NOT_CURRENT");
    }
    const attention = AttentionItemHttpSchema.parse(state.attention);
    const availability = attention.actions.find(
      ({ action }) => action === command.action,
    );
    if (availability === undefined || !availability.enabled) {
      throw new Error("ATTENTION_ACTION_DISABLED");
    }

    if (command.action === "submit_input") {
      await this.observations.submitInput({
        runId,
        attemptId,
        text: command.input.text,
        contentHash: command.input.contentHash,
        expectedVersion: command.expectedVersion,
        idempotencyKey: command.idempotencyKey,
        actor,
      });
      return AttentionActionHttpResponseSchema.parse({
        runId,
        attemptId,
        action: command.action,
        status: "accepted",
        effect: "input_recorded",
        stepCompletion: "unchanged",
      });
    }

    if (command.action === "record_human_receipt") {
      const evidence = attention.evidence.find(
        (reference) =>
          evidenceReferenceKey(reference)
          === evidenceReferenceKey(command.receipt.evidenceRef),
      );
      if (
        evidence === undefined
        || evidence.contentHash
          !== command.receipt.evidenceRef.contentHash
      ) {
        throw new Error("ATTENTION_EVIDENCE_SCOPE_MISMATCH");
      }
      await this.observations.recordHumanReceipt({
        runId,
        attemptId,
        evidenceRef: command.receipt.evidenceRef,
        acknowledgedInputHash: command.receipt.acknowledgedInputHash,
        expectedVersion: command.expectedVersion,
        idempotencyKey: command.idempotencyKey,
        actor,
      });
      return AttentionActionHttpResponseSchema.parse({
        runId,
        attemptId,
        action: command.action,
        status: "recorded",
        effect: "human_receipt_recorded",
        stepCompletion: "human_verified",
      });
    }

    if (command.action === "confirm_external_result") {
      const evidence = attention.evidence.find(
        (reference) =>
          "evidenceId" in reference
          && reference.evidenceId === command.observation.evidenceId,
      );
      if (
        evidence === undefined
        || evidence.contentHash !== command.observation.contentHash
      ) {
        throw new Error("ATTENTION_EVIDENCE_SCOPE_MISMATCH");
      }
      const observation = await this.observations.record({
        runId,
        attemptId,
        fact: command.observation.fact,
        evidenceId: command.observation.evidenceId,
        contentHash: command.observation.contentHash,
        expectedVersion: command.expectedVersion,
        idempotencyKey: command.idempotencyKey,
        actor,
        source: "human_confirm",
      });
      return AttentionActionHttpResponseSchema.parse({
        runId,
        attemptId,
        action: command.action,
        status: "recorded",
        effect: "observation_recorded",
        stepCompletion: completionFor(observation.fact),
      });
    }

    if (command.action === "retry_external_check") {
      if (
        availability.capability?.probeReceiptId
        !== command.capabilityProbeReceiptId
      ) {
        throw new Error("ATTENTION_CAPABILITY_RECEIPT_MISMATCH");
      }
      const retried = await this.observations.retry({
        runId,
        attemptId,
        expectedVersion: command.expectedVersion,
        idempotencyKey: command.idempotencyKey,
        actor,
        capabilityProbeReceiptId: command.capabilityProbeReceiptId,
      });
      const observation = await this.observations.record({
        runId,
        attemptId,
        ...retried,
        expectedVersion: command.expectedVersion,
        idempotencyKey: command.idempotencyKey,
        actor,
        source: "runtime_recheck",
      });
      return AttentionActionHttpResponseSchema.parse({
        runId,
        attemptId,
        action: command.action,
        status: "recorded",
        effect: "recheck_requested",
        stepCompletion: completionFor(observation.fact),
      });
    }

    if (command.action === "create_new_attempt") {
      await this.observations.createAttempt({
        runId,
        priorAttemptId: attemptId,
        expectedVersion: command.expectedVersion,
        idempotencyKey: command.idempotencyKey,
        actor,
      });
      return AttentionActionHttpResponseSchema.parse({
        runId,
        attemptId,
        action: command.action,
        status: "accepted",
        effect: "new_attempt_requested",
        stepCompletion: "unchanged",
      });
    }

    throw new Error("ATTENTION_ACTION_NOT_IMPLEMENTED");
  }
}
