import { describe, expect, it, vi } from "vitest";
import {
  AttemptIdSchema,
  CapabilityProbeReceiptIdSchema,
  RunIdSchema,
} from "@hunter/domain/ids";

import { HunterApi } from "./client.js";

const requestedRunId = RunIdSchema.parse("run_task400001");
const validResponse = {
  runId: requestedRunId,
  projectionPosition: 3,
  aggregateVersion: 4,
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
      evidenceIds: ["evd_task400001"],
      attention: {
        reasonCode: "verifier_failed",
        requiredActor: "hunter_verifier",
        inputRevision: {
          changeRevisionId: "crv_task400001",
          workflowRevisionId: "wfr_task400001",
          requirementRevisionIds: ["rrv_task400001"],
          fixedContentHash: "a".repeat(64),
        },
        evidence: [{
          evidenceId: "evd_task400001",
          contentHash: "a".repeat(64),
        }],
        actions: [{ action: "create_new_attempt", enabled: true }],
      },
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

describe("HunterApi.executeAttentionAction", () => {
  it("reuses the exact idempotency envelope after an ambiguous transport result", async () => {
    const bodies: string[] = [];
    const transport = {
      request: vi.fn(async (_path: string, init?: RequestInit) => {
        bodies.push(String(init?.body));
        if (bodies.length === 1) throw new Error("AMBIGUOUS_TRANSPORT_RESULT");
        return {
          runId: requestedRunId,
          attemptId: "att_task400001",
          action: "retry_external_check",
          status: "recorded",
          effect: "recheck_requested",
          stepCompletion: "verifier_required",
        };
      }),
    };
    const api = new HunterApi(transport, {
      projectId: () => "prj_unused000001",
      requirementId: () => "req_unused000001",
      requirementRevisionId: () => "rrv_unused000001",
      idempotencyKey: () => "attention-client-stable-key",
    });
    const input = {
      attemptId: AttemptIdSchema.parse("att_task400001"),
      action: "retry_external_check" as const,
      capabilityProbeReceiptId:
        CapabilityProbeReceiptIdSchema.parse("cpr_task400001"),
      expectedVersion: 4,
    };

    await expect(
      api.executeAttentionAction(requestedRunId, input),
    ).rejects.toThrow("AMBIGUOUS_TRANSPORT_RESULT");
    await expect(
      api.executeAttentionAction(requestedRunId, input),
    ).resolves.toMatchObject({
      action: input.action,
      stepCompletion: "verifier_required",
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(JSON.parse(bodies[0]!)).toMatchObject({
      ...input,
      idempotencyKey: "attention-client-stable-key",
    });
  });
});
