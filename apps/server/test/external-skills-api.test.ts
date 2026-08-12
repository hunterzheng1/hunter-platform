import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { uuidV7, type LlmClient, type LlmPrompt, type LlmResponse } from "@hunter-harness/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/app.js";
import type { RegistryPersistence } from "../src/registry/persistence.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

class MemoryPersistence implements RegistryPersistence {
  snapshot: unknown = null;
  async load(): Promise<unknown | null> { return this.snapshot; }
  async save(snapshot: unknown): Promise<void> { this.snapshot = structuredClone(snapshot); }
}

function fakeNpmFetch(version: string, readme = "# Widget\nInstall me."): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.includes("registry.npmjs.org")) {
      return new Response(JSON.stringify({
        name: "@acme/widget",
        description: "A widget skill",
        license: "MIT",
        homepage: "https://example.com/widget",
        license: "MIT",
        homepage: "https://example.com/widget",
        readme,
        "dist-tags": { latest: version }
      }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
}

class FakeLlmClient implements LlmClient {
  constructor(private readonly fn: (prompt: LlmPrompt) => Promise<LlmResponse>) {}
  analyze(prompt: LlmPrompt): Promise<LlmResponse> { return this.fn(prompt); }
}

describe("/api/v1/external-skills", () => {
  const token = "external-owner-token";
  let repository: MemoryRepository;
  let persistence: MemoryPersistence;
  let app: Awaited<ReturnType<typeof createServer>>;
  let secretFile: string;
  let llmFn: (prompt: LlmPrompt) => Promise<LlmResponse>;

  beforeEach(async () => {
    repository = new MemoryRepository();
    persistence = new MemoryPersistence();
    await repository.createActorWithToken({ actorId: "actor_owner", token });
    secretFile = path.join(os.tmpdir(), `hh-external-summary-${uuidV7()}.json`);
    await fs.writeFile(secretFile, JSON.stringify({ deepseek: { apiKey: "sk-test-external" } }), "utf8");
    llmFn = async () => ({
      content: JSON.stringify({
        overview: "用于构建和查询代码知识图谱。",
        use_cases: ["分析大型代码库"],
        capabilities: ["索引代码关系"],
        quick_start: [
          {
            title: "安装并初始化",
            instruction: "安装后进入项目根目录构建索引。",
            commands: ["npm install -g @acme/widget", "widget init --index"]
          }
        ],
        caveats: ["首次使用前需要建立索引"]
      }),
      usage: { requests: 1, tokens: 120, input_tokens: 100, output_tokens: 20 }
    });
    app = await createServer({
      repository,
      storage: new MemoryArtifactStorage(),
      registryPersistence: persistence,
      config: { externalSkillRefreshIntervalMs: 0, aiSecretFile: secretFile },
      externalFetch: fakeNpmFetch("1.0.0"),
      aiLlmClientFactory: () => new FakeLlmClient((prompt) => llmFn(prompt))
    });
  });

  afterEach(async () => {
    await app.close();
    await fs.rm(secretFile, { force: true });
  });

  function headers(): Record<string, string> {
    return {
      authorization: "Bearer " + token,
      "x-request-id": uuidV7(),
      "idempotency-key": uuidV7()
    };
  }

  it("keeps legacy notes compatible while checking and applying an upstream update", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/external-skills",
      headers: headers(),
      payload: {
        source: { type: "npm", ref: "@acme/widget" },
        curationNote: "Owner picked this for SAP mapping",
        tags: ["sap"]
      }
    });
    expect(created.statusCode).toBe(201);
    const skill = created.json() as {
      id: string;
      curationNote: string;
      snapshot: { version: string | null };
      updateAvailable: boolean;
      revision: number;
    };
    expect(skill.curationNote).toBe("Owner picked this for SAP mapping");
    expect(skill.snapshot.version).toBe("1.0.0");
    expect(skill.updateAvailable).toBe(false);

    const listed = await app.inject({ method: "GET", url: "/api/v1/external-skills", headers: headers() });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { items: unknown[] }).items).toHaveLength(1);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/external-skills/${skill.id}`,
      headers: headers(),
      payload: { curationNote: "Still the best pick", tags: ["code-intelligence", "sap"], revision: skill.revision }
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { curationNote: string }).curationNote).toBe("Still the best pick");
    expect((patched.json() as { tags: string[] }).tags).toEqual(["code-intelligence", "sap"]);

    await app.close();
    app = await createServer({
      repository,
      storage: new MemoryArtifactStorage(),
      registryPersistence: persistence,
      config: { externalSkillRefreshIntervalMs: 0 },
      externalFetch: fakeNpmFetch("2.0.0")
    });

    const checked = await app.inject({
      method: "POST",
      url: `/api/v1/external-skills/${skill.id}/check-upstream`,
      headers: headers()
    });
    expect(checked.statusCode).toBe(200);
    expect(checked.json()).toMatchObject({
      curationNote: "Still the best pick",
      snapshot: { version: "1.0.0" },
      updateAvailable: true,
      availableVersion: "2.0.0"
    });

    const refreshed = await app.inject({
      method: "POST",
      url: `/api/v1/external-skills/${skill.id}/refresh`,
      headers: headers()
    });
    expect(refreshed.statusCode).toBe(200);
    const after = refreshed.json() as {
      curationNote: string;
      snapshot: { version: string | null };
      updateAvailable: boolean;
      revision: number;
    };
    expect(after.curationNote).toBe("Still the best pick");
    expect(after.snapshot.version).toBe("2.0.0");
    expect(after.updateAvailable).toBe(false);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/external-skills/${skill.id}`,
      headers: headers()
    });
    expect(deleted.statusCode).toBe(200);
    expect((deleted.json() as { deleted: boolean }).deleted).toBe(true);
  });

  it("loads snapshots without externalSkills as empty list", async () => {
    persistence.snapshot = {
      schemaVersion: 4,
      compilerVersion: "1.0.0",
      skills: [],
      proposals: [],
      tags: [],
      projectBindings: [],
      drafts: [],
      workflowFamilies: [],
      workflowFamilyDrafts: [],
      aiConfig: { defaultProvider: null, providers: [], usage: [] }
    };
    await app.close();
    app = await createServer({
      repository,
      storage: new MemoryArtifactStorage(),
      registryPersistence: persistence,
      config: { externalSkillRefreshIntervalMs: 0 },
      externalFetch: fakeNpmFetch("1.0.0")
    });
    const listed = await app.inject({ method: "GET", url: "/api/v1/external-skills", headers: headers() });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { items: unknown[] }).items).toEqual([]);
  });

  it("persists a manually arranged skill catalog order with revision protection", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/external-skills",
      headers: headers(),
      payload: { source: { type: "npm", ref: "@acme/widget" } }
    });
    const skill = created.json() as { id: string };

    const initial = await app.inject({
      method: "GET",
      url: "/api/v1/skill-catalog/order",
      headers: headers()
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ items: [], revision: 0, updated_at: null });

    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/skill-catalog/order",
      headers: headers(),
      payload: { items: [`external:${skill.id}`], revision: 0 }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ items: [`external:${skill.id}`], revision: 1 });

    const stale = await app.inject({
      method: "PUT",
      url: "/api/v1/skill-catalog/order",
      headers: headers(),
      payload: { items: [], revision: 0 }
    });
    expect(stale.statusCode).toBe(409);

    await app.close();
    app = await createServer({
      repository,
      storage: new MemoryArtifactStorage(),
      registryPersistence: persistence,
      config: { externalSkillRefreshIntervalMs: 0 },
      externalFetch: fakeNpmFetch("1.0.0")
    });
    const restored = await app.inject({
      method: "GET",
      url: "/api/v1/skill-catalog/order",
      headers: headers()
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ items: [`external:${skill.id}`], revision: 1 });
  });

  it("checks upstream without replacing the snapshot, then applies the update while preserving the versioned summary", async () => {
    const createdProvider = await app.inject({
      method: "POST",
      url: "/api/v1/ai-config/providers",
      headers: headers(),
      payload: {
        schema_version: 1,
        provider_id: "deepseek",
        label: "DeepSeek",
        base_url: "https://api.deepseek.com",
        model: "deepseek-chat",
        enabled: true,
        api_key_env: "secret-file",
        is_default: true
      }
    });
    expect(createdProvider.statusCode).toBe(201);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/external-skills",
      headers: headers(),
      payload: { source: { type: "npm", ref: "@acme/widget" } }
    });
    const skill = created.json() as { id: string; revision: number; aiSummary?: unknown };
    expect(skill.aiSummary ?? null).toBeNull();

    const generated = await app.inject({
      method: "POST",
      url: `/api/v1/external-skills/${skill.id}/summary`,
      headers: headers(),
      payload: { revision: skill.revision }
    });
    expect(generated.statusCode).toBe(200);
    const summarized = generated.json() as {
      revision: number;
      aiSummary: {
        overview: string;
        provider_id: string;
        source_sha256: string;
        quick_start: Array<{ title: string; commands: string[] }>;
      };
    };
    expect(summarized.aiSummary.overview).toBe("用于构建和查询代码知识图谱。");
    expect(summarized.aiSummary.provider_id).toBe("deepseek");
    expect(summarized.aiSummary.source_sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(summarized.aiSummary.quick_start).toEqual([
      {
        title: "安装并初始化",
        instruction: "安装后进入项目根目录构建索引。",
        commands: ["npm install -g @acme/widget", "widget init --index"]
      }
    ]);

    llmFn = async () => { throw new Error("cache should avoid another LLM call"); };
    const cached = await app.inject({
      method: "POST",
      url: `/api/v1/external-skills/${skill.id}/summary`,
      headers: headers(),
      payload: { revision: summarized.revision }
    });
    expect(cached.statusCode).toBe(200);
    expect((cached.json() as { aiSummary: { overview: string } }).aiSummary.overview)
      .toBe("用于构建和查询代码知识图谱。");

    await app.close();
    app = await createServer({
      repository,
      storage: new MemoryArtifactStorage(),
      registryPersistence: persistence,
      config: { externalSkillRefreshIntervalMs: 0, aiSecretFile: secretFile },
      externalFetch: fakeNpmFetch("1.0.0", "# Widget\nThe README changed."),
      aiLlmClientFactory: () => new FakeLlmClient((prompt) => llmFn(prompt))
    });
    const checked = await app.inject({
      method: "POST",
      url: `/api/v1/external-skills/${skill.id}/check-upstream`,
      headers: headers()
    });
    expect(checked.statusCode).toBe(200);
    expect(checked.json()).toMatchObject({
      snapshot: { version: "1.0.0" },
      updateAvailable: true,
      availableVersion: "1.0.0",
      aiSummary: { overview: "用于构建和查询代码知识图谱。", source_version: "1.0.0" }
    });

    const refreshed = await app.inject({
      method: "POST",
      url: `/api/v1/external-skills/${skill.id}/refresh`,
      headers: headers()
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({
      snapshot: { version: "1.0.0" },
      updateAvailable: false,
      availableVersion: null,
      aiSummary: { overview: "用于构建和查询代码知识图谱。", source_version: "1.0.0" },
      updateHistory: [{
        from_version: "1.0.0",
        to_version: "1.0.0",
        changes: ["上游说明文档已更新"]
      }]
    });
  });

  it("records readable upstream changes only after the user applies a newer version", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/external-skills",
      headers: headers(),
      payload: { source: { type: "npm", ref: "@acme/widget" } }
    });
    const skill = created.json() as { id: string };

    await app.close();
    app = await createServer({
      repository,
      storage: new MemoryArtifactStorage(),
      registryPersistence: persistence,
      config: { externalSkillRefreshIntervalMs: 0 },
      externalFetch: fakeNpmFetch("2.0.0", "# Widget\nNew setup and examples.")
    });

    const checked = await app.inject({
      method: "POST",
      url: `/api/v1/external-skills/${skill.id}/check-upstream`,
      headers: headers()
    });
    expect(checked.json()).toMatchObject({
      snapshot: { version: "1.0.0" },
      availableVersion: "2.0.0",
      updateAvailable: true
    });

    const applied = await app.inject({
      method: "POST",
      url: `/api/v1/external-skills/${skill.id}/refresh`,
      headers: headers()
    });
    expect(applied.json()).toMatchObject({
      snapshot: { version: "2.0.0" },
      updateAvailable: false,
      availableVersion: null,
      updateHistory: [{
        from_version: "1.0.0",
        to_version: "2.0.0",
        changes: expect.arrayContaining(["版本由 1.0.0 更新为 2.0.0", "上游说明文档已更新"])
      }]
    });
  });

  it("records every intermediate npm version when one refresh crosses multiple releases", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/external-skills",
      headers: headers(),
      payload: { source: { type: "npm", ref: "@acme/widget" } }
    });
    const skill = created.json() as { id: string };

    await app.close();
    app = await createServer({
      repository,
      storage: new MemoryArtifactStorage(),
      registryPersistence: persistence,
      config: { externalSkillRefreshIntervalMs: 0 },
      externalFetch: async (input) => {
        if (!String(input).includes("registry.npmjs.org")) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify({
          name: "@acme/widget",
          description: "A widget skill",
          readme: "# Widget\nLatest usage.",
          "dist-tags": { latest: "1.2.0" },
          time: {
            "1.0.0": "2026-01-01T00:00:00.000Z",
            "1.1.0": "2026-02-01T00:00:00.000Z",
            "1.2.0": "2026-03-01T00:00:00.000Z"
          },
          versions: {
            "1.0.0": { name: "@acme/widget", version: "1.0.0", description: "Initial" },
            "1.1.0": { name: "@acme/widget", version: "1.1.0", description: "Adds batch mode" },
            "1.2.0": { name: "@acme/widget", version: "1.2.0", description: "Improves retries" }
          }
        }), { status: 200 });
      }
    });

    const applied = await app.inject({
      method: "POST",
      url: `/api/v1/external-skills/${skill.id}/refresh`,
      headers: headers()
    });

    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({
      updateHistory: [{
        from_version: "1.0.0",
        to_version: "1.2.0",
        releases: [
          {
            version: "1.1.0",
            published_at: "2026-02-01T00:00:00.000Z",
            changes: ["上游未提供该版本的独立发布说明（包简介：Adds batch mode）"]
          },
          {
            version: "1.2.0",
            published_at: "2026-03-01T00:00:00.000Z",
            changes: ["上游未提供该版本的独立发布说明（包简介：Improves retries）"]
          }
        ]
      }]
    });
  });

  it("checks only update availability and refreshes a historical update note explicitly", async () => {
    const provider = await app.inject({
      method: "POST",
      url: "/api/v1/ai-config/providers",
      headers: headers(),
      payload: {
        schema_version: 1,
        provider_id: "deepseek",
        label: "DeepSeek",
        base_url: "https://api.deepseek.com",
        model: "deepseek-chat",
        enabled: true,
        api_key_env: "secret-file",
        is_default: true
      }
    });
    expect(provider.statusCode).toBe(201);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/external-skills",
      headers: headers(),
      payload: { source: { type: "npm", ref: "@acme/widget" } }
    });
    const skill = created.json() as { id: string };
    const persisted = persistence.snapshot as { externalSkills: Array<[string, Record<string, unknown>]> };
    const entry = persisted.externalSkills.find(([id]) => id === skill.id)?.[1];
    expect(entry).toBeDefined();
    if (entry !== undefined) {
      entry.updateHistory = [{
        from_version: "0.9.0",
        to_version: "1.0.0",
        applied_at: "2026-01-02T00:00:00.000Z",
        source_url: "https://www.npmjs.com/package/@acme/widget",
        changes: ["版本由 0.9.0 更新为 1.0.0"]
      }];
    }

    await app.close();
    llmFn = async () => ({
      content: JSON.stringify({ changes: ["完善组件能力", "改进使用说明"] }),
      usage: { requests: 1, input_tokens: 40, output_tokens: 12 }
    });
    app = await createServer({
      repository,
      storage: new MemoryArtifactStorage(),
      registryPersistence: persistence,
      config: { externalSkillRefreshIntervalMs: 0, aiSecretFile: secretFile },
      aiLlmClientFactory: () => new FakeLlmClient((prompt) => llmFn(prompt)),
      externalFetch: async () => new Response(JSON.stringify({
        name: "@acme/widget",
        description: "A widget skill",
        license: "MIT",
        homepage: "https://example.com/widget",
        readme: "# Widget\nInstall me.",
        "dist-tags": { latest: "1.0.0" },
        time: { "0.9.0": "2025-12-01T00:00:00.000Z", "1.0.0": "2026-01-01T00:00:00.000Z" },
        versions: {
          "0.9.0": { name: "@acme/widget", version: "0.9.0", description: "Preview" },
          "1.0.0": { name: "@acme/widget", version: "1.0.0", description: "A widget skill" }
        }
      }), { status: 200 })
    });

    const checked = await app.inject({
      method: "POST",
      url: `/api/v1/external-skills/${skill.id}/check-upstream`,
      headers: headers()
    });
    expect(checked.statusCode).toBe(200);
    expect(checked.json()).toMatchObject({
      updateHistory: [{
        from_version: "0.9.0",
        to_version: "1.0.0",
        releases: []
      }]
    });

    const refreshed = await app.inject({
      method: "POST",
      url: `/api/v1/external-skills/${skill.id}/update-history/refresh`,
      headers: headers(),
      payload: { applied_at: "2026-01-02T00:00:00.000Z" }
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({
      updateHistory: [{
        from_version: "0.9.0",
        to_version: "1.0.0",
        changes: ["完善组件能力", "改进使用说明"],
        releases: [{ version: "1.0.0", changes: ["上游未提供该版本的独立发布说明（包简介：A widget skill）"] }]
      }]
    });
  });

  it("repairs one malformed summary response and never retries more than once", async () => {
    const createdProvider = await app.inject({
      method: "POST",
      url: "/api/v1/ai-config/providers",
      headers: headers(),
      payload: {
        schema_version: 1,
        provider_id: "deepseek",
        label: "DeepSeek",
        base_url: "https://api.deepseek.com",
        model: "deepseek-chat",
        enabled: true,
        api_key_env: "secret-file",
        is_default: true
      }
    });
    expect(createdProvider.statusCode).toBe(201);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/external-skills",
      headers: headers(),
      payload: { source: { type: "npm", ref: "@acme/widget" } }
    });
    const skill = created.json() as { id: string; revision: number };
    const prompts: LlmPrompt[] = [];
    llmFn = async (prompt) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        return { content: "这不是结构化摘要", usage: { requests: 1, tokens: 10 } };
      }
      return {
        content: JSON.stringify({
          overview: "用于构建和查询代码知识图谱。",
          use_cases: ["分析大型代码库"],
          capabilities: ["索引代码关系"],
          getting_started: [],
          caveats: []
        }),
        usage: { requests: 1, tokens: 20 }
      };
    };

    const generated = await app.inject({
      method: "POST",
      url: `/api/v1/external-skills/${skill.id}/summary`,
      headers: headers(),
      payload: { revision: skill.revision }
    });

    expect(generated.statusCode).toBe(200);
    expect((generated.json() as { aiSummary: { overview: string } }).aiSummary.overview)
      .toBe("用于构建和查询代码知识图谱。");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]?.user).toContain("<invalid_summary>");
  });

  it("returns a parse error after exactly one unsuccessful repair attempt", async () => {
    const createdProvider = await app.inject({
      method: "POST",
      url: "/api/v1/ai-config/providers",
      headers: headers(),
      payload: {
        schema_version: 1,
        provider_id: "deepseek",
        label: "DeepSeek",
        base_url: "https://api.deepseek.com",
        model: "deepseek-chat",
        enabled: true,
        api_key_env: "secret-file",
        is_default: true
      }
    });
    expect(createdProvider.statusCode).toBe(201);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/external-skills",
      headers: headers(),
      payload: { source: { type: "npm", ref: "@acme/widget" } }
    });
    const skill = created.json() as { id: string; revision: number };
    let calls = 0;
    llmFn = async () => {
      calls += 1;
      return { content: "仍然不是 JSON", usage: { requests: 1, tokens: 10 } };
    };

    const generated = await app.inject({
      method: "POST",
      url: `/api/v1/external-skills/${skill.id}/summary`,
      headers: headers(),
      payload: { revision: skill.revision }
    });

    expect(generated.statusCode).toBe(502);
    expect(generated.json().error.code).toBe("AI_PARSE_FAILED");
    expect(calls).toBe(2);
  });

  it("rejects unauthenticated access", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/external-skills" });
    expect(response.statusCode).toBe(401);
  });
});
