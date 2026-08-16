BEGIN;

ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS lifecycle_kind text NOT NULL DEFAULT 'legacy_unmarked',
  ADD COLUMN IF NOT EXISTS branch_name text,
  ADD COLUMN IF NOT EXISTS source_version text;

ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_lifecycle_identity_check;
ALTER TABLE runs ADD CONSTRAINT runs_lifecycle_identity_check CHECK (
  (lifecycle_kind = 'legacy_unmarked' AND branch_name IS NULL AND source_version IS NULL)
  OR
  (lifecycle_kind = 'change' AND length(branch_name) BETWEEN 1 AND 512
    AND source_version = 'plan-event-bundle/v1')
);

ALTER TABLE run_events ADD COLUMN IF NOT EXISTS plan_event jsonb;

CREATE INDEX IF NOT EXISTS runs_project_change_monitor_idx
  ON runs (project_id, last_event_at DESC NULLS LAST, run_id)
  WHERE lifecycle_kind = 'change';

COMMIT;
