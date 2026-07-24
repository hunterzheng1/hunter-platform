import { readFileSync, realpathSync } from "node:fs";
import { arch, release } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  CapabilityLevelSchema,
  CapabilityProbeReceiptSchema,
  computeCapabilityManifest,
} from "@hunter/runtime-contracts";
import { NodeCommandRunner } from "@hunter/spike-testkit";
import { expect, test } from "@playwright/test";
import { z } from "zod";

import { createDoctorInventory } from "../spikes/doctor/src/probes.js";
import { assertLocalProbeMatchesReceipt } from "./real-provider-validation.js";

const enabled =
  process.platform === "win32"
  && process.env.HUNTER_REAL_AGENTS === "1";
const receiptBundlePath = process.env.HUNTER_REAL_PROVIDER_RECEIPTS;

test.skip(
  !enabled,
  "SKIP: owner-approved Windows agents and HUNTER_REAL_AGENTS=1 are required",
);
test.skip(
  receiptBundlePath === undefined,
  "SKIP: sanitized versioned capability receipt bundle unavailable",
);

const ReceiptAssertionSchema = z.object({
  claimedLevel: CapabilityLevelSchema,
  receipt: CapabilityProbeReceiptSchema,
}).strict();
const RealProviderReceiptBundleSchema = z.object({
  schemaVersion: z.literal(1),
  connectors: z.object({
    codex: ReceiptAssertionSchema,
    codebuddy: ReceiptAssertionSchema,
    cursor: ReceiptAssertionSchema,
    orca: ReceiptAssertionSchema,
  }).strict(),
}).strict();

test("owner-approved agents publish honest evidence-derived capability receipts", async () => {
  if (receiptBundlePath === undefined) {
    throw new Error("REAL_PROVIDER_RECEIPT_BUNDLE_REQUIRED");
  }
  const repositoryRoot = realpathSync.native(resolve(import.meta.dirname, ".."));
  const evidenceRoot = realpathSync.native(
    resolve(repositoryRoot, "docs", "validation", "evidence"),
  );
  if (!isAbsolute(receiptBundlePath)) {
    throw new Error("REAL_PROVIDER_RECEIPT_PATH_MUST_BE_ABSOLUTE");
  }
  const canonicalBundle = realpathSync.native(receiptBundlePath);
  const relativePath = relative(evidenceRoot, canonicalBundle);
  if (
    relativePath === ""
    || relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  ) {
    throw new Error("REAL_PROVIDER_RECEIPT_PATH_OUTSIDE_EVIDENCE_ROOT");
  }
  const bundle = RealProviderReceiptBundleSchema.parse(
    JSON.parse(readFileSync(canonicalBundle, "utf8")) as unknown,
  );
  const orcaExecutable = process.env.ORCA_CLI_COMMAND?.trim();
  const inventory = await createDoctorInventory({
    runner: new NodeCommandRunner(),
    cwd: repositoryRoot,
    now: () => new Date(),
    host: {
      platform: process.platform,
      architecture: arch(),
      release: release(),
    },
    ...(orcaExecutable === undefined || orcaExecutable === ""
      ? {}
      : { executableOverrides: { orca: orcaExecutable } }),
  });

  for (const [connector, assertion] of Object.entries(bundle.connectors)) {
    if (assertion.receipt.schemaVersion !== 2) {
      throw new Error(`REAL_PROVIDER_CURRENT_RECEIPT_REQUIRED:${connector}`);
    }
    const localProbe = inventory.probes.find(({ id }) => id === connector);
    if (localProbe === undefined) {
      throw new Error(`REAL_PROVIDER_LOCAL_PROBE_MISSING:${connector}`);
    }
    expect(assertion.receipt.platform).toBe("windows");
    assertLocalProbeMatchesReceipt(connector, {
      availability: localProbe.availability.status,
      authentication: localProbe.authentication.status,
      version: localProbe.version,
    }, assertion.receipt);
    const manifest = computeCapabilityManifest(assertion.receipt, new Date());
    expect(
      manifest.level,
      `${connector} capability level must be computed from its current receipt`,
    ).toBe(assertion.claimedLevel);
    expect(
      manifest.level,
      `${connector} has no current L0 evidence and is not accepted`,
    ).not.toBe("NONE");
    expect(
      manifest.capabilities.some(
        ({ status, evidence }) =>
          status === "supported"
          && (
            evidence?.source === "local_probe"
            || evidence?.source === "phase0_evidence"
          ),
      ),
      `${connector} has no supported atom from authoritative evidence`,
    ).toBe(true);
  }
});
