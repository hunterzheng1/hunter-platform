import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { arch, release, tmpdir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
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

export const HERDR_STABLE_RELEASE = {
  tag: "v0.7.5",
  commit: "ef4c23f5775bb8cfec05f05d0844226ff959a07a",
  publishedAt: "2026-07-21T18:11:20Z",
  windowsAssetPublished: false,
} as const;

export const HERDR_WINDOWS_PREVIEW_RELEASE = {
  tag: "preview-2026-07-21-0f10e1453a7f",
  commit: "0f10e1453a7f9fda357352bb65ce17fa26fda447",
  relationToStable: "ahead_by_2_docs_only",
  publishedAt: "2026-07-21T19:02:36Z",
  assetName: "herdr-windows-x86_64.exe",
  size: 19_981_312,
  sha256: "75c85763db0ca5fd13b485d0728cc3e9ea1152964a4e976e1d49f2e86b01a92b",
  downloadUrl:
    "https://github.com/ogulcancelik/herdr/releases/download/preview-2026-07-21-0f10e1453a7f/herdr-windows-x86_64.exe",
} as const;

export const HERDR_API_SCHEMA_CANONICAL_SHA256 =
  "7cb5b7086f5dd04adb8b7b2069042afd7214da87f6bca66e2b07ff8aa95f6f6f" as const;

export const HERDR_REPLACEMENT_TIMEBOX_STARTED_AT =
  "2026-07-28T04:19:30.589Z" as const;
export const HERDR_REPLACEMENT_TIMEBOX_DEADLINE_AT =
  "2026-08-04T04:19:30.589Z" as const;

export const HERDR_CONTROL_PLANE_SOURCE_PATHSPEC = [
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

const EXPECTED_TOOL_IDS = ["codex", "git", "herdr", "node"] as const;
const EXPECTED_PUBLIC_INTERFACE_OPERATIONS = [
  "agent_inventory",
  "api_schema",
  "root_help",
  "session_inventory",
  "workspace_inventory",
  "worktree_inventory",
] as const;
const EXPECTED_CAPABILITY_IDS = [
  "asset_integrity",
  "fixed_version",
  "public_inventory",
  "public_schema",
  "resource_cleanup",
  "security_defaults",
  "windows_binary_launch",
  "workspace_attach_existing",
] as const;
const EXPECTED_COMMAND_OPERATIONS = [
  "codex_login_status",
  "codex_version",
  "git_version",
  "herdr_agent_help",
  "herdr_api_schema",
  "herdr_help",
  "herdr_session_help",
  "herdr_version",
  "herdr_workspace_help",
  "herdr_worktree_help",
  "node_version",
] as const;

const SourceIdentitySchema = z.strictObject({
  commit: z.string().regex(/^[a-f0-9]{40}$/u),
  digest: SHA256Schema,
  clean: z.literal(true),
});
export type HerdrSourceIdentity = z.infer<typeof SourceIdentitySchema>;

const ToolReceiptSchema = z.strictObject({
  id: z.enum(["node", "git", "herdr", "codex"]),
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
  executable: z.enum(["node", "git", "herdr", "codex"]),
  args: z.array(z.string().max(512)).max(32),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  outcome: z.enum(["success", "exit_nonzero", "timed_out", "spawn_error"]),
  timeoutCleanup: z.enum([
    "not_applicable",
    "process_tree_terminated",
    "not_proven",
  ]),
  outputHash: SHA256Schema,
});

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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function computeShanghaiBusinessDeadline(
  startedAt: string,
  workingDays: number,
): string {
  const started = new Date(startedAt);
  if (
    Number.isNaN(started.valueOf())
    || !Number.isSafeInteger(workingDays)
    || workingDays < 1
    || workingDays > 31
  ) {
    throw new Error("TIMEBOX_INPUT_INVALID");
  }
  const shanghaiOffsetMs = 8 * 60 * 60 * 1_000;
  const cursor = new Date(started.valueOf() + shanghaiOffsetMs);
  let remaining = workingDays;
  while (remaining > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return new Date(cursor.valueOf() - shanghaiOffsetMs).toISOString();
}

function inventoryMatches(
  observed: readonly string[],
  expected: readonly string[],
): boolean {
  return JSON.stringify([...observed].sort())
    === JSON.stringify([...expected].sort());
}

export const HerdrControlPlaneBaselineSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    evidenceType: z.literal("herdr_control_plane_baseline"),
    generatedAt: z.iso.datetime(),
    generator: z.strictObject({
      name: z.literal("hunter-herdr-control-plane-baseline"),
      version: z.literal("0.1.0"),
    }),
    timebox: z.strictObject({
      timezone: z.literal("Asia/Shanghai"),
      workingDays: z.literal(5),
      startedAt: z.literal(HERDR_REPLACEMENT_TIMEBOX_STARTED_AT),
      deadlineAt: z.literal(HERDR_REPLACEMENT_TIMEBOX_DEADLINE_AT),
    }),
    source: SourceIdentitySchema.extend({
      digestAlgorithm: z.literal("sha256-path-content-v1"),
      pathspec: z.tuple(
        HERDR_CONTROL_PLANE_SOURCE_PATHSPEC.map((entry) => z.literal(entry)) as [
          z.ZodLiteral<
            (typeof HERDR_CONTROL_PLANE_SOURCE_PATHSPEC)[number]
          >,
          ...z.ZodLiteral<
            (typeof HERDR_CONTROL_PLANE_SOURCE_PATHSPEC)[number]
          >[],
        ],
      ),
    }),
    host: z.strictObject({
      platform: z.string().min(1).max(64),
      architecture: z.string().min(1).max(64),
      release: z.string().min(1).max(128),
    }),
    selectedAgent: z.literal("codex"),
    release: z.strictObject({
      stable: z.literal(HERDR_STABLE_RELEASE),
      windowsPreview: z.literal(HERDR_WINDOWS_PREVIEW_RELEASE),
    }),
    assetIntegrity: z.strictObject({
      algorithm: z.literal("sha256"),
      expected: z.literal(HERDR_WINDOWS_PREVIEW_RELEASE.sha256),
      actual: SHA256Schema,
      expectedSize: z.literal(HERDR_WINDOWS_PREVIEW_RELEASE.size),
      actualSize: z.number().int().nonnegative(),
      temporaryDirectoryVerified: z.literal(true),
      status: z.enum(["PASS", "BLOCKED"]),
    }),
    downloadPolicy: z.strictObject({
      sourceUrl: z.literal(HERDR_WINDOWS_PREVIEW_RELEASE.downloadUrl),
      temporaryDirectoryOnly: z.literal(true),
      globalInstall: z.literal(false),
      pipeToShell: z.literal(false),
      executionPolicyBypass: z.literal(false),
    }),
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
        z.literal("docs/validation/orca-public-adapter-gate.md"),
      ]),
    }),
    task0Verdict: z.enum(["PASS", "BLOCKED"]),
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
    const inventories = [
      [
        evidence.tools.map(({ id }) => id),
        EXPECTED_TOOL_IDS,
        "TOOL_INVENTORY_MISMATCH",
        "tools",
      ],
      [
        evidence.publicInterfaces.map(({ operation }) => operation),
        EXPECTED_PUBLIC_INTERFACE_OPERATIONS,
        "PUBLIC_INTERFACE_INVENTORY_MISMATCH",
        "publicInterfaces",
      ],
      [
        evidence.capabilities.map(({ id }) => id),
        EXPECTED_CAPABILITY_IDS,
        "CAPABILITY_INVENTORY_MISMATCH",
        "capabilities",
      ],
      [
        evidence.commandReceipts.map(({ operation }) => operation),
        EXPECTED_COMMAND_OPERATIONS,
        "COMMAND_RECEIPT_INVENTORY_MISMATCH",
        "commandReceipts",
      ],
    ] as const;
    for (const [observed, expected, message, path] of inventories) {
      if (!inventoryMatches(observed, expected)) {
        context.addIssue({ code: "custom", path: [path], message });
      }
      if (new Set(observed).size !== observed.length) {
        context.addIssue({
          code: "custom",
          path: [path],
          message: `${message}_DUPLICATE`,
        });
      }
    }

    const requiredTask0Capabilities = [
      "asset_integrity",
      "windows_binary_launch",
      "fixed_version",
      "public_schema",
      "public_inventory",
    ];
    const task0Pass =
      evidence.assetIntegrity.status === "PASS"
      && evidence.host.platform === "win32"
      && evidence.host.architecture === "x64"
      && requiredTask0Capabilities.every(
        (id) =>
          evidence.capabilities.find((capability) => capability.id === id)
            ?.status === "PASS",
      );
    if (evidence.task0Verdict !== (task0Pass ? "PASS" : "BLOCKED")) {
      context.addIssue({
        code: "custom",
        path: ["task0Verdict"],
        message: "TASK0_VERDICT_MISMATCH",
      });
    }

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
      JSON.stringify(
        canonicalize({ ...withoutFingerprint, generatedAt: undefined }),
      ),
    );
    if (contentFingerprint !== expectedFingerprint) {
      context.addIssue({
        code: "custom",
        path: ["contentFingerprint"],
        message: "CONTENT_FINGERPRINT_MISMATCH",
      });
    }
  });

