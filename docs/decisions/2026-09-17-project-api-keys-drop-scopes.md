# 项目 API 密钥移除"权限范围"决策记录

日期：2026-09-17 决策并实施
状态：已落地（服务端 + Web + contracts，配套 CLI 见 Hunter-Harness 同日期 ADR）

本文档记录 hunter-platform 把项目 API 密钥从"按权限范围（scope）签发"简化为"项目级全权限密钥"的决策。

## D1 密钥不再携带 scope，默认拥有项目内全部权限

- 背景：scope 枚举（push / knowledge:read / knowledge:write / platform:read / files:read / files:write / archive:* / progress:write）随端点增减而演化，用户每次新增能力都要重新签发或调整密钥，实际使用中几乎全部密钥勾选全集，scope 粒度形同虚设却横跨 schema、存储、路由、OpenAPI 扩展、Web UI 五层。
- 决策：创建密钥只需"用途标签"；密钥隐式拥有项目内全部权限。删除 `PROJECT_KEY_SCOPES` 枚举、`ProjectKeyScope` 类型、创建 schema 的 scopes 字段、仓库存取的 scopes 读写、`migrations/037_drop_project_api_keys_scopes.sql` 下线 DB 列、`/auth/key-info` 与创建/列表响应的 scopes 字段、Web 创建区的勾选项与列表"权限范围"列（步骤说明 5 步精简为 4 步）。
- 后果：权限项今后增删无需重新签发密钥；存量密钥的 scopes 列随迁移删除后行为等价（此前实际等价全集）。

## D2 保留两层安全边界

- 背景：scope 删除后仍需防越权。
- 决策：
  1. 项目绑定校验不变——项目 key 只能用于其绑定项目，跨项目仍 `PROJECT_KEY_MISMATCH`（403）。
  2. 端点准入改为显式布尔 `allowProjectKey`，default-deny 不变：未声明接受项目 key 的路由（如 dashboard、全局 search）仍拒绝。`PROJECT_KEY_SCOPE` 错误码**不改名**（跨仓冻结契约，CLI 诊断映射依赖），语义从"密钥缺少该 scope"变为"该端点不接受项目 key"。
- 后果：`authenticated(request, repository, allowProjectKey?)` 第三参由 scope 名收敛为布尔，46+ 调用点机械替换；`assertProjectKeyScope` 瘦身为 `assertProjectKeyBinding`。branch 域 `branch_files` 的 scopes（receipt 字段）与 npm 发布凭证的 scope 是同名异概念，均保留。

## D3 契约与冻结产物同步

- 背景：`openapi/hunter-harness-v1.yaml` 带字节级 sha256 冻结，contracts 操作元数据里的 `project_key_scope` / `project_key_scope_by_view` 与 `x-hunter-project-key-scope(-by-view)` 扩展是 scope 概念的对外投影。
- 决策：两仓（hunter-platform 与 Hunter-Harness vendored 副本）contracts 源文件、冻结 fixtures、yaml 扩展行同步删除，yaml 描述句改为 "The actor and project allowlist come from authenticated server authority."，`.sha256` 两侧按各自行尾（CRLF/LF）重算。
- 后果：两仓 openapi 哈希测试与契约 fixture 测试全绿；CLI 老版本对 key-info 缺失 scopes 字段有容错，无兼容风险。

## 验收状态（2026-09-17）

- hunter-platform 全量 vitest：380 文件 / 4970 测试通过，typecheck 全绿
- Hunter-Harness `npm run release:preflight` 通过
- Web 密钥面板测试 3/3（无勾选项、4 步指引、请求体仅 label）
