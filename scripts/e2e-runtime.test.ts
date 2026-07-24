import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  acquireFailClosedLock,
  E2E_CSRF_HEADER,
  E2E_SESSION_COOKIE,
  assertOwnedTemporaryDirectory,
  atomicWriteE2eReadiness,
  atomicWritePlaywrightState,
  classifyE2eLock,
  closeOwnedHttpServer,
  collectBoundedBody,
  createMemoizedCleanup,
  createBrowserSession,
  createStartupStopGuard,
  injectBrowserBootstrap,
  isAllowedE2eProxyRequest,
  parseCookieHeader,
  renderBrowserBootstrap,
  runAbortableStartupOperation,
  webBuildCommand,
} from "./e2e-runtime.js";

describe("E2E runtime security boundary", () => {
  it("creates separate opaque cookie and CSRF values without a bearer credential", () => {
    const session = createBrowserSession(() => Buffer.alloc(32, 7));

    expect(session.cookieValue).toMatch(/^[a-f0-9]{64}$/u);
    expect(session.csrfValue).toMatch(/^[a-f0-9]{64}$/u);
    expect(session.cookieValue).not.toBe(session.csrfValue);
    expect(JSON.stringify(session)).not.toMatch(/bearer|authorization/iu);
  });

  it("writes Playwright state atomically with HttpOnly cookie and invokes the platform protector", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hunter-e2e-state-unit-"));
    const target = join(directory, "playwright-state.json");
    const protect = vi.fn(async (path: string) => {
      expect((await stat(path)).size).toBe(0);
    });
    const session = createBrowserSession(() => Buffer.alloc(32, 9));

    try {
      await atomicWritePlaywrightState(target, session, protect);

      const parsed = JSON.parse(await readFile(target, "utf8")) as {
        cookies: Array<Record<string, unknown>>;
        origins: Array<{ localStorage: Array<{ name: string; value: string }> }>;
      };
      expect(parsed.cookies).toEqual([
        expect.objectContaining({
          name: E2E_SESSION_COOKIE,
          value: session.cookieValue,
          httpOnly: true,
          sameSite: "Strict",
          secure: false,
        }),
      ]);
      expect(parsed.origins[0]?.localStorage).toContainEqual({
        name: E2E_CSRF_HEADER,
        value: session.csrfValue,
      });
      expect(await stat(target)).toMatchObject({ mode: expect.any(Number) });
      expect(protect).toHaveBeenCalledOnce();
      expect(protect.mock.calls[0]?.[0]).not.toBe(target);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("publishes a credential-free versioned readiness file atomically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hunter-e2e-readiness-unit-"));
    const target = join(directory, "readiness.json");
    const protect = vi.fn(async () => undefined);
    try {
      await atomicWriteE2eReadiness(target, {
        schemaVersion: 1,
        webOrigin: "http://127.0.0.1:4173",
        storageStatePath: ".hunter-e2e/playwright-state.json",
      }, protect);
      const text = await readFile(target, "utf8");
      expect(JSON.parse(text)).toEqual({
        schemaVersion: 1,
        webOrigin: "http://127.0.0.1:4173",
        storageStatePath: ".hunter-e2e/playwright-state.json",
      });
      expect(text).not.toMatch(/authorization|bearer|cookie|csrf|token/iu);
      expect(protect).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("renders a same-origin transport that never embeds a bearer token", () => {
    const script = renderBrowserBootstrap("wfr_e2eroot0001");

    expect(script).toContain("/__e2e_api");
    expect(script).toContain(E2E_CSRF_HEADER);
    expect(script).toContain(
      'const rootWorkflowRevisionId = "wfr_e2eroot0001";',
    );
    expect(script).not.toContain("command.tasks[0].workflowRevisionId");
    expect(script).toContain("启动工作流（测试契约）");
    expect(script).toContain("E2E_CONTRACT_HOST_NOT_FOUND");
    expect(script).toContain("attempt < 200");
    expect(script).toContain("setTimeout(() => attach(attempt + 1), 25)");
    expect(script).not.toMatch(/Bearer\s+[A-Za-z0-9._-]+/u);
    expect(script).not.toContain("authorization");
  });

  it("rejects cleanup outside the exact owned mkdtemp prefix on both supported path families", () => {
    expect(() =>
      assertOwnedTemporaryDirectory(
        "C:\\private",
        "C:\\Temp\\hunter-e2e-data-123",
        "win32",
      ),
    ).toThrowError("E2E_TEMP_DIRECTORY_NOT_OWNED");
    expect(() =>
      assertOwnedTemporaryDirectory(
        "C:\\Temp\\hunter-e2e-data-",
        "C:\\Temp\\hunter-e2e-data-123",
        "win32",
      ),
    ).not.toThrow();
    expect(() =>
      assertOwnedTemporaryDirectory(
        "C:\\Temp\\hunter-e2e-data-",
        "C:\\Temp\\nested\\hunter-e2e-data-123",
        "win32",
      ),
    ).toThrowError("E2E_TEMP_DIRECTORY_NOT_OWNED");
    expect(() =>
      assertOwnedTemporaryDirectory(
        "C:\\TEMP\\hunter-e2e-data-",
        "c:\\temp\\hunter-e2e-data-123",
        "win32",
      ),
    ).not.toThrow();
    expect(() =>
      assertOwnedTemporaryDirectory(
        "/tmp/hunter-e2e-data-",
        "/tmp/hunter-e2e-data-123",
        "linux",
      ),
    ).not.toThrow();
    expect(() =>
      assertOwnedTemporaryDirectory(
        "/tmp/hunter-e2e-data-",
        "/tmp/nested/hunter-e2e-data-123",
        "linux",
      ),
    ).toThrowError("E2E_TEMP_DIRECTORY_NOT_OWNED");
  });

  it("allows only the owner-story daemon surface and parses exact cookies", () => {
    expect(isAllowedE2eProxyRequest("GET", "/api/v1/projects")).toBe(true);
    expect(
      isAllowedE2eProxyRequest(
        "POST",
        "/api/v1/projects/prj_e2econtract01/requirements",
      ),
    ).toBe(true);
    expect(
      isAllowedE2eProxyRequest(
        "GET",
        "/api/v1/projects/prj_e2econtract01/knowledge",
        "?includeHistorical=true",
      ),
    ).toBe(true);
    expect(
      isAllowedE2eProxyRequest(
        "GET",
        "/api/v1/projects/prj_e2econtract01/knowledge",
        "?includeHistorical=all",
      ),
    ).toBe(false);
    expect(isAllowedE2eProxyRequest("POST", "/runs")).toBe(true);
    expect(isAllowedE2eProxyRequest("GET", "/health")).toBe(false);
    expect(isAllowedE2eProxyRequest("POST", "/pair")).toBe(false);
    expect(isAllowedE2eProxyRequest("GET", "/events")).toBe(false);
    expect(parseCookieHeader("a=1; hunter_e2e_session=opaque%20value")).toEqual(
      new Map([
        ["a", "1"],
        ["hunter_e2e_session", "opaque value"],
      ]),
    );
  });

  it("uses cmd.exe only as a fixed Windows npm launcher", () => {
    expect(webBuildCommand("win32")).toEqual({
      executable: "cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        "npm.cmd",
        "run",
        "build",
        "--workspace",
        "@hunter/web",
      ],
    });
    expect(webBuildCommand("linux")).toEqual({
      executable: "npm",
      args: ["run", "build", "--workspace", "@hunter/web"],
    });
  });

  it("fails closed when the built Web document has no head injection point", () => {
    expect(injectBrowserBootstrap("<html><head></head><body /></html>")).toBe(
      '<html><head><script src="/__e2e_bootstrap.js"></script></head><body /></html>',
    );
    expect(() => injectBrowserBootstrap("<html><body /></html>")).toThrowError(
      "E2E_WEB_BOOTSTRAP_INJECTION_FAILED",
    );
  });

  it("caps daemon response bytes", async () => {
    await expect(
      collectBoundedBody(Readable.from([Buffer.from("ok")]), 2),
    ).resolves.toEqual(Buffer.from("ok"));
    await expect(
      collectBoundedBody(
        Readable.from([Buffer.from("too"), Buffer.from("large")]),
        4,
      ),
    ).rejects.toThrowError("E2E_DAEMON_RESPONSE_TOO_LARGE");
  });

  it("classifies only strict launcher locks and never guesses malformed ownership", () => {
    const lock = JSON.stringify({
      schemaVersion: 1,
      pid: 123,
      nonce: "a".repeat(32),
    });
    expect(classifyE2eLock(lock, () => true)).toBe("active");
    expect(classifyE2eLock(lock, () => false)).toBe("stale");
    expect(classifyE2eLock("active\n", () => false)).toBe("invalid");
    expect(
      classifyE2eLock(
        JSON.stringify({ schemaVersion: 1, pid: 123, nonce: "../unsafe" }),
        () => false,
      ),
    ).toBe("invalid");
  });

  it("allows exactly one of three interleaved launchers to create active.lock and never takes over an existing lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hunter-e2e-lock-unit-"));
    const target = join(directory, "active.lock");
    const owners = [101, 102, 103].map((pid, index) => ({
      schemaVersion: 1 as const,
      pid,
      nonce: String(index + 1).repeat(32),
    }));

    try {
      const outcomes = await Promise.allSettled(
        owners.map((owner) =>
          acquireFailClosedLock(target, owner, async () => undefined),
        ),
      );
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(2);
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          expect(outcome.reason).toEqual(new Error("E2E_ACTIVE_LOCK_HELD"));
        }
      }

      const stored = JSON.parse(await readFile(target, "utf8")) as {
        readonly pid: number;
        readonly nonce: string;
      };
      expect(owners).toContainEqual(expect.objectContaining(stored));
      await expect(
        acquireFailClosedLock(
          target,
          {
            schemaVersion: 1,
            pid: 999_999,
            nonce: "f".repeat(32),
          },
          async () => undefined,
        ),
      ).rejects.toThrowError("E2E_ACTIVE_LOCK_HELD");
      expect(JSON.parse(await readFile(target, "utf8"))).toMatchObject(stored);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("memoizes cleanup while still attempting every cleanup step after a failure", async () => {
    const calls: string[] = [];
    const cleanup = createMemoizedCleanup([
      async () => {
        calls.push("server");
        throw new Error("SERVER_CLOSE_FAILED");
      },
      async () => {
        calls.push("state");
      },
      async () => {
        calls.push("lock");
      },
    ]);

    const first = cleanup();
    const second = cleanup();

    expect(first).toBe(second);
    await expect(first).rejects.toThrowError("SERVER_CLOSE_FAILED");
    expect(calls).toEqual(["server", "state", "lock"]);
    await expect(cleanup()).rejects.toThrowError("SERVER_CLOSE_FAILED");
    expect(calls).toEqual(["server", "state", "lock"]);
  });

  it("stops initialization at the next checkpoint when a signal arrives during state creation", async () => {
    const guard = createStartupStopGuard();
    const created: string[] = [];
    let finishStateWrite: (() => void) | undefined;
    const stateWrite = new Promise<void>((resolveStateWrite) => {
      finishStateWrite = resolveStateWrite;
    });
    const initialization = (async () => {
      created.push("temporary-directory");
      guard.throwIfStopRequested();
      await stateWrite;
      created.push("state");
      guard.throwIfStopRequested();
      created.push("database");
    })();

    guard.requestStop();
    finishStateWrite?.();

    await expect(initialization).rejects.toThrowError("E2E_STARTUP_ABORTED");
    expect(created).toEqual(["temporary-directory", "state"]);
  });

  it("aborts a startup operation that never completes on its own", async () => {
    const guard = createStartupStopGuard();
    const operation = runAbortableStartupOperation(
      guard.signal,
      10_000,
      async (signal) =>
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true },
          );
        }),
    );

    guard.requestStop();

    await expect(operation).rejects.toThrowError("E2E_STARTUP_ABORTED");
  });

  it("closes owned HTTP connections so browser keep-alive cannot strand the lock", async () => {
    let finish: (() => void) | undefined;
    const server = {
      close: vi.fn((callback: () => void) => {
        finish = callback;
      }),
      closeAllConnections: vi.fn(() => finish?.()),
    };

    await closeOwnedHttpServer(server);

    expect(server.close).toHaveBeenCalledOnce();
    expect(server.closeAllConnections).toHaveBeenCalledOnce();
  });
});
