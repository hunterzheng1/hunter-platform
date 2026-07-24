import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  createAppServerPlan,
  createApprovalDenial,
  createInterruptRequest,
  createTurnStartRequest,
  parseAppServerLine,
  summarizeAppServerTranscript,
  type AppServerMessage,
  type AppServerRequest,
  type AppServerTranscriptSummary,
  type JsonRpcId,
} from "./app-server-protocol.js";

export type AppServerCleanup = "process_tree_terminated" | "direct_process_exit" | "not_proven";

export function classifyWindowsCleanup(
  taskkillSucceeded: boolean,
  processExitObserved: boolean,
): AppServerCleanup {
  if (!processExitObserved) return "not_proven";
  return taskkillSucceeded ? "process_tree_terminated" : "direct_process_exit";
}

export interface AppServerTransport {
  send(message: AppServerMessage): Promise<void>;
  receive(timeoutMs: number): Promise<AppServerMessage>;
  close(timeoutMs: number): Promise<AppServerCleanup>;
}

export interface RunAppServerSessionOptions {
  readonly transport: AppServerTransport;
  readonly fixturePath: string;
  readonly approvalPrompt: string;
  readonly interruptPrompt: string;
  readonly timeoutMs: number;
}

export interface AppServerSessionReceipt {
  readonly summary: AppServerTranscriptSummary;
  readonly cleanup: AppServerCleanup;
  readonly realTurnCount: 2;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isResponse(message: AppServerMessage, id: JsonRpcId): boolean {
  return !("method" in message) && message.id === id;
}

function responseResult(message: AppServerMessage, id: JsonRpcId): Record<string, unknown> {
  if (!isResponse(message, id)) throw new Error("APP_SERVER_RESPONSE_ID_MISMATCH");
  if ("error" in message && message.error !== undefined) throw new Error("APP_SERVER_RESPONSE_ERROR");
  return "result" in message && isRecord(message.result) ? message.result : {};
}

function nestedId(result: Record<string, unknown>, key: "thread" | "turn"): string {
  const target = isRecord(result[key]) ? result[key] : null;
  if (typeof target?.id !== "string" || target.id.trim() === "") {
    throw new Error(`APP_SERVER_${key.toUpperCase()}_ID_MISSING`);
  }
  return target.id;
}

function methodOf(message: AppServerMessage): string | null {
  return "method" in message ? message.method : null;
}

async function withinDeadline<T>(
  operation: () => Promise<T>,
  remainingMs: () => number,
): Promise<T> {
  const timeoutMs = remainingMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("APP_SERVER_SESSION_TIMEOUT")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function turnFromNotification(message: AppServerMessage): Record<string, unknown> | null {
  if (!("params" in message) || !isRecord(message.params)) return null;
  return isRecord(message.params.turn) ? message.params.turn : null;
}

async function receiveResponse(
  transport: AppServerTransport,
  transcript: AppServerMessage[],
  id: JsonRpcId,
  remainingMs: () => number,
): Promise<Record<string, unknown>> {
  for (let count = 0; count < 200; count += 1) {
    const message = await transport.receive(remainingMs());
    transcript.push(message);
    if (isResponse(message, id)) return responseResult(message, id);
    if ("id" in message && "method" in message) {
      const denial = createApprovalDenial(message as AppServerRequest);
      await withinDeadline(() => transport.send(denial), remainingMs);
      transcript.push(denial);
    }
  }
  throw new Error("APP_SERVER_RESPONSE_NOT_OBSERVED");
}

async function receiveTurnCompleted(
  transport: AppServerTransport,
  transcript: AppServerMessage[],
  threadId: string,
  turnId: string,
  remainingMs: () => number,
): Promise<void> {
  for (let count = 0; count < 500; count += 1) {
    const message = await transport.receive(remainingMs());
    transcript.push(message);
    if ("id" in message && "method" in message) {
      const denial = createApprovalDenial(message as AppServerRequest);
      await withinDeadline(() => transport.send(denial), remainingMs);
      transcript.push(denial);
      continue;
    }
    if (
      methodOf(message) === "turn/completed" &&
      "params" in message &&
      isRecord(message.params) &&
      message.params.threadId === threadId &&
      turnFromNotification(message)?.id === turnId
    ) return;
  }
  throw new Error("APP_SERVER_TURN_TERMINAL_NOT_OBSERVED");
}

async function receiveTurnStarted(
  transport: AppServerTransport,
  transcript: AppServerMessage[],
  threadId: string,
  turnId: string,
  remainingMs: () => number,
): Promise<void> {
  for (let count = 0; count < 200; count += 1) {
    const message = await transport.receive(remainingMs());
    transcript.push(message);
    if ("id" in message && "method" in message) {
      const denial = createApprovalDenial(message as AppServerRequest);
      await withinDeadline(() => transport.send(denial), remainingMs);
      transcript.push(denial);
      continue;
    }
    if (
      methodOf(message) === "turn/started" &&
      "params" in message &&
      isRecord(message.params) &&
      message.params.threadId === threadId &&
      turnFromNotification(message)?.id === turnId
    ) return;
  }
  throw new Error("APP_SERVER_TURN_STARTED_NOT_OBSERVED");
}

export async function runAppServerSession(
  options: RunAppServerSessionOptions,
): Promise<AppServerSessionReceipt> {
  const transcript: AppServerMessage[] = [];
  const deadline = Date.now() + options.timeoutMs;
  const remainingMs = (): number => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("APP_SERVER_SESSION_TIMEOUT");
    return remaining;
  };
  let cleanup: AppServerCleanup = "not_proven";
  try {
    const plan = createAppServerPlan(options.fixturePath);
    await withinDeadline(() => options.transport.send(plan.initialize), remainingMs);
    await receiveResponse(options.transport, transcript, 1, remainingMs);
    await withinDeadline(() => options.transport.send(plan.initialized), remainingMs);
    await withinDeadline(() => options.transport.send(plan.threadStart), remainingMs);
    const threadId = nestedId(
      await receiveResponse(options.transport, transcript, 2, remainingMs),
      "thread",
    );

    await withinDeadline(
      () => options.transport.send(createTurnStartRequest(3, threadId, options.approvalPrompt)),
      remainingMs,
    );
    const approvalTurnId = nestedId(
      await receiveResponse(options.transport, transcript, 3, remainingMs),
      "turn",
    );
    await receiveTurnCompleted(
      options.transport,
      transcript,
      threadId,
      approvalTurnId,
      remainingMs,
    );

    await withinDeadline(
      () => options.transport.send(createTurnStartRequest(4, threadId, options.interruptPrompt)),
      remainingMs,
    );
    const interruptTurnId = nestedId(
      await receiveResponse(options.transport, transcript, 4, remainingMs),
      "turn",
    );
    await receiveTurnStarted(
      options.transport,
      transcript,
      threadId,
      interruptTurnId,
      remainingMs,
    );
    await withinDeadline(
      () => options.transport.send(createInterruptRequest(8, threadId, interruptTurnId)),
      remainingMs,
    );
    await receiveResponse(options.transport, transcript, 8, remainingMs);
    await receiveTurnCompleted(
      options.transport,
      transcript,
      threadId,
      interruptTurnId,
      remainingMs,
    );
    cleanup = await withinDeadline(() => options.transport.close(remainingMs()), remainingMs);
    return { summary: summarizeAppServerTranscript(transcript), cleanup, realTurnCount: 2 };
  } finally {
    if (cleanup === "not_proven") {
      await options.transport.close(Math.max(0, deadline - Date.now())).catch(() => undefined);
    }
  }
}

type PendingReceive = {
  readonly resolve: (message: AppServerMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

export interface AppServerOutputLimits {
  readonly maxBytes: number;
  readonly maxLineBytes: number;
  readonly maxMessages: number;
}

export class BoundedAppServerOutput {
  readonly #limits: AppServerOutputLimits;
  #buffer = "";
  #totalBytes = 0;
  #messageCount = 0;
  #fatalCode: string | null = null;

  constructor(
    limits: AppServerOutputLimits = {
      maxBytes: 4 * 1024 * 1024,
      maxLineBytes: 512 * 1024,
      maxMessages: 2_000,
    },
  ) {
    this.#limits = limits;
  }

  #fail(code: string): never {
    this.#fatalCode ??= code;
    throw new Error(this.#fatalCode);
  }

  accept(chunk: Buffer): AppServerMessage[] {
    if (this.#fatalCode !== null) throw new Error(this.#fatalCode);
    this.#totalBytes += chunk.byteLength;
    if (this.#totalBytes > this.#limits.maxBytes) this.#fail("APP_SERVER_OUTPUT_LIMIT");
    this.#buffer += chunk.toString("utf8");
    const lines = this.#buffer.split(/\r?\n/u);
    this.#buffer = lines.pop() ?? "";
    if (Buffer.byteLength(this.#buffer) > this.#limits.maxLineBytes) {
      this.#fail("APP_SERVER_OUTPUT_LIMIT");
    }
    const messages: AppServerMessage[] = [];
    for (const line of lines) {
      if (line.trim() === "") continue;
      if (Buffer.byteLength(line) > this.#limits.maxLineBytes) {
        this.#fail("APP_SERVER_OUTPUT_LIMIT");
      }
      this.#messageCount += 1;
      if (this.#messageCount > this.#limits.maxMessages) this.#fail("APP_SERVER_OUTPUT_LIMIT");
      try {
        messages.push(parseAppServerLine(line));
      } catch {
        this.#fail("APP_SERVER_PROTOCOL_INVALID_JSON");
      }
    }
    return messages;
  }
}

async function waitForChildClose(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return await new Promise<boolean>((resolve) => {
    const onClose = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("close", onClose);
      resolve(child.exitCode !== null);
    }, timeoutMs);
    child.once("close", onClose);
  });
}

async function waitForProcessGroupGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      process.kill(-pid, 0);
    } catch (error: unknown) {
      if (isRecord(error) && error.code === "ESRCH") return true;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))));
  }
  return false;
}

