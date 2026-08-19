import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import { classifyContentPath } from "@hunter-harness/contracts";
import AdmZip from "adm-zip";

import {
  KnowledgePipelineError,
  changeDocumentIdentity,
  changeDocumentVersion,
  changeProjectionInputHash,
  changeProjectionOutputHash,
  validateArchivePackage,
  validateCoreV1ArchivePackage,
  type ArchiveStore,
  type ChangeDocument,
  type ChangeDocumentType,
  type ChangeProjectionCommitPort,
  type ChangeProjectionJob,
  type ChangeProjectionTaskPort,
  type CoreV1ArchiveIdentity,
  type StoredArchive
} from "../knowledge-pipeline/index.js";

export interface ArchivePackageVerifierLimits {
  max_package_bytes: number;
  max_file_count: number;
  max_file_bytes: number;
  max_uncompressed_bytes: number;
  max_compression_ratio: number;
}

export interface VerifiedProjectionEntry {
  path: string;
  content_hash: string;
  content: string;
}

export interface VerifiedProjectionArchive {
  schema_version: 1;
  project_id: string;
  change_key: string;
  archive_id: string;
  package_sha256: string;
  manifest_sha256: string;
  project_version: string;
  package_schema_version: number;
  archive_schema_version: number;
  validation_receipt: StoredArchive["validation_receipt"];
  entries: readonly VerifiedProjectionEntry[];
}

export interface ArchivePackageVerifierPort {
  verify(input: {
    package_bytes: Uint8Array;
    manifest_bytes: Uint8Array;
    limits: ArchivePackageVerifierLimits;
    verified_at: string;
    /**
     * core-v1 包的身份不在 manifest 里（客户端无从得知服务端 id），由已入库的
     * 归档记录提供。v2 包不传，身份仍从 manifest 自证。
     */
    core_v1_identity?: CoreV1ArchiveIdentity;
  }): Promise<VerifiedProjectionArchive>;
  isTrusted(value: unknown): value is VerifiedProjectionArchive;
}

const trustedProjectionArchives = new WeakSet<object>();

/** Adapter over the frozen archive validator; it does not duplicate validation rules. */
export function createArchivePackageVerifier(): ArchivePackageVerifierPort {
  return Object.freeze({
    async verify(input: {
      package_bytes: Uint8Array;
      manifest_bytes: Uint8Array;
      limits: ArchivePackageVerifierLimits;
      verified_at: string;
      core_v1_identity?: CoreV1ArchiveIdentity;
    }) {
      const validated = input.core_v1_identity === undefined
        ? validateArchivePackage({
          package_bytes: input.package_bytes,
          manifest_bytes: input.manifest_bytes,
          limits: input.limits,
          validated_at: input.verified_at
        })
        : validateCoreV1ArchivePackage({
          package_bytes: input.package_bytes,
          manifest_bytes: input.manifest_bytes,
          identity: input.core_v1_identity,
          limits: input.limits,
          validated_at: input.verified_at
        });
      const zip = new AdmZip(Buffer.from(input.package_bytes));
      const entries = zip.getEntries().filter((entry) => documentType(entry.entryName) !== null)
        .map((entry) => {
          const content = new TextDecoder("utf-8", { fatal: true }).decode(entry.getData());
          return Object.freeze({
            path: entry.entryName,
            content_hash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
            content
          });
        });
      const result = Object.freeze({
        schema_version: 1 as const,
        project_id: validated.project_id,
        change_key: validated.change_key,
        archive_id: validated.archive_id,
        package_sha256: validated.package_sha256,
        manifest_sha256: validated.manifest_sha256,
        project_version: validated.project_version,
        package_schema_version: validated.package_schema_version,
        archive_schema_version: validated.archive_schema_version,
        validation_receipt: validated.validation_receipt,
        entries: Object.freeze(entries)
      });
      trustedProjectionArchives.add(result);
      return result;
    },
    isTrusted(value: unknown): value is VerifiedProjectionArchive {
      return value !== null && typeof value === "object" && trustedProjectionArchives.has(value);
    }
  });
}

