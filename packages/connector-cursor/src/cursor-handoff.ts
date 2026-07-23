import { createHash } from "node:crypto";
import {
  AgentProfileIdSchema,
  OperationIdSchema,
  WorkspaceIdSchema,
  type AgentProfileId,
  type OperationId,
  type WorkspaceId,
} from "@hunter/domain";
import { z } from "zod";
import {
  CURSOR_TASK_PACK_LIMITS,
  renderTaskPack,
  type CursorTaskPackInput,
} from "./task-pack.js";

export const CURSOR_SYNTHETIC_LIMITS = Object.freeze({
  maxResponseBytes: 64 * 1024,
  maxStringBytes: 16 * 1024,
  maxDepth: 8,
  maxObjectKeys: 64,
  maxArrayItems: 64,
  maxNodes: 2048,
});

const FIXTURE_KIND = "hunter.cursor.synthetic_handoff_v1" as const;

const CandidateOptionsSchema = z.strictObject({
  candidateSchemaVersion: z.literal(1),
});

const CandidateRequestSchema = z.strictObject({
  operationId: OperationIdSchema,
  profileId: AgentProfileIdSchema,
  workspaceId: WorkspaceIdSchema,
  prompt: z.string(),
});

const RelativeTaskPackPathSchema = z
  .string()
  .regex(/^\.hunter\/handoffs\/opn_[a-z0-9][a-z0-9_-]{7,63}\.md$/u);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

const WriteTaskPackRequestSchema = z.strictObject({
  fixtureKind: z.literal(FIXTURE_KIND),
  method: z.literal("writeTaskPack"),
  params: z.strictObject({
    operationId: OperationIdSchema,
    workspaceId: WorkspaceIdSchema,
    relativePath: RelativeTaskPackPathSchema,
    content: z
      .string()
      .min(1)
      .refine(
        (value) =>
          Buffer.byteLength(value, "utf8") <=
          CURSOR_TASK_PACK_LIMITS.maxContentBytes,
      ),
    contentDigest: DigestSchema,
  }),
});

const OpenWorkspaceRequestSchema = z.strictObject({
  fixtureKind: z.literal(FIXTURE_KIND),
  method: z.literal("openWorkspace"),
  params: z.strictObject({
    operationId: OperationIdSchema,
    workspaceId: WorkspaceIdSchema,
  }),
});

export const SyntheticCursorHandoffRequestSchema = z.discriminatedUnion(
  "method",
  [WriteTaskPackRequestSchema, OpenWorkspaceRequestSchema],
);
export type SyntheticCursorHandoffRequest = z.infer<
  typeof SyntheticCursorHandoffRequestSchema
>;

const WriteTaskPackResponseSchema = z.strictObject({
  accepted: z.boolean(),
  operationId: OperationIdSchema,
  contentDigest: DigestSchema,
});

const OpenWorkspaceResponseSchema = z.strictObject({
  opened: z.boolean(),
  operationId: OperationIdSchema,
});

const CandidateObservationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("task_pack_write_response"),
    accepted: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("native_surface_open_response"),
    opened: z.boolean(),
  }),
]);

const CandidateResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operationId: OperationIdSchema,
  fingerprint: DigestSchema,
  fixtureKind: z.literal(FIXTURE_KIND),
  proofScope: z.literal("contract_only"),
  connectorValidationStatus: z.literal("NOT_PROVEN"),
  retrySafety: z.literal("NOT_PROVEN"),
  status: z.enum(["waiting_input", "needs_attention"]),
  completionSource: z.literal("manual_receipt"),
  manualReceiptRequiresVerifier: z.literal(true),
  stepCompletion: z.literal("not_established"),
  taskPackIntent: z.strictObject({
    relativePath: RelativeTaskPackPathSchema,
    contentDigest: DigestSchema,
  }),
  observations: z.array(CandidateObservationSchema).min(1).max(2),
});

export type CursorHandoffCandidateResult = z.infer<
  typeof CandidateResultSchema
>;

export interface SyntheticCursorHandoffTransport {
  /**
   * Hunter-owned fixture transport. It does not represent a Cursor protocol,
   * executable, login, workspace observer, or native-window capability.
   */
  request(message: SyntheticCursorHandoffRequest): Promise<string>;
}

