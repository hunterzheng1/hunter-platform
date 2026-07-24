import { createHash } from "node:crypto";

import { z } from "zod";

import {
  assertNoSensitiveMaterial,
  DIAGNOSTIC_REDACTION_SCHEMA_VERSION,
  redactDiagnosticValue,
  type DiagnosticRedactionCounts,
  type DiagnosticRedactionOptions,
} from "@hunter/policy";

export const DIAGNOSTIC_BUNDLE_SCHEMA_VERSION = 1 as const;

export type DiagnosticSourceKind =
  "database"
  | "logs"
  | "exports"
  | "prompts";

const HunterVersionSchema = z.string().max(64).regex(
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u,
);
const NodeVersionSchema = z.string().max(32).regex(
  /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u,
);
const GeneratedAtSchema = z.iso.datetime().max(32);
const HostSchema = z.strictObject({
  platform: z.enum(["win32", "linux"]),
  architecture: z.enum(["x64", "arm64"]),
  nodeVersion: NodeVersionSchema,
});
const DatabaseErrorCodeSchema = z.enum([
  "STORAGE_HEALTH_FAILED",
  "STORAGE_INTEGRITY_FAILED",
  "STORAGE_MIGRATION_FAILED",
]);
const LogErrorCodeSchema = z.enum([
  "LOG_SCAN_FAILED",
  "RUNTIME_OBSERVATION_INVALID",
]);
const ExportErrorCodeSchema = z.enum([
  "EXPORT_FAILED",
  "EXPORT_HASH_MISMATCH",
]);
const PromptErrorCodeSchema = z.enum([
  "PROMPT_REDACTION_FAILED",
  "PROMPT_REJECTED",
]);
const DiagnosticHealthSchema = z.enum([
  "healthy",
  "degraded",
  "failed",
  "unknown",
]);
const DiagnosticDetailSchema = z.string().min(1).max(2_048);
const DatabaseSummarySchema = z.strictObject({
  health: DiagnosticHealthSchema,
  tableCount: z.number().int().nonnegative(),
  detail: DiagnosticDetailSchema.optional(),
});
const LogSummarySchema = z.strictObject({
  health: DiagnosticHealthSchema,
  eventCount: z.number().int().nonnegative(),
  detail: DiagnosticDetailSchema.optional(),
});
const ExportSummarySchema = z.strictObject({
  health: DiagnosticHealthSchema,
  artifactCount: z.number().int().nonnegative(),
  detail: DiagnosticDetailSchema.optional(),
});
const PromptSummarySchema = z.strictObject({
  health: DiagnosticHealthSchema,
  promptCount: z.number().int().nonnegative(),
});
const DiagnosticSummarySchema = z.union([
  DatabaseSummarySchema,
  LogSummarySchema,
  ExportSummarySchema,
  PromptSummarySchema,
]);
const DiagnosticSourceInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("database"),
    count: z.number().int().nonnegative(),
    errorCodes: z.array(DatabaseErrorCodeSchema).max(64),
    summary: DatabaseSummarySchema,
  }),
  z.strictObject({
    kind: z.literal("logs"),
    count: z.number().int().nonnegative(),
    errorCodes: z.array(LogErrorCodeSchema).max(64),
    summary: LogSummarySchema,
  }),
  z.strictObject({
    kind: z.literal("exports"),
    count: z.number().int().nonnegative(),
    errorCodes: z.array(ExportErrorCodeSchema).max(64),
    summary: ExportSummarySchema,
  }),
  z.strictObject({
    kind: z.literal("prompts"),
    count: z.number().int().nonnegative(),
    errorCodes: z.array(PromptErrorCodeSchema).max(64),
    summary: PromptSummarySchema,
  }),
]);
const RedactionCountsSchema = z.strictObject({
  authorization: z.number().int().nonnegative(),
  cookie: z.number().int().nonnegative(),
  credential: z.number().int().nonnegative(),
  path: z.number().int().nonnegative(),
  prompt: z.number().int().nonnegative(),
  registeredSecret: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

const DiagnosticBundleSourceBaseShape = {
  count: z.number().int().nonnegative(),
  summaryHash: z.string().regex(/^[a-f0-9]{64}$/u),
  byteCount: z.number().int().nonnegative(),
};
const DiagnosticBundleSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...DiagnosticBundleSourceBaseShape,
    kind: z.literal("database"),
    errorCodes: z.array(DatabaseErrorCodeSchema).max(64),
    redactedSummary: DatabaseSummarySchema,
  }),
  z.strictObject({
    ...DiagnosticBundleSourceBaseShape,
    kind: z.literal("logs"),
    errorCodes: z.array(LogErrorCodeSchema).max(64),
    redactedSummary: LogSummarySchema,
  }),
  z.strictObject({
    ...DiagnosticBundleSourceBaseShape,
    kind: z.literal("exports"),
    errorCodes: z.array(ExportErrorCodeSchema).max(64),
    redactedSummary: ExportSummarySchema,
  }),
  z.strictObject({
    ...DiagnosticBundleSourceBaseShape,
    kind: z.literal("prompts"),
    errorCodes: z.array(PromptErrorCodeSchema).max(64),
    redactedSummary: PromptSummarySchema,
  }),
]);

