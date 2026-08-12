import type { AgentToolMutation } from "@hunter-harness/contracts";
import { uuidV7 } from "@hunter-harness/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createServer } from "../src/app.js";
import type { RegistryPersistence } from "../src/registry/persistence.js";
import { RegistryStore } from "../src/registry/store.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

const token = "agent-tools-owner-token";

function repositoryPersistence(repository: MemoryRepository): RegistryPersistence {
  return {
    load: (tx) => (tx ?? repository).loadRegistryState(),
    save: (snapshot, tx) => (tx ?? repository).saveRegistryState(snapshot)
  };
}

function agentToolPayload(slug: string) {
  return {
    schema_version: 1 as const,
    slug,
    displayName: slug === "pi-coding-agent" ? "Pi Coding Agent" : "Hunter Harness",
    description: "A peer Agent Tool used to exercise registry persistence.",
    category: "runtime" as const,
    status: "active" as const,
    source: {
      type: "github" as const,
      ref: slug === "pi-coding-agent"
        ? "https://github.com/earendil-works/pi/tree/main/packages/coding-agent"
        : "https://github.com/hunterzheng1/Hunter-Harness"
    },
    homepage: null,
    packageName: null,
    installCommand: null,
    tags: ["agent-tool"],
    relatedWorkflowFamilies: []
  };
}

function agentToolStoreInput(slug: string): AgentToolMutation {
  const input = { ...agentToolPayload(slug) } as Record<string, unknown>;
  delete input.schema_version;
  return input as AgentToolMutation;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve?.() };
}

