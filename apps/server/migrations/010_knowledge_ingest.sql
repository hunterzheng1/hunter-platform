BEGIN;

-- P3: server-side knowledge ingest (idempotent, content-hash dedupe).
-- Rows with projected_at IS NULL form the outbox for async semantic projection.

CREATE TABLE IF NOT EXISTS knowledge_ingest_entries (
  project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  entry_id text NOT NULL,
  content_sha256 text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  projected_at timestamptz,
  PRIMARY KEY (project_id, entry_id)
);

CREATE INDEX IF NOT EXISTS knowledge_ingest_pending_idx
  ON knowledge_ingest_entries (project_id)
  WHERE projected_at IS NULL;

COMMIT;