export type HerdrControlPlaneBaseline = z.infer<
  typeof HerdrControlPlaneBaselineSchema
>;

export interface HerdrControlPlaneBaselineInput {
  readonly generatedAt: string;
  readonly timeboxStartedAt: string;
  readonly source: HerdrSourceIdentity;
  readonly host: HerdrControlPlaneBaseline["host"];
  readonly asset: {
    readonly actualSha256: string;
    readonly actualSize: number;
    readonly temporaryDirectoryVerified: boolean;
  };
  readonly tools: HerdrControlPlaneBaseline["tools"];
  readonly publicInterfaces: HerdrControlPlaneBaseline["publicInterfaces"];
  readonly capabilities: HerdrControlPlaneBaseline["capabilities"];
  readonly commandReceipts: HerdrControlPlaneBaseline["commandReceipts"];
}

export interface HerdrControlPlaneBaselineCollectionOptions {
  readonly runner: CommandRunner;
  readonly cwd: string;
  readonly herdrExecutable: string;
  readonly herdrEnvironment?: Readonly<Record<string, string>>;
  readonly codexExecutable: string;
  readonly codexPrefixArguments?: readonly string[];
  readonly now: () => Date;
  readonly timeboxStartedAt: string;
  readonly source: HerdrSourceIdentity;
  readonly host: HerdrControlPlaneBaseline["host"];
  readonly asset: HerdrControlPlaneBaselineInput["asset"];
}

