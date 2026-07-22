import { describe, expect, it, vi } from "vitest";

import { StartupRecoveryCoordinator, recoverThenListen } from "../src/startup/startup-recovery-coordinator.js";

function ports(order: string[]) {
  return {
    validateStorage: vi.fn(async () => { order.push("storage"); return []; }),
    reconcileMigration: vi.fn(async () => { order.push("migration"); return []; }),
    reconcileOutbox: vi.fn(async () => { order.push("outbox"); return [{ kind: "operation", status: "indeterminate" as const }]; }),
    enumerateActiveAttempts: vi.fn(async () => { order.push("attempts"); return [{ kind: "attempt", attemptId: "att_recovery001" }]; }),
    probeExternalState: vi.fn(async () => { order.push("probe"); return [{ kind: "session", status: "missing" as const }]; }),
    reconcileLeasesAndWorkspace: vi.fn(async () => { order.push("leases"); return [{ kind: "workspace", status: "drift" as const }]; }),
    validateProjections: vi.fn(async () => { order.push("projections"); return []; }),
    submitRecoveryConclusions: vi.fn(async (facts: readonly unknown[]) => { order.push("flow"); return { receiptId: "recovery-1", facts: facts.length }; }),
  };
}

describe("StartupRecoveryCoordinator", () => {
  it("executes the mandatory sequence and never turns absence into success", async () => {
    const order: string[] = [];
    const coordinator = new StartupRecoveryCoordinator(ports(order));
    const report = await coordinator.run();
    expect(order).toEqual(["storage", "migration", "outbox", "attempts", "probe", "leases", "projections", "flow"]);
    expect(JSON.stringify(report)).not.toMatch(/succeeded|StepSucceeded|RunSucceeded/u);
    expect(report.conclusions).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "needs_attention" }),
      expect.objectContaining({ status: "indeterminate" }),
    ]));
  });

  it("does not listen until recovery resolves and never listens after recovery failure", async () => {
    const order: string[] = [];
    const listen = vi.fn(async () => { order.push("listen"); });
    await recoverThenListen(new StartupRecoveryCoordinator(ports(order)), async () => ({ listen }));
    expect(order.at(-1)).toBe("listen");

    const failed = ports([]);
    failed.validateStorage.mockRejectedValueOnce(new Error("integrity"));
    const forbiddenListen = vi.fn();
    await expect(recoverThenListen(new StartupRecoveryCoordinator(failed), async () => ({ listen: forbiddenListen }))).rejects.toThrow(/integrity/u);
    expect(forbiddenListen).not.toHaveBeenCalled();
  });

  it("submits replay-stable recovery commands on repeated runs", async () => {
    const recoveryPorts = ports([]);
    const coordinator = new StartupRecoveryCoordinator(recoveryPorts);
    const first = await coordinator.run();
    const second = await coordinator.run();
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(recoveryPorts.submitRecoveryConclusions).toHaveBeenCalledTimes(2);
    expect(recoveryPorts.submitRecoveryConclusions.mock.calls[1]).toEqual(recoveryPorts.submitRecoveryConclusions.mock.calls[0]);
  });
});
