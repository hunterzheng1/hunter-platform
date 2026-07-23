import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  AgentProfileIdSchema,
  AttemptIdSchema,
  ControllerLeaseIdSchema,
  EvidenceIdSchema,
  LeaseOwnerIdSchema,
  NativeSessionIdSchema,
  OperationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  WorkspaceIdSchema,
} from "@hunter/domain";
import {
  computeCapabilityManifest,
  createExternalOperation,
  runtimeFactCanCompleteStep,
  type ExternalOperation,
} from "@hunter/runtime-contracts";
import {
  CodexCandidateConnector,
  CodexConnector,
  type CodexCandidateTransport,
  type CodexOperationObservation,
  type CodexOperationTransport,
} from "./codex-connector.js";
import { CodexCapabilityProbe } from "./codex-probe.js";
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
          rawEventDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      ],
    });
    expect(JSON.stringify(parsed)).not.toMatch(/private prompt|C:\\\\private|input_tokens/iu);
  });

  it("parses exact approval, item lifecycle, error, and failed-turn observations", () => {
    expect(
      parseCodexEventLines([
        line({ type: "thread.started", thread_id: "thread-01" }),
        line({ type: "turn.started" }),
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
        { kind: "turn_started" },
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
        line({ type: "turn.started" }),
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
      error: "CODEX_THREAD_STARTED_REQUIRED",
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
        line({ type: "turn.started" }),
        line({ type: "turn.completed" }),
        line({ type: "turn.failed" }),
      ],
      error: "CODEX_TURN_TERMINAL_CONFLICT",
    },
    {
      name: "duplicate completed terminal",
      lines: [
        line({ type: "thread.started", thread_id: "thread-01" }),
        line({ type: "turn.started" }),
        line({ type: "turn.completed" }),
        line({ type: "turn.completed" }),
      ],
      error: "CODEX_TURN_TERMINAL_CONFLICT",
    },
    {
      name: "duplicate failed terminal",
      lines: [
        line({ type: "thread.started", thread_id: "thread-01" }),
        line({ type: "turn.started" }),
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
      line({ type: "turn.started" }),
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
      line({ type: "turn.started" }),
      line({
        type: "item.completed",
        item: { type: "private_prompt_name", value: "private output" },
      }),
    ]);

    expect(parsed.observations[2]).toEqual({
      kind: "unknown_event",
      rawEventDigest: createHash("sha256")
        .update(
          line({
            type: "item.completed",
            item: { type: "private_prompt_name", value: "private output" },
          }),
          "utf8",
        )
        .digest("hex"),
    });
    expect(JSON.stringify(parsed)).not.toMatch(/private_prompt_name|private output/u);
  });

  it("derives the same unknown-event digest for the same exact UTF-8 line", () => {
    const rawLine = line({
      type: "future.event",
      zeta: 1,
      alpha: { second: 2, first: 1 },
    });
    const first = parseCodexEventLines([
      line({ type: "thread.started", thread_id: "thread-01" }),
      rawLine,
    ]);
    const second = parseCodexEventLines([
      line({ type: "thread.started", thread_id: "thread-01" }),
      rawLine,
    ]);

    expect(first.observations[1]).toEqual(second.observations[1]);
    expect(first.observations[1]).toEqual({
      kind: "unknown_event",
      rawEventDigest: createHash("sha256").update(rawLine, "utf8").digest("hex"),
    });
  });

  it.each([
    [
      '{"type":"future.event","value":9007199254740992}',
      '{"type":"future.event","value":9007199254740993}',
    ],
    [
      '{"type":"future.event","value":1e400}',
      '{"type":"future.event","value":null}',
    ],
    [
      '{"type":"future.event","value":7}',
      '{ "type": "future.event", "value": 7 }',
    ],
  ])("keeps distinct valid raw bytes distinct even when parsed values can collapse", (left, right) => {
    const leftParsed = parseCodexEventLines([
      line({ type: "thread.started", thread_id: "thread-01" }),
      left,
    ]);
    const rightParsed = parseCodexEventLines([
      line({ type: "thread.started", thread_id: "thread-01" }),
      right,
    ]);

    expect(leftParsed.observations[1]).toEqual({
      kind: "unknown_event",
      rawEventDigest: createHash("sha256").update(left, "utf8").digest("hex"),
    });
    expect(rightParsed.observations[1]).toEqual({
      kind: "unknown_event",
      rawEventDigest: createHash("sha256").update(right, "utf8").digest("hex"),
    });
    expect(leftParsed.observations[1]).not.toEqual(rightParsed.observations[1]);
  });

  it("does not expose a provider-controlled unknown type", () => {
    const maliciousLine = line({
      type: "token/sk_live_privatevalue",
      value: "private provider output",
    });
    const parsed = parseCodexEventLines([
      maliciousLine,
      line({ type: "thread.started", thread_id: "thread-01" }),
      line({ type: "turn.started" }),
    ]);

    expect(parsed.observations[0]).toEqual({
      kind: "unknown_event",
      rawEventDigest: createHash("sha256").update(maliciousLine, "utf8").digest("hex"),
    });
    expect(JSON.stringify(parsed)).not.toMatch(
      /token\/sk_live_privatevalue|private provider output/u,
    );
  });

  it.each([
    {
      name: "turn before thread",
      lines: [
        line({ type: "turn.started" }),
        line({ type: "thread.started", thread_id: "thread-01" }),
      ],
      error: "CODEX_THREAD_STARTED_REQUIRED",
    },
    {
      name: "terminal before turn",
      lines: [
        line({ type: "thread.started", thread_id: "thread-01" }),
        line({ type: "turn.completed" }),
      ],
      error: "CODEX_TURN_NOT_STARTED",
    },
    {
      name: "duplicate turn start",
      lines: [
        line({ type: "thread.started", thread_id: "thread-01" }),
        line({ type: "turn.started" }),
        line({ type: "turn.started" }),
      ],
      error: "CODEX_TURN_STARTED_DUPLICATE",
    },
    {
      name: "item before turn",
      lines: [
        line({ type: "thread.started", thread_id: "thread-01" }),
        line({ type: "item.completed", item: { type: "agent_message" } }),
      ],
      error: "CODEX_TURN_NOT_STARTED",
    },
    {
      name: "approval before turn",
      lines: [
        line({ type: "thread.started", thread_id: "thread-01" }),
        line({ type: "approval.requested", request: { kind: "command" } }),
      ],
      error: "CODEX_TURN_NOT_STARTED",
    },
    {
      name: "error before turn",
      lines: [
        line({ type: "thread.started", thread_id: "thread-01" }),
        line({ type: "error" }),
      ],
      error: "CODEX_TURN_NOT_STARTED",
    },
    {
      name: "known item after terminal",
      lines: [
        line({ type: "thread.started", thread_id: "thread-01" }),
        line({ type: "turn.started" }),
        line({ type: "turn.completed" }),
        line({ type: "item.completed", item: { type: "agent_message" } }),
      ],
      error: "CODEX_EVENT_AFTER_TERMINAL",
    },
    {
      name: "known turn after terminal",
      lines: [
        line({ type: "thread.started", thread_id: "thread-01" }),
        line({ type: "turn.started" }),
        line({ type: "turn.completed" }),
        line({ type: "turn.started" }),
      ],
      error: "CODEX_EVENT_AFTER_TERMINAL",
    },
  ])("fails closed for single-turn lifecycle: $name", ({ lines, error }) => {
    expect(() => parseCodexEventLines(lines)).toThrow(error);
  });

  it("allows unknown observations without advancing the single-turn lifecycle", () => {
    const beforeThread = line({ type: "future.before" });
    const duringTurn = line({ type: "future.during" });
    const parsed = parseCodexEventLines([
      beforeThread,
      line({ type: "thread.started", thread_id: "thread-01" }),
      duringTurn,
      line({ type: "turn.started" }),
    ]);

    expect(parsed.terminalOutcome).toBe("indeterminate");
    expect(parsed.observations).toEqual([
      {
        kind: "unknown_event",
        rawEventDigest: createHash("sha256").update(beforeThread, "utf8").digest("hex"),
      },
      { kind: "thread_started", sessionRef: "thread-01" },
      {
        kind: "unknown_event",
        rawEventDigest: createHash("sha256").update(duringTurn, "utf8").digest("hex"),
      },
      { kind: "turn_started" },
    ]);
  });
});

