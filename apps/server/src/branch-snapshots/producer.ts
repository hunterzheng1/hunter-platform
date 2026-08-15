import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import { remoteSyncSourceRefSchema, type RemoteSyncSourceRef } from "@hunter-harness/contracts";
import { z } from "zod";

import {
  branchSnapshotRecordSchema,
  validateSnapshotManifest,
} from "./module.js";
import type { BranchSnapshotRecord, BranchSnapshotSeed } from "./types.js";

const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const identifier = z.string().min(1).max(160).regex(/^[A-Za-z0-9._/-]+$/u);
const contentKind = z.enum([
  "config",
  "rule",
  "architecture",
  "instruction",
  "branch_file",
  "change_document",
  "archive_package",
  "knowledge_entry",
  "knowledge_candidate",
  "project_content_candidate",
]);
const action = z.enum(["add", "modify", "delete", "restore", "rename", "no_change"]);
const mediaType = z.enum([
  "text/plain",
  "text/markdown",
  "application/json",
  "application/yaml",
]);

function canonicalUploadedAt(value: string): string {
  const fraction = /\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/u.exec(value)?.[1];
  if (fraction !== undefined && fraction.length > 3) {
    throw producerError("BRANCH_SNAPSHOT_PRODUCER_INPUT_INVALID");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw producerError("BRANCH_SNAPSHOT_PRODUCER_INPUT_INVALID");
  }
  return parsed.toISOString();
}
const file = z
  .object({
    path: z.string().min(1).max(1_024),
    content_kind: contentKind,
    size: z.number().int().nonnegative().max(64 * 1024 * 1024),
    content_hash: sha256,
    media_type: mediaType,
    action,
    content: z.string().max(64 * 1024 * 1024),
  })
  .strict();

const inputSchema = z
  .object({
    schema_version: z.literal(1),
    actor_id: z.string().min(1).max(160),
    idempotency_key: z.string().min(1).max(240),
    expected_revision: z.string().min(1).max(240),
    source: remoteSyncSourceRefSchema.refine(
      (value) => value.commit_sha !== undefined,
      "commit_sha is required",
    ),
    project_version: identifier,
    artifact_id: identifier,
    manifest_hash: sha256,
    diff_ref: identifier,
    uploaded_at: z.iso.datetime({ offset: true }),
    changed_paths: z.array(z.string().min(1).max(1_024)).max(100_000),
    files: z.array(file).max(100_000),
  })
  .strict();

export interface BranchSnapshotProducerInput {
  schema_version: 1;
  actor_id: string;
  idempotency_key: string;
  expected_revision: string;
  source: RemoteSyncSourceRef & { commit_sha?: string };
  project_version: string;
  artifact_id: string;
  manifest_hash: string;
  diff_ref: string;
  uploaded_at: string;
  changed_paths: string[];
  files: BranchSnapshotSeed["files"];
}

export type BranchSnapshotDurableCommitResult =
  | { outcome: "new" | "replay"; record: BranchSnapshotRecord }
  | { outcome: "conflict"; reason_code: "BRANCH_SNAPSHOT_IDENTITY_CONFLICT" | "BRANCH_SNAPSHOT_REVISION_CONFLICT" };

export type BranchSnapshotCommitResult =
  | BranchSnapshotDurableCommitResult
  | { outcome: "no_changes" };

/**
 * This port is implemented by the authoritative Remote Sync commit
 * transaction. Implementations must publish the remote version and snapshot
 * atomically, or durably record a reconciled outbox operation before either is
 * reported committed.
 */
export interface BranchSnapshotCommitPort {
  commitSnapshot(input: {
    actor_id: string;
    idempotency_key: string;
    /** Opaque branch-pointer CAS token; the uninitialized branch has no row. */
    expected_revision: string;
    source: RemoteSyncSourceRef;
    seed: BranchSnapshotSeed;
  }): Promise<BranchSnapshotDurableCommitResult>;
}

export interface BranchSnapshotProducer {
  publish(input: BranchSnapshotProducerInput): Promise<BranchSnapshotCommitResult>;
}

function compareCodepoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function producerError(code: string): Error {
  return new Error(code);
}

function fileRef(entry: BranchSnapshotSeed["files"][number]): BranchSnapshotRecord["files"][number] {
  return {
    path: entry.path,
    content_kind: entry.content_kind,
    size: entry.size,
    content_hash: entry.content_hash,
    media_type: entry.media_type,
    ...(entry.action === undefined ? {} : { action: entry.action }),
  };
}