const timestampPattern = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u;
const sha256Pattern = /^sha256:[a-f0-9]{64}$/u;
const jobRequiredKeys = [
  "schema_version", "job_id", "project_id", "change_key", "archive_id", "package_sha256",
  "manifest_sha256", "project_version", "package_schema_version", "archive_schema_version",
  "status", "attempt", "project_generation", "generation", "input_hash", "retryable",
  "created_at", "updated_at"
] as const;
const jobOptionalKeys = [
  "owner_id", "lease_token", "lease_expires_at", "output_hash", "document_count", "reason_code"
] as const;
const archiveKeys = [
  "schema_version", "project_id", "change_key", "archive_id", "package_sha256",
  "manifest_sha256", "project_version", "package_schema_version", "archive_schema_version",
  "package_bytes", "manifest_bytes", "knowledge_candidates", "project_content_candidates",
  "validation_receipt", "stored_at"
] as const;
const validationReceiptKeys = [
  "schema_version", "package_sha256", "manifest_sha256", "package_schema_version",
  "archive_schema_version", "safe_paths", "no_symlinks", "no_encrypted_entries",
  "declared_files_verified", "content_hashes_verified", "candidate_sources_bound",
  "file_count", "compressed_bytes", "uncompressed_bytes", "validated_at"
] as const;
const verifiedArchiveKeys = [
  "schema_version", "project_id", "change_key", "archive_id", "package_sha256",
  "manifest_sha256", "project_version", "package_schema_version", "archive_schema_version",
  "validation_receipt", "entries"
] as const;
const verifiedEntryKeys = ["path", "content_hash", "content"] as const;

export interface ChangeProjectionWorkerInput {
  job_id: string;
  owner_id: string;
}

export interface ChangeProjectionWorkerResult {
  job_id: string;
  status: "ready" | "failed";
  retryable: boolean;
  document_count?: number;
  output_hash?: string;
  reason_code?: string;
}

export interface ChangeProjectionWorker {
  run(input: ChangeProjectionWorkerInput): Promise<ChangeProjectionWorkerResult>;
}

export interface ChangeProjectionWorkerDependencies {
  task_port: ChangeProjectionTaskPort;
  archive_store: ArchiveStore;
  commit_port: ChangeProjectionCommitPort;
  archive_verifier: ArchivePackageVerifierPort;
  verification_limits: ArchivePackageVerifierLimits;
  clock: () => string;
  lease_duration_ms: number;
}

class WorkerFailure extends Error {
  constructor(readonly reason_code: string, readonly retryable: boolean) {
    super(reason_code);
  }
}

function fail(reasonCode: string, retryable = false): never {
  throw new WorkerFailure(reasonCode, retryable);
}

function strictTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !timestampPattern.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function ownDataRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  reasonCode: string
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length > 0) fail(reasonCode);
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  const keys = Object.keys(descriptors);
  if (required.some((key) => !keys.includes(key)) ||
      keys.some((key) => !required.includes(key) && !optional.includes(key))) fail(reasonCode);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) fail(reasonCode);
    result[key] = descriptor.value;
  }
  return result;
}

function text(value: unknown, reasonCode: string, max = 512): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value.trim() !== value ||
      Array.from(value).some((character) => character.charCodeAt(0) < 32)) fail(reasonCode);
  return value;
}

function contentText(value: unknown, reasonCode: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1_048_576 ||
      value.includes("\0")) fail(reasonCode);
  return value;
}

function positiveInteger(value: unknown, reasonCode: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) fail(reasonCode);
  return Number(value);
}

function workerInput(value: unknown): ChangeProjectionWorkerInput {
  const record = ownDataRecord(value, ["job_id", "owner_id"], [], "CHANGE_PROJECTION_WORKER_INPUT_INVALID");
  return {
    job_id: text(record.job_id, "CHANGE_PROJECTION_WORKER_INPUT_INVALID"),
    owner_id: text(record.owner_id, "CHANGE_PROJECTION_WORKER_INPUT_INVALID")
  };
}

function now(clock: () => string): string {
  const value = clock();
  if (!strictTimestamp(value)) fail("CHANGE_PROJECTION_CLOCK_INVALID");
  return value;
}

function leaseExpiry(current: string, duration: number): string {
  const value = new Date(new Date(current).getTime() + duration).toISOString();
  if (!strictTimestamp(value)) fail("CHANGE_PROJECTION_CLOCK_INVALID");
  return value;
}

