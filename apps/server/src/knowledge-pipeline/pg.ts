import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { types as nodeTypes } from "node:util";

import {
  canonicalJson,
  classifyContentPath,
  knowledgeCandidateSchema,
  projectContentCandidateSchema,
  type ProjectContentCandidate
} from "@hunter-harness/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { KnowledgePipelineError } from "./errors.js";
import { changeSummaryPaths } from "./memory-ports.js";
import {
  changeDocumentIdentity,
  changeDocumentVersion,
  changeProjectionOutputHash
} from "./change-projection.js";
import type {
  ArchiveStore,
  ArchiveStorePutResult,
  ChangeProjectionCommitPort,
  CommitChangeProjectionInput,
  CommitKnowledgeResultsInput,
  EnqueueKnowledgeJobInput,
  FailChangeProjectionJobInput,
  JobRepository,
  KnowledgeCommitPort,
  KnowledgeIndex,
  KnowledgeIndexQuery,
  PlanArchiveTasksInput,
  PlanArchiveTasksResult,
  ProjectContentCandidateQuery,
  ProjectContentCandidateQueryResult,
  ReapChangeProjectionLeaseInput,
  RenewChangeProjectionLeaseInput,
  RetryChangeProjectionJobInput
} from "./ports.js";
import type {
  ArchivePackageValidationReceipt,
  ChangeDocument,
  ChangeProjectionJob,
  KnowledgeExtractionJob,
  KnowledgeResult,
  StoredArchive
} from "./types.js";

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const PROJECT = /^prj_[A-Za-z0-9][A-Za-z0-9._:-]{0,155}$/u;
const ARCHIVE = /^arc_[A-Za-z0-9][A-Za-z0-9._:-]{0,155}$/u;
const JOB = /^job_[a-z]+_[a-f0-9]{32}$/u;
const TIMESTAMP = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_ARRAY = 10_000;
const MAX_TEXT = 1_048_576;

type Row = QueryResultRow & Record<string, unknown>;

function fail(reasonCode: string, retryable = false): never {
  throw new KnowledgePipelineError(reasonCode, retryable);
}

function storageFailure(): never {
  fail("KNOWLEDGE_PIPELINE_STORAGE_UNAVAILABLE", true);
}

function safeOwnRecord(value: unknown, keys: readonly string[], reasonCode: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) fail(reasonCode);
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  const actual = Object.keys(descriptors).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(reasonCode);
  }
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      fail(reasonCode);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function safeOwnRecordWithOptional(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  reasonCode: string
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) fail(reasonCode);
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const actual = Object.keys(descriptors);
  if (actual.some((key) => !allowed.has(key)) || requiredKeys.some((key) => descriptors[key] === undefined)) {
    fail(reasonCode);
  }
  const result: Record<string, unknown> = {};
  for (const key of [...requiredKeys, ...optionalKeys]) {
    const descriptor = descriptors[key];
    if (descriptor === undefined) continue;
    if (!("value" in descriptor) || descriptor.enumerable !== true) fail(reasonCode);
    result[key] = descriptor.value;
  }
  return result;
}

function safeOwnArray(value: unknown, reasonCode: string): unknown[] {
  if (value === null || typeof value !== "object" || !Array.isArray(value) ||
      nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) fail(reasonCode);
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  const lengthDescriptor = descriptors.length;
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) || Number(lengthDescriptor.value) < 0 ||
      Number(lengthDescriptor.value) > MAX_JSON_ARRAY) fail(reasonCode);
  const length = Number(lengthDescriptor.value);
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      fail(reasonCode);
    }
    result.push(descriptor.value);
  }
  const expected = new Set(["length", ...result.map((_, index) => String(index))]);
  if (Object.keys(descriptors).some((key) => !expected.has(key))) fail(reasonCode);
  return result;
}

function snapshotJson(value: unknown, reasonCode: string, depth = 0): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(reasonCode);
    return value;
  }
  if (depth > MAX_JSON_DEPTH || value === undefined || typeof value !== "object" ||
      nodeTypes.isProxy(value) || Object.getOwnPropertySymbols(value).length !== 0) {
    fail(reasonCode);
  }
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) fail(reasonCode);
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  if (array) {
    const lengthDescriptor = descriptors.length;
    if (lengthDescriptor === undefined || !("value" in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) || Number(lengthDescriptor.value) < 0 ||
        Number(lengthDescriptor.value) > MAX_JSON_ARRAY) fail(reasonCode);
    const result: unknown[] = [];
    const length = Number(lengthDescriptor.value);
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
        fail(reasonCode);
      }
      result.push(snapshotJson(descriptor.value, reasonCode, depth + 1));
    }
    if (Object.keys(descriptors).some((key) => key !== "length" && !/^\d+$/u.test(key))) fail(reasonCode);
    return result;
  }
  const result: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor) || descriptor.enumerable !== true) fail(reasonCode);
    result[key] = snapshotJson(descriptor.value, reasonCode, depth + 1);
  }
  return result;
}

function text(value: unknown, reasonCode: string, max = 512): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max ||
      value !== value.trim() || value !== value.normalize("NFC") ||
      Array.from(value).some((character) => {
        const point = character.codePointAt(0) ?? 0;
        return point <= 31 || point === 127 || (point >= 0xd800 && point <= 0xdfff);
      })) fail(reasonCode);
  return value;
}

function documentContent(value: unknown, reasonCode: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_TEXT ||
      Array.from(value).some((character) => {
        const point = character.codePointAt(0) ?? 0;
        // Markdown and JSON legitimately contain tab/newline/CR. Other C0
        // controls, DEL, and lone surrogate code points remain forbidden.
        return (point <= 31 && point !== 9 && point !== 10 && point !== 13) ||
          point === 127 || (point >= 0xd800 && point <= 0xdfff);
      })) fail(reasonCode);
  return value;
}

function timestamp(value: unknown, reasonCode: string): string {
  const result = typeof value === "string" && TIMESTAMP.test(value)
    ? value
    : value instanceof Date && !Number.isNaN(value.getTime())
      ? value.toISOString()
      : null;
  if (result === null || Number.isNaN(Date.parse(result)) || new Date(result).toISOString() !== result) {
    fail(reasonCode);
  }
  return result;
}

function positiveInteger(value: unknown, reasonCode: string): number {
  const number = typeof value === "bigint" ? Number(value) :
    typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || Number(number) < 1) fail(reasonCode);
  return Number(number);
}

function nonNegativeInteger(value: unknown, reasonCode: string): number {
  const number = typeof value === "bigint" ? Number(value) :
    typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || Number(number) < 0) fail(reasonCode);
  return Number(number);
}

function sha(value: unknown, reasonCode: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(reasonCode);
  return value;
}

