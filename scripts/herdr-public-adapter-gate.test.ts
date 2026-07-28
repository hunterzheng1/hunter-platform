import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  NodeCommandRunner,
  withTemporaryGitFixture,
} from "@hunter/spike-testkit";
import { describe, expect, it } from "vitest";
import {
  HerdrAdapterError,
} from "@hunter/provider-herdr";
import {
  HerdrPublicAdapterGateSchema,
  assertOwnedSessionAbsent,
  collectPermissionArgumentGate,
  createHerdrPublicAdapterGateEvidence,
  fingerprintHerdrPublicAdapterGateContent,
  prepareHerdrPublicAdapterGateOutput,
  resolveHerdrPublicAdapterGateOutputPath,
  type HerdrGateObservations,
} from "./herdr-public-adapter-gate.js";

const SOURCE = {
  commit: "1".repeat(40),
  digest: "a".repeat(64),
  clean: true as const,
};

function passingObservations(): HerdrGateObservations {
  return {
    identityVerified: true,
    noRemote: true,
    exactPathAttached: true,
    headPreservedAfterClose: true,
    branchPreservedAfterClose: true,
    contentPreservedAfterClose: true,
    gitPathPreservedAfterClose: true,
    prepareStatus: "completed",
    prepareReceiptHash: "b".repeat(64),
    duplicateReturnedSameReceipt: true,
    releaseStatus: "completed",
    releaseReceiptHash: "c".repeat(64),
    targetBefore: "absent",
    targetAfterClose: "running",
    targetAfterCleanup: "absent",
    unrelatedDigestBefore: "d".repeat(64),
    unrelatedDigestAfterClose: "d".repeat(64),
    unrelatedDigestAfterCleanup: "d".repeat(64),
    dangerousArgumentRejectedBeforeIo: true,
    forceRemovalRejectedBeforeIo: true,
    workspaceStateClosed: true,
    ownedSessionStopped: true,
    ownedSessionDeleted: true,
    hunterGitWorktreeRemoved: true,
    hunterGitBranchRemoved: true,
  };
}

