import {
  CapabilityProbeReceiptSchema,
  type CurrentCapabilityProbeReceipt,
} from "@hunter/runtime-contracts";
import { describe, expect, it } from "vitest";

import { assertLocalProbeMatchesReceipt } from "../real-provider-validation.js";

function receipt(): CurrentCapabilityProbeReceipt {
  const parsed = CapabilityProbeReceiptSchema.parse({
    schemaVersion: 2,
    probeReceiptId: "cpr_realvalidation",
    subject: {
      kind: "connector",
      connectorId: "con_realvalidation",
      implementationVersion: "1.0.0",
    },
    platform: "windows",
    executable: { status: "available" },
    loginState: "authenticated",
    productVersion: {
      observed: "codex-cli 0.144.6",
      supported: ["codex-cli 0.144.6"],
    },
    protocol: {
      kind: "stdio",
      observedVersion: "1",
      supportedVersions: ["1"],
      schemaVersion: 1,
      supportedSchemaVersions: [1],
      schemaDigest: "a".repeat(64),
    },
    probedAt: "2026-07-24T00:00:00.000Z",
    validUntil: "2026-07-25T00:00:00.000Z",
    results: [{
      capability: "discover",
      status: "supported",
      evidenceId: "evd_realvalidation",
      evidence: { source: "local_probe", digest: "b".repeat(64) },
      probedAt: "2026-07-24T00:00:00.000Z",
    }],
  });
  if (parsed.schemaVersion !== 2) throw new Error("TEST_RECEIPT_VERSION_INVALID");
  return parsed;
}

describe("real-provider local validation", () => {
  it("accepts only an executable, version, and login state matching the receipt", () => {
    expect(() => assertLocalProbeMatchesReceipt("codex", {
      availability: "DETECTED",
      authentication: "DETECTED",
      version: "codex-cli 0.144.6",
    }, receipt())).not.toThrow();
  });

  it.each([
    [
      "REAL_PROVIDER_EXECUTABLE_NOT_DETECTED",
      { availability: "BLOCKED", authentication: "BLOCKED", version: null },
    ],
    [
      "REAL_PROVIDER_VERSION_MISMATCH",
      {
        availability: "DETECTED",
        authentication: "DETECTED",
        version: "codex-cli 0.145.0",
      },
    ],
    [
      "REAL_PROVIDER_LOGIN_STATE_MISMATCH",
      {
        availability: "DETECTED",
        authentication: "NOT_PROVEN",
        version: "codex-cli 0.144.6",
      },
    ],
  ] as const)("rejects %s", (message, probe) => {
    expect(() =>
      assertLocalProbeMatchesReceipt("codex", probe, receipt()),
    ).toThrow(message);
  });
});
