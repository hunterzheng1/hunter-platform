import {
  NativeSessionIdSchema,
  OperationIdSchema,
  canonicalSha256,
} from "@hunter/domain";
import {
  ExternalOperationSchema,
  computeCapabilityManifest,
  createExternalOperation,
  decodeCapabilityProbeReceipt,
  type CapabilityProbeReceipt,
  type ExternalOperation,
} from "@hunter/runtime-contracts";
import type { LeaseService } from "@hunter/runtime-manager";
import type {
  OperationWorker,
  SqliteOperationJournal,
} from "@hunter/storage";

import type {
  AttemptObservation,
  AttemptObservationPort,
} from "./attempt-settlement-runner.js";

export class SqliteAttemptObservation implements AttemptObservationPort {
  public constructor(
    private readonly journal: SqliteOperationJournal,
    private readonly worker: OperationWorker,
    private readonly leases: LeaseService,
    private readonly capabilityReceiptFor:
      | ((operation: ExternalOperation) => CapabilityProbeReceipt | null)
      | undefined,
    private readonly now: () => Date,
  ) {}

  public async observe(
    input: Parameters<AttemptObservationPort["observe"]>[0],
  ): Promise<AttemptObservation> {
    const launch = this.operation(input.operationId);
    if (
      launch.operationType !== "session.launch"
      || launch.runId !== input.runId
      || launch.attemptId !== input.attemptId
    ) {
      throw new Error("ATTEMPT_LAUNCH_SCOPE_MISMATCH");
    }
    const launchReceipt = await this.deliver(launch);
    const session = launchReceipt.nativeReferences.find(
      ({ kind }) => kind === "session",
    );
    if (session === undefined) throw new Error("NATIVE_SESSION_RECEIPT_REQUIRED");
    const observationId = OperationIdSchema.parse(
      `opn_${canonicalSha256({
        launchOperationId: launch.operationId,
        attemptId: input.attemptId,
        action: "settlement-observe",
      }).slice(0, 24)}`,
    );
    const recoveryObservationId = OperationIdSchema.parse(
      `opn_${canonicalSha256({
        runId: input.runId,
        attemptId: input.attemptId,
        nativeSessionId: session.referenceId,
        action: "recovery-observe",
      }).slice(0, 24)}`,
    );
    const existingObservations = [
      observationId,
      recoveryObservationId,
    ].map((operationId) => this.journal.findOperation(operationId))
      .filter((candidate) => candidate !== null)
      .map((candidate) =>
        ExternalOperationSchema.parse(candidate.operation)
      );
    for (const operation of existingObservations) {
      if (
        operation.operationType !== "session.observe"
        || operation.runId !== input.runId
        || operation.attemptId !== input.attemptId
        || operation.payload.nativeSessionId !== session.referenceId
      ) {
        throw new Error("ATTEMPT_OBSERVATION_SCOPE_MISMATCH");
      }
    }
    const completedObservation = existingObservations.find((operation) =>
      this.worker.resolveReceipt(operation)?.operationStatus === "completed"
    );
    if (completedObservation !== undefined) {
      return this.toAttemptObservation(
        await this.deliver(completedObservation),
      );
    }
    const existingObservation = existingObservations[0];
    if (existingObservation !== undefined) {
      return this.toAttemptObservation(
        await this.deliver(existingObservation),
      );
    }
    const controller = await this.leases.findActiveController(
      launch.projectId,
      NativeSessionIdSchema.parse(session.referenceId),
    );
    if (controller === null) throw new Error("CONTROLLER_LEASE_REQUIRED");
    const observation = createExternalOperation({
      schemaVersion: 1,
      operationId: observationId,
      projectId: launch.projectId,
      runId: input.runId,
      attemptId: input.attemptId,
      operationVersion: 2,
      operationType: "session.observe",
      requestedCapabilities: ["observe"],
      payload: {
        nativeSessionId: session.referenceId,
        controllerLeaseId: controller.leaseId,
        controllerLeaseOwnerId: controller.ownerId,
        controllerLeaseGeneration: controller.generation,
      },
    });
    this.assertObserveCapability(observation);
    this.journal.commitCommand({
      commandId: `settlement-observe:${input.attemptId}`,
      requestFingerprint: observation.fingerprint,
      projectId: observation.projectId,
      aggregateId: `attempt-observation:${input.attemptId}`,
      expectedVersion: 0,
      actor: {
        actorId: "attempt-settlement",
        correlationId: `settle:${input.runId}:${input.attemptId}`,
      },
      events: [],
      operations: [observation],
      response: { operationId: observation.operationId },
    });
    const receipt = await this.deliver(observation);
    return this.toAttemptObservation(receipt);
  }

  private toAttemptObservation(
    receipt: Awaited<ReturnType<SqliteAttemptObservation["deliver"]>>,
  ): AttemptObservation {
    const fact = receipt.facts.some(({ kind }) => kind === "agent_returned")
      ? "agent_returned"
      : receipt.facts.some(({ kind }) => kind === "process_exited")
        ? "structured_process_exit"
        : null;
    if (fact === null) throw new Error("ATTEMPT_RETURN_NOT_OBSERVED");
    return {
      fact,
      evidenceHash: receipt.evidence.evidenceHash,
    };
  }

  private operation(operationId: ReturnType<typeof OperationIdSchema.parse>) {
    const state = this.journal.findOperation(operationId);
    if (state === null) throw new Error("OPERATION_JOURNAL_ENTRY_REQUIRED");
    return ExternalOperationSchema.parse(state.operation);
  }

  private async deliver(operation: ExternalOperation) {
    for (let delivery = 0; delivery < 1_000; delivery += 1) {
      const existing = this.worker.resolveReceipt(operation);
      if (existing !== null) {
        if (existing.operationStatus !== "completed") {
          throw new Error(
            `OPERATION_RECEIPT_${existing.operationStatus.toUpperCase()}`,
          );
        }
        return existing;
      }
      const row = this.journal.findOperation(operation.operationId);
      if (
        row !== null
        && ["indeterminate", "needs_attention"].includes(row.status)
      ) {
        throw new Error(`OPERATION_DELIVERY_${row.status.toUpperCase()}`);
      }
      if (await this.worker.runOnce() === "idle") break;
    }
    throw new Error("OPERATION_DELIVERY_LIMIT_EXCEEDED");
  }

  private assertObserveCapability(operation: ExternalOperation): void {
    const receipt = this.capabilityReceiptFor?.(operation);
    if (receipt === undefined || receipt === null) {
      throw new Error("SESSION_OBSERVE_CAPABILITY_NOT_CONFIGURED");
    }
    const probe = decodeCapabilityProbeReceipt(receipt);
    const manifest = computeCapabilityManifest(probe, this.now());
    if (!manifest.capabilities.some(
      ({ capability, status }) =>
        capability === "observe" && status === "supported",
    )) {
      throw new Error("SESSION_OBSERVE_CAPABILITY_NOT_PROVEN");
    }
  }
}
