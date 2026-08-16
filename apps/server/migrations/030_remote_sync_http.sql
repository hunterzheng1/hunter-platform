BEGIN;

-- Durable HTTP lease, push, and pull state.  Binary content is never stored in
-- these tables; push file metadata carries only the opaque bounded-upload ref.
CREATE TABLE IF NOT EXISTS remote_sync_http_lease_commands (
  project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  branch_name text NOT NULL CHECK (length(branch_name) BETWEEN 1 AND 160),
  actor_id text NOT NULL REFERENCES actors(actor_id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 240),
  command_kind text NOT NULL CHECK (command_kind IN ('acquire','renew','release')),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^sha256:[a-f0-9]{64}$'),
  generation bigint NOT NULL CHECK (generation >= 1),
  lease_json jsonb,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, branch_name, actor_id, idempotency_key),
  CHECK (command_kind = 'release' OR jsonb_typeof(lease_json) = 'object'),
  CHECK (lease_json IS NULL OR (
    lease_json ?& ARRAY['schema_version','lease_id','lease_token','generation','project_id','branch_name','actor_id','expires_at']
    AND lease_json - ARRAY['schema_version','lease_id','lease_token','generation','project_id','branch_name','actor_id','expires_at'] = '{}'::jsonb
    AND lease_json->'schema_version' = '1'::jsonb
    AND jsonb_typeof(lease_json->'lease_id') = 'string'
    AND jsonb_typeof(lease_json->'lease_token') = 'string'
    AND jsonb_typeof(lease_json->'generation') = 'number'
    AND jsonb_typeof(lease_json->'project_id') = 'string'
    AND jsonb_typeof(lease_json->'branch_name') = 'string'
    AND jsonb_typeof(lease_json->'actor_id') = 'string'
    AND jsonb_typeof(lease_json->'expires_at') = 'string'
    AND length(lease_json->>'lease_id') BETWEEN 1 AND 160
    AND length(lease_json->>'lease_token') BETWEEN 16 AND 512
    AND lease_json->>'generation' = generation::text
    AND length(lease_json->>'expires_at') BETWEEN 20 AND 40
    AND lease_json->>'project_id' = project_id
    AND lease_json->>'branch_name' = branch_name
    AND lease_json->>'actor_id' = actor_id
  ))
);

CREATE TABLE IF NOT EXISTS remote_sync_http_active_leases (
  project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  branch_name text NOT NULL,
  actor_id text NOT NULL REFERENCES actors(actor_id) ON DELETE CASCADE,
  lease_id text NOT NULL,
  lease_token text NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 1),
  expires_at timestamptz NOT NULL,
  source_json jsonb NOT NULL CHECK (jsonb_typeof(source_json) = 'object'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, branch_name),
  UNIQUE (project_id, branch_name, lease_id),
  CHECK (length(branch_name) BETWEEN 1 AND 160),
  CHECK (length(lease_id) BETWEEN 1 AND 160),
  CHECK (length(lease_token) BETWEEN 16 AND 512),
  CHECK (source_json ?& ARRAY['project_id','branch_name','actor_id']),
  CHECK (source_json - ARRAY['project_id','branch_name','actor_id','commit_sha','client_id','change_key'] = '{}'::jsonb),
  CHECK (jsonb_typeof(source_json->'project_id') = 'string'),
  CHECK (jsonb_typeof(source_json->'branch_name') = 'string'),
  CHECK (jsonb_typeof(source_json->'actor_id') = 'string'),
  CHECK (source_json->>'project_id' = project_id),
  CHECK (source_json->>'branch_name' = branch_name),
  CHECK (source_json->>'actor_id' = actor_id),
  CHECK (length(source_json->>'project_id') BETWEEN 1 AND 160),
  CHECK (length(source_json->>'branch_name') BETWEEN 1 AND 160),
  CHECK (length(source_json->>'actor_id') BETWEEN 1 AND 160),
  CHECK (NOT (source_json ? 'commit_sha') OR (jsonb_typeof(source_json->'commit_sha') = 'string' AND length(source_json->>'commit_sha') BETWEEN 1 AND 240)),
  CHECK (NOT (source_json ? 'client_id') OR (jsonb_typeof(source_json->'client_id') = 'string' AND length(source_json->>'client_id') BETWEEN 1 AND 240)),
  CHECK (NOT (source_json ? 'change_key') OR (jsonb_typeof(source_json->'change_key') = 'string' AND length(source_json->>'change_key') BETWEEN 1 AND 240))
);

