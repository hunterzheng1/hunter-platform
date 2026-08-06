BEGIN;

-- P2: project-scoped API keys (hh_ prefix, hash-only storage, scoped access).

CREATE TABLE IF NOT EXISTS project_api_keys (
  key_id text PRIMARY KEY,
  key_hash text NOT NULL UNIQUE,
  project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES actors(actor_id),
  label text NOT NULL,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  last_used_at timestamptz
);

CREATE INDEX IF NOT EXISTS project_api_keys_project_idx ON project_api_keys(project_id);

COMMIT;