function copyBytes(value: unknown, reasonCode: string): Uint8Array {
  if (!ArrayBuffer.isView(value) || nodeTypes.isProxy(value) ||
      (Object.getPrototypeOf(value) !== Uint8Array.prototype && !Buffer.isBuffer(value))) {
    fail(reasonCode);
  }
  const result = new Uint8Array(value as Uint8Array);
  if (result.byteLength < 1) fail(reasonCode);
  return result;
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function identifier(prefix: string, identity: string): string {
  return `${prefix}_${createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 32)}`;
}

function rowValue(row: unknown, key: string): unknown {
  if (row === null || typeof row !== "object" || nodeTypes.isProxy(row)) fail("KNOWLEDGE_PIPELINE_ROW_INVALID");
  const descriptor = Object.getOwnPropertyDescriptor(row, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function requiredRowValue(row: unknown, key: string, reasonCode: string): unknown {
  if (row === null || typeof row !== "object" || nodeTypes.isProxy(row)) fail(reasonCode);
  const descriptor = Object.getOwnPropertyDescriptor(row, key);
  if (descriptor === undefined || !("value" in descriptor)) fail(reasonCode);
  return descriptor.value;
}

function jsonArrayStrings(value: unknown, reasonCode: string): string[] {
  const snapshot = safeOwnArray(snapshotJson(value, reasonCode), reasonCode);
  return snapshot.map((entry) => text(entry, reasonCode, 512));
}

function canonicalArray(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function candidateArray(value: unknown, reasonCode: string): ProjectContentCandidate[] {
  const snapshot = safeOwnArray(snapshotJson(value, reasonCode), reasonCode);
  return snapshot.map((candidate) => {
    const parsed = projectContentCandidateSchema.safeParse(candidate);
    if (!parsed.success) fail(reasonCode);
    return structuredClone(parsed.data);
  });
}

function knowledgeCandidateArray(value: unknown, reasonCode: string) {
  const snapshot = safeOwnArray(snapshotJson(value, reasonCode), reasonCode);
  return snapshot.map((candidate) => {
    const parsed = knowledgeCandidateSchema.safeParse(candidate);
    if (!parsed.success) fail(reasonCode);
    return structuredClone(parsed.data);
  });
}

const receiptKeys = [
  "schema_version", "package_sha256", "manifest_sha256", "package_schema_version",
  "archive_schema_version", "safe_paths", "no_symlinks", "no_encrypted_entries",
  "declared_files_verified", "content_hashes_verified", "candidate_sources_bound",
  "file_count", "compressed_bytes", "uncompressed_bytes", "validated_at"
] as const;

function validationReceipt(value: unknown, reasonCode: string): ArchivePackageValidationReceipt {
  const record = safeOwnRecord(value, receiptKeys, reasonCode);
  if (record.schema_version !== 1 || record.safe_paths !== true || record.no_symlinks !== true ||
      record.no_encrypted_entries !== true || record.declared_files_verified !== true ||
      record.content_hashes_verified !== true || record.candidate_sources_bound !== true) {
    fail(reasonCode);
  }
  const result: ArchivePackageValidationReceipt = {
    schema_version: 1,
    package_sha256: sha(record.package_sha256, reasonCode),
    manifest_sha256: sha(record.manifest_sha256, reasonCode),
    package_schema_version: positiveInteger(record.package_schema_version, reasonCode),
    archive_schema_version: positiveInteger(record.archive_schema_version, reasonCode),
    safe_paths: true,
    no_symlinks: true,
    no_encrypted_entries: true,
    declared_files_verified: true,
    content_hashes_verified: true,
    candidate_sources_bound: true,
    file_count: nonNegativeInteger(record.file_count, reasonCode),
    compressed_bytes: positiveInteger(record.compressed_bytes, reasonCode),
    uncompressed_bytes: nonNegativeInteger(record.uncompressed_bytes, reasonCode),
    validated_at: timestamp(record.validated_at, reasonCode)
  };
  return result;
}

const archiveKeys = [
  "schema_version", "project_id", "change_key", "archive_id", "package_sha256",
  "manifest_sha256", "project_version", "package_schema_version", "archive_schema_version",
  "package_bytes", "manifest_bytes", "knowledge_candidates", "project_content_candidates",
  "validation_receipt", "stored_at"
] as const;

function snapshotArchive(value: unknown, reasonCode = "ARCHIVE_INPUT_INVALID"): StoredArchive {
  const record = safeOwnRecord(value, archiveKeys, reasonCode);
  if (record.schema_version !== 1) fail(reasonCode);
  const packageBytes = copyBytes(record.package_bytes, reasonCode);
  const manifestBytes = copyBytes(record.manifest_bytes, reasonCode);
  const packageSha = sha(record.package_sha256, reasonCode);
  const manifestSha = sha(record.manifest_sha256, reasonCode);
  if (digest(packageBytes) !== packageSha || digest(manifestBytes) !== manifestSha) fail("ARCHIVE_HASH_MISMATCH");
  const receipt = validationReceipt(record.validation_receipt, reasonCode);
  if (receipt.package_sha256 !== packageSha || receipt.manifest_sha256 !== manifestSha ||
      receipt.package_schema_version !== record.package_schema_version ||
      receipt.archive_schema_version !== record.archive_schema_version ||
      receipt.compressed_bytes !== packageBytes.byteLength) fail(reasonCode);
  return {
    schema_version: 1,
    project_id: (() => { const id = text(record.project_id, reasonCode, 160); if (!PROJECT.test(id)) fail(reasonCode); return id; })(),
    change_key: text(record.change_key, reasonCode, 160),
    archive_id: (() => { const id = text(record.archive_id, reasonCode, 160); if (!ARCHIVE.test(id)) fail(reasonCode); return id; })(),
    package_sha256: packageSha,
    manifest_sha256: manifestSha,
    project_version: text(record.project_version, reasonCode, 160),
    package_schema_version: positiveInteger(record.package_schema_version, reasonCode),
    archive_schema_version: positiveInteger(record.archive_schema_version, reasonCode),
    package_bytes: packageBytes,
    manifest_bytes: manifestBytes,
    knowledge_candidates: knowledgeCandidateArray(record.knowledge_candidates, reasonCode),
    project_content_candidates: candidateArray(record.project_content_candidates, reasonCode),
    validation_receipt: receipt,
    stored_at: timestamp(record.stored_at, reasonCode)
  };
}

function archiveIdentityEqual(left: StoredArchive, right: StoredArchive): boolean {
  return left.schema_version === right.schema_version && left.project_id === right.project_id &&
    left.change_key === right.change_key && left.archive_id === right.archive_id &&
    left.package_sha256 === right.package_sha256 && left.manifest_sha256 === right.manifest_sha256 &&
    left.project_version === right.project_version &&
    left.package_schema_version === right.package_schema_version &&
    left.archive_schema_version === right.archive_schema_version &&
    left.package_bytes.length === right.package_bytes.length &&
    left.package_bytes.every((byte, index) => byte === right.package_bytes[index]) &&
    left.manifest_bytes.length === right.manifest_bytes.length &&
    left.manifest_bytes.every((byte, index) => byte === right.manifest_bytes[index]) &&
    canonicalJson(left.knowledge_candidates) === canonicalJson(right.knowledge_candidates) &&
    canonicalJson(left.project_content_candidates) === canonicalJson(right.project_content_candidates) &&
    canonicalJson(left.validation_receipt) === canonicalJson(right.validation_receipt);
}

function archiveCanonicalEqual(left: StoredArchive, right: StoredArchive): boolean {
  return left.project_id === right.project_id && left.package_sha256 === right.package_sha256 &&
    left.manifest_sha256 === right.manifest_sha256 &&
    left.package_schema_version === right.package_schema_version &&
    left.archive_schema_version === right.archive_schema_version &&
    left.package_bytes.length === right.package_bytes.length &&
    left.package_bytes.every((byte, index) => byte === right.package_bytes[index]) &&
    left.manifest_bytes.length === right.manifest_bytes.length &&
    left.manifest_bytes.every((byte, index) => byte === right.manifest_bytes[index]);
}

function archiveFromRow(row: unknown): StoredArchive {
  const packageBytes = copyBytes(rowValue(row, "package_bytes"), "ARCHIVE_STORE_CORRUPT");
  const manifestBytes = copyBytes(rowValue(row, "manifest_bytes"), "ARCHIVE_STORE_CORRUPT");
  const packageSha = sha(rowValue(row, "package_sha256"), "ARCHIVE_STORE_CORRUPT");
  const manifestSha = sha(rowValue(row, "manifest_sha256"), "ARCHIVE_STORE_CORRUPT");
  if (digest(packageBytes) !== packageSha || digest(manifestBytes) !== manifestSha) fail("ARCHIVE_STORE_CORRUPT");
  const receipt = validationReceipt(rowValue(row, "validation_receipt"), "ARCHIVE_STORE_CORRUPT");
  const packageSchemaVersion = positiveInteger(
    rowValue(row, "package_schema_version"), "ARCHIVE_STORE_CORRUPT"
  );
  const archiveSchemaVersion = positiveInteger(
    rowValue(row, "archive_schema_version"), "ARCHIVE_STORE_CORRUPT"
  );
  if (receipt.package_sha256 !== packageSha || receipt.manifest_sha256 !== manifestSha ||
      receipt.package_schema_version !== packageSchemaVersion ||
      receipt.archive_schema_version !== archiveSchemaVersion ||
      receipt.compressed_bytes !== packageBytes.byteLength) fail("ARCHIVE_STORE_CORRUPT");
  return {
    schema_version: 1,
    project_id: (() => {
      const id = text(rowValue(row, "project_id"), "ARCHIVE_STORE_CORRUPT", 160);
      if (!PROJECT.test(id)) fail("ARCHIVE_STORE_CORRUPT");
      return id;
    })(),
    change_key: text(rowValue(row, "change_key"), "ARCHIVE_STORE_CORRUPT", 160),
    archive_id: (() => { const id = text(rowValue(row, "archive_id"), "ARCHIVE_STORE_CORRUPT", 160); if (!ARCHIVE.test(id)) fail("ARCHIVE_STORE_CORRUPT"); return id; })(),
    package_sha256: packageSha,
    manifest_sha256: manifestSha,
    project_version: text(rowValue(row, "project_version"), "ARCHIVE_STORE_CORRUPT", 160),
    package_schema_version: packageSchemaVersion,
    archive_schema_version: archiveSchemaVersion,
    package_bytes: packageBytes,
    manifest_bytes: manifestBytes,
    knowledge_candidates: knowledgeCandidateArray(rowValue(row, "knowledge_candidates"), "ARCHIVE_STORE_CORRUPT"),
    project_content_candidates: candidateArray(rowValue(row, "project_content_candidates"), "ARCHIVE_STORE_CORRUPT"),
    validation_receipt: receipt,
    stored_at: timestamp(rowValue(row, "stored_at"), "ARCHIVE_STORE_CORRUPT")
  };
}

function optionalText(value: unknown, reasonCode: string, max = 512): string | undefined {
  if (value === null || value === undefined) return undefined;
  return text(value, reasonCode, max);
}

function jobStatus(value: unknown, reasonCode: string): KnowledgeExtractionJob["status"] {
  if (value !== "queued" && value !== "extracting" && value !== "ready" && value !== "failed") fail(reasonCode);
  return value;
}

function changeStatus(value: unknown, reasonCode: string): ChangeProjectionJob["status"] {
  if (value !== "queued" && value !== "projecting" && value !== "ready" && value !== "failed") fail(reasonCode);
  return value;
}

function knowledgeJobFromRow(row: unknown): KnowledgeExtractionJob {
  const outputHash = optionalText(requiredRowValue(row, "output_hash", "KNOWLEDGE_JOB_CORRUPT"), "KNOWLEDGE_JOB_CORRUPT", 71);
  if (outputHash !== undefined && !SHA256.test(outputHash)) fail("KNOWLEDGE_JOB_CORRUPT");
  const resultCountRaw = requiredRowValue(row, "result_count", "KNOWLEDGE_JOB_CORRUPT");
  const reasonCode = optionalText(requiredRowValue(row, "reason_code", "KNOWLEDGE_JOB_CORRUPT"), "KNOWLEDGE_JOB_CORRUPT");
  const status = jobStatus(rowValue(row, "status"), "KNOWLEDGE_JOB_CORRUPT");
  const retryable = rowValue(row, "retryable");
  if (typeof retryable !== "boolean") fail("KNOWLEDGE_JOB_CORRUPT");
  const hasResultCount = resultCountRaw !== null && resultCountRaw !== undefined;
  if ((status === "queued" || status === "extracting") &&
      (outputHash !== undefined || hasResultCount || reasonCode !== undefined || retryable !== true)) {
    fail("KNOWLEDGE_JOB_CORRUPT");
  }
  if (status === "ready" &&
      (outputHash === undefined || !hasResultCount || reasonCode !== undefined || retryable !== false)) {
    fail("KNOWLEDGE_JOB_CORRUPT");
  }
  if (status === "failed" &&
      (outputHash !== undefined || hasResultCount || reasonCode === undefined)) {
    fail("KNOWLEDGE_JOB_CORRUPT");
  }
  const result: KnowledgeExtractionJob = {
    schema_version: 1,
    job_id: (() => { const value = text(rowValue(row, "job_id"), "KNOWLEDGE_JOB_CORRUPT", 160); if (!JOB.test(value)) fail("KNOWLEDGE_JOB_CORRUPT"); return value; })(),
    idempotency_key: text(rowValue(row, "idempotency_key"), "KNOWLEDGE_JOB_CORRUPT", 512),
    project_id: text(rowValue(row, "project_id"), "KNOWLEDGE_JOB_CORRUPT", 160),
    change_key: text(rowValue(row, "change_key"), "KNOWLEDGE_JOB_CORRUPT", 160),
    archive_id: text(rowValue(row, "archive_id"), "KNOWLEDGE_JOB_CORRUPT", 160),
    package_sha256: sha(rowValue(row, "package_sha256"), "KNOWLEDGE_JOB_CORRUPT"),
    extractor_version: text(rowValue(row, "extractor_version"), "KNOWLEDGE_JOB_CORRUPT"),
    prompt_version: text(rowValue(row, "prompt_version"), "KNOWLEDGE_JOB_CORRUPT"),
    index_schema_version: text(rowValue(row, "index_schema_version"), "KNOWLEDGE_JOB_CORRUPT"),
    status,
    attempt: positiveInteger(rowValue(row, "attempt"), "KNOWLEDGE_JOB_CORRUPT"),
    generation: positiveInteger(rowValue(row, "generation"), "KNOWLEDGE_JOB_CORRUPT"),
    input_hash: sha(rowValue(row, "input_hash"), "KNOWLEDGE_JOB_CORRUPT"),
    retryable,
    knowledge_candidates: knowledgeCandidateArray(rowValue(row, "knowledge_candidates"), "KNOWLEDGE_JOB_CORRUPT"),
    created_at: timestamp(rowValue(row, "created_at"), "KNOWLEDGE_JOB_CORRUPT"),
    updated_at: timestamp(rowValue(row, "updated_at"), "KNOWLEDGE_JOB_CORRUPT")
  };
  if (outputHash !== undefined) result.output_hash = outputHash;
  if (resultCountRaw !== null && resultCountRaw !== undefined) result.result_count = nonNegativeInteger(resultCountRaw, "KNOWLEDGE_JOB_CORRUPT");
  if (reasonCode !== undefined) result.reason_code = reasonCode;
  return result;
}

function changeJobFromRow(row: unknown): ChangeProjectionJob {
  const status = changeStatus(rowValue(row, "status"), "CHANGE_PROJECTION_JOB_CORRUPT");
  const retryable = rowValue(row, "retryable");
  if (typeof retryable !== "boolean") fail("CHANGE_PROJECTION_JOB_CORRUPT");
  const result: ChangeProjectionJob = {
    schema_version: 1,
    job_id: (() => { const value = text(rowValue(row, "job_id"), "CHANGE_PROJECTION_JOB_CORRUPT", 160); if (!JOB.test(value)) fail("CHANGE_PROJECTION_JOB_CORRUPT"); return value; })(),
    project_id: text(rowValue(row, "project_id"), "CHANGE_PROJECTION_JOB_CORRUPT", 160),
    change_key: text(rowValue(row, "change_key"), "CHANGE_PROJECTION_JOB_CORRUPT", 160),
    archive_id: text(rowValue(row, "archive_id"), "CHANGE_PROJECTION_JOB_CORRUPT", 160),
    package_sha256: sha(rowValue(row, "package_sha256"), "CHANGE_PROJECTION_JOB_CORRUPT"),
    manifest_sha256: sha(rowValue(row, "manifest_sha256"), "CHANGE_PROJECTION_JOB_CORRUPT"),
    project_version: text(rowValue(row, "project_version"), "CHANGE_PROJECTION_JOB_CORRUPT", 160),
    package_schema_version: positiveInteger(rowValue(row, "package_schema_version"), "CHANGE_PROJECTION_JOB_CORRUPT"),
    archive_schema_version: positiveInteger(rowValue(row, "archive_schema_version"), "CHANGE_PROJECTION_JOB_CORRUPT"),
    status,
    attempt: positiveInteger(rowValue(row, "attempt"), "CHANGE_PROJECTION_JOB_CORRUPT"),
    project_generation: positiveInteger(rowValue(row, "project_generation"), "CHANGE_PROJECTION_JOB_CORRUPT"),
    generation: positiveInteger(rowValue(row, "generation"), "CHANGE_PROJECTION_JOB_CORRUPT"),
    input_hash: sha(rowValue(row, "input_hash"), "CHANGE_PROJECTION_JOB_CORRUPT"),
    retryable,
    created_at: timestamp(rowValue(row, "created_at"), "CHANGE_PROJECTION_JOB_CORRUPT"),
    updated_at: timestamp(rowValue(row, "updated_at"), "CHANGE_PROJECTION_JOB_CORRUPT")
  };
  const owner = optionalText(requiredRowValue(row, "owner_id", "CHANGE_PROJECTION_JOB_CORRUPT"), "CHANGE_PROJECTION_JOB_CORRUPT");
  const token = optionalText(requiredRowValue(row, "lease_token", "CHANGE_PROJECTION_JOB_CORRUPT"), "CHANGE_PROJECTION_JOB_CORRUPT");
  const expiry = requiredRowValue(row, "lease_expires_at", "CHANGE_PROJECTION_JOB_CORRUPT");
  if (owner !== undefined) result.owner_id = owner;
  if (token !== undefined) result.lease_token = token;
  if (expiry !== null && expiry !== undefined) result.lease_expires_at = timestamp(expiry, "CHANGE_PROJECTION_JOB_CORRUPT");
  const output = optionalText(requiredRowValue(row, "output_hash", "CHANGE_PROJECTION_JOB_CORRUPT"), "CHANGE_PROJECTION_JOB_CORRUPT", 71);
  if (output !== undefined) {
    if (!SHA256.test(output)) fail("CHANGE_PROJECTION_JOB_CORRUPT");
    result.output_hash = output;
  }
  const count = requiredRowValue(row, "document_count", "CHANGE_PROJECTION_JOB_CORRUPT");
  if (count !== null && count !== undefined) result.document_count = nonNegativeInteger(count, "CHANGE_PROJECTION_JOB_CORRUPT");
  const reason = optionalText(requiredRowValue(row, "reason_code", "CHANGE_PROJECTION_JOB_CORRUPT"), "CHANGE_PROJECTION_JOB_CORRUPT");
  if (reason !== undefined) result.reason_code = reason;
  const hasOwner = owner !== undefined;
  const hasToken = token !== undefined;
  const hasExpiry = expiry !== null && expiry !== undefined;
  const hasOutput = output !== undefined;
  const hasCount = count !== null && count !== undefined;
  if (status === "queued" &&
      (hasOwner || hasToken || hasExpiry || hasOutput || hasCount || reason !== undefined || retryable !== true)) {
    fail("CHANGE_PROJECTION_JOB_CORRUPT");
  }
  if (status === "projecting" &&
      (!hasOwner || !hasToken || !hasExpiry || hasOutput || hasCount || reason !== undefined || retryable !== true)) {
    fail("CHANGE_PROJECTION_JOB_CORRUPT");
  }
  if (status === "ready" &&
      (hasOwner || hasToken || hasExpiry || !hasOutput || !hasCount || reason !== undefined || retryable !== false)) {
    fail("CHANGE_PROJECTION_JOB_CORRUPT");
  }
  if (status === "failed" &&
      (hasOwner || hasToken || hasExpiry || hasOutput || hasCount || reason === undefined)) {
    fail("CHANGE_PROJECTION_JOB_CORRUPT");
  }
  return result;
}

function resultFromRow(row: unknown): KnowledgeResult {
  const contentKind = rowValue(row, "content_kind");
  const status = rowValue(row, "status");
  if (contentKind !== "knowledge_entry" || status !== "active") fail("KNOWLEDGE_RESULT_CORRUPT");
  const confidence = rowValue(row, "confidence");
  const confidenceNumber = typeof confidence === "string" ? Number(confidence) : confidence;
  if (typeof confidenceNumber !== "number" || !Number.isFinite(confidenceNumber) || confidenceNumber < 0 || confidenceNumber > 1) {
    fail("KNOWLEDGE_RESULT_CORRUPT");
  }
  return {
    schema_version: 1,
    knowledge_id: text(rowValue(row, "knowledge_id"), "KNOWLEDGE_RESULT_CORRUPT", 160),
    project_id: text(rowValue(row, "project_id"), "KNOWLEDGE_RESULT_CORRUPT", 160),
    content_kind: "knowledge_entry",
    status: "active",
    content_hash: sha(rowValue(row, "content_hash"), "KNOWLEDGE_RESULT_CORRUPT"),
    display_title: text(rowValue(row, "display_title"), "KNOWLEDGE_RESULT_CORRUPT", 240),
    summary: text(rowValue(row, "summary"), "KNOWLEDGE_RESULT_CORRUPT", MAX_TEXT),
    reusability_scope: text(rowValue(row, "reusability_scope"), "KNOWLEDGE_RESULT_CORRUPT", MAX_TEXT),
    confidence: confidenceNumber,
    source_archive_ids: jsonArrayStrings(rowValue(row, "source_archive_ids"), "KNOWLEDGE_RESULT_CORRUPT"),
    source_change_keys: jsonArrayStrings(rowValue(row, "source_change_keys"), "KNOWLEDGE_RESULT_CORRUPT"),
    source_candidate_ids: jsonArrayStrings(rowValue(row, "source_candidate_ids"), "KNOWLEDGE_RESULT_CORRUPT"),
    source_refs: jsonArrayStrings(rowValue(row, "source_refs"), "KNOWLEDGE_RESULT_CORRUPT"),
    extractor_version: text(rowValue(row, "extractor_version"), "KNOWLEDGE_RESULT_CORRUPT"),
    prompt_version: text(rowValue(row, "prompt_version"), "KNOWLEDGE_RESULT_CORRUPT"),
    index_schema_version: text(rowValue(row, "index_schema_version"), "KNOWLEDGE_RESULT_CORRUPT"),
    generation: positiveInteger(rowValue(row, "generation"), "KNOWLEDGE_RESULT_CORRUPT"),
    created_at: timestamp(rowValue(row, "created_at"), "KNOWLEDGE_RESULT_CORRUPT"),
    updated_at: timestamp(rowValue(row, "updated_at"), "KNOWLEDGE_RESULT_CORRUPT"),
    ...entryProjectionFromRow(row)
  };
}

/**
 * 三列都可空：候选生成器上线前的归档不带它们。缺失保持缺失，不补默认值——
 * "没有分类"和"分类是某个默认值"在下游是两回事。
 */
function entryProjectionFromRow(row: unknown) {
  const entryType = rowValue(row, "entry_type");
  const body = rowValue(row, "body");
  const keywords = rowValue(row, "keywords");
  return {
    ...(entryType === null || entryType === undefined ? {} : {
      entry_type: text(entryType, "KNOWLEDGE_RESULT_CORRUPT", 32) as
        NonNullable<KnowledgeResult["entry_type"]>
    }),
    ...(body === null || body === undefined ? {} : {
      body: text(body, "KNOWLEDGE_RESULT_CORRUPT", MAX_TEXT)
    }),
    ...(keywords === null || keywords === undefined ? {} : {
      keywords: jsonArrayStrings(keywords, "KNOWLEDGE_RESULT_CORRUPT")
    })
  };
}

function databaseCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || nodeTypes.isProxy(error)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}

function isUnique(error: unknown): boolean { return databaseCode(error) === "23505"; }

async function transaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve the original failure */ }
    throw error;
  } finally {
    client.release();
  }
}

