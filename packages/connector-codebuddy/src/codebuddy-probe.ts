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
import {
  CodeBuddyTransportEndpointSchema,
  CodeBuddyTransportKindSchema,
  VerifiedCodeBuddyTransportSelectionSchema,
  type VerifiedCodeBuddyTransportSelection,
} from "./acp-transport.js";

export type { VerifiedCodeBuddyTransportSelection } from "./acp-transport.js";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

const CodeBuddyProbeObservationSchema = z
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
    transportKind: CodeBuddyTransportKindSchema,
    endpoint: CodeBuddyTransportEndpointSchema,
    protocolKind: z.string().min(1).max(128),
    protocolVersion: z.string().min(1).max(128).nullable(),
    supportedProtocolVersions: z.array(z.string().min(1).max(128)).min(1).max(32),
    protocolSchemaVersion: z.number().int().nonnegative().nullable(),
    supportedProtocolSchemaVersions: z.array(z.number().int().nonnegative()).min(1).max(32),
    protocolSchemaDigest: DigestSchema.nullable(),
    sourceEvidenceDigest: DigestSchema,
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

export interface CodeBuddyProbeSource {
  inspect(): Promise<unknown>;
}

export interface CodeBuddyProbeResult {
  readonly receipt: CurrentCapabilityProbeReceipt;
  readonly selection: VerifiedCodeBuddyTransportSelection;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function codeBuddySelectionDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function codeBuddyReceiptDigest(
  receipt: CurrentCapabilityProbeReceipt,
): string {
  return codeBuddySelectionDigest(receipt);
}

function stableId(prefix: "cpr" | "evd", value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function normalizedCapabilities(
  capabilities: z.infer<typeof CodeBuddyProbeObservationSchema>["capabilities"],
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

export class CodeBuddyCapabilityProbe {
  constructor(
    private readonly source: CodeBuddyProbeSource,
    private readonly store: CapabilityProbeReceiptStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async probe(): Promise<CodeBuddyProbeResult> {
    let inspected: unknown;
    try {
      inspected = await this.source.inspect();
    } catch {
      throw new Error("CODEBUDDY_PROBE_FAILED");
    }
    let value: z.infer<typeof CodeBuddyProbeObservationSchema>;
    try {
      value = parseBoundedProviderObject(
        CodeBuddyProbeObservationSchema,
        inspected,
      );
    } catch {
      throw new Error("CODEBUDDY_PROBE_INVALID");
    }
    const probedAt = this.now();
    const probedAtIso = probedAt.toISOString();
    const selectionBase = {
      schemaVersion: 1 as const,
      transportKind: value.transportKind,
      endpoint: value.endpoint,
      protocolKind: value.protocolKind,
      protocolVersion: value.protocolVersion ?? "unknown",
      supportedProtocolVersions: value.supportedProtocolVersions,
      protocolSchemaVersion: value.protocolSchemaVersion ?? 0,
      supportedProtocolSchemaVersions: value.supportedProtocolSchemaVersions,
      protocolSchemaDigest: value.protocolSchemaDigest ?? "0".repeat(64),
      sourceEvidenceDigest: value.sourceEvidenceDigest,
    };
    const selectionDigest = codeBuddySelectionDigest(selectionBase);
    const probeReceiptId = CapabilityProbeReceiptIdSchema.parse(
      stableId("cpr", `codebuddy:${selectionDigest}:${probedAtIso}`),
    );
    const receipt = CapabilityProbeReceiptSchema.parse({
      schemaVersion: 2,
      probeReceiptId,
      subject: {
        kind: "connector",
        connectorId: ConnectorIdSchema.parse("con_codebuddy_acp"),
        implementationVersion: "1.0.0",
      },
      platform: process.platform === "win32" ? "windows" : "linux",
      executable: { status: value.executableStatus },
      loginState: value.loginState,
      productVersion: {
        observed: value.productVersion,
        supported: value.supportedProductVersions,
      },
      protocol: {
        kind: value.protocolKind,
        observedVersion: value.protocolVersion,
        supportedVersions: value.supportedProtocolVersions,
        schemaVersion: value.protocolSchemaVersion,
        supportedSchemaVersions: value.supportedProtocolSchemaVersions,
        schemaDigest: value.protocolSchemaDigest,
      },
      probedAt: probedAtIso,
      validUntil: new Date(probedAt.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
      results: normalizedCapabilities(value.capabilities).map(({ capability, status }, index) => ({
        capability,
        status,
        evidenceId: EvidenceIdSchema.parse(
          stableId("evd", `codebuddy:${selectionDigest}:${capability}:${index}`),
        ),
        evidence: { source: "local_probe", digest: selectionDigest },
        probedAt: probedAtIso,
      })),
    });
    if (receipt.schemaVersion !== 2) throw new Error("CODEBUDDY_PROBE_INVALID");
    const selection = VerifiedCodeBuddyTransportSelectionSchema.parse({
      ...selectionBase,
      probeReceiptId,
      selectionDigest,
      receiptDigest: codeBuddyReceiptDigest(receipt),
    });
    await this.store.save(receipt);
    return Object.freeze({
      receipt,
      selection: Object.freeze(selection),
    });
  }
}