CREATE TABLE IF NOT EXISTS remote_sync_http_pushes (
  project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  branch_name text NOT NULL,
  actor_id text NOT NULL REFERENCES actors(actor_id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 240),
  prepare_id text NOT NULL UNIQUE,
  source_json jsonb NOT NULL CHECK (jsonb_typeof(source_json) = 'object'),
  lease_id text NOT NULL,
  lease_token text NOT NULL,
  lease_generation bigint NOT NULL CHECK (lease_generation >= 1),
  expected_revision text NOT NULL CHECK (length(expected_revision) BETWEEN 1 AND 240),
  preview_hash text NOT NULL CHECK (preview_hash ~ '^sha256:[a-f0-9]{64}$'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^sha256:[a-f0-9]{64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^sha256:[a-f0-9]{64}$'),
  files_json jsonb NOT NULL CHECK (jsonb_typeof(files_json) = 'array'),
  operations_json jsonb NOT NULL CHECK (jsonb_typeof(operations_json) = 'array'),
  skipped_json jsonb NOT NULL CHECK (jsonb_typeof(skipped_json) = 'array'),
  state text NOT NULL CHECK (state IN ('prepared','committing','committed','failed','unknown')),
  receipt_json jsonb,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, branch_name, actor_id, idempotency_key),
  CHECK (length(branch_name) BETWEEN 1 AND 160),
  CHECK (length(prepare_id) BETWEEN 1 AND 160),
  CHECK (length(lease_id) BETWEEN 1 AND 160),
  CHECK (length(lease_token) BETWEEN 16 AND 512),
  CHECK (source_json ?& ARRAY['project_id','branch_name','actor_id']),
  CHECK (source_json - ARRAY['project_id','branch_name','actor_id','commit_sha','client_id','change_key'] = '{}'::jsonb),
  CHECK (jsonb_typeof(source_json->'project_id') = 'string'),
  CHECK (jsonb_typeof(source_json->'branch_name') = 'string'),
  CHECK (jsonb_typeof(source_json->'actor_id') = 'string'),
  CHECK (source_json->>'project_id' = project_id),
  CHECK (source_json->>'branch_name' = branch_name),
  CHECK (source_json->>'actor_id' = actor_id),
  CHECK (length(source_json->>'project_id') BETWEEN 1 AND 160),
  CHECK (length(source_json->>'branch_name') BETWEEN 1 AND 160),
  CHECK (length(source_json->>'actor_id') BETWEEN 1 AND 160),
  CHECK (NOT (source_json ? 'commit_sha') OR (jsonb_typeof(source_json->'commit_sha') = 'string' AND length(source_json->>'commit_sha') BETWEEN 1 AND 240)),
  CHECK (NOT (source_json ? 'client_id') OR (jsonb_typeof(source_json->'client_id') = 'string' AND length(source_json->>'client_id') BETWEEN 1 AND 240)),
  CHECK (NOT (source_json ? 'change_key') OR (jsonb_typeof(source_json->'change_key') = 'string' AND length(source_json->>'change_key') BETWEEN 1 AND 240)),
  CHECK (jsonb_array_length(files_json) <= 100000),
  CHECK (jsonb_array_length(operations_json) <= 100000),
  CHECK (jsonb_array_length(skipped_json) <= 100000),
  CHECK (expires_at > created_at),
  CHECK ((state = 'committed' AND jsonb_typeof(receipt_json) = 'object') OR
         (state <> 'committed' AND receipt_json IS NULL))
);

CREATE INDEX IF NOT EXISTS remote_sync_http_pushes_prepare_idx
  ON remote_sync_http_pushes (project_id, branch_name, prepare_id);
CREATE INDEX IF NOT EXISTS remote_sync_http_pushes_state_idx
  ON remote_sync_http_pushes (project_id, branch_name, state, expires_at);

CREATE TABLE IF NOT EXISTS remote_sync_http_pulls (
  project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  branch_name text NOT NULL,
  actor_id text NOT NULL REFERENCES actors(actor_id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 240),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^sha256:[a-f0-9]{64}$'),
  receipt_json jsonb NOT NULL CHECK (jsonb_typeof(receipt_json) = 'object'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, branch_name, actor_id, idempotency_key),
  CHECK (length(branch_name) BETWEEN 1 AND 160),
  CHECK (receipt_json ?& ARRAY['schema_version','source','idempotency_key','payload_hash']),
  CHECK (receipt_json->'schema_version' = '1'::jsonb),
  CHECK (jsonb_typeof(receipt_json->'source') = 'object'),
  CHECK ((receipt_json->'source') ?& ARRAY['project_id','branch_name','actor_id']),
  CHECK ((receipt_json->'source') - ARRAY['project_id','branch_name','actor_id','commit_sha','client_id','change_key'] = '{}'::jsonb),
  CHECK (jsonb_typeof(receipt_json->'source'->'project_id') = 'string'),
  CHECK (jsonb_typeof(receipt_json->'source'->'branch_name') = 'string'),
  CHECK (jsonb_typeof(receipt_json->'source'->'actor_id') = 'string'),
  CHECK (jsonb_typeof(receipt_json->'idempotency_key') = 'string'),
  CHECK (jsonb_typeof(receipt_json->'payload_hash') = 'string'),
  CHECK (receipt_json->'source'->>'project_id' = project_id),
  CHECK (receipt_json->'source'->>'branch_name' = branch_name),
  CHECK (receipt_json->'source'->>'actor_id' = actor_id),
  CHECK (length(receipt_json->'source'->>'project_id') BETWEEN 1 AND 160),
  CHECK (length(receipt_json->'source'->>'branch_name') BETWEEN 1 AND 160),
  CHECK (length(receipt_json->'source'->>'actor_id') BETWEEN 1 AND 160),
  CHECK (NOT ((receipt_json->'source') ? 'commit_sha') OR
    (jsonb_typeof(receipt_json->'source'->'commit_sha') = 'string' AND length(receipt_json->'source'->>'commit_sha') BETWEEN 1 AND 240)),
  CHECK (NOT ((receipt_json->'source') ? 'client_id') OR
    (jsonb_typeof(receipt_json->'source'->'client_id') = 'string' AND length(receipt_json->'source'->>'client_id') BETWEEN 1 AND 240)),
  CHECK (NOT ((receipt_json->'source') ? 'change_key') OR
    (jsonb_typeof(receipt_json->'source'->'change_key') = 'string' AND length(receipt_json->'source'->>'change_key') BETWEEN 1 AND 240)),
  CHECK (receipt_json->>'idempotency_key' = idempotency_key),
  CHECK (receipt_json->>'payload_hash' = payload_hash)
);

COMMIT;
