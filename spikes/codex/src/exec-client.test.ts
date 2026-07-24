import { describe, expect, it } from "vitest";
import { createCodexExecPlan, parseCodexJsonLines } from "./exec-client.js";

const prompt = "Read README.md and return its first heading. Do not modify files.";

describe("Direct Codex exec client", () => {
  it("plans a new read-only JSON execution with separate arguments", () => {
    expect(createCodexExecPlan({ mode: "new", prompt })).toEqual({
      executable: "codex",
      args: ["exec", "--json", "--sandbox", "read-only", prompt],
    });
  });

  it("places inherited safety options before the resume subcommand", () => {
    expect(
      createCodexExecPlan({ mode: "resume", sessionId: "thread-1", prompt }),
    ).toEqual({
      executable: "codex",
      args: [
        "exec",
        "--json",
        "--sandbox",
        "read-only",
        "resume",
        "thread-1",
        prompt,
      ],
    });
  });

  it("rejects empty or forbidden execution input", () => {
    expect(() => createCodexExecPlan({ mode: "new", prompt: "" })).toThrow(
      "CODEX_PROMPT_REQUIRED",
    );
    expect(() =>
      createCodexExecPlan({ mode: "resume", sessionId: "", prompt }),
    ).toThrow("CODEX_SESSION_ID_REQUIRED");
    expect(() =>
      createCodexExecPlan({ mode: "new", prompt: "run with --yolo" }),
    ).toThrow("CODEX_FORBIDDEN_ARGUMENT");
  });

  it("normalizes a returned turn without inventing Hunter success", () => {
    const stream = parseCodexJsonLines(
      [
        JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "item.completed",
          item: { id: "item-1", type: "agent_message", text: "# Hunter" },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      ].join("\n"),
    );

    expect(stream.summary).toEqual({
      sessionIdentityPresent: true,
      terminalOutcome: "returned",
      protocolErrors: 0,
    });
    expect(stream.facts).toContainEqual({ kind: "agent_returned" });
    expect(stream.facts).not.toContainEqual(
      expect.objectContaining({ kind: "step_succeeded" }),
    );
  });

  it("fails closed for approval, tool failure, interruption, and malformed JSON", () => {
    const stream = parseCodexJsonLines(
      [
        JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
        JSON.stringify({ type: "approval.requested", request: { kind: "command" } }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "command_execution", status: "failed", exit_code: 23 },
        }),
        "not-json",
        JSON.stringify({ type: "turn.failed", error: { message: "interrupted" } }),
      ].join("\n"),
    );

    expect(stream.summary.terminalOutcome).toBe("interrupted");
    expect(stream.summary.protocolErrors).toBe(1);
    expect(stream.facts).toEqual(
      expect.arrayContaining([
        { kind: "approval_requested" },
        { kind: "tool_failed" },
        { kind: "protocol_error" },
        { kind: "interrupted" },
      ]),
    );
  });

  it("preserves an unknown future event as raw input", () => {
    const raw = { type: "future.event", payload: { value: 7 } };
    const stream = parseCodexJsonLines(JSON.stringify(raw));

    expect(stream.events).toContainEqual({ kind: "unknown", raw });
    expect(stream.summary.terminalOutcome).toBe("indeterminate");
  });
});
