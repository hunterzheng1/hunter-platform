BEGIN;

-- Durable storage for the Stage 06A pipeline.  These tables are deliberately
-- separate from the legacy knowledge_ingest_entries/semantic_documents path:
-- the frozen pipeline ports need immutable archive bytes, task leases and
-- generation-fenced visible snapshots.

CREATE TABLE IF NOT EXISTS knowledge_pipeline_capacity_fence (
  fence_id smallint PRIMARY KEY CHECK (fence_id = 1)
);

CREATE TABLE IF NOT EXISTS knowledge_pipeline_project_fences (
  project_id text PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
  knowledge_generation bigint NOT NULL DEFAULT 0 CHECK (knowledge_generation >= 0),
  change_projection_generation bigint NOT NULL DEFAULT 0
    CHECK (change_projection_generation >= 0)
);

CREATE TABLE IF NOT EXISTS knowledge_pipeline_archives (
  archive_id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  change_key text NOT NULL,
  package_sha256 text NOT NULL,
  manifest_sha256 text NOT NULL,
  project_version text NOT NULL,
  package_schema_version integer NOT NULL CHECK (package_schema_version >= 1),
  archive_schema_version integer NOT NULL CHECK (archive_schema_version >= 1),
  package_bytes bytea NOT NULL CHECK (octet_length(package_bytes) > 0),
  manifest_bytes bytea NOT NULL CHECK (octet_length(manifest_bytes) > 0),
  knowledge_candidates jsonb NOT NULL
    CHECK (jsonb_typeof(knowledge_candidates) = 'array'),
  project_content_candidates jsonb NOT NULL
    CHECK (jsonb_typeof(project_content_candidates) = 'array'),
  validation_receipt jsonb NOT NULL
    CHECK (jsonb_typeof(validation_receipt) = 'object'),
  stored_at timestamptz NOT NULL,
  UNIQUE (project_id, change_key),
  UNIQUE (project_id, archive_id),
  UNIQUE (
    project_id, package_sha256, manifest_sha256,
    package_schema_version, archive_schema_version
  )
);

CREATE INDEX IF NOT EXISTS knowledge_pipeline_archives_project_idx
  ON knowledge_pipeline_archives(project_id, stored_at DESC, archive_id ASC);

