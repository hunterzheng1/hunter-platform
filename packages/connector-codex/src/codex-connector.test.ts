import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { OperationIdSchema } from "@hunter/domain";
import { runtimeFactCanCompleteStep } from "@hunter/runtime-contracts";
import {
  CodexCandidateConnector,
  type CodexCandidateTransport,
} from "./codex-connector.js";
import {
  CODEX_EVENT_LIMITS,
  parseCodexEventLines,
} from "./codex-events.js";

const launchOperationId = OperationIdSchema.parse("opn_codexlaunch01");
const resumeOperationId = OperationIdSchema.parse("opn_codexresume01");
const interruptOperationId = OperationIdSchema.parse("opn_codexinterrupt01");
const prompt = "Inspect the fixture and return a bounded summary.";
const windowsWorkspace = "C:\\fixtures\\hunter-worktree";

function line(value: unknown): string {
  return JSON.stringify(value);
}

class FixtureTransport implements CodexCandidateTransport {
  readonly executeCalls: Array<{ readonly args: readonly string[]; readonly cwd: string }> = [];
  readonly cancelCalls: string[] = [];

  constructor(
    private readonly observations: readonly {
      readonly lines: readonly string[];
      readonly exitCode: number | null;
    }[],
  ) {}

  async execute(
    args: readonly string[],
    cwd: string,
  ): Promise<{ readonly lines: readonly string[]; readonly exitCode: number | null }> {
    this.executeCalls.push({ args: [...args], cwd });
    const observation = this.observations[this.executeCalls.length - 1];
    if (observation === undefined) throw new Error("private fixture failure");
    return observation;
  }

  async cancel(operationId: string): Promise<void> {
    this.cancelCalls.push(operationId);
  }
}

function returnedLines(sessionRef = "thread-01"): readonly string[] {
  return [
    line({ type: "thread.started", thread_id: sessionRef }),
    line({ type: "turn.started" }),
    line({
      type: "item.completed",
      item: { type: "agent_message", text: "private output" },
    }),
    line({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 2 } }),
    line({ type: "future.event", prompt: "private prompt", path: "C:\\private" }),
  ];
}

