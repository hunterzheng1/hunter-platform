import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { arch, release } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  NodeCommandRunner,
  assertSafeEvidence,
  redact,
  type CommandResult,
  type CommandRunner,
} from "@hunter/spike-testkit";
import { OrcaClient } from "./orca-client.js";

const CapabilityOutcomeSchema = z.enum(["PASS", "FAIL", "BLOCKED", "NOT_PROVEN"]);

const OrcaCommandReceiptSchema = z.strictObject({
  operation: z.enum([
    "status",
    "repo_help",
    "worktree_create_help",
    "terminal_create_help",
  ]),
  args: z.array(z.string()),
  cwdScope: z.literal("repository"),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  spawnError: z.string().nullable(),
  outputSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

const OrcaCapabilityReceiptSchema = z.strictObject({
  id: z.enum([
    "discover_runtime",
    "fixed_version",
    "workspace_create",
    "resource_cleanup",
    "terminal_launch",
    "terminal_observe",
    "terminal_interrupt",
    "restart_reconcile",
    "workspace_session_identity",
    "security_defaults",
    "mobile_pairing",
  ]),
  outcome: CapabilityOutcomeSchema,
  reason: z.string().min(1),
});

export const OrcaPreflightEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  evidenceType: z.literal("phase0_orca_windows_provider_preflight"),
  generatedAt: z.iso.datetime(),
  generator: z.strictObject({
    name: z.literal("hunter-phase0-orca-preflight"),
    version: z.literal("0.1.0"),
  }),
  host: z.strictObject({
    platform: z.string().min(1),
    architecture: z.string().min(1),
    release: z.string().min(1),
  }),
  provider: z.literal("orca"),
  candidateVersion: z.null(),
  providerVerdict: z.literal("NOT_PROVEN"),
  proofScope: z.literal("local_preflight_only"),
  mutationAttempted: z.literal(false),
  commands: z.array(OrcaCommandReceiptSchema),
  capabilities: z.array(OrcaCapabilityReceiptSchema),
  redaction: z.strictObject({
    applied: z.literal(true),
    schemaVersion: z.literal(1),
  }),
  contentFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type OrcaPreflightEvidence = z.infer<typeof OrcaPreflightEvidenceSchema>;

export interface OrcaPreflightOptions {
  readonly runner: CommandRunner;
  readonly executable: string;
  readonly cwd: string;
  readonly now: () => Date;
  readonly host: {
    readonly platform: NodeJS.Platform | string;
    readonly architecture: string;
    readonly release: string;
  };
}

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

function commandReceipt(
  operation: z.infer<typeof OrcaCommandReceiptSchema>["operation"],
  result: CommandResult,
  outputForHash: string = result.stdout + result.stderr,
): z.infer<typeof OrcaCommandReceiptSchema> {
  const normalizedOutput = redact(outputForHash).replace(/\r\n/gu, "\n").trim();
  return {
    operation,
    args: [...result.args],
    cwdScope: "repository",
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    spawnError: result.spawnError ?? null,
    outputSha256: sha256(normalizedOutput),
  };
}

async function runHelp(
  options: OrcaPreflightOptions,
  args: readonly string[],
): Promise<CommandResult> {
  return await options.runner.run({
    executable: options.executable,
    args,
    cwd: options.cwd,
    timeoutMs: 5_000,
  });
}

function commandSucceeded(result: CommandResult): boolean {
  return result.exitCode === 0 && !result.timedOut && result.spawnError == null;
}

export async function createOrcaPreflightEvidence(
  options: OrcaPreflightOptions,
): Promise<OrcaPreflightEvidence> {
  const client = new OrcaClient({
    runner: options.runner,
    executable: options.executable,
    cwd: options.cwd,
    timeoutMs: 5_000,
  });
  const status = await client.status();
  const repoHelp = await runHelp(options, ["repo", "--help"]);
  const worktreeHelp = await runHelp(options, ["worktree", "create", "--help"]);
  const terminalHelp = await runHelp(options, ["terminal", "create", "--help"]);

  const runtimeReady =
    status.known.app.running &&
    status.known.runtime.reachable &&
    status.known.runtime.state.toLowerCase() === "ready";
  const worktreeDestinationSupported =
    commandSucceeded(worktreeHelp) &&
    /(?:^|\s)--(?:path|destination|checkout-path|worktree-path)(?:\s|$)/u.test(
      worktreeHelp.stdout,
    );
  const repoRemovalSupported =
    commandSucceeded(repoHelp) && /\b(?:remove|rm|delete)\b/u.test(repoHelp.stdout);
  const generatedAt = options.now().toISOString();
  const withoutFingerprint = {
    schemaVersion: 1 as const,
    evidenceType: "phase0_orca_windows_provider_preflight" as const,
    generatedAt,
    generator: {
      name: "hunter-phase0-orca-preflight" as const,
      version: "0.1.0" as const,
    },
    host: options.host,
    provider: "orca" as const,
    candidateVersion: null,
    providerVerdict: "NOT_PROVEN" as const,
    proofScope: "local_preflight_only" as const,
    mutationAttempted: false as const,
    commands: [
      commandReceipt(
        "status",
        status.command,
        JSON.stringify({
          app: {
            running: status.known.app.running,
            desktopWindowStatus: status.known.app.desktopWindowStatus,
          },
          runtime: {
            state: status.known.runtime.state,
            reachable: status.known.runtime.reachable,
          },
          graph: { state: status.known.graph.state },
        }),
      ),
      commandReceipt("repo_help", repoHelp),
      commandReceipt("worktree_create_help", worktreeHelp),
      commandReceipt("terminal_create_help", terminalHelp),
    ],
    capabilities: [
      {
        id: "discover_runtime" as const,
        outcome: runtimeReady ? ("PASS" as const) : ("FAIL" as const),
        reason: runtimeReady
          ? "status_json_reports_running_reachable_runtime"
          : "status_json_does_not_report_running_reachable_runtime",
      },
      {
        id: "fixed_version" as const,
        outcome: "NOT_PROVEN" as const,
        reason: "public_cli_did_not_return_a_numeric_version",
      },
      {
        id: "workspace_create" as const,
        outcome: "NOT_PROVEN" as const,
        reason: worktreeDestinationSupported
          ? "mutating_scenario_not_executed_by_preflight"
          : "public_cli_has_no_fixture_destination_flag",
      },
      {
        id: "resource_cleanup" as const,
        outcome: "NOT_PROVEN" as const,
        reason: repoRemovalSupported
          ? "cleanup_command_not_executed_by_preflight"
          : "public_cli_has_no_repo_remove_command",
      },
      {
        id: "terminal_launch" as const,
        outcome: "NOT_PROVEN" as const,
        reason: "workspace_fixture_confinement_not_proven",
      },
      {
        id: "terminal_observe" as const,
        outcome: "NOT_PROVEN" as const,
        reason: "terminal_not_launched",
      },
      {
        id: "terminal_interrupt" as const,
        outcome: "NOT_PROVEN" as const,
        reason: "terminal_not_launched",
      },
      {
        id: "restart_reconcile" as const,
        outcome: "NOT_PROVEN" as const,
        reason: "native_session_not_created",
      },
      {
        id: "workspace_session_identity" as const,
        outcome: "NOT_PROVEN" as const,
        reason: "native_session_not_created",
      },
      {
        id: "security_defaults" as const,
        outcome: "NOT_PROVEN" as const,
        reason: "settings_not_available_as_versioned_noninteractive_receipt",
      },
      {
        id: "mobile_pairing" as const,
        outcome: "NOT_PROVEN" as const,
        reason: "remote_pairing_not_enabled_or_tested",
      },
    ],
    redaction: { applied: true as const, schemaVersion: 1 as const },
  };
  const fingerprintProjection = {
    ...withoutFingerprint,
    generatedAt: undefined,
  };

  return OrcaPreflightEvidenceSchema.parse({
    ...withoutFingerprint,
    contentFingerprint: sha256(JSON.stringify(canonicalize(fingerprintProjection))),
  });
}

function parseOutputArgument(argv: readonly string[]): string {
  const index = argv.indexOf("--output");
  const output = index >= 0 ? argv[index + 1] : undefined;
  if (output === undefined || output.trim() === "") {
    throw new Error("USAGE: --output docs/validation/evidence/orca/<file>.json");
  }
  return output;
}

function assertEvidenceOutput(repositoryRoot: string, output: string): string {
  const evidenceRoot = resolve(repositoryRoot, "docs", "validation", "evidence", "orca");
  const outputPath = resolve(repositoryRoot, output);
  const segment = relative(evidenceRoot, outputPath);
  if (
    segment === "" ||
    segment === ".." ||
    segment.startsWith(`..${sep}`) ||
    !outputPath.endsWith(".json")
  ) {
    throw new Error("ORCA_EVIDENCE_OUTPUT_OUTSIDE_ALLOWED_ROOT");
  }
  return outputPath;
}

async function main(): Promise<void> {
  if (process.env.HUNTER_PHASE0_MUTATION !== "allowed") {
    throw new Error("HUNTER_PHASE0_MUTATION_MUST_EQUAL_ALLOWED");
  }
  const executable = process.env.ORCA_CLI_COMMAND?.trim();
  if (executable === undefined || executable === "") {
    throw new Error("ORCA_CLI_COMMAND_REQUIRED");
  }

  const repositoryRoot = process.cwd();
  const outputPath = assertEvidenceOutput(
    repositoryRoot,
    parseOutputArgument(process.argv.slice(2)),
  );
  const evidence = await createOrcaPreflightEvidence({
    runner: new NodeCommandRunner(),
    executable,
    cwd: repositoryRoot,
    now: () => new Date(),
    host: {
      platform: process.platform,
      architecture: arch(),
      release: release(),
    },
  });
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  assertSafeEvidence(serialized);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialized, "utf8");
  process.stdout.write(
    `Orca Phase 0 preflight: provider=${evidence.providerVerdict} mutationAttempted=${String(evidence.mutationAttempted)}\n`,
  );
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && resolve(entryPoint) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Orca Phase 0 preflight failed: ${redact(message)}\n`);
    process.exitCode = 1;
  });
}
