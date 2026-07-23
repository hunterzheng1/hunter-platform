import { createHash } from "node:crypto";
import {
  ConnectorIdSchema,
  EvidenceIdSchema,
  NativeSessionIdSchema,
  OperationIdSchema,
  type OperationId,
} from "@hunter/domain";
import { z } from "zod";
import {
  CapabilityProbeReceiptSchema,
  ExternalOperationSchema,
  capabilityManifestSupportsOperation,
  computeCapabilityManifest,
  parseBoundedProviderObject,
  type CapabilityManifest,
  type CapabilityProbeReceipt,
  type ExternalOperation,
  type ExternalOperationHandler,
  type ExternalOperationReceipt,
  type ExternalOperationReconciliation,
  type ExternalOperationReconciler,
} from "@hunter/runtime-contracts";
import {
  CODEX_EVENT_LIMITS,
  CodexCandidateObservationSchema,
  CodexNativeSessionRefSchema,
  ParsedCodexEventStreamSchema,
  parseCodexEventLines,
  type CodexNativeSessionRef,
} from "./codex-events.js";

const PromptSchema = z
  .string()
  .min(1)
  .max(16_384);

const CandidateRequestSchema = z.strictObject({
  operationId: OperationIdSchema,
  workspacePath: z.string(),
  prompt: z.string(),
});

const CandidateOptionsSchema = z.strictObject({
  pathFlavor: z.enum(["windows", "posix"]),
});

const TransportObservationSchema = z.strictObject({
  lines: z.array(z.string()).max(CODEX_EVENT_LIMITS.maxEvents),
  exitCode: z.number().int().nullable(),
});

const CandidateResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operationId: OperationIdSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  proofScope: z.literal("contract_only"),
  connectorValidationStatus: z.literal("NOT_PROVEN"),
  retrySafety: z.literal("NOT_PROVEN"),
  sessionRef: CodexNativeSessionRefSchema,
  terminalOutcome: ParsedCodexEventStreamSchema.shape.terminalOutcome,
  stepCompletion: z.literal("not_established"),
  observations: z.array(CodexCandidateObservationSchema),
});
export type CodexCandidateResult = z.infer<typeof CandidateResultSchema>;

const InterruptResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operationId: OperationIdSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  sessionRef: CodexNativeSessionRefSchema,
  proofScope: z.literal("contract_only"),
  connectorValidationStatus: z.literal("NOT_PROVEN"),
  retrySafety: z.literal("NOT_PROVEN"),
  structuredInterrupt: z.literal("NOT_PROVEN"),
  sessionTargeting: z.literal("NOT_PROVEN"),
  stepCompletion: z.literal("not_established"),
  observation: z.strictObject({ kind: z.literal("process_cancel_requested") }),
});
export type CodexCandidateInterruptResult = z.infer<typeof InterruptResultSchema>;

export interface CodexCandidateTransport {
  execute(
    args: readonly string[],
    cwd: string,
  ): Promise<{
    readonly lines: readonly string[];
    readonly exitCode: number | null;
  }>;
  cancel(operationId: OperationId): Promise<void>;
}

export interface CodexCandidateRequest {
  readonly operationId: OperationId;
  readonly workspacePath: string;
  readonly prompt: string;
}

export interface CodexCandidateConnectorOptions {
  readonly pathFlavor: "windows" | "posix";
}

function containsControl(
  value: string,
  allowedCodes: ReadonlySet<number> = new Set(),
): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && ((code <= 31 && !allowedCodes.has(code)) || code === 127);
  });
}

function parsePrompt(value: string): string {
  const parsed = PromptSchema.safeParse(value);
  if (!parsed.success || parsed.data.trim() === "") {
    throw new Error("CODEX_PROMPT_REQUIRED");
  }
  if (Buffer.byteLength(parsed.data, "utf8") > 16_384) {
    throw new Error("CODEX_PROMPT_TOO_LARGE");
  }
  if (
    parsed.data.trimStart().startsWith("-") ||
    containsControl(parsed.data, new Set([9, 10, 13]))
  ) {
    throw new Error("CODEX_PROMPT_UNSAFE");
  }
  return parsed.data;
}

