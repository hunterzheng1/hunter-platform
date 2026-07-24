import {
  AttentionActionHttpRequestSchema,
  AttentionItemHttpSchema,
} from "@hunter/api-contracts";
import {
  AttemptIdSchema,
  CapabilityProbeReceiptIdSchema,
  EvidenceIdSchema,
  RunIdSchema,
  canonicalSha256,
} from "@hunter/domain";
import { describe, expect, it, vi } from "vitest";

import {
  AttentionActionService,
  type AttentionActionStatePort,
  type AttentionObservationPort,
} from "../src/services/attention-action-service.js";

const runId = RunIdSchema.parse("run_attentionservice01");
const attemptId = AttemptIdSchema.parse("att_attentionservice01");
const evidenceId = EvidenceIdSchema.parse("evd_attentionservice01");
const baseAttention = AttentionItemHttpSchema.parse({
  reasonCode: "external_operation_indeterminate",
  requiredActor: "human_operator",
  inputRevision: {
    changeRevisionId: "crv_attentionservice01",
    workflowRevisionId: "wfr_attentionservice01",
    requirementRevisionIds: ["rrv_attentionservice01"],
    fixedContentHash: "f".repeat(64),
  },
  evidence: [{
    evidenceId,
    contentHash: "a".repeat(64),
  }],
  actions: [
    { action: "confirm_external_result", enabled: true },
    {
      action: "retry_external_check",
      enabled: false,
      capability: {
        probeReceiptId: "cpr_attentionservice01",
        status: "not_proven",
        reasonCode: "observe_not_proven",
      },
    },
    { action: "create_new_attempt", enabled: true },
  ],
});

function fixture() {
  const attempts = [{
    attemptId,
    executionStatus: "needs_attention" as const,
  }];
  const state: AttentionActionStatePort = {
    load: vi.fn(() => ({
      runId,
      version: 7,
      attempts,
      attention: baseAttention,
    })),
  };
  const receipts = new Map<string, {
    readonly fingerprint: string;
    readonly response: {
      readonly fact:
        | "agent_returned"
        | "session_missing"
        | "session_running"
        | "structured_process_exit";
    };
  }>();
  const observations: AttentionObservationPort = {
    replay: vi.fn(async () => null),
    submitInput: vi.fn(async () => undefined),
    recordHumanReceipt: vi.fn(async () => undefined),
    record: vi.fn(async (command) => {
      const fingerprint = canonicalSha256(command);
      const existing = receipts.get(command.idempotencyKey);
      if (existing !== undefined && existing.fingerprint !== fingerprint) {
        throw new Error("ATTENTION_IDEMPOTENCY_CONFLICT");
      }
      const response = { fact: command.fact };
      receipts.set(command.idempotencyKey, { fingerprint, response });
      return response;
    }),
    retry: vi.fn(),
    createAttempt: vi.fn(async () => ({
      attemptId: AttemptIdSchema.parse("att_attentionservice02"),
    })),
  };
  return {
    service: new AttentionActionService(state, observations),
    state,
    observations,
    attempts,
  };
}