describe("Herdr public Adapter real gate evidence", () => {
  it("records PASS only when exact attach, state-only close, isolation, cleanup, and argv gates all pass", () => {
    const evidence = createHerdrPublicAdapterGateEvidence({
      generatedAt: "2026-07-28T09:00:00.000Z",
      source: SOURCE,
      baselineSha256: "e".repeat(64),
      observations: passingObservations(),
      failureCode: null,
    });

    expect(evidence.providerVerdict).toBe("PASS");
    expect(evidence.failureCode).toBeNull();
    expect(evidence.checks.every(({ status }) => status === "PASS")).toBe(
      true,
    );
    expect(evidence.subsequentTasks).toEqual(
      Array.from({ length: 7 }, (_, index) => ({
        task: index + 2,
        status: "READY",
      })),
    );
    expect(evidence.proofScope).toBe(
      "local_public_cli_temporary_git_fixture",
    );
    expect(JSON.stringify(evidence)).not.toMatch(
      /(?:Users[\\/]|AppData|socket_path|session_dir|--yolo)/iu,
    );
  });

  it("blocks Tasks 2-8 instead of forging PASS when one hard gate is not proven", () => {
    const observations = {
      ...passingObservations(),
      gitPathPreservedAfterClose: false,
    };
    const evidence = createHerdrPublicAdapterGateEvidence({
      generatedAt: "2026-07-28T09:00:00.000Z",
      source: SOURCE,
      baselineSha256: "e".repeat(64),
      observations,
      failureCode: "GIT_PATH_NOT_PRESERVED",
    });

    expect(evidence.providerVerdict).toBe("BLOCKED");
    expect(evidence.checks).toContainEqual(
      expect.objectContaining({
        id: "state_only_cleanup",
        status: "BLOCKED",
      }),
    );
    expect(
      evidence.subsequentTasks.every(({ status }) => status === "NOT_RUN"),
    ).toBe(true);

    const identityBlocked = createHerdrPublicAdapterGateEvidence({
      generatedAt: "2026-07-28T09:00:00.000Z",
      source: SOURCE,
      baselineSha256: "e".repeat(64),
      observations: {
        ...passingObservations(),
        identityVerified: false,
      },
      failureCode: null,
    });
    expect(identityBlocked.providerVerdict).toBe("BLOCKED");
    expect(identityBlocked.failureCode).toBe("HERDR_TASK1_NOT_PROVEN");
    expect(identityBlocked.checks).toContainEqual(
      expect.objectContaining({
        id: "fixed_version",
        status: "BLOCKED",
      }),
    );
  });

  it("rejects forged verdicts and fingerprints", () => {
    const evidence = createHerdrPublicAdapterGateEvidence({
      generatedAt: "2026-07-28T09:00:00.000Z",
      source: SOURCE,
      baselineSha256: "e".repeat(64),
      observations: passingObservations(),
      failureCode: null,
    });

    expect(() =>
      HerdrPublicAdapterGateSchema.parse({
        ...evidence,
        providerVerdict: "BLOCKED",
        failureCode: "FORGED",
      }),
    ).toThrow();
    expect(() =>
      HerdrPublicAdapterGateSchema.parse({
        ...evidence,
        contentFingerprint: "f".repeat(64),
      }),
    ).toThrow();

    const contradictory = {
      ...evidence,
      fixture: {
        ...evidence.fixture,
        exactPathAttached: false,
      },
    };
    const withoutFingerprint = { ...contradictory };
    delete withoutFingerprint.contentFingerprint;
    expect(() =>
      HerdrPublicAdapterGateSchema.parse({
        ...withoutFingerprint,
        contentFingerprint:
          fingerprintHerdrPublicAdapterGateContent(withoutFingerprint),
      }),
    ).toThrow();
  });

  it("blocks on any terminal cleanup failure even when prior observations passed", () => {
    const evidence = createHerdrPublicAdapterGateEvidence({
      generatedAt: "2026-07-28T09:00:00.000Z",
      source: SOURCE,
      baselineSha256: "e".repeat(64),
      observations: passingObservations(),
      failureCode: "TEMP_FIXTURE_CLEANUP_FAILED",
    });

    expect(evidence.providerVerdict).toBe("BLOCKED");
    expect(evidence.failureCode).toBe("TEMP_FIXTURE_CLEANUP_FAILED");
    expect(evidence.checks).toContainEqual(
      expect.objectContaining({
        id: "resource_cleanup",
        status: "BLOCKED",
      }),
    );
    expect(
      evidence.subsequentTasks.every(({ status }) => status === "NOT_RUN"),
    ).toBe(true);
  });

  it("refuses a pre-existing target session before claiming cleanup ownership", () => {
    expect(() => assertOwnedSessionAbsent("absent")).not.toThrow();
    expect(() => assertOwnedSessionAbsent("running")).toThrow(
      "HERDR_OWNED_SESSION_COLLISION",
    );
    expect(() => assertOwnedSessionAbsent("stopped")).toThrow(
      "HERDR_OWNED_SESSION_COLLISION",
    );
  });

  it("records both permission probes only after both fail closed before I/O", async () => {
    const calls: string[][] = [];
    const receipt = await collectPermissionArgumentGate({
      run: async (args) => {
        calls.push([...args]);
        if (args.includes("--yolo")) {
          throw new HerdrAdapterError("HERDR_ARGUMENT_FORBIDDEN");
        }
        throw new HerdrAdapterError("HERDR_COMMAND_FORBIDDEN");
      },
    });

    expect(receipt).toEqual({
      dangerousArgumentRejectedBeforeIo: true,
      forceRemovalRejectedBeforeIo: true,
    });
    expect(calls).toHaveLength(2);
  });

  it("allows only the canonical Task 1 output and refuses to archive unsafe prior content", async () => {
    const repositoryRoot = resolve("C:\\fixture\\hunter");
    const intended =
      "docs/validation/evidence/herdr-control-plane/public-adapter-gate.json";
    expect(
      resolveHerdrPublicAdapterGateOutputPath(repositoryRoot, intended),
    ).toBe(resolve(repositoryRoot, intended));
    expect(() =>
      resolveHerdrPublicAdapterGateOutputPath(
        repositoryRoot,
        "docs/validation/evidence/herdr-control-plane/baseline.json",
      ),
    ).toThrow("HERDR_TASK1_OUTPUT_OUTSIDE_ALLOWED_ROOT");
    expect(() =>
      resolveHerdrPublicAdapterGateOutputPath(
        repositoryRoot,
        "docs/validation/evidence/herdr-control-plane/public-adapter-gate.attempts/forged.json",
      ),
    ).toThrow("HERDR_TASK1_OUTPUT_OUTSIDE_ALLOWED_ROOT");

    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "hunter-herdr-output-test-"),
    );
    try {
      const outputPath = join(
        temporaryRoot,
        "public-adapter-gate.json",
      );
      await mkdir(temporaryRoot, { recursive: true });
      await writeFile(
        outputPath,
        JSON.stringify({
          leakedPath: "C:\\Users\\Private\\secret.txt",
        }),
        "utf8",
      );
      expect(() =>
        prepareHerdrPublicAdapterGateOutput(outputPath),
      ).toThrow();
      expect(existsSync(outputPath)).toBe(true);
      expect(
        existsSync(join(temporaryRoot, "public-adapter-gate.attempts")),
      ).toBe(false);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("can create and clean the exact nested Hunter worktree shape used by the gate", async () => {
    await withTemporaryGitFixture(async (fixture) => {
      const worktreePath = join(
        fixture.path,
        ".hunter-task1-worktrees",
        "attach",
      );
      const runner = new NodeCommandRunner();
      const created = await runner.run({
        executable: "git",
        args: [
          "worktree",
          "add",
          "-b",
          "codex/herdr-task1-fixture",
          worktreePath,
          fixture.baselineCommit,
        ],
        cwd: fixture.path,
        timeoutMs: 15_000,
      });
      if (created.exitCode !== 0) {
        throw new Error(
          `TASK1_FIXTURE_WORKTREE_CREATE_FAILED:${created.stderr.trim()}`,
        );
      }
      const removed = await runner.run({
        executable: "git",
        args: ["worktree", "remove", worktreePath],
        cwd: fixture.path,
        timeoutMs: 15_000,
      });
      if (removed.exitCode !== 0) {
        throw new Error(
          `TASK1_FIXTURE_WORKTREE_REMOVE_FAILED:${removed.stderr.trim()}`,
        );
      }
      const branchRemoved = await runner.run({
        executable: "git",
        args: ["branch", "--delete", "codex/herdr-task1-fixture"],
        cwd: fixture.path,
        timeoutMs: 15_000,
      });
      if (branchRemoved.exitCode !== 0) {
        throw new Error(
          `TASK1_FIXTURE_BRANCH_REMOVE_FAILED:${branchRemoved.stderr.trim()}`,
        );
      }
    });
  });
});
