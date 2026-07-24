import {
  AttemptIdSchema,
  EvidenceIdSchema,
  RunIdSchema,
} from "@hunter/domain";
import { describe, expect, it, vi } from "vitest";

import { buildTestApp, projectA, projectB } from "./support/build-test-app.js";

const runId = RunIdSchema.parse("run_attentionroute01");
const attemptId = AttemptIdSchema.parse("att_attentionroute01");
const evidenceId = EvidenceIdSchema.parse("evd_attentionroute01");
const payload = {
  attemptId,
  action: "confirm_external_result" as const,
  expectedVersion: 7,
  idempotencyKey: "attention-route-confirm",
  observation: {
    fact: "session_missing" as const,
    evidenceId,
    contentHash: "a".repeat(64),
  },
};

describe("Attention action route", () => {
  it("serves an authorized strict production RunView and hides cross-project runs", async () => {
    const getRun = vi.fn(() => ({
      runId,
      projectionPosition: 9,
      aggregateVersion: 7,
      status: "created" as const,
      steps: [],
    }));
    const projectForRun = vi.fn(() => ({ projectId: projectA, runId }));
    const { app, headers } = buildTestApp({ projectForRun, getRun });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      runId,
      projectionPosition: 9,
      aggregateVersion: 7,
      status: "created",
      steps: [],
    });

    projectForRun.mockReturnValueOnce({ projectId: projectB, runId });
    const forbidden = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}`,
      headers,
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({ code: "PROJECT_FORBIDDEN" });
    expect(getRun).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("authorizes the Run scope and forwards a strict idempotent command", async () => {
    const executeAttentionAction = vi.fn(async () => ({
      runId,
      attemptId,
      action: payload.action,
      status: "recorded" as const,
      effect: "observation_recorded" as const,
      stepCompletion: "unchanged" as const,
    }));
    const { app, headers } = buildTestApp({
      projectForRun: vi.fn(() => ({ projectId: projectA, runId })),
      executeAttentionAction,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/attention-actions`,
      headers,
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      runId,
      attemptId,
      stepCompletion: "unchanged",
    });
    expect(executeAttentionAction).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({
        expectedVersion: 7,
        idempotencyKey: "attention-route-confirm",
      }),
      {
        actorId: "desktop-owner",
        correlationId: "attention-route-confirm",
      },
    );
    await app.close();
  });

  it("rejects unknown fields and unauthorized Run scope before execution", async () => {
    const executeAttentionAction = vi.fn();
    const { app, headers } = buildTestApp({
      projectForRun: vi.fn(() => ({ projectId: projectB, runId })),
      executeAttentionAction,
    });

    const malformed = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/attention-actions`,
      headers,
      payload: { ...payload, terminalCommand: "approve-all" },
    });
    const forbidden = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/attention-actions`,
      headers,
      payload,
    });

    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({ code: "REQUEST_SCHEMA_INVALID" });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({ code: "PROJECT_FORBIDDEN" });
    expect(executeAttentionAction).not.toHaveBeenCalled();
    await app.close();
  });

  it("maps expected command conflicts to fixed safe responses", async () => {
    const { app, headers } = buildTestApp({
      projectForRun: vi.fn(() => ({ projectId: projectA, runId })),
      executeAttentionAction: vi.fn(async () => {
        throw new Error("ATTENTION_VERSION_CONFLICT");
      }),
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/attention-actions`,
      headers,
      payload,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: "ATTENTION_VERSION_CONFLICT",
    });
    await app.close();
  });

  it("maps a detailed ledger version conflict to a fixed safe 409 code", async () => {
    const { app, headers } = buildTestApp({
      projectForRun: vi.fn(() => ({ projectId: projectA, runId })),
      executeAttentionAction: vi.fn(async () => {
        throw new Error("EXPECTED_VERSION_CONFLICT expected=7 actual=8");
      }),
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/attention-actions`,
      headers,
      payload,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: "EXPECTED_VERSION_CONFLICT",
    });
    await app.close();
  });
});
