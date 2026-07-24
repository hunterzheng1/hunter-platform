import { describe, expect, it } from "vitest";

import { verifyResourceBounds } from "./verify-resource-bounds.js";

describe("Phase 1 resource-bounds verification", () => {
  it("measures bounded log delivery with waiting and active Fake workloads", async () => {
    const result = await verifyResourceBounds();

    expect(result).toMatchObject({
      schemaVersion: 1,
      status: "PASS",
      proofScope: "contract_only",
      scenario: {
        readonlyWaitingSteps: 10,
        activeFakeSteps: 4,
        largeLogEntries: 42,
      },
      checks: {
        boundedPages: true,
        retentionResync: true,
        softQuotaWarning: true,
        hardQuotaRejection: true,
        coreReceiptReserve: true,
        protectedRetention: true,
        slowClientDisconnected: true,
        durableReplay: true,
        fakeRuntimeReceipts: true,
      },
    });
    expect(result.limits.storage).toEqual(result.limits.http);
    expect(result.measurements.maxObservedPageItems)
      .toBeLessThanOrEqual(result.limits.storage.maxPageItems);
    expect(result.measurements.maxObservedPageBytes)
      .toBeLessThanOrEqual(result.limits.storage.maxPageBytes);
    expect(JSON.stringify(result)).not.toMatch(
      /(?:[A-Z]:\\|\/(?:home|Users|tmp)\/|relativePath|contentRef)/u,
    );
  });
});
