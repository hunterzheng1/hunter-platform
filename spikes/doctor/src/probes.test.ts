import { describe, expect, it } from "vitest";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "../../testkit/src/index.js";
import {
  createDoctorInventory,
  finalizeTimeboxedStatus,
} from "./probes.js";

class FixtureRunner implements CommandRunner {
  readonly #results: ReadonlyMap<string, Partial<CommandResult>>;

  constructor(results: Readonly<Record<string, Partial<CommandResult>>>) {
    this.#results = new Map(Object.entries(results));
  }

  async run(request: CommandRequest): Promise<CommandResult> {
    const key = [request.executable, ...request.args].join(" ");
    const result = this.#results.get(key) ?? {
      exitCode: null,
      spawnError: "ENOENT",
    };
    return {
      executable: request.executable,
      args: request.args,
      cwd: request.cwd,
      exitCode: result.exitCode ?? null,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      timedOut: result.timedOut ?? false,
      spawnError: result.spawnError,
      startedAt: "2026-07-21T00:00:00.000Z",
      finishedAt: "2026-07-21T00:00:01.000Z",
    };
  }
}

describe("phase 0 doctor", () => {
  it("continues inventory when optional tools are unavailable", async () => {
    const runner = new FixtureRunner({
      "node --version": { exitCode: 0, stdout: "v24.14.0" },
      "git --version": { exitCode: 0, stdout: "git version 2.49.0" },
      "codex --version": { exitCode: 0, stdout: "codex-cli 1.2.3" },
      "codex login status": {
        exitCode: 1,
        stderr: "Not logged in",
      },
      "cursor --version": { exitCode: 0, stdout: "2.0.0" },
    });

    const inventory = await createDoctorInventory({
      runner,
      cwd: "C:\\Users\\hunter\\hunter-platform",
      now: () => new Date("2026-07-21T00:00:00.000Z"),
      host: { platform: "win32", architecture: "x64", release: "10.0" },
    });

    expect(inventory.probes.find((probe) => probe.id === "node")?.status).toBe(
      "DETECTED",
    );
    expect(inventory.probes.find((probe) => probe.id === "codex")?.status).toBe(
      "BLOCKED",
    );
    expect(inventory.probes.find((probe) => probe.id === "cursor")?.status).toBe(
      "NOT_PROVEN",
    );
    expect(inventory.probes.find((probe) => probe.id === "orca")?.status).toBe(
      "BLOCKED",
    );
    expect(inventory.probes).toHaveLength(8);
    expect(JSON.stringify(inventory)).not.toContain("C:\\Users\\hunter");
  });

  it("converts a timeboxed blocked capability to not proven without inventing pass", () => {
    expect(finalizeTimeboxedStatus("BLOCKED")).toBe("NOT_PROVEN");
    expect(finalizeTimeboxedStatus("NOT_PROVEN")).toBe("NOT_PROVEN");
    expect(finalizeTimeboxedStatus("DETECTED")).toBe("DETECTED");
  });

  it("uses a configured Orca executable without leaking its private path or inventing a version", async () => {
    const orcaExecutable = "C:\\Users\\hunter\\Programs\\orca\\orca.exe";
    const runner = new FixtureRunner({
      "node --version": { exitCode: 0, stdout: "v24.14.0" },
      "git --version": { exitCode: 0, stdout: "git version 2.49.0" },
      [`${orcaExecutable} --version`]: { exitCode: 0, stdout: "orca" },
      [`${orcaExecutable} --help`]: { exitCode: 0, stdout: "safe help" },
      [`${orcaExecutable} status --json`]: {
        exitCode: 0,
        stdout: JSON.stringify({
          id: "request-1",
          ok: true,
          result: {
            app: { running: true },
            runtime: { state: "ready", reachable: true },
          },
        }),
      },
    });

    const inventory = await createDoctorInventory({
      runner,
      cwd: "C:\\Users\\hunter\\hunter-platform",
      now: () => new Date("2026-07-22T00:00:00.000Z"),
      host: { platform: "win32", architecture: "x64", release: "10.0" },
      executableOverrides: { orca: orcaExecutable },
    });
    const orca = inventory.probes.find((probe) => probe.id === "orca");

    expect(orca?.status).toBe("NOT_PROVEN");
    expect(orca?.authentication).toEqual({
      required: true,
      status: "NOT_PROVEN",
      method: "orca status --json",
      reason: "runtime_status_available_login_not_proven",
    });
    expect(orca?.version).toBeNull();
    expect(orca?.commands[0]?.command.executable).toBe("[PRIVATE_PATH]");
    expect(JSON.stringify(inventory)).not.toContain(orcaExecutable);
  });

  it("detects Orca from status when its version command does not terminate", async () => {
    const orcaExecutable = "C:\\Users\\hunter\\Programs\\orca\\orca.exe";
    const runner = new FixtureRunner({
      "node --version": { exitCode: 0, stdout: "v24.14.0" },
      "git --version": { exitCode: 0, stdout: "git version 2.49.0" },
      [`${orcaExecutable} --version`]: {
        exitCode: null,
        timedOut: true,
      },
      [`${orcaExecutable} --help`]: { exitCode: 0, stdout: "safe help" },
      [`${orcaExecutable} status --json`]: {
        exitCode: 0,
        stdout: JSON.stringify({
          id: "request-1",
          ok: true,
          result: {
            app: { running: true },
            runtime: { state: "ready", reachable: true },
          },
        }),
      },
    });

    const inventory = await createDoctorInventory({
      runner,
      cwd: "C:\\Users\\hunter\\hunter-platform",
      now: () => new Date("2026-07-22T00:00:00.000Z"),
      host: { platform: "win32", architecture: "x64", release: "10.0" },
      executableOverrides: { orca: orcaExecutable },
    });
    const orca = inventory.probes.find((probe) => probe.id === "orca");

    expect(orca?.availability).toEqual({
      status: "DETECTED",
      reason: "executable_detected",
    });
    expect(orca?.authentication.status).toBe("NOT_PROVEN");
    expect(orca?.version).toBeNull();
    expect(orca?.status).toBe("NOT_PROVEN");
    expect(orca?.commands.some((command) => command.timedOut)).toBe(true);
  });
});
