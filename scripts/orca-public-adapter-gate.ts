import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
import {
  CONTROL_PLANE_SOURCE_PATHSPEC,
  OrcaControlPlaneBaselineSchema,
  inspectControlPlaneSource,
  prepareBaselineEvidenceOutput,
} from "./orca-control-plane-baseline.js";

const SHA256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const SourceIdentitySchema = z.strictObject({
  commit: z.string().regex(/^[a-f0-9]{40}$/u),
  digest: SHA256Schema,
  clean: z.literal(true),
});
const BaselineReferenceSchema = z.strictObject({
  path: z.literal(
    "docs/validation/evidence/orca-control-plane/baseline.json",
  ),
  sha256: SHA256Schema,
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  sourceDigest: SHA256Schema,
  timeboxStartedAt: z.iso.datetime(),
  timeboxDeadlineAt: z.iso.datetime(),
});
const CommandReceiptSchema = z.strictObject({
  operation: z.enum([
    "status",
    "repo_help",
    "repo_add_help",
    "worktree_help",
    "worktree_create_help",
    "worktree_set_help",
    "worktree_rm_help",
  ]),
  args: z.array(z.string().min(1).max(128)).min(2).max(3),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  outcome: z.enum(["success", "exit_nonzero", "timed_out", "spawn_error"]),
  outputHash: SHA256Schema,
});
const CapabilityReceiptSchema = z.strictObject({
  id: z.enum([
    "fixed_version",
    "workspace_attach_existing",
    "resource_cleanup",
    "permission_argument_gate",
    "security_defaults",
  ]),
  status: z.enum(["PASS", "BLOCKED", "NOT_PROVEN", "CONTRACT_ONLY"]),
  reason: z.string().min(1).max(256),
  receiptHash: SHA256Schema.nullable(),
});

export const OrcaPublicAdapterGateSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    evidenceType: z.literal("orca_public_adapter_gate"),
    generatedAt: z.iso.datetime(),
    generator: z.strictObject({
      name: z.literal("hunter-orca-public-adapter-gate"),
      version: z.literal("0.1.0"),
    }),
    source: SourceIdentitySchema,
    baseline: BaselineReferenceSchema,
    runtime: z.strictObject({
      availability: z.enum(["DETECTED", "BLOCKED", "NOT_PROVEN"]),
      version: z.string().regex(/^[0-9]+(?:\.[0-9]+){1,3}$/u).nullable(),
    }),
    publicSurface: z.strictObject({
      exactExistingWorktreeAttachDetected: z.boolean(),
      nonDestructiveDeregisterDetected: z.boolean(),
      repoRemoveCommandDetected: z.boolean(),
      worktreeCreateCreatesNewCheckout: z.boolean(),
      worktreeRemoveDeletesGitWorktree: z.boolean(),
      worktreeSetOnlyUpdatesMetadata: z.boolean(),
    }),
    commandReceipts: z.tuple([
      CommandReceiptSchema,
      CommandReceiptSchema,
      CommandReceiptSchema,
      CommandReceiptSchema,
      CommandReceiptSchema,
      CommandReceiptSchema,
      CommandReceiptSchema,
    ]),
    capabilities: z.tuple([
      CapabilityReceiptSchema,
      CapabilityReceiptSchema,
      CapabilityReceiptSchema,
      CapabilityReceiptSchema,
      CapabilityReceiptSchema,
    ]),
    budgetUsage: z.strictObject({
      realAttempts: z.literal(0),
      realSessions: z.literal(0),
      sends: z.literal(0),
      additionalPaidBudgetUsd: z.literal(0),
    }),
    cleanup: z.strictObject({
      status: z.literal("NOT_REQUIRED"),
      reason: z.literal("no_provider_resource_created"),
    }),
    subsequentTasks: z.tuple([
      z.strictObject({ task: z.literal(2), status: z.literal("NOT_RUN") }),
      z.strictObject({ task: z.literal(3), status: z.literal("NOT_RUN") }),
      z.strictObject({ task: z.literal(4), status: z.literal("NOT_RUN") }),
      z.strictObject({ task: z.literal(5), status: z.literal("NOT_RUN") }),
      z.strictObject({ task: z.literal(6), status: z.literal("NOT_RUN") }),
      z.strictObject({ task: z.literal(7), status: z.literal("NOT_RUN") }),
      z.strictObject({ task: z.literal(8), status: z.literal("NOT_RUN") }),
    ]),
    providerVerdict: z.enum(["BLOCKED", "NOT_PROVEN"]),
    proofScope: z.literal("local_public_cli_help_inventory"),
    mutationAttempted: z.literal(false),
    redaction: z.strictObject({
      applied: z.literal(true),
      schemaVersion: z.literal(1),
    }),
    contentFingerprint: SHA256Schema,
  })
  .superRefine((evidence, context) => {
    const ids = evidence.capabilities.map(({ id }) => id);
    if (
      new Set(ids).size !== ids.length ||
      ids.join(",") !== [
        "fixed_version",
        "workspace_attach_existing",
        "resource_cleanup",
        "permission_argument_gate",
        "security_defaults",
      ].join(",")
    ) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "CAPABILITY_INVENTORY_MISMATCH",
      });
    }

    const attach = evidence.capabilities[1];
    const cleanup = evidence.capabilities[2];
    if (
      (!evidence.publicSurface.exactExistingWorktreeAttachDetected
        && attach.status !== "BLOCKED") ||
      (!evidence.publicSurface.nonDestructiveDeregisterDetected
        && cleanup.status !== "BLOCKED")
    ) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "PUBLIC_SURFACE_BLOCK_NOT_REFLECTED",
      });
    }
    if (
      (attach.status === "BLOCKED" || cleanup.status === "BLOCKED")
      && evidence.providerVerdict !== "BLOCKED"
    ) {
      context.addIssue({
        code: "custom",
        path: ["providerVerdict"],
        message: "BLOCKED_CAPABILITY_REQUIRES_BLOCKED_VERDICT",
      });
    }

    const { contentFingerprint, ...withoutFingerprint } = evidence;
    const expected = sha256(
      JSON.stringify(canonicalize({
        ...withoutFingerprint,
        generatedAt: undefined,
      })),
    );
    if (contentFingerprint !== expected) {
      context.addIssue({
        code: "custom",
        path: ["contentFingerprint"],
        message: "CONTENT_FINGERPRINT_MISMATCH",
      });
    }
  });

export type OrcaPublicAdapterGate = z.infer<
  typeof OrcaPublicAdapterGateSchema
>;

export interface OrcaPublicAdapterGateInput {
  readonly runner: CommandRunner;
  readonly cwd: string;
  readonly orcaExecutable: string;
  readonly generatedAt: string;
  readonly source: z.infer<typeof SourceIdentitySchema>;
  readonly baseline: z.infer<typeof BaselineReferenceSchema>;
}

