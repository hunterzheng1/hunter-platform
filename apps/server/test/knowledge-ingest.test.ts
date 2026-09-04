import { uuidV7 } from "@hunter-harness/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/app.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { SemanticMemoryStore } from "../src/semantic/memory-store.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

// 归档日期用当天：judge 的 age penalty 按日历天数扣分，固定日期会让
// auto-promote 断言在约 22 天后随日历漂移失败（2026-08-29 起实锤）。
const TODAY = new Date().toISOString().slice(0, 10);

function entry(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    projectId: "local",
    type: "decision",
    status: "candidate",
    title: `Decision ${id}`,
    summary: `Summary for ${id}`,
    body: `Body for ${id}: use scrypt for password hashing.`,
    keywords: ["auth", "scrypt"],
    source: {
      archive: `${TODAY}-auth-change`,
      summaryData: "reports/final/summary-data.json",
      summarySha256: "sha256:" + "0".repeat(64),
      sourceCommit: "abc1234",
      baseCommit: "def5678",
      changeName: "auth-change",
      finalStatus: "OK"
    },
    scope: { sourceFiles: ["apps/server/src/auth/accounts.ts"] },
    lifecycle: {
      createdAt: `${TODAY}T00:00:00Z`,
      verifiedAt: `${TODAY}T00:00:00Z`,
      lastCheckedAt: `${TODAY}T00:00:00Z`,
      confidence: "medium",
      supersedes: [],
      supersededBy: null,
      conflictsWith: [],
      staleReasons: []
    },
    ...overrides
  };
}

describe("server-side knowledge ingest (P3)", () => {
  let repository: MemoryRepository;
  let semanticStore: SemanticMemoryStore;
  let app: Awaited<ReturnType<typeof createServer>>;
  let projectId: string;

  beforeEach(async () => {
    repository = new MemoryRepository();
    semanticStore = new SemanticMemoryStore();
    await repository.createActorWithToken({ actorId: "actor_owner", token: "api-token" });
    app = await createServer({
      repository,
      storage: new MemoryArtifactStorage(),
      semanticStore
    });
    const resolved = await repository.resolveProject({
      actorId: "actor_owner",
      localProjectKey: uuidV7(),
      displayName: "Ingest Project",
      requestedProjectId: null
    });
    projectId = resolved.project.projectId;
  });

  afterEach(async () => {
    await app.close();
  });

  async function ingest(entries: Record<string, unknown>[]) {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/knowledge/ingest`,
      headers: { authorization: "Bearer api-token" },
      payload: { schema_version: 1, entries }
    });
    return { statusCode: response.statusCode, body: response.json() as Record<string, unknown> };
  }

  it("accepts entries idempotently with content-hash dedupe", async () => {
    const first = await ingest([entry("kn-001"), entry("kn-002")]);
    expect(first.statusCode).toBe(202);
    expect(first.body.created).toBe(2);

    const again = await ingest([entry("kn-001")]);
    expect(again.statusCode).toBe(202);
    expect(again.body.created).toBe(0);
    expect(again.body.duplicates).toBe(1);

    const changed = await ingest([entry("kn-001", { body: "Revised body." })]);
    expect(changed.body.updated).toBe(1);
    expect(changed.body.duplicates).toBe(0);
  });

  it("projects ingested entries into the semantic index asynchronously", async () => {
    await ingest([entry("kn-100", { status: "active" })]);
    // Fire-and-forget projection: give the microtask a tick to settle.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const documents = await semanticStore.listByKinds(projectId, ["knowledge_entry"]);
    expect(documents).toHaveLength(1);
    expect(documents[0]?.artifact_id).toBe("ingest");
    expect(documents[0]?.title).toBe("Decision kn-100");
    expect(documents[0]?.metadata.entry_id).toBe("kn-100");
  });

  it("keeps ingest-projected documents across a push-triggered rebuild", async () => {
    await ingest([entry("kn-200", { status: "active" })]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await semanticStore.rebuild({
      project_id: projectId,
      artifact_id: "art_push",
      documents: [],
      edges: []
    });
    const documents = await semanticStore.listByKinds(projectId, ["knowledge_entry"]);
    expect(documents.map((document) => document.metadata.entry_id)).toEqual(["kn-200"]);
  });

  it("auto-promotes high-confidence candidates on ingest", async () => {
    await ingest([entry("kn-300")]);
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/knowledge/entries?status=active`,
      headers: { authorization: "Bearer api-token" }
    });
    expect(list.statusCode).toBe(200);
    const items = (list.json() as { items: Array<Record<string, unknown>> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.entry_id).toBe("kn-300");

    await new Promise((resolve) => setTimeout(resolve, 20));
    const documents = await semanticStore.listByKinds(projectId, ["knowledge_entry"]);
    expect(documents[0]?.metadata.status).toBe("active");
  });

  it("keeps deprecated sticky across content upserts and excludes from search", async () => {
    await ingest([entry("kn-dep")]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const docs = await semanticStore.listByKinds(projectId, ["knowledge_entry"]);
    const documentId = docs[0]?.document_id;
    expect(documentId).toBeTruthy();

    const deprecate = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/semantic/knowledge/${documentId}/deprecate`,
      headers: { authorization: "Bearer api-token" }
    });
    expect(deprecate.statusCode).toBe(200);

    await ingest([entry("kn-dep", { body: "Revised body after deprecate." })]);
    const listed = await repository.listKnowledgeEntries({
      projectId,
      status: "deprecated",
      limit: 10
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe("deprecated");

    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = await semanticStore.listByKinds(projectId, ["knowledge_entry"]);
    expect(after.find((doc) => doc.metadata.entry_id === "kn-dep")).toBeUndefined();
  });

  it("rejects invalid entry payloads", async () => {
    const response = await ingest([{ id: "broken" }]);
    expect(response.statusCode).toBe(400);
  });

  it("enforces knowledge:write scope for project API keys", async () => {
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { username: "owner", password: "password123" }
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "owner", password: "password123" }
    });
    const sessionToken = (login.json() as { token: string }).token;

    async function issueKey(scopes: string[]): Promise<string> {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/api-keys`,
        headers: { authorization: `Bearer ${sessionToken}` },
        payload: { label: "ci", scopes }
      });
      expect(response.statusCode).toBe(201);
      return (response.json() as { api_key: string }).api_key;
    }

    async function ingestWithKey(key: string): Promise<number> {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/knowledge/ingest`,
        headers: { authorization: `Bearer ${key}` },
        payload: { schema_version: 1, entries: [entry("kn-400")] }
      });
      return response.statusCode;
    }

    expect(await ingestWithKey(await issueKey(["files:read"]))).toBe(403);
    expect(await ingestWithKey(await issueKey(["knowledge:write"]))).toBe(202);
  });
});
