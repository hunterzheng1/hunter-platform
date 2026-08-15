import { createHash } from "node:crypto";

import { canonicalJson } from "@hunter-harness/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { PgBranchSnapshotPort } from "../branch-snapshots/pg.js";
import {
  branchSnapshotRecordSchema,
  validateSnapshotManifest,
} from "../branch-snapshots/module.js";
import type {
  BranchSnapshotCommitPort,
  BranchSnapshotDurableCommitResult,
} from "../branch-snapshots/producer.js";
import type { BranchSnapshotRecord, BranchSnapshotSeed } from "../branch-snapshots/types.js";
import type { PgRemoteSyncCommitOptions, PgRemoteSyncCommitPort } from "./ports.js";

const PROJECT = /^prj_[A-Za-z0-9_-]{1,156}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;

function error(code: string): Error { return new Error(code); }

function hash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function nowIso(clock: () => Date): string {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw error("REMOTE_SYNC_CLOCK_INVALID");
  return value.toISOString();
}

function safeText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= max &&
    value === value.trim() && value === value.normalize("NFC") &&
    !Array.from(value).some((character) => (character.codePointAt(0) ?? 0) < 32);
}

function validateInput(input: Parameters<BranchSnapshotCommitPort["commitSnapshot"]>[0]): void {
  if (!safeText(input.actor_id, 160) || !safeText(input.idempotency_key, 240) ||
      !safeText(input.expected_revision, 240)) {
    throw error("BRANCH_SNAPSHOT_COMMIT_INPUT_INVALID");
  }
  const source = input.source;
  const seed = input.seed;
  const sourceKeys = Object.keys(source).sort();
  const allowedSourceKeys = ["actor_id", "branch_name", "change_key", "client_id", "commit_sha", "project_id"];
  if (sourceKeys.some((key) => !allowedSourceKeys.includes(key)) ||
      sourceKeys.length < 4 || sourceKeys.length > allowedSourceKeys.length) {
    throw error("BRANCH_SNAPSHOT_COMMIT_INPUT_INVALID");
  }
  if (!PROJECT.test(source.project_id) || !safeText(source.branch_name, 160) ||
      source.actor_id !== input.actor_id || seed.project_id !== source.project_id ||
      seed.branch_name !== source.branch_name || seed.commit_sha !== source.commit_sha) {
    throw error("BRANCH_SNAPSHOT_COMMIT_INPUT_INVALID");
  }
  if (source.commit_sha === undefined || !/^[a-f0-9]{40,64}$/u.test(source.commit_sha) ||
      seed.schema_version !== 1 || !SHA256.test(seed.manifest_hash)) {
    throw error("BRANCH_SNAPSHOT_COMMIT_INPUT_INVALID");
  }
}

function payloadHash(input: Parameters<BranchSnapshotCommitPort["commitSnapshot"]>[0]): string {
  return hash({
    actor_id: input.actor_id,
    idempotency_key: input.idempotency_key,
    expected_revision: input.expected_revision,
    source: input.source,
    seed: input.seed,
  });
}

function sourceJson(input: Parameters<BranchSnapshotCommitPort["commitSnapshot"]>[0]): string {
  return canonicalJson(input.source);
}

function recordFromJson(value: unknown): BranchSnapshotRecord {
  let parsedValue = value;
  if (typeof value === "string") {
    try { parsedValue = JSON.parse(value) as unknown; } catch { throw error("REMOTE_SYNC_RECEIPT_INVALID"); }
  }
  const parsed = branchSnapshotRecordSchema.parse(parsedValue);
  return validateSnapshotManifest(parsed);
}

function stableConflict(reason: "BRANCH_SNAPSHOT_IDENTITY_CONFLICT" | "BRANCH_SNAPSHOT_REVISION_CONFLICT"):
BranchSnapshotDurableCommitResult {
  return { outcome: "conflict", reason_code: reason };
}

async function transaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (cause) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw cause;
    }
  } finally {
    client.release();
  }
}

interface ReceiptRow extends QueryResultRow {
  payload_hash: string;
  source_json: unknown;
  expected_revision: string;
  project_version: string;
  artifact_id: string;
  manifest_hash: string;
  commit_sha: string;
  record_json: unknown;
}

interface PointerRow extends QueryResultRow {
  revision: string;
  generation: string | number;
}

function generationNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw error("BRANCH_SNAPSHOT_POINTER_INVALID");
  return number;
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { throw error("REMOTE_SYNC_RECEIPT_INVALID"); }
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(jsonValue(left)) === canonicalJson(jsonValue(right));
}