function nativePromise(value: unknown): value is Promise<unknown> {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value) ||
      !(value instanceof Promise)) return false;
  try {
    return Object.getPrototypeOf(value) === Promise.prototype && Reflect.ownKeys(value).length === 0;
  } catch {
    return false;
  }
}

function commitMethod(value: unknown): BranchSnapshotCommitPort["commitSnapshot"] {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw producerError("BRANCH_SNAPSHOT_PRODUCER_PORT_INVALID");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 1 || keys[0] !== "commitSnapshot") {
    throw producerError("BRANCH_SNAPSHOT_PRODUCER_PORT_INVALID");
  }
  const descriptor = descriptors.commitSnapshot;
  if (descriptor === undefined || !("value" in descriptor) ||
      typeof descriptor.value !== "function" || nodeTypes.isProxy(descriptor.value) ||
      descriptor.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined) {
    throw producerError("BRANCH_SNAPSHOT_PRODUCER_PORT_INVALID");
  }
  return descriptor.value as BranchSnapshotCommitPort["commitSnapshot"];
}

interface SnapshotBudget {
  nodes: number;
  text_bytes: number;
  active: WeakSet<object>;
}

function boundedSnapshot(value: unknown, budget?: SnapshotBudget, depth = 0): unknown {
  const state = budget ?? { nodes: 0, text_bytes: 0, active: new WeakSet<object>() };
  state.nodes += 1;
  if (state.nodes > 1_000_000 || depth > 32) {
    throw producerError("BRANCH_SNAPSHOT_PRODUCER_INPUT_INVALID");
  }
  if (typeof value === "string") {
    state.text_bytes += Buffer.byteLength(value, "utf8");
    if (state.text_bytes > 272 * 1024 * 1024) {
      throw producerError("BRANCH_SNAPSHOT_PRODUCER_INPUT_INVALID");
    }
    return value;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value !== "object" || nodeTypes.isProxy(value)) {
    throw producerError("BRANCH_SNAPSHOT_PRODUCER_INPUT_INVALID");
  }
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype) ||
      state.active.has(value)) {
    throw producerError("BRANCH_SNAPSHOT_PRODUCER_INPUT_INVALID");
  }
  state.active.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key === "symbol")) {
      throw producerError("BRANCH_SNAPSHOT_PRODUCER_INPUT_INVALID");
    }
    if (array) {
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || Number(length) > 100_000 ||
          keys.some((key) => typeof key === "string" && key !== "length" &&
            !/^(?:0|[1-9]\d*)$/u.test(key))) {
        throw producerError("BRANCH_SNAPSHOT_PRODUCER_INPUT_INVALID");
      }
      return Array.from({ length: Number(length) }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
          throw producerError("BRANCH_SNAPSHOT_PRODUCER_INPUT_INVALID");
        }
        return boundedSnapshot(descriptor.value, state, depth + 1);
      });
    }
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (key === "__proto__" || descriptor === undefined || !("value" in descriptor) ||
          descriptor.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined) {
        throw producerError("BRANCH_SNAPSHOT_PRODUCER_INPUT_INVALID");
      }
      output[key] = boundedSnapshot(descriptor.value, state, depth + 1);
    }
    return output;
  } finally {
    state.active.delete(value);
  }
}

function dependencyPort(value: unknown): BranchSnapshotCommitPort {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw producerError("BRANCH_SNAPSHOT_PRODUCER_PORT_INVALID");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const descriptor = descriptors.commit_port;
  if (keys.length !== 1 || keys[0] !== "commit_port" || descriptor === undefined ||
      !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined ||
      descriptor.enumerable !== true) {
    throw producerError("BRANCH_SNAPSHOT_PRODUCER_PORT_INVALID");
  }
  return descriptor.value as BranchSnapshotCommitPort;
}

