import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  AgentProfileIdSchema,
  OperationIdSchema,
} from "@hunter/domain";
import { runtimeFactCanCompleteStep } from "@hunter/runtime-contracts";
import {
  ACP_LIMITS,
  type AcpRequest,
  type AcpTransport,
} from "./acp-transport.js";
import { CodeBuddyCandidateConnector } from "./codebuddy-connector.js";

const launchOperationId = OperationIdSchema.parse("opn_codebuddylaunch01");
const resumeOperationId = OperationIdSchema.parse("opn_codebuddyresume01");
const interruptOperationId = OperationIdSchema.parse("opn_codebuddyinterrupt01");
const profileId = AgentProfileIdSchema.parse("apr_codebuddyimpl01");
const workspacePath = "C:\\fixtures\\hunter-codebuddy-worktree";
const prompt = "Inspect the fixture and return a bounded summary.";
const sessionRef = "cb-session-01";

type AcpResponse =
  | { readonly protocolVersion: 1 }
  | { readonly sessionId: string }
  | {
      readonly accepted: boolean;
      readonly sessionId: string;
      readonly runId: string;
    };

class FixtureTransport implements AcpTransport {
  readonly calls: AcpRequest[] = [];

  constructor(private readonly responses: readonly AcpResponse[]) {}

  async request(message: AcpRequest): Promise<unknown> {
    this.calls.push(message);
    const response = this.responses[this.calls.length - 1];
    if (response === undefined) throw new Error("private token=CREDENTIAL");
    return response;
  }
}

function launchResponses(
  overrides: Partial<{
    readonly protocolVersion: 1;
    readonly sessionId: string;
    readonly accepted: boolean;
    readonly runId: string;
  }> = {},
): readonly AcpResponse[] {
  return [
    { protocolVersion: overrides.protocolVersion ?? 1 },
    { sessionId: overrides.sessionId ?? sessionRef },
    {
      accepted: overrides.accepted ?? true,
      sessionId: overrides.sessionId ?? sessionRef,
      runId: overrides.runId ?? launchOperationId,
    },
  ];
}

