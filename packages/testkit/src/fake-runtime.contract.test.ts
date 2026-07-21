import { describe, expect, it } from "vitest";
import {
  OperationIdSchema,
  RuntimeProviderIdSchema,
} from "@hunter/domain";
import { createExternalOperation } from "@hunter/runtime-contracts";
import {
  FakeRuntime,
  verifyExternalOperationHandlerContract,
} from "./index.js";

describe("deterministic fake runtime", () => {
  it("passes the shared external-operation contract suite", async () => {
    const result = await verifyExternalOperationHandlerContract(
      () =>
        new FakeRuntime({
          providerId: RuntimeProviderIdSchema.parse("rtp_00000001"),
          implementationVersion: "0.0.0-contract",
          observedAt: "2026-07-21T00:00:00.000Z",
        }),
    );

    expect(result).toEqual({
      deterministicReplay: true,
      conflictingReuseRejected: true,
      falseSuccessRejected: true,
      proofScope: "contract_only",
    });
  });

  it("rejects a forged fingerprint before execution", async () => {
    const fake = new FakeRuntime({
      providerId: RuntimeProviderIdSchema.parse("rtp_00000001"),
      implementationVersion: "0.0.0-contract",
      observedAt: "2026-07-21T00:00:00.000Z",
    });
    const operation = createExternalOperation({
      schemaVersion: 1,
      operationId: OperationIdSchema.parse("opn_00000009"),
      projectId: "prj_00000001",
      runId: "run_00000001",
      attemptId: "att_00000001",
      operationVersion: 1,
      operationType: "session.observe",
      requestedCapabilities: ["observe"],
      payload: { nativeSessionId: "ses_00000001" },
    });

    await expect(
      fake.execute({ ...operation, fingerprint: "f".repeat(64) }),
    ).rejects.toThrowError("OPERATION_FINGERPRINT_MISMATCH");
  });
});
