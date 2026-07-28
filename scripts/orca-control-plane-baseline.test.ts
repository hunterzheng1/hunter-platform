import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "../spikes/testkit/src/index.js";
import {
  CONTROL_PLANE_SOURCE_PATHSPEC,
  OrcaControlPlaneBaselineSchema,
  collectOrcaControlPlaneBaseline,
  createOrcaControlPlaneBaseline,
  inspectControlPlaneSource,
  resolveBaselineOutputPath,
} from "./orca-control-plane-baseline.js";
import { withTemporaryGitFixture } from "../spikes/testkit/src/index.js";

const SHA256_A = "a".repeat(64);
const SHA256_B = "b".repeat(64);

class FixtureRunner implements CommandRunner {
  readonly requests: CommandRequest[] = [];

  async run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push(request);
    const key = `${request.executable}\u0000${request.args.join("\u0000")}`;
    const outputs = new Map<string, string>([
      ["node\u0000--version", "v24.4.1"],
      ["git\u0000--version", "git version 2.50.1.windows.1"],
      ["C:\\Users\\private\\orca.exe\u0000--version", "Orca 0.8.0"],
      [
        "C:\\Users\\private\\orca.exe\u0000status\u0000--json",
        JSON.stringify({
          id: "request-private",
          ok: true,
          result: {
            app: { running: true, pid: 42, desktopWindowStatus: "open" },
            runtime: {
              state: "ready",
              reachable: true,
              runtimeId: "runtime-private",
            },
            graph: { state: "ready" },
          },
        }),
      ],
      [
        "C:\\Users\\private\\orca.exe\u0000repo\u0000--help",
        "Commands: list add show set-base-ref search-refs",
      ],
      [
        "C:\\Users\\private\\orca.exe\u0000worktree\u0000--help",
        "Commands: create list rm show",
      ],
      [
        "C:\\Users\\private\\orca.exe\u0000worktree\u0000create\u0000--help",
        "Options: --repo --name --agent --setup --base-branch --json",
      ],
      [
        "C:\\Users\\private\\orca.exe\u0000terminal\u0000--help",
        "Commands: create list send read wait close",
      ],
      ["codex\u0000--version", "codex-cli 0.1.0"],
      ["codex\u0000login\u0000status", "Logged in using secret@example.invalid"],
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
      startedAt: "2026-07-28T04:15:00.000Z",
      finishedAt: "2026-07-28T04:15:01.000Z",
    };
  }
}

