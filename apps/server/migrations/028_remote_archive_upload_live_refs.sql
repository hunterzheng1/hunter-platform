BEGIN;

-- Remote Archive v2 records pin the exact project-scoped upload object.  A
-- committed receipt pins it permanently; an in-flight archive pins it until
-- its durable lease expires.  These expression indexes support the upload GC
-- live-reference probes without scanning a project's archive history.
CREATE INDEX IF NOT EXISTS remote_archive_v2_committed_upload_ref_idx
  ON remote_archive_v2_records (
    project_id,
    ((record_json->'upload_ref'->>'sha256')),
    ((record_json->'upload_ref'->>'size_bytes'))
  )
  WHERE state='committed';

CREATE INDEX IF NOT EXISTS remote_archive_v2_active_upload_ref_idx
  ON remote_archive_v2_records (
    project_id,
    ((record_json->'upload_ref'->>'sha256')),
    ((record_json->'upload_ref'->>'size_bytes')),
    ((record_json->'lease'->>'expires_at'))
  )
  WHERE state IN ('prepared','committing');

COMMIT;
