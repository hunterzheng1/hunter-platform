import { types as nodeTypes } from "node:util";

import { knowledgeCandidateSchema } from "@hunter-harness/contracts";

import type {
  ChangeProjectionWorker,
  ChangeProjectionWorkerResult
} from "../../change-projection-worker/index.js";
import type {
  CompleteKnowledgeExtractionInput,
  JobReceipt,
  KnowledgeExtractionJob,
  KnowledgePipelineWorker,
  KnowledgeResultDraft
} from "../index.js";

export const WORKER_HOST_SCHEMA_VERSION = 1 as const;

export const workerKindValues = [
  "change_projection",
  "knowledge_extraction",
  "project_content_candidate"
] as const;

export type WorkerKind = typeof workerKindValues[number];

export interface WorkerHostJob {
  schema_version: 1;
  worker_kind: WorkerKind;
  job_id: string;
  owner_id: string;
}

export interface WorkerHostResult {
  schema_version: 1;
  worker_kind: WorkerKind;
  job_id: string;
  status: "ready" | "failed";
  retryable: boolean;
  generation?: number;
  output_hash?: string;
  document_count?: number;
  candidate_count?: number;
  result_count?: number;
  reason_code?: string;
}

export interface WorkerHostBatchInput {
  schema_version: 1;
  jobs: readonly WorkerHostJob[];
}

export interface WorkerHostBatchResult {
  schema_version: 1;
  results: readonly WorkerHostResult[];
}

export interface KnowledgeExtractorInput {
  job: Readonly<KnowledgeExtractionJob>;
}

/**
 * The real extractor is deliberately an injected port. The host never invents
 * knowledge when this dependency is absent or fails.
 */
export interface KnowledgeExtractorPort {
  extract(input: KnowledgeExtractorInput): Promise<readonly KnowledgeResultDraft[]>;
}

/**
 * Project-content governance has no durable producer in this adapter yet. A
 * future producer may be injected without making this host guess candidates.
 */
export interface ProjectContentCandidateWorkerPort {
  run(input: WorkerHostJob): Promise<unknown>;
}

export interface ProjectContentCandidateWorkerResult {
  schema_version: 1;
  job_id: string;
  status: "ready" | "failed";
  retryable: boolean;
  candidate_count?: number;
  reason_code?: string;
}

export interface KnowledgePipelineWorkerHostDependencies {
  change_projection_worker: ChangeProjectionWorker;
  knowledge_pipeline_worker: KnowledgePipelineWorker;
  knowledge_extractor?: KnowledgeExtractorPort;
  project_content_candidate_worker?: ProjectContentCandidateWorkerPort;
  max_concurrency?: number;
  max_batch_size?: number;
  max_result_drafts?: number;
}

export interface KnowledgePipelineWorkerHost {
  run(input: unknown): Promise<WorkerHostResult>;
  dispatch(input: unknown): Promise<WorkerHostBatchResult>;
}

export class WorkerHostError extends Error {
  readonly reason_code: string;
  readonly retryable: boolean;

  constructor(reason_code: string, retryable = false) {
    super(reason_code);
    this.name = "WorkerHostError";
    this.reason_code = reason_code;
    this.retryable = retryable;
  }
}

class SnapshotFailure extends Error {}
class PortInvocationFailure extends Error {
  constructor(
    readonly output_invalid = false,
    readonly safe_failure?: { reason_code: string; retryable: boolean }
  ) {
    super(output_invalid ? "WORKER_HOST_PORT_OUTPUT_INVALID" : "WORKER_HOST_PORT_UNAVAILABLE");
  }
}

const timestampPattern = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u;
const hashPattern = /^sha256:[a-f0-9]{64}$/u;
const defaultMaxConcurrency = 4;
const defaultMaxBatchSize = 64;
const defaultMaxResultDrafts = 64;
const maxSnapshotDepth = 16;
const maxSnapshotNodes = 4096;
const maxSnapshotString = 1_048_576;
const maxCandidates = 256;
const maxSourceRefs = 64;
const maxDocuments = 64;

const changeReasonCodes = new Set([
  "CHANGE_DOCUMENT_STORE_UNAVAILABLE",
  "CHANGE_PROJECTION_ARCHIVE_IDENTITY_MISMATCH",
  "CHANGE_PROJECTION_ARCHIVE_INVALID",
  "CHANGE_PROJECTION_ARCHIVE_NOT_FOUND",
  "CHANGE_PROJECTION_CLOCK_INVALID",
  "CHANGE_PROJECTION_DOCUMENT_CONTENT_INVALID",
  "CHANGE_PROJECTION_DOCUMENT_PATH_INVALID",
  "CHANGE_PROJECTION_JOB_ALREADY_CLAIMED",
  "CHANGE_PROJECTION_JOB_GENERATION_STALE",
  "CHANGE_PROJECTION_JOB_NOT_FOUND",
  "CHANGE_PROJECTION_JOB_STATE_INVALID",
  "CHANGE_PROJECTION_LEASE_EXPIRED",
  "CHANGE_PROJECTION_LEASE_STALE",
  "CHANGE_PROJECTION_LEGACY_READ_ONLY",
  "CHANGE_PROJECTION_PACKAGE_VERIFICATION_FAILED",
  "CHANGE_PROJECTION_PORT_INVALID",
  "CHANGE_PROJECTION_PROJECT_GENERATION_STALE",
  "CHANGE_PROJECTION_VERIFIER_EVIDENCE_INVALID",
  "CHANGE_PROJECTION_WORKER_CONFIGURATION_INVALID",
  "CHANGE_PROJECTION_WORKER_FAILED",
  "CHANGE_PROJECTION_WORKER_INPUT_INVALID"
]);

