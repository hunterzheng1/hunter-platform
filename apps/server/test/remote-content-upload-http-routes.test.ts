import { createHash } from "node:crypto";
import {
  remoteContentUploadHttpRecordHash,
  remoteContentUploadHttpResultSchema,
  validateRemoteContentUploadHttpResult,
  type RemoteContentUploadHttpRecord,
  type RemoteContentUploadHttpResult,
  type RemoteContentUploadHttpSource
} from "@hunter-harness/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/app.js";
import type { RemoteContentUploadHttpServicePort } from "../src/remote-content-upload-http/index.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

const IDEMPOTENCY_KEY = `sha256:${"a".repeat(64)}` as const;
const UPLOAD_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function uploadResult(input: {
  readonly projectId: string;
  readonly sha256: `sha256:${string}`;
  readonly sizeBytes: number;
  readonly outcome?: "new" | "replay";
  readonly expiresInMs?: number;
  readonly source?: Partial<RemoteContentUploadHttpSource>;
}): RemoteContentUploadHttpResult {
  const uploadRef = {
    ref_id: `bounded_upload:${UPLOAD_TOKEN}` as const,
    sha256: input.sha256,
    size_bytes: input.sizeBytes
  };
  const body: Omit<RemoteContentUploadHttpRecord, "record_hash"> = {
    schema_version: 1,
    upload_id: `remote_content_upload:${UPLOAD_TOKEN}`,
    source: {
      project_id: input.projectId,
      branch_name: "main",
      actor_id: "actor_upload",
      ...input.source
    },
    idempotency_key: IDEMPOTENCY_KEY,
    purpose: "remote_archive",
    content_sha256: input.sha256,
    size_bytes: input.sizeBytes,
    upload_ref: uploadRef,
    state: "stored",
    created_at: "2026-08-15T00:00:00.000Z",
    expires_at: new Date(Date.parse("2026-08-15T00:00:00.000Z") + (input.expiresInMs ?? 60_000)).toISOString()
  };
  return {
    outcome: input.outcome ?? "new",
    upload_ref: { ...uploadRef },
    record: { ...body, upload_ref: { ...uploadRef }, record_hash: remoteContentUploadHttpRecordHash(body) }
  };
}

