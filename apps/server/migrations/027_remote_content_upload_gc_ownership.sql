BEGIN;

-- A CAS row has one durable GC owner.  This upgrades databases that already
-- ran 025 as well as fresh databases that run the migrations in order.
ALTER TABLE remote_content_upload_cas_objects
  ADD COLUMN IF NOT EXISTS gc_batch_id text;

-- Preserve the newest extant claim when upgrading old rows.  A claimed row
-- without any durable item cannot be safely attributed and returns to ready.
WITH newest_claim AS (
  SELECT DISTINCT ON (i.project_id, i.content_sha256)
    i.project_id,
    i.content_sha256,
    i.batch_id
  FROM remote_content_upload_gc_items i
  JOIN remote_content_upload_gc_batches b
    ON b.batch_id = i.batch_id AND b.project_id = i.project_id
  ORDER BY i.project_id, i.content_sha256,
    b.lease_until DESC, b.created_at DESC, b.batch_id DESC
)
UPDATE remote_content_upload_cas_objects c
SET gc_batch_id = newest_claim.batch_id
FROM newest_claim
WHERE c.project_id = newest_claim.project_id
  AND c.content_sha256 = newest_claim.content_sha256
  AND c.state = 'gc_claimed'
  AND c.gc_batch_id IS NULL;

UPDATE remote_content_upload_cas_objects
SET state = 'ready', gc_claimed_at = NULL, gc_lease_until = NULL
WHERE state = 'gc_claimed' AND gc_batch_id IS NULL;

ALTER TABLE remote_content_upload_cas_objects
  DROP CONSTRAINT IF EXISTS remote_content_upload_cas_objects_state_check;
ALTER TABLE remote_content_upload_cas_objects
  DROP CONSTRAINT IF EXISTS remote_content_upload_cas_objects_check;
ALTER TABLE remote_content_upload_cas_objects
  DROP CONSTRAINT IF EXISTS remote_content_upload_cas_objects_claim_shape_check;
ALTER TABLE remote_content_upload_cas_objects
  DROP CONSTRAINT IF EXISTS remote_content_upload_cas_objects_gc_batch_id_check;

ALTER TABLE remote_content_upload_cas_objects
  ADD CONSTRAINT remote_content_upload_cas_objects_state_check
    CHECK (state IN ('publishing', 'ready', 'gc_claimed')),
  ADD CONSTRAINT remote_content_upload_cas_objects_claim_shape_check
    CHECK (
      (state IN ('publishing', 'ready')
        AND gc_claimed_at IS NULL AND gc_lease_until IS NULL AND gc_batch_id IS NULL)
      OR
      (state = 'gc_claimed'
        AND gc_claimed_at IS NOT NULL AND gc_lease_until IS NOT NULL AND gc_batch_id IS NOT NULL)
    ),
  ADD CONSTRAINT remote_content_upload_cas_objects_gc_batch_id_check
    CHECK (gc_batch_id IS NULL OR gc_batch_id ~ '^remote_content_upload_gc:[A-Za-z0-9_-]{43}$');

CREATE INDEX IF NOT EXISTS remote_content_upload_cas_gc_owner_idx
  ON remote_content_upload_cas_objects (project_id, gc_batch_id)
  WHERE gc_batch_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS remote_content_upload_gc_batches_reap_idx
  ON remote_content_upload_gc_batches (project_id, lease_until, batch_id);

CREATE INDEX IF NOT EXISTS remote_content_upload_gc_batches_unack_reap_idx
  ON remote_content_upload_gc_batches (project_id, lease_until, batch_id)
  WHERE acknowledged=false;

COMMIT;
