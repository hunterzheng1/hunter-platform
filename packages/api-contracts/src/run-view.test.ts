import { describe, expect, it } from "vitest";

import {
  RunEventEnvelopeHttpSchema,
  RunEventResyncHttpSchema,
  RunViewHttpResponseSchema,
} from "./http.js";

const validRun = {
  runId: "run_task400001",
  status: "running",
  steps: [
    {
      stepRunId: "spr_task400001",
      title: "测试",
      conclusion: "active",
      attempts: [
        {
          attemptId: "att_task400001",
          attemptNumber: 1,
          executionStatus: "returned",
          verificationStatus: "failed",
          agentProfileId: "apr_task400001",
          evidenceIds: ["evd_task400001"],
        },
        {
          attemptId: "att_task400002",
          attemptNumber: 2,
          executionStatus: "running",
          verificationStatus: "pending",
          evidenceIds: [],
        },
      ],
    },
  ],
} as const;

describe("Run HTTP view contracts", () => {
  it("accepts the canonical Flow status vocabulary while retaining every Attempt", () => {
    expect(RunViewHttpResponseSchema.parse(validRun)).toMatchObject(validRun);

    const executionStatuses = [
      "assigned",
      "running",
      "waiting_input",
      "returned",
      "failed",
      "canceled",
      "stale",
      "needs_attention",
    ];
    const verificationStatuses = [
      "pending",
      "verifying",
      "passed",
      "failed",
      "error",
      "needs_human",
      "canceled",
    ];
    for (const executionStatus of executionStatuses) {
      expect(RunViewHttpResponseSchema.safeParse({
        ...validRun,
        steps: [{
          ...validRun.steps[0],
          attempts: [{ ...validRun.steps[0].attempts[0], executionStatus }],
        }],
      }).success).toBe(true);
    }
    for (const verificationStatus of verificationStatuses) {
      expect(RunViewHttpResponseSchema.safeParse({
        ...validRun,
        steps: [{
          ...validRun.steps[0],
          attempts: [{ ...validRun.steps[0].attempts[0], verificationStatus }],
        }],
      }).success).toBe(true);
    }
  });

  it("rejects private runtime data, unknown status values, duplicate Attempts, and unordered histories", () => {
    expect(RunViewHttpResponseSchema.safeParse({
      ...validRun,
      steps: [{
        ...validRun.steps[0],
        attempts: [{ ...validRun.steps[0].attempts[0], nativeSessionRef: "private-session" }],
      }],
    }).success).toBe(false);
    expect(RunViewHttpResponseSchema.safeParse({
      ...validRun,
      steps: [{
        ...validRun.steps[0],
        attempts: [{ ...validRun.steps[0].attempts[0], executionStatus: "idle" }],
      }],
    }).success).toBe(false);
    expect(RunViewHttpResponseSchema.safeParse({
      ...validRun,
      steps: [{
        ...validRun.steps[0],
        attempts: [validRun.steps[0].attempts[0], validRun.steps[0].attempts[0]],
      }],
    }).success).toBe(false);
    expect(RunViewHttpResponseSchema.safeParse({
      ...validRun,
      steps: [{
        ...validRun.steps[0],
        attempts: [validRun.steps[0].attempts[1], validRun.steps[0].attempts[0]],
      }],
    }).success).toBe(false);
  });

  it("rejects a successful Step unless its final authoritative verification passed", () => {
    expect(RunViewHttpResponseSchema.safeParse({
      ...validRun,
      steps: [{
        ...validRun.steps[0],
        conclusion: "succeeded",
        attempts: [{
          ...validRun.steps[0].attempts[0],
          executionStatus: "returned",
          verificationStatus: "failed",
        }],
      }],
    }).success).toBe(false);
    expect(RunViewHttpResponseSchema.safeParse({
      ...validRun,
      steps: [{ ...validRun.steps[0], conclusion: "succeeded", attempts: [] }],
    }).success).toBe(false);
    expect(RunViewHttpResponseSchema.safeParse({
      ...validRun,
      steps: [{
        ...validRun.steps[0],
        conclusion: "succeeded",
        attempts: [{
          ...validRun.steps[0].attempts[0],
          executionStatus: "returned",
          verificationStatus: "passed",
        }],
      }],
    }).success).toBe(true);
  });

  it("rejects missing Attempt history and cross-Step Attempt identity reuse", () => {
    expect(RunViewHttpResponseSchema.safeParse({
      ...validRun,
      steps: [{
        ...validRun.steps[0],
        attempts: [
          validRun.steps[0].attempts[0],
          { ...validRun.steps[0].attempts[1], attemptNumber: 3 },
        ],
      }],
    }).success).toBe(false);
    expect(RunViewHttpResponseSchema.safeParse({
      ...validRun,
      steps: [{
        ...validRun.steps[0],
        attempts: [{ ...validRun.steps[0].attempts[0], attemptNumber: 2 }],
      }],
    }).success).toBe(false);
    expect(RunViewHttpResponseSchema.safeParse({
      ...validRun,
      steps: [
        { ...validRun.steps[0], attempts: [validRun.steps[0].attempts[0]] },
        {
          ...validRun.steps[0],
          stepRunId: "spr_task400002",
          attempts: [{ ...validRun.steps[0].attempts[0], attemptNumber: 1 }],
        },
      ],
    }).success).toBe(false);
  });

  it("strictly validates scoped durable event and resync envelopes", () => {
    expect(RunEventEnvelopeHttpSchema.parse({
      schemaVersion: 1,
      position: 7,
      runId: validRun.runId,
      eventType: "run_projection_changed",
    })).toMatchObject({ position: 7, runId: validRun.runId });
    expect(RunEventEnvelopeHttpSchema.safeParse({
      schemaVersion: 1,
      position: 7,
      runId: validRun.runId,
      eventType: "run_projection_changed",
      terminalPath: "C:\\private",
    }).success).toBe(false);
    expect(RunEventResyncHttpSchema.parse({
      schemaVersion: 1,
      runId: validRun.runId,
      code: "EVENT_CURSOR_RESYNC_REQUIRED",
      retentionFloor: 4,
      highWaterPosition: 9,
    })).toMatchObject({ retentionFloor: 4, highWaterPosition: 9 });
  });
});