export const DiagnosticBundleSchema = z.strictObject({
  schemaVersion: z.literal(DIAGNOSTIC_BUNDLE_SCHEMA_VERSION),
  bundleType: z.literal("hunter_diagnostic_bundle"),
  generatedAt: GeneratedAtSchema,
  generator: z.strictObject({
    name: z.literal("hunterd"),
    version: HunterVersionSchema,
  }),
  host: HostSchema,
  sources: z.array(DiagnosticBundleSourceSchema).min(1).max(4),
  excludedByDefault: z.tuple([
    z.literal("credentials"),
    z.literal("environment"),
    z.literal("raw_agent_events"),
    z.literal("source_code"),
    z.literal("sqlite"),
  ]),
  redaction: z.strictObject({
    applied: z.literal(true),
    schemaVersion: z.literal(DIAGNOSTIC_REDACTION_SCHEMA_VERSION),
    replacements: RedactionCountsSchema,
  }),
  contentFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type DiagnosticBundle = z.infer<typeof DiagnosticBundleSchema>;

export interface DiagnosticBundleSourceInput {
  readonly kind: DiagnosticSourceKind;
  readonly count: number;
  readonly errorCodes: readonly string[];
  readonly summary: unknown;
}

export interface CreateDiagnosticBundleInput {
  readonly generatedAt: string;
  readonly hunterVersion: string;
  readonly host: {
    readonly platform: string;
    readonly architecture: string;
    readonly nodeVersion: string;
  };
  readonly sources: readonly DiagnosticBundleSourceInput[];
  readonly redaction?: DiagnosticRedactionOptions | undefined;
}

export interface CreateDiagnosticBundleResult {
  readonly manifest: DiagnosticBundle;
  readonly bytes: Uint8Array;
}

const SOURCE_ORDER: Readonly<Record<DiagnosticSourceKind, number>> = {
  database: 0,
  logs: 1,
  exports: 2,
  prompts: 3,
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(canonicalize(value))}\n`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function emptyCounts(): DiagnosticRedactionCounts {
  return {
    authorization: 0,
    cookie: 0,
    credential: 0,
    path: 0,
    prompt: 0,
    registeredSecret: 0,
    total: 0,
  };
}

function addCounts(
  left: DiagnosticRedactionCounts,
  right: DiagnosticRedactionCounts,
): DiagnosticRedactionCounts {
  return {
    authorization: left.authorization + right.authorization,
    cookie: left.cookie + right.cookie,
    credential: left.credential + right.credential,
    path: left.path + right.path,
    prompt: left.prompt + right.prompt,
    registeredSecret: left.registeredSecret + right.registeredSecret,
    total: left.total + right.total,
  };
}

function validateInput(
  input: CreateDiagnosticBundleInput,
): readonly z.infer<typeof DiagnosticSourceInputSchema>[] {
  GeneratedAtSchema.parse(input.generatedAt);
  HunterVersionSchema.parse(input.hunterVersion);
  HostSchema.parse(input.host);
  if (input.sources.length < 1 || input.sources.length > 4) {
    throw new Error("DIAGNOSTIC_SOURCE_COUNT_INVALID");
  }
  const kinds = new Set<DiagnosticSourceKind>();
  const sources = input.sources.map((source) =>
    DiagnosticSourceInputSchema.parse(source)
  );
  for (const source of sources) {
    if (kinds.has(source.kind)) throw new Error("DIAGNOSTIC_SOURCE_DUPLICATE");
    kinds.add(source.kind);
  }
  return sources;
}

export function createDiagnosticBundle(
  input: CreateDiagnosticBundleInput,
): CreateDiagnosticBundleResult {
  const validatedSources = validateInput(input);
  let replacements = emptyCounts();
  const sources = validatedSources.map((source) => {
    const redacted = redactDiagnosticValue(source.summary, input.redaction);
    replacements = addCounts(replacements, redacted.replacements);
    const redactedSummary = DiagnosticSummarySchema.parse(redacted.value);
    const summaryBytes = encode(redactedSummary);
    return {
      kind: source.kind,
      count: source.count,
      errorCodes: [...new Set(source.errorCodes)].sort(),
      summaryHash: sha256(summaryBytes),
      byteCount: summaryBytes.byteLength,
      redactedSummary,
    };
  }).sort((left, right) => SOURCE_ORDER[left.kind] - SOURCE_ORDER[right.kind]);
  const withoutFingerprint = {
    schemaVersion: DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
    bundleType: "hunter_diagnostic_bundle" as const,
    generatedAt: input.generatedAt,
    generator: {
      name: "hunterd" as const,
      version: input.hunterVersion,
    },
    host: input.host,
    sources,
    excludedByDefault: [
      "credentials",
      "environment",
      "raw_agent_events",
      "source_code",
      "sqlite",
    ] as const,
    redaction: {
      applied: true as const,
      schemaVersion: DIAGNOSTIC_REDACTION_SCHEMA_VERSION,
      replacements,
    },
  };
  const contentFingerprint = sha256(encode(withoutFingerprint));
  const manifest = DiagnosticBundleSchema.parse({
    ...withoutFingerprint,
    contentFingerprint,
  });
  const bytes = encode(manifest);
  assertNoSensitiveMaterial(bytes, input.redaction?.registeredSecrets);
  return { manifest, bytes };
}
