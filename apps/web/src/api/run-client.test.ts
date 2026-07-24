import { describe, expect, it, vi } from "vitest";
import { RunIdSchema } from "@hunter/domain/ids";

import { HunterApi } from "./client.js";

const requestedRunId = RunIdSchema.parse("run_task400001");
const validResponse = {
  runId: requestedRunId,
  projectionPosition: 3,
  status: "running",
  steps: [{
    stepRunId: "spr_task400001",
    title: "测试",
    conclusion: "active",
    attempts: [{
      attemptId: "att_task400001",
      attemptNumber: 1,
      executionStatus: "returned",
      verificationStatus: "failed",
      artifactIds: [],
      evidenceIds: [],
    }],
  }],
} as const;

describe("HunterApi.getRun", () => {
  it("uses the authenticated transport receiver and strictly parses the response", async () => {
    const transport = {
      marker: "trusted-host",
      request: vi.fn(async function (this: { marker: string }, path: string) {
        expect(this.marker).toBe("trusted-host");
        expect(path).toBe(`/api/v1/runs/${requestedRunId}`);
        return validResponse;
      }),
    };
    const api = new HunterApi(transport);

    await expect(Reflect.apply(api.getRun, api, [requestedRunId])).resolves.toMatchObject(validResponse);
  });

  it("rejects a different Run scope and provider-private response fields", async () => {
    const mismatched = new HunterApi({ request: async () => ({ ...validResponse, runId: "run_task400002" }) });
    await expect(mismatched.getRun(requestedRunId)).rejects.toThrow("RUN_RESPONSE_SCOPE_MISMATCH");

    const privateResponse = new HunterApi({
      request: async () => ({
        ...validResponse,
        steps: [{
          ...validResponse.steps[0],
          attempts: [{ ...validResponse.steps[0].attempts[0], nativeSessionRef: "orca:private" }],
        }],
      }),
    });
    await expect(privateResponse.getRun(requestedRunId)).rejects.toThrow();
  });
});