function jobSnapshot(value: unknown): ChangeProjectionJob {
  const record = ownDataRecord(value, jobRequiredKeys, jobOptionalKeys, "CHANGE_PROJECTION_PORT_INVALID");
  const reason = "CHANGE_PROJECTION_PORT_INVALID";
  if (record.schema_version !== 1 || typeof record.status !== "string" ||
      !["queued", "projecting", "ready", "failed"].includes(record.status) ||
      !sha256Pattern.test(text(record.package_sha256, reason)) ||
      !sha256Pattern.test(text(record.manifest_sha256, reason)) ||
      !sha256Pattern.test(text(record.input_hash, reason)) ||
      !strictTimestamp(record.created_at) || !strictTimestamp(record.updated_at) ||
      typeof record.retryable !== "boolean") fail(reason);
  const base = {
    schema_version: 1 as const,
    job_id: text(record.job_id, reason),
    project_id: text(record.project_id, reason),
    change_key: text(record.change_key, reason, 160),
    archive_id: text(record.archive_id, reason),
    package_sha256: record.package_sha256 as string,
    manifest_sha256: record.manifest_sha256 as string,
    project_version: text(record.project_version, reason),
    package_schema_version: positiveInteger(record.package_schema_version, reason),
    archive_schema_version: positiveInteger(record.archive_schema_version, reason),
    attempt: positiveInteger(record.attempt, reason),
    project_generation: positiveInteger(record.project_generation, reason),
    generation: positiveInteger(record.generation, reason),
    input_hash: record.input_hash as string,
    created_at: record.created_at as string,
    updated_at: record.updated_at as string
  };
  const owner = record.owner_id === undefined ? undefined : text(record.owner_id, reason);
  const token = record.lease_token === undefined ? undefined : text(record.lease_token, reason);
  const expires = record.lease_expires_at;
  const output = record.output_hash;
  const count = record.document_count;
  const failureReason = record.reason_code;
  if (expires !== undefined && !strictTimestamp(expires)) fail(reason);
  if (output !== undefined && (typeof output !== "string" || !sha256Pattern.test(output))) fail(reason);
  if (count !== undefined && (!Number.isSafeInteger(count) || Number(count) < 0)) fail(reason);
  if (failureReason !== undefined) text(failureReason, reason);
  if (record.status === "queued") {
    if (owner !== undefined || token !== undefined || expires !== undefined || output !== undefined ||
        count !== undefined || failureReason !== undefined || record.retryable !== true) fail(reason);
    return { ...base, status: "queued", retryable: true };
  }
  if (record.status === "projecting") {
    if (owner === undefined || token === undefined || expires === undefined ||
        expires <= record.updated_at || output !== undefined || count !== undefined ||
        failureReason !== undefined || record.retryable !== true) fail(reason);
    return {
      ...base, status: "projecting", retryable: true,
      owner_id: owner, lease_token: token, lease_expires_at: expires
    };
  }
  if (record.status === "ready") {
    if (owner !== undefined || token !== undefined || expires !== undefined || output === undefined ||
        count === undefined || failureReason !== undefined || record.retryable !== false) fail(reason);
    return { ...base, status: "ready", retryable: false, output_hash: output, document_count: Number(count) };
  }
  if (owner !== undefined || token !== undefined || expires !== undefined || output !== undefined ||
      count !== undefined || failureReason === undefined) fail(reason);
  return {
    ...base,
    status: "failed",
    retryable: record.retryable,
    reason_code: failureReason as string
  };
}

function ownDenseArray(value: unknown, reasonCode: string, max = 64): unknown[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0) {
    fail(reasonCode);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max) fail(reasonCode);
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) fail(reasonCode);
    result.push(descriptor.value);
  }
  if (Object.keys(descriptors).some((key) => key !== "length" && !/^(?:0|[1-9]\d*)$/u.test(key))) {
    fail(reasonCode);
  }
  return result;
}

