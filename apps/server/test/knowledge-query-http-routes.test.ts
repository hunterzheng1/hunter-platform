import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  knowledgeQueryHttpReceiptId,
  knowledgeQueryHttpResultSetHash,
  type KnowledgeQueryHttpResponse
} from "@hunter-harness/contracts";
import type { KnowledgeQueryHttpServicePort } from "../src/knowledge-query-http/index.js";
import { createServer } from "../src/app.js";
import { ServerDomainError } from "../src/repositories/interfaces.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

const requestId = "0198f012-3456-7abc-8def-0123456789ab";
const queryHash = "sha256:" + "a".repeat(64);

function responseFor(projectId: string): KnowledgeQueryHttpResponse {
  const queryId = `knowledge_query:${"a".repeat(64)}` as const;
  const receiptBody = {
    schema_version: 1 as const,
    query_hash: queryHash,
    project_id: projectId,
    index_generation: "knowledge_generation:17",
    result_ids: ["knowledge.result.1"],
    source_versions: ["artifact:v4"],
    result_set_hash: knowledgeQueryHttpResultSetHash({
      index_generation: "knowledge_generation:17",
      result_ids: ["knowledge.result.1"],
      source_versions: ["artifact:v4"]
    }),
    status: "succeeded" as const,
    executed_at: "2026-08-14T01:02:03.000Z",
    reason_code: "initial_intent" as const
  };
  return {
    schema_version: 1,
    query_id: queryId,
    project_id: projectId,
    receipt: {
      ...receiptBody,
      receipt_id: knowledgeQueryHttpReceiptId(receiptBody)
    },
    results: [{
      result_id: "knowledge.result.1",
      kind: "archive_knowledge",
      summary: "The durable knowledge projection is authoritative.",
      relevance: "high",
      source: "archive:change-17",
      verified_at: "2026-08-13T12:00:00.000Z",
      source_version: "artifact:v4",
      conflicts_with_intent: false
    }]
  };
}

function serviceStub(): {
  service: KnowledgeQueryHttpServicePort;
  execute: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn();
  return {
    execute,
    service: { execute } as unknown as KnowledgeQueryHttpServicePort
  };
}

