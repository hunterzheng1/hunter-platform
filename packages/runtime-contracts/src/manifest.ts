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
  "attach",
  "observe",
  "send",
  "interrupt",
  "resume",
  "steer",
  "structured_events",
  "permission_events",
  "completion_receipt",
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

const AtomicCapabilityProbeResultSchema = z.strictObject({
  capability: AtomicCapabilitySchema,
  status: z.enum(["SUPPORTED", "UNSUPPORTED", "BLOCKED", "NOT_PROVEN"]),
  evidenceId: EvidenceIdSchema,
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const CapabilityProbeReceiptSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    probeReceiptId: CapabilityProbeReceiptIdSchema,
    subject: ProbeSubjectSchema,
    platform: z.enum(["windows", "linux"]),
    observedAt: z.iso.datetime(),
    validUntil: z.iso.datetime(),
    results: z.array(AtomicCapabilityProbeResultSchema).min(1).max(19),
  })
  .superRefine((receipt, context) => {
    if (Date.parse(receipt.validUntil) <= Date.parse(receipt.observedAt)) {
      context.addIssue({ code: "custom", message: "CAPABILITY_RECEIPT_WINDOW_INVALID" });
    }
    const capabilities = receipt.results.map((result) => result.capability);
    if (new Set(capabilities).size !== capabilities.length) {
      context.addIssue({ code: "custom", message: "DUPLICATE_CAPABILITY_RESULT" });
    }
  });
export type CapabilityProbeReceipt = z.infer<typeof CapabilityProbeReceiptSchema>;

export const CapabilityLevelSchema = z.enum(["NONE", "L0", "L1", "L2", "L3"]);
export type CapabilityLevel = z.infer<typeof CapabilityLevelSchema>;

const LEVEL_REQUIREMENTS: ReadonlyArray<readonly [CapabilityLevel, readonly AtomicCapability[]]> = [
  ["L0", ["discover", "workspace_targeting", "native_surface"]],
  ["L1", ["discover", "workspace_targeting", "native_surface", "observe", "artifact_export"]],
  [
    "L2",
    [
      "discover",
      "workspace_targeting",
      "native_surface",
      "observe",
      "artifact_export",
      "launch",
      "send",
      "interrupt",
      "structured_events",
    ],
  ],
  [
    "L3",
    [
      "discover",
      "workspace_targeting",
      "native_surface",
      "observe",
      "artifact_export",
      "launch",
      "send",
      "interrupt",
      "structured_events",
      "permission_events",
      "resume",
      "completion_receipt",
    ],
  ],
];

export function deriveCapabilityLevel(
  input: CapabilityProbeReceipt,
  at: Date,
): CapabilityLevel {
  const receipt = CapabilityProbeReceiptSchema.parse(input);
  const timestamp = at.getTime();
  if (timestamp < Date.parse(receipt.observedAt) || timestamp > Date.parse(receipt.validUntil)) {
    return "NONE";
  }
  const supported = new Set(
    receipt.results
      .filter((result) => result.status === "SUPPORTED")
      .map((result) => result.capability),
  );
  let level: CapabilityLevel = "NONE";
  for (const [candidate, requirements] of LEVEL_REQUIREMENTS) {
    if (requirements.every((capability) => supported.has(capability))) level = candidate;
  }
  return level;
}
