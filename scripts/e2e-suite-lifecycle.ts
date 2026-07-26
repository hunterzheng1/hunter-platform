import { access, readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  E2E_CSRF_HEADER,
  E2E_SESSION_COOKIE,
} from "./e2e-runtime.js";

const WEB_ORIGIN = "http://127.0.0.1:4173";
const SHUTDOWN_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 50;
const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

const OpaqueValueSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const ReadinessSchema = z
  .object({
    schemaVersion: z.literal(1),
    webOrigin: z.literal(WEB_ORIGIN),
    storageStatePath: z.literal(".hunter-e2e/playwright-state.json"),
  })
  .strict();
const StorageStateSchema = z
  .object({
    cookies: z
      .array(
        z
          .object({
            name: z.literal(E2E_SESSION_COOKIE),
            value: OpaqueValueSchema,
            domain: z.literal("127.0.0.1"),
            path: z.literal("/"),
            expires: z.literal(-1),
            httpOnly: z.literal(true),
            secure: z.literal(false),
            sameSite: z.literal("Strict"),
          })
          .strict(),
      )
      .length(1),
    origins: z
      .array(
        z
          .object({
            origin: z.literal(WEB_ORIGIN),
            localStorage: z
              .array(
                z
                  .object({
                    name: z.literal(E2E_CSRF_HEADER),
                    value: OpaqueValueSchema,
                  })
                  .strict(),
              )
              .length(1),
          })
          .strict(),
      )
      .length(1),
  })
  .strict();

export interface E2eSuiteLifecycleDependencies {
  readonly readFile: (path: string) => Promise<string>;
  readonly fetch: (
    input: string,
    init: RequestInit,
  ) => Promise<{ readonly status: number }>;
  readonly lockExists: (path: string) => Promise<boolean>;
  readonly pause: (milliseconds: number) => Promise<void>;
  readonly monotonicNow: () => number;
}

export async function prepareE2eSuiteLifecycle(
  e2eDirectory: string,
  dependencies: E2eSuiteLifecycleDependencies,
): Promise<() => Promise<void>> {
  let readiness: z.infer<typeof ReadinessSchema>;
  let state: z.infer<typeof StorageStateSchema>;
  try {
    const [readinessText, stateText] = await Promise.all([
      dependencies.readFile(join(e2eDirectory, "readiness.json")),
      dependencies.readFile(join(e2eDirectory, "playwright-state.json")),
    ]);
    readiness = ReadinessSchema.parse(
      JSON.parse(readinessText) as unknown,
    );
    state = StorageStateSchema.parse(JSON.parse(stateText) as unknown);
  } catch {
    throw new Error("E2E_SUITE_MATERIAL_INVALID");
  }

  const lockPath = join(e2eDirectory, "active.lock");
  const cookieValue = state.cookies[0]!.value;
  const csrfValue = state.origins[0]!.localStorage[0]!.value;
  let teardownPromise: Promise<void> | undefined;

  return () => {
    teardownPromise ??= (async () => {
      if (!(await dependencies.lockExists(lockPath))) return;

      let response: { readonly status: number };
      try {
        response = await dependencies.fetch(
          `${readiness.webOrigin}/__e2e_shutdown`,
          {
            method: "POST",
            cache: "no-store",
            redirect: "error",
            headers: {
              cookie: `${E2E_SESSION_COOKIE}=${cookieValue}`,
              "x-hunter-e2e-csrf": csrfValue,
            },
            signal: AbortSignal.timeout(SHUTDOWN_TIMEOUT_MS),
          },
        );
      } catch {
        throw new Error("E2E_SUITE_SHUTDOWN_REQUEST_FAILED");
      }
      if (response.status !== 202) {
        throw new Error("E2E_SUITE_SHUTDOWN_REJECTED");
      }

      const deadline = dependencies.monotonicNow() + SHUTDOWN_TIMEOUT_MS;
      while (await dependencies.lockExists(lockPath)) {
        if (dependencies.monotonicNow() >= deadline) {
          throw new Error("E2E_SUITE_SHUTDOWN_TIMEOUT");
        }
        await dependencies.pause(POLL_INTERVAL_MS);
      }
    })();
    return teardownPromise;
  };
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  return prepareE2eSuiteLifecycle(
    resolve(repositoryRoot, ".hunter-e2e"),
    {
      readFile: (path) => readFile(path, "utf8"),
      fetch: (input, init) => fetch(input, init),
      lockExists: async (path) => {
        try {
          await access(path);
          return true;
        } catch (error) {
          if (
            error !== null
            && typeof error === "object"
            && "code" in error
            && error.code === "ENOENT"
          ) {
            return false;
          }
          throw new Error("E2E_SUITE_LOCK_CHECK_FAILED");
        }
      },
      pause: (milliseconds) =>
        new Promise((resolvePause) => {
          setTimeout(resolvePause, milliseconds);
        }),
      monotonicNow: () => performance.now(),
    },
  );
}
