import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AttemptIdSchema,
  OperationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  RuntimeProviderIdSchema,
} from "@hunter/domain";
import { createExternalOperation } from "@hunter/runtime-contracts";
import { describe, expect, it } from "vitest";

import { PersistentFakeRuntime } from "./phase1-persistent-fake-runtime.js";

const providerId = RuntimeProviderIdSchema.parse("rtp_phase1persistent");

function operation(session = "ses_phase1persistent") {
  return createExternalOperation({
    schemaVersion: 1,
    operationId: OperationIdSchema.parse("opn_phase1persistent"),
    projectId: ProjectIdSchema.parse("prj_phase1persistent"),
    runId: RunIdSchema.parse("run_phase1persistent"),
    attemptId: AttemptIdSchema.parse("att_phase1persistent"),
    operationVersion: 2,
    operationType: "session.observe",
    requestedCapabilities: ["observe"],
    payload: {
      nativeSessionId: session,
      controllerLeaseId: "ctl_phase1persistent",
      controllerLeaseOwnerId: "own_phase1persistent",
      controllerLeaseGeneration: 1,
    },
  });
}

describe("Persistent Phase 1 Fake Runtime", () => {
  it("persists native effects and dispatch counts across Runtime reconstruction", async () => {
    const root = mkdtempSync(join(tmpdir(), "hunter-persistent-fake-"));
    const path = join(root, "provider.sqlite");
    try {
      const first = new PersistentFakeRuntime(path, {
        providerId,
        implementationVersion: "phase1-test",
        observedAt: "2026-07-25T00:00:00.000Z",
      });
      const firstReceipt = await first.execute(operation());
      first.recordRestartProbe(1, "2026-07-25T00:00:00.500Z");
      first.close();

      const second = new PersistentFakeRuntime(path, {
        providerId,
        implementationVersion: "phase1-test",
        observedAt: "2026-07-25T00:00:01.000Z",
      });
      try {
        const replay = await second.execute(operation());
        expect(replay).toEqual(firstReceipt);
        expect(second.providerInvocationCount).toBe(2);
        expect(second.providerNativeEffectCount).toBe(1);
        expect(second.restartProbeCount).toBe(1);
        second.recordRestartProbe(1, "2026-07-25T00:00:00.500Z");
        expect(second.restartProbeCount).toBe(1);
        expect(await second.inspect(operation())).toEqual(firstReceipt);
        await expect(
          second.execute(operation("ses_phase1changed")),
        ).rejects.toThrow(
          "OPERATION_ID_REUSED_WITH_DIFFERENT_PAYLOAD",
        );
      } finally {
        second.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
