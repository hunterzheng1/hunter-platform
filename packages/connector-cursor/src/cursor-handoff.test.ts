import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import {
  AgentProfileIdSchema,
  AttemptIdSchema,
  EvidenceIdSchema,
  OperationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  WorkspaceIdSchema,
} from "@hunter/domain";
import { createExternalOperation, runtimeFactCanCompleteStep } from "@hunter/runtime-contracts";
import { OperationWorker, SqliteOperationJournal } from "@hunter/storage";
import { describe, expect, it } from "vitest";
import {
  CURSOR_SYNTHETIC_LIMITS,
  type CursorHandoffCandidateRequest,
  type CursorHandoffCandidateResult,
  type SyntheticCursorHandoffRequest,
  type SyntheticCursorHandoffTransport,
} from "./cursor-handoff.js";
import { CursorHandoffCandidate } from "./cursor-handoff.js";
import {
  CURSOR_TASK_PACK_LIMITS,
  renderTaskPack,
  taskPackRelativePath,
} from "./task-pack.js";

const operationId = OperationIdSchema.parse("opn_cursorhandoff01");
const profileId = AgentProfileIdSchema.parse("apr_cursorimpl0001");
const workspaceId = WorkspaceIdSchema.parse("wsp_cursorfixture01");
const prompt = "Implement the bounded fixture task.";

type FixtureResponse =
  | {
      readonly accepted: boolean;
      readonly operationId: typeof operationId;
      readonly contentDigest: string;
    }
  | {
      readonly opened: boolean;
      readonly operationId: typeof operationId;
    }
  | string
  | object;

class FixtureTransport implements SyntheticCursorHandoffTransport {
  readonly calls: SyntheticCursorHandoffRequest[] = [];

  constructor(
    private readonly responseFor: (
      request: SyntheticCursorHandoffRequest,
    ) => FixtureResponse,
  ) {}

  async request(message: SyntheticCursorHandoffRequest): Promise<string> {
    this.calls.push(message);
    const response = this.responseFor(message);
    return typeof response === "string" ? response : JSON.stringify(response);
  }
}

function successfulTransport(): FixtureTransport {
  return new FixtureTransport((request) =>
    request.method === "writeTaskPack"
      ? {
          accepted: true,
          operationId: request.params.operationId,
          contentDigest: request.params.contentDigest,
        }
      : {
          opened: true,
          operationId: request.params.operationId,
        },
  );
}

const request = { operationId, profileId, workspaceId, prompt };

function dispatchFixture(
  candidate: CursorHandoffCandidate,
  value: CursorHandoffCandidateRequest,
): Promise<CursorHandoffCandidateResult> {
  return (
    candidate as unknown as {
      dispatchFixture(
        input: CursorHandoffCandidateRequest,
      ): Promise<CursorHandoffCandidateResult>;
    }
  ).dispatchFixture(value);
}

