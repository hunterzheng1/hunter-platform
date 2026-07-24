import { isAbsolute, win32 } from "node:path";

export type JsonRpcId = string | number;
export type JsonRpcRequest = Readonly<{
  method: string;
  id: JsonRpcId;
  params?: Readonly<Record<string, unknown>>;
}>;
export type JsonRpcNotification = Readonly<{
  method: string;
  params?: Readonly<Record<string, unknown>>;
}>;
export type JsonRpcResponse = Readonly<{
  id: JsonRpcId;
  result?: unknown;
  error?: unknown;
}>;
export type AppServerMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;
export type AppServerRequest = JsonRpcRequest;

export interface AppServerPlan {
  readonly executableArgs: readonly ["app-server", "--stdio"];
  readonly initialize: JsonRpcRequest;
  readonly initialized: JsonRpcNotification;
  readonly threadStart: JsonRpcRequest;
}

export interface AppServerTranscriptSummary {
  readonly initialized: boolean;
  readonly ephemeralThread: boolean;
  readonly approvalRequestMethods: readonly string[];
  readonly approvalDenialMethods: readonly string[];
  readonly approvalContextMatched: boolean;
  readonly interruptAccepted: boolean;
  readonly interruptTerminalStatus: "interrupted" | "completed" | "failed" | "not_observed";
  readonly protocolErrors: number;
  readonly stepSuccess: false;
}

const approvalMethods = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createAppServerPlan(fixturePath: string): AppServerPlan {
  if (!isAbsolute(fixturePath) && !win32.isAbsolute(fixturePath)) {
    throw new Error("APP_SERVER_FIXTURE_ABSOLUTE_REQUIRED");
  }
  if (/danger-full-access|dangerously|--yolo|--full-auto/iu.test(fixturePath)) {
    throw new Error("APP_SERVER_BOUNDARY_FORBIDDEN");
  }
  return {
    executableArgs: ["app-server", "--stdio"],
    initialize: {
      method: "initialize",
      id: 1,
      params: {
        clientInfo: {
          name: "hunter_phase0",
          title: "Hunter Phase 0",
          version: "0.1.0",
        },
      },
    },
    initialized: { method: "initialized", params: {} },
    threadStart: {
      method: "thread/start",
      id: 2,
      params: {
        cwd: fixturePath,
        ephemeral: true,
        sandbox: "read-only",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
      },
    },
  };
}

export function createTurnStartRequest(
  id: JsonRpcId,
  threadId: string,
  prompt: string,
): JsonRpcRequest {
  if (threadId.trim() === "" || prompt.trim() === "") {
    throw new Error("APP_SERVER_TURN_INPUT_REQUIRED");
  }
  return {
    method: "turn/start",
    id,
    params: {
      threadId,
      input: [{ type: "text", text: prompt }],
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    },
  };
}

export function createInterruptRequest(
  id: JsonRpcId,
  threadId: string,
  turnId: string,
): JsonRpcRequest {
  if (threadId.trim() === "" || turnId.trim() === "") {
    throw new Error("APP_SERVER_INTERRUPT_ID_REQUIRED");
  }
  return { method: "turn/interrupt", id, params: { threadId, turnId } };
}

export function parseAppServerLine(line: string): AppServerMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw new Error("APP_SERVER_PROTOCOL_INVALID_JSON");
  }
  if (!isRecord(parsed)) throw new Error("APP_SERVER_PROTOCOL_INVALID_MESSAGE");
  const hasMethod = typeof parsed.method === "string";
  const hasId = typeof parsed.id === "string" || typeof parsed.id === "number";
  if (!hasMethod && !hasId) throw new Error("APP_SERVER_PROTOCOL_INVALID_MESSAGE");
  return parsed as AppServerMessage;
}

export function createApprovalDenial(request: AppServerRequest): JsonRpcResponse {
  if (!approvalMethods.has(request.method)) {
    throw new Error("APP_SERVER_REQUEST_UNSUPPORTED");
  }
  if (request.method === "item/permissions/requestApproval") {
    return {
      id: request.id,
      result: {
        permissions: { fileSystem: null, network: null },
        scope: "turn",
        strictAutoReview: true,
      },
    };
  }
  return { id: request.id, result: { decision: "decline" } };
}

