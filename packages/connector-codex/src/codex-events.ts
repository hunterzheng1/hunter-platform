import { createHash } from "node:crypto";
import { z } from "zod";

export const CODEX_EVENT_LIMITS = Object.freeze({
  maxEvents: 512,
  maxLineBytes: 64 * 1024,
  maxStringBytes: 16 * 1024,
  maxDepth: 8,
  maxObjectKeys: 128,
  maxArrayItems: 256,
});

export const CodexNativeSessionRefSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u,
    "CODEX_SESSION_ID_INVALID",
  )
  .brand<"CodexNativeSessionRef">();
export type CodexNativeSessionRef = z.infer<typeof CodexNativeSessionRefSchema>;

const ProviderTypeSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u, "CODEX_EVENT_TYPE_INVALID");

const ItemTypeSchema = z.enum(["agent_message", "command_execution"]);

export const CodexCandidateObservationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("thread_started"),
    sessionRef: CodexNativeSessionRefSchema,
  }),
  z.strictObject({ kind: z.literal("turn_started") }),
  z.strictObject({ kind: z.literal("agent_returned") }),
  z.strictObject({ kind: z.literal("turn_failed") }),
  z.strictObject({
    kind: z.enum(["item_started", "item_updated", "item_completed"]),
    itemType: ItemTypeSchema,
  }),
  z.strictObject({ kind: z.literal("approval_requested") }),
  z.strictObject({ kind: z.literal("tool_failed") }),
  z.strictObject({ kind: z.literal("runtime_error") }),
  z.strictObject({
    kind: z.literal("unknown_event"),
    rawEventDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  z.strictObject({
    kind: z.literal("process_exited"),
    exitCode: z.number().int().nullable(),
  }),
]);
export type CodexCandidateObservation = z.infer<
  typeof CodexCandidateObservationSchema
>;

export const ParsedCodexEventStreamSchema = z.strictObject({
  sessionRef: CodexNativeSessionRefSchema,
  terminalOutcome: z.enum(["agent_returned", "turn_failed", "indeterminate"]),
  observations: z.array(CodexCandidateObservationSchema).max(CODEX_EVENT_LIMITS.maxEvents),
});
export type ParsedCodexEventStream = z.infer<typeof ParsedCodexEventStreamSchema>;

const knownEventTypes = new Set([
  "thread.started",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "item.started",
  "item.updated",
  "item.completed",
  "approval.requested",
  "error",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertBoundedValue(value: unknown, depth = 0): void {
  if (depth > CODEX_EVENT_LIMITS.maxDepth) {
    throw new Error("CODEX_EVENT_DEPTH_EXCEEDED");
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > CODEX_EVENT_LIMITS.maxStringBytes) {
      throw new Error("CODEX_EVENT_VALUE_TOO_LARGE");
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > CODEX_EVENT_LIMITS.maxArrayItems) {
      throw new Error("CODEX_EVENT_VALUE_TOO_LARGE");
    }
    for (const item of value) assertBoundedValue(item, depth + 1);
    return;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > CODEX_EVENT_LIMITS.maxObjectKeys) {
      throw new Error("CODEX_EVENT_VALUE_TOO_LARGE");
    }
    for (const [key, item] of entries) {
      if (Buffer.byteLength(key, "utf8") > CODEX_EVENT_LIMITS.maxStringBytes) {
        throw new Error("CODEX_EVENT_VALUE_TOO_LARGE");
      }
      assertBoundedValue(item, depth + 1);
    }
  }
}

function rawEventDigest(line: string): string {
  return createHash("sha256")
    .update(line, "utf8")
    .digest("hex");
}

function parseLine(line: string): Record<string, unknown> {
  if (Buffer.byteLength(line, "utf8") > CODEX_EVENT_LIMITS.maxLineBytes) {
    throw new Error("CODEX_EVENT_LINE_TOO_LARGE");
  }
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    throw new Error("CODEX_EVENT_INVALID_JSON");
  }
  if (!isRecord(value)) throw new Error("CODEX_EVENT_INVALID_OBJECT");
  assertBoundedValue(value);
  return value;
}

function parseType(value: Record<string, unknown>): string {
  const parsed = ProviderTypeSchema.safeParse(value.type);
  if (!parsed.success) throw new Error("CODEX_EVENT_TYPE_INVALID");
  return parsed.data;
}