function canonicalUploadedAt(value: unknown): string {
  if (typeof value !== "string") throw error("BRANCH_SNAPSHOT_COMMIT_INPUT_INVALID");
  const fraction = /\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/u.exec(value)?.[1];
  if (fraction !== undefined && fraction.length > 3) {
    throw error("BRANCH_SNAPSHOT_COMMIT_INPUT_INVALID");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw error("BRANCH_SNAPSHOT_COMMIT_INPUT_INVALID");
  return parsed.toISOString();
}

function isUniqueViolation(value: unknown, depth = 0): boolean {
  if (depth > 4 || (typeof value !== "object" && typeof value !== "function") || value === null) return false;
  const candidate = value as { code?: unknown; cause?: unknown };
  return candidate.code === "23505" || isUniqueViolation(candidate.cause, depth + 1);
}

function conflictFromCause(value: unknown): BranchSnapshotDurableCommitResult | null {
  if (isUniqueViolation(value)) return stableConflict("BRANCH_SNAPSHOT_IDENTITY_CONFLICT");
  if (value instanceof Error && value.message === "BRANCH_SNAPSHOT_IDENTITY_CONFLICT") {
    return stableConflict("BRANCH_SNAPSHOT_IDENTITY_CONFLICT");
  }
  if (value instanceof Error && value.message === "BRANCH_SNAPSHOT_REVISION_CONFLICT") {
    return stableConflict("BRANCH_SNAPSHOT_REVISION_CONFLICT");
  }
  return null;
}

function storageSeedRecord(seed: BranchSnapshotSeed): BranchSnapshotRecord {
  return validateSnapshotManifest(branchSnapshotRecordSchema.parse({
    ...seed,
    // PostgreSQL returns timestamptz in canonical UTC form; compare against
    // that representation even when the producer supplied an RFC3339 offset.
    uploaded_at: canonicalUploadedAt(seed.uploaded_at),
    files: seed.files.map((file) => ({
      path: file.path,
      content_kind: file.content_kind,
      size: file.size,
      content_hash: file.content_hash,
      media_type: file.media_type,
      ...(file.action === undefined ? {} : { action: file.action }),
    })),
  }));
}

function requestRecord(seed: BranchSnapshotSeed): BranchSnapshotRecord {
  return validateSnapshotManifest(branchSnapshotRecordSchema.parse({
    ...seed,
    uploaded_at: canonicalUploadedAt(seed.uploaded_at),
    files: seed.files.map((file) => ({
      path: file.path,
      content_kind: file.content_kind,
      size: file.size,
      content_hash: file.content_hash,
      media_type: file.media_type,
      ...(file.action === undefined ? {} : { action: file.action }),
    })),
  }));
}

export function createPgRemoteSyncCommitPort(options: PgRemoteSyncCommitOptions): PgRemoteSyncCommitPort {
  const snapshotPort = options.branchSnapshots ?? new PgBranchSnapshotPort(options.pool);
  const clock = options.now ?? (() => new Date());

  return {
    async commitSnapshot(rawInput) {
      validateInput(rawInput);
      const input = rawInput;
      const payload_hash = payloadHash(input);
      const source_json = sourceJson(input);
      const seed = input.seed;
      const expected = requestRecord(seed);
      const storageExpected = storageSeedRecord(seed);

      try {
        return await transaction(options.pool, async (client) => {
        // JSON is deliberately NUL-free and stable across clients; PostgreSQL
        // text parameters cannot contain a NUL byte.
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [canonicalJson({ scope: "remote-sync-commit", project_id: seed.project_id, branch_name: seed.branch_name })]
        );
        // Sample timestamps after the branch fence.  A waiter must not commit
        // a newer revision with an older transaction identity.
        const created_at = nowIso(clock);
        const receipt = await client.query<ReceiptRow>(
          `SELECT payload_hash, source_json, expected_revision, project_version,
                  artifact_id, manifest_hash, commit_sha, record_json
             FROM remote_sync_commit_receipts
           WHERE project_id=$1 AND branch_name=$2 AND idempotency_key=$3 FOR UPDATE`,
          [seed.project_id, seed.branch_name, input.idempotency_key]
        );
        const prior = receipt.rows[0];
        if (prior !== undefined) {
          if (prior.payload_hash !== payload_hash) return stableConflict("BRANCH_SNAPSHOT_IDENTITY_CONFLICT");
          if (!sameCanonical(prior.source_json, input.source) || prior.expected_revision !== input.expected_revision ||
              prior.project_version !== seed.project_version || prior.artifact_id !== seed.artifact_id ||
              prior.manifest_hash !== seed.manifest_hash || prior.commit_sha !== seed.commit_sha) {
            throw error("REMOTE_SYNC_RECEIPT_INVALID");
          }
          const replayRecord = recordFromJson(prior.record_json);
          if (JSON.stringify(replayRecord) !== JSON.stringify(expected)) throw error("REMOTE_SYNC_RECEIPT_INVALID");
          return { outcome: "replay", record: replayRecord };
        }

        const pointer = await client.query<PointerRow>(
          `SELECT revision, generation FROM remote_sync_branch_pointers
           WHERE project_id=$1 AND branch_name=$2 FOR UPDATE`,
          [seed.project_id, seed.branch_name]
        );
        const current = pointer.rows[0];
        // An absent pointer is the uninitialized branch state.  The caller's
        // revision remains an opaque protocol token; once a commit exists,
        // the committed project_version becomes the next exact CAS token.
        const currentRevision = current === undefined ? null : String(current.revision);
        if (currentRevision !== null && input.expected_revision !== currentRevision) {
          return stableConflict("BRANCH_SNAPSHOT_REVISION_CONFLICT");
        }
        const nextRevision = seed.project_version;
        const generation = current === undefined ? 1 : generationNumber(current.generation) + 1;
        if (!Number.isSafeInteger(generation)) throw error("BRANCH_SNAPSHOT_POINTER_INVALID");

        await client.query(
          `INSERT INTO remote_sync_artifacts
             (project_id,branch_name,artifact_id,manifest_hash,commit_sha,project_version,source_json,payload_hash,idempotency_key,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`,
          [seed.project_id, seed.branch_name, seed.artifact_id, seed.manifest_hash, seed.commit_sha,
            seed.project_version, source_json, payload_hash, input.idempotency_key, created_at]
        );
        await client.query(
          `INSERT INTO remote_sync_versions
             (project_id,branch_name,project_version,artifact_id,manifest_hash,commit_sha,source_json,payload_hash,idempotency_key,snapshot_json,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11)`,
          [seed.project_id, seed.branch_name, seed.project_version, seed.artifact_id, seed.manifest_hash,
            seed.commit_sha, source_json, payload_hash, input.idempotency_key, JSON.stringify(expected), created_at]
        );

        // The branch table is timestamptz and returns canonical UTC.  Persist
        // and return the same millisecond-precision canonical instant so the
        // version, receipt, and branch snapshot cannot diverge by spelling or
        // precision.
        const persistedSeed = { ...seed, uploaded_at: storageExpected.uploaded_at };
        const storedRecord = await snapshotPort.persistSnapshotWithClient(client, {
          actor_id: input.actor_id,
          seed: persistedSeed,
        });
        if (JSON.stringify(storedRecord) !== JSON.stringify(storageExpected)) {
          throw error("BRANCH_SNAPSHOT_RECORD_INVALID");
        }
        const record = storedRecord;

        if (current === undefined) {
          await client.query(
            `INSERT INTO remote_sync_branch_pointers
               (project_id,branch_name,revision,generation,project_version,artifact_id,manifest_hash,commit_sha,updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [seed.project_id, seed.branch_name, nextRevision, generation, seed.project_version,
              seed.artifact_id, seed.manifest_hash, seed.commit_sha, created_at]
          );
        } else {
          const updated = await client.query(
            `UPDATE remote_sync_branch_pointers
             SET revision=$3,generation=$4,project_version=$5,artifact_id=$6,manifest_hash=$7,commit_sha=$8,updated_at=$9
             WHERE project_id=$1 AND branch_name=$2 AND revision=$10`,
            [seed.project_id, seed.branch_name, nextRevision, generation, seed.project_version,
              seed.artifact_id, seed.manifest_hash, seed.commit_sha, created_at, currentRevision]
          );
          if ((updated.rowCount ?? 0) !== 1) throw error("BRANCH_SNAPSHOT_REVISION_CONFLICT");
        }
        await client.query(
          `INSERT INTO remote_sync_commit_receipts
             (project_id,branch_name,idempotency_key,payload_hash,source_json,expected_revision,
              project_version,artifact_id,manifest_hash,commit_sha,record_json,created_at)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11::jsonb,$12)`,
          [seed.project_id, seed.branch_name, input.idempotency_key, payload_hash, source_json,
            input.expected_revision, seed.project_version, seed.artifact_id, seed.manifest_hash,
            seed.commit_sha, JSON.stringify(record), created_at]
        );
        return { outcome: "new", record };
        });
      } catch (cause) {
        const conflict = conflictFromCause(cause);
        if (conflict !== null) return conflict;
        throw cause;
      }
    },
  };
}
