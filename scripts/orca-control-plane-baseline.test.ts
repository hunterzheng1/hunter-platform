import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  findBaselineTimeboxStart,
  inspectControlPlaneSource,
  prepareBaselineEvidenceOutput,
  resolveBaselineOutputPath,
} from "./orca-control-plane-baseline.js";
import { withTemporaryGitFixture } from "../spikes/testkit/src/index.js";

const SHA256_A = "a".repeat(64);
const SHA256_B = "b".repeat(64);

class FixtureRunner implements CommandRunner {
  readonly requests: CommandRequest[] = [];
  #active = false;

  async run(request: CommandRequest): Promise<CommandResult> {
    if (this.#active) throw new Error("CONCURRENT_PROBE_COMMAND");
    this.#active = true;
    this.requests.push(request);
    await Promise.resolve();
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
              appVersion: "0.8.0",
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
      [
        "powershell.exe\u0000-NoLogo\u0000-NoProfile\u0000-NonInteractive\u0000-File\u0000C:\\Users\\private\\codex.ps1\u0000--version",
        "codex-cli 0.1.0",
      ],
      [
        "powershell.exe\u0000-NoLogo\u0000-NoProfile\u0000-NonInteractive\u0000-File\u0000C:\\Users\\private\\codex.ps1\u0000login\u0000status",
        "Logged in using secret@example.invalid",
      ],
    ]);
    const stdout = outputs.get(key);
    try {
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
    } finally {
      this.#active = false;
    }
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
          launcherKind: "native",
          availability: "DETECTED",
          version: "v24.4.1",
          authentication: "DETECTED",
          authenticationRequired: false,
        },
        {
          id: "git",
          launcherKind: "native",
          availability: "DETECTED",
          version: "2.50.1.windows.1",
          authentication: "DETECTED",
          authenticationRequired: false,
        },
        {
          id: "orca",
          launcherKind: "native",
          availability: "DETECTED",
          version: null,
          authentication: "NOT_PROVEN",
          authenticationRequired: true,
        },
        {
          id: "codex",
          launcherKind: "native",
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
          outcome: "success",
          timeoutCleanup: "not_applicable",
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
      codexExecutable: "powershell.exe",
      codexPrefixArguments: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        "C:\\Users\\private\\codex.ps1",
      ],
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
      ["status", "--json"],
      ["repo", "--help"],
      ["worktree", "--help"],
      ["worktree", "create", "--help"],
      ["terminal", "--help"],
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        "C:\\Users\\private\\codex.ps1",
        "--version",
      ],
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        "C:\\Users\\private\\codex.ps1",
        "login",
        "status",
      ],
    ]);
    expect(evidence.tools).toContainEqual({
      id: "orca",
      launcherKind: "native",
      availability: "DETECTED",
      version: "0.8.0",
      authentication: "NOT_PROVEN",
      authenticationRequired: true,
    });
    expect(evidence.tools).toContainEqual({
      id: "codex",
      launcherKind: "powershell_script",
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
    expect(evidence.commandReceipts.every((receipt) =>
      receipt.outcome === "success"
      && receipt.timeoutCleanup === "not_applicable"
    )).toBe(true);
    expect(JSON.stringify(evidence)).not.toMatch(
      /C:\\Users\\private|secret@example|runtime-private|request-private/iu,
    );
    expect(evidence.mutationAttempted).toBe(false);

    const duplicateTools = [
      evidence.tools[0],
      evidence.tools[0],
      evidence.tools[2],
      evidence.tools[3],
    ];
    const duplicateToolResult = OrcaControlPlaneBaselineSchema.safeParse({
      ...evidence,
      tools: duplicateTools,
    });
    expect(duplicateToolResult.error?.issues.map((issue) => issue.message))
      .toContain("TOOL_INVENTORY_MISMATCH");

    const duplicateCapabilities = [
      evidence.capabilities[0],
      evidence.capabilities[0],
      ...evidence.capabilities.slice(2),
    ];
    const duplicateCapabilityResult = OrcaControlPlaneBaselineSchema.safeParse({
      ...evidence,
      capabilities: duplicateCapabilities,
    });
    expect(duplicateCapabilityResult.error?.issues.map((issue) => issue.message))
      .toContain("CAPABILITY_RECEIPT_DUPLICATE");
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

  it("archives an earlier failed baseline by content hash before a retry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hunter-orca-baseline-test-"));
    const target = join(directory, "baseline.json");
    const failedEvidence = "{\"providerVerdict\":\"NOT_PROVEN\"}\n";
    try {
      await writeFile(target, failedEvidence, "utf8");

      const archived = prepareBaselineEvidenceOutput(target);

      expect(archived).toMatch(
        /baseline\.attempts[\\/][a-f0-9]{64}\.json$/u,
      );
      await expect(readFile(archived, "utf8")).resolves.toBe(failedEvidence);
      await expect(readFile(target, "utf8")).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the earliest valid timebox start across archived retries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hunter-orca-timebox-test-"));
    const target = join(directory, "baseline.json");
    const attempts = join(directory, "baseline.attempts");
    try {
      await mkdir(attempts);
      await writeFile(
        target,
        JSON.stringify({
          timebox: { startedAt: "2026-07-28T04:25:00.000Z" },
        }),
        "utf8",
      );
      await writeFile(
        join(attempts, `${"a".repeat(64)}.json`),
        JSON.stringify({
          timebox: { startedAt: "2026-07-28T04:19:30.589Z" },
        }),
        "utf8",
      );

      expect(
        findBaselineTimeboxStart(
          target,
          "2026-07-28T04:30:00.000Z",
        ),
      ).toBe("2026-07-28T04:19:30.589Z");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed instead of resetting a timebox when history is invalid", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hunter-orca-timebox-invalid-"));
    const target = join(directory, "baseline.json");
    try {
      await writeFile(target, "{\"timebox\":{\"startedAt\":\"not-a-date\"}}", "utf8");
      expect(() =>
        findBaselineTimeboxStart(
          target,
          "2026-07-28T04:30:00.000Z",
        ),
      ).toThrow("BASELINE_TIMEBOX_HISTORY_INVALID");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
