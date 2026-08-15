BEGIN;

-- Transaction-bound Remote Sync publication.  The snapshot rows remain the
-- authoritative file record; these tables bind the remote version, artifact,
-- branch pointer and receipt to the same commit transaction.
CREATE TABLE IF NOT EXISTS remote_sync_artifacts (
  project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  branch_name text NOT NULL CHECK (length(branch_name) BETWEEN 1 AND 160),
  artifact_id text NOT NULL CHECK (length(artifact_id) BETWEEN 1 AND 160),
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^sha256:[a-f0-9]{64}$'),
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40,64}$'),
  project_version text NOT NULL CHECK (length(project_version) BETWEEN 1 AND 160),
  source_json jsonb NOT NULL CHECK (jsonb_typeof(source_json) = 'object'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^sha256:[a-f0-9]{64}$'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 240),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, branch_name, artifact_id, manifest_hash),
  UNIQUE (project_id, branch_name, project_version),
  CHECK (source_json->>'project_id' IS NOT NULL AND source_json->>'project_id' = project_id),
  CHECK (source_json->>'branch_name' IS NOT NULL AND source_json->>'branch_name' = branch_name),
  CHECK (source_json->>'commit_sha' IS NOT NULL AND source_json->>'commit_sha' = commit_sha)
);

CREATE TABLE IF NOT EXISTS remote_sync_versions (
  project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  branch_name text NOT NULL CHECK (length(branch_name) BETWEEN 1 AND 160),
  project_version text NOT NULL CHECK (length(project_version) BETWEEN 1 AND 160),
  artifact_id text NOT NULL CHECK (length(artifact_id) BETWEEN 1 AND 160),
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^sha256:[a-f0-9]{64}$'),
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40,64}$'),
  source_json jsonb NOT NULL CHECK (jsonb_typeof(source_json) = 'object'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^sha256:[a-f0-9]{64}$'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 240),
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json) = 'object'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, branch_name, project_version),
  UNIQUE (project_id, branch_name, project_version, artifact_id, manifest_hash, commit_sha),
  CHECK (source_json->>'project_id' IS NOT NULL AND source_json->>'project_id' = project_id),
  CHECK (source_json->>'branch_name' IS NOT NULL AND source_json->>'branch_name' = branch_name),
  CHECK (source_json->>'commit_sha' IS NOT NULL AND source_json->>'commit_sha' = commit_sha),
  CHECK (snapshot_json->>'project_id' IS NOT NULL AND snapshot_json->>'project_id' = project_id),
  CHECK (snapshot_json->>'branch_name' IS NOT NULL AND snapshot_json->>'branch_name' = branch_name),
  CHECK (snapshot_json->>'project_version' IS NOT NULL AND snapshot_json->>'project_version' = project_version),
  CHECK (snapshot_json->>'artifact_id' IS NOT NULL AND snapshot_json->>'artifact_id' = artifact_id),
  CHECK (snapshot_json->>'manifest_hash' IS NOT NULL AND snapshot_json->>'manifest_hash' = manifest_hash),
  CHECK (snapshot_json->>'commit_sha' IS NOT NULL AND snapshot_json->>'commit_sha' = commit_sha)
);

CREATE TABLE IF NOT EXISTS remote_sync_branch_pointers (
  project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  branch_name text NOT NULL CHECK (length(branch_name) BETWEEN 1 AND 160),
  -- Revisions are opaque protocol values.  The producer/HTTP contract does
  -- not promise decimal sequencing; generation is the numeric monotone
  -- fence, while revision is the exact caller-visible CAS token.
  revision text NOT NULL CHECK (length(revision) BETWEEN 1 AND 240),
  generation bigint NOT NULL CHECK (generation >= 1),
  project_version text NOT NULL,
  artifact_id text NOT NULL,
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^sha256:[a-f0-9]{64}$'),
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40,64}$'),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, branch_name),
  UNIQUE (project_id, branch_name, revision),
  FOREIGN KEY (project_id, branch_name, project_version, artifact_id, manifest_hash, commit_sha)
    REFERENCES remote_sync_versions(project_id, branch_name, project_version, artifact_id, manifest_hash, commit_sha)
);

CREATE TABLE IF NOT EXISTS remote_sync_commit_receipts (
  project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  branch_name text NOT NULL CHECK (length(branch_name) BETWEEN 1 AND 160),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 240),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^sha256:[a-f0-9]{64}$'),
  source_json jsonb NOT NULL CHECK (jsonb_typeof(source_json) = 'object'),
  expected_revision text NOT NULL CHECK (length(expected_revision) BETWEEN 1 AND 240),
  project_version text NOT NULL CHECK (length(project_version) BETWEEN 1 AND 160),
  artifact_id text NOT NULL CHECK (length(artifact_id) BETWEEN 1 AND 160),
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^sha256:[a-f0-9]{64}$'),
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40,64}$'),
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json) = 'object'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, branch_name, idempotency_key),
  CHECK (source_json->>'project_id' IS NOT NULL AND source_json->>'project_id' = project_id),
  CHECK (source_json->>'branch_name' IS NOT NULL AND source_json->>'branch_name' = branch_name),
  CHECK (record_json->>'project_id' IS NOT NULL AND record_json->>'project_id' = project_id),
  CHECK (record_json->>'branch_name' IS NOT NULL AND record_json->>'branch_name' = branch_name),
  CHECK (record_json->>'project_version' IS NOT NULL AND record_json->>'project_version' = project_version),
  CHECK (record_json->>'artifact_id' IS NOT NULL AND record_json->>'artifact_id' = artifact_id),
  CHECK (record_json->>'manifest_hash' IS NOT NULL AND record_json->>'manifest_hash' = manifest_hash),
  CHECK (record_json->>'commit_sha' IS NOT NULL AND record_json->>'commit_sha' = commit_sha)
);

CREATE INDEX IF NOT EXISTS remote_sync_versions_project_order_idx
  ON remote_sync_versions (project_id, branch_name, created_at DESC, project_version);
CREATE INDEX IF NOT EXISTS remote_sync_receipts_payload_idx
  ON remote_sync_commit_receipts (project_id, payload_hash);

COMMIT;
