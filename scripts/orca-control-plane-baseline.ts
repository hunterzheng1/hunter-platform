import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { arch, release } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NodeCommandRunner,
  assertSafeEvidence,
  redact,
  type CommandResult,
  type CommandRunner,
} from "@hunter/spike-testkit";
import { z } from "zod";

const SHA256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const ToolStateSchema = z.enum(["DETECTED", "BLOCKED", "NOT_PROVEN"]);
const MeasuredStateSchema = z.enum([
  "PASS",
  "FAIL",
  "BLOCKED",
  "NOT_PROVEN",
  "NOT_RUN",
  "CONTRACT_ONLY",
]);

export const CONTROL_PLANE_SOURCE_PATHSPEC = [
  ".github/workflows/ci.yml",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.base.json",
  "tsconfig.e2e.json",
  "apps",
  "contexts",
  "packages",
  "scripts",
  "spikes",
  "workflow-packs",
] as const;

const ControlPlaneSourceIdentitySchema = z.strictObject({
  commit: z.string().regex(/^[a-f0-9]{40}$/u),
  digest: SHA256Schema,
  clean: z.literal(true),
});
export type ControlPlaneSourceIdentity = z.infer<
  typeof ControlPlaneSourceIdentitySchema
>;

const ToolReceiptSchema = z.strictObject({
  id: z.enum(["node", "git", "orca", "codex"]),
  availability: ToolStateSchema,
  version: z.string().min(1).max(256).nullable(),
  authentication: ToolStateSchema,
  authenticationRequired: z.boolean(),
});

const PublicInterfaceReceiptSchema = z.strictObject({
  operation: z.string().min(1).max(128),
  status: ToolStateSchema,
  receiptHash: SHA256Schema.nullable(),
});

const CapabilityReceiptSchema = z
  .strictObject({
    id: z.string().min(1).max(128),
    status: MeasuredStateSchema,
    reason: z.string().min(1).max(256),
    receiptHash: SHA256Schema.nullable(),
  })
  .superRefine((receipt, context) => {
    if (receipt.status === "PASS" && receipt.receiptHash === null) {
      context.addIssue({
        code: "custom",
        path: ["receiptHash"],
        message: "PASS_REQUIRES_RECEIPT_HASH",
      });
    }
  });

const CommandReceiptSchema = z.strictObject({
  operation: z.string().min(1).max(128),
  executable: z.enum(["node", "git", "orca", "codex"]),
  args: z.array(z.string().max(512)).max(32),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  outputHash: SHA256Schema,
});

export const OrcaControlPlaneBaselineSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    evidenceType: z.literal("orca_control_plane_baseline"),
    generatedAt: z.iso.datetime(),
    generator: z.strictObject({
      name: z.literal("hunter-orca-control-plane-baseline"),
      version: z.literal("0.1.0"),
    }),
    timebox: z.strictObject({
      timezone: z.literal("Asia/Shanghai"),
      workingDays: z.literal(5),
      weekendDays: z.tuple([z.literal("saturday"), z.literal("sunday")]),
      startedAt: z.iso.datetime(),
      deadlineAt: z.iso.datetime(),
    }),
    source: ControlPlaneSourceIdentitySchema.extend({
      digestAlgorithm: z.literal("sha256-path-content-v1"),
      pathspec: z.tuple(
        CONTROL_PLANE_SOURCE_PATHSPEC.map((entry) => z.literal(entry)) as [
          z.ZodLiteral<(typeof CONTROL_PLANE_SOURCE_PATHSPEC)[number]>,
          ...z.ZodLiteral<(typeof CONTROL_PLANE_SOURCE_PATHSPEC)[number]>[],
        ],
      ),
    }),
    host: z.strictObject({
      platform: z.string().min(1).max(64),
      architecture: z.string().min(1).max(64),
      release: z.string().min(1).max(128),
    }),
    selectedAgent: z.literal("codex"),
    tools: z.array(ToolReceiptSchema).length(4),
    publicInterfaces: z.array(PublicInterfaceReceiptSchema),
    capabilities: z.array(CapabilityReceiptSchema),
    commandReceipts: z.array(CommandReceiptSchema),
    runBudget: z.strictObject({
      maxAttempts: z.literal(2),
      maxSessionsPerAttempt: z.literal(1),
      maxSendsPerAttempt: z.literal(4),
      maxAttemptDurationMs: z.literal(1_200_000),
      maxTotalExecutionMs: z.literal(2_700_000),
      additionalPaidBudgetUsd: z.literal(0),
    }),
    historicalEvidence: z.strictObject({
      readOnly: z.literal(true),
      references: z.tuple([
        z.literal("docs/validation/phase-0-decision.md"),
        z.literal("docs/validation/gate-r1-runtime-connectors.md"),
        z.literal("docs/validation/evidence/gate-r1/runtime-connectors.json"),
      ]),
    }),
    providerVerdict: z.literal("NOT_PROVEN"),
    proofScope: z.literal("local_inventory_only"),
    mutationAttempted: z.literal(false),
    redaction: z.strictObject({
      applied: z.literal(true),
      schemaVersion: z.literal(1),
    }),
    contentFingerprint: SHA256Schema,
  })
  .superRefine((evidence, context) => {
    const expectedDeadline = computeShanghaiBusinessDeadline(
      evidence.timebox.startedAt,
      evidence.timebox.workingDays,
    );
    if (evidence.timebox.deadlineAt !== expectedDeadline) {
      context.addIssue({
        code: "custom",
        path: ["timebox", "deadlineAt"],
        message: "TIMEBOX_DEADLINE_MISMATCH",
      });
    }

    const { contentFingerprint, ...withoutFingerprint } = evidence;
    const expectedFingerprint = sha256(
      JSON.stringify(canonicalize({
        ...withoutFingerprint,
        generatedAt: undefined,
      })),
    );
    if (contentFingerprint !== expectedFingerprint) {
      context.addIssue({
        code: "custom",
        path: ["contentFingerprint"],
        message: "CONTENT_FINGERPRINT_MISMATCH",
      });
    }
  });

export type OrcaControlPlaneBaseline = z.infer<
  typeof OrcaControlPlaneBaselineSchema
>;

export interface OrcaControlPlaneBaselineInput {
  readonly generatedAt: string;
  readonly timeboxStartedAt: string;
  readonly source: ControlPlaneSourceIdentity;
  readonly host: OrcaControlPlaneBaseline["host"];
  readonly tools: OrcaControlPlaneBaseline["tools"];
  readonly publicInterfaces: OrcaControlPlaneBaseline["publicInterfaces"];
  readonly capabilities: OrcaControlPlaneBaseline["capabilities"];
  readonly commandReceipts: OrcaControlPlaneBaseline["commandReceipts"];
}

export interface OrcaControlPlaneBaselineCollectionOptions {
  readonly runner: CommandRunner;
  readonly cwd: string;
  readonly orcaExecutable: string;
  readonly codexExecutable: string;
  readonly now: () => Date;
  readonly source: ControlPlaneSourceIdentity;
  readonly host: OrcaControlPlaneBaseline["host"];
}

export interface ControlPlaneSourceInspectionOptions {
  readonly cwd: string;
  readonly pathspec: readonly string[];
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

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactValue(item)]),
    );
  }
  return value;
}