function messageMethod(message: AppServerMessage): string | null {
  return "method" in message && typeof message.method === "string" ? message.method : null;
}

function isResponse(message: AppServerMessage): message is JsonRpcResponse {
  return !("method" in message) && "id" in message;
}

function denialProven(method: string, response: JsonRpcResponse): boolean {
  if (!isRecord(response.result)) return false;
  if (method === "item/permissions/requestApproval") {
    const permissions = isRecord(response.result.permissions) ? response.result.permissions : null;
    return permissions?.fileSystem === null && permissions.network === null;
  }
  return response.result.decision === "decline" || response.result.decision === "cancel";
}

export function summarizeAppServerTranscript(
  messages: readonly AppServerMessage[],
): AppServerTranscriptSummary {
  const pendingApprovalRequests = new Map<JsonRpcId, string>();
  const approvalRequests: string[] = [];
  const approvalDenials: string[] = [];
  let initialized = false;
  let ephemeralThread = false;
  let threadId: string | null = null;
  let approvalTurnId: string | null = null;
  let interruptTurnId: string | null = null;
  let matchingTurnStarted = false;
  let interruptAccepted = false;
  let interruptTerminalStatus: AppServerTranscriptSummary["interruptTerminalStatus"] =
    "not_observed";

  for (const message of messages) {
    const method = messageMethod(message);
    if (
      method !== null &&
      approvalMethods.has(method) &&
      "id" in message &&
      "params" in message &&
      isRecord(message.params) &&
      threadId !== null &&
      approvalTurnId !== null &&
      message.params.threadId === threadId &&
      message.params.turnId === approvalTurnId
    ) {
      pendingApprovalRequests.set(message.id, method);
      approvalRequests.push(method);
    }
    if (isResponse(message)) {
      const approvalMethod = pendingApprovalRequests.get(message.id);
      if (approvalMethod !== undefined && denialProven(approvalMethod, message)) {
        approvalDenials.push(approvalMethod);
        pendingApprovalRequests.delete(message.id);
      }
    }
    if (isResponse(message) && message.id === 1 && message.result !== undefined && message.error === undefined) {
      initialized = true;
    }
    if (isResponse(message) && message.id === 2 && isRecord(message.result)) {
      const thread = isRecord(message.result.thread) ? message.result.thread : null;
      ephemeralThread = thread?.ephemeral === true;
      threadId = typeof thread?.id === "string" ? thread.id : null;
    }
    if (isResponse(message) && message.id === 4 && isRecord(message.result)) {
      const turn = isRecord(message.result.turn) ? message.result.turn : null;
      interruptTurnId = typeof turn?.id === "string" ? turn.id : null;
    }
    if (isResponse(message) && message.id === 3 && isRecord(message.result)) {
      const turn = isRecord(message.result.turn) ? message.result.turn : null;
      approvalTurnId = typeof turn?.id === "string" ? turn.id : null;
    }
    if (method === "turn/started" && "params" in message && isRecord(message.params)) {
      const turn = isRecord(message.params.turn) ? message.params.turn : null;
      matchingTurnStarted =
        threadId !== null &&
        interruptTurnId !== null &&
        message.params.threadId === threadId &&
        turn?.id === interruptTurnId;
    }
    if (
      isResponse(message) &&
      message.id === 8 &&
      message.result !== undefined &&
      message.error === undefined &&
      matchingTurnStarted
    ) {
      interruptAccepted = true;
    }
    if (method === "turn/completed" && "params" in message && isRecord(message.params)) {
      const turn = isRecord(message.params.turn) ? message.params.turn : null;
      const status = turn?.status;
      if (
        threadId !== null &&
        interruptTurnId !== null &&
        message.params.threadId === threadId &&
        turn?.id === interruptTurnId
      ) {
        interruptTerminalStatus =
          status === "interrupted" ? "interrupted" : status === "failed" ? "failed" : "completed";
      }
    }
  }

  return {
    initialized,
    ephemeralThread,
    approvalRequestMethods: [...approvalRequests].sort(),
    approvalDenialMethods: [...approvalDenials].sort(),
    approvalContextMatched: approvalRequests.length > 0,
    interruptAccepted,
    interruptTerminalStatus,
    protocolErrors: 0,
    stepSuccess: false,
  };
}