describe("Orca control-plane baseline evidence", () => {
  it("freezes a five-working-day Shanghai timebox and the zero-paid two-attempt budget", () => {
    const evidence = createOrcaControlPlaneBaseline({
      generatedAt: "2026-07-28T04:15:00.000Z",
      timeboxStartedAt: "2026-07-28T04:15:00.000Z",
      source: {
        commit: "1".repeat(40),
        digest: SHA256_A,
        clean: true,
      },
      host: {
        platform: "win32",
        architecture: "x64",
        release: "10.0.26100",
      },
      tools: [
        {
          id: "node",
          availability: "DETECTED",
          version: "v24.4.1",
          authentication: "DETECTED",
          authenticationRequired: false,
        },
        {
          id: "git",
          availability: "DETECTED",
          version: "2.50.1.windows.1",
          authentication: "DETECTED",
          authenticationRequired: false,
        },
        {
          id: "orca",
          availability: "DETECTED",
          version: null,
          authentication: "NOT_PROVEN",
          authenticationRequired: true,
        },
        {
          id: "codex",
          availability: "DETECTED",
          version: "codex-cli 0.1.0",
          authentication: "NOT_PROVEN",
          authenticationRequired: true,
        },
      ],
      publicInterfaces: [
        {
          operation: "status",
          status: "DETECTED",
          receiptHash: SHA256_B,
        },
        {
          operation: "workspace_attach_existing",
          status: "NOT_PROVEN",
          receiptHash: SHA256_B,
        },
      ],
      capabilities: [
        {
          id: "discover_runtime",
          status: "PASS",
          reason: "status_json_reports_running_reachable_runtime",
          receiptHash: SHA256_B,
        },
        {
          id: "workspace_attach_existing",
          status: "NOT_PROVEN",
          reason: "mutating_fixture_not_run",
          receiptHash: null,
        },
      ],
      commandReceipts: [
        {
          operation: "orca_status",
          executable: "orca",
          args: ["status", "--json"],
          exitCode: 0,
          timedOut: false,
          outputHash: SHA256_B,
        },
      ],
    });

    expect(() => OrcaControlPlaneBaselineSchema.parse(evidence)).not.toThrow();
    expect(evidence.timebox).toEqual({
      timezone: "Asia/Shanghai",
      workingDays: 5,
      weekendDays: ["saturday", "sunday"],
      startedAt: "2026-07-28T04:15:00.000Z",
      deadlineAt: "2026-08-04T04:15:00.000Z",
    });
    expect(evidence.runBudget).toEqual({
      maxAttempts: 2,
      maxSessionsPerAttempt: 1,
      maxSendsPerAttempt: 4,
      maxAttemptDurationMs: 1_200_000,
      maxTotalExecutionMs: 2_700_000,
      additionalPaidBudgetUsd: 0,
    });
    expect(evidence.source).toEqual({
      commit: "1".repeat(40),
      digest: SHA256_A,
      clean: true,
      digestAlgorithm: "sha256-path-content-v1",
      pathspec: CONTROL_PLANE_SOURCE_PATHSPEC,
    });
    expect(evidence.providerVerdict).toBe("NOT_PROVEN");
    expect(evidence.historicalEvidence).toEqual({
      readOnly: true,
      references: [
        "docs/validation/phase-0-decision.md",
        "docs/validation/gate-r1-runtime-connectors.md",
        "docs/validation/evidence/gate-r1/runtime-connectors.json",
      ],
    });
  });

  it("collects only redacted read-only public-interface receipts without promoting attach", async () => {
    const runner = new FixtureRunner();

    const evidence = await collectOrcaControlPlaneBaseline({
      runner,
      cwd: "C:\\Users\\private\\hunter-platform",
      orcaExecutable: "C:\\Users\\private\\orca.exe",
      codexExecutable: "codex",
      now: () => new Date("2026-07-28T04:15:00.000Z"),
      source: {
        commit: "1".repeat(40),
        digest: SHA256_A,
        clean: true,
      },
      host: {
        platform: "win32",
        architecture: "x64",
        release: "10.0.26100",
      },
    });

    expect(runner.requests.map((request) => request.args)).toEqual([
      ["--version"],
      ["--version"],
      ["--version"],
      ["status", "--json"],
      ["repo", "--help"],
      ["worktree", "--help"],
      ["worktree", "create", "--help"],
      ["terminal", "--help"],
      ["--version"],
      ["login", "status"],
    ]);
    expect(evidence.tools).toContainEqual({
      id: "orca",
      availability: "DETECTED",
      version: "0.8.0",
      authentication: "NOT_PROVEN",
      authenticationRequired: true,
    });
    expect(evidence.tools).toContainEqual({
      id: "codex",
      availability: "DETECTED",
      version: "0.1.0",
      authentication: "DETECTED",
      authenticationRequired: true,
    });
    expect(evidence.capabilities).toContainEqual({
      id: "discover_runtime",
      status: "PASS",
      reason: "status_json_reports_running_reachable_runtime",
      receiptHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(evidence.capabilities).toContainEqual({
      id: "workspace_attach_existing",
      status: "NOT_PROVEN",
      reason: "mutating_temporary_fixture_not_run",
      receiptHash: null,
    });
    expect(JSON.stringify(evidence)).not.toMatch(
      /C:\\Users\\private|secret@example|runtime-private|request-private/iu,
    );
    expect(evidence.mutationAttempted).toBe(false);
  });

  it("binds a clean source digest and detects later source drift in a temporary Git fixture", async () => {
    await withTemporaryGitFixture(async (fixture) => {
      const baseline = inspectControlPlaneSource({
        cwd: fixture.path,
        pathspec: ["README.md"],
      });

      expect(baseline).toEqual({
        commit: fixture.baselineCommit,
        digest:
          "0476de4ebdb43c284dcb8135e80d1d43123e0c3c19e3945a60800a05b2df2a00",
        clean: true,
      });

      await writeFile(
        `${fixture.path}\\README.md`,
        "# Hunter changed fixture\n",
        "utf8",
      );
      const drifted = inspectControlPlaneSource({
        cwd: fixture.path,
        pathspec: ["README.md"],
      });
      expect(drifted.clean).toBe(false);
      expect(drifted.digest).not.toBe(baseline.digest);
    });
  });

  it("confines evidence output to the versioned Orca control-plane directory", () => {
    expect(
      resolveBaselineOutputPath(
        "C:\\repo",
        "docs/validation/evidence/orca-control-plane/baseline.json",
      ),
    ).toBe(
      "C:\\repo\\docs\\validation\\evidence\\orca-control-plane\\baseline.json",
    );
    expect(() =>
      resolveBaselineOutputPath(
        "C:\\repo",
        "docs/validation/evidence/orca/baseline.json",
      ),
    ).toThrow("BASELINE_EVIDENCE_OUTPUT_OUTSIDE_ALLOWED_ROOT");
    expect(() =>
      resolveBaselineOutputPath("C:\\repo", "C:\\tmp\\baseline.json"),
    ).toThrow("BASELINE_EVIDENCE_OUTPUT_OUTSIDE_ALLOWED_ROOT");
  });
});
