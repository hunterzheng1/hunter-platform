import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Phase1BuildIdentitySchema,
  type Phase1BuildIdentity,
} from "@hunter/testkit";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePathspec = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.e2e.json",
  "packages",
  "apps",
  "scripts",
] as const;

function git(args: readonly string[]): Buffer {
  return execFileSync("git", [...args], {
    cwd: repositoryRoot,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

export function phase1BuildIdentity(): Phase1BuildIdentity {
  const packageJson = JSON.parse(
    readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
  ) as { readonly version?: unknown };
  const baseRevision = git(["rev-parse", "HEAD"]).toString("utf8").trim();
  const digest = createHash("sha256");
  digest.update(baseRevision);
  digest.update(
    git(["diff", "--binary", "HEAD", "--", ...sourcePathspec]),
  );
  const untracked = git([
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ...sourcePathspec,
  ]).toString("utf8").split("\0").filter(Boolean).sort();
  for (const relativePath of untracked) {
    digest.update(relativePath);
    digest.update("\0");
    digest.update(readFileSync(resolve(repositoryRoot, relativePath)));
    digest.update("\0");
  }
  return Phase1BuildIdentitySchema.parse({
    productVersion: packageJson.version,
    baseRevision,
    sourceDigest: digest.digest("hex"),
  });
}

const exactCodes = new Set([
  "ARCHIVE_RECOVERY_MISMATCH",
  "CAPACITY_RESTORED_COMMIT_ACCEPTED",
  "COMMIT_BOUNDARY_MISMATCH",
  "EVENT_CURSOR_GAP",
  "FAULT_NOT_INJECTED",
  "INJECTED_AFTER_COMMIT",
  "INJECTED_AFTER_MANIFEST_PUBLICATION",
  "INJECTED_BEFORE_COMMIT",
  "INJECTED_SOAK_CYCLE_FAILURE",
  "MOBILE_REPLAY_DUPLICATED",
  "MOBILE_REPLAY_RETURNED_ORIGINAL_RECEIPT",
  "OPERATION_FINGERPRINT_MISMATCH",
  "PHASE1_BENCHMARK_FAILED",
  "PHASE1_CONCURRENT_WORKLOAD_MISMATCH",
  "PHASE1_EVIDENCE_RENAME_FAILED",
  "PHASE1_EVIDENCE_WRITE_FAILED",
  "PHASE1_EVENT_SUBSCRIPTION_MISSING",
  "PHASE1_UI_MEASUREMENT_TIMEOUT",
  "PHASE1_UI_ROOT_MISSING",
  "PROJECTION_REBUILD_MISMATCH",
  "READ_ONLY_NOT_FAIL_CLOSED",
  "RESTART_PROBE_ARGUMENTS_REQUIRED",
  "RESTART_PROBE_ID_REUSED",
  "RESTART_PROBE_RECONCILIATION_FAILED",
  "RESTART_PROBE_SEQUENCE_INVALID",
  "RESTART_PROBE_STATE_MISSING",
  "RESTART_PROBE_TIME_INVALID",
  "RECOVERY_COMMITTED_ONCE",
  "RECEIPT_REPLAYED_WITHOUT_DUPLICATE",
  "SNAPSHOT_REPLACED_AND_RESUMED",
  "SOAK_FAULT_MATRIX_FAILED",
  "SOAK_RESUME_CHECKPOINT_INVALID",
  "SOAK_RESUME_EVIDENCE_MISMATCH",
  "SOAK_RESUME_START_TIME_MISSING",
  "SOAK_RESUME_STATE_MISSING",
  "SOAK_RECEIPT_MISSING",
  "SOAK_RUNTIME_FACT_FALSE_SUCCESS",
  "SOAK_STATE_ALREADY_EXISTS",
  "SOAK_STATE_PATH_INVALID",
  "SQLITE_FULL",
  "SQLITE_READONLY",
  "WRITABLE_COMMIT_ACCEPTED",
]);

export function safePhase1ErrorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : "";
  if (/SQLITE_FULL|database or disk is full/iu.test(raw)) return "SQLITE_FULL";
  if (/SQLITE_READONLY|read-?only database/iu.test(raw)) {
    return "SQLITE_READONLY";
  }
  const normalized = raw.trim().toUpperCase();
  if (exactCodes.has(normalized)) return normalized;
  if (
    /^INJECTED_FAULT:(?:AFTER_COMMAND_COMMIT_BEFORE_PROVIDER_CALL|AFTER_PROVIDER_SUCCESS_BEFORE_RECEIPT_COMMIT|AFTER_RECEIPT_COMMIT_BEFORE_OUTBOX_COMPLETE)$/u
      .test(normalized)
  ) {
    return normalized;
  }
  if (
    /^(?:RECOVERY|SOAK_OPERATION)_(?:COMPLETED|IDLE|NEEDS_ATTENTION|BLOCKED|FAILED)$/u
      .test(normalized)
  ) {
    return normalized;
  }
  return "UNKNOWN_PHASE1_FAILURE";
}

export function writePhase1JsonAtomic(path: string, value: unknown): void {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    renamePhase1FileWithRetry(temporary, target);
  } catch (error) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      // The fixed error below is the only evidence-safe outward detail.
    }
    throw error;
  }
}

interface Phase1RenameOptions {
  readonly maxAttempts?: number | undefined;
  readonly rename?: ((source: string, target: string) => void) | undefined;
  readonly wait?: ((milliseconds: number) => void) | undefined;
}

function waitSynchronously(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

export function renamePhase1FileWithRetry(
  source: string,
  target: string,
  options: Phase1RenameOptions = {},
): void {
  const maxAttempts = options.maxAttempts ?? 6;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0 || maxAttempts > 10) {
    throw new Error("PHASE1_EVIDENCE_RENAME_ATTEMPTS_INVALID");
  }
  const rename = options.rename ?? renameSync;
  const wait = options.wait ?? waitSynchronously;
  const transientCodes = new Set(["EACCES", "EBUSY", "EPERM"]);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      rename(source, target);
      return;
    } catch (error) {
      lastError = error;
      const code = error !== null && typeof error === "object"
        ? (error as { readonly code?: unknown }).code
        : undefined;
      if (!transientCodes.has(String(code)) || attempt === maxAttempts) break;
      wait(Math.min(250, 10 * 2 ** (attempt - 1)));
    }
  }
  throw new Error("PHASE1_EVIDENCE_RENAME_FAILED", { cause: lastError });
}

export function preparePhase1EvidenceOutput(path: string): void {
  const target = resolve(path);
  if (!existsSync(target)) return;
  const contents = readFileSync(target);
  const extension = extname(target);
  const stem = basename(target, extension);
  const archiveRoot = resolve(dirname(target), `${stem}.attempts`);
  mkdirSync(archiveRoot, { recursive: true });
  const digest = createHash("sha256").update(contents).digest("hex");
  const archive = resolve(archiveRoot, `${digest}${extension || ".json"}`);
  if (existsSync(archive)) {
    const archived = readFileSync(archive);
    if (!archived.equals(contents)) {
      throw new Error("PHASE1_EVIDENCE_HASH_COLLISION");
    }
    unlinkSync(target);
    return;
  }
  renamePhase1FileWithRetry(target, archive);
}