export class NodeAppServerTransport implements AppServerTransport {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #queue: AppServerMessage[] = [];
  readonly #pending: PendingReceive[] = [];
  readonly #output = new BoundedAppServerOutput();
  #closed = false;
  #fatalCode: string | null = null;

  constructor(executable: string, cwd: string) {
    this.#child = spawn(executable, ["app-server", "--stdio"], {
      cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    this.#child.stdout.on("data", (chunk: Buffer) => this.#acceptChunk(chunk));
    this.#child.stderr.on("data", () => undefined);
    this.#child.once("error", () => this.#setFatal("APP_SERVER_PROCESS_ERROR"));
    this.#child.once("close", () => this.#setFatal("APP_SERVER_PROCESS_CLOSED"));
  }

  #rejectPending(code: string): void {
    for (const pending of this.#pending.splice(0)) {
      clearTimeout(pending.timer);
      pending.reject(new Error(code));
    }
  }

  #setFatal(code: string): void {
    this.#fatalCode ??= code;
    this.#rejectPending(this.#fatalCode);
  }

  #acceptChunk(chunk: Buffer): void {
    let messages: AppServerMessage[];
    try {
      messages = this.#output.accept(chunk);
    } catch (error: unknown) {
      this.#setFatal(error instanceof Error ? error.message : "APP_SERVER_PROTOCOL_ERROR");
      return;
    }
    for (const message of messages) {
      const pending = this.#pending.shift();
      if (pending === undefined) this.#queue.push(message);
      else {
        clearTimeout(pending.timer);
        pending.resolve(message);
      }
    }
  }

  async send(message: AppServerMessage): Promise<void> {
    if (this.#closed) throw new Error("APP_SERVER_TRANSPORT_CLOSED");
    if (this.#fatalCode !== null) throw new Error(this.#fatalCode);
    await new Promise<void>((resolve, reject) => {
      this.#child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error === null || error === undefined) resolve();
        else reject(new Error("APP_SERVER_STDIN_WRITE_FAILED"));
      });
    });
  }

  async receive(timeoutMs: number): Promise<AppServerMessage> {
    if (this.#fatalCode !== null) throw new Error(this.#fatalCode);
    const queued = this.#queue.shift();
    if (queued !== undefined) return queued;
    return await new Promise<AppServerMessage>((resolve, reject) => {
      const pending: PendingReceive = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.#pending.indexOf(pending);
          if (index >= 0) this.#pending.splice(index, 1);
          reject(new Error("APP_SERVER_TRANSPORT_TIMEOUT"));
        }, timeoutMs),
      };
      this.#pending.push(pending);
    });
  }

  async close(timeoutMs: number): Promise<AppServerCleanup> {
    if (this.#closed) return this.#child.exitCode === null ? "not_proven" : "direct_process_exit";
    this.#closed = true;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const remaining = (): number => Math.max(0, deadline - Date.now());
    this.#child.stdin.end();
    if (this.#child.exitCode !== null) return "direct_process_exit";
    const exited = await waitForChildClose(this.#child, Math.min(500, remaining()));
    if (exited) return "direct_process_exit";
    const pid = this.#child.pid;
    if (pid === undefined) {
      this.#child.kill("SIGKILL");
      return "not_proven";
    }
    if (process.platform === "win32") {
      const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      const killed = await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (value: boolean): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        const timer = setTimeout(() => {
          killer.kill();
          finish(false);
        }, remaining());
        killer.once("error", () => finish(false));
        killer.once("close", (code) => finish(code === 0));
      });
      const processExitObserved = await waitForChildClose(this.#child, remaining());
      return classifyWindowsCleanup(killed, processExitObserved);
    }
    try {
      process.kill(-pid, "SIGKILL");
      const rootExited = await waitForChildClose(this.#child, remaining());
      const groupGone = await waitForProcessGroupGone(pid, remaining());
      return rootExited && groupGone ? "process_tree_terminated" : "not_proven";
    } catch {
      this.#child.kill("SIGKILL");
      return "not_proven";
    }
  }
}