function canonicalSeed(value: z.infer<typeof inputSchema>): BranchSnapshotSeed {
  const files = value.files.map((entry) => ({ ...entry }));
  const paths = files.map((entry) => entry.path);
  const changed = files
    .filter((entry) => entry.action !== "no_change")
    .map((entry) => entry.path)
    .sort(compareCodepoint);
  if (new Set(paths).size !== paths.length ||
      paths.join("\0") !== [...paths].sort(compareCodepoint).join("\0") ||
      new Set(value.changed_paths).size !== value.changed_paths.length ||
      value.changed_paths.join("\0") !== [...value.changed_paths].sort(compareCodepoint).join("\0") ||
      changed.join("\0") !== value.changed_paths.join("\0")) {
    throw producerError("BRANCH_SNAPSHOT_PRODUCER_INPUT_INVALID");
  }
  for (const entry of files) {
    const bytes = Buffer.from(entry.content, "utf8");
    if (/\p{Surrogate}/u.test(entry.content) || bytes.byteLength !== entry.size ||
        `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== entry.content_hash) {
      throw producerError("BRANCH_SNAPSHOT_PRODUCER_INPUT_INVALID");
    }
  }
  const commitSha = value.source.commit_sha;
  if (commitSha === undefined || value.source.actor_id !== value.actor_id) {
    throw producerError("BRANCH_SNAPSHOT_PRODUCER_INPUT_INVALID");
  }
  const seed: BranchSnapshotSeed = {
    schema_version: 1,
    project_id: value.source.project_id,
    branch_name: value.source.branch_name,
    commit_sha: commitSha,
    project_version: value.project_version,
    artifact_id: value.artifact_id,
    manifest_hash: value.manifest_hash,
    file_count: files.length,
    changed_file_count: value.changed_paths.length,
    uploaded_at: canonicalUploadedAt(value.uploaded_at),
    diff_ref: value.diff_ref,
    files,
    changed_paths: [...value.changed_paths],
  };
  const refs = files.map(fileRef);
  validateSnapshotManifest(branchSnapshotRecordSchema.parse({ ...seed, files: refs }));
  return seed;
}

function expectedRecord(seed: BranchSnapshotSeed): BranchSnapshotRecord {
  return validateSnapshotManifest(
    branchSnapshotRecordSchema.parse({
      ...seed,
      files: seed.files.map(fileRef),
    }),
  );
}

function readResult(value: unknown, expected: BranchSnapshotRecord): BranchSnapshotDurableCommitResult {
  let plain: unknown;
  try {
    plain = boundedSnapshot(value);
  } catch {
    throw producerError("BRANCH_SNAPSHOT_PRODUCER_RECEIPT_INVALID");
  }
  const conflict = z
    .object({
      outcome: z.literal("conflict"),
      reason_code: z.enum(["BRANCH_SNAPSHOT_IDENTITY_CONFLICT", "BRANCH_SNAPSHOT_REVISION_CONFLICT"]),
    })
    .strict()
    .safeParse(plain);
  if (conflict.success) return conflict.data;
  const committed = z
    .object({
      outcome: z.enum(["new", "replay"]),
      record: branchSnapshotRecordSchema,
    })
    .strict()
    .safeParse(plain);
  if (!committed.success) throw producerError("BRANCH_SNAPSHOT_PRODUCER_RECEIPT_INVALID");
  let record: BranchSnapshotRecord;
  try {
    record = validateSnapshotManifest(committed.data.record);
  } catch {
    throw producerError("BRANCH_SNAPSHOT_PRODUCER_RECEIPT_INVALID");
  }
  if (JSON.stringify(record) !== JSON.stringify(expected)) {
    throw producerError("BRANCH_SNAPSHOT_PRODUCER_RECEIPT_INVALID");
  }
  return { outcome: committed.data.outcome, record };
}

export function createBranchSnapshotProducer(input: {
  commit_port: BranchSnapshotCommitPort;
}): BranchSnapshotProducer {
  const commitPort = dependencyPort(input);
  const commitSnapshot = commitMethod(commitPort);
  return {
    async publish(raw) {
      let parsed: z.infer<typeof inputSchema>;
      try {
        parsed = inputSchema.parse(boundedSnapshot(raw));
      } catch {
        throw producerError("BRANCH_SNAPSHOT_PRODUCER_INPUT_INVALID");
      }
      let seed: BranchSnapshotSeed;
      try {
        seed = canonicalSeed(parsed);
      } catch {
        throw producerError("BRANCH_SNAPSHOT_PRODUCER_INPUT_INVALID");
      }
      const expected = expectedRecord(seed);
      if (seed.changed_paths.length === 0) return { outcome: "no_changes" };
      let returned: unknown;
      try {
        returned = Reflect.apply(commitSnapshot, commitPort, [{
          actor_id: parsed.actor_id,
          idempotency_key: parsed.idempotency_key,
          expected_revision: parsed.expected_revision,
          source: parsed.source,
          seed,
        }]);
      } catch {
        throw producerError("BRANCH_SNAPSHOT_PRODUCER_PORT_INVALID");
      }
      if (!nativePromise(returned)) throw producerError("BRANCH_SNAPSHOT_PRODUCER_PORT_INVALID");
      let resolved: unknown;
      try {
        resolved = await returned;
      } catch {
        throw producerError("BRANCH_SNAPSHOT_PRODUCER_PORT_INVALID");
      }
      return readResult(resolved, expected);
    },
  };
}