export interface HerdrSourceInspectionOptions {
  readonly cwd: string;
  readonly pathspec: readonly string[];
}

export interface HerdrSourceInspection {
  readonly commit: string;
  readonly digest: string;
  readonly clean: boolean;
}

function gitOutput(
  cwd: string,
  args: readonly string[],
  encoding: "utf8",
): string {
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
      entry.length === 0
      || entry.length > 512
      || isAbsolute(entry)
      || entry === ".."
      || entry.startsWith(`..${sep}`)
      || entry.includes("\u0000")
    ) {
      throw new Error("SOURCE_PATHSPEC_INVALID");
    }
    return entry;
  });
}

export function inspectHerdrControlPlaneSource(
  options: HerdrSourceInspectionOptions,
): HerdrSourceInspection {
  const repositoryRoot = resolve(options.cwd);
  const pathspec = validateSourcePathspec(options.pathspec);
  const commit = gitOutput(
    repositoryRoot,
    ["rev-parse", "HEAD"],
    "utf8",
  ).trim();
  const status = gitOutput(
    repositoryRoot,
    [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      ...pathspec,
    ],
    "utf8",
  ).trim();
  const listed = gitOutput(
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
  )
    .split("\u0000")
    .filter(Boolean)
    .sort();
  const digest = createHash("sha256");
  for (const repositoryPath of listed) {
    const absolutePath = resolve(repositoryRoot, repositoryPath);
    const segment = relative(repositoryRoot, absolutePath);
    if (
      segment === ""
      || segment === ".."
      || segment.startsWith(`..${sep}`)
      || isAbsolute(segment)
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
  };
}

export function resolveHerdrBaselineOutputPath(
  repositoryRootInput: string,
  outputInput: string,
): string {
  const repositoryRoot = resolve(repositoryRootInput);
  const evidenceRoot = resolve(
    repositoryRoot,
    "docs",
    "validation",
    "evidence",
    "herdr-control-plane",
  );
  const outputPath = resolve(repositoryRoot, outputInput);
  const segment = relative(evidenceRoot, outputPath);
  if (
    segment === ""
    || segment === ".."
    || segment.startsWith(`..${sep}`)
    || isAbsolute(segment)
    || !outputPath.endsWith(".json")
  ) {
    throw new Error("HERDR_BASELINE_OUTPUT_OUTSIDE_ALLOWED_ROOT");
  }
  return outputPath;
}

export function prepareHerdrBaselineEvidenceOutput(
  outputPathInput: string,
): string | null {
  const outputPath = resolve(outputPathInput);
  if (!existsSync(outputPath)) return null;
  const contents = readFileSync(outputPath);
  const extension = extname(outputPath) || ".json";
  const stem = basename(outputPath, extname(outputPath));
  const archiveRoot = resolve(dirname(outputPath), `${stem}.attempts`);
  const archivePath = resolve(
    archiveRoot,
    `${createHash("sha256").update(contents).digest("hex")}${extension}`,
  );
  mkdirSync(archiveRoot, { recursive: true });
  if (existsSync(archivePath)) {
    if (!readFileSync(archivePath).equals(contents)) {
      throw new Error("HERDR_BASELINE_EVIDENCE_HASH_COLLISION");
    }
    unlinkSync(outputPath);
    return archivePath;
  }
  renameSync(outputPath, archivePath);
  return archivePath;
}

export function resolveHerdrTemporaryRoots(
  repositoryRootInput: string,
): readonly string[] {
  const repositoryRoot = resolve(repositoryRootInput);
  return [
    ...new Set([
      resolve(tmpdir()),
      resolve(parse(repositoryRoot).root, "tmp"),
    ]),
  ];
}

function pathIsWithinRoot(pathInput: string, rootInput: string): boolean {
  const segment = relative(resolve(rootInput), resolve(pathInput));
  return (
    segment !== ""
    && segment !== ".."
    && !segment.startsWith(`..${sep}`)
    && !isAbsolute(segment)
  );
}

export function resolveDefaultHerdrAssetPath(
  repositoryRootInput: string,
): string {
  const candidates = resolveHerdrTemporaryRoots(repositoryRootInput).map(
    (root) =>
      resolve(
        root,
        "hunter-herdr-v0.7.5-preview",
        HERDR_WINDOWS_PREVIEW_RELEASE.assetName,
      ),
  );
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

export function inspectHerdrAsset(
  assetPathInput: string,
  temporaryRoots: readonly string[] = resolveHerdrTemporaryRoots(process.cwd()),
): HerdrControlPlaneBaselineInput["asset"] {
  const assetPath = resolve(assetPathInput);
  if (
    temporaryRoots.length === 0
    || !temporaryRoots.some((root) => pathIsWithinRoot(assetPath, root))
  ) {
    throw new Error("HERDR_ASSET_OUTSIDE_TEMPORARY_DIRECTORY");
  }
  const stat = lstatSync(assetPath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error("HERDR_ASSET_INVALID");
  }
  return {
    actualSha256: createHash("sha256")
      .update(readFileSync(assetPath))
      .digest("hex"),
    actualSize: stat.size,
    temporaryDirectoryVerified: true,
  };
}

export interface HerdrBaselineArguments {
  readonly output: string;
  readonly asset: string | null;
}

export function parseHerdrBaselineArguments(
  argv: readonly string[],
): HerdrBaselineArguments {
  if (argv.length !== 2 && argv.length !== 4) {
    throw new Error("HERDR_BASELINE_USAGE");
  }
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      (flag !== "--output" && flag !== "--asset")
      || value === undefined
      || value.trim().length === 0
      || values.has(flag)
    ) {
      throw new Error("HERDR_BASELINE_USAGE");
    }
    values.set(flag, value);
  }
  const output = values.get("--output");
  const asset = values.get("--asset");
  if (output === undefined) {
    throw new Error("HERDR_BASELINE_USAGE");
  }
  return { output, asset: asset ?? null };
}

