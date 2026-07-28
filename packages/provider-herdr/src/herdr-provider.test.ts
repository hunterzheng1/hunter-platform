import {
  DeviceBindingIdSchema,
  OperationIdSchema,
  ProjectIdSchema,
  RepositoryIdSchema,
  WorkspaceIdSchema,
} from "@hunter/domain";
import {
  createExternalOperation,
  createWorkspacePathBoundary,
} from "@hunter/runtime-contracts";
import { describe, expect, it } from "vitest";
import {
  HerdrAdapterError,
  HerdrCommandRunner,
  HERDR_EXECUTABLE_IDENTITY,
  HerdrPublicAdapter,
  HerdrPublicClient,
  type HerdrExecFileAdapter,
} from "./index.js";
import { createHerdrCommandRunnerForTest } from "./command-runner.js";

const repositoryId = RepositoryIdSchema.parse("rep_herdrpublic01");
const workspaceId = WorkspaceIdSchema.parse("wsp_herdrpublic01");
const fixtureRoot =
  process.platform === "win32"
    ? "C:\\fixtures\\hunter-herdr"
    : "/tmp/fixtures/hunter-herdr";
const fixturePath =
  process.platform === "win32"
    ? `${fixtureRoot}\\worktree`
    : `${fixtureRoot}/worktree`;

function openResponse(
  path = fixturePath,
  workspace = "w1",
  alreadyOpen = false,
): unknown {
  return {
    id: "cli:worktree:open",
    result: {
      type: "worktree_opened",
      workspace: {
        workspace_id: workspace,
        number: 1,
        label: "hunter-opn_herdprepare01",
        focused: false,
        pane_count: 1,
        tab_count: 1,
        active_tab_id: `${workspace}:t1`,
        agent_status: "idle",
        worktree: {
          repo_key: "fixture",
          repo_name: "fixture",
          repo_root: fixtureRoot,
          checkout_path: path,
          is_linked_worktree: true,
        },
      },
      tab: {
        tab_id: `${workspace}:t1`,
        workspace_id: workspace,
        number: 1,
        label: "shell",
        focused: false,
        pane_count: 1,
        agent_status: "idle",
      },
      root_pane: {
        pane_id: `${workspace}:p1`,
        terminal_id: "terminal-1",
        workspace_id: workspace,
        tab_id: `${workspace}:t1`,
        focused: false,
        agent_status: "idle",
        revision: 0,
      },
      worktree: {
        path,
        branch: "codex/task1-fixture",
        is_bare: false,
        is_detached: false,
        is_prunable: false,
        is_linked_worktree: true,
        label: "task1-fixture",
        open_workspace_id: workspace,
      },
      already_open: alreadyOpen,
    },
  };
}

function closeResponse(): unknown {
  return {
    id: "cli:workspace:close",
    result: { type: "ok" },
  };
}

function sessionInfo(
  name = "hunter-task1-gate",
  running = false,
): unknown {
  return {
    name,
    default: false,
    running,
    socket_path: `${fixtureRoot}/task1.sock`,
    session_dir: `${fixtureRoot}/task1`,
  };
}

class FakeExec {
  readonly calls: Array<{
    readonly executable: string;
    readonly args: readonly string[];
    readonly environment: NodeJS.ProcessEnv;
  }> = [];
  readonly #responses: string[];

  constructor(...responses: unknown[]) {
    this.#responses = responses.map((response) => JSON.stringify(response));
  }

  readonly adapter: HerdrExecFileAdapter = async (
    executable,
    args,
    options,
  ) => {
    this.calls.push({
      executable,
      args: [...args],
      environment: options.env,
    });
    const stdout = this.#responses.shift();
    if (stdout === undefined) throw new Error("UNEXPECTED_HERDR_CALL");
    return { stdout, stderr: "" };
  };
}

function createRunner(fake: FakeExec): HerdrCommandRunner {
  return createHerdrCommandRunnerForTest({
    executable:
      process.platform === "win32"
        ? "C:\\tmp\\herdr-windows-x86_64.exe"
        : "/tmp/herdr",
    sessionName: "hunter-task1-gate",
    configPath:
      process.platform === "win32"
        ? "C:\\tmp\\hunter-task1-config.toml"
        : "/tmp/hunter-task1-config.toml",
    execFile: fake.adapter,
  }, async () => HERDR_EXECUTABLE_IDENTITY);
}

