import { createHash } from "node:crypto";
import {
  AgentProfileIdSchema,
  OperationIdSchema,
  type AgentProfileId,
  type OperationId,
} from "@hunter/domain";
import { z } from "zod";
import {
  CodeBuddyNativeSessionRefSchema,
  SyntheticCodeBuddyCandidateRequestSchema,
  SyntheticCodeBuddyCancelRunResponseSchema,
  SyntheticCodeBuddyInitializeResponseSchema,
  SyntheticCodeBuddyNewSessionResponseSchema,
  SyntheticCodeBuddyPromptResponseSchema,
  parseSyntheticCodeBuddyCandidateResponseText,
  type CodeBuddyNativeSessionRef,
  type SyntheticCodeBuddyCandidateRequest,
  type SyntheticCodeBuddyCandidateTransport,
} from "./synthetic-candidate-transport.js";

const PromptSchema = z.string().min(1).max(16_384);
const CandidateRequestSchema = z.strictObject({
  operationId: OperationIdSchema,
  profileId: AgentProfileIdSchema,
  workspacePath: z.string(),
  prompt: z.string(),
});
const CandidateOptionsSchema = z.strictObject({
  pathFlavor: z.enum(["windows", "posix"]),
});

const CandidateObservationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("candidate_initialize_observed"),
    candidateSchemaVersion: z.literal(1),
  }),
  z.strictObject({ kind: z.literal("session_created") }),
  z.strictObject({
    kind: z.literal("prompt_response"),
    accepted: z.boolean(),
  }),
]);

const CandidateResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operationId: OperationIdSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  mode: z.enum(["launch", "resume"]),
  fixtureKind: z.literal("hunter.codebuddy.synthetic_candidate_v1"),
  proofScope: z.literal("contract_only"),
  connectorValidationStatus: z.literal("NOT_PROVEN"),
  retrySafety: z.literal("NOT_PROVEN"),
  sessionRef: CodeBuddyNativeSessionRefSchema,
  stepCompletion: z.literal("not_established"),
  observations: z.array(CandidateObservationSchema).min(1).max(3),
});
export type CodeBuddyCandidateResult = z.infer<typeof CandidateResultSchema>;

const InterruptObservationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("cancel_requested") }),
  z.strictObject({
    kind: z.literal("cancel_response"),
    accepted: z.boolean(),
  }),
]);
const InterruptResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operationId: OperationIdSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  fixtureKind: z.literal("hunter.codebuddy.synthetic_candidate_v1"),
  proofScope: z.literal("contract_only"),
  connectorValidationStatus: z.literal("NOT_PROVEN"),
  retrySafety: z.literal("NOT_PROVEN"),
  structuredInterrupt: z.literal("NOT_PROVEN"),
  sessionTargeting: z.literal("NOT_PROVEN"),
  sessionRef: CodeBuddyNativeSessionRefSchema,
  stepCompletion: z.literal("not_established"),
  observations: z.array(InterruptObservationSchema).length(2),
});
export type CodeBuddyCandidateInterruptResult = z.infer<
  typeof InterruptResultSchema
>;

export interface CodeBuddyCandidateRequest {
  readonly operationId: OperationId;
  readonly profileId: AgentProfileId;
  readonly workspacePath: string;
  readonly prompt: string;
}

export interface CodeBuddyCandidateConnectorOptions {
  readonly pathFlavor: "windows" | "posix";
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function containsControl(
  value: string,
  allowedCodes: ReadonlySet<number> = new Set(),
): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return (
      code !== undefined &&
      ((code <= 31 && !allowedCodes.has(code)) || code === 127)
    );
  });
}

function parsePrompt(value: string): string {
  const parsed = PromptSchema.safeParse(value);
  if (!parsed.success || parsed.data.trim() === "") {
    throw new Error("CODEBUDDY_PROMPT_REQUIRED");
  }
  if (Buffer.byteLength(parsed.data, "utf8") > 16_384) {
    throw new Error("CODEBUDDY_PROMPT_TOO_LARGE");
  }
  if (
    parsed.data.trimStart().startsWith("-") ||
    containsControl(parsed.data, new Set([9, 10, 13]))
  ) {
    throw new Error("CODEBUDDY_PROMPT_UNSAFE");
  }
  return parsed.data;
}

function isFullyQualifiedWindowsPath(value: string): boolean {
  if (/^[A-Za-z]:[\\/]/u.test(value)) return true;
  if (/^\\\\\?\\[A-Za-z]:\\/u.test(value)) return true;
  if (/^\\\\\?\\UNC\\[^\\/]+\\[^\\/]+(?:\\|$)/iu.test(value)) return true;
  return /^\\\\(?![.?]\\)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/u.test(
    value,
  );
}

function hasDotSegment(
  value: string,
  pathFlavor: "windows" | "posix",
): boolean {
  const segments =
    pathFlavor === "windows" ? value.split(/[\\/]/u) : value.split("/");
  return segments.some((segment) => segment === "." || segment === "..");
}

