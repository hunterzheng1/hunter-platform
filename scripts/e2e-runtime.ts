import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, posix, win32 } from "node:path";
import { promisify } from "node:util";

export const E2E_SESSION_COOKIE = "hunter_e2e_session";
export const E2E_CSRF_HEADER = "hunter-e2e-csrf";
const E2E_ORIGIN = "http://127.0.0.1:4173";
const executeFile = promisify(execFile);

export interface BrowserSessionMaterial {
  readonly cookieValue: string;
  readonly csrfValue: string;
}

export type FileProtector = (path: string) => Promise<void>;

function derive(seed: Buffer, label: string): string {
  return createHash("sha256").update(label).update(seed).digest("hex");
}

export function createBrowserSession(
  entropy: () => Buffer = () => randomBytes(32),
): BrowserSessionMaterial {
  const seed = entropy();
  if (seed.length < 32) throw new Error("E2E_SESSION_ENTROPY_TOO_SHORT");
  return Object.freeze({
    cookieValue: derive(seed, "cookie"),
    csrfValue: derive(seed, "csrf"),
  });
}

export async function protectCurrentUserOnly(path: string): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(path, 0o600);
    return;
  }
  const identityRow = (await executeFile(
    "whoami",
    ["/user", "/fo", "csv", "/nh"],
    { encoding: "utf8", windowsHide: true },
  )).stdout.trim();
  const sid = /"(S-\d+(?:-\d+)+)"\s*$/u.exec(identityRow)?.[1];
  if (sid === undefined) {
    throw new Error("E2E_WINDOWS_SID_INVALID");
  }
  await executeFile(
    "icacls",
    [path, "/inheritance:r", "/grant:r", `*${sid}:(F)`],
    { encoding: "utf8", windowsHide: true },
  );
}

export async function atomicWritePlaywrightState(
  target: string,
  session: BrowserSessionMaterial,
  protect: FileProtector = protectCurrentUserOnly,
): Promise<void> {
  const state = {
    cookies: [
      {
        name: E2E_SESSION_COOKIE,
        value: session.cookieValue,
        domain: "127.0.0.1",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: "Strict",
      },
    ],
    origins: [
      {
        origin: E2E_ORIGIN,
        localStorage: [{ name: E2E_CSRF_HEADER, value: session.csrfValue }],
      },
    ],
  };
  await atomicWriteProtectedJson(target, state, protect);
}

export interface E2eReadiness {
  readonly schemaVersion: 1;
  readonly webOrigin: string;
  readonly storageStatePath: ".hunter-e2e/playwright-state.json";
}

export async function atomicWriteE2eReadiness(
  target: string,
  readiness: E2eReadiness,
  protect: FileProtector = protectCurrentUserOnly,
): Promise<void> {
  if (
    readiness.schemaVersion !== 1
    || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(readiness.webOrigin)
    || readiness.storageStatePath !== ".hunter-e2e/playwright-state.json"
  ) {
    throw new Error("E2E_READINESS_INVALID");
  }
  await atomicWriteProtectedJson(target, readiness, protect);
}

async function atomicWriteProtectedJson(
  target: string,
  value: unknown,
  protect: FileProtector,
): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await protect(temporary);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, target);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
}

export function assertOwnedTemporaryDirectory(
  ownedPrefix: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const path = platform === "win32" ? win32 : posix;
  const normalizedPrefix = path.resolve(ownedPrefix);
  const normalizedTarget = path.resolve(target);
  const prefixParent = path.dirname(normalizedPrefix);
  const targetParent = path.dirname(normalizedTarget);
  const normalizeCase = (value: string) =>
    platform === "win32" ? value.toLowerCase() : value;
  const targetName = normalizeCase(path.basename(normalizedTarget));
  const prefixName = normalizeCase(path.basename(normalizedPrefix));
  if (
    path.relative(normalizeCase(prefixParent), normalizeCase(targetParent)) !== ""
    || targetName.length <= prefixName.length
    || !targetName.startsWith(prefixName)
  ) {
    throw new Error("E2E_TEMP_DIRECTORY_NOT_OWNED");
  }
}

const PROJECT_PATH_ID = "prj_[A-Za-z0-9_-]{8,}";
const REQUIREMENT_REVISION_PATH_ID = "rrv_[A-Za-z0-9_-]{8,}";
const OWNER_STORY_PROXY_ROUTES = [
  { method: "GET", path: new RegExp(`^/api/v1/projects(?:/${PROJECT_PATH_ID})?$`, "u") },
  { method: "POST", path: /^\/api\/v1\/projects$/u },
  { method: "POST", path: new RegExp(`^/api/v1/projects/${PROJECT_PATH_ID}/requirements$`, "u") },
  { method: "POST", path: new RegExp(`^/api/v1/projects/${PROJECT_PATH_ID}/requirement-revisions/${REQUIREMENT_REVISION_PATH_ID}/approve$`, "u") },
  { method: "POST", path: new RegExp(`^/api/v1/projects/${PROJECT_PATH_ID}/changes$`, "u") },
  {
    method: "GET",
    path: new RegExp(`^/api/v1/projects/${PROJECT_PATH_ID}/knowledge$`, "u"),
    searches: ["?includeHistorical=true", "?includeHistorical=false"],
  },
  { method: "POST", path: /^\/runs$/u },
] as const;