function isFullyQualifiedWindowsPath(value: string): boolean {
  if (/^[A-Za-z]:[\\/]/u.test(value)) return true;
  if (/^\\\\\?\\[A-Za-z]:\\/u.test(value)) return true;
  if (/^\\\\\?\\UNC\\[^\\/]+\\[^\\/]+(?:\\|$)/iu.test(value)) return true;
  return /^\\\\(?![.?]\\)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/u.test(value);
}

function hasDotSegment(value: string, pathFlavor: "windows" | "posix"): boolean {
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
    throw new Error("CODEX_WORKSPACE_PATH_INVALID");
  }
  const valid =
    pathFlavor === "windows"
      ? isFullyQualifiedWindowsPath(value)
      : value.startsWith("/") && !value.startsWith("//");
  if (!valid) throw new Error("CODEX_WORKSPACE_PATH_INVALID");
  return value;
}

function fingerprint(input: {
  readonly mode: "launch" | "resume";
  readonly operationId: OperationId;
  readonly workspacePath: string;
  readonly prompt: string;
  readonly sessionRef: CodexNativeSessionRef | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        mode: input.mode,
        operationId: input.operationId,
        prompt: input.prompt,
        sessionRef: input.sessionRef,
        workspacePath: input.workspacePath,
      }),
    )
    .digest("hex");
}

function interruptFingerprint(
  operationId: OperationId,
  sessionRef: CodexNativeSessionRef,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ mode: "interrupt", operationId, sessionRef }))
    .digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Contract-only candidate for the audited Codex CLI 0.144.6 fixture surface.
 *
 * It intentionally is not a runtime-contracts Connector, operation handler,
 * production transport, capability manifest, or durable receipt. Task 14 owns
 * durable dispatch/recovery and Task 15 owns real probes and capability levels.
 */
export class CodexCandidateConnector {
  private readonly options: CodexCandidateConnectorOptions;

  constructor(
    private readonly transport: CodexCandidateTransport,
    optionsValue: CodexCandidateConnectorOptions,
  ) {
    const parsedOptions = CandidateOptionsSchema.safeParse(optionsValue);
    if (!parsedOptions.success) throw new Error("CODEX_OPTIONS_INVALID");
    this.options = parsedOptions.data;
  }

  async launch(request: CodexCandidateRequest): Promise<CodexCandidateResult> {
    return this.run("launch", null, request);
  }

  async resume(
    sessionRefValue: string,
    request: CodexCandidateRequest,
  ): Promise<CodexCandidateResult> {
    const parsedSession = CodexNativeSessionRefSchema.safeParse(sessionRefValue);
    if (!parsedSession.success) throw new Error("CODEX_SESSION_ID_INVALID");
    return this.run("resume", parsedSession.data, request);
  }

  async interrupt(
    sessionRefValue: string,
    operationIdValue: OperationId,
  ): Promise<CodexCandidateInterruptResult> {
    const parsedSession = CodexNativeSessionRefSchema.safeParse(sessionRefValue);
    if (!parsedSession.success) throw new Error("CODEX_SESSION_ID_INVALID");
    const operationId = OperationIdSchema.parse(operationIdValue);
    try {
      await this.transport.cancel(operationId);
    } catch {
      throw new Error("CODEX_TRANSPORT_FAILED");
    }
    return deepFreeze(
      InterruptResultSchema.parse({
        schemaVersion: 1,
        operationId,
        fingerprint: interruptFingerprint(operationId, parsedSession.data),
        sessionRef: parsedSession.data,
        proofScope: "contract_only",
        connectorValidationStatus: "NOT_PROVEN",
        retrySafety: "NOT_PROVEN",
        structuredInterrupt: "NOT_PROVEN",
        sessionTargeting: "NOT_PROVEN",
        stepCompletion: "not_established",
        observation: { kind: "process_cancel_requested" },
      }),
    );
  }