export interface CursorHandoffCandidateOptions {
  readonly candidateSchemaVersion: 1;
}

export interface CursorHandoffCandidateRequest {
  readonly operationId: OperationId;
  readonly profileId: AgentProfileId;
  readonly workspaceId: WorkspaceId;
  readonly prompt: string;
}

type FrozenOptions = z.infer<typeof CandidateOptionsSchema>;
type ParsedRequest = z.infer<typeof CandidateRequestSchema>;
type TransportRequest = (
  message: SyntheticCursorHandoffRequest,
) => Promise<string>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertBoundedResponse(
  value: unknown,
  budget: { count: number },
  depth = 0,
): void {
  budget.count += 1;
  if (
    budget.count > CURSOR_SYNTHETIC_LIMITS.maxNodes ||
    depth > CURSOR_SYNTHETIC_LIMITS.maxDepth
  ) {
    throw new Error("CURSOR_RESPONSE_TOO_LARGE");
  }
  if (typeof value === "string") {
    if (
      Buffer.byteLength(value, "utf8") >
      CURSOR_SYNTHETIC_LIMITS.maxStringBytes
    ) {
      throw new Error("CURSOR_RESPONSE_TOO_LARGE");
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > CURSOR_SYNTHETIC_LIMITS.maxArrayItems) {
      throw new Error("CURSOR_RESPONSE_TOO_LARGE");
    }
    for (const item of value) {
      assertBoundedResponse(item, budget, depth + 1);
    }
    return;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > CURSOR_SYNTHETIC_LIMITS.maxObjectKeys) {
      throw new Error("CURSOR_RESPONSE_TOO_LARGE");
    }
    for (const [key, item] of entries) {
      if (
        Buffer.byteLength(key, "utf8") >
        CURSOR_SYNTHETIC_LIMITS.maxStringBytes
      ) {
        throw new Error("CURSOR_RESPONSE_TOO_LARGE");
      }
      assertBoundedResponse(item, budget, depth + 1);
    }
  }
}

function parseResponseText(rawText: unknown): unknown {
  if (typeof rawText !== "string") {
    throw new Error("CURSOR_RESPONSE_INVALID");
  }
  if (
    Buffer.byteLength(rawText, "utf8") >
    CURSOR_SYNTHETIC_LIMITS.maxResponseBytes
  ) {
    throw new Error("CURSOR_RESPONSE_TOO_LARGE");
  }
  let value: unknown;
  try {
    value = JSON.parse(rawText) as unknown;
  } catch {
    throw new Error("CURSOR_RESPONSE_INVALID");
  }
  assertBoundedResponse(value, { count: 0 });
  return value;
}

function parseOptions(
  value: CursorHandoffCandidateOptions,
): FrozenOptions {
  let parsed: z.ZodSafeParseResult<FrozenOptions>;
  try {
    parsed = CandidateOptionsSchema.safeParse(value);
  } catch {
    throw new Error("CURSOR_OPTIONS_INVALID");
  }
  if (!parsed.success) throw new Error("CURSOR_OPTIONS_INVALID");
  return deepFreeze(parsed.data);
}

function parseCandidateRequest(
  value: CursorHandoffCandidateRequest,
): ParsedRequest {
  let parsed: z.ZodSafeParseResult<ParsedRequest>;
  try {
    parsed = CandidateRequestSchema.safeParse(value);
  } catch {
    throw new Error("CURSOR_REQUEST_INVALID");
  }
  if (!parsed.success) throw new Error("CURSOR_REQUEST_INVALID");
  try {
    renderTaskPack(parsed.data);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "CURSOR_TASK_PACK_INPUT_TOO_LARGE"
    ) {
      throw new Error("CURSOR_REQUEST_TOO_LARGE");
    }
    if (
      error instanceof Error &&
      error.message === "CURSOR_TASK_PACK_INPUT_UNSAFE"
    ) {
      throw new Error("CURSOR_REQUEST_UNSAFE");
    }
    throw new Error("CURSOR_REQUEST_INVALID");
  }
  return parsed.data;
}

function requestFingerprint(input: ParsedRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        fixtureKind: FIXTURE_KIND,
        operationId: input.operationId,
        profileId: input.profileId,
        prompt: input.prompt,
        workspaceId: input.workspaceId,
      }),
      "utf8",
    )
    .digest("hex");
}