describe("Cursor deterministic task pack", () => {
  it("renders a deterministic provenance-rich pack at a canonical safe path", () => {
    const first = renderTaskPack(request);
    const second = renderTaskPack(request);

    expect(second).toEqual(first);
    expect(first.relativePath).toBe(
      ".hunter/handoffs/opn_cursorhandoff01.md",
    );
    expect(first.contentDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.content).toContain("Schema: hunter.cursor.task_pack/v1");
    expect(first.content).toContain(`Operation: ${operationId}`);
    expect(first.content).toContain(`Agent profile: ${profileId}`);
    expect(first.content).toContain(`Workspace: ${workspaceId}`);
    expect(first.content).toContain(
      "Manual declaration must be followed by Hunter verifier.",
    );
  });

  it("BND-05 derives a task-pack filename only from a branded OperationId", () => {
    expect(taskPackRelativePath(operationId)).toBe(
      ".hunter/handoffs/opn_cursorhandoff01.md",
    );
    expect(() =>
      taskPackRelativePath("opn_../../private" as never),
    ).toThrow("UNBRANDED_ID");
    const maximum = OperationIdSchema.parse(`opn_${"a".repeat(92)}`);
    expect(taskPackRelativePath(maximum)).toBe(
      `.hunter/handoffs/${maximum}.md`,
    );
  });

  it("contains only the stable workspace identity and no absolute workspace path", () => {
    const taskPack = renderTaskPack(request);

    expect(taskPack.content).toContain(workspaceId);
    expect(taskPack.content).not.toMatch(
      /(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/(?:Users|home)\/)/u,
    );
    expect(taskPack).not.toHaveProperty("workspacePath");
  });

  it("encodes hostile Markdown and HTML as a reversible indented JSON code block", () => {
    const privatePrompt =
      '<img src=x onerror=alert(1)><script>private()</script>\n# Forged\n```escape```\n<&>\u2028\u2029';
    const taskPack = renderTaskPack({ ...request, prompt: privatePrompt });
    const codeLine = taskPack.content
      .split("\n")
      .find((line) => line.startsWith("    "));

    expect(codeLine).toBeDefined();
    expect(JSON.parse(codeLine?.slice(4) ?? "null")).toBe(privatePrompt);
    expect(taskPack.content).not.toContain("<img");
    expect(taskPack.content).not.toContain("<script");
    expect(taskPack.content).not.toContain("<&>");
    expect(taskPack.content).not.toContain("\u2028");
    expect(taskPack.content).not.toContain("\u2029");
    expect(taskPack.content).not.toContain("\n# Forged");
  });

  it.each([
    { ...request, operationId: "opn_../../private" },
    { ...request, operationId: "opn_cursor\\private" },
    { ...request, profileId: "cursor_impl" },
    { ...request, workspaceId: "C:\\private\\workspace" },
    { ...request, prompt: "private\rprompt" },
    { ...request, prompt: "private\u0000prompt" },
    { ...request, prompt: "x".repeat(16_385) },
    { ...request, privatePath: "C:\\Users\\private" },
  ])("rejects unsafe or non-canonical task-pack input", (unsafe) => {
    expect(() => renderTaskPack(unsafe as never)).toThrow(
      /^CURSOR_TASK_PACK_INPUT_(?:INVALID|TOO_LARGE|UNSAFE)$/u,
    );
  });

  it("sanitizes proxy/getter failures at the task-pack boundary", () => {
    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error("private token=CREDENTIAL");
        },
      },
    );

    expect(() => renderTaskPack(proxy as never)).toThrow(
      /^CURSOR_TASK_PACK_INPUT_INVALID$/u,
    );
  });
});