describe("Codex capability probe and durable operation adapter", () => {
  const now = new Date("2026-07-24T00:00:00.000Z");
  const schemaDigest = "b".repeat(64);
  const evidenceDigest = "c".repeat(64);
  const nativeSessionId = NativeSessionIdSchema.parse("ses_codexruntime01");
  const common = {
    schemaVersion: 1 as const,
    projectId: ProjectIdSchema.parse("prj_codexruntime01"),
    runId: RunIdSchema.parse("run_codexruntime01"),
    attemptId: AttemptIdSchema.parse("att_codexruntime01"),
  };

  function source(
    overrides: Record<string, unknown> = {},
  ) {
    return {
      inspect: vi.fn(async () => ({
        schemaVersion: 1,
        executableStatus: "available",
        loginState: "authenticated",
        productVersion: "0.144.6",
        supportedProductVersions: ["0.144.6"],
        protocolKind: "exec-jsonl",
        protocolVersion: "0.144.6",
        supportedProtocolVersions: ["0.144.6"],
        protocolSchemaVersion: 1,
        supportedProtocolSchemaVersions: [1],
        protocolSchemaDigest: schemaDigest,
        evidenceDigest,
        capabilities: [
          "discover",
          "workspace_targeting",
          "launch",
          "observe",
          "structured_events",
          "send",
          "resume",
          "completion_receipt",
          "headless",
        ].map((capability) => ({ capability, status: "supported" })),
        ...overrides,
      })),
    };
  }

  it("persists a versioned receipt and computes the fixed Phase 0 Codex matrix as L1", async () => {
    const save = vi.fn(async () => undefined);
    const probe = new CodexCapabilityProbe(source(), { save }, () => now);

    const receipt = await probe.probe();

    expect(receipt).toMatchObject({
      schemaVersion: 2,
      loginState: "authenticated",
      productVersion: {
        observed: "0.144.6",
        supported: ["0.144.6"],
      },
      protocol: {
        kind: "exec-jsonl",
        observedVersion: "0.144.6",
        schemaVersion: 1,
        schemaDigest,
      },
    });
    expect(save).toHaveBeenCalledWith(receipt);
    expect(computeCapabilityManifest(receipt, now).level).toBe("L1");
    expect(
      computeCapabilityManifest(receipt, now).capabilities
        .find(({ capability }) => capability === "interrupt"),
    ).toMatchObject({ status: "unknown" });
  });

  it("fails closed for logged-out and unknown-version observations", async () => {
    const loggedOut = await new CodexCapabilityProbe(
      source({ loginState: "unauthenticated" }),
      { save: async () => undefined },
      () => now,
    ).probe();
    const unknownVersion = await new CodexCapabilityProbe(
      source({ productVersion: null }),
      { save: async () => undefined },
      () => now,
    ).probe();

    expect(computeCapabilityManifest(loggedOut, now).level).toBe("NONE");
    expect(computeCapabilityManifest(unknownVersion, now).level).toBe("NONE");
  });

  it("never advertises deep observe when the structured event stream is missing", async () => {
    const receipt = await new CodexCapabilityProbe(
      source({
        capabilities: [
          "discover",
          "workspace_targeting",
          "launch",
          "observe",
        ].map((capability) => ({ capability, status: "supported" })),
      }),
      { save: async () => undefined },
      () => now,
    ).probe();

    expect(
      computeCapabilityManifest(receipt, now).capabilities
        .find(({ capability }) => capability === "observe"),
    ).toMatchObject({ status: "unknown" });
    expect(computeCapabilityManifest(receipt, now).level).toBe("L0");
  });

  function operation(
    operationType: "session.launch" | "session.send" | "session.resume" | "session.interrupt",
    operationId: string,
  ): ExternalOperation {
    const base = {
      ...common,
      operationId: OperationIdSchema.parse(operationId),
      requestedCapabilities: [
        operationType === "session.launch"
          ? "launch"
          : operationType === "session.interrupt"
            ? "interrupt"
            : operationType === "session.resume"
              ? "resume"
              : "send",
      ],
    };
    if (operationType === "session.launch") {
      return createExternalOperation({
        ...base,
        operationVersion: 1,
        operationType,
        payload: {
          agentProfileId: AgentProfileIdSchema.parse("apr_codexruntime01"),
          workspaceId: WorkspaceIdSchema.parse("wsp_codexruntime01"),
        },
      });
    }
    const authority = {
      controllerLeaseId: ControllerLeaseIdSchema.parse("ctl_codexruntime01"),
      controllerLeaseOwnerId: LeaseOwnerIdSchema.parse("own_codexruntime01"),
      controllerLeaseGeneration: 1,
    };
    return createExternalOperation({
      ...base,
      operationVersion: 2,
      operationType,
      payload: operationType === "session.send"
        ? {
            nativeSessionId,
            inputEvidenceId: EvidenceIdSchema.parse("evd_codexruntime01"),
            ...authority,
          }
        : operationType === "session.interrupt"
          ? { nativeSessionId, reason: "bounded test", ...authority }
          : { nativeSessionId, ...authority },
    });
  }

  async function provenReceipt() {
    return new CodexCapabilityProbe(
      source({
        capabilities: [
          "discover",
          "workspace_targeting",
          "launch",
          "observe",
          "structured_events",
          "send",
          "interrupt",
          "resume",
          "completion_receipt",
        ].map((capability) => ({ capability, status: "supported" })),
      }),
      { save: async () => undefined },
      () => now,
    ).probe();
  }

  it("dispatches launch/send/resume/interrupt with the stable operationId and persists native refs in receipts", async () => {
    const calls: ExternalOperation[] = [];
    const transport: CodexOperationTransport = {
      execute: vi.fn(async (input) => {
        calls.push(input);
        return {
          operationId: input.operationId,
          nativeSessionId,
          state: input.operationType === "session.interrupt" ? "waiting_input" : "running",
          evidenceDigest,
        } satisfies CodexOperationObservation;
      }),
      reconcile: vi.fn(async () => ({ outcome: "unknown" })),
    };
    const connector = new CodexConnector(transport, await provenReceipt(), () => now);
    const operations = [
      operation("session.launch", "opn_codexdeep001"),
      operation("session.send", "opn_codexdeep002"),
      operation("session.resume", "opn_codexdeep003"),
      operation("session.interrupt", "opn_codexdeep004"),
    ];

    for (const externalOperation of operations) {
      const receipt = await connector.execute(externalOperation);
      expect(receipt.operationId).toBe(externalOperation.operationId);
      expect(receipt.fingerprint).toBe(externalOperation.fingerprint);
      expect(receipt.nativeReferences).toContainEqual({
        kind: "session",
        referenceId: nativeSessionId,
      });
      expect(receipt.facts.every((fact) => !runtimeFactCanCompleteStep(fact))).toBe(true);
    }
    expect(calls.map(({ operationId }) => operationId)).toEqual(
      operations.map(({ operationId }) => operationId),
    );
  });

  it("rejects an unproven requested atom before transport I/O", async () => {
    const transport: CodexOperationTransport = {
      execute: vi.fn(),
      reconcile: vi.fn(async () => ({ outcome: "unknown" })),
    };
    const connector = new CodexConnector(
      transport,
      await new CodexCapabilityProbe(source(), { save: async () => undefined }, () => now).probe(),
      () => now,
    );

    await expect(
      connector.execute(operation("session.interrupt", "opn_codexblocked01")),
    ).rejects.toThrow(/^CODEX_CAPABILITY_NOT_PROVEN$/u);
    expect(transport.execute).not.toHaveBeenCalled();
  });

  it("reconciles a crash-after-create from a new adapter without creating another session", async () => {
    const created = new Map<string, CodexOperationObservation>();
    let creates = 0;
    const transport: CodexOperationTransport = {
      execute: vi.fn(async (input) => {
        creates += 1;
        created.set(input.operationId, {
          operationId: input.operationId,
          nativeSessionId,
          state: "created",
          evidenceDigest,
        });
        throw new Error("fixture crash after native effect");
      }),
      reconcile: vi.fn(async (input) => {
        const observation = created.get(input.operationId);
        return observation === undefined
          ? { outcome: "confirmed_absent" }
          : { outcome: "attached", observation };
      }),
    };
    const launch = operation("session.launch", "opn_codexcrash001");
    const receipt = await provenReceipt();
    await expect(
      new CodexConnector(transport, receipt, () => now).execute(launch),
    ).rejects.toThrow(/^CODEX_TRANSPORT_FAILED$/u);

    const recovered = await new CodexConnector(
      transport,
      receipt,
      () => now,
    ).reconcile(launch);

    expect(recovered).toMatchObject({
      outcome: "attached",
      receipt: {
        operationId: launch.operationId,
        nativeReferences: [{ kind: "session", referenceId: nativeSessionId }],
      },
    });
    expect(creates).toBe(1);
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