  private async run(
    mode: "launch" | "resume",
    sessionRef: CodexNativeSessionRef | null,
    requestValue: CodexCandidateRequest,
  ): Promise<CodexCandidateResult> {
    const parsedRequest = CandidateRequestSchema.safeParse(requestValue);
    if (!parsedRequest.success) throw new Error("CODEX_REQUEST_INVALID");
    const operationId = parsedRequest.data.operationId;
    const workspacePath = parseWorkspacePath(
      parsedRequest.data.workspacePath,
      this.options.pathFlavor,
    );
    const prompt = parsePrompt(parsedRequest.data.prompt);
    const args = ["exec", "--json", "--sandbox", "read-only"];
    if (mode === "resume") args.push("resume", sessionRef as CodexNativeSessionRef);
    args.push(prompt);

    let transportValue: unknown;
    try {
      transportValue = await this.transport.execute(args, workspacePath);
    } catch {
      throw new Error("CODEX_TRANSPORT_FAILED");
    }
    const parsedTransport = TransportObservationSchema.safeParse(transportValue);
    if (!parsedTransport.success) {
      throw new Error("CODEX_TRANSPORT_RESPONSE_INVALID");
    }
    const transportObservation = parsedTransport.data;
    const eventStream = parseCodexEventLines(transportObservation.lines);
    if (sessionRef !== null && eventStream.sessionRef !== sessionRef) {
      throw new Error("CODEX_RESUME_SESSION_MISMATCH");
    }

    const inputFingerprint = fingerprint({
      mode,
      operationId,
      workspacePath,
      prompt,
      sessionRef,
    });
    return deepFreeze(
      CandidateResultSchema.parse({
        schemaVersion: 1,
        operationId,
        fingerprint: inputFingerprint,
        proofScope: "contract_only",
        connectorValidationStatus: "NOT_PROVEN",
        retrySafety: "NOT_PROVEN",
        sessionRef: eventStream.sessionRef,
        terminalOutcome: eventStream.terminalOutcome,
        stepCompletion: "not_established",
        observations: [
          ...eventStream.observations,
          { kind: "process_exited", exitCode: transportObservation.exitCode },
        ],
      }),
    );
  }
}

const CodexOperationObservationSchema = z.strictObject({
  operationId: OperationIdSchema,
  nativeSessionId: NativeSessionIdSchema,
  state: z.enum(["created", "running", "waiting_input", "returned", "unknown"]),
  evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type CodexOperationObservation = z.infer<
  typeof CodexOperationObservationSchema
>;

const CodexOperationReconcileResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("attached"),
    observation: CodexOperationObservationSchema,
  }),
  z.strictObject({ outcome: z.literal("confirmed_absent") }),
  z.strictObject({ outcome: z.literal("unknown") }),
]);

export interface CodexOperationTransport {
  execute(operation: ExternalOperation): Promise<unknown>;
  reconcile(operation: ExternalOperation): Promise<unknown>;
}

function receiptEvidenceId(operation: ExternalOperation): ReturnType<typeof EvidenceIdSchema.parse> {
  return EvidenceIdSchema.parse(
    `evd_${createHash("sha256").update(`codex:${operation.operationId}`).digest("hex").slice(0, 24)}`,
  );
}

