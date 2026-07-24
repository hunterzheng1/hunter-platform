import {
  AgentProfileIdSchema,
  OperationIdSchema,
} from "@hunter/domain";
import { z } from "zod";

export const SYNTHETIC_CODEBUDDY_LIMITS = Object.freeze({
  maxResponseBytes: 64 * 1024,
  maxStringBytes: 16 * 1024,
  maxDepth: 8,
  maxObjectKeys: 64,
  maxArrayItems: 64,
  maxNodes: 2048,
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
  fixtureKind: z.literal("hunter.codebuddy.synthetic_candidate_v1"),
  method: z.literal("initialize"),
  params: z.strictObject({
    client: z.literal("hunter"),
    candidateSchemaVersion: z.literal(1),
  }),
});

const NewSessionRequestSchema = z.strictObject({
  fixtureKind: z.literal("hunter.codebuddy.synthetic_candidate_v1"),
  method: z.literal("newSession"),
  params: z.strictObject({
    cwd: z.string().min(1).max(4096),
    profileId: AgentProfileIdSchema,
  }),
});

const PromptRequestSchema = z.strictObject({
  fixtureKind: z.literal("hunter.codebuddy.synthetic_candidate_v1"),
  method: z.literal("prompt"),
  params: z.strictObject({
    sessionId: CodeBuddyNativeSessionRefSchema,
    runId: OperationIdSchema,
    prompt: z.string().min(1).max(16_384),
  }),
});

const CancelRunRequestSchema = z.strictObject({
  fixtureKind: z.literal("hunter.codebuddy.synthetic_candidate_v1"),
  method: z.literal("cancelRun"),
  params: z.strictObject({
    sessionId: CodeBuddyNativeSessionRefSchema,
    runId: OperationIdSchema,
  }),
});

export const SyntheticCodeBuddyCandidateRequestSchema = z.discriminatedUnion("method", [
  InitializeRequestSchema,
  NewSessionRequestSchema,
  PromptRequestSchema,
  CancelRunRequestSchema,
]);
export type SyntheticCodeBuddyCandidateRequest = z.infer<
  typeof SyntheticCodeBuddyCandidateRequestSchema
>;

export const SyntheticCodeBuddyInitializeResponseSchema = z.strictObject({
  candidateSchemaVersion: z.literal(1),
});
export const SyntheticCodeBuddyNewSessionResponseSchema = z.strictObject({
  sessionId: CodeBuddyNativeSessionRefSchema,
});
export const SyntheticCodeBuddyPromptResponseSchema = z.strictObject({
  accepted: z.boolean(),
  sessionId: CodeBuddyNativeSessionRefSchema,
  runId: OperationIdSchema,
});
export const SyntheticCodeBuddyCancelRunResponseSchema = z.strictObject({
  accepted: z.boolean(),
  sessionId: CodeBuddyNativeSessionRefSchema,
  runId: OperationIdSchema,
});

/**
 * Hunter-owned synthetic lifecycle fixture. Method labels exercise connector
 * behavior only; they are not a claim about a CodeBuddy wire protocol.
 */
export interface SyntheticCodeBuddyCandidateTransport {
  request(message: SyntheticCodeBuddyCandidateRequest): Promise<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertBoundedValue(
  value: unknown,
  budget: { count: number },
  depth = 0,
): void {
  budget.count += 1;
  if (budget.count > SYNTHETIC_CODEBUDDY_LIMITS.maxNodes) {
    throw new Error("CODEBUDDY_RESPONSE_TOO_LARGE");
  }
  if (depth > SYNTHETIC_CODEBUDDY_LIMITS.maxDepth) {
    throw new Error("CODEBUDDY_RESPONSE_TOO_LARGE");
  }
  if (typeof value === "string") {
    if (
      Buffer.byteLength(value, "utf8") >
      SYNTHETIC_CODEBUDDY_LIMITS.maxStringBytes
    ) {
      throw new Error("CODEBUDDY_RESPONSE_TOO_LARGE");
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > SYNTHETIC_CODEBUDDY_LIMITS.maxArrayItems) {
      throw new Error("CODEBUDDY_RESPONSE_TOO_LARGE");
    }
    for (const item of value) {
      assertBoundedValue(item, budget, depth + 1);
    }
    return;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > SYNTHETIC_CODEBUDDY_LIMITS.maxObjectKeys) {
      throw new Error("CODEBUDDY_RESPONSE_TOO_LARGE");
    }
    for (const [key, item] of entries) {
      if (
        Buffer.byteLength(key, "utf8") >
        SYNTHETIC_CODEBUDDY_LIMITS.maxStringBytes
      ) {
        throw new Error("CODEBUDDY_RESPONSE_TOO_LARGE");
      }
      assertBoundedValue(item, budget, depth + 1);
    }
  }
}

export function parseSyntheticCodeBuddyCandidateResponseText(
  rawText: unknown,
): unknown {
  if (typeof rawText !== "string") {
    throw new Error("CODEBUDDY_RESPONSE_INVALID");
  }
  if (
    Buffer.byteLength(rawText, "utf8") >
    SYNTHETIC_CODEBUDDY_LIMITS.maxResponseBytes
  ) {
    throw new Error("CODEBUDDY_RESPONSE_TOO_LARGE");
  }
  let value: unknown;
  try {
    value = JSON.parse(rawText) as unknown;
  } catch {
    throw new Error("CODEBUDDY_RESPONSE_INVALID");
  }
  assertBoundedValue(value, { count: 0 });
  return value;
}
