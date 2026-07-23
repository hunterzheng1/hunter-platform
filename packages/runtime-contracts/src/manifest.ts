import {
  CapabilityProbeReceiptIdSchema,
  ConnectorIdSchema,
  EvidenceIdSchema,
  RuntimeProviderIdSchema,
} from "@hunter/domain";
import { z } from "zod";

export const AtomicCapabilitySchema = z.enum([
  "discover",
  "workspace_prepare",
  "workspace_isolation",
  "workspace_targeting",
  "launch",
  "handoff",
  "attach",
  "observe",
  "send",
  "interrupt",
  "resume",
  "steer",
  "structured_events",
  "result_channel",
  "permission_events",
  "approve",
  "structured_tool_events",
  "policy_hook",
  "reliable_attach_recovery",
  "completion_receipt",
  "durable_completion_receipt",
  "artifact_export",
  "native_surface",
  "headless",
  "mobile_control",
]);
export type AtomicCapability = z.infer<typeof AtomicCapabilitySchema>;

const ProbeSubjectSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("provider"),
    providerId: RuntimeProviderIdSchema,
    implementationVersion: z.string().min(1).max(256),
  }),
  z.strictObject({
    kind: z.literal("connector"),
    connectorId: ConnectorIdSchema,
    implementationVersion: z.string().min(1).max(256),
  }),
]);

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

const LegacyAtomicCapabilityProbeResultSchema = z.strictObject({
  capability: AtomicCapabilitySchema,
  status: z.enum(["SUPPORTED", "UNSUPPORTED", "BLOCKED", "NOT_PROVEN"]),
  evidenceId: EvidenceIdSchema,
  evidenceHash: DigestSchema,
});

const CapabilityProbeEvidenceSchema = z.strictObject({
  source: z.enum(["local_probe", "phase0_evidence", "contract_fixture", "unknown_event"]),
  digest: DigestSchema,
});

export const CapabilityProbeStatusSchema = z.enum([
  "supported",
  "unsupported",
  "unknown",
]);
export type CapabilityProbeStatus = z.infer<typeof CapabilityProbeStatusSchema>;

const AtomicCapabilityProbeResultSchema = z.strictObject({
  capability: AtomicCapabilitySchema,
  status: CapabilityProbeStatusSchema,
  evidenceId: EvidenceIdSchema,
  evidence: CapabilityProbeEvidenceSchema,
  probedAt: z.iso.datetime(),
});

const LegacyCapabilityProbeReceiptSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    probeReceiptId: CapabilityProbeReceiptIdSchema,
    subject: ProbeSubjectSchema,
    platform: z.enum(["windows", "linux"]),
    observedAt: z.iso.datetime(),
    validUntil: z.iso.datetime(),
    results: z
      .array(LegacyAtomicCapabilityProbeResultSchema)
      .min(1)
      .max(AtomicCapabilitySchema.options.length),
  })
  .superRefine((receipt, context) => {
    if (Date.parse(receipt.validUntil) <= Date.parse(receipt.observedAt)) {
      context.addIssue({
        code: "custom",
        message: "CAPABILITY_RECEIPT_WINDOW_INVALID",
      });
    }
    const capabilities = receipt.results.map((result) => result.capability);
    if (new Set(capabilities).size !== capabilities.length) {
      context.addIssue({
        code: "custom",
        message: "DUPLICATE_CAPABILITY_RESULT",
      });
    }
  });

const ProductVersionConstraintSchema = z.strictObject({
  observed: z.string().min(1).max(128).nullable(),
  supported: z.array(z.string().min(1).max(128)).min(1).max(64),
});

const ProtocolConstraintSchema = z.strictObject({
  kind: z.string().min(1).max(128),
  observedVersion: z.string().min(1).max(128).nullable(),
  supportedVersions: z.array(z.string().min(1).max(128)).min(1).max(64),
  schemaVersion: z.number().int().nonnegative().nullable(),
  supportedSchemaVersions: z.array(z.number().int().nonnegative()).min(1).max(64),
  schemaDigest: DigestSchema.nullable(),
});

const CurrentCapabilityProbeReceiptSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    probeReceiptId: CapabilityProbeReceiptIdSchema,
    subject: ProbeSubjectSchema,
    platform: z.enum(["windows", "linux"]),
    executable: z.strictObject({
      status: z.enum(["available", "unavailable", "unknown"]),
    }),
    loginState: z.enum([
      "authenticated",
      "unauthenticated",
      "not_required",
      "unknown",
    ]),
    productVersion: ProductVersionConstraintSchema,
    protocol: ProtocolConstraintSchema,
    probedAt: z.iso.datetime(),
    validUntil: z.iso.datetime(),
    results: z
      .array(AtomicCapabilityProbeResultSchema)
      .min(1)
      .max(AtomicCapabilitySchema.options.length),
  })
  .superRefine((receipt, context) => {
    if (Date.parse(receipt.validUntil) <= Date.parse(receipt.probedAt)) {
      context.addIssue({
        code: "custom",
        message: "CAPABILITY_RECEIPT_WINDOW_INVALID",
      });
    }
    const capabilities = receipt.results.map((result) => result.capability);
    if (new Set(capabilities).size !== capabilities.length) {
      context.addIssue({
        code: "custom",
        message: "DUPLICATE_CAPABILITY_RESULT",
      });
    }
    if (new Set(receipt.productVersion.supported).size !== receipt.productVersion.supported.length) {
      context.addIssue({
        code: "custom",
        message: "DUPLICATE_SUPPORTED_PRODUCT_VERSION",
      });
    }
    if (
      new Set(receipt.protocol.supportedVersions).size
      !== receipt.protocol.supportedVersions.length
    ) {
      context.addIssue({
        code: "custom",
        message: "DUPLICATE_SUPPORTED_PROTOCOL_VERSION",
      });
    }
    if (
      new Set(receipt.protocol.supportedSchemaVersions).size
      !== receipt.protocol.supportedSchemaVersions.length
    ) {
      context.addIssue({
        code: "custom",
        message: "DUPLICATE_SUPPORTED_PROTOCOL_SCHEMA_VERSION",
      });
    }
    for (const result of receipt.results) {
      const timestamp = Date.parse(result.probedAt);
      if (
        timestamp < Date.parse(receipt.probedAt)
        || timestamp > Date.parse(receipt.validUntil)
      ) {
        context.addIssue({
          code: "custom",
          message: "CAPABILITY_RESULT_TIME_OUTSIDE_RECEIPT_WINDOW",
          path: ["results", receipt.results.indexOf(result), "probedAt"],
        });
      }
    }
  });

export const CapabilityProbeReceiptSchema = z.discriminatedUnion(
  "schemaVersion",
  [
    LegacyCapabilityProbeReceiptSchema,
    CurrentCapabilityProbeReceiptSchema,
  ],
);
export type CapabilityProbeReceipt = z.infer<
  typeof CapabilityProbeReceiptSchema
>;
export type CurrentCapabilityProbeReceipt = z.infer<
  typeof CurrentCapabilityProbeReceiptSchema
>;

export interface CapabilityProbeReceiptStore {
  save(receipt: CurrentCapabilityProbeReceipt): Promise<void>;
}

export const CapabilityLevelSchema = z.enum(["NONE", "L0", "L1", "L2", "L3"]);
export type CapabilityLevel = z.infer<typeof CapabilityLevelSchema>;

const CapabilityManifestAtomSchema = z.strictObject({
  capability: AtomicCapabilitySchema,
  status: CapabilityProbeStatusSchema,
  evidence: CapabilityProbeEvidenceSchema.nullable(),
  probedAt: z.iso.datetime().nullable(),
});

export const CapabilityManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  probeReceiptId: CapabilityProbeReceiptIdSchema,
  subject: ProbeSubjectSchema,
  level: CapabilityLevelSchema,
  capabilities: z.array(CapabilityManifestAtomSchema).length(
    AtomicCapabilitySchema.options.length,
  ),
  computedAt: z.iso.datetime(),
});
export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;

const AUTHENTICATED_EXECUTION_ATOMS = new Set<AtomicCapability>([
  "launch",
  "attach",
  "observe",
  "send",
  "interrupt",
  "resume",
  "steer",
  "structured_events",
  "result_channel",
  "permission_events",
  "approve",
  "structured_tool_events",
  "policy_hook",
  "reliable_attach_recovery",
  "completion_receipt",
  "durable_completion_receipt",
  "headless",
  "mobile_control",
]);

const AUTHORITATIVE_EVIDENCE_SOURCES = new Set([
  "local_probe",
  "phase0_evidence",
]);

function includesEvery(
  supported: ReadonlySet<AtomicCapability>,
  required: readonly AtomicCapability[],
): boolean {
  return required.every((capability) => supported.has(capability));
}

