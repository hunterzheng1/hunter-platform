import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { arch, release } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
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
import {
  createCodexExecPlan,
  parseCodexJsonLines,
  type CodexEventStream,
} from "./exec-client.js";

const READ_ONLY_PROMPT =
  "Read README.md and return its first heading. Do not modify files.";
const RESUME_PROMPT =
  "Return exactly the same first heading again. Do not modify files.";
const INTERRUPT_PROMPT =
  "Wait until interrupted. Do not modify files or use tools.";

const CAPABILITY_IDS = [
  "discover",
  "workspace_targeting",
  "launch",
  "send",
  "observe",
  "structured_events",
  "permission_events",
  "resume",
  "interrupt",
  "completion_receipt",
  "headless",
  "artifact_export",
] as const;

const CapabilityOutcomeSchema = z.enum(["PASS", "FAIL", "BLOCKED", "NOT_PROVEN"]);
const CapabilityIdSchema = z.enum(CAPABILITY_IDS);
const CommandOperationSchema = z.enum([
  "version",
  "exec_help",
  "resume_help",
  "app_server_help",
  "login_status",
  "create",
  "resume",
  "interrupt",
  "fixture_status",
]);

const CommandReceiptSchema = z.strictObject({
  operation: CommandOperationSchema,
  args: z.array(z.string()),
  cwdScope: z.literal("temporary_git_fixture"),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  timeoutCleanup: z.enum([
    "not_applicable",
    "process_tree_terminated",
    "not_proven",
  ]),
  spawnError: z.string().nullable(),
  outputDiscarded: z.boolean(),
  stdoutSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  stderrSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

const CapabilityReceiptSchema = z.strictObject({
  id: CapabilityIdSchema,
  outcome: CapabilityOutcomeSchema,
  reason: z.string().min(1),
});

export const DirectCodexEvidenceSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    evidenceType: z.literal("phase0_direct_codex_runtime"),
    generatedAt: z.iso.datetime(),
    generator: z.strictObject({
      name: z.literal("hunter-phase0-direct-codex"),
      version: z.literal("0.1.0"),
    }),
    host: z.strictObject({
      platform: z.string().min(1),
      architecture: z.string().min(1),
      release: z.string().min(1),
      nodeVersion: z.string().min(1),
    }),
    connector: z.literal("direct_codex_cli"),
    installedVersion: z.string().min(1).nullable(),
    helpHashes: z.strictObject({
      exec: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
      resume: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
      appServer: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
    }),
    loginAvailable: z.boolean(),
    connectorVerdict: z.literal("NOT_PROVEN"),
    proofScope: z.literal("local_typed_scenario"),
    modelServiceCallAttempted: z.boolean(),
    remoteRepositoryWriteAttempted: z.literal(false),
    realCallCount: z.number().int().min(0).max(3),
    fixture: z.strictObject({
      cwdScope: z.literal("temporary_git_fixture"),
      remotePresent: z.literal(false),
      repositoryCleanAfterScenario: z.boolean(),
      cleanup: z.literal("verified_by_fixture_return"),
    }),
    commands: z.array(CommandReceiptSchema),
    capabilities: z.array(CapabilityReceiptSchema),
    redaction: z.strictObject({
      applied: z.literal(true),
      schemaVersion: z.literal(1),
    }),
    contentFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .superRefine((value, context) => {
    const ids = value.capabilities.map((capability) => capability.id);
    if (
      new Set(ids).size !== CAPABILITY_IDS.length ||
      CAPABILITY_IDS.some((id) => !ids.includes(id))
    ) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "CAPABILITY_SET_INVALID",
      });
    }
    const expected = evidenceFingerprint({
      ...value,
      generatedAt: undefined,
      contentFingerprint: undefined,
    });
    if (value.contentFingerprint !== expected) {
      context.addIssue({
        code: "custom",
        path: ["contentFingerprint"],
        message: "CONTENT_FINGERPRINT_MISMATCH",
      });
    }
  });

export type DirectCodexEvidence = z.infer<typeof DirectCodexEvidenceSchema>;

