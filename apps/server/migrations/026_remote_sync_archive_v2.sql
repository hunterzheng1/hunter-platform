BEGIN;

-- Durable Remote Archive v2 lifecycle.  The canonical JSON record is the
-- authoritative state; capability material is intentionally never persisted.
CREATE TABLE IF NOT EXISTS remote_archive_v2_records (
  project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  operation_id text NOT NULL CHECK (operation_id ~ '^remote_archive_operation:.{1,216}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^sha256:[0-9a-f]{64}$'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('pending','prepared','committing','committed','failed')),
  generation integer NOT NULL CHECK (generation >= 0),
  record_json jsonb NOT NULL CHECK (
    jsonb_typeof(record_json) = 'object'
    AND record_json->>'schema_version' = '2'
    AND record_json->>'operation_id' = operation_id
    AND record_json->>'idempotency_key' = idempotency_key
    AND record_json->>'payload_hash' = payload_hash
    AND record_json->>'state' = state
    AND (record_json->>'generation')::integer = generation
    AND record_json->'source'->>'project_id' = project_id
    AND record_json->'receipt'->>'operation_id' IS NOT DISTINCT FROM
      CASE WHEN record_json->'receipt' IS NULL THEN NULL ELSE operation_id END
  ),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, operation_id),
  UNIQUE (project_id, idempotency_key),
  CHECK (updated_at >= created_at),
  CHECK ((state IN ('prepared','committing','committed')) = (record_json->'lease' IS NOT NULL)),
  CHECK ((state = 'committed') = (record_json->'receipt' IS NOT NULL)),
  CHECK ((state = 'failed') = (record_json->>'failure_code' IS NOT NULL)),
  CHECK (state <> 'failed' OR record_json->'lease' IS NULL),
  CHECK (state <> 'failed' OR record_json->'receipt' IS NULL)
);

CREATE INDEX IF NOT EXISTS remote_archive_v2_project_state_idx
  ON remote_archive_v2_records (project_id, state, updated_at, operation_id);

CREATE INDEX IF NOT EXISTS remote_archive_v2_project_key_idx
  ON remote_archive_v2_records (project_id, idempotency_key);

COMMIT;