function parseWorkspacePath(
  value: string,
  pathFlavor: "windows" | "posix",
): string {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 4096 ||
    containsControl(value) ||
    hasDotSegment(value, pathFlavor)
  ) {
    throw new Error("CODEBUDDY_WORKSPACE_PATH_INVALID");
  }
  const valid =
    pathFlavor === "windows"
      ? isFullyQualifiedWindowsPath(value)
      : value.startsWith("/") && !value.startsWith("//");
  if (!valid) throw new Error("CODEBUDDY_WORKSPACE_PATH_INVALID");
  return value;
}

function fingerprint(input: {
  readonly mode: "launch" | "resume" | "interrupt";
  readonly operationId: OperationId;
  readonly profileId: AgentProfileId | null;
  readonly workspacePath: string | null;
  readonly prompt: string | null;
  readonly sessionRef: CodeBuddyNativeSessionRef | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        mode: input.mode,
        operationId: input.operationId,
        profileId: input.profileId,
        prompt: input.prompt,
        sessionRef: input.sessionRef,
        workspacePath: input.workspacePath,
      }),
    )
    .digest("hex");
}

/**
 * Contract-only synthetic lifecycle candidate. Labels in its injected
 * transport belong to Hunter's fixture, not to a verified provider protocol.
 */
export class CodeBuddyCandidateConnector {
  private readonly options: CodeBuddyCandidateConnectorOptions;

  constructor(
    private readonly transport: SyntheticCodeBuddyCandidateTransport,
    optionsValue: CodeBuddyCandidateConnectorOptions,
  ) {
    let options: z.ZodSafeParseResult<
      z.infer<typeof CandidateOptionsSchema>
    >;
    try {
      options = CandidateOptionsSchema.safeParse(optionsValue);
    } catch {
      throw new Error("CODEBUDDY_OPTIONS_INVALID");
    }
    if (!options.success) throw new Error("CODEBUDDY_OPTIONS_INVALID");
    this.options = deepFreeze(options.data);
  }

  async launch(
    requestValue: CodeBuddyCandidateRequest,
  ): Promise<CodeBuddyCandidateResult> {
    const request = this.parseRequest(requestValue);
    const initialize = await this.call({
      fixtureKind: "hunter.codebuddy.synthetic_candidate_v1",
      method: "initialize",
      params: { client: "hunter", candidateSchemaVersion: 1 },
    });
    const initializeResponse = this.parseResponse(
      SyntheticCodeBuddyInitializeResponseSchema,
      initialize,
    );
    const created = await this.call({
      fixtureKind: "hunter.codebuddy.synthetic_candidate_v1",
      method: "newSession",
      params: {
        cwd: request.workspacePath,
        profileId: request.profileId,
      },
    });
    const session = this.parseResponse(
      SyntheticCodeBuddyNewSessionResponseSchema,
      created,
    );
    const prompted = await this.promptSession(
      session.sessionId,
      request.operationId,
      request.prompt,
    );
    return this.createResult(
      "launch",
      request,
      session.sessionId,
      [
        {
          kind: "candidate_initialize_observed",
          candidateSchemaVersion: initializeResponse.candidateSchemaVersion,
        },
        { kind: "session_created" },
        { kind: "prompt_response", accepted: prompted.accepted },
      ],
    );
  }

  async resume(
    sessionRefValue: string,
    requestValue: CodeBuddyCandidateRequest,
  ): Promise<CodeBuddyCandidateResult> {
    const sessionRef = this.parseSessionRef(sessionRefValue);
    const request = this.parseRequest(requestValue);
    const prompted = await this.promptSession(
      sessionRef,
      request.operationId,
      request.prompt,
    );
    return this.createResult("resume", request, sessionRef, [
      { kind: "prompt_response", accepted: prompted.accepted },
    ]);
  }

  async interrupt(
    sessionRefValue: string,
    operationIdValue: OperationId,
  ): Promise<CodeBuddyCandidateInterruptResult> {
    const sessionRef = this.parseSessionRef(sessionRefValue);
    let operation: z.ZodSafeParseResult<OperationId>;
    try {
      operation = OperationIdSchema.safeParse(operationIdValue);
    } catch {
      throw new Error("CODEBUDDY_OPERATION_ID_INVALID");
    }
    if (!operation.success) throw new Error("CODEBUDDY_OPERATION_ID_INVALID");
    const responseValue = await this.call({
      fixtureKind: "hunter.codebuddy.synthetic_candidate_v1",
      method: "cancelRun",
      params: { sessionId: sessionRef, runId: operation.data },
    });
    const response = this.parseResponse(
      SyntheticCodeBuddyCancelRunResponseSchema,
      responseValue,
    );
    this.assertResponseIdentity(
      response.sessionId,
      response.runId,
      sessionRef,
      operation.data,
    );
    return deepFreeze(
      InterruptResultSchema.parse({
        schemaVersion: 1,
        operationId: operation.data,
        fingerprint: fingerprint({
          mode: "interrupt",
          operationId: operation.data,
          profileId: null,
          workspacePath: null,
          prompt: null,
          sessionRef,
        }),
        proofScope: "contract_only",
        fixtureKind: "hunter.codebuddy.synthetic_candidate_v1",
        connectorValidationStatus: "NOT_PROVEN",
        retrySafety: "NOT_PROVEN",
        structuredInterrupt: "NOT_PROVEN",
        sessionTargeting: "NOT_PROVEN",
        sessionRef,
        stepCompletion: "not_established",
        observations: [
          { kind: "cancel_requested" },
          { kind: "cancel_response", accepted: response.accepted },
        ],
      }),
    );
  }

