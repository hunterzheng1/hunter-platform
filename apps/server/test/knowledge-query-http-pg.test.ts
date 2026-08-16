import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  knowledgeQueryHttpReceiptId,
  knowledgeQueryHttpResultSetHash,
  validateKnowledgeQueryHttpResponse,
  type KnowledgeQueryHttpRequest,
} from "@hunter-harness/contracts";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import {
  PgKnowledgeQueryHttpService,
  type KnowledgeQueryHttpQueryIndex
} from "../src/knowledge-query-http/pg.js";
import type { KnowledgeIndexQuery } from "../src/knowledge-pipeline/ports.js";
import type { KnowledgeResult } from "../src/knowledge-pipeline/types.js";

const now = "2026-08-15T01:02:03.000Z";
const projectId = "prj_query_fixture";
const actorId = "actor_query_fixture";
const queryText = "find durable receipts";
const queryHash = `sha256:${createHash("sha256").update(queryText).digest("hex")}`;

function request(overrides: Partial<KnowledgeQueryHttpRequest> = {}): KnowledgeQueryHttpRequest {
  return {
    schema_version: 1,
    project_id: projectId,
    query_id: `knowledge_query:${queryHash.slice("sha256:".length)}`,
    query_hash: queryHash,
    reason_code: "initial_intent",
    query: queryText,
    budget: { max_results: 3, max_total_summary_bytes: 4_096, deadline_ms: 5_000 },
    ...overrides
  };
}

function result(overrides: Partial<KnowledgeResult> = {}): KnowledgeResult {
  return {
    schema_version: 1,
    knowledge_id: "kn_query_fixture_1",
    project_id: projectId,
    content_kind: "knowledge_entry",
    status: "active",
    content_hash: `sha256:${"a".repeat(64)}`,
    display_title: "Durable receipt",
    summary: "Durable receipt summary",
    reusability_scope: "server",
    confidence: 0.9,
    source_archive_ids: ["arc_query_fixture"],
    source_change_keys: ["change-query-fixture"],
    source_candidate_ids: ["candidate-query-fixture"],
    source_refs: ["summary/change-summary.json#receipt"],
    extractor_version: "extractor-v1",
    prompt_version: "prompt-v1",
    index_schema_version: "knowledge-index-v1",
    generation: 7,
    created_at: now,
    updated_at: now,
    ...overrides
  };
}

