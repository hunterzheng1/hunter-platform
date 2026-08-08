# hunter-platform

Web Console slice split from Hunter-Harness: Next.js UI (`apps/web`) and Fastify API (`apps/server`), plus shared `@hunter-harness/contracts` and `@hunter-harness/core`.

Package names and console behavior match Hunter-Harness. CLI / skill-cli / workflow-data-harness npm packaging stays in the Hunter-Harness repo.

## 归档、知识与项目指令职责

Hunter Platform 是归档和知识的耐久端：

- `PUT /api/v1/projects/{project_id}/changes/{change_key}/archive-package` 接收一个确定性 ZIP；
- 在写入对象存储前校验 ZIP 路径、符号链接/加密项、文件数、单文件/展开大小、压缩比、manifest、内容哈希、UTF-8/JSON 和敏感信息；
- 只接受 `summary-data.json`、`spec/**/*.md`、`plans/**/*.md`、`archive-meta.md`、`change-context.json`，拒绝日志、测试/审查报告、HTML、缓存和临时文件；
- 原始 ZIP 作为耐久事实源保留，解包后的核心文件发布为项目 artifact，并在服务端建立语义索引；
- 状态接口返回 `durable + indexing|ready|failed`，download 接口可恢复完全相同的原 ZIP；同一 change 的相同包幂等，不同包返回冲突。

客户端知识查询只调用 `/api/v1/semantic/search`，平台不可用时不提供本地 fallback。查询是只读 FTS；归档 ingest 对相同且已 ready 的包幂等短路，失败可用服务端已保存的原 ZIP 重试，并受 50 MiB 包/展开上限、10 MiB 单文件上限和 100 文件上限保护。日志和报告不会进入索引；大规模部署仍应监控归档队列、语义文档总量与重建耗时。

项目文档使用“审计—提案—确认应用”：

- `POST /api/v1/projects/{project_id}/instruction-proposals` 结合项目类型、现有文档、Codebase Map、服务端已保存的近期归档总结和公开最佳实践，生成中文、无托管标记的提案；
- 提案不会修改仓库，客户端按基线 hash 审阅并事务化应用；
- 重复审计会稳定复用“项目特定约定/规则”区，不会递归嵌套旧模板；Codebase Map 和近期变更也纳入敏感信息扫描；
- 每次变更的经验只形成 `auto_apply=false` 的规则候选；重复证据会聚合并提高人工采纳建议，但不会自动写入规则。

数据库迁移 `012_change_archive_packages.sql` 保存原包身份、artifact 与知识状态。API 合同位于 `apps/server/openapi/hunter-harness-v1.yaml`，并与 Hunter-Harness 仓库的合同副本保持一致。

## Requirements

- Node.js >= 24, npm >= 11
- Postgres 17 (for `apps/server` runtime)

## Setup

```bash
npm install
cp .env.example .env
# create secrets/postgres_password.txt (and optional bootstrap token) before compose
```

### Typecheck / build

```bash
npm run typecheck
npm run build
```

### Local run (without Docker)

1. Start Postgres and set `DATABASE_URL` / `ARTIFACT_ROOT`.
2. Build and start API:

```bash
npm run build -w packages/contracts -w packages/core -w apps/server
npm run start -w apps/server
```

3. Start web (API rewrite optional via `HUNTER_HARNESS_INTERNAL_API_URL`):

```bash
npm run dev -w apps/web
```

### Docker Compose

```bash
docker compose up --build
```

Web defaults to port `3000` (`WEB_PORT`). npm publish overlay is not included here; configure `HUNTER_HARNESS_NPM_SCOPE` + token the same way as Hunter-Harness when needed.
