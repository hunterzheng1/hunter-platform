import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";

import type {
  CodexConnectionState,
  CodexLoginStart,
  CodexModelOption
} from "@hunter-harness/contracts";
import type { LlmClient, LlmPrompt, LlmResponse } from "@hunter-harness/core";

type JsonObject = Record<string, unknown>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface NotificationWaiter {
  predicate: (message: JsonObject) => boolean;
  resolve: (message: JsonObject) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CodexAiService {
  getConnection(): Promise<Omit<CodexConnectionState, "selected_model" | "enabled">>;
  startDeviceLogin(): Promise<CodexLoginStart>;
  cancelLogin(loginId: string): Promise<void>;
  logout(): Promise<void>;
  getLlmClient(model: string | null): Promise<LlmClient | null>;
  close(): Promise<void>;
}

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function boolean(value: unknown): boolean {
  return value === true;
}

function codexBinPath(): string {
  return path.join(process.cwd(), "node_modules", "@openai", "codex", "bin", "codex.js");
}

function publicError(error: unknown): string {
  if (error instanceof Error && error.message.includes("not installed")) {
    return "Codex 服务尚未安装，请重新构建 Hunter Platform。";
  }
  return "Codex 服务暂不可用，请稍后重试。";
}

function parseModel(item: unknown): CodexModelOption | null {
  const row = object(item);
  if (row === null) return null;
  const id = string(row.id) ?? string(row.model);
  if (id === null) return null;
  const rawEfforts = Array.isArray(row.supportedReasoningEfforts)
    ? row.supportedReasoningEfforts
    : Array.isArray(row.reasoningEfforts)
      ? row.reasoningEfforts
      : [];
  const reasoningEfforts = rawEfforts.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    const parsed = object(entry);
    const effort = parsed === null ? null : string(parsed.reasoningEffort) ?? string(parsed.effort);
    return effort === null ? [] : [effort];
  });
  return {
    id,
    display_name: string(row.displayName) ?? string(row.display_name) ?? id,
    is_default: boolean(row.isDefault) || boolean(row.is_default),
    reasoning_efforts: reasoningEfforts
  };
}

