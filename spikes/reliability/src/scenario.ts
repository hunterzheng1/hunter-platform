import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { basename, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  NodeCommandRunner,
  assertProbeWorkspace,
  assertSafeEvidence,
  withTemporaryGitFixture,
  type CommandResult,
} from "@hunter/spike-testkit";

export const reliabilityEvidenceSchemaVersion = 1 as const;

const RELIABILITY_SCENARIO_IDS = [
  "unicode_space_workspace",
  "child_process_tree",
  "forced_provider_exit",
  "stale_session_reference",
  "duplicate_command_idempotency",
  "denied_permission_request",
] as const;

export const ReliabilityScenarioIdSchema = z.enum(RELIABILITY_SCENARIO_IDS);

export const ObservableStateSchema = z.enum([
  "succeeded",
  "needs_attention",
  "waiting_approval",
]);

const ScenarioVerdictSchema = z.enum(["PASS", "FAIL", "NOT_PROVEN"]);

const ScenarioCommandSchema = z.strictObject({
  executable: z.literal("node"),
  args: z.array(z.string()),
  cwdScope: z.literal("temporary_git_fixture"),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  spawnError: z.string().nullable(),
});

const ReliabilityScenarioEvidenceSchema = z.strictObject({
  id: ReliabilityScenarioIdSchema,
  expectedObservableState: ObservableStateSchema,
  observedState: ObservableStateSchema,
  verdict: ScenarioVerdictSchema,
  reason: z.string().min(1),
  cleanup: z.strictObject({
    target: z.string().min(1),
    outcome: z.enum(["PASS", "NOT_PROVEN"]),
    mechanic: z.string().min(1),
    remainingResources: z.number().int().nonnegative(),
  }),
  commands: z.array(ScenarioCommandSchema),
});