describe("Cursor contract-only synthetic handoff candidate", () => {
  it.each([
    { observed: "attached" as const, expected: "attached" },
    { observed: "confirmed_absent" as const, expected: "confirmed_absent" },
  ])(
    "reconciles a task pack by operation identity and content fingerprint: $observed",
    async ({ observed, expected }) => {
      const transport = successfulTransport();
      const observations: unknown[] = [];
      const operation = createExternalOperation({
        schemaVersion: 1,
        projectId: ProjectIdSchema.parse("prj_cursorreconcile"),
        runId: RunIdSchema.parse("run_cursorreconcile"),
        attemptId: AttemptIdSchema.parse("att_cursorreconcile"),
        operationId: OperationIdSchema.parse("opn_cursorreconcile"),
        operationVersion: 2,
        operationType: "task_pack.write",
        requestedCapabilities: ["artifact_export"],
        payload: {
          workspaceId,
          inputEvidenceId: EvidenceIdSchema.parse("evd_cursorreconcile"),
        },
      });
      const handler = new CursorHandoffCandidate(
        transport,
        { candidateSchemaVersion: 1 },
        {
          taskPackInputFor: () => ({ profileId, prompt }),
          observeTaskPack: async (observation) => {
            observations.push(observation);
            return observed;
          },
          observedAt: () => "2026-07-23T00:00:00.000Z",
        },
      );
      const pack = renderTaskPack({
        operationId: operation.operationId,
        profileId,
        workspaceId,
        prompt,
      });

      const result = await handler.reconcile(operation);

      expect(result.outcome).toBe(expected);
      expect(observations).toEqual([{
        operationId: operation.operationId,
        workspaceId,
        relativePath: pack.relativePath,
        contentDigest: pack.contentDigest,
      }]);
      if (result.outcome === "attached") {
        expect(result.receipt).toMatchObject({
          operationId: operation.operationId,
          fingerprint: operation.fingerprint,
          operationStatus: "completed",
          evidence: {
            evidenceHash: pack.contentDigest,
            proofScope: "local_observation",
          },
        });
      }
      expect(transport.calls).toHaveLength(0);
    },
  );

  it("keeps native-surface recovery UNKNOWN without observing or reopening it", async () => {
    const transport = successfulTransport();
    let observations = 0;
    const operation = createExternalOperation({
      schemaVersion: 1,
      projectId: ProjectIdSchema.parse("prj_cursorreconcile"),
      runId: RunIdSchema.parse("run_cursorreconcile"),
      attemptId: AttemptIdSchema.parse("att_cursorreconcile"),
      operationId: OperationIdSchema.parse("opn_cursorreopen001"),
      operationVersion: 1,
      operationType: "native_surface.open",
      requestedCapabilities: ["native_surface"],
      payload: { workspaceId },
    });
    const handler = new CursorHandoffCandidate(
      transport,
      { candidateSchemaVersion: 1 },
      {
        taskPackInputFor: () => ({ profileId, prompt }),
        observeTaskPack: async () => {
          observations += 1;
          return "attached";
        },
      },
    );

    await expect(handler.reconcile(operation)).resolves.toEqual({
      outcome: "unknown",
    });
    expect(observations).toBe(0);
    expect(transport.calls).toHaveLength(0);
  });

  it("dispatches task-pack write and native-surface open only from the Foundation worker", async () => {
    const transport = successfulTransport();
    const handler = new CursorHandoffCandidate(transport, {
      candidateSchemaVersion: 1,
    }, {
      taskPackInputFor: () => ({ profileId, prompt }),
      observedAt: () => "2026-07-23T00:00:00.000Z",
    });
    const database = new DatabaseSync(":memory:");
    const journal = new SqliteOperationJournal(database);
    const common = {
      schemaVersion: 1,
      projectId: ProjectIdSchema.parse("prj_cursorworker01"),
      runId: RunIdSchema.parse("run_cursorworker01"),
      attemptId: AttemptIdSchema.parse("att_cursorworker01"),
    };
    const write = createExternalOperation({
      ...common,
      operationId: OperationIdSchema.parse("opn_cursorworker01"),
      operationVersion: 2,
      operationType: "task_pack.write",
      requestedCapabilities: ["artifact_export"],
      payload: {
        workspaceId,
        inputEvidenceId: EvidenceIdSchema.parse("evd_cursorworker01"),
      },
    });
    const open = createExternalOperation({
      ...common,
      operationId: OperationIdSchema.parse("opn_cursorworker02"),
      operationVersion: 1,
      operationType: "native_surface.open",
      requestedCapabilities: ["native_surface"],
      payload: { workspaceId },
    });
    journal.commitCommand({
      commandId: "cursor-worker-operations",
      requestFingerprint: "a".repeat(64),
      projectId: common.projectId,
      aggregateId: "attempt:att_cursorworker01",
      expectedVersion: 0,
      actor: { actorId: "test", correlationId: "cursor-worker" },
      events: [],
      operations: [write, open],
      response: {},
    });
    const worker = new OperationWorker(database, handler as never, {
      ownerId: "cursor-worker",
      replayPolicy: () => "inspectable",
    });

    expect(transport.calls).toHaveLength(0);
    await expect(worker.runOnce()).resolves.toBe("completed");
    await expect(worker.runOnce()).resolves.toBe("completed");
    expect(transport.calls.map(({ method }) => method)).toEqual([
      "writeTaskPack",
      "openWorkspace",
    ]);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM side_effect_receipts",
    ).get()).toEqual({ count: 2 });
    database.close();
  });

  it("sends the exact frozen writer then opener messages without a raw path", async () => {
    const transport = successfulTransport();
    const candidate = new CursorHandoffCandidate(transport, {
      candidateSchemaVersion: 1,
    });
    const result = await dispatchFixture(candidate, request);
    const pack = renderTaskPack(request);

    expect(transport.calls).toEqual([
      {
        fixtureKind: "hunter.cursor.synthetic_handoff_v1",
        method: "writeTaskPack",
        params: {
          operationId,
          workspaceId,
          relativePath: pack.relativePath,
          content: pack.content,
          contentDigest: pack.contentDigest,
        },
      },
      {
        fixtureKind: "hunter.cursor.synthetic_handoff_v1",
        method: "openWorkspace",
        params: { operationId, workspaceId },
      },
    ]);
    expect(transport.calls.every(Object.isFrozen)).toBe(true);
    expect(transport.calls.every((call) => Object.isFrozen(call.params))).toBe(
      true,
    );
    expect(
      transport.calls.every((call) => !("workspacePath" in call.params)),
    ).toBe(true);
    const writer = transport.calls[0];
    if (writer?.method === "writeTaskPack") {
      expect(writer.params.content).not.toMatch(
        /(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/(?:Users|home)\/)/u,
      );
    }
    expect(result.taskPackIntent).toEqual({
      relativePath: pack.relativePath,
      contentDigest: pack.contentDigest,
    });
  });

  it("keeps an opened handoff waiting for input and never establishes Step success", async () => {
    const candidate = new CursorHandoffCandidate(successfulTransport(), {
      candidateSchemaVersion: 1,
    });

    const result = await dispatchFixture(candidate, request);

    expect(result).toMatchObject({
      fixtureKind: "hunter.cursor.synthetic_handoff_v1",
      proofScope: "contract_only",
      connectorValidationStatus: "NOT_PROVEN",
      retrySafety: "NOT_PROVEN",
      status: "waiting_input",
      completionSource: "manual_receipt",
      manualReceiptRequiresVerifier: true,
      stepCompletion: "not_established",
      observations: [
        { kind: "task_pack_write_response", accepted: true },
        { kind: "native_surface_open_response", opened: true },
      ],
    });
    expect(result).not.toHaveProperty("manifest");
    expect(result).not.toHaveProperty("level");
    expect(runtimeFactCanCompleteStep({ kind: "native_surface_opened" })).toBe(
      false,
    );
    expect(runtimeFactCanCompleteStep({ kind: "agent_returned" })).toBe(false);
  });

  it("fails honestly when the synthetic writer rejects and does not open a surface", async () => {
    const transport = new FixtureTransport((message) => {
      if (message.method !== "writeTaskPack") {
        throw new Error("opener must not be called");
      }
      return {
        accepted: false,
        operationId: message.params.operationId,
        contentDigest: message.params.contentDigest,
      };
    });
    const candidate = new CursorHandoffCandidate(transport, {
      candidateSchemaVersion: 1,
    });

    const result = await dispatchFixture(candidate, request);

    expect(transport.calls).toHaveLength(1);
    expect(result).toMatchObject({
      status: "needs_attention",
      stepCompletion: "not_established",
      retrySafety: "NOT_PROVEN",
      observations: [
        { kind: "task_pack_write_response", accepted: false },
      ],
    });
  });

  it("reports an unopened surface as needs_attention after an accepted write", async () => {
    const transport = new FixtureTransport((message) =>
      message.method === "writeTaskPack"
        ? {
            accepted: true,
            operationId: message.params.operationId,
            contentDigest: message.params.contentDigest,
          }
        : {
            opened: false,
            operationId: message.params.operationId,
          },
    );

    const result = await dispatchFixture(new CursorHandoffCandidate(transport, {
      candidateSchemaVersion: 1,
    }), request);

    expect(result.status).toBe("needs_attention");
    expect(result.stepCompletion).toBe("not_established");
  });

  it("binds the deterministic fingerprint to every request field without local replay state", async () => {
    const launch = async (value = request) =>
      dispatchFixture(new CursorHandoffCandidate(successfulTransport(), {
        candidateSchemaVersion: 1,
      }), value);
    const baseline = await launch();

    expect((await launch()).fingerprint).toBe(baseline.fingerprint);
    for (const changed of [
      await launch({
        ...request,
        operationId: OperationIdSchema.parse("opn_cursorhandoff02"),
      }),
      await launch({
        ...request,
        profileId: AgentProfileIdSchema.parse("apr_cursorreview01"),
      }),
      await launch({
        ...request,
        workspaceId: WorkspaceIdSchema.parse("wsp_cursorfixture02"),
      }),
      await launch({ ...request, prompt: `${prompt} Changed.` }),
    ]) {
      expect(changed.fingerprint).not.toBe(baseline.fingerprint);
    }
  });

  it("deep-freezes the result and all nested values", async () => {
    const result = await dispatchFixture(new CursorHandoffCandidate(successfulTransport(), {
      candidateSchemaVersion: 1,
    }), request);

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.taskPackIntent)).toBe(true);
    expect(Object.isFrozen(result.observations)).toBe(true);
    expect(result.observations.every(Object.isFrozen)).toBe(true);
  });

  it.each([
    {
      label: "malformed JSON",
      response: "{broken",
      expected: "CURSOR_RESPONSE_INVALID",
    },
    {
      label: "oversized JSON",
      response: `{"private":"${"x".repeat(
        CURSOR_SYNTHETIC_LIMITS.maxResponseBytes,
      )}"}`,
      expected: "CURSOR_RESPONSE_TOO_LARGE",
    },
    {
      label: "private response field",
      response: JSON.stringify({
        accepted: true,
        operationId,
        contentDigest: "a".repeat(64),
        token: "private",
      }),
      expected: "CURSOR_RESPONSE_INVALID",
    },
  ])("fails closed on $label with a fixed error", async ({ response, expected }) => {
    const transport: SyntheticCursorHandoffTransport = {
      request: async () => response,
    };
    const candidate = new CursorHandoffCandidate(transport, {
      candidateSchemaVersion: 1,
    });

    await expect(dispatchFixture(candidate, request)).rejects.toThrow(
      new RegExp(`^${expected}$`, "u"),
    );
  });

  it("rejects an object response without reading a private getter", async () => {
    let reads = 0;
    const response = Object.defineProperty({}, "private", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("private response");
      },
    });
    const transport = {
      request: async () => response,
    } as unknown as SyntheticCursorHandoffTransport;

    await expect(
      dispatchFixture(new CursorHandoffCandidate(transport, {
        candidateSchemaVersion: 1,
      }), request),
    ).rejects.toThrow(/^CURSOR_RESPONSE_INVALID$/u);
    expect(reads).toBe(0);
  });

  it("sanitizes writer and opener transport failures without echoing content", async () => {
    for (const failMethod of ["writeTaskPack", "openWorkspace"] as const) {
      const transport: SyntheticCursorHandoffTransport = {
        request: async (message) => {
          if (message.method === failMethod) {
            throw new Error(`token=private content=${message.method}`);
          }
          return JSON.stringify({
            accepted: true,
            operationId: message.params.operationId,
            contentDigest:
              message.method === "writeTaskPack"
                ? message.params.contentDigest
                : "not-used",
          });
        },
      };

      await expect(
        dispatchFixture(new CursorHandoffCandidate(transport, {
          candidateSchemaVersion: 1,
        }), request),
      ).rejects.toThrow(/^CURSOR_SYNTHETIC_TRANSPORT_FAILED$/u);
    }
  });

  it.each([
    {
      label: "newline expansion",
      extremePrompt: `${"\n".repeat(
        CURSOR_TASK_PACK_LIMITS.maxPromptBytes - 1,
      )}x`,
    },
    {
      label: "HTML escape expansion",
      extremePrompt: `${"<>&".repeat(
        Math.floor(CURSOR_TASK_PACK_LIMITS.maxPromptBytes / 3),
      )}x`,
    },
  ])(
    "sends every valid maximum-byte prompt under the shared content budget: $label",
    async ({ extremePrompt }) => {
      expect(Buffer.byteLength(extremePrompt, "utf8")).toBe(
        CURSOR_TASK_PACK_LIMITS.maxPromptBytes,
      );
      const transport = successfulTransport();
      const result = await dispatchFixture(new CursorHandoffCandidate(transport, {
        candidateSchemaVersion: 1,
      }), { ...request, prompt: extremePrompt });

      expect(result.status).toBe("waiting_input");
      expect(transport.calls).toHaveLength(2);
      const writeCall = transport.calls[0];
      expect(writeCall?.method).toBe("writeTaskPack");
      if (writeCall?.method === "writeTaskPack") {
        expect(Buffer.byteLength(writeCall.params.content, "utf8")).toBeLessThanOrEqual(
          CURSOR_TASK_PACK_LIMITS.maxContentBytes,
        );
      }
    },
  );

  it("sanitizes an invalid internal synthetic request instead of leaking Zod details", async () => {
    const candidate = new CursorHandoffCandidate(successfulTransport(), {
      candidateSchemaVersion: 1,
    });
    const internal = candidate as unknown as {
      call(value: unknown): Promise<unknown>;
    };

    await expect(
      internal.call({
        fixtureKind: "hunter.cursor.synthetic_handoff_v1",
        method: "writeTaskPack",
        params: {
          operationId,
          workspaceId,
          relativePath: ".hunter/handoffs/private.md",
          content: "private",
          contentDigest: "not-a-digest",
        },
      }),
    ).rejects.toThrow(/^CURSOR_SYNTHETIC_REQUEST_INVALID$/u);
  });

  it.each([
    { ...request, operationId: "opn_invalid/operation" },
    { ...request, profileId: "apr_short" },
    { ...request, workspaceId: "../private" },
    { ...request, prompt: "private\rprompt" },
    { ...request, privateExtra: "not accepted" },
  ])("rejects strict request input before transport dispatch", async (unsafe) => {
    const transport = successfulTransport();
    const candidate = new CursorHandoffCandidate(transport, {
      candidateSchemaVersion: 1,
    });

    await expect(dispatchFixture(candidate, unsafe as never)).rejects.toThrow(
      /^CURSOR_REQUEST_(?:INVALID|TOO_LARGE|UNSAFE)$/u,
    );
    expect(transport.calls).toHaveLength(0);
  });

  it("rejects strict options and proxy inputs with fixed errors", async () => {
    const transport = successfulTransport();
    expect(
      () =>
        new CursorHandoffCandidate(transport, {
          candidateSchemaVersion: 2,
        } as never),
    ).toThrow(/^CURSOR_OPTIONS_INVALID$/u);
    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error("private options");
        },
      },
    );
    expect(
      () => new CursorHandoffCandidate(transport, proxy as never),
    ).toThrow(/^CURSOR_OPTIONS_INVALID$/u);
  });

  it("contains no filesystem, GUI, shell, endpoint, capability, or bypass implementation", async () => {
    const root = new URL("../../../", import.meta.url);
    const source = (
      await Promise.all(
        [
          "packages/connector-cursor/src/task-pack.ts",
          "packages/connector-cursor/src/cursor-handoff.ts",
          "packages/connector-cursor/src/index.ts",
        ].map((file) => readFile(new URL(file, root), "utf8")),
      )
    ).join("\n");

    expect(source).not.toMatch(
      /\b(?:node:fs|writeFile|mkdir|child_process|execFile|spawn|NativeSurfaceOpener|fetch|https?:|localhost|CapabilityManifest|manifest|level:\s*["']L1|yolo|dangerously-bypass|auto-approve)\b/iu,
    );
    expect(source).toContain("hunter.cursor.synthetic_handoff_v1");
  });
});