describe("Knowledge Query HTTP routes", () => {
  let repository: MemoryRepository;
  let projectId: string;
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    repository = new MemoryRepository();
    await repository.createActorWithToken({ actorId: "actor_knowledge", token: "knowledge-token" });
    projectId = (await repository.resolveProject({
      actorId: "actor_knowledge",
      localProjectKey: "knowledge-http-tests",
      displayName: "Knowledge HTTP",
      requestedProjectId: null
    })).project.projectId;
  });

  afterEach(async () => {
    await app?.close();
  });

  it("authenticates before exposing missing service availability", async () => {
    app = await createServer({ repository, storage: new MemoryArtifactStorage() });
    const missing = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/knowledge/query`,
      headers: { authorization: "Bearer knowledge-token", "idempotency-key": "query-1", "x-request-id": requestId },
      payload: {
        schema_version: 1, project_id: projectId, query_id: `knowledge_query:${"a".repeat(64)}`,
        query_hash: queryHash, reason_code: "initial_intent", query: "authoritative knowledge",
        budget: { max_results: 3, max_total_summary_bytes: 4096, deadline_ms: 1000 }
      }
    });
    expect(missing.statusCode).toBe(503);
    expect(missing.json()).toMatchObject({ error: { code: "REMOTE_UNAVAILABLE", request_id: requestId } });
    const unauthenticated = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/knowledge/query`,
      payload: {}
    });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it("derives project identity and actor from authentication", async () => {
    const { service, execute } = serviceStub();
    execute.mockResolvedValue({ outcome: "new", value: responseFor(projectId) });
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), knowledgeQuery: service });
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/knowledge/query`,
      headers: { authorization: "Bearer knowledge-token", "idempotency-key": "query-2", "x-request-id": requestId },
      payload: {
        schema_version: 1, project_id: projectId, query_id: `knowledge_query:${"a".repeat(64)}`,
        query_hash: queryHash, reason_code: "initial_intent", query: "authoritative knowledge",
        budget: { max_results: 3, max_total_summary_bytes: 4096, deadline_ms: 1000 }
      }
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["x-request-id"]).toBe(requestId);
    expect(response.json().results[0].summary).toContain("authoritative");
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      actor_id: "actor_knowledge",
      idempotency_key: "query-2"
    }));
  });

  it("rejects a body project mismatch before invoking the service", async () => {
    const { service, execute } = serviceStub();
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), knowledgeQuery: service });
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/knowledge/query`,
      headers: { authorization: "Bearer knowledge-token", "idempotency-key": "query-3" },
      payload: {
        schema_version: 1, project_id: "prj_other", query_id: `knowledge_query:${"a".repeat(64)}`,
        query_hash: queryHash, reason_code: "initial_intent", query: "authoritative knowledge",
        budget: { max_results: 3, max_total_summary_bytes: 4096, deadline_ms: 1000 }
      }
    });
    expect(response.statusCode).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns replay and conflict outcomes without leaking service errors", async () => {
    const { service, execute } = serviceStub();
    execute.mockResolvedValueOnce({ outcome: "replay", value: responseFor(projectId) });
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), knowledgeQuery: service });
    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/knowledge/query`,
      headers: { authorization: "Bearer knowledge-token", "idempotency-key": "query-4", "x-request-id": requestId },
      payload: {
        schema_version: 1, project_id: projectId, query_id: `knowledge_query:${"a".repeat(64)}`,
        query_hash: queryHash, reason_code: "initial_intent", query: "authoritative knowledge",
        budget: { max_results: 3, max_total_summary_bytes: 4096, deadline_ms: 1000 }
      }
    });
    expect(replay.statusCode).toBe(200);
    execute.mockResolvedValueOnce({ outcome: "conflict", error: { code: "KNOWLEDGE_QUERY_IDEMPOTENCY_CONFLICT", retryable: false } });
    const conflict = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/knowledge/query`,
      headers: { authorization: "Bearer knowledge-token", "idempotency-key": "query-5" },
      payload: {
        schema_version: 1, project_id: projectId, query_id: `knowledge_query:${"a".repeat(64)}`,
        query_hash: queryHash, reason_code: "initial_intent", query: "authoritative knowledge",
        budget: { max_results: 3, max_total_summary_bytes: 4096, deadline_ms: 1000 }
      }
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("KNOWLEDGE_QUERY_IDEMPOTENCY_CONFLICT");
  });

  it("maps unknown service failures and invalid responses to safe 503", async () => {
    const { service, execute } = serviceStub();
    execute.mockRejectedValueOnce({ code: "DB_PASSWORD_SECRET", message: "password=hunter2" });
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), knowledgeQuery: service });
    const base = {
      schema_version: 1, project_id: projectId, query_id: `knowledge_query:${"a".repeat(64)}`,
      query_hash: queryHash, reason_code: "initial_intent", query: "authoritative knowledge",
      budget: { max_results: 3, max_total_summary_bytes: 4096, deadline_ms: 1000 }
    };
    const failed = await app.inject({
      method: "POST", url: `/api/v1/projects/${projectId}/knowledge/query`,
      headers: { authorization: "Bearer knowledge-token", "idempotency-key": "query-6" }, payload: base
    });
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain("hunter2");
    execute.mockResolvedValueOnce({ outcome: "new", value: { ...responseFor(projectId), project_id: "prj_wrong" } });
    const invalid = await app.inject({
      method: "POST", url: `/api/v1/projects/${projectId}/knowledge/query`,
      headers: { authorization: "Bearer knowledge-token", "idempotency-key": "query-7" }, payload: base
    });
    expect(invalid.statusCode).toBe(503);
    expect(invalid.json().error.code).toBe("REMOTE_UNAVAILABLE");
  });

  it("fails closed for hostile, malformed, and unknown service outcomes", async () => {
    const { service, execute } = serviceStub();
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), knowledgeQuery: service });
    const base = {
      schema_version: 1, project_id: projectId, query_id: `knowledge_query:${"a".repeat(64)}`,
      query_hash: queryHash, reason_code: "initial_intent", query: "authoritative knowledge",
      budget: { max_results: 3, max_total_summary_bytes: 4096, deadline_ms: 1000 }
    };
    execute.mockResolvedValueOnce(new Proxy({ outcome: "new", value: responseFor(projectId) }, {
      get() { throw new Error("service getter must not execute"); }
    }));
    const hostile = await app.inject({
      method: "POST", url: `/api/v1/projects/${projectId}/knowledge/query`,
      headers: { authorization: "Bearer knowledge-token", "idempotency-key": "query-hostile" }, payload: base
    });
    expect(hostile.statusCode).toBe(503);
    expect(hostile.json().error.code).toBe("REMOTE_UNAVAILABLE");

    execute.mockResolvedValueOnce({ outcome: "bogus", value: responseFor(projectId) });
    const unknown = await app.inject({
      method: "POST", url: `/api/v1/projects/${projectId}/knowledge/query`,
      headers: { authorization: "Bearer knowledge-token", "idempotency-key": "query-unknown" }, payload: base
    });
    expect(unknown.statusCode).toBe(503);
    expect(unknown.json().error.code).toBe("REMOTE_UNAVAILABLE");

    execute.mockResolvedValueOnce(null);
    const malformed = await app.inject({
      method: "POST", url: `/api/v1/projects/${projectId}/knowledge/query`,
      headers: { authorization: "Bearer knowledge-token", "idempotency-key": "query-null" }, payload: base
    });
    expect(malformed.statusCode).toBe(503);
    expect(malformed.json().error.code).toBe("REMOTE_UNAVAILABLE");

    execute.mockRejectedValueOnce(new Proxy({}, {
      get() { throw new Error("error getter must not execute"); }
    }));
    const hostileError = await app.inject({
      method: "POST", url: `/api/v1/projects/${projectId}/knowledge/query`,
      headers: { authorization: "Bearer knowledge-token", "idempotency-key": "query-error-hostile" }, payload: base
    });
    expect(hostileError.statusCode).toBe(503);
    expect(hostileError.json().error.code).toBe("REMOTE_UNAVAILABLE");
  });

  it("keeps service error status mappings aligned with the shared descriptor", async () => {
    const { service, execute } = serviceStub();
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), knowledgeQuery: service });
    const base = {
      schema_version: 1, project_id: projectId, query_id: `knowledge_query:${"a".repeat(64)}`,
      query_hash: queryHash, reason_code: "initial_intent", query: "authoritative knowledge",
      budget: { max_results: 3, max_total_summary_bytes: 4096, deadline_ms: 1000 }
    };
    execute.mockRejectedValueOnce({ code: "KNOWLEDGE_QUERY_RECEIPT_INVALID", message: "internal" });
    const receiptInvalid = await app.inject({
      method: "POST", url: `/api/v1/projects/${projectId}/knowledge/query`,
      headers: { authorization: "Bearer knowledge-token", "idempotency-key": "query-receipt-invalid" }, payload: base
    });
    expect(receiptInvalid.statusCode).toBe(422);
    expect(receiptInvalid.json().error.code).toBe("KNOWLEDGE_QUERY_RECEIPT_INVALID");

    execute.mockRejectedValueOnce({ code: "KNOWLEDGE_QUERY_TIMEOUT", message: "internal" });
    const timeout = await app.inject({
      method: "POST", url: `/api/v1/projects/${projectId}/knowledge/query`,
      headers: { authorization: "Bearer knowledge-token", "idempotency-key": "query-timeout" }, payload: base
    });
    expect(timeout.statusCode).toBe(503);
    expect(timeout.json().error.code).toBe("KNOWLEDGE_QUERY_TIMEOUT");

    execute.mockRejectedValueOnce(new ServerDomainError(418, "DB_PASSWORD_SECRET", "password=hunter2"));
    const unsafeDomain = await app.inject({
      method: "POST", url: `/api/v1/projects/${projectId}/knowledge/query`,
      headers: { authorization: "Bearer knowledge-token", "idempotency-key": "query-unsafe-domain" }, payload: base
    });
    expect(unsafeDomain.statusCode).toBe(503);
    expect(unsafeDomain.json().error.code).toBe("REMOTE_UNAVAILABLE");
    expect(unsafeDomain.body).not.toContain("hunter2");

    execute.mockRejectedValueOnce(new ServerDomainError(503, "AUTH_REQUIRED", "internal auth detail"));
    const authError = await app.inject({
      method: "POST", url: `/api/v1/projects/${projectId}/knowledge/query`,
      headers: { authorization: "Bearer knowledge-token", "idempotency-key": "query-auth-error" }, payload: base
    });
    expect(authError.statusCode).toBe(401);
    expect(authError.json().error.code).toBe("AUTH_REQUIRED");
  });
});
