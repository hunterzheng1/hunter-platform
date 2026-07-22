import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { arch, release } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  NodeCommandRunner,
  assertProbeWorkspace,
  assertSafeEvidence,
  redact,
  type CommandResult,
  type CommandRunner,
  withTemporaryGitFixture,
} from "@hunter/spike-testkit";

const CapabilityOutcomeSchema = z.enum(["PASS", "FAIL", "BLOCKED", "NOT_PROVEN"]);

const CommandOperationSchema = z.enum([
  "version",
  "status",
  "doctor",
  "agent_catalog",
  "project_add",
  "project_get",
  "agent_refresh",
  "status_after_refresh",
  "session_list",
  "stale_session_get",
  "root_help",
  "session_help",
  "project_remove",
  "project_get_after_remove",
]);

const AgentOrchestratorCommandReceiptSchema = z.strictObject({
  operation: CommandOperationSchema,
  args: z.array(z.string()),
  cwdScope: z.literal("temporary_git_fixture"),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  spawnError: z.string().nullable(),
  stdinMode: z.enum(["none", "exact_project_id"]),
  stdoutSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  stderrSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

const CapabilityIdSchema = z.enum([
  "discover_runtime",
  "fixed_version",
  "project_registration",
  "resource_cleanup",
  "agent_readiness",
  "workspace_create_find",
  "process_terminal_launch",
  "observe",
  "interrupt",
  "restart_reconcile",
  "workspace_session_identity",
  "daemon_external_contract",
  "security_defaults",
  "mobile_pairing",
]);

const AgentOrchestratorCapabilityReceiptSchema = z.strictObject({
  id: CapabilityIdSchema,
  outcome: CapabilityOutcomeSchema,
  reason: z.string().min(1),
});

export const AgentOrchestratorEvidenceSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    evidenceType: z.literal("phase0_agent_orchestrator_fallback"),
    generatedAt: z.iso.datetime(),
    generator: z.strictObject({
      name: z.literal("hunter-phase0-agent-orchestrator"),
      version: z.literal("0.1.0"),
    }),
    host: z.strictObject({
      platform: z.string().min(1),
      architecture: z.string().min(1),
      release: z.string().min(1),
      nodeVersion: z.string().min(1),
    }),
    provider: z.literal("agent_orchestrator"),
    candidateRelease: z.literal("v0.10.3"),
    sourceLicense: z.literal("Apache-2.0"),
    cliReportedVersion: z.string().min(1).nullable(),
    providerVerdict: z.literal("NOT_PROVEN"),
    proofScope: z.literal("local_typed_scenario"),
    mutationAttempted: z.literal(true),
    spawnAttempted: z.literal(false),
    remoteAccessAttempted: z.literal(false),
    fixture: z.strictObject({
      cwdScope: z.literal("temporary_git_fixture"),
      remotePresent: z.literal(false),
    }),
    commands: z.array(AgentOrchestratorCommandReceiptSchema),
    capabilities: z.array(AgentOrchestratorCapabilityReceiptSchema),
    redaction: z.strictObject({
      applied: z.literal(true),
      schemaVersion: z.literal(1),
    }),
    contentFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .superRefine((value, context) => {
    const operations = value.commands.map((receipt) => receipt.operation);
    if (
      new Set(operations).size !== CommandOperationSchema.options.length ||
      CommandOperationSchema.options.some((operation) => !operations.includes(operation))
    ) {
      context.addIssue({
        code: "custom",
        path: ["commands"],
        message: "COMMAND_OPERATION_SET_INVALID",
      });
    }
    const capabilities = value.capabilities.map((receipt) => receipt.id);
    if (
      new Set(capabilities).size !== CapabilityIdSchema.options.length ||
      CapabilityIdSchema.options.some((capability) => !capabilities.includes(capability))
    ) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "CAPABILITY_SET_INVALID",
      });
    }
    const expectedFingerprint = sha256(
      JSON.stringify(
        canonicalize({
          ...value,
          generatedAt: undefined,
          contentFingerprint: undefined,
        }),
      ),
    );
    if (value.contentFingerprint !== expectedFingerprint) {
      context.addIssue({
        code: "custom",
        path: ["contentFingerprint"],
        message: "CONTENT_FINGERPRINT_MISMATCH",
      });
    }
  });