function sha256(value: string | Buffer): string {
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

function commandSucceeded(result: CommandResult): boolean {
  return result.exitCode === 0 && !result.timedOut && result.spawnError === null;
}

function commandHash(result: CommandResult, projection?: unknown): string {
  const output = projection === undefined
    ? `${result.stdout}\n${result.stderr}`.replace(/\r\n/gu, "\n").trim()
    : JSON.stringify(canonicalize(projection));
  return sha256(redact(output));
}

function listedCommand(help: string, names: readonly string[]): boolean {
  return names.some((name) =>
    new RegExp(`^\\s{2}${name}\\s+`, "mu").test(help)
  );
}

function resultOutcome(
  result: CommandResult,
): "success" | "exit_nonzero" | "timed_out" | "spawn_error" {
  if (result.timedOut) return "timed_out";
  if (result.spawnError !== null) return "spawn_error";
  return result.exitCode === 0 ? "success" : "exit_nonzero";
}

export async function collectOrcaPublicAdapterGate(
  input: OrcaPublicAdapterGateInput,
): Promise<OrcaPublicAdapterGate> {
  const run = async (
    args: readonly string[],
    timeoutMs = 10_000,
  ): Promise<CommandResult> => await input.runner.run({
    executable: input.orcaExecutable,
    args,
    cwd: input.cwd,
    timeoutMs,
  });

  // Orca runtime access may serialize internally. Keep the inventory ordered.
  const status = await run(["status", "--json"], 15_000);
  const repoHelp = await run(["repo", "--help"]);
  const repoAddHelp = await run(["repo", "add", "--help"]);
  const worktreeHelp = await run(["worktree", "--help"]);
  const worktreeCreateHelp = await run(["worktree", "create", "--help"]);
  const worktreeSetHelp = await run(["worktree", "set", "--help"]);
  const worktreeRmHelp = await run(["worktree", "rm", "--help"]);

  const statusSchema = z.object({
    ok: z.literal(true),
    result: z.object({
      app: z.object({ running: z.boolean() }),
      runtime: z.object({
        state: z.string(),
        reachable: z.boolean(),
        appVersion: z.string().optional(),
      }),
    }),
  });
  let statusProjection: unknown = { parseStatus: "invalid" };
  let version: string | null = null;
  if (commandSucceeded(status)) {
    try {
      const parsed = statusSchema.safeParse(JSON.parse(status.stdout) as unknown);
      if (parsed.success) {
        statusProjection = {
          app: { running: parsed.data.result.app.running },
          runtime: {
            state: parsed.data.result.runtime.state,
            reachable: parsed.data.result.runtime.reachable,
            appVersion: parsed.data.result.runtime.appVersion,
          },
        };
        version = /^([0-9]+(?:\.[0-9]+){1,3})$/u
          .exec(parsed.data.result.runtime.appVersion ?? "")?.[1] ?? null;
      }
    } catch {
      statusProjection = { parseStatus: "invalid" };
    }
  }

  const repoRemoveCommandDetected =
    commandSucceeded(repoHelp)
    && listedCommand(repoHelp.stdout, ["remove", "rm", "delete"]);
  const exactExistingWorktreeAttachDetected =
    commandSucceeded(worktreeHelp)
    && listedCommand(worktreeHelp.stdout, [
      "attach",
      "import",
      "register",
    ]);
  const worktreeCreateCreatesNewCheckout =
    commandSucceeded(worktreeCreateHelp)
    && /\bcreates? a new checkout\b/iu.test(worktreeCreateHelp.stdout);
  const worktreeSetOnlyUpdatesMetadata =
    commandSucceeded(worktreeSetHelp)
    && /\bupdate Orca metadata for a worktree\b/iu.test(
      worktreeSetHelp.stdout,
    );
  const worktreeRemoveDeletesGitWorktree =
    commandSucceeded(worktreeRmHelp)
    && /\bfrom Orca and git\b/iu.test(worktreeRmHelp.stdout);
  const nonDestructiveDeregisterDetected =
    repoRemoveCommandDetected ||
    (
      commandSucceeded(worktreeHelp)
      && listedCommand(worktreeHelp.stdout, ["detach", "unregister"])
    );

  const attachInventoryConclusive =
    commandSucceeded(worktreeHelp)
    && commandSucceeded(worktreeCreateHelp)
    && commandSucceeded(worktreeSetHelp);
  const cleanupInventoryConclusive =
    commandSucceeded(repoHelp)
    && commandSucceeded(worktreeHelp)
    && commandSucceeded(worktreeRmHelp);
  const attachStatus =
    exactExistingWorktreeAttachDetected
      ? "NOT_PROVEN"
      : attachInventoryConclusive ? "BLOCKED" : "NOT_PROVEN";
  const cleanupStatus =
    nonDestructiveDeregisterDetected
      ? "NOT_PROVEN"
      : cleanupInventoryConclusive ? "BLOCKED" : "NOT_PROVEN";

  const commandInputs = [
    ["status", ["status", "--json"], status, statusProjection],
    ["repo_help", ["repo", "--help"], repoHelp, undefined],
    ["repo_add_help", ["repo", "add", "--help"], repoAddHelp, undefined],
    ["worktree_help", ["worktree", "--help"], worktreeHelp, undefined],
    [
      "worktree_create_help",
      ["worktree", "create", "--help"],
      worktreeCreateHelp,
      undefined,
    ],
    [
      "worktree_set_help",
      ["worktree", "set", "--help"],
      worktreeSetHelp,
      undefined,
    ],
    [
      "worktree_rm_help",
      ["worktree", "rm", "--help"],
      worktreeRmHelp,
      undefined,
    ],
  ] as const;
  const commandReceipts = commandInputs.map(
    ([operation, args, result, projection]) => ({
      operation,
      args: [...args],
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      outcome: resultOutcome(result),
      outputHash: commandHash(result, projection),
    }),
  ) as OrcaPublicAdapterGate["commandReceipts"];
  const statusHash = commandReceipts[0].outputHash;

  const withoutFingerprint = {
    schemaVersion: 1 as const,
    evidenceType: "orca_public_adapter_gate" as const,
    generatedAt: input.generatedAt,
    generator: {
      name: "hunter-orca-public-adapter-gate" as const,
      version: "0.1.0" as const,
    },
    source: input.source,
    baseline: input.baseline,
    runtime: {
      availability: commandSucceeded(status)
        ? ("DETECTED" as const)
        : ("BLOCKED" as const),
      version,
    },
    publicSurface: {
      exactExistingWorktreeAttachDetected,
      nonDestructiveDeregisterDetected,
      repoRemoveCommandDetected,
      worktreeCreateCreatesNewCheckout,
      worktreeRemoveDeletesGitWorktree,
      worktreeSetOnlyUpdatesMetadata,
    },
    commandReceipts,
    capabilities: [
      {
        id: "fixed_version" as const,
        status: version === null ? ("NOT_PROVEN" as const) : ("PASS" as const),
        reason: version === null
          ? "status_json_did_not_return_numeric_app_version"
          : "status_json_returned_numeric_app_version",
        receiptHash: version === null ? null : statusHash,
      },
      {
        id: "workspace_attach_existing" as const,
        status: attachStatus,
        reason: attachStatus === "BLOCKED"
          ? "public_cli_only_creates_new_checkout_or_updates_managed_metadata"
          : "public_attach_operation_not_measured",
        receiptHash: null,
      },
      {
        id: "resource_cleanup" as const,
        status: cleanupStatus,
        reason: cleanupStatus === "BLOCKED"
          ? "public_cli_has_no_nondestructive_deregister_and_rm_deletes_git_worktree"
          : "nondestructive_deregister_not_measured",
        receiptHash: null,
      },
      {
        id: "permission_argument_gate" as const,
        status: "CONTRACT_ONLY" as const,
        reason: "adapter_rejects_forbidden_permission_flags_in_local_tests",
        receiptHash: null,
      },
      {
        id: "security_defaults" as const,
        status: "NOT_PROVEN" as const,
        reason: "real_manual_fail_closed_configuration_not_executed",
        receiptHash: null,
      },
    ],
    budgetUsage: {
      realAttempts: 0 as const,
      realSessions: 0 as const,
      sends: 0 as const,
      additionalPaidBudgetUsd: 0 as const,
    },
    cleanup: {
      status: "NOT_REQUIRED" as const,
      reason: "no_provider_resource_created" as const,
    },
    subsequentTasks: [
      { task: 2 as const, status: "NOT_RUN" as const },
      { task: 3 as const, status: "NOT_RUN" as const },
      { task: 4 as const, status: "NOT_RUN" as const },
      { task: 5 as const, status: "NOT_RUN" as const },
      { task: 6 as const, status: "NOT_RUN" as const },
      { task: 7 as const, status: "NOT_RUN" as const },
      { task: 8 as const, status: "NOT_RUN" as const },
    ],
    providerVerdict:
      attachStatus === "BLOCKED" || cleanupStatus === "BLOCKED"
        ? ("BLOCKED" as const)
        : ("NOT_PROVEN" as const),
    proofScope: "local_public_cli_help_inventory" as const,
    mutationAttempted: false as const,
    redaction: { applied: true as const, schemaVersion: 1 as const },
  };
  const contentFingerprint = sha256(
    JSON.stringify(canonicalize({
      ...withoutFingerprint,
      generatedAt: undefined,
    })),
  );
  return OrcaPublicAdapterGateSchema.parse({
    ...withoutFingerprint,
    contentFingerprint,
  });
}

function parseOutputArgument(argv: readonly string[]): string {
  const index = argv.indexOf("--output");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      "USAGE: --output docs/validation/evidence/orca-control-plane/public-adapter-gate.json",
    );
  }
  return value;
}

