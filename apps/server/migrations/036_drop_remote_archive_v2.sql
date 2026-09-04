BEGIN;

-- Remote Archive v2 回执登记整链退役（2026-09 精简 §3.3）：
-- remote-sync-archive-http/-pg 与 content-upload(remote_archive) 路由已删，
-- 表无任何 SELECT 消费方，CLI 实际归档走 archives:ingest。
DROP INDEX IF EXISTS remote_archive_v2_committed_upload_ref_idx;
DROP INDEX IF EXISTS remote_archive_v2_active_upload_ref_idx;
DROP INDEX IF EXISTS remote_archive_v2_project_state_idx;
DROP INDEX IF EXISTS remote_archive_v2_project_key_idx;
DROP TABLE IF EXISTS remote_archive_v2_records;

COMMIT;