function parseItemType(
  value: Record<string, unknown>,
): z.infer<typeof ItemTypeSchema> | null {
  if (!isRecord(value.item)) throw new Error("CODEX_ITEM_INVALID");
  if (typeof value.item.type !== "string") throw new Error("CODEX_ITEM_INVALID");
  const parsed = ItemTypeSchema.safeParse(value.item.type);
  return parsed.success ? parsed.data : null;
}

/**
 * Parses the fixed Codex 0.144.6 JSONL fixture boundary. Unknown event types
 * survive only as a bounded digest: provider output, prompts, tokens and paths
 * are never retained in the candidate snapshot.
 */
export function parseCodexEventLines(
  lines: readonly string[],
): ParsedCodexEventStream {
  if (lines.length > CODEX_EVENT_LIMITS.maxEvents) {
    throw new Error("CODEX_EVENT_COUNT_EXCEEDED");
  }

  const observations: CodexCandidateObservation[] = [];
  let sessionRef: CodexNativeSessionRef | null = null;
  let turnStarted = false;
  let terminalSeen = false;
  let terminalOutcome: ParsedCodexEventStream["terminalOutcome"] = "indeterminate";

  for (const line of lines) {
    const raw = parseLine(line);
    const type = parseType(raw);

    if (!knownEventTypes.has(type)) {
      observations.push({
        kind: "unknown_event",
        rawEventDigest: rawEventDigest(line),
      });
      continue;
    }

    if (type === "thread.started") {
      const parsedSession = CodexNativeSessionRefSchema.safeParse(raw.thread_id);
      if (!parsedSession.success) throw new Error("CODEX_SESSION_ID_INVALID");
      if (sessionRef !== null) {
        throw new Error(
          sessionRef === parsedSession.data
            ? "CODEX_SESSION_ID_DUPLICATE"
            : "CODEX_SESSION_ID_CONFLICT",
        );
      }
      sessionRef = parsedSession.data;
      observations.push({ kind: "thread_started", sessionRef });
      continue;
    }

    if (sessionRef === null) throw new Error("CODEX_THREAD_STARTED_REQUIRED");

    if (terminalSeen) {
      if (type === "turn.completed" || type === "turn.failed") {
        throw new Error("CODEX_TURN_TERMINAL_CONFLICT");
      }
      throw new Error("CODEX_EVENT_AFTER_TERMINAL");
    }

    if (type === "turn.started") {
      if (turnStarted) throw new Error("CODEX_TURN_STARTED_DUPLICATE");
      turnStarted = true;
      observations.push({ kind: "turn_started" });
      continue;
    }

    if (type === "turn.completed" || type === "turn.failed") {
      if (!turnStarted) throw new Error("CODEX_TURN_NOT_STARTED");
      const nextOutcome = type === "turn.completed" ? "agent_returned" : "turn_failed";
      terminalSeen = true;
      terminalOutcome = nextOutcome;
      observations.push({ kind: nextOutcome });
      continue;
    }

    if (type === "item.started" || type === "item.updated" || type === "item.completed") {
      if (!turnStarted) throw new Error("CODEX_TURN_NOT_STARTED");
      const itemType = parseItemType(raw);
      if (itemType === null) {
        observations.push({
          kind: "unknown_event",
          rawEventDigest: rawEventDigest(line),
        });
        continue;
      }
      observations.push({
        kind:
          type === "item.started"
            ? "item_started"
            : type === "item.updated"
              ? "item_updated"
              : "item_completed",
        itemType,
      });
      if (
        (type === "item.updated" || type === "item.completed") &&
        isRecord(raw.item) &&
        raw.item.status === "failed"
      ) {
        observations.push({ kind: "tool_failed" });
      }
      continue;
    }

    if (type === "approval.requested") {
      if (!turnStarted) throw new Error("CODEX_TURN_NOT_STARTED");
      if (!isRecord(raw.request)) throw new Error("CODEX_APPROVAL_EVENT_INVALID");
      observations.push({ kind: "approval_requested" });
      continue;
    }

    if (type === "error") {
      if (!turnStarted) throw new Error("CODEX_TURN_NOT_STARTED");
      observations.push({ kind: "runtime_error" });
      continue;
    }
  }

  if (sessionRef === null) throw new Error("CODEX_SESSION_ID_MISSING");
  return ParsedCodexEventStreamSchema.parse({
    sessionRef,
    terminalOutcome,
    observations,
  });
}