const knowledgeReasonCodes = new Set([
  "KNOWLEDGE_COMPLETE_CONFLICT",
  "KNOWLEDGE_COMPLETE_STATE_INVALID",
  "KNOWLEDGE_JOB_GENERATION_STALE",
  "KNOWLEDGE_JOB_NOT_FOUND",
  "KNOWLEDGE_COMMIT_RETRY",
  "KNOWLEDGE_MODEL_UNAVAILABLE",
  "KNOWLEDGE_PIPELINE_STORAGE_CORRUPT",
  "KNOWLEDGE_PIPELINE_STORAGE_UNAVAILABLE",
  "KNOWLEDGE_PROJECT_GENERATION_STALE",
  "KNOWLEDGE_RESULT_INVALID",
  "KNOWLEDGE_RESULT_LIMIT_EXCEEDED",
  "KNOWLEDGE_QUALITY_GATE_FAILED",
  "KNOWLEDGE_SOURCE_CANDIDATE_INVALID",
  "KNOWLEDGE_START_STATE_INVALID",
  "KNOWLEDGE_EXTRACTOR_UNAVAILABLE",
  "KNOWLEDGE_WORKER_PORT_INVALID"
]);

const knowledgeReasonRetryability = new Map<string, boolean>([
  ["KNOWLEDGE_COMPLETE_CONFLICT", false],
  ["KNOWLEDGE_COMPLETE_STATE_INVALID", false],
  ["KNOWLEDGE_JOB_GENERATION_STALE", false],
  ["KNOWLEDGE_JOB_NOT_FOUND", false],
  ["KNOWLEDGE_COMMIT_RETRY", true],
  ["KNOWLEDGE_MODEL_UNAVAILABLE", true],
  ["KNOWLEDGE_PIPELINE_STORAGE_CORRUPT", false],
  ["KNOWLEDGE_PIPELINE_STORAGE_UNAVAILABLE", true],
  ["KNOWLEDGE_PROJECT_GENERATION_STALE", false],
  ["KNOWLEDGE_RESULT_INVALID", false],
  ["KNOWLEDGE_RESULT_LIMIT_EXCEEDED", false],
  ["KNOWLEDGE_QUALITY_GATE_FAILED", false],
  ["KNOWLEDGE_SOURCE_CANDIDATE_INVALID", false],
  ["KNOWLEDGE_START_STATE_INVALID", false],
  ["KNOWLEDGE_EXTRACTOR_UNAVAILABLE", true],
  ["KNOWLEDGE_WORKER_PORT_INVALID", true]
]);

const hostReasonCodes = new Set([
  "CHANGE_PROJECTION_WORKER_OUTPUT_INVALID",
  "CHANGE_PROJECTION_WORKER_UNAVAILABLE",
  "KNOWLEDGE_EXTRACTOR_UNAVAILABLE",
  "KNOWLEDGE_RESULT_INVALID",
  "KNOWLEDGE_WORKER_PORT_INVALID",
  "PROJECT_CONTENT_CANDIDATE_UNAVAILABLE",
  "PROJECT_CONTENT_CANDIDATE_OUTPUT_INVALID",
  "WORKER_HOST_JOB_ALREADY_RUNNING",
  "WORKER_HOST_FAILED"
]);

const candidateReasonCodes = new Set([
  "PROJECT_CONTENT_CANDIDATE_UNAVAILABLE",
  "PROJECT_CONTENT_CANDIDATE_OUTPUT_INVALID",
  "PROJECT_CONTENT_CANDIDATE_PORT_INVALID"
]);

type SnapshotState = { seen: Set<object>; nodes: number };

function failInput(reason_code: string): never {
  throw new WorkerHostError(reason_code);
}

function ownRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  reason_code: string
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length > 0) {
    throw new SnapshotFailure(reason_code);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  const keys = Object.keys(descriptors);
  if (required.some((key) => !keys.includes(key)) ||
      keys.some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new SnapshotFailure(reason_code);
  }
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new SnapshotFailure(reason_code);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function snapshot(value: unknown, state: SnapshotState, depth = 0): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > maxSnapshotString || Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })) {
      throw new SnapshotFailure("WORKER_HOST_SNAPSHOT_INVALID");
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new SnapshotFailure("WORKER_HOST_SNAPSHOT_INVALID");
    return value;
  }
  if (typeof value !== "object" || nodeTypes.isProxy(value) || depth > maxSnapshotDepth) {
    throw new SnapshotFailure("WORKER_HOST_SNAPSHOT_INVALID");
  }
  const object = value as object;
  if (state.seen.has(object)) throw new SnapshotFailure("WORKER_HOST_SNAPSHOT_INVALID");
  state.seen.add(object);
  state.nodes += 1;
  if (state.nodes > maxSnapshotNodes || Object.getPrototypeOf(object) !== Object.prototype &&
      Object.getPrototypeOf(object) !== Array.prototype) {
    throw new SnapshotFailure("WORKER_HOST_SNAPSHOT_INVALID");
  }
  const descriptors = Object.getOwnPropertyDescriptors(object) as Record<string, PropertyDescriptor>;
  if (Object.getOwnPropertySymbols(object).length > 0) {
    throw new SnapshotFailure("WORKER_HOST_SNAPSHOT_INVALID");
  }
  const array = Array.isArray(object);
  if (array) {
    const length = descriptors.length?.value;
    if (!Number.isSafeInteger(length) || Number(length) < 0 || Number(length) > maxCandidates ||
        Object.keys(descriptors).some((key) => key !== "length" && !/^(?:0|[1-9]\d*)$/u.test(key))) {
      throw new SnapshotFailure("WORKER_HOST_SNAPSHOT_INVALID");
    }
    const output: unknown[] = [];
    for (let index = 0; index < Number(length); index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
        throw new SnapshotFailure("WORKER_HOST_SNAPSHOT_INVALID");
      }
      output.push(snapshot(descriptor.value, state, depth + 1));
    }
    state.seen.delete(object);
    return output;
  }
  const keys = Object.keys(descriptors);
  if (keys.length > maxSnapshotNodes) throw new SnapshotFailure("WORKER_HOST_SNAPSHOT_INVALID");
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new SnapshotFailure("WORKER_HOST_SNAPSHOT_INVALID");
    }
    output[key] = snapshot(descriptor.value, state, depth + 1);
  }
  state.seen.delete(object);
  return output;
}

function snapshotValue(value: unknown): unknown {
  return snapshot(value, { seen: new Set<object>(), nodes: 0 });
}

function text(value: unknown, max: number, reason_code: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max ||
      value.trim() !== value || Array.from(value).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })) throw new SnapshotFailure(reason_code);
  return value;
}

function timestamp(value: unknown, reason_code: string): string {
  const candidate = text(value, 64, reason_code);
  const parsed = new Date(candidate);
  if (!timestampPattern.test(candidate) || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== candidate) {
    throw new SnapshotFailure(reason_code);
  }
  return candidate;
}

function positiveInteger(value: unknown, reason_code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new SnapshotFailure(reason_code);
  return Number(value);
}

function boundedInteger(value: unknown, maximum: number, reason_code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    throw new SnapshotFailure(reason_code);
  }
  return Number(value);
}

function hash(value: unknown, reason_code: string): string {
  const candidate = text(value, 71, reason_code);
  if (!hashPattern.test(candidate)) throw new SnapshotFailure(reason_code);
  return candidate;
}

function nativePromise(value: unknown): value is Promise<unknown> {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value) ||
      !(value instanceof Promise)) return false;
  try {
    return Object.getPrototypeOf(value) === Promise.prototype;
  } catch {
    return false;
  }
}

function safeFailureFromError(
  value: unknown,
  allowed: ReadonlySet<string>
): { reason_code: string; retryable: boolean } | undefined {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) return undefined;
  let reason: unknown;
  let retryable: unknown;
  try {
    const reasonDescriptor = Object.getOwnPropertyDescriptor(value, "reason_code");
    const retryableDescriptor = Object.getOwnPropertyDescriptor(value, "retryable");
    if (reasonDescriptor === undefined || !("value" in reasonDescriptor) ||
        retryableDescriptor === undefined || !("value" in retryableDescriptor)) return undefined;
    reason = reasonDescriptor.value;
    retryable = retryableDescriptor.value;
  } catch {
    return undefined;
  }
  if (typeof reason !== "string" || !allowed.has(reason)) return undefined;
  return {
    reason_code: reason,
    retryable: typeof retryable === "boolean"
      ? retryable
      : knowledgeReasonRetryability.get(reason) ?? true
  };
}

async function invokeNative(
  method: (...args: never[]) => unknown,
  input: unknown,
  allowedReasons: ReadonlySet<string> = new Set()
): Promise<unknown> {
  let returned: unknown;
  try {
    returned = method(input as never);
  } catch (error) {
    throw new PortInvocationFailure(false, safeFailureFromError(error, allowedReasons));
  }
  if (!nativePromise(returned)) throw new PortInvocationFailure(true);
  try {
    return await returned;
  } catch (error) {
    throw new PortInvocationFailure(false, safeFailureFromError(error, allowedReasons));
  }
}

function portMethod(value: unknown, name: string, reason_code: string): (...args: never[]) => unknown {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new WorkerHostError(reason_code);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "function" ||
      nodeTypes.isProxy(descriptor.value)) throw new WorkerHostError(reason_code);
  return descriptor.value as (...args: never[]) => unknown;
}