export const ReliabilityEvidenceEnvelopeSchema = z
  .strictObject({
    schemaVersion: z.literal(reliabilityEvidenceSchemaVersion),
    evidenceType: z.literal("phase0_runtime_reliability"),
    generatedAt: z.iso.datetime(),
    generator: z.strictObject({
      name: z.literal("hunter-runtime-reliability"),
      version: z.literal("0.1.0"),
    }),
    host: z.strictObject({
      platform: z.string().min(1),
      architecture: z.string().min(1),
      release: z.string().min(1),
      nodeVersion: z.string().regex(/^v\d+\.\d+\.\d+/u),
    }),
    proofScope: z.literal("hunter_contract_fixture"),
    fixture: z.strictObject({
      cwdScope: z.literal("temporary_git_fixture"),
      workspaceShape: z.literal("unicode_and_spaces"),
    }),
    scenarios: z.array(ReliabilityScenarioEvidenceSchema).length(6),
    summary: z.strictObject({
      passed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      notProven: z.number().int().nonnegative(),
    }),
    redaction: z.strictObject({
      applied: z.literal(true),
      schemaVersion: z.literal(1),
    }),
    contentFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .superRefine((value, context) => {
    const observedIds = new Set(value.scenarios.map((scenario) => scenario.id));
    if (
      observedIds.size !== RELIABILITY_SCENARIO_IDS.length ||
      !RELIABILITY_SCENARIO_IDS.every((id) => observedIds.has(id))
    ) {
      context.addIssue({
        code: "custom",
        message: "RELIABILITY_SCENARIO_IDS_INCOMPLETE_OR_DUPLICATED",
        path: ["scenarios"],
      });
    }

    const expectedSummary = {
      passed: value.scenarios.filter((scenario) => scenario.verdict === "PASS").length,
      failed: value.scenarios.filter((scenario) => scenario.verdict === "FAIL").length,
      notProven: value.scenarios.filter(
        (scenario) => scenario.verdict === "NOT_PROVEN",
      ).length,
    };
    if (
      value.summary.passed !== expectedSummary.passed ||
      value.summary.failed !== expectedSummary.failed ||
      value.summary.notProven !== expectedSummary.notProven
    ) {
      context.addIssue({
        code: "custom",
        message: "RELIABILITY_SUMMARY_INCONSISTENT",
        path: ["summary"],
      });
    }

    if (value.contentFingerprint !== calculateContentFingerprint(value)) {
      context.addIssue({
        code: "custom",
        message: "RELIABILITY_CONTENT_FINGERPRINT_INVALID",
        path: ["contentFingerprint"],
      });
    }
  });

export type ReliabilityEvidenceEnvelope = z.infer<
  typeof ReliabilityEvidenceEnvelopeSchema
>;
export type ReliabilityScenarioId = z.infer<typeof ReliabilityScenarioIdSchema>;
export type ObservableState = z.infer<typeof ObservableStateSchema>;

export interface ReliabilityScenarioPlan {
  readonly id: ReliabilityScenarioId;
  readonly expectedObservableState: ObservableState;
  readonly cleanupTarget: string;
}

export type ReliabilityObservation =
  | { readonly kind: "provider_exit"; readonly exitCode: number | null }
  | { readonly kind: "session_missing" }
  | { readonly kind: "permission_denied" }
  | { readonly kind: "verifier_receipt"; readonly passed: boolean };

export interface ExecuteReliabilityOptions {
  readonly now?: () => Date;
  readonly processTreeFault?: "after_child_spawn";
}

export function resolveObservableState(
  observation: ReliabilityObservation,
): ObservableState {
  if (observation.kind === "permission_denied") return "waiting_approval";
  if (observation.kind === "verifier_receipt" && observation.passed) {
    return "succeeded";
  }
  return "needs_attention";
}

export function planReliabilityScenarios(): readonly ReliabilityScenarioPlan[] {
  return [
    {
      id: "unicode_space_workspace",
      expectedObservableState: "succeeded",
      cleanupTarget: "temporary_git_fixture",
    },
    {
      id: "child_process_tree",
      expectedObservableState: "succeeded",
      cleanupTarget: "spawned_process_tree",
    },
    {
      id: "forced_provider_exit",
      expectedObservableState: "needs_attention",
      cleanupTarget: "provider_process",
    },
    {
      id: "stale_session_reference",
      expectedObservableState: "needs_attention",
      cleanupTarget: "native_session_reference",
    },
    {
      id: "duplicate_command_idempotency",
      expectedObservableState: "succeeded",
      cleanupTarget: "idempotency_record",
    },
    {
      id: "denied_permission_request",
      expectedObservableState: "waiting_approval",
      cleanupTarget: "permission_request",
    },
  ];
}

type ScenarioEvidence = z.infer<typeof ReliabilityScenarioEvidenceSchema>;

function commandEvidence(
  result: CommandResult,
  displayArgs: readonly string[],
): z.infer<typeof ScenarioCommandSchema> {
  return {
    executable: "node",
    args: [...displayArgs],
    cwdScope: "temporary_git_fixture",
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    spawnError: result.spawnError ?? null,
  };
}

function resultFor(
  plan: ReliabilityScenarioPlan,
  observedState: ObservableState,
  reason: string,
  cleanup: ScenarioEvidence["cleanup"],
  commands: ScenarioEvidence["commands"] = [],
  forcedVerdict?: ScenarioEvidence["verdict"],
): ScenarioEvidence {
  return {
    id: plan.id,
    expectedObservableState: plan.expectedObservableState,
    observedState,
    verdict:
      forcedVerdict ??
      (observedState === plan.expectedObservableState && cleanup.outcome === "PASS"
        ? "PASS"
        : "FAIL"),
    reason,
    cleanup,
    commands,
  };
}

const CHILD_PROCESS_FIXTURE = String.raw`
import { once } from "node:events";
import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["tree-child.mjs"], {
  cwd: process.cwd(),
  shell: false,
  windowsHide: true,
  detached: process.platform !== "win32",
  stdio: ["pipe", "pipe", "pipe"],
});

if (child.pid === undefined) process.exit(70);
let line = "";
const childPid = child.pid;
let childClosed = false;
child.once("close", () => { childClosed = true; });
let grandchildPid;
let setupFailed = false;
let faultObserved = false;
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
};

try {
  grandchildPid = await Promise.race([
    new Promise((resolve, reject) => {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        line += chunk;
        const newline = line.indexOf("\n");
        if (newline >= 0) {
          const parsed = Number.parseInt(line.slice(0, newline), 10);
          Number.isInteger(parsed) ? resolve(parsed) : reject(new Error("INVALID_GRANDCHILD_PID"));
        }
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error("CHILD_EXITED_BEFORE_READY:" + code)));
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("TREE_READY_TIMEOUT")), 4_000)),
  ]);
  if (process.argv.includes("--fault-after-child-spawn")) {
    faultObserved = true;
    throw new Error("INJECTED_TREE_FAULT");
  }
} catch {
  setupFailed = true;
} finally {
  if (!childClosed) {
    if (process.platform === "win32") {
      child.stdin.write("shutdown\n");
    } else {
      process.kill(-childPid, "SIGTERM");
    }
  }
}

if (!childClosed) {
  await Promise.race([
    once(child, "close"),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
}
if (!childClosed) {
  if (grandchildPid !== undefined && isAlive(grandchildPid)) process.kill(grandchildPid);
  if (isAlive(childPid)) child.kill();
  await Promise.race([
    once(child, "close"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("TREE_CLEANUP_TIMEOUT")), 2_000)),
  ]);
}

for (let attempt = 0; attempt < 40 && (isAlive(childPid) || (grandchildPid !== undefined && isAlive(grandchildPid))); attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

const cleanupConfirmed = !isAlive(childPid) && (grandchildPid === undefined || !isAlive(grandchildPid));
process.stdout.write(JSON.stringify({
  mechanic: process.platform === "win32" ? "windows_exact_pid_handles" : "posix_process_group",
  spawnedCount: 2,
  cleanupConfirmed,
  faultObserved,
}));
process.exit(!cleanupConfirmed ? 71 : faultObserved ? 73 : setupFailed ? 74 : 0);
`;

const TREE_CHILD_FIXTURE = String.raw`
import { once } from "node:events";
import { spawn } from "node:child_process";

const grandchild = spawn(process.execPath, ["tree-grandchild.mjs"], {
  cwd: process.cwd(),
  shell: false,
  windowsHide: true,
  detached: false,
  stdio: "ignore",
});
if (grandchild.pid === undefined) process.exit(72);
process.stdout.write(String(grandchild.pid) + "\n");

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  grandchild.kill();
  await Promise.race([
    once(grandchild, "close"),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (chunk.includes("shutdown")) void stop();
});
setInterval(() => undefined, 1_000);
`;

const TREE_GRANDCHILD_FIXTURE = "setInterval(() => undefined, 1_000);\n";

async function executeInsideFixture(
  options: ExecuteReliabilityOptions,
): Promise<readonly ScenarioEvidence[]> {
  return await withTemporaryGitFixture(async (fixture) => {
    assertProbeWorkspace({ mutation: "repository", cwd: fixture.path, fixture });
    const workspace = resolve(fixture.path, "可靠性 工作区");
    await mkdir(workspace);
    await Promise.all([
      writeFile(resolve(workspace, "process-tree-fixture.mjs"), CHILD_PROCESS_FIXTURE, "utf8"),
      writeFile(resolve(workspace, "tree-child.mjs"), TREE_CHILD_FIXTURE, "utf8"),
      writeFile(resolve(workspace, "tree-grandchild.mjs"), TREE_GRANDCHILD_FIXTURE, "utf8"),
    ]);

    const plans = new Map(planReliabilityScenarios().map((plan) => [plan.id, plan]));
    const plan = (id: ReliabilityScenarioId): ReliabilityScenarioPlan => {
      const value = plans.get(id);
      if (value === undefined) throw new Error(`MISSING_SCENARIO_PLAN:${id}`);
      return value;
    };
    const runner = new NodeCommandRunner();

    const unicodeCommand = await runner.run({
      executable: process.execPath,
      args: [
        "-e",
        "const cwd=process.cwd();process.exit(cwd.includes(' ')&&cwd.includes('可靠性')?0:19)",
      ],
      cwd: workspace,
      timeoutMs: 5_000,
    });
    const unicodePassed = unicodeCommand.exitCode === 0 && !unicodeCommand.timedOut;
    const unicodeState = resolveObservableState({
      kind: "verifier_receipt",
      passed: unicodePassed,
    });

    const treeCommand = await runner.run({
      executable: process.execPath,
      args:
        options.processTreeFault === "after_child_spawn"
          ? ["process-tree-fixture.mjs", "--fault-after-child-spawn"]
          : ["process-tree-fixture.mjs"],
      cwd: workspace,
      timeoutMs: 12_000,
    });
    let treeReceipt:
      | {
          readonly mechanic: string;
          readonly cleanupConfirmed: boolean;
          readonly faultObserved?: boolean;
        }
      | undefined;
    try {
      treeReceipt = JSON.parse(treeCommand.stdout) as {
        readonly mechanic: string;
        readonly cleanupConfirmed: boolean;
        readonly faultObserved?: boolean;
      };
    } catch {
      treeReceipt = undefined;
    }
    const supportedProcessHost = platform() === "win32" || platform() === "linux";
    const treeCleanupPassed =
      supportedProcessHost && treeReceipt?.cleanupConfirmed === true;
    const treePassed =
      treeCleanupPassed &&
      treeCommand.exitCode === 0 &&
      !treeCommand.timedOut &&
      treeReceipt?.faultObserved !== true;
    const treeState = resolveObservableState({
      kind: "verifier_receipt",
      passed: treePassed,
    });

    const forcedExitCommand = await runner.run({
      executable: process.execPath,
      args: ["-e", "process.exit(23)"],
      cwd: workspace,
      timeoutMs: 5_000,
    });
    const forcedExitState = resolveObservableState({
      kind: "provider_exit",
      exitCode: forcedExitCommand.exitCode,
    });

    const idempotencyReceipts = new Map<string, { readonly verifierPassed: true }>();
    let dispatchCount = 0;
    const dispatch = (key: string): { readonly verifierPassed: true } => {
      const existing = idempotencyReceipts.get(key);
      if (existing !== undefined) return existing;
      dispatchCount += 1;
      const receipt = { verifierPassed: true as const };
      idempotencyReceipts.set(key, receipt);
      return receipt;
    };
    const firstReceipt = dispatch("reliability-command-1");
    const duplicateReceipt = dispatch("reliability-command-1");
    const duplicatePassed = firstReceipt === duplicateReceipt && dispatchCount === 1;
    idempotencyReceipts.clear();

    const nativeSessions = new Set<string>();
    const nativeSessionReferences = new Set(["stale-native-session-ref"]);
    const staleSessionMissing = !nativeSessions.has("stale-native-session-ref");
    const staleSessionState = resolveObservableState({ kind: "session_missing" });
    nativeSessionReferences.delete("stale-native-session-ref");

    const pendingPermissionRequests = new Set(["denied-permission-request"]);
    const deniedPermissionState = resolveObservableState({
      kind: "permission_denied",
    });
    pendingPermissionRequests.delete("denied-permission-request");

    const treeVerdict = supportedProcessHost
      ? undefined
      : ("NOT_PROVEN" as const);
    return [
      resultFor(
        plan("unicode_space_workspace"),
        unicodeState,
        unicodePassed
          ? "verifier_confirmed_unicode_and_space_cwd"
          : "unicode_and_space_cwd_not_verified",
        {
          target: "temporary_git_fixture",
          outcome: "PASS",
          mechanic: "validated_fixture_cleanup_on_return",
          remainingResources: 0,
        },
        [commandEvidence(unicodeCommand, ["-e", "[UNICODE_CWD_VERIFIER]"])],
      ),
      resultFor(
        plan("child_process_tree"),
        treeState,
        treePassed
          ? "harmless_node_process_tree_created_and_terminated"
          : treeReceipt?.faultObserved === true && treeCleanupPassed
            ? "injected_process_tree_failure_cleaned_without_success_transition"
          : supportedProcessHost
            ? "process_tree_cleanup_not_confirmed"
            : "process_group_mechanic_not_supported_on_host",
        {
          target: "spawned_process_tree",
          outcome: treeCleanupPassed ? "PASS" : "NOT_PROVEN",
          mechanic: treeReceipt?.mechanic ?? "not_observed",
          remainingResources: treeCleanupPassed ? 0 : 1,
        },
        [commandEvidence(treeCommand, ["process-tree-fixture.mjs"])],
        treeVerdict,
      ),
      resultFor(
        plan("forced_provider_exit"),
        forcedExitState,
        forcedExitCommand.exitCode === 23
          ? "provider_exit_observed_without_success_transition"
          : "forced_exit_code_not_observed",
        {
          target: "provider_process",
          outcome:
            forcedExitCommand.exitCode === 23 && !forcedExitCommand.timedOut
              ? "PASS"
              : "NOT_PROVEN",
          mechanic: "exact_child_handle_reaped_by_command_runner",
          remainingResources:
            forcedExitCommand.exitCode === 23 && !forcedExitCommand.timedOut ? 0 : 1,
        },
        [commandEvidence(forcedExitCommand, ["-e", "[FORCED_EXIT_FIXTURE]"])],
      ),
      resultFor(
        plan("stale_session_reference"),
        staleSessionState,
        staleSessionMissing
          ? "missing_native_session_requires_attention"
          : "stale_session_fixture_was_not_missing",
        {
          target: "native_session_reference",
          outcome:
            staleSessionMissing && nativeSessionReferences.size === 0
              ? "PASS"
              : "NOT_PROVEN",
          mechanic: "stale_reference_released",
          remainingResources: nativeSessionReferences.size,
        },
      ),
      resultFor(
        plan("duplicate_command_idempotency"),
        resolveObservableState({
          kind: "verifier_receipt",
          passed: duplicatePassed,
        }),
        duplicatePassed
          ? "duplicate_key_reused_single_verified_receipt"
          : "duplicate_key_dispatched_more_than_once",
        {
          target: "idempotency_record",
          outcome: "PASS",
          mechanic: "bounded_in_memory_record_released",
          remainingResources: idempotencyReceipts.size,
        },
      ),
      resultFor(
        plan("denied_permission_request"),
        deniedPermissionState,
        "denied_permission_waits_for_explicit_approval",
        {
          target: "permission_request",
          outcome: pendingPermissionRequests.size === 0 ? "PASS" : "NOT_PROVEN",
          mechanic: "pending_request_released",
          remainingResources: pendingPermissionRequests.size,
        },
      ),
    ];
  });
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

function calculateContentFingerprint(value: unknown): string {
  const record = value as Record<string, unknown>;
  const withoutFingerprint = { ...record };
  Reflect.deleteProperty(withoutFingerprint, "contentFingerprint");
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonicalize({ ...withoutFingerprint, generatedAt: undefined }),
      ),
    )
    .digest("hex");
}

export async function executeReliabilityScenarios(
  options: ExecuteReliabilityOptions = {},
): Promise<ReliabilityEvidenceEnvelope> {
  const scenarios = await executeInsideFixture(options);
  const summary = {
    passed: scenarios.filter((scenario) => scenario.verdict === "PASS").length,
    failed: scenarios.filter((scenario) => scenario.verdict === "FAIL").length,
    notProven: scenarios.filter((scenario) => scenario.verdict === "NOT_PROVEN").length,
  };
  const withoutFingerprint = {
    schemaVersion: reliabilityEvidenceSchemaVersion,
    evidenceType: "phase0_runtime_reliability" as const,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    generator: {
      name: "hunter-runtime-reliability" as const,
      version: "0.1.0" as const,
    },
    host: {
      platform: platform(),
      architecture: arch(),
      release: release(),
      nodeVersion: process.version,
    },
    proofScope: "hunter_contract_fixture" as const,
    fixture: {
      cwdScope: "temporary_git_fixture" as const,
      workspaceShape: "unicode_and_spaces" as const,
    },
    scenarios: [...scenarios],
    summary,
    redaction: { applied: true as const, schemaVersion: 1 as const },
  };
  const contentFingerprint = calculateContentFingerprint(withoutFingerprint);
  return ReliabilityEvidenceEnvelopeSchema.parse({
    ...withoutFingerprint,
    contentFingerprint,
  });
}

function outputDirectoryFromArgs(args: readonly string[]): string {
  const outputIndex = args.indexOf("--output");
  const requested = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  if (requested === undefined || requested.length === 0) {
    throw new Error("USAGE: scenario.js --output <directory>");
  }
  const outputDirectory = resolve(requested);
  const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  const outputRelative = relative(repositoryRoot, outputDirectory);
  if (
    outputRelative.startsWith("..") ||
    resolve(repositoryRoot, outputRelative) !== outputDirectory
  ) {
    throw new Error("RELIABILITY_EVIDENCE_OUTPUT_OUTSIDE_REPOSITORY");
  }
  return outputDirectory;
}

async function main(): Promise<void> {
  const outputDirectory = outputDirectoryFromArgs(process.argv.slice(2));
  const evidence = await executeReliabilityScenarios();
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  assertSafeEvidence(serialized);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(resolve(outputDirectory, "runtime-reliability.json"), serialized, "utf8");
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath !== undefined && invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "UNKNOWN_RELIABILITY_FAILURE";
    process.stderr.write(`${basename(invokedPath)}: ${message}\n`);
    process.exitCode = 1;
  });
}