CREATE TABLE IF NOT EXISTS knowledge_pipeline_knowledge_jobs (
  job_id text PRIMARY KEY,
  idempotency_key text NOT NULL,
  project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  change_key text NOT NULL,
  archive_id text NOT NULL,
  package_sha256 text NOT NULL,
  extractor_version text NOT NULL,
  prompt_version text NOT NULL,
  index_schema_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'extracting', 'ready', 'failed')),
  attempt integer NOT NULL CHECK (attempt >= 1),
  generation bigint NOT NULL CHECK (generation >= 1),
  input_hash text NOT NULL,
  output_hash text,
  result_count integer CHECK (result_count IS NULL OR result_count BETWEEN 0 AND 5),
  retryable boolean NOT NULL,
  reason_code text,
  knowledge_candidates jsonb NOT NULL
    CHECK (jsonb_typeof(knowledge_candidates) = 'array'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (project_id, archive_id)
    REFERENCES knowledge_pipeline_archives(project_id, archive_id),
  CHECK (
    (status IN ('queued', 'extracting') AND output_hash IS NULL AND result_count IS NULL
      AND reason_code IS NULL AND retryable)
    OR (status = 'ready' AND output_hash IS NOT NULL AND result_count IS NOT NULL
      AND reason_code IS NULL AND NOT retryable)
    OR (status = 'failed' AND output_hash IS NULL AND result_count IS NULL
      AND reason_code IS NOT NULL AND length(reason_code) > 0)
  ),
  UNIQUE (project_id, job_id),
  UNIQUE (project_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS knowledge_pipeline_knowledge_jobs_queue_idx
  ON knowledge_pipeline_knowledge_jobs(project_id, status, updated_at ASC, job_id ASC);

CREATE TABLE IF NOT EXISTS knowledge_pipeline_change_jobs (
  job_id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  change_key text NOT NULL,
  archive_id text NOT NULL,
  package_sha256 text NOT NULL,
  manifest_sha256 text NOT NULL,
  project_version text NOT NULL,
  package_schema_version integer NOT NULL CHECK (package_schema_version >= 1),
  archive_schema_version integer NOT NULL CHECK (archive_schema_version >= 1),
  status text NOT NULL CHECK (status IN ('queued', 'projecting', 'ready', 'failed')),
  attempt integer NOT NULL CHECK (attempt >= 1),
  project_generation bigint NOT NULL CHECK (project_generation >= 1),
  generation bigint NOT NULL CHECK (generation >= 1),
  input_hash text NOT NULL,
  owner_id text,
  lease_token text,
  lease_expires_at timestamptz,
  output_hash text,
  document_count integer CHECK (document_count IS NULL OR document_count >= 0),
  retryable boolean NOT NULL,
  reason_code text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (project_id, archive_id)
    REFERENCES knowledge_pipeline_archives(project_id, archive_id),
  CHECK (
    (status = 'queued' AND owner_id IS NULL AND lease_token IS NULL
      AND lease_expires_at IS NULL AND output_hash IS NULL AND document_count IS NULL
      AND reason_code IS NULL AND retryable)
    OR (status = 'projecting' AND owner_id IS NOT NULL AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL AND output_hash IS NULL AND document_count IS NULL
      AND reason_code IS NULL AND retryable)
    OR (status = 'ready' AND owner_id IS NULL AND lease_token IS NULL
      AND lease_expires_at IS NULL AND output_hash IS NOT NULL AND document_count IS NOT NULL
      AND reason_code IS NULL AND NOT retryable)
    OR (status = 'failed' AND owner_id IS NULL AND lease_token IS NULL
      AND lease_expires_at IS NULL AND output_hash IS NULL AND document_count IS NULL
      AND reason_code IS NOT NULL AND length(reason_code) > 0)
  ),
  UNIQUE (project_id, job_id),
  UNIQUE (project_id, input_hash)
);

CREATE INDEX IF NOT EXISTS knowledge_pipeline_change_jobs_queue_idx
  ON knowledge_pipeline_change_jobs(project_id, status, updated_at ASC, job_id ASC);

CREATE TABLE IF NOT EXISTS knowledge_pipeline_task_plans (
  project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  change_projection_job_id text NOT NULL,
  knowledge_job_id text NOT NULL,
  project_content_job_id text,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, idempotency_key),
  FOREIGN KEY (project_id, change_projection_job_id)
    REFERENCES knowledge_pipeline_change_jobs(project_id, job_id),
  FOREIGN KEY (project_id, knowledge_job_id)
    REFERENCES knowledge_pipeline_knowledge_jobs(project_id, job_id)
);

CREATE TABLE IF NOT EXISTS knowledge_pipeline_project_candidates (
  project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  candidate_type text NOT NULL,
  content_hash text NOT NULL,
  candidate_id text NOT NULL,
  status text NOT NULL,
  candidate jsonb NOT NULL CHECK (jsonb_typeof(candidate) = 'object'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, candidate_type, content_hash),
  UNIQUE (project_id, candidate_id)
);

CREATE INDEX IF NOT EXISTS knowledge_pipeline_project_candidates_page_idx
  ON knowledge_pipeline_project_candidates(
    project_id, candidate_type, status, created_at DESC, candidate_id ASC
  );

CREATE TABLE IF NOT EXISTS knowledge_pipeline_change_documents (
  project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  document_id text NOT NULL,
  document_version text NOT NULL,
  change_key text NOT NULL,
  archive_id text NOT NULL,
  package_sha256 text NOT NULL,
  project_version text NOT NULL,
  document_type text NOT NULL
    CHECK (document_type IN ('design', 'plan', 'test_scenarios', 'change_summary')),
  source_path text NOT NULL,
  content_hash text NOT NULL,
  content text NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, document_id),
  FOREIGN KEY (project_id, archive_id)
    REFERENCES knowledge_pipeline_archives(project_id, archive_id)
);

CREATE INDEX IF NOT EXISTS knowledge_pipeline_change_documents_page_idx
  ON knowledge_pipeline_change_documents(project_id, change_key, document_id);

CREATE TABLE IF NOT EXISTS knowledge_pipeline_results (
  project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  knowledge_id text NOT NULL,
  content_kind text NOT NULL CHECK (content_kind = 'knowledge_entry'),
  status text NOT NULL CHECK (status = 'active'),
  content_hash text NOT NULL,
  display_title text NOT NULL,
  summary text NOT NULL,
  reusability_scope text NOT NULL,
  confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  source_archive_ids jsonb NOT NULL CHECK (jsonb_typeof(source_archive_ids) = 'array'),
  source_change_keys jsonb NOT NULL CHECK (jsonb_typeof(source_change_keys) = 'array'),
  source_candidate_ids jsonb NOT NULL CHECK (jsonb_typeof(source_candidate_ids) = 'array'),
  source_refs jsonb NOT NULL CHECK (jsonb_typeof(source_refs) = 'array'),
  extractor_version text NOT NULL,
  prompt_version text NOT NULL,
  index_schema_version text NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, knowledge_id),
  UNIQUE (project_id, content_hash)
);

CREATE INDEX IF NOT EXISTS knowledge_pipeline_results_query_idx
  ON knowledge_pipeline_results(project_id, status, updated_at DESC, knowledge_id ASC);

COMMIT;