function readHostJob(value: unknown): WorkerHostJob {
  let record: Record<string, unknown>;
  try {
    record = ownRecord(value, ["schema_version", "worker_kind", "job_id", "owner_id"], [], "WORKER_HOST_INPUT_INVALID");
  } catch {
    failInput("WORKER_HOST_INPUT_INVALID");
  }
  if (record.schema_version !== 1 || !workerKindValues.includes(record.worker_kind as WorkerKind)) {
    failInput("WORKER_HOST_INPUT_INVALID");
  }
  try {
    return Object.freeze({
      schema_version: 1 as const,
      worker_kind: record.worker_kind as WorkerKind,
      job_id: text(record.job_id, 160, "WORKER_HOST_INPUT_INVALID"),
      owner_id: text(record.owner_id, 160, "WORKER_HOST_INPUT_INVALID")
    });
  } catch {
    failInput("WORKER_HOST_INPUT_INVALID");
  }
}

function readBatch(value: unknown, maxBatchSize: number): WorkerHostJob[] {
  let record: Record<string, unknown>;
  try {
    record = ownRecord(value, ["schema_version", "jobs"], [], "WORKER_HOST_INPUT_INVALID");
  } catch {
    failInput("WORKER_HOST_INPUT_INVALID");
  }
  if (record.schema_version !== 1) failInput("WORKER_HOST_INPUT_INVALID");
  let jobs: unknown;
  try {
    jobs = snapshotValue(record.jobs);
  } catch {
    failInput("WORKER_HOST_INPUT_INVALID");
  }
  if (!Array.isArray(jobs)) failInput("WORKER_HOST_INPUT_INVALID");
  if (jobs.length > maxBatchSize) failInput("WORKER_HOST_BATCH_LIMIT_EXCEEDED");
  const parsed = jobs.map(readHostJob);
  const seen = new Set<string>();
  for (const job of parsed) {
    const key = `${job.worker_kind}\0${job.job_id}`;
    if (seen.has(key)) failInput("WORKER_HOST_DUPLICATE_JOB");
    seen.add(key);
  }
  return parsed;
}

const knowledgeJobRequired = [
  "schema_version", "job_id", "idempotency_key", "project_id", "change_key", "archive_id",
  "package_sha256", "extractor_version", "prompt_version", "index_schema_version", "status",
  "attempt", "generation", "input_hash", "retryable", "knowledge_candidates", "created_at", "updated_at"
] as const;
const knowledgeJobOptional = ["output_hash", "result_count", "reason_code"] as const;
const receiptRequired = knowledgeJobRequired.filter((key) => key !== "knowledge_candidates");

