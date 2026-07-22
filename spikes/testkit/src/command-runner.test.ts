import { describe, expect, it } from "vitest";
import { NodeCommandRunner } from "./index.js";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

describe("node command runner", () => {
  it("records a synchronous spawn denial instead of aborting the inventory", async () => {
    const runner = new NodeCommandRunner(() => {
      const error = new Error("spawn EPERM") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });

    await expect(
      runner.run({
        executable: "blocked-tool",
        args: ["--version"],
        cwd: process.cwd(),
        timeoutMs: 100,
      }),
    ).resolves.toMatchObject({
      exitCode: null,
      spawnError: "EPERM",
      timedOut: false,
    });
  });

  it("passes explicit environment overrides without shell interpolation", async () => {
    const runner = new NodeCommandRunner();

    const result = await runner.run({
      executable: process.execPath,
      args: [
        "-e",
        "process.stdout.write(process.env.HUNTER_COMMAND_RUNNER_PROBE ?? 'missing')",
      ],
      cwd: process.cwd(),
      timeoutMs: 1_000,
      environment: { HUNTER_COMMAND_RUNNER_PROBE: "isolated" },
    });

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "isolated",
      timedOut: false,
      timeoutCleanup: "not_applicable",
      spawnError: null,
    });
  });

  it("writes an exact confirmation value to stdin and closes the stream", async () => {
    const runner = new NodeCommandRunner();

    const result = await runner.run({
      executable: process.execPath,
      args: [
        "-e",
        "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>process.stdout.write(input))",
      ],
      cwd: process.cwd(),
      timeoutMs: 1_000,
      stdin: "hunter-phase0-fixture\n",
    });

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "hunter-phase0-fixture\n",
      timedOut: false,
      spawnError: null,
    });
  });

  it("bounds timeout cleanup and terminates the spawned process tree", async () => {
    const runner = new NodeCommandRunner();
    let rootPid: number | undefined;
    let descendantPid: number | undefined;

    try {
      const result = await runner.run({
        executable: process.execPath,
        args: [
          "-e",
          "const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write(JSON.stringify({root:process.pid,descendant:child.pid})+'\\n');setInterval(()=>{},1000)",
        ],
        cwd: process.cwd(),
        timeoutMs: 250,
      });
      const pids = JSON.parse(result.stdout.trim()) as {
        readonly root: number;
        readonly descendant: number;
      };
      rootPid = pids.root;
      descendantPid = pids.descendant;

      expect(result.timedOut).toBe(true);
      expect(isProcessAlive(rootPid)).toBe(false);
      expect(Number.isInteger(descendantPid)).toBe(true);
      expect(["process_tree_terminated", "not_proven"]).toContain(result.timeoutCleanup);
      if (result.timeoutCleanup === "process_tree_terminated") {
        expect(isProcessAlive(descendantPid)).toBe(false);
      }
    } finally {
      if (rootPid !== undefined && isProcessAlive(rootPid)) {
        process.kill(rootPid, "SIGKILL");
      }
      if (descendantPid !== undefined && isProcessAlive(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
    }
  }, 5_000);
});
