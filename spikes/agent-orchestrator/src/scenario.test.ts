import { describe, expect, it } from "vitest";
import { access } from "node:fs/promises";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "../../testkit/src/index.js";
import {
  AgentOrchestratorEvidenceSchema,
  assertAgentOrchestratorIsolation,
  collectAgentOrchestratorEvidence,
  executeAgentOrchestratorScenario,
} from "./scenario.js";

class AgentOrchestratorFixtureRunner implements CommandRunner {
  readonly requests: CommandRequest[] = [];
  #projectGetCount = 0;

  constructor(
    private fixturePath = "C:\\fixture",
    private projectId = "volatile-project",
    private readonly pid = 42,
    private readonly installedAgents: readonly { readonly id: string }[] = [],
    private readonly authorizedAgents: readonly { readonly id: string }[] = [],
  ) {}

  get registeredFixturePath(): string {
    return this.fixturePath;
  }

  async run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push(request);
    const key = request.args.join(" ");
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = 0;
    let timedOut = false;

    if (key === "--version") stdout = "ao version dev\n";
    else if (key === "status --json") {
      stdout = JSON.stringify({
        state: "ready",
        pid: this.pid,
        port: 39101,
        runFile: "C:\\fixture\\running.json",
        dataDir: "C:\\fixture\\data",
        health: "ok",
        ready: "ready",
      });
    } else if (key === "doctor --json") {
      stdout = JSON.stringify({ ok: true, failures: 0, checks: [] });
    } else if (key === "agent ls --json") {
      stdout = JSON.stringify({
        supported: [{ id: "codex", label: "Codex" }],
        installed: this.installedAgents,
        authorized: this.authorizedAgents,
      });
    } else if (key === "agent ls --refresh --json") {
      exitCode = null;
      timedOut = true;
    } else if (key.startsWith("project add ")) {
      if (this.projectId === "" || this.fixturePath === "") {
        const idIndex = request.args.indexOf("--id");
        const pathIndex = request.args.indexOf("--path");
        this.projectId = request.args[idIndex + 1] ?? "";
        this.fixturePath = request.args[pathIndex + 1] ?? "";
      }
      stdout = `registered project ${this.projectId} at ${this.fixturePath}\n`;
    } else if (key.startsWith("project get ")) {
      this.#projectGetCount += 1;
      if (this.#projectGetCount === 1) {
        stdout = JSON.stringify({
          status: "ok",
          project: {
            id: this.projectId,
            name: "Hunter Phase0 Fixture",
            kind: "single_repo",
            path: this.fixturePath,
            repo: "",
            defaultBranch: "main",
            config: {
              worker: { agent: "codex", agentConfig: {} },
              orchestrator: { agent: "codex", agentConfig: {} },
            },
          },
        });
      } else {
        exitCode = 1;
        stderr = "Unknown project (PROJECT_NOT_FOUND)";
      }
    } else if (key === "session ls --json") {
      stdout = JSON.stringify({ data: [], meta: { hiddenTerminatedCount: 0 } });
    } else if (key.startsWith("session get hunter-phase0-missing ")) {
      exitCode = 1;
      stderr = "Unknown session (SESSION_NOT_FOUND)";
    } else if (key === "--help") {
      stdout = "Available Commands: agent doctor project session spawn status stop";
    } else if (key === "session --help") {
      stdout = "Available Commands: get kill ls restore cleanup";
    } else if (key.startsWith("project rm ")) {
      stdout = `Remove project "${this.projectId}"? Type the project id to confirm: ${JSON.stringify(
        {
          projectId: this.projectId,
          removedStorageDir: false,
        },
      )}`;
    } else {
      throw new Error(`UNEXPECTED_COMMAND:${key}`);
    }

    return {
      executable: request.executable,
      args: request.args,
      cwd: request.cwd,
      exitCode,
      stdout,
      stderr,
      timedOut,
      spawnError: null,
      startedAt: "2026-07-22T00:00:00.000Z",
      finishedAt: "2026-07-22T00:00:01.000Z",
    };
  }
}

