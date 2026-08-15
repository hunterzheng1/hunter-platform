-- MANUAL REVIEW REQUIRED: immutable branch snapshots and opaque cursor capabilities.
BEGIN;

CREATE TABLE IF NOT EXISTS branch_snapshot_blobs (
  content_hash text PRIMARY KEY CHECK (content_hash ~ '^sha256:[a-f0-9]{64}$'),
  content_bytes bytea NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS branch_snapshots (
  project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  branch_name text NOT NULL,
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40,64}$'),
  project_version text NOT NULL,
  artifact_id text NOT NULL,
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^sha256:[a-f0-9]{64}$'),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  file_count integer NOT NULL CHECK (file_count >= 0),
  changed_file_count integer NOT NULL CHECK (changed_file_count >= 0),
  uploaded_at timestamptz NOT NULL,
  diff_ref text NOT NULL,
  changed_paths jsonb NOT NULL,
  PRIMARY KEY (project_id, branch_name, commit_sha, project_version, artifact_id, manifest_hash),
  UNIQUE (project_id, branch_name, project_version)
);

CREATE TABLE IF NOT EXISTS branch_snapshot_files (
  project_id text NOT NULL,
  branch_name text NOT NULL,
  commit_sha text NOT NULL,
  project_version text NOT NULL,
  artifact_id text NOT NULL,
  manifest_hash text NOT NULL,
  path text NOT NULL,
  content_kind text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  content_hash text NOT NULL REFERENCES branch_snapshot_blobs(content_hash),
  media_type text NOT NULL,
  action text,
  PRIMARY KEY (project_id, branch_name, commit_sha, project_version, artifact_id, manifest_hash, path),
  FOREIGN KEY (project_id, branch_name, commit_sha, project_version, artifact_id, manifest_hash)
    REFERENCES branch_snapshots(project_id, branch_name, commit_sha, project_version, artifact_id, manifest_hash)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS branch_snapshots_project_order_idx
  ON branch_snapshots(project_id, uploaded_at DESC, project_version, branch_name,
    artifact_id, commit_sha, manifest_hash);
CREATE INDEX IF NOT EXISTS branch_snapshot_files_identity_path_idx
  ON branch_snapshot_files(project_id, branch_name, commit_sha, project_version,
    artifact_id, manifest_hash, path);

CREATE TABLE IF NOT EXISTS branch_snapshot_cursors (
  token text PRIMARY KEY CHECK (token ~ '^[A-Za-z0-9_-]{43}$'),
  capability_key text NOT NULL UNIQUE,
  actor_id text NOT NULL REFERENCES actors(actor_id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  query_kind text NOT NULL CHECK (query_kind IN ('branches', 'project_versions', 'versions', 'files')),
  branch_name text,
  snapshot_identity jsonb,
  cursor_offset bigint NOT NULL CHECK (cursor_offset >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (query_kind = 'versions' AND branch_name IS NOT NULL AND snapshot_identity IS NULL) OR
    (query_kind = 'files' AND branch_name IS NULL AND snapshot_identity IS NOT NULL) OR
    (query_kind IN ('branches', 'project_versions') AND branch_name IS NULL AND snapshot_identity IS NULL)
  )
);

COMMIT;
