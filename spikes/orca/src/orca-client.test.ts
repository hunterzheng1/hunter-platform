import { describe, expect, it } from "vitest";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "../../testkit/src/index.js";
import { OrcaClient } from "./orca-client.js";

class RecordingRunner implements CommandRunner {
  readonly requests: CommandRequest[] = [];

  constructor(private readonly result: Partial<CommandResult>) {}

  async run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push(request);
    return {
      executable: request.executable,
      args: request.args,
      cwd: request.cwd,
      exitCode: this.result.exitCode ?? 0,
      stdout: this.result.stdout ?? "",
      stderr: this.result.stderr ?? "",
      timedOut: this.result.timedOut ?? false,
      spawnError: this.result.spawnError,
      startedAt: "2026-07-22T00:00:00.000Z",
      finishedAt: "2026-07-22T00:00:01.000Z",
    };
  }
}

class SequencedRunner implements CommandRunner {
  readonly requests: CommandRequest[] = [];
  readonly #stdout: string[];

  constructor(stdout: readonly unknown[]) {
    this.#stdout = stdout.map((value) => JSON.stringify(value));
  }

  async run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push(request);
    const stdout = this.#stdout.shift();
    if (stdout === undefined) throw new Error("MISSING_FIXTURE_RESULT");
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

describe("OrcaClient", () => {
  it("maps status to an argv-only JSON call and retains unknown upstream fields", async () => {
    const upstream = {
      id: "request-1",
      ok: true,
      result: {
        app: { running: true, pid: 42, desktopWindowStatus: "open" },
        runtime: { state: "ready", reachable: true, runtimeId: "runtime-1" },
        graph: { state: "ready" },
      },
      _meta: { runtimeId: "runtime-1" },
      futureField: { retained: true },
    };
    const runner = new RecordingRunner({ stdout: JSON.stringify(upstream) });
    const client = new OrcaClient({
      runner,
      executable: "orca",
      cwd: "C:\\fixture",
      timeoutMs: 5_000,
    });

    const receipt = await client.status();

    expect(runner.requests).toEqual([
      {
        executable: "orca",
        args: ["status", "--json"],
        cwd: "C:\\fixture",
        timeoutMs: 5_000,
      },
    ]);
    expect(receipt.known).toEqual({
      app: { running: true, pid: 42, desktopWindowStatus: "open" },
      runtime: { state: "ready", reachable: true, runtimeId: "runtime-1" },
      graph: { state: "ready" },
    });
    expect(receipt.raw).toEqual(upstream);
  });

  it("passes the repository path as a distinct argv value", async () => {
    const upstream = {
      id: "request-2",
      ok: true,
      result: { repo: { id: "repo-1" } },
    };
    const runner = new RecordingRunner({ stdout: JSON.stringify(upstream) });
    const client = new OrcaClient({
      runner,
      executable: "orca",
      cwd: "C:\\fixture",
      timeoutMs: 5_000,
    });

    const receipt = await client.addRepo("C:\\temp root\\fixture repo");

    expect(runner.requests[0]?.args).toEqual([
      "repo",
      "add",
      "--path",
      "C:\\temp root\\fixture repo",
      "--json",
    ]);
    expect(receipt.raw).toEqual(upstream);
  });

  it("maps worktree creation without concatenating identifiers or prompts", async () => {
    const upstream = {
      id: "request-3",
      ok: true,
      result: {
        worktree: { id: "repo-1::C:\\temp\\hunter-phase0-worktree" },
        startupTerminal: { handle: "terminal-1" },
      },
    };
    const runner = new RecordingRunner({ stdout: JSON.stringify(upstream) });
    const client = new OrcaClient({
      runner,
      executable: "orca",
      cwd: "C:\\fixture",
      timeoutMs: 5_000,
    });

    const receipt = await client.createWorktree({
      repoId: "repo-1",
      name: "hunter-phase0",
      agent: "codex",
      setup: "skip",
    });

    expect(runner.requests[0]?.args).toEqual([
      "worktree",
      "create",
      "--repo",
      "id:repo-1",
      "--name",
      "hunter-phase0",
      "--agent",
      "codex",
      "--setup",
      "skip",
      "--json",
    ]);
    expect(receipt.known.worktree.id).toBe(
      "repo-1::C:\\temp\\hunter-phase0-worktree",
    );
  });

  it("maps the terminal lifecycle to distinct argv values", async () => {
    const ok = (result: unknown, index: number) => ({
      id: `request-${index}`,
      ok: true,
      result,
    });
    const runner = new SequencedRunner([
      ok({ terminals: [{ handle: "terminal-1" }] }, 4),
      ok({ terminal: { handle: "terminal-2" } }, 5),
      ok({ accepted: true }, 6),
      ok(
        {
          text: "HUNTER_READY",
          nextCursor: "cursor-2",
          latestCursor: "cursor-2",
          limited: false,
        },
        7,
      ),
      ok({ observation: "tui-idle" }, 8),
      ok({ closed: true }, 9),
      ok({ removed: true }, 10),
    ]);
    const client = new OrcaClient({
      runner,
      executable: "orca",
      cwd: "C:\\fixture",
      timeoutMs: 5_000,
    });
    const worktreeId = "repo-1::C:\\temp\\hunter-phase0-worktree";

    await client.listTerminals(worktreeId);
    await client.createTerminal({
      worktreeId,
      title: "hunter-probe",
      command: "pwsh",
    });
    await client.send({
      terminalHandle: "terminal-2",
      text: "Write-Output HUNTER_READY",
      enter: true,
    });
    const readReceipt = await client.read({
      terminalHandle: "terminal-2",
      cursor: "cursor-1",
      limit: 1_000,
    });
    await client.wait({
      terminalHandle: "terminal-2",
      for: "tui-idle",
      timeoutMs: 300_000,
    });
    await client.closeTerminal("terminal-2");
    await client.removeWorktree(worktreeId);

    expect(runner.requests.map((request) => request.args)).toEqual([
      ["terminal", "list", "--worktree", `id:${worktreeId}`, "--json"],
      [
        "terminal",
        "create",
        "--worktree",
        `id:${worktreeId}`,
        "--title",
        "hunter-probe",
        "--command",
        "pwsh",
        "--json",
      ],
      [
        "terminal",
        "send",
        "--terminal",
        "terminal-2",
        "--text",
        "Write-Output HUNTER_READY",
        "--enter",
        "--json",
      ],
      [
        "terminal",
        "read",
        "--terminal",
        "terminal-2",
        "--cursor",
        "cursor-1",
        "--limit",
        "1000",
        "--json",
      ],
      [
        "terminal",
        "wait",
        "--terminal",
        "terminal-2",
        "--for",
        "tui-idle",
        "--timeout-ms",
        "300000",
        "--json",
      ],
      ["terminal", "close", "--terminal", "terminal-2", "--json"],
      ["worktree", "rm", "--worktree", `id:${worktreeId}`, "--force", "--json"],
    ]);
    expect(readReceipt.known.text).toContain("HUNTER_READY");
  });
});
