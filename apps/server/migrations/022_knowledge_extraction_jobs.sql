BEGIN;

-- Durable retry authority for the platform-information knowledge view.
-- This table stores job descriptors only; extracted content remains in the
-- pipeline's own result/current tables and is never inferred here.
CREATE TABLE IF NOT EXISTS knowledge_extraction_jobs (
  job_id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  change_key text NOT NULL,
  archive_id text NOT NULL,
  idempotency_key text NOT NULL,
  input_hash text NOT NULL,
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  status text NOT NULL CHECK (status IN ('queued', 'extracting', 'ready', 'failed')),
  retryable boolean NOT NULL DEFAULT false,
  reason_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS knowledge_extraction_jobs_project_status_idx
  ON knowledge_extraction_jobs(project_id, status, updated_at DESC);

COMMIT;