  private parseRequest(
    requestValue: CodeBuddyCandidateRequest,
  ): {
    readonly operationId: OperationId;
    readonly profileId: AgentProfileId;
    readonly workspacePath: string;
    readonly prompt: string;
  } {
    let parsed: z.ZodSafeParseResult<
      z.infer<typeof CandidateRequestSchema>
    >;
    try {
      parsed = CandidateRequestSchema.safeParse(requestValue);
    } catch {
      throw new Error("CODEBUDDY_REQUEST_INVALID");
    }
    if (!parsed.success) throw new Error("CODEBUDDY_REQUEST_INVALID");
    return {
      operationId: parsed.data.operationId,
      profileId: parsed.data.profileId,
      workspacePath: parseWorkspacePath(
        parsed.data.workspacePath,
        this.options.pathFlavor,
      ),
      prompt: parsePrompt(parsed.data.prompt),
    };
  }

  private parseSessionRef(value: string): CodeBuddyNativeSessionRef {
    let parsed: z.ZodSafeParseResult<CodeBuddyNativeSessionRef>;
    try {
      parsed = CodeBuddyNativeSessionRefSchema.safeParse(value);
    } catch {
      throw new Error("CODEBUDDY_SESSION_ID_INVALID");
    }
    if (!parsed.success) throw new Error("CODEBUDDY_SESSION_ID_INVALID");
    return parsed.data;
  }

  private async call(
    messageValue: SyntheticCodeBuddyCandidateRequest,
  ): Promise<unknown> {
    const message = deepFreeze(
      SyntheticCodeBuddyCandidateRequestSchema.parse(messageValue),
    );
    try {
      return await this.transport.request(message);
    } catch {
      throw new Error("CODEBUDDY_TRANSPORT_FAILED");
    }
  }

  private parseResponse<T>(
    schema: z.ZodType<T>,
    rawText: unknown,
  ): T {
    const value =
      parseSyntheticCodeBuddyCandidateResponseText(rawText);
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new Error("CODEBUDDY_RESPONSE_INVALID");
    return parsed.data;
  }

  private async promptSession(
    sessionRef: CodeBuddyNativeSessionRef,
    operationId: OperationId,
    prompt: string,
  ): Promise<z.infer<typeof SyntheticCodeBuddyPromptResponseSchema>> {
    const responseValue = await this.call({
      fixtureKind: "hunter.codebuddy.synthetic_candidate_v1",
      method: "prompt",
      params: {
        sessionId: sessionRef,
        runId: operationId,
        prompt,
      },
    });
    const response = this.parseResponse(
      SyntheticCodeBuddyPromptResponseSchema,
      responseValue,
    );
    this.assertResponseIdentity(
      response.sessionId,
      response.runId,
      sessionRef,
      operationId,
    );
    return response;
  }

  private assertResponseIdentity(
    responseSession: CodeBuddyNativeSessionRef,
    responseOperation: OperationId,
    expectedSession: CodeBuddyNativeSessionRef,
    expectedOperation: OperationId,
  ): void {
    if (
      responseSession !== expectedSession ||
      responseOperation !== expectedOperation
    ) {
      throw new Error("CODEBUDDY_RESPONSE_IDENTITY_MISMATCH");
    }
  }

  private createResult(
    mode: "launch" | "resume",
    request: {
      readonly operationId: OperationId;
      readonly profileId: AgentProfileId;
      readonly workspacePath: string;
      readonly prompt: string;
    },
    sessionRef: CodeBuddyNativeSessionRef,
    observations: readonly z.infer<typeof CandidateObservationSchema>[],
  ): CodeBuddyCandidateResult {
    return deepFreeze(
      CandidateResultSchema.parse({
        schemaVersion: 1,
        operationId: request.operationId,
        fingerprint: fingerprint({
          mode,
          operationId: request.operationId,
          profileId: request.profileId,
          workspacePath: request.workspacePath,
          prompt: request.prompt,
          sessionRef: mode === "resume" ? sessionRef : null,
        }),
        mode,
        fixtureKind: "hunter.codebuddy.synthetic_candidate_v1",
        proofScope: "contract_only",
        connectorValidationStatus: "NOT_PROVEN",
        retrySafety: "NOT_PROVEN",
        sessionRef,
        stepCompletion: "not_established",
        observations,
      }),
    );
  }
}
