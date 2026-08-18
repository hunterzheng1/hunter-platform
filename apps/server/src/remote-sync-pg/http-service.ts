import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  canonicalJson,
  classifyContentPath,
  remoteSyncLeaseSchema,
  remoteSyncSourceRefSchema,
  remoteSyncPreparedPushSchema,
  remoteSyncPushReceiptHttpSchema,
  remoteSyncPushPrepareHttpRequestSchema,
  remoteSyncPushStatusSchema,
  remoteSyncRemoteSnapshotSchema,
  remoteSyncPullReceiptSchema,
  type RemoteSyncLease,
  type RemoteSyncPreparedPush,
  type RemoteSyncPushPrepareHttpRequest,
  type RemoteSyncPushCommitHttpRequest,
  type RemoteSyncPushReceiptHttp,
  type RemoteSyncPushStatus,
  type RemoteSyncPullReceipt,
  type RemoteSyncRemoteSnapshot,
  type RemoteSyncOperation,
  type RemoteSyncSourceRef,
  type RemoteSyncContentChunk,
} from "@hunter-harness/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { runTransaction, type TransactionOperation } from "@hunter-harness/core";

import type { BranchSnapshotProducer } from "../branch-snapshots/producer.js";
import { branchSnapshotRecordSchema, remoteSyncManifestHash, validateSnapshotManifest } from "../branch-snapshots/module.js";
import type { BranchSnapshotRecord, BranchSnapshotSeed } from "../branch-snapshots/types.js";
import { materializeRemoteSyncPushFiles } from "./push-files.js";
import type {
  RemoteSyncHttpContentStream,
  RemoteSyncHttpServicePort,
  RemoteSyncIdempotencyResult,
} from "../remote-sync-http/ports.js";
import type { RemoteContentUploadHttpRef, RemoteContentUploadHttpSource } from "@hunter-harness/contracts";

export interface PgRemoteSyncHttpServiceOptions {
  readonly pool: Pool;
  readonly workspaceRoot?: string;
  readonly branchSnapshotProducer: BranchSnapshotProducer;
  readonly resolveUpload: (input: {
    readonly source: RemoteContentUploadHttpSource;
    readonly upload_ref: RemoteContentUploadHttpRef;
    readonly purpose: "remote_sync_file";
    readonly now: string;
    readonly executor?: Pick<PoolClient, "query">;
    readonly allow_expired?: true;
  }) => Promise<AsyncIterable<Uint8Array>>;
  readonly now?: () => Date;
}

export interface PgRemoteSyncHttpService extends RemoteSyncHttpServicePort {
  close(): Promise<void>;
}

class PgRemoteSyncHttpError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable = false) {
    super(code);
    this.name = "PgRemoteSyncHttpError";
    this.code = code;
    this.retryable = retryable;
  }
}

function fail(code: string, retryable = false): never {
  throw new PgRemoteSyncHttpError(code, retryable);
}

function hash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function compareCodepoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function remoteSyncPayloadHash(input: RemoteSyncPushPrepareHttpRequest): string {
  const sortOperations = (operations: typeof input.operations) => [...operations].sort((left, right) =>
    compareCodepoint(left.path, right.path) ||
    compareCodepoint(left.action, right.action) ||
    compareCodepoint(left.source_path ?? "", right.source_path ?? ""));
  return hash({
    source: input.source,
    expected_revision: input.expected_revision,
    preview_hash: input.preview_hash,
    idempotency_key: input.idempotency_key,
    files: input.files.map(({ upload_ref, ...file }) => {
      void upload_ref;
      return file;
    }).sort((left, right) => compareCodepoint(left.path, right.path)),
    operations: sortOperations(input.operations),
    skipped: sortOperations(input.skipped)
  });
}

function token(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function nowIso(clock: () => Date): string {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail("REMOTE_UNAVAILABLE");
  return value.toISOString();
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { fail("REMOTE_UNAVAILABLE"); }
}

function sameOptional(left: string | undefined, right: string | undefined): boolean {
  return left === right;
}

function sameSource(left: RemoteSyncSourceRef, right: RemoteSyncSourceRef): boolean {
  return left.project_id === right.project_id && left.branch_name === right.branch_name &&
    left.actor_id === right.actor_id && sameOptional(left.commit_sha, right.commit_sha) &&
    sameOptional(left.client_id, right.client_id) && sameOptional(left.change_key, right.change_key);
}

function sourceFromJson(value: unknown): RemoteSyncSourceRef {
  const parsed = remoteSyncSourceRefSchema.safeParse(jsonObject(value));
  if (!parsed.success) fail("REMOTE_UNAVAILABLE");
  return parsed.data;
}

function iso(value: unknown): string {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) fail("REMOTE_UNAVAILABLE");
  return parsed.toISOString();
}

function jsonObject(value: unknown): Record<string, unknown> {
  const parsed = parseJson(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) fail("REMOTE_UNAVAILABLE");
  return parsed as Record<string, unknown>;
}

function leaseFromJson(value: unknown): RemoteSyncLease {
  const parsed = remoteSyncLeaseSchema.safeParse(jsonObject(value));
  if (!parsed.success) fail("REMOTE_UNAVAILABLE");
  return parsed.data;
}

function preparedFromJson(value: unknown): RemoteSyncPreparedPush {
  const parsed = remoteSyncPreparedPushSchema.safeParse(jsonObject(value));
  if (!parsed.success) fail("REMOTE_UNAVAILABLE");
  return parsed.data;
}

function receiptFromJson(value: unknown): RemoteSyncPushReceiptHttp {
  const parsed = remoteSyncPushReceiptHttpSchema.safeParse(jsonObject(value));
  if (!parsed.success) fail("REMOTE_UNAVAILABLE");
  return parsed.data;
}

function managedPullPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/") ||
      value.includes("\\") || value.includes("\0") || value.split("/").includes("..") ||
      value === ".harness" || value.startsWith(".harness/")) {
    fail("REMOTE_UNAVAILABLE");
  }
  return value;
}

function pullContentKind(path: string, explicit: RemoteSyncRemoteSnapshot["files"][number]["content_kind"]): RemoteSyncOperation["content_kind"] {
  if (explicit !== undefined) return explicit;
  const classification = classifyContentPath({ schema_version: 1, path });
  return "content_kind" in classification ? classification.content_kind : "branch_file";
}

async function previousPullPaths(workspaceRoot: string, source: RemoteSyncSourceRef): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await readFile(join(workspaceRoot, ".harness", "state", "remote-sync-manifest.json"), "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) fail("REMOTE_UNAVAILABLE");
    const value = parsed as Record<string, unknown>;
    if (value.source !== undefined && !sameSource(sourceFromJson(value.source), source)) {
      fail("REMOTE_UNAVAILABLE");
    }
    if (value.files === undefined) return new Set();
    if (!Array.isArray(value.files)) fail("REMOTE_UNAVAILABLE");
    return new Set(value.files.map((item) => managedPullPath(
      item !== null && typeof item === "object" && !Array.isArray(item)
        ? (item as Record<string, unknown>).path
        : item
    )));
  } catch (error) {
    if (error instanceof PgRemoteSyncHttpError) throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Set();
    fail("REMOTE_UNAVAILABLE");
  }
}

