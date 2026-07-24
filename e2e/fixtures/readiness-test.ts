import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test as base } from "@playwright/test";
import { z } from "zod";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const readinessPath = resolve(repositoryRoot, ".hunter-e2e", "readiness.json");
const ReadinessSchema = z
  .object({
    schemaVersion: z.literal(1),
    webOrigin: z
      .url()
      .refine((value) => {
        const url = new URL(value);
        return url.protocol === "http:"
          && url.hostname === "127.0.0.1"
          && url.port !== "";
      }),
    storageStatePath: z.literal(".hunter-e2e/playwright-state.json"),
  })
  .strict();

async function readReadiness() {
  const parsed = ReadinessSchema.parse(
    JSON.parse(await readFile(readinessPath, "utf8")) as unknown,
  );
  return {
    ...parsed,
    storageStatePath: resolve(repositoryRoot, parsed.storageStatePath),
  };
}

export const test = base.extend({
  baseURL: async ({ browserName: _browserName }, use) => {
    void _browserName;
    const readiness = await readReadiness();
    await use(readiness.webOrigin);
  },
  storageState: async ({ browserName: _browserName }, use) => {
    void _browserName;
    const readiness = await readReadiness();
    await use(readiness.storageStatePath);
  },
});

export { expect };