export class CodexConnector
  implements ExternalOperationHandler, ExternalOperationReconciler
{
  readonly connectorId = ConnectorIdSchema.parse("con_codex_direct");
  private readonly selectedReceipt: CapabilityProbeReceipt;

  constructor(
    private readonly operationTransport: CodexOperationTransport,
    receiptInput: unknown,
    private readonly now: () => Date = () => new Date(),
  ) {
    let receipt: z.ZodSafeParseResult<CapabilityProbeReceipt>;
    try {
      receipt = CapabilityProbeReceiptSchema.safeParse(receiptInput);
    } catch {
      throw new Error("CODEX_PROBE_RECEIPT_MISMATCH");
    }
    if (
      !receipt.success
      || receipt.data.schemaVersion !== 2
      || receipt.data.subject.kind !== "connector"
      || receipt.data.subject.connectorId !== this.connectorId
    ) {
      throw new Error("CODEX_PROBE_RECEIPT_MISMATCH");
    }
    this.selectedReceipt = deepFreeze(receipt.data);
  }

  get manifest(): CapabilityManifest {
    return computeCapabilityManifest(this.selectedReceipt, this.now());
  }

  async probe(): Promise<CapabilityProbeReceipt> {
    return this.selectedReceipt;
  }

  async execute(input: ExternalOperation): Promise<ExternalOperationReceipt> {
    const operation = ExternalOperationSchema.parse(input);
    this.assertOperationSupported(operation);
    let raw: unknown;
    try {
      raw = await this.operationTransport.execute(operation);
    } catch {
      throw new Error("CODEX_TRANSPORT_FAILED");
    }
    let observation: CodexOperationObservation;
    try {
      observation = parseBoundedProviderObject(
        CodexOperationObservationSchema,
        raw,
      );
    } catch {
      throw new Error("CODEX_TRANSPORT_RESPONSE_INVALID");
    }
    return this.receiptFor(operation, observation);
  }

  async reconcile(
    input: ExternalOperation,
  ): Promise<ExternalOperationReconciliation> {
    const operation = ExternalOperationSchema.parse(input);
    this.assertOperationSupported(operation);
    let raw: unknown;
    try {
      raw = await this.operationTransport.reconcile(operation);
    } catch {
      return { outcome: "unknown" };
    }
    let result: z.infer<typeof CodexOperationReconcileResultSchema>;
    try {
      result = parseBoundedProviderObject(
        CodexOperationReconcileResultSchema,
        raw,
      );
    } catch {
      return { outcome: "unknown" };
    }
    if (result.outcome !== "attached") return result;
    return {
      outcome: "attached",
      receipt: this.receiptFor(operation, result.observation),
    };
  }

  private assertOperationSupported(operation: ExternalOperation): void {
    if (
      ![
        "session.launch",
        "session.send",
        "session.resume",
        "session.interrupt",
      ].includes(operation.operationType)
    ) {
      throw new Error("CODEX_OPERATION_UNSUPPORTED");
    }
    if (!capabilityManifestSupportsOperation(this.manifest, operation)) {
      throw new Error("CODEX_CAPABILITY_NOT_PROVEN");
    }
  }

  private receiptFor(
    operation: ExternalOperation,
    observation: CodexOperationObservation,
  ): ExternalOperationReceipt {
    if (observation.operationId !== operation.operationId) {
      throw new Error("CODEX_RESPONSE_IDENTITY_MISMATCH");
    }
    if (
      operation.operationType !== "session.launch"
      && "nativeSessionId" in operation.payload
      && operation.payload.nativeSessionId !== observation.nativeSessionId
    ) {
      throw new Error("CODEX_RESPONSE_IDENTITY_MISMATCH");
    }
    return {
      schemaVersion: 1,
      operationId: operation.operationId,
      fingerprint: operation.fingerprint,
      operationStatus: "completed",
      subject: {
        kind: "connector",
        connectorId: this.connectorId,
        implementationVersion: this.selectedReceipt.subject.implementationVersion,
      },
      nativeReferences: [{
        kind: "session",
        referenceId: observation.nativeSessionId,
      }],
      facts: [
        { kind: "operation_accepted" },
        { kind: "session_observed", state: observation.state },
      ],
      evidence: {
        evidenceId: receiptEvidenceId(operation),
        evidenceHash: observation.evidenceDigest,
        proofScope: "local_observation",
      },
      observedAt: this.now().toISOString(),
    };
  }
}