async function transaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (cause) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw cause;
    }
  } finally {
    client.release();
  }
}

function branchLockKey(source: RemoteSyncSourceRef): string {
  return canonicalJson({ scope: "remote-sync-commit", project_id: source.project_id, branch_name: source.branch_name });
}

function uploadObjectLockKey(projectId: string, contentSha256: string): string {
  return JSON.stringify({ project_id: projectId, content_sha256: contentSha256 });
}

function emptyManifestHash(): `sha256:${string}` {
  return hash([]);
}

function snapshotId(projectId: string, branchName: string, revision: string, manifestHash: string): string {
  return `snapshot_${hash({ project_id: projectId, branch_name: branchName, revision, manifest_hash: manifestHash }).slice(7, 39)}`;
}

function idSuffix(value: unknown): string {
  return hash(value).slice(7, 39);
}

interface LeaseCommandRow extends QueryResultRow {
  payload_hash: string;
  command_kind: string;
  generation: string | number;
  lease_json: unknown;
}

interface ActiveLeaseRow extends QueryResultRow {
  lease_id: string;
  lease_token: string;
  generation: string | number;
  expires_at: string | Date;
  source_json: unknown;
}

interface PushRow extends QueryResultRow {
  project_id: string;
  branch_name: string;
  actor_id: string;
  idempotency_key: string;
  prepare_id: string;
  source_json: unknown;
  lease_id: string;
  lease_token: string;
  lease_generation: string | number;
  expected_revision: string;
  preview_hash: string;
  payload_hash: string;
  request_hash: string;
  files_json: unknown;
  operations_json: unknown;
  skipped_json: unknown;
  state: string;
  receipt_json: unknown;
  created_at: string | Date;
  expires_at: string | Date;
  updated_at: string | Date;
}

interface PointerRow extends QueryResultRow {
  revision: string;
  project_version: string;
  artifact_id: string;
  manifest_hash: string;
  commit_sha: string;
  snapshot_json: unknown;
  source_json: unknown;
}

interface DurableSnapshotReceiptRow extends QueryResultRow {
  payload_hash: string;
  source_json: unknown;
  expected_revision: string;
  project_version: string;
  artifact_id: string;
  manifest_hash: string;
  commit_sha: string;
  record_json: unknown;
}

function numberGeneration(value: unknown): number {
  const generation = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(generation) || generation < 1) fail("SYNC_LEASE_FENCED");
  return generation;
}

function leaseMatches(row: ActiveLeaseRow, lease: RemoteSyncLease, source: RemoteSyncSourceRef): boolean {
  return row.lease_id === lease.lease_id && row.lease_token === lease.lease_token &&
    numberGeneration(row.generation) === lease.generation &&
    iso(row.expires_at) === lease.expires_at && sameSource(jsonObject(row.source_json) as RemoteSyncSourceRef, source);
}

function ensurePreparedLease(row: PushRow, lease: RemoteSyncLease): void {
  if (row.lease_id !== lease.lease_id || row.lease_token !== lease.lease_token ||
      numberGeneration(row.lease_generation) !== lease.generation) {
    fail("SYNC_LEASE_FENCED");
  }
}

function ensureSource(source: RemoteSyncSourceRef, lease: RemoteSyncLease): void {
  if (lease.project_id !== source.project_id || lease.branch_name !== source.branch_name || lease.actor_id !== source.actor_id) {
    fail("SYNC_LEASE_SCOPE_MISMATCH");
  }
}

function ensureLeaseTime(lease: RemoteSyncLease, now: string): void {
  if (Date.parse(lease.expires_at) <= Date.parse(now)) fail("SYNC_LEASE_EXPIRED");
}

function leasePayloadHash(kind: string, value: unknown): `sha256:${string}` {
  return hash({ kind, value });
}

const SEED_MEDIA_TYPES = new Set([
  "text/plain", "text/markdown", "application/json", "application/yaml"
]);

function operationPaths(value: readonly { path: string; action: string }[]): string[] {
  return [...new Set(value.filter((operation) => operation.action !== "no_change")
    .flatMap((operation) => operation.action === "rename" && "source_path" in operation &&
      typeof operation.source_path === "string" ? [operation.path, operation.source_path] : [operation.path]))].sort();
}

function removedOperationPaths(value: readonly { path: string; action: string; source_path?: string | undefined }[]): string[] {
  return [...new Set(value.flatMap((operation) => {
    if (operation.action === "delete") return [operation.path];
    if (operation.action === "rename" && operation.source_path !== undefined) return [operation.source_path];
    return [];
  }))].sort();
}

function ensureUniquePushPaths(input: RemoteSyncPushPrepareHttpRequest): void {
  const filePaths = input.files.map((file) => file.path);
  const outcomePaths = [...input.operations, ...input.skipped].map((operation) => operation.path);
  if (new Set(filePaths).size !== filePaths.length || new Set(outcomePaths).size !== outcomePaths.length) {
    fail("SYNC_CONTENT_INVALID");
  }
}

function receiptFromRecord(
  prepared: RemoteSyncPreparedPush,
  record: BranchSnapshotRecord,
  operations: RemoteSyncPushPrepareHttpRequest["operations"],
  skipped: RemoteSyncPushPrepareHttpRequest["skipped"]
): RemoteSyncPushReceiptHttp {
  return {
    schema_version: 1,
    prepare_id: prepared.prepare_id,
    source: prepared.source,
    idempotency_key: prepared.idempotency_key,
    payload_hash: prepared.payload_hash,
    preview_hash: prepared.preview_hash,
    project_version: record.project_version,
    artifact_id: record.artifact_id,
    commit_sha: record.commit_sha,
    manifest_hash: record.manifest_hash,
    no_changes: operations.length === 0,
    applied: [...operations],
    skipped: [...skipped],
    retryable: [],
  };
}

function branchRecordFromJson(value: unknown): BranchSnapshotRecord {
  const parsed = branchSnapshotRecordSchema.safeParse(parseJson(value));
  if (!parsed.success) fail("REMOTE_UNAVAILABLE");
  try {
    return validateSnapshotManifest(parsed.data);
  } catch {
    fail("REMOTE_UNAVAILABLE");
  }
}

