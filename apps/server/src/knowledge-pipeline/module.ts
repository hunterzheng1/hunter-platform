import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { types as nodeTypes } from "node:util";

import { archiveIngestReceiptSchema } from "@hunter-harness/contracts";
import { z } from "zod";

import { KnowledgePipelineError } from "./errors.js";
import { archiveUploadIdempotencyKey } from "./identity.js";
import { changeProjectionInputHash } from "./change-projection.js";
import { knowledgeCandidatesForArchive } from "./extractor.js";
import type {
  ArchiveStore,
  ArchiveValidationEvidencePort,
  JobRepository,
  KnowledgeCommitPort,
  KnowledgeIndex,
  PlanArchiveTasksResult
} from "./ports.js";
import type {
  AcceptArchiveInput,
  ArchiveIngestReceipt,
  CompleteKnowledgeExtractionInput,
  EnqueueKnowledgeExtractionInput,
  FailKnowledgeExtractionInput,
  JobReceipt,
  KnowledgeExtractionJob,
  KnowledgePipelineStats,
  KnowledgeResult,
  KnowledgeResultDraft,
  KnowledgePipeline,
  ListRuleCandidatesInput,
  QueryKnowledgeInput,
  RetryArchiveTaskPlanningInput,
  StoredArchive,
  ValidatedArchivePackage
} from "./types.js";

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const reasonCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u);

const resultDraftSchema = z.object({
  source_candidate_id: z.string().min(1),
  content_hash: sha256Schema,
  display_title: z.string().trim().min(1).max(240),
  summary: z.string().trim().min(1),
  reusability_scope: z.string().trim().min(1),
  source_refs: z.array(z.string().min(1)),
  confidence: z.number().min(0).max(1),
  // 入库投影所需字段，随候选一路透传；老归档不带时保持 undefined。
  entry_type: z.enum(["requirement", "decision", "implementation", "risk", "test-evidence", "pitfall", "api-contract"]).optional(),
  body: z.string().min(1).max(20_000).optional(),
  keywords: z.array(z.string().min(1).max(80)).max(32).optional()
}).strict();

