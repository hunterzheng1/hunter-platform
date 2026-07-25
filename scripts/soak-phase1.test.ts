import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  Phase1SoakReportSchema,
  type Phase1SoakReport,
} from "@hunter/testkit";
import { describe, expect, it } from "vitest";

import {
  createNotRunPhase1SoakReport,
  loadPhase1SoakResumeCheckpoint,
  persistPhase1SoakCheckpoint,
  phase1SoakOptionsForMode,
  phase1SoakExitCode,
  resolvePhase1SoakStatus,
  runPhase1Soak,
} from "./soak-phase1.js";
import { writePhase1JsonAtomic } from "./phase1-evidence.js";

describe("Phase 1 24-hour soak", () => {
  it("returns success only for a completed full run or an explicit smoke", () => {
    expect(phase1SoakExitCode("full", "PASS")).toBe(0);
    expect(phase1SoakExitCode("full", "NOT_PROVEN")).toBe(1);
    expect(phase1SoakExitCode("full", "FAIL")).toBe(1);
    expect(phase1SoakExitCode("smoke", "NOT_PROVEN")).toBe(0);
    expect(phase1SoakExitCode("smoke", "FAIL")).toBe(1);
  });

  it("makes the CLI smoke exercise every long-run mechanism", () => {
    expect(phase1SoakOptionsForMode("smoke")).toEqual({
      mode: "smoke",
      maxCycles: 4,
      cycleIntervalMs: 0,
      restartEveryCycles: 2,
      archiveEveryCycles: 2,
      rebuildEveryCycles: 2,
      loopEveryCycles: 1,
      faultMatrixEveryCycles: 4,
    });
    expect(phase1SoakOptionsForMode("full")).toEqual({ mode: "full" });
  });

  it("reports the actual smoke schedule instead of the full-run schedule", async () => {
    const options = phase1SoakOptionsForMode("smoke");
    const report = await runPhase1Soak(options);

    expect(report.execution).toEqual({
      mode: "smoke",
      cycleIntervalMs: 0,
      restartEveryCycles: 2,
      archiveEveryCycles: 2,
      rebuildEveryCycles: 2,
      loopEveryCycles: 1,
      faultMatrixEveryCycles: 4,
    });
    expect(report.faultMatrixCount).toBe(1);
  }, 30_000);

  it("resumes the same durable run after a new process invocation", async () => {
    const root = mkdtempSync(join(tmpdir(), "hunter-phase1-resume-"));
    const stateRoot = join(root, "state");
    try {
      const common = {
        mode: "smoke" as const,
        cycleIntervalMs: 0,
        restartEveryCycles: 2,
        archiveEveryCycles: 2,
        rebuildEveryCycles: 2,
        loopEveryCycles: 1,
        faultMatrixEveryCycles: 4,
        stateRoot,
      };
      const first = await runPhase1Soak({
        ...common,
        maxCycles: 2,
        preserveStateOnNotProven: true,
      });
      expect(first.status).toBe("NOT_PROVEN");
      expect(first.cycleCount).toBe(2);
      expect(existsSync(join(stateRoot, "hunter.sqlite"))).toBe(true);

      const resumed = await runPhase1Soak({
        ...common,
        maxCycles: 4,
        resumeFrom: first,
        preserveStateOnNotProven: false,
      });
      expect(resumed.status).toBe("NOT_PROVEN");
      expect(resumed.cycleAttempts.map(({ sequence }) => sequence)).toEqual([
        1,
        2,
        3,
        4,
      ]);
      expect(resumed.restartCount).toBeGreaterThanOrEqual(3);
      expect(resumed.scheduledRestartCount).toBe(2);
      expect(resumed.recoveryRestartCount).toBe(1);
      expect(resumed.restartCount).toBe(3);
      expect(resumed.observations.restartOperationCount).toBe(
        resumed.restartCount,
      );
      expect(resumed.observations.providerNativeEffectCount).toBe(
        resumed.cycleCount + resumed.restartCount,
      );
      expect(resumed.observations.providerInvocationCount).toBe(
        resumed.cycleCount + resumed.restartCount,
      );
      expect(resumed.checks.noDuplicateExternalOperations).toBe(true);
      expect(existsSync(stateRoot)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("resumes from a durable checkpoint after the latest evidence sink fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "hunter-phase1-checkpoint-"));
    const output = join(root, "soak.json");
    const stateRoot = `${output}.state`;
    const common = {
      mode: "smoke" as const,
      cycleIntervalMs: 0,
      restartEveryCycles: 2,
      archiveEveryCycles: 2,
      rebuildEveryCycles: 2,
      loopEveryCycles: 1,
      faultMatrixEveryCycles: 4,
      stateRoot,
    };
    try {
      const first = await runPhase1Soak({
        ...common,
        maxCycles: 2,
        preserveStateOnNotProven: true,
      });
      expect(() =>
        persistPhase1SoakCheckpoint(output, first, (path, value) => {
          if (path === output) throw new Error("PHASE1_EVIDENCE_RENAME_FAILED");
          writePhase1JsonAtomic(path, value);
        }),
      ).toThrow("PHASE1_EVIDENCE_RENAME_FAILED");
      writePhase1JsonAtomic(output, {
        schemaVersion: 1,
        proofScope: "contract_only",
        build: first.build,
        command: "soak",
        status: "NOT_PROVEN",
        observedAt: "2026-07-25T01:00:00.000Z",
        errorCode: "PHASE1_EVIDENCE_RENAME_FAILED",
      });

      const checkpoint = loadPhase1SoakResumeCheckpoint(output);
      expect(checkpoint?.cycleCount).toBe(2);
      expect(
        JSON.parse(readFileSync(output, "utf8")) as { readonly errorCode: string },
      ).toMatchObject({ errorCode: "PHASE1_EVIDENCE_RENAME_FAILED" });

      const resumed = await runPhase1Soak({
        ...common,
        maxCycles: 4,
        resumeFrom: checkpoint,
        preserveStateOnNotProven: false,
      });
      expect(resumed.cycleCount).toBe(4);
      expect(resumed.checks.noDuplicateExternalOperations).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("reconciles a scheduled restart completed after the last durable checkpoint", async () => {
    const root = mkdtempSync(join(tmpdir(), "hunter-phase1-restart-window-"));
    const stateRoot = join(root, "state");
    const common = {
      mode: "smoke" as const,
      cycleIntervalMs: 0,
      restartEveryCycles: 2,
      archiveEveryCycles: 2,
      rebuildEveryCycles: 2,
      loopEveryCycles: 1,
      faultMatrixEveryCycles: 4,
      stateRoot,
    };
    let durableCheckpoint: Phase1SoakReport | undefined;
    try {
      await expect(runPhase1Soak({
        ...common,
        maxCycles: 2,
        preserveStateOnNotProven: true,
        onCheckpoint: (checkpoint) => {
          if (
            checkpoint.cycleCount === 2
            && checkpoint.scheduledRestartCount === 0
          ) {
            durableCheckpoint = checkpoint;
          }
          if (
            checkpoint.cycleCount === 2
            && checkpoint.scheduledRestartCount === 1
          ) {
            throw new Error("SIMULATED_CHECKPOINT_CRASH");
          }
        },
      })).rejects.toThrow("SIMULATED_CHECKPOINT_CRASH");
      expect(durableCheckpoint).toBeDefined();

      const resumed = await runPhase1Soak({
        ...common,
        maxCycles: 2,
        resumeFrom: durableCheckpoint,
        preserveStateOnNotProven: false,
      });

      expect(resumed.cycleCount).toBe(2);
      expect(resumed.scheduledRestartCount).toBe(1);
      expect(resumed.recoveryRestartCount).toBe(1);
      expect(resumed.restartCount).toBe(2);
      expect(resumed.observations.restartOperationCount).toBe(2);
      expect(resumed.observations.providerNativeEffectCount).toBe(4);
      expect(resumed.checks.noDuplicateExternalOperations).toBe(true);
      expect(resumed.checks.allStatesExplainable).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("checkpoints scheduled catch-up before recording a recovery restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "hunter-phase1-recovery-window-"));
    const stateRoot = join(root, "state");
    const common = {
      mode: "smoke" as const,
      cycleIntervalMs: 0,
      restartEveryCycles: 2,
      archiveEveryCycles: 2,
      rebuildEveryCycles: 2,
      loopEveryCycles: 1,
      faultMatrixEveryCycles: 4,
      stateRoot,
    };
    let beforeScheduledRestart: Phase1SoakReport | undefined;
    let beforeRecoveryRestart: Phase1SoakReport | undefined;
    try {
      await expect(runPhase1Soak({
        ...common,
        maxCycles: 2,
        preserveStateOnNotProven: true,
        onCheckpoint: (checkpoint) => {
          if (
            checkpoint.cycleCount === 2
            && checkpoint.scheduledRestartCount === 0
          ) {
            beforeScheduledRestart = checkpoint;
          }
          if (
            checkpoint.cycleCount === 2
            && checkpoint.scheduledRestartCount === 1
          ) {
            throw new Error("SIMULATED_SCHEDULED_CHECKPOINT_CRASH");
          }
        },
      })).rejects.toThrow("SIMULATED_SCHEDULED_CHECKPOINT_CRASH");

      await expect(runPhase1Soak({
        ...common,
        maxCycles: 2,
        resumeFrom: beforeScheduledRestart,
        preserveStateOnNotProven: true,
        onCheckpoint: (checkpoint) => {
          if (
            checkpoint.scheduledRestartCount === 1
            && checkpoint.recoveryRestartCount === 0
          ) {
            beforeRecoveryRestart = checkpoint;
          }
          if (
            checkpoint.scheduledRestartCount === 1
            && checkpoint.recoveryRestartCount === 1
          ) {
            throw new Error("SIMULATED_RECOVERY_CHECKPOINT_CRASH");
          }
        },
      })).rejects.toThrow("SIMULATED_RECOVERY_CHECKPOINT_CRASH");
      expect(beforeRecoveryRestart).toBeDefined();

      const resumed = await runPhase1Soak({
        ...common,
        maxCycles: 2,
        resumeFrom: beforeRecoveryRestart,
        preserveStateOnNotProven: false,
      });

      expect(resumed.scheduledRestartCount).toBe(1);
      expect(resumed.recoveryRestartCount).toBe(1);
      expect(resumed.restartCount).toBe(2);
      expect(resumed.observations.restartOperationCount).toBe(2);
      expect(resumed.checks.noDuplicateExternalOperations).toBe(true);
      expect(resumed.checks.allStatesExplainable).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails closed without leaking paths when a CLI resume checkpoint is corrupt", () => {
    const root = mkdtempSync(join(tmpdir(), "hunter-phase1-corrupt-checkpoint-"));
    const output = join(root, "soak.json");
    const checkpoint = join(`${output}.state`, "checkpoint.json");
    try {
      mkdirSync(`${output}.state`, { recursive: true });
      writeFileSync(checkpoint, "{not-json", "utf8");

      const result = spawnSync(
        process.execPath,
        [
          "--no-warnings",
          "--import",
          "tsx",
          resolve("scripts/soak-phase1.ts"),
          "--output",
          output,
        ],
        { encoding: "utf8", timeout: 10_000 },
      );

      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe("UNKNOWN_PHASE1_FAILURE");
      expect(result.stderr).not.toContain(root);
      expect(
        JSON.parse(readFileSync(output, "utf8")) as {
          readonly status: string;
          readonly errorCode: string;
        },
      ).toMatchObject({
        status: "NOT_PROVEN",
        errorCode: "UNKNOWN_PHASE1_FAILURE",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("prints only a fixed code when the CLI failure envelope cannot be written", () => {
    const root = mkdtempSync(join(tmpdir(), "hunter-phase1-unwritable-evidence-"));
    const output = join(root, "soak.json");
    try {
      mkdirSync(output);

      const result = spawnSync(
        process.execPath,
        [
          "--no-warnings",
          "--import",
          "tsx",
          resolve("scripts/soak-phase1.ts"),
          "--output",
          output,
        ],
        { encoding: "utf8", timeout: 10_000 },
      );

      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe("PHASE1_EVIDENCE_WRITE_FAILED");
      expect(result.stderr).not.toContain(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("downgrades a full-duration candidate when any invariant check fails", () => {
    const passingChecks = {
      noDuplicateExternalOperations: true,
      noFalseSuccess: true,
      boundedResourceGrowth: true,
      allStatesExplainable: true,
      failedAttemptsPreserved: true,
    };
    const completedWork = {
      cycleCount: 1_440,
      restartCount: 288,
      scheduledRestartCount: 288,
      recoveryRestartCount: 0,
      archiveCount: 144,
      rebuildCount: 48,
      loopCount: 1_440,
      faultMatrixCount: 24,
      allFaultAttemptsPassed: true,
    };

    expect(resolvePhase1SoakStatus({
      mode: "full",
      elapsedMs: 86_400_000,
      stoppedByFailure: false,
      aborted: false,
      checks: passingChecks,
      ...completedWork,
    })).toBe("PASS");
    expect(resolvePhase1SoakStatus({
      mode: "full",
      elapsedMs: 86_400_000,
      stoppedByFailure: false,
      aborted: false,
      checks: { ...passingChecks, noFalseSuccess: false },
      ...completedWork,
    })).toBe("FAIL");
    expect(resolvePhase1SoakStatus({
      mode: "smoke",
      elapsedMs: 86_400_000,
      stoppedByFailure: false,
      aborted: false,
      checks: passingChecks,
      ...completedWork,
    })).toBe("NOT_PROVEN");
    expect(resolvePhase1SoakStatus({
      mode: "full",
      elapsedMs: 86_400_000,
      stoppedByFailure: false,
      aborted: false,
      checks: passingChecks,
      ...completedWork,
      cycleCount: 0,
    })).toBe("FAIL");
  });

  it.each([
    ["restart", { restartCount: 287 }],
    ["archive", { archiveCount: 143 }],
    ["rebuild", { rebuildCount: 47 }],
    ["loop", { loopCount: 1_439 }],
    ["fault matrix", { faultMatrixCount: 23 }],
  ])(
    "rejects a full-duration candidate with an incomplete %s schedule",
    (_label, incompleteWork) => {
      expect(resolvePhase1SoakStatus({
        mode: "full",
        elapsedMs: 86_400_000,
        stoppedByFailure: false,
        aborted: false,
        checks: {
          noDuplicateExternalOperations: true,
          noFalseSuccess: true,
          boundedResourceGrowth: true,
          allStatesExplainable: true,
          failedAttemptsPreserved: true,
        },
        cycleCount: 1_440,
        restartCount: 288,
        scheduledRestartCount: 288,
        recoveryRestartCount: 0,
        archiveCount: 144,
        rebuildCount: 48,
        loopCount: 1_440,
        faultMatrixCount: 24,
        allFaultAttemptsPassed: true,
        ...incompleteWork,
      })).toBe("FAIL");
    },
  );

  it.each([
    ["archive", { archiveCount: 145 }],
    ["rebuild", { rebuildCount: 49 }],
    ["loop", { loopCount: 1_441 }],
    ["fault matrix", { faultMatrixCount: 25 }],
  ])(
    "rejects a full-duration candidate with a duplicated %s schedule",
    (_label, duplicatedWork) => {
      expect(resolvePhase1SoakStatus({
        mode: "full",
        elapsedMs: 86_400_000,
        stoppedByFailure: false,
        aborted: false,
        checks: {
          noDuplicateExternalOperations: true,
          noFalseSuccess: true,
          boundedResourceGrowth: true,
          allStatesExplainable: true,
          failedAttemptsPreserved: true,
        },
        cycleCount: 1_440,
        restartCount: 288,
        scheduledRestartCount: 288,
        recoveryRestartCount: 0,
        archiveCount: 144,
        rebuildCount: 48,
        loopCount: 1_440,
        faultMatrixCount: 24,
        allFaultAttemptsPassed: true,
        ...duplicatedWork,
      })).toBe("FAIL");
    },
  );

  it("allows an additional restart canary after a durable process recovery", () => {
    expect(resolvePhase1SoakStatus({
      mode: "full",
      elapsedMs: 86_400_000,
      stoppedByFailure: false,
      aborted: false,
      checks: {
        noDuplicateExternalOperations: true,
        noFalseSuccess: true,
        boundedResourceGrowth: true,
        allStatesExplainable: true,
        failedAttemptsPreserved: true,
      },
      cycleCount: 1_440,
      restartCount: 289,
      scheduledRestartCount: 288,
      recoveryRestartCount: 1,
      archiveCount: 144,
      rebuildCount: 48,
      loopCount: 1_440,
      faultMatrixCount: 24,
      allFaultAttemptsPassed: true,
    })).toBe("PASS");
  });

  it("does not let a recovery restart mask a missing scheduled restart", () => {
    const candidate = {
      mode: "full" as const,
      elapsedMs: 86_400_000,
      stoppedByFailure: false,
      aborted: false,
      checks: {
        noDuplicateExternalOperations: true,
        noFalseSuccess: true,
        boundedResourceGrowth: true,
        allStatesExplainable: true,
        failedAttemptsPreserved: true,
      },
      cycleCount: 1_440,
      restartCount: 288,
      scheduledRestartCount: 287,
      recoveryRestartCount: 1,
      archiveCount: 144,
      rebuildCount: 48,
      loopCount: 1_440,
      faultMatrixCount: 24,
      allFaultAttemptsPassed: true,
    } as Parameters<typeof resolvePhase1SoakStatus>[0];

    expect(resolvePhase1SoakStatus(candidate)).toBe("FAIL");
  });

  it("derives the frozen schedule from the actual 1,441 cycle total", () => {
    expect(resolvePhase1SoakStatus({
      mode: "full",
      elapsedMs: 86_400_001,
      stoppedByFailure: false,
      aborted: false,
      checks: {
        noDuplicateExternalOperations: true,
        noFalseSuccess: true,
        boundedResourceGrowth: true,
        allStatesExplainable: true,
        failedAttemptsPreserved: true,
      },
      cycleCount: 1_441,
      restartCount: 288,
      scheduledRestartCount: 288,
      recoveryRestartCount: 0,
      archiveCount: 144,
      rebuildCount: 48,
      loopCount: 1_441,
      faultMatrixCount: 24,
      allFaultAttemptsPassed: true,
    })).toBe("PASS");
  });

  it("cannot represent a run that never started as PASS", () => {
    const report = createNotRunPhase1SoakReport();

    expect(Phase1SoakReportSchema.parse(report)).toEqual(report);
    expect(report).toMatchObject({
      status: "NOT_RUN",
      startedAt: null,
      completedAt: null,
      elapsedMs: 0,
      cycleCount: 0,
      cycleAttempts: [],
    });
  });

  it("runs loops, restart, archive, rebuild, and the complete fault matrix without claiming 24h", async () => {
    const before = readdirSync(tmpdir()).filter((name) =>
      name.startsWith("hunter-phase1-soak-"),
    );
    const report = await runPhase1Soak({
      mode: "smoke",
      maxCycles: 4,
      cycleIntervalMs: 0,
      restartEveryCycles: 2,
      archiveEveryCycles: 2,
      rebuildEveryCycles: 2,
      loopEveryCycles: 1,
      faultMatrixEveryCycles: 4,
    });
    const after = readdirSync(tmpdir()).filter((name) =>
      name.startsWith("hunter-phase1-soak-"),
    );

    expect(Phase1SoakReportSchema.parse(report)).toEqual(report);
    expect(report).toMatchObject({
      status: "NOT_PROVEN",
      cycleCount: 4,
      restartCount: 2,
      archiveCount: 2,
      rebuildCount: 2,
      loopCount: 4,
      observations: {
        receiptCount: 6,
        providerInvocationCount: 6,
        providerNativeEffectCount: 6,
        completedOutboxCount: 6,
        totalOutboxCount: 6,
        restartOperationCount: 2,
      },
      checks: {
        noDuplicateExternalOperations: true,
        noFalseSuccess: true,
        boundedResourceGrowth: true,
        allStatesExplainable: true,
        failedAttemptsPreserved: true,
      },
    });
    expect(report.faultAttempts).toHaveLength(12);
    expect(report.faultAttempts.every(({ status }) => status === "PASS")).toBe(
      true,
    );
    expect(report.cycleAttempts.map(({ status }) => status)).toEqual([
      "PASS",
      "PASS",
      "PASS",
      "PASS",
    ]);
    expect(after).toEqual(before);
  }, 30_000);

  it("stops after the first failed cycle and preserves it instead of rerunning", async () => {
    const report = await runPhase1Soak({
      mode: "smoke",
      maxCycles: 5,
      cycleIntervalMs: 0,
      restartEveryCycles: 10,
      archiveEveryCycles: 10,
      rebuildEveryCycles: 10,
      loopEveryCycles: 10,
      faultMatrixEveryCycles: 10,
      injectCycleFailureAt: 2,
    });

    expect(report.status).toBe("FAIL");
    expect(report.cycleCount).toBe(2);
    expect(report.cycleAttempts.map(({ status }) => status)).toEqual([
      "PASS",
      "FAIL",
    ]);
    expect(report.cycleAttempts[1]?.errorCode).toBe(
      "INJECTED_SOAK_CYCLE_FAILURE",
    );
  }, 30_000);
});