describe("Remote Content Upload HTTP routes", () => {
  let repository: MemoryRepository; let projectId: string; let app: Awaited<ReturnType<typeof createServer>>;
  beforeEach(async () => {
    repository = new MemoryRepository();
    await repository.createActorWithToken({ actorId: "actor_upload", token: "upload-token" });
    projectId = (await repository.resolveProject({ actorId: "actor_upload", localProjectKey: "upload-test",
      displayName: "Upload", requestedProjectId: null })).project.projectId;
  });
  afterEach(async () => app?.close());

  it("authenticates before reporting an absent adapter", async () => {
    app = await createServer({ repository, storage: new MemoryArtifactStorage() });
    const url = `/api/v1/projects/${projectId}/branches/main/remote-sync/content-upload/status`;
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    const response = await app.inject({ method: "GET", url, headers: { authorization: "Bearer upload-token",
      "idempotency-key": `sha256:${"a".repeat(64)}` } });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("REMOTE_UNAVAILABLE");
  });

  it("authenticates before inspecting malformed route identity", async () => {
    app = await createServer({ repository, storage: new MemoryArtifactStorage() });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/projects/%20${projectId}/branches/main/remote-sync/content-upload/status`,
      headers: { "idempotency-key": IDEMPOTENCY_KEY }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("AUTH_REQUIRED");
  });

  it("streams bounded binary chunks and returns new then status", async () => {
    const bytes = Buffer.from("PK\u0003\u0004streamed zip"); const sha = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    let serviceValidation: unknown;
    const stage = vi.fn(async (input: Parameters<RemoteContentUploadHttpServicePort["stage"]>[0]) => {
      const chunks = []; for await (const chunk of input.chunks) chunks.push(chunk);
      expect(Buffer.concat(chunks.map((item) => Buffer.from(item.bytes)))).toEqual(bytes);
      const upload_ref = { ref_id: `bounded_upload:${"A".repeat(43)}` as const, sha256: sha, size_bytes: bytes.length };
      const body = { schema_version: 1 as const, upload_id: `remote_content_upload:${"A".repeat(43)}` as const,
        source: { project_id: projectId, branch_name: "main", actor_id: "actor_upload" },
        idempotency_key: `sha256:${"a".repeat(64)}` as const, purpose: "remote_archive" as const,
        content_sha256: sha, size_bytes: bytes.length, upload_ref: { ...upload_ref }, state: "stored" as const,
        created_at: "2026-08-15T00:00:00.000Z", expires_at: "2026-08-15T00:01:00.000Z" };
      const result = { outcome: "new" as const, upload_ref, record: { ...body, record_hash: remoteContentUploadHttpRecordHash(body) } };
      expect(remoteContentUploadHttpResultSchema.safeParse(result)).toMatchObject({ success: true });
      serviceValidation = validateRemoteContentUploadHttpResult(result);
      return result;
    });
    const status = vi.fn();
    const service = { stage, status } as unknown as RemoteContentUploadHttpServicePort;
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), remoteContentUpload: service });
    const response = await app.inject({ method: "POST",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/content-upload`, payload: bytes,
      headers: { authorization: "Bearer upload-token", "content-type": "application/zip",
        "content-length": String(bytes.length), "idempotency-key": `sha256:${"a".repeat(64)}`,
        "x-content-sha256": sha, "x-upload-expires-in-ms": "60000" } });
    expect(serviceValidation).toMatchObject({ success: true });
    if (response.statusCode !== 201) expect(response.json()).toEqual({ expected_status: 201 });
    expect(stage).toHaveBeenCalledOnce();
  });

  it("keeps a trusted stage unpublished when the trailing raw stream hash fails", async () => {
    const bytes = Buffer.alloc(1024 * 1024 + 1, 0x50);
    const declaredHash = `sha256:${"e".repeat(64)}` as const;
    let published = false;
    let receivedBytes = 0;
    const stage = vi.fn(async (input: Parameters<RemoteContentUploadHttpServicePort["stage"]>[0]) => {
      for await (const chunk of input.chunks) receivedBytes += chunk.size;
      published = true;
      return uploadResult({ projectId, sha256: declaredHash, sizeBytes: bytes.length });
    });
    const service = { stage, status: vi.fn() } satisfies RemoteContentUploadHttpServicePort;
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), remoteContentUpload: service });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/content-upload`,
      payload: bytes,
      headers: {
        authorization: "Bearer upload-token",
        "content-type": "application/zip",
        "content-length": String(bytes.length),
        "idempotency-key": IDEMPOTENCY_KEY,
        "x-content-sha256": declaredHash,
        "x-upload-expires-in-ms": "60000"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("REMOTE_CONTENT_UPLOAD_HASH_MISMATCH");
    expect(stage).toHaveBeenCalledOnce();
    expect(receivedBytes).toBe(1024 * 1024);
    expect(published).toBe(false);
  });

  it("fails closed when a hostile stage returns before consuming a bad stream", async () => {
    const bytes = Buffer.from("PK\u0003\u0004lazy stream must be consumed");
    const declaredHash = `sha256:${"f".repeat(64)}` as const;
    const stage = vi.fn(async () => uploadResult({ projectId, sha256: declaredHash, sizeBytes: bytes.length }));
    const service = { stage, status: vi.fn() } satisfies RemoteContentUploadHttpServicePort;
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), remoteContentUpload: service });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/content-upload`,
      payload: bytes,
      headers: {
        authorization: "Bearer upload-token",
        "content-type": "application/zip",
        "content-length": String(bytes.length),
        "idempotency-key": IDEMPOTENCY_KEY,
        "x-content-sha256": declaredHash,
        "x-upload-expires-in-ms": "60000"
      }
    });

    expect(stage).toHaveBeenCalledOnce();
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("REMOTE_UNAVAILABLE");
  });

  it("rejects a syntactically valid service result whose content hash is not request-bound", async () => {
    const bytes = Buffer.from("PK\u0003\u0004request identity");
    const requestSha = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
    const service = {
      stage: vi.fn(async () => uploadResult({
        projectId,
        sha256: `sha256:${"c".repeat(64)}`,
        sizeBytes: bytes.length
      })),
      status: vi.fn()
    } satisfies RemoteContentUploadHttpServicePort;
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), remoteContentUpload: service });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/content-upload`,
      payload: bytes,
      headers: {
        authorization: "Bearer upload-token",
        "content-type": "application/zip",
        "content-length": String(bytes.length),
        "idempotency-key": IDEMPOTENCY_KEY,
        "x-content-sha256": requestSha,
        "x-upload-expires-in-ms": "60000"
      }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatchObject({ code: "REMOTE_UNAVAILABLE" });
  });

  it("returns replay as 200 and preserves the full optional request identity", async () => {
    const bytes = Buffer.from("PK\u0003\u0004replayed content");
    const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
    let descriptor: Parameters<RemoteContentUploadHttpServicePort["stage"]>[0]["descriptor"] | undefined;
    const service = {
      stage: vi.fn(async (input: Parameters<RemoteContentUploadHttpServicePort["stage"]>[0]) => {
        descriptor = input.descriptor;
        for await (const chunk of input.chunks) { void chunk.bytes; }
        return uploadResult({
          projectId,
          sha256,
          sizeBytes: bytes.length,
          outcome: "replay",
          source: { commit_sha: "commit-1", client_id: "client-1", change_key: "change-1" }
        });
      }),
      status: vi.fn()
    } satisfies RemoteContentUploadHttpServicePort;
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), remoteContentUpload: service });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/content-upload`,
      payload: bytes,
      headers: {
        authorization: "Bearer upload-token",
        "content-type": "application/zip",
        "content-length": String(bytes.length),
        "idempotency-key": IDEMPOTENCY_KEY,
        "x-content-sha256": sha256,
        "x-upload-expires-in-ms": "60000",
        "x-commit-sha": "commit-1",
        "x-client-id": "client-1",
        "x-change-key": "change-1"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ outcome: "replay", record: {
      source: { project_id: projectId, branch_name: "main", actor_id: "actor_upload",
        commit_sha: "commit-1", client_id: "client-1", change_key: "change-1" },
      idempotency_key: IDEMPOTENCY_KEY,
      content_sha256: sha256,
      size_bytes: bytes.length
    } });
    expect(descriptor).toMatchObject({
      path: { project_id: projectId, branch_name: "main" },
      auth: { actor_id: "actor_upload" },
      headers: {
        "Idempotency-Key": IDEMPOTENCY_KEY,
        "X-Content-SHA256": sha256,
        "Content-Length": String(bytes.length),
        "X-Upload-Expires-In-Ms": "60000",
        "X-Commit-SHA": "commit-1",
        "X-Client-Id": "client-1",
        "X-Change-Key": "change-1"
      }
    });
  });

  it("returns scoped stored, expired, and unknown status without retry ambiguity", async () => {
    const sha256 = `sha256:${"d".repeat(64)}` as const;
    const record = uploadResult({ projectId, sha256, sizeBytes: 42,
      source: { commit_sha: "commit-status", client_id: "client-status", change_key: "change-status" } }).record;
    const status = vi.fn()
      .mockResolvedValueOnce({ state: "stored", record: structuredClone(record) })
      .mockResolvedValueOnce({ state: "expired", record: structuredClone(record) })
      .mockResolvedValueOnce({ state: "unknown", record: null });
    const service = { stage: vi.fn(), status } satisfies RemoteContentUploadHttpServicePort;
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), remoteContentUpload: service });
    const request = () => app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/content-upload/status`,
      headers: {
        authorization: "Bearer upload-token",
        "idempotency-key": IDEMPOTENCY_KEY,
        "x-commit-sha": "commit-status",
        "x-client-id": "client-status",
        "x-change-key": "change-status"
      }
    });

    expect((await request()).json()).toMatchObject({ state: "stored", record: { source: { project_id: projectId } } });
    expect((await request()).json()).toMatchObject({ state: "expired", record: { source: { project_id: projectId } } });
    expect((await request()).json()).toEqual({ state: "unknown", record: null });
    expect(status).toHaveBeenCalledTimes(3);
    expect(status.mock.calls[0]?.[0].descriptor).toMatchObject({
      path: { project_id: projectId, branch_name: "main" },
      auth: { actor_id: "actor_upload" },
      headers: {
        "Idempotency-Key": IDEMPOTENCY_KEY,
        "X-Commit-SHA": "commit-status",
        "X-Client-Id": "client-status",
        "X-Change-Key": "change-status"
      }
    });
  });

  it("does not execute hostile service method getters and fails closed without secrets", async () => {
    let traps = 0;
    const service = Object.create(Object.prototype) as Record<string, unknown>;
    Object.defineProperty(service, "stage", {
      enumerable: true,
      get: () => {
        traps += 1;
        throw new Error("service-getter-secret");
      }
    });
    Object.defineProperty(service, "status", { enumerable: true, value: vi.fn() });
    app = await createServer({ repository, storage: new MemoryArtifactStorage(),
      remoteContentUpload: service as unknown as RemoteContentUploadHttpServicePort });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/content-upload/status`,
      headers: { authorization: "Bearer upload-token", "idempotency-key": IDEMPOTENCY_KEY }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatchObject({
      code: "REMOTE_UNAVAILABLE",
      message: "remote content upload service is unavailable"
    });
    expect(response.body).not.toContain("service-getter-secret");
    expect(traps).toBe(0);
  });

});
