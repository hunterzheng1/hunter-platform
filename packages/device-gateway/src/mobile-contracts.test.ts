import { describe, expect, it } from "vitest";

import {
  MobileCommandEnvelopeSchema,
  MobileScopeSetSchema,
  MobileRunProjectionSchema,
} from "./mobile-contracts.js";

const projectId = "prj_mobile00001";
const runId = "run_mobile00001";
const stepRunId = "spr_mobile00001";
const gateId = "gat_mobile00001";

function command(overrides: Record<string, unknown> = {}) {
  return {
    projectId,
    runId,
    stepRunId,
    expectedVersion: 7,
    idempotencyKey: "mobile-command-0001",
    action: "pause_run",
    payload: {},
    ...overrides,
  };
}

describe("mobile public contracts", () => {
  it("freezes the four least-privilege mobile scopes", () => {
    expect(MobileScopeSetSchema.parse([
      "runs:read",
      "artifacts:read",
      "gates:approve",
      "runs:control",
    ])).toHaveLength(4);
    expect(MobileScopeSetSchema.safeParse(["policy:write"]).success).toBe(false);
    expect(MobileScopeSetSchema.safeParse(["runs:read", "runs:read"]).success).toBe(false);
    expect(MobileScopeSetSchema.safeParse([]).success).toBe(false);
  });

  it("requires branded scope, version, idempotency, target, action, and bounded payload", () => {
    expect(MobileCommandEnvelopeSchema.parse(command())).toMatchObject({
      projectId,
      runId,
      stepRunId,
      action: "pause_run",
    });
    expect(MobileCommandEnvelopeSchema.safeParse(command({ projectId: "project-mobile" })).success).toBe(false);
    expect(MobileCommandEnvelopeSchema.safeParse(command({ runId: "run-short" })).success).toBe(false);
    expect(MobileCommandEnvelopeSchema.safeParse(command({ expectedVersion: Number.MAX_SAFE_INTEGER + 1 })).success).toBe(false);
    expect(MobileCommandEnvelopeSchema.safeParse(command({ idempotencyKey: "short" })).success).toBe(false);
    expect(MobileCommandEnvelopeSchema.safeParse(command({ action: "policy:write" })).success).toBe(false);
    expect(MobileCommandEnvelopeSchema.safeParse(command({ payload: { text: "x" } })).success).toBe(false);
    expect(MobileCommandEnvelopeSchema.safeParse(command({ credential: "must-not-cross" })).success).toBe(false);
  });

  it("requires exactly one Step or Gate target and action-specific payload", () => {
    expect(MobileCommandEnvelopeSchema.safeParse(command({ gateId })).success).toBe(false);
    expect(MobileCommandEnvelopeSchema.safeParse(command({ stepRunId: undefined })).success).toBe(false);
    expect(MobileCommandEnvelopeSchema.safeParse(command({
      stepRunId: undefined,
      gateId,
      action: "approve_gate",
    })).success).toBe(true);
    expect(MobileCommandEnvelopeSchema.safeParse(command({
      action: "supplement_input",
      payload: { text: "继续检查失败日志" },
    })).success).toBe(true);
    expect(MobileCommandEnvelopeSchema.safeParse(command({
      action: "supplement_input",
      payload: { text: "x".repeat(4_001) },
    })).success).toBe(false);
  });

  it("binds Gate decisions to gates and all other actions to Step Runs", () => {
    for (const action of ["approve_gate", "reject_gate"] as const) {
      expect(MobileCommandEnvelopeSchema.safeParse(command({ action })).success).toBe(false);
      expect(MobileCommandEnvelopeSchema.safeParse(command({
        stepRunId: undefined,
        gateId,
        action,
      })).success).toBe(true);
    }
    for (const action of ["supplement_input", "pause_run", "resume_run", "terminate_run"] as const) {
      const payload = action === "supplement_input" ? { text: "继续" } : {};
      expect(MobileCommandEnvelopeSchema.safeParse(command({ action, payload })).success).toBe(true);
      expect(MobileCommandEnvelopeSchema.safeParse(command({
        stepRunId: undefined,
        gateId,
        action,
        payload,
      })).success).toBe(false);
    }
  });

  it("rejects runId-only projections and command scope mismatches", () => {
    const projection = {
      projectId,
      runId,
      projectName: "Hunter",
      currentStep: "approve_plan",
      attention: "等待批准",
      connection: "online",
      commands: [command({
        stepRunId: undefined,
        gateId,
        action: "approve_gate",
      })],
    };
    expect(MobileRunProjectionSchema.safeParse(projection).success).toBe(true);
    expect(MobileRunProjectionSchema.safeParse({ runId }).success).toBe(false);
    expect(MobileRunProjectionSchema.safeParse({
      ...projection,
      commands: [command({ projectId: "prj_mobile00002" })],
    }).success).toBe(false);
  });
});