/**
 * Contract-only Cursor handoff fixture. Real Cursor discovery, authentication,
 * workspace opening, and observation all remain NOT_PROVEN.
 */
export class CursorHandoffCandidate {
  private readonly options: FrozenOptions;
  private readonly requestTransport: TransportRequest;

  constructor(
    transport: SyntheticCursorHandoffTransport,
    optionsValue: CursorHandoffCandidateOptions,
  ) {
    this.options = parseOptions(optionsValue);
    try {
      const request = transport.request;
      if (typeof request !== "function") {
        throw new Error("invalid transport");
      }
      this.requestTransport = (message) => request.call(transport, message);
    } catch {
      throw new Error("CURSOR_TRANSPORT_INVALID");
    }
  }

  async launch(
    requestValue: CursorHandoffCandidateRequest,
  ): Promise<CursorHandoffCandidateResult> {
    const request = parseCandidateRequest(requestValue);
    const taskPack = renderTaskPack(request as CursorTaskPackInput);
    const writeValue = await this.call({
      fixtureKind: FIXTURE_KIND,
      method: "writeTaskPack",
      params: {
        operationId: request.operationId,
        workspaceId: request.workspaceId,
        relativePath: taskPack.relativePath,
        content: taskPack.content,
        contentDigest: taskPack.contentDigest,
      },
    });
    const writeResponse = this.parseResponse(
      WriteTaskPackResponseSchema,
      writeValue,
    );
    if (
      writeResponse.operationId !== request.operationId ||
      writeResponse.contentDigest !== taskPack.contentDigest
    ) {
      throw new Error("CURSOR_RESPONSE_IDENTITY_MISMATCH");
    }

    const observations: z.infer<typeof CandidateObservationSchema>[] = [
      {
        kind: "task_pack_write_response",
        accepted: writeResponse.accepted,
      },
    ];
    let opened = false;
    if (writeResponse.accepted) {
      const openValue = await this.call({
        fixtureKind: FIXTURE_KIND,
        method: "openWorkspace",
        params: {
          operationId: request.operationId,
          workspaceId: request.workspaceId,
        },
      });
      const openResponse = this.parseResponse(
        OpenWorkspaceResponseSchema,
        openValue,
      );
      if (openResponse.operationId !== request.operationId) {
        throw new Error("CURSOR_RESPONSE_IDENTITY_MISMATCH");
      }
      opened = openResponse.opened;
      observations.push({
        kind: "native_surface_open_response",
        opened,
      });
    }

    return deepFreeze(
      CandidateResultSchema.parse({
        schemaVersion: this.options.candidateSchemaVersion,
        operationId: request.operationId,
        fingerprint: requestFingerprint(request),
        fixtureKind: FIXTURE_KIND,
        proofScope: "contract_only",
        connectorValidationStatus: "NOT_PROVEN",
        retrySafety: "NOT_PROVEN",
        status:
          writeResponse.accepted && opened
            ? "waiting_input"
            : "needs_attention",
        completionSource: "manual_receipt",
        manualReceiptRequiresVerifier: true,
        stepCompletion: "not_established",
        taskPackIntent: {
          relativePath: taskPack.relativePath,
          contentDigest: taskPack.contentDigest,
        },
        observations,
      }),
    );
  }

  private async call(value: unknown): Promise<unknown> {
    let parsed: z.ZodSafeParseResult<SyntheticCursorHandoffRequest>;
    try {
      parsed = SyntheticCursorHandoffRequestSchema.safeParse(value);
    } catch {
      throw new Error("CURSOR_SYNTHETIC_REQUEST_INVALID");
    }
    if (!parsed.success) {
      throw new Error("CURSOR_SYNTHETIC_REQUEST_INVALID");
    }
    const message = deepFreeze(parsed.data);
    try {
      return await this.requestTransport(message);
    } catch {
      throw new Error("CURSOR_SYNTHETIC_TRANSPORT_FAILED");
    }
  }

  private parseResponse<T>(schema: z.ZodType<T>, rawText: unknown): T {
    const value = parseResponseText(rawText);
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new Error("CURSOR_RESPONSE_INVALID");
    return parsed.data;
  }
}
