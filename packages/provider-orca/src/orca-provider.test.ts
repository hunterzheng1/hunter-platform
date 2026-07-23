import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { AttemptIdSchema, DeviceBindingIdSchema, OperationIdSchema, ProjectIdSchema, RepositoryIdSchema, RunIdSchema, WorkspaceIdSchema } from "@hunter/domain";
import { createExternalOperation, createWorkspacePathBoundary } from "@hunter/runtime-contracts";
import { OperationWorker, SqliteOperationJournal } from "@hunter/storage";
import {
  OrcaClient,
  OrcaCommandRunner,
  OrcaWorkspaceCandidateReceiptSchema,
  OrcaWorkspaceProvider,
  resolveOrcaExecutable,
  type ExecFileAdapter,
  type JsonCommandRunner,
} from "./index.js";

const operationId = OperationIdSchema.parse("opn_orcacandidate01");
const repositoryId = RepositoryIdSchema.parse("rep_orcacandidate01");

class FixtureRunner implements JsonCommandRunner {
  readonly calls: string[][] = [];
  readonly #responses: unknown[];

  constructor(responses: readonly unknown[]) {
    this.#responses = [...responses];
  }

  async run(args: readonly string[]): Promise<unknown> {
    this.calls.push([...args]);
    const response = this.#responses.shift();
    if (response === undefined) throw new Error("MISSING_FIXTURE_RESPONSE");
    return response;
  }
}

function success(result: unknown, id = "fixture-request") {
  return { id, ok: true, result };
}

function windowsClient(runner: JsonCommandRunner): OrcaClient {
  return new OrcaClient(runner, { pathFlavor: "windows" });
}

