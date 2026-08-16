-- Platform Information export metadata, durable GC leases, and opaque cursor capabilities.
BEGIN;

CREATE TABLE IF NOT EXISTS platform_information_exports (
  export_id text PRIMARY KEY,
  export_id_utf8 bytea NOT NULL,
  project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES actors(actor_id) ON DELETE CASCADE,
  view text NOT NULL,
  query_hash text NOT NULL CHECK (query_hash ~ '^sha256:[a-f0-9]{64}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^sha256:[a-f0-9]{64}$'),
  query_canonical text NOT NULL,
  range_json jsonb NOT NULL,
  m4_proof_json jsonb NOT NULL,
  proof_sha text NOT NULL CHECK (proof_sha ~ '^sha256:[a-f0-9]{64}$'),
  receipt_json jsonb NOT NULL,
  receipt_canonical text NOT NULL,
  content_sha text NOT NULL CHECK (content_sha ~ '^sha256:[a-f0-9]{64}$'),
  items_sha text NOT NULL CHECK (items_sha ~ '^sha256:[a-f0-9]{64}$'),
  byte_count bigint NOT NULL CHECK (byte_count > 0),
  item_count bigint NOT NULL CHECK (item_count >= 0),
  page_count integer NOT NULL CHECK (page_count > 0),
  format text NOT NULL CHECK (format = 'canonical_jsonl_v1'),
  media_type text NOT NULL CHECK (media_type = 'application/x-ndjson'),
  status text NOT NULL CHECK (status IN ('ready', 'expired')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_ms bigint NOT NULL,
  expires_ms bigint NOT NULL,
  CHECK (created_ms < expires_ms),
  CHECK ((extract(epoch FROM created_at) * 1000)::bigint = created_ms),
  CHECK ((extract(epoch FROM expires_at) * 1000)::bigint = expires_ms),
  CHECK (export_id_utf8 = convert_to(export_id, 'UTF8')),
  CHECK (receipt_canonical::jsonb = receipt_json),
  CHECK (query_canonical::jsonb IS NOT NULL),
  CHECK (receipt_json ->> 'export_id' = export_id),
  CHECK (receipt_json ->> 'project_id' = project_id),
  CHECK (receipt_json ->> 'view' = view),
  CHECK (receipt_json ->> 'proof_sha' = proof_sha),
  CHECK (receipt_json -> 'range' = range_json),
  CHECK (receipt_json -> 'm4_proof' = m4_proof_json),
  CHECK (receipt_json #>> '{artifact,content_sha}' = content_sha),
  CHECK (receipt_json #>> '{artifact,items_sha}' = items_sha),
  CHECK ((receipt_json #>> '{artifact,byte_count}')::bigint = byte_count),
  CHECK ((receipt_json #>> '{artifact,item_count}')::bigint = item_count),
  CHECK ((receipt_json #>> '{artifact,page_count}')::integer = page_count),
  CHECK (receipt_json #>> '{artifact,format}' = format),
  CHECK (receipt_json #>> '{artifact,media_type}' = media_type),
  CHECK (receipt_json ->> 'status' = 'ready'),
  UNIQUE (actor_id, project_id, idempotency_key),
  UNIQUE (actor_id, project_id, idempotency_key, query_hash)
);

CREATE INDEX IF NOT EXISTS platform_information_exports_expiry_order_idx
  ON platform_information_exports(status, expires_ms, export_id_utf8);
CREATE INDEX IF NOT EXISTS platform_information_exports_live_content_idx
  ON platform_information_exports(content_sha, status, expires_ms);

CREATE TABLE IF NOT EXISTS platform_information_export_cursors (
  token text PRIMARY KEY CHECK (token ~ '^[A-Za-z0-9_-]{43}$'),
  capability_key text NOT NULL UNIQUE,
  now_ms bigint NOT NULL,
  expires_ms bigint NOT NULL,
  export_id text NOT NULL REFERENCES platform_information_exports(export_id) ON DELETE CASCADE,
  export_id_utf8 bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (export_id_utf8 = convert_to(export_id, 'UTF8'))
);

CREATE TABLE IF NOT EXISTS platform_information_export_batches (
  batch_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id text NOT NULL UNIQUE CHECK (batch_id ~ '^[A-Za-z0-9_-]{43}$'),
  request_key text NOT NULL,
  worker_id text NOT NULL,
  lease_until timestamptz NOT NULL,
  lease_until_ms bigint NOT NULL,
  next_cursor text REFERENCES platform_information_export_cursors(token) ON DELETE SET NULL,
  acknowledged boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_information_export_batch_items (
  batch_id text NOT NULL REFERENCES platform_information_export_batches(batch_id) ON DELETE CASCADE,
  export_id text NOT NULL REFERENCES platform_information_exports(export_id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  PRIMARY KEY (batch_id, export_id),
  UNIQUE (batch_id, ordinal)
);

CREATE INDEX IF NOT EXISTS platform_information_export_batch_items_export_idx
  ON platform_information_export_batch_items(export_id, batch_id);

CREATE UNIQUE INDEX IF NOT EXISTS platform_information_export_batches_live_request_idx
  ON platform_information_export_batches(request_key) WHERE acknowledged = false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_information_export_batches_lease_time_consistent'
      AND conrelid = 'platform_information_export_batches'::regclass
  ) THEN
    ALTER TABLE platform_information_export_batches
      ADD CONSTRAINT platform_information_export_batches_lease_time_consistent
      CHECK ((extract(epoch FROM lease_until) * 1000)::bigint = lease_until_ms);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION cleanup_empty_platform_information_export_batch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM platform_information_export_batches batch
  WHERE batch.batch_id = OLD.batch_id
    AND NOT EXISTS (
      SELECT 1 FROM platform_information_export_batch_items item
      WHERE item.batch_id = batch.batch_id
    );
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION lock_platform_information_export_batch_before_item_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM platform_information_export_batches batch
  WHERE batch.batch_id = OLD.batch_id
  FOR UPDATE;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS platform_information_export_batch_items_lock_parent
  ON platform_information_export_batch_items;
CREATE TRIGGER platform_information_export_batch_items_lock_parent
BEFORE DELETE ON platform_information_export_batch_items
FOR EACH ROW EXECUTE FUNCTION lock_platform_information_export_batch_before_item_delete();

DROP TRIGGER IF EXISTS platform_information_export_batch_items_cleanup_empty
  ON platform_information_export_batch_items;
CREATE TRIGGER platform_information_export_batch_items_cleanup_empty
AFTER DELETE ON platform_information_export_batch_items
FOR EACH ROW EXECUTE FUNCTION cleanup_empty_platform_information_export_batch();

COMMIT;
