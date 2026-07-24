import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("production Runtime and verifier composition", () => {
  it("owns attempt observation and verification outside the E2E fixture", () => {
    const fixtureSource = readFileSync(
      resolve(
        import.meta.dirname,
        "fixtures",
        "e2e-application.ts",
      ),
      "utf8",
    );
    const compositionSource = readFileSync(
      resolve(
        import.meta.dirname,
        "..",
        "src",
        "services",
        "composition-root.ts",
      ),
      "utf8",
    );

    expect(fixtureSource).not.toMatch(
      /services\.flowEngine\.handle\(\{\s*type:\s*"RecordExternalObservation"/u,
    );
    expect(fixtureSource).not.toMatch(
      /services\.flowEngine\.handle\(\{\s*type:\s*"RecordVerifierResult"/u,
    );
    expect(compositionSource).toContain("AttemptSettlementRunner");
    expect(compositionSource).toContain("attemptSettlement");
  });

  it("queries Outbox, receipts, and leases through their owning modules", () => {
    const serviceSources = [
      "sqlite-application-services.ts",
      "sqlite-attempt-observation.ts",
    ].map((file) =>
      readFileSync(
        resolve(import.meta.dirname, "..", "src", "services", file),
        "utf8",
      ));

    for (const source of serviceSources) {
      expect(source).not.toMatch(
        /\b(?:FROM|UPDATE)\s+(?:outbox|side_effect_receipts|lease_records)\b/iu,
      );
    }
  });
});