export function createPgRemoteSyncHttpService(options: PgRemoteSyncHttpServiceOptions): PgRemoteSyncHttpService {
  const clock = options.now ?? (() => new Date());
  let closed = false;
  const open = (): void => { if (closed) fail("REMOTE_UNAVAILABLE"); };
  const now = (): string => nowIso(clock);

  async function lockBranch(client: PoolClient, source: RemoteSyncSourceRef): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [branchLockKey(source)]);
  }

  async function activeLease(client: PoolClient, source: RemoteSyncSourceRef): Promise<ActiveLeaseRow | undefined> {
    const result = await client.query<ActiveLeaseRow>(
      `SELECT lease_id,lease_token,generation,expires_at,source_json
         FROM remote_sync_http_active_leases
        WHERE project_id=$1 AND branch_name=$2 FOR UPDATE`,
      [source.project_id, source.branch_name]
    );
    return result.rows[0];
  }

  async function requireLease(
    client: PoolClient,
    source: RemoteSyncSourceRef,
    lease: RemoteSyncLease,
    exactSource?: RemoteSyncSourceRef,
  ): Promise<{ readonly source: RemoteSyncSourceRef; readonly at: string }> {
    ensureSource(source, lease);
    const current = await activeLease(client, source);
    if (current === undefined) fail("SYNC_LEASE_FENCED");
    const at = now();
    ensureLeaseTime(lease, at);
    const storedSource = sourceFromJson(current.source_json);
    if (storedSource.project_id !== source.project_id || storedSource.branch_name !== source.branch_name ||
        storedSource.actor_id !== source.actor_id || (exactSource !== undefined && !sameSource(storedSource, exactSource)) ||
        !leaseMatches(current, lease, storedSource)) fail("SYNC_LEASE_FENCED");
    return { source: storedSource, at };
  }

  async function verifyUploadRefs(client: PoolClient, request: RemoteSyncPushPrepareHttpRequest): Promise<void> {
    const refs = request.files.filter((file) => file.size > 0).map((file) => {
      if (file.upload_ref === undefined) fail("SYNC_STREAM_INVALID");
      return file.upload_ref;
    }).sort((left, right) => left.sha256 < right.sha256 ? -1 : left.sha256 > right.sha256 ? 1 :
      left.ref_id < right.ref_id ? -1 : left.ref_id > right.ref_id ? 1 : 0);
    const locked = new Set<string>();
    for (const ref of refs) {
      if (locked.has(ref.sha256)) continue;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        uploadObjectLockKey(request.source.project_id, ref.sha256)
      ]);
      locked.add(ref.sha256);
    }
    const at = now();
    for (const file of request.files) {
      if (file.size === 0) continue;
      if (file.upload_ref === undefined) fail("SYNC_STREAM_INVALID");
      // The resolver performs the project/source/ref/expiry/CAS existence
      // checks without consuming the returned stream. Bytes are consumed only
      // by commit, after the push row is durably prepared.
      await options.resolveUpload({ source: request.source as RemoteContentUploadHttpSource,
        upload_ref: file.upload_ref, purpose: "remote_sync_file", now: at, executor: client });
    }
  }

  async function currentPointer(client: Pool | PoolClient, source: RemoteSyncSourceRef): Promise<PointerRow | undefined> {
    const result = await client.query<PointerRow>(
      `SELECT p.revision,p.project_version,p.artifact_id,p.manifest_hash,p.commit_sha,
              v.snapshot_json,v.source_json
         FROM remote_sync_branch_pointers p
         JOIN remote_sync_versions v
           ON v.project_id=p.project_id AND v.branch_name=p.branch_name
          AND v.project_version=p.project_version AND v.artifact_id=p.artifact_id
          AND v.manifest_hash=p.manifest_hash AND v.commit_sha=p.commit_sha
        WHERE p.project_id=$1 AND p.branch_name=$2`,
      [source.project_id, source.branch_name]
    );
    return result.rows[0];
  }

  type SeedFile = BranchSnapshotSeed["files"][number];

  // 阶段 02 语义：每个分支保存"最近一次成功上传后的完整有效快照"，不是本次增量。
  // commit 必须把父快照文件与本次 operations 合并；父文件内容从 Blob 读取并复核完整性。
  async function loadParentSeedFiles(
    client: PoolClient,
    source: RemoteSyncSourceRef
  ): Promise<Map<string, SeedFile>> {
    const files = new Map<string, SeedFile>();
    const pointer = await currentPointer(client, source);
    if (pointer === undefined) return files;
    const result = await client.query<{
      path: string; content_kind: string; size_bytes: number | string;
      content_hash: string; media_type: string; content_bytes: Buffer;
    }>(
      `SELECT f.path, f.content_kind, f.size_bytes, f.content_hash, f.media_type, b.content_bytes
         FROM branch_snapshot_files f
         JOIN branch_snapshot_blobs b ON b.content_hash = f.content_hash
        WHERE f.project_id = $1 AND f.branch_name = $2 AND f.project_version = $3
          AND f.artifact_id = $4 AND f.manifest_hash = $5 AND f.commit_sha = $6
        ORDER BY f.path COLLATE "C" ASC`,
      [source.project_id, source.branch_name, pointer.project_version,
        pointer.artifact_id, pointer.manifest_hash, pointer.commit_sha]
    );
    for (const row of result.rows) {
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(row.content_bytes);
      } catch {
        fail("REMOTE_UNAVAILABLE");
      }
      const sizeBytes = Number(row.size_bytes);
      const bytes = Buffer.from(content, "utf8");
      if (!Number.isSafeInteger(sizeBytes) || bytes.byteLength !== sizeBytes ||
          `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== row.content_hash ||
          !SEED_MEDIA_TYPES.has(row.media_type)) {
        fail("REMOTE_UNAVAILABLE");
      }
      files.set(row.path, {
        path: row.path,
        content_kind: row.content_kind as SeedFile["content_kind"],
        size: sizeBytes,
        content_hash: row.content_hash,
        media_type: row.media_type as SeedFile["media_type"],
        action: "no_change",
        content
      });
    }
    return files;
  }

  function mergePushSeedFiles(
    parentFiles: Map<string, SeedFile>,
    materialized: readonly SeedFile[],
    operations: RemoteSyncPushPrepareHttpRequest["operations"]
  ): SeedFile[] {
    const merged = new Map(parentFiles);
    for (const path of removedOperationPaths(operations)) merged.delete(path);
    for (const entry of materialized) merged.set(entry.path, entry);
    return [...merged.values()].sort((left, right) => compareCodepoint(left.path, right.path));
  }

  function remoteSnapshotFromRow(source: RemoteSyncSourceRef, row: PointerRow | undefined): RemoteSyncRemoteSnapshot {
    if (row === undefined) {
      return {
        source,
        snapshot_id: snapshotId(source.project_id, source.branch_name, "0", emptyManifestHash()),
        revision: "0",
        project_version: null,
        commit_sha: source.commit_sha ?? null,
        artifact_id: null,
        manifest_hash: emptyManifestHash(),
        files: [],
      };
    }
    const snapshot = jsonObject(row.snapshot_json);
    const files = Array.isArray(snapshot.files) ? snapshot.files : [];
    const value = {
      source,
      snapshot_id: snapshotId(source.project_id, source.branch_name, row.revision, row.manifest_hash),
      revision: row.revision,
      project_version: row.project_version,
      commit_sha: row.commit_sha,
      artifact_id: row.artifact_id,
      manifest_hash: row.manifest_hash,
      files: files.map((file) => {
        const record = jsonObject(file);
        return {
          path: String(record.path),
          content_hash: String(record.content_hash),
          size: Number(record.size),
          ...(record.content_kind === undefined ? {} : { content_kind: String(record.content_kind) as never }),
        };
      }),
    };
    const parsed = remoteSyncRemoteSnapshotSchema.safeParse(value);
    if (!parsed.success) fail("REMOTE_UNAVAILABLE");
    return parsed.data;
  }

  function preparedFromRow(row: PushRow): RemoteSyncPreparedPush {
    return preparedFromJson({
      schema_version: 1,
      prepare_id: row.prepare_id,
      source: jsonObject(row.source_json),
      lease_id: row.lease_id,
      lease_token: row.lease_token,
      lease_generation: numberGeneration(row.lease_generation),
      expected_revision: row.expected_revision,
      preview_hash: row.preview_hash,
      idempotency_key: row.idempotency_key,
      payload_hash: row.payload_hash,
      state: "prepared",
      expires_at: iso(row.expires_at),
    });
  }

  function pushOperations(row: PushRow): {
    files: RemoteSyncPushPrepareHttpRequest["files"];
    operations: RemoteSyncPushPrepareHttpRequest["operations"];
    skipped: RemoteSyncPushPrepareHttpRequest["skipped"];
  } {
    return {
      files: JSON.parse(JSON.stringify(parseJson(row.files_json))) as RemoteSyncPushPrepareHttpRequest["files"],
      operations: JSON.parse(JSON.stringify(parseJson(row.operations_json))) as RemoteSyncPushPrepareHttpRequest["operations"],
      skipped: JSON.parse(JSON.stringify(parseJson(row.skipped_json))) as RemoteSyncPushPrepareHttpRequest["skipped"],
    };
  }

  async function recoverDurableSnapshot(
    client: PoolClient,
    row: PushRow,
    prepared: RemoteSyncPreparedPush,
    operations: RemoteSyncPushPrepareHttpRequest["operations"],
    skipped: RemoteSyncPushPrepareHttpRequest["skipped"],
    at: string,
  ): Promise<RemoteSyncPushReceiptHttp | null> {
    const result = await client.query<DurableSnapshotReceiptRow>(
      `SELECT payload_hash,source_json,expected_revision,project_version,artifact_id,manifest_hash,commit_sha,record_json
         FROM remote_sync_commit_receipts
        WHERE project_id=$1 AND branch_name=$2 AND idempotency_key=$3 FOR UPDATE`,
      [prepared.source.project_id, prepared.source.branch_name, prepared.idempotency_key]
    );
    const durable = result.rows[0];
    if (durable === undefined) return null;
    const record = branchRecordFromJson(durable.record_json);
    const suffix = idSuffix({ prepare_id: prepared.prepare_id, payload_hash: prepared.payload_hash });
    if (!sameSource(sourceFromJson(durable.source_json), prepared.source) ||
        durable.expected_revision !== prepared.expected_revision ||
        durable.project_version !== `pv_${suffix}` || durable.artifact_id !== `art_${suffix}` ||
        durable.project_version !== record.project_version || durable.artifact_id !== record.artifact_id ||
        durable.manifest_hash !== record.manifest_hash || durable.commit_sha !== record.commit_sha ||
        record.project_id !== prepared.source.project_id || record.branch_name !== prepared.source.branch_name ||
        record.commit_sha !== prepared.source.commit_sha) {
      fail("REMOTE_UNAVAILABLE");
    }
    const receipt = receiptFromRecord(prepared, record, operations, skipped);
    const parsed = remoteSyncPushReceiptHttpSchema.safeParse(receipt);
    if (!parsed.success) fail("REMOTE_UNAVAILABLE");
    await client.query(
      `UPDATE remote_sync_http_pushes SET state='committed',receipt_json=$5::jsonb,updated_at=$6
        WHERE project_id=$1 AND branch_name=$2 AND actor_id=$3 AND prepare_id=$4`,
      [prepared.source.project_id, prepared.source.branch_name, prepared.source.actor_id, prepared.prepare_id,
        JSON.stringify(parsed.data), at]
    );
    return parsed.data;
  }

  async function preparePush(input: RemoteSyncPushPrepareHttpRequest): Promise<RemoteSyncIdempotencyResult<RemoteSyncPreparedPush>> {
    open();
    ensureSource(input.source, input.lease);
    ensureUniquePushPaths(input);
    const parsedInput = remoteSyncPushPrepareHttpRequestSchema.safeParse(input);
    if (!parsedInput.success || remoteSyncPayloadHash(parsedInput.data) !== parsedInput.data.payload_hash) {
      fail("SYNC_STREAM_INVALID");
    }
    const requestHash = hash(input);
    return transaction(options.pool, async (client) => {
      await lockBranch(client, input.source);
      const priorResult = await client.query<PushRow>(
        `SELECT * FROM remote_sync_http_pushes
          WHERE project_id=$1 AND branch_name=$2 AND actor_id=$3 AND idempotency_key=$4 FOR UPDATE`,
        [input.source.project_id, input.source.branch_name, input.source.actor_id, input.idempotency_key]
      );
      const prior = priorResult.rows[0];
      if (prior !== undefined) {
        if (prior.request_hash !== requestHash) return { outcome: "conflict", error: { code: "SYNC_IDEMPOTENCY_CONFLICT", retryable: false } };
        return { outcome: "replay", value: preparedFromJson({
          schema_version: 1, prepare_id: prior.prepare_id, source: jsonObject(prior.source_json),
          lease_id: prior.lease_id, lease_token: prior.lease_token, lease_generation: numberGeneration(prior.lease_generation),
          expected_revision: prior.expected_revision, preview_hash: prior.preview_hash, idempotency_key: prior.idempotency_key,
          payload_hash: prior.payload_hash, state: "prepared", expires_at: iso(prior.expires_at),
        }) };
      }
      await verifyUploadRefs(client, input);
      const { at } = await requireLease(client, input.source, input.lease, input.source);
      const pointer = await currentPointer(client, input.source);
      const revision = pointer?.revision ?? "0";
      if (revision !== input.expected_revision) fail("SYNC_PREVIEW_STALE");
      const prepared: RemoteSyncPreparedPush = {
        schema_version: 1,
        prepare_id: token("prepare"),
        source: input.source,
        lease_id: input.lease.lease_id,
        lease_token: input.lease.lease_token,
        lease_generation: input.lease.generation,
        expected_revision: input.expected_revision,
        preview_hash: input.preview_hash,
        idempotency_key: input.idempotency_key,
        payload_hash: input.payload_hash,
        state: "prepared",
        expires_at: input.lease.expires_at,
      };
      await client.query(
        `INSERT INTO remote_sync_http_pushes
          (project_id,branch_name,actor_id,idempotency_key,prepare_id,source_json,lease_id,lease_token,
           lease_generation,expected_revision,preview_hash,payload_hash,request_hash,files_json,operations_json,
           skipped_json,state,created_at,expires_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16::jsonb,'prepared',$17,$18,$17)`,
        [input.source.project_id, input.source.branch_name, input.source.actor_id, input.idempotency_key,
          prepared.prepare_id, canonicalJson(input.source), input.lease.lease_id, input.lease.lease_token,
          input.lease.generation, input.expected_revision, input.preview_hash, input.payload_hash, requestHash,
          JSON.stringify(input.files), JSON.stringify(input.operations), JSON.stringify(input.skipped), at, input.lease.expires_at]
      );
      return { outcome: "new", value: prepared };
    });
  }

  async function acquireLease(input: { source: RemoteSyncSourceRef; ttl_ms?: number; idempotency_key: string }): Promise<RemoteSyncIdempotencyResult<RemoteSyncLease>> {
    open();
    const ttl = input.ttl_ms ?? 60_000;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 600_000) fail("SYNC_LEASE_INVALID");
    const fingerprint = leasePayloadHash("acquire", { source: input.source, ttl_ms: ttl });
    return transaction(options.pool, async (client) => {
      await lockBranch(client, input.source);
      const priorResult = await client.query<LeaseCommandRow>(
        `SELECT payload_hash,command_kind,generation,lease_json FROM remote_sync_http_lease_commands
          WHERE project_id=$1 AND branch_name=$2 AND actor_id=$3 AND idempotency_key=$4 FOR UPDATE`,
        [input.source.project_id, input.source.branch_name, input.source.actor_id, input.idempotency_key]
      );
      const prior = priorResult.rows[0];
      if (prior !== undefined) {
        if (prior.payload_hash !== fingerprint || prior.command_kind !== "acquire" || prior.lease_json === null) {
          return { outcome: "conflict", error: { code: "SYNC_IDEMPOTENCY_CONFLICT", retryable: false } };
        }
        return { outcome: "replay", value: leaseFromJson(prior.lease_json) };
      }
      const active = await activeLease(client, input.source);
      const at = now();
      if (active !== undefined && Date.parse(iso(active.expires_at)) > Date.parse(at)) fail("SYNC_LEASE_BUSY", true);
      const generationResult = await client.query<{ generation: string | number }>(
        `SELECT COALESCE(MAX(generation),0) AS generation FROM remote_sync_http_lease_commands
          WHERE project_id=$1 AND branch_name=$2`, [input.source.project_id, input.source.branch_name]
      );
      const generation = numberGeneration(Number(generationResult.rows[0]?.generation ?? 0) + 1);
      const lease: RemoteSyncLease = {
        schema_version: 1, lease_id: token("lease"), lease_token: token("lease"), generation,
        project_id: input.source.project_id, branch_name: input.source.branch_name,
        actor_id: input.source.actor_id, expires_at: new Date(Date.parse(at) + ttl).toISOString(),
      };
      await client.query(
        `INSERT INTO remote_sync_http_active_leases
          (project_id,branch_name,actor_id,lease_id,lease_token,generation,expires_at,source_json,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$9)
         ON CONFLICT (project_id,branch_name) DO UPDATE SET actor_id=EXCLUDED.actor_id,lease_id=EXCLUDED.lease_id,
           lease_token=EXCLUDED.lease_token,generation=EXCLUDED.generation,expires_at=EXCLUDED.expires_at,
           source_json=EXCLUDED.source_json,updated_at=EXCLUDED.updated_at`,
        [lease.project_id, lease.branch_name, lease.actor_id, lease.lease_id, lease.lease_token, lease.generation,
          lease.expires_at, canonicalJson(input.source), at]
      );
      await client.query(
        `INSERT INTO remote_sync_http_lease_commands
          (project_id,branch_name,actor_id,idempotency_key,command_kind,payload_hash,generation,lease_json,created_at)
         VALUES ($1,$2,$3,$4,'acquire',$5,$6,$7::jsonb,$8)`,
        [input.source.project_id, input.source.branch_name, input.source.actor_id, input.idempotency_key,
          fingerprint, generation, JSON.stringify(lease), at]
      );
      return { outcome: "new", value: lease };
    });
  }

  async function renewLease(input: { lease: RemoteSyncLease; ttl_ms?: number; idempotency_key: string }): Promise<RemoteSyncIdempotencyResult<RemoteSyncLease>> {
    open();
    const ttl = input.ttl_ms ?? 60_000;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 600_000) fail("SYNC_LEASE_INVALID");
    const source: RemoteSyncSourceRef = {
      project_id: input.lease.project_id, branch_name: input.lease.branch_name, actor_id: input.lease.actor_id,
    };
    const fingerprint = leasePayloadHash("renew", { lease: input.lease, ttl_ms: ttl });
    return transaction(options.pool, async (client) => {
      await lockBranch(client, source);
      const priorResult = await client.query<LeaseCommandRow>(
        `SELECT payload_hash,command_kind,generation,lease_json FROM remote_sync_http_lease_commands
          WHERE project_id=$1 AND branch_name=$2 AND actor_id=$3 AND idempotency_key=$4 FOR UPDATE`,
        [source.project_id, source.branch_name, source.actor_id, input.idempotency_key]
      );
      const prior = priorResult.rows[0];
      if (prior !== undefined) {
        if (prior.payload_hash !== fingerprint || prior.command_kind !== "renew" || prior.lease_json === null) return { outcome: "conflict", error: { code: "SYNC_IDEMPOTENCY_CONFLICT", retryable: false } };
        return { outcome: "replay", value: leaseFromJson(prior.lease_json) };
      }
      const { at } = await requireLease(client, source, input.lease);
      const renewed: RemoteSyncLease = { ...input.lease, expires_at: new Date(Date.parse(at) + ttl).toISOString() };
      await client.query(
        `UPDATE remote_sync_http_active_leases SET expires_at=$4,updated_at=$5
          WHERE project_id=$1 AND branch_name=$2 AND lease_id=$3`,
        [source.project_id, source.branch_name, input.lease.lease_id, renewed.expires_at, at]
      );
      await client.query(
        `INSERT INTO remote_sync_http_lease_commands
          (project_id,branch_name,actor_id,idempotency_key,command_kind,payload_hash,generation,lease_json,created_at)
         VALUES ($1,$2,$3,$4,'renew',$5,$6,$7::jsonb,$8)`,
        [source.project_id, source.branch_name, source.actor_id, input.idempotency_key, fingerprint,
          renewed.generation, JSON.stringify(renewed), at]
      );
      return { outcome: "new", value: renewed };
    });
  }

  async function releaseLease(input: { lease: RemoteSyncLease; idempotency_key: string }): Promise<RemoteSyncIdempotencyResult<void>> {
    open();
    const source: RemoteSyncSourceRef = {
      project_id: input.lease.project_id, branch_name: input.lease.branch_name, actor_id: input.lease.actor_id,
    };
    const fingerprint = leasePayloadHash("release", input.lease);
    return transaction(options.pool, async (client) => {
      await lockBranch(client, source);
      const priorResult = await client.query<LeaseCommandRow>(
        `SELECT payload_hash,command_kind,generation,lease_json FROM remote_sync_http_lease_commands
          WHERE project_id=$1 AND branch_name=$2 AND actor_id=$3 AND idempotency_key=$4 FOR UPDATE`,
        [source.project_id, source.branch_name, source.actor_id, input.idempotency_key]
      );
      const prior = priorResult.rows[0];
      if (prior !== undefined) {
        if (prior.payload_hash !== fingerprint || prior.command_kind !== "release") return { outcome: "conflict", error: { code: "SYNC_IDEMPOTENCY_CONFLICT", retryable: false } };
        return { outcome: "replay", value: undefined };
      }
      const { at } = await requireLease(client, source, input.lease);
      await client.query(`DELETE FROM remote_sync_http_active_leases WHERE project_id=$1 AND branch_name=$2`, [source.project_id, source.branch_name]);
      await client.query(
        `INSERT INTO remote_sync_http_lease_commands
          (project_id,branch_name,actor_id,idempotency_key,command_kind,payload_hash,generation,lease_json,created_at)
         VALUES ($1,$2,$3,$4,'release',$5,$6,NULL,$7)`,
        [source.project_id, source.branch_name, source.actor_id, input.idempotency_key, fingerprint, input.lease.generation, at]
      );
      return { outcome: "new", value: undefined };
    });
  }

  async function commitPush(input: RemoteSyncPushCommitHttpRequest): Promise<RemoteSyncIdempotencyResult<RemoteSyncPushReceiptHttp>> {
    open();
    const source: RemoteSyncSourceRef = {
      project_id: input.lease.project_id, branch_name: input.lease.branch_name, actor_id: input.lease.actor_id,
    };
    return transaction(options.pool, async (client) => {
      await lockBranch(client, source);
      const result = await client.query<PushRow>(
        `SELECT * FROM remote_sync_http_pushes WHERE project_id=$1 AND branch_name=$2 AND actor_id=$3 AND prepare_id=$4 FOR UPDATE`,
        [source.project_id, source.branch_name, source.actor_id, input.prepare_id]
      );
      const found = result.rows[0];
      if (found === undefined) fail("SYNC_PREPARE_NOT_FOUND");
      if (found.idempotency_key !== input.idempotency_key || found.payload_hash !== input.payload_hash) {
        return { outcome: "conflict", error: { code: "SYNC_IDEMPOTENCY_CONFLICT", retryable: false } };
      }
      const prepared = preparedFromRow(found);
      ensureSource(prepared.source, input.lease);
      ensurePreparedLease(found, input.lease);
      const arrays = pushOperations(found);
      if (found.state === "committed" && found.receipt_json !== null) {
        const receipt = receiptFromJson(found.receipt_json);
        if (!sameSource(receipt.source, prepared.source) || receipt.prepare_id !== prepared.prepare_id ||
            receipt.idempotency_key !== prepared.idempotency_key || receipt.payload_hash !== prepared.payload_hash) {
          fail("REMOTE_UNAVAILABLE");
        }
        return { outcome: "replay", value: receipt };
      }
      if (found.state === "committing" || found.state === "failed") {
        const recovered = await recoverDurableSnapshot(client, found, prepared, arrays.operations, arrays.skipped, now());
        if (recovered !== null) return { outcome: "replay", value: recovered };
      }
      const { files, operations, skipped } = arrays;
      if (found.state === "failed") fail("SYNC_COMMIT_AMBIGUOUS", true);
      const { at } = await requireLease(client, prepared.source, input.lease, prepared.source);
      if (Date.parse(iso(found.expires_at)) <= Date.parse(at)) fail("SYNC_PREPARE_EXPIRED");
      if (operationPaths(arrays.operations).length === 0) {
        const pointer = await currentPointer(client, prepared.source);
        const snapshot = remoteSnapshotFromRow(prepared.source, pointer);
        const receipt: RemoteSyncPushReceiptHttp = {
          schema_version: 1,
          prepare_id: prepared.prepare_id,
          source: prepared.source,
          idempotency_key: prepared.idempotency_key,
          payload_hash: prepared.payload_hash,
          preview_hash: prepared.preview_hash,
          project_version: snapshot.project_version,
          artifact_id: snapshot.artifact_id,
          commit_sha: snapshot.commit_sha,
          manifest_hash: snapshot.manifest_hash,
          no_changes: true,
          applied: [],
          skipped: [...arrays.skipped],
          retryable: [],
        };
        const parsed = remoteSyncPushReceiptHttpSchema.safeParse(receipt);
        if (!parsed.success) fail("REMOTE_UNAVAILABLE");
        await client.query(
          `UPDATE remote_sync_http_pushes SET state='committed',receipt_json=$5::jsonb,updated_at=$6
            WHERE project_id=$1 AND branch_name=$2 AND actor_id=$3 AND prepare_id=$4`,
          [prepared.source.project_id, prepared.source.branch_name, prepared.source.actor_id,
            prepared.prepare_id, JSON.stringify(parsed.data), at]
        );
        return { outcome: "new", value: parsed.data };
      }
      await client.query(`UPDATE remote_sync_http_pushes SET state='committing',updated_at=$5 WHERE project_id=$1 AND branch_name=$2 AND actor_id=$3 AND prepare_id=$4`,
        [source.project_id, source.branch_name, source.actor_id, input.prepare_id, at]);
      const refs = files.filter((file) => file.size > 0 && file.upload_ref !== undefined)
        .map((file) => file.upload_ref as RemoteContentUploadHttpRef)
        .sort((left, right) => left.sha256.localeCompare(right.sha256) || left.ref_id.localeCompare(right.ref_id));
      const locked = new Set<string>();
      for (const ref of refs) {
        if (locked.has(ref.sha256)) continue;
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          uploadObjectLockKey(prepared.source.project_id, ref.sha256)
        ]);
        locked.add(ref.sha256);
      }
      const materialized = await materializeRemoteSyncPushFiles({
        files,
        operations,
        resolveUpload: async (ref) => {
          if (ref === undefined) fail("SYNC_STREAM_INVALID");
          return options.resolveUpload({ source: prepared.source as RemoteContentUploadHttpSource,
            upload_ref: ref, purpose: "remote_sync_file", now: now(), executor: client, allow_expired: true });
        },
      });
      const parentFiles = await loadParentSeedFiles(client, prepared.source);
      const seedFiles = mergePushSeedFiles(parentFiles, materialized, operations);
      const manifestRefs = seedFiles.map((entry) => {
        const { content, ...ref } = entry;
        void content;
        return ref;
      });
      // Use the CLI-compatible shape for the snapshot manifest hash; the richer
      // canonicalSnapshotFileRefs (with media_type/action) is only meaningful
      // for the branch-snapshots module's own validation.
      const manifest_hash = remoteSyncManifestHash(manifestRefs);
      const suffix = idSuffix({ prepare_id: prepared.prepare_id, payload_hash: prepared.payload_hash });
      if (prepared.source.commit_sha === undefined || options.branchSnapshotProducer.publishWithClient === undefined) {
        fail("REMOTE_UNAVAILABLE");
      }
      const producerResult = await options.branchSnapshotProducer.publishWithClient(client, {
        schema_version: 1,
        actor_id: prepared.source.actor_id,
        idempotency_key: prepared.idempotency_key,
        expected_revision: prepared.expected_revision,
        lease_fence: input.lease,
        source: { ...prepared.source, commit_sha: prepared.source.commit_sha },
        project_version: `pv_${suffix}`,
        artifact_id: `art_${suffix}`,
        manifest_hash,
        diff_ref: `diff_${suffix}`,
        uploaded_at: now(),
        changed_paths: operationPaths(operations),
        removed_paths: removedOperationPaths(operations),
        files: seedFiles,
      });
      if (producerResult.outcome === "no_changes") fail("REMOTE_UNAVAILABLE");
      if (producerResult.outcome === "conflict") {
        if (producerResult.reason_code === "BRANCH_SNAPSHOT_REVISION_CONFLICT") fail("SYNC_PREVIEW_STALE");
        if (producerResult.reason_code === "BRANCH_SNAPSHOT_LEASE_FENCED") fail("SYNC_LEASE_FENCED");
        fail("SYNC_IDEMPOTENCY_CONFLICT");
      }
      const receipt = receiptFromRecord(prepared, producerResult.record, operations, skipped);
      const parsedReceipt = remoteSyncPushReceiptHttpSchema.safeParse(receipt);
      if (!parsedReceipt.success) fail("REMOTE_UNAVAILABLE");
      await client.query(
        `UPDATE remote_sync_http_pushes SET state='committed',receipt_json=$5::jsonb,updated_at=$6
          WHERE project_id=$1 AND branch_name=$2 AND actor_id=$3 AND prepare_id=$4`,
        [source.project_id, source.branch_name, source.actor_id, prepared.prepare_id, JSON.stringify(parsedReceipt.data), now()]
      );
      return { outcome: "new", value: parsedReceipt.data };
    });
  }

  async function readRemoteSnapshot(input: { source: RemoteSyncSourceRef; expected_revision?: string; signal?: AbortSignal }): Promise<RemoteSyncRemoteSnapshot> {
    open();
    if (input.signal?.aborted === true) fail("SYNC_STREAM_ABORTED", true);
    const row = await currentPointer(options.pool, input.source);
    const snapshot = remoteSnapshotFromRow(input.source, row);
    if (input.expected_revision !== undefined && input.expected_revision !== snapshot.revision) fail("SYNC_PREVIEW_STALE");
    return snapshot;
  }

  async function openContentStream(input: { source: RemoteSyncSourceRef; path: string; snapshot_id: string; expected_revision: string; chunk_size: number; signal?: AbortSignal }): Promise<RemoteSyncHttpContentStream> {
    open();
    if (input.signal?.aborted === true) fail("SYNC_STREAM_ABORTED", true);
    const pointer = await currentPointer(options.pool, input.source);
    const snapshot = remoteSnapshotFromRow(input.source, pointer);
    if (snapshot.snapshot_id !== input.snapshot_id || snapshot.revision !== input.expected_revision) fail("SYNC_PREVIEW_STALE");
    const file = snapshot.files.find((candidate) => candidate.path === input.path);
    if (file === undefined || pointer === undefined) fail("SYNC_SNAPSHOT_NOT_FOUND");
    const result = await options.pool.query<{ content_bytes: Buffer }>(
      `SELECT b.content_bytes FROM branch_snapshot_blobs b WHERE b.content_hash=$1`, [file.content_hash]
    );
    const bytes = result.rows[0]?.content_bytes;
    if (bytes === undefined || bytes.byteLength !== file.size || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== file.content_hash) fail("REMOTE_UNAVAILABLE");
    const chunkSize = Math.max(1, Math.min(input.chunk_size, 1024 * 1024));
    return {
      snapshot_id: snapshot.snapshot_id, revision: snapshot.revision, content_sha256: file.content_hash, size: file.size,
      stream: (async function* (): AsyncGenerator<RemoteSyncContentChunk> {
        let sequence = 0;
        if (bytes.byteLength === 0) {
          const empty = new Uint8Array(new ArrayBuffer(0)) as Uint8Array<ArrayBuffer>;
          yield {
            sequence: 0,
            offset: 0,
            size: 0,
            chunk_hash: `sha256:${createHash("sha256").update(empty).digest("hex")}`,
            final: true,
            bytes: empty
          };
          return;
        }
        for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
          if (input.signal?.aborted === true) fail("SYNC_STREAM_ABORTED", true);
          const length = Math.min(chunkSize, bytes.byteLength - offset);
          const chunk = new Uint8Array(new ArrayBuffer(length)) as Uint8Array<ArrayBuffer>;
          chunk.set(bytes.subarray(offset, offset + length));
          yield { sequence, offset, size: chunk.byteLength, chunk_hash: `sha256:${createHash("sha256").update(chunk).digest("hex")}`, final: offset + chunk.byteLength === bytes.byteLength, bytes: chunk };
          sequence += 1;
        }
      })(),
    };
  }

  async function getPushStatus(input: { source: RemoteSyncSourceRef; idempotency_key: string }): Promise<RemoteSyncPushStatus | null> {
    open();
    const result = await options.pool.query<PushRow>(
      `SELECT * FROM remote_sync_http_pushes WHERE project_id=$1 AND branch_name=$2 AND actor_id=$3 AND idempotency_key=$4`,
      [input.source.project_id, input.source.branch_name, input.source.actor_id, input.idempotency_key]
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    if (!sameSource(sourceFromJson(row.source_json), input.source)) return null;
    const value: RemoteSyncPushStatus = {
      source: jsonObject(row.source_json) as RemoteSyncSourceRef,
      state: row.state as RemoteSyncPushStatus["state"],
      prepare_id: row.prepare_id,
      idempotency_key: row.idempotency_key,
      payload_hash: row.payload_hash,
      ...(row.receipt_json === null ? {} : { receipt: receiptFromJson(row.receipt_json) }),
    };
    const parsed = remoteSyncPushStatusSchema.safeParse(value);
    if (!parsed.success) fail("REMOTE_UNAVAILABLE");
    return parsed.data;
  }

  async function getPushReceipt(input: { source: RemoteSyncSourceRef; prepare_id: string }): Promise<RemoteSyncPushReceiptHttp | null> {
    open();
    const result = await options.pool.query<PushRow>(
      `SELECT * FROM remote_sync_http_pushes WHERE project_id=$1 AND branch_name=$2 AND actor_id=$3 AND prepare_id=$4`,
      [input.source.project_id, input.source.branch_name, input.source.actor_id, input.prepare_id]
    );
    const row = result.rows[0];
    if (row === undefined || row.receipt_json === null) return null;
    if (!sameSource(sourceFromJson(row.source_json), input.source)) return null;
    const receipt = receiptFromJson(row.receipt_json);
    if (!sameSource(receipt.source, input.source)) fail("REMOTE_UNAVAILABLE");
    return receipt;
  }

  async function pull(input: { source: RemoteSyncSourceRef; actor_id: string; idempotency_key: string; payload_hash?: string; signal?: AbortSignal }): Promise<RemoteSyncIdempotencyResult<RemoteSyncPullReceipt>> {
    open();
    if (input.signal?.aborted === true) fail("SYNC_STREAM_ABORTED", true);
    if (input.actor_id !== input.source.actor_id) fail("SYNC_LEASE_SCOPE_MISMATCH");
    const payloadHash = input.payload_hash ?? hash({ source: input.source, actor_id: input.actor_id, idempotency_key: input.idempotency_key });
    return transaction(options.pool, async (client) => {
      await lockBranch(client, input.source);
      const priorResult = await client.query<{ payload_hash: string; receipt_json: unknown }>(
        `SELECT payload_hash,receipt_json FROM remote_sync_http_pulls
          WHERE project_id=$1 AND branch_name=$2 AND actor_id=$3 AND idempotency_key=$4 FOR UPDATE`,
        [input.source.project_id, input.source.branch_name, input.source.actor_id, input.idempotency_key]
      );
      const prior = priorResult.rows[0];
      if (prior !== undefined) {
        if (prior.payload_hash !== payloadHash) {
          return { outcome: "conflict", error: { code: "SYNC_IDEMPOTENCY_CONFLICT", retryable: false } };
        }
        const parsed = remoteSyncPullReceiptSchema.safeParse(jsonObject(prior.receipt_json));
        if (!parsed.success || !sameSource(parsed.data.source, input.source) ||
            parsed.data.idempotency_key !== input.idempotency_key || parsed.data.payload_hash !== payloadHash) {
          fail("REMOTE_UNAVAILABLE");
        }
        return { outcome: "replay", value: parsed.data };
      }
      if (options.workspaceRoot === undefined) fail("REMOTE_UNAVAILABLE");
      const pointer = await currentPointer(client, input.source);
      const snapshot = remoteSnapshotFromRow(input.source, pointer);
      const workspaceRoot = join(options.workspaceRoot, idSuffix({
        project_id: input.source.project_id,
        branch_name: input.source.branch_name,
      }));
      const operations: TransactionOperation[] = [];
      const previousPaths = await previousPullPaths(workspaceRoot, input.source);
      const currentPaths = new Set<string>();
      for (const file of snapshot.files) {
        currentPaths.add(managedPullPath(file.path));
        const blob = await client.query<{ content_bytes: Buffer }>(
          "SELECT content_bytes FROM branch_snapshot_blobs WHERE content_hash=$1",
          [file.content_hash]
        );
        const bytes = blob.rows[0]?.content_bytes;
        if (bytes === undefined || bytes.byteLength !== file.size ||
            `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== file.content_hash) {
          fail("REMOTE_UNAVAILABLE");
        }
        operations.push({ operation: "modify", path: file.path, content: new Uint8Array(bytes) });
      }
      for (const path of [...previousPaths].sort((left, right) => left.localeCompare(right))) {
        if (!currentPaths.has(path)) operations.push({ operation: "delete", path });
      }
      const appliedOperations = [
        ...snapshot.files.map((file) => ({
          path: file.path,
          content_kind: pullContentKind(file.path, file.content_kind),
          action: "modify" as const,
          remote_hash: file.content_hash
        })),
        ...[...previousPaths]
          .filter((path) => !currentPaths.has(path))
          .sort((left, right) => left.localeCompare(right))
          .map((path) => ({
            path,
            content_kind: pullContentKind(path, undefined),
            action: "delete" as const
          }))
      ];
      const transactionId = `remote_pull_${idSuffix({
        source: input.source,
        idempotency_key: input.idempotency_key,
      })}`;
      const applied = await runTransaction(workspaceRoot, operations, {
        id: transactionId,
        kind: "update",
        projectIdentity: canonicalJson({ source: input.source, direction: "pull" }),
        targetBundleVersion: snapshot.revision,
        ownershipManifestHash: snapshot.manifest_hash,
      });
      if (applied.status !== "committed") fail("SYNC_PULL_WORKSPACE_FAILED", true);
      const receipt = remoteSyncPullReceiptSchema.parse({
        schema_version: 1,
        source: input.source,
        idempotency_key: input.idempotency_key,
        payload_hash: payloadHash,
        remote_revision: snapshot.revision,
        local_transaction: "committed",
        commit_sha: snapshot.commit_sha,
        artifact_id: snapshot.artifact_id,
        manifest_hash: snapshot.manifest_hash,
        project_version: snapshot.project_version,
        no_changes: operations.length === 0,
        applied: appliedOperations,
        skipped: [],
        retryable: [],
      });
      await mkdir(join(workspaceRoot, ".harness", "state"), { recursive: true });
      await writeFile(join(workspaceRoot, ".harness", "state", "remote-sync-manifest.json"),
        JSON.stringify({
          source: input.source,
          revision: snapshot.revision,
          manifest_hash: snapshot.manifest_hash,
          files: snapshot.files.map((file) => ({
            path: file.path,
            content_hash: file.content_hash,
            size: file.size,
            ...(file.content_kind === undefined ? {} : { content_kind: file.content_kind })
          }))
        }), "utf8");
      await client.query(
        `INSERT INTO remote_sync_http_pulls
          (project_id,branch_name,actor_id,idempotency_key,payload_hash,receipt_json,created_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
        [input.source.project_id, input.source.branch_name, input.source.actor_id,
          input.idempotency_key, payloadHash, JSON.stringify(receipt), now()]
      );
      return { outcome: "new", value: receipt };
    });
  }

  return Object.freeze({
    acquireLease,
    renewLease,
    releaseLease,
    readRemoteSnapshot,
    openContentStream,
    preparePush,
    commitPush,
    getPushStatus,
    getPushReceipt,
    pull,
    async close(): Promise<void> { closed = true; },
  });
}

export { PgRemoteSyncHttpError };
