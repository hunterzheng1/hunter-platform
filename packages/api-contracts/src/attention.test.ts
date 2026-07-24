import { describe, expect, it } from "vitest";

import {
  AttentionActionHttpRequestSchema,
  AttentionActionHttpResponseSchema,
  AttentionItemHttpSchema,
  RunViewHttpResponseSchema,
} from "./http.js";

const inputRevision = {
  changeRevisionId: "crv_attention001",
  workflowRevisionId: "wfr_attention001",
  requirementRevisionIds: ["rrv_attention001"],
  fixedContentHash: "a".repeat(64),
} as const;

const externalAttention = {
  reasonCode: "external_operation_indeterminate",
  requiredActor: "human_operator",
  inputRevision,
  evidence: [{
    evidenceId: "evd_attention001",
    contentHash: "a".repeat(64),
  }],
  actions: [
    {
      action: "confirm_external_result",
      enabled: true,
    },
    {
      action: "retry_external_check",
      enabled: false,
      capability: {
        probeReceiptId: "cpr_attention001",
        status: "not_proven",
        reasonCode: "observe_not_proven",
      },
    },
    {
      action: "create_new_attempt",
      enabled: true,
    },
  ],
} as const;

describe("Attention HTTP contracts", () => {
  it("accepts a provider-neutral AttentionItem with receipt-derived actions", () => {
    expect(AttentionItemHttpSchema.parse(externalAttention)).toEqual(
      externalAttention,
    );
    expect(() => AttentionItemHttpSchema.parse({
      ...externalAttention,
      providerSessionId: "private-runtime-session",
    })).toThrow();
    expect(AttentionItemHttpSchema.parse({
      ...externalAttention,
      actions: [{
        action: "create_new_attempt",
        enabled: false,
        disabledReasonCode: "attempt_limit_reached",
      }],
    }).actions[0]).toEqual({
      action: "create_new_attempt",
      enabled: false,
      disabledReasonCode: "attempt_limit_reached",
    });
    expect(() => AttentionItemHttpSchema.parse({
      ...externalAttention,
      actions: [{
        action: "create_new_attempt",
        enabled: true,
        disabledReasonCode: "attempt_limit_reached",
      }],
    })).toThrow();
    expect(() => AttentionItemHttpSchema.parse({
      ...externalAttention,
      actions: [{
        action: "retry_external_check",
        enabled: true,
      }],
    })).toThrow();
    expect(() => AttentionItemHttpSchema.parse({
      ...externalAttention,
      actions: [{
        action: "retry_external_check",
        enabled: true,
        capability: {
          probeReceiptId: "cpr_attention001",
          status: "not_proven",
          reasonCode: "observe_not_proven",
        },
      }],
    })).toThrow();
    expect(() => AttentionItemHttpSchema.parse({
      ...externalAttention,
      actions: [{ action: "mark_success", enabled: true }],
    })).toThrow();
  });

  it("accepts a durable Flow event as Attention evidence without minting an Evidence record id", () => {
    const flowEventAttention = {
      ...externalAttention,
      evidence: [{
        source: "flow_event",
        eventId: "evt_attention_state_0001",
        contentHash: "b".repeat(64),
      }],
      actions: [{
        action: "record_human_receipt",
        enabled: true,
      }],
    } as const;
    expect(AttentionItemHttpSchema.parse(flowEventAttention)).toEqual(
      flowEventAttention,
    );
    const request = {
      attemptId: "att_attention001",
      action: "record_human_receipt",
      expectedVersion: 4,
      idempotencyKey: "attention-human-001",
      receipt: {
        evidenceRef: flowEventAttention.evidence[0],
        acknowledgedInputHash: inputRevision.fixedContentHash,
      },
    } as const;
    expect(AttentionActionHttpRequestSchema.parse(request)).toEqual(request);
  });

  it("requires AttentionItem details for waiting, failed, stale, and attention states", () => {
    for (const executionStatus of [
      "waiting_input",
      "failed",
      "stale",
      "needs_attention",
    ] as const) {
      const waitingReason = executionStatus === "waiting_input"
        ? { code: "input_required" as const }
        : executionStatus === "needs_attention"
          ? { code: "recovery_attention_required" as const }
          : undefined;
      const result = RunViewHttpResponseSchema.safeParse({
        runId: "run_attention001",
        projectionPosition: 4,
        aggregateVersion: 4,
        status: "needs_attention",
        steps: [{
          stepRunId: "spr_attention001",
          title: "恢复",
          conclusion: "active",
          attempts: [{
            attemptId: "att_attention001",
            attemptNumber: 1,
            executionStatus,
            verificationStatus: "pending",
            artifactIds: [],
            evidenceIds: ["evd_attention001"],
            waitingReason,
          }],
        }],
      });
      expect(result.success).toBe(false);
    }
  });

  it("accepts only narrow idempotent actions that cannot assert Step success", () => {
    const request = {
      attemptId: "att_attention001",
      action: "confirm_external_result",
      expectedVersion: 4,
      idempotencyKey: "attention-confirm-001",
      observation: {
        fact: "session_missing",
        evidenceId: "evd_attention001",
        contentHash: "a".repeat(64),
      },
    };
    expect(AttentionActionHttpRequestSchema.parse(request)).toEqual(request);
    for (const forbidden of [
      { outcome: "succeeded" },
      { terminalCommand: "approve-all" },
      { providerSessionId: "private" },
    ]) {
      expect(() => AttentionActionHttpRequestSchema.parse({
        ...request,
        ...forbidden,
      })).toThrow();
    }
    expect(AttentionActionHttpResponseSchema.parse({
      runId: "run_attention001",
      attemptId: request.attemptId,
      action: request.action,
      status: "recorded",
      effect: "observation_recorded",
      stepCompletion: "verifier_required",
    })).toMatchObject({
      status: "recorded",
      stepCompletion: "verifier_required",
    });
    expect(() => AttentionActionHttpResponseSchema.parse({
      runId: "run_attention001",
      attemptId: request.attemptId,
      action: request.action,
      status: "recorded",
      effect: "step_succeeded",
      stepCompletion: "succeeded",
    })).toThrow();
  });
});
