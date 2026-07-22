import { describe, expect, it } from "vitest";

import { StartRunHttpRequestSchema } from "./http.js";

describe("HTTP command schemas", () => {
  it("accepts only the stable root StartRun authority", () => {
    const valid = { runId: "run_http000001", executionPlanId: "epl_http000001", workflowRevisionId: "wfr_http000001", expectedVersion: 0, idempotencyKey: "start-http-1" };
    expect(StartRunHttpRequestSchema.parse(valid)).toEqual(valid);
    for (const forbidden of ["absolutePath", "policySnapshot", "remainingBudget", "actor", "projectId", "deviceBindingPath"] as const) {
      expect(() => StartRunHttpRequestSchema.parse({ ...valid, [forbidden]: "caller-owned" })).toThrow();
    }
  });

  it("rejects malformed IDs, unknown fields, and invalid versions", () => {
    expect(() => StartRunHttpRequestSchema.parse({ runId: "bad", executionPlanId: "epl_http000001", workflowRevisionId: "wfr_http000001", expectedVersion: -1, idempotencyKey: "x", extra: true })).toThrow();
  });
});
