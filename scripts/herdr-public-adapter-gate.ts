import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DeviceBindingIdSchema,
  OperationIdSchema,
  ProjectIdSchema,
  RepositoryIdSchema,
  WorkspaceIdSchema,
} from "@hunter/domain";
import {
  HERDR_EXECUTABLE_IDENTITY,
  HerdrAdapterError,
  HerdrCommandRunner,
  HerdrPublicAdapter,
  HerdrPublicClient,
  type HerdrExecFileAdapter,
} from "@hunter/provider-herdr";
import {
  createExternalOperation,
  createWorkspacePathBoundary,
} from "@hunter/runtime-contracts";
import {
  NodeCommandRunner,
  assertProbeWorkspace,
  assertSafeEvidence,
  withTemporaryGitFixture,
  type TemporaryGitFixture,
} from "@hunter/spike-testkit";
import { z } from "zod";
import {
  HERDR_CONTROL_PLANE_SOURCE_PATHSPEC,
  HerdrControlPlaneBaselineSchema,
  inspectHerdrControlPlaneSource,
  prepareHerdrBaselineEvidenceOutput,
  resolveDefaultHerdrAssetPath,
} from "./herdr-control-plane-baseline.js";

const SHA256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const GateStatusSchema = z.enum(["PASS", "BLOCKED"]);
const SourceIdentitySchema = z.strictObject({
  commit: z.string().regex(/^[a-f0-9]{40}$/u),
  digest: SHA256Schema,
  clean: z.literal(true),
});
const CheckSchema = z.strictObject({
  id: z.enum([
    "fixed_version",
    "workspace_attach_existing",
    "operation_idempotency",
    "state_only_cleanup",
    "isolated_session",
    "permission_argument_gate",
    "resource_cleanup",
  ]),
  status: GateStatusSchema,
  receiptHash: SHA256Schema.nullable(),
});

const SubsequentTaskSchema = z.strictObject({
  task: z.number().int().min(2).max(8),
  status: z.enum(["READY", "NOT_RUN"]),
});

export const HerdrPublicAdapterGateSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    evidenceType: z.literal("herdr_public_adapter_gate"),
    generatedAt: z.iso.datetime(),
    generator: z.strictObject({
      name: z.literal("hunter-herdr-public-adapter-gate"),
      version: z.literal("0.1.0"),
    }),
    source: SourceIdentitySchema,
    baseline: z.strictObject({
      path: z.literal(
        "docs/validation/evidence/herdr-control-plane/baseline.json",
      ),
      sha256: SHA256Schema,
      task0Verdict: z.literal("PASS"),
      providerVerdict: z.literal("NOT_PROVEN"),
    }),
    runtime: z.strictObject({
      providerId: z.literal("rtp_herdr_public_cli"),
      version: z.literal(HERDR_EXECUTABLE_IDENTITY.version),
      identityFingerprint: z.literal(
        HERDR_EXECUTABLE_IDENTITY.fingerprint,
      ),
      identityVerified: z.boolean(),
    }),
    fixture: z.strictObject({
      noRemote: z.boolean(),
      exactPathAttached: z.boolean(),
      headPreservedAfterClose: z.boolean(),
      branchPreservedAfterClose: z.boolean(),
      contentPreservedAfterClose: z.boolean(),
      gitPathPreservedAfterClose: z.boolean(),
    }),
    operations: z.strictObject({
      prepareStatus: z.enum(["completed", "needs_attention", "not_run"]),
      prepareReceiptHash: SHA256Schema.nullable(),
      duplicateReturnedSameReceipt: z.boolean(),
      releaseStatus: z.enum(["completed", "needs_attention", "not_run"]),
      releaseReceiptHash: SHA256Schema.nullable(),
    }),
    sessionIsolation: z.strictObject({
      targetBefore: z.enum(["absent", "running", "stopped", "unknown"]),
      targetAfterClose: z.enum([
        "absent",
        "running",
        "stopped",
        "unknown",
      ]),
      targetAfterCleanup: z.enum([
        "absent",
        "running",
        "stopped",
        "unknown",
      ]),
      unrelatedDigestBefore: SHA256Schema.nullable(),
      unrelatedDigestAfterClose: SHA256Schema.nullable(),
      unrelatedDigestAfterCleanup: SHA256Schema.nullable(),
      unrelatedResourcesUntouched: z.boolean(),
    }),
    permissionGate: z.strictObject({
      dangerousArgumentRejectedBeforeIo: z.boolean(),
      forceRemovalRejectedBeforeIo: z.boolean(),
      shellExecutionUsed: z.literal(false),
      privateStateRead: z.literal(false),
      guiOrTerminalScrapingUsed: z.literal(false),
    }),
    cleanup: z.strictObject({
      workspaceStateClosed: z.boolean(),
      ownedSessionStopped: z.boolean(),
      ownedSessionDeleted: z.boolean(),
      hunterGitWorktreeRemoved: z.boolean(),
      hunterGitBranchRemoved: z.boolean(),
    }),
    checks: z.tuple([
      CheckSchema,
      CheckSchema,
      CheckSchema,
      CheckSchema,
      CheckSchema,
      CheckSchema,
      CheckSchema,
    ]),
    budgetUsage: z.strictObject({
      realAttempts: z.literal(1),
      realSessions: z.literal(1),
      agentStarts: z.literal(0),
      sends: z.literal(0),
      additionalPaidBudgetUsd: z.literal(0),
    }),
    providerVerdict: GateStatusSchema,
    failureCode: z.string().regex(/^[A-Z0-9_]+$/u).nullable(),
    subsequentTasks: z.tuple([
      SubsequentTaskSchema,
      SubsequentTaskSchema,
      SubsequentTaskSchema,
      SubsequentTaskSchema,
      SubsequentTaskSchema,
      SubsequentTaskSchema,
      SubsequentTaskSchema,
    ]),
    proofScope: z.literal("local_public_cli_temporary_git_fixture"),
    redaction: z.strictObject({
      applied: z.literal(true),
      schemaVersion: z.literal(1),
    }),
    contentFingerprint: SHA256Schema,
  })
  .superRefine((evidence, context) => {
    const expectedIds = [
      "fixed_version",
      "workspace_attach_existing",
      "operation_idempotency",
      "state_only_cleanup",
      "isolated_session",
      "permission_argument_gate",
      "resource_cleanup",
    ];
    if (
      evidence.checks.map(({ id }) => id).join(",")
      !== expectedIds.join(",")
    ) {
      context.addIssue({
        code: "custom",
        path: ["checks"],
        message: "CHECK_INVENTORY_MISMATCH",
      });
    }
    const expectedChecks = deriveChecks(
      observationsFromEvidence(evidence),
      evidence.failureCode,
    );
    if (JSON.stringify(evidence.checks) !== JSON.stringify(expectedChecks)) {
      context.addIssue({
        code: "custom",
        path: ["checks"],
        message: "CHECK_DERIVATION_MISMATCH",
      });
    }
    const allPass = expectedChecks.every(
      ({ status }) => status === "PASS",
    );
    if (
      evidence.providerVerdict !== (allPass ? "PASS" : "BLOCKED")
      || evidence.subsequentTasks.some(
        ({ task, status }, index) =>
          task !== index + 2
          || status !== (allPass ? "READY" : "NOT_RUN"),
      )
      || (allPass && evidence.failureCode !== null)
      || (!allPass && evidence.failureCode === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["providerVerdict"],
        message: "GATE_VERDICT_MISMATCH",
      });
    }
    const expectedFingerprint =
      fingerprintHerdrPublicAdapterGateContent(evidence);
    if (evidence.contentFingerprint !== expectedFingerprint) {
      context.addIssue({
        code: "custom",
        path: ["contentFingerprint"],
        message: "CONTENT_FINGERPRINT_MISMATCH",
      });
    }
  });

export type HerdrPublicAdapterGate = z.infer<
  typeof HerdrPublicAdapterGateSchema
>;