function prepareOperation(
  operationId = "opn_herdprepare01",
  targetWorkspaceId = workspaceId,
) {
  return createExternalOperation({
    schemaVersion: 1,
    operationVersion: 1,
    operationId: OperationIdSchema.parse(operationId),
    projectId: ProjectIdSchema.parse("prj_herdrpublic01"),
    runId: null,
    attemptId: null,
    operationType: "workspace.prepare",
    requestedCapabilities: ["workspace_prepare"],
    payload: {
      repositoryId,
      deviceBindingId: DeviceBindingIdSchema.parse("dev_herdrpublic01"),
      workspaceId: targetWorkspaceId,
      mode: "write",
      baselineRevision: "7cac74bd17a195509ff45fa0a8265c095293a1f0",
    },
  });
}

function releaseOperation(operationId = "opn_herdrelease01") {
  return createExternalOperation({
    schemaVersion: 1,
    operationVersion: 1,
    operationId: OperationIdSchema.parse(operationId),
    projectId: ProjectIdSchema.parse("prj_herdrpublic01"),
    runId: null,
    attemptId: null,
    operationType: "workspace.release",
    requestedCapabilities: ["workspace_prepare"],
    payload: { workspaceId },
  });
}

function createAdapter(fake: FakeExec): HerdrPublicAdapter {
  const runner = createRunner(fake);
  return new HerdrPublicAdapter(
    new HerdrPublicClient(runner),
    createWorkspacePathBoundary(
      new Map([[repositoryId, fixtureRoot]]),
      {
        platform: process.platform === "win32" ? "win32" : "posix",
        realpathNative: (path) => path,
      },
    ),
    {
      repositoryPathFor: (candidate) =>
        candidate === repositoryId ? fixturePath : null,
      repositorySourcePathFor: (candidate) =>
        candidate === repositoryId ? fixtureRoot : null,
      observedAt: () => "2026-07-28T08:30:00.000Z",
    },
  );
}