export function isAllowedE2eProxyRequest(
  method: string,
  pathname: string,
  search = "",
): boolean {
  return OWNER_STORY_PROXY_ROUTES.some(
    (route) =>
      route.method === method
      && route.path.test(pathname)
      && ("searches" in route
        ? route.searches.includes(search as never)
        : search === ""),
  );
}

export function parseCookieHeader(header: string): ReadonlyMap<string, string> {
  const cookies = new Map<string, string>();
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = decodeURIComponent(part.slice(separator + 1).trim());
    if (cookies.has(name)) throw new Error("E2E_COOKIE_DUPLICATE");
    cookies.set(name, value);
  }
  return cookies;
}

export function webBuildCommand(platform: NodeJS.Platform): {
  readonly executable: string;
  readonly args: readonly string[];
} {
  const args = ["run", "build", "--workspace", "@hunter/web"] as const;
  return platform === "win32"
    ? {
        executable: "cmd.exe",
        args: ["/d", "/s", "/c", "npm.cmd", ...args],
      }
    : { executable: "npm", args };
}

export function injectBrowserBootstrap(index: string): string {
  const marker = "</head>";
  if (!index.includes(marker)) {
    throw new Error("E2E_WEB_BOOTSTRAP_INJECTION_FAILED");
  }
  return index.replace(
    marker,
    '<script src="/__e2e_bootstrap.js"></script></head>',
  );
}

export async function collectBoundedBody(
  source: AsyncIterable<Uint8Array | string>,
  maximumBytes: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error("E2E_RESPONSE_LIMIT_INVALID");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of source) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBytes) {
      throw new Error("E2E_DAEMON_RESPONSE_TOO_LARGE");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export interface E2eLockOwner {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly nonce: string;
}

export async function acquireFailClosedLock(
  target: string,
  owner: E2eLockOwner,
  protect: FileProtector = protectCurrentUserOnly,
): Promise<void> {
  let handle;
  try {
    handle = await open(target, "wx", 0o600);
  } catch (error) {
    if (
      error !== null
      && typeof error === "object"
      && "code" in error
      && error.code === "EEXIST"
    ) {
      throw new Error("E2E_ACTIVE_LOCK_HELD");
    }
    throw error;
  }
  try {
    await protect(target);
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(target, { force: true });
    throw error;
  }
  await handle.close();
}

export function createMemoizedCleanup(
  steps: readonly (() => void | Promise<void>)[],
): () => Promise<void> {
  let cleanupPromise: Promise<void> | undefined;
  return () => {
    cleanupPromise ??= (async () => {
      let firstError: unknown;
      for (const step of steps) {
        try {
          await step();
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError !== undefined) throw firstError;
    })();
    return cleanupPromise;
  };
}

export function createStartupStopGuard(): {
  readonly requestStop: (error?: unknown) => void;
  readonly throwIfStopRequested: () => void;
  readonly isStopRequested: () => boolean;
  readonly failure: () => unknown;
  readonly signal: AbortSignal;
} {
  const controller = new AbortController();
  let stopRequested = false;
  let startupFailure: unknown;
  return Object.freeze({
    requestStop(error?: unknown): void {
      stopRequested = true;
      startupFailure ??= error;
      if (!controller.signal.aborted) {
        controller.abort(error ?? new Error("E2E_STARTUP_ABORTED"));
      }
    },
    throwIfStopRequested(): void {
      if (!stopRequested) return;
      if (startupFailure !== undefined) throw startupFailure;
      throw new Error("E2E_STARTUP_ABORTED");
    },
    isStopRequested: () => stopRequested,
    failure: () => startupFailure,
    signal: controller.signal,
  });
}

export async function runAbortableStartupOperation<T>(
  stopSignal: AbortSignal,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("E2E_STARTUP_TIMEOUT_INVALID");
  }
  const operationSignal = AbortSignal.any([
    stopSignal,
    AbortSignal.timeout(timeoutMs),
  ]);
  try {
    return await operation(operationSignal);
  } catch (error) {
    if (operationSignal.aborted) {
      throw new Error("E2E_STARTUP_ABORTED");
    }
    throw error;
  }
}

export function parseE2eLockOwner(input: string): E2eLockOwner | null {
  try {
    const value = JSON.parse(input) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !== "nonce,pid,schemaVersion"
      || record.schemaVersion !== 1
      || !Number.isSafeInteger(record.pid)
      || (record.pid as number) <= 0
      || typeof record.nonce !== "string"
      || !/^[a-f0-9]{32}$/u.test(record.nonce)
    ) {
      return null;
    }
    return {
      schemaVersion: 1,
      pid: record.pid as number,
      nonce: record.nonce,
    };
  } catch {
    return null;
  }
}

