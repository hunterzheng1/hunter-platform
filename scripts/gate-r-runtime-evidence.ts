import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CapabilityProbeReceiptIdSchema,
  ConnectorIdSchema,
  EvidenceIdSchema,
} from "@hunter/domain";
import {
  CapabilityManifestSchema,
  CapabilityProbeReceiptSchema,
  computeCapabilityManifest,
  type AtomicCapability,
  type CapabilityProbeStatus,
  type CurrentCapabilityProbeReceipt,
} from "@hunter/runtime-contracts";
import { EvidenceEnvelopeSchema, assertSafeEvidence } from "@hunter/spike-testkit";
import { z } from "zod";
import { DirectCodexEvidenceSchema } from "../spikes/codex/src/scenario.js";
import { OrcaPreflightEvidenceSchema } from "../spikes/orca/src/scenario.js";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const OutcomeSchema = z.enum(["PASS", "FAIL", "BLOCKED", "NOT_PROVEN"]);

interface InventoryInput {
  readonly generatedAt: string;
  readonly host: { readonly platform: string };
  readonly contentFingerprint: string;
  readonly probes: readonly {
    readonly id: string;
    readonly version: string | null;
    readonly availability: { readonly status: "DETECTED" | "BLOCKED" | "NOT_PROVEN" };
  }[];
}

interface CodexInput {
  readonly generatedAt: string;
  readonly installedVersion: string | null;
  readonly loginAvailable: boolean;
  readonly helpHashes: { readonly exec: string | null };
  readonly contentFingerprint: string;
  readonly capabilities: readonly {
    readonly id: string;
    readonly outcome: "PASS" | "FAIL" | "BLOCKED" | "NOT_PROVEN";
  }[];
}

interface OrcaInput {
  readonly generatedAt: string;
  readonly providerVerdict: "NOT_PROVEN";
  readonly mutationAttempted: false;
  readonly contentFingerprint: string;
  readonly capabilities: readonly {
    readonly id: string;
    readonly outcome: "PASS" | "FAIL" | "BLOCKED" | "NOT_PROVEN";
    readonly reason: string;
  }[];
}

export const OrcaLauncherAttemptEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  evidenceType: z.literal("gate_r_orca_open_launcher_attempt"),
  recordedAt: z.iso.datetime(),
  attemptedAt: z.null(),
  command: z.strictObject({
    executable: z.literal("[PRIVATE_PATH]"),
    args: z.tuple([z.literal("open"), z.literal("--json")]),
    cwdScope: z.literal("repository"),
  }),
  durationLowerBoundMs: z.number().int().min(90_000),
  launcher: z.strictObject({
    outcome: z.literal("FAIL"),
    timedOut: z.literal(true),
    exitCode: z.null(),
    outputCaptured: z.literal(false),
    cleanup: z.literal("exact_launcher_terminated"),
  }),
  runtimeAfterLauncher: z.strictObject({
    status: z.literal("ready"),
    sourceEvidenceDigest: DigestSchema,
  }),
  mutationAttempted: z.literal(false),
  stepSuccessInferred: z.literal(false),
  redaction: z.strictObject({
    applied: z.literal(true),
    schemaVersion: z.literal(1),
  }),
  contentFingerprint: DigestSchema,
}).superRefine((value, context) => {
  const { contentFingerprint, ...withoutFingerprint } = value;
  const expected = sha256(JSON.stringify(canonicalize({
    ...withoutFingerprint,
    recordedAt: undefined,
  })));
  if (contentFingerprint !== expected) {
    context.addIssue({
      code: "custom",
      path: ["contentFingerprint"],
      message: "CONTENT_FINGERPRINT_MISMATCH",
    });
  }
});
export type OrcaLauncherAttemptEvidence = z.infer<
  typeof OrcaLauncherAttemptEvidenceSchema
>;