function readKnowledgeRecord(value: unknown, includeCandidates: boolean): KnowledgeExtractionJob | JobReceipt {
  const required = includeCandidates ? knowledgeJobRequired : receiptRequired;
  let record: Record<string, unknown>;
  try {
    record = ownRecord(value, required, knowledgeJobOptional, "KNOWLEDGE_WORKER_PORT_INVALID");
  } catch {
    throw new SnapshotFailure("KNOWLEDGE_WORKER_PORT_INVALID");
  }
  if (record.schema_version !== 1) throw new SnapshotFailure("KNOWLEDGE_WORKER_PORT_INVALID");
  const status = record.status;
  if (status !== "queued" && status !== "extracting" && status !== "ready" && status !== "failed") {
    throw new SnapshotFailure("KNOWLEDGE_WORKER_PORT_INVALID");
  }
  const result: Record<string, unknown> = {
    schema_version: 1,
    job_id: text(record.job_id, 160, "KNOWLEDGE_WORKER_PORT_INVALID"),
    idempotency_key: hash(record.idempotency_key, "KNOWLEDGE_WORKER_PORT_INVALID"),
    project_id: text(record.project_id, 160, "KNOWLEDGE_WORKER_PORT_INVALID"),
    change_key: text(record.change_key, 160, "KNOWLEDGE_WORKER_PORT_INVALID"),
    archive_id: text(record.archive_id, 160, "KNOWLEDGE_WORKER_PORT_INVALID"),
    package_sha256: hash(record.package_sha256, "KNOWLEDGE_WORKER_PORT_INVALID"),
    extractor_version: text(record.extractor_version, 128, "KNOWLEDGE_WORKER_PORT_INVALID"),
    prompt_version: text(record.prompt_version, 128, "KNOWLEDGE_WORKER_PORT_INVALID"),
    index_schema_version: text(record.index_schema_version, 128, "KNOWLEDGE_WORKER_PORT_INVALID"),
    status,
    attempt: positiveInteger(record.attempt, "KNOWLEDGE_WORKER_PORT_INVALID"),
    generation: positiveInteger(record.generation, "KNOWLEDGE_WORKER_PORT_INVALID"),
    input_hash: hash(record.input_hash, "KNOWLEDGE_WORKER_PORT_INVALID"),
    retryable: record.retryable,
    created_at: timestamp(record.created_at, "KNOWLEDGE_WORKER_PORT_INVALID"),
    updated_at: timestamp(record.updated_at, "KNOWLEDGE_WORKER_PORT_INVALID")
  };
  if (typeof record.retryable !== "boolean") throw new SnapshotFailure("KNOWLEDGE_WORKER_PORT_INVALID");
  if (includeCandidates) {
    let candidates: unknown;
    try { candidates = snapshotValue(record.knowledge_candidates); } catch { throw new SnapshotFailure("KNOWLEDGE_WORKER_PORT_INVALID"); }
    if (!Array.isArray(candidates) || candidates.length > maxCandidates) throw new SnapshotFailure("KNOWLEDGE_WORKER_PORT_INVALID");
    const parsedCandidates = knowledgeCandidateSchema.array().max(maxCandidates).safeParse(candidates);
    if (!parsedCandidates.success || parsedCandidates.data.some((candidate) => candidate.source_refs.length > maxSourceRefs)) {
      throw new SnapshotFailure("KNOWLEDGE_WORKER_PORT_INVALID");
    }
    result.knowledge_candidates = parsedCandidates.data;
  }
  const output = record.output_hash;
  const count = record.result_count;
  const reason = record.reason_code;
  if (output !== undefined) result.output_hash = hash(output, "KNOWLEDGE_WORKER_PORT_INVALID");
  if (count !== undefined) result.result_count = boundedInteger(count, 5, "KNOWLEDGE_WORKER_PORT_INVALID");
  if (reason !== undefined) {
    const safe = text(reason, 128, "KNOWLEDGE_WORKER_PORT_INVALID");
    if (!knowledgeReasonCodes.has(safe) && !hostReasonCodes.has(safe)) throw new SnapshotFailure("KNOWLEDGE_WORKER_PORT_INVALID");
    result.reason_code = safe;
  }
  if (status === "queued" || status === "extracting") {
    if (result.output_hash !== undefined || result.result_count !== undefined || result.reason_code !== undefined || record.retryable !== true) {
      throw new SnapshotFailure("KNOWLEDGE_WORKER_PORT_INVALID");
    }
  } else if (status === "ready") {
    if (result.output_hash === undefined || result.result_count === undefined || result.reason_code !== undefined || record.retryable !== false) {
      throw new SnapshotFailure("KNOWLEDGE_WORKER_PORT_INVALID");
    }
  } else if (result.reason_code === undefined || result.output_hash !== undefined || result.result_count !== undefined) {
    throw new SnapshotFailure("KNOWLEDGE_WORKER_PORT_INVALID");
  }
  return result as unknown as KnowledgeExtractionJob | JobReceipt;
}

function readKnowledgeJob(value: unknown): KnowledgeExtractionJob {
  const result = readKnowledgeRecord(value, true);
  if (result.status !== "extracting") throw new SnapshotFailure("KNOWLEDGE_WORKER_PORT_INVALID");
  return result as KnowledgeExtractionJob;
}

const knowledgeImmutableKeys = [
  "job_id", "idempotency_key", "project_id", "change_key", "archive_id", "package_sha256",
  "extractor_version", "prompt_version", "index_schema_version", "input_hash", "attempt", "created_at"
] as const;

function readKnowledgeReceipt(
  value: unknown,
  started: KnowledgeExtractionJob,
  expectedStatus: "ready" | "failed",
  expectedReasonCode?: string,
  expectedRetryable?: boolean
): JobReceipt {
  const result = readKnowledgeRecord(value, false);
  if (result.status !== expectedStatus || result.generation !== started.generation ||
      result.updated_at < started.updated_at ||
      !knowledgeImmutableKeys.every((key) => result[key] === started[key]) ||
      (expectedStatus === "failed" &&
        (result.reason_code !== expectedReasonCode || result.retryable !== expectedRetryable))) {
    throw new SnapshotFailure("KNOWLEDGE_WORKER_PORT_INVALID");
  }
  return result as JobReceipt;
}

