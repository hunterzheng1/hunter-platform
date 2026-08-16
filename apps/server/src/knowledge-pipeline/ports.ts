import type { ProjectContentCandidate } from "@hunter-harness/contracts";

import type {
  ChangeDocument,
  ChangeProjectionJob,
  KnowledgeExtractionJob,
  KnowledgeResult,
  StoredArchive,
  ValidatedArchivePackage
} from "./types.js";

export interface ArchiveValidationEvidencePort {
  isValidatedPackage(value: unknown): value is ValidatedArchivePackage;
}

export interface ArchiveStorePutResult {
  disposition: "stored" | "existing";
  archive: StoredArchive;
}

export interface ArchiveStore {
  /** CAS by archive_id; a different immutable identity must fail, never overwrite. */
  putIfAbsent(archive: StoredArchive): Promise<ArchiveStorePutResult>;
  getByArchiveId(archive_id: string): Promise<StoredArchive | null>;
}

export interface PlanArchiveTasksInput {
  archive: StoredArchive;
  idempotency_key: string;
  extractor_version: string;
  prompt_version: string;
  index_schema_version: string;
  change_projection_input_hash: string;
  input_hash: string;
  now: string;
}

export interface PlanArchiveTasksResult {
  change_projection_job_id: string;
  change_projection_job: ChangeProjectionJob;
  knowledge_job: KnowledgeExtractionJob;
  project_content_job_id?: string;
}

export interface EnqueueKnowledgeJobInput {
  archive: StoredArchive;
  idempotency_key: string;
  extractor_version: string;
  prompt_version: string;
  index_schema_version: string;
  input_hash: string;
  now: string;
}

export interface ProjectContentCandidateQuery {
  project_id: string;
  candidate_type: ProjectContentCandidate["candidate_type"];
  status: ProjectContentCandidate["status"];
  cursor?: string;
  limit: number;
}

export interface ProjectContentCandidateQueryResult {
  items: ProjectContentCandidate[];
  next_cursor?: string;
}

export interface ChangeProjectionTaskPort {
  getChangeProjectionJob(job_id: string): Promise<ChangeProjectionJob | null>;
  /** Claims one queued generation and returns the immutable archive identity. */
  claimChangeProjectionJob(input: ClaimChangeProjectionJobInput): Promise<ChangeProjectionJob>;
  renewChangeProjectionLease(input: RenewChangeProjectionLeaseInput): Promise<ChangeProjectionJob>;
  failChangeProjectionJob(input: FailChangeProjectionJobInput): Promise<ChangeProjectionJob>;
  reapExpiredChangeProjectionLease(input: ReapChangeProjectionLeaseInput): Promise<ChangeProjectionJob>;
  retryChangeProjectionJob(input: RetryChangeProjectionJobInput): Promise<ChangeProjectionJob>;
}

export interface ClaimChangeProjectionJobInput {
  job_id: string;
  owner_id: string;
  now: string;
  lease_expires_at: string;
}

export interface RenewChangeProjectionLeaseInput extends ClaimChangeProjectionJobInput {
  generation: number;
  lease_token: string;
}

export interface FailChangeProjectionJobInput {
  job_id: string;
  generation: number;
  owner_id: string;
  lease_token: string;
  reason_code: string;
  retryable: boolean;
  now: string;
}

export interface ReapChangeProjectionLeaseInput {
  job_id: string;
  generation: number;
  now: string;
}

export interface RetryChangeProjectionJobInput {
  job_id: string;
  expected_generation: number;
  expected_status: "failed";
  now: string;
}

export interface JobRepository extends ChangeProjectionTaskPort {
  /** Atomically creates all three plans or creates none when any queue is full. */
  planArchiveTasks(input: PlanArchiveTasksInput): Promise<PlanArchiveTasksResult>;
  enqueueKnowledgeJob(input: EnqueueKnowledgeJobInput): Promise<KnowledgeExtractionJob>;
  getKnowledgeJob(job_id: string): Promise<KnowledgeExtractionJob | null>;
  startKnowledgeJob(job_id: string, now: string): Promise<KnowledgeExtractionJob>;
  failKnowledgeJob(
    job_id: string,
    generation: number,
    reason_code: string,
    retryable: boolean,
    now: string
  ): Promise<KnowledgeExtractionJob>;
  retryKnowledgeJob(job_id: string, now: string): Promise<KnowledgeExtractionJob>;
  listProjectContentCandidates(
    query: ProjectContentCandidateQuery
  ): Promise<ProjectContentCandidateQueryResult>;
}

export interface KnowledgeIndexQuery {
  project_id: string;
  content_kind: "knowledge_entry";
  status: "active";
  query: string;
  limit: number;
}

export interface KnowledgeIndex {
  /** Applies project, kind, status, query and limit before returning results. */
  query(query: KnowledgeIndexQuery): Promise<KnowledgeResult[]>;
}

export interface CommitKnowledgeResultsInput {
  job_id: string;
  generation: number;
  output_hash: string;
  results: readonly KnowledgeResult[];
  now: string;
}

export interface KnowledgeCommitPort {
  /**
   * In one transaction: checks job status/generation and that generation equals
   * the project's latest planned generation, then applies visible index results
   * and records ready/output state. A stale project generation or any failure
   * leaves both job and index unchanged. Replaying the same generation/output is
   * idempotent; a different output for a ready generation is a conflict.
   */
  commitKnowledgeResults(
    input: CommitKnowledgeResultsInput
  ): Promise<KnowledgeExtractionJob>;
}

export interface CommitChangeProjectionInput {
  job_id: string;
  generation: number;
  owner_id: string;
  lease_token: string;
  output_hash: string;
  /** Complete document snapshot produced for this job generation. */
  documents: readonly ChangeDocument[];
  now: string;
}

export interface ChangeProjectionCommitPort {
  /**
   * In one conditional transaction: fences job and project generation, replaces
   * the visible document snapshot, and records ready/output state. No knowledge
   * index or durable archive state participates in this transaction.
   */
  commitChangeProjection(input: CommitChangeProjectionInput): Promise<ChangeProjectionJob>;
}
