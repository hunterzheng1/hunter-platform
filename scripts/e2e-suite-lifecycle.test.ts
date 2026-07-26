import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  prepareE2eSuiteLifecycle,
  type E2eSuiteLifecycleDependencies,
} from "./e2e-suite-lifecycle.js";

const E2E_DIRECTORY = "C:\\repo\\.hunter-e2e";
const WEB_ORIGIN = "http://127.0.0.1:4173";
const COOKIE_VALUE = "a".repeat(64);
const CSRF_VALUE = "b".repeat(64);

function readiness(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    webOrigin: WEB_ORIGIN,
    storageStatePath: ".hunter-e2e/playwright-state.json",
    ...overrides,
  });
}

function storageState(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    cookies: [
      {
        name: "hunter_e2e_session",
        value: COOKIE_VALUE,
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
        origin: WEB_ORIGIN,
        localStorage: [
          {
            name: "hunter-e2e-csrf",
            value: CSRF_VALUE,
          },
        ],
      },
    ],
    ...overrides,
  });
}

function dependencies(
  overrides: Partial<E2eSuiteLifecycleDependencies> = {},
): E2eSuiteLifecycleDependencies {
  const files = new Map([
    [join(E2E_DIRECTORY, "readiness.json"), readiness()],
    [join(E2E_DIRECTORY, "playwright-state.json"), storageState()],
  ]);
  let now = 0;
  return {
    readFile: vi.fn(async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error("ENOENT");
      return value;
    }),
    fetch: vi.fn(async () => ({ status: 202 })),
    lockExists: vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false),
    pause: vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    }),
    monotonicNow: () => now,
    ...overrides,
  };
}

describe("Playwright E2E suite lifecycle", () => {
  it("captures shutdown material before tests and removes the owned lock before Playwright stops the webServer", async () => {
    const deps = dependencies();

    const teardown = await prepareE2eSuiteLifecycle(E2E_DIRECTORY, deps);
    await teardown();

    expect(deps.readFile).toHaveBeenCalledTimes(2);
    expect(deps.fetch).toHaveBeenCalledWith(
      `${WEB_ORIGIN}/__e2e_shutdown`,
      {
        method: "POST",
        cache: "no-store",
        redirect: "error",
        headers: {
          cookie: `hunter_e2e_session=${COOKIE_VALUE}`,
          "x-hunter-e2e-csrf": CSRF_VALUE,
        },
        signal: expect.any(AbortSignal),
      },
    );
    expect(deps.lockExists).toHaveBeenCalledWith(
      join(E2E_DIRECTORY, "active.lock"),
    );
    expect(deps.pause).toHaveBeenCalledOnce();
  });

  it("fails closed with a fixed code when readiness or browser state is not the exact launcher format", async () => {
    const invalidReadiness = dependencies({
      readFile: vi.fn(async (path: string) =>
        path.endsWith("readiness.json")
          ? readiness({ credential: "must-not-appear" })
          : storageState()),
    });

    await expect(
      prepareE2eSuiteLifecycle(E2E_DIRECTORY, invalidReadiness),
    ).rejects.toThrowError("E2E_SUITE_MATERIAL_INVALID");
    expect(invalidReadiness.fetch).not.toHaveBeenCalled();
  });

  it("replaces request failures and non-202 responses with credential-free fixed codes", async () => {
    const requestFailure = dependencies({
      fetch: vi.fn(async () => {
        throw new Error(COOKIE_VALUE);
      }),
    });
    const failedTeardown = await prepareE2eSuiteLifecycle(
      E2E_DIRECTORY,
      requestFailure,
    );
    await expect(failedTeardown()).rejects.toThrowError(
      "E2E_SUITE_SHUTDOWN_REQUEST_FAILED",
    );

    const rejected = dependencies({
      fetch: vi.fn(async () => ({ status: 401 })),
    });
    const rejectedTeardown = await prepareE2eSuiteLifecycle(
      E2E_DIRECTORY,
      rejected,
    );
    await expect(rejectedTeardown()).rejects.toThrowError(
      "E2E_SUITE_SHUTDOWN_REJECTED",
    );
  });

  it("uses condition polling and fails closed when the launcher does not release its lock", async () => {
    let now = 0;
    const deps = dependencies({
      lockExists: vi.fn(async () => true),
      pause: vi.fn(async (milliseconds: number) => {
        now += milliseconds;
      }),
      monotonicNow: () => now,
    });
    const teardown = await prepareE2eSuiteLifecycle(E2E_DIRECTORY, deps);

    await expect(teardown()).rejects.toThrowError(
      "E2E_SUITE_SHUTDOWN_TIMEOUT",
    );
    expect(deps.pause).toHaveBeenCalled();
  });
});
