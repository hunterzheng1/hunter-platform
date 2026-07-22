export type CodexExecMode =
  | { readonly mode: "new"; readonly prompt: string }
  | {
      readonly mode: "resume";
      readonly sessionId: string;
      readonly prompt: string;
    };

export interface CodexExecPlan {
  readonly executable: "codex";
  readonly args: readonly string[];
}

export type CodexRuntimeFact =
  | { readonly kind: "operation_accepted" }
  | { readonly kind: "agent_returned" }
  | { readonly kind: "approval_requested" }
  | { readonly kind: "tool_failed" }
  | { readonly kind: "protocol_error" }
  | { readonly kind: "interrupted" }
  | { readonly kind: "turn_failed" };

export type NormalizedCodexEvent =
  | { readonly kind: "session_started"; readonly sessionId: string; readonly raw: unknown }
  | { readonly kind: "turn_started"; readonly raw: unknown }
  | { readonly kind: "agent_message"; readonly raw: unknown }
  | { readonly kind: "tool_event"; readonly raw: unknown }
  | { readonly kind: "approval_requested"; readonly raw: unknown }
  | { readonly kind: "turn_returned"; readonly raw: unknown }
  | { readonly kind: "turn_failed"; readonly raw: unknown }
  | { readonly kind: "error"; readonly raw: unknown }
  | { readonly kind: "protocol_error"; readonly raw: string }
  | { readonly kind: "unknown"; readonly raw: unknown };

export interface CodexEventStream {
  readonly events: readonly NormalizedCodexEvent[];
  readonly facts: readonly CodexRuntimeFact[];
  readonly summary: {
    readonly sessionIdentityPresent: boolean;
    readonly terminalOutcome: "returned" | "failed" | "interrupted" | "indeterminate";
    readonly protocolErrors: number;
  };
}

const forbiddenArgument =
  /dangerously|(?:^|\s)--?yolo(?:\s|$)|--full-auto|danger-full-access|ask-for-approval\s+never/iu;

export function createCodexExecPlan(input: CodexExecMode): CodexExecPlan {
  if (input.prompt.trim() === "") throw new Error("CODEX_PROMPT_REQUIRED");
  if (input.mode === "resume" && input.sessionId.trim() === "") {
    throw new Error("CODEX_SESSION_ID_REQUIRED");
  }

  const args = ["exec", "--json", "--sandbox", "read-only"];
  if (input.mode === "resume") args.push("resume", input.sessionId);
  args.push(input.prompt);
  if (args.some((argument) => forbiddenArgument.test(argument))) {
    throw new Error("CODEX_FORBIDDEN_ARGUMENT");
  }
  return { executable: "codex", args };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function eventType(value: unknown): string | null {
  return isRecord(value) && typeof value.type === "string" ? value.type : null;
}

function normalizeEvent(value: unknown): NormalizedCodexEvent {
  const type = eventType(value);
  if (type === "thread.started" && isRecord(value) && typeof value.thread_id === "string") {
    return { kind: "session_started", sessionId: value.thread_id, raw: value };
  }
  if (type === "turn.started") return { kind: "turn_started", raw: value };
  if (type === "turn.completed") return { kind: "turn_returned", raw: value };
  if (type === "turn.failed") return { kind: "turn_failed", raw: value };
  if (type === "error") return { kind: "error", raw: value };
  if (type?.includes("approval") === true) {
    return { kind: "approval_requested", raw: value };
  }
  if (type === "item.started" || type === "item.updated" || type === "item.completed") {
    const item = isRecord(value) && isRecord(value.item) ? value.item : null;
    return item?.type === "agent_message"
      ? { kind: "agent_message", raw: value }
      : { kind: "tool_event", raw: value };
  }
  return { kind: "unknown", raw: value };
}

function turnFailedWasInterrupted(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  const error = isRecord(raw.error) ? raw.error : null;
  const message = typeof error?.message === "string" ? error.message : "";
  return /interrupt|cancel/iu.test(message);
}

function toolEventFailed(raw: unknown): boolean {
  if (!isRecord(raw) || !isRecord(raw.item)) return false;
  return raw.item.status === "failed";
}

export function parseCodexJsonLines(stdout: string): CodexEventStream {
  const events: NormalizedCodexEvent[] = [];
  const facts: CodexRuntimeFact[] = [];
  let sessionIdentityPresent = false;
  let terminalOutcome: CodexEventStream["summary"]["terminalOutcome"] = "indeterminate";
  let protocolErrors = 0;

  for (const line of stdout.split(/\r?\n/u).filter((candidate) => candidate.trim() !== "")) {
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      events.push({ kind: "protocol_error", raw: line });
      facts.push({ kind: "protocol_error" });
      protocolErrors += 1;
      continue;
    }

    const event = normalizeEvent(raw);
    events.push(event);
    if (event.kind === "session_started") {
      sessionIdentityPresent = true;
      facts.push({ kind: "operation_accepted" });
    } else if (event.kind === "approval_requested") {
      facts.push({ kind: "approval_requested" });
    } else if (event.kind === "tool_event" && toolEventFailed(event.raw)) {
      facts.push({ kind: "tool_failed" });
    } else if (event.kind === "turn_returned") {
      terminalOutcome = "returned";
      facts.push({ kind: "agent_returned" });
    } else if (event.kind === "turn_failed") {
      if (turnFailedWasInterrupted(event.raw)) {
        terminalOutcome = "interrupted";
        facts.push({ kind: "interrupted" });
      } else {
        terminalOutcome = "failed";
        facts.push({ kind: "turn_failed" });
      }
    } else if (event.kind === "error") {
      terminalOutcome = "failed";
      facts.push({ kind: "turn_failed" });
    }
  }

  return {
    events,
    facts,
    summary: { sessionIdentityPresent, terminalOutcome, protocolErrors },
  };
}