export class CodexAppServerService implements CodexAiService {
  private child: ChildProcessWithoutNullStreams | null = null;
  private reader: ReadlineInterface | null = null;
  private startPromise: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly waiters = new Set<NotificationWaiter>();
  private analysisQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly codexHome: string,
    private readonly requestTimeoutMs = 30_000,
    private readonly turnTimeoutMs = 120_000
  ) {}

  async getConnection(): Promise<Omit<CodexConnectionState, "selected_model" | "enabled">> {
    try {
      await this.ensureStarted();
      const accountResult = object(await this.request("account/read", {}));
      const account = object(accountResult?.account);
      if (account === null || string(account.type) !== "chatgpt") {
        return {
          status: "disconnected",
          auth_mode: null,
          email: null,
          plan_type: null,
          models: [],
          error: null
        };
      }
      const modelResult = object(await this.request("model/list", { limit: 100, includeHidden: false }));
      const rawModels = Array.isArray(modelResult?.data)
        ? modelResult.data
        : Array.isArray(modelResult?.items)
          ? modelResult.items
          : [];
      const models = rawModels.map(parseModel).filter((item): item is CodexModelOption => item !== null);
      return {
        status: "connected",
        auth_mode: "chatgpt",
        email: string(account.email),
        plan_type: string(account.planType) ?? string(account.plan_type),
        models,
        error: null
      };
    } catch (error) {
      return {
        status: "unavailable",
        auth_mode: null,
        email: null,
        plan_type: null,
        models: [],
        error: publicError(error)
      };
    }
  }

  async startDeviceLogin(): Promise<CodexLoginStart> {
    await this.ensureStarted();
    const result = object(await this.request("account/login/start", { type: "chatgptDeviceCode" }));
    const loginId = string(result?.loginId) ?? string(result?.login_id);
    const verificationUrl = string(result?.verificationUrl) ?? string(result?.verification_url);
    const userCode = string(result?.userCode) ?? string(result?.user_code);
    if (loginId === null || verificationUrl === null || userCode === null) {
      throw new Error("Codex App Server returned an invalid login response");
    }
    return {
      login_id: loginId,
      verification_url: verificationUrl,
      user_code: userCode
    };
  }

  async cancelLogin(loginId: string): Promise<void> {
    await this.ensureStarted();
    await this.request("account/login/cancel", { loginId });
  }

  async logout(): Promise<void> {
    await this.ensureStarted();
    await this.request("account/logout", undefined);
  }

  async getLlmClient(model: string | null): Promise<LlmClient | null> {
    const connection = await this.getConnection();
    if (connection.status !== "connected") return null;
    const selected = model
      ?? connection.models.find((item) => item.is_default)?.id
      ?? connection.models[0]?.id
      ?? null;
    if (selected === null) return null;
    return {
      analyze: (prompt) => this.enqueueAnalysis(selected, prompt)
    };
  }

  async close(): Promise<void> {
    const error = new Error("Codex App Server closed");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
    this.reader?.close();
    this.reader = null;
    if (this.child !== null) {
      this.child.kill("SIGTERM");
      this.child = null;
    }
    this.startPromise = null;
  }

  private enqueueAnalysis(model: string, prompt: LlmPrompt): Promise<LlmResponse> {
    const run = this.analysisQueue.then(() => this.analyze(model, prompt));
    this.analysisQueue = run.catch(() => undefined);
    return run;
  }

  private async analyze(model: string, prompt: LlmPrompt): Promise<LlmResponse> {
    await this.ensureStarted();
    const started = object(await this.request("thread/start", {
      model,
      approvalPolicy: "never",
      sandbox: "read-only",
      serviceName: "hunter-platform",
      ephemeral: true
    }));
    const thread = object(started?.thread);
    const threadId = string(thread?.id) ?? string(started?.threadId);
    if (threadId === null) throw new Error("Codex did not return a thread id");

    try {
      const turnStarted = object(await this.request("turn/start", {
        threadId,
        input: [{
          type: "text",
          text: `${prompt.system}\n\n${prompt.user}\n\n只返回任务要求的最终内容，不要调用工具，也不要补充解释。`,
          text_elements: []
        }]
      }));
      const turn = object(turnStarted?.turn);
      const turnId = string(turn?.id) ?? string(turnStarted?.turnId);
      if (turnId === null) throw new Error("Codex did not return a turn id");

      const messages: string[] = [];
      const completed = this.waitForNotification((message) => {
        const params = object(message.params);
        const notificationTurn = object(params?.turn);
        const notificationTurnId = string(params?.turnId) ?? string(notificationTurn?.id);
        if (string(params?.threadId) !== threadId || notificationTurnId !== turnId) return false;
        if (message.method === "item/completed") {
          const item = object(params?.item);
          if (string(item?.type) === "agentMessage") {
            const text = string(item?.text);
            if (text !== null) messages.push(text);
          }
          return false;
        }
        return message.method === "turn/completed";
      }, this.turnTimeoutMs);
      const done = await completed;
      const params = object(done.params);
      const completedTurn = object(params?.turn);
      const status = string(completedTurn?.status);
      if (status !== null && status !== "completed") {
        throw new Error(`Codex turn ended with status ${status}`);
      }
      const completedItems = Array.isArray(completedTurn?.items) ? completedTurn.items : [];
      for (const value of completedItems) {
        const item = object(value);
        if (string(item?.type) !== "agentMessage") continue;
        const text = string(item?.text);
        if (text !== null && !messages.includes(text)) messages.push(text);
      }
      const content = messages.at(-1)?.trim() ?? "";
      if (content === "") throw new Error("Codex returned an empty response");
      return { content, usage: { requests: 1, tokens: 0 } };
    } finally {
      try {
        await this.request("thread/delete", { threadId });
      } catch {
        // 临时分析线程清理失败不覆盖主请求结果；App Server 会自行维护线程数据。
      }
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.child !== null) return;
    if (this.startPromise !== null) return this.startPromise;
    this.startPromise = this.start();
    try {
      await this.startPromise;
    } catch (error) {
      this.startPromise = null;
      throw error;
    }
  }

  private async start(): Promise<void> {
    const bin = codexBinPath();
    try {
      await fs.access(bin);
    } catch {
      throw new Error("Codex App Server is not installed");
    }
    await fs.mkdir(this.codexHome, { recursive: true, mode: 0o700 });
    const child = spawn(process.execPath, [bin, "app-server"], {
      cwd: process.cwd(),
      env: { ...process.env, CODEX_HOME: this.codexHome },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    // App Server 的诊断流可能持续输出；主动排空，避免 pipe 写满阻塞。
    // 不转发到平台日志，防止账号或本机路径进入审计输出。
    child.stderr.resume();
    this.reader = createInterface({ input: child.stdout });
    this.reader.on("line", (line) => this.onLine(line));
    child.on("error", (error) => this.onExit(error));
    child.on("exit", (code, signal) => this.onExit(new Error(`Codex App Server exited (${code ?? signal ?? "unknown"})`)));
    await this.request("initialize", {
      clientInfo: { name: "hunter-platform", title: "Hunter Platform", version: "0.1.0" },
      capabilities: { experimentalApi: false, requestAttestation: false }
    });
    this.notify("initialized");
  }

  private request(method: string, params: JsonObject | undefined): Promise<unknown> {
    if (this.child === null) throw new Error("Codex App Server is not running");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write(params === undefined
        ? { jsonrpc: "2.0", id, method }
        : { jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params?: JsonObject): void {
    this.write(params === undefined
      ? { jsonrpc: "2.0", method }
      : { jsonrpc: "2.0", method, params });
  }

  private write(message: JsonObject): void {
    if (this.child === null || !this.child.stdin.writable) {
      throw new Error("Codex App Server input is unavailable");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const message = object(parsed);
    if (message === null) return;
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      const rpcError = object(message.error);
      if (rpcError !== null) {
        pending.reject(new Error(string(rpcError.message) ?? "Codex request failed"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(message)) continue;
      this.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  }

  private waitForNotification(predicate: NotificationWaiter["predicate"], timeoutMs: number): Promise<JsonObject> {
    return new Promise((resolve, reject) => {
      const waiter: NotificationWaiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error("Codex turn timed out"));
        }, timeoutMs)
      };
      this.waiters.add(waiter);
    });
  }

  private onExit(error: Error): void {
    const child = this.child;
    this.child = null;
    this.startPromise = null;
    if (child !== null) child.stdin.destroy();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }
}
