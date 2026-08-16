BEGIN;

ALTER TABLE run_events DROP CONSTRAINT IF EXISTS run_events_run_id_producer_seq_key;
CREATE UNIQUE INDEX IF NOT EXISTS run_events_change_group_sequence_key
  ON run_events (run_id, phase, ((plan_event->>'attempt')::bigint), producer_seq)
  WHERE plan_event IS NOT NULL;

COMMIT;
