import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { arch, release } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
  NodeAppServerTransport,
  runAppServerSession,
  type AppServerSessionReceipt,
  type AppServerTransport,
} from "./app-server-client.js";
import { resolveCodexExecutable } from "./scenario.js";

const HASH = /^[a-f0-9]{64}$/u;
const CapabilityOutcomeSchema = z.enum(["PASS", "FAIL", "BLOCKED", "NOT_PROVEN"]);
const ApprovalMethodSchema = z.enum([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);
const CapabilitySchema = z.strictObject({
  id: z.enum(["permission_events", "interrupt"]),
  outcome: CapabilityOutcomeSchema,
  reason: z.string().min(1),
});

export const AppServerEvidenceSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    evidenceType: z.literal("phase0_codex_app_server_runtime"),
    generatedAt: z.iso.datetime(),
    generator: z.strictObject({
      name: z.literal("hunter-phase0-codex-app-server"),
      version: z.literal("0.1.0"),
    }),
    host: z.strictObject({
      platform: z.string().min(1),
      architecture: z.string().min(1),
      release: z.string().min(1),
      nodeVersion: z.string().min(1),
    }),
    installedVersion: z.literal("0.144.6"),
    helpHash: z.string().regex(HASH),
    schemaBundleHash: z.string().regex(HASH),
    schemaCanonicalHash: z.string().regex(HASH),
    schemaValidated: z.literal(true),
    transport: z.literal("stdio"),
    proofScope: z.literal("local_ephemeral_typed_scenario"),
    providerVerdict: z.literal("NOT_PROVEN"),
    realTurnCount: z.literal(2),
    attempts: z.strictObject({
      plannedRealCallLimit: z.literal(2),
      actualRealScenarioRuns: z.number().int().positive(),
      actualRealTurnCount: z.number().int().positive(),
      conformance: z.enum(["PASS", "FAIL"]),
      reason: z.enum(["within_real_call_limit", "real_call_limit_exceeded"]),
    }),
    fixture: z.strictObject({
      cwdScope: z.literal("temporary_git_fixture"),
      remotePresent: z.literal(false),
      repositoryCleanAfterScenario: z.boolean(),
      cleanup: z.literal("verified_by_fixture_return"),
    }),
    protocol: z.strictObject({
      initialized: z.boolean(),
      ephemeralThread: z.boolean(),
      approvalRequestMethods: z.array(ApprovalMethodSchema),
      approvalDenialMethods: z.array(ApprovalMethodSchema),
      approvalContextMatched: z.boolean(),
      interruptAccepted: z.boolean(),
      interruptTerminalStatus: z.enum(["interrupted", "completed", "failed", "not_observed"]),
      protocolErrors: z.number().int().nonnegative(),
      transportCleanup: z.enum(["process_tree_terminated", "direct_process_exit", "not_proven"]),
      stepSuccess: z.literal(false),
    }),
    capabilities: z.tuple([CapabilitySchema, CapabilitySchema]),
    redaction: z.strictObject({ applied: z.literal(true), schemaVersion: z.literal(1) }),
    contentFingerprint: z.string().regex(HASH),
  })
  .superRefine((value, context) => {
    const attemptsWithinLimit =
      value.attempts.actualRealScenarioRuns <= value.attempts.plannedRealCallLimit &&
      value.attempts.actualRealTurnCount === value.attempts.actualRealScenarioRuns * 2;
    if (
      value.attempts.conformance !== (attemptsWithinLimit ? "PASS" : "FAIL") ||
      value.attempts.reason !==
        (attemptsWithinLimit ? "within_real_call_limit" : "real_call_limit_exceeded")
    ) {
      context.addIssue({
        code: "custom",
        path: ["attempts"],
        message: "ATTEMPT_LEDGER_CONTRADICTION",
      });
    }
    if (value.capabilities[0].id !== "permission_events" || value.capabilities[1].id !== "interrupt") {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "CAPABILITY_SLOTS_INVALID",
      });
    }
    const capabilityPass = value.capabilities.some((capability) => capability.outcome === "PASS");
    if (
      capabilityPass &&
      (value.attempts.conformance !== "PASS" ||
        !value.fixture.repositoryCleanAfterScenario ||
        value.protocol.transportCleanup !== "process_tree_terminated" ||
        !value.protocol.initialized ||
        !value.protocol.ephemeralThread ||
        value.protocol.protocolErrors !== 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "CAPABILITY_PASS_WITHOUT_SAFE_PREREQUISITES",
      });
    }
    if (
      value.capabilities[0].outcome === "PASS" &&
      (!value.protocol.approvalContextMatched ||
        value.protocol.approvalRequestMethods.length === 0 ||
        value.protocol.approvalRequestMethods.length !== value.protocol.approvalDenialMethods.length ||
        value.protocol.approvalRequestMethods.some(
          (method, index) => value.protocol.approvalDenialMethods[index] !== method,
        ))
    ) {
      context.addIssue({
        code: "custom",
        path: ["capabilities", 0],
        message: "PERMISSION_PASS_WITHOUT_DENIAL_RECEIPT",
      });
    }
    if (
      value.protocol.approvalDenialMethods.some(
        (method) => !value.protocol.approvalRequestMethods.includes(method),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["protocol", "approvalDenialMethods"],
        message: "APPROVAL_DENIAL_WITHOUT_MATCHING_REQUEST",
      });
    }
    const expected = fingerprint({
      ...value,
      generatedAt: undefined,
      contentFingerprint: undefined,
    });
    if (value.contentFingerprint !== expected) {
      context.addIssue({ code: "custom", path: ["contentFingerprint"], message: "CONTENT_FINGERPRINT_MISMATCH" });
    }
  });

