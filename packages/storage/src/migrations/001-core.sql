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

CREATE TABLE IF NOT EXISTS pairing_challenges (
  pairing_id TEXT PRIMARY KEY,
  challenge_hash TEXT NOT NULL UNIQUE,
  created_by_principal_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  submitted_at TEXT,
  submitted_device_name TEXT,
  submitted_public_jwk_json TEXT,
  submitted_public_key_thumbprint TEXT,
  confirmed_device_name TEXT,
  confirmed_scopes_json TEXT,
  confirmed_project_ids_json TEXT,
  confirmed_device_expires_at TEXT,
  confirmed_device_id TEXT,
  delivered_at TEXT
);

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  public_jwk_json TEXT NOT NULL,
  public_key_thumbprint TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL,
  project_ids_json TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_families (
  family_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(device_id),
  refresh_hash TEXT NOT NULL UNIQUE,
  previous_refresh_hash TEXT UNIQUE,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  reuse_detected_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_credential_history (
  family_id TEXT NOT NULL REFERENCES refresh_families(family_id),
  refresh_hash TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  retired_at TEXT NOT NULL,
  PRIMARY KEY (family_id, generation)
);

CREATE TABLE IF NOT EXISTS device_proof_nonces (
  device_id TEXT NOT NULL REFERENCES devices(device_id),
  token_jti TEXT NOT NULL,
  nonce TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (device_id, token_jti, nonce)
);

CREATE INDEX IF NOT EXISTS device_proof_nonces_expiry
  ON device_proof_nonces(expires_at);

INSERT INTO storage_metadata(metadata_key, metadata_value, updated_at)
VALUES ('schema_version', '1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(metadata_key) DO UPDATE SET
  metadata_value = excluded.metadata_value,
  updated_at = excluded.updated_at;

COMMIT;
