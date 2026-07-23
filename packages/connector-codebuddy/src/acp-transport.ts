import {
  AgentProfileIdSchema,
  OperationIdSchema,
} from "@hunter/domain";
import { z } from "zod";

export const ACP_LIMITS = Object.freeze({
  maxResponseBytes: 64 * 1024,
  maxStringBytes: 16 * 1024,
  maxDepth: 8,
  maxObjectKeys: 64,
  maxArrayItems: 64,
});

export const CodeBuddyNativeSessionRefSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u,
    "CODEBUDDY_SESSION_ID_INVALID",
  )
  .brand<"CodeBuddyNativeSessionRef">();
export type CodeBuddyNativeSessionRef = z.infer<
  typeof CodeBuddyNativeSessionRefSchema
>;

const InitializeRequestSchema = z.strictObject({
  method: z.literal("initialize"),
  params: z.strictObject({
    client: z.literal("hunter"),
    protocolVersion: z.literal(1),
  }),
});

const NewSessionRequestSchema = z.strictObject({
  method: z.literal("newSession"),
  params: z.strictObject({
    cwd: z.string().min(1).max(4096),
    profileId: AgentProfileIdSchema,
  }),
});

const PromptRequestSchema = z.strictObject({
  method: z.literal("prompt"),
  params: z.strictObject({
    sessionId: CodeBuddyNativeSessionRefSchema,
    runId: OperationIdSchema,
    prompt: z.string().min(1).max(16_384),
  }),
});

const CancelRunRequestSchema = z.strictObject({
  method: z.literal("cancelRun"),
  params: z.strictObject({
    sessionId: CodeBuddyNativeSessionRefSchema,
    runId: OperationIdSchema,
  }),
});

export const AcpRequestSchema = z.discriminatedUnion("method", [
  InitializeRequestSchema,
  NewSessionRequestSchema,
  PromptRequestSchema,
  CancelRunRequestSchema,
]);
export type AcpRequest = z.infer<typeof AcpRequestSchema>;

export const InitializeResponseSchema = z.strictObject({
  protocolVersion: z.literal(1),
});
export const NewSessionResponseSchema = z.strictObject({
  sessionId: CodeBuddyNativeSessionRefSchema,
});
export const PromptResponseSchema = z.strictObject({
  accepted: z.boolean(),
  sessionId: CodeBuddyNativeSessionRefSchema,
  runId: OperationIdSchema,
});
export const CancelRunResponseSchema = z.strictObject({
  accepted: z.boolean(),
  sessionId: CodeBuddyNativeSessionRefSchema,
  runId: OperationIdSchema,
});

export interface AcpTransport {
  request(message: AcpRequest): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertBoundedValue(
  value: unknown,
  depth = 0,
  ancestors: ReadonlySet<object> = new Set(),
): void {
  if (depth > ACP_LIMITS.maxDepth) {
    throw new Error("CODEBUDDY_RESPONSE_TOO_LARGE");
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > ACP_LIMITS.maxStringBytes) {
      throw new Error("CODEBUDDY_RESPONSE_TOO_LARGE");
    }
    return;
  }
  if (Array.isArray(value)) {
    if (
      ancestors.has(value) ||
      value.length > ACP_LIMITS.maxArrayItems
    ) {
      throw new Error("CODEBUDDY_RESPONSE_TOO_LARGE");
    }
    const nextAncestors = new Set(ancestors).add(value);
    for (const item of value) {
      assertBoundedValue(item, depth + 1, nextAncestors);
    }
    return;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (
      ancestors.has(value) ||
      entries.length > ACP_LIMITS.maxObjectKeys
    ) {
      throw new Error("CODEBUDDY_RESPONSE_TOO_LARGE");
    }
    const nextAncestors = new Set(ancestors).add(value);
    for (const [key, item] of entries) {
      if (Buffer.byteLength(key, "utf8") > ACP_LIMITS.maxStringBytes) {
        throw new Error("CODEBUDDY_RESPONSE_TOO_LARGE");
      }
      assertBoundedValue(item, depth + 1, nextAncestors);
    }
  }
}

export function assertBoundedAcpResponse(value: unknown): void {
  assertBoundedValue(value);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("CODEBUDDY_RESPONSE_INVALID");
  }
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, "utf8") > ACP_LIMITS.maxResponseBytes
  ) {
    throw new Error("CODEBUDDY_RESPONSE_TOO_LARGE");
  }
}
