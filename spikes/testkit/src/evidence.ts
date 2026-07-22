import { createHash } from "node:crypto";
import { z } from "zod";

export const evidenceSchemaVersion = 1 as const;

export const ProbeStatusSchema = z.enum(["DETECTED", "BLOCKED", "NOT_PROVEN"]);
export type ProbeStatus = z.infer<typeof ProbeStatusSchema>;

export const CommandEvidenceSchema = z.strictObject({
  command: z.strictObject({
    executable: z.string().min(1),
    args: z.array(z.string()),
  }),
  cwdScope: z.enum(["repository", "temporary_git_fixture", "none"]),
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  timedOut: z.boolean(),
  spawnError: z.string().nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
});
export type CommandEvidence = z.infer<typeof CommandEvidenceSchema>;

export const ProbeEvidenceSchema = z.strictObject({
  id: z.string().min(1),
  displayName: z.string().min(1),
  category: z.enum(["host", "tool", "agent", "runtime"]),
  status: ProbeStatusSchema,
  version: z.string().nullable(),
  helpHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  availability: z.strictObject({
    status: ProbeStatusSchema,
    reason: z.string().min(1),
  }),
  authentication: z.strictObject({
    required: z.boolean(),
    status: ProbeStatusSchema,
    method: z.string().min(1),
    reason: z.string().min(1),
  }),
  commands: z.array(CommandEvidenceSchema),
});
export type ProbeEvidence = z.infer<typeof ProbeEvidenceSchema>;

export const EvidenceEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(evidenceSchemaVersion),
  evidenceType: z.literal("phase0_environment_inventory"),
  generatedAt: z.iso.datetime(),
  generator: z.strictObject({
    name: z.literal("hunter-phase0-doctor"),
    version: z.literal("0.1.0"),
  }),
  host: z.strictObject({
    platform: z.string().min(1),
    architecture: z.string().min(1),
    release: z.string().min(1),
  }),
  probes: z.array(ProbeEvidenceSchema),
  summary: z.strictObject({
    detected: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    notProven: z.number().int().nonnegative(),
  }),
  redaction: z.strictObject({
    applied: z.literal(true),
    schemaVersion: z.literal(1),
  }),
  contentFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type EvidenceEnvelope = z.infer<typeof EvidenceEnvelopeSchema>;

export interface EvidenceEnvelopeInput {
  readonly evidenceType: "phase0_environment_inventory";
  readonly generatedAt: string;
  readonly host: {
    readonly platform: string;
    readonly architecture: string;
    readonly release: string;
  };
  readonly probes: readonly ProbeEvidence[];
}

export function redact(value: string): string {
  return value
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s\r\n]+/giu, "$1[REDACTED]")
    .replace(/(cookie\s*:\s*)[^\r\n]+/giu, "$1[REDACTED]")
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD))\s*=\s*[^\s\r\n]+/giu,
      "$1=[REDACTED]",
    )
    .replace(/([?&](?:token|access_token|auth|key)=)[^&\s]+/giu, "$1[REDACTED]")
    .replace(/\\\\[^\\\s]+\\[^\s\r\n]+/gu, "[PRIVATE_PATH]")
    .replace(/\b[A-Za-z]:\\(?:[^\\\s\r\n]+\\?)+/gu, "[PRIVATE_PATH]")
    .replace(/\/(?:home|Users)\/[^/\s]+(?:\/[^\s\r\n]*)?/gu, "[PRIVATE_PATH]");
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

function fingerprintProjection(envelope: Omit<EvidenceEnvelope, "contentFingerprint">): unknown {
  return {
    ...envelope,
    generatedAt: undefined,
    probes: envelope.probes.map((probe) => ({
      ...probe,
      commands: probe.commands.map((command) => ({
        command: command.command,
        cwdScope: command.cwdScope,
        exitCode: command.exitCode,
        stdout: command.stdout,
        stderr: command.stderr,
        timedOut: command.timedOut,
        spawnError: command.spawnError,
      })),
    })),
  };
}

export function createEvidenceEnvelope(input: EvidenceEnvelopeInput): EvidenceEnvelope {
  const safeInput = redactValue(input) as EvidenceEnvelopeInput;
  const summary = {
    detected: safeInput.probes.filter((probe) => probe.status === "DETECTED").length,
    blocked: safeInput.probes.filter((probe) => probe.status === "BLOCKED").length,
    notProven: safeInput.probes.filter((probe) => probe.status === "NOT_PROVEN").length,
  };
  const withoutFingerprint = {
    schemaVersion: evidenceSchemaVersion,
    evidenceType: safeInput.evidenceType,
    generatedAt: safeInput.generatedAt,
    generator: { name: "hunter-phase0-doctor" as const, version: "0.1.0" as const },
    host: safeInput.host,
    probes: [...safeInput.probes],
    summary,
    redaction: { applied: true as const, schemaVersion: 1 as const },
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(canonicalize(fingerprintProjection(withoutFingerprint))))
    .digest("hex");

  return EvidenceEnvelopeSchema.parse({
    ...withoutFingerprint,
    contentFingerprint: fingerprint,
  });
}

export function assertSafeEvidence(serialized: string): void {
  const forbidden = [
    /authorization\s*:\s*(?:bearer|basic)\s+(?!\[REDACTED\])/iu,
    /\b[A-Z][A-Z0-9_]*(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD)=(?!\[REDACTED\])/u,
    /\b[A-Za-z]:\\(?:Users\\)?[^\s"']+/u,
    /\/(?:home|Users)\/[^/\s"']+/u,
  ];
  if (forbidden.some((pattern) => pattern.test(serialized))) {
    throw new Error("EVIDENCE_CONTAINS_SENSITIVE_MATERIAL");
  }
}