export interface HerdrGateObservations {
  readonly identityVerified: boolean;
  readonly noRemote: boolean;
  readonly exactPathAttached: boolean;
  readonly headPreservedAfterClose: boolean;
  readonly branchPreservedAfterClose: boolean;
  readonly contentPreservedAfterClose: boolean;
  readonly gitPathPreservedAfterClose: boolean;
  readonly prepareStatus: "completed" | "needs_attention" | "not_run";
  readonly prepareReceiptHash: string | null;
  readonly duplicateReturnedSameReceipt: boolean;
  readonly releaseStatus: "completed" | "needs_attention" | "not_run";
  readonly releaseReceiptHash: string | null;
  readonly targetBefore: "absent" | "running" | "stopped" | "unknown";
  readonly targetAfterClose: "absent" | "running" | "stopped" | "unknown";
  readonly targetAfterCleanup: "absent" | "running" | "stopped" | "unknown";
  readonly unrelatedDigestBefore: string | null;
  readonly unrelatedDigestAfterClose: string | null;
  readonly unrelatedDigestAfterCleanup: string | null;
  readonly dangerousArgumentRejectedBeforeIo: boolean;
  readonly forceRemovalRejectedBeforeIo: boolean;
  readonly workspaceStateClosed: boolean;
  readonly ownedSessionStopped: boolean;
  readonly ownedSessionDeleted: boolean;
  readonly hunterGitWorktreeRemoved: boolean;
  readonly hunterGitBranchRemoved: boolean;
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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function derivedReceiptHash(
  id: string,
  passed: boolean,
  proof: unknown,
): string | null {
  return passed
    ? sha256(JSON.stringify(canonicalize({
        id,
        identityFingerprint: HERDR_EXECUTABLE_IDENTITY.fingerprint,
        proof,
      })))
    : null;
}

function deriveChecks(
  observation: HerdrGateObservations,
  failureCode: string | null,
): HerdrPublicAdapterGate["checks"] {
  const unrelatedResourcesUntouched =
    observation.unrelatedDigestBefore !== null
    && observation.unrelatedDigestBefore
      === observation.unrelatedDigestAfterClose
    && observation.unrelatedDigestBefore
      === observation.unrelatedDigestAfterCleanup;
  const predicates = {
    fixed_version: observation.identityVerified,
    workspace_attach_existing:
      observation.noRemote
      && observation.exactPathAttached
      && observation.prepareStatus === "completed"
      && observation.prepareReceiptHash !== null,
    operation_idempotency:
      observation.duplicateReturnedSameReceipt
      && observation.prepareReceiptHash !== null,
    state_only_cleanup:
      observation.releaseStatus === "completed"
      && observation.releaseReceiptHash !== null
      && observation.workspaceStateClosed
      && observation.gitPathPreservedAfterClose
      && observation.headPreservedAfterClose
      && observation.branchPreservedAfterClose
      && observation.contentPreservedAfterClose,
    isolated_session:
      observation.targetBefore === "absent"
      && observation.targetAfterCleanup === "absent"
      && unrelatedResourcesUntouched,
    permission_argument_gate:
      observation.dangerousArgumentRejectedBeforeIo
      && observation.forceRemovalRejectedBeforeIo,
    resource_cleanup:
      failureCode === null
      && observation.ownedSessionStopped
      && observation.ownedSessionDeleted
      && observation.hunterGitWorktreeRemoved
      && observation.hunterGitBranchRemoved,
  } as const;
  const proofById = {
    fixed_version: {
      identityVerified: observation.identityVerified,
    },
    workspace_attach_existing: {
      noRemote: observation.noRemote,
      exactPathAttached: observation.exactPathAttached,
      prepareReceiptHash: observation.prepareReceiptHash,
    },
    operation_idempotency: {
      prepareReceiptHash: observation.prepareReceiptHash,
      duplicateReturnedSameReceipt:
        observation.duplicateReturnedSameReceipt,
    },
    state_only_cleanup: {
      releaseReceiptHash: observation.releaseReceiptHash,
      workspaceStateClosed: observation.workspaceStateClosed,
      gitPathPreservedAfterClose:
        observation.gitPathPreservedAfterClose,
      headPreservedAfterClose:
        observation.headPreservedAfterClose,
      branchPreservedAfterClose:
        observation.branchPreservedAfterClose,
      contentPreservedAfterClose:
        observation.contentPreservedAfterClose,
    },
    isolated_session: {
      targetBefore: observation.targetBefore,
      targetAfterClose: observation.targetAfterClose,
      targetAfterCleanup: observation.targetAfterCleanup,
      unrelatedDigestBefore: observation.unrelatedDigestBefore,
      unrelatedDigestAfterClose:
        observation.unrelatedDigestAfterClose,
      unrelatedDigestAfterCleanup:
        observation.unrelatedDigestAfterCleanup,
    },
    permission_argument_gate: {
      dangerousArgumentRejectedBeforeIo:
        observation.dangerousArgumentRejectedBeforeIo,
      forceRemovalRejectedBeforeIo:
        observation.forceRemovalRejectedBeforeIo,
    },
    resource_cleanup: {
      failureCode,
      ownedSessionStopped: observation.ownedSessionStopped,
      ownedSessionDeleted: observation.ownedSessionDeleted,
      hunterGitWorktreeRemoved:
        observation.hunterGitWorktreeRemoved,
      hunterGitBranchRemoved: observation.hunterGitBranchRemoved,
    },
  } as const;
  return (Object.entries(predicates) as Array<
    [keyof typeof predicates, boolean]
  >).map(([id, passed]) => ({
    id,
    status: passed ? "PASS" as const : "BLOCKED" as const,
    receiptHash: derivedReceiptHash(id, passed, proofById[id]),
  })) as HerdrPublicAdapterGate["checks"];
}

function observationsFromEvidence(
  evidence: Omit<HerdrPublicAdapterGate, "checks">,
): HerdrGateObservations {
  return {
    identityVerified:
      evidence.runtime.identityVerified,
    ...evidence.fixture,
    ...evidence.operations,
    targetBefore: evidence.sessionIsolation.targetBefore,
    targetAfterClose: evidence.sessionIsolation.targetAfterClose,
    targetAfterCleanup: evidence.sessionIsolation.targetAfterCleanup,
    unrelatedDigestBefore:
      evidence.sessionIsolation.unrelatedDigestBefore,
    unrelatedDigestAfterClose:
      evidence.sessionIsolation.unrelatedDigestAfterClose,
    unrelatedDigestAfterCleanup:
      evidence.sessionIsolation.unrelatedDigestAfterCleanup,
    dangerousArgumentRejectedBeforeIo:
      evidence.permissionGate.dangerousArgumentRejectedBeforeIo,
    forceRemovalRejectedBeforeIo:
      evidence.permissionGate.forceRemovalRejectedBeforeIo,
    ...evidence.cleanup,
  };
}

export function fingerprintHerdrPublicAdapterGateContent(
  evidence: Omit<HerdrPublicAdapterGate, "contentFingerprint">,
): string {
  const withoutFingerprint = { ...evidence } as Partial<
    HerdrPublicAdapterGate
  >;
  delete withoutFingerprint.contentFingerprint;
  return sha256(
    JSON.stringify(canonicalize({
      ...withoutFingerprint,
      generatedAt: undefined,
    })),
  );
}

export function createHerdrPublicAdapterGateEvidence(input: {
  readonly generatedAt: string;
  readonly source: {
    readonly commit: string;
    readonly digest: string;
    readonly clean: true;
  };
  readonly baselineSha256: string;
  readonly observations: HerdrGateObservations;
  readonly failureCode: string | null;
}): HerdrPublicAdapterGate {
  const observation = input.observations;
  const unrelatedResourcesUntouched =
    observation.unrelatedDigestBefore !== null
    && observation.unrelatedDigestBefore
      === observation.unrelatedDigestAfterClose
    && observation.unrelatedDigestBefore
      === observation.unrelatedDigestAfterCleanup;
  let effectiveFailureCode = input.failureCode;
  let checks = deriveChecks(observation, effectiveFailureCode);
  if (
    effectiveFailureCode === null
    && checks.some(({ status }) => status !== "PASS")
  ) {
    effectiveFailureCode = "HERDR_TASK1_NOT_PROVEN";
    checks = deriveChecks(observation, effectiveFailureCode);
  }
  const providerVerdict = checks.every(({ status }) => status === "PASS")
    ? "PASS" as const
    : "BLOCKED" as const;
  const evidenceWithoutFingerprint = {
    schemaVersion: 1 as const,
    evidenceType: "herdr_public_adapter_gate" as const,
    generatedAt: input.generatedAt,
    generator: {
      name: "hunter-herdr-public-adapter-gate" as const,
      version: "0.1.0" as const,
    },
    source: input.source,
    baseline: {
      path:
        "docs/validation/evidence/herdr-control-plane/baseline.json" as const,
      sha256: input.baselineSha256,
      task0Verdict: "PASS" as const,
      providerVerdict: "NOT_PROVEN" as const,
    },
    runtime: {
      providerId: "rtp_herdr_public_cli" as const,
      version: HERDR_EXECUTABLE_IDENTITY.version,
      identityFingerprint: HERDR_EXECUTABLE_IDENTITY.fingerprint,
      identityVerified: observation.identityVerified,
    },
    fixture: {
      noRemote: observation.noRemote,
      exactPathAttached: observation.exactPathAttached,
      headPreservedAfterClose: observation.headPreservedAfterClose,
      branchPreservedAfterClose: observation.branchPreservedAfterClose,
      contentPreservedAfterClose: observation.contentPreservedAfterClose,
      gitPathPreservedAfterClose: observation.gitPathPreservedAfterClose,
    },
    operations: {
      prepareStatus: observation.prepareStatus,
      prepareReceiptHash: observation.prepareReceiptHash,
      duplicateReturnedSameReceipt:
        observation.duplicateReturnedSameReceipt,
      releaseStatus: observation.releaseStatus,
      releaseReceiptHash: observation.releaseReceiptHash,
    },
    sessionIsolation: {
      targetBefore: observation.targetBefore,
      targetAfterClose: observation.targetAfterClose,
      targetAfterCleanup: observation.targetAfterCleanup,
      unrelatedDigestBefore: observation.unrelatedDigestBefore,
      unrelatedDigestAfterClose: observation.unrelatedDigestAfterClose,
      unrelatedDigestAfterCleanup:
        observation.unrelatedDigestAfterCleanup,
      unrelatedResourcesUntouched,
    },
    permissionGate: {
      dangerousArgumentRejectedBeforeIo:
        observation.dangerousArgumentRejectedBeforeIo,
      forceRemovalRejectedBeforeIo:
        observation.forceRemovalRejectedBeforeIo,
      shellExecutionUsed: false as const,
      privateStateRead: false as const,
      guiOrTerminalScrapingUsed: false as const,
    },
    cleanup: {
      workspaceStateClosed: observation.workspaceStateClosed,
      ownedSessionStopped: observation.ownedSessionStopped,
      ownedSessionDeleted: observation.ownedSessionDeleted,
      hunterGitWorktreeRemoved: observation.hunterGitWorktreeRemoved,
      hunterGitBranchRemoved: observation.hunterGitBranchRemoved,
    },
    checks,
    budgetUsage: {
      realAttempts: 1 as const,
      realSessions: 1 as const,
      agentStarts: 0 as const,
      sends: 0 as const,
      additionalPaidBudgetUsd: 0 as const,
    },
    providerVerdict,
    failureCode: providerVerdict === "PASS"
      ? null
      : effectiveFailureCode,
    subsequentTasks: Array.from({ length: 7 }, (_, index) => ({
      task: index + 2,
      status: providerVerdict === "PASS"
        ? "READY" as const
        : "NOT_RUN" as const,
    })) as HerdrPublicAdapterGate["subsequentTasks"],
    proofScope: "local_public_cli_temporary_git_fixture" as const,
    redaction: {
      applied: true as const,
      schemaVersion: 1 as const,
    },
  };
  return HerdrPublicAdapterGateSchema.parse({
    ...evidenceWithoutFingerprint,
    contentFingerprint:
      fingerprintHerdrPublicAdapterGateContent(evidenceWithoutFingerprint),
  });
}

function defaultObservations(): HerdrGateObservations {
  return {
    identityVerified: false,
    noRemote: false,
    exactPathAttached: false,
    headPreservedAfterClose: false,
    branchPreservedAfterClose: false,
    contentPreservedAfterClose: false,
    gitPathPreservedAfterClose: false,
    prepareStatus: "not_run",
    prepareReceiptHash: null,
    duplicateReturnedSameReceipt: false,
    releaseStatus: "not_run",
    releaseReceiptHash: null,
    targetBefore: "unknown",
    targetAfterClose: "unknown",
    targetAfterCleanup: "unknown",
    unrelatedDigestBefore: null,
    unrelatedDigestAfterClose: null,
    unrelatedDigestAfterCleanup: null,
    dangerousArgumentRejectedBeforeIo: false,
    forceRemovalRejectedBeforeIo: false,
    workspaceStateClosed: false,
    ownedSessionStopped: false,
    ownedSessionDeleted: false,
    hunterGitWorktreeRemoved: false,
    hunterGitBranchRemoved: false,
  };
}

async function runGit(
  fixture: TemporaryGitFixture,
  cwd: string,
  args: readonly string[],
): Promise<string> {
  assertProbeWorkspace({
    mutation: "repository",
    cwd: fixture.path,
    fixture,
  });
  const result = await new NodeCommandRunner().run({
    executable: "git",
    args,
    cwd,
    timeoutMs: 15_000,
  });
  if (result.exitCode !== 0) throw new Error("TEMP_GIT_COMMAND_FAILED");
  return result.stdout.trim();
}

function productionExecFile(): HerdrExecFileAdapter {
  return (executable, args, options) =>
    new Promise((resolvePromise, rejectPromise) => {
      execFile(executable, [...args], options, (error, stdout, stderr) => {
        if (error !== null) {
          rejectPromise(error);
          return;
        }
        resolvePromise({ stdout, stderr });
      });
    });
}

function receiptHash(receipt: unknown): string {
  return sha256(JSON.stringify(canonicalize(receipt)));
}

function normalizeFailureCode(error: unknown): string {
  if (error instanceof HerdrAdapterError) return error.code;
  if (
    error instanceof Error
    && /^[A-Z0-9_]+$/u.test(error.message)
  ) {
    return error.message;
  }
  return "HERDR_TASK1_GATE_BLOCKED";
}

export function assertOwnedSessionAbsent(
  target: "absent" | "running" | "stopped",
): void {
  if (target !== "absent") {
    throw new Error("HERDR_OWNED_SESSION_COLLISION");
  }
}

export async function collectPermissionArgumentGate(
  runner: Pick<HerdrCommandRunner, "run">,
): Promise<{
  readonly dangerousArgumentRejectedBeforeIo: boolean;
  readonly forceRemovalRejectedBeforeIo: boolean;
}> {
  let dangerousArgumentRejectedBeforeIo = false;
  let forceRemovalRejectedBeforeIo = false;
  try {
    await runner.run([
      "agent",
      "start",
      "probe",
      "--kind",
      "codex",
      "--pane",
      "w1:p1",
      "--yolo",
    ]);
  } catch (error) {
    dangerousArgumentRejectedBeforeIo =
      error instanceof HerdrAdapterError
      && error.code === "HERDR_ARGUMENT_FORBIDDEN"
      && !error.effectPossible;
  }
  try {
    await runner.run([
      "worktree",
      "remove",
      "fixture",
      "--force",
    ]);
  } catch (error) {
    forceRemovalRejectedBeforeIo =
      error instanceof HerdrAdapterError
      && error.code === "HERDR_COMMAND_FORBIDDEN"
      && !error.effectPossible;
  }
  return {
    dangerousArgumentRejectedBeforeIo,
    forceRemovalRejectedBeforeIo,
  };
}

async function exerciseGate(options: {
  readonly executable: string;
  readonly generatedAt: string;
}): Promise<{
  readonly observations: HerdrGateObservations;
  readonly failureCode: string | null;
}> {
  let observations = defaultObservations();
  let failureCode: string | null = null;
  try {
    await withTemporaryGitFixture(async (fixture) => {
      const branchName = "codex/herdr-task1-fixture";
      const requestedWorktreePath = join(
        fixture.path,
        ".hunter-task1-worktrees",
        "attach",
      );
      const sessionName =
        `hunter-task1-${process.pid}-${randomBytes(5).toString("hex")}`;
      let attachedPath: string | null = null;
      let client: HerdrPublicClient | null = null;
      let sessionOwned = false;
      let stopped = false;
      let deleted = false;
      let gitWorktreeRemoved = false;
      let gitBranchRemoved = false;
      try {
        const remoteList = await runGit(
          fixture,
          fixture.path,
          ["remote"],
        );
        await runGit(fixture, fixture.path, [
          "worktree",
          "add",
          "-b",
          branchName,
          requestedWorktreePath,
          fixture.baselineCommit,
        ]);
        attachedPath = realpathSync.native(requestedWorktreePath);
        const expectedHead = await runGit(
          fixture,
          attachedPath,
          ["rev-parse", "HEAD"],
        );
        const expectedBranch = await runGit(
          fixture,
          attachedPath,
          ["branch", "--show-current"],
        );
        const expectedContent = sha256(
          readFileSync(join(attachedPath, "README.md")),
        );
        const runner = new HerdrCommandRunner({
          executable: options.executable,
          sessionName,
          configPath: join(fixture.path, ".hunter-task1-config.toml"),
          execFile: productionExecFile(),
        });
        client = new HerdrPublicClient(runner);
        const before = await client.inventorySessions(sessionName);
        assertOwnedSessionAbsent(before.target);
        sessionOwned = true;
        observations = {
          ...observations,
          identityVerified: true,
          noRemote: remoteList.length === 0,
          targetBefore: before.target,
          unrelatedDigestBefore: before.unrelatedDigest,
        };
        const permissionGate =
          await collectPermissionArgumentGate(runner);
        observations = { ...observations, ...permissionGate };
        const repositoryId =
          RepositoryIdSchema.parse("rep_herdrgate01");
        const workspaceId =
          WorkspaceIdSchema.parse("wsp_herdrgate01");
        const adapter = new HerdrPublicAdapter(
          client,
          createWorkspacePathBoundary(
            new Map([[repositoryId, fixture.path]]),
            {
              platform: process.platform === "win32" ? "win32" : "posix",
              realpathNative: realpathSync.native,
            },
          ),
          {
            repositoryPathFor: (candidate) =>
              candidate === repositoryId ? attachedPath : null,
            repositorySourcePathFor: (candidate) =>
              candidate === repositoryId ? fixture.path : null,
            observedAt: () => options.generatedAt,
          },
        );
        const prepare = createExternalOperation({
          schemaVersion: 1,
          operationVersion: 1,
          operationId: OperationIdSchema.parse("opn_herdrgateprepare01"),
          projectId: ProjectIdSchema.parse("prj_herdrgate01"),
          runId: null,
          attemptId: null,
          operationType: "workspace.prepare",
          requestedCapabilities: ["workspace_prepare"],
          payload: {
            repositoryId,
            deviceBindingId:
              DeviceBindingIdSchema.parse("dev_herdrgate01"),
            workspaceId,
            mode: "write",
            baselineRevision: expectedHead,
          },
        });
        const prepared = await adapter.execute(prepare);
        const replay = await adapter.execute(prepare);
        observations = {
          ...observations,
          exactPathAttached:
            prepared.operationStatus === "completed"
            && prepared.workspaceResult?.reportedWorkspacePath
              === attachedPath,
          prepareStatus: prepared.operationStatus,
          prepareReceiptHash: receiptHash(prepared),
          duplicateReturnedSameReceipt:
            receiptHash(prepared) === receiptHash(replay),
        };
        if (prepared.operationStatus !== "completed") {
          throw new Error("HERDR_PREPARE_NOT_COMPLETED");
        }
        const release = createExternalOperation({
          schemaVersion: 1,
          operationVersion: 1,
          operationId: OperationIdSchema.parse("opn_herdrgaterelease01"),
          projectId: ProjectIdSchema.parse("prj_herdrgate01"),
          runId: null,
          attemptId: null,
          operationType: "workspace.release",
          requestedCapabilities: ["workspace_prepare"],
          payload: { workspaceId },
        });
        const released = await adapter.execute(release);
        observations = {
          ...observations,
          releaseStatus: released.operationStatus,
          releaseReceiptHash: receiptHash(released),
          workspaceStateClosed:
            released.operationStatus === "completed",
        };
        const afterClose = await client.inventorySessions(sessionName);
        const actualHead = await runGit(
          fixture,
          attachedPath,
          ["rev-parse", "HEAD"],
        );
        const actualBranch = await runGit(
          fixture,
          attachedPath,
          ["branch", "--show-current"],
        );
        const actualContent = sha256(
          readFileSync(join(attachedPath, "README.md")),
        );
        observations = {
          ...observations,
          headPreservedAfterClose: expectedHead === actualHead,
          branchPreservedAfterClose:
            expectedBranch === actualBranch
            && expectedBranch === branchName,
          contentPreservedAfterClose: expectedContent === actualContent,
          gitPathPreservedAfterClose: existsSync(attachedPath),
          targetAfterClose: afterClose.target,
          unrelatedDigestAfterClose: afterClose.unrelatedDigest,
        };
      } finally {
        if (client !== null && sessionOwned) {
          try {
            const current = await client.inventorySessions(sessionName);
            if (current.target === "running") {
              await client.stopOwnedSession(sessionName);
              stopped = true;
            } else if (current.target === "stopped") {
              stopped = true;
            }
            const stoppedInventory =
              await client.inventorySessions(sessionName);
            if (stoppedInventory.target === "stopped") {
              await client.deleteOwnedSession(sessionName);
              deleted = true;
            } else if (stoppedInventory.target === "absent") {
              deleted = true;
            }
            const afterCleanup =
              await client.inventorySessions(sessionName);
            observations = {
              ...observations,
              targetAfterCleanup: afterCleanup.target,
              unrelatedDigestAfterCleanup:
                afterCleanup.unrelatedDigest,
              ownedSessionStopped: stopped,
              ownedSessionDeleted: deleted,
            };
          } catch (error) {
            failureCode ??= normalizeFailureCode(error);
          }
        }
        if (attachedPath !== null && existsSync(attachedPath)) {
          try {
            const status = await runGit(
              fixture,
              attachedPath,
              ["status", "--porcelain=v1"],
            );
            if (status.length === 0) {
              await runGit(fixture, fixture.path, [
                "worktree",
                "remove",
                attachedPath,
              ]);
              gitWorktreeRemoved = !existsSync(attachedPath);
              await runGit(
                fixture,
                fixture.path,
                ["branch", "--delete", branchName],
              );
              gitBranchRemoved = true;
            }
          } catch (error) {
            failureCode ??= normalizeFailureCode(error);
          }
        }
        observations = {
          ...observations,
          hunterGitWorktreeRemoved: gitWorktreeRemoved,
          hunterGitBranchRemoved: gitBranchRemoved,
        };
      }
    });
  } catch (error) {
    failureCode ??= normalizeFailureCode(error);
  }
  return { observations, failureCode };
}

export function resolveHerdrPublicAdapterGateOutputPath(
  repositoryRoot: string,
  output: string,
): string {
  const expectedOutputPath = resolve(
    repositoryRoot,
    "docs",
    "validation",
    "evidence",
    "herdr-control-plane",
    "public-adapter-gate.json",
  );
  const outputPath = resolve(repositoryRoot, output);
  if (outputPath !== expectedOutputPath) {
    throw new Error("HERDR_TASK1_OUTPUT_OUTSIDE_ALLOWED_ROOT");
  }
  return outputPath;
}

export function prepareHerdrPublicAdapterGateOutput(
  outputPath: string,
): string | null {
  if (!existsSync(outputPath)) return null;
  const serialized = readFileSync(outputPath, "utf8");
  assertSafeEvidence(serialized);
  HerdrPublicAdapterGateSchema.parse(
    JSON.parse(serialized) as unknown,
  );
  return prepareHerdrBaselineEvidenceOutput(outputPath);
}

function parseArguments(args: readonly string[]): {
  readonly output: string;
  readonly asset: string | null;
} {
  let output: string | null = null;
  let asset: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if ((argument === "--output" || argument === "--asset") && value) {
      if (argument === "--output") output = value;
      else asset = value;
      index += 1;
      continue;
    }
    throw new Error("HERDR_TASK1_ARGUMENT_INVALID");
  }
  if (output === null) throw new Error("HERDR_TASK1_OUTPUT_REQUIRED");
  return { output, asset };
}

