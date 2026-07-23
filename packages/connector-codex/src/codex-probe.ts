import { createHash } from "node:crypto";
import {
  CapabilityProbeReceiptIdSchema,
  ConnectorIdSchema,
  EvidenceIdSchema,
} from "@hunter/domain";
import {
  AtomicCapabilitySchema,
  CapabilityProbeReceiptSchema,
  parseBoundedProviderObject,
  type CapabilityProbeReceiptStore,
  type CurrentCapabilityProbeReceipt,
} from "@hunter/runtime-contracts";
import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

const CodexProbeObservationSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    executableStatus: z.enum(["available", "unavailable", "unknown"]),
    loginState: z.enum([
      "authenticated",
      "unauthenticated",
      "not_required",
      "unknown",
    ]),
    productVersion: z.string().min(1).max(128).nullable(),
    supportedProductVersions: z.array(z.string().min(1).max(128)).min(1).max(32),
    protocolKind: z.string().min(1).max(128),
    protocolVersion: z.string().min(1).max(128).nullable(),
    supportedProtocolVersions: z.array(z.string().min(1).max(128)).min(1).max(32),
    protocolSchemaVersion: z.number().int().nonnegative().nullable(),
    supportedProtocolSchemaVersions: z.array(z.number().int().nonnegative()).min(1).max(32),
    protocolSchemaDigest: DigestSchema.nullable(),
    evidenceDigest: DigestSchema,
    capabilities: z.array(z.strictObject({
      capability: AtomicCapabilitySchema,
      status: z.enum(["supported", "unsupported", "unknown"]),
    })).max(AtomicCapabilitySchema.options.length),
  })
  .superRefine((observation, context) => {
    const capabilities = observation.capabilities.map(({ capability }) => capability);
    if (new Set(capabilities).size !== capabilities.length) {
      context.addIssue({ code: "custom", message: "DUPLICATE_CAPABILITY_RESULT" });
    }
  });

export interface CodexProbeSource {
  inspect(): Promise<unknown>;
}

function stableId(prefix: "cpr" | "evd", value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function normalizedCapabilities(
  capabilities: z.infer<typeof CodexProbeObservationSchema>["capabilities"],
) {
  const supported = new Set(
    capabilities
      .filter(({ status }) => status === "supported")
      .map(({ capability }) => capability),
  );
  return capabilities.map((result) => {
    if (
      result.capability === "observe"
      && !supported.has("structured_events")
    ) {
      return { ...result, status: "unknown" as const };
    }
    return result;
  });
}

export class CodexCapabilityProbe {
  constructor(
    private readonly source: CodexProbeSource,
    private readonly store: CapabilityProbeReceiptStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async probe(): Promise<CurrentCapabilityProbeReceipt> {
    let inspected: unknown;
    try {
      inspected = await this.source.inspect();
    } catch {
      throw new Error("CODEX_PROBE_FAILED");
    }
    let parsed: z.infer<typeof CodexProbeObservationSchema>;
    try {
      parsed = parseBoundedProviderObject(
        CodexProbeObservationSchema,
        inspected,
      );
    } catch {
      throw new Error("CODEX_PROBE_INVALID");
    }
    const probedAt = this.now();
    const probedAtIso = probedAt.toISOString();
    const receipt = CapabilityProbeReceiptSchema.parse({
      schemaVersion: 2,
      probeReceiptId: CapabilityProbeReceiptIdSchema.parse(
        stableId("cpr", `codex:${parsed.evidenceDigest}:${probedAtIso}`),
      ),
      subject: {
        kind: "connector",
        connectorId: ConnectorIdSchema.parse("con_codex_direct"),
        implementationVersion: "1.0.0",
      },
      platform: process.platform === "win32" ? "windows" : "linux",
      executable: { status: parsed.executableStatus },
      loginState: parsed.loginState,
      productVersion: {
        observed: parsed.productVersion,
        supported: parsed.supportedProductVersions,
      },
      protocol: {
        kind: parsed.protocolKind,
        observedVersion: parsed.protocolVersion,
        supportedVersions: parsed.supportedProtocolVersions,
        schemaVersion: parsed.protocolSchemaVersion,
        supportedSchemaVersions: parsed.supportedProtocolSchemaVersions,
        schemaDigest: parsed.protocolSchemaDigest,
      },
      probedAt: probedAtIso,
      validUntil: new Date(probedAt.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
      results: normalizedCapabilities(parsed.capabilities).map(({ capability, status }, index) => ({
        capability,
        status,
        evidenceId: EvidenceIdSchema.parse(
          stableId("evd", `codex:${parsed.evidenceDigest}:${capability}:${index}`),
        ),
        evidence: {
          source: "phase0_evidence",
          digest: parsed.evidenceDigest,
        },
        probedAt: probedAtIso,
      })),
    });
    if (receipt.schemaVersion !== 2) throw new Error("CODEX_PROBE_INVALID");
    await this.store.save(receipt);
    return receipt;
  }
}