function verifiedSnapshot(value: unknown): VerifiedProjectionArchive {
  const reason = "CHANGE_PROJECTION_PACKAGE_VERIFICATION_FAILED";
  const record = ownDataRecord(value, verifiedArchiveKeys, [], reason);
  const receipt = ownDataRecord(record.validation_receipt, validationReceiptKeys, [], reason);
  const entries = ownDenseArray(record.entries, reason).map((value) => {
    const entry = ownDataRecord(value, verifiedEntryKeys, [], reason);
    return {
      path: text(entry.path, reason, 240),
      content_hash: text(entry.content_hash, reason),
      content: contentText(entry.content, reason)
    };
  });
  if (record.schema_version !== 1 || receipt.schema_version !== 1 ||
      !sha256Pattern.test(text(record.package_sha256, reason)) ||
      !sha256Pattern.test(text(record.manifest_sha256, reason)) ||
      !strictTimestamp(receipt.validated_at)) fail(reason);
  return {
    schema_version: 1,
    project_id: text(record.project_id, reason),
    change_key: text(record.change_key, reason),
    archive_id: text(record.archive_id, reason),
    package_sha256: record.package_sha256 as string,
    manifest_sha256: record.manifest_sha256 as string,
    project_version: text(record.project_version, reason),
    package_schema_version: positiveInteger(record.package_schema_version, reason),
    archive_schema_version: positiveInteger(record.archive_schema_version, reason),
    validation_receipt: receipt as unknown as StoredArchive["validation_receipt"],
    entries
  };
}

function bytes(value: unknown): Uint8Array {
  if (!ArrayBuffer.isView(value) || nodeTypes.isProxy(value) ||
      (Object.getPrototypeOf(value) !== Uint8Array.prototype && !Buffer.isBuffer(value))) {
    fail("CHANGE_PROJECTION_ARCHIVE_INVALID");
  }
  return new Uint8Array(value as Uint8Array);
}

function archiveSnapshot(value: unknown): StoredArchive {
  const record = ownDataRecord(value, archiveKeys, [], "CHANGE_PROJECTION_ARCHIVE_INVALID");
  const packageBytes = bytes(record.package_bytes);
  const manifestBytes = bytes(record.manifest_bytes);
  const validationReceipt = ownDataRecord(
    record.validation_receipt,
    validationReceiptKeys,
    [],
    "CHANGE_PROJECTION_ARCHIVE_INVALID"
  );
  if (record.schema_version !== 1 || validationReceipt.schema_version !== 1 ||
      !strictTimestamp(record.stored_at) || !strictTimestamp(validationReceipt.validated_at) ||
      validationReceipt.package_sha256 !== record.package_sha256 ||
      validationReceipt.manifest_sha256 !== record.manifest_sha256 ||
      validationReceipt.package_schema_version !== record.package_schema_version ||
      validationReceipt.archive_schema_version !== record.archive_schema_version ||
      validationReceipt.safe_paths !== true || validationReceipt.no_symlinks !== true ||
      validationReceipt.no_encrypted_entries !== true ||
      validationReceipt.declared_files_verified !== true ||
      validationReceipt.content_hashes_verified !== true ||
      validationReceipt.candidate_sources_bound !== true ||
      !Number.isSafeInteger(validationReceipt.file_count) || Number(validationReceipt.file_count) < 0 ||
      !Number.isSafeInteger(validationReceipt.compressed_bytes) ||
      Number(validationReceipt.compressed_bytes) < 1 ||
      Number(validationReceipt.compressed_bytes) !== packageBytes.byteLength ||
      !Number.isSafeInteger(validationReceipt.uncompressed_bytes) ||
      Number(validationReceipt.uncompressed_bytes) < 1) {
    fail("CHANGE_PROJECTION_ARCHIVE_INVALID");
  }
  return {
    schema_version: 1,
    project_id: text(record.project_id, "CHANGE_PROJECTION_ARCHIVE_INVALID"),
    change_key: text(record.change_key, "CHANGE_PROJECTION_ARCHIVE_INVALID"),
    archive_id: text(record.archive_id, "CHANGE_PROJECTION_ARCHIVE_INVALID"),
    package_sha256: text(record.package_sha256, "CHANGE_PROJECTION_ARCHIVE_INVALID"),
    manifest_sha256: text(record.manifest_sha256, "CHANGE_PROJECTION_ARCHIVE_INVALID"),
    project_version: text(record.project_version, "CHANGE_PROJECTION_ARCHIVE_INVALID"),
    package_schema_version: positiveInteger(record.package_schema_version, "CHANGE_PROJECTION_ARCHIVE_INVALID"),
    archive_schema_version: positiveInteger(record.archive_schema_version, "CHANGE_PROJECTION_ARCHIVE_INVALID"),
    package_bytes: packageBytes,
    manifest_bytes: manifestBytes,
    knowledge_candidates: [],
    project_content_candidates: [],
    validation_receipt: validationReceipt as unknown as StoredArchive["validation_receipt"],
    stored_at: record.stored_at as string
  };
}

