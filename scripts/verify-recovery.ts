import { StartupRecoveryCoordinator } from "../apps/daemon/src/startup/startup-recovery-coordinator.js";

const facts = [{ kind: "session", status: "missing" }] as const;
const receipts = new Map<string, unknown>();
const coordinator = new StartupRecoveryCoordinator({
  validateStorage: async () => [],
  reconcileMigration: async () => [],
  reconcileOutbox: async () => [{ kind: "operation", status: "indeterminate" }],
  enumerateActiveAttempts: async () => [{ kind: "attempt", attemptId: "att_verify0001" }],
  probeExternalState: async () => facts,
  reconcileLeasesAndWorkspace: async () => [],
  validateProjections: async () => [],
  submitRecoveryConclusions: async (conclusions) => {
    const key = JSON.stringify(conclusions);
    const receipt = receipts.get(key) ?? { receiptId: `recovery-${receipts.size + 1}` };
    receipts.set(key, receipt);
    return receipt;
  },
});

const first = await coordinator.run();
const second = await coordinator.run();
if (first.fingerprint !== second.fingerprint || receipts.size !== 1) {
  throw new Error("RECOVERY_REPLAY_UNSTABLE");
}
process.stdout.write(`verify:recovery PASS ${first.fingerprint}\n`);