function readDrafts(value: unknown, maxResultDrafts: number): KnowledgeResultDraft[] {
  let snapshotResult: unknown;
  try { snapshotResult = snapshotValue(value); } catch { throw new SnapshotFailure("KNOWLEDGE_RESULT_INVALID"); }
  if (!Array.isArray(snapshotResult) || snapshotResult.length > maxResultDrafts) throw new SnapshotFailure("KNOWLEDGE_RESULT_INVALID");
  return snapshotResult.map((raw) => {
    let record: Record<string, unknown>;
    try {
      record = ownRecord(raw, ["source_candidate_id", "content_hash", "display_title", "summary", "reusability_scope", "source_refs", "confidence"], [], "KNOWLEDGE_RESULT_INVALID");
    } catch { throw new SnapshotFailure("KNOWLEDGE_RESULT_INVALID"); }
    let refs: unknown;
    try { refs = snapshotValue(record.source_refs); } catch { throw new SnapshotFailure("KNOWLEDGE_RESULT_INVALID"); }
    if (!Array.isArray(refs) || refs.length > maxSourceRefs || refs.some((ref) => typeof ref !== "string")) {
      throw new SnapshotFailure("KNOWLEDGE_RESULT_INVALID");
    }
    if (typeof record.confidence !== "number" || !Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1) {
      throw new SnapshotFailure("KNOWLEDGE_RESULT_INVALID");
    }
    return {
      source_candidate_id: text(record.source_candidate_id, 160, "KNOWLEDGE_RESULT_INVALID"),
      content_hash: hash(record.content_hash, "KNOWLEDGE_RESULT_INVALID"),
      display_title: text(record.display_title, 240, "KNOWLEDGE_RESULT_INVALID"),
      summary: text(record.summary, 65_536, "KNOWLEDGE_RESULT_INVALID"),
      reusability_scope: text(record.reusability_scope, 512, "KNOWLEDGE_RESULT_INVALID"),
      source_refs: refs.map((ref) => text(ref, 512, "KNOWLEDGE_RESULT_INVALID")),
      confidence: record.confidence
    };
  });
}

function readChangeResult(value: unknown, expectedJobId: string): ChangeProjectionWorkerResult {
  let record: Record<string, unknown>;
  try {
    record = ownRecord(value, ["job_id", "status", "retryable"], ["output_hash", "document_count", "reason_code"], "CHANGE_PROJECTION_WORKER_OUTPUT_INVALID");
  } catch { throw new SnapshotFailure("CHANGE_PROJECTION_WORKER_OUTPUT_INVALID"); }
  if (record.job_id !== expectedJobId || (record.status !== "ready" && record.status !== "failed") || typeof record.retryable !== "boolean") {
    throw new SnapshotFailure("CHANGE_PROJECTION_WORKER_OUTPUT_INVALID");
  }
  const outputHash = record.output_hash === undefined ? undefined : hash(record.output_hash, "CHANGE_PROJECTION_WORKER_OUTPUT_INVALID");
  const count = record.document_count === undefined ? undefined : boundedInteger(record.document_count, maxDocuments, "CHANGE_PROJECTION_WORKER_OUTPUT_INVALID");
  const reason = record.reason_code;
  if (record.status === "ready") {
    if (record.retryable !== false || outputHash === undefined || count === undefined || reason !== undefined) throw new SnapshotFailure("CHANGE_PROJECTION_WORKER_OUTPUT_INVALID");
  } else {
    if (reason === undefined || outputHash !== undefined || count !== undefined) throw new SnapshotFailure("CHANGE_PROJECTION_WORKER_OUTPUT_INVALID");
    const safeReason = text(reason, 128, "CHANGE_PROJECTION_WORKER_OUTPUT_INVALID");
    if (!changeReasonCodes.has(safeReason)) throw new SnapshotFailure("CHANGE_PROJECTION_WORKER_OUTPUT_INVALID");
  }
  return {
    job_id: expectedJobId,
    status: record.status,
    retryable: record.retryable,
    ...(outputHash === undefined ? {} : { output_hash: outputHash }),
    ...(count === undefined ? {} : { document_count: count }),
    ...(reason === undefined ? {} : { reason_code: reason as string })
  };
}

function readCandidateResult(value: unknown, expectedJobId: string): ProjectContentCandidateWorkerResult {
  let record: Record<string, unknown>;
  try {
    record = ownRecord(value, ["schema_version", "job_id", "status", "retryable"], ["candidate_count", "reason_code"], "PROJECT_CONTENT_CANDIDATE_OUTPUT_INVALID");
  } catch {
    throw new SnapshotFailure("PROJECT_CONTENT_CANDIDATE_OUTPUT_INVALID");
  }
  if (record.schema_version !== 1 || record.job_id !== expectedJobId ||
      (record.status !== "ready" && record.status !== "failed") || typeof record.retryable !== "boolean") {
    throw new SnapshotFailure("PROJECT_CONTENT_CANDIDATE_OUTPUT_INVALID");
  }
  const count = record.candidate_count === undefined
    ? undefined
    : boundedInteger(record.candidate_count, maxCandidates, "PROJECT_CONTENT_CANDIDATE_OUTPUT_INVALID");
  const reason = record.reason_code;
  if (record.status === "ready") {
    if (record.retryable !== false || count === undefined || reason !== undefined) {
      throw new SnapshotFailure("PROJECT_CONTENT_CANDIDATE_OUTPUT_INVALID");
    }
    return { schema_version: 1, job_id: expectedJobId, status: "ready", retryable: false, candidate_count: count };
  }
  if (count !== undefined || reason === undefined || record.retryable !== true) {
    throw new SnapshotFailure("PROJECT_CONTENT_CANDIDATE_OUTPUT_INVALID");
  }
  const safeReason = text(reason, 128, "PROJECT_CONTENT_CANDIDATE_OUTPUT_INVALID");
  if (!candidateReasonCodes.has(safeReason)) throw new SnapshotFailure("PROJECT_CONTENT_CANDIDATE_OUTPUT_INVALID");
  return { schema_version: 1, job_id: expectedJobId, status: "failed", retryable: true, reason_code: safeReason };
}