export function computeShanghaiBusinessDeadline(
  startedAt: string,
  workingDays: number,
): string {
  const started = new Date(startedAt);
  if (
    Number.isNaN(started.valueOf()) ||
    !Number.isSafeInteger(workingDays) ||
    workingDays < 1 ||
    workingDays > 31
  ) {
    throw new Error("TIMEBOX_INPUT_INVALID");
  }

  const shanghaiOffsetMs = 8 * 60 * 60 * 1_000;
  const localCursor = new Date(started.valueOf() + shanghaiOffsetMs);
  let remaining = workingDays;
  while (remaining > 0) {
    localCursor.setUTCDate(localCursor.getUTCDate() + 1);
    const day = localCursor.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return new Date(localCursor.valueOf() - shanghaiOffsetMs).toISOString();
}

export function createOrcaControlPlaneBaseline(
  input: OrcaControlPlaneBaselineInput,
): OrcaControlPlaneBaseline {
  const safeInput = redactValue(input) as OrcaControlPlaneBaselineInput;
  const withoutFingerprint = {
    schemaVersion: 1 as const,
    evidenceType: "orca_control_plane_baseline" as const,
    generatedAt: safeInput.generatedAt,
    generator: {
      name: "hunter-orca-control-plane-baseline" as const,
      version: "0.1.0" as const,
    },
    timebox: {
      timezone: "Asia/Shanghai" as const,
      workingDays: 5 as const,
      weekendDays: ["saturday", "sunday"] as const,
      startedAt: safeInput.timeboxStartedAt,
      deadlineAt: computeShanghaiBusinessDeadline(
        safeInput.timeboxStartedAt,
        5,
      ),
    },
    source: {
      ...safeInput.source,
      digestAlgorithm: "sha256-path-content-v1" as const,
      pathspec: CONTROL_PLANE_SOURCE_PATHSPEC,
    },
    host: safeInput.host,
    selectedAgent: "codex" as const,
    tools: safeInput.tools,
    publicInterfaces: safeInput.publicInterfaces,
    capabilities: safeInput.capabilities,
    commandReceipts: safeInput.commandReceipts,
    runBudget: {
      maxAttempts: 2 as const,
      maxSessionsPerAttempt: 1 as const,
      maxSendsPerAttempt: 4 as const,
      maxAttemptDurationMs: 1_200_000 as const,
      maxTotalExecutionMs: 2_700_000 as const,
      additionalPaidBudgetUsd: 0 as const,
    },
    historicalEvidence: {
      readOnly: true as const,
      references: [
        "docs/validation/phase-0-decision.md",
        "docs/validation/gate-r1-runtime-connectors.md",
        "docs/validation/evidence/gate-r1/runtime-connectors.json",
      ] as const,
    },
    providerVerdict: "NOT_PROVEN" as const,
    proofScope: "local_inventory_only" as const,
    mutationAttempted: false as const,
    redaction: { applied: true as const, schemaVersion: 1 as const },
  };
  const contentFingerprint = sha256(
    JSON.stringify(canonicalize({
      ...withoutFingerprint,
      generatedAt: undefined,
    })),
  );
  return OrcaControlPlaneBaselineSchema.parse({
    ...withoutFingerprint,
    contentFingerprint,
  });
}

function gitOutput(
  cwd: string,
  args: readonly string[],
  encoding: "utf8" | "buffer",
): string | Buffer {
  return execFileSync("git", [...args], {
    cwd,
    encoding,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function validateSourcePathspec(pathspec: readonly string[]): string[] {
  if (pathspec.length === 0 || pathspec.length > 64) {
    throw new Error("SOURCE_PATHSPEC_INVALID");
  }
  return pathspec.map((entry) => {
    if (
      entry.length === 0 ||
      entry.length > 512 ||
      isAbsolute(entry) ||
      entry === ".." ||
      entry.startsWith(`..${sep}`) ||
      entry.includes("\u0000")
    ) {
      throw new Error("SOURCE_PATHSPEC_INVALID");
    }
    return entry;
  });
}

export function inspectControlPlaneSource(
  options: ControlPlaneSourceInspectionOptions,
): ControlPlaneSourceIdentity {
  const repositoryRoot = resolve(options.cwd);
  const pathspec = validateSourcePathspec(options.pathspec);
  const commit = String(
    gitOutput(repositoryRoot, ["rev-parse", "HEAD"], "utf8"),
  ).trim();
  const status = String(
    gitOutput(
      repositoryRoot,
      ["status", "--porcelain=v1", "--untracked-files=all", "--", ...pathspec],
      "utf8",
    ),
  ).trim();
  const listed = String(
    gitOutput(
      repositoryRoot,
      [
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        ...pathspec,
      ],
      "utf8",
    ),
  ).split("\u0000").filter(Boolean).sort();
  const digest = createHash("sha256");
  for (const repositoryPath of listed) {
    const absolutePath = resolve(repositoryRoot, repositoryPath);
    const segment = relative(repositoryRoot, absolutePath);
    if (
      segment === "" ||
      segment === ".." ||
      segment.startsWith(`..${sep}`) ||
      isAbsolute(segment)
    ) {
      throw new Error("SOURCE_PATH_OUTSIDE_REPOSITORY");
    }
    const stat = lstatSync(absolutePath);
    const contents = stat.isSymbolicLink()
      ? Buffer.from(readlinkSync(absolutePath), "utf8")
      : readFileSync(absolutePath);
    digest.update(repositoryPath.replaceAll("\\", "/"));
    digest.update("\u0000");
    digest.update(contents);
    digest.update("\u0000");
  }
  return {
    commit,
    digest: digest.digest("hex"),
    clean: status.length === 0,
  } as ControlPlaneSourceIdentity;
}

export function resolveBaselineOutputPath(
  repositoryRootInput: string,
  outputInput: string,
): string {
  const repositoryRoot = resolve(repositoryRootInput);
  const evidenceRoot = resolve(
    repositoryRoot,
    "docs",
    "validation",
    "evidence",
    "orca-control-plane",
  );
  const outputPath = resolve(repositoryRoot, outputInput);
  const segment = relative(evidenceRoot, outputPath);
  if (
    segment === "" ||
    segment === ".." ||
    segment.startsWith(`..${sep}`) ||
    isAbsolute(segment) ||
    !outputPath.endsWith(".json")
  ) {
    throw new Error("BASELINE_EVIDENCE_OUTPUT_OUTSIDE_ALLOWED_ROOT");
  }
  return outputPath;
}

const OrcaStatusSchema = z.object({
  ok: z.literal(true),
  result: z.object({
    app: z.object({ running: z.boolean() }),
    runtime: z.object({
      state: z.string().min(1),
      reachable: z.boolean(),
    }),
    graph: z.object({ state: z.string().min(1) }),
  }),
});

function commandSucceeded(result: CommandResult): boolean {
  return result.exitCode === 0 && !result.timedOut && result.spawnError == null;
}

function commandHash(result: CommandResult, projection?: unknown): string {
  const output = projection === undefined
    ? `${result.stdout}\n${result.stderr}`.replace(/\r\n/gu, "\n").trim()
    : JSON.stringify(canonicalize(projection));
  return sha256(redact(output));
}

function parseVersion(result: CommandResult, product: "node" | "git" | "orca" | "codex"):
  string | null {
  if (!commandSucceeded(result)) return null;
  const normalized = redact(result.stdout).trim().split(/\r?\n/u, 1)[0] ?? "";
  const pattern = product === "node"
    ? /^v?([0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?)$/u
    : product === "git"
      ? /^git version ([0-9]+(?:\.[0-9]+){1,3}(?:\.[A-Za-z0-9.-]+)?)$/iu
      : /\b([0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?)\b/u;
  return pattern.exec(normalized)?.[1] ?? null;
}

function helpHas(result: CommandResult, word: string): boolean {
  return commandSucceeded(result)
    && new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "iu")
      .test(result.stdout);
}

export async function collectOrcaControlPlaneBaseline(
  options: OrcaControlPlaneBaselineCollectionOptions,
): Promise<OrcaControlPlaneBaseline> {
  const run = async (
    executable: string,
    args: readonly string[],
  ): Promise<CommandResult> => await options.runner.run({
    executable,
    args,
    cwd: options.cwd,
    timeoutMs: 5_000,
  });

  const [
    nodeVersion,
    gitVersion,
    orcaVersion,
    orcaStatus,
    orcaRepoHelp,
    orcaWorktreeHelp,
    orcaWorktreeCreateHelp,
    orcaTerminalHelp,
    codexVersion,
    codexLogin,
  ] = await Promise.all([
    run("node", ["--version"]),
    run("git", ["--version"]),
    run(options.orcaExecutable, ["--version"]),
    run(options.orcaExecutable, ["status", "--json"]),
    run(options.orcaExecutable, ["repo", "--help"]),
    run(options.orcaExecutable, ["worktree", "--help"]),
    run(options.orcaExecutable, ["worktree", "create", "--help"]),
    run(options.orcaExecutable, ["terminal", "--help"]),
    run(options.codexExecutable, ["--version"]),
    run(options.codexExecutable, ["login", "status"]),
  ]);

  let statusJson: unknown;
  if (commandSucceeded(orcaStatus)) {
    try {
      statusJson = JSON.parse(orcaStatus.stdout) as unknown;
    } catch {
      statusJson = undefined;
    }
  }
  const parsedStatus = statusJson === undefined
    ? null
    : OrcaStatusSchema.safeParse(statusJson);
  const statusProjection = parsedStatus?.success === true
    ? {
        app: { running: parsedStatus.data.result.app.running },
        runtime: {
          reachable: parsedStatus.data.result.runtime.reachable,
          state: parsedStatus.data.result.runtime.state,
        },
        graph: { state: parsedStatus.data.result.graph.state },
      }
    : { parseStatus: "invalid" };
  const statusReceiptHash = commandHash(orcaStatus, statusProjection);
  const runtimeReady = parsedStatus?.success === true
    && parsedStatus.data.result.app.running
    && parsedStatus.data.result.runtime.reachable
    && parsedStatus.data.result.runtime.state.toLowerCase() === "ready";

  const commandInputs = [
    ["node_version", "node", ["--version"], nodeVersion],
    ["git_version", "git", ["--version"], gitVersion],
    ["orca_version", "orca", ["--version"], orcaVersion],
    ["orca_status", "orca", ["status", "--json"], orcaStatus],
    ["orca_repo_help", "orca", ["repo", "--help"], orcaRepoHelp],
    ["orca_worktree_help", "orca", ["worktree", "--help"], orcaWorktreeHelp],
    [
      "orca_worktree_create_help",
      "orca",
      ["worktree", "create", "--help"],
      orcaWorktreeCreateHelp,
    ],
    ["orca_terminal_help", "orca", ["terminal", "--help"], orcaTerminalHelp],
    ["codex_version", "codex", ["--version"], codexVersion],
    ["codex_login_status", "codex", ["login", "status"], codexLogin],
  ] as const;
  const commandReceipts = commandInputs.map(
    ([operation, executable, args, result]) => ({
      operation,
      executable,
      args: [...args],
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      outputHash: operation === "orca_status"
        ? statusReceiptHash
        : commandHash(result),
    }),
  );

  const orcaDetected = commandSucceeded(orcaStatus);
  const codexDetected = commandSucceeded(codexVersion);
  const detectedInterface = (
    operation: string,
    detected: boolean,
    result: CommandResult,
  ) => ({
    operation,
    status: detected ? ("DETECTED" as const) : ("NOT_PROVEN" as const),
    receiptHash: commandHash(result),
  });

  const generatedAt = options.now().toISOString();
  return createOrcaControlPlaneBaseline({
    generatedAt,
    timeboxStartedAt: generatedAt,
    source: options.source,
    host: options.host,
    tools: [
      {
        id: "node",
        availability: commandSucceeded(nodeVersion) ? "DETECTED" : "BLOCKED",
        version: parseVersion(nodeVersion, "node"),
        authentication: "DETECTED",
        authenticationRequired: false,
      },
      {
        id: "git",
        availability: commandSucceeded(gitVersion) ? "DETECTED" : "BLOCKED",
        version: parseVersion(gitVersion, "git"),
        authentication: "DETECTED",
        authenticationRequired: false,
      },
      {
        id: "orca",
        availability: orcaDetected ? "DETECTED" : "BLOCKED",
        version: parseVersion(orcaVersion, "orca"),
        authentication: "NOT_PROVEN",
        authenticationRequired: true,
      },
      {
        id: "codex",
        availability: codexDetected ? "DETECTED" : "BLOCKED",
        version: parseVersion(codexVersion, "codex"),
        authentication: commandSucceeded(codexLogin)
          ? "DETECTED"
          : codexDetected ? "NOT_PROVEN" : "BLOCKED",
        authenticationRequired: true,
      },
    ],
    publicInterfaces: [
      detectedInterface("status", orcaDetected, orcaStatus),
      detectedInterface("repo_add", helpHas(orcaRepoHelp, "add"), orcaRepoHelp),
      detectedInterface(
        "repo_remove",
        helpHas(orcaRepoHelp, "remove") || helpHas(orcaRepoHelp, "rm"),
        orcaRepoHelp,
      ),
      detectedInterface(
        "worktree_create",
        helpHas(orcaWorktreeHelp, "create"),
        orcaWorktreeHelp,
      ),
      detectedInterface(
        "worktree_remove",
        helpHas(orcaWorktreeHelp, "remove") || helpHas(orcaWorktreeHelp, "rm"),
        orcaWorktreeHelp,
      ),
      {
        operation: "workspace_attach_existing",
        status: "NOT_PROVEN",
        receiptHash: commandHash(orcaWorktreeCreateHelp),
      },
      ...(["create", "list", "send", "read", "wait", "close"] as const).map(
        (operation) => detectedInterface(
          `terminal_${operation}`,
          helpHas(orcaTerminalHelp, operation),
          orcaTerminalHelp,
        ),
      ),
    ],
    capabilities: [
      {
        id: "discover_runtime",
        status: runtimeReady ? "PASS" : orcaDetected ? "NOT_PROVEN" : "BLOCKED",
        reason: runtimeReady
          ? "status_json_reports_running_reachable_runtime"
          : orcaDetected
            ? "status_json_does_not_prove_running_reachable_runtime"
            : "orca_status_unavailable",
        receiptHash: runtimeReady ? statusReceiptHash : null,
      },
      {
        id: "fixed_version",
        status: parseVersion(orcaVersion, "orca") === null
          ? "NOT_PROVEN"
          : "PASS",
        reason: parseVersion(orcaVersion, "orca") === null
          ? "orca_version_not_observed"
          : "orca_version_observed_from_public_cli",
        receiptHash: parseVersion(orcaVersion, "orca") === null
          ? null
          : commandHash(orcaVersion),
      },
      {
        id: "workspace_attach_existing",
        status: "NOT_PROVEN",
        reason: "mutating_temporary_fixture_not_run",
        receiptHash: null,
      },
      {
        id: "resource_cleanup",
        status: "NOT_PROVEN",
        reason: "cleanup_not_executed_in_task0_inventory",
        receiptHash: null,
      },
      {
        id: "security_defaults",
        status: "NOT_PROVEN",
        reason: "manual_fail_closed_configuration_not_yet_receipted",
        receiptHash: null,
      },
    ],
    commandReceipts,
  });
}

function parseOutputArgument(argv: readonly string[]): string {
  const index = argv.indexOf("--output");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      "USAGE: --output docs/validation/evidence/orca-control-plane/<file>.json",
    );
  }
  return value;
}

function writeBaselineEvidenceAtomic(outputPath: string, serialized: string): void {
  if (existsSync(outputPath)) {
    throw new Error("BASELINE_EVIDENCE_ALREADY_EXISTS");
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, serialized, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    renameSync(temporaryPath, outputPath);
  } catch (error) {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw new Error("BASELINE_EVIDENCE_WRITE_FAILED", { cause: error });
  }
}

async function main(): Promise<void> {
  const repositoryRoot = process.cwd();
  const outputPath = resolveBaselineOutputPath(
    repositoryRoot,
    parseOutputArgument(process.argv.slice(2)),
  );
  const source = inspectControlPlaneSource({
    cwd: repositoryRoot,
    pathspec: CONTROL_PLANE_SOURCE_PATHSPEC,
  });
  if (!source.clean) throw new Error("CONTROL_PLANE_SOURCE_NOT_CLEAN");

  const evidence = await collectOrcaControlPlaneBaseline({
    runner: new NodeCommandRunner(),
    cwd: repositoryRoot,
    orcaExecutable: process.env.ORCA_CLI_COMMAND?.trim() || "orca",
    codexExecutable: process.env.CODEX_CLI_COMMAND?.trim() || "codex",
    now: () => new Date(),
    source,
    host: {
      platform: process.platform,
      architecture: arch(),
      release: release(),
    },
  });
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  assertSafeEvidence(serialized);
  writeBaselineEvidenceAtomic(outputPath, serialized);
  const states = evidence.tools
    .map((tool) => `${tool.id}=${tool.availability}/${tool.authentication}`)
    .join(",");
  process.stdout.write(
    `Orca control-plane baseline: verdict=${evidence.providerVerdict} tools=${states}\n`,
  );
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  resolve(entryPoint) === resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Orca control-plane baseline failed: ${redact(message)}\n`);
    process.exitCode = 1;
  });
}