export type AppServerEvidence = z.infer<typeof AppServerEvidenceSchema>;

export interface CollectAppServerEvidenceOptions {
  readonly now: () => Date;
  readonly host: AppServerEvidence["host"];
  readonly installedVersion: string;
  readonly helpHash: string;
  readonly schemaBundleHash: string;
  readonly schemaCanonicalHash: string;
  readonly schemaValidated: true;
  readonly receipt: AppServerSessionReceipt;
  readonly fixture: {
    readonly remotePresent: false;
    readonly repositoryCleanAfterScenario: boolean;
  };
  readonly attempts: {
    readonly plannedRealCallLimit: 2;
    readonly actualRealScenarioRuns: number;
    readonly actualRealTurnCount: number;
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
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

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function collectAppServerEvidence(
  options: CollectAppServerEvidenceOptions,
): AppServerEvidence {
  const attemptConformance =
    options.attempts.actualRealScenarioRuns <= options.attempts.plannedRealCallLimit &&
    options.attempts.actualRealTurnCount === options.attempts.actualRealScenarioRuns * 2;
  const safePrerequisites =
    attemptConformance &&
    options.fixture.repositoryCleanAfterScenario &&
    options.receipt.cleanup === "process_tree_terminated" &&
    options.receipt.summary.initialized &&
    options.receipt.summary.ephemeralThread &&
    options.receipt.summary.protocolErrors === 0;
  const permissionObserved =
    options.receipt.summary.approvalContextMatched &&
    options.receipt.summary.approvalRequestMethods.length > 0;
  const permissionDenied =
    permissionObserved &&
    options.receipt.summary.approvalRequestMethods.length ===
      options.receipt.summary.approvalDenialMethods.length &&
    options.receipt.summary.approvalRequestMethods.every(
      (method, index) => options.receipt.summary.approvalDenialMethods[index] === method,
    );
  const interruptProven =
    safePrerequisites &&
    options.receipt.summary.interruptAccepted &&
    options.receipt.summary.interruptTerminalStatus === "interrupted" &&
    options.receipt.cleanup === "process_tree_terminated";
  const withoutFingerprint = {
    schemaVersion: 1 as const,
    evidenceType: "phase0_codex_app_server_runtime" as const,
    generatedAt: options.now().toISOString(),
    generator: { name: "hunter-phase0-codex-app-server" as const, version: "0.1.0" as const },
    host: options.host,
    installedVersion: options.installedVersion,
    helpHash: options.helpHash,
    schemaBundleHash: options.schemaBundleHash,
    schemaCanonicalHash: options.schemaCanonicalHash,
    schemaValidated: options.schemaValidated,
    transport: "stdio" as const,
    proofScope: "local_ephemeral_typed_scenario" as const,
    providerVerdict: "NOT_PROVEN" as const,
    realTurnCount: options.receipt.realTurnCount,
    attempts: {
      ...options.attempts,
      conformance: attemptConformance ? ("PASS" as const) : ("FAIL" as const),
      reason: attemptConformance
        ? ("within_real_call_limit" as const)
        : ("real_call_limit_exceeded" as const),
    },
    fixture: {
      cwdScope: "temporary_git_fixture" as const,
      remotePresent: options.fixture.remotePresent,
      repositoryCleanAfterScenario: options.fixture.repositoryCleanAfterScenario,
      cleanup: "verified_by_fixture_return" as const,
    },
    protocol: {
      ...options.receipt.summary,
      transportCleanup: options.receipt.cleanup,
    },
    capabilities: [
      {
        id: "permission_events" as const,
        outcome: safePrerequisites && permissionDenied ? ("PASS" as const) : ("NOT_PROVEN" as const),
        reason:
          safePrerequisites && permissionDenied
            ? "approval_request_observed_and_denied"
            : !permissionObserved
              ? "no_approval_request_observed"
              : !permissionDenied
                ? "approval_denial_not_proven"
                : "scenario_safety_prerequisites_not_proven",
      },
      {
        id: "interrupt" as const,
        outcome: interruptProven ? ("PASS" as const) : ("NOT_PROVEN" as const),
        reason: interruptProven
          ? "matching_interrupt_response_and_terminal_observed"
          : options.receipt.summary.interruptAccepted &&
              options.receipt.summary.interruptTerminalStatus === "interrupted"
            ? "scenario_safety_prerequisites_not_proven"
            : "matching_interrupted_terminal_not_observed",
      },
    ] as const,
    redaction: { applied: true as const, schemaVersion: 1 as const },
  };
  return AppServerEvidenceSchema.parse({
    ...withoutFingerprint,
    contentFingerprint: fingerprint({ ...withoutFingerprint, generatedAt: undefined }),
  });
}

export interface ExecuteAppServerScenarioOptions {
  readonly runner: CommandRunner;
  readonly executable: string;
  readonly now: () => Date;
  readonly host: AppServerEvidence["host"];
  readonly timeoutMs?: number;
  readonly transportFactory?: (executable: string, cwd: string) => AppServerTransport;
}

function succeeded(result: CommandResult): boolean {
  return result.exitCode === 0 && !result.timedOut && result.spawnError == null;
}

function hasErrorCode(error: unknown): error is { readonly code: string } {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string";
}

export function requireSupportedCodexVersion(version: string): "0.144.6" {
  if (version !== "0.144.6") throw new Error("APP_SERVER_VERSION_MISMATCH");
  return version;
}

export interface AppServerSchemaArtifacts {
  readonly protocol: string;
  readonly serverRequests: string;
  readonly commandApprovalResponse: string;
  readonly fileApprovalResponse: string;
  readonly permissionsApprovalResponse: string;
}

export function validateAppServerSchemaArtifacts(artifacts: AppServerSchemaArtifacts): true {
  const requirements: ReadonlyArray<readonly [string, readonly string[]]> = [
    [
      artifacts.protocol,
      [
        "thread/start",
        "turn/start",
        "turn/interrupt",
        "turn/started",
        "turn/completed",
        "approvalsReviewer",
        "sandboxPolicy",
        "ephemeral",
      ],
    ],
    [
      artifacts.serverRequests,
      [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/permissions/requestApproval",
      ],
    ],
    [artifacts.commandApprovalResponse, ["decline", "cancel"]],
    [artifacts.fileApprovalResponse, ["decline", "cancel"]],
    [artifacts.permissionsApprovalResponse, ["permissions", "strictAutoReview"]],
  ];
  for (const [source, markers] of requirements) {
    const normalized = JSON.stringify(JSON.parse(source) as unknown);
    if (markers.some((marker) => !normalized.includes(JSON.stringify(marker)))) {
      throw new Error("APP_SERVER_SCHEMA_REQUIRED_MARKER_MISSING");
    }
  }
  return true;
}

function strictChild(parent: string, child: string): boolean {
  const segment = relative(resolve(parent), resolve(child));
  return segment !== "" && segment !== ".." && !segment.startsWith(`..${sep}`) && !isAbsolute(segment);
}

export async function executeAppServerScenario(
  options: ExecuteAppServerScenarioOptions,
): Promise<AppServerEvidence> {
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  const remaining = (perOperationLimit: number): number => {
    const value = Math.min(perOperationLimit, deadline - Date.now());
    if (value <= 0) throw new Error("APP_SERVER_SCENARIO_TIMEOUT");
    return value;
  };
  return await withTemporaryGitFixture(async (fixture) => {
    assertProbeWorkspace({ mutation: "repository", cwd: fixture.path, fixture });
    const remote = await options.runner.run({
      executable: "git",
      args: ["remote"],
      cwd: fixture.path,
      timeoutMs: remaining(5_000),
    });
    if (!succeeded(remote) || remote.stdout.trim() !== "") {
      throw new Error("APP_SERVER_SCENARIO_REQUIRES_NO_REMOTE_FIXTURE");
    }
    const version = await options.runner.run({
      executable: options.executable,
      args: ["--version"],
      cwd: fixture.path,
      timeoutMs: remaining(10_000),
    });
    const help = await options.runner.run({
      executable: options.executable,
      args: ["app-server", "--help"],
      cwd: fixture.path,
      timeoutMs: remaining(10_000),
    });
    if (!succeeded(version) || !succeeded(help)) throw new Error("APP_SERVER_PREFLIGHT_BLOCKED");
    const match = /codex-cli\s+([^\s]+)/u.exec(version.stdout);
    if (match?.[1] === undefined) throw new Error("APP_SERVER_VERSION_NOT_PROVEN");
    const installedVersion = requireSupportedCodexVersion(match[1]);

    const schemaDir = join(fixture.path, ".hunter-app-server-schema");
    if (!strictChild(fixture.path, schemaDir)) throw new Error("APP_SERVER_SCHEMA_PATH_UNSAFE");
    const generated = await options.runner.run({
      executable: options.executable,
      args: ["app-server", "generate-json-schema", "--out", schemaDir],
      cwd: fixture.path,
      timeoutMs: remaining(30_000),
    });
    if (!succeeded(generated)) throw new Error("APP_SERVER_SCHEMA_GENERATION_BLOCKED");
    const schema = await readFile(join(schemaDir, "codex_app_server_protocol.v2.schemas.json"), "utf8");
    const schemaValidated = validateAppServerSchemaArtifacts({
      protocol: schema,
      serverRequests: await readFile(join(schemaDir, "ServerRequest.json"), "utf8"),
      commandApprovalResponse: await readFile(
        join(schemaDir, "CommandExecutionRequestApprovalResponse.json"),
        "utf8",
      ),
      fileApprovalResponse: await readFile(
        join(schemaDir, "FileChangeRequestApprovalResponse.json"),
        "utf8",
      ),
      permissionsApprovalResponse: await readFile(
        join(schemaDir, "PermissionsRequestApprovalResponse.json"),
        "utf8",
      ),
    });
    const schemaBundleHash = sha256(schema);
    const schemaCanonicalHash = fingerprint(JSON.parse(schema) as unknown);
    await rm(schemaDir, { recursive: true, force: false });

    const transport = (options.transportFactory ?? ((executable, cwd) => new NodeAppServerTransport(executable, cwd)))(
      options.executable,
      fixture.path,
    );
    const receipt = await runAppServerSession({
      transport,
      fixturePath: fixture.path,
      approvalPrompt:
        "Create a file named hunter-app-server-probe.txt containing probe using exactly one shell command. Do nothing else.",
      interruptPrompt:
        "Wait for 60 seconds without modifying files. Do not return before the wait completes unless interrupted.",
      timeoutMs: remaining(60_000),
    });
    const status = await options.runner.run({
      executable: "git",
      args: ["status", "--porcelain"],
      cwd: fixture.path,
      timeoutMs: remaining(5_000),
    });
    const repositoryCleanAfterScenario = succeeded(status) && status.stdout.trim() === "";
    return collectAppServerEvidence({
      now: options.now,
      host: options.host,
      installedVersion,
      helpHash: sha256(help.stdout),
      schemaBundleHash,
      schemaCanonicalHash,
      schemaValidated,
      receipt,
      fixture: { remotePresent: false, repositoryCleanAfterScenario },
      attempts: { plannedRealCallLimit: 2, actualRealScenarioRuns: 1, actualRealTurnCount: 2 },
    });
  });
}

function outputArgument(args: readonly string[]): string {
  const index = args.indexOf("--output");
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value === undefined || value.trim() === "") {
    throw new Error("USAGE: --output docs/validation/evidence/codex/app-server-runtime.json");
  }
  return value;
}

async function main(): Promise<void> {
  if (process.env.HUNTER_PHASE0_CODEX_APP_SERVER !== "allowed") {
    throw new Error("HUNTER_PHASE0_CODEX_APP_SERVER_MUST_EQUAL_ALLOWED");
  }
  const repositoryRoot = process.cwd();
  const outputPath = resolve(repositoryRoot, outputArgument(process.argv.slice(2)));
  const allowedRoot = resolve(repositoryRoot, "docs", "validation", "evidence", "codex");
  if (!strictChild(allowedRoot, outputPath) || !outputPath.endsWith(".json")) {
    throw new Error("APP_SERVER_EVIDENCE_OUTPUT_OUTSIDE_ALLOWED_ROOT");
  }
  try {
    await stat(outputPath);
    throw new Error("APP_SERVER_EVIDENCE_OUTPUT_ALREADY_EXISTS");
  } catch (error: unknown) {
    if (!hasErrorCode(error) || error.code !== "ENOENT") throw error;
  }
  const executable = await resolveCodexExecutable({
    platform: process.platform,
    architecture: arch(),
    ...(process.env.APPDATA === undefined ? {} : { appData: process.env.APPDATA }),
  });
  const evidence = await executeAppServerScenario({
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
  if (/thread-private|turn-private|fixed prompt|[A-Z]:\\Users\\/iu.test(serialized)) {
    throw new Error("APP_SERVER_EVIDENCE_CONTAINS_PRIVATE_DATA");
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialized, { encoding: "utf8", flag: "wx" });
  process.stdout.write(
    `Codex app-server Phase 0: verdict=${evidence.providerVerdict} turns=${String(evidence.realTurnCount)}\n`,
  );
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && resolve(entryPoint) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Codex app-server Phase 0 failed: ${redact(message)}\n`);
    process.exitCode = 1;
  });
}