export type AgentOrchestratorEvidence = z.infer<
  typeof AgentOrchestratorEvidenceSchema
>;

export interface CollectAgentOrchestratorEvidenceOptions {
  readonly runner: CommandRunner;
  readonly executable: string;
  readonly fixturePath: string;
  readonly projectId: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly now: () => Date;
  readonly host: AgentOrchestratorEvidence["host"];
}

export type ExecuteAgentOrchestratorScenarioOptions = Omit<
  CollectAgentOrchestratorEvidenceOptions,
  "fixturePath" | "projectId"
>;

export interface AgentOrchestratorIsolationPaths {
  readonly phase0Root: string;
  readonly runFile: string;
  readonly dataDir: string;
}

const StatusSchema = z.object({
  state: z.string(),
  health: z.string().optional(),
  ready: z.string().optional(),
});

const DoctorSchema = z.object({
  ok: z.boolean(),
  failures: z.number().int().nonnegative(),
});

const AgentInfoSchema = z.object({ id: z.string().min(1) });
const AgentCatalogSchema = z.object({
  supported: z.array(AgentInfoSchema),
  installed: z.array(AgentInfoSchema),
  authorized: z.array(AgentInfoSchema),
});

const ProjectGetSchema = z.object({
  status: z.string(),
  project: z.object({
    id: z.string().min(1),
    path: z.string().min(1),
    defaultBranch: z.string().min(1),
  }),
});

const ProjectRemoveSchema = z
  .object({
    ok: z.literal(true).optional(),
    id: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
  })
  .refine(
    (value) => value.id !== undefined || value.projectId !== undefined,
    "PROJECT_REMOVE_RECEIPT_EMPTY",
  );

