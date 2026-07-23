import { mkdir, readFile, copyFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const desktopDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = join(desktopDirectory, "..", "..");
const preloadOutput = join(desktopDirectory, "dist", "preload.cjs");
const daemonOutputDirectory = join(desktopDirectory, "dist-sidecar");
const daemonOutput = join(daemonOutputDirectory, "main.cjs");

await mkdir(dirname(preloadOutput), { recursive: true });
await build({
  entryPoints: [join(desktopDirectory, "src", "preload.ts")],
  outfile: preloadOutput,
  bundle: true,
  format: "iife",
  platform: "node",
  target: "node22",
  external: ["electron"],
  sourcemap: false,
});

const preloadBundle = await readFile(preloadOutput, "utf8");
if (
  preloadBundle.includes("node:crypto")
  || preloadBundle.includes("node:fs")
  || preloadBundle.includes("child_process")
) {
  throw new Error("SANDBOX_PRELOAD_FORBIDDEN_IMPORT");
}

await rm(daemonOutputDirectory, { recursive: true, force: true });
await mkdir(join(daemonOutputDirectory, "migrations"), { recursive: true });
await build({
  entryPoints: [
    join(repositoryRoot, "apps", "daemon", "src", "protected-main.ts"),
  ],
  outfile: daemonOutput,
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node24",
  sourcemap: false,
});
await copyFile(
  join(
    repositoryRoot,
    "packages",
    "storage",
    "src",
    "migrations",
    "001-core.sql",
  ),
  join(daemonOutputDirectory, "migrations", "001-core.sql"),
);