export const GateRRuntimeEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  evidenceType: z.literal("gate_r_runtime_connector_validation"),
  generatedAt: z.iso.datetime(),
  generator: z.strictObject({
    name: z.literal("hunter-gate-r-runtime-validation"),
    version: z.literal("0.1.0"),
  }),
  overallVerdict: z.literal("NOT_PROVEN"),
  proofScope: z.literal("local_runtime_and_connector_receipts"),
  sourceEvidence: z.strictObject({
    inventory: DigestSchema,
    codex: DigestSchema,
    orca: DigestSchema,
    orcaLauncher: DigestSchema,
  }),
  provider: z.strictObject({
    provider: z.literal("orca"),
    verdict: z.literal("NOT_PROVEN"),
    mutationAttempted: z.literal(false),
    launcherAttempt: OrcaLauncherAttemptEvidenceSchema,
    capabilities: z.array(z.strictObject({
      id: z.string().min(1),
      outcome: OutcomeSchema,
      reason: z.string().min(1),
    })),
  }),
  connectors: z.array(z.strictObject({
    connector: z.enum(["codex", "codebuddy", "cursor"]),
    receipt: CapabilityProbeReceiptSchema,
    manifest: CapabilityManifestSchema,
  })).length(3),
  safety: z.strictObject({
    remoteRepositoryWriteAttempted: z.literal(false),
    providerMutationAttempted: z.literal(false),
    stepSuccessInferredFromRuntimeObservation: z.literal(false),
  }),
  redaction: z.strictObject({
    applied: z.literal(true),
    schemaVersion: z.literal(1),
  }),
  contentFingerprint: DigestSchema,
}).superRefine((value, context) => {
  const { contentFingerprint, ...withoutFingerprint } = value;
  const expected = sha256(JSON.stringify(canonicalize(
    fingerprintProjection(withoutFingerprint),
  )));
  if (contentFingerprint !== expected) {
    context.addIssue({
      code: "custom",
      path: ["contentFingerprint"],
      message: "CONTENT_FINGERPRINT_MISMATCH",
    });
  }
});

export type GateRRuntimeEvidence = z.infer<typeof GateRRuntimeEvidenceSchema>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function fingerprintProjection(
  value: Omit<GateRRuntimeEvidence, "contentFingerprint">,
): unknown {
  return {
    ...value,
    generatedAt: undefined,
    connectors: value.connectors.map((connector) => ({
      ...connector,
      manifest: {
        ...connector.manifest,
        computedAt: undefined,
      },
    })),
  };
}

function stableId(prefix: "cpr" | "evd", value: string): string {
  return `${prefix}_${sha256(value).slice(0, 24)}`;
}

export function createOrcaLauncherAttemptEvidence(input: {
  readonly recordedAt: Date;
  readonly durationLowerBoundMs: number;
  readonly sourceOrcaDigest: string;
}): OrcaLauncherAttemptEvidence {
  const withoutFingerprint = {
    schemaVersion: 1 as const,
    evidenceType: "gate_r_orca_open_launcher_attempt" as const,
    recordedAt: input.recordedAt.toISOString(),
    attemptedAt: null,
    command: {
      executable: "[PRIVATE_PATH]" as const,
      args: ["open", "--json"] as const,
      cwdScope: "repository" as const,
    },
    durationLowerBoundMs: input.durationLowerBoundMs,
    launcher: {
      outcome: "FAIL" as const,
      timedOut: true as const,
      exitCode: null,
      outputCaptured: false as const,
      cleanup: "exact_launcher_terminated" as const,
    },
    runtimeAfterLauncher: {
      status: "ready" as const,
      sourceEvidenceDigest: input.sourceOrcaDigest,
    },
    mutationAttempted: false as const,
    stepSuccessInferred: false as const,
    redaction: { applied: true as const, schemaVersion: 1 as const },
  };
  return OrcaLauncherAttemptEvidenceSchema.parse({
    ...withoutFingerprint,
    contentFingerprint: sha256(JSON.stringify(canonicalize({
      ...withoutFingerprint,
      recordedAt: undefined,
    }))),
  });
}

function validUntil(probedAt: string): string {
  return new Date(Date.parse(probedAt) + 24 * 60 * 60 * 1_000).toISOString();
}