class FaultInjectingRunner implements CommandRunner {
  #projectGetCount = 0;

  constructor(
    private readonly inner: CommandRunner,
    private readonly fault:
      | "stale_timeout"
      | "cleanup_wrong_error"
      | "cleanup_wrong_id"
      | "cleanup_bare_ok"
      | "project_add_timeout_after_effect",
  ) {}

  async run(request: CommandRequest): Promise<CommandResult> {
    const result = await this.inner.run(request);
    const key = request.args.join(" ");
    if (key.startsWith("project get ")) this.#projectGetCount += 1;
    if (this.fault === "project_add_timeout_after_effect" && key.startsWith("project add ")) {
      return { ...result, exitCode: null, timedOut: true, stdout: "" };
    }
    if (this.fault === "stale_timeout" && key.startsWith("session get hunter-phase0-missing ")) {
      return { ...result, exitCode: null, timedOut: true, stderr: "" };
    }
    if (this.fault === "cleanup_wrong_error" && this.#projectGetCount === 2) {
      return { ...result, exitCode: 1, stderr: "permission denied" };
    }
    if (this.fault === "cleanup_wrong_id" && key.startsWith("project rm ")) {
      return { ...result, stdout: JSON.stringify({ ok: true, projectId: "other-project" }) };
    }
    if (this.fault === "cleanup_bare_ok" && key.startsWith("project rm ")) {
      return { ...result, stdout: JSON.stringify({ ok: true }) };
    }
    return result;
  }
}

