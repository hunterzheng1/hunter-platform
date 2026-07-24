import {
  AttemptIdSchema,
  CapabilityProbeReceiptIdSchema,
  EvidenceIdSchema,
  LeaseOwnerIdSchema,
  NativeSessionIdSchema,
  OperationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  RuntimeProviderIdSchema,
} from "@hunter/domain";
import {
  CapabilityProbeReceiptSchema,
  ExternalOperationReceiptSchema,
  createExternalOperation,
  type ExternalOperation,
  type ExternalOperationReceipt,
  type RuntimeFact,
} from "@hunter/runtime-contracts";
import type { LeaseService } from "@hunter/runtime-manager";
import type {
  OperationWorker,
  SqliteOperationJournal,
} from "@hunter/storage";
import { describe, expect, it, vi } from "vitest";

import { SqliteAttemptObservation } from "../src/services/sqlite-attempt-observation.js";

const ids = {
  project: ProjectIdSchema.parse("prj_observe0001"),
  run: RunIdSchema.parse("run_observe0001"),
  attempt: AttemptIdSchema.parse("att_observe0001"),
  launch: OperationIdSchema.parse("opn_observe0001"),
  session: NativeSessionIdSchema.parse("ses_observe0001"),
};

function launchOperation() {
  return createExternalOperation({
    schemaVersion: 1,
    operationId: ids.launch,
    projectId: ids.project,
    runId: ids.run,
    attemptId: ids.attempt,
    operationVersion: 1,
    operationType: "session.launch",
    requestedCapabilities: ["launch"],
    payload: {
      agentProfileId: "apr_observe0001",
      workspaceId: "wsp_observe0001",
    },
  });
}

function receipt(
  operation: ExternalOperation,
  operationStatus: ExternalOperationReceipt["operationStatus"],
  facts: readonly RuntimeFact[],
) {
  return ExternalOperationReceiptSchema.parse({
    schemaVersion: 1,
    operationId: operation.operationId,
    fingerprint: operation.fingerprint,
    operationStatus,
    subject: {
      kind: "provider",
      providerId: RuntimeProviderIdSchema.parse("rtp_observe0001"),
      implementationVersion: "test",
    },
    nativeReferences: operation.operationType === "session.launch"
      ? [{ kind: "session", referenceId: ids.session }]
      : [],
    facts,
    evidence: {
      evidenceId: EvidenceIdSchema.parse(
        operation.operationType === "session.launch"
          ? "evd_observelaunch"
          : "evd_observereturn",
      ),
      evidenceHash: operation.operationType === "session.launch"
        ? "a".repeat(64)
        : "b".repeat(64),
      proofScope: "local_observation",
    },
    observedAt: "2026-07-24T00:00:00.000Z",
  });
}

function observeCapability() {
  return CapabilityProbeReceiptSchema.parse({
    schemaVersion: 2,
    probeReceiptId: CapabilityProbeReceiptIdSchema.parse("cpr_observe0001"),
    subject: {
      kind: "provider",
      providerId: RuntimeProviderIdSchema.parse("rtp_observe0001"),
      implementationVersion: "test",
    },
    platform: "windows",
    executable: { status: "available" },
    loginState: "not_required",
    productVersion: { observed: "test", supported: ["test"] },
    protocol: {
      kind: "test",
      observedVersion: "1",
      supportedVersions: ["1"],
      schemaVersion: 1,
      supportedSchemaVersions: [1],
      schemaDigest: "c".repeat(64),
    },
    probedAt: "2026-07-24T00:00:00.000Z",
    validUntil: "2026-07-25T00:00:00.000Z",
    results: [{
      capability: "observe",
      status: "supported",
      evidenceId: EvidenceIdSchema.parse("evd_observecapability"),
      evidence: { source: "local_probe", digest: "d".repeat(64) },
      probedAt: "2026-07-24T00:00:00.000Z",
    }],
  });
}

function observationWith(
  statusFor: (operation: ExternalOperation) =>
    ExternalOperationReceipt["operationStatus"],
) {
  const launch = launchOperation();
  let observedOperation: ExternalOperation | undefined;
  const journal = {
    findOperation: vi.fn((operationId: string) => {
      const operation = operationId === launch.operationId
        ? launch
        : observedOperation;
      return operation === undefined
        ? null
        : { operation, status: "pending" };
    }),
    commitCommand: vi.fn((command: { operations: readonly ExternalOperation[] }) => {
      observedOperation = command.operations[0];
      return { commandId: "settlement-observe", response: {} };
    }),
  };
  const worker = {
    resolveReceipt: vi.fn((operation: ExternalOperation) =>
      receipt(
        operation,
        statusFor(operation),
        operation.operationType === "session.observe"
          ? [{ kind: "agent_returned" }]
          : [{ kind: "operation_accepted" }],
      )),
    runOnce: vi.fn(async () => "idle"),
  };
  const leases = {
    findActiveController: vi.fn(async () => ({
      kind: "controller",
      leaseId: "ctl_observe0001",
      ownerId: LeaseOwnerIdSchema.parse("own_observe0001"),
      generation: 1,
    })),
  };
  return {
    observation: new SqliteAttemptObservation(
      journal as unknown as SqliteOperationJournal,
      worker as unknown as OperationWorker,
      leases as unknown as LeaseService,
      () => observeCapability(),
      () => new Date("2026-07-24T01:00:00.000Z"),
    ),
    leases,
  };
}

describe("SQLite attempt observation", () => {
  it.each(["indeterminate", "needs_attention", "rejected"] as const)(
    "rejects a %s launch receipt before using its native references",
    async (status) => {
      const { observation } = observationWith(() => status);

      await expect(observation.observe({
        runId: ids.run,
        attemptId: ids.attempt,
        operationId: ids.launch,
      })).rejects.toThrow(`OPERATION_RECEIPT_${status.toUpperCase()}`);
    },
  );

  it.each(["indeterminate", "needs_attention", "rejected"] as const)(
    "rejects a %s observe receipt before using its runtime facts",
    async (status) => {
      const { observation } = observationWith((operation) =>
        operation.operationType === "session.launch" ? "completed" : status);

      await expect(observation.observe({
        runId: ids.run,
        attemptId: ids.attempt,
        operationId: ids.launch,
      })).rejects.toThrow(`OPERATION_RECEIPT_${status.toUpperCase()}`);
    },
  );

  it("recovers the durable observe receipt without reacquiring a controller lease", async () => {
    const { observation, leases } = observationWith(() => "completed");

    await expect(observation.observe({
      runId: ids.run,
      attemptId: ids.attempt,
      operationId: ids.launch,
    })).resolves.toEqual({
      fact: "agent_returned",
      evidenceHash: "b".repeat(64),
    });
    leases.findActiveController.mockRejectedValueOnce(
      new Error("CONTROLLER_LEASE_EXPIRED"),
    );
    await expect(observation.observe({
      runId: ids.run,
      attemptId: ids.attempt,
      operationId: ids.launch,
    })).resolves.toEqual({
      fact: "agent_returned",
      evidenceHash: "b".repeat(64),
    });
    expect(leases.findActiveController).toHaveBeenCalledOnce();
  });
});