const SessionListSchema = z.object({
  data: z.array(z.unknown()),
  meta: z.object({ hiddenTerminatedCount: z.number().int().nonnegative() }),
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function replaceAll(value: string, search: string, replacement: string): string {
  return search === "" ? value : value.split(search).join(replacement);
}

function sanitizeValue(
  value: string,
  fixturePath: string,
  projectId: string,
): string {
  const jsonEscapedFixture = JSON.stringify(fixturePath).slice(1, -1);
  return redact(
    replaceAll(
      replaceAll(
        replaceAll(value, jsonEscapedFixture, "<FIXTURE_PATH>"),
        fixturePath,
        "<FIXTURE_PATH>",
      ),
      projectId,
      "<PROJECT_ID>",
    ),
  )
    .replace(/\r\n/gu, "\n")
    .trim();
}

function sanitizeArgs(
  args: readonly string[],
  fixturePath: string,
  projectId: string,
): string[] {
  return args.map((arg) =>
    arg === fixturePath
      ? "<FIXTURE_PATH>"
      : arg === projectId
        ? "<PROJECT_ID>"
        : arg,
  );
}

function commandSucceeded(result: CommandResult): boolean {
  return result.exitCode === 0 && !result.timedOut && result.spawnError == null;
}

function commandRejectedAsExpected(
  result: CommandResult | null,
  expectedMessage: RegExp,
): boolean {
  return (
    result !== null &&
    result.exitCode !== null &&
    result.exitCode !== 0 &&
    !result.timedOut &&
    result.spawnError == null &&
    expectedMessage.test(`${result.stdout}\n${result.stderr}`)
  );
}

function isStrictChild(parent: string, child: string): boolean {
  const segment = relative(resolve(parent), resolve(child));
  return (
    segment !== "" &&
    segment !== ".." &&
    !segment.startsWith(`..${sep}`) &&
    !isAbsolute(segment)
  );
}

export function assertAgentOrchestratorIsolation(
  paths: AgentOrchestratorIsolationPaths,
): void {
  if (!isStrictChild(paths.phase0Root, paths.runFile)) {
    throw new Error("AO_RUN_FILE_OUTSIDE_PHASE0_ROOT");
  }
  if (!isStrictChild(paths.phase0Root, paths.dataDir)) {
    throw new Error("AO_DATA_DIR_OUTSIDE_PHASE0_ROOT");
  }
}

function parseJson<T>(result: CommandResult, schema: z.ZodType<T>): T | null {
  if (!commandSucceeded(result)) return null;
  try {
    return schema.parse(JSON.parse(result.stdout));
  } catch {
    return null;
  }
}

function parseJsonSuffix<T>(result: CommandResult, schema: z.ZodType<T>): T | null {
  if (!commandSucceeded(result)) return null;
  const jsonStart = result.stdout.indexOf("{");
  if (jsonStart < 0) return null;
  try {
    return schema.parse(JSON.parse(result.stdout.slice(jsonStart)));
  } catch {
    return null;
  }
}

export async function collectAgentOrchestratorEvidence(
  options: CollectAgentOrchestratorEvidenceOptions,
): Promise<AgentOrchestratorEvidence> {
  const commands: z.infer<typeof AgentOrchestratorCommandReceiptSchema>[] = [];
  const run = async (
    operation: z.infer<typeof CommandOperationSchema>,
    args: readonly string[],
    request: { readonly timeoutMs?: number; readonly stdin?: string } = {},
  ): Promise<CommandResult> => {
    const result = await options.runner.run({
      executable: options.executable,
      args,
      cwd: options.fixturePath,
      timeoutMs: request.timeoutMs ?? 5_000,
      environment: options.environment,
      ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
    });
    commands.push({
      operation,
      args: sanitizeArgs(args, options.fixturePath, options.projectId),
      cwdScope: "temporary_git_fixture",
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      spawnError: result.spawnError ?? null,
      stdinMode: request.stdin === undefined ? "none" : "exact_project_id",
      stdoutSha256: sha256(
        sanitizeValue(result.stdout, options.fixturePath, options.projectId),
      ),
      stderrSha256: sha256(
        sanitizeValue(result.stderr, options.fixturePath, options.projectId),
      ),
    });
    return result;
  };

  const version = await run("version", ["--version"]);
  const status = await run("status", ["status", "--json"]);
  const doctor = await run("doctor", ["doctor", "--json"]);
  const cachedCatalog = await run("agent_catalog", ["agent", "ls", "--json"]);
  let projectAdd: CommandResult | null = null;
  let projectGet: CommandResult | null = null;
  let refresh: CommandResult | null = null;
  let statusAfterRefresh: CommandResult | null = null;
  let sessionList: CommandResult | null = null;
  let staleSessionGet: CommandResult | null = null;
  let rootHelp: CommandResult | null = null;
  let sessionHelp: CommandResult | null = null;
  let projectRemove: CommandResult | null = null;
  let projectGetAfterRemove: CommandResult | null = null;

  try {
    projectAdd = await run("project_add", [
      "project",
      "add",
      "--id",
      options.projectId,
      "--name",
      "Hunter Phase0 Fixture",
      "--path",
      options.fixturePath,
      "--worker-agent",
      "codex",
      "--orchestrator-agent",
      "codex",
    ]);
    projectGet = await run("project_get", [
      "project",
      "get",
      options.projectId,
      "--json",
    ]);
    refresh = await run(
      "agent_refresh",
      ["agent", "ls", "--refresh", "--json"],
      { timeoutMs: 10_000 },
    );
    statusAfterRefresh = await run("status_after_refresh", ["status", "--json"]);
    sessionList = await run("session_list", ["session", "ls", "--json"]);
    staleSessionGet = await run("stale_session_get", [
      "session",
      "get",
      "hunter-phase0-missing",
      "--project",
      options.projectId,
      "--json",
    ]);
    rootHelp = await run("root_help", ["--help"]);
    sessionHelp = await run("session_help", ["session", "--help"]);
  } finally {
    if (projectAdd !== null) {
      projectRemove = await run(
        "project_remove",
        ["project", "rm", options.projectId, "--json"],
        { stdin: `${options.projectId}\n` },
      );
      projectGetAfterRemove = await run("project_get_after_remove", [
        "project",
        "get",
        options.projectId,
        "--json",
      ]);
    }
  }

  const statusValue = parseJson(status, StatusSchema);
  const doctorValue = parseJson(doctor, DoctorSchema);
  const cachedCatalogValue = parseJson(cachedCatalog, AgentCatalogSchema);
  const refreshedCatalogValue = refresh === null ? null : parseJson(refresh, AgentCatalogSchema);
  const projectValue = projectGet === null ? null : parseJson(projectGet, ProjectGetSchema);
  const statusAfterValue =
    statusAfterRefresh === null ? null : parseJson(statusAfterRefresh, StatusSchema);
  const sessionListValue =
    sessionList === null ? null : parseJson(sessionList, SessionListSchema);
  const staleSessionRejected = commandRejectedAsExpected(
    staleSessionGet,
    /\bSESSION_NOT_FOUND\b/u,
  );
  const cliReportedVersion = commandSucceeded(version)
    ? /^ao version (.+)$/u.exec(version.stdout.trim())?.[1] ?? version.stdout.trim()
    : null;
  const runtimeReady =
    statusValue?.state === "ready" &&
    statusValue.health === "ok" &&
    statusAfterValue?.state === "ready" &&
    doctorValue?.ok === true &&
    doctorValue.failures === 0;
  const projectRegistered =
    commandSucceeded(projectAdd as CommandResult) &&
    projectValue?.project.id === options.projectId &&
    projectValue.project.path === options.fixturePath &&
    projectValue.project.defaultBranch.length > 0;
  const projectRemoveValue =
    projectRemove === null ? null : parseJsonSuffix(projectRemove, ProjectRemoveSchema);
  const removedProjectIds = [projectRemoveValue?.id, projectRemoveValue?.projectId].filter(
    (id): id is string => id !== undefined,
  );
  const removedProjectIdentityMatches =
    projectRemoveValue !== null &&
    removedProjectIds.length > 0 &&
    removedProjectIds.every((id) => id === options.projectId);
  const cleanupConfirmed =
    removedProjectIdentityMatches &&
    commandRejectedAsExpected(projectGetAfterRemove, /\bPROJECT_NOT_FOUND\b/u);
  const inventory = refreshedCatalogValue ?? cachedCatalogValue;
  const installedCount = inventory?.installed.length ?? 0;
  const installedAgentIds = new Set(inventory?.installed.map((agent) => agent.id) ?? []);
  const agentReady =
    installedAgentIds.has("codex") &&
    inventory?.authorized.some((agent) => agent.id === "codex") === true;
  const refreshTimedOut = refresh?.timedOut === true;
  const publicTerminalCommandPresent =
    /(?:^|\s)terminal(?:\s|$)/u.test(rootHelp?.stdout ?? "") ||
    /(?:^|\s)(?:read|input|interrupt)(?:\s|$)/u.test(sessionHelp?.stdout ?? "");
  const structuredCliSurface =
    statusValue !== null &&
    doctorValue !== null &&
    projectValue !== null &&
    sessionListValue !== null &&
    staleSessionRejected;

  const withoutFingerprint = {
    schemaVersion: 1 as const,
    evidenceType: "phase0_agent_orchestrator_fallback" as const,
    generatedAt: options.now().toISOString(),
    generator: {
      name: "hunter-phase0-agent-orchestrator" as const,
      version: "0.1.0" as const,
    },
    host: options.host,
    provider: "agent_orchestrator" as const,
    candidateRelease: "v0.10.3" as const,
    sourceLicense: "Apache-2.0" as const,
    cliReportedVersion,
    providerVerdict: "NOT_PROVEN" as const,
    proofScope: "local_typed_scenario" as const,
    mutationAttempted: true as const,
    spawnAttempted: false as const,
    remoteAccessAttempted: false as const,
    fixture: {
      cwdScope: "temporary_git_fixture" as const,
      remotePresent: false as const,
    },
    commands,
    capabilities: [
      {
        id: "discover_runtime" as const,
        outcome: runtimeReady ? ("PASS" as const) : ("FAIL" as const),
        reason: runtimeReady
          ? "status_ready_and_doctor_ok"
          : "status_or_doctor_not_ready",
      },
      {
        id: "fixed_version" as const,
        outcome: cliReportedVersion === "0.10.3" ? ("PASS" as const) : ("FAIL" as const),
        reason:
          cliReportedVersion === "0.10.3"
            ? "cli_reports_pinned_release"
            : "release_cli_reports_dev",
      },
      {
        id: "project_registration" as const,
        outcome: projectRegistered ? ("PASS" as const) : ("FAIL" as const),
        reason: projectRegistered
          ? "temporary_git_project_registered_and_read_back"
          : "project_registration_receipt_missing_or_mismatched",
      },
      {
        id: "resource_cleanup" as const,
        outcome: cleanupConfirmed ? ("PASS" as const) : ("FAIL" as const),
        reason: cleanupConfirmed
          ? "project_removed_by_exact_id_and_target_lookup_returns_not_found"
          : "project_removal_not_confirmed",
      },
      {
        id: "agent_readiness" as const,
        outcome: agentReady
          ? ("PASS" as const)
          : refreshTimedOut && installedCount === 0
            ? ("BLOCKED" as const)
            : ("NOT_PROVEN" as const),
        reason: agentReady
          ? "catalog_reports_installed_and_authorized_agent"
          : refreshTimedOut && installedCount === 0
            ? "catalog_refresh_timed_out_and_cached_inventory_empty"
            : "agent_inventory_not_authoritative",
      },
      {
        id: "workspace_create_find" as const,
        outcome: "BLOCKED" as const,
        reason: agentReady
          ? "real_agent_spawn_requires_separate_quota_authorization"
          : "no_session_worktree_created_without_proven_agent_readiness",
      },
      {
        id: "process_terminal_launch" as const,
        outcome: "BLOCKED" as const,
        reason: agentReady
          ? "real_agent_spawn_requires_separate_quota_authorization"
          : "spawn_not_attempted_without_proven_agent_readiness",
      },
      {
        id: "observe" as const,
        outcome: "BLOCKED" as const,
        reason: agentReady
          ? "no_live_session_without_real_agent_spawn_authorization"
          : "no_live_session_to_observe_without_proven_agent_readiness",
      },
      {
        id: "interrupt" as const,
        outcome: publicTerminalCommandPresent ? ("NOT_PROVEN" as const) : ("FAIL" as const),
        reason: publicTerminalCommandPresent
          ? "interrupt_surface_present_but_not_exercised"
          : "public_cli_has_no_raw_terminal_interrupt",
      },
      {
        id: "restart_reconcile" as const,
        outcome: "NOT_PROVEN" as const,
        reason: "no_native_session_identity_to_reconcile",
      },
      {
        id: "workspace_session_identity" as const,
        outcome: "NOT_PROVEN" as const,
        reason: "no_native_session_identity_receipt_available",
      },
      {
        id: "daemon_external_contract" as const,
        outcome: structuredCliSurface ? ("PASS" as const) : ("FAIL" as const),
        reason: structuredCliSurface
          ? "supported_cli_json_surface_returned_structured_receipts"
          : "supported_cli_json_surface_incomplete",
      },
      {
        id: "security_defaults" as const,
        outcome: "NOT_PROVEN" as const,
        reason: "listener_and_telemetry_defaults_not_exposed_as_versioned_receipt",
      },
      {
        id: "mobile_pairing" as const,
        outcome: "NOT_PROVEN" as const,
        reason: "mobile_and_lan_listener_not_enabled_or_tested",
      },
    ],
    redaction: { applied: true as const, schemaVersion: 1 as const },
  };

  const fingerprintProjection = {
    ...withoutFingerprint,
    generatedAt: undefined,
  };
  return AgentOrchestratorEvidenceSchema.parse({
    ...withoutFingerprint,
    contentFingerprint: sha256(JSON.stringify(canonicalize(fingerprintProjection))),
  });
}

export async function executeAgentOrchestratorScenario(
  options: ExecuteAgentOrchestratorScenarioOptions,
): Promise<AgentOrchestratorEvidence> {
  return await withTemporaryGitFixture(async (fixture) => {
    assertProbeWorkspace({
      mutation: "repository",
      cwd: fixture.path,
      fixture,
    });
    const remoteReceipt = await new NodeCommandRunner().run({
      executable: "git",
      args: ["remote"],
      cwd: fixture.path,
      timeoutMs: 5_000,
    });
    if (
      !commandSucceeded(remoteReceipt) ||
      remoteReceipt.stdout.trim() !== ""
    ) {
      throw new Error("AO_SCENARIO_REQUIRES_NO_REMOTE_FIXTURE");
    }
    return await collectAgentOrchestratorEvidence({
      ...options,
      fixturePath: fixture.path,
      projectId: `hunter-phase0-${randomUUID()}`,
    });
  });
}

function outputArgument(args: readonly string[]): string {
  const index = args.indexOf("--output");
  const output = index >= 0 ? args[index + 1] : undefined;
  if (output === undefined || output.trim() === "") {
    throw new Error("USAGE: --output docs/validation/evidence/agent-orchestrator/<file>.json");
  }
  return output;
}

function assertEvidenceOutput(repositoryRoot: string, requested: string): string {
  const evidenceRoot = resolve(
    repositoryRoot,
    "docs",
    "validation",
    "evidence",
    "agent-orchestrator",
  );
  const outputPath = resolve(repositoryRoot, requested);
  if (!isStrictChild(evidenceRoot, outputPath) || !outputPath.endsWith(".json")) {
    throw new Error("AO_EVIDENCE_OUTPUT_OUTSIDE_ALLOWED_ROOT");
  }
  return outputPath;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name}_REQUIRED`);
  }
  return value;
}

async function main(): Promise<void> {
  if (process.env.HUNTER_PHASE0_MUTATION !== "allowed") {
    throw new Error("HUNTER_PHASE0_MUTATION_MUST_EQUAL_ALLOWED");
  }
  const executable = requiredEnvironment("AO_CLI_COMMAND");
  const phase0Root = requiredEnvironment("AO_PHASE0_ROOT");
  const runFile = requiredEnvironment("AO_RUN_FILE");
  const dataDir = requiredEnvironment("AO_DATA_DIR");
  const port = requiredEnvironment("AO_PORT");
  if (!/^\d{2,5}$/u.test(port)) throw new Error("AO_PORT_INVALID");
  assertAgentOrchestratorIsolation({ phase0Root, runFile, dataDir });

  const repositoryRoot = process.cwd();
  const outputPath = assertEvidenceOutput(
    repositoryRoot,
    outputArgument(process.argv.slice(2)),
  );
  const evidence = await executeAgentOrchestratorScenario({
    runner: new NodeCommandRunner(),
    executable,
    environment: {
      AO_RUN_FILE: runFile,
      AO_DATA_DIR: dataDir,
      AO_PORT: port,
    },
    now: () => new Date(),
    host: {
      platform: process.platform,
      architecture: arch(),
      release: release(),
      nodeVersion: process.version,
    },
  });
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  assertSafeEvidence(serialized);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialized, "utf8");
  process.stdout.write(
    `Agent Orchestrator Phase 0 fallback: provider=${evidence.providerVerdict} commands=${String(evidence.commands.length)}\n`,
  );
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  resolve(entryPoint) === resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Agent Orchestrator Phase 0 fallback failed: ${redact(message)}\n`);
    process.exitCode = 1;
  });
}
