import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, parse, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "../spikes/testkit/src/index.js";
import { withTemporaryGitFixture } from "../spikes/testkit/src/index.js";
import {
  HERDR_STABLE_RELEASE,
  HERDR_REPLACEMENT_TIMEBOX_STARTED_AT,
  HERDR_WINDOWS_PREVIEW_RELEASE,
  HerdrControlPlaneBaselineSchema,
  collectHerdrControlPlaneBaseline,
  createHerdrControlPlaneBaseline,
  findHerdrBaselineTimeboxStart,
  inspectHerdrAsset,
  inspectHerdrApiSchemaDocument,
  inspectHerdrControlPlaneSource,
  parseHerdrBaselineArguments,
  prepareHerdrBaselineEvidenceOutput,
  resolveHerdrBaselineOutputPath,
} from "./herdr-control-plane-baseline.js";

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
      ["node\u0000--version", "v24.14.0"],
      ["git\u0000--version", "git version 2.50.1.windows.1"],
      [
        "C:\\Users\\private\\herdr.exe\u0000--version",
        "herdr 0.7.5-preview.2026-07-21-0f10e1453a7f",
      ],
      [
        "C:\\Users\\private\\herdr.exe\u0000--help",
        [
          "herdr api <subcommand>",
          "herdr worktree <subcommand>",
          "herdr workspace <subcommand>",
          "herdr session <subcommand>",
          "herdr agent <subcommand>",
        ].join("\n"),
      ],
      [
        "C:\\Users\\private\\herdr.exe\u0000api\u0000schema\u0000--json",
        JSON.stringify({
          $schema: "https://json-schema.org/draft/2020-12/schema",
          protocol: 17,
          schema_version: 1,
          schemas: {
            error_response: { type: "object" },
            event: { type: "object" },
            request: { type: "object" },
            subscription_event: { type: "object" },
            success_response: { type: "object" },
          },
          title: "Herdr API",
        }),
      ],
      [
        "C:\\Users\\private\\herdr.exe\u0000worktree\u0000--help",
        "Manage Git worktree-backed workspaces\nopen  Open an existing Git worktree",
      ],
      [
        "C:\\Users\\private\\herdr.exe\u0000workspace\u0000--help",
        "Manage workspaces over the socket API\nclose  Close a workspace",
      ],
      [
        "C:\\Users\\private\\herdr.exe\u0000session\u0000--help",
        "Manage named persistent sessions\nlist\nattach\nstop\ndelete",
      ],
      [
        "C:\\Users\\private\\herdr.exe\u0000agent\u0000--help",
        "Control and inspect agent panes\nstart\nprompt\nwait",
      ],
      [
        "powershell.exe\u0000-NoLogo\u0000-NoProfile\u0000-NonInteractive\u0000-File\u0000C:\\Users\\private\\codex.ps1\u0000--version",
        "codex-cli 0.144.6",
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
        startedAt: "2026-07-28T07:30:00.000Z",
        finishedAt: "2026-07-28T07:30:01.000Z",
      };
    } finally {
      this.#active = false;
    }
  }
}