export function classifyE2eLock(
  input: string,
  isAlive: (pid: number) => boolean,
): "active" | "stale" | "invalid" {
  const owner = parseE2eLockOwner(input);
  if (owner === null) return "invalid";
  return isAlive(owner.pid) ? "active" : "stale";
}

export async function closeOwnedHttpServer(server: {
  close(callback: (error?: Error) => void): unknown;
  closeAllConnections(): void;
}): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error === undefined) resolveClose();
      else rejectClose(error);
    });
    server.closeAllConnections();
  });
}

export function renderBrowserBootstrap(): string {
  return String.raw`(() => {
  "use strict";
  const csrfStorageKey = "${E2E_CSRF_HEADER}";
  const csrfRequestHeader = "x-hunter-e2e-csrf";
  class E2eResponseError extends Error {
    constructor(payload) {
      super(typeof payload?.code === "string" ? payload.code : "E2E_REQUEST_FAILED");
      this.payload = payload;
    }
  }
  const transport = {
    async request(path, init = {}) {
      const headers = new Headers(init.headers);
      headers.set(csrfRequestHeader, localStorage.getItem(csrfStorageKey) ?? "");
      const response = await fetch("/__e2e_api" + path, {
        ...init,
        headers,
        credentials: "same-origin",
      });
      const payload = await response.json();
      if (!response.ok) throw new E2eResponseError(payload);
      if (path.endsWith("/changes") && init.method === "POST") {
        const command = JSON.parse(String(init.body));
        installRunContract({
          executionPlanId: payload.executionPlanId,
          workflowRevisionId: command.tasks[0].workflowRevisionId,
        });
      }
      return payload;
    },
  };
  function installRunContract(plan) {
    const attach = (attempt = 0) => {
      const host = document.querySelector('[aria-label="Change 规划"]');
      if (host === null) {
        if (attempt < 200) {
          setTimeout(() => attach(attempt + 1), 25);
          return;
        }
        const failure = document.createElement("p");
        failure.setAttribute("role", "alert");
        failure.textContent = "E2E_CONTRACT_HOST_NOT_FOUND";
        document.body.append(failure);
        return;
      }
      if (document.querySelector('[data-testid="e2e-run-contract"]') !== null) return;
      const section = document.createElement("section");
      section.dataset.testid = "e2e-run-contract";
      section.className = "panel";
      const note = document.createElement("p");
      note.textContent = "测试契约：仅证明 Hunter 契约，不代表任何真实 Provider 已验证。";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "button button-primary";
      button.textContent = "启动工作流（测试契约）";
      const result = document.createElement("div");
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await transport.request("/runs", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              runId: "run_" + crypto.randomUUID(),
              executionPlanId: plan.executionPlanId,
              workflowRevisionId: plan.workflowRevisionId,
              expectedVersion: 0,
              idempotencyKey: "start-e2e-" + crypto.randomUUID(),
            }),
          });
          result.replaceChildren();
          const execution = document.createElement("p");
          execution.textContent = "Execution: returned";
          const verification = document.createElement("p");
          verification.textContent = "Verification: failed once, then passed";
          const archive = document.createElement("p");
          archive.textContent = "Archive: verified · Knowledge: projected";
          result.append(execution, verification, archive);
        } catch (error) {
          const payload = error instanceof E2eResponseError ? error.payload : {};
          result.replaceChildren();
          const code = document.createElement("p");
          code.textContent = typeof payload.code === "string" ? payload.code : "E2E_REQUEST_FAILED";
          const project = document.createElement("span");
          project.dataset.testid = "project-created-position";
          project.textContent = String(payload.positions?.ProjectCreated ?? "");
          const approval = document.createElement("span");
          approval.dataset.testid = "requirement-approved-position";
          approval.textContent = String(payload.positions?.RequirementRevisionApproved ?? "");
          result.append(code, project, approval);
        }
      });
      section.append(note, button, result);
      host.append(section);
    };
    attach();
  }
  Object.defineProperty(window, "hunterAuthenticatedTransport", {
    value: transport,
    configurable: false,
    enumerable: false,
    writable: false,
  });
})();`;
}