const BaselineTimeboxFragmentSchema = z.object({
  timebox: z.object({ startedAt: z.iso.datetime() }),
});

export function findHerdrBaselineTimeboxStart(
  outputPathInput: string,
  fallbackInput: string,
): string {
  const fallback = z.iso.datetime().parse(fallbackInput);
  const outputPath = resolve(outputPathInput);
  const extension = extname(outputPath) || ".json";
  const stem = basename(outputPath, extname(outputPath));
  const archiveRoot = resolve(dirname(outputPath), `${stem}.attempts`);
  const candidates = existsSync(outputPath) ? [outputPath] : [];
  if (existsSync(archiveRoot)) {
    for (const entry of readdirSync(archiveRoot, { withFileTypes: true })) {
      if (
        entry.isFile()
        && new RegExp(`^[a-f0-9]{64}\\${extension}$`, "u").test(entry.name)
      ) {
        candidates.push(resolve(archiveRoot, entry.name));
      }
    }
  }

  let earliest = fallback;
  let invalidHistory = false;
  for (const candidate of candidates) {
    try {
      const contents = readFileSync(candidate, "utf8");
      if (Buffer.byteLength(contents) > 1024 * 1024) {
        invalidHistory = true;
        continue;
      }
      const parsed = BaselineTimeboxFragmentSchema.safeParse(
        JSON.parse(contents) as unknown,
      );
      if (!parsed.success) {
        invalidHistory = true;
        continue;
      }
      if (
        new Date(parsed.data.timebox.startedAt).valueOf()
        < new Date(earliest).valueOf()
      ) {
        earliest = parsed.data.timebox.startedAt;
      }
    } catch {
      invalidHistory = true;
    }
  }
  if (invalidHistory) {
    throw new Error("HERDR_BASELINE_TIMEBOX_HISTORY_INVALID");
  }
  return earliest;
}

