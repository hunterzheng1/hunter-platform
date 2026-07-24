import { createHash } from "node:crypto";
import {
  CapabilityProbeReceiptIdSchema,
  ConnectorIdSchema,
  EvidenceIdSchema,
} from "@hunter/domain";
import {
  CapabilityProbeReceiptSchema,
  parseBoundedProviderObject,
  type CapabilityProbeReceiptStore,
  type CapabilityProbeStatus,
  type CurrentCapabilityProbeReceipt,
} from "@hunter/runtime-contracts";
import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const ProbeStatusSchema = z.enum(["supported", "unsupported", "unknown"]);

const CursorProbeObservationSchema = z.strictObject({
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
  discoveryStatus: ProbeStatusSchema,
  workspaceTargetingStatus: ProbeStatusSchema,
  handoffStatus: ProbeStatusSchema,
  nativeSurfaceStatus: ProbeStatusSchema,
  observerContract: z.enum(["passed", "failed", "not_proven"]),
});

export interface CursorProbeSource {
  inspect(): Promise<unknown>;
}

function stableId(prefix: "cpr" | "evd", value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

export class CursorCapabilityProbe {
  constructor(
    private readonly source: CursorProbeSource,
    private readonly store: CapabilityProbeReceiptStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async probe(): Promise<CurrentCapabilityProbeReceipt> {
    let inspected: unknown;
    try {
      inspected = await this.source.inspect();
    } catch {
      throw new Error("CURSOR_PROBE_FAILED");
    }
    let value: z.infer<typeof CursorProbeObservationSchema>;
    try {
      value = parseBoundedProviderObject(
        CursorProbeObservationSchema,
        inspected,
      );
    } catch {
      throw new Error("CURSOR_PROBE_INVALID");
    }
    const probedAt = this.now();
    const probedAtIso = probedAt.toISOString();
    const observerStatus: CapabilityProbeStatus = value.observerContract === "passed"
      ? "supported"
      : value.observerContract === "failed"
        ? "unsupported"
        : "unknown";
    const capabilities = [
      { capability: "discover" as const, status: value.discoveryStatus },
      {
        capability: "workspace_targeting" as const,
        status: value.workspaceTargetingStatus,
      },
      { capability: "handoff" as const, status: value.handoffStatus },
      {
        capability: "native_surface" as const,
        status: value.nativeSurfaceStatus,
      },
      { capability: "observe" as const, status: observerStatus },
      { capability: "artifact_export" as const, status: observerStatus },
    ];
    const receipt = CapabilityProbeReceiptSchema.parse({
      schemaVersion: 2,
      probeReceiptId: CapabilityProbeReceiptIdSchema.parse(
        stableId("cpr", `cursor:${value.evidenceDigest}:${probedAtIso}`),
      ),
      subject: {
        kind: "connector",
        connectorId: ConnectorIdSchema.parse("con_cursor_handoff"),
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
      results: capabilities.map(({ capability, status }, index) => ({
        capability,
        status,
        evidenceId: EvidenceIdSchema.parse(
          stableId("evd", `cursor:${value.evidenceDigest}:${capability}:${index}`),
        ),
        evidence: {
          source: "local_probe",
          digest: value.evidenceDigest,
        },
        probedAt: probedAtIso,
      })),
    });
    if (receipt.schemaVersion !== 2) throw new Error("CURSOR_PROBE_INVALID");
    await this.store.save(receipt);
    return receipt;
  }
}