describe("AttentionActionService", () => {
  it("records the same external observation idempotently without completing the Step", async () => {
    const { service, observations, attempts } = fixture();
    const command = AttentionActionHttpRequestSchema.parse({
      attemptId,
      action: "confirm_external_result",
      expectedVersion: 7,
      idempotencyKey: "attention-confirm-stable",
      observation: {
        fact: "agent_returned",
        evidenceId,
        contentHash: "a".repeat(64),
      },
    });
    if (command.action !== "confirm_external_result") {
      throw new Error("TEST_ATTENTION_COMMAND_KIND_INVALID");
    }

    const first = await service.execute(runId, command, {
      actorId: "desktop-owner",
      correlationId: command.idempotencyKey,
    });
    const second = await service.execute(runId, command, {
      actorId: "desktop-owner",
      correlationId: command.idempotencyKey,
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      effect: "observation_recorded",
      stepCompletion: "verifier_required",
    });
    expect(first).not.toHaveProperty("succeeded");
    expect(observations.record).toHaveBeenCalledTimes(2);
    expect(attempts).toEqual([{
      attemptId,
      executionStatus: "needs_attention",
    }]);
  });

  it("rejects mismatched reuse, stale versions, disabled actions, and historical Attempts", async () => {
    const { service, state, observations } = fixture();
    const command = AttentionActionHttpRequestSchema.parse({
      attemptId,
      action: "confirm_external_result",
      expectedVersion: 7,
      idempotencyKey: "attention-confirm-conflict",
      observation: {
        fact: "session_missing",
        evidenceId,
        contentHash: "a".repeat(64),
      },
    });
    if (command.action !== "confirm_external_result") {
      throw new Error("TEST_ATTENTION_COMMAND_KIND_INVALID");
    }
    await service.execute(runId, command, {
      actorId: "desktop-owner",
      correlationId: command.idempotencyKey,
    });
    await expect(service.execute(runId, {
      ...command,
      observation: {
        ...command.observation,
        fact: "session_running",
      },
    }, {
      actorId: "desktop-owner",
      correlationId: command.idempotencyKey,
    })).rejects.toThrow("ATTENTION_IDEMPOTENCY_CONFLICT");
    await expect(service.execute(runId, {
      ...command,
      expectedVersion: 6,
      idempotencyKey: "attention-stale-version",
    }, {
      actorId: "desktop-owner",
      correlationId: "attention-stale-version",
    })).rejects.toThrow("ATTENTION_VERSION_CONFLICT");
    await expect(service.execute(runId, {
      attemptId,
      action: "retry_external_check",
      capabilityProbeReceiptId: CapabilityProbeReceiptIdSchema.parse(
        "cpr_attentionservice01",
      ),
      expectedVersion: 7,
      idempotencyKey: "attention-disabled-action",
    }, {
      actorId: "desktop-owner",
      correlationId: "attention-disabled-action",
    })).rejects.toThrow("ATTENTION_ACTION_DISABLED");

    vi.mocked(state.load).mockReturnValue({
      runId,
      version: 7,
      attempts: [
        { attemptId, executionStatus: "stale" },
        {
          attemptId: AttemptIdSchema.parse("att_attentionservice02"),
          executionStatus: "running",
        },
      ],
      attention: baseAttention,
    });
    await expect(service.execute(runId, {
      ...command,
      idempotencyKey: "attention-historical-attempt",
    }, {
      actorId: "desktop-owner",
      correlationId: "attention-historical-attempt",
    })).rejects.toThrow("ATTENTION_ATTEMPT_NOT_CURRENT");
    expect(observations.retry).not.toHaveBeenCalled();
  });

  it("requests a new Attempt while retaining the prior Attempt as history", async () => {
    const { service, observations, attempts } = fixture();
    const response = await service.execute(runId, {
      attemptId,
      action: "create_new_attempt",
      expectedVersion: 7,
      idempotencyKey: "attention-create-new-attempt",
    }, {
      actorId: "desktop-owner",
      correlationId: "attention-create-new-attempt",
    });

    expect(response).toEqual({
      runId,
      attemptId,
      action: "create_new_attempt",
      status: "accepted",
      effect: "new_attempt_requested",
      stepCompletion: "unchanged",
    });
    expect(observations.createAttempt).toHaveBeenCalledWith({
      runId,
      priorAttemptId: attemptId,
      expectedVersion: 7,
      idempotencyKey: "attention-create-new-attempt",
      actor: {
        actorId: "desktop-owner",
        correlationId: "attention-create-new-attempt",
      },
    });
    expect(attempts).toEqual([{
      attemptId,
      executionStatus: "needs_attention",
    }]);
  });

  it("records supplemental input and a human verifier receipt through narrow ports", async () => {
    const { service, state, observations } = fixture();
    const text = "请补充失败日志";
    vi.mocked(state.load).mockReturnValue({
      runId,
      version: 7,
      attempts: [{ attemptId, executionStatus: "waiting_input" }],
      attention: AttentionItemHttpSchema.parse({
        ...baseAttention,
        reasonCode: "input_required",
        actions: [{ action: "submit_input", enabled: true }],
      }),
    });
    await expect(service.execute(runId, {
      attemptId,
      action: "submit_input",
      input: {
        text,
        contentHash: canonicalSha256(text),
      },
      expectedVersion: 7,
      idempotencyKey: "attention-submit-input",
    }, {
      actorId: "desktop-owner",
      correlationId: "attention-submit-input",
    })).resolves.toMatchObject({
      action: "submit_input",
      effect: "input_recorded",
      stepCompletion: "unchanged",
    });
    expect(observations.submitInput).toHaveBeenCalledWith(expect.objectContaining({
      runId,
      attemptId,
      text,
      contentHash: canonicalSha256(text),
    }));

    vi.mocked(state.load).mockReturnValue({
      runId,
      version: 8,
      attempts: [{ attemptId, executionStatus: "running" }],
      attention: AttentionItemHttpSchema.parse({
        ...baseAttention,
        reasonCode: "human_verification_required",
        actions: [{ action: "record_human_receipt", enabled: true }],
      }),
    });
    await expect(service.execute(runId, {
      attemptId,
      action: "record_human_receipt",
      receipt: {
        evidenceRef: {
          evidenceId,
          contentHash: "a".repeat(64),
        },
        acknowledgedInputHash: "f".repeat(64),
      },
      expectedVersion: 8,
      idempotencyKey: "attention-human-receipt",
    }, {
      actorId: "desktop-owner",
      correlationId: "attention-human-receipt",
    })).resolves.toMatchObject({
      action: "record_human_receipt",
      effect: "human_receipt_recorded",
      stepCompletion: "human_verified",
    });
    expect(observations.recordHumanReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        runId,
        attemptId,
        evidenceRef: {
          evidenceId,
          contentHash: "a".repeat(64),
        },
        acknowledgedInputHash: "f".repeat(64),
      }),
    );
  });

  it("returns a durable replay before current-version and current-Attempt checks", async () => {
    const { service, state, observations } = fixture();
    const command = AttentionActionHttpRequestSchema.parse({
      attemptId,
      action: "confirm_external_result",
      expectedVersion: 7,
      idempotencyKey: "attention-confirm-replay",
      observation: {
        fact: "session_missing",
        evidenceId,
        contentHash: "a".repeat(64),
      },
    });
    const first = await service.execute(runId, command, {
      actorId: "desktop-owner",
      correlationId: command.idempotencyKey,
    });
    vi.mocked(observations.replay).mockResolvedValueOnce(first);
    vi.mocked(state.load).mockReturnValue({
      runId,
      version: 8,
      attempts: [{
        attemptId: AttemptIdSchema.parse("att_attentionservice02"),
        executionStatus: "running",
      }],
      attention: baseAttention,
    });

    await expect(service.execute(runId, command, {
      actorId: "desktop-owner",
      correlationId: command.idempotencyKey,
    })).resolves.toEqual(first);
    expect(state.load).toHaveBeenCalledTimes(1);
  });
});
