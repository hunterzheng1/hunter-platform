import {
  CapabilityProbeReceiptIdSchema,
  ConnectorIdSchema,
  EvidenceIdSchema,
} from "@hunter/domain";
import { describe, expect, it } from "vitest";
import {
  CapabilityProbeReceiptSchema,
  computeCapabilityManifest,
  type AtomicCapability,
} from "./manifest.js";

const probedAt = "2026-07-24T00:00:00.000Z";
const validUntil = "2026-07-25T00:00:00.000Z";
const digest = "a".repeat(64);

const levelThreeAtoms = [
  "discover",
  "workspace_targeting",
  "launch",
  "observe",
  "structured_events",
  "send",
  "interrupt",
  "result_channel",
  "permission_events",
  "approve",
  "structured_tool_events",
  "policy_hook",
  "reliable_attach_recovery",
  "durable_completion_receipt",
] as const satisfies readonly AtomicCapability[];

function receipt(
  atoms: readonly AtomicCapability[] = levelThreeAtoms,
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: 2,
    probeReceiptId: CapabilityProbeReceiptIdSchema.parse("cpr_manifest001"),
    subject: {
      kind: "connector",
      connectorId: ConnectorIdSchema.parse("con_manifest001"),
      implementationVersion: "1.0.0",
    },
    platform: "windows",
    executable: { status: "available" },
    loginState: "authenticated",
    productVersion: {
      observed: "1.2.3",
      supported: ["1.2.3"],
    },
    protocol: {
      kind: "structured-test",
      observedVersion: "2026-07",
      supportedVersions: ["2026-07"],
      schemaVersion: 1,
      supportedSchemaVersions: [1],
      schemaDigest: digest,
    },
    probedAt,
    validUntil,
    results: atoms.map((capability, index) => ({
      capability,
      status: "supported",
      evidenceId: EvidenceIdSchema.parse(`evd_manifest${String(index).padStart(3, "0")}`),
      evidence: {
        source: "local_probe",
        digest,
      },
      probedAt,
    })),
    ...overrides,
  };
}

describe("computed capability manifests", () => {
  it("computes the highest fully satisfied prefix without a product-name or target-level input", () => {
    const l0 = ["discover", "workspace_targeting", "launch"] as const;
    const l1 = [...l0, "artifact_export"] as const;
    const l2 = [
      ...l1,
      "structured_events",
      "send",
      "interrupt",
      "completion_receipt",
    ] as const;

    expect(computeCapabilityManifest(receipt(l0), new Date(probedAt)).level).toBe("L0");
    expect(computeCapabilityManifest(receipt(l1), new Date(probedAt)).level).toBe("L1");
    expect(computeCapabilityManifest(receipt(l2), new Date(probedAt)).level).toBe("L2");
    expect(computeCapabilityManifest(receipt(), new Date(probedAt)).level).toBe("L3");
    expect(Object.keys(computeCapabilityManifest)).not.toContain("targetLevel");
  });

  it("is invariant to result ordering and never infers a missing atom", () => {
    const forward = computeCapabilityManifest(receipt(), new Date(probedAt));
    const reverse = computeCapabilityManifest(
      receipt([...levelThreeAtoms].reverse()),
      new Date(probedAt),
    );

    expect(reverse.level).toBe(forward.level);
    expect(reverse.capabilities).toEqual(forward.capabilities);

    const withoutApprove = levelThreeAtoms.filter((atom) => atom !== "approve");
    const downgraded = computeCapabilityManifest(
      receipt(withoutApprove),
      new Date(probedAt),
    );
    expect(downgraded.level).toBe("L2");
    expect(downgraded.capabilities.find(({ capability }) => capability === "approve"))
      .toMatchObject({ status: "unknown", evidence: null });
  });

  it("does not advertise observe, L3 recovery, or durable completion when their proof is absent", () => {
    const withoutObservation = levelThreeAtoms.filter(
      (atom) => atom !== "observe",
    );
    expect(
      computeCapabilityManifest(receipt(withoutObservation), new Date(probedAt)).level,
    ).toBe("L0");

    for (const missing of [
      "reliable_attach_recovery",
      "durable_completion_receipt",
    ] as const) {
      expect(
        computeCapabilityManifest(
          receipt(levelThreeAtoms.filter((atom) => atom !== missing)),
          new Date(probedAt),
        ).level,
      ).toBe("L2");
    }
  });

  it("fails closed for executable, login, product, protocol, schema, and validity uncertainty", () => {
    const cases = [
      receipt(levelThreeAtoms, { executable: { status: "unavailable" } }),
      receipt(levelThreeAtoms, { loginState: "unauthenticated" }),
      receipt(levelThreeAtoms, {
        productVersion: { observed: null, supported: ["1.2.3"] },
      }),
      receipt(levelThreeAtoms, {
        productVersion: { observed: "unknown", supported: ["unknown"] },
      }),
      receipt(levelThreeAtoms, {
        protocol: {
          kind: "structured-test",
          observedVersion: null,
          supportedVersions: ["2026-07"],
          schemaVersion: 1,
          supportedSchemaVersions: [1],
          schemaDigest: digest,
        },
      }),
      receipt(levelThreeAtoms, {
        protocol: {
          kind: "structured-test",
          observedVersion: "*",
          supportedVersions: ["*"],
          schemaVersion: 1,
          supportedSchemaVersions: [1],
          schemaDigest: digest,
        },
      }),
      receipt(levelThreeAtoms, {
        protocol: {
          kind: "structured-test",
          observedVersion: "2026-07",
          supportedVersions: ["2026-07"],
          schemaVersion: 2,
          supportedSchemaVersions: [1],
          schemaDigest: digest,
        },
      }),
    ];

    for (const candidate of cases) {
      expect(
        computeCapabilityManifest(candidate, new Date(probedAt)).level,
      ).toBe("NONE");
    }
    expect(
      computeCapabilityManifest(receipt(), new Date("2026-07-26T00:00:00.000Z")).level,
    ).toBe("NONE");
  });

  it("rejects missing atom evidence and treats a legacy schema as non-authoritative", () => {
    const missingEvidence = receipt();
    const [first, ...rest] = missingEvidence.results;
    expect(first).toBeDefined();
    missingEvidence.results = [
      { ...first, evidence: undefined },
      ...rest,
    ] as typeof missingEvidence.results;
    expect(() => CapabilityProbeReceiptSchema.parse(missingEvidence)).toThrow();

    const legacy = {
      schemaVersion: 1,
      probeReceiptId: CapabilityProbeReceiptIdSchema.parse("cpr_manifestold"),
      subject: {
        kind: "connector",
        connectorId: ConnectorIdSchema.parse("con_manifest001"),
        implementationVersion: "0.1.0",
      },
      platform: "windows",
      observedAt: probedAt,
      validUntil,
      results: [{
        capability: "discover",
        status: "SUPPORTED",
        evidenceId: EvidenceIdSchema.parse("evd_manifestold"),
        evidenceHash: digest,
      }],
    };
    expect(CapabilityProbeReceiptSchema.parse(legacy).schemaVersion).toBe(1);
    expect(computeCapabilityManifest(legacy, new Date(probedAt)).level).toBe("NONE");
  });
});
