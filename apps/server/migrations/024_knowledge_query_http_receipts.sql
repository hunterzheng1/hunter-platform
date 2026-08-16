BEGIN;

-- Durable Stage 09 query receipts.  The logical idempotency scope is the
-- authenticated actor, project and transport key; the response is retained
-- as a bounded contract snapshot so replay does not re-run the index.
CREATE TABLE IF NOT EXISTS knowledge_query_http_receipts (
  actor_id text NOT NULL REFERENCES actors(actor_id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 240),
  request_hash text NOT NULL CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  query_hash text NOT NULL CHECK (query_hash ~ '^sha256:[0-9a-f]{64}$'),
  query_id text NOT NULL CHECK (query_id ~ '^knowledge_query:[0-9a-f]{64}$'),
  receipt_id text NOT NULL CHECK (receipt_id ~ '^knowledge_query_receipt:[0-9a-f]{64}$'),
  result_set_hash text NOT NULL CHECK (result_set_hash ~ '^sha256:[0-9a-f]{64}$'),
  index_generation text,
  response_json jsonb NOT NULL CHECK (
    jsonb_typeof(response_json) = 'object'
    AND response_json->>'schema_version' = '1'
    AND response_json->>'query_id' IS NOT NULL
    AND response_json->>'query_id' = query_id
    AND response_json->>'project_id' IS NOT NULL
    AND response_json->>'project_id' = project_id
    AND jsonb_typeof(response_json->'receipt') = 'object'
    AND response_json->'receipt'->>'project_id' IS NOT NULL
    AND response_json->'receipt'->>'project_id' = project_id
    AND response_json->'receipt'->>'query_hash' IS NOT NULL
    AND response_json->'receipt'->>'query_hash' = query_hash
    AND response_json->'receipt'->>'receipt_id' IS NOT NULL
    AND response_json->'receipt'->>'receipt_id' = receipt_id
    AND response_json->'receipt'->>'result_set_hash' IS NOT NULL
    AND response_json->'receipt'->>'result_set_hash' = result_set_hash
    AND COALESCE(response_json->'receipt'->>'index_generation', '') = COALESCE(index_generation, '')
  ),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (actor_id, project_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS knowledge_query_http_receipts_project_created_idx
  ON knowledge_query_http_receipts(project_id, created_at DESC, receipt_id ASC);

COMMIT;
