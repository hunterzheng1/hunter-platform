-- A durable legacy archive can finish its synchronous storage/projection work
-- while the asynchronous knowledge-pipeline admission fails. Keep that failure
-- distinct from semantic projection so API receipts are actionable.
ALTER TABLE change_archive_packages
  DROP CONSTRAINT IF EXISTS change_archive_packages_failure_stage_check;

ALTER TABLE change_archive_packages
  ADD CONSTRAINT change_archive_packages_failure_stage_check
  CHECK (failure_stage IS NULL OR failure_stage IN (
    'raw_storage', 'core_storage', 'finalize', 'semantic', 'knowledge_enqueue'
  ));