const immutableJobKeys = [
  "schema_version", "job_id", "project_id", "change_key", "archive_id", "package_sha256",
  "manifest_sha256", "project_version", "package_schema_version", "archive_schema_version",
  "project_generation", "input_hash", "created_at"
] as const;

function sameJobIdentity(before: ChangeProjectionJob, after: ChangeProjectionJob): boolean {
  return immutableJobKeys.every((key) => before[key] === after[key]);
}

function transitionInvalid(): never { fail("CHANGE_PROJECTION_PORT_INVALID"); }

function validateClaimTransition(
  before: ChangeProjectionJob,
  after: ChangeProjectionJob,
  owner: string,
  transitionNow: string,
  expires: string
): ChangeProjectionJob {
  if (!sameJobIdentity(before, after) || before.status !== "queued" || after.status !== "projecting" ||
      after.generation !== before.generation || after.attempt !== before.attempt ||
      after.owner_id !== owner || typeof after.lease_token !== "string" || after.lease_token.length < 1 ||
      after.lease_expires_at !== expires || after.updated_at !== transitionNow || after.retryable !== true ||
      after.output_hash !== undefined || after.document_count !== undefined || after.reason_code !== undefined) {
    transitionInvalid();
  }
  return after;
}

function validateRenewTransition(
  before: ChangeProjectionJob,
  after: ChangeProjectionJob,
  transitionNow: string,
  expires: string
): ChangeProjectionJob {
  if (!sameJobIdentity(before, after) || before.status !== "projecting" || after.status !== "projecting" ||
      after.generation !== before.generation || after.attempt !== before.attempt ||
      after.owner_id !== before.owner_id || after.lease_token !== before.lease_token ||
      after.lease_expires_at !== expires || after.updated_at !== transitionNow ||
      after.retryable !== before.retryable || after.output_hash !== before.output_hash ||
      after.document_count !== before.document_count || after.reason_code !== before.reason_code) transitionInvalid();
  return after;
}

function validateReapTransition(before: ChangeProjectionJob, after: ChangeProjectionJob, transitionNow: string): ChangeProjectionJob {
  if (!sameJobIdentity(before, after) || before.status !== "projecting" || after.status !== "failed" ||
      after.generation !== before.generation || after.attempt !== before.attempt ||
      after.updated_at !== transitionNow || after.retryable !== true ||
      after.reason_code !== "CHANGE_PROJECTION_LEASE_EXPIRED" || after.owner_id !== undefined ||
      after.lease_token !== undefined || after.lease_expires_at !== undefined ||
      after.output_hash !== before.output_hash || after.document_count !== before.document_count) transitionInvalid();
  return after;
}

function validateRetryTransition(before: ChangeProjectionJob, after: ChangeProjectionJob, transitionNow: string): ChangeProjectionJob {
  if (!sameJobIdentity(before, after) || before.status !== "failed" || after.status !== "queued" ||
      after.generation !== before.generation + 1 || after.attempt !== before.attempt + 1 ||
      after.updated_at !== transitionNow || after.retryable !== true || after.reason_code !== undefined ||
      after.owner_id !== undefined || after.lease_token !== undefined || after.lease_expires_at !== undefined ||
      after.output_hash !== undefined || after.document_count !== undefined) transitionInvalid();
  return after;
}

function validateCommitTransition(
  before: ChangeProjectionJob,
  after: ChangeProjectionJob,
  transitionNow: string,
  outputHash: string,
  count: number
): ChangeProjectionJob {
  if (!sameJobIdentity(before, after) || before.status !== "projecting" || after.status !== "ready" ||
      after.generation !== before.generation || after.attempt !== before.attempt ||
      before.owner_id === undefined || before.lease_token === undefined ||
      before.lease_expires_at === undefined || transitionNow >= before.lease_expires_at ||
      after.owner_id !== undefined || after.lease_token !== undefined ||
      after.lease_expires_at !== undefined || after.updated_at !== transitionNow ||
      after.retryable !== false || after.reason_code !== undefined ||
      after.output_hash !== outputHash || after.document_count !== count) transitionInvalid();
  return after;
}