function digest(namespace: string, value: string): string {
  return `${namespace}_${createHash("sha256").update(value).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function knowledgeExtractionIdentity(input: {
  package_sha256: string;
  extractor_version: string;
  prompt_version: string;
  index_schema_version: string;
}): string {
  return `sha256:${createHash("sha256").update([
    input.package_sha256,
    input.extractor_version,
    input.prompt_version,
    input.index_schema_version
  ].join("\0")).digest("hex")}`;
}

const archiveRequestIdPattern = /^archive_request:[a-f0-9]{64}$/u;
const projectIdPattern = /^prj_[A-Za-z0-9][A-Za-z0-9._:-]{0,155}$/u;
const archiveIdPattern = /^arc_[A-Za-z0-9][A-Za-z0-9._:-]{0,155}$/u;
const projectVersionPattern = /^pv_[A-Za-z0-9][A-Za-z0-9._:-]{0,155}$/u;
const arrayIndexPattern = /^(?:0|[1-9]\d*)$/u;

function inputInvalid(): never {
  throw new KnowledgePipelineError("ARCHIVE_INPUT_INVALID", false);
}

function snapshotSerialized(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) inputInvalid();
    return value;
  }
  if (typeof value !== "object" || nodeTypes.isProxy(value) || depth > 32) inputInvalid();
  if (value instanceof Uint8Array) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype ||
        Object.getOwnPropertySymbols(value).length > 0) inputInvalid();
    return new Uint8Array(value);
  }
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype) inputInvalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some((key) => typeof key === "symbol")) inputInvalid();
  for (const key of ownKeys as string[]) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined ||
        descriptor.set !== undefined || (key !== "length" && descriptor.enumerable !== true)) inputInvalid();
  }
  if (array) {
    const length = descriptors.length?.value as unknown;
    if (!Number.isSafeInteger(length) || (length as number) < 0 ||
        ownKeys.some((key) => typeof key === "string" && key !== "length" && !arrayIndexPattern.test(key))) {
      inputInvalid();
    }
    const result: unknown[] = [];
    for (let index = 0; index < (length as number); index += 1) {
      const descriptor = descriptors[index.toFixed(0)];
      if (descriptor === undefined || !("value" in descriptor)) inputInvalid();
      result.push(snapshotSerialized(descriptor.value, depth + 1));
    }
    return result;
  }
  const result: Record<string, unknown> = {};
  for (const key of ownKeys as string[]) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) inputInvalid();
    result[key] = snapshotSerialized(descriptor.value, depth + 1);
  }
  return result;
}

function canonicalText(value: unknown, maximum: number, pattern?: RegExp): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    value === value.trim() && value === value.normalize("NFC") &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 32) &&
    (pattern === undefined || pattern.test(value));
}

function canonicalInputHash(input: {
  archive: StoredArchive | ValidatedArchivePackage;
  extractor_version: string;
  prompt_version: string;
  index_schema_version: string;
}): string {
  return `sha256:${createHash("sha256").update(stableJson({
    project_id: input.archive.project_id,
    archive_id: input.archive.archive_id,
    change_key: input.archive.change_key,
    project_version: input.archive.project_version,
    package_sha256: input.archive.package_sha256,
    manifest_sha256: input.archive.manifest_sha256,
    extractor_version: input.extractor_version,
    prompt_version: input.prompt_version,
    index_schema_version: input.index_schema_version,
    knowledge_candidates: input.archive.knowledge_candidates
  })).digest("hex")}`;
}

function projectionIdentityInput(archive: StoredArchive | ValidatedArchivePackage) {
  return {
    schema_version: archive.schema_version,
    project_id: archive.project_id,
    change_key: archive.change_key,
    archive_id: archive.archive_id,
    package_sha256: archive.package_sha256,
    manifest_sha256: archive.manifest_sha256,
    project_version: archive.project_version,
    package_schema_version: archive.package_schema_version,
    archive_schema_version: archive.archive_schema_version
  };
}

function jobReceipt(job: KnowledgeExtractionJob): JobReceipt {
  return {
    schema_version: job.schema_version,
    job_id: job.job_id,
    idempotency_key: job.idempotency_key,
    project_id: job.project_id,
    change_key: job.change_key,
    archive_id: job.archive_id,
    package_sha256: job.package_sha256,
    extractor_version: job.extractor_version,
    prompt_version: job.prompt_version,
    index_schema_version: job.index_schema_version,
    status: job.status,
    attempt: job.attempt,
    generation: job.generation,
    input_hash: job.input_hash,
    ...(job.output_hash === undefined ? {} : { output_hash: job.output_hash }),
    ...(job.result_count === undefined ? {} : { result_count: job.result_count }),
    retryable: job.retryable,
    ...(job.reason_code === undefined ? {} : { reason_code: job.reason_code }),
    created_at: job.created_at,
    updated_at: job.updated_at
  };
}

function plannedStatus(job: KnowledgeExtractionJob) {
  return {
    status: job.status,
    updated_at: job.updated_at,
    retryable: job.retryable,
    ...(job.reason_code === undefined ? {} : { reason_code: job.reason_code })
  };
}

function changeProjectionStatus(job: PlanArchiveTasksResult["change_projection_job"]) {
  return {
    status: job.status === "projecting" ? "indexing" as const : job.status,
    updated_at: job.updated_at,
    retryable: job.retryable,
    ...(job.reason_code === undefined ? {} : { reason_code: job.reason_code })
  };
}

function validateArchiveInput(
  rawInput: AcceptArchiveInput,
  archiveValidation: ArchiveValidationEvidencePort
): AcceptArchiveInput {
  const originalPackage = rawInput !== null && typeof rawInput === "object" &&
    !nodeTypes.isProxy(rawInput)
    ? Object.getOwnPropertyDescriptor(rawInput, "validated_package")?.value as unknown
    : undefined;
  const input = snapshotSerialized(rawInput) as AcceptArchiveInput;
  const exactKeys = [
    "schema_version",
    "request_id",
    "validated_package",
    "extractor_version",
    "prompt_version",
    "index_schema_version"
  ];
  if (Object.keys(input).length !== exactKeys.length || exactKeys.some((key) => !Object.hasOwn(input, key)) ||
      input.schema_version !== 1 || !canonicalText(input.request_id, 80, archiveRequestIdPattern) ||
      !canonicalText(input.extractor_version, 128) || !canonicalText(input.prompt_version, 128) ||
      !canonicalText(input.index_schema_version, 128)) inputInvalid();
  const validatedPackage = input.validated_package;
  const packageKeys = [
    "schema_version", "project_id", "change_key", "archive_id", "package_sha256",
    "manifest_sha256", "project_version", "package_schema_version", "archive_schema_version",
    "package_bytes", "manifest_bytes", "knowledge_candidates", "project_content_candidates",
    "validation_receipt"
  ];
  if (validatedPackage === null || typeof validatedPackage !== "object" ||
      Object.keys(validatedPackage).length !== packageKeys.length ||
      packageKeys.some((key) => !Object.hasOwn(validatedPackage, key)) ||
      validatedPackage.schema_version !== 1 ||
      !canonicalText(validatedPackage.project_id, 160, projectIdPattern) ||
      !canonicalText(validatedPackage.change_key, 160) ||
      !canonicalText(validatedPackage.archive_id, 160, archiveIdPattern) ||
      !canonicalText(validatedPackage.package_sha256, 71, /^sha256:[a-f0-9]{64}$/u) ||
      !canonicalText(validatedPackage.manifest_sha256, 71, /^sha256:[a-f0-9]{64}$/u) ||
      !canonicalText(validatedPackage.project_version, 160, projectVersionPattern) ||
      !Number.isSafeInteger(validatedPackage.package_schema_version) || validatedPackage.package_schema_version < 1 ||
      !Number.isSafeInteger(validatedPackage.archive_schema_version) || validatedPackage.archive_schema_version < 1) {
    inputInvalid();
  }
  if (!archiveValidation.isValidatedPackage(originalPackage)) {
    throw new KnowledgePipelineError("ARCHIVE_VALIDATION_REQUIRED", false);
  }
  const receipt = validatedPackage.validation_receipt;
  const receiptKeys = [
    "schema_version", "package_sha256", "manifest_sha256", "package_schema_version",
    "archive_schema_version", "safe_paths", "no_symlinks", "no_encrypted_entries",
    "declared_files_verified", "content_hashes_verified", "candidate_sources_bound",
    "file_count", "compressed_bytes", "uncompressed_bytes", "validated_at"
  ];
  if (Object.keys(receipt).length !== receiptKeys.length ||
      receiptKeys.some((key) => !Object.hasOwn(receipt, key)) ||
      receipt.schema_version !== 1 || receipt.safe_paths !== true ||
      receipt.no_symlinks !== true || receipt.no_encrypted_entries !== true ||
      receipt.declared_files_verified !== true ||
      receipt.content_hashes_verified !== true ||
      receipt.candidate_sources_bound !== true ||
      receipt.package_schema_version !== validatedPackage.package_schema_version ||
      receipt.archive_schema_version !== validatedPackage.archive_schema_version ||
      !Number.isInteger(receipt.file_count) || receipt.file_count < 0 ||
      !Number.isInteger(receipt.compressed_bytes) || receipt.compressed_bytes < 1 ||
      !Number.isInteger(receipt.uncompressed_bytes) || receipt.uncompressed_bytes < 0) {
    throw new KnowledgePipelineError("ARCHIVE_VALIDATION_EVIDENCE_INVALID", false);
  }
  const actualPackageHash = `sha256:${createHash("sha256")
    .update(validatedPackage.package_bytes)
    .digest("hex")}`;
  const actualManifestHash = `sha256:${createHash("sha256")
    .update(validatedPackage.manifest_bytes)
    .digest("hex")}`;
  if (actualPackageHash !== validatedPackage.package_sha256 ||
      actualManifestHash !== validatedPackage.manifest_sha256 ||
      actualPackageHash !== receipt.package_sha256 ||
      actualManifestHash !== receipt.manifest_sha256) {
    throw new KnowledgePipelineError("ARCHIVE_HASH_MISMATCH", false);
  }
  return input;
}

function storedArchive(input: AcceptArchiveInput, stored_at: string): StoredArchive {
  const validatedPackage = input.validated_package;
  const archive: StoredArchive = {
    schema_version: 1,
    project_id: validatedPackage.project_id,
    change_key: validatedPackage.change_key,
    archive_id: validatedPackage.archive_id,
    package_sha256: validatedPackage.package_sha256,
    manifest_sha256: validatedPackage.manifest_sha256,
    project_version: validatedPackage.project_version,
    package_schema_version: validatedPackage.package_schema_version,
    archive_schema_version: validatedPackage.archive_schema_version,
    package_bytes: validatedPackage.package_bytes.slice(),
    manifest_bytes: validatedPackage.manifest_bytes.slice(),
    knowledge_candidates: structuredClone(validatedPackage.knowledge_candidates),
    project_content_candidates: structuredClone(
      validatedPackage.project_content_candidates
    ),
    validation_receipt: structuredClone(validatedPackage.validation_receipt),
    stored_at
  };
  return {
    ...archive,
    knowledge_candidates: structuredClone([...knowledgeCandidatesForArchive(archive)])
  };
}

function failedPlanningReceipt(
  request_id: string,
  archive: StoredArchive,
  idempotency_key: string,
  reason_code: string,
  now: string
): ArchiveIngestReceipt {
  return archiveIngestReceiptSchema.parse({
    schema_version: 1,
    request_id,
    idempotency_key,
    project_id: archive.project_id,
    change_key: archive.change_key,
    archive_id: archive.archive_id,
    package_sha256: archive.package_sha256,
    manifest_sha256: archive.manifest_sha256,
    archive_status: {
      status: "stored",
      updated_at: archive.stored_at,
      retryable: false
    },
    change_index_status: {
      status: "failed",
      updated_at: now,
      retryable: true,
      reason_code
    },
    knowledge_extraction_status: {
      status: "failed",
      updated_at: now,
      retryable: true,
      reason_code
    },
    project_version: archive.project_version,
    stored_at: archive.stored_at,
    retryable: false
  });
}

function queuedPlanningReceipt(
  request_id: string,
  archive: StoredArchive,
  idempotency_key: string,
  planned: PlanArchiveTasksResult
): ArchiveIngestReceipt {
  return archiveIngestReceiptSchema.parse({
    schema_version: 1,
    request_id,
    idempotency_key,
    project_id: archive.project_id,
    change_key: archive.change_key,
    archive_id: archive.archive_id,
    package_sha256: archive.package_sha256,
    manifest_sha256: archive.manifest_sha256,
    archive_status: {
      status: "stored",
      updated_at: archive.stored_at,
      retryable: false
    },
    change_index_status: changeProjectionStatus(planned.change_projection_job),
    knowledge_extraction_status: plannedStatus(planned.knowledge_job),
    change_projection_job_id: planned.change_projection_job_id,
    knowledge_extraction_job_id: planned.knowledge_job.job_id,
    ...(planned.project_content_job_id === undefined
      ? {}
      : { project_content_job_id: planned.project_content_job_id }),
    project_version: archive.project_version,
    stored_at: archive.stored_at,
    retryable: false
  });
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new KnowledgePipelineError("PAGINATION_LIMIT_INVALID", false);
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export interface KnowledgePipelineDependencies {
  archive_store: ArchiveStore;
  archive_validation: ArchiveValidationEvidencePort;
  job_repository: JobRepository;
  knowledge_index: KnowledgeIndex;
  knowledge_commit: KnowledgeCommitPort;
  clock: () => string;
}

export function createKnowledgePipeline(
  dependencies: KnowledgePipelineDependencies
): KnowledgePipeline {
  async function acceptArchive(rawInput: AcceptArchiveInput): Promise<ArchiveIngestReceipt> {
    const input = validateArchiveInput(rawInput, dependencies.archive_validation);
    const now = dependencies.clock();
    const idempotency_key = archiveUploadIdempotencyKey({
      project_id: input.validated_package.project_id,
      change_key: input.validated_package.change_key,
      archive_schema_version: input.validated_package.archive_schema_version,
      package_sha256: input.validated_package.package_sha256
    });
    const knowledge_idempotency_key = knowledgeExtractionIdentity({
      package_sha256: input.validated_package.package_sha256,
      extractor_version: input.extractor_version,
      prompt_version: input.prompt_version,
      index_schema_version: input.index_schema_version
    });
    const stored = await dependencies.archive_store.putIfAbsent(storedArchive(input, now));
    try {
      const planned = await dependencies.job_repository.planArchiveTasks({
        archive: stored.archive,
        idempotency_key: knowledge_idempotency_key,
        extractor_version: input.extractor_version,
        prompt_version: input.prompt_version,
        index_schema_version: input.index_schema_version,
        change_projection_input_hash: changeProjectionInputHash(
          projectionIdentityInput(stored.archive)
        ),
        input_hash: canonicalInputHash({
          archive: stored.archive,
          extractor_version: input.extractor_version,
          prompt_version: input.prompt_version,
          index_schema_version: input.index_schema_version
        }),
        now
      });
      return queuedPlanningReceipt(
        input.request_id,
        stored.archive,
        idempotency_key,
        planned
      );
    } catch (error) {
      if (error instanceof KnowledgePipelineError && !error.retryable) {
        throw error;
      }
      const reason_code = error instanceof KnowledgePipelineError
        ? error.reason_code
        : "KNOWLEDGE_JOB_PLAN_FAILED";
      return failedPlanningReceipt(
        input.request_id,
        stored.archive,
        idempotency_key,
        reason_code,
        now
      );
    }
  }

  async function enqueueKnowledgeExtraction(
    input: EnqueueKnowledgeExtractionInput
  ): Promise<JobReceipt> {
    const archive = await dependencies.archive_store.getByArchiveId(input.archive_id);
    if (archive === null) {
      throw new KnowledgePipelineError("ARCHIVE_NOT_FOUND", false);
    }
    for (const version of [
      input.extractor_version,
      input.prompt_version,
      input.index_schema_version
    ]) {
      if (version.trim() === "") {
        throw new KnowledgePipelineError("KNOWLEDGE_VERSION_INVALID", false);
      }
    }
    const idempotency_key = knowledgeExtractionIdentity({
      package_sha256: archive.package_sha256,
      ...input
    });
    const job = await dependencies.job_repository.enqueueKnowledgeJob({
      archive,
      idempotency_key,
      extractor_version: input.extractor_version,
      prompt_version: input.prompt_version,
      index_schema_version: input.index_schema_version,
      input_hash: canonicalInputHash({ archive, ...input }),
      now: dependencies.clock()
    });
    return jobReceipt(job);
  }

  async function retryArchiveTaskPlanning(
    input: RetryArchiveTaskPlanningInput
  ): Promise<ArchiveIngestReceipt> {
    const archive = await dependencies.archive_store.getByArchiveId(input.archive_id);
    if (archive === null) {
      throw new KnowledgePipelineError("ARCHIVE_NOT_FOUND", false);
    }
    for (const version of [
      input.extractor_version,
      input.prompt_version,
      input.index_schema_version
    ]) {
      if (version.trim() === "") {
        throw new KnowledgePipelineError("KNOWLEDGE_VERSION_INVALID", false);
      }
    }
    const idempotency_key = archiveUploadIdempotencyKey({
      project_id: archive.project_id,
      change_key: archive.change_key,
      archive_schema_version: archive.archive_schema_version,
      package_sha256: archive.package_sha256
    });
    const knowledge_idempotency_key = knowledgeExtractionIdentity({
      package_sha256: archive.package_sha256,
      extractor_version: input.extractor_version,
      prompt_version: input.prompt_version,
      index_schema_version: input.index_schema_version
    });
    const now = dependencies.clock();
    try {
      const planned = await dependencies.job_repository.planArchiveTasks({
        archive,
        idempotency_key: knowledge_idempotency_key,
        extractor_version: input.extractor_version,
        prompt_version: input.prompt_version,
        index_schema_version: input.index_schema_version,
        change_projection_input_hash: changeProjectionInputHash(projectionIdentityInput(archive)),
        input_hash: canonicalInputHash({ archive, ...input }),
        now
      });
      return queuedPlanningReceipt(input.request_id, archive, idempotency_key, planned);
    } catch (error) {
      if (error instanceof KnowledgePipelineError && !error.retryable) throw error;
      const reason_code = error instanceof KnowledgePipelineError
        ? error.reason_code
        : "KNOWLEDGE_JOB_PLAN_FAILED";
      return failedPlanningReceipt(
        input.request_id,
        archive,
        idempotency_key,
        reason_code,
        now
      );
    }
  }

  async function retryKnowledgeExtraction(job_id: string): Promise<JobReceipt> {
    return jobReceipt(await dependencies.job_repository.retryKnowledgeJob(
      job_id,
      dependencies.clock()
    ));
  }

  async function pipelineStatus(project_id: string): Promise<KnowledgePipelineStats> {
    if (typeof project_id !== "string" || project_id.trim() === "") {
      throw new KnowledgePipelineError("KNOWLEDGE_STATS_INVALID", false);
    }
    return dependencies.job_repository.knowledgePipelineStats(project_id);
  }

  async function queryKnowledge(input: QueryKnowledgeInput): Promise<KnowledgeResult[]> {
    validateLimit(input.limit);
    if (input.project_id === "" || input.query.trim() === "") {
      throw new KnowledgePipelineError("KNOWLEDGE_QUERY_INVALID", false);
    }
    return dependencies.knowledge_index.query({
      project_id: input.project_id,
      content_kind: "knowledge_entry",
      status: "active",
      query: input.query,
      limit: input.limit
    });
  }

  async function listRuleCandidates(input: ListRuleCandidatesInput) {
    validateLimit(input.limit);
    if (input.project_id === "") {
      throw new KnowledgePipelineError("PROJECT_ID_INVALID", false);
    }
    return dependencies.job_repository.listProjectContentCandidates({
      project_id: input.project_id,
      candidate_type: "rule",
      status: "pending",
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      limit: input.limit
    });
  }

  async function startKnowledgeExtraction(job_id: string): Promise<KnowledgeExtractionJob> {
    return dependencies.job_repository.startKnowledgeJob(job_id, dependencies.clock());
  }

  async function completeKnowledgeExtraction(
    input: CompleteKnowledgeExtractionInput
  ): Promise<JobReceipt> {
    const job = await dependencies.job_repository.getKnowledgeJob(input.job_id);
    if (job === null) throw new KnowledgePipelineError("KNOWLEDGE_JOB_NOT_FOUND", false);
    if (job.generation !== input.generation) {
      throw new KnowledgePipelineError("KNOWLEDGE_JOB_GENERATION_STALE", false);
    }
    if (job.status !== "extracting" && job.status !== "ready") {
      throw new KnowledgePipelineError("KNOWLEDGE_COMPLETE_STATE_INVALID", false);
    }
    const parsed = z.array(resultDraftSchema).safeParse(input.results);
    if (!parsed.success) {
      throw new KnowledgePipelineError("KNOWLEDGE_RESULT_INVALID", false);
    }
    const allowedCandidateIds = new Set(
      job.knowledge_candidates.map((candidate) => candidate.candidate_id)
    );
    if (parsed.data.some((result) => !allowedCandidateIds.has(result.source_candidate_id))) {
      throw new KnowledgePipelineError("KNOWLEDGE_SOURCE_CANDIDATE_INVALID", false);
    }

    const grouped = new Map<string, KnowledgeResultDraft[]>();
    for (const result of parsed.data) {
      const existing = grouped.get(result.content_hash) ?? [];
      existing.push({
        source_candidate_id: result.source_candidate_id,
        content_hash: result.content_hash,
        display_title: result.display_title,
        summary: result.summary,
        reusability_scope: result.reusability_scope,
        source_refs: result.source_refs,
        confidence: result.confidence,
        ...(result.entry_type === undefined ? {} : { entry_type: result.entry_type }),
        ...(result.body === undefined ? {} : { body: result.body }),
        ...(result.keywords === undefined ? {} : { keywords: result.keywords })
      });
      grouped.set(result.content_hash, existing);
    }
    if (grouped.size > 5) {
      throw new KnowledgePipelineError("KNOWLEDGE_RESULT_LIMIT_EXCEEDED", false);
    }

    const output_hash = `sha256:${createHash("sha256")
      .update(stableJson({
        job_id: job.job_id,
        generation: input.generation,
        results: parsed.data
      }))
      .digest("hex")}`;
    if (job.status === "ready") {
      if (job.output_hash === output_hash && job.result_count === grouped.size) {
        return jobReceipt(job);
      }
      throw new KnowledgePipelineError("KNOWLEDGE_COMPLETE_CONFLICT", false);
    }

    const now = dependencies.clock();
    const results: KnowledgeResult[] = [...grouped.entries()].map(([content_hash, drafts]) => {
      const first = drafts[0];
      if (first === undefined) {
        throw new KnowledgePipelineError("KNOWLEDGE_RESULT_INVALID", false);
      }
      return {
        schema_version: 1,
        knowledge_id: digest("kn", `${job.project_id}\0${content_hash}`),
        project_id: job.project_id,
        content_kind: "knowledge_entry",
        status: "active",
        content_hash,
        display_title: first.display_title,
        summary: first.summary,
        reusability_scope: first.reusability_scope,
        confidence: Math.max(...drafts.map((draft) => draft.confidence)),
        // 同一 content_hash 的草稿语义等价，取首条即可；缺失就保持缺失。
        ...(first.entry_type === undefined ? {} : { entry_type: first.entry_type }),
        ...(first.body === undefined ? {} : { body: first.body }),
        ...(first.keywords === undefined ? {} : { keywords: [...first.keywords] }),
        source_archive_ids: [job.archive_id],
        source_change_keys: [job.change_key],
        source_candidate_ids: uniqueStrings(drafts.map((draft) => draft.source_candidate_id)),
        source_refs: uniqueStrings(drafts.flatMap((draft) => draft.source_refs)),
        extractor_version: job.extractor_version,
        prompt_version: job.prompt_version,
        index_schema_version: job.index_schema_version,
        generation: job.generation,
        created_at: now,
        updated_at: now
      };
    });
    return jobReceipt(await dependencies.knowledge_commit.commitKnowledgeResults({
      job_id: job.job_id,
      generation: input.generation,
      output_hash,
      results,
      now
    }));
  }

  async function failKnowledgeExtraction(
    input: FailKnowledgeExtractionInput
  ): Promise<JobReceipt> {
    if (!reasonCodeSchema.safeParse(input.reason_code).success) {
      throw new KnowledgePipelineError("KNOWLEDGE_REASON_CODE_INVALID", false);
    }
    return jobReceipt(await dependencies.job_repository.failKnowledgeJob(
      input.job_id,
      input.generation,
      input.reason_code,
      input.retryable,
      dependencies.clock()
    ));
  }

  return {
    acceptArchive,
    retryArchiveTaskPlanning,
    enqueueKnowledgeExtraction,
    retryKnowledgeExtraction,
    queryKnowledge,
    pipelineStatus,
    listRuleCandidates,
    worker: {
      startKnowledgeExtraction,
      completeKnowledgeExtraction,
      failKnowledgeExtraction
    }
  };
}
