import { describe, expect, it } from "vitest";
import {
  BoundedAppServerOutput,
  classifyWindowsCleanup,
  runAppServerSession,
  type AppServerTransport,
} from "./app-server-client.js";
import type { AppServerMessage } from "./app-server-protocol.js";

class ScriptedTransport implements AppServerTransport {
  readonly sent: AppServerMessage[] = [];
  closed = false;

  constructor(private readonly inbound: AppServerMessage[]) {}

  async send(message: AppServerMessage): Promise<void> {
    this.sent.push(message);
  }

  async receive(): Promise<AppServerMessage> {
    const message = this.inbound.shift();
    if (message === undefined) throw new Error("APP_SERVER_TRANSPORT_TIMEOUT");
    return message;
  }

  async close(): Promise<"process_tree_terminated" | "direct_process_exit" | "not_proven"> {
    this.closed = true;
    return "process_tree_terminated";
  }
}

describe("Codex app-server bounded session", () => {
  it("persists malformed-output failures and bounds cumulative JSONL", () => {
    const malformed = new BoundedAppServerOutput({ maxBytes: 100, maxLineBytes: 50, maxMessages: 5 });
    expect(() => malformed.accept(Buffer.from("not-json\n"))).toThrow(
      "APP_SERVER_PROTOCOL_INVALID_JSON",
    );
    expect(() => malformed.accept(Buffer.from('{"id":1,"result":{}}\n'))).toThrow(
      "APP_SERVER_PROTOCOL_INVALID_JSON",
    );

    const bounded = new BoundedAppServerOutput({ maxBytes: 30, maxLineBytes: 25, maxMessages: 5 });
    expect(bounded.accept(Buffer.from('{"id":1}\n'))).toHaveLength(1);
    expect(() => bounded.accept(Buffer.from('{"id":2,"result":"too-large"}\n'))).toThrow(
      "APP_SERVER_OUTPUT_LIMIT",
    );
    expect(() => bounded.accept(Buffer.from('{"id":3}\n'))).toThrow("APP_SERVER_OUTPUT_LIMIT");
  });

  it("classifies a taskkill race from observed process exit, not taskkill exit alone", () => {
    expect(classifyWindowsCleanup(false, true)).toBe("direct_process_exit");
    expect(classifyWindowsCleanup(true, true)).toBe("process_tree_terminated");
    expect(classifyWindowsCleanup(false, false)).toBe("not_proven");
  });

  it("declines approval and proves a matching structured interrupt", async () => {
    const transport = new ScriptedTransport([
      { id: 1, result: { userAgent: "codex" } },
      { id: 2, result: { thread: { id: "thread-private", ephemeral: true } } },
      { id: 3, result: { turn: { id: "approval-turn" } } },
      { id: 40, method: "item/commandExecution/requestApproval", params: { threadId: "thread-private", turnId: "approval-turn", command: "private" } },
      { method: "turn/completed", params: { threadId: "thread-private", turn: { id: "approval-turn", status: "completed" } } },
      { id: 4, result: { turn: { id: "interrupt-turn" } } },
      { method: "turn/started", params: { threadId: "thread-private", turn: { id: "interrupt-turn" } } },
      { id: 8, result: {} },
      { method: "turn/completed", params: { threadId: "thread-private", turn: { id: "interrupt-turn", status: "interrupted" } } },
    ]);

    const receipt = await runAppServerSession({
      transport,
      fixturePath: "C:\\fixture",
      approvalPrompt: "fixed approval prompt",
      interruptPrompt: "fixed interrupt prompt",
      timeoutMs: 1_000,
    });

    expect(receipt).toEqual({
      summary: {
        initialized: true,
        ephemeralThread: true,
        approvalRequestMethods: ["item/commandExecution/requestApproval"],
        approvalDenialMethods: ["item/commandExecution/requestApproval"],
        approvalContextMatched: true,
        interruptAccepted: true,
        interruptTerminalStatus: "interrupted",
        protocolErrors: 0,
        stepSuccess: false,
      },
      cleanup: "process_tree_terminated",
      realTurnCount: 2,
    });
    expect(transport.sent).toContainEqual({ id: 40, result: { decision: "decline" } });
    expect(transport.sent).toContainEqual({
      method: "turn/interrupt",
      id: 8,
      params: { threadId: "thread-private", turnId: "interrupt-turn" },
    });
    expect(transport.closed).toBe(true);
  });

  it("fails closed on an unsupported server request and still closes", async () => {
    const transport = new ScriptedTransport([
      { id: 1, result: {} },
      { id: 2, result: { thread: { id: "thread-private", ephemeral: true } } },
      { id: 3, result: { turn: { id: "approval-turn" } } },
      { id: 99, method: "unknown/request", params: {} },
    ]);

    await expect(
      runAppServerSession({
        transport,
        fixturePath: "C:\\fixture",
        approvalPrompt: "fixed approval prompt",
        interruptPrompt: "fixed interrupt prompt",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("APP_SERVER_REQUEST_UNSUPPORTED");
    expect(transport.closed).toBe(true);
  });

  it("fails closed on mismatched thread identity or a missing terminal receipt", async () => {
    const transport = new ScriptedTransport([
      { id: 1, result: {} },
      { id: 2, result: { thread: { id: "thread-private", ephemeral: true } } },
      { id: 3, result: { turn: { id: "approval-turn" } } },
      {
        method: "turn/completed",
        params: { threadId: "wrong-thread", turn: { id: "approval-turn", status: "completed" } },
      },
    ]);

    await expect(
      runAppServerSession({
        transport,
        fixturePath: "C:\\fixture",
        approvalPrompt: "fixed approval prompt",
        interruptPrompt: "fixed interrupt prompt",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("APP_SERVER_TRANSPORT_TIMEOUT");
    expect(transport.closed).toBe(true);
  });

  it("enforces one deadline for the complete session and still closes", async () => {
    const transport = new ScriptedTransport([
      { id: 1, result: {} },
      { id: 2, result: { thread: { id: "thread-private", ephemeral: true } } },
    ]);

    await expect(
      runAppServerSession({
        transport,
        fixturePath: "C:\\fixture",
        approvalPrompt: "fixed approval prompt",
        interruptPrompt: "fixed interrupt prompt",
        timeoutMs: 0,
      }),
    ).rejects.toThrow("APP_SERVER_SESSION_TIMEOUT");
    expect(transport.sent).toEqual([]);
    expect(transport.closed).toBe(true);
  });
});