function validateFailTransition(
  before: ChangeProjectionJob,
  after: ChangeProjectionJob,
  transitionNow: string,
  reasonCode: string,
  retryable: boolean
): ChangeProjectionJob {
  if (!sameJobIdentity(before, after) || before.status !== "projecting" || after.status !== "failed" ||
      after.generation !== before.generation || after.attempt !== before.attempt ||
      after.updated_at !== transitionNow || after.retryable !== retryable || after.reason_code !== reasonCode ||
      after.owner_id !== undefined || after.lease_token !== undefined || after.lease_expires_at !== undefined ||
      after.output_hash !== before.output_hash || after.document_count !== before.document_count) transitionInvalid();
  return after;
}

function sameArchiveIdentity(job: ChangeProjectionJob, archive: StoredArchive): boolean {
  return job.project_id === archive.project_id && job.change_key === archive.change_key &&
    job.archive_id === archive.archive_id && job.package_sha256 === archive.package_sha256 &&
    job.manifest_sha256 === archive.manifest_sha256 && job.project_version === archive.project_version &&
    job.package_schema_version === archive.package_schema_version &&
    job.archive_schema_version === archive.archive_schema_version &&
    job.input_hash === changeProjectionInputHash({
      schema_version: archive.schema_version,
      project_id: archive.project_id,
      change_key: archive.change_key,
      archive_id: archive.archive_id,
      package_sha256: archive.package_sha256,
      manifest_sha256: archive.manifest_sha256,
      project_version: archive.project_version,
      package_schema_version: archive.package_schema_version,
      archive_schema_version: archive.archive_schema_version
    });
}

function sameValidationReceipt(
  left: StoredArchive["validation_receipt"],
  right: StoredArchive["validation_receipt"]
): boolean {
  return validationReceiptKeys.every((key) => left[key] === right[key]);
}

function documentType(path: string): ChangeDocumentType | null {
  if (path === "summary/change-summary.json") return "change_summary";
  // core-v1 的同一份事实换了个位置：入库桥要靠这份文档取 changeName /
  // baseCommit / finalCommit / finalStatus 做溯源。
  if (path === "reports/final/summary-data.json") return "change_summary";
  if (/^plans\/(?:[^/]+\/)*[^/]+-test-scenarios\.md$/u.test(path)) return "test_scenarios";
  if (/^spec\/.+\.md$/u.test(path)) return "design";
  if (/^plans\/.+\.md$/u.test(path)) return "plan";
  return null;
}

function projectDocuments(
  job: ChangeProjectionJob,
  archive: StoredArchive,
  verified: VerifiedProjectionArchive
): ChangeDocument[] {
  const documents: ChangeDocument[] = [];
  for (const entry of verified.entries) {
    const type = documentType(entry.path);
    if (type === null) continue;
    const classification = classifyContentPath({ schema_version: 1, path: entry.path, source_kind: "branch_file" });
    if ("reason_code" in classification) fail("CHANGE_PROJECTION_DOCUMENT_PATH_INVALID");
    const content = entry.content;
    if (content.length < 1) fail("CHANGE_PROJECTION_DOCUMENT_CONTENT_INVALID");
    const contentHash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    if (contentHash !== entry.content_hash) fail("CHANGE_PROJECTION_VERIFIER_EVIDENCE_INVALID");
    const identity = { project_id: job.project_id, change_key: job.change_key, document_type: type, source_path: entry.path };
    documents.push({
      schema_version: 1,
      document_id: changeDocumentIdentity(identity),
      document_version: changeDocumentVersion(contentHash),
      project_id: job.project_id,
      change_key: job.change_key,
      archive_id: job.archive_id,
      package_sha256: job.package_sha256,
      project_version: job.project_version,
      document_type: type,
      source_path: entry.path,
      content_hash: contentHash,
      content,
      generation: job.project_generation,
      created_at: archive.stored_at,
      updated_at: archive.stored_at
    });
  }
  documents.sort((left, right) => left.document_id < right.document_id ? -1 : left.document_id > right.document_id ? 1 : 0);
  return documents;
}

function result(job: ChangeProjectionJob): ChangeProjectionWorkerResult {
  return {
    job_id: job.job_id,
    status: job.status === "ready" ? "ready" : "failed",
    retryable: job.retryable,
    ...(job.document_count === undefined ? {} : { document_count: job.document_count }),
    ...(job.output_hash === undefined ? {} : { output_hash: job.output_hash }),
    ...(job.reason_code === undefined ? {} : { reason_code: job.reason_code })
  };
}