function outcomeStatus(
  outcome: CodexInput["capabilities"][number]["outcome"],
): CapabilityProbeStatus {
  if (outcome === "PASS") return "supported";
  if (outcome === "FAIL") return "unsupported";
  return "unknown";
}

function codexReceipt(input: CodexInput): CurrentCapabilityProbeReceipt {
  const version = input.installedVersion;
  return CapabilityProbeReceiptSchema.parse({
    schemaVersion: 2,
    probeReceiptId: CapabilityProbeReceiptIdSchema.parse(
      stableId("cpr", `gate-r:codex:${input.contentFingerprint}`),
    ),
    subject: {
      kind: "connector",
      connectorId: ConnectorIdSchema.parse("con_codex_direct"),
      implementationVersion: "1.0.0",
    },
    platform: "windows",
    executable: { status: version === null ? "unknown" : "available" },
    loginState: input.loginAvailable ? "authenticated" : "unknown",
    productVersion: {
      observed: version,
      supported: ["not_proven"],
    },
    protocol: {
      kind: "codex_jsonl",
      observedVersion: null,
      supportedVersions: ["not_proven"],
      schemaVersion: null,
      supportedSchemaVersions: [0],
      schemaDigest: null,
    },
    probedAt: input.generatedAt,
    validUntil: validUntil(input.generatedAt),
    results: input.capabilities.map(({ id, outcome }, index) => ({
      capability: id as AtomicCapability,
      status: outcomeStatus(outcome),
      evidenceId: EvidenceIdSchema.parse(
        stableId("evd", `gate-r:codex:${input.contentFingerprint}:${id}:${index}`),
      ),
      evidence: {
        source: "phase0_evidence",
        digest: input.contentFingerprint,
      },
      probedAt: input.generatedAt,
    })),
  }) as CurrentCapabilityProbeReceipt;
}

function unavailableReceipt(
  connector: "codebuddy" | "cursor",
  inventory: InventoryInput,
): CurrentCapabilityProbeReceipt {
  const probe = inventory.probes.find(({ id }) => id === connector);
  const probedAt = inventory.generatedAt;
  const observedVersion = probe?.version ?? null;
  const executableStatus = probe?.availability.status === "DETECTED"
    ? "available"
    : "unknown";
  return CapabilityProbeReceiptSchema.parse({
    schemaVersion: 2,
    probeReceiptId: CapabilityProbeReceiptIdSchema.parse(
      stableId("cpr", `gate-r:${connector}:${inventory.contentFingerprint}`),
    ),
    subject: {
      kind: "connector",
      connectorId: ConnectorIdSchema.parse(
        connector === "codebuddy" ? "con_codebuddy_acp" : "con_cursor_handoff",
      ),
      implementationVersion: "1.0.0",
    },
    platform: inventory.host.platform === "win32" ? "windows" : "linux",
    executable: { status: executableStatus },
    loginState: "unknown",
    productVersion: {
      observed: observedVersion,
      supported: [observedVersion ?? "not_proven"],
    },
    protocol: {
      kind: connector === "codebuddy" ? "acp" : "native_handoff",
      observedVersion: null,
      supportedVersions: ["not_proven"],
      schemaVersion: null,
      supportedSchemaVersions: [0],
      schemaDigest: null,
    },
    probedAt,
    validUntil: validUntil(probedAt),
    results: [{
      capability: "discover",
      status: "unknown",
      evidenceId: EvidenceIdSchema.parse(
        stableId("evd", `gate-r:${connector}:${inventory.contentFingerprint}:discover`),
      ),
      evidence: {
        source: "local_probe",
        digest: inventory.contentFingerprint,
      },
      probedAt,
    }],
  }) as CurrentCapabilityProbeReceipt;
}