describe("Herdr control-plane baseline evidence", () => {
  it("pins the official Windows preview identity without promoting the Provider", () => {
    const evidence = createHerdrControlPlaneBaseline({
      generatedAt: "2026-07-28T07:30:00.000Z",
      timeboxStartedAt: "2026-07-28T04:19:30.589Z",
      source: {
        commit: "1".repeat(40),
        digest: SHA256_A,
        clean: true,
      },
      host: {
        platform: "win32",
        architecture: "x64",
        release: "10.0.26200",
      },
      asset: {
        actualSha256: HERDR_WINDOWS_PREVIEW_RELEASE.sha256,
        actualSize: HERDR_WINDOWS_PREVIEW_RELEASE.size,
        temporaryDirectoryVerified: true,
      },
      tools: [
        {
          id: "node",
          availability: "DETECTED",
          version: "24.14.0",
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
          id: "herdr",
          availability: "DETECTED",
          version: "0.7.5",
          authentication: "DETECTED",
          authenticationRequired: false,
        },
        {
          id: "codex",
          availability: "DETECTED",
          version: "0.144.6",
          authentication: "DETECTED",
          authenticationRequired: true,
        },
      ],
      publicInterfaces: [
        "root_help",
        "api_schema",
        "worktree_inventory",
        "workspace_inventory",
        "session_inventory",
        "agent_inventory",
      ].map((operation) => ({
        operation,
        status: "DETECTED" as const,
        receiptHash: SHA256_B,
      })),
      capabilities: [
        "asset_integrity",
        "windows_binary_launch",
        "fixed_version",
        "public_schema",
        "public_inventory",
      ].map((id) => ({
        id,
        status: "PASS" as const,
        reason: `${id}_proven`,
        receiptHash: SHA256_B,
      })).concat([
        {
          id: "workspace_attach_existing",
          status: "NOT_PROVEN" as const,
          reason: "mutating_fixture_not_run",
          receiptHash: null,
        },
        {
          id: "resource_cleanup",
          status: "NOT_PROVEN" as const,
          reason: "cleanup_not_run",
          receiptHash: null,
        },
        {
          id: "security_defaults",
          status: "NOT_PROVEN" as const,
          reason: "agent_launch_not_run",
          receiptHash: null,
        },
      ]),
      commandReceipts: [
        "node_version",
        "git_version",
        "herdr_version",
        "herdr_help",
        "herdr_api_schema",
        "herdr_worktree_help",
        "herdr_workspace_help",
        "herdr_session_help",
        "herdr_agent_help",
        "codex_version",
        "codex_login_status",
      ].map((operation) => ({
        operation,
        executable: operation.startsWith("herdr_")
          ? ("herdr" as const)
          : operation.startsWith("codex_")
            ? ("codex" as const)
            : operation.startsWith("git_")
              ? ("git" as const)
              : ("node" as const),
        args: ["--version"],
        exitCode: 0,
        timedOut: false,
        outcome: "success" as const,
        timeoutCleanup: "not_applicable" as const,
        outputHash: SHA256_B,
      })),
    });

    expect(evidence.release.stable).toEqual(HERDR_STABLE_RELEASE);
    expect(evidence.release.windowsPreview).toEqual(
      HERDR_WINDOWS_PREVIEW_RELEASE,
    );
    expect(evidence.task0Verdict).toBe("PASS");
    expect(evidence.providerVerdict).toBe("NOT_PROVEN");
    expect(() =>
      HerdrControlPlaneBaselineSchema.parse(
        JSON.parse(JSON.stringify(evidence)) as unknown,
      ),
    ).not.toThrow();
    expect(evidence.proofScope).toBe("local_inventory_only");
    expect(evidence.mutationAttempted).toBe(false);
    expect(evidence.runBudget.additionalPaidBudgetUsd).toBe(0);
  });

  it("collects sequential read-only version, schema, inventory, and login receipts", async () => {
    const runner = new FixtureRunner();
    const evidence = await collectHerdrControlPlaneBaseline({
      runner,
      cwd: "C:\\Users\\private\\repo",
      herdrExecutable: "C:\\Users\\private\\herdr.exe",
      codexExecutable: "powershell.exe",
      codexPrefixArguments: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        "C:\\Users\\private\\codex.ps1",
      ],
      now: () => new Date("2026-07-28T07:30:00.000Z"),
      timeboxStartedAt: "2026-07-28T04:19:30.589Z",
      source: {
        commit: "1".repeat(40),
        digest: SHA256_A,
        clean: true,
      },
      host: {
        platform: "win32",
        architecture: "x64",
        release: "10.0.26200",
      },
      asset: {
        actualSha256: HERDR_WINDOWS_PREVIEW_RELEASE.sha256,
        actualSize: HERDR_WINDOWS_PREVIEW_RELEASE.size,
        temporaryDirectoryVerified: true,
      },
    });

    expect(runner.requests.map(({ args }) => args)).toEqual([
      ["--version"],
      ["--version"],
      ["--version"],
      ["--help"],
      ["api", "schema", "--json"],
      ["worktree", "--help"],
      ["workspace", "--help"],
      ["session", "--help"],
      ["agent", "--help"],
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
    expect(evidence.task0Verdict).toBe("BLOCKED");
    expect(
      evidence.capabilities.find(({ id }) => id === "public_schema"),
    ).toMatchObject({
      status: "BLOCKED",
      reason: "public_schema_invalid_or_unavailable",
    });
    expect(
      evidence.capabilities.find(({ id }) => id === "workspace_attach_existing"),
    ).toMatchObject({ status: "NOT_PROVEN", receiptHash: null });
    expect(JSON.stringify(evidence)).not.toContain("C:\\Users\\private");
    expect(JSON.stringify(evidence)).not.toContain("secret@example.invalid");
  });

  it("binds source identity and detects drift through the Git fixture boundary", async () => {
    await withTemporaryGitFixture(async (fixture) => {
      const baseline = inspectHerdrControlPlaneSource({
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
        join(fixture.path, "README.md"),
        "# Hunter changed fixture\n",
        "utf8",
      );
      const drifted = inspectHerdrControlPlaneSource({
        cwd: fixture.path,
        pathspec: ["README.md"],
      });
      expect(drifted.clean).toBe(false);
      expect(drifted.digest).not.toBe(baseline.digest);
    });
  });

  it("confines output to the versioned Herdr evidence directory", () => {
    const repositoryRoot = join(tmpdir(), "hunter-herdr-output-root");
    expect(
      resolveHerdrBaselineOutputPath(
        repositoryRoot,
        "docs/validation/evidence/herdr-control-plane/baseline.json",
      ),
    ).toBe(
      join(
        repositoryRoot,
        "docs",
        "validation",
        "evidence",
        "herdr-control-plane",
        "baseline.json",
      ),
    );
    expect(() =>
      resolveHerdrBaselineOutputPath(
        repositoryRoot,
        "docs/validation/evidence/herdr/baseline.json",
      ),
    ).toThrow("HERDR_BASELINE_OUTPUT_OUTSIDE_ALLOWED_ROOT");
    expect(() =>
      resolveHerdrBaselineOutputPath(
        repositoryRoot,
        resolve(tmpdir(), "herdr-baseline-outside.json"),
      ),
    ).toThrow("HERDR_BASELINE_OUTPUT_OUTSIDE_ALLOWED_ROOT");
  });

  it("archives an earlier attempt by content hash before replacement", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "hunter-herdr-baseline-test-"),
    );
    const target = join(directory, "baseline.json");
    const failedEvidence = "{\"task0Verdict\":\"BLOCKED\"}\n";
    try {
      await writeFile(target, failedEvidence, "utf8");

      const archived = prepareHerdrBaselineEvidenceOutput(target);

      expect(archived).toMatch(
        /baseline\.attempts[\\/][a-f0-9]{64}\.json$/u,
      );
      await expect(readFile(archived!, "utf8")).resolves.toBe(failedEvidence);
      await expect(readFile(target, "utf8")).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the original Orca-started deadline across replacement retries", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "hunter-herdr-timebox-test-"),
    );
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
        findHerdrBaselineTimeboxStart(
          target,
          "2026-07-28T04:30:00.000Z",
        ),
      ).toBe("2026-07-28T04:19:30.589Z");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects any attempt to reset the original replacement timebox", () => {
    expect(HERDR_REPLACEMENT_TIMEBOX_STARTED_AT).toBe(
      "2026-07-28T04:19:30.589Z",
    );
    expect(() =>
      createHerdrControlPlaneBaseline({
        generatedAt: "2026-07-28T07:30:00.000Z",
        timeboxStartedAt: "2026-07-28T04:25:00.000Z",
        source: {
          commit: "1".repeat(40),
          digest: SHA256_A,
          clean: true,
        },
        host: {
          platform: "win32",
          architecture: "x64",
          release: "10.0.26200",
        },
        asset: {
          actualSha256: HERDR_WINDOWS_PREVIEW_RELEASE.sha256,
          actualSize: HERDR_WINDOWS_PREVIEW_RELEASE.size,
          temporaryDirectoryVerified: true,
        },
        tools: [],
        publicInterfaces: [],
        capabilities: [],
        commandReceipts: [],
      }),
    ).toThrow("HERDR_REPLACEMENT_TIMEBOX_RESET");
  });

  it("measures the downloaded asset through its bytes rather than its filename", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hunter-herdr-asset-test-"));
    const asset = join(directory, "herdr-windows-x86_64.exe");
    try {
      await writeFile(asset, "abc", "utf8");
      expect(inspectHerdrAsset(asset)).toEqual({
        actualSha256:
          "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        actualSize: 3,
        temporaryDirectoryVerified: true,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("hashes the complete normalized schema and rejects nested drift", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      protocol: 17,
      schema_version: 1,
      schemas: {
        error_response: { properties: { code: { type: "string" } } },
        event: { properties: { sequence: { type: "integer" } } },
        request: { properties: { method: { type: "string" } } },
        subscription_event: { properties: { kind: { type: "string" } } },
        success_response: { properties: { result: { type: "object" } } },
      },
      title: "Herdr API",
    };
    const serialized = JSON.stringify(schema);
    const expected = createHash("sha256").update(serialized).digest("hex");
    expect(inspectHerdrApiSchemaDocument(serialized, expected)).toMatchObject({
      canonicalSha256: expected,
      matchesPinnedSchema: true,
    });
    schema.schemas.request.properties.method.type = "number";
    expect(
      inspectHerdrApiSchemaDocument(JSON.stringify(schema), expected),
    ).toMatchObject({ matchesPinnedSchema: false });
  });

  it("requires a recoverable temporary asset path", () => {
    expect(() =>
      inspectHerdrAsset(
        resolve(
          parse(resolve(process.cwd())).root,
          "hunter-not-temporary",
          "herdr-windows-x86_64.exe",
        ),
      ),
    ).toThrow("HERDR_ASSET_OUTSIDE_TEMPORARY_DIRECTORY");
  });

  it("blocks Task 0 outside a real Windows x64 host", async () => {
    const runner = new FixtureRunner();
    const evidence = await collectHerdrControlPlaneBaseline({
      runner,
      cwd: process.cwd(),
      herdrExecutable: "C:\\Users\\private\\herdr.exe",
      codexExecutable: "powershell.exe",
      codexPrefixArguments: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        "C:\\Users\\private\\codex.ps1",
      ],
      now: () => new Date("2026-07-28T07:30:00.000Z"),
      timeboxStartedAt: HERDR_REPLACEMENT_TIMEBOX_STARTED_AT,
      source: {
        commit: "1".repeat(40),
        digest: SHA256_A,
        clean: true,
      },
      host: {
        platform: "linux",
        architecture: "x64",
        release: "6.8.0",
      },
      asset: {
        actualSha256: HERDR_WINDOWS_PREVIEW_RELEASE.sha256,
        actualSize: HERDR_WINDOWS_PREVIEW_RELEASE.size,
        temporaryDirectoryVerified: true,
      },
    });
    expect(evidence.task0Verdict).toBe("BLOCKED");
    expect(
      evidence.capabilities.find(({ id }) => id === "windows_binary_launch"),
    ).toMatchObject({ status: "BLOCKED" });
  });

  it("does not treat empty successful help output as public inventory", async () => {
    class EmptyHelpRunner extends FixtureRunner {
      override async run(request: CommandRequest): Promise<CommandResult> {
        const result = await super.run(request);
        return request.args.at(-1) === "--help"
          ? { ...result, exitCode: 0, stdout: "" }
          : result;
      }
    }
    const evidence = await collectHerdrControlPlaneBaseline({
      runner: new EmptyHelpRunner(),
      cwd: process.cwd(),
      herdrExecutable: "C:\\Users\\private\\herdr.exe",
      codexExecutable: "powershell.exe",
      codexPrefixArguments: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        "C:\\Users\\private\\codex.ps1",
      ],
      now: () => new Date("2026-07-28T07:30:00.000Z"),
      timeboxStartedAt: HERDR_REPLACEMENT_TIMEBOX_STARTED_AT,
      source: {
        commit: "1".repeat(40),
        digest: SHA256_A,
        clean: true,
      },
      host: {
        platform: "win32",
        architecture: "x64",
        release: "10.0.26200",
      },
      asset: {
        actualSha256: HERDR_WINDOWS_PREVIEW_RELEASE.sha256,
        actualSize: HERDR_WINDOWS_PREVIEW_RELEASE.size,
        temporaryDirectoryVerified: true,
      },
    });
    expect(
      evidence.capabilities.find(({ id }) => id === "public_inventory"),
    ).toMatchObject({ status: "BLOCKED" });
  });

  it("supports the reproducible npm entry and an explicit temporary asset override", () => {
    expect(
      parseHerdrBaselineArguments([
        "--output",
        "docs/validation/evidence/herdr-control-plane/baseline.json",
      ]),
    ).toEqual({
      output:
        "docs/validation/evidence/herdr-control-plane/baseline.json",
      asset: null,
    });
    expect(
      parseHerdrBaselineArguments([
        "--output",
        "docs/validation/evidence/herdr-control-plane/baseline.json",
        "--asset",
        "C:\\tmp\\herdr.exe",
      ]),
    ).toEqual({
      output:
        "docs/validation/evidence/herdr-control-plane/baseline.json",
      asset: "C:\\tmp\\herdr.exe",
    });
    expect(() =>
      parseHerdrBaselineArguments([
        "--asset",
        "C:\\tmp\\herdr.exe",
        "--unknown",
        "value",
      ]),
    ).toThrow("HERDR_BASELINE_USAGE");
  });
});