export function createChangeProjectionWorker(dependencies: ChangeProjectionWorkerDependencies): ChangeProjectionWorker {
  const duration = dependencies.lease_duration_ms;
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 86_400_000) {
    fail("CHANGE_PROJECTION_WORKER_CONFIGURATION_INVALID");
  }
  const limits = dependencies.verification_limits;
  if (limits === null || typeof limits !== "object" || Array.isArray(limits) ||
      nodeTypes.isProxy(limits) || Object.getPrototypeOf(limits) !== Object.prototype ||
      Object.keys(limits).length !== 5 ||
      !Number.isSafeInteger(limits.max_package_bytes) || limits.max_package_bytes < 1 ||
      !Number.isSafeInteger(limits.max_file_count) || limits.max_file_count < 1 ||
      !Number.isSafeInteger(limits.max_file_bytes) || limits.max_file_bytes < 1 ||
      !Number.isSafeInteger(limits.max_uncompressed_bytes) || limits.max_uncompressed_bytes < 1 ||
      !Number.isFinite(limits.max_compression_ratio) || limits.max_compression_ratio < 1) {
    fail("CHANGE_PROJECTION_WORKER_CONFIGURATION_INVALID");
  }
  const fixedLimits = Object.freeze({ ...limits });

  async function current(jobId: string): Promise<ChangeProjectionJob> {
    try {
      const value = await dependencies.task_port.getChangeProjectionJob(jobId);
      if (value === null) fail("CHANGE_PROJECTION_JOB_NOT_FOUND");
      return jobSnapshot(value);
    } catch (error) {
      if (error instanceof WorkerFailure) throw error;
      fail("CHANGE_PROJECTION_PORT_INVALID");
    }
  }

  async function active(capability: ChangeProjectionJob): Promise<ChangeProjectionJob> {
    const observed = await current(capability.job_id);
    const observedNow = now(dependencies.clock);
    if (observed.status !== "projecting" || observed.generation !== capability.generation ||
        observed.owner_id !== capability.owner_id || observed.lease_token !== capability.lease_token ||
        observed.lease_expires_at === undefined || observedNow >= observed.lease_expires_at) {
      fail("CHANGE_PROJECTION_LEASE_STALE");
    }
    return observed;
  }

  async function run(rawInput: ChangeProjectionWorkerInput): Promise<ChangeProjectionWorkerResult> {
    const input = workerInput(rawInput);
    let capability: ChangeProjectionJob | undefined;
    try {
      const initialNow = now(dependencies.clock);
      let job = await current(input.job_id);
      if (job.status === "ready") return result(job);
      const claimNow = initialNow;
      if (job.status === "projecting") {
        if (job.lease_expires_at === undefined || claimNow < job.lease_expires_at) {
          fail("CHANGE_PROJECTION_JOB_ALREADY_CLAIMED", true);
        }
        const beforeReap = job;
        job = validateReapTransition(beforeReap, jobSnapshot(await dependencies.task_port.reapExpiredChangeProjectionLease({
          job_id: job.job_id, generation: job.generation, now: claimNow
        })), claimNow);
      }
      if (job.status === "failed") {
        if (!job.retryable) return result(job);
        const beforeRetry = job;
        job = validateRetryTransition(beforeRetry, jobSnapshot(await dependencies.task_port.retryChangeProjectionJob({
          job_id: job.job_id, expected_generation: job.generation, expected_status: "failed", now: claimNow
        })), claimNow);
      }
      if (job.status !== "queued") fail("CHANGE_PROJECTION_JOB_STATE_INVALID");
      const claimExpires = leaseExpiry(claimNow, duration);
      capability = validateClaimTransition(job, jobSnapshot(await dependencies.task_port.claimChangeProjectionJob({
        job_id: job.job_id,
        owner_id: input.owner_id,
        now: claimNow,
        lease_expires_at: claimExpires
      })), input.owner_id, claimNow, claimExpires);

      capability = await active(capability);
      const rawArchive = await dependencies.archive_store.getByArchiveId(capability.archive_id);
      if (rawArchive === null) fail("CHANGE_PROJECTION_ARCHIVE_NOT_FOUND", true);
      const archive = archiveSnapshot(rawArchive);
      if (!sameArchiveIdentity(capability, archive)) fail("CHANGE_PROJECTION_ARCHIVE_IDENTITY_MISMATCH");

      capability = await active(capability);
      const renewNow = now(dependencies.clock);
      const renewBefore = capability;
      const renewExpires = leaseExpiry(renewNow, duration);
      capability = validateRenewTransition(renewBefore, jobSnapshot(await dependencies.task_port.renewChangeProjectionLease({
        job_id: capability.job_id,
        generation: capability.generation,
        owner_id: capability.owner_id as string,
        lease_token: capability.lease_token as string,
        now: renewNow,
        lease_expires_at: renewExpires
      })), renewNow, renewExpires);
      // core-v1（1/1）是生产归档器的当前形态；只有形态不成对的包才是需要
      // 只读拒绝的 legacy 残留（例如自称 v2 却带 schema 1 的包）。
      const coreV1 = archive.package_schema_version === 1 && archive.archive_schema_version === 1;
      if (!coreV1 &&
          (archive.package_schema_version !== 2 || archive.archive_schema_version !== 2)) {
        fail("CHANGE_PROJECTION_LEGACY_READ_ONLY");
      }
      let rawVerified: unknown;
      try {
        rawVerified = await dependencies.archive_verifier.verify({
          package_bytes: archive.package_bytes,
          manifest_bytes: archive.manifest_bytes,
          limits: fixedLimits,
          verified_at: renewNow,
          ...(coreV1 ? { core_v1_identity: {
            project_id: archive.project_id,
            change_key: archive.change_key,
            archive_id: archive.archive_id,
            project_version: archive.project_version
          } } : {})
        });
      } catch {
        fail("CHANGE_PROJECTION_PACKAGE_VERIFICATION_FAILED");
      }
      let trusted: boolean;
      try { trusted = dependencies.archive_verifier.isTrusted(rawVerified); }
      catch { fail("CHANGE_PROJECTION_PACKAGE_VERIFICATION_FAILED"); }
      if (!trusted) fail("CHANGE_PROJECTION_PACKAGE_VERIFICATION_FAILED");
      const verified = verifiedSnapshot(rawVerified);
      if (verified.project_id !== archive.project_id || verified.change_key !== archive.change_key ||
          verified.archive_id !== archive.archive_id || verified.package_sha256 !== archive.package_sha256 ||
          verified.manifest_sha256 !== archive.manifest_sha256 ||
          verified.project_version !== archive.project_version ||
          verified.package_schema_version !== archive.package_schema_version ||
          verified.archive_schema_version !== archive.archive_schema_version ||
          !sameValidationReceipt(verified.validation_receipt, archive.validation_receipt)) {
        fail("CHANGE_PROJECTION_PACKAGE_VERIFICATION_FAILED");
      }
      const documents = projectDocuments(capability, archive, verified);
      const outputHash = changeProjectionOutputHash(documents);

      capability = await active(capability);
      const commitBefore = capability;
      const commitNow = now(dependencies.clock);
      const committed = validateCommitTransition(commitBefore, jobSnapshot(await dependencies.commit_port.commitChangeProjection({
        job_id: capability.job_id,
        generation: capability.generation,
        owner_id: capability.owner_id as string,
        lease_token: capability.lease_token as string,
        output_hash: outputHash,
        documents,
        now: commitNow
      })), commitNow, outputHash, documents.length);
      return result(committed);
    } catch (error) {
      const failure = error instanceof WorkerFailure
        ? error
        : error instanceof KnowledgePipelineError
          ? new WorkerFailure(error.reason_code, error.retryable)
          : new WorkerFailure("CHANGE_PROJECTION_WORKER_FAILED", true);
      if (capability === undefined || [
        "CHANGE_PROJECTION_LEASE_STALE", "CHANGE_PROJECTION_JOB_GENERATION_STALE",
        "CHANGE_PROJECTION_PROJECT_GENERATION_STALE", "CHANGE_PROJECTION_PORT_INVALID"
      ].includes(failure.reason_code)) throw failure;
      const fenced = await active(capability);
      const failNow = now(dependencies.clock);
      const failed = validateFailTransition(fenced, jobSnapshot(await dependencies.task_port.failChangeProjectionJob({
        job_id: fenced.job_id,
        generation: fenced.generation,
        owner_id: fenced.owner_id as string,
        lease_token: fenced.lease_token as string,
        reason_code: failure.reason_code,
        retryable: failure.retryable,
        now: failNow
      })), failNow, failure.reason_code, failure.retryable);
      return result(failed);
    }
  }

  return Object.freeze({ run });
}
