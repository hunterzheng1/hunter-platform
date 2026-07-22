import { access } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "../../testkit/src/index.js";
import {
  DirectCodexEvidenceSchema,
  collectDirectCodexEvidence,
  executeDirectCodexScenario,
  resolveCodexExecutable,
} from "./scenario.js";

type FixtureFault =
  | "none"
  | "login_blocked"
  | "resume_mismatch"
  | "missing_terminal"
  | "interrupt_cleanup_unknown"
  | "dirty_fixture";

class CodexFixtureRunner implements CommandRunner {
  readonly requests: CommandRequest[] = [];
  registeredFixturePath = "C:\\fixture";

  constructor(
    private readonly sessionId = "thread-1",
    private readonly fault: FixtureFault = "none",
  ) {}

  async run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push(request);
    this.registeredFixturePath = request.cwd;
    const key = request.args.join(" ");
    let exitCode: number | null = 0;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timeoutCleanup: CommandResult["timeoutCleanup"] = "not_applicable";

    if (request.executable === "git" && key === "remote") stdout = "";
    else if (request.executable === "git" && key === "status --porcelain") {
      stdout = this.fault === "dirty_fixture" ? " M README.md\n" : "";
    }
    else if (key === "--version") stdout = "codex-cli 0.144.6\n";
    else if (key === "exec --help") stdout = "--json --sandbox <SANDBOX_MODE> resume";
    else if (key === "exec resume --help") stdout = "Resume a previous session --json";
    else if (key === "app-server --help") stdout = "--listen <URL> --stdio";
    else if (key === "login status") {
      if (this.fault === "login_blocked") {
        exitCode = 1;
        stderr = "login required";
      } else stdout = "logged in with private account data";
    } else if (key.includes("Wait until interrupted")) {
      exitCode = null;
      timedOut = true;
      timeoutCleanup =
        this.fault === "interrupt_cleanup_unknown"
          ? "not_proven"
          : "process_tree_terminated";
    } else if (key.includes("resume")) {
      const resumedSession =
        this.fault === "resume_mismatch" ? "thread-other" : this.sessionId;
      stdout = returnedStream(resumedSession);
    } else if (key.includes("Read README.md")) {
      stdout =
        this.fault === "missing_terminal"
          ? JSON.stringify({ type: "thread.started", thread_id: this.sessionId })
          : returnedStream(this.sessionId);
    } else {
      throw new Error(`UNEXPECTED_COMMAND:${request.executable}:${key}`);
    }

    return {
      executable: request.executable,
      args: request.args,
      cwd: request.cwd,
      exitCode,
      stdout,
      stderr,
      timedOut,
      timeoutCleanup,
      spawnError: null,
      startedAt: "2026-07-23T00:00:00.000Z",
      finishedAt: "2026-07-23T00:00:01.000Z",
    };
  }
}

function returnedStream(sessionId: string): string {
  return [
    JSON.stringify({ type: "thread.started", thread_id: sessionId }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "# Hunter Phase 0 fixture" },
    }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
  ].join("\n");
}

const host = {
  platform: "win32",
  architecture: "x64",
  release: "10.0",
  nodeVersion: "v24.14.0",
} as const;

async function collect(
  runner: CommandRunner,
  fixturePath = "C:\\fixture",
) {
  return await collectDirectCodexEvidence({
    runner,
    executable: "codex",
    fixturePath,
    now: () => new Date("2026-07-23T00:00:00.000Z"),
    host,
  });
}