export function createHerdrControlPlaneBaseline(
  input: HerdrControlPlaneBaselineInput,
): HerdrControlPlaneBaseline {
  if (input.timeboxStartedAt !== HERDR_REPLACEMENT_TIMEBOX_STARTED_AT) {
    throw new Error("HERDR_REPLACEMENT_TIMEBOX_RESET");
  }
  const assetStatus =
    input.asset.actualSha256 === HERDR_WINDOWS_PREVIEW_RELEASE.sha256
    && input.asset.actualSize === HERDR_WINDOWS_PREVIEW_RELEASE.size
    && input.asset.temporaryDirectoryVerified
      ? ("PASS" as const)
      : ("BLOCKED" as const);
  const requiredTask0Capabilities = [
    "asset_integrity",
    "windows_binary_launch",
    "fixed_version",
    "public_schema",
    "public_inventory",
  ];
  const task0Verdict =
    assetStatus === "PASS"
    && input.host.platform === "win32"
    && input.host.architecture === "x64"
    && requiredTask0Capabilities.every(
      (id) =>
        input.capabilities.find((capability) => capability.id === id)?.status
          === "PASS",
    )
      ? ("PASS" as const)
      : ("BLOCKED" as const);
  const withoutFingerprint = {
    schemaVersion: 1 as const,
    evidenceType: "herdr_control_plane_baseline" as const,
    generatedAt: input.generatedAt,
    generator: {
      name: "hunter-herdr-control-plane-baseline" as const,
      version: "0.1.0" as const,
    },
    timebox: {
      timezone: "Asia/Shanghai" as const,
      workingDays: 5 as const,
      startedAt: input.timeboxStartedAt,
      deadlineAt: computeShanghaiBusinessDeadline(input.timeboxStartedAt, 5),
    },
    source: {
      ...input.source,
      digestAlgorithm: "sha256-path-content-v1" as const,
      pathspec: HERDR_CONTROL_PLANE_SOURCE_PATHSPEC,
    },
    host: input.host,
    selectedAgent: "codex" as const,
    release: {
      stable: HERDR_STABLE_RELEASE,
      windowsPreview: HERDR_WINDOWS_PREVIEW_RELEASE,
    },
    assetIntegrity: {
      algorithm: "sha256" as const,
      expected: HERDR_WINDOWS_PREVIEW_RELEASE.sha256,
      actual: input.asset.actualSha256,
      expectedSize: HERDR_WINDOWS_PREVIEW_RELEASE.size,
      actualSize: input.asset.actualSize,
      temporaryDirectoryVerified: input.asset.temporaryDirectoryVerified,
      status: assetStatus,
    },
    downloadPolicy: {
      sourceUrl: HERDR_WINDOWS_PREVIEW_RELEASE.downloadUrl,
      temporaryDirectoryOnly: true as const,
      globalInstall: false as const,
      pipeToShell: false as const,
      executionPolicyBypass: false as const,
    },
    tools: input.tools,
    publicInterfaces: input.publicInterfaces,
    capabilities: input.capabilities,
    commandReceipts: input.commandReceipts,
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
        "docs/validation/orca-public-adapter-gate.md",
      ] as const,
    },
    task0Verdict,
    providerVerdict: "NOT_PROVEN" as const,
    proofScope: "local_inventory_only" as const,
    mutationAttempted: false as const,
    redaction: { applied: true as const, schemaVersion: 1 as const },
  };
  const contentFingerprint = sha256(
    JSON.stringify(
      canonicalize({ ...withoutFingerprint, generatedAt: undefined }),
    ),
  );
  return HerdrControlPlaneBaselineSchema.parse({
    ...withoutFingerprint,
    contentFingerprint,
  });
}

const NonEmptyJsonObjectSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => Object.keys(value).length > 0);

const HerdrApiSchemaReceiptSchema = z.strictObject({
  $schema: z.literal("https://json-schema.org/draft/2020-12/schema"),
  protocol: z.literal(17),
  schema_version: z.literal(1),
  schemas: z.strictObject({
    error_response: NonEmptyJsonObjectSchema,
    event: NonEmptyJsonObjectSchema,
    request: NonEmptyJsonObjectSchema,
    subscription_event: NonEmptyJsonObjectSchema,
    success_response: NonEmptyJsonObjectSchema,
  }),
  title: z.literal("Herdr API"),
});

export interface HerdrApiSchemaInspection {
  readonly canonicalSha256: string | null;
  readonly matchesPinnedSchema: boolean;
  readonly parsed: z.infer<typeof HerdrApiSchemaReceiptSchema> | null;
}

export function inspectHerdrApiSchemaDocument(
  stdout: string,
  expectedSha256: string = HERDR_API_SCHEMA_CANONICAL_SHA256,
): HerdrApiSchemaInspection {
  try {
    const parsedJson = JSON.parse(stdout) as unknown;
    const parsed = HerdrApiSchemaReceiptSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return {
        canonicalSha256: null,
        matchesPinnedSchema: false,
        parsed: null,
      };
    }
    const canonicalSha256 = sha256(
      JSON.stringify(canonicalize(parsed.data)),
    );
    return {
      canonicalSha256,
      matchesPinnedSchema: canonicalSha256 === expectedSha256,
      parsed: parsed.data,
    };
  } catch {
    return {
      canonicalSha256: null,
      matchesPinnedSchema: false,
      parsed: null,
    };
  }
}

function commandSucceeded(result: CommandResult): boolean {
  return result.exitCode === 0 && !result.timedOut && result.spawnError == null;
}

function commandHash(result: CommandResult, projection?: unknown): string {
  const value =
    projection === undefined
      ? `${result.stdout}\n${result.stderr}`.replace(/\r\n/gu, "\n").trim()
      : JSON.stringify(canonicalize(projection));
  return sha256(redact(value));
}