async function safeStorage<T>(operation: () => Promise<T>, preserveStatementTimeout = false): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (preserveStatementTimeout && databaseCode(error) === "57014") throw error;
    if (error instanceof KnowledgePipelineError) throw error;
    storageFailure();
  }
}

async function lockFence(client: PoolClient, projectId: string): Promise<{ knowledge: number; change: number }> {
  try {
    await client.query(
      `INSERT INTO knowledge_pipeline_project_fences(project_id)
       VALUES ($1) ON CONFLICT (project_id) DO NOTHING`,
      [projectId]
    );
  } catch (error) {
    if (databaseCode(error) === "23503") fail("PROJECT_NOT_FOUND");
    throw error;
  }
  const result = await client.query<Row>(
    `SELECT knowledge_generation, change_projection_generation
       FROM knowledge_pipeline_project_fences
      WHERE project_id = $1 FOR UPDATE`,
    [projectId]
  );
  const row = result.rows[0];
  if (row === undefined) fail("PROJECT_NOT_FOUND");
  return {
    knowledge: nonNegativeInteger(rowValue(row, "knowledge_generation"), "KNOWLEDGE_PIPELINE_FENCE_CORRUPT"),
    change: nonNegativeInteger(rowValue(row, "change_projection_generation"), "KNOWLEDGE_PIPELINE_FENCE_CORRUPT")
  };
}

