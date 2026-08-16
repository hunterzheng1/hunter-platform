BEGIN;

-- The upload GC live-reference predicates inspect push file metadata.  The
-- expression keeps the JSON opaque at the application boundary while giving
-- PostgreSQL a bounded GIN path for project-scoped ref probes.
CREATE INDEX IF NOT EXISTS remote_sync_http_pushes_upload_refs_idx
  ON remote_sync_http_pushes USING gin (files_json jsonb_path_ops)
  WHERE state IN ('prepared','committing','committed');

COMMIT;
