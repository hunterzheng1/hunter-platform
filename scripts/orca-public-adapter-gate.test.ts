import { describe, expect, it } from "vitest";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "../spikes/testkit/src/index.js";
import {
  OrcaPublicAdapterGateSchema,
  collectOrcaPublicAdapterGate,
} from "./orca-public-adapter-gate.js";

const SOURCE = {
  commit: "1".repeat(40),
  digest: "a".repeat(64),
  clean: true as const,
};

class PublicHelpRunner implements CommandRunner {
  readonly requests: CommandRequest[] = [];

  async run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push(request);
    const key = request.args.join("\u0000");
    const outputs = new Map<string, string>([
      [
        "status\u0000--json",
        JSON.stringify({
          id: "local-status",
          ok: true,
          result: {
            app: { running: true },
            runtime: {
              state: "ready",
              reachable: true,
              appVersion: "1.4.159",
            },
            graph: { state: "ready" },
          },
        }),
      ],
      [
        "repo\u0000--help",
        [
          "Commands:",
          "  list  List repos registered in Orca",
          "  add   Add a project to Orca by filesystem path",
          "  show  Show one registered repo",
        ].join("\n"),
      ],
      [
        "repo\u0000add\u0000--help",
        "Usage: orca repo add --path <path> [--json]",
      ],
      [
        "worktree\u0000--help",
        [
          "Commands:",
          "  list    List Orca-managed worktrees",
          "  create  Create a new Orca-managed worktree",
          "  set     Update Orca metadata for a worktree",
          "  rm      Remove a worktree from Orca and git",
        ].join("\n"),
      ],
      [
        "worktree\u0000create\u0000--help",
        [
          "Create a new Orca-managed worktree",
          "Notes:",
          "  This creates a new checkout.",
        ].join("\n"),
      ],
      [
        "worktree\u0000set\u0000--help",
        "Update Orca metadata for a worktree",
      ],
      [
        "worktree\u0000rm\u0000--help",
        "Remove a worktree from Orca and git",
      ],
    ]);
    const stdout = outputs.get(key);
    return {
      executable: request.executable,
      args: request.args,
      cwd: request.cwd,
      exitCode: stdout === undefined ? 1 : 0,
      stdout: stdout ?? "",
      stderr: stdout === undefined ? "unsupported" : "",
      timedOut: false,
      spawnError: null,
      startedAt: "2026-07-28T05:30:00.000Z",
      finishedAt: "2026-07-28T05:30:01.000Z",
    };
  }
}

class InconclusiveHelpRunner extends PublicHelpRunner {
  override async run(request: CommandRequest): Promise<CommandResult> {
    const result = await super.run(request);
    return request.args.join("\u0000") === "worktree\u0000--help"
      ? {
          ...result,
          exitCode: 1,
          stdout: "",
          stderr: "help unavailable",
        }
      : result;
  }
}