describe("bounded Codex 0.144.6 JSONL candidate parser", () => {
  it("normalizes known events and keeps unknown schema drift only as a safe digest", () => {
    const parsed = parseCodexEventLines(returnedLines());

    expect(parsed).toEqual({
      sessionRef: "thread-01",
      terminalOutcome: "agent_returned",
      observations: [
        { kind: "thread_started", sessionRef: "thread-01" },
        { kind: "turn_started" },
        {
          kind: "item_completed",
          itemType: "agent_message",
        },
        { kind: "agent_returned" },
        {
          kind: "unknown_event",
          eventType: "future.event",
          payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      ],
    });
    expect(JSON.stringify(parsed)).not.toMatch(/private prompt|C:\\\\private|input_tokens/iu);
  });

  it("parses exact approval, item lifecycle, error, and failed-turn observations", () => {
    expect(
      parseCodexEventLines([
        line({ type: "thread.started", thread_id: "thread-01" }),
        line({ type: "approval.requested", request: { kind: "command" } }),
        line({ type: "item.started", item: { type: "command_execution" } }),
        line({ type: "item.updated", item: { type: "command_execution" } }),
        line({ type: "item.completed", item: { type: "command_execution" } }),
        line({ type: "error", message: "private provider error" }),
        line({ type: "turn.failed", error: { message: "private reason" } }),
      ]),
    ).toMatchObject({
      terminalOutcome: "turn_failed",
      observations: [
        { kind: "thread_started", sessionRef: "thread-01" },
        { kind: "approval_requested" },
        { kind: "item_started", itemType: "command_execution" },
        { kind: "item_updated", itemType: "command_execution" },
        { kind: "item_completed", itemType: "command_execution" },
        { kind: "runtime_error" },
        { kind: "turn_failed" },
      ],
    });
  });

  it.each(["item.updated", "item.completed"])(
    "records failed tool status from %s as an observation only",
    (eventType) => {
      const parsed = parseCodexEventLines([
        line({ type: "thread.started", thread_id: "thread-01" }),
        line({
          type: eventType,
          item: { type: "command_execution", status: "failed", exit_code: 23 },
        }),
      ]);

      expect(parsed.observations).toContainEqual({ kind: "tool_failed" });
      expect(parsed.terminalOutcome).toBe("indeterminate");
      expect(parsed.observations).not.toContainEqual(
        expect.objectContaining({ kind: "step_succeeded" }),
      );
    },
  );

  it.each([
    { name: "malformed JSON", lines: ["not-json"], error: "CODEX_EVENT_INVALID_JSON" },
    { name: "non-object JSON", lines: ["[]"], error: "CODEX_EVENT_INVALID_OBJECT" },
    {
      name: "missing type",
      lines: [line({ thread_id: "thread-01" })],
      error: "CODEX_EVENT_TYPE_INVALID",
    },
    {
      name: "oversized line",
      lines: ["x".repeat(CODEX_EVENT_LIMITS.maxLineBytes + 1)],
      error: "CODEX_EVENT_LINE_TOO_LARGE",
    },
    {
      name: "oversized field",
      lines: [
        line({
          type: "future.event",
          value: "x".repeat(CODEX_EVENT_LIMITS.maxStringBytes + 1),
        }),
      ],
      error: "CODEX_EVENT_VALUE_TOO_LARGE",
    },
    {
      name: "excessive depth",
      lines: [
        line({
          type: "future.event",
          value: { a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } },
        }),
      ],
      error: "CODEX_EVENT_DEPTH_EXCEEDED",
    },
    {
      name: "too many events",
      lines: Array.from(
        { length: CODEX_EVENT_LIMITS.maxEvents + 1 },
        () => line({ type: "future.event" }),
      ),
      error: "CODEX_EVENT_COUNT_EXCEEDED",
    },
  ])("fails closed for $name", ({ lines, error }) => {
    expect(() => parseCodexEventLines(lines)).toThrow(error);
  });

  it.each([
    {
      name: "missing thread identity",
      lines: [line({ type: "turn.completed" })],
      error: "CODEX_SESSION_ID_MISSING",
    },
    {
      name: "duplicate thread event",
      lines: [
        line({ type: "thread.started", thread_id: "thread-01" }),
        line({ type: "thread.started", thread_id: "thread-01" }),
      ],
      error: "CODEX_SESSION_ID_DUPLICATE",
    },
    {
      name: "conflicting thread identity",
      lines: [
        line({ type: "thread.started", thread_id: "thread-01" }),
        line({ type: "thread.started", thread_id: "thread-02" }),
      ],
      error: "CODEX_SESSION_ID_CONFLICT",
    },
    {
      name: "conflicting terminal outcome",
      lines: [
        line({ type: "thread.started", thread_id: "thread-01" }),
        line({ type: "turn.completed" }),
        line({ type: "turn.failed" }),
      ],
      error: "CODEX_TURN_TERMINAL_CONFLICT",
    },
    {
      name: "duplicate completed terminal",
      lines: [
        line({ type: "thread.started", thread_id: "thread-01" }),
        line({ type: "turn.completed" }),
        line({ type: "turn.completed" }),
      ],
      error: "CODEX_TURN_TERMINAL_CONFLICT",
    },
    {
      name: "duplicate failed terminal",
      lines: [
        line({ type: "thread.started", thread_id: "thread-01" }),
        line({ type: "turn.failed" }),
        line({ type: "turn.failed" }),
      ],
      error: "CODEX_TURN_TERMINAL_CONFLICT",
    },
  ])("rejects $name", ({ lines, error }) => {
    expect(() => parseCodexEventLines(lines)).toThrow(error);
  });

  it("does not guess interruption from free text", () => {
    const parsed = parseCodexEventLines([
      line({ type: "thread.started", thread_id: "thread-01" }),
      line({
        type: "turn.failed",
        error: { message: "the operator wrote interrupted and cancelled" },
      }),
    ]);

    expect(parsed.terminalOutcome).toBe("turn_failed");
    expect(parsed.observations).not.toContainEqual(
      expect.objectContaining({ kind: "interrupted" }),
    );
  });

  it("retains an unknown item shape as a digest without exposing its private type", () => {
    const parsed = parseCodexEventLines([
      line({ type: "thread.started", thread_id: "thread-01" }),
      line({
        type: "item.completed",
        item: { type: "private_prompt_name", value: "private output" },
      }),
    ]);

    expect(parsed.observations[1]).toEqual({
      kind: "unknown_event",
      eventType: "item.completed",
      payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(parsed)).not.toMatch(/private_prompt_name|private output/u);
  });

  it("derives the same unknown-event digest regardless of object insertion order", () => {
    const first = parseCodexEventLines([
      line({ type: "thread.started", thread_id: "thread-01" }),
      line({ type: "future.event", zeta: 1, alpha: { second: 2, first: 1 } }),
    ]);
    const second = parseCodexEventLines([
      line({ type: "thread.started", thread_id: "thread-01" }),
      line({ alpha: { first: 1, second: 2 }, zeta: 1, type: "future.event" }),
    ]);

    expect(first.observations[1]).toEqual(second.observations[1]);
  });

  it("uses code-unit key order for a locale-independent unknown-event digest", () => {
    const parsed = parseCodexEventLines([
      line({ type: "thread.started", thread_id: "thread-01" }),
      line({ "ä": 2, zeta: 1, type: "future.event" }),
    ]);
    const expectedDigest = createHash("sha256")
      .update('{"type":"future.event","zeta":1,"ä":2}')
      .digest("hex");

    expect(parsed.observations[1]).toEqual({
      kind: "unknown_event",
      eventType: "future.event",
      payloadDigest: expectedDigest,
    });
  });
});

describe("Codex candidate contract-only connector", () => {
  it("launches through injected transport with exact read-only argv and immutable facts", async () => {
    const transport = new FixtureTransport([{ lines: returnedLines(), exitCode: 0 }]);
    const connector = new CodexCandidateConnector(transport, { pathFlavor: "windows" });

    const result = await connector.launch({
      operationId: launchOperationId,
      workspacePath: windowsWorkspace,
      prompt,
    });

    expect(transport.executeCalls).toEqual([
      {
        args: ["exec", "--json", "--sandbox", "read-only", prompt],
        cwd: windowsWorkspace,
      },
    ]);
    expect(result).toMatchObject({
      schemaVersion: 1,
      operationId: launchOperationId,
      proofScope: "contract_only",
      connectorValidationStatus: "NOT_PROVEN",
      retrySafety: "NOT_PROVEN",
      sessionRef: "thread-01",
      terminalOutcome: "agent_returned",
      stepCompletion: "not_established",
      observations: expect.arrayContaining([
        { kind: "agent_returned" },
        { kind: "process_exited", exitCode: 0 },
      ]),
    });
    expect(result).not.toHaveProperty("operationStatus");
    expect(result).not.toHaveProperty("capabilityManifest");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.observations)).toBe(true);
    for (const observation of result.observations) {
      expect(Object.isFrozen(observation)).toBe(true);
      if (
        observation.kind === "agent_returned" ||
        observation.kind === "process_exited"
      ) {
        expect(runtimeFactCanCompleteStep(observation)).toBe(false);
      }
    }
  });

  it("resumes only the selected session with evidence-consistent argument order", async () => {
    const transport = new FixtureTransport([
      { lines: returnedLines("thread-01"), exitCode: 17 },
    ]);
    const connector = new CodexCandidateConnector(transport, { pathFlavor: "windows" });

    const result = await connector.resume("thread-01", {
      operationId: resumeOperationId,
      workspacePath: windowsWorkspace,
      prompt,
    });

    expect(transport.executeCalls[0]).toEqual({
      args: [
        "exec",
        "--json",
        "--sandbox",
        "read-only",
        "resume",
        "thread-01",
        prompt,
      ],
      cwd: windowsWorkspace,
    });
    expect(result.observations).toContainEqual({ kind: "process_exited", exitCode: 17 });
    expect(result.stepCompletion).toBe("not_established");
  });

  it("rejects a resume transcript for a different session", async () => {
    const transport = new FixtureTransport([
      { lines: returnedLines("thread-other"), exitCode: 0 },
    ]);
    const connector = new CodexCandidateConnector(transport, { pathFlavor: "windows" });

    await expect(
      connector.resume("thread-01", {
        operationId: resumeOperationId,
        workspacePath: windowsWorkspace,
        prompt,
      }),
    ).rejects.toThrow("CODEX_RESUME_SESSION_MISMATCH");
  });

  it.each([
    "",
    "   ",
    "-danger",
    "--full-auto",
    "bad\u0000prompt",
    "x".repeat(16_385),
  ])("rejects unsafe prompt input before dispatch: %s", async (candidatePrompt) => {
    const transport = new FixtureTransport([{ lines: returnedLines(), exitCode: 0 }]);
    const connector = new CodexCandidateConnector(transport, { pathFlavor: "windows" });

    await expect(
      connector.launch({
        operationId: launchOperationId,
        workspacePath: windowsWorkspace,
        prompt: candidatePrompt,
      }),
    ).rejects.toThrow(/^CODEX_PROMPT_/u);
    expect(transport.executeCalls).toHaveLength(0);
  });

  it("keeps security terms inside one positional prompt instead of treating them as argv flags", async () => {
    const securityReviewPrompt =
      "Remove --full-auto, danger-full-access, --ask-for-approval never, and --yolo from the documentation.";
    const transport = new FixtureTransport([{ lines: returnedLines(), exitCode: 0 }]);
    const connector = new CodexCandidateConnector(transport, { pathFlavor: "windows" });

    await connector.launch({
      operationId: launchOperationId,
      workspacePath: windowsWorkspace,
      prompt: securityReviewPrompt,
    });

    expect(transport.executeCalls[0]?.args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      securityReviewPrompt,
    ]);
    expect(transport.executeCalls[0]?.args).not.toEqual(
      expect.arrayContaining([
        "--full-auto",
        "danger-full-access",
        "--ask-for-approval",
        "never",
        "--yolo",
      ]),
    );
  });

  it.each([
    "relative\\fixture",
    "C:relative\\fixture",
    "\\rooted-current-drive",
    "\\\\server-without-share",
    "\\\\.\\pipe\\hunter",
    "/rooted-on-current-drive",
    "C:\\fixture\u0000escape",
  ])("rejects an unsafe Windows cwd before dispatch: %s", async (workspacePath) => {
    const transport = new FixtureTransport([{ lines: returnedLines(), exitCode: 0 }]);
    const connector = new CodexCandidateConnector(transport, { pathFlavor: "windows" });

    await expect(
      connector.launch({
        operationId: launchOperationId,
        workspacePath,
        prompt,
      }),
    ).rejects.toThrow("CODEX_WORKSPACE_PATH_INVALID");
    expect(transport.executeCalls).toHaveLength(0);
  });

  it("uses explicitly injected POSIX path semantics", async () => {
    const transport = new FixtureTransport([{ lines: returnedLines(), exitCode: null }]);
    const connector = new CodexCandidateConnector(transport, { pathFlavor: "posix" });

    await connector.launch({
      operationId: launchOperationId,
      workspacePath: "/tmp/hunter-fixture",
      prompt,
    });

    expect(transport.executeCalls[0]?.cwd).toBe("/tmp/hunter-fixture");
  });

  it("rejects an unknown path flavor instead of falling through to POSIX", () => {
    expect(
      () =>
        new CodexCandidateConnector(new FixtureTransport([]), {
          pathFlavor: "other",
        } as never),
    ).toThrow(/^CODEX_OPTIONS_INVALID$/u);
  });

  it.each([
    {
      operationId: "invalid-operation",
      workspacePath: windowsWorkspace,
      prompt,
    },
    {
      operationId: launchOperationId,
      workspacePath: windowsWorkspace,
      prompt,
      privateExtra: "not accepted",
    },
  ])("strictly rejects an invalid candidate request before dispatch", async (request) => {
    const transport = new FixtureTransport([{ lines: returnedLines(), exitCode: 0 }]);
    const connector = new CodexCandidateConnector(transport, { pathFlavor: "windows" });

    await expect(connector.launch(request as never)).rejects.toThrow(
      /^CODEX_REQUEST_INVALID$/u,
    );
    expect(transport.executeCalls).toHaveLength(0);
  });

  it.each(["", " ", "-thread", "thread\u0000-private", "x".repeat(257)])(
    "rejects an unsafe provider-private session selector: %s",
    async (sessionRef) => {
      const transport = new FixtureTransport([{ lines: returnedLines(), exitCode: 0 }]);
      const connector = new CodexCandidateConnector(transport, { pathFlavor: "windows" });

      await expect(
        connector.resume(sessionRef, {
          operationId: resumeOperationId,
          workspacePath: windowsWorkspace,
          prompt,
        }),
      ).rejects.toThrow("CODEX_SESSION_ID_INVALID");
      expect(transport.executeCalls).toHaveLength(0);
    },
  );

  it("returns only a process-cancel request and never claims structured interruption", async () => {
    const transport = new FixtureTransport([]);
    const connector = new CodexCandidateConnector(transport, { pathFlavor: "windows" });

    const result = await connector.interrupt("thread-01", interruptOperationId);

    expect(transport.cancelCalls).toEqual([interruptOperationId]);
    expect(result).toEqual({
      schemaVersion: 1,
      operationId: interruptOperationId,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      sessionRef: "thread-01",
      proofScope: "contract_only",
      connectorValidationStatus: "NOT_PROVEN",
      retrySafety: "NOT_PROVEN",
      structuredInterrupt: "NOT_PROVEN",
      sessionTargeting: "NOT_PROVEN",
      stepCompletion: "not_established",
      observation: { kind: "process_cancel_requested" },
    });
    expect(result).not.toHaveProperty("operationStatus");
  });

  it("binds deterministic interrupt fingerprints to operation and requested session", async () => {
    const otherOperationId = OperationIdSchema.parse("opn_codexinterrupt02");
    const first = new CodexCandidateConnector(new FixtureTransport([]), {
      pathFlavor: "windows",
    });
    const second = new CodexCandidateConnector(new FixtureTransport([]), {
      pathFlavor: "windows",
    });
    const changedOperation = new CodexCandidateConnector(new FixtureTransport([]), {
      pathFlavor: "windows",
    });
    const changedSession = new CodexCandidateConnector(new FixtureTransport([]), {
      pathFlavor: "windows",
    });

    const firstResult = await first.interrupt("thread-01", interruptOperationId);
    const secondResult = await second.interrupt("thread-01", interruptOperationId);
    const changedOperationResult = await changedOperation.interrupt(
      "thread-01",
      otherOperationId,
    );
    const changedSessionResult = await changedSession.interrupt(
      "thread-02",
      interruptOperationId,
    );

    expect(secondResult.fingerprint).toBe(firstResult.fingerprint);
    expect(changedOperationResult.fingerprint).not.toBe(firstResult.fingerprint);
    expect(changedSessionResult.fingerprint).not.toBe(firstResult.fingerprint);
    expect(firstResult.retrySafety).toBe("NOT_PROVEN");
  });

  it("derives deterministic fingerprints without an in-memory replay claim", async () => {
    const first = new CodexCandidateConnector(
      new FixtureTransport([{ lines: returnedLines(), exitCode: 0 }]),
      { pathFlavor: "windows" },
    );
    const second = new CodexCandidateConnector(
      new FixtureTransport([{ lines: returnedLines(), exitCode: 0 }]),
      { pathFlavor: "windows" },
    );

    const firstResult = await first.launch({
      operationId: launchOperationId,
      workspacePath: windowsWorkspace,
      prompt,
    });
    const secondResult = await second.launch({
      operationId: launchOperationId,
      workspacePath: windowsWorkspace,
      prompt,
    });

    expect(secondResult.fingerprint).toBe(firstResult.fingerprint);
    expect(secondResult.retrySafety).toBe("NOT_PROVEN");
  });

  it("sanitizes transport failures without disclosing provider output", async () => {
    const transport: CodexCandidateTransport = {
      execute: async () => {
        throw new Error("token=private C:\\Users\\private");
      },
      cancel: async () => {
        throw new Error("token=private C:\\Users\\private");
      },
    };
    const connector = new CodexCandidateConnector(transport, { pathFlavor: "windows" });

    await expect(
      connector.launch({
        operationId: launchOperationId,
        workspacePath: windowsWorkspace,
        prompt,
      }),
    ).rejects.toThrow(/^CODEX_TRANSPORT_FAILED$/u);
    await expect(
      connector.interrupt("thread-01", interruptOperationId),
    ).rejects.toThrow(/^CODEX_TRANSPORT_FAILED$/u);
  });

  it.each([
    { lines: "private output", exitCode: 0 },
    { lines: [7], exitCode: 0 },
    { lines: returnedLines(), exitCode: 1.5 },
    {
      lines: Array.from(
        { length: CODEX_EVENT_LIMITS.maxEvents + 1 },
        () => line({ type: "future.event" }),
      ),
      exitCode: 0,
    },
  ])("rejects invalid transport observations with a constant error", async (observation) => {
    const transport = {
      execute: vi.fn(async () => observation),
      cancel: vi.fn(async () => undefined),
    } as unknown as CodexCandidateTransport;
    const connector = new CodexCandidateConnector(transport, { pathFlavor: "windows" });

    await expect(
      connector.launch({
        operationId: launchOperationId,
        workspacePath: windowsWorkspace,
        prompt,
      }),
    ).rejects.toThrow(/^CODEX_TRANSPORT_RESPONSE_INVALID$/u);
  });

  it("keeps Codex-private vocabulary out of shared contracts", async () => {
    const root = new URL("../../../", import.meta.url);
    const sharedFiles = [
      "packages/domain/src/ids.ts",
      "packages/runtime-contracts/src/external-boundary.ts",
      "packages/runtime-contracts/src/operations.ts",
      "packages/runtime-contracts/src/leases.ts",
      "packages/runtime-contracts/src/manifest.ts",
    ];
    const source = (
      await Promise.all(sharedFiles.map((file) => readFile(new URL(file, root), "utf8")))
    ).join("\n");

    expect(source).not.toMatch(/\bcodex(?:Thread|Turn|Session|Connector|Event)?\b/iu);
  });
});
