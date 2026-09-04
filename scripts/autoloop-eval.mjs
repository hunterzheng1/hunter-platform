#!/usr/bin/env node
/**
 * AutoLoop evaluator for hunter-platform simplification research.
 *
 * Emits METRIC lines (metric_lines format) for the autoloop CLI.
 *
 * Metric: platform_loc — total non-blank, non-comment lines of TypeScript
 * production source under apps/server/src + apps/web (components, app, lib —
 * excluding tests). Direction: lower. This is a *research candidate* metric,
 * not a score; the semantic layer (researcher judgment + code evidence per
 * the simplification-analysis doc) must confirm real simplification.
 *
 * Guardrail mode (--guardrail): exit 0 iff typecheck passes. The full test
 * suite is run by the researcher outside autoloop per batch (too slow for
 * per-experiment use); see .autoloop/config.toml.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Production source roots counted by the metric. */
const SOURCE_ROOTS = [
  "apps/server/src",
  "apps/web/components",
  "apps/web/app",
  "apps/web/lib",
];

/** Web directories that are not production source. */
const WEB_EXCLUDES = new Set(["test", "tests", "__tests__"]);

function isCommentLine(line) {
  const stripped = line.trim();
  return stripped === "" || stripped.startsWith("//") || stripped.startsWith("/*") || stripped.startsWith("*");
}

function walk(dir, predicate) {
  const entries = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const info = statSync(path);
    if (info.isDirectory()) {
      if (predicate(name, path, true)) entries.push(...walk(path, predicate));
    } else if (predicate(name, path, false)) {
      entries.push(path);
    }
  }
  return entries;
}

function countLoc() {
  let total = 0;
  for (const root of SOURCE_ROOTS) {
    const files = walk(join(REPO_ROOT, root), (name, _path, isDir) => {
      if (isDir) return !WEB_EXCLUDES.has(name);
      return name.endsWith(".ts") || name.endsWith(".tsx");
    });
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const line of content.split("\n")) {
        if (!isCommentLine(line)) total += 1;
      }
    }
  }
  return total;
}

function runGuardrail() {
  try {
    execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-b"], {
      cwd: REPO_ROOT,
      stdio: "pipe",
      timeout: 300_000,
    });
    return true;
  } catch {
    return false;
  }
}

if (process.argv.includes("--guardrail")) {
  if (!runGuardrail()) {
    console.error("guardrail failed: typecheck");
    process.exit(1);
  }
  process.exit(0);
}

console.log(`METRIC platform_loc=${countLoc()}`);