describe("Agent Orchestrator Phase 0 fallback evidence", () => {
  it("rejects daemon state paths that escape the explicit Phase 0 root", () => {
    expect(() =>
      assertAgentOrchestratorIsolation({
        phase0Root: "C:\\phase0",
        runFile: "C:\\phase0\\running.json",
        dataDir: "C:\\Users\\private\\.ao\\data",
      }),
    ).toThrow("AO_DATA_DIR_OUTSIDE_PHASE0_ROOT");

    expect(() =>
      assertAgentOrchestratorIsolation({
        phase0Root: "C:\\phase0",
        runFile: "C:\\phase0\\running.json",
        dataDir: "C:\\phase0\\data",
      }),
    ).not.toThrow();
  });

  it("records proven CLI mechanics without promoting blocked session capabilities", async () => {
    const runner = new AgentOrchestratorFixtureRunner();
    const evidence = await collectAgentOrchestratorEvidence({
      runner,
      executable: "C:\\Programs\\agent-orchestrator\\ao.exe",
      fixturePath: "C:\\fixture",
      projectId: "volatile-project",
      environment: {
        AO_RUN_FILE: "C:\\fixture\\running.json",
        AO_DATA_DIR: "C:\\fixture\\data",
        AO_PORT: "39101",
      },
      now: () => new Date("2026-07-22T00:00:00.000Z"),
      host: {
        platform: "win32",
        architecture: "x64",
        release: "10.0",
        nodeVersion: "v24.14.0",
      },
    });

    expect(() => AgentOrchestratorEvidenceSchema.parse(evidence)).not.toThrow();
    expect(evidence.providerVerdict).toBe("NOT_PROVEN");
    expect(evidence.spawnAttempted).toBe(false);
    expect(evidence.capabilities).toEqual(
      expect.arrayContaining([
        {
          id: "discover_runtime",
          outcome: "PASS",
          reason: "status_ready_and_doctor_ok",
        },
        {
          id: "fixed_version",
          outcome: "FAIL",
          reason: "release_cli_reports_dev",
        },
        {
          id: "project_registration",
          outcome: "PASS",
          reason: "temporary_git_project_registered_and_read_back",
        },
        {
          id: "resource_cleanup",
          outcome: "PASS",
          reason: "project_removed_by_exact_id_and_target_lookup_returns_not_found",
        },
        {
          id: "agent_readiness",
          outcome: "BLOCKED",
          reason: "catalog_refresh_timed_out_and_cached_inventory_empty",
        },
        expect.objectContaining({ id: "workspace_create_find", outcome: "BLOCKED" }),
        expect.objectContaining({ id: "process_terminal_launch", outcome: "BLOCKED" }),
        expect.objectContaining({ id: "observe", outcome: "BLOCKED" }),
        expect.objectContaining({ id: "interrupt", outcome: "FAIL" }),
        expect.objectContaining({ id: "restart_reconcile", outcome: "NOT_PROVEN" }),
        expect.objectContaining({ id: "workspace_session_identity", outcome: "NOT_PROVEN" }),
      ]),
    );
    const cleanup = runner.requests.find((request) => request.args[0] === "project" && request.args[1] === "rm");
    expect(cleanup?.stdin).toBe("volatile-project\n");
    expect(cleanup?.args).not.toContain("--yes");
    expect(JSON.stringify(evidence)).not.toContain("C:\\fixture");
    expect(evidence.commands.every((receipt) => !receipt.args.includes("--yes"))).toBe(true);
  });

  it("does not prove agent readiness from disjoint installed and authorized sets", async () => {
    const evidence = await collectAgentOrchestratorEvidence({
      runner: new AgentOrchestratorFixtureRunner(
        "C:\\fixture",
        "volatile-project",
        42,
        [{ id: "claude" }],
        [{ id: "claude" }],
      ),
      executable: "ao",
      fixturePath: "C:\\fixture",
      projectId: "volatile-project",
      environment: {
        AO_RUN_FILE: "C:\\fixture\\running.json",
        AO_DATA_DIR: "C:\\fixture\\data",
        AO_PORT: "39101",
      },
      now: () => new Date("2026-07-22T00:00:00.000Z"),
      host: {
        platform: "win32",
        architecture: "x64",
        release: "10.0",
        nodeVersion: "v24.14.0",
      },
    });

    expect(evidence.capabilities).toContainEqual({
      id: "agent_readiness",
      outcome: "NOT_PROVEN",
      reason: "agent_inventory_not_authoritative",
    });
  });

  it("fails closed when a negative lookup times out or returns the wrong error", async () => {
    const collect = async (runner: CommandRunner) =>
      await collectAgentOrchestratorEvidence({
        runner,
        executable: "ao",
        fixturePath: "C:\\fixture",
        projectId: "volatile-project",
        environment: {
          AO_RUN_FILE: "C:\\fixture\\running.json",
          AO_DATA_DIR: "C:\\fixture\\data",
          AO_PORT: "39101",
        },
        now: () => new Date("2026-07-22T00:00:00.000Z"),
        host: {
          platform: "win32",
          architecture: "x64",
          release: "10.0",
          nodeVersion: "v24.14.0",
        },
      });

    const timedOutLookup = await collect(
      new FaultInjectingRunner(new AgentOrchestratorFixtureRunner(), "stale_timeout"),
    );
    expect(timedOutLookup.capabilities).toContainEqual({
      id: "daemon_external_contract",
      outcome: "FAIL",
      reason: "supported_cli_json_surface_incomplete",
    });

    const wrongCleanupError = await collect(
      new FaultInjectingRunner(new AgentOrchestratorFixtureRunner(), "cleanup_wrong_error"),
    );
    expect(wrongCleanupError.capabilities).toContainEqual({
      id: "resource_cleanup",
      outcome: "FAIL",
      reason: "project_removal_not_confirmed",
    });

    const wrongCleanupIdentity = await collect(
      new FaultInjectingRunner(new AgentOrchestratorFixtureRunner(), "cleanup_wrong_id"),
    );
    expect(wrongCleanupIdentity.capabilities).toContainEqual({
      id: "resource_cleanup",
      outcome: "FAIL",
      reason: "project_removal_not_confirmed",
    });

    const missingCleanupIdentity = await collect(
      new FaultInjectingRunner(new AgentOrchestratorFixtureRunner(), "cleanup_bare_ok"),
    );
    expect(missingCleanupIdentity.capabilities).toContainEqual({
      id: "resource_cleanup",
      outcome: "FAIL",
      reason: "project_removal_not_confirmed",
    });
  });

  it("cleans the exact project after an add timeout with an applied server-side effect", async () => {
    const evidence = await collectAgentOrchestratorEvidence({
      runner: new FaultInjectingRunner(
        new AgentOrchestratorFixtureRunner(),
        "project_add_timeout_after_effect",
      ),
      executable: "ao",
      fixturePath: "C:\\fixture",
      projectId: "volatile-project",
      environment: {
        AO_RUN_FILE: "C:\\fixture\\running.json",
        AO_DATA_DIR: "C:\\fixture\\data",
        AO_PORT: "39101",
      },
      now: () => new Date("2026-07-22T00:00:00.000Z"),
      host: {
        platform: "win32",
        architecture: "x64",
        release: "10.0",
        nodeVersion: "v24.14.0",
      },
    });

    expect(evidence.capabilities).toContainEqual({
      id: "resource_cleanup",
      outcome: "PASS",
      reason: "project_removed_by_exact_id_and_target_lookup_returns_not_found",
    });
  });

  it("keeps the fingerprint stable across volatile fixture identities and timestamps", async () => {
    const create = async (
      fixturePath: string,
      projectId: string,
      pid: number,
      generatedAt: string,
    ) =>
      await collectAgentOrchestratorEvidence({
        runner: new AgentOrchestratorFixtureRunner(fixturePath, projectId, pid),
        executable: "ao",
        fixturePath,
        projectId,
        environment: {
          AO_RUN_FILE: `${fixturePath}\\running.json`,
          AO_DATA_DIR: `${fixturePath}\\data`,
          AO_PORT: "39101",
        },
        now: () => new Date(generatedAt),
        host: {
          platform: "win32",
          architecture: "x64",
          release: "10.0",
          nodeVersion: "v24.14.0",
        },
      });

    const first = await create(
      "C:\\fixture-a",
      "project-a",
      42,
      "2026-07-22T00:00:00.000Z",
    );
    const second = await create(
      "C:\\fixture-b",
      "project-b",
      84,
      "2026-07-22T01:00:00.000Z",
    );

    expect(second.contentFingerprint).toBe(first.contentFingerprint);
    expect(second.commands.map((receipt) => receipt.stdoutSha256)).toEqual(
      first.commands.map((receipt) => receipt.stdoutSha256),
    );

    expect(() =>
      AgentOrchestratorEvidenceSchema.parse({
        ...first,
        contentFingerprint: "0".repeat(64),
      }),
    ).toThrow();
    expect(() =>
      AgentOrchestratorEvidenceSchema.parse({
        ...first,
        capabilities: [...first.capabilities, first.capabilities[0]],
      }),
    ).toThrow();
  });

  it("returns only after the temporary no-remote Git fixture is removed", async () => {
    const runner = new AgentOrchestratorFixtureRunner("", "");

    const evidence = await executeAgentOrchestratorScenario({
      runner,
      executable: "ao",
      environment: {
        AO_RUN_FILE: "C:\\ao-data\\running.json",
        AO_DATA_DIR: "C:\\ao-data\\data",
        AO_PORT: "39101",
      },
      now: () => new Date("2026-07-22T00:00:00.000Z"),
      host: {
        platform: "win32",
        architecture: "x64",
        release: "10.0",
        nodeVersion: "v24.14.0",
      },
    });

    expect(evidence.fixture.remotePresent).toBe(false);
    await expect(access(runner.registeredFixturePath)).rejects.toThrow();
  });
});
