import { describe, expect, it } from "vitest";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "../../testkit/src/index.js";
import {
  OrcaPreflightEvidenceSchema,
  createOrcaPreflightEvidence,
} from "./scenario.js";

class FixtureRunner implements CommandRunner {
  readonly requests: CommandRequest[] = [];

  constructor(
    private readonly volatile: {
      readonly requestId: string;
      readonly runtimeId: string;
      readonly pid: number;
    } = { requestId: "request-1", runtimeId: "runtime-1", pid: 42 },
  ) {}

  async run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push(request);
    const key = request.args.join(" ");
    const stdout =
      key === "status --json"
        ? JSON.stringify({
            id: this.volatile.requestId,
            ok: true,
            result: {
              app: {
                running: true,
                pid: this.volatile.pid,
                desktopWindowStatus: "open",
              },
              runtime: {
                state: "ready",
                reachable: true,
                runtimeId: this.volatile.runtimeId,
              },
              graph: { state: "ready" },
            },
            _meta: { runtimeId: this.volatile.runtimeId },
          })
        : key === "repo --help"
          ? "Commands: list add show set-base-ref search-refs"
          : key === "worktree create --help"
            ? "Options: --repo --name --agent --setup --base-branch --json"
            : "Options: --worktree --title --command --json";
    return {
      executable: request.executable,
      args: request.args,
      cwd: request.cwd,
      exitCode: 0,
      stdout,
      stderr: "",
      timedOut: false,
      spawnError: null,
      startedAt: "2026-07-22T00:00:00.000Z",
      finishedAt: "2026-07-22T00:00:01.000Z",
    };
  }
}

describe("Orca Phase 0 preflight evidence", () => {
  it("records discover PASS but refuses an unconfined mutating scenario", async () => {
    const runner = new FixtureRunner();

    const evidence = await createOrcaPreflightEvidence({
      runner,
      executable: "C:\\Users\\hunter\\Programs\\orca\\orca.exe",
      cwd: "C:\\Users\\hunter\\hunter-platform",
      now: () => new Date("2026-07-22T00:00:00.000Z"),
      host: { platform: "win32", architecture: "x64", release: "10.0" },
    });

    expect(() => OrcaPreflightEvidenceSchema.parse(evidence)).not.toThrow();
    expect(evidence.providerVerdict).toBe("NOT_PROVEN");
    expect(evidence.mutationAttempted).toBe(false);
    expect(evidence.capabilities).toContainEqual({
      id: "discover_runtime",
      outcome: "PASS",
      reason: "status_json_reports_running_reachable_runtime",
    });
    expect(evidence.capabilities).toContainEqual({
      id: "workspace_create",
      outcome: "NOT_PROVEN",
      reason: "public_cli_has_no_fixture_destination_flag",
    });
    expect(evidence.capabilities).toContainEqual({
      id: "resource_cleanup",
      outcome: "NOT_PROVEN",
      reason: "public_cli_has_no_repo_remove_command",
    });
    expect(runner.requests.map((request) => request.args)).toEqual([
      ["status", "--json"],
      ["repo", "--help"],
      ["worktree", "create", "--help"],
      ["terminal", "create", "--help"],
    ]);
    expect(JSON.stringify(evidence)).not.toContain("C:\\Users\\hunter");
  });

  it("keeps the content fingerprint stable across volatile upstream identities", async () => {
    const create = async (
      runner: FixtureRunner,
      generatedAt: string,
    ) =>
      await createOrcaPreflightEvidence({
        runner,
        executable: "orca",
        cwd: "C:\\fixture",
        now: () => new Date(generatedAt),
        host: { platform: "win32", architecture: "x64", release: "10.0" },
      });

    const first = await create(
      new FixtureRunner({ requestId: "request-a", runtimeId: "runtime-a", pid: 42 }),
      "2026-07-22T00:00:00.000Z",
    );
    const second = await create(
      new FixtureRunner({ requestId: "request-b", runtimeId: "runtime-b", pid: 84 }),
      "2026-07-22T01:00:00.000Z",
    );

    expect(second.commands[0]?.outputSha256).toBe(first.commands[0]?.outputSha256);
    expect(second.contentFingerprint).toBe(first.contentFingerprint);
  });
});