function parseVersion(
  result: CommandResult,
  product: "node" | "git" | "herdr" | "codex",
): string | null {
  if (!commandSucceeded(result)) return null;
  const firstLine = redact(result.stdout).trim().split(/\r?\n/u, 1)[0] ?? "";
  const pattern =
    product === "node"
      ? /^v?([0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?)$/u
      : product === "git"
        ? /^git version ([0-9]+(?:\.[0-9]+){1,3}(?:\.[A-Za-z0-9.-]+)?)$/iu
        : product === "herdr"
          ? /^herdr ([0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?)$/u
          : /\b([0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?)\b/u;
  return pattern.exec(firstLine)?.[1] ?? null;
}

export async function collectHerdrControlPlaneBaseline(
  options: HerdrControlPlaneBaselineCollectionOptions,
): Promise<HerdrControlPlaneBaseline> {
  const run = async (
    executable: string,
    args: readonly string[],
    timeoutMs = 10_000,
    environment?: Readonly<Record<string, string>>,
    maxCaptureBytes?: number,
  ): Promise<CommandResult> =>
    await options.runner.run({
      executable,
      args,
      cwd: options.cwd,
      timeoutMs,
      ...(environment === undefined ? {} : { environment }),
      ...(maxCaptureBytes === undefined ? {} : { maxCaptureBytes }),
    });

  const nodeVersion = await run("node", ["--version"]);
  const gitVersion = await run("git", ["--version"]);
  const runHerdr = async (
    args: readonly string[],
    timeoutMs = 10_000,
    maxCaptureBytes?: number,
  ): Promise<CommandResult> =>
    await run(
      options.herdrExecutable,
      args,
      timeoutMs,
      options.herdrEnvironment,
      maxCaptureBytes,
    );
  const herdrVersion = await runHerdr(["--version"]);
  const herdrHelp = await runHerdr(["--help"]);
  const herdrApiSchema = await runHerdr(
    ["api", "schema", "--json"],
    20_000,
    512 * 1024,
  );
  const herdrWorktreeHelp = await runHerdr(["worktree", "--help"]);
  const herdrWorkspaceHelp = await runHerdr(["workspace", "--help"]);
  const herdrSessionHelp = await runHerdr(["session", "--help"]);
  const herdrAgentHelp = await runHerdr(["agent", "--help"]);
  const codexPrefixArguments = options.codexPrefixArguments ?? [];
  const runCodex = async (args: readonly string[]): Promise<CommandResult> =>
    await run(options.codexExecutable, [...codexPrefixArguments, ...args]);
  const codexVersion = await runCodex(["--version"]);
  const codexLoginStatus = await runCodex(["login", "status"]);

  const schemaInspection = commandSucceeded(herdrApiSchema)
    ? inspectHerdrApiSchemaDocument(herdrApiSchema.stdout)
    : {
        canonicalSha256: null,
        matchesPinnedSchema: false,
        parsed: null,
      };
  const schemaProjection = {
    actualCanonicalSha256: schemaInspection.canonicalSha256,
    expectedCanonicalSha256: HERDR_API_SCHEMA_CANONICAL_SHA256,
    matchesPinnedSchema: schemaInspection.matchesPinnedSchema,
  };
  const schemaReceiptHash = commandHash(herdrApiSchema, schemaProjection);
  const observedHerdrVersion = parseVersion(herdrVersion, "herdr");
  const expectedHerdrVersion =
    "0.7.5-preview.2026-07-21-0f10e1453a7f";
  const fixedVersion = observedHerdrVersion === expectedHerdrVersion;
  const assetIntegrity =
    options.asset.actualSha256 === HERDR_WINDOWS_PREVIEW_RELEASE.sha256
    && options.asset.actualSize === HERDR_WINDOWS_PREVIEW_RELEASE.size
    && options.asset.temporaryDirectoryVerified;
  const windowsX64Host =
    options.host.platform === "win32" && options.host.architecture === "x64";
  const inventoryChecks = [
    [
      herdrHelp,
      [
        "herdr api <subcommand>",
        "herdr worktree <subcommand>",
        "herdr workspace <subcommand>",
        "herdr session <subcommand>",
        "herdr agent <subcommand>",
      ],
    ],
    [
      herdrWorktreeHelp,
      ["git worktree-backed workspaces", "open", "existing git worktree"],
    ],
    [
      herdrWorkspaceHelp,
      ["workspaces over the socket api", "close", "close a workspace"],
    ],
    [
      herdrSessionHelp,
      ["named persistent sessions", "list", "attach", "stop", "delete"],
    ],
    [
      herdrAgentHelp,
      ["control and inspect agent panes", "start", "prompt", "wait"],
    ],
  ];
  const inventoryResultIsValid = (
    result: CommandResult,
    requiredTokens: readonly string[],
  ): boolean => {
    if (!commandSucceeded(result)) return false;
    const normalized = result.stdout.replace(/\s+/gu, " ").toLowerCase();
    return requiredTokens.every((token) =>
      normalized.includes(token.toLowerCase()));
  };
  const publicInventory = inventoryChecks.every(([result, tokens]) =>
    inventoryResultIsValid(
      result as CommandResult,
      tokens as readonly string[],
    ));

  const logicalCommands = [
    ["node_version", "node", ["--version"], nodeVersion],
    ["git_version", "git", ["--version"], gitVersion],
    ["herdr_version", "herdr", ["--version"], herdrVersion],
    ["herdr_help", "herdr", ["--help"], herdrHelp],
    [
      "herdr_api_schema",
      "herdr",
      ["api", "schema", "--json"],
      herdrApiSchema,
    ],
    [
      "herdr_worktree_help",
      "herdr",
      ["worktree", "--help"],
      herdrWorktreeHelp,
    ],
    [
      "herdr_workspace_help",
      "herdr",
      ["workspace", "--help"],
      herdrWorkspaceHelp,
    ],
    [
      "herdr_session_help",
      "herdr",
      ["session", "--help"],
      herdrSessionHelp,
    ],
    [
      "herdr_agent_help",
      "herdr",
      ["agent", "--help"],
      herdrAgentHelp,
    ],
    ["codex_version", "codex", ["--version"], codexVersion],
    [
      "codex_login_status",
      "codex",
      ["login", "status"],
      codexLoginStatus,
    ],
  ] as const;
  const commandReceipts = logicalCommands.map(
    ([operation, executable, args, result]) => ({
      operation,
      executable,
      args: [...args],
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      outcome: result.timedOut
        ? ("timed_out" as const)
        : result.spawnError != null
          ? ("spawn_error" as const)
          : result.exitCode === 0
            ? ("success" as const)
            : ("exit_nonzero" as const),
      timeoutCleanup:
        result.timeoutCleanup
        ?? (result.timedOut ? "not_proven" : "not_applicable"),
      outputHash:
        operation === "herdr_api_schema"
          ? schemaReceiptHash
          : commandHash(result),
    }),
  );
  const interfaceReceipts = [
    ["root_help", herdrHelp, inventoryChecks[0]![1]],
    ["api_schema", herdrApiSchema, null],
    ["worktree_inventory", herdrWorktreeHelp, inventoryChecks[1]![1]],
    ["workspace_inventory", herdrWorkspaceHelp, inventoryChecks[2]![1]],
    ["session_inventory", herdrSessionHelp, inventoryChecks[3]![1]],
    ["agent_inventory", herdrAgentHelp, inventoryChecks[4]![1]],
  ] as const;
  const publicInterfaces = interfaceReceipts.map(
    ([operation, result, requiredTokens]) => {
      const detected =
        operation === "api_schema"
          ? schemaInspection.matchesPinnedSchema
          : inventoryResultIsValid(result, requiredTokens ?? []);
      return {
        operation,
        status: detected
          ? ("DETECTED" as const)
          : ("NOT_PROVEN" as const),
        receiptHash: detected
          ? operation === "api_schema"
            ? schemaReceiptHash
            : commandHash(result)
          : null,
      };
    },
  );

  const capability = (
    id: string,
    passed: boolean,
    passReason: string,
    blockedReason: string,
    receiptHash: string,
  ) => ({
    id,
    status: passed ? ("PASS" as const) : ("BLOCKED" as const),
    reason: passed ? passReason : blockedReason,
    receiptHash: passed ? receiptHash : null,
  });
  const assetReceiptHash = sha256(
    JSON.stringify({
      actualSha256: options.asset.actualSha256,
      actualSize: options.asset.actualSize,
      expectedSha256: HERDR_WINDOWS_PREVIEW_RELEASE.sha256,
      expectedSize: HERDR_WINDOWS_PREVIEW_RELEASE.size,
    }),
  );
  const herdrVersionHash = commandHash(herdrVersion);
  const inventoryReceiptHash = sha256(
    JSON.stringify(
      interfaceReceipts.map(([operation, result]) => ({
        operation,
        outputHash:
          operation === "api_schema"
            ? schemaReceiptHash
            : commandHash(result),
      })),
    ),
  );

  return createHerdrControlPlaneBaseline({
    generatedAt: options.now().toISOString(),
    timeboxStartedAt: options.timeboxStartedAt,
    source: options.source,
    host: options.host,
    asset: options.asset,
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
        id: "herdr",
        availability: commandSucceeded(herdrVersion) ? "DETECTED" : "BLOCKED",
        version: observedHerdrVersion,
        authentication: "DETECTED",
        authenticationRequired: false,
      },
      {
        id: "codex",
        availability: commandSucceeded(codexVersion) ? "DETECTED" : "BLOCKED",
        version: parseVersion(codexVersion, "codex"),
        authentication: commandSucceeded(codexLoginStatus)
          ? "DETECTED"
          : commandSucceeded(codexVersion)
            ? "NOT_PROVEN"
            : "BLOCKED",
        authenticationRequired: true,
      },
    ],
    publicInterfaces,
    capabilities: [
      capability(
        "asset_integrity",
        assetIntegrity,
        "official_preview_asset_sha256_and_size_match",
        "official_preview_asset_integrity_mismatch",
        assetReceiptHash,
      ),
      capability(
        "windows_binary_launch",
        windowsX64Host && commandSucceeded(herdrVersion),
        "windows_binary_returned_version",
        windowsX64Host
          ? "windows_binary_version_command_failed"
          : "real_windows_x64_host_required",
        herdrVersionHash,
      ),
      capability(
        "fixed_version",
        fixedVersion,
        "exact_preview_version_matches_pinned_release",
        "windows_binary_version_mismatch",
        herdrVersionHash,
      ),
      capability(
        "public_schema",
        schemaInspection.matchesPinnedSchema,
        "protocol_17_schema_1_full_hash_matches",
        "public_schema_invalid_or_unavailable",
        schemaReceiptHash,
      ),
      capability(
        "public_inventory",
        publicInventory,
        "all_read_only_help_inventory_commands_succeeded",
        "public_help_inventory_incomplete",
        inventoryReceiptHash,
      ),
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
        reason: "manual_fail_closed_agent_launch_not_run",
        receiptHash: null,
      },
    ],
    commandReceipts,
  });
}