/** Serialize every queue-capacity decision, including requests for different projects. */
async function lockCapacityFence(client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO knowledge_pipeline_capacity_fence(fence_id)
     VALUES (1) ON CONFLICT (fence_id) DO NOTHING`
  );
  const result = await client.query<Row>(
    `SELECT fence_id
       FROM knowledge_pipeline_capacity_fence
      WHERE fence_id = 1 FOR UPDATE`
  );
  if (result.rows[0] === undefined) fail("KNOWLEDGE_PIPELINE_CAPACITY_FENCE_CORRUPT");
  positiveInteger(rowValue(result.rows[0], "fence_id"), "KNOWLEDGE_PIPELINE_CAPACITY_FENCE_CORRUPT");
}

async function incrementFence(client: PoolClient, projectId: string, column: "knowledge_generation" | "change_projection_generation"): Promise<number> {
  const result = await client.query<Row>(
    `UPDATE knowledge_pipeline_project_fences
        SET ${column} = ${column} + 1
      WHERE project_id = $1
      RETURNING ${column}`,
    [projectId]
  );
  const row = result.rows[0];
  if (row === undefined) fail("PROJECT_NOT_FOUND");
  return positiveInteger(rowValue(row, column), "KNOWLEDGE_PIPELINE_FENCE_CORRUPT");
}

async function archiveForClient(client: PoolClient, archiveId: string): Promise<StoredArchive> {
  const result = await client.query<Row>(
    `SELECT archive_id, project_id, change_key, package_sha256, manifest_sha256, project_version,
            package_schema_version, archive_schema_version, package_bytes, manifest_bytes,
            knowledge_candidates, project_content_candidates, validation_receipt, stored_at
       FROM knowledge_pipeline_archives WHERE archive_id = $1 FOR SHARE`,
    [archiveId]
  );
  const row = result.rows[0];
  if (row === undefined) fail("ARCHIVE_NOT_FOUND");
  return archiveFromRow(row);
}

function archiveParams(archive: StoredArchive): unknown[] {
  return [
    archive.archive_id, archive.project_id, archive.change_key, archive.package_sha256,
    archive.manifest_sha256, archive.project_version, archive.package_schema_version,
    archive.archive_schema_version, Buffer.from(archive.package_bytes), Buffer.from(archive.manifest_bytes),
    JSON.stringify(archive.knowledge_candidates), JSON.stringify(archive.project_content_candidates),
    JSON.stringify(archive.validation_receipt), archive.stored_at
  ];
}

export class PgArchiveStore implements ArchiveStore {
  readonly #pool: Pool;

  constructor(pool: Pool) { this.#pool = pool; }

  async putIfAbsent(rawArchive: StoredArchive): Promise<ArchiveStorePutResult> {
    return safeStorage(async () => {
      const archive = snapshotArchive(rawArchive);
      try {
        return await transaction(this.#pool, async (client) => {
          const inserted = await client.query<Row>(
            `INSERT INTO knowledge_pipeline_archives(
               archive_id, project_id, change_key, package_sha256, manifest_sha256, project_version,
               package_schema_version, archive_schema_version, package_bytes, manifest_bytes,
               knowledge_candidates, project_content_candidates, validation_receipt, stored_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14)
             ON CONFLICT (archive_id) DO NOTHING
             RETURNING archive_id, project_id, change_key, package_sha256, manifest_sha256, project_version,
                       package_schema_version, archive_schema_version, package_bytes, manifest_bytes,
                       knowledge_candidates, project_content_candidates, validation_receipt, stored_at`,
            archiveParams(archive)
          );
          if (inserted.rows[0] !== undefined) {
            return { disposition: "stored", archive: archiveFromRow(inserted.rows[0]) };
          }
          const byIdResult = await client.query<Row>(
            `SELECT archive_id, project_id, change_key, package_sha256, manifest_sha256, project_version,
                    package_schema_version, archive_schema_version, package_bytes, manifest_bytes,
                    knowledge_candidates, project_content_candidates, validation_receipt, stored_at
               FROM knowledge_pipeline_archives WHERE archive_id = $1 FOR SHARE`,
            [archive.archive_id]
          );
          if (byIdResult.rows[0] !== undefined) {
            const existing = archiveFromRow(byIdResult.rows[0]);
            if (!archiveIdentityEqual(existing, archive)) fail("ARCHIVE_IDENTITY_CONFLICT");
            return { disposition: "existing", archive: existing };
          }
          const byCanonical = await client.query<Row>(
            `SELECT archive_id, project_id, change_key, package_sha256, manifest_sha256, project_version,
                    package_schema_version, archive_schema_version, package_bytes, manifest_bytes,
                    knowledge_candidates, project_content_candidates, validation_receipt, stored_at
               FROM knowledge_pipeline_archives
              WHERE project_id = $1 AND package_sha256 = $2 AND manifest_sha256 = $3
                AND package_schema_version = $4 AND archive_schema_version = $5 FOR SHARE`,
            [archive.project_id, archive.package_sha256, archive.manifest_sha256,
              archive.package_schema_version, archive.archive_schema_version]
          );
          if (byCanonical.rows[0] !== undefined) {
            const existing = archiveFromRow(byCanonical.rows[0]);
            if (!archiveCanonicalEqual(existing, archive)) fail("ARCHIVE_CANONICAL_IDENTITY_CONFLICT");
            fail("ARCHIVE_CANONICAL_IDENTITY_CONFLICT");
          }
          const byChange = await client.query<Row>(
            `SELECT archive_id, project_id, change_key, package_sha256, manifest_sha256, project_version,
                    package_schema_version, archive_schema_version, package_bytes, manifest_bytes,
                    knowledge_candidates, project_content_candidates, validation_receipt, stored_at
               FROM knowledge_pipeline_archives WHERE project_id = $1 AND change_key = $2 FOR SHARE`,
            [archive.project_id, archive.change_key]
          );
          if (byChange.rows[0] !== undefined) fail("ARCHIVE_IDENTITY_CONFLICT");
          fail("ARCHIVE_STORE_CONFLICT");
        });
      } catch (error) {
        if (!isUnique(error)) throw error;
        // A concurrent insert can win either the archive-id or canonical key.
        return transaction(this.#pool, async (client) => {
          const result = await client.query<Row>(
            `SELECT archive_id, project_id, change_key, package_sha256, manifest_sha256, project_version,
                    package_schema_version, archive_schema_version, package_bytes, manifest_bytes,
                    knowledge_candidates, project_content_candidates, validation_receipt, stored_at
               FROM knowledge_pipeline_archives
              WHERE archive_id = $1 OR
                (project_id = $2 AND change_key = $3) OR
                (project_id = $2 AND package_sha256 = $4 AND manifest_sha256 = $5
                  AND package_schema_version = $6 AND archive_schema_version = $7)
              ORDER BY CASE WHEN archive_id = $1 THEN 0 ELSE 1 END LIMIT 1 FOR SHARE`,
            [archive.archive_id, archive.project_id, archive.change_key, archive.package_sha256,
              archive.manifest_sha256, archive.package_schema_version, archive.archive_schema_version]
          );
          const row = result.rows[0];
          if (row === undefined) fail("ARCHIVE_STORE_CONFLICT");
          const existing = archiveFromRow(row);
          if (archiveIdentityEqual(existing, archive)) return { disposition: "existing", archive: existing };
          if (archiveCanonicalEqual(existing, archive)) fail("ARCHIVE_CANONICAL_IDENTITY_CONFLICT");
          fail("ARCHIVE_IDENTITY_CONFLICT");
        });
      }
    });
  }

  async getByArchiveId(archive_id: string): Promise<StoredArchive | null> {
    return safeStorage(async () => {
      const value = text(archive_id, "ARCHIVE_ID_INVALID", 160);
      if (!ARCHIVE.test(value)) fail("ARCHIVE_ID_INVALID");
      const result = await this.#pool.query<Row>(
        `SELECT archive_id, project_id, change_key, package_sha256, manifest_sha256, project_version,
                package_schema_version, archive_schema_version, package_bytes, manifest_bytes,
                knowledge_candidates, project_content_candidates, validation_receipt, stored_at
           FROM knowledge_pipeline_archives WHERE archive_id = $1`,
        [value]
      );
      return result.rows[0] === undefined ? null : archiveFromRow(result.rows[0]);
    });
  }
}

export interface PgJobRepositoryOptions {
  max_queued_change_projection_jobs?: number;
  max_queued_knowledge_jobs?: number;
  max_queued_project_content_jobs?: number;
}

function queueCapacity(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value < 0) fail("PIPELINE_QUEUE_CAPACITY_INVALID");
  return value;
}

function planChangeIdentity(input: PlanArchiveTasksInput): string {
  return [
    input.archive.schema_version, input.archive.project_id, input.archive.change_key,
    input.archive.archive_id, input.archive.package_sha256, input.archive.manifest_sha256,
    input.archive.project_version, input.archive.package_schema_version,
    input.archive.archive_schema_version, input.change_projection_input_hash
  ].join("\0");
}

function jobIdForChange(input: PlanArchiveTasksInput): string {
  return identifier("job_change", planChangeIdentity(input));
}

function jobIdForKnowledge(projectId: string, idempotencyKey: string): string {
  return identifier("job_knowledge", `${projectId}\0${idempotencyKey}`);
}

function projectContentJobId(projectId: string, packageSha256: string): string {
  return identifier("job_content", `${projectId}\0${packageSha256}`);
}

function validatePlanInput(raw: PlanArchiveTasksInput): PlanArchiveTasksInput {
  const record = safeOwnRecord(raw, [
    "archive", "idempotency_key", "extractor_version", "prompt_version", "index_schema_version",
    "change_projection_input_hash", "input_hash", "now"
  ], "PIPELINE_TASK_PLAN_INVALID");
  const archive = snapshotArchive(record.archive, "PIPELINE_TASK_PLAN_INVALID");
  return {
    archive,
    idempotency_key: text(record.idempotency_key, "PIPELINE_TASK_PLAN_INVALID"),
    extractor_version: text(record.extractor_version, "PIPELINE_TASK_PLAN_INVALID"),
    prompt_version: text(record.prompt_version, "PIPELINE_TASK_PLAN_INVALID"),
    index_schema_version: text(record.index_schema_version, "PIPELINE_TASK_PLAN_INVALID"),
    change_projection_input_hash: sha(record.change_projection_input_hash, "PIPELINE_TASK_PLAN_INVALID"),
    input_hash: sha(record.input_hash, "PIPELINE_TASK_PLAN_INVALID"),
    now: timestamp(record.now, "PIPELINE_TASK_PLAN_INVALID")
  };
}

function validateEnqueueInput(raw: EnqueueKnowledgeJobInput): EnqueueKnowledgeJobInput {
  const record = safeOwnRecord(raw, [
    "archive", "idempotency_key", "extractor_version", "prompt_version", "index_schema_version",
    "input_hash", "now"
  ], "KNOWLEDGE_JOB_ENQUEUE_INVALID");
  return {
    archive: snapshotArchive(record.archive, "KNOWLEDGE_JOB_ENQUEUE_INVALID"),
    idempotency_key: text(record.idempotency_key, "KNOWLEDGE_JOB_ENQUEUE_INVALID"),
    extractor_version: text(record.extractor_version, "KNOWLEDGE_JOB_ENQUEUE_INVALID"),
    prompt_version: text(record.prompt_version, "KNOWLEDGE_JOB_ENQUEUE_INVALID"),
    index_schema_version: text(record.index_schema_version, "KNOWLEDGE_JOB_ENQUEUE_INVALID"),
    input_hash: sha(record.input_hash, "KNOWLEDGE_JOB_ENQUEUE_INVALID"),
    now: timestamp(record.now, "KNOWLEDGE_JOB_ENQUEUE_INVALID")
  };
}

function projectCandidateFromRow(
  row: unknown,
  projectId: string,
  candidateType: string,
  status: string
): ProjectContentCandidate {
  const parsed = projectContentCandidateSchema.safeParse(
    snapshotJson(rowValue(row, "candidate"), "PROJECT_CANDIDATE_CORRUPT")
  );
  if (!parsed.success) fail("PROJECT_CANDIDATE_CORRUPT");
  const rowProjectId = text(rowValue(row, "project_id"), "PROJECT_CANDIDATE_CORRUPT", 160);
  const rowCandidateType = text(rowValue(row, "candidate_type"), "PROJECT_CANDIDATE_CORRUPT", 64);
  const rowContentHash = sha(rowValue(row, "content_hash"), "PROJECT_CANDIDATE_CORRUPT");
  const rowCandidateId = text(rowValue(row, "candidate_id"), "PROJECT_CANDIDATE_CORRUPT", 160);
  const rowStatus = text(rowValue(row, "status"), "PROJECT_CANDIDATE_CORRUPT", 64);
  const rowCreatedAt = timestamp(rowValue(row, "created_at"), "PROJECT_CANDIDATE_CORRUPT");
  const candidateCreatedAt = new Date(parsed.data.provenance.created_at);
  if (rowProjectId !== projectId || rowCandidateType !== candidateType || rowStatus !== status ||
      parsed.data.candidate_type !== rowCandidateType || parsed.data.content_hash !== rowContentHash ||
      parsed.data.candidate_id !== rowCandidateId || parsed.data.status !== rowStatus ||
      Number.isNaN(candidateCreatedAt.getTime()) || candidateCreatedAt.toISOString() !== rowCreatedAt) {
    fail("PROJECT_CANDIDATE_CORRUPT");
  }
  return structuredClone(parsed.data);
}

export class PgJobRepository implements JobRepository {
  readonly #pool: Pool;
  readonly #maxChange: number;
  readonly #maxKnowledge: number;
  readonly #maxContent: number;

  constructor(pool: Pool, options: PgJobRepositoryOptions = {}) {
    this.#pool = pool;
    this.#maxChange = queueCapacity(options.max_queued_change_projection_jobs);
    this.#maxKnowledge = queueCapacity(options.max_queued_knowledge_jobs);
    this.#maxContent = queueCapacity(options.max_queued_project_content_jobs);
  }

  async planArchiveTasks(rawInput: PlanArchiveTasksInput): Promise<PlanArchiveTasksResult> {
    return safeStorage(async () => {
      const input = validatePlanInput(rawInput);
      return transaction(this.#pool, async (client) => {
        await lockFence(client, input.archive.project_id);
        await lockCapacityFence(client);
        const archive = await archiveForClient(client, input.archive.archive_id);
        if (!archiveIdentityEqual(archive, input.archive)) fail("ARCHIVE_IDENTITY_CONFLICT");

        const existingPlan = await client.query<Row>(
          `SELECT project_id, idempotency_key, change_projection_job_id, knowledge_job_id,
                  project_content_job_id
             FROM knowledge_pipeline_task_plans
            WHERE project_id = $1 AND idempotency_key = $2 FOR UPDATE`,
          [archive.project_id, input.idempotency_key]
        );
        if (existingPlan.rows[0] !== undefined) {
          const plan = existingPlan.rows[0];
          const changeJob = await this.#changeJobForClient(client, String(rowValue(plan, "change_projection_job_id")));
          const knowledgeJob = await this.#knowledgeJobForClient(client, String(rowValue(plan, "knowledge_job_id")));
          if (changeJob.project_id !== archive.project_id || knowledgeJob.project_id !== archive.project_id ||
              knowledgeJob.archive_id !== archive.archive_id) fail("PIPELINE_TASK_PLAN_CORRUPT");
          const contentJob = optionalText(rowValue(plan, "project_content_job_id"), "PIPELINE_TASK_PLAN_CORRUPT", 160);
          return {
            change_projection_job_id: changeJob.job_id,
            change_projection_job: changeJob,
            knowledge_job: knowledgeJob,
            ...(contentJob === undefined ? {} : { project_content_job_id: contentJob })
          };
        }

        const existingChangeResult = await client.query<Row>(
          `SELECT * FROM knowledge_pipeline_change_jobs
            WHERE project_id = $1 AND input_hash = $2 FOR UPDATE`,
          [archive.project_id, input.change_projection_input_hash]
        );
        const existingKnowledgeResult = await client.query<Row>(
          `SELECT * FROM knowledge_pipeline_knowledge_jobs
            WHERE project_id = $1 AND idempotency_key = $2 FOR UPDATE`,
          [archive.project_id, input.idempotency_key]
        );
        const needsChange = existingChangeResult.rows[0] === undefined;
        const needsKnowledge = existingKnowledgeResult.rows[0] === undefined;
        const changeCount = await this.#activeCount(client, "knowledge_pipeline_change_jobs", ["queued", "projecting"]);
        const knowledgeCount = await this.#activeCount(client, "knowledge_pipeline_knowledge_jobs", ["queued", "extracting"]);
        if ((needsChange && changeCount >= this.#maxChange) ||
            (needsKnowledge && knowledgeCount >= this.#maxKnowledge)) {
          fail("PIPELINE_QUEUE_CAPACITY_EXCEEDED", true);
        }

        const contentJobId = archive.project_content_candidates.length === 0
          ? undefined
          : projectContentJobId(archive.project_id, archive.package_sha256);
        if (contentJobId !== undefined) {
          const existingContent = await client.query<Row>(
            `SELECT count(DISTINCT project_content_job_id)::int AS count,
                    count(*) FILTER (WHERE project_content_job_id = $1)::int AS existing_count
               FROM knowledge_pipeline_task_plans
              WHERE project_content_job_id IS NOT NULL`,
            [contentJobId]
          );
          const count = Number(existingContent.rows[0]?.count ?? 0);
          const existingCount = Number(existingContent.rows[0]?.existing_count ?? 0);
          if (existingCount === 0 && count >= this.#maxContent) fail("PIPELINE_QUEUE_CAPACITY_EXCEEDED", true);
        }

        let changeJob: ChangeProjectionJob;
        if (existingChangeResult.rows[0] !== undefined) {
          changeJob = changeJobFromRow(existingChangeResult.rows[0]);
          if (changeJob.archive_id !== archive.archive_id || changeJob.package_sha256 !== archive.package_sha256 ||
              changeJob.manifest_sha256 !== archive.manifest_sha256) fail("CHANGE_PROJECTION_IDENTITY_CONFLICT");
        } else {
          const generation = await incrementFence(client, archive.project_id, "change_projection_generation");
          const jobId = jobIdForChange(input);
          const inserted = await client.query<Row>(
            `INSERT INTO knowledge_pipeline_change_jobs(
               job_id, project_id, change_key, archive_id, package_sha256, manifest_sha256,
               project_version, package_schema_version, archive_schema_version, status, attempt,
               project_generation, generation, input_hash, retryable, created_at, updated_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',1,$10,1,$11,true,$12,$12)
             RETURNING *`,
            [jobId, archive.project_id, archive.change_key, archive.archive_id, archive.package_sha256,
              archive.manifest_sha256, archive.project_version, archive.package_schema_version,
              archive.archive_schema_version, generation, input.change_projection_input_hash, input.now]
          );
          changeJob = changeJobFromRow(inserted.rows[0]);
        }

        let knowledgeJob: KnowledgeExtractionJob;
        if (existingKnowledgeResult.rows[0] !== undefined) {
          knowledgeJob = knowledgeJobFromRow(existingKnowledgeResult.rows[0]);
          if (knowledgeJob.archive_id !== archive.archive_id || knowledgeJob.package_sha256 !== archive.package_sha256 ||
              knowledgeJob.extractor_version !== input.extractor_version || knowledgeJob.prompt_version !== input.prompt_version ||
              knowledgeJob.index_schema_version !== input.index_schema_version) fail("KNOWLEDGE_JOB_IDENTITY_CONFLICT");
        } else {
          const generation = await incrementFence(client, archive.project_id, "knowledge_generation");
          const inserted = await client.query<Row>(
            `INSERT INTO knowledge_pipeline_knowledge_jobs(
               job_id, idempotency_key, project_id, change_key, archive_id, package_sha256,
               extractor_version, prompt_version, index_schema_version, status, attempt, generation,
               input_hash, retryable, knowledge_candidates, created_at, updated_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',1,$10,$11,true,$12::jsonb,$13,$13)
             RETURNING *`,
            [jobIdForKnowledge(archive.project_id, input.idempotency_key), input.idempotency_key,
              archive.project_id, archive.change_key, archive.archive_id, archive.package_sha256,
              input.extractor_version, input.prompt_version, input.index_schema_version, generation,
              input.input_hash, JSON.stringify(archive.knowledge_candidates), input.now]
          );
          knowledgeJob = knowledgeJobFromRow(inserted.rows[0]);
        }
        await this.#insertCandidates(client, archive);
        await client.query(
          `INSERT INTO knowledge_pipeline_task_plans(
             project_id, idempotency_key, change_projection_job_id, knowledge_job_id,
             project_content_job_id, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6)`,
          [archive.project_id, input.idempotency_key, changeJob.job_id, knowledgeJob.job_id, contentJobId ?? null, input.now]
        );
        return {
          change_projection_job_id: changeJob.job_id,
          change_projection_job: changeJob,
          knowledge_job: knowledgeJob,
          ...(contentJobId === undefined ? {} : { project_content_job_id: contentJobId })
        };
      });
    });
  }

  async enqueueKnowledgeJob(rawInput: EnqueueKnowledgeJobInput): Promise<KnowledgeExtractionJob> {
    return safeStorage(async () => {
      const input = validateEnqueueInput(rawInput);
      return transaction(this.#pool, async (client) => {
        await lockFence(client, input.archive.project_id);
        await lockCapacityFence(client);
        const archive = await archiveForClient(client, input.archive.archive_id);
        if (!archiveIdentityEqual(archive, input.archive)) fail("ARCHIVE_IDENTITY_CONFLICT");
        const existing = await client.query<Row>(
          `SELECT * FROM knowledge_pipeline_knowledge_jobs
            WHERE project_id = $1 AND idempotency_key = $2 FOR UPDATE`,
          [archive.project_id, input.idempotency_key]
        );
        if (existing.rows[0] !== undefined) {
          const job = knowledgeJobFromRow(existing.rows[0]);
          if (job.archive_id !== archive.archive_id || job.package_sha256 !== archive.package_sha256 ||
              job.extractor_version !== input.extractor_version || job.prompt_version !== input.prompt_version ||
              job.index_schema_version !== input.index_schema_version || job.input_hash !== input.input_hash) {
            fail("KNOWLEDGE_JOB_IDENTITY_CONFLICT");
          }
          return job;
        }
        const active = await this.#activeCount(client, "knowledge_pipeline_knowledge_jobs", ["queued", "extracting"]);
        if (active >= this.#maxKnowledge) fail("KNOWLEDGE_QUEUE_CAPACITY_EXCEEDED", true);
        const generation = await incrementFence(client, archive.project_id, "knowledge_generation");
        const result = await client.query<Row>(
          `INSERT INTO knowledge_pipeline_knowledge_jobs(
             job_id, idempotency_key, project_id, change_key, archive_id, package_sha256,
             extractor_version, prompt_version, index_schema_version, status, attempt, generation,
             input_hash, retryable, knowledge_candidates, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',1,$10,$11,true,$12::jsonb,$13,$13)
           RETURNING *`,
          [jobIdForKnowledge(archive.project_id, input.idempotency_key), input.idempotency_key,
            archive.project_id, archive.change_key, archive.archive_id, archive.package_sha256,
            input.extractor_version, input.prompt_version, input.index_schema_version, generation,
            input.input_hash, JSON.stringify(archive.knowledge_candidates), input.now]
        );
        return knowledgeJobFromRow(result.rows[0]);
      });
    });
  }

  async getKnowledgeJob(job_id: string): Promise<KnowledgeExtractionJob | null> {
    return safeStorage(async () => {
      const id = text(job_id, "KNOWLEDGE_JOB_ID_INVALID", 160);
      const result = await this.#pool.query<Row>("SELECT * FROM knowledge_pipeline_knowledge_jobs WHERE job_id = $1", [id]);
      return result.rows[0] === undefined ? null : knowledgeJobFromRow(result.rows[0]);
    });
  }

  async listQueuedKnowledgeJobs(limit: number): Promise<KnowledgeExtractionJob[]> {
    return safeStorage(async () => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("KNOWLEDGE_DEQUEUE_INVALID");
      const result = await this.#pool.query<Row>(
        `SELECT knowledge_job.*
           FROM knowledge_pipeline_knowledge_jobs knowledge_job
          WHERE knowledge_job.status = 'queued'
            AND NOT EXISTS (
              SELECT 1
                FROM knowledge_pipeline_knowledge_jobs active_knowledge
               WHERE active_knowledge.project_id = knowledge_job.project_id
                 AND active_knowledge.status = 'extracting'
            )
            AND EXISTS (
              SELECT 1
                FROM knowledge_pipeline_change_jobs change_job
               WHERE change_job.status = 'ready'
                 AND change_job.project_id = knowledge_job.project_id
                 AND change_job.change_key = knowledge_job.change_key
                 AND change_job.archive_id = knowledge_job.archive_id
                 AND change_job.package_sha256 = knowledge_job.package_sha256
            )
          ORDER BY knowledge_job.updated_at ASC, knowledge_job.job_id ASC
          LIMIT $1`,
        [limit]
      );
      return result.rows.map(knowledgeJobFromRow);
    });
  }

  async listQueuedChangeProjectionJobs(limit: number): Promise<ChangeProjectionJob[]> {
    return safeStorage(async () => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("CHANGE_PROJECTION_DEQUEUE_INVALID");
      const result = await this.#pool.query<Row>(
        `SELECT change_job.* FROM knowledge_pipeline_change_jobs change_job
          WHERE change_job.status = 'queued'
            AND NOT EXISTS (
              SELECT 1
                FROM knowledge_pipeline_change_jobs active_change
               WHERE active_change.project_id = change_job.project_id
                 AND active_change.status = 'projecting'
            )
          ORDER BY change_job.updated_at ASC, change_job.job_id ASC
          LIMIT $1`,
        [limit]
      );
      return result.rows.map(changeJobFromRow);
    });
  }

  async getChangeProjectionJob(job_id: string): Promise<ChangeProjectionJob | null> {
    return safeStorage(async () => {
      const id = text(job_id, "CHANGE_PROJECTION_JOB_ID_INVALID", 160);
      const result = await this.#pool.query<Row>("SELECT * FROM knowledge_pipeline_change_jobs WHERE job_id = $1", [id]);
      return result.rows[0] === undefined ? null : changeJobFromRow(result.rows[0]);
    });
  }

  async claimChangeProjectionJob(rawInput: { job_id: string; owner_id: string; now: string; lease_expires_at: string }): Promise<ChangeProjectionJob> {
    const input = safeOwnRecord(rawInput, ["job_id", "owner_id", "now", "lease_expires_at"], "CHANGE_PROJECTION_CLAIM_INVALID");
    const jobId = text(input.job_id, "CHANGE_PROJECTION_CLAIM_INVALID", 160);
    const owner = text(input.owner_id, "CHANGE_PROJECTION_CLAIM_INVALID");
    const now = timestamp(input.now, "CHANGE_PROJECTION_CLAIM_INVALID");
    const expires = timestamp(input.lease_expires_at, "CHANGE_PROJECTION_CLAIM_INVALID");
    if (expires <= now) fail("CHANGE_PROJECTION_CLAIM_INVALID");
    return safeStorage(() => transaction(this.#pool, async (client) => {
      const currentResult = await client.query<Row>("SELECT * FROM knowledge_pipeline_change_jobs WHERE job_id = $1 FOR UPDATE", [jobId]);
      const current = currentResult.rows[0];
      if (current === undefined) fail("CHANGE_PROJECTION_JOB_NOT_FOUND");
      const before = changeJobFromRow(current);
      if (before.status !== "queued") fail("CHANGE_PROJECTION_CLAIM_STATE_INVALID");
      const token = identifier("lease_change", [jobId, before.generation, owner, now, expires].join("\0"));
      const result = await client.query<Row>(
        `UPDATE knowledge_pipeline_change_jobs
            SET status='projecting', owner_id=$2, lease_token=$3, lease_expires_at=$4,
                retryable=true, updated_at=$5
          WHERE job_id=$1 AND status='queued' RETURNING *`,
        [jobId, owner, token, expires, now]
      );
      return changeJobFromRow(result.rows[0]);
    }));
  }

  async renewChangeProjectionLease(input: RenewChangeProjectionLeaseInput): Promise<ChangeProjectionJob> {
    const record = safeOwnRecord(input, ["job_id", "generation", "owner_id", "lease_token", "now", "lease_expires_at"], "CHANGE_PROJECTION_RENEW_INVALID");
    const jobId = text(record.job_id, "CHANGE_PROJECTION_RENEW_INVALID", 160);
    const owner = text(record.owner_id, "CHANGE_PROJECTION_RENEW_INVALID");
    const token = text(record.lease_token, "CHANGE_PROJECTION_RENEW_INVALID");
    const now = timestamp(record.now, "CHANGE_PROJECTION_RENEW_INVALID");
    const expires = timestamp(record.lease_expires_at, "CHANGE_PROJECTION_RENEW_INVALID");
    const generation = positiveInteger(record.generation, "CHANGE_PROJECTION_RENEW_INVALID");
    if (expires <= now) fail("CHANGE_PROJECTION_RENEW_INVALID");
    return safeStorage(() => transaction(this.#pool, async (client) => {
      const result = await client.query<Row>(
        `UPDATE knowledge_pipeline_change_jobs
            SET lease_expires_at=$6, updated_at=$7
          WHERE job_id=$1 AND status='projecting' AND generation=$2 AND owner_id=$3
            AND lease_token=$4 AND lease_expires_at > $5::timestamptz
          RETURNING *`,
        [jobId, generation, owner, token, now, expires, now]
      );
      if (result.rows[0] !== undefined) return changeJobFromRow(result.rows[0]);
      await this.#assertActiveLease(client, jobId, generation, owner, token, now, "RENEW");
      fail("CHANGE_PROJECTION_LEASE_STALE");
    }));
  }

  async failChangeProjectionJob(input: FailChangeProjectionJobInput): Promise<ChangeProjectionJob> {
    const record = safeOwnRecord(input, ["job_id", "generation", "owner_id", "lease_token", "reason_code", "retryable", "now"], "CHANGE_PROJECTION_FAIL_INVALID");
    const jobId = text(record.job_id, "CHANGE_PROJECTION_FAIL_INVALID", 160);
    const owner = text(record.owner_id, "CHANGE_PROJECTION_FAIL_INVALID");
    const token = text(record.lease_token, "CHANGE_PROJECTION_FAIL_INVALID");
    const reason = text(record.reason_code, "CHANGE_PROJECTION_FAIL_INVALID");
    const now = timestamp(record.now, "CHANGE_PROJECTION_FAIL_INVALID");
    const generation = positiveInteger(record.generation, "CHANGE_PROJECTION_FAIL_INVALID");
    if (typeof record.retryable !== "boolean") fail("CHANGE_PROJECTION_FAIL_INVALID");
    return safeStorage(() => transaction(this.#pool, async (client) => {
      const result = await client.query<Row>(
        `UPDATE knowledge_pipeline_change_jobs
            SET status='failed', owner_id=NULL, lease_token=NULL, lease_expires_at=NULL,
                reason_code=$6, retryable=$7, updated_at=$8
          WHERE job_id=$1 AND status='projecting' AND generation=$2 AND owner_id=$3
            AND lease_token=$4 AND lease_expires_at > $5::timestamptz
          RETURNING *`,
        [jobId, generation, owner, token, now, reason, record.retryable, now]
      );
      if (result.rows[0] !== undefined) return changeJobFromRow(result.rows[0]);
      await this.#assertActiveLease(client, jobId, generation, owner, token, now, "FAIL");
      fail("CHANGE_PROJECTION_LEASE_STALE");
    }));
  }

  async reapExpiredChangeProjectionLease(input: ReapChangeProjectionLeaseInput): Promise<ChangeProjectionJob> {
    const record = safeOwnRecord(input, ["job_id", "generation", "now"], "CHANGE_PROJECTION_REAP_INVALID");
    const jobId = text(record.job_id, "CHANGE_PROJECTION_REAP_INVALID", 160);
    const generation = positiveInteger(record.generation, "CHANGE_PROJECTION_REAP_INVALID");
    const now = timestamp(record.now, "CHANGE_PROJECTION_REAP_INVALID");
    return safeStorage(() => transaction(this.#pool, async (client) => {
      const result = await client.query<Row>(
        `UPDATE knowledge_pipeline_change_jobs
            SET status='failed', owner_id=NULL, lease_token=NULL, lease_expires_at=NULL,
                reason_code='CHANGE_PROJECTION_LEASE_EXPIRED', retryable=true, updated_at=$3
          WHERE job_id=$1 AND status='projecting' AND generation=$2
            AND lease_expires_at <= $3::timestamptz RETURNING *`,
        [jobId, generation, now]
      );
      if (result.rows[0] !== undefined) return changeJobFromRow(result.rows[0]);
      const current = await this.#changeJobForClient(client, jobId);
      if (current.generation !== generation) fail("CHANGE_PROJECTION_JOB_GENERATION_STALE");
      if (current.status !== "projecting" || current.lease_expires_at === undefined || now < current.lease_expires_at) {
        fail("CHANGE_PROJECTION_REAP_STATE_INVALID");
      }
      fail("CHANGE_PROJECTION_REAP_STATE_INVALID");
    }));
  }

  async retryChangeProjectionJob(input: RetryChangeProjectionJobInput): Promise<ChangeProjectionJob> {
    const record = safeOwnRecord(input, ["job_id", "expected_generation", "expected_status", "now"], "CHANGE_PROJECTION_RETRY_INVALID");
    const jobId = text(record.job_id, "CHANGE_PROJECTION_RETRY_INVALID", 160);
    const expectedGeneration = positiveInteger(record.expected_generation, "CHANGE_PROJECTION_RETRY_INVALID");
    const now = timestamp(record.now, "CHANGE_PROJECTION_RETRY_INVALID");
    if (record.expected_status !== "failed") fail("CHANGE_PROJECTION_RETRY_INVALID");
    return safeStorage(() => transaction(this.#pool, async (client) => {
      const initial = await this.#readChangeJobForClient(client, jobId);
      await lockFence(client, initial.project_id);
      await lockCapacityFence(client);
      const current = await this.#changeJobForClient(client, jobId);
      if (current.generation !== expectedGeneration) fail("CHANGE_PROJECTION_JOB_GENERATION_STALE");
      if (current.status !== "failed" || !current.retryable) fail("CHANGE_PROJECTION_RETRY_STATE_INVALID");
      const active = await this.#activeCount(client, "knowledge_pipeline_change_jobs", ["queued", "projecting"]);
      if (active >= this.#maxChange) fail("CHANGE_PROJECTION_QUEUE_CAPACITY_EXCEEDED", true);
      const result = await client.query<Row>(
        `UPDATE knowledge_pipeline_change_jobs
            SET status='queued', attempt=attempt+1, generation=generation+1,
                output_hash=NULL, document_count=NULL, reason_code=NULL,
                owner_id=NULL, lease_token=NULL, lease_expires_at=NULL,
                retryable=true, updated_at=$3
          WHERE job_id=$1 AND status='failed' AND generation=$2 AND retryable=true
          RETURNING *`,
        [jobId, expectedGeneration, now]
      );
      if (result.rows[0] === undefined) fail("CHANGE_PROJECTION_RETRY_STATE_INVALID");
      return changeJobFromRow(result.rows[0]);
    }));
  }

  async startKnowledgeJob(job_id: string, now: string): Promise<KnowledgeExtractionJob> {
    const id = text(job_id, "KNOWLEDGE_START_INVALID", 160);
    const at = timestamp(now, "KNOWLEDGE_START_INVALID");
    return safeStorage(() => transaction(this.#pool, async (client) => {
      const result = await client.query<Row>(
        `UPDATE knowledge_pipeline_knowledge_jobs
            SET status='extracting', retryable=true, updated_at=$2
          WHERE job_id=$1 AND status='queued' RETURNING *`,
        [id, at]
      );
      if (result.rows[0] !== undefined) return knowledgeJobFromRow(result.rows[0]);
      const current = await this.#knowledgeJobForClient(client, id);
      if (current.status !== "queued") fail("KNOWLEDGE_START_STATE_INVALID");
      fail("KNOWLEDGE_START_STATE_INVALID");
    }));
  }

  async failKnowledgeJob(job_id: string, generation: number, reason_code: string, retryable: boolean, now: string): Promise<KnowledgeExtractionJob> {
    const id = text(job_id, "KNOWLEDGE_FAIL_INVALID", 160);
    const gen = positiveInteger(generation, "KNOWLEDGE_FAIL_INVALID");
    const reason = text(reason_code, "KNOWLEDGE_FAIL_INVALID");
    const at = timestamp(now, "KNOWLEDGE_FAIL_INVALID");
    if (typeof retryable !== "boolean") fail("KNOWLEDGE_FAIL_INVALID");
    return safeStorage(() => transaction(this.#pool, async (client) => {
      const result = await client.query<Row>(
        `UPDATE knowledge_pipeline_knowledge_jobs
            SET status='failed', retryable=$4, reason_code=$3, updated_at=$5
          WHERE job_id=$1 AND generation=$2 AND status IN ('queued','extracting')
          RETURNING *`,
        [id, gen, reason, retryable, at]
      );
      if (result.rows[0] !== undefined) return knowledgeJobFromRow(result.rows[0]);
      const current = await this.#knowledgeJobForClient(client, id);
      if (current.generation !== gen) fail("KNOWLEDGE_JOB_GENERATION_STALE");
      fail("KNOWLEDGE_FAIL_STATE_INVALID");
    }));
  }

  async retryKnowledgeJob(job_id: string, now: string): Promise<KnowledgeExtractionJob> {
    const id = text(job_id, "KNOWLEDGE_RETRY_INVALID", 160);
    const at = timestamp(now, "KNOWLEDGE_RETRY_INVALID");
    return safeStorage(() => transaction(this.#pool, async (client) => {
      const initial = await this.#readKnowledgeJobForClient(client, id);
      await lockFence(client, initial.project_id);
      await lockCapacityFence(client);
      const current = await this.#knowledgeJobForClient(client, id);
      if (current.status !== "failed" || !current.retryable) fail("KNOWLEDGE_RETRY_STATE_INVALID");
      const active = await this.#activeCount(client, "knowledge_pipeline_knowledge_jobs", ["queued", "extracting"]);
      if (active >= this.#maxKnowledge) fail("KNOWLEDGE_QUEUE_CAPACITY_EXCEEDED", true);
      const generation = await incrementFence(client, current.project_id, "knowledge_generation");
      const result = await client.query<Row>(
        `UPDATE knowledge_pipeline_knowledge_jobs
            SET status='queued', attempt=attempt+1, generation=$2,
                output_hash=NULL, result_count=NULL, reason_code=NULL,
                retryable=true, updated_at=$3
          WHERE job_id=$1 AND status='failed' AND retryable=true
          RETURNING *`,
        [id, generation, at]
      );
      if (result.rows[0] === undefined) fail("KNOWLEDGE_RETRY_STATE_INVALID");
      return knowledgeJobFromRow(result.rows[0]);
    }));
  }

  async listProjectContentCandidates(query: ProjectContentCandidateQuery): Promise<ProjectContentCandidateQueryResult> {
    const input = safeOwnRecordWithOptional(
      query,
      ["project_id", "candidate_type", "status", "limit"],
      ["cursor"],
      "CANDIDATE_QUERY_INVALID"
    );
    const projectId = text(input.project_id, "CANDIDATE_QUERY_INVALID", 160);
    const candidateType = text(input.candidate_type, "CANDIDATE_QUERY_INVALID", 64);
    const status = text(input.status, "CANDIDATE_QUERY_INVALID", 64);
    const rawLimit = input.limit;
    if (typeof rawLimit !== "number" || !Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
      fail("PAGINATION_LIMIT_INVALID");
    }
    const limit = rawLimit;
    let cursor: {
      project_id: string;
      candidate_type: string;
      status: string;
      created_at: string;
      candidate_id: string;
    } | undefined;
    if (input.cursor !== undefined) {
      try {
        const encodedCursor = text(input.cursor, "CANDIDATE_CURSOR_INVALID", 4096);
        const parsed: unknown = JSON.parse(Buffer.from(encodedCursor, "base64url").toString("utf8"));
        const record = safeOwnRecord(parsed, [
          "project_id", "candidate_type", "status", "created_at", "candidate_id"
        ], "CANDIDATE_CURSOR_INVALID");
        cursor = {
          project_id: text(record.project_id, "CANDIDATE_CURSOR_INVALID", 160),
          candidate_type: text(record.candidate_type, "CANDIDATE_CURSOR_INVALID", 64),
          status: text(record.status, "CANDIDATE_CURSOR_INVALID", 64),
          created_at: timestamp(record.created_at, "CANDIDATE_CURSOR_INVALID"),
          candidate_id: text(record.candidate_id, "CANDIDATE_CURSOR_INVALID", 160)
        };
        if (cursor.project_id !== projectId || cursor.candidate_type !== candidateType || cursor.status !== status) {
          fail("CANDIDATE_CURSOR_INVALID");
        }
      } catch (error) {
        if (error instanceof KnowledgePipelineError) throw error;
        fail("CANDIDATE_CURSOR_INVALID");
      }
    }
    return safeStorage(async () => {
      if (cursor !== undefined) {
        const anchor = await this.#pool.query<Row>(
          `SELECT project_id, candidate_type, content_hash, candidate_id, status,
                  candidate, created_at
             FROM knowledge_pipeline_project_candidates
            WHERE project_id=$1 AND candidate_type=$2 AND status=$3
              AND created_at=$4::timestamptz AND candidate_id=$5`,
          [projectId, candidateType, status, cursor.created_at, cursor.candidate_id]
        );
        if (anchor.rows[0] === undefined) fail("CANDIDATE_CURSOR_INVALID");
        projectCandidateFromRow(anchor.rows[0], projectId, candidateType, status);
      }
      const result = await this.#pool.query<Row>(
        `SELECT project_id, candidate_type, content_hash, candidate_id, status,
                candidate, created_at
           FROM knowledge_pipeline_project_candidates
          WHERE project_id=$1 AND candidate_type=$2 AND status=$3
            AND ($4::timestamptz IS NULL OR created_at < $4::timestamptz OR
              (created_at = $4::timestamptz AND candidate_id > $5::text))
          ORDER BY created_at DESC, candidate_id ASC LIMIT $6`,
        [projectId, candidateType, status, cursor?.created_at ?? null, cursor?.candidate_id ?? null, limit + 1]
      );
      const rows = result.rows;
      const limited = rows.slice(0, limit);
      const items = limited.map((row) => projectCandidateFromRow(row, projectId, candidateType, status));
      const lastRow = limited.at(-1);
      return rows.length > limit && lastRow !== undefined
        ? { items, next_cursor: Buffer.from(JSON.stringify({
            project_id: projectId,
            candidate_type: candidateType,
            status,
            created_at: timestamp(rowValue(lastRow, "created_at"), "PROJECT_CANDIDATE_CORRUPT"),
            candidate_id: text(rowValue(lastRow, "candidate_id"), "PROJECT_CANDIDATE_CORRUPT", 160)
          })).toString("base64url") }
        : { items };
    });
  }

  async #knowledgeJobForClient(client: PoolClient, jobId: string): Promise<KnowledgeExtractionJob> {
    const result = await client.query<Row>("SELECT * FROM knowledge_pipeline_knowledge_jobs WHERE job_id=$1 FOR UPDATE", [jobId]);
    if (result.rows[0] === undefined) fail("KNOWLEDGE_JOB_NOT_FOUND");
    return knowledgeJobFromRow(result.rows[0]);
  }

  async #readKnowledgeJobForClient(client: PoolClient, jobId: string): Promise<KnowledgeExtractionJob> {
    const result = await client.query<Row>("SELECT * FROM knowledge_pipeline_knowledge_jobs WHERE job_id=$1", [jobId]);
    if (result.rows[0] === undefined) fail("KNOWLEDGE_JOB_NOT_FOUND");
    return knowledgeJobFromRow(result.rows[0]);
  }

  async #changeJobForClient(client: PoolClient, jobId: string): Promise<ChangeProjectionJob> {
    const result = await client.query<Row>("SELECT * FROM knowledge_pipeline_change_jobs WHERE job_id=$1 FOR UPDATE", [jobId]);
    if (result.rows[0] === undefined) fail("CHANGE_PROJECTION_JOB_NOT_FOUND");
    return changeJobFromRow(result.rows[0]);
  }

  async #readChangeJobForClient(client: PoolClient, jobId: string): Promise<ChangeProjectionJob> {
    const result = await client.query<Row>("SELECT * FROM knowledge_pipeline_change_jobs WHERE job_id=$1", [jobId]);
    if (result.rows[0] === undefined) fail("CHANGE_PROJECTION_JOB_NOT_FOUND");
    return changeJobFromRow(result.rows[0]);
  }

  async #activeCount(client: PoolClient, table: string, statuses: readonly string[]): Promise<number> {
    const allowed = new Set(["knowledge_pipeline_change_jobs", "knowledge_pipeline_knowledge_jobs"]);
    if (!allowed.has(table)) fail("KNOWLEDGE_PIPELINE_STORAGE_INVALID");
    const result = await client.query<Row>(`SELECT count(*)::int AS count FROM ${table} WHERE status = ANY($1::text[])`, [statuses]);
    return nonNegativeInteger(rowValue(result.rows[0], "count"), "KNOWLEDGE_PIPELINE_STORAGE_CORRUPT");
  }

  async #insertCandidates(client: PoolClient, archive: StoredArchive): Promise<void> {
    for (const candidate of archive.project_content_candidates) {
      const createdAt = text(candidate.provenance.created_at, "PROJECT_CANDIDATE_INVALID", 64);
      await client.query(
        `INSERT INTO knowledge_pipeline_project_candidates(
           project_id, candidate_type, content_hash, candidate_id, status, candidate, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$7)
         ON CONFLICT (project_id, candidate_type, content_hash) DO NOTHING`,
        [archive.project_id, candidate.candidate_type, candidate.content_hash, candidate.candidate_id,
          candidate.status, JSON.stringify(candidate), createdAt]
      );
    }
  }

  async #assertActiveLease(client: PoolClient, jobId: string, generation: number, owner: string, token: string, now: string, operation: "RENEW" | "FAIL"): Promise<void> {
    const current = await this.#changeJobForClient(client, jobId);
    if (current.generation !== generation) fail("CHANGE_PROJECTION_JOB_GENERATION_STALE");
    if (current.status !== "projecting" || current.owner_id !== owner || current.lease_token !== token) fail("CHANGE_PROJECTION_LEASE_STALE");
    if (current.lease_expires_at === undefined || now >= current.lease_expires_at) fail("CHANGE_PROJECTION_LEASE_EXPIRED");
    fail(`CHANGE_PROJECTION_${operation}_STATE_INVALID`);
  }
}

function validateKnowledgeResult(value: unknown): KnowledgeResult {
  const record = safeOwnRecordWithOptional(value, [
    "schema_version", "knowledge_id", "project_id", "content_kind", "status", "content_hash",
    "display_title", "summary", "reusability_scope", "confidence", "source_archive_ids",
    "source_change_keys", "source_candidate_ids", "source_refs", "extractor_version", "prompt_version",
    "index_schema_version", "generation", "created_at", "updated_at"
  ], ["entry_type", "body", "keywords"], "KNOWLEDGE_RESULT_INVALID");
  if (record.schema_version !== 1 || record.content_kind !== "knowledge_entry" || record.status !== "active") fail("KNOWLEDGE_RESULT_INVALID");
  const confidence = record.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) fail("KNOWLEDGE_RESULT_INVALID");
  return {
    schema_version: 1,
    knowledge_id: text(record.knowledge_id, "KNOWLEDGE_RESULT_INVALID", 160),
    project_id: text(record.project_id, "KNOWLEDGE_RESULT_INVALID", 160),
    content_kind: "knowledge_entry",
    status: "active",
    content_hash: sha(record.content_hash, "KNOWLEDGE_RESULT_INVALID"),
    display_title: text(record.display_title, "KNOWLEDGE_RESULT_INVALID", 240),
    summary: documentContent(record.summary, "KNOWLEDGE_RESULT_INVALID"),
    reusability_scope: text(record.reusability_scope, "KNOWLEDGE_RESULT_INVALID", MAX_TEXT),
    confidence,
    source_archive_ids: canonicalArray(jsonArrayStrings(record.source_archive_ids, "KNOWLEDGE_RESULT_INVALID")),
    source_change_keys: canonicalArray(jsonArrayStrings(record.source_change_keys, "KNOWLEDGE_RESULT_INVALID")),
    source_candidate_ids: canonicalArray(jsonArrayStrings(record.source_candidate_ids, "KNOWLEDGE_RESULT_INVALID")),
    source_refs: canonicalArray(jsonArrayStrings(record.source_refs, "KNOWLEDGE_RESULT_INVALID")),
    extractor_version: text(record.extractor_version, "KNOWLEDGE_RESULT_INVALID"),
    prompt_version: text(record.prompt_version, "KNOWLEDGE_RESULT_INVALID"),
    index_schema_version: text(record.index_schema_version, "KNOWLEDGE_RESULT_INVALID"),
    generation: positiveInteger(record.generation, "KNOWLEDGE_RESULT_INVALID"),
    created_at: timestamp(record.created_at, "KNOWLEDGE_RESULT_INVALID"),
    updated_at: timestamp(record.updated_at, "KNOWLEDGE_RESULT_INVALID")
  };
}

export class PgKnowledgeIndex implements KnowledgeIndex {
  readonly #pool: Pool;

  constructor(pool: Pool) { this.#pool = pool; }

  async query(rawQuery: KnowledgeIndexQuery): Promise<KnowledgeResult[]> {
    return this.#queryWithExecutor(rawQuery, (text, values) => this.#pool.query<Row>(text, values));
  }

  /** Execute inside the caller's transaction so its statement timeout and cancellation fence apply. */
  async queryWithClient(client: PoolClient, rawQuery: KnowledgeIndexQuery): Promise<KnowledgeResult[]> {
    return this.#queryWithExecutor(rawQuery, (text, values) => client.query<Row>(text, values));
  }

  async #queryWithExecutor(
    rawQuery: KnowledgeIndexQuery,
    execute: (text: string, values: unknown[]) => Promise<{ readonly rows: readonly Row[] }>
  ): Promise<KnowledgeResult[]> {
    const query = safeOwnRecord(rawQuery, ["project_id", "content_kind", "status", "query", "limit"], "KNOWLEDGE_QUERY_INVALID");
    const projectId = text(query.project_id, "KNOWLEDGE_QUERY_INVALID", 160);
    if (query.content_kind !== "knowledge_entry" || query.status !== "active" ||
        typeof query.query !== "string" || query.query.trim() === "" || query.query.length > 16_384 ||
        !Number.isSafeInteger(query.limit) || Number(query.limit) < 1 || Number(query.limit) > 100) {
      fail("KNOWLEDGE_QUERY_INVALID");
    }
    const needle = query.query as string;
    return safeStorage(async () => {
      const result = await execute(
        `SELECT project_id, knowledge_id, content_kind, status, content_hash, display_title, summary, entry_type, body, keywords,
                reusability_scope, confidence, source_archive_ids, source_change_keys,
                source_candidate_ids, source_refs, extractor_version, prompt_version,
                index_schema_version, generation, created_at, updated_at
           FROM knowledge_pipeline_results
          WHERE project_id=$1 AND content_kind='knowledge_entry' AND status='active'
            AND (position(lower($2) in lower(display_title)) > 0 OR
                 position(lower($2) in lower(summary)) > 0 OR
                 position(lower($2) in lower(reusability_scope)) > 0 OR
                 EXISTS (SELECT 1 FROM jsonb_array_elements_text(source_refs) ref
                          WHERE position(lower($2) in lower(ref)) > 0))
          ORDER BY updated_at DESC, knowledge_id ASC LIMIT $3`,
        [projectId, needle, Number(query.limit)]
      );
      return result.rows.map((row) => resultFromRow(row));
    }, true);
  }
}

function mergeStrings(left: readonly string[], right: readonly string[]): string[] {
  return canonicalArray([...left, ...right]);
}

function validateCommitInput(raw: CommitKnowledgeResultsInput): {
  job_id: string; generation: number; output_hash: string; results: KnowledgeResult[]; now: string;
} {
  const record = safeOwnRecord(raw, ["job_id", "generation", "output_hash", "results", "now"], "KNOWLEDGE_COMMIT_INVALID");
  const results = safeOwnArray(record.results, "KNOWLEDGE_COMMIT_INVALID").map(validateKnowledgeResult);
  if (results.length > 5) fail("KNOWLEDGE_RESULT_LIMIT_EXCEEDED");
  const seen = new Set<string>();
  for (const result of results) {
    if (seen.has(result.content_hash)) fail("KNOWLEDGE_RESULT_INVALID");
    seen.add(result.content_hash);
  }
  return {
    job_id: text(record.job_id, "KNOWLEDGE_COMMIT_INVALID", 160),
    generation: positiveInteger(record.generation, "KNOWLEDGE_COMMIT_INVALID"),
    output_hash: sha(record.output_hash, "KNOWLEDGE_COMMIT_INVALID"),
    results,
    now: timestamp(record.now, "KNOWLEDGE_COMMIT_INVALID")
  };
}

function knowledgeResultId(projectId: string, contentHash: string): string {
  return `kn_${createHash("sha256").update(`${projectId}\0${contentHash}`, "utf8").digest("hex")}`;
}

function validateKnowledgeResultsForJob(
  results: readonly KnowledgeResult[],
  job: KnowledgeExtractionJob
): void {
  if (results.length > 5) fail("KNOWLEDGE_RESULT_LIMIT_EXCEEDED");
  const allowedCandidateIds = new Set(job.knowledge_candidates.map((candidate) => candidate.candidate_id));
  for (const result of results) {
    if (result.project_id !== job.project_id || result.generation !== job.generation ||
        result.extractor_version !== job.extractor_version || result.prompt_version !== job.prompt_version ||
        result.index_schema_version !== job.index_schema_version ||
        result.knowledge_id !== knowledgeResultId(job.project_id, result.content_hash) ||
        result.source_archive_ids.length !== 1 || result.source_archive_ids[0] !== job.archive_id ||
        result.source_change_keys.length !== 1 || result.source_change_keys[0] !== job.change_key ||
        result.source_candidate_ids.some((candidateId) => !allowedCandidateIds.has(candidateId))) {
      fail("KNOWLEDGE_RESULT_INVALID");
    }
  }
}

async function storedKnowledgeResults(
  client: PoolClient,
  projectId: string,
  generation: number
): Promise<KnowledgeResult[]> {
  const result = await client.query<Row>(
    `SELECT project_id, knowledge_id, content_kind, status, content_hash, display_title, summary, entry_type, body, keywords,
            reusability_scope, confidence, source_archive_ids, source_change_keys,
            source_candidate_ids, source_refs, extractor_version, prompt_version,
            index_schema_version, generation, created_at, updated_at
       FROM knowledge_pipeline_results
      WHERE project_id=$1 AND generation=$2
      ORDER BY content_hash ASC`,
    [projectId, generation]
  );
  return result.rows.map((row) => resultFromRow(row));
}

function sameKnowledgeResultSet(left: readonly KnowledgeResult[], right: readonly KnowledgeResult[]): boolean {
  if (left.length !== right.length) return false;
  const canonical = (results: readonly KnowledgeResult[]) => canonicalJson(
    [...results]
      .sort((a, b) => a.content_hash < b.content_hash ? -1 : a.content_hash > b.content_hash ? 1 : 0)
      .map(({ created_at, updated_at, ...stable }) => {
        void created_at;
        void updated_at;
        return stable;
      })
  );
  return canonical(left) === canonical(right);
}

export class PgKnowledgeCommitPort implements KnowledgeCommitPort {
  readonly #pool: Pool;

  constructor(pool: Pool) { this.#pool = pool; }

  async commitKnowledgeResults(rawInput: CommitKnowledgeResultsInput): Promise<KnowledgeExtractionJob> {
    return safeStorage(async () => {
      const input = validateCommitInput(rawInput);
      return transaction(this.#pool, async (client) => {
        const identityResult = await client.query<Row>(
          "SELECT project_id FROM knowledge_pipeline_knowledge_jobs WHERE job_id=$1",
          [input.job_id]
        );
        if (identityResult.rows[0] === undefined) fail("KNOWLEDGE_JOB_NOT_FOUND");
        const projectId = text(rowValue(identityResult.rows[0], "project_id"), "KNOWLEDGE_JOB_CORRUPT", 160);
        const fence = await lockFence(client, projectId);
        const jobResult = await client.query<Row>(
          "SELECT * FROM knowledge_pipeline_knowledge_jobs WHERE job_id=$1 FOR UPDATE",
          [input.job_id]
        );
        if (jobResult.rows[0] === undefined) fail("KNOWLEDGE_JOB_NOT_FOUND");
        const job = knowledgeJobFromRow(jobResult.rows[0]);
        if (job.generation !== input.generation) fail("KNOWLEDGE_JOB_GENERATION_STALE");
        if (job.generation !== fence.knowledge) fail("KNOWLEDGE_PROJECT_GENERATION_STALE");
        validateKnowledgeResultsForJob(input.results, job);
        if (job.status === "ready") {
          if (job.output_hash !== input.output_hash || job.result_count !== input.results.length) {
            fail("KNOWLEDGE_COMPLETE_CONFLICT");
          }
          const stored = await storedKnowledgeResults(client, job.project_id, job.generation);
          validateKnowledgeResultsForJob(stored, job);
          if (job.result_count !== stored.length || !sameKnowledgeResultSet(stored, input.results)) {
            fail("KNOWLEDGE_READY_STATE_INVALID");
          }
          return job;
        }
        if (job.status !== "extracting") fail("KNOWLEDGE_COMPLETE_STATE_INVALID");
        for (const result of input.results) {
          await this.#upsertResult(client, result);
        }
        const updated = await client.query<Row>(
          `UPDATE knowledge_pipeline_knowledge_jobs
              SET status='ready', output_hash=$2, result_count=$3, retryable=false,
                  reason_code=NULL, updated_at=$4
            WHERE job_id=$1 AND status='extracting' AND generation=$5
            RETURNING *`,
          [input.job_id, input.output_hash, input.results.length, input.now, input.generation]
        );
        if (updated.rows[0] === undefined) fail("KNOWLEDGE_COMPLETE_STATE_INVALID");
        return knowledgeJobFromRow(updated.rows[0]);
      });
    });
  }

  async #upsertResult(client: PoolClient, incoming: KnowledgeResult): Promise<void> {
    const existingResult = await client.query<Row>(
      `SELECT project_id, knowledge_id, content_kind, status, content_hash, display_title, summary, entry_type, body, keywords,
              reusability_scope, confidence, source_archive_ids, source_change_keys,
              source_candidate_ids, source_refs, extractor_version, prompt_version,
              index_schema_version, generation, created_at, updated_at
         FROM knowledge_pipeline_results
        WHERE project_id=$1 AND content_hash=$2 FOR UPDATE`,
      [incoming.project_id, incoming.content_hash]
    );
    const existingRow = existingResult.rows[0];
    if (existingRow === undefined) {
      await client.query(
        `INSERT INTO knowledge_pipeline_results(
           project_id, knowledge_id, content_kind, status, content_hash, display_title, summary,
           reusability_scope, confidence, source_archive_ids, source_change_keys,
           source_candidate_ids, source_refs, extractor_version, prompt_version,
           index_schema_version, generation, created_at, updated_at,
           entry_type, body, keywords
         ) VALUES ($1,$2,'knowledge_entry','active',$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb)`,
        [incoming.project_id, incoming.knowledge_id, incoming.content_hash, incoming.display_title,
          incoming.summary, incoming.reusability_scope, incoming.confidence,
          JSON.stringify(incoming.source_archive_ids), JSON.stringify(incoming.source_change_keys),
          JSON.stringify(incoming.source_candidate_ids), JSON.stringify(incoming.source_refs),
           incoming.extractor_version, incoming.prompt_version, incoming.index_schema_version,
           incoming.generation, incoming.created_at, incoming.updated_at,
           incoming.entry_type ?? null, incoming.body ?? null,
           incoming.keywords === undefined ? null : JSON.stringify(incoming.keywords)]
      );
      return;
    }
    const existing = resultFromRow(existingRow);
    if (existing.knowledge_id !== incoming.knowledge_id) fail("KNOWLEDGE_RESULT_IDENTITY_CONFLICT");
    const current = incoming.generation >= existing.generation ? incoming : existing;
    const createdAt = existing.created_at < incoming.created_at ? existing.created_at : incoming.created_at;
    const updatedAt = incoming.generation >= existing.generation ? incoming.updated_at : existing.updated_at;
    await client.query(
      `UPDATE knowledge_pipeline_results
          SET display_title=$3, summary=$4, reusability_scope=$5, confidence=$6,
              source_archive_ids=$7::jsonb, source_change_keys=$8::jsonb,
              source_candidate_ids=$9::jsonb, source_refs=$10::jsonb,
              extractor_version=$11, prompt_version=$12, index_schema_version=$13,
              generation=$14, created_at=$15, updated_at=$16,
              entry_type=$17, body=$18, keywords=$19::jsonb
        WHERE project_id=$1 AND content_hash=$2`,
      [incoming.project_id, incoming.content_hash, current.display_title, current.summary,
        current.reusability_scope, current.confidence, JSON.stringify(mergeStrings(existing.source_archive_ids, incoming.source_archive_ids)),
        JSON.stringify(mergeStrings(existing.source_change_keys, incoming.source_change_keys)),
        JSON.stringify(mergeStrings(existing.source_candidate_ids, incoming.source_candidate_ids)),
        JSON.stringify(mergeStrings(existing.source_refs, incoming.source_refs)), current.extractor_version,
        current.prompt_version, current.index_schema_version, current.generation, createdAt, updatedAt,
        current.entry_type ?? null, current.body ?? null,
        current.keywords === undefined ? null : JSON.stringify(current.keywords)]
    );
  }
}

function validateChangeDocument(value: unknown, job: ChangeProjectionJob): ChangeDocument {
  const record = safeOwnRecord(value, [
    "schema_version", "document_id", "document_version", "project_id", "change_key", "archive_id",
    "package_sha256", "project_version", "document_type", "source_path", "content_hash", "content",
    "generation", "created_at", "updated_at"
  ], "CHANGE_DOCUMENT_INVALID");
  if (record.schema_version !== 1 || record.document_type !== "design" && record.document_type !== "plan" &&
      record.document_type !== "test_scenarios" && record.document_type !== "change_summary") fail("CHANGE_DOCUMENT_INVALID");
  const sourcePath = text(record.source_path, "CHANGE_DOCUMENT_INVALID", 240);
  if (sourcePath !== sourcePath.normalize("NFC") ||
      "reason_code" in classifyContentPath({ schema_version: 1, path: sourcePath, source_kind: "branch_file" })) fail("CHANGE_DOCUMENT_INVALID");
  const documentType = record.document_type as ChangeDocument["document_type"];
  if ((documentType === "design" && !/^spec\/(?:[^/]+\/)*[^/]+\.md$/u.test(sourcePath)) ||
      (documentType === "plan" && (!/^plans\/(?:[^/]+\/)*[^/]+\.md$/u.test(sourcePath) || /-test-scenarios\.md$/u.test(sourcePath))) ||
      (documentType === "test_scenarios" && sourcePath !== `plans/${job.change_key}-test-scenarios.md`) ||
      (documentType === "change_summary" && !changeSummaryPaths.has(sourcePath))) fail("CHANGE_DOCUMENT_INVALID");
  const content = documentContent(record.content, "CHANGE_DOCUMENT_INVALID");
  const contentHash = sha(record.content_hash, "CHANGE_DOCUMENT_INVALID");
  if (digest(new TextEncoder().encode(content)) !== contentHash) fail("CHANGE_DOCUMENT_INVALID");
  const result: ChangeDocument = {
    schema_version: 1,
    document_id: text(record.document_id, "CHANGE_DOCUMENT_INVALID", 160),
    document_version: text(record.document_version, "CHANGE_DOCUMENT_INVALID", 160),
    project_id: text(record.project_id, "CHANGE_DOCUMENT_INVALID", 160),
    change_key: text(record.change_key, "CHANGE_DOCUMENT_INVALID", 160),
    archive_id: text(record.archive_id, "CHANGE_DOCUMENT_INVALID", 160),
    package_sha256: sha(record.package_sha256, "CHANGE_DOCUMENT_INVALID"),
    project_version: text(record.project_version, "CHANGE_DOCUMENT_INVALID", 160),
    document_type: documentType,
    source_path: sourcePath,
    content_hash: contentHash,
    content,
    generation: positiveInteger(record.generation, "CHANGE_DOCUMENT_INVALID"),
    created_at: timestamp(record.created_at, "CHANGE_DOCUMENT_INVALID"),
    updated_at: timestamp(record.updated_at, "CHANGE_DOCUMENT_INVALID")
  };
  if (result.created_at > result.updated_at || result.document_id !== changeDocumentIdentity({
    project_id: result.project_id, change_key: result.change_key, document_type: result.document_type, source_path: result.source_path
  }) || result.document_version !== changeDocumentVersion(result.content_hash)) fail("CHANGE_DOCUMENT_INVALID");
  if (result.project_id !== job.project_id || result.change_key !== job.change_key || result.archive_id !== job.archive_id ||
      result.package_sha256 !== job.package_sha256 || result.project_version !== job.project_version ||
      result.generation !== job.project_generation) fail("CHANGE_DOCUMENT_INVALID");
  return result;
}

function validateChangeCommitInput(raw: CommitChangeProjectionInput): {
  job_id: string; generation: number; owner_id: string; lease_token: string; output_hash: string; documents: ChangeDocument[]; now: string;
} {
  const record = safeOwnRecord(raw, ["job_id", "generation", "owner_id", "lease_token", "output_hash", "documents", "now"], "CHANGE_PROJECTION_COMMIT_INVALID");
  return {
    job_id: text(record.job_id, "CHANGE_PROJECTION_COMMIT_INVALID", 160),
    generation: positiveInteger(record.generation, "CHANGE_PROJECTION_COMMIT_INVALID"),
    owner_id: text(record.owner_id, "CHANGE_PROJECTION_COMMIT_INVALID"),
    lease_token: text(record.lease_token, "CHANGE_PROJECTION_COMMIT_INVALID"),
    output_hash: sha(record.output_hash, "CHANGE_PROJECTION_COMMIT_INVALID"),
    documents: safeOwnArray(record.documents, "CHANGE_PROJECTION_COMMIT_INVALID") as ChangeDocument[],
    now: timestamp(record.now, "CHANGE_PROJECTION_COMMIT_INVALID")
  };
}

function validateChangeDocuments(
  values: readonly unknown[],
  job: ChangeProjectionJob
): ChangeDocument[] {
  const documents = values.map((value) => validateChangeDocument(value, job));
  const ids = new Set<string>();
  const paths = new Set<string>();
  let previous = "";
  for (const document of documents) {
    const foldedPath = document.source_path.normalize("NFC").toLocaleLowerCase("en-US");
    if (ids.has(document.document_id) || paths.has(foldedPath) ||
        (previous !== "" && previous >= document.document_id)) {
      fail("CHANGE_DOCUMENT_INVALID");
    }
    ids.add(document.document_id);
    paths.add(foldedPath);
    previous = document.document_id;
  }
  return documents;
}

async function storedChangeDocuments(
  client: PoolClient,
  job: ChangeProjectionJob
): Promise<ChangeDocument[]> {
  const result = await client.query<Row>(
    `SELECT project_id, document_id, document_version, change_key, archive_id, package_sha256,
            project_version, document_type, source_path, content_hash, content, generation,
            created_at, updated_at
       FROM knowledge_pipeline_change_documents
      WHERE project_id=$1 AND change_key=$2 AND generation=$3
      ORDER BY document_id ASC`,
    [job.project_id, job.change_key, job.project_generation]
  );
  return result.rows.map((row) => validateChangeDocument({
    schema_version: 1,
    document_id: rowValue(row, "document_id"),
    document_version: rowValue(row, "document_version"),
    project_id: rowValue(row, "project_id"),
    change_key: rowValue(row, "change_key"),
    archive_id: rowValue(row, "archive_id"),
    package_sha256: rowValue(row, "package_sha256"),
    project_version: rowValue(row, "project_version"),
    document_type: rowValue(row, "document_type"),
    source_path: rowValue(row, "source_path"),
    content_hash: rowValue(row, "content_hash"),
    content: rowValue(row, "content"),
    generation: rowValue(row, "generation"),
    created_at: rowValue(row, "created_at"),
    updated_at: rowValue(row, "updated_at")
  }, job));
}

function sameChangeDocumentSet(left: readonly ChangeDocument[], right: readonly ChangeDocument[]): boolean {
  if (left.length !== right.length) return false;
  const canonical = (documents: readonly ChangeDocument[]) => canonicalJson(
    [...documents].sort((a, b) => a.document_id < b.document_id ? -1 : a.document_id > b.document_id ? 1 : 0)
  );
  return canonical(left) === canonical(right);
}

export class PgChangeProjectionCommitPort implements ChangeProjectionCommitPort {
  readonly #pool: Pool;

  constructor(pool: Pool) { this.#pool = pool; }

  async commitChangeProjection(rawInput: CommitChangeProjectionInput): Promise<ChangeProjectionJob> {
    return safeStorage(async () => {
      const input = validateChangeCommitInput(rawInput);
      return transaction(this.#pool, async (client) => {
        const identityResult = await client.query<Row>(
          "SELECT project_id FROM knowledge_pipeline_change_jobs WHERE job_id=$1",
          [input.job_id]
        );
        if (identityResult.rows[0] === undefined) fail("CHANGE_PROJECTION_JOB_NOT_FOUND");
        const projectId = text(rowValue(identityResult.rows[0], "project_id"), "CHANGE_PROJECTION_JOB_CORRUPT", 160);
        const fence = await lockFence(client, projectId);
        const jobResult = await client.query<Row>(
          "SELECT * FROM knowledge_pipeline_change_jobs WHERE job_id=$1 FOR UPDATE",
          [input.job_id]
        );
        if (jobResult.rows[0] === undefined) fail("CHANGE_PROJECTION_JOB_NOT_FOUND");
        const job = changeJobFromRow(jobResult.rows[0]);
        if (job.generation !== input.generation) fail("CHANGE_PROJECTION_JOB_GENERATION_STALE");
        if (job.project_generation !== fence.change) fail("CHANGE_PROJECTION_PROJECT_GENERATION_STALE");
        const documents = validateChangeDocuments(input.documents, job);
        if (job.status === "ready") {
          if (job.output_hash !== input.output_hash || job.document_count !== documents.length) {
            fail("CHANGE_PROJECTION_COMPLETE_CONFLICT");
          }
          const stored = await storedChangeDocuments(client, job);
          if (job.document_count !== stored.length || job.output_hash !== changeProjectionOutputHash(stored) ||
              !sameChangeDocumentSet(stored, documents)) {
            fail("CHANGE_PROJECTION_READY_STATE_INVALID");
          }
          return job;
        }
        if (job.status !== "projecting" || job.owner_id !== input.owner_id || job.lease_token !== input.lease_token) fail("CHANGE_PROJECTION_LEASE_STALE");
        if (job.lease_expires_at === undefined || input.now >= job.lease_expires_at) fail("CHANGE_PROJECTION_LEASE_EXPIRED");
        if (input.output_hash !== changeProjectionOutputHash(documents)) fail("CHANGE_PROJECTION_OUTPUT_INVALID");
        await client.query(
          `DELETE FROM knowledge_pipeline_change_documents WHERE project_id=$1 AND change_key=$2`,
          [job.project_id, job.change_key]
        );
        for (const document of documents) {
          await client.query(
            `INSERT INTO knowledge_pipeline_change_documents(
               project_id, document_id, document_version, change_key, archive_id, package_sha256,
               project_version, document_type, source_path, content_hash, content, generation,
               created_at, updated_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [document.project_id, document.document_id, document.document_version, document.change_key,
              document.archive_id, document.package_sha256, document.project_version, document.document_type,
              document.source_path, document.content_hash, document.content, document.generation,
              document.created_at, document.updated_at]
          );
        }
        const updated = await client.query<Row>(
          `UPDATE knowledge_pipeline_change_jobs
              SET status='ready', owner_id=NULL, lease_token=NULL, lease_expires_at=NULL,
                  output_hash=$2, document_count=$3, retryable=false, reason_code=NULL, updated_at=$4
            WHERE job_id=$1 AND status='projecting' AND generation=$5
            RETURNING *`,
          [input.job_id, input.output_hash, documents.length, input.now, input.generation]
        );
        if (updated.rows[0] === undefined) fail("CHANGE_PROJECTION_COMPLETE_STATE_INVALID");
        return changeJobFromRow(updated.rows[0]);
      });
    });
  }
}

export interface PgKnowledgePipelinePorts {
  archive_store: PgArchiveStore;
  job_repository: PgJobRepository;
  knowledge_index: PgKnowledgeIndex;
  knowledge_commit: PgKnowledgeCommitPort;
  change_projection_commit: PgChangeProjectionCommitPort;
}

export function createPgKnowledgePipelinePorts(pool: Pool, options: PgJobRepositoryOptions = {}): PgKnowledgePipelinePorts {
  const jobRepository = new PgJobRepository(pool, options);
  return {
    archive_store: new PgArchiveStore(pool),
    job_repository: jobRepository,
    knowledge_index: new PgKnowledgeIndex(pool),
    knowledge_commit: new PgKnowledgeCommitPort(pool),
    change_projection_commit: new PgChangeProjectionCommitPort(pool)
  };
}
