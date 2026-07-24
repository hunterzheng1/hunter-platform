import {
  AttemptIdSchema,
  OperationIdSchema,
  RunIdSchema,
  canonicalSha256,
  type RunId,
} from "@hunter/domain";
import type {
  FlowCommandHandler,
  FlowStore,
  WorkflowRunState,
} from "@hunter/flow-engine";

import type {
  CompletionVerifierPort,
  VerificationResult,
} from "./application-services.js";

export interface AttemptObservation {
  readonly fact: "agent_returned" | "structured_process_exit";
  readonly evidenceHash: string;
}

export interface AttemptObservationPort {
  observe(input: {
    readonly runId: RunId;
    readonly attemptId: ReturnType<typeof AttemptIdSchema.parse>;
    readonly operationId: ReturnType<typeof OperationIdSchema.parse>;
  }): Promise<AttemptObservation>;
}

function activeAttempt(state: WorkflowRunState) {
  const step = [...state.steps]
    .reverse()
    .find(({ conclusion }) => conclusion === "active");
  const attempt = step?.attempts.at(-1);
  if (step === undefined || attempt === undefined) {
    throw new Error("ACTIVE_ATTEMPT_REQUIRED");
  }
  if (attempt.assignment === undefined) {
    throw new Error("ATTEMPT_ASSIGNMENT_REQUIRED");
  }
  const assignment = attempt.assignment;
  return {
    step,
    attempt,
    assignment,
    operationId: OperationIdSchema.parse(assignment.operationId),
  };
}

export class AttemptSettlementRunner {
  public constructor(
    private readonly flowStore: Pick<FlowStore, "loadRun">,
    private readonly commands: FlowCommandHandler,
    private readonly observations: AttemptObservationPort,
    private readonly verifier: CompletionVerifierPort,
  ) {}

  public async settle(runIdInput: RunId): Promise<{
    readonly runId: RunId;
    readonly attemptId: ReturnType<typeof AttemptIdSchema.parse>;
    readonly verification: VerificationResult["status"];
  }> {
    const runId = RunIdSchema.parse(runIdInput);
    let state = this.flowStore.loadRun(runId);
    if (state === null) throw new Error("FLOW_RUN_NOT_FOUND");
    const assigned = activeAttempt(state);
    const attemptId = AttemptIdSchema.parse(assigned.attempt.attemptId);
    let runtimeEvidenceHash = assigned.assignment.operationId;

    if (assigned.attempt.executionStatus !== "returned") {
      const observation = await this.observations.observe({
        runId,
        attemptId,
        operationId: assigned.operationId,
      });
      runtimeEvidenceHash = observation.evidenceHash;
      this.commands.handle({
        type: "RecordExternalObservation",
        runId,
        fact: observation.fact,
        expectedVersion: state.version,
        idempotencyKey: `attempt-observation:${attemptId}:${observation.evidenceHash}`,
        actor: {
          actorId: "attempt-settlement",
          correlationId: `settle:${runId}:${attemptId}`,
        },
      });
    }

    state = this.flowStore.loadRun(runId);
    if (state === null) throw new Error("FLOW_RUN_NOT_FOUND");
    const returned = activeAttempt(state);
    if (returned.attempt.attemptId !== attemptId) {
      throw new Error("ACTIVE_ATTEMPT_CHANGED_DURING_SETTLEMENT");
    }
    const verification = await this.verifier.verify({
      runId,
      attemptId,
      runtimeEvidenceHash,
    });
    const evidenceFingerprint = canonicalSha256({
      runtimeEvidenceHash,
      evidence: verification.evidence,
    });
    this.commands.handle({
      type: "RecordVerifierResult",
      runId,
      outcome: verification.status,
      evidenceFingerprint,
      ...(verification.status === "failed"
        ? {
            failureFingerprint: canonicalSha256({
              attemptId,
              status: verification.status,
              evidenceFingerprint,
            }),
            diffFingerprint: canonicalSha256({
              attemptId,
              runtimeEvidenceHash,
            }),
          }
        : {}),
      expectedVersion: state.version,
      idempotencyKey: `attempt-verification:${attemptId}:${evidenceFingerprint}`,
      actor: {
        actorId: "attempt-settlement",
        correlationId: `settle:${runId}:${attemptId}`,
      },
    });
    return { runId, attemptId, verification: verification.status };
  }
}
