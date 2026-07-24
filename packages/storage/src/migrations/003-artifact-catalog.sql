CREATE TABLE artifact_catalog (
  artifact_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  attempt_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('log', 'report', 'receipt')),
  retention_class TEXT NOT NULL CHECK (
    retention_class IN (
      'ephemeral',
      'standard',
      'evidence',
      'archive',
      'core_receipt'
    )
  ),
  summary TEXT NOT NULL,
  byte_length INTEGER NOT NULL DEFAULT 0 CHECK (byte_length >= 0),
  entry_count INTEGER NOT NULL DEFAULT 0 CHECK (entry_count >= 0),
  retention_floor INTEGER NOT NULL DEFAULT 0 CHECK (retention_floor >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (retention_floor <= entry_count)
) STRICT;
CREATE INDEX artifact_catalog_project_created
  ON artifact_catalog(project_id, created_at, artifact_id);

CREATE TABLE artifact_entries (
  artifact_id TEXT NOT NULL,
  cursor INTEGER NOT NULL CHECK (cursor > 0),
  stream TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr', 'system')),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  content_ref TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length > 0),
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, cursor),
  FOREIGN KEY (artifact_id) REFERENCES artifact_catalog(artifact_id)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX artifact_entries_content_hash
  ON artifact_entries(content_hash);

CREATE TABLE artifact_references (
  artifact_id TEXT NOT NULL,
  reference_kind TEXT NOT NULL CHECK (
    reference_kind IN ('evidence', 'archive')
  ),
  reference_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, reference_kind, reference_id),
  FOREIGN KEY (artifact_id) REFERENCES artifact_catalog(artifact_id)
    ON DELETE CASCADE
) STRICT;