describe("Orca public adapter gate", () => {
  it("fails closed without mutating when public CLI cannot attach and detach an exact existing worktree", async () => {
    const runner = new PublicHelpRunner();
    const evidence = await collectOrcaPublicAdapterGate({
      runner,
      cwd: "C:\\fixture",
      orcaExecutable: "C:\\private\\orca.exe",
      generatedAt: "2026-07-28T05:30:00.000Z",
      source: SOURCE,
      baseline: {
        path: "docs/validation/evidence/orca-control-plane/baseline.json",
        sha256: "b".repeat(64),
        sourceCommit: "2".repeat(40),
        sourceDigest: "c".repeat(64),
        timeboxStartedAt: "2026-07-28T04:19:30.589Z",
        timeboxDeadlineAt: "2026-08-04T04:19:30.589Z",
      },
    });

    expect(runner.requests.map(({ args }) => args)).toEqual([
      ["status", "--json"],
      ["repo", "--help"],
      ["repo", "add", "--help"],
      ["worktree", "--help"],
      ["worktree", "create", "--help"],
      ["worktree", "set", "--help"],
      ["worktree", "rm", "--help"],
    ]);
    expect(evidence.providerVerdict).toBe("BLOCKED");
    expect(evidence.mutationAttempted).toBe(false);
    expect(evidence.publicSurface).toEqual({
      exactExistingWorktreeAttachDetected: false,
      nonDestructiveDeregisterDetected: false,
      repoRemoveCommandDetected: false,
      worktreeCreateCreatesNewCheckout: true,
      worktreeRemoveDeletesGitWorktree: true,
      worktreeSetOnlyUpdatesMetadata: true,
    });
    expect(evidence.capabilities).toEqual([
      expect.objectContaining({ id: "fixed_version", status: "PASS" }),
      expect.objectContaining({
        id: "workspace_attach_existing",
        status: "BLOCKED",
      }),
      expect.objectContaining({
        id: "resource_cleanup",
        status: "BLOCKED",
      }),
      expect.objectContaining({
        id: "permission_argument_gate",
        status: "CONTRACT_ONLY",
      }),
      expect.objectContaining({
        id: "security_defaults",
        status: "NOT_PROVEN",
      }),
    ]);
    expect(evidence.budgetUsage).toEqual({
      realAttempts: 0,
      realSessions: 0,
      sends: 0,
      additionalPaidBudgetUsd: 0,
    });
    expect(evidence.cleanup).toEqual({
      status: "NOT_REQUIRED",
      reason: "no_provider_resource_created",
    });
    expect(evidence.subsequentTasks).toEqual([
      { task: 2, status: "NOT_RUN" },
      { task: 3, status: "NOT_RUN" },
      { task: 4, status: "NOT_RUN" },
      { task: 5, status: "NOT_RUN" },
      { task: 6, status: "NOT_RUN" },
      { task: 7, status: "NOT_RUN" },
      { task: 8, status: "NOT_RUN" },
    ]);
    expect(JSON.stringify(evidence)).not.toContain("C:\\private");
    expect(evidence.contentFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects a forged PASS over the same blocked public surface", async () => {
    const evidence = await collectOrcaPublicAdapterGate({
      runner: new PublicHelpRunner(),
      cwd: "C:\\fixture",
      orcaExecutable: "orca",
      generatedAt: "2026-07-28T05:30:00.000Z",
      source: SOURCE,
      baseline: {
        path: "docs/validation/evidence/orca-control-plane/baseline.json",
        sha256: "b".repeat(64),
        sourceCommit: "2".repeat(40),
        sourceDigest: "c".repeat(64),
        timeboxStartedAt: "2026-07-28T04:19:30.589Z",
        timeboxDeadlineAt: "2026-08-04T04:19:30.589Z",
      },
    });
    expect(() =>
      OrcaPublicAdapterGateSchema.parse({
        ...evidence,
        providerVerdict: "PASS",
      }),
    ).toThrow();

    expect(() =>
      OrcaPublicAdapterGateSchema.parse({
        ...evidence,
        commandReceipts: [
          evidence.commandReceipts[0],
          evidence.commandReceipts[0],
          ...evidence.commandReceipts.slice(2),
        ],
      }),
    ).toThrow();
  });

  it("records NOT_PROVEN instead of losing evidence when help inventory is incomplete", async () => {
    const evidence = await collectOrcaPublicAdapterGate({
      runner: new InconclusiveHelpRunner(),
      cwd: "C:\\fixture",
      orcaExecutable: "orca",
      generatedAt: "2026-07-28T05:30:00.000Z",
      source: SOURCE,
      baseline: {
        path: "docs/validation/evidence/orca-control-plane/baseline.json",
        sha256: "b".repeat(64),
        sourceCommit: "2".repeat(40),
        sourceDigest: "c".repeat(64),
        timeboxStartedAt: "2026-07-28T04:19:30.589Z",
        timeboxDeadlineAt: "2026-08-04T04:19:30.589Z",
      },
    });

    expect(evidence.providerVerdict).toBe("NOT_PROVEN");
    expect(evidence.capabilities).toEqual([
      expect.objectContaining({ id: "fixed_version", status: "PASS" }),
      expect.objectContaining({
        id: "workspace_attach_existing",
        status: "NOT_PROVEN",
      }),
      expect.objectContaining({
        id: "resource_cleanup",
        status: "NOT_PROVEN",
      }),
      expect.objectContaining({
        id: "permission_argument_gate",
        status: "CONTRACT_ONLY",
      }),
      expect.objectContaining({
        id: "security_defaults",
        status: "NOT_PROVEN",
      }),
    ]);
  });
});
