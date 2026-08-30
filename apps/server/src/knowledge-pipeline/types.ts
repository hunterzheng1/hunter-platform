import type {
  ArchiveIngestReceipt,
  KnowledgeCandidate,
  KnowledgeCandidateEntryType,
  ProjectContentCandidate
} from "@hunter-harness/contracts";

export const KNOWLEDGE_PIPELINE_SCHEMA_VERSION = 1 as const;

export type KnowledgeJobStatus = "queued" | "extracting" | "ready" | "failed";
export type ChangeProjectionJobStatus = "queued" | "projecting" | "ready" | "failed";
export type ChangeDocumentType = "design" | "plan" | "test_scenarios" | "change_summary";

export interface ArchivePackageValidationLimits {
  max_package_bytes: number;
  max_file_count: number;
  max_file_bytes: number;
  max_uncompressed_bytes: number;
  max_compression_ratio: number;
}

export interface ArchivePackageValidationReceipt {
  schema_version: 1;
  package_sha256: string;
  manifest_sha256: string;
  package_schema_version: number;
  archive_schema_version: number;
  safe_paths: true;
  no_symlinks: true;
  no_encrypted_entries: true;
  declared_files_verified: true;
  content_hashes_verified: true;
  candidate_sources_bound: true;
  file_count: number;
  compressed_bytes: number;
  uncompressed_bytes: number;
  validated_at: string;
}

export interface ValidatedArchivePackage {
  schema_version: 1;
  project_id: string;
  change_key: string;
  archive_id: string;
  package_sha256: string;
  manifest_sha256: string;
  project_version: string;
  package_schema_version: number;
  archive_schema_version: number;
  package_bytes: Uint8Array;
  manifest_bytes: Uint8Array;
  knowledge_candidates: KnowledgeCandidate[];
  project_content_candidates: ProjectContentCandidate[];
  validation_receipt: ArchivePackageValidationReceipt;
}

export interface ValidateArchivePackageInput {
  package_bytes: Uint8Array;
  manifest_bytes: Uint8Array;
  limits: ArchivePackageValidationLimits;
  validated_at: string;
}

/**
 * Identity for a core-v1 package. The client cannot know server-minted ids at
 * package-build time, so the route supplies them rather than trusting — or
 * forcing the client to invent — manifest fields.
 */
export interface CoreV1ArchiveIdentity {
  project_id: string;
  change_key: string;
  archive_id: string;
  project_version: string;
}

export interface ValidateCoreV1ArchivePackageInput {
  package_bytes: Uint8Array;
  manifest_bytes: Uint8Array;
  identity: CoreV1ArchiveIdentity;
  limits: ArchivePackageValidationLimits;
  validated_at: string;
}

export interface AcceptArchiveInput {
  schema_version: 1;
  request_id: string;
  validated_package: ValidatedArchivePackage;
  extractor_version: string;
  prompt_version: string;
  index_schema_version: string;
}

export interface RetryArchiveTaskPlanningInput {
  request_id: string;
  archive_id: string;
  extractor_version: string;
  prompt_version: string;
  index_schema_version: string;
}

export interface StoredArchive {
  schema_version: 1;
  project_id: string;
  change_key: string;
  archive_id: string;
  package_sha256: string;
  manifest_sha256: string;
  project_version: string;
  package_schema_version: number;
  archive_schema_version: number;
  package_bytes: Uint8Array;
  manifest_bytes: Uint8Array;
  knowledge_candidates: KnowledgeCandidate[];
  project_content_candidates: ProjectContentCandidate[];
  validation_receipt: ArchivePackageValidationReceipt;
  stored_at: string;
}

export type { ArchiveIngestReceipt };

export interface KnowledgeExtractionJob {
  schema_version: 1;
  job_id: string;
  idempotency_key: string;
  project_id: string;
  change_key: string;
  archive_id: string;
  package_sha256: string;
  extractor_version: string;
  prompt_version: string;
  index_schema_version: string;
  status: KnowledgeJobStatus;
  attempt: number;
  generation: number;
  input_hash: string;
  output_hash?: string;
  result_count?: number;
  retryable: boolean;
  reason_code?: string;
  knowledge_candidates: KnowledgeCandidate[];
  created_at: string;
  updated_at: string;
}

