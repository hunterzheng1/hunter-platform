BEGIN;

-- Project-scoped durable upload identities.  The database stores only bounded
-- metadata and the canonical HTTP record; bytes live in the private CAS root.
CREATE TABLE IF NOT EXISTS remote_content_uploads (
  project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES actors(actor_id) ON DELETE CASCADE,
  branch_name text NOT NULL CHECK (length(branch_name) BETWEEN 1 AND 160),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^sha256:[0-9a-f]{64}$'),
  source_json jsonb NOT NULL CHECK (jsonb_typeof(source_json) = 'object'),
  upload_id text NOT NULL CHECK (upload_id ~ '^remote_content_upload:[A-Za-z0-9_-]{43}$'),
  ref_id text NOT NULL CHECK (ref_id ~ '^bounded_upload:[A-Za-z0-9_-]{43}$'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 536870912),
  state text NOT NULL CHECK (state IN ('staged', 'stored', 'expired')),
  stage_attempt_id text CHECK (stage_attempt_id IS NULL OR stage_attempt_id ~ '^attempt_[0-9a-f]{32}$'),
  stage_lease_until timestamptz,
  record_json jsonb NOT NULL CHECK (
    jsonb_typeof(record_json) = 'object'
    AND record_json->>'schema_version' = '1'
    AND source_json = record_json->'source'
    AND record_json->>'upload_id' = upload_id
    AND record_json->>'idempotency_key' = idempotency_key
    AND record_json->>'content_sha256' = content_sha256
    AND (record_json->>'size_bytes')::bigint = size_bytes
    AND record_json->'source'->>'project_id' = project_id
    AND record_json->'source'->>'actor_id' = actor_id
    AND record_json->'source'->>'branch_name' = branch_name
    AND record_json->'upload_ref'->>'ref_id' = ref_id
    AND record_json->'upload_ref'->>'sha256' = content_sha256
    AND (record_json->'upload_ref'->>'size_bytes')::bigint = size_bytes
  ),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, branch_name, actor_id, idempotency_key),
  UNIQUE (project_id, upload_id),
  UNIQUE (project_id, ref_id),
  CHECK (expires_at > created_at),
  CHECK (
    (state IN ('stored','expired') AND stage_attempt_id IS NULL AND stage_lease_until IS NULL)
    OR (state = 'staged' AND stage_attempt_id IS NOT NULL AND stage_lease_until IS NOT NULL)
  ),
  CHECK (state <> 'staged' OR stage_lease_until > created_at),
  CHECK (state <> 'staged' OR stage_lease_until <= expires_at)
);

CREATE INDEX IF NOT EXISTS remote_content_uploads_expiry_idx
  ON remote_content_uploads (expires_at, project_id, upload_id);

CREATE INDEX IF NOT EXISTS remote_content_uploads_stored_live_ref_idx
  ON remote_content_uploads (project_id, content_sha256, expires_at)
  WHERE state = 'stored';

CREATE INDEX IF NOT EXISTS remote_content_uploads_staged_live_ref_idx
  ON remote_content_uploads (project_id, content_sha256, stage_lease_until, expires_at)
  WHERE state = 'staged';

CREATE TABLE IF NOT EXISTS remote_content_upload_cas_objects (
  project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 536870912),
  state text NOT NULL CHECK (state IN ('ready', 'gc_claimed')),
  created_at timestamptz NOT NULL,
  gc_claimed_at timestamptz,
  gc_lease_until timestamptz,
  PRIMARY KEY (project_id, content_sha256),
  CHECK (
    (state = 'ready' AND gc_claimed_at IS NULL AND gc_lease_until IS NULL)
    OR (state = 'gc_claimed' AND gc_claimed_at IS NOT NULL AND gc_lease_until IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS remote_content_upload_cas_gc_idx
  ON remote_content_upload_cas_objects (state, gc_lease_until, project_id, content_sha256);

CREATE TABLE IF NOT EXISTS remote_content_upload_gc_batches (
  batch_id text PRIMARY KEY CHECK (batch_id ~ '^remote_content_upload_gc:[A-Za-z0-9_-]{43}$'),
  project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  worker_id text NOT NULL CHECK (length(worker_id) BETWEEN 1 AND 160),
  lease_until timestamptz NOT NULL,
  acknowledged boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  UNIQUE (project_id, batch_id),
  UNIQUE (batch_id, project_id)
);

CREATE TABLE IF NOT EXISTS remote_content_upload_gc_items (
  batch_id text NOT NULL REFERENCES remote_content_upload_gc_batches(batch_id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  content_sha256 text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 536870912),
  ordinal integer NOT NULL CHECK (ordinal >= 1),
  PRIMARY KEY (batch_id, content_sha256),
  FOREIGN KEY (batch_id, project_id)
    REFERENCES remote_content_upload_gc_batches(batch_id, project_id)
    ON DELETE CASCADE,
  FOREIGN KEY (project_id, content_sha256)
    REFERENCES remote_content_upload_cas_objects(project_id, content_sha256)
    ON DELETE CASCADE,
  UNIQUE (batch_id, ordinal)
);

COMMIT;
