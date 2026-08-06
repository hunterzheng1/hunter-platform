BEGIN;

-- P4: Run monitoring — events.ndjson sync + heartbeats + projection snapshot.

CREATE TABLE IF NOT EXISTS runs (
  run_id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  change_key text NOT NULL,
  title text,
  run_status text NOT NULL DEFAULT 'running'
    CHECK (run_status IN ('running', 'succeeded', 'failed', 'partial')),
  connection_status text NOT NULL DEFAULT 'offline'
    CHECK (connection_status IN ('online', 'delayed', 'offline', 'reconciling')),
  sync_completeness text NOT NULL DEFAULT 'pending'
    CHECK (sync_completeness IN ('complete', 'pending', 'gapped', 'degraded')),
  current_phase text,
  started_at timestamptz,
  ended_at timestamptz,
  last_event_at timestamptz,
  last_heartbeat_at timestamptz,
  server_cursor bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, change_key)
);

CREATE INDEX IF NOT EXISTS runs_project_last_event_idx
  ON runs (project_id, last_event_at DESC NULLS LAST, run_id);

CREATE TABLE IF NOT EXISTS run_events (
  server_cursor bigserial PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  run_id text NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  event_id text NOT NULL,
  producer_seq bigint NOT NULL CHECK (producer_seq >= 1),
  event_type text NOT NULL,
  phase text,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, event_id),
  UNIQUE (run_id, producer_seq)
);

CREATE INDEX IF NOT EXISTS run_events_run_cursor_idx
  ON run_events (run_id, server_cursor);

COMMIT;