describe("OrcaCommandRunner", () => {
  it("resolves only an executable and runs argv without a shell", async () => {
    const execFile = vi.fn(async () => ({ stdout: JSON.stringify({ ok: true }) }));
    const runner = new OrcaCommandRunner({
      executable: "C:\\Program Files\\Orca\\orca.exe",
      execFile,
      timeoutMs: 12_000,
      maxBufferBytes: 512_000,
    });

    await expect(runner.run(["status", "--json"])).resolves.toEqual({ ok: true });
    expect(execFile).toHaveBeenCalledWith(
      "C:\\Program Files\\Orca\\orca.exe",
      ["status", "--json"],
      {
        encoding: "utf8",
        maxBuffer: 512_000,
        shell: false,
        timeout: 12_000,
        windowsHide: true,
      },
    );
  });

  it("uses a bounded default buffer with room for the terminal text envelope", async () => {
    const execFile = vi.fn<ExecFileAdapter>(
      async () => ({ stdout: JSON.stringify({ ok: true }) }),
    );
    const runner = new OrcaCommandRunner({ executable: "orca", execFile });

    await runner.run(["status", "--json"]);

    expect(execFile.mock.calls[0]?.[2].maxBuffer).toBe(10 * 1024 * 1024);
  });

  it("uses the configured command before development and platform defaults", () => {
    expect(
      resolveOrcaExecutable({
        configuredCommand: "D:\\Tools\\orca-custom.exe",
        development: true,
        platform: "win32",
      }),
    ).toBe("D:\\Tools\\orca-custom.exe");
    expect(resolveOrcaExecutable({ development: true, platform: "win32" })).toBe("orca-dev");
    expect(resolveOrcaExecutable({ development: false, platform: "win32" })).toBe("orca");
    expect(resolveOrcaExecutable({ development: false, platform: "linux" })).toBe("orca-ide");
    expect(resolveOrcaExecutable({ development: false, platform: "darwin" })).toBe("orca");
  });

  it.each([
    "",
    "   ",
    "\"C:\\Program Files\\Orca\\orca.exe\"",
    "orca status",
    "C:\\Program Files\\Orca\\orca.exe --json",
    "orca\u0000.exe",
    "orca\nstatus",
  ])("rejects a composite or unsafe configured executable %s", (configuredCommand) => {
    expect(() =>
      resolveOrcaExecutable({
        configuredCommand,
        development: false,
        platform: "win32",
      }),
    ).toThrow("ORCA_EXECUTABLE_INVALID");
  });

  it.each([
    "--dangerously-bypass",
    "--yolo",
    "--auto-approve",
    "--auto_approve",
    "--approve-all",
  ])("rejects forbidden permission argument %s before process creation", async (argument) => {
    const execFile = vi.fn(async () => ({ stdout: "{}" }));
    const runner = new OrcaCommandRunner({ executable: "orca", execFile });

    await expect(runner.run(["status", argument, "--json"])).rejects.toThrow(
      "ORCA_ARGUMENT_FORBIDDEN",
    );
    expect(execFile).not.toHaveBeenCalled();
  });

  it("allows ordinary path values that contain words used by bypass flags", async () => {
    const execFile = vi.fn(async () => ({ stdout: JSON.stringify({ ok: true }) }));
    const runner = new OrcaCommandRunner({ executable: "orca", execFile });

    await expect(
      runner.run([
        "repo",
        "add",
        "--path",
        "C:\\fixtures\\bypass-yolo-project",
        "--json",
      ]),
    ).resolves.toEqual({ ok: true });
    expect(execFile).toHaveBeenCalledOnce();
  });

  it("fails closed with constants that do not disclose command or output", async () => {
    const invalidJson = new OrcaCommandRunner({
      executable: "C:\\private\\orca.exe",
      execFile: async () => ({ stdout: "token=secret-value" }),
    });
    const failedCommand = new OrcaCommandRunner({
      executable: "C:\\private\\orca.exe",
      execFile: async () => {
        throw new Error("C:\\Users\\private token=secret-value");
      },
    });

    await expect(invalidJson.run(["status", "--json"])).rejects.toThrow(/^ORCA_OUTPUT_INVALID$/u);
    await expect(failedCommand.run(["status", "--json"])).rejects.toThrow(/^ORCA_COMMAND_FAILED$/u);
  });

  it.each([
    { args: ["status"] },
    { args: [] },
    { args: ["status", ""] },
    { args: ["status", "bad\u0000argument", "--json"] },
  ])("rejects non-JSON or invalid argv before process creation", async ({ args }) => {
    const execFile = vi.fn(async () => ({ stdout: "{}" }));
    const runner = new OrcaCommandRunner({ executable: "orca", execFile });

    await expect(runner.run(args)).rejects.toThrow("ORCA_ARGUMENT_INVALID");
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe("OrcaClient contract fixtures", () => {
  it("rejects an oversized provider envelope before consuming its fields", async () => {
    const runner = new FixtureRunner([
      {
        id: "request-repo",
        ok: true,
        result: {
          repo: { id: "repo-01" },
          padding: "x".repeat(70 * 1024),
        },
      },
    ]);
    const client = windowsClient(runner);

    await expect(
      client.addRepository("C:\\fixtures\\hunter"),
    ).rejects.toThrow("ORCA_OUTPUT_TOO_LARGE");
  });

  it.each([
    {
      id: "request-repo",
      ok: true,
      result: { repo: { id: "repo-01" } },
      unexpectedTopLevel: true,
    },
    {
      id: "request-repo",
      ok: true,
      result: { repo: { id: "repo-01" } },
      _meta: { ignored: true },
    },
  ])("rejects unknown top-level envelope metadata", async (fixture) => {
    const runner = new FixtureRunner([fixture]);
    const client = windowsClient(runner);

    await expect(client.addRepository("C:\\fixtures\\hunter")).rejects.toThrow(
      "ORCA_OUTPUT_SCHEMA_MISMATCH",
    );
  });

  it("maps repository and worktree creation to the current public argv contract", async () => {
    const fullWorktreeId = "repo-01::C:\\fixtures\\hunter-worktree";
    const runner = new FixtureRunner([
      success({ repo: { id: "repo-01" } }, "request-repo"),
      success({ worktree: { id: fullWorktreeId }, startupTerminal: null }, "request-worktree"),
    ]);
    const client = windowsClient(runner);

    const repository = await client.addRepository("C:\\fixtures\\hunter");
    const worktree = await client.createWorktree(repository.repoId, operationId);

    expect(runner.calls).toEqual([
      ["repo", "add", "--path", "C:\\fixtures\\hunter", "--json"],
      [
        "worktree",
        "create",
        "--repo",
        "id:repo-01",
        "--name",
        "hunter-opn_orcacandidate01",
        "--setup",
        "skip",
        "--no-parent",
        "--json",
      ],
    ]);
    expect(runner.calls.flat(2).join(" ")).not.toMatch(
      /--agent|--prompt|--activate|run-hooks|dangerously|bypass|yolo|auto.?approve/iu,
    );
    expect(worktree).toEqual({
      worktreeId: fullWorktreeId,
      reportedAbsolutePath: "C:\\fixtures\\hunter-worktree",
      startupTerminalId: null,
    });
  });

  it("normalizes a startup terminal handle from worktree creation", async () => {
    const fullWorktreeId = "repo-01::C:\\fixtures\\hunter-worktree";
    const withTerminal = new FixtureRunner([
      success({
        worktree: { id: fullWorktreeId },
        startupTerminal: { handle: "terminal-startup-01" },
      }),
    ]);
    const omittedTerminal = new FixtureRunner([
      success({ worktree: { id: fullWorktreeId } }),
    ]);

    await expect(
      windowsClient(withTerminal).createWorktree("repo-01", operationId),
    ).resolves.toMatchObject({ startupTerminalId: "terminal-startup-01" });
    await expect(
      windowsClient(omittedTerminal).createWorktree("repo-01", operationId),
    ).resolves.toMatchObject({ startupTerminalId: null });
  });

  it("preserves the full worktree selector and uses bounded terminal inputs", async () => {
    const fullWorktreeId = "repo-01::C:\\fixtures\\hunter-worktree";
    const runner = new FixtureRunner([
      success({ terminal: { handle: "terminal-01" } }, "request-terminal"),
      success(
        { text: "ready", nextCursor: 8, latestCursor: 8, limited: false },
        "request-read",
      ),
    ]);
    const client = windowsClient(runner);
    const terminal = await client.createTerminal(fullWorktreeId, "pwsh.exe");
    const observation = await client.readTerminal(terminal.terminalId, 7, 100);

    expect(runner.calls).toEqual([
      [
        "terminal",
        "create",
        "--worktree",
        `id:${fullWorktreeId}`,
        "--title",
        "hunter-managed",
        "--command",
        "pwsh.exe",
        "--json",
      ],
      [
        "terminal",
        "read",
        "--terminal",
        "terminal-01",
        "--cursor",
        "7",
        "--limit",
        "100",
        "--json",
      ],
    ]);
    expect(observation.nextCursor).toBe(8);
  });

  it.each(["pwsh -Command whoami", "pwsh;whoami", "C:\\Windows\\pwsh.exe", "pwsh\nwhoami"])(
    "rejects non-token terminal command %s before dispatch",
    async (command) => {
      const runner = new FixtureRunner([success({ terminal: { handle: "terminal-01" } })]);
      const client = windowsClient(runner);

      await expect(
        client.createTerminal("repo-01::C:\\fixtures\\hunter-worktree", command),
      ).rejects.toThrow("ORCA_TERMINAL_EXECUTABLE_INVALID");
      expect(runner.calls).toHaveLength(0);
    },
  );

  it("rejects unknown private repository result fields", async () => {
    const runner = new FixtureRunner([success({ repo: { id: "repo-01", drift: true } })]);
    const client = windowsClient(runner);

    await expect(client.addRepository("C:\\fixtures\\hunter")).rejects.toThrow(
      "ORCA_OUTPUT_SCHEMA_MISMATCH",
    );
  });

  it.each([
    "abcd",
    "repo-01::relative\\worktree",
    "other-repo::C:\\fixtures\\worktree",
  ])("rejects malformed private worktree result %s", async (worktreeId) => {
    const runner = new FixtureRunner([
      success({ worktree: { id: worktreeId }, startupTerminal: null }),
    ]);
    const client = windowsClient(runner);

    await expect(client.createWorktree("repo-01", operationId)).rejects.toThrow(
      "ORCA_OUTPUT_SCHEMA_MISMATCH",
    );
  });

  it("rejects unknown private terminal result fields", async () => {
    const runner = new FixtureRunner([
      success({ terminal: { handle: "terminal-01", secret: "not-accepted" } }),
    ]);
    const client = windowsClient(runner);

    await expect(
      client.createTerminal("repo-01::C:\\fixtures\\hunter-worktree", "pwsh"),
    ).rejects.toThrow("ORCA_OUTPUT_SCHEMA_MISMATCH");
  });

  it("rejects control characters in provider-private identifiers", async () => {
    const runner = new FixtureRunner([success({ repo: { id: "repo\u0000-01" } })]);
    const client = windowsClient(runner);

    await expect(client.addRepository("C:\\fixtures\\hunter")).rejects.toThrow(
      "ORCA_OUTPUT_SCHEMA_MISMATCH",
    );
  });

  it.each([
    "relative\\repository",
    "C:relative\\repository",
    "\\rooted-current-drive",
    "\\\\server-without-share",
    "\\\\.\\pipe\\hunter",
    "/rooted-on-current-drive",
    "C:\\fixtures\\hunter\u0000escape",
  ])("rejects unsafe repository path %s before client dispatch", async (repositoryPath) => {
    const runner = new FixtureRunner([success({ repo: { id: "repo-01" } })]);
    const client = windowsClient(runner);

    await expect(client.addRepository(repositoryPath)).rejects.toThrow(
      "ORCA_REPOSITORY_PATH_INVALID",
    );
    expect(runner.calls).toHaveLength(0);
  });

  it.each([
    "C:\\fixtures\\hunter",
    "C:/fixtures/hunter",
    "\\\\server\\share\\hunter",
    "\\\\?\\C:\\fixtures\\hunter",
    "\\\\?\\UNC\\server\\share\\hunter",
  ])("accepts a fully-qualified repository path %s", async (repositoryPath) => {
    const runner = new FixtureRunner([success({ repo: { id: "repo-01" } })]);
    const client = windowsClient(runner);

    await expect(client.addRepository(repositoryPath)).resolves.toEqual({
      repoId: "repo-01",
    });
    expect(runner.calls[0]).toEqual([
      "repo",
      "add",
      "--path",
      repositoryPath,
      "--json",
    ]);
  });

  it("uses POSIX path semantics when explicitly configured", async () => {
    const acceptedRunner = new FixtureRunner([success({ repo: { id: "repo-01" } })]);
    const acceptedClient = new OrcaClient(acceptedRunner, { pathFlavor: "posix" });
    const rejectedRunner = new FixtureRunner([success({ repo: { id: "repo-01" } })]);
    const rejectedClient = new OrcaClient(rejectedRunner, { pathFlavor: "posix" });

    await expect(acceptedClient.addRepository("/tmp/hunter")).resolves.toEqual({
      repoId: "repo-01",
    });
    await expect(rejectedClient.addRepository("C:\\fixtures\\hunter")).rejects.toThrow(
      "ORCA_REPOSITORY_PATH_INVALID",
    );
    expect(rejectedRunner.calls).toHaveLength(0);
  });

  it("validates returned worktree paths with the configured host flavor", async () => {
    const runner = new FixtureRunner([
      success({ worktree: { id: "repo-01::/tmp/hunter" }, startupTerminal: null }),
    ]);
    const client = windowsClient(runner);

    await expect(client.createWorktree("repo-01", operationId)).rejects.toThrow(
      "ORCA_OUTPUT_SCHEMA_MISMATCH",
    );
  });

  it.each([
    { cursor: 7, nextCursor: 9, latestCursor: 8 },
    { cursor: 7, nextCursor: 6, latestCursor: 8 },
  ])(
    "rejects incoherent terminal cursor result next=$nextCursor latest=$latestCursor",
    async ({ cursor, nextCursor, latestCursor }) => {
      const runner = new FixtureRunner([
        success({ text: "", nextCursor, latestCursor, limited: false }),
      ]);
      const client = windowsClient(runner);

      await expect(client.readTerminal("terminal-01", cursor, 100)).rejects.toThrow(
        "ORCA_OUTPUT_SCHEMA_MISMATCH",
      );
    },
  );

  it.each([
    "abcd",
    "repo-01::relative\\worktree",
    "repo-01::/tmp/hunter",
    "repo-01::C:\\fixtures\\hunter\u0000escape",
  ])("rejects unsafe worktree selector %s before terminal dispatch", async (worktreeId) => {
    const runner = new FixtureRunner([success({ terminal: { handle: "terminal-01" } })]);
    const client = windowsClient(runner);

    await expect(client.createTerminal(worktreeId, "pwsh")).rejects.toThrow(
      "ORCA_WORKTREE_ID_INVALID",
    );
    expect(runner.calls).toHaveLength(0);
  });

  it("applies POSIX semantics before terminal selector dispatch", async () => {
    const runner = new FixtureRunner([success({ terminal: { handle: "terminal-01" } })]);
    const client = new OrcaClient(runner, { pathFlavor: "posix" });

    await expect(
      client.createTerminal("repo-01::C:\\fixtures\\hunter-worktree", "pwsh"),
    ).rejects.toThrow("ORCA_WORKTREE_ID_INVALID");
    expect(runner.calls).toHaveLength(0);
  });

  it.each([
    [-1, 100],
    [1.5, 100],
    [0, 0],
    [0, 1_001],
  ])("rejects invalid terminal read cursor=%s limit=%s before dispatch", async (cursor, limit) => {
    const runner = new FixtureRunner([
      success({ text: "", nextCursor: 0, latestCursor: 0, limited: false }),
    ]);
    const client = windowsClient(runner);

    await expect(client.readTerminal("terminal-01", cursor, limit)).rejects.toThrow(
      /ORCA_(?:CURSOR|LIMIT)_INVALID/u,
    );
    expect(runner.calls).toHaveLength(0);
  });
});

describe("OrcaWorkspaceProvider candidate boundary", () => {
  function fixtureProvider(repositoryPath = "C:\\fixtures\\hunter") {
    const fullWorktreeId = `repo-01::${repositoryPath}-worktree`;
    const runner = new FixtureRunner([
      success({ repo: { id: "repo-01" } }, "request-repo"),
      success({ worktree: { id: fullWorktreeId }, startupTerminal: null }, "request-worktree"),
    ]);
    const boundary = createWorkspacePathBoundary(
      new Map([[repositoryId, "C:\\fixtures"]]),
      {
        platform: "win32",
        realpathNative: (candidate) => candidate,
      },
    );
    return {
      provider: new OrcaWorkspaceProvider(windowsClient(runner), boundary, {
        repositoryPathFor: () => repositoryPath,
        observedAt: () => "2026-07-23T00:00:00.000Z",
      }),
      runner,
    };
  }

  function prepareOperation() {
    return createExternalOperation({
      schemaVersion: 1,
      operationId,
      projectId: ProjectIdSchema.parse("prj_orcapublic0001"),
      runId: RunIdSchema.parse("run_orcapublic0001"),
      attemptId: AttemptIdSchema.parse("att_orcapublic0001"),
      operationVersion: 1,
      operationType: "workspace.prepare",
      requestedCapabilities: ["workspace_prepare"],
      payload: {
        repositoryId,
        deviceBindingId: DeviceBindingIdSchema.parse("dev_orcapublic0001"),
        workspaceId: WorkspaceIdSchema.parse("wsp_orcapublic0001"),
        mode: "write",
        baselineRevision: "a".repeat(40),
      },
    });
  }

  it("dispatches repository/worktree creation only from the Foundation worker", async () => {
    const { provider, runner } = fixtureProvider();
    const database = new DatabaseSync(":memory:");
    const journal = new SqliteOperationJournal(database);
    const operation = createExternalOperation({
      schemaVersion: 1,
      operationId,
      projectId: ProjectIdSchema.parse("prj_orcaworker0001"),
      runId: RunIdSchema.parse("run_orcaworker0001"),
      attemptId: AttemptIdSchema.parse("att_orcaworker0001"),
      operationVersion: 1,
      operationType: "workspace.prepare",
      requestedCapabilities: ["workspace_prepare"],
      payload: {
        repositoryId,
        deviceBindingId: DeviceBindingIdSchema.parse("dev_orcaworker0001"),
        workspaceId: WorkspaceIdSchema.parse("wsp_orcaworker0001"),
        mode: "write",
        baselineRevision: "a".repeat(40),
      },
    });
    journal.commitCommand({
      commandId: "orca-workspace-worker",
      requestFingerprint: operation.fingerprint,
      projectId: operation.projectId,
      aggregateId: "attempt:att_orcaworker0001",
      expectedVersion: 0,
      actor: { actorId: "test", correlationId: "orca-worker" },
      events: [],
      operations: [operation],
      response: {},
    });
    const worker = new OperationWorker(database, provider as never, {
      ownerId: "orca-worker",
      replayPolicy: () => "inspectable",
    });

    expect(runner.calls).toHaveLength(0);
    await expect(worker.runOnce()).resolves.toBe("completed");
    expect(runner.calls).toHaveLength(2);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM side_effect_receipts",
    ).get()).toEqual({ count: 1 });
    database.close();
  });

  it("returns a public receipt with a provider-neutral verified workspace result", async () => {
    const { provider } = fixtureProvider();
    const receipt = await provider.execute(prepareOperation());

    expect(receipt).toMatchObject({
      schemaVersion: 1,
      operationId,
      operationStatus: "completed",
      evidence: { proofScope: "contract_only" },
      workspaceResult: {
        workspaceRef:
          "repo-01::C:\\fixtures\\hunter-worktree",
        worktreeId: expect.stringMatching(/^wtr_[a-f0-9]{24}$/u),
        reportedWorkspacePath: "C:\\fixtures\\hunter-worktree",
      },
    });
    expect(receipt).not.toHaveProperty("privateWorkspace");
    expect(receipt).not.toHaveProperty("leaseId");
  });

  it.each([
    {
      worktreeId: { arbitrary: true },
      workspaceRef: "repo-01::C:\\fixtures\\hunter-worktree",
      verifiedWorkspacePath: "C:\\fixtures\\hunter-worktree",
      startupTerminalId: null,
    },
    {
      worktreeId: "not-a-complete-selector",
      workspaceRef: "repo-01::C:\\fixtures\\hunter-worktree",
      verifiedWorkspacePath: "C:\\fixtures\\hunter-worktree",
      startupTerminalId: null,
    },
  ])("rejects an invalid private workspace receipt shape", (privateWorkspace) => {
    expect(
      OrcaWorkspaceCandidateReceiptSchema.safeParse({
        schemaVersion: 1,
        operationId,
        operationLabel: "hunter-opn_orcacandidate01",
        fingerprint: "a".repeat(64),
        proofScope: "contract_only",
        providerValidationStatus: "NOT_PROVEN",
        retrySafety: "NOT_PROVEN",
        privateWorkspace,
      }).success,
    ).toBe(false);
  });

  it("rejects a candidate receipt whose deterministic label does not match its operation", () => {
    expect(
      OrcaWorkspaceCandidateReceiptSchema.safeParse({
        schemaVersion: 1,
        operationId,
        operationLabel: "hunter-opn_forgedcandidate01",
        fingerprint: "a".repeat(64),
        proofScope: "contract_only",
        providerValidationStatus: "NOT_PROVEN",
        retrySafety: "NOT_PROVEN",
        privateWorkspace: {
          workspaceRef:
            "repo-01::C:\\fixtures\\hunter-worktree",
          worktreeId: "repo-01::C:\\fixtures\\hunter-worktree",
          verifiedWorkspacePath: "C:\\fixtures\\hunter-worktree",
          startupTerminalId: null,
        },
      }).success,
    ).toBe(false);
  });

  it("rejects an invalid startup terminal handle before candidate receipt creation", async () => {
    const runner = new FixtureRunner([
      success({ repo: { id: "repo-01" } }, "request-repo"),
      success(
        {
          worktree: { id: "repo-01::C:\\fixtures\\hunter-worktree" },
          startupTerminal: { handle: "terminal\u0000-invalid" },
        },
        "request-worktree",
      ),
    ]);
    const provider = new OrcaWorkspaceProvider(
      windowsClient(runner),
      createWorkspacePathBoundary(
        new Map([[repositoryId, "C:\\fixtures"]]),
        {
          platform: "win32",
          realpathNative: (candidate) => candidate,
        },
      ),
      {
        repositoryPathFor: () => "C:\\fixtures\\hunter",
        observedAt: () => "2026-07-23T00:00:00.000Z",
      },
    );

    await expect(
      provider.execute(prepareOperation()),
    ).rejects.toThrow("ORCA_OUTPUT_SCHEMA_MISMATCH");
  });

  it.each(["relative\\repository", "C:\\fixtures\\hunter\u0000escape"])(
    "rejects unsafe repository path %s before any candidate dispatch",
    async (repositoryPath) => {
      const { provider, runner } = fixtureProvider(repositoryPath);

      await expect(
        provider.execute(prepareOperation()),
      ).rejects.toThrow();
      expect(runner.calls).toHaveLength(0);
    },
  );

  it("derives deterministic fingerprints and argv without claiming replay safety", async () => {
    const first = fixtureProvider();
    const second = fixtureProvider();
    const changed = fixtureProvider("C:\\fixtures\\other");

    const firstReceipt = await first.provider.execute(prepareOperation());
    const secondReceipt = await second.provider.execute(prepareOperation());
    const changedReceipt = await changed.provider.execute(prepareOperation());

    expect(secondReceipt.evidence.evidenceHash).toBe(
      firstReceipt.evidence.evidenceHash,
    );
    expect(second.runner.calls).toEqual(first.runner.calls);
    expect(changedReceipt.evidence.evidenceHash).not.toBe(
      firstReceipt.evidence.evidenceHash,
    );
  });

  it("rejects a returned workspace that resolves outside the registered root", async () => {
    const runner = new FixtureRunner([
      success({ repo: { id: "repo-01" } }, "request-repo"),
      success(
        {
          worktree: {
            id: "repo-01::C:\\provider-alias\\escaped-worktree",
          },
          startupTerminal: null,
        },
        "request-worktree",
      ),
    ]);
    const boundary = createWorkspacePathBoundary(
      new Map([[repositoryId, "C:\\fixtures"]]),
      {
        platform: "win32",
        realpathNative: (candidate) =>
          candidate.includes("provider-alias")
            ? "C:\\outside\\escaped-worktree"
            : candidate,
      },
    );
    const provider = new OrcaWorkspaceProvider(
      windowsClient(runner),
      boundary,
      {
        repositoryPathFor: () => "C:\\fixtures\\hunter",
        observedAt: () => "2026-07-23T00:00:00.000Z",
      },
    );

    await expect(
      provider.execute(prepareOperation()),
    ).rejects.toThrow("PATH_SCOPE_VIOLATION");
  });

  it("does not leak Orca-private vocabulary into shared domain/runtime contracts", async () => {
    const root = new URL("../../../", import.meta.url);
    const sharedFiles = [
      "packages/domain/src/ids.ts",
      "packages/runtime-contracts/src/external-boundary.ts",
      "packages/runtime-contracts/src/operations.ts",
      "packages/runtime-contracts/src/leases.ts",
      "packages/runtime-contracts/src/manifest.ts",
    ];
    const source = (
      await Promise.all(
        sharedFiles.map((file) => readFile(new URL(file, root), "utf8")),
      )
    ).join("\n");

    expect(source).not.toMatch(/\borca(?:Repo|Worktree|Terminal|Provider|Workspace)?\b/iu);
  });
});
