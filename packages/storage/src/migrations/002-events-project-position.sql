CREATE TABLE IF NOT EXISTS principal_project_authorizations (
  principal_id TEXT PRIMARY KEY,
  project_ids_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS events_project_position
  ON events(project_id, position);