export interface CollectDirectCodexEvidenceOptions {
  readonly runner: CommandRunner;
  readonly executable: string;
  readonly fixturePath: string;
  readonly now: () => Date;
  readonly host: DirectCodexEvidence["host"];
}

export type ExecuteDirectCodexScenarioOptions = Omit<
  CollectDirectCodexEvidenceOptions,
  "fixturePath"
>;

export interface ResolveCodexExecutableOptions {
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly appData?: string;
  readonly fileExists?: (path: string) => Promise<boolean>;
}

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCodexExecutable(
  options: ResolveCodexExecutableOptions,
): Promise<string> {
  if (options.platform !== "win32") return "codex";
  if (options.appData === undefined || options.appData.trim() === "") {
    throw new Error("CODEX_WINDOWS_APPDATA_REQUIRED");
  }
  const target =
    options.architecture === "x64"
      ? { packageName: "codex-win32-x64", triple: "x86_64-pc-windows-msvc" }
      : options.architecture === "arm64"
        ? { packageName: "codex-win32-arm64", triple: "aarch64-pc-windows-msvc" }
        : null;
  if (target === null) throw new Error("CODEX_WINDOWS_ARCHITECTURE_UNSUPPORTED");
  const candidate = win32.join(
    options.appData,
    "npm",
    "node_modules",
    "@openai",
    "codex",
    "node_modules",
    "@openai",
    target.packageName,
    "vendor",
    target.triple,
    "bin",
    "codex.exe",
  );
  const fileExists = options.fileExists ?? defaultFileExists;
  if (!(await fileExists(candidate))) {
    throw new Error("CODEX_NATIVE_EXECUTABLE_NOT_FOUND");
  }
  return candidate;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function evidenceFingerprint(value: unknown): string {
  return sha256(JSON.stringify(canonicalize(value)));
}

function commandSucceeded(result: CommandResult): boolean {
  return result.exitCode === 0 && !result.timedOut && result.spawnError == null;
}

function sanitizeOutput(value: string, fixturePath: string): string {
  return redact(value)
    .split(fixturePath)
    .join("<FIXTURE_PATH>")
    .replace(/("(?:thread_id|session_id)"\s*:\s*")[^"]+("?)/giu, "$1[VOLATILE]$2")
    .replace(/\bthread-[A-Za-z0-9_-]+\b/gu, "[VOLATILE]")
    .replace(/\r\n/gu, "\n")
    .trim();
}

function safeArgs(args: readonly string[], sessionId: string | null): string[] {
  return args.map((argument) => {
    if (argument === READ_ONLY_PROMPT) return "<READ_ONLY_PROMPT>";
    if (argument === RESUME_PROMPT) return "<RESUME_PROMPT>";
    if (argument === INTERRUPT_PROMPT) return "<INTERRUPT_PROMPT>";
    if (sessionId !== null && argument === sessionId) return "<SESSION_ID>";
    return argument;
  });
}

function sessionIdFrom(stream: CodexEventStream): string | null {
  const event = stream.events.find((candidate) => candidate.kind === "session_started");
  return event?.kind === "session_started" ? event.sessionId : null;
}

function helpHash(result: CommandResult): string | null {
  return commandSucceeded(result) ? sha256(result.stdout.replace(/\r\n/gu, "\n").trim()) : null;
}

function outcome(
  id: (typeof CAPABILITY_IDS)[number],
  value: "PASS" | "FAIL" | "BLOCKED" | "NOT_PROVEN",
  reason: string,
): z.infer<typeof CapabilityReceiptSchema> {
  return { id, outcome: value, reason };
}

export async function collectDirectCodexEvidence(
  options: CollectDirectCodexEvidenceOptions,
): Promise<DirectCodexEvidence> {
  const commands: z.infer<typeof CommandReceiptSchema>[] = [];
  let currentSessionId: string | null = null;
  const run = async (
    operation: z.infer<typeof CommandOperationSchema>,
    args: readonly string[],
    timeoutMs: number,
    discardOutput = false,
    executable = options.executable,
  ): Promise<CommandResult> => {
    const result = await options.runner.run({
      executable,
      args,
      cwd: options.fixturePath,
      timeoutMs,
    });
    const stdout = discardOutput ? "" : sanitizeOutput(result.stdout, options.fixturePath);
    const stderr = discardOutput ? "" : sanitizeOutput(result.stderr, options.fixturePath);
    commands.push({
      operation,
      args: safeArgs(args, currentSessionId),
      cwdScope: "temporary_git_fixture",
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      timeoutCleanup: result.timeoutCleanup ?? "not_applicable",
      spawnError: result.spawnError ?? null,
      outputDiscarded: discardOutput,
      stdoutSha256: sha256(stdout),
      stderrSha256: sha256(stderr),
    });
    return result;
  };

  const version = await run("version", ["--version"], 5_000);
  const execHelp = await run("exec_help", ["exec", "--help"], 5_000);
  const resumeHelp = await run("resume_help", ["exec", "resume", "--help"], 5_000);
  const appServerHelp = await run(
    "app_server_help",
    ["app-server", "--help"],
    5_000,
  );
  const login = await run("login_status", ["login", "status"], 5_000, true);
  const installedVersion = commandSucceeded(version)
    ? /^codex-cli\s+([^\s]+)$/u.exec(version.stdout.trim())?.[1] ?? null
    : null;
  const execSurfaceAvailable =
    commandSucceeded(execHelp) &&
    execHelp.stdout.includes("--json") &&
    execHelp.stdout.includes("--sandbox");
  const resumeSurfaceAvailable =
    commandSucceeded(resumeHelp) && /resume/iu.test(resumeHelp.stdout);
  const loginAvailable = commandSucceeded(login);

  let createResult: CommandResult | null = null;
  let createStream: CodexEventStream | null = null;
  let resumeResult: CommandResult | null = null;
  let resumeStream: CodexEventStream | null = null;
  let interruptResult: CommandResult | null = null;
  let realCallCount = 0;

  if (installedVersion !== null && execSurfaceAvailable && loginAvailable) {
    const createPlan = createCodexExecPlan({ mode: "new", prompt: READ_ONLY_PROMPT });
    createResult = await run("create", createPlan.args, 60_000);
    realCallCount += 1;
    createStream = parseCodexJsonLines(createResult.stdout);
    currentSessionId = sessionIdFrom(createStream);

    if (currentSessionId !== null && resumeSurfaceAvailable) {
      const resumePlan = createCodexExecPlan({
        mode: "resume",
        sessionId: currentSessionId,
        prompt: RESUME_PROMPT,
      });
      resumeResult = await run("resume", resumePlan.args, 60_000);
      realCallCount += 1;
      resumeStream = parseCodexJsonLines(resumeResult.stdout);
    }

    const interruptPlan = createCodexExecPlan({
      mode: "new",
      prompt: INTERRUPT_PROMPT,
    });
    interruptResult = await run("interrupt", interruptPlan.args, 250);
    realCallCount += 1;
  }

  const fixtureStatus = await run(
    "fixture_status",
    ["status", "--porcelain"],
    5_000,
    false,
    "git",
  );
  const repositoryCleanAfterScenario =
    commandSucceeded(fixtureStatus) && fixtureStatus.stdout.trim() === "";

  const createdSessionId = createStream === null ? null : sessionIdFrom(createStream);
  const resumedSessionId = resumeStream === null ? null : sessionIdFrom(resumeStream);
  const createReturned = createStream?.summary.terminalOutcome === "returned";
  const createProtocolClean = createStream?.summary.protocolErrors === 0;
  const sessionCreated =
    createResult !== null && commandSucceeded(createResult) && createdSessionId !== null;
  const observed =
    createStream !== null && createStream.events.length > 0 && createProtocolClean;
  const resumeIdentityMatches =
    createdSessionId !== null &&
    resumedSessionId !== null &&
    sha256(createdSessionId) === sha256(resumedSessionId);
  const approvalObserved =
    createStream?.facts.some((fact) => fact.kind === "approval_requested") === true ||
    resumeStream?.facts.some((fact) => fact.kind === "approval_requested") === true;

  const capabilities = [
    outcome(
      "discover",
      installedVersion !== null && execSurfaceAvailable && loginAvailable
        ? "PASS"
        : installedVersion === null || !execSurfaceAvailable
          ? "FAIL"
          : "BLOCKED",
      installedVersion !== null && execSurfaceAvailable && loginAvailable
        ? "fixed_cli_and_login_available"
        : installedVersion === null || !execSurfaceAvailable
          ? "fixed_cli_or_exec_json_surface_missing"
          : "login_not_available",
    ),
    outcome(
      "workspace_targeting",
      repositoryCleanAfterScenario ? "PASS" : "FAIL",
      repositoryCleanAfterScenario
        ? "temporary_no_remote_fixture_bound"
        : "temporary_fixture_changed_during_read_only_scenario",
    ),
    outcome(
      "launch",
      sessionCreated ? "PASS" : loginAvailable ? "NOT_PROVEN" : "BLOCKED",
      sessionCreated
        ? "structured_session_identity_created"
        : loginAvailable
          ? "structured_session_identity_missing"
          : "login_not_available",
    ),
    outcome(
      "send",
      sessionCreated ? "PASS" : loginAvailable ? "NOT_PROVEN" : "BLOCKED",
      sessionCreated ? "fixed_prompt_accepted" : loginAvailable ? "prompt_acceptance_not_proven" : "login_not_available",
    ),
    outcome(
      "observe",
      observed ? "PASS" : loginAvailable ? "NOT_PROVEN" : "BLOCKED",
      observed ? "structured_events_observed" : loginAvailable ? "structured_observation_not_proven" : "login_not_available",
    ),
    outcome(
      "structured_events",
      observed ? "PASS" : loginAvailable ? "NOT_PROVEN" : "BLOCKED",
      observed ? "versioned_jsonl_stream_parsed" : loginAvailable ? "jsonl_stream_missing_or_malformed" : "login_not_available",
    ),
    outcome(
      "permission_events",
      approvalObserved ? "PASS" : "NOT_PROVEN",
      approvalObserved ? "structured_approval_event_observed" : "no_safe_permission_event_exercised",
    ),
    outcome(
      "resume",
      resumeResult === null
        ? loginAvailable
          ? "NOT_PROVEN"
          : "BLOCKED"
        : resumeIdentityMatches && resumeStream?.summary.terminalOutcome === "returned"
          ? "PASS"
          : "FAIL",
      resumeResult === null
        ? loginAvailable
          ? "resume_not_exercised_without_session_identity"
          : "login_not_available"
        : resumeIdentityMatches && resumeStream?.summary.terminalOutcome === "returned"
          ? "same_session_identity_resumed"
          : "resumed_session_identity_mismatch",
    ),
    outcome(
      "interrupt",
      "NOT_PROVEN",
      interruptResult?.timedOut === true &&
        interruptResult.timeoutCleanup === "process_tree_terminated"
        ? "process_tree_termination_is_not_structured_session_interrupt"
        : interruptResult?.timedOut === true
          ? "interrupt_process_cleanup_not_proven"
          : "structured_interrupt_not_exercised",
    ),
    outcome(
      "completion_receipt",
      createReturned ? "PASS" : "NOT_PROVEN",
      createReturned
        ? "structured_turn_terminal_event_observed_not_step_success"
        : "structured_terminal_event_missing",
    ),
    outcome(
      "headless",
      sessionCreated ? "PASS" : loginAvailable ? "NOT_PROVEN" : "BLOCKED",
      sessionCreated ? "noninteractive_exec_json_completed" : loginAvailable ? "headless_execution_not_proven" : "login_not_available",
    ),
    outcome("artifact_export", "NOT_PROVEN", "artifact_export_not_exercised"),
  ];

  const withoutFingerprint = {
    schemaVersion: 1 as const,
    evidenceType: "phase0_direct_codex_runtime" as const,
    generatedAt: options.now().toISOString(),
    generator: {
      name: "hunter-phase0-direct-codex" as const,
      version: "0.1.0" as const,
    },
    host: options.host,
    connector: "direct_codex_cli" as const,
    installedVersion,
    helpHashes: {
      exec: helpHash(execHelp),
      resume: helpHash(resumeHelp),
      appServer: helpHash(appServerHelp),
    },
    loginAvailable,
    connectorVerdict: "NOT_PROVEN" as const,
    proofScope: "local_typed_scenario" as const,
    modelServiceCallAttempted: realCallCount > 0,
    remoteRepositoryWriteAttempted: false as const,
    realCallCount,
    fixture: {
      cwdScope: "temporary_git_fixture" as const,
      remotePresent: false as const,
      repositoryCleanAfterScenario,
      cleanup: "verified_by_fixture_return" as const,
    },
    commands,
    capabilities,
    redaction: { applied: true as const, schemaVersion: 1 as const },
  };
  return DirectCodexEvidenceSchema.parse({
    ...withoutFingerprint,
    contentFingerprint: evidenceFingerprint({
      ...withoutFingerprint,
      generatedAt: undefined,
    }),
  });
}

export async function executeDirectCodexScenario(
  options: ExecuteDirectCodexScenarioOptions,
): Promise<DirectCodexEvidence> {
  return await withTemporaryGitFixture(async (fixture) => {
    assertProbeWorkspace({ mutation: "repository", cwd: fixture.path, fixture });
    const remote = await new NodeCommandRunner().run({
      executable: "git",
      args: ["remote"],
      cwd: fixture.path,
      timeoutMs: 5_000,
    });
    if (!commandSucceeded(remote) || remote.stdout.trim() !== "") {
      throw new Error("CODEX_SCENARIO_REQUIRES_NO_REMOTE_FIXTURE");
    }
    return await collectDirectCodexEvidence({ ...options, fixturePath: fixture.path });
  });
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

function outputArgument(args: readonly string[]): string {
  const index = args.indexOf("--output");
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value === undefined || value.trim() === "") {
    throw new Error("USAGE: --output docs/validation/evidence/codex/direct-runtime.json");
  }
  return value;
}

function assertEvidenceOutput(repositoryRoot: string, requested: string): string {
  const evidenceRoot = resolve(repositoryRoot, "docs", "validation", "evidence", "codex");
  const outputPath = resolve(repositoryRoot, requested);
  if (!isStrictChild(evidenceRoot, outputPath) || !outputPath.endsWith(".json")) {
    throw new Error("CODEX_EVIDENCE_OUTPUT_OUTSIDE_ALLOWED_ROOT");
  }
  return outputPath;
}

async function main(): Promise<void> {
  if (process.env.HUNTER_PHASE0_CODEX !== "allowed") {
    throw new Error("HUNTER_PHASE0_CODEX_MUST_EQUAL_ALLOWED");
  }
  const repositoryRoot = process.cwd();
  const outputPath = assertEvidenceOutput(
    repositoryRoot,
    outputArgument(process.argv.slice(2)),
  );
  const executable = await resolveCodexExecutable({
    platform: process.platform,
    architecture: arch(),
    ...(process.env.APPDATA === undefined ? {} : { appData: process.env.APPDATA }),
  });
  const evidence = await executeDirectCodexScenario({
    runner: new NodeCommandRunner(),
    executable,
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
  if (/\bthread-[A-Za-z0-9_-]+\b|private account/iu.test(serialized)) {
    throw new Error("CODEX_EVIDENCE_CONTAINS_PRIVATE_RUNTIME_IDENTITY");
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialized, "utf8");
  process.stdout.write(
    `Direct Codex Phase 0: connector=${evidence.connectorVerdict} calls=${String(evidence.realCallCount)}\n`,
  );
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  resolve(entryPoint) === resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Direct Codex Phase 0 failed: ${redact(message)}\n`);
    process.exitCode = 1;
  });
}