function writeHerdrBaselineEvidenceAtomic(
  outputPath: string,
  serialized: string,
): void {
  if (existsSync(outputPath)) {
    throw new Error("HERDR_BASELINE_EVIDENCE_ALREADY_EXISTS");
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
    throw new Error("HERDR_BASELINE_EVIDENCE_WRITE_FAILED", { cause: error });
  }
}

function findFileOnPath(fileName: string): string | null {
  const pathValue = process.env.PATH;
  if (pathValue === undefined) return null;
  for (const rawDirectory of pathValue.split(delimiter)) {
    const directory = rawDirectory.trim().replace(/^"|"$/gu, "");
    if (directory.length === 0) continue;
    const candidate = join(directory, fileName);
    try {
      if (existsSync(candidate) && lstatSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // An unreadable PATH entry is not an executable candidate.
    }
  }
  return null;
}

async function main(): Promise<void> {
  const repositoryRoot = process.cwd();
  const args = parseHerdrBaselineArguments(process.argv.slice(2));
  const outputPath = resolveHerdrBaselineOutputPath(
    repositoryRoot,
    args.output,
  );
  const generatedAt = new Date();
  const timeboxStartedAt = findHerdrBaselineTimeboxStart(
    outputPath,
    HERDR_REPLACEMENT_TIMEBOX_STARTED_AT,
  );
  const sourceInspection = inspectHerdrControlPlaneSource({
    cwd: repositoryRoot,
    pathspec: HERDR_CONTROL_PLANE_SOURCE_PATHSPEC,
  });
  if (!sourceInspection.clean) {
    throw new Error("HERDR_CONTROL_PLANE_SOURCE_NOT_CLEAN");
  }
  const source = SourceIdentitySchema.parse(sourceInspection);
  const assetPath =
    args.asset === null
      ? resolveDefaultHerdrAssetPath(repositoryRoot)
      : resolve(args.asset);
  const asset = inspectHerdrAsset(
    assetPath,
    resolveHerdrTemporaryRoots(repositoryRoot),
  );

  const configuredCodexCommand = process.env.CODEX_CLI_COMMAND?.trim();
  const codexScript =
    configuredCodexCommand === undefined && process.platform === "win32"
      ? findFileOnPath("codex.ps1")
      : null;
  const evidence = await collectHerdrControlPlaneBaseline({
    runner: new NodeCommandRunner(),
    cwd: repositoryRoot,
    herdrExecutable: assetPath,
    herdrEnvironment: {
      HERDR_SESSION: "hunter-task0-readonly",
      HERDR_CONFIG_PATH: join(dirname(assetPath), "hunter-task0-config.toml"),
    },
    codexExecutable:
      configuredCodexCommand
      ?? (codexScript === null ? "codex" : "powershell.exe"),
    ...(codexScript === null
      ? {}
      : {
          codexPrefixArguments: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-File",
            codexScript,
          ],
        }),
    now: () => generatedAt,
    timeboxStartedAt,
    source,
    host: {
      platform: process.platform,
      architecture: arch(),
      release: release(),
    },
    asset,
  });
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  assertSafeEvidence(serialized);
  prepareHerdrBaselineEvidenceOutput(outputPath);
  writeHerdrBaselineEvidenceAtomic(outputPath, serialized);
  const states = evidence.tools
    .map(
      (tool) =>
        `${tool.id}=${tool.availability}/${tool.authentication}`,
    )
    .join(",");
  process.stdout.write(
    `Herdr control-plane baseline: task0=${evidence.task0Verdict} provider=${evidence.providerVerdict} tools=${states}\n`,
  );
  if (evidence.task0Verdict !== "PASS") process.exitCode = 2;
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined
  && resolve(entryPoint) === resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `Herdr control-plane baseline failed: ${redact(message)}\n`,
    );
    process.exitCode = 1;
  });
}