function resultFromChange(job: WorkerHostJob, result: ChangeProjectionWorkerResult): WorkerHostResult {
  return Object.freeze({ schema_version: 1 as const, worker_kind: job.worker_kind, ...result });
}

function failedResult(job: WorkerHostJob, reason_code: string, retryable = true, generation?: number): WorkerHostResult {
  return Object.freeze({
    schema_version: 1 as const,
    worker_kind: job.worker_kind,
    job_id: job.job_id,
    status: "failed" as const,
    retryable,
    ...(generation === undefined ? {} : { generation }),
    reason_code
  });
}

function safePortError(error: unknown, kind: WorkerKind): string {
  if (!(error instanceof SnapshotFailure)) return kind === "change_projection"
    ? "CHANGE_PROJECTION_WORKER_UNAVAILABLE"
    : "KNOWLEDGE_WORKER_PORT_INVALID";
  return error.message;
}

export function createKnowledgePipelineWorkerHost(
  rawDependencies: KnowledgePipelineWorkerHostDependencies
): KnowledgePipelineWorkerHost {
  let dependencies: Record<string, unknown>;
  try {
    dependencies = ownRecord(rawDependencies, ["change_projection_worker", "knowledge_pipeline_worker"], [
      "knowledge_extractor", "project_content_candidate_worker", "max_concurrency", "max_batch_size", "max_result_drafts"
    ], "WORKER_HOST_CONFIGURATION_INVALID");
  } catch {
    throw new WorkerHostError("WORKER_HOST_CONFIGURATION_INVALID");
  }
  const maxConcurrency = dependencies.max_concurrency ?? defaultMaxConcurrency;
  const maxBatchSize = dependencies.max_batch_size ?? defaultMaxBatchSize;
  const maxResultDrafts = dependencies.max_result_drafts ?? defaultMaxResultDrafts;
  for (const value of [maxConcurrency, maxBatchSize, maxResultDrafts]) {
    if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 64) {
      throw new WorkerHostError("WORKER_HOST_CONFIGURATION_INVALID");
    }
  }
  const changeRun = portMethod(dependencies.change_projection_worker, "run", "WORKER_HOST_CONFIGURATION_INVALID");
  const knowledgeStart = portMethod(dependencies.knowledge_pipeline_worker, "startKnowledgeExtraction", "WORKER_HOST_CONFIGURATION_INVALID");
  const knowledgeComplete = portMethod(dependencies.knowledge_pipeline_worker, "completeKnowledgeExtraction", "WORKER_HOST_CONFIGURATION_INVALID");
  const knowledgeFail = portMethod(dependencies.knowledge_pipeline_worker, "failKnowledgeExtraction", "WORKER_HOST_CONFIGURATION_INVALID");
  const extractor = dependencies.knowledge_extractor === undefined
    ? undefined
    : portMethod(dependencies.knowledge_extractor, "extract", "WORKER_HOST_CONFIGURATION_INVALID");
  const candidateRun = dependencies.project_content_candidate_worker === undefined
    ? undefined
    : portMethod(dependencies.project_content_candidate_worker, "run", "WORKER_HOST_CONFIGURATION_INVALID");
  const active = new Set<string>();

  async function runChange(job: WorkerHostJob): Promise<WorkerHostResult> {
    let raw: unknown;
    try {
      raw = await invokeNative(changeRun, { job_id: job.job_id, owner_id: job.owner_id }, changeReasonCodes);
      return resultFromChange(job, readChangeResult(raw, job.job_id));
    } catch (error) {
      if (error instanceof PortInvocationFailure && error.output_invalid) {
        return failedResult(job, "CHANGE_PROJECTION_WORKER_OUTPUT_INVALID", true);
      }
      if (error instanceof SnapshotFailure && error.message === "CHANGE_PROJECTION_WORKER_OUTPUT_INVALID") {
        return failedResult(job, error.message, true);
      }
      if (error instanceof PortInvocationFailure && error.safe_failure !== undefined) {
        return failedResult(job, error.safe_failure.reason_code, error.safe_failure.retryable);
      }
      return failedResult(job, safePortError(error, "change_projection"), true);
    }
  }

  async function runKnowledge(job: WorkerHostJob): Promise<WorkerHostResult> {
    if (extractor === undefined) return failedResult(job, "KNOWLEDGE_EXTRACTOR_UNAVAILABLE", true);
    let started: KnowledgeExtractionJob;
    try {
      started = readKnowledgeJob(await invokeNative(knowledgeStart, job.job_id, knowledgeReasonCodes));
    } catch (error) {
      if (error instanceof PortInvocationFailure && error.safe_failure !== undefined) {
        return failedResult(job, error.safe_failure.reason_code, error.safe_failure.retryable);
      }
      return failedResult(job, "KNOWLEDGE_WORKER_PORT_INVALID", true);
    }
    if (started.job_id !== job.job_id) return failedResult(job, "KNOWLEDGE_WORKER_PORT_INVALID", true);
    const generation = started.generation;
    let drafts: KnowledgeResultDraft[];
    try {
      const extractorInput = Object.freeze({ job: structuredClone(started) });
      drafts = readDrafts(await invokeNative(extractor, extractorInput, knowledgeReasonCodes), Number(maxResultDrafts));
    } catch (error) {
      if (error instanceof PortInvocationFailure && error.output_invalid) {
        return failedResult(job, "KNOWLEDGE_WORKER_PORT_INVALID", true, generation);
      }
      const reasonCode = error instanceof SnapshotFailure && error.message === "KNOWLEDGE_RESULT_INVALID"
        ? "KNOWLEDGE_RESULT_INVALID"
        : error instanceof PortInvocationFailure && error.output_invalid
          ? "KNOWLEDGE_WORKER_PORT_INVALID"
          : "KNOWLEDGE_EXTRACTOR_UNAVAILABLE";
      const safeFailure = error instanceof PortInvocationFailure ? error.safe_failure : undefined;
      const finalReasonCode = safeFailure?.reason_code ?? reasonCode;
      const retryable = safeFailure?.retryable ?? reasonCode === "KNOWLEDGE_EXTRACTOR_UNAVAILABLE";
      try {
        const failureInput: CompleteKnowledgeExtractionInput & { reason_code: string; retryable: boolean } = {
          job_id: started.job_id,
          generation,
          results: [],
          reason_code: finalReasonCode,
          retryable
        };
        const failed = await invokeNative(knowledgeFail, {
          job_id: failureInput.job_id,
          generation: failureInput.generation,
          reason_code: failureInput.reason_code,
          retryable: failureInput.retryable
        }, knowledgeReasonCodes);
        const receipt = readKnowledgeReceipt(failed, started, "failed", finalReasonCode, retryable);
        return failedResult(job, receipt.reason_code as string, receipt.retryable, generation);
      } catch (failureError) {
        if (failureError instanceof PortInvocationFailure && failureError.safe_failure !== undefined) {
          return failedResult(job, failureError.safe_failure.reason_code, failureError.safe_failure.retryable, generation);
        }
        return failedResult(job, "KNOWLEDGE_WORKER_PORT_INVALID", true, generation);
      }
    }
    try {
      const complete = await invokeNative(knowledgeComplete, {
        job_id: started.job_id,
        generation,
        results: drafts
      }, knowledgeReasonCodes);
      const receipt = readKnowledgeReceipt(complete, started, "ready");
      return Object.freeze({
        schema_version: 1 as const,
        worker_kind: job.worker_kind,
        job_id: job.job_id,
        status: "ready" as const,
        retryable: false,
        generation,
        ...(receipt.output_hash === undefined ? {} : { output_hash: receipt.output_hash }),
        ...(receipt.result_count === undefined ? {} : { result_count: receipt.result_count })
      });
    } catch (error) {
      if (error instanceof PortInvocationFailure && error.safe_failure !== undefined) {
        return failedResult(job, error.safe_failure.reason_code, error.safe_failure.retryable, generation);
      }
      return failedResult(job, "KNOWLEDGE_WORKER_PORT_INVALID", true, generation);
    }
  }

  async function runCandidate(job: WorkerHostJob): Promise<WorkerHostResult> {
    if (candidateRun === undefined) return failedResult(job, "PROJECT_CONTENT_CANDIDATE_UNAVAILABLE", true);
    try {
      const raw = await invokeNative(candidateRun, job);
      const result = readCandidateResult(raw, job.job_id);
      return Object.freeze({ ...result, schema_version: 1 as const, worker_kind: job.worker_kind });
    } catch {
      return failedResult(job, "PROJECT_CONTENT_CANDIDATE_OUTPUT_INVALID", true);
    }
  }

  async function run(rawInput: unknown): Promise<WorkerHostResult> {
    const job = readHostJob(rawInput);
    const key = `${job.worker_kind}\0${job.job_id}`;
    if (active.has(key)) return failedResult(job, "WORKER_HOST_JOB_ALREADY_RUNNING", true);
    active.add(key);
    try {
      if (job.worker_kind === "change_projection") return await runChange(job);
      if (job.worker_kind === "knowledge_extraction") return await runKnowledge(job);
      return await runCandidate(job);
    } finally {
      active.delete(key);
    }
  }

  async function dispatch(rawInput: unknown): Promise<WorkerHostBatchResult> {
    const batch = readBatch(rawInput, Number(maxBatchSize));
    const results: WorkerHostResult[] = new Array(batch.length);
    let next = 0;
    const lane = async (): Promise<void> => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= batch.length) return;
        try {
          results[index] = await run(batch[index]);
        } catch {
          const job = batch[index];
          if (job === undefined) return;
          results[index] = failedResult(job, "WORKER_HOST_FAILED", true);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(Number(maxConcurrency), Math.max(batch.length, 1)) }, lane));
    return Object.freeze({ schema_version: 1 as const, results: Object.freeze(results) });
  }

  return Object.freeze({ run, dispatch });
}
