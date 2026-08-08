import { sha256Bytes, uuidV7 } from "@hunter-harness/core";
import AdmZip from "adm-zip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/app.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

describe("instruction proposal API", () => {
  const token = "instruction-owner-token";
  let repository: MemoryRepository;
  let app: Awaited<ReturnType<typeof createServer>>;
  let projectId: string;

  beforeEach(async () => {
    repository = new MemoryRepository();
    await repository.createActorWithToken({ actorId: "actor_instruction", token });
    app = await createServer({ repository, storage: new MemoryArtifactStorage() });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects:resolve",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-request-id": uuidV7(),
        "idempotency-key": uuidV7()
      },
      payload: {
        schema_version: 1,
        local_project_key: uuidV7(),
        display_name: "中文规则项目",
        requested_project_id: null,
        client_id: "cli_test"
      }
    });
    projectId = response.json().project_id as string;
  });

  afterEach(async () => app.close());

  async function uploadServerOwnedChange(
    changeKey = "archive-v1",
    decision = "所有归档上传都必须校验内容哈希"
  ): Promise<void> {
    const content = JSON.stringify({
      schema_version: 1,
      change_key: changeKey,
      summary: "归档改为单 ZIP 上传并在服务端建立知识索引。",
      decisions: [decision]
    });
    const zip = new AdmZip();
    zip.addFile("reports/final/summary-data.json", Buffer.from(content, "utf8"));
    zip.addFile("archive-manifest.json", Buffer.from(JSON.stringify({
      schema_version: 1,
      profile: "core-v1",
      change_key: changeKey,
      created_at: "2026-08-08T00:00:00.000Z",
      source: { commit: "0123456789abcdef", tree: null },
      files: [{
        path: "reports/final/summary-data.json",
        role: "summary",
        media_type: "application/json",
        content_sha256: sha256Bytes(content),
        size_bytes: Buffer.byteLength(content)
      }]
    }), "utf8"));
    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/changes/${changeKey}/archive-package`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/zip",
        "x-request-id": uuidV7(),
        "idempotency-key": uuidV7()
      },
      payload: zip.toBuffer()
    });
    expect(response.statusCode, response.body).toBe(201);
  }

  it("audits legacy blocks and proposes concise Chinese project instructions from evidence", async () => {
    await uploadServerOwnedChange();
    const agents = [
      "# Old guide",
      "<!-- hunter-harness:start id=hunter-harness-core -->",
      "Generated English block",
      "<!-- hunter-harness:end id=hunter-harness-core -->",
      "",
      "## Important custom rule",
      "Never change the public wire format without a migration."
    ].join("\n");
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/instruction-proposals`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-request-id": uuidV7(),
        "idempotency-key": uuidV7()
      },
      payload: {
        schema_version: 1,
        language: "zh-CN",
        project_profile: "typescript-monorepo",
        adapters: ["codex", "claude-code", "cursor"],
        documents: [
          { path: "AGENTS.md", content: agents, content_sha256: sha256Bytes(agents) },
          { path: "CLAUDE.md", content: "旧说明\n", content_sha256: sha256Bytes("旧说明\n") },
          {
            path: "package.json",
            content: JSON.stringify({ scripts: { test: "vitest run", check: "npm run lint && npm run typecheck" } }),
            content_sha256: sha256Bytes(JSON.stringify({ scripts: { test: "vitest run", check: "npm run lint && npm run typecheck" } }))
          }
        ],
        codebase_map: {
          status: "fresh",
          content: "packages/core：核心协议与项目操作。\npackages/cli：npx 命令入口。"
        },
        recent_changes: []
      }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({
      schema_version: 1,
      project_id: projectId,
      language: "zh-CN",
      mode: "audit-propose",
      applied: false
    });
    expect(body.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "LEGACY_MANAGED_BLOCK" })
    ]));
    const files = new Map((body.files as Array<{ path: string; content: string }>).map((file) => [file.path, file.content]));
    expect([...files.keys()]).toEqual(expect.arrayContaining([
      "AGENTS.md",
      "CLAUDE.md",
      ".harness/rules/project-guidance.md",
      ".cursor/rules/project-guidance.mdc"
    ]));
    const proposedAgents = files.get("AGENTS.md") ?? "";
    expect(proposedAgents).toContain("# 项目协作指南");
    expect(proposedAgents).toContain("## 仓库导航");
    expect(proposedAgents).toContain("npm test");
    expect(proposedAgents).toContain("工作区包边界");
    expect(proposedAgents).toContain("public wire format");
    expect(proposedAgents).not.toContain("hunter-harness:start");
    expect(body.rule_candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        content: "所有归档上传都必须校验内容哈希",
        evidence_count: 1,
        auto_apply: false
      })
    ]));
  });

  it("keeps generated instructions byte-stable across repeated audits", async () => {
    await uploadServerOwnedChange();
    const packageJson = JSON.stringify({
      packageManager: "npm@11.4.2",
      scripts: { test: "vitest run", typecheck: "tsc -b" }
    });
    const basePayload = {
      schema_version: 1,
      language: "zh-CN",
      project_profile: "typescript-monorepo",
      adapters: ["codex", "claude-code", "cursor"],
      documents: [
        {
          path: "AGENTS.md",
          content: "# 自定义约定\n\n公共协议变更必须提供迁移。\n",
          content_sha256: sha256Bytes("# 自定义约定\n\n公共协议变更必须提供迁移。\n")
        },
        { path: "package.json", content: packageJson, content_sha256: sha256Bytes(packageJson) }
      ],
      codebase_map: {
        status: "fresh",
        content: "packages/core：核心协议。\npackages/cli：CLI 入口。"
      },
      recent_changes: []
    };
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/instruction-proposals`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-request-id": uuidV7(),
        "idempotency-key": uuidV7()
      },
      payload: basePayload
    });
    expect(first.statusCode, first.body).toBe(201);
    const firstFiles = first.json().files as Array<{
      path: string;
      content: string;
      content_sha256: string;
    }>;
    const generatedDocuments = firstFiles.map((file) => ({
      path: file.path,
      content: file.content,
      content_sha256: file.content_sha256
    }));
    const second = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/instruction-proposals`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-request-id": uuidV7(),
        "idempotency-key": uuidV7()
      },
      payload: {
        ...basePayload,
        documents: [
          ...generatedDocuments,
          { path: "package.json", content: packageJson, content_sha256: sha256Bytes(packageJson) }
        ]
      }
    });
    expect(second.statusCode, second.body).toBe(201);
    const secondFiles = second.json().files as typeof firstFiles;
    expect(Object.fromEntries(secondFiles.map((file) => [file.path, file.content])))
      .toEqual(Object.fromEntries(firstFiles.map((file) => [file.path, file.content])));
  });

  it("aggregates repeated archived decisions into one review-only rule candidate", async () => {
    const decision = "公共归档协议变更必须带迁移测试";
    await uploadServerOwnedChange("archive-v1", decision);
    await uploadServerOwnedChange("archive-v2", decision);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/instruction-proposals`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-request-id": uuidV7(),
        "idempotency-key": uuidV7()
      },
      payload: {
        schema_version: 1,
        language: "zh-CN",
        project_profile: "general",
        adapters: ["codex"],
        documents: [],
        codebase_map: { status: "missing", content: "" },
        recent_changes: []
      }
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().rule_candidates).toEqual([
      expect.objectContaining({
        content: decision,
        evidence_count: 2,
        auto_apply: false,
        recommendation: "promote"
      })
    ]);
  });

  it("scans codebase-map evidence before using it in instructions", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/instruction-proposals`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-request-id": uuidV7(),
        "idempotency-key": uuidV7()
      },
      payload: {
        schema_version: 1,
        language: "zh-CN",
        project_profile: "general",
        adapters: ["codex"],
        documents: [],
        codebase_map: {
          status: "fresh",
          content: "packages/core: AWS key AKIAIOSFODNN7EXAMPLE"
        },
        recent_changes: []
      }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: "SENSITIVE_CONTENT_BLOCKED" } });
  });
});