describe("agent tools registry API", () => {
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    const repository = new MemoryRepository();
    await repository.createActorWithToken({ actorId: "actor_owner", token });
    app = await createServer({ repository, storage: new MemoryArtifactStorage() });
  });

  afterEach(async () => app.close());

  function headers(): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      "x-request-id": uuidV7(),
      "idempotency-key": uuidV7()
    };
  }

  it("registers a peer Agent Tool and preserves its exact GitHub subdirectory source", async () => {
    const sourceRef = "https://github.com/earendil-works/pi/tree/main/packages/coding-agent";
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/agent-tools",
      headers: headers(),
      payload: {
        schema_version: 1,
        slug: "pi-coding-agent",
        displayName: "Pi Coding Agent",
        description: "A coding agent package inside the Pi monorepo.",
        category: "runtime",
        status: "active",
        source: { type: "github", ref: sourceRef },
        homepage: "https://github.com/earendil-works/pi",
        packageName: "@mariozechner/pi-coding-agent",
        installCommand: "npm install @mariozechner/pi-coding-agent",
        tags: ["coding-agent", "pi"],
        relatedWorkflowFamilies: []
      }
    });

    expect(create.statusCode).toBe(201);
    expect(create.json()).toMatchObject({
      slug: "pi-coding-agent",
      category: "runtime",
      source: { type: "github", ref: sourceRef }
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/agent-tools",
      headers: headers()
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0].source.ref).toBe(sourceRef);

    const detail = await app.inject({
      method: "GET",
      url: "/api/v1/agent-tools/pi-coding-agent",
      headers: headers()
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().displayName).toBe("Pi Coding Agent");
  });

  it("rejects duplicate Agent Tool slugs", async () => {
    const payload = {
      schema_version: 1,
      slug: "hunter-harness",
      displayName: "Hunter Harness",
      description: "Local harness and governed workflow runtime.",
      category: "harness",
      status: "active",
      source: { type: "github", ref: "https://github.com/hunterzheng1/Hunter-Harness" },
      tags: ["harness"],
      relatedWorkflowFamilies: ["harness"]
    };
    const first = await app.inject({ method: "POST", url: "/api/v1/agent-tools", headers: headers(), payload });
    const duplicate = await app.inject({ method: "POST", url: "/api/v1/agent-tools", headers: headers(), payload });

    expect(first.statusCode).toBe(201);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("AGENT_TOOL_EXISTS");
  });

  it("rolls back the in-memory Agent Tool when persistence fails", async () => {
    const persistence = {
      load: vi.fn(async () => null),
      save: vi.fn(async () => { throw new Error("persistence unavailable"); })
    };
    const store = new RegistryStore(new MemoryArtifactStorage(), persistence);
    await store.initialize();

    await expect(store.createAgentTool({
      slug: "pi-coding-agent",
      displayName: "Pi Coding Agent",
      description: "A coding agent package inside the Pi monorepo.",
      category: "runtime",
      status: "active",
      source: { type: "github", ref: "https://github.com/earendil-works/pi/tree/main/packages/coding-agent" },
      homepage: "https://github.com/earendil-works/pi",
      packageName: "@mariozechner/pi-coding-agent",
      installCommand: "npm install @mariozechner/pi-coding-agent",
      tags: ["coding-agent", "pi"],
      relatedWorkflowFamilies: []
    })).rejects.toThrow("persistence unavailable");
    expect(store.listAgentTools()).toEqual([]);
  });

  it("serializes concurrent registrations so the durable snapshot contains both tools", async () => {
    await app.close();
    const repository = new MemoryRepository();
    await repository.createActorWithToken({ actorId: "actor_owner", token });
    const persistence = repositoryPersistence(repository);
    app = await createServer({
      repository,
      storage: new MemoryArtifactStorage(),
      registryPersistence: persistence
    });

    const [first, second] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/v1/agent-tools",
        headers: headers(),
        payload: agentToolPayload("pi-coding-agent")
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/agent-tools",
        headers: headers(),
        payload: agentToolPayload("hunter-harness")
      })
    ]);

    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    const reloaded = new RegistryStore(new MemoryArtifactStorage(), persistence);
    await reloaded.initialize();
    expect(reloaded.listAgentTools().map((tool) => tool.slug).sort()).toEqual([
      "hunter-harness",
      "pi-coding-agent"
    ]);
  });

  it("prevents a delayed older Agent Tool snapshot from overwriting a newer registration", async () => {
    const firstSaveStarted = deferred();
    const releaseFirstSave = deferred();
    const snapshots: unknown[] = [];
    let saveCalls = 0;
    const persistence: RegistryPersistence = {
      load: async () => null,
      save: async (snapshot) => {
        saveCalls += 1;
        if (saveCalls === 1) {
          firstSaveStarted.resolve();
          await releaseFirstSave.promise;
        }
        snapshots.push(structuredClone(snapshot));
      }
    };
    const store = new RegistryStore(new MemoryArtifactStorage(), persistence);
    await store.initialize();
    const firstInput = agentToolStoreInput("pi-coding-agent");
    const secondInput = agentToolStoreInput("hunter-harness");

    const first = store.createAgentTool(firstInput);
    await firstSaveStarted.promise;
    const second = store.createAgentTool(secondInput);
    await Promise.resolve();
    expect(saveCalls).toBe(1);
    releaseFirstSave.resolve();
    await Promise.all([first, second]);

    const durable = snapshots.at(-1) as { agentTools: Array<[string, unknown]> };
    expect(durable.agentTools.map(([slug]) => slug).sort()).toEqual([
      "hunter-harness",
      "pi-coding-agent"
    ]);
  });

  it("prevents an older Agent Tool snapshot from overwriting a legacy registry writer", async () => {
    const firstSaveStarted = deferred();
    const releaseFirstSave = deferred();
    const snapshots: unknown[] = [];
    let saveCalls = 0;
    const persistence: RegistryPersistence = {
      load: async () => null,
      save: async (snapshot) => {
        saveCalls += 1;
        if (saveCalls === 1) {
          firstSaveStarted.resolve();
          await releaseFirstSave.promise;
        }
        snapshots.push(structuredClone(snapshot));
      }
    };
    const store = new RegistryStore(new MemoryArtifactStorage(), persistence);
    await store.initialize();
    const toolInput = agentToolStoreInput("pi-coding-agent");

    const tool = store.createAgentTool(toolInput);
    await firstSaveStarted.promise;
    const reordered = store.updateSkillCatalogOrder({ items: [], revision: 0 });
    await Promise.resolve();
    expect(saveCalls).toBe(1);
    releaseFirstSave.resolve();
    await Promise.all([tool, reordered]);

    const durable = snapshots.at(-1) as {
      agentTools: Array<[string, unknown]>;
      skillCatalogOrder: { revision: number };
    };
    expect(durable.agentTools.map(([slug]) => slug)).toEqual(["pi-coding-agent"]);
    expect(durable.skillCatalogOrder.revision).toBe(1);
  });

  it("does not commit a queued legacy mutation through an earlier feature transaction", async () => {
    const featureEntered = deferred();
    const releaseFeature = deferred();
    const snapshots: unknown[] = [];
    let saveCalls = 0;
    const persistence: RegistryPersistence = {
      load: async () => snapshots.at(-1) ?? null,
      save: async (snapshot) => {
        saveCalls += 1;
        if (saveCalls === 2) throw new Error("legacy save failed");
        snapshots.push(structuredClone(snapshot));
      }
    };
    const store = new RegistryStore(new MemoryArtifactStorage(), persistence);
    await store.initialize();

    const feature = store.withFeatureMutation(async () => {
      featureEntered.resolve();
      await releaseFeature.promise;
      return store.createAgentTool(agentToolStoreInput("pi-coding-agent"));
    });
    await featureEntered.promise;
    const legacy = store.updateSkillCatalogOrder({ items: [], revision: 0 });
    await Promise.resolve();
    expect(store.getSkillCatalogOrder().revision).toBe(0);

    releaseFeature.resolve();
    await feature;
    await expect(legacy).rejects.toThrow("legacy save failed");

    const durable = snapshots.at(-1) as {
      agentTools: Array<[string, unknown]>;
      skillCatalogOrder: { revision: number };
    };
    expect(durable.agentTools.map(([slug]) => slug)).toEqual(["pi-coding-agent"]);
    expect(durable.skillCatalogOrder.revision).toBe(0);
  });

  it("rolls registry, audit, and idempotency back together when audit persistence fails", async () => {
    await app.close();
    const repository = new MemoryRepository();
    await repository.createActorWithToken({ actorId: "actor_owner", token });
    const withTransaction = repository.withTransaction.bind(repository);
    vi.spyOn(repository, "withTransaction").mockImplementationOnce((fn) =>
      withTransaction((tx) => fn({
        ...tx,
        appendAudit: async () => {
          throw new Error("audit unavailable");
        }
      }))
    );
    app = await createServer({
      repository,
      storage: new MemoryArtifactStorage(),
      registryPersistence: repositoryPersistence(repository)
    });
    const requestHeaders = headers();
    const request = {
      method: "POST" as const,
      url: "/api/v1/agent-tools",
      headers: requestHeaders,
      payload: agentToolPayload("pi-coding-agent")
    };

    const failed = await app.inject(request);
    expect(failed.statusCode).toBe(500);
    const empty = await app.inject({ method: "GET", url: "/api/v1/agent-tools", headers: headers() });
    expect(empty.json().items).toEqual([]);

    const retried = await app.inject(request);
    expect(retried.statusCode).toBe(201);
    expect((await repository.listAuditEvents({ actorId: "actor_owner", limit: 10 }))).toHaveLength(1);
  });

  it("rolls registry and audit back when the idempotency record cannot be committed", async () => {
    await app.close();
    const repository = new MemoryRepository();
    await repository.createActorWithToken({ actorId: "actor_owner", token });
    const withTransaction = repository.withTransaction.bind(repository);
    vi.spyOn(repository, "withTransaction").mockImplementationOnce((fn) =>
      withTransaction((tx) => fn({
        ...tx,
        putIdempotency: async () => {
          throw new Error("idempotency unavailable");
        }
      }))
    );
    app = await createServer({
      repository,
      storage: new MemoryArtifactStorage(),
      registryPersistence: repositoryPersistence(repository)
    });
    const requestHeaders = headers();
    const request = {
      method: "POST" as const,
      url: "/api/v1/agent-tools",
      headers: requestHeaders,
      payload: agentToolPayload("pi-coding-agent")
    };

    const failed = await app.inject(request);
    expect(failed.statusCode).toBe(500);
    expect((await repository.listAuditEvents({ actorId: "actor_owner", limit: 10 }))).toEqual([]);

    const retried = await app.inject(request);
    expect(retried.statusCode).toBe(201);
    expect((await repository.listAuditEvents({ actorId: "actor_owner", limit: 10 }))).toHaveLength(1);
  });
});
