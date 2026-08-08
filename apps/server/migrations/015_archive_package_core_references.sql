-- Persist every declared core object as part of the durable archive record. This
-- keeps partially written CAS objects reachable after core storage/finalize
-- failures and lets project purge quarantine them deterministically.
ALTER TABLE change_archive_packages
  ADD COLUMN IF NOT EXISTS core_content_sha256 jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'change_archive_packages_core_content_sha256_check'
  ) THEN
    ALTER TABLE change_archive_packages
      ADD CONSTRAINT change_archive_packages_core_content_sha256_check
      CHECK (jsonb_typeof(core_content_sha256) = 'array');
  END IF;
END $$;