function writeAtomic(outputPath: string, serialized: string): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, serialized, "utf8");
  renameSync(temporaryPath, outputPath);
}

async function main(): Promise<void> {
  const repositoryRoot = process.cwd();
  const args = parseArguments(process.argv.slice(2));
  const outputPath = resolveHerdrPublicAdapterGateOutputPath(
    repositoryRoot,
    args.output,
  );
  const baselinePath = resolve(
    repositoryRoot,
    "docs/validation/evidence/herdr-control-plane/baseline.json",
  );
  const baselineRaw = readFileSync(baselinePath);
  const baseline = HerdrControlPlaneBaselineSchema.parse(
    JSON.parse(baselineRaw.toString("utf8")) as unknown,
  );
  if (
    baseline.task0Verdict !== "PASS"
    || baseline.providerVerdict !== "NOT_PROVEN"
  ) {
    throw new Error("HERDR_TASK0_BASELINE_NOT_ELIGIBLE");
  }
  const source = SourceIdentitySchema.parse(
    inspectHerdrControlPlaneSource({
      cwd: repositoryRoot,
      pathspec: HERDR_CONTROL_PLANE_SOURCE_PATHSPEC,
    }),
  );
  const generatedAt = new Date().toISOString();
  const executable =
    args.asset === null
      ? resolveDefaultHerdrAssetPath(repositoryRoot)
      : resolve(args.asset);
  const exercised = await exerciseGate({ executable, generatedAt });
  const evidence = createHerdrPublicAdapterGateEvidence({
    generatedAt,
    source,
    baselineSha256: sha256(baselineRaw),
    observations: exercised.observations,
    failureCode: exercised.failureCode,
  });
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  assertSafeEvidence(serialized);
  prepareHerdrPublicAdapterGateOutput(outputPath);
  writeAtomic(outputPath, serialized);
  process.stdout.write(
    `Herdr public Adapter gate: ${evidence.providerVerdict}\n`,
  );
  if (evidence.providerVerdict !== "PASS") process.exitCode = 2;
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined
  && fileURLToPath(import.meta.url) === resolve(entryPoint)
) {
  await main();
}