function includesOne(
  supported: ReadonlySet<AtomicCapability>,
  alternatives: readonly AtomicCapability[],
): boolean {
  return alternatives.some((capability) => supported.has(capability));
}

function compatibleReceipt(
  receipt: CurrentCapabilityProbeReceipt,
  at: Date,
): boolean {
  const timestamp = at.getTime();
  const observedProduct = receipt.productVersion.observed;
  const observedProtocol = receipt.protocol.observedVersion;
  const schemaVersion = receipt.protocol.schemaVersion;
  const versionIsKnown = (value: string | null): value is string =>
    value !== null
    && !["unknown", "unavailable", "*"].includes(value.trim().toLocaleLowerCase("en-US"));
  return (
    receipt.executable.status === "available"
    && timestamp >= Date.parse(receipt.probedAt)
    && timestamp <= Date.parse(receipt.validUntil)
    && versionIsKnown(observedProduct)
    && receipt.productVersion.supported.includes(observedProduct)
    && versionIsKnown(observedProtocol)
    && receipt.protocol.supportedVersions.includes(observedProtocol)
    && schemaVersion !== null
    && receipt.protocol.supportedSchemaVersions.includes(schemaVersion)
    && receipt.protocol.schemaDigest !== null
  );
}

function computedLevel(supported: ReadonlySet<AtomicCapability>): CapabilityLevel {
  const l0 = (
    includesEvery(supported, ["discover", "workspace_targeting"])
    && includesOne(supported, ["launch", "handoff", "native_surface"])
  );
  if (!l0) return "NONE";
  const l1 = includesOne(supported, ["observe", "artifact_export"]);
  if (!l1) return "L0";
  const l2 = (
    includesEvery(supported, [
      "launch",
      "structured_events",
      "send",
      "interrupt",
    ])
    && includesOne(supported, ["result_channel", "completion_receipt"])
  );
  if (!l2) return "L1";
  const l3 = includesEvery(supported, [
    "permission_events",
    "approve",
    "structured_tool_events",
    "policy_hook",
    "reliable_attach_recovery",
    "durable_completion_receipt",
  ]);
  return l3 ? "L3" : "L2";
}

export function computeCapabilityManifest(
  input: unknown,
  at = new Date(),
): CapabilityManifest {
  let receipt: CapabilityProbeReceipt;
  try {
    receipt = CapabilityProbeReceiptSchema.parse(input);
  } catch {
    throw new Error("CAPABILITY_RECEIPT_INVALID");
  }
  const computedAt = at.toISOString();
  if (receipt.schemaVersion === 1) {
    return CapabilityManifestSchema.parse({
      schemaVersion: 1,
      probeReceiptId: receipt.probeReceiptId,
      subject: receipt.subject,
      level: "NONE",
      capabilities: AtomicCapabilitySchema.options.map((capability) => ({
        capability,
        status: "unknown",
        evidence: null,
        probedAt: null,
      })),
      computedAt,
    });
  }

  const globallyCompatible = compatibleReceipt(receipt, at);
  const authenticated = (
    receipt.loginState === "authenticated"
    || receipt.loginState === "not_required"
  );
  const byCapability = new Map(
    receipt.results.map((result) => [result.capability, result] as const),
  );
  const capabilities = AtomicCapabilitySchema.options.map((capability) => {
    const result = byCapability.get(capability);
    if (result === undefined) {
      return {
        capability,
        status: "unknown" as const,
        evidence: null,
        probedAt: null,
      };
    }
    const sourceAuthoritative = AUTHORITATIVE_EVIDENCE_SOURCES.has(
      result.evidence.source,
    );
    const authenticationAllows = (
      authenticated
      || !AUTHENTICATED_EXECUTION_ATOMS.has(capability)
    );
    const status = (
      globallyCompatible
      && sourceAuthoritative
      && authenticationAllows
    )
      ? result.status
      : "unknown";
    return {
      capability,
      status,
      evidence: result.evidence,
      probedAt: result.probedAt,
    };
  });
  const supported = new Set(
    capabilities
      .filter(({ status }) => status === "supported")
      .map(({ capability }) => capability),
  );
  return CapabilityManifestSchema.parse({
    schemaVersion: 1,
    probeReceiptId: receipt.probeReceiptId,
    subject: receipt.subject,
    level: computedLevel(supported),
    capabilities,
    computedAt,
  });
}

export function deriveCapabilityLevel(
  input: CapabilityProbeReceipt,
  at: Date,
): CapabilityLevel {
  return computeCapabilityManifest(input, at).level;
}
