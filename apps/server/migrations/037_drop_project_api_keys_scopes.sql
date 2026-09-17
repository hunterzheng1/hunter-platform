BEGIN;

-- 项目 API key 不再按权限范围签发：密钥隐式拥有其绑定项目内的全部（已开放端点）
-- 能力，scope 概念整体下线。项目绑定校验（PROJECT_KEY_MISMATCH）与端点
-- default-deny 保持不变。

ALTER TABLE project_api_keys DROP COLUMN scopes;

COMMIT;
