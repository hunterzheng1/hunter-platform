BEGIN;

-- 项目 API key 可恢复查看：AES-256-GCM 密文列（格式 v1.<iv_b64>.<tag_b64>.<ct_b64>）。
-- 既有行的密文为 NULL——旧 key 永远无法再次查看明文（创建时只存了哈希）。

ALTER TABLE project_api_keys ADD COLUMN IF NOT EXISTS key_ciphertext text;

COMMIT;