function resolveOutputPath(repositoryRoot: string, outputInput: string): string {
  const root = resolve(
    repositoryRoot,
    "docs",
    "validation",
    "evidence",
    "orca-control-plane",
  );
  const output = resolve(repositoryRoot, outputInput);
  const segment = relative(root, output);
  if (
    segment !== "public-adapter-gate.json" ||
    segment.startsWith(`..${sep}`) ||
    isAbsolute(segment)
  ) {
    throw new Error("ORCA_PUBLIC_ADAPTER_EVIDENCE_PATH_INVALID");
  }
  return output;
}

function writeAtomic(outputPath: string, serialized: string): void {
  if (existsSync(outputPath)) {
    throw new Error("ORCA_PUBLIC_ADAPTER_EVIDENCE_ALREADY_EXISTS");
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
    throw new Error("ORCA_PUBLIC_ADAPTER_EVIDENCE_WRITE_FAILED", {
      cause: error,
    });
  }
}

async function main(): Promise<void> {
  const repositoryRoot = process.cwd();
  const outputPath = resolveOutputPath(
    repositoryRoot,
    parseOutputArgument(process.argv.slice(2)),
  );
  const sourceInspection = inspectControlPlaneSource({
    cwd: repositoryRoot,
    pathspec: CONTROL_PLANE_SOURCE_PATHSPEC,
  });
  if (!sourceInspection.clean) throw new Error("CONTROL_PLANE_SOURCE_NOT_CLEAN");
  const source = SourceIdentitySchema.parse(sourceInspection);
  const baselinePath = resolve(
    repositoryRoot,
    "docs",
    "validation",
    "evidence",
    "orca-control-plane",
    "baseline.json",
  );
  const baselineContents = readFileSync(baselinePath);
  assertSafeEvidence(baselineContents.toString("utf8"));
  const baseline = OrcaControlPlaneBaselineSchema.parse(
    JSON.parse(baselineContents.toString("utf8")) as unknown,
  );
  const generatedAt = new Date().toISOString();
  const evidence = await collectOrcaPublicAdapterGate({
    runner: new NodeCommandRunner(),
    cwd: repositoryRoot,
    orcaExecutable: process.env.ORCA_CLI_COMMAND?.trim() || "orca",
    generatedAt,
    source,
    baseline: {
      path: "docs/validation/evidence/orca-control-plane/baseline.json",
      sha256: sha256(baselineContents),
      sourceCommit: baseline.source.commit,
      sourceDigest: baseline.source.digest,
      timeboxStartedAt: baseline.timebox.startedAt,
      timeboxDeadlineAt: baseline.timebox.deadlineAt,
    },
  });
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  assertSafeEvidence(serialized);
  prepareBaselineEvidenceOutput(outputPath);
  writeAtomic(outputPath, serialized);
  process.stdout.write(
    `Orca public adapter gate: verdict=${evidence.providerVerdict} mutation=${evidence.mutationAttempted}\n`,
  );
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  resolve(entryPoint) === resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Orca public adapter gate failed: ${redact(message)}\n`);
    process.exitCode = 1;
  });
}
