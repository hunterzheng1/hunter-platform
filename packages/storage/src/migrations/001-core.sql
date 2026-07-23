PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS events (
  position INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  event_data TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  schema_version INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (aggregate_id, aggregate_version)
);

CREATE TABLE IF NOT EXISTS command_receipts (
  command_id TEXT PRIMARY KEY,
  request_fingerprint TEXT NOT NULL,
  project_id TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  first_position INTEGER,
  last_position INTEGER,
  response_json TEXT NOT NULL,
  committed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  outbox_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT,
  attempt_id TEXT,
  operation_type TEXT NOT NULL,
  operation_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  operation_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','in_flight','completed','indeterminate','needs_attention')),
  dispatch_owner TEXT,
  dispatch_generation INTEGER NOT NULL DEFAULT 0,
  dispatch_expires_at TEXT,
  delivery_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS outbox_eligible
  ON outbox(status, next_attempt_at, dispatch_expires_at, created_at);

CREATE TABLE IF NOT EXISTS side_effect_receipts (
  operation_id TEXT PRIMARY KEY REFERENCES outbox(operation_id),
  request_fingerprint TEXT NOT NULL,
  provider_kind TEXT NOT NULL,
  provider_receipt_json TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  observed_status TEXT NOT NULL CHECK (observed_status IN ('completed','indeterminate','needs_attention')),
  recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_records (
  evidence_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE REFERENCES outbox(operation_id),
  evidence_hash TEXT NOT NULL,
  observed_status TEXT NOT NULL CHECK (observed_status IN ('completed','indeterminate','needs_attention')),
  proof_scope TEXT NOT NULL CHECK (proof_scope IN ('contract_only','local_observation','human_receipt')),
  observed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lease_records (
  lease_id TEXT PRIMARY KEY,
  lease_kind TEXT NOT NULL CHECK (lease_kind IN ('workspace','writer','controller')),
  scope_key TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (lease_kind, scope_key)
);

CREATE TABLE IF NOT EXISTS entity_views (
  projector_name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  entity_version INTEGER NOT NULL,
  view_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (projector_name, entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS projection_checkpoints (
  projector_name TEXT PRIMARY KEY,
  projector_version INTEGER NOT NULL,
  last_position INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS storage_metadata (
  metadata_key TEXT PRIMARY KEY,
  metadata_value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO storage_metadata(metadata_key, metadata_value, updated_at)
VALUES ('schema_version', '1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(metadata_key) DO UPDATE SET
  metadata_value = excluded.metadata_value,
  updated_at = excluded.updated_at;

COMMIT;