export function createGateRRuntimeEvidence(input: {
  readonly inventory: InventoryInput;
  readonly codex: CodexInput;
  readonly orca: OrcaInput;
  readonly orcaLauncher: OrcaLauncherAttemptEvidence;
  readonly generatedAt: Date;
}): GateRRuntimeEvidence {
  const receipts = [
    { connector: "codex" as const, receipt: codexReceipt(input.codex) },
    {
      connector: "codebuddy" as const,
      receipt: unavailableReceipt("codebuddy", input.inventory),
    },
    {
      connector: "cursor" as const,
      receipt: unavailableReceipt("cursor", input.inventory),
    },
  ];
  const connectors = receipts.map(({ connector, receipt }) => ({
    connector,
    receipt,
    manifest: computeCapabilityManifest(receipt, input.generatedAt),
  }));
  const withoutFingerprint = {
    schemaVersion: 1 as const,
    evidenceType: "gate_r_runtime_connector_validation" as const,
    generatedAt: input.generatedAt.toISOString(),
    generator: {
      name: "hunter-gate-r-runtime-validation" as const,
      version: "0.1.0" as const,
    },
    overallVerdict: "NOT_PROVEN" as const,
    proofScope: "local_runtime_and_connector_receipts" as const,
    sourceEvidence: {
      inventory: input.inventory.contentFingerprint,
      codex: input.codex.contentFingerprint,
      orca: input.orca.contentFingerprint,
      orcaLauncher: input.orcaLauncher.contentFingerprint,
    },
    provider: {
      provider: "orca" as const,
      verdict: input.orca.providerVerdict,
      mutationAttempted: input.orca.mutationAttempted,
      launcherAttempt: input.orcaLauncher,
      capabilities: input.orca.capabilities.map((capability) => ({ ...capability })),
    },
    connectors,
    safety: {
      remoteRepositoryWriteAttempted: false as const,
      providerMutationAttempted: false as const,
      stepSuccessInferredFromRuntimeObservation: false as const,
    },
    redaction: { applied: true as const, schemaVersion: 1 as const },
  };
  return GateRRuntimeEvidenceSchema.parse({
    ...withoutFingerprint,
    contentFingerprint: sha256(JSON.stringify(canonicalize(
      fingerprintProjection(withoutFingerprint),
    ))),
  });
}

function outputPath(repositoryRoot: string, args: readonly string[]): string {
  const index = args.indexOf("--output");
  const requested = index >= 0 ? args[index + 1] : undefined;
  if (requested === undefined) throw new Error("GATE_R_OUTPUT_REQUIRED");
  const evidenceRoot = resolve(
    repositoryRoot,
    "docs",
    "validation",
    "evidence",
    "gate-r1",
  );
  const target = resolve(repositoryRoot, requested);
  const segment = relative(evidenceRoot, target);
  if (
    segment === ""
    || segment === ".."
    || segment.startsWith(`..${sep}`)
    || !target.endsWith(".json")
  ) {
    throw new Error("GATE_R_OUTPUT_OUTSIDE_ALLOWED_ROOT");
  }
  return target;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main(): Promise<void> {
  const root = process.cwd();
  const inventory = EvidenceEnvelopeSchema.parse(
    await readJson(resolve(root, "docs/validation/environment-inventory.json")),
  );
  const codex = DirectCodexEvidenceSchema.parse(
    await readJson(resolve(root, "docs/validation/evidence/codex/direct-runtime.json")),
  );
  const orca = OrcaPreflightEvidenceSchema.parse(
    await readJson(resolve(root, "docs/validation/evidence/orca/preflight.json")),
  );
  const orcaLauncher = OrcaLauncherAttemptEvidenceSchema.parse(
    await readJson(resolve(
      root,
      "docs/validation/evidence/gate-r1/orca-open-attempt.json",
    )),
  );
  const evidence = createGateRRuntimeEvidence({
    inventory,
    codex,
    orca,
    orcaLauncher,
    generatedAt: new Date(),
  });
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  assertSafeEvidence(serialized);
  const target = outputPath(root, process.argv.slice(2));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, serialized, "utf8");
  process.stdout.write(
    `Gate R runtime: provider=${evidence.provider.verdict} connectors=${
      evidence.connectors.map(({ connector, manifest }) =>
        `${connector}:${manifest.level}`).join(",")
    }\n`,
  );
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined
  && resolve(entryPoint) === resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Gate R runtime failed: ${message}\n`);
    process.exitCode = 1;
  });
}