/** Durable task identity for the deterministic archive-to-change projection. */
export interface ChangeProjectionJob {
  schema_version: 1;
  job_id: string;
  project_id: string;
  change_key: string;
  archive_id: string;
  package_sha256: string;
  manifest_sha256: string;
  project_version: string;
  package_schema_version: number;
  archive_schema_version: number;
  status: ChangeProjectionJobStatus;
  attempt: number;
  /** Monotonic archive ordering fence for the project; immutable across retries. */
  project_generation: number;
  /** Attempt/lease generation; increments only when this job is retried. */
  generation: number;
  input_hash: string;
  owner_id?: string;
  lease_token?: string;
  lease_expires_at?: string;
  output_hash?: string;
  document_count?: number;
  retryable: boolean;
  reason_code?: string;
  created_at: string;
  updated_at: string;
}

/** A project-scoped change record. This is not reusable project knowledge. */
export interface ChangeDocument {
  schema_version: 1;
  document_id: string;
  document_version: string;
  project_id: string;
  change_key: string;
  archive_id: string;
  package_sha256: string;
  project_version: string;
  document_type: ChangeDocumentType;
  source_path: string;
  content_hash: string;
  content: string;
  generation: number;
  created_at: string;
  updated_at: string;
}

export type JobReceipt = Omit<KnowledgeExtractionJob, "knowledge_candidates">;

export interface KnowledgeResultDraft {
  source_candidate_id: string;
  content_hash: string;
  display_title: string;
  summary: string;
  reusability_scope: string;
  source_refs: string[];
  confidence: number;
  // 入库投影所需、reusability_scope 无法映射的三个字段。可选：老归档不带它们，
  // 桥走降级路径而不是凭空造一个 type。
  entry_type?: KnowledgeCandidateEntryType;
  body?: string;
  keywords?: string[];
}

export interface KnowledgeResult {
  schema_version: 1;
  knowledge_id: string;
  project_id: string;
  content_kind: "knowledge_entry";
  status: "active";
  content_hash: string;
  display_title: string;
  summary: string;
  reusability_scope: string;
  confidence: number;
  source_archive_ids: string[];
  source_change_keys: string[];
  source_candidate_ids: string[];
  source_refs: string[];
  extractor_version: string;
  prompt_version: string;
  index_schema_version: string;
  generation: number;
  created_at: string;
  updated_at: string;
  // 入库投影所需、reusability_scope 无法映射的三个字段。可选：老归档不带它们，
  // 桥走降级路径而不是凭空造一个 type。
  entry_type?: KnowledgeCandidateEntryType;
  body?: string;
  keywords?: string[];
}

export interface CandidatePage {
  items: ProjectContentCandidate[];
  next_cursor?: string;
}

export interface EnqueueKnowledgeExtractionInput {
  archive_id: string;
  extractor_version: string;
  prompt_version: string;
  index_schema_version: string;
}

export interface QueryKnowledgeInput {
  project_id: string;
  query: string;
  limit: number;
}

export interface ListRuleCandidatesInput {
  project_id: string;
  cursor?: string;
  limit: number;
}

export interface CompleteKnowledgeExtractionInput {
  job_id: string;
  generation: number;
  results: KnowledgeResultDraft[];
}

export interface FailKnowledgeExtractionInput {
  job_id: string;
  generation: number;
  reason_code: string;
  retryable: boolean;
}

export interface KnowledgePipelineWorker {
  startKnowledgeExtraction(job_id: string): Promise<KnowledgeExtractionJob>;
  completeKnowledgeExtraction(
    input: CompleteKnowledgeExtractionInput
  ): Promise<JobReceipt>;
  failKnowledgeExtraction(input: FailKnowledgeExtractionInput): Promise<JobReceipt>;
}

/** 查询面自查（2026-08-30 P0-1）：ingest 回执说 ready 但查询全空时，
 *  调用方需要能区分「job 没跑」「job 失败」「结果为空」三种状态。 */
export interface KnowledgePipelineStats {
  readonly project_id: string;
  readonly generation: number;
  readonly results_count: number;
  readonly jobs: Readonly<Record<"queued" | "extracting" | "ready" | "failed", number>>;
  readonly latest_job_updated_at: string | null;
}

export interface KnowledgePipeline {
  acceptArchive(input: AcceptArchiveInput): Promise<ArchiveIngestReceipt>;
  retryArchiveTaskPlanning(
    input: RetryArchiveTaskPlanningInput
  ): Promise<ArchiveIngestReceipt>;
  enqueueKnowledgeExtraction(
    input: EnqueueKnowledgeExtractionInput
  ): Promise<JobReceipt>;
  retryKnowledgeExtraction(job_id: string): Promise<JobReceipt>;
  queryKnowledge(input: QueryKnowledgeInput): Promise<KnowledgeResult[]>;
  pipelineStatus(project_id: string): Promise<KnowledgePipelineStats>;
  listRuleCandidates(input: ListRuleCandidatesInput): Promise<CandidatePage>;
  worker: KnowledgePipelineWorker;
}