describe("Herdr public Adapter Task 1", () => {
  it("uses exact structured argv and a dedicated named session", async () => {
    const fake = new FakeExec(openResponse());
    const client = new HerdrPublicClient(createRunner(fake));

    const opened = await client.openExistingWorktree({
      sourcePath: fixtureRoot,
      path: fixturePath,
      operationLabel: "hunter-opn_herdprepare01",
    });

    expect(opened).toMatchObject({
      workspaceId: "w1",
      reportedPath: fixturePath,
      alreadyOpen: false,
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.args).toEqual([
      "--session",
      "hunter-task1-gate",
      "worktree",
      "open",
      "--cwd",
      fixtureRoot,
      "--path",
      fixturePath,
      "--label",
      "hunter-opn_herdprepare01",
      "--no-focus",
      "--json",
    ]);
    expect(fake.calls[0]?.environment.HERDR_SESSION).toBe(
      "hunter-task1-gate",
    );
    expect(fake.calls[0]?.environment.HERDR_CONFIG_PATH).toBeDefined();
  });

  it.each([
    "--dangerously-bypass-approvals-and-sandbox",
    "--yolo",
    "--auto-approve",
    "--approve-all",
    "--full-auto",
    "--approval-mode=never",
  ])("rejects forbidden Agent argument %s before Provider I/O", async (flag) => {
    const fake = new FakeExec({ unused: true });
    const runner = createRunner(fake);

    await expect(
      runner.run([
        "agent",
        "start",
        "hunter-agent",
        "--kind",
        "codex",
        "--pane",
        "w1:p1",
        "--",
        flag,
      ]),
    ).rejects.toMatchObject({
      code: "HERDR_ARGUMENT_FORBIDDEN",
    } satisfies Partial<HerdrAdapterError>);
    expect(fake.calls).toHaveLength(0);
  });

  it.each([
    ["worktree", "create", "--json"],
    ["worktree", "remove", "--workspace", "w1", "--force", "--json"],
    ["workspace", "close", "w1", "--force"],
  ])("rejects forbidden workspace mutation before I/O: %j", async (...args) => {
    const fake = new FakeExec({ unused: true });
    await expect(createRunner(fake).run(args)).rejects.toMatchObject({
      code: "HERDR_COMMAND_FORBIDDEN",
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("rejects an unverified executable identity before Provider I/O", async () => {
    const fake = new FakeExec({ unused: true });
    const runner = createHerdrCommandRunnerForTest({
      executable:
        process.platform === "win32"
          ? "C:\\tmp\\herdr-windows-x86_64.exe"
          : "/tmp/herdr",
      sessionName: "hunter-task1-gate",
      configPath:
        process.platform === "win32"
          ? "C:\\tmp\\hunter-task1-config.toml"
          : "/tmp/hunter-task1-config.toml",
      execFile: fake.adapter,
    }, async () => ({
        ...HERDR_EXECUTABLE_IDENTITY,
        version: "0.7.5",
      }));

    await expect(
      runner.run(["session", "list", "--json"]),
    ).rejects.toMatchObject({ code: "HERDR_IDENTITY_MISMATCH" });
    expect(fake.calls).toHaveLength(0);
  });

  it("returns the same receipt for replay and rejects operation-id payload conflict", async () => {
    const fake = new FakeExec(openResponse());
    const adapter = createAdapter(fake);
    const operation = prepareOperation();

    const first = await adapter.execute(operation);
    const replay = await adapter.execute(operation);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      operationId: operation.operationId,
      fingerprint: operation.fingerprint,
      operationStatus: "completed",
      evidence: { proofScope: "local_observation" },
      workspaceResult: { reportedWorkspacePath: fixturePath },
    });
    expect(fake.calls).toHaveLength(1);

    await expect(
      adapter.execute(
        prepareOperation(
          operation.operationId,
          WorkspaceIdSchema.parse("wsp_herdrpublic02"),
        ),
      ),
    ).rejects.toThrow("OPERATION_ID_REUSED_WITH_DIFFERENT_PAYLOAD");
    expect(fake.calls).toHaveLength(1);
  });

  it("shares one in-flight Provider effect across concurrent replay", async () => {
    const fake = new FakeExec(openResponse());
    const adapter = createAdapter(fake);
    const operation = prepareOperation();

    const [first, second] = await Promise.all([
      adapter.execute(operation),
      adapter.execute(operation),
    ]);

    expect(second).toEqual(first);
    expect(fake.calls).toHaveLength(1);
  });

  it("closes only Herdr workspace state and never removes the Git worktree", async () => {
    const fake = new FakeExec(openResponse(), closeResponse());
    const adapter = createAdapter(fake);
    await adapter.execute(prepareOperation());

    const release = await adapter.execute(releaseOperation());

    expect(release).toMatchObject({
      operationStatus: "completed",
      evidence: { proofScope: "local_observation" },
    });
    expect(fake.calls[1]?.args).toEqual([
      "--session",
      "hunter-task1-gate",
      "workspace",
      "close",
      "w1",
    ]);
    expect(
      fake.calls.flatMap(({ args }) => args).join(" "),
    ).not.toMatch(/\bworktree\s+(?:create|remove)\b|--force/iu);
  });

  it("fails closed on unexpected response fields and returned path mismatch", async () => {
    const extraField = openResponse() as {
      result: Record<string, unknown>;
    };
    extraField.result["private_state"] = true;
    await expect(
      new HerdrPublicClient(createRunner(new FakeExec(extraField)))
        .openExistingWorktree({
          sourcePath: fixtureRoot,
          path: fixturePath,
          operationLabel: "hunter-opn_herdprepare01",
        }),
    ).rejects.toMatchObject({ code: "HERDR_OUTPUT_INVALID" });

    const mismatchedPath =
      process.platform === "win32"
        ? "C:\\fixtures\\outside"
        : "/tmp/fixtures/outside";
    await expect(
      createAdapter(new FakeExec(openResponse(mismatchedPath))).execute(
        prepareOperation(),
      ),
    ).resolves.toMatchObject({
      operationStatus: "needs_attention",
    });

    const unsafeWorktree = openResponse() as {
      result: { worktree: { is_bare: boolean } };
    };
    unsafeWorktree.result.worktree.is_bare = true;
    await expect(
      new HerdrPublicClient(createRunner(new FakeExec(unsafeWorktree)))
        .openExistingWorktree({
          sourcePath: fixtureRoot,
          path: fixturePath,
          operationLabel: "hunter-opn_herdprepare01",
        }),
    ).rejects.toMatchObject({ code: "HERDR_OUTPUT_INVALID" });

    const unrelatedAlreadyOpen = openResponse(
      fixturePath,
      "w1",
      true,
    ) as { result: { workspace: { label: string } } };
    unrelatedAlreadyOpen.result.workspace.label = "unrelated-workspace";
    await expect(
      new HerdrPublicClient(
        createRunner(new FakeExec(unrelatedAlreadyOpen)),
      ).openExistingWorktree({
        sourcePath: fixtureRoot,
        path: fixturePath,
        operationLabel: "hunter-opn_herdprepare01",
      }),
    ).rejects.toMatchObject({ code: "HERDR_OUTPUT_INVALID" });
  });

  it("does not repeat a possible Provider effect after an invalid response", async () => {
    const invalid = {
      id: "cli:worktree:open",
      result: { type: "unexpected_after_external_effect" },
    };
    const fake = new FakeExec(invalid, invalid);
    const adapter = createAdapter(fake);
    const operation = prepareOperation();

    const first = await adapter.execute(operation);
    const replay = await adapter.execute(operation);

    expect(first).toMatchObject({
      operationStatus: "needs_attention",
      fingerprint: operation.fingerprint,
      nativeReferences: [],
      facts: [],
      evidence: { proofScope: "local_observation" },
    });
    expect(replay).toEqual(first);
    expect(fake.calls).toHaveLength(1);
  });

  it("does not repeat an uncertain workspace close", async () => {
    const invalidClose = {
      id: "cli:workspace:close",
      result: { type: "unexpected_after_external_effect" },
    };
    const fake = new FakeExec(openResponse(), invalidClose, invalidClose);
    const adapter = createAdapter(fake);
    await adapter.execute(prepareOperation());
    const operation = releaseOperation();

    const first = await adapter.execute(operation);
    const replay = await adapter.execute(operation);

    expect(first).toMatchObject({
      operationStatus: "needs_attention",
      fingerprint: operation.fingerprint,
      nativeReferences: [],
      facts: [],
      evidence: { proofScope: "local_observation" },
    });
    expect(replay).toEqual(first);
    expect(fake.calls).toHaveLength(2);
  });

  it("hashes unrelated session inventory without exposing names or paths", async () => {
    const fake = new FakeExec({
      sessions: [
        {
          name: "personal-private",
          default: false,
          running: true,
          socket_path: `${fixtureRoot}/private.sock`,
          session_dir: `${fixtureRoot}/private`,
        },
        {
          name: "hunter-task1-gate",
          default: false,
          running: true,
          socket_path: `${fixtureRoot}/task1.sock`,
          session_dir: `${fixtureRoot}/task1`,
        },
      ],
    });
    const inventory = await new HerdrPublicClient(
      createRunner(fake),
    ).inventorySessions("hunter-task1-gate");

    expect(inventory).toMatchObject({
      totalCount: 2,
      unrelatedCount: 1,
      target: "running",
    });
    expect(inventory.unrelatedDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(inventory)).not.toContain("personal-private");
    expect(JSON.stringify(inventory)).not.toContain("private.sock");
  });

  it("stops and deletes only the runner-owned named session", async () => {
    const fake = new FakeExec(
      {
        stopped: true,
        session: sessionInfo(),
      },
      {
        deleted: true,
        session: sessionInfo(),
      },
    );
    const client = new HerdrPublicClient(createRunner(fake));

    await expect(
      client.stopOwnedSession("hunter-task1-gate"),
    ).resolves.toEqual({ outcome: "stopped" });
    await expect(
      client.deleteOwnedSession("hunter-task1-gate"),
    ).resolves.toEqual({ outcome: "deleted" });

    expect(fake.calls.map(({ args }) => args)).toEqual([
      [
        "--session",
        "hunter-task1-gate",
        "session",
        "stop",
        "hunter-task1-gate",
        "--json",
      ],
      [
        "--session",
        "hunter-task1-gate",
        "session",
        "delete",
        "hunter-task1-gate",
        "--json",
      ],
    ]);
  });

  it("rejects cleanup of any session other than the runner-owned session before I/O", async () => {
    const fake = new FakeExec();
    const client = new HerdrPublicClient(createRunner(fake));

    await expect(
      client.stopOwnedSession("hunter-unrelated"),
    ).rejects.toMatchObject({ code: "HERDR_COMMAND_FORBIDDEN" });
    await expect(
      client.deleteOwnedSession("hunter-unrelated"),
    ).rejects.toMatchObject({ code: "HERDR_COMMAND_FORBIDDEN" });
    expect(fake.calls).toHaveLength(0);
  });

  it("fails closed when session cleanup receipts are inconsistent", async () => {
    const fake = new FakeExec(
      {
        stopped: true,
        session: sessionInfo("hunter-other"),
      },
      {
        deleted: true,
        session: sessionInfo("hunter-task1-gate", true),
      },
    );
    const client = new HerdrPublicClient(createRunner(fake));

    await expect(
      client.stopOwnedSession("hunter-task1-gate"),
    ).rejects.toMatchObject({
      code: "HERDR_OUTPUT_INVALID",
      effectPossible: true,
    });
    await expect(
      client.deleteOwnedSession("hunter-task1-gate"),
    ).rejects.toMatchObject({
      code: "HERDR_OUTPUT_INVALID",
      effectPossible: true,
    });
  });
});