describe("CodeBuddy ACP contract-only candidate", () => {
  it("uses the exact initialize, newSession, and prompt sequence with immutable messages", async () => {
    const transport = new FixtureTransport(launchResponses());
    const connector = new CodeBuddyCandidateConnector(transport, {
      pathFlavor: "windows",
    });

    const result = await connector.launch({
      operationId: launchOperationId,
      profileId,
      workspacePath,
      prompt,
    });

    expect(transport.calls).toEqual([
      {
        method: "initialize",
        params: { client: "hunter", protocolVersion: 1 },
      },
      {
        method: "newSession",
        params: { cwd: workspacePath, profileId },
      },
      {
        method: "prompt",
        params: {
          sessionId: sessionRef,
          runId: launchOperationId,
          prompt,
        },
      },
    ]);
    expect(transport.calls.every(Object.isFrozen)).toBe(true);
    expect(transport.calls.every((call) => Object.isFrozen(call.params))).toBe(
      true,
    );
    expect(result.sessionRef).toBe(sessionRef);
  });

  it("does not cache initialize state or claim durable replay safety", async () => {
    const transport = new FixtureTransport([
      ...launchResponses(),
      ...launchResponses(),
    ]);
    const connector = new CodeBuddyCandidateConnector(transport, {
      pathFlavor: "windows",
    });
    const request = {
      operationId: launchOperationId,
      profileId,
      workspacePath,
      prompt,
    };

    const first = await connector.launch(request);
    const second = await connector.launch(request);

    expect(transport.calls.map(({ method }) => method)).toEqual([
      "initialize",
      "newSession",
      "prompt",
      "initialize",
      "newSession",
      "prompt",
    ]);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.retrySafety).toBe("NOT_PROVEN");
  });

  it("resumes only by prompting the validated same session", async () => {
    const transport = new FixtureTransport([
      {
        accepted: true,
        sessionId: sessionRef,
        runId: resumeOperationId,
      },
    ]);
    const connector = new CodeBuddyCandidateConnector(transport, {
      pathFlavor: "windows",
    });

    const result = await connector.resume(sessionRef, {
      operationId: resumeOperationId,
      profileId,
      workspacePath,
      prompt,
    });

    expect(transport.calls).toEqual([
      {
        method: "prompt",
        params: {
          sessionId: sessionRef,
          runId: resumeOperationId,
          prompt,
        },
      },
    ]);
    expect(result.sessionRef).toBe(sessionRef);
  });

  it("records cancel request and response facts without structured interrupt proof", async () => {
    const transport = new FixtureTransport([
      {
        accepted: true,
        sessionId: sessionRef,
        runId: interruptOperationId,
      },
    ]);
    const connector = new CodeBuddyCandidateConnector(transport, {
      pathFlavor: "windows",
    });

    const result = await connector.interrupt(sessionRef, interruptOperationId);

    expect(transport.calls).toEqual([
      {
        method: "cancelRun",
        params: { sessionId: sessionRef, runId: interruptOperationId },
      },
    ]);
    expect(result).toMatchObject({
      proofScope: "contract_only",
      connectorValidationStatus: "NOT_PROVEN",
      retrySafety: "NOT_PROVEN",
      structuredInterrupt: "NOT_PROVEN",
      sessionTargeting: "NOT_PROVEN",
      stepCompletion: "not_established",
      observations: [
        { kind: "cancel_requested" },
        { kind: "cancel_response", accepted: true },
      ],
    });
    expect(result).not.toHaveProperty("operationStatus");
  });

  it.each([true, false])(
    "keeps prompt accepted=%s as an observation instead of Step success",
    async (accepted) => {
      const transport = new FixtureTransport(launchResponses({ accepted }));
      const connector = new CodeBuddyCandidateConnector(transport, {
        pathFlavor: "windows",
      });

      const result = await connector.launch({
        operationId: launchOperationId,
        profileId,
        workspacePath,
        prompt,
      });

      expect(result).toMatchObject({
        proofScope: "contract_only",
        connectorValidationStatus: "NOT_PROVEN",
        retrySafety: "NOT_PROVEN",
        stepCompletion: "not_established",
        observations: [
          { kind: "protocol_initialized", protocolVersion: 1 },
          { kind: "session_created" },
          { kind: "prompt_response", accepted },
        ],
      });
      expect(result).not.toHaveProperty("operationStatus");
      expect(
        runtimeFactCanCompleteStep(
          accepted
            ? { kind: "agent_returned" }
            : { kind: "process_exited", exitCode: 0 },
        ),
      ).toBe(false);
    },
  );

  it("binds a deterministic fingerprint to every payload field without claiming idempotency", async () => {
    const baseline = async (overrides: Partial<{
      readonly operationId: typeof launchOperationId;
      readonly profileId: typeof profileId;
      readonly workspacePath: string;
      readonly prompt: string;
    }> = {}) => {
      const request = {
        operationId: overrides.operationId ?? launchOperationId,
        profileId: overrides.profileId ?? profileId,
        workspacePath: overrides.workspacePath ?? workspacePath,
        prompt: overrides.prompt ?? prompt,
      };
      const connector = new CodeBuddyCandidateConnector(
        new FixtureTransport(
          launchResponses({ runId: request.operationId }),
        ),
        { pathFlavor: "windows" },
      );
      return connector.launch(request);
    };
    const same = await baseline();
    const changedOperation = await baseline({
      operationId: OperationIdSchema.parse("opn_codebuddylaunch02"),
    });
    const changedProfile = await baseline({
      profileId: AgentProfileIdSchema.parse("apr_codebuddyreview01"),
    });
    const changedPath = await baseline({
      workspacePath: "C:\\fixtures\\other-worktree",
    });
    const changedPrompt = await baseline({ prompt: `${prompt} Changed.` });

    expect((await baseline()).fingerprint).toBe(same.fingerprint);
    for (const changed of [
      changedOperation,
      changedProfile,
      changedPath,
      changedPrompt,
    ]) {
      expect(changed.fingerprint).not.toBe(same.fingerprint);
    }
  });

  it("deep-freezes results and nested observations", async () => {
    const connector = new CodeBuddyCandidateConnector(
      new FixtureTransport(launchResponses()),
      { pathFlavor: "windows" },
    );
    const result = await connector.launch({
      operationId: launchOperationId,
      profileId,
      workspacePath,
      prompt,
    });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.observations)).toBe(true);
    expect(result.observations.every(Object.isFrozen)).toBe(true);
  });

  it.each([
    {
      label: "initialize extra private field",
      responses: [
        { protocolVersion: 1, token: "private-token" },
        { sessionId: sessionRef },
        {
          accepted: true,
          sessionId: sessionRef,
          runId: launchOperationId,
        },
      ],
    },
    {
      label: "malformed new session",
      responses: [
        { protocolVersion: 1 },
        { sessionId: "../private" },
        {
          accepted: true,
          sessionId: sessionRef,
          runId: launchOperationId,
        },
      ],
    },
    {
      label: "oversized prompt response",
      responses: [
        { protocolVersion: 1 },
        { sessionId: sessionRef },
        {
          accepted: true,
          sessionId: "x".repeat(ACP_LIMITS.maxStringBytes + 1),
          runId: launchOperationId,
        },
      ],
    },
    {
      label: "private response object too deep",
      responses: [
        { protocolVersion: 1 },
        { sessionId: sessionRef },
        {
          accepted: true,
          sessionId: sessionRef,
          runId: launchOperationId,
          private: {
            a: { b: { c: { d: { e: { f: { g: { h: { i: "secret" } } } } } } } },
          },
        },
      ],
    },
  ])("fails closed on $label without disclosure", async ({ responses }) => {
    const connector = new CodeBuddyCandidateConnector(
      new FixtureTransport(responses as never),
      { pathFlavor: "windows" },
    );

    await expect(
      connector.launch({
        operationId: launchOperationId,
        profileId,
        workspacePath,
        prompt,
      }),
    ).rejects.toThrow(/^CODEBUDDY_RESPONSE_(?:INVALID|TOO_LARGE)$/u);
  });

  it.each([
    {
      operationId: "invalid-operation",
      profileId,
      workspacePath,
      prompt,
    },
    {
      operationId: launchOperationId,
      profileId: "invalid-profile",
      workspacePath,
      prompt,
    },
    {
      operationId: launchOperationId,
      profileId,
      workspacePath: "relative\\private",
      prompt,
    },
    {
      operationId: launchOperationId,
      profileId,
      workspacePath: "C:\\fixtures\\..\\private",
      prompt,
    },
    {
      operationId: launchOperationId,
      profileId,
      workspacePath,
      prompt: "-yolo",
    },
    {
      operationId: launchOperationId,
      profileId,
      workspacePath,
      prompt: "private\u0000prompt",
    },
    {
      operationId: launchOperationId,
      profileId,
      workspacePath,
      prompt,
      privateExtra: "not accepted",
    },
  ])("rejects unsafe launch input before transport dispatch", async (request) => {
    const transport = new FixtureTransport(launchResponses());
    const connector = new CodeBuddyCandidateConnector(transport, {
      pathFlavor: "windows",
    });

    await expect(connector.launch(request as never)).rejects.toThrow(
      /^CODEBUDDY_(?:REQUEST|WORKSPACE_PATH|PROMPT)_/u,
    );
    expect(transport.calls).toHaveLength(0);
  });

  it.each(["", " ", "-session", "../private", "x".repeat(257)])(
    "rejects unsafe session identity before transport dispatch: %s",
    async (unsafeSessionRef) => {
      const transport = new FixtureTransport([]);
      const connector = new CodeBuddyCandidateConnector(transport, {
        pathFlavor: "windows",
      });

      await expect(
        connector.resume(unsafeSessionRef, {
          operationId: resumeOperationId,
          profileId,
          workspacePath,
          prompt,
        }),
      ).rejects.toThrow(/^CODEBUDDY_SESSION_ID_INVALID$/u);
      expect(transport.calls).toHaveLength(0);
    },
  );

  it("rejects invalid transport options at construction", () => {
    expect(
      () =>
        new CodeBuddyCandidateConnector(new FixtureTransport([]), {
          pathFlavor: "other",
        } as never),
    ).toThrow(/^CODEBUDDY_OPTIONS_INVALID$/u);
  });

  it("rejects mismatched response identities without retaining provider data", async () => {
    const connector = new CodeBuddyCandidateConnector(
      new FixtureTransport(
        launchResponses({
          runId: OperationIdSchema.parse("opn_codebuddymismatch01"),
        }),
      ),
      { pathFlavor: "windows" },
    );

    await expect(
      connector.launch({
        operationId: launchOperationId,
        profileId,
        workspacePath,
        prompt,
      }),
    ).rejects.toThrow(/^CODEBUDDY_RESPONSE_IDENTITY_MISMATCH$/u);
  });

  it("sanitizes transport failures without disclosing prompt, paths, or credentials", async () => {
    const transport: AcpTransport = {
      request: async () => {
        throw new Error(
          `token=private path=${workspacePath} prompt=${prompt}`,
        );
      },
    };
    const connector = new CodeBuddyCandidateConnector(transport, {
      pathFlavor: "windows",
    });

    await expect(
      connector.launch({
        operationId: launchOperationId,
        profileId,
        workspacePath,
        prompt,
      }),
    ).rejects.toThrow(/^CODEBUDDY_TRANSPORT_FAILED$/u);
  });

  it("contains no production endpoint, fetch, capability manifest, or bypass switch", async () => {
    const root = new URL("../../../", import.meta.url);
    const files = [
      "packages/connector-codebuddy/src/acp-transport.ts",
      "packages/connector-codebuddy/src/codebuddy-connector.ts",
    ];
    const source = (
      await Promise.all(
        files.map((file) => readFile(new URL(file, root), "utf8")),
      )
    ).join("\n");

    expect(source).not.toMatch(
      /\b(?:fetch|https?:|HttpAcpTransport|CapabilityManifest|localhost|127\.0\.0\.1|yolo|dangerously-bypass|auto-approve)\b/iu,
    );
  });
});