describe("Direct Codex Runtime evidence", () => {
  it("resolves the official Windows native executable without a shell shim", async () => {
    const checked: string[] = [];
    const executable = await resolveCodexExecutable({
      platform: "win32",
      architecture: "x64",
      appData: "C:\\profile-data",
      fileExists: async (path) => {
        checked.push(path);
        return true;
      },
    });

    expect(executable).toBe(
      "C:\\profile-data\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe",
    );
    expect(checked).toEqual([executable]);
    expect(executable.endsWith(".cmd")).toBe(false);
  });

  it("records typed local receipts without exposing identity or claiming adoption", async () => {
    const evidence = await collect(new CodexFixtureRunner());

    expect(() => DirectCodexEvidenceSchema.parse(evidence)).not.toThrow();
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      evidenceType: "phase0_direct_codex_runtime",
      connector: "direct_codex_cli",
      installedVersion: "0.144.6",
      connectorVerdict: "NOT_PROVEN",
      proofScope: "local_typed_scenario",
      modelServiceCallAttempted: true,
      remoteRepositoryWriteAttempted: false,
      realCallCount: 3,
      fixture: {
        remotePresent: false,
        repositoryCleanAfterScenario: true,
      },
    });
    expect(evidence.capabilities).toEqual(
      expect.arrayContaining([
        { id: "discover", outcome: "PASS", reason: "fixed_cli_and_login_available" },
        { id: "workspace_targeting", outcome: "PASS", reason: "temporary_no_remote_fixture_bound" },
        { id: "structured_events", outcome: "PASS", reason: "versioned_jsonl_stream_parsed" },
        { id: "resume", outcome: "PASS", reason: "same_session_identity_resumed" },
        {
          id: "interrupt",
          outcome: "NOT_PROVEN",
          reason: "process_tree_termination_is_not_structured_session_interrupt",
        },
      ]),
    );
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("thread-1");
    expect(serialized).not.toContain("C:\\fixture");
    expect(serialized).not.toContain("private account data");
  });

  it("does not call the model when login status is blocked", async () => {
    const runner = new CodexFixtureRunner("thread-1", "login_blocked");
    const evidence = await collect(runner);

    expect(evidence.realCallCount).toBe(0);
    expect(evidence.modelServiceCallAttempted).toBe(false);
    expect(evidence.capabilities).toContainEqual({
      id: "launch",
      outcome: "BLOCKED",
      reason: "login_not_available",
    });
    expect(
      runner.requests.some((request) =>
        request.args.some((argument) => argument.includes("Read README.md")),
      ),
    ).toBe(false);
  });

  it("fails closed on mismatched resume identity and missing terminal events", async () => {
    const mismatch = await collect(new CodexFixtureRunner("thread-1", "resume_mismatch"));
    expect(mismatch.capabilities).toContainEqual({
      id: "resume",
      outcome: "FAIL",
      reason: "resumed_session_identity_mismatch",
    });

    const missing = await collect(new CodexFixtureRunner("thread-1", "missing_terminal"));
    expect(missing.capabilities).toContainEqual({
      id: "completion_receipt",
      outcome: "NOT_PROVEN",
      reason: "structured_terminal_event_missing",
    });
  });

  it("never promotes process cleanup into structured interrupt", async () => {
    const evidence = await collect(
      new CodexFixtureRunner("thread-1", "interrupt_cleanup_unknown"),
    );
    expect(evidence.capabilities).toContainEqual({
      id: "interrupt",
      outcome: "NOT_PROVEN",
      reason: "interrupt_process_cleanup_not_proven",
    });
  });

  it("fails workspace targeting when the temporary repository is dirty", async () => {
    const evidence = await collect(new CodexFixtureRunner("thread-1", "dirty_fixture"));

    expect(evidence.fixture.repositoryCleanAfterScenario).toBe(false);
    expect(evidence.capabilities).toContainEqual({
      id: "workspace_targeting",
      outcome: "FAIL",
      reason: "temporary_fixture_changed_during_read_only_scenario",
    });
  });


  it("keeps the fingerprint stable across volatile time, path, and session identity", async () => {
    const first = await collect(new CodexFixtureRunner("thread-a"), "C:\\fixture-a");
    const second = await collectDirectCodexEvidence({
      runner: new CodexFixtureRunner("thread-b"),
      executable: "codex",
      fixturePath: "C:\\fixture-b",
      now: () => new Date("2026-07-23T01:00:00.000Z"),
      host,
    });

    expect(second.contentFingerprint).toBe(first.contentFingerprint);
    expect(() =>
      DirectCodexEvidenceSchema.parse({ ...first, contentFingerprint: "0".repeat(64) }),
    ).toThrow();
  });

  it("returns only after the temporary no-remote fixture is removed", async () => {
    const runner = new CodexFixtureRunner();
    const evidence = await executeDirectCodexScenario({
      runner,
      executable: "codex",
      now: () => new Date("2026-07-23T00:00:00.000Z"),
      host,
    });

    expect(evidence.fixture.remotePresent).toBe(false);
    await expect(access(runner.registeredFixturePath)).rejects.toThrow();
  });
});
