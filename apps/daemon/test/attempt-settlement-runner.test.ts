import {
  AttemptIdSchema,
  OperationIdSchema,
  RunIdSchema,
} from "@hunter/domain";
import type {
  FlowCommandHandler,
  FlowStore,
  WorkflowRunState,
} from "@hunter/flow-engine";
import { describe, expect, it, vi } from "vitest";

import {
  AttemptSettlementRunner,
  type AttemptObservationPort,
} from "../src/services/attempt-settlement-runner.js";
import type { CompletionVerifierPort } from "../src/services/application-services.js";

const runId = RunIdSchema.parse("run_settlement01");
const attemptId = AttemptIdSchema.parse("att_settlement01");
const operationId = OperationIdSchema.parse("opn_settlement01");

function returnedState(): WorkflowRunState {
  return {
    version: 7,
    steps: [{
      conclusion: "active",
      attempts: [{
        attemptId,
        executionStatus: "returned",
        assignment: {
          operationId,
          capabilityProbeReceiptId: "cpr_settlement01",
          leaseIds: ["wsl_settlement01"],
        },
      }],
    }],
  } as unknown as WorkflowRunState;
}

describe("Attempt settlement crash recovery", () => {
  it("reuses the durable observation evidence hash after observation was recorded", async () => {
    const state = returnedState();
    const flowStore = {
      loadRun: vi.fn(() => state),
    };
    const commands = {
      handle: vi.fn(() => ({
        commandId: "verify-returned-attempt",
        response: {},
      })),
    };
    const observations = {
      observe: vi.fn(async () => ({
        fact: "agent_returned" as const,
        evidenceHash: "a".repeat(64),
      })),
    };
    const verifier = {
      verify: vi.fn(async () => ({
        status: "passed" as const,
        evidence: [{
          kind: "test",
          command: "verify",
          exitCode: 0,
          proofScope: "hunter_contract_only" as const,
        }],
      })),
    };
    const runner = new AttemptSettlementRunner(
      flowStore as unknown as Pick<FlowStore, "loadRun">,
      commands as unknown as FlowCommandHandler,
      observations as AttemptObservationPort,
      verifier as unknown as CompletionVerifierPort,
    );

    await expect(runner.settle(runId)).resolves.toMatchObject({
      runId,
      attemptId,
      verification: "passed",
    });
    expect(observations.observe).toHaveBeenCalledWith({
      runId,
      attemptId,
      operationId,
    });
    expect(verifier.verify).toHaveBeenCalledWith({
      runId,
      attemptId,
      runtimeEvidenceHash: "a".repeat(64),
    });
    expect(commands.handle).toHaveBeenCalledOnce();
    expect(commands.handle).toHaveBeenCalledWith(
      expect.objectContaining({ type: "RecordVerifierResult" }),
    );
  });
});
