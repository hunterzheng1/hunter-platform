import { readFile } from "node:fs/promises";

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

  async function resolveProject(displayName: string): Promise<string> {
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
        display_name: displayName,
        requested_project_id: null,
        client_id: "cli_test"
      }
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().project_id as string;
  }

  beforeEach(async () => {
    repository = new MemoryRepository();
    await repository.createActorWithToken({ actorId: "actor_instruction", token });
    app = await createServer({ repository, storage: new MemoryArtifactStorage() });
    projectId = await resolveProject("中文规则项目");
  });

  afterEach(async () => app.close());

  async function uploadServerOwnedChange(
    changeKey = "archive-v1",
    options: {
      decision?: string | null;
      schemaVersion?: "2.2" | "2.3";
    } = {}
  ): Promise<void> {
    const schemaVersion = options.schemaVersion ?? "2.3";
    const fixtureUrl = new URL(
      `./fixtures/instruction-summary-data-v${schemaVersion}.json`,
      import.meta.url
    );
    const summary = JSON.parse(await readFile(fixtureUrl, "utf8")) as {
      changeName: string;
      timeline: Array<Record<string, unknown>>;
    };
    summary.changeName = changeKey;
    const decision = options.decision === undefined
      ? "所有归档上传都必须校验内容哈希"
      : options.decision;
    if (decision !== null) {
      summary.timeline.push({
        phase: "review",
        timestamp: "2026-08-08T00:00:00.000Z",
        type: "decision",
        summary: decision
      });
    }
    const content = JSON.stringify(summary);
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

  it.each([
    ["2.2", "验证 schema 2.2 归档总结能够形成最近变更线索。", "旧客户端读取路径仍需保留", "审查保留一个兼容性观察项", "API 环境未启动"],
    ["2.3", "验证 schema 2.3 归档总结能够形成最近变更线索。", "冻结事件流是报告事实源", "审查确认归档事实来自冻结事件流", "历史 2.2 归档仍需兼容读取"]
  ] as const)(
    "extracts stable recent-change evidence from Hunter-Harness summary-data %s without inventing decisions",
    async (schemaVersion, goal, maintenance, review, risk) => {
      await uploadServerOwnedChange(`archive-v${schemaVersion.replace(".", "")}`, {
        schemaVersion,
        decision: null
      });
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
      const body = response.json();
      const agents = (body.files as Array<{ path: string; content: string }>)
        .find((file) => file.path === "AGENTS.md")?.content ?? "";
      expect(agents).toContain(goal);
      expect(agents).toContain(maintenance);
      expect(agents).toContain(review);
      expect(agents).toContain(risk);
      expect(body.rule_candidates).toEqual([]);
    }
  );

  it("preserves each adapter's unique guidance while removing legacy managed blocks", async () => {
    const legacyBlock = (body: string) => [
      "<!-- hunter-harness:start id=legacy -->",
      body,
      "<!-- hunter-harness:end id=legacy -->"
    ].join("\n");
    const documents = [
      {
        path: "CLAUDE.md",
        content: [
          "# Claude 专属约定",
          "只在完成聚焦测试后运行全量测试。",
          legacyBlock("旧 Claude 生成段落")
        ].join("\n")
      },
      {
        path: "CODEBUDDY.md",
        content: [
          "# CodeBuddy 专属约定",
          "CodeBuddy 调查完成后必须留下证据路径。",
          legacyBlock("旧 CodeBuddy 生成段落")
        ].join("\n")
      },
      {
        path: ".cursor/rules/project-guidance.mdc",
        content: [
          "---",
          "description: 现有 Cursor 项目约定",
          "globs: apps/server/**/*.ts",
          "alwaysApply: false",
          "---",
          "Cursor 修改服务端协议时必须补契约测试。",
          legacyBlock("旧 Cursor 生成段落")
        ].join("\n")
      }
    ] as const;
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
        project_profile: "typescript",
        adapters: ["claude-code", "cursor", "codebuddy"],
        documents: documents.map((document) => ({
          ...document,
          content_sha256: sha256Bytes(document.content)
        })),
        codebase_map: { status: "missing", content: "" },
        recent_changes: []
      }
    });
    expect(response.statusCode, response.body).toBe(201);
    const files = new Map((response.json().files as Array<{
      path: string;
      content: string;
      base_content_sha256: string | null;
    }>).map((file) => [file.path, file]));
    const expectations = [
      ["CLAUDE.md", "只在完成聚焦测试后运行全量测试。", "旧 Claude 生成段落"],
      ["CODEBUDDY.md", "CodeBuddy 调查完成后必须留下证据路径。", "旧 CodeBuddy 生成段落"],
      [".cursor/rules/project-guidance.mdc", "Cursor 修改服务端协议时必须补契约测试。", "旧 Cursor 生成段落"]
    ] as const;
    for (const [path, uniqueGuidance, removedLegacyText] of expectations) {
      const proposed = files.get(path);
      expect(proposed?.content).toContain(uniqueGuidance);
      expect(proposed?.content.split(uniqueGuidance)).toHaveLength(2);
      expect(proposed?.content).not.toContain(removedLegacyText);
      expect(proposed?.content).not.toMatch(/hunter-harness:(?:start|end)/iu);
      const source = documents.find((document) => document.path === path);
      expect(proposed?.base_content_sha256).toBe(
        source === undefined ? null : sha256Bytes(source.content)
      );
    }
  });

  it("keeps every proposed output marker-free when all evidence channels contain marker text", async () => {
    const injectedProjectId = await resolveProject(
      "注入项目 hunter-harness:start 项目名 hunter-harness:end"
    );
    const agents = [
      "# 现有约定",
      "hunter-harness:start",
      "仍需保留的用户规则。",
      "hunter-harness:end"
    ].join("\n");
    const claude = "Claude 规则 hunter-harness:start 保留内容 hunter-harness:end";
    const codebuddy = "CodeBuddy 规则 hunter-harness:start 保留内容 hunter-harness:end";
    const cursor = "Cursor 规则 hunter-harness:start 保留内容 hunter-harness:end";
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${injectedProjectId}/instruction-proposals`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-request-id": uuidV7(),
        "idempotency-key": uuidV7()
      },
      payload: {
        schema_version: 1,
        language: "zh-CN",
        project_profile: "typescript hunter-harness:start profile hunter-harness:end",
        adapters: ["codex", "claude-code", "cursor", "codebuddy"],
        documents: [
          { path: "AGENTS.md", content: agents, content_sha256: sha256Bytes(agents) },
          { path: "CLAUDE.md", content: claude, content_sha256: sha256Bytes(claude) },
          { path: "CODEBUDDY.md", content: codebuddy, content_sha256: sha256Bytes(codebuddy) },
          {
            path: ".cursor/rules/project-guidance.mdc",
            content: cursor,
            content_sha256: sha256Bytes(cursor)
          }
        ],
        codebase_map: {
          status: "fresh",
          content: "packages/core：hunter-harness:start 地图注入 hunter-harness:end"
        },
        recent_changes: [{
          change_key: "marker-injection",
          summary: "hunter-harness:start 最近变更 hunter-harness:end",
          decisions: ["hunter-harness:start 规则候选 hunter-harness:end"]
        }]
      }
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(JSON.stringify(response.json())).not.toMatch(/hunter-harness:(?:start|end)/iu);
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
    await uploadServerOwnedChange("archive-v1", { decision, schemaVersion: "2.2" });
    await uploadServerOwnedChange("archive-v2", { decision, schemaVersion: "2.3" });
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