function fakePool(options: {
  receipt?: Record<string, unknown>;
  forceReceipt?: boolean;
  project?: Record<string, unknown>;
  generation?: Record<string, unknown>;
} = {}): {
  pool: Pool;
  queries: Array<{ text: string; values?: readonly unknown[] }>;
  inserted: readonly unknown[] | undefined;
} {
  const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
  let inserted: readonly unknown[] | undefined;
  const client = {
    query: async (text: string, values?: readonly unknown[]) => {
      queries.push({ text, values });
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
      if (text.includes("set_config('statement_timeout'")) return { rows: [] };
      if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("FROM knowledge_query_http_receipts") && text.includes("FOR UPDATE")) {
        const requestedActor = values?.[0];
        const requestedProject = values?.[1];
        const requestedKey = values?.[2];
        const matches = options.receipt !== undefined && (options.forceReceipt === true ||
          options.receipt.actor_id === requestedActor &&
          options.receipt.project_id === requestedProject &&
          options.receipt.idempotency_key === requestedKey);
        return { rows: matches ? [options.receipt] : [] };
      }
      if (text.includes("FROM projects")) {
        const requestedProject = values?.[0];
        const requestedActor = values?.[1];
        const project = options.project ?? { project_id: projectId, owner_actor_id: actorId };
        if (project.project_id !== requestedProject || project.owner_actor_id !== requestedActor) return { rows: [] };
        return { rows: [project] };
      }
      if (text.includes("FROM knowledge_pipeline_project_fences")) {
        return { rows: options.generation === undefined ? [{ knowledge_generation: "7" }] : [options.generation] };
      }
      if (text.includes("INSERT INTO knowledge_query_http_receipts")) {
        inserted = values;
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
    release() { /* fake client */ }
  } as unknown as PoolClient;
  return {
    pool: { connect: async () => client } as unknown as Pool,
    queries,
    get inserted() { return inserted; }
  };
}

function indexStub(results: readonly KnowledgeResult[] | (() => Promise<readonly KnowledgeResult[]>)): {
  index: KnowledgeQueryHttpQueryIndex;
  calls: KnowledgeIndexQuery[];
  limits: number[];
} {
  const calls: KnowledgeIndexQuery[] = [];
  const limits: number[] = [];
  return {
    calls,
    limits,
    index: {
      query: async (input) => {
        calls.push(input);
        limits.push(input.limit);
        return typeof results === "function" ? results() : [...results];
      },
      queryWithClient: async (_client, input) => {
        calls.push(input);
        limits.push(input.limit);
        return typeof results === "function" ? results() : [...results];
      }
    }
  };
}

describe("PostgreSQL knowledge query HTTP service", () => {
  it("persists a canonical bounded response before returning a new outcome", async () => {
    const storage = fakePool();
    const index = indexStub([result()]);
    const service = new PgKnowledgeQueryHttpService(storage.pool, index.index, () => now);
    const input = request();
    const outcome = await service.execute({ request: input, actor_id: actorId, idempotency_key: "query-key-1" });

    expect(outcome.outcome).toBe("new");
    if (outcome.outcome === "new") {
      expect(validateKnowledgeQueryHttpResponse(outcome.value, input).success).toBe(true);
      expect(outcome.value.receipt.index_generation).toBe("knowledge_generation:7");
      expect(outcome.value.receipt.result_set_hash).toBe(knowledgeQueryHttpResultSetHash(outcome.value.receipt));
      expect(outcome.value.receipt.receipt_id).toBe(knowledgeQueryHttpReceiptId(outcome.value.receipt));
    }
    expect(index.calls[0]).toMatchObject({ project_id: projectId, query: queryText });
    expect(index.limits[0]).toBe(3);
    expect(storage.queries.some((query) => query.text.includes("FOR UPDATE"))).toBe(true);
    expect(storage.inserted).toBeDefined();
    expect(storage.inserted?.[4]).toBe(queryHash);
    expect(storage.inserted?.[5]).not.toBe(queryHash);
    expect(JSON.parse(String(storage.inserted?.[9]))).toMatchObject({ query_id: input.query_id });
  });

  it("serializes the advisory lock identity without PostgreSQL-invalid NUL bytes", async () => {
    const storage = fakePool();
    const index = indexStub([result()]);
    const service = new PgKnowledgeQueryHttpService(storage.pool, index.index, () => now);

    await expect(service.execute({
      request: request(),
      actor_id: actorId,
      idempotency_key: "query-key-lock"
    })).resolves.toMatchObject({ outcome: "new" });

    const advisory = storage.queries.find((query) => query.text.includes("pg_advisory_xact_lock"));
    expect(advisory).toBeDefined();
    const lockValue = advisory?.values?.[0];
    expect(typeof lockValue).toBe("string");
    expect(String(lockValue)).not.toContain("\0");
    expect(lockValue).toBe(JSON.stringify([actorId, projectId, "query-key-lock"]));
  });

  it("fails with a stable timeout when the index exceeds the request deadline", async () => {
    const storage = fakePool();
    const index = indexStub(() => new Promise<readonly KnowledgeResult[]>(() => { /* intentionally pending */ }));
    const service = new PgKnowledgeQueryHttpService(storage.pool, index.index, () => now);
    await expect(service.execute({
      request: request({ budget: { max_results: 3, max_total_summary_bytes: 4_096, deadline_ms: 10 } }),
      actor_id: actorId,
      idempotency_key: "query-key-timeout"
    })).rejects.toMatchObject({ code: "KNOWLEDGE_QUERY_TIMEOUT" });
  });

  it("stops a pending index query when the caller aborts", async () => {
    const storage = fakePool();
    const index = indexStub(() => new Promise<readonly KnowledgeResult[]>(() => { /* intentionally pending */ }));
    const service = new PgKnowledgeQueryHttpService(storage.pool, index.index, () => now);
    const controller = new AbortController();
    const pending = service.execute({
      request: request({ budget: { max_results: 3, max_total_summary_bytes: 4_096, deadline_ms: 1_000 } }),
      actor_id: actorId,
      idempotency_key: "query-key-abort",
      signal: controller.signal
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "KNOWLEDGE_QUERY_ABORTED" });
  });

  it("uses the receipt transaction client when the index exposes the production seam", async () => {
    const storage = fakePool();
    let transactionalCalls = 0;
    const index: KnowledgeQueryHttpQueryIndex = {
      query: async () => { throw new Error("non-transactional query must not run"); },
      queryWithClient: async (_client, input) => {
        transactionalCalls += 1;
        expect(input.project_id).toBe(projectId);
        return [];
      }
    };
    const service = new PgKnowledgeQueryHttpService(storage.pool, index, () => now);
    await expect(service.execute({
      request: request(),
      actor_id: actorId,
      idempotency_key: "query-key-transactional"
    })).resolves.toMatchObject({ outcome: "new" });
    expect(transactionalCalls).toBe(1);
  });

  it("maps PostgreSQL statement cancellation to the declared timeout error", async () => {
    const storage = fakePool();
    const index: KnowledgeQueryHttpQueryIndex = {
      query: async () => [],
      queryWithClient: async () => { throw { code: "57014" }; }
    };
    const service = new PgKnowledgeQueryHttpService(storage.pool, index, () => now);
    await expect(service.execute({
      request: request(),
      actor_id: actorId,
      idempotency_key: "query-key-sql-timeout"
    })).rejects.toMatchObject({ code: "KNOWLEDGE_QUERY_TIMEOUT" });
  });

  it("does not wait forever for an exhausted pool connection", async () => {
    const pool = {
      connect: () => new Promise<PoolClient>(() => { /* intentionally pending */ })
    } as unknown as Pool;
    const service = new PgKnowledgeQueryHttpService(pool, indexStub([result()]).index, () => now);
    await expect(service.execute({
      request: request({ budget: { max_results: 3, max_total_summary_bytes: 4_096, deadline_ms: 10 } }),
      actor_id: actorId,
      idempotency_key: "query-key-connect-timeout"
    })).rejects.toMatchObject({ code: "KNOWLEDGE_QUERY_TIMEOUT" });
  });

  it("destroys a client when BEGIN remains active past the deadline", async () => {
    let releaseArgument: unknown;
    const client = {
      query: async (text: string) => {
        if (text === "BEGIN") return await new Promise<never>(() => { /* intentionally pending */ });
        return { rows: [] };
      },
      release: (error?: unknown) => { releaseArgument = error; }
    } as unknown as PoolClient;
    const pool = { connect: async () => client } as unknown as Pool;
    const service = new PgKnowledgeQueryHttpService(pool, indexStub([result()]).index, () => now);
    await expect(service.execute({
      request: request({ budget: { max_results: 3, max_total_summary_bytes: 4_096, deadline_ms: 10 } }),
      actor_id: actorId,
      idempotency_key: "query-key-begin-timeout"
    })).rejects.toMatchObject({ code: "KNOWLEDGE_QUERY_TIMEOUT" });
    expect(releaseArgument).toBeInstanceOf(Error);
  });

  it("destroys a client when an in-transaction query remains active past the deadline", async () => {
    let releaseArgument: unknown;
    const client = {
      query: async (text: string) => {
        if (text.includes("pg_advisory_xact_lock")) return await new Promise<never>(() => { /* pending */ });
        return { rows: [] };
      },
      release: (error?: unknown) => { releaseArgument = error; }
    } as unknown as PoolClient;
    const pool = { connect: async () => client } as unknown as Pool;
    const service = new PgKnowledgeQueryHttpService(pool, indexStub([result()]).index, () => now);
    await expect(service.execute({
      request: request({ budget: { max_results: 3, max_total_summary_bytes: 4_096, deadline_ms: 10 } }),
      actor_id: actorId,
      idempotency_key: "query-key-lock-timeout"
    })).rejects.toMatchObject({ code: "KNOWLEDGE_QUERY_TIMEOUT" });
    expect(releaseArgument).toBeInstanceOf(Error);
  });

  it("observes an abort raised synchronously by the transactional index seam", async () => {
    const storage = fakePool();
    const controller = new AbortController();
    const index: KnowledgeQueryHttpQueryIndex = {
      query: async () => [],
      queryWithClient: async () => {
        controller.abort();
        return [];
      }
    };
    const service = new PgKnowledgeQueryHttpService(storage.pool, index, () => now);
    await expect(service.execute({
      request: request(),
      actor_id: actorId,
      idempotency_key: "query-key-sync-abort",
      signal: controller.signal
    })).rejects.toMatchObject({ code: "KNOWLEDGE_QUERY_ABORTED" });
  });

  it("replays an identical actor/project idempotency key and conflicts on request drift", async () => {
    const firstStorage = fakePool();
    const firstIndex = indexStub([result()]);
    const first = new PgKnowledgeQueryHttpService(firstStorage.pool, firstIndex.index, () => now);
    const input = request();
    const created = await first.execute({ request: input, actor_id: actorId, idempotency_key: "query-key-2" });
    expect(created.outcome).toBe("new");
    if (created.outcome !== "new") throw new Error("fixture did not create a response");

    const replayStorage = fakePool({
      receipt: {
        actor_id: actorId,
        project_id: projectId,
        idempotency_key: "query-key-2",
        request_hash: `sha256:${createHash("sha256").update(canonicalJson(input)).digest("hex")}`,
        query_hash: input.query_hash,
        query_id: input.query_id,
        receipt_id: created.value.receipt.receipt_id,
        result_set_hash: created.value.receipt.result_set_hash,
        index_generation: created.value.receipt.index_generation,
        response_json: created.value,
        created_at: now
      }
    });
    const replayIndex = indexStub(() => { throw new Error("index must not run on replay"); });
    const replay = new PgKnowledgeQueryHttpService(replayStorage.pool, replayIndex.index, () => now);
    await expect(replay.execute({ request: input, actor_id: actorId, idempotency_key: "query-key-2" }))
      .resolves.toMatchObject({ outcome: "replay", value: created.value });
    expect(replayIndex.calls).toHaveLength(0);

    const conflict = await replay.execute({
      request: { ...input, reason_code: "directed_evidence_followup" },
      actor_id: actorId,
      idempotency_key: "query-key-2"
    });
    expect(conflict).toEqual({
      outcome: "conflict",
      error: { code: "KNOWLEDGE_QUERY_IDEMPOTENCY_CONFLICT", retryable: false }
    });
  });

  it("rejects a receipt row whose durable identity is outside the requested scope", async () => {
    const firstStorage = fakePool();
    const first = new PgKnowledgeQueryHttpService(firstStorage.pool, indexStub([result()]).index, () => now);
    const input = request();
    const created = await first.execute({ request: input, actor_id: actorId, idempotency_key: "query-key-corrupt" });
    if (created.outcome !== "new") throw new Error("fixture did not create a response");

    const corruptStorage = fakePool({
      forceReceipt: true,
      receipt: {
        actor_id: undefined,
        project_id: projectId,
        idempotency_key: undefined,
        request_hash: `sha256:${createHash("sha256").update(canonicalJson(input)).digest("hex")}`,
        query_hash: input.query_hash,
        query_id: created.value.query_id,
        receipt_id: created.value.receipt.receipt_id,
        result_set_hash: created.value.receipt.result_set_hash,
        index_generation: created.value.receipt.index_generation,
        response_json: created.value,
        created_at: now
      }
    });
    const replay = new PgKnowledgeQueryHttpService(corruptStorage.pool, indexStub(() => {
      throw new Error("index must not run on corrupt replay");
    }).index, () => now);
    await expect(replay.execute({ request: input, actor_id: actorId, idempotency_key: "query-key-corrupt" }))
      .rejects.toMatchObject({ code: "KNOWLEDGE_QUERY_RECEIPT_INVALID" });
  });

  it("rejects accessor-backed requests without opening storage or invoking the index", async () => {
    const storage = fakePool();
    const index = indexStub([result()]);
    const service = new PgKnowledgeQueryHttpService(storage.pool, index.index, () => now);
    const hostile = { ...request() } as Record<string, unknown>;
    Object.defineProperty(hostile, "query", {
      enumerable: true,
      get: () => { throw new Error("query secret"); }
    });
    await expect(service.execute({ request: hostile as never, actor_id: actorId, idempotency_key: "query-key-3" }))
      .rejects.toMatchObject({ code: "KNOWLEDGE_QUERY_INVALID" });
    expect(storage.queries).toHaveLength(0);
    expect(index.calls).toHaveLength(0);
  });

  it("stores a fixed failed receipt without copying an index or database error", async () => {
    const storage = fakePool();
    const index = indexStub(() => Promise.reject(new Error("DB_PASSWORD_SECRET=password=hunter2")));
    const service = new PgKnowledgeQueryHttpService(storage.pool, index.index, () => now);
    const outcome = await service.execute({ request: request(), actor_id: actorId, idempotency_key: "query-key-4" });

    expect(outcome.outcome).toBe("new");
    if (outcome.outcome === "new") {
      expect(outcome.value.receipt.status).toBe("failed");
      expect(outcome.value.receipt.reason_code).toBe("remote_knowledge_unavailable");
      expect(outcome.value.receipt.failure_code).toBe("remote_knowledge_unavailable");
      expect(JSON.stringify(outcome.value)).not.toContain("DB_PASSWORD_SECRET");
      expect(JSON.stringify(outcome.value)).not.toContain("hunter2");
    }
  });

  it("bounds result count and UTF-8 summary bytes before constructing the receipt", async () => {
    const storage = fakePool();
    const index = indexStub([
      result({ knowledge_id: "kn_query_1", summary: "中文摘要".repeat(600) }),
      result({ knowledge_id: "kn_query_2", content_hash: `sha256:${"b".repeat(64)}`, summary: "second" }),
      result({ knowledge_id: "kn_query_3", content_hash: `sha256:${"c".repeat(64)}`, summary: "third" })
    ]);
    const service = new PgKnowledgeQueryHttpService(storage.pool, index.index, () => now);
    const input = request({ budget: { max_results: 2, max_total_summary_bytes: 10, deadline_ms: 5_000 } });
    const outcome = await service.execute({ request: input, actor_id: actorId, idempotency_key: "query-key-5" });
    expect(outcome.outcome).toBe("new");
    if (outcome.outcome === "new") {
      expect(outcome.value.results).toHaveLength(2);
      expect(new TextEncoder().encode(outcome.value.results.map((item) => item.summary).join("")).byteLength).toBeLessThanOrEqual(10);
      expect(validateKnowledgeQueryHttpResponse(outcome.value, input).success).toBe(true);
    }
  });

  it("rejects an actor that does not own the requested project before querying knowledge", async () => {
    const storage = fakePool({ project: { project_id: projectId, owner_actor_id: "actor_other" } });
    const index = indexStub([result()]);
    const service = new PgKnowledgeQueryHttpService(storage.pool, index.index, () => now);
    await expect(service.execute({ request: request(), actor_id: actorId, idempotency_key: "query-key-6" }))
      .rejects.toMatchObject({ code: "PROJECT_INFORMATION_FORBIDDEN" });
    expect(index.calls).toHaveLength(0);
    expect(storage.inserted).toBeUndefined();
  });

  it("does not replay a receipt across actor or project binding", async () => {
    const firstStorage = fakePool();
    const firstIndex = indexStub([result()]);
    const first = new PgKnowledgeQueryHttpService(firstStorage.pool, firstIndex.index, () => now);
    const input = request();
    const created = await first.execute({ request: input, actor_id: actorId, idempotency_key: "query-key-scope" });
    if (created.outcome !== "new") throw new Error("fixture did not create a response");
    const storedReceipt = {
      actor_id: actorId,
      project_id: projectId,
      idempotency_key: "query-key-scope",
      request_hash: `sha256:${createHash("sha256").update(canonicalJson(input)).digest("hex")}`,
      query_hash: input.query_hash,
      query_id: input.query_id,
      receipt_id: created.value.receipt.receipt_id,
      result_set_hash: created.value.receipt.result_set_hash,
      index_generation: created.value.receipt.index_generation,
      response_json: created.value,
      created_at: now
    };

    const otherActor = "actor_query_other";
    const actorStorage = fakePool({
      project: { project_id: projectId, owner_actor_id: otherActor },
      receipt: storedReceipt
    });
    const actorIndex = indexStub([result()]);
    const actorService = new PgKnowledgeQueryHttpService(actorStorage.pool, actorIndex.index, () => now);
    await expect(actorService.execute({ request: input, actor_id: otherActor, idempotency_key: "query-key-scope" }))
      .resolves.toMatchObject({ outcome: "new" });
    expect(actorIndex.calls).toHaveLength(1);

    const otherProject = "prj_query_other";
    const projectInput = request({ project_id: otherProject });
    const projectStorage = fakePool({
      project: { project_id: otherProject, owner_actor_id: actorId },
      receipt: storedReceipt
    });
    const projectIndex = indexStub([result({ project_id: otherProject })]);
    const projectService = new PgKnowledgeQueryHttpService(projectStorage.pool, projectIndex.index, () => now);
    await expect(projectService.execute({ request: projectInput, actor_id: actorId, idempotency_key: "query-key-scope" }))
      .resolves.toMatchObject({ outcome: "new" });
    expect(projectIndex.calls).toHaveLength(1);
  });

  it("keeps migration 024 receipt identity columns and composite binding durable", async () => {
    const migration = await readFile(fileURLToPath(new URL("../migrations/024_knowledge_query_http_receipts.sql", import.meta.url)), "utf8");
    expect(migration).toContain("PRIMARY KEY (actor_id, project_id, idempotency_key)");
    expect(migration).toContain("request_hash text NOT NULL");
    expect(migration).toContain("query_id text NOT NULL");
    expect(migration).toContain("receipt_id text NOT NULL");
    expect(migration).toContain("result_set_hash text NOT NULL");
    expect(migration).toContain("index_generation text");
    expect(migration).toContain("response_json jsonb NOT NULL");
    expect(migration).toContain("response_json->>'query_id' = query_id");
    expect(migration).toContain("response_json->>'project_id' = project_id");
    expect(migration).toContain("response_json->'receipt'->>'project_id' = project_id");
    expect(migration).toContain("response_json->'receipt'->>'receipt_id' = receipt_id");
    expect(migration).toContain("response_json->'receipt'->>'result_set_hash' = result_set_hash");
    expect(migration).toContain("response_json->'receipt'->>'query_hash' = query_hash");
    expect(migration).toContain("REFERENCES actors(actor_id)");
    expect(migration).toContain("REFERENCES projects(project_id)");
  });
});
