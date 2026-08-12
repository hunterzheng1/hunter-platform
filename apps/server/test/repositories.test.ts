import { describe, expect, it } from "vitest";

import { MemoryRepository } from "../src/repositories/memory.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve: () => resolve?.() };
}

describe("repositories", () => {
  it("MemoryRepository.withTransaction rolls registry, audit and idempotency state back together", async () => {
    const repo = new MemoryRepository();
    await repo.saveRegistryState({ revision: 1 });
    await expect(repo.withTransaction(async (tx) => {
      await tx.saveRegistryState({ revision: 2 });
      await tx.appendAudit({
        actorId: "actor_owner",
        projectId: null,
        action: "workflow.family.published",
        targetId: "harness",
        requestId: "00000000-0000-4000-8000-000000000001",
        details: {}
      });
      await tx.putIdempotency({
        actorId: "actor_owner",
        method: "POST",
        path: "/api/v1/workflow-families/harness/publish",
        key: "publish-key",
        bodyHash: "sha256:" + "a".repeat(64),
        statusCode: 200,
        response: { version: "1.0.0" }
      });
      throw new Error("rollback");
    })).rejects.toThrow("rollback");

    expect(await repo.loadRegistryState()).toEqual({ revision: 1 });
    expect(await repo.listAuditEvents({ actorId: "actor_owner", limit: 10 })).toEqual([]);
    expect(await repo.getIdempotency({
      actorId: "actor_owner",
      method: "POST",
      path: "/api/v1/workflow-families/harness/publish",
      key: "publish-key"
    })).toBeNull();
  });

  it("does not erase a concurrent idempotency write when a transaction rolls back", async () => {
    const repo = new MemoryRepository();
    const entered = deferred();
    const release = deferred();
    const transaction = repo.withTransaction(async (tx) => {
      await tx.saveRegistryState({ revision: 2 });
      entered.resolve();
      await release.promise;
      throw new Error("rollback");
    });
    await entered.promise;
    const record = {
      actorId: "actor_owner",
      method: "POST",
      path: "/api/v1/unrelated",
      key: "unrelated-key",
      bodyHash: "sha256:" + "b".repeat(64),
      statusCode: 201,
      response: { ok: true }
    };
    await repo.putIdempotency(record);
    release.resolve();
    await expect(transaction).rejects.toThrow("rollback");
    expect(await repo.getIdempotency(record)).toEqual(record);
  });
});
