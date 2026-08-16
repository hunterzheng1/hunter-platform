import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  RemoteSyncHttpServicePort,
  RemoteSyncHttpContentStream
} from "../src/remote-sync-http/index.js";
import { createServer } from "../src/app.js";
import { projectApiKeyHash } from "../src/auth/accounts.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

function requestId(): string {
  return "0198f012-3456-7abc-8def-0123456789ab";
}

function emptyHash(): string {
  return `sha256:${createHash("sha256").update("").digest("hex")}`;
}

function serviceStub(): {
  service: RemoteSyncHttpServicePort;
  acquireLease: ReturnType<typeof vi.fn>;
  openContentStream: ReturnType<typeof vi.fn>;
} {
  const acquireLease = vi.fn();
  const openContentStream = vi.fn();
  const service = {
    acquireLease,
    renewLease: vi.fn(),
    releaseLease: vi.fn(),
    readRemoteSnapshot: vi.fn(),
    openContentStream,
    preparePush: vi.fn(),
    commitPush: vi.fn(),
    getPushStatus: vi.fn(),
    getPushReceipt: vi.fn(),
    pull: vi.fn()
  } as unknown as RemoteSyncHttpServicePort;
  return { service, acquireLease, openContentStream };
}

describe("Remote Sync HTTP routes", () => {
  let repository: MemoryRepository;
  let projectId: string;
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    repository = new MemoryRepository();
    await repository.createActorWithToken({ actorId: "actor_remote", token: "remote-token" });
    const resolved = await repository.resolveProject({
      actorId: "actor_remote",
      localProjectKey: "remote-http-tests",
      displayName: "Remote HTTP",
      requestedProjectId: null
    });
    projectId = resolved.project.projectId;
  });

  afterEach(async () => {
    await app?.close();
  });

  it("fails closed with 503 when the deployment adapter is absent", async () => {
    app = await createServer({ repository, storage: new MemoryArtifactStorage() });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/snapshot`,
      headers: { authorization: "Bearer remote-token", "x-request-id": requestId() }
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "REMOTE_UNAVAILABLE", request_id: requestId() } });
  });

  it("requires authentication before exposing adapter availability", async () => {
    app = await createServer({ repository, storage: new MemoryArtifactStorage() });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/snapshot`
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("AUTH_REQUIRED");
  });

  it("derives source actor/project from auth and rejects a body scope mismatch", async () => {
    const { service, acquireLease } = serviceStub();
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), remoteSync: service });
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/leases`,
      headers: {
        authorization: "Bearer remote-token",
        "idempotency-key": "lease-request-1",
        "x-request-id": requestId()
      },
      payload: {
        source: { project_id: projectId, branch_name: "main", actor_id: "attacker" },
        ttl_ms: 1_000
      }
    });
    expect(response.statusCode).toBe(403);
    expect(acquireLease).not.toHaveBeenCalled();
  });

  it("passes server-derived source and maps an idempotency conflict to 409", async () => {
    const { service, acquireLease } = serviceStub();
    acquireLease.mockResolvedValue({
      outcome: "conflict",
      error: { code: "SYNC_IDEMPOTENCY_CONFLICT", retryable: false }
    });
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), remoteSync: service });
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/leases`,
      headers: {
        authorization: "Bearer remote-token",
        "idempotency-key": "lease-request-2",
        "x-request-id": requestId()
      },
      payload: { source: { project_id: projectId, branch_name: "main", actor_id: "actor_remote" } }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "SYNC_IDEMPOTENCY_CONFLICT", outcome: "conflict", request_id: requestId() }
    });
    expect(acquireLease).toHaveBeenCalledWith({
      source: { project_id: projectId, branch_name: "main", actor_id: "actor_remote" },
      ttl_ms: 60_000,
      idempotency_key: "lease-request-2"
    });
  });

  it("enforces the bounded stream contract and emits identity headers", async () => {
    const { service, openContentStream } = serviceStub();
    const content: RemoteSyncHttpContentStream = {
      snapshot_id: "snapshot_1",
      revision: "0",
      content_sha256: emptyHash(),
      size: 0,
      stream: (async function* () {
        yield {
          sequence: 0,
          offset: 0,
          size: 0,
          chunk_hash: emptyHash(),
          final: true,
          bytes: new Uint8Array()
        };
      })()
    };
    openContentStream.mockResolvedValue(content);
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), remoteSync: service });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/snapshots/snapshot_1/content?path=docs%2FREADME.md&expected_revision=0&chunk_size=1048576`,
      headers: { authorization: "Bearer remote-token", "x-request-id": requestId() }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-content-sha256"]).toBe(emptyHash());
    expect(response.headers["x-remote-snapshot-id"]).toBe("snapshot_1");
    expect(response.headers["x-remote-revision"]).toBe("0");
    expect(openContentStream).toHaveBeenCalledWith({
      source: { project_id: projectId, branch_name: "main", actor_id: "actor_remote" },
      path: "docs/README.md",
      snapshot_id: "snapshot_1",
      expected_revision: "0",
      chunk_size: 1_048_576
    });
  });

  it("rejects an idempotency header/body mismatch before invoking push", async () => {
    const { service } = serviceStub();
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), remoteSync: service });
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/pull`,
      headers: {
        authorization: "Bearer remote-token",
        "idempotency-key": "header-key",
        "x-request-id": requestId()
      },
      payload: {
        source: { project_id: projectId, branch_name: "main", actor_id: "actor_remote" },
        actor_id: "actor_remote",
        idempotency_key: "body-key"
      }
    });
    expect(response.statusCode).toBe(409);
    expect((service.pull as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("serves canonical colon verb URLs and requires the files:write project-key scope", async () => {
    const { service, acquireLease } = serviceStub();
    acquireLease.mockResolvedValue({
      outcome: "conflict",
      error: { code: "SYNC_IDEMPOTENCY_CONFLICT", retryable: false }
    });
    const lease = {
      schema_version: 1 as const,
      lease_id: "lease_route_test",
      lease_token: `lease_${"a".repeat(43)}`,
      generation: 1,
      project_id: projectId,
      branch_name: "main",
      actor_id: "actor_remote",
      expires_at: new Date(Date.now() + 60_000).toISOString()
    };
    (service.renewLease as ReturnType<typeof vi.fn>).mockResolvedValue({ outcome: "new", value: lease });
    (service.releaseLease as ReturnType<typeof vi.fn>).mockResolvedValue({ outcome: "new", value: undefined });
    const prepare = {
      schema_version: 1 as const,
      prepare_id: "prepare_route_test",
      source: { project_id: projectId, branch_name: "main", actor_id: "actor_remote" },
      lease_id: lease.lease_id,
      lease_token: lease.lease_token,
      lease_generation: lease.generation,
      expected_revision: "0",
      preview_hash: `sha256:${"1".repeat(64)}`,
      idempotency_key: "prepare-idem",
      payload_hash: `sha256:${"2".repeat(64)}`,
      state: "prepared" as const,
      expires_at: lease.expires_at
    };
    (service.preparePush as ReturnType<typeof vi.fn>).mockResolvedValue({ outcome: "new", value: prepare });
    (service.commitPush as ReturnType<typeof vi.fn>).mockResolvedValue({
      outcome: "conflict", error: { code: "SYNC_IDEMPOTENCY_CONFLICT", retryable: false }
    });
    await repository.createProjectApiKey({
      keyId: "key-remote-read", keyHash: projectApiKeyHash("remote-read-key"), projectId,
      actorId: "actor_remote", label: "read", scopes: ["files:read"]
    });
    await repository.createProjectApiKey({
      keyId: "key-remote-write", keyHash: projectApiKeyHash("remote-write-key"), projectId,
      actorId: "actor_remote", label: "write", scopes: ["files:write"]
    });
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), remoteSync: service });
    const common = { authorization: "Bearer remote-token", "idempotency-key": "lease-canonical" };
    const renewed = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/leases/${lease.lease_id}:renew`,
      headers: { ...common, "x-request-id": requestId() },
      payload: { lease, ttl_ms: 1_000 }
    });
    expect(renewed.statusCode).toBe(200);
    const released = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/leases/${lease.lease_id}:release`,
      headers: { ...common, "idempotency-key": "release-canonical", "x-request-id": requestId() },
      payload: { lease }
    });
    expect(released.statusCode).toBe(200);
    const prepared = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/push:prepare`,
      headers: { authorization: "Bearer remote-token", "idempotency-key": "prepare-idem", "x-request-id": requestId() },
      payload: {
        source: { project_id: projectId, branch_name: "main", actor_id: "actor_remote" },
        lease,
        expected_revision: "0",
        preview_hash: `sha256:${"1".repeat(64)}`,
        idempotency_key: "prepare-idem",
        payload_hash: `sha256:${"2".repeat(64)}`,
        files: [], operations: [], skipped: []
      }
    });
    expect(prepared.statusCode).toBe(201);
    const committed = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/push:commit`,
      headers: { authorization: "Bearer remote-token", "idempotency-key": "commit-idem", "x-request-id": requestId() },
      payload: {
        prepare_id: "prepare_route_test",
        lease,
        idempotency_key: "commit-idem",
        payload_hash: `sha256:${"2".repeat(64)}`
      }
    });
    expect(committed.statusCode).toBe(409);
    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/leases`,
      headers: { authorization: "Bearer remote-read-key", "idempotency-key": "read-key" },
      payload: { source: { project_id: projectId, branch_name: "main", actor_id: "actor_remote" } }
    });
    expect(denied.statusCode).toBe(403);
    const allowed = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/leases`,
      headers: { authorization: "Bearer remote-write-key", "idempotency-key": "write-key" },
      payload: { source: { project_id: projectId, branch_name: "main", actor_id: "actor_remote" } }
    });
    expect(allowed.statusCode).toBe(409);
    expect(acquireLease).toHaveBeenCalledOnce();
  });

  it("rejects over-limit and malformed trailing chunks before sending a binary prefix", async () => {
    const { service, openContentStream } = serviceStub();
    openContentStream.mockResolvedValueOnce({
      snapshot_id: "snapshot_large", revision: "0", content_sha256: emptyHash(), size: 10 * 1024 * 1024 + 1,
      stream: (async function* () {})()
    });
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), remoteSync: service });
    const tooLarge = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/snapshots/snapshot_large/content?path=docs%2FREADME.md&expected_revision=0`,
      headers: { authorization: "Bearer remote-token" }
    });
    expect(tooLarge.statusCode).toBe(413);
    openContentStream.mockResolvedValueOnce({
      snapshot_id: "snapshot_bad", revision: "0", content_sha256: `sha256:${"a".repeat(64)}`, size: 1,
      stream: (async function* () {
        yield { sequence: 0, offset: 0, size: 0, chunk_hash: emptyHash(), final: false, bytes: new Uint8Array() };
        yield { sequence: 1, offset: 0, size: 0, chunk_hash: emptyHash(), final: true, bytes: new Uint8Array() };
      })()
    });
    const malformed = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/snapshots/snapshot_bad/content?path=docs%2FREADME.md&expected_revision=0`,
      headers: { authorization: "Bearer remote-token" }
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe("SYNC_STREAM_INVALID");
    openContentStream.mockResolvedValueOnce({
      snapshot_id: "snapshot_throw", revision: "0", content_sha256: emptyHash(), size: 0,
      stream: {
        [Symbol.asyncIterator]() {
          return { next: async () => { throw new Error("stream backend secret"); } };
        }
      }
    });
    const thrown = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/snapshots/snapshot_throw/content?path=docs%2FREADME.md&expected_revision=0`,
      headers: { authorization: "Bearer remote-token" }
    });
    expect(thrown.statusCode).toBe(503);
    expect(thrown.json().error.code).toBe("REMOTE_UNAVAILABLE");
    expect(thrown.body).not.toContain("stream backend secret");
  });

  it("allowlists service errors and never reflects backend messages", async () => {
    const { service, acquireLease } = serviceStub();
    acquireLease.mockRejectedValue({ code: "DB_PASSWORD_SECRET", message: "password=hunter2" });
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), remoteSync: service });
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/leases`,
      headers: { authorization: "Bearer remote-token", "idempotency-key": "secret-test" },
      payload: { source: { project_id: projectId, branch_name: "main", actor_id: "actor_remote" } }
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("REMOTE_UNAVAILABLE");
    expect(response.body).not.toContain("DB_PASSWORD_SECRET");
    expect(response.body).not.toContain("hunter2");
  });

  it("copies each validated chunk before a producer can mutate its yielded backing bytes", async () => {
    const { service, openContentStream } = serviceStub();
    const shared = new Uint8Array([65]);
    const expectedHash = `sha256:${createHash("sha256").update(shared).digest("hex")}`;
    openContentStream.mockResolvedValue({
      snapshot_id: "snapshot_alias",
      revision: "revision_alias",
      content_sha256: expectedHash,
      size: 1,
      stream: (async function* () {
        yield {
          sequence: 0, offset: 0, size: 1, chunk_hash: expectedHash, final: true, bytes: shared,
        };
        shared[0] = 66;
      })(),
    });
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), remoteSync: service });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/snapshots/snapshot_alias/content?path=src%2Findex.ts&expected_revision=revision_alias&chunk_size=1`,
      headers: { authorization: "Bearer remote-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(Buffer.from(response.rawPayload)).toEqual(Buffer.from([65]));
    expect(shared[0]).toBe(66);
  });

  it("rejects hostile service output accessors and non-native thenables without executing them", async () => {
    const { service, openContentStream } = serviceStub();
    let getterCalls = 0;
    const hostile = Object.defineProperty({
      revision: "0",
      content_sha256: emptyHash(),
      size: 0,
      stream: (async function* () {})(),
    }, "snapshot_id", {
      enumerable: true,
      get() { getterCalls += 1; return "snapshot_hostile"; },
    });
    openContentStream.mockResolvedValueOnce(hostile).mockReturnValueOnce({
      then() { getterCalls += 1; },
    });
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), remoteSync: service });
    const url = `/api/v1/projects/${projectId}/branches/main/remote-sync/snapshots/snapshot_hostile/content?path=src%2Findex.ts&expected_revision=0`;

    const accessor = await app.inject({ method: "GET", url, headers: { authorization: "Bearer remote-token" } });
    const thenable = await app.inject({ method: "GET", url, headers: { authorization: "Bearer remote-token" } });
    expect([accessor.statusCode, thenable.statusCode]).toEqual([503, 503]);
    expect(getterCalls).toBe(0);
  });

  it("preserves an encoded feature branch and exact optional source identity on status reads", async () => {
    const { service } = serviceStub();
    const source = {
      project_id: projectId,
      branch_name: "feature/contracts",
      actor_id: "actor_remote",
      commit_sha: "a".repeat(40),
      client_id: "cli_remote",
      change_key: "change_remote",
    };
    (service.getPushStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      source,
      state: "prepared",
      prepare_id: "prepare_feature",
      idempotency_key: "push-feature",
      payload_hash: `sha256:${"a".repeat(64)}`,
    });
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), remoteSync: service });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/branches/feature%2Fcontracts/remote-sync/push/status?idempotency_key=push-feature&commit_sha=${source.commit_sha}&client_id=${source.client_id}&change_key=${source.change_key}`,
      headers: { authorization: "Bearer remote-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(service.getPushStatus).toHaveBeenCalledWith({ source, idempotency_key: "push-feature" });
  });
});
