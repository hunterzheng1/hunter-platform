import { describe, expect, it } from "vitest";
import {
  createAppServerPlan,
  createApprovalDenial,
  createInterruptRequest,
  createTurnStartRequest,
  parseAppServerLine,
  summarizeAppServerTranscript,
} from "./app-server-protocol.js";

describe("Codex app-server protocol seam", () => {
  it("plans one ephemeral read-only stdio thread", () => {
    expect(createAppServerPlan("C:\\fixture")).toEqual({
      executableArgs: ["app-server", "--stdio"],
      initialize: {
        method: "initialize",
        id: 1,
        params: {
          clientInfo: {
            name: "hunter_phase0",
            title: "Hunter Phase 0",
            version: "0.1.0",
          },
        },
      },
      initialized: { method: "initialized", params: {} },
      threadStart: {
        method: "thread/start",
        id: 2,
        params: {
          cwd: "C:\\fixture",
          ephemeral: true,
          sandbox: "read-only",
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
        },
      },
    });
  });

  it("rejects paths and protocol input that could weaken the boundary", () => {
    expect(() => createAppServerPlan("fixture")).toThrow("APP_SERVER_FIXTURE_ABSOLUTE_REQUIRED");
    expect(() => createAppServerPlan("danger-full-access")).toThrow();
    expect(() => parseAppServerLine("not-json")).toThrow("APP_SERVER_PROTOCOL_INVALID_JSON");
  });

  it("denies every supported approval request and rejects unknown server requests", () => {
    for (const method of [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
    ] as const) {
      expect(createApprovalDenial({ id: 40, method, params: { private: "discarded" } })).toEqual(
        method === "item/permissions/requestApproval"
          ? {
              id: 40,
              result: {
                permissions: { fileSystem: null, network: null },
                scope: "turn",
                strictAutoReview: true,
              },
            }
          : { id: 40, result: { decision: "decline" } },
      );
    }
    expect(() => createApprovalDenial({ id: 41, method: "unknown/request", params: {} })).toThrow(
      "APP_SERVER_REQUEST_UNSUPPORTED",
    );
  });

  it("builds fixed turn and interrupt requests without Step-success semantics", () => {
    expect(createTurnStartRequest(3, "thread-private", "fixed prompt")).toEqual({
      method: "turn/start",
      id: 3,
      params: {
        threadId: "thread-private",
        input: [{ type: "text", text: "fixed prompt" }],
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      },
    });
    expect(createInterruptRequest(8, "thread-private", "turn-private")).toEqual({
      method: "turn/interrupt",
      id: 8,
      params: { threadId: "thread-private", turnId: "turn-private" },
    });
  });

  it("summarizes matching approval and interrupt receipts without retaining identities", () => {
    const summary = summarizeAppServerTranscript([
      { id: 1, result: { userAgent: "codex" } },
      { id: 2, result: { thread: { id: "thread-private", ephemeral: true } } },
      { id: 3, result: { turn: { id: "turn-private" } } },
      { method: "item/commandExecution/requestApproval", id: 40, params: { threadId: "thread-private", turnId: "turn-private" } },
      { id: 40, result: { decision: "decline" } },
      { id: 4, result: { turn: { id: "interrupt-turn" } } },
      { method: "turn/started", params: { threadId: "thread-private", turn: { id: "interrupt-turn" } } },
      { id: 8, result: {} },
      { method: "turn/completed", params: { threadId: "thread-private", turn: { id: "interrupt-turn", status: "interrupted" } } },
    ]);

    expect(summary).toEqual({
      initialized: true,
      ephemeralThread: true,
      approvalRequestMethods: ["item/commandExecution/requestApproval"],
      approvalDenialMethods: ["item/commandExecution/requestApproval"],
      approvalContextMatched: true,
      interruptAccepted: true,
      interruptTerminalStatus: "interrupted",
      protocolErrors: 0,
      stepSuccess: false,
    });
    expect(JSON.stringify(summary)).not.toContain("thread-private");
    expect(JSON.stringify(summary)).not.toContain("turn-private");
  });

  it("does not prove approval denial or interrupt from uncorrelated messages", () => {
    const summary = summarizeAppServerTranscript([
      { id: 1, result: {} },
      { id: 2, result: { thread: { id: "thread-private", ephemeral: true } } },
      { method: "item/commandExecution/requestApproval", params: {} },
      { id: 4, result: { turn: { id: "interrupt-turn" } } },
      { method: "turn/started", params: { threadId: "wrong-thread", turn: { id: "interrupt-turn" } } },
      { id: 8, result: {} },
      { method: "turn/completed", params: { threadId: "wrong-thread", turn: { id: "interrupt-turn", status: "interrupted" } } },
    ]);

    expect(summary.approvalRequestMethods).toEqual([]);
    expect(summary.approvalDenialMethods).toEqual([]);
    expect(summary.approvalContextMatched).toBe(false);
    expect(summary.interruptAccepted).toBe(false);
    expect(summary.interruptTerminalStatus).toBe("not_observed");
  });

  it("retains per-request denial cardinality instead of deduplicating by method", () => {
    const summary = summarizeAppServerTranscript([
      { id: 1, result: {} },
      { id: 2, result: { thread: { id: "thread-private", ephemeral: true } } },
      { id: 3, result: { turn: { id: "approval-turn" } } },
      { id: 40, method: "item/commandExecution/requestApproval", params: { threadId: "thread-private", turnId: "approval-turn" } },
      { id: 41, method: "item/commandExecution/requestApproval", params: { threadId: "thread-private", turnId: "approval-turn" } },
      { id: 40, result: { decision: "decline" } },
    ]);

    expect(summary.approvalRequestMethods).toHaveLength(2);
    expect(summary.approvalDenialMethods).toHaveLength(1);
    expect(summary.approvalContextMatched).toBe(true);
  });
});
