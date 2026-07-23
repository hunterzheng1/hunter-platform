import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createReadStream,
} from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import {
  dirname,
  extname,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

import { ProjectIdSchema } from "@hunter/domain";
import { createVerticalSliceFixture } from "../e2e/fixtures/fake-runtime-scenario.js";
import { createE2eDaemonComposition } from "./e2e-application.js";
import {
  E2E_SESSION_COOKIE,
  acquireFailClosedLock,
  assertOwnedTemporaryDirectory,
  atomicWritePlaywrightState,
  collectBoundedBody,
  closeOwnedHttpServer,
  createBrowserSession,
  createMemoizedCleanup,
  createStartupStopGuard,
  injectBrowserBootstrap,
  isAllowedE2eProxyRequest,
  parseCookieHeader,
  parseE2eLockOwner,
  protectCurrentUserOnly,
  renderBrowserBootstrap,
  runAbortableStartupOperation,
  webBuildCommand,
} from "./e2e-runtime.js";

const executeFile = promisify(execFile);
const WEB_HOST = "127.0.0.1";
const WEB_PORT = 4173;
const WEB_ORIGIN = `http://${WEB_HOST}:${WEB_PORT}`;
const MAX_PROXY_BODY = 64 * 1024;
const MAX_DAEMON_RESPONSE = 64 * 1024;
const DAEMON_REQUEST_TIMEOUT_MS = 10_000;
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(moduleDirectory, "..");
const e2eDirectory = join(repositoryRoot, ".hunter-e2e");
const statePath = join(e2eDirectory, "playwright-state.json");
const lockPath = join(e2eDirectory, "active.lock");
const webDist = join(repositoryRoot, "apps", "web", "dist");

function equalSecret(left: string | undefined, right: string): boolean {
  if (left === undefined) return false;
  const received = Buffer.from(left);
  const expected = Buffer.from(right);
  return (
    received.length === expected.length
    && timingSafeEqual(received, expected)
  );
}

async function acquireExclusiveLock(): Promise<{
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly nonce: string;
}> {
  await mkdir(e2eDirectory, { recursive: true });
  const owner = {
    schemaVersion: 1 as const,
    pid: process.pid,
    nonce: randomBytes(16).toString("hex"),
  };
  await acquireFailClosedLock(lockPath, owner, protectCurrentUserOnly);
  return owner;
}

async function releaseOwnedLock(owner: {
  readonly pid: number;
  readonly nonce: string;
}): Promise<void> {
  const stored = parseE2eLockOwner(
    await readFile(lockPath, "utf8").catch(() => ""),
  );
  if (stored?.pid === owner.pid && stored.nonce === owner.nonce) {
    await rm(lockPath, { force: true });
  }
}

async function buildWebAssets(stopSignal: AbortSignal): Promise<void> {
  const command = webBuildCommand(process.platform);
  try {
    await runAbortableStartupOperation(
      stopSignal,
      120_000,
      async (signal) =>
        await executeFile(
          command.executable,
          [...command.args],
          {
            cwd: repositoryRoot,
            encoding: "utf8",
            windowsHide: true,
            maxBuffer: 2 * 1024 * 1024,
            signal,
          },
        ),
    );
  } catch (error) {
    if (
      error instanceof Error
      && error.message === "E2E_STARTUP_ABORTED"
    ) {
      throw error;
    }
    throw new Error("E2E_WEB_BUILD_FAILED");
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_PROXY_BODY) throw new Error("E2E_PROXY_BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".webmanifest":
      return "application/manifest+json";
    default:
      return "application/octet-stream";
  }
}

function safeStaticFile(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const candidate = resolve(webDist, decoded.replace(/^\/+/u, ""));
  const distance = relative(webDist, candidate);
  if (
    distance === ""
    || distance.startsWith("..")
    || resolve(webDist, distance) !== candidate
  ) {
    return null;
  }
  return candidate;
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("cache-control", "no-store");
}

async function proxyToDaemon(input: {
  readonly browserRequest: IncomingMessage;
  readonly browserResponse: ServerResponse;
  readonly pathname: string;
  readonly daemonPort: number;
  readonly daemonHostHeader: string;
  readonly daemonCsrf: string;
  readonly browserSession: {
    readonly cookieValue: string;
    readonly csrfValue: string;
  };
  readonly getCredential: () => string;
  readonly onAuthenticated: () => Promise<void>;
  readonly onProjectCreated: (projectId: string) => void;
}): Promise<void> {
  const method = input.browserRequest.method ?? "";
  if (!isAllowedE2eProxyRequest(method, input.pathname)) {
    input.browserResponse.writeHead(404).end();
    return;
  }
  let cookies: ReadonlyMap<string, string>;
  try {
    cookies = parseCookieHeader(input.browserRequest.headers.cookie ?? "");
  } catch {
    input.browserResponse.writeHead(401).end();
    return;
  }
  const session = cookies.get(E2E_SESSION_COOKIE);
  const csrfHeader = input.browserRequest.headers["x-hunter-e2e-csrf"];
  const browserCsrf =
    typeof csrfHeader === "string" ? csrfHeader : undefined;
  if (
    !equalSecret(session, input.browserSession.cookieValue)
    || !equalSecret(browserCsrf, input.browserSession.csrfValue)
  ) {
    input.browserResponse.writeHead(401).end();
    return;
  }
  await input.onAuthenticated();
  const body = method === "POST" ? await readBody(input.browserRequest) : Buffer.alloc(0);
  const daemonResponse = await new Promise<{
    readonly statusCode: number;
    readonly headers: Readonly<Record<string, string | string[] | undefined>>;
    readonly body: Buffer;
  }>((resolveResponse, rejectResponse) => {
    const forwarded = httpRequest(
      {
        hostname: WEB_HOST,
        port: input.daemonPort,
        method,
        path: input.pathname,
        headers: {
          host: input.daemonHostHeader,
          origin: WEB_ORIGIN,
          authorization: `Bearer ${input.getCredential()}`,
          "x-csrf-token": input.daemonCsrf,
          ...(method === "POST"
            ? {
                "content-type": "application/json",
                "content-length": body.length,
              }
            : {}),
        },
        timeout: DAEMON_REQUEST_TIMEOUT_MS,
      },
      (response) => {
        void collectBoundedBody(response, MAX_DAEMON_RESPONSE)
          .then((responseBody) => resolveResponse({
            statusCode: response.statusCode ?? 500,
            headers: response.headers,
            body: responseBody,
          }))
          .catch((error: unknown) => {
            response.destroy();
            forwarded.destroy();
            rejectResponse(error);
          });
      },
    );
    forwarded.on("error", rejectResponse);
    forwarded.on("timeout", () => {
      forwarded.destroy(new Error("E2E_DAEMON_REQUEST_TIMEOUT"));
    });
    if (body.length > 0) forwarded.write(body);
    forwarded.end();
  });
  if (
    method === "POST"
    && input.pathname === "/api/v1/projects"
    && daemonResponse.statusCode === 201
  ) {
    const payload = JSON.parse(daemonResponse.body.toString("utf8")) as {
      readonly projectId?: string;
    };
    if (typeof payload.projectId === "string") {
      input.onProjectCreated(payload.projectId);
    }
  }
  input.browserResponse.statusCode = daemonResponse.statusCode;
  input.browserResponse.setHeader(
    "content-type",
    typeof daemonResponse.headers["content-type"] === "string"
      ? daemonResponse.headers["content-type"]
      : "application/json; charset=utf-8",
  );
  securityHeaders(input.browserResponse);
  input.browserResponse.end(daemonResponse.body);
}

export async function runE2eLauncher(options: {
  readonly selfCheck: boolean;
  readonly verify: boolean;
}): Promise<void> {
  if (options.verify) {
    throw new Error("E2E_VERIFY_NOT_AVAILABLE_UNTIL_TASK_19");
  }
  let database: DatabaseSync | undefined;
  let composition:
    | ReturnType<typeof createE2eDaemonComposition>
    | undefined;
  let webServer: ReturnType<typeof createServer> | undefined;
  let dataDirectory: string | undefined;
  const dataPrefix = join(tmpdir(), "hunter-e2e-data-");
  const lockOwner = await acquireExclusiveLock();
  let stopResolve: (() => void) | undefined;
  const stopped = new Promise<void>((resolveStopped) => {
    stopResolve = resolveStopped;
  });
  const startupStop = createStartupStopGuard();
  function onSignal(): void {
    requestStop();
  }
  const cleanup = createMemoizedCleanup([
    async () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    },
    async () => {
      if (webServer !== undefined) await closeOwnedHttpServer(webServer);
    },
    async () => {
      if (composition !== undefined) await composition.app.close();
    },
    async () => {
      if (database !== undefined) database.close();
    },
    async () => {
      await rm(statePath, { force: true });
    },
    async () => {
      await releaseOwnedLock(lockOwner);
    },
    async () => {
      if (dataDirectory !== undefined) {
        assertOwnedTemporaryDirectory(dataPrefix, dataDirectory);
        await rm(dataDirectory, { recursive: true, force: true });
      }
    },
  ]);
  const requestStop = (error?: unknown) => {
    startupStop.requestStop(error);
    stopResolve?.();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    dataDirectory = await mkdtemp(dataPrefix);
    startupStop.throwIfStopRequested();
    assertOwnedTemporaryDirectory(dataPrefix, dataDirectory);
    await buildWebAssets(startupStop.signal);
    startupStop.throwIfStopRequested();
    const browserSession = createBrowserSession();
    await atomicWritePlaywrightState(statePath, browserSession);
    startupStop.throwIfStopRequested();
    database = new DatabaseSync(join(dataDirectory, "hunter.sqlite"));
    const allowedHosts: string[] = [];
    composition = createE2eDaemonComposition({
      database,
      fixture: createVerticalSliceFixture(),
      installSecret: randomBytes(32).toString("hex"),
      dataDirectory,
      allowedHosts,
      allowedOrigins: [WEB_ORIGIN],
    });
    await composition.services.recovery.run();
    startupStop.throwIfStopRequested();
    await composition.app.listen({ host: WEB_HOST, port: 0 });
    startupStop.throwIfStopRequested();
    const address = composition.app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("E2E_DAEMON_ADDRESS_INVALID");
    }
    const daemonPort = address.port;
    const daemonHostHeader = `${WEB_HOST}:${daemonPort}`;
    allowedHosts.push(daemonHostHeader);
    const activeComposition = composition;
    let daemonCredential = activeComposition.issueSession([]);
    const indexTemplate = await readFile(join(webDist, "index.html"), "utf8");
    startupStop.throwIfStopRequested();
    const index = injectBrowserBootstrap(indexTemplate);
    let ready = false;
    webServer = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? "/", WEB_ORIGIN);
        if (url.pathname === "/__e2e_ready") {
          securityHeaders(response);
          response.statusCode = ready ? 200 : 503;
          response.setHeader("content-type", "application/json; charset=utf-8");
          response.end(JSON.stringify({ status: ready ? "ready" : "starting" }));
          return;
        }
        if (url.pathname === "/__e2e_bootstrap.js") {
          securityHeaders(response);
          response.statusCode = 200;
          response.setHeader("content-type", "text/javascript; charset=utf-8");
          response.end(renderBrowserBootstrap());
          return;
        }
        if (url.pathname === "/__e2e_shutdown") {
          let cookies: ReadonlyMap<string, string>;
          try {
            cookies = parseCookieHeader(request.headers.cookie ?? "");
          } catch {
            response.writeHead(401).end();
            return;
          }
          const csrfHeader = request.headers["x-hunter-e2e-csrf"];
          const browserCsrf =
            typeof csrfHeader === "string" ? csrfHeader : undefined;
          if (
            request.method !== "POST"
            || !equalSecret(
              cookies.get(E2E_SESSION_COOKIE),
              browserSession.cookieValue,
            )
            || !equalSecret(browserCsrf, browserSession.csrfValue)
          ) {
            response.writeHead(401).end();
            return;
          }
          securityHeaders(response);
          response.statusCode = 202;
          response.once("finish", () => {
            setImmediate(requestStop);
          });
          response.end();
          return;
        }
        if (url.pathname.startsWith("/__e2e_api")) {
          await proxyToDaemon({
            browserRequest: request,
            browserResponse: response,
            pathname: url.pathname.slice("/__e2e_api".length) || "/",
            daemonPort,
            daemonHostHeader,
            daemonCsrf: activeComposition.daemonCsrf,
            browserSession,
            getCredential: () => daemonCredential,
            onAuthenticated: async () => {
              await rm(statePath, { force: true });
            },
            onProjectCreated: (projectId) => {
              daemonCredential = activeComposition.issueSession([
                ProjectIdSchema.parse(projectId),
              ]);
            },
          });
          return;
        }
        const staticFile = safeStaticFile(url.pathname);
        const fileInfo =
          staticFile === null
            ? null
            : await stat(staticFile).catch((error: unknown) => {
                if (
                  error !== null
                  && typeof error === "object"
                  && "code" in error
                  && error.code === "ENOENT"
                ) {
                  return null;
                }
                throw error;
              });
        if (staticFile !== null && fileInfo?.isFile() === true) {
          securityHeaders(response);
          response.statusCode = 200;
          response.setHeader("content-type", contentType(staticFile));
          await new Promise<void>((resolveStream, rejectStream) => {
            const stream = createReadStream(staticFile);
            stream.once("error", rejectStream);
            response.once("finish", resolveStream);
            stream.pipe(response);
          });
          return;
        }
        securityHeaders(response);
        response.statusCode = 200;
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(index);
      })().catch((error: unknown) => {
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : undefined);
          return;
        }
        if (!response.headersSent) {
          securityHeaders(response);
          response.statusCode = 500;
          response.setHeader("content-type", "application/json; charset=utf-8");
        }
        const fixedCode =
          error instanceof Error
          && [
            "E2E_PROXY_BODY_TOO_LARGE",
            "E2E_DAEMON_RESPONSE_TOO_LARGE",
            "E2E_DAEMON_REQUEST_TIMEOUT",
          ].includes(error.message)
            ? error.message
            : "E2E_TEST_SERVER_ERROR";
        response.end(JSON.stringify({ code: fixedCode }));
      });
    });
    webServer.on("error", (error) => {
      if ("code" in error && error.code === "EADDRINUSE") {
        requestStop(error);
      }
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: NodeJS.ErrnoException) => {
        webServer?.off("listening", onListening);
        rejectListen(
          error.code === "EADDRINUSE"
            ? new Error("E2E_PORT_4173_UNAVAILABLE")
            : error,
        );
      };
      const onListening = () => {
        webServer?.off("error", onError);
        resolveListen();
      };
      webServer?.once("error", onError);
      webServer?.once("listening", onListening);
      webServer?.listen(WEB_PORT, WEB_HOST);
    });
    startupStop.throwIfStopRequested();
    ready = true;

    if (options.selfCheck) {
      const response = await fetch(`${WEB_ORIGIN}/__e2e_ready`);
      startupStop.throwIfStopRequested();
      if (!response.ok) throw new Error("E2E_SELF_CHECK_FAILED");
      process.stdout.write("E2E_SELF_CHECK_READY\n");
      return;
    }
    await stopped;
    const stopFailure = startupStop.failure();
    if (stopFailure !== undefined) throw stopFailure;
  } catch (error) {
    if (
      !(
        startupStop.isStopRequested()
        && error instanceof Error
        && error.message === "E2E_STARTUP_ABORTED"
      )
    ) {
      throw error;
    }
  } finally {
    await cleanup();
  }
}
