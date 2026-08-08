-- Retry diagnostics for synchronous archive ingestion. Session advisory locks
-- are released by PostgreSQL if a request or process dies, so retries do not
-- require a persistent worker lease.
ALTER TABLE change_archive_packages
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS failure_stage text,
  ADD COLUMN IF NOT EXISTS last_error_code text;

ALTER TABLE proposal_sessions
  DROP CONSTRAINT IF EXISTS proposal_sessions_status_check;
ALTER TABLE proposal_sessions
  ADD CONSTRAINT proposal_sessions_status_check
  CHECK (status IN ('open', 'finalized', 'failed'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'change_archive_packages_attempt_count_check'
  ) THEN
    ALTER TABLE change_archive_packages
      ADD CONSTRAINT change_archive_packages_attempt_count_check CHECK (attempt_count >= 1);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'change_archive_packages_failure_stage_check'
  ) THEN
    ALTER TABLE change_archive_packages
      ADD CONSTRAINT change_archive_packages_failure_stage_check
      CHECK (failure_stage IS NULL OR failure_stage IN (
        'raw_storage', 'core_storage', 'finalize', 'semantic'
      ));
  END IF;
END $$;
