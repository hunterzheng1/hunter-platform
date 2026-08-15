import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createInMemoryRemoteArchiveV2,
} from "@hunter-harness/core";
import {
  remoteSyncArchiveHttpStableHash,
  type RemoteSyncArchivePrepareHttpRequest,
} from "@hunter-harness/contracts";
import { createServer } from "../src/app.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

const hash = (digit: string) => `sha256:${digit.repeat(64)}` as `sha256:${string}`;

describe("Remote Sync Archive HTTP routes", () => {
  let repository: MemoryRepository;
  let projectId: string;
  let app: Awaited<ReturnType<typeof createServer>> | undefined;

  beforeEach(async () => {
    repository = new MemoryRepository();
    await repository.createActorWithToken({ actorId: "actor_archive", token: "archive-token" });
    projectId = (await repository.resolveProject({ actorId: "actor_archive", localProjectKey: "archive-http",
      displayName: "Archive HTTP", requestedProjectId: null })).project.projectId;
  });

  afterEach(async () => { await app?.close(); });

  function request(): RemoteSyncArchivePrepareHttpRequest {
    const metadata = {
      schema_version: 2 as const,
      source: { project_id: projectId, branch_name: "main", actor_id: "actor_archive",
        commit_sha: "commit-http", client_id: "client-http", change_key: "change-http" },
      archive_id: "archive-http-test",
      identities: {
        package_sha256: hash("1"), package_size_bytes: 42, archive_schema_version: 1 as const,
        trusted_package_receipt_hash: hash("2"), local_archive_receipt_hash: hash("3"),
        manifest_hash: hash("4"), inventory_hash: hash("5"), core_v2_projection_hash: hash("6")
      },
      upload_ref: { ref_id: "bounded_upload:http-test", sha256: hash("1"), size_bytes: 42 }
    };
    return {
      schema_version: 2,
      operation_id: "remote_archive_operation:http-test",
      idempotency_key: hash("7"), payload_hash: remoteSyncArchiveHttpStableHash(metadata),
      lease_ttl_ms: 60_000, metadata
    };
  }

  it("authenticates before reporting an absent archive adapter", async () => {
    app = await createServer({ repository, storage: new MemoryArtifactStorage() });
    const url = `/api/v1/projects/${projectId}/branches/main/remote-sync/archive/status`;
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    const response = await app.inject({ method: "GET", url, headers: {
      authorization: "Bearer archive-token", "x-request-id": "0198f012-3456-7abc-8def-0123456789ab"
    } });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("REMOTE_UNAVAILABLE");
  });

  it("prepares, replays, commits, and looks up a receipt by the canonical path operation id", async () => {
    const core = createInMemoryRemoteArchiveV2({ clock: () => new Date("2026-08-15T00:00:00.000Z") });
    const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
    const service = {
      prepare: async (value: Parameters<typeof core.prepare>[0]) => wire(await core.prepare(value)),
      commit: async (value: Parameters<typeof core.commit>[0]) => wire(await core.commit(value)),
      status: async (value: Parameters<typeof core.status>[0]) => wire(await core.status(value)),
      receipt: async (value: Parameters<typeof core.receipt>[0]) => wire(await core.receipt(value))
    };
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), remoteSyncArchive: service });
    const input = request();
    const base = {
      authorization: "Bearer archive-token", "content-type": "application/json",
      "idempotency-key": input.idempotency_key
    };
    const query = new URLSearchParams({ actor_id: "actor_archive", commit_sha: "commit-http", client_id: "client-http", change_key: "change-http" });
    const prepare = await app.inject({ method: "POST",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/archive:prepare`, headers: base, payload: input });
    expect(prepare.statusCode).toBe(201);
    const shadowPrepare = await app.inject({ method: "POST",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/archive/prepare`, headers: base, payload: input });
    expect(shadowPrepare.statusCode).toBe(404);
    const prepared = prepare.json();
    expect(prepared.outcome).toBe("new");
    const replay = await app.inject({ method: "POST",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/archive:prepare`, headers: base, payload: input });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ outcome: "replay", claim: null, record: { operation_id: input.operation_id } });
    const commitBody = { claim: prepared.claim, idempotency_key: input.idempotency_key, payload_hash: input.payload_hash };
    const status = await app.inject({ method: "GET",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/archive/status?operation_id=${encodeURIComponent(input.operation_id)}&${query}`, headers: { authorization: "Bearer archive-token" } });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ operation_id: input.operation_id, state: "prepared" });
    const mismatchedScope = await app.inject({ method: "GET",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/archive/status?operation_id=${encodeURIComponent(input.operation_id)}&actor_id=actor_archive&commit_sha=commit-http&client_id=wrong&change_key=change-http`, headers: { authorization: "Bearer archive-token" } });
    expect(mismatchedScope.statusCode).toBe(409);
    expect(mismatchedScope.json().error.code).toBe("REMOTE_ARCHIVE_LEASE_SCOPE_MISMATCH");
    const actorMismatch = await app.inject({ method: "GET",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/archive/status?operation_id=${encodeURIComponent(input.operation_id)}&actor_id=attacker&commit_sha=commit-http&client_id=client-http&change_key=change-http`, headers: { authorization: "Bearer archive-token" } });
    expect(actorMismatch.statusCode).toBe(403);
    expect(actorMismatch.json().error.code).toBe("PROJECT_INFORMATION_FORBIDDEN");
    const commit = await app.inject({ method: "POST",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/archive:commit`, headers: base, payload: commitBody });
    expect(commit.statusCode).toBe(200);
    const shadowCommit = await app.inject({ method: "POST",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/archive/commit`, headers: base, payload: commitBody });
    expect(shadowCommit.statusCode).toBe(404);
    expect(commit.json()).toMatchObject({ record: { state: "committed" }, receipt: { operation_id: input.operation_id } });
    const receipt = await app.inject({ method: "GET",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/archive/${encodeURIComponent(input.operation_id)}/receipt?${query}`,
      headers: { authorization: "Bearer archive-token" } });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json()).toMatchObject({ receipt: { operation_id: input.operation_id } });
  });

  it("rejects a source outside the authenticated project before invoking the adapter", async () => {
    const service = createInMemoryRemoteArchiveV2();
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), remoteSyncArchive: service });
    const input = request();
    const metadata = { ...input.metadata, source: { ...input.metadata.source, actor_id: "attacker" } };
    const foreign = { ...input, metadata, payload_hash: remoteSyncArchiveHttpStableHash(metadata) };
    const response = await app.inject({ method: "POST",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/archive:prepare`, headers: {
        authorization: "Bearer archive-token", "content-type": "application/json", "idempotency-key": input.idempotency_key
      }, payload: foreign });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("PROJECT_INFORMATION_FORBIDDEN");
  });

  it("maps malformed prepare, commit, status, and receipt input to a fixed 400", async () => {
    const service = createInMemoryRemoteArchiveV2();
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), remoteSyncArchive: service });
    const input = request();
    const base = { authorization: "Bearer archive-token", "content-type": "application/json", "idempotency-key": input.idempotency_key };
    const responses = await Promise.all([
      app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/branches/main/remote-sync/archive:prepare`, headers: base,
        payload: { ...input, lease_ttl_ms: "not-a-number" } }),
      app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/branches/main/remote-sync/archive:commit`, headers: base, payload: {} }),
      app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/branches/main/remote-sync/archive/status?operation_id=${encodeURIComponent(input.operation_id)}`, headers: { authorization: "Bearer archive-token" } }),
      app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/branches/main/remote-sync/archive/not-an-operation/receipt?actor_id=actor_archive`, headers: { authorization: "Bearer archive-token" } })
    ]);
    for (const response of responses) {
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("REMOTE_ARCHIVE_INPUT_INVALID");
    }
  });

  it("maps a structurally valid prepare payload hash mismatch to the frozen 422", async () => {
    const service = createInMemoryRemoteArchiveV2();
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), remoteSyncArchive: service });
    const input = request();
    const response = await app.inject({ method: "POST",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/archive:prepare`,
      headers: { authorization: "Bearer archive-token", "content-type": "application/json", "idempotency-key": input.idempotency_key },
      payload: { ...input, payload_hash: hash("f") } });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("REMOTE_ARCHIVE_PAYLOAD_HASH_MISMATCH");
  });

  it("fails closed when an adapter reports a known archive code for the wrong endpoint", async () => {
    const core = createInMemoryRemoteArchiveV2();
    const input = request();
    const prepared = await core.prepare(input);
    if (prepared.claim === null) throw new Error("prepared claim missing");
    const service = {
      prepare: async () => { throw Object.assign(new Error("prepare-secret"), { code: "REMOTE_ARCHIVE_PREPARE_NOT_FOUND" }); },
      commit: async () => { throw Object.assign(new Error("commit-secret"), { code: "REMOTE_ARCHIVE_PAYLOAD_HASH_MISMATCH" }); },
      status: async () => { throw Object.assign(new Error("status-secret"), { code: "REMOTE_ARCHIVE_PREPARE_EXPIRED" }); },
      receipt: async () => { throw Object.assign(new Error("receipt-secret"), { code: "REMOTE_ARCHIVE_IDEMPOTENCY_CONFLICT" }); }
    };
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), remoteSyncArchive: service });
    const base = { authorization: "Bearer archive-token", "content-type": "application/json", "idempotency-key": input.idempotency_key };
    const query = new URLSearchParams({ operation_id: input.operation_id, actor_id: "actor_archive", commit_sha: "commit-http", client_id: "client-http", change_key: "change-http" });
    const responses = await Promise.all([
      app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/branches/main/remote-sync/archive:prepare`, headers: base, payload: input }),
      app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/branches/main/remote-sync/archive:commit`, headers: base,
        payload: { claim: prepared.claim, idempotency_key: input.idempotency_key, payload_hash: input.payload_hash } }),
      app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/branches/main/remote-sync/archive/status?${query}`,
        headers: { authorization: "Bearer archive-token" } }),
      app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/branches/main/remote-sync/archive/${encodeURIComponent(input.operation_id)}/receipt?${query}`,
        headers: { authorization: "Bearer archive-token" } })
    ]);
    for (const response of responses) {
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe("REMOTE_UNAVAILABLE");
      expect(response.body).not.toContain("secret");
    }
  });

  it("fails closed when an adapter reports a record invariant failure", async () => {
    const input = request();
    const service = {
      prepare: async () => { throw Object.assign(new Error("record-secret"), { code: "REMOTE_ARCHIVE_RECORD_INVALID" }); },
      commit: async () => null,
      status: async () => null,
      receipt: async () => null
    };
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), remoteSyncArchive: service });
    const response = await app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/branches/main/remote-sync/archive:prepare`,
      headers: { authorization: "Bearer archive-token", "content-type": "application/json", "idempotency-key": input.idempotency_key }, payload: input });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("REMOTE_UNAVAILABLE");
    expect(response.body).not.toContain("record-secret");
  });

  it("fails closed when an archive adapter tries to report an authentication failure", async () => {
    const input = request();
    const service = {
      prepare: async () => null,
      commit: async () => null,
      status: async () => { throw Object.assign(new Error("auth-secret"), { code: "AUTH_REQUIRED" }); },
      receipt: async () => null
    };
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), remoteSyncArchive: service });
    const query = new URLSearchParams({ operation_id: input.operation_id, actor_id: "actor_archive", commit_sha: "commit-http", client_id: "client-http", change_key: "change-http" });
    const response = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/branches/main/remote-sync/archive/status?${query}`,
      headers: { authorization: "Bearer archive-token" } });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("REMOTE_UNAVAILABLE");
    expect(response.body).not.toContain("auth-secret");
  });

  it("fails closed when a valid adapter response changes an optional lookup source binding", async () => {
    const core = createInMemoryRemoteArchiveV2({ clock: () => new Date("2026-08-15T00:00:00.000Z") });
    const input = request();
    const prepared = await core.prepare(input);
    if (prepared.claim === null) throw new Error("claim missing");
    const foreignSource = { ...input.metadata.source, client_id: "victim-client" };
    const forgeRecord = (record: typeof prepared.record) => {
      const metadata = { schema_version: 2 as const, source: foreignSource, archive_id: record.archive_id,
        identities: record.identities, upload_ref: record.upload_ref };
      const payload_hash = remoteSyncArchiveHttpStableHash(metadata);
      const prepare_id = `remote_archive_prepare:${remoteSyncArchiveHttpStableHash({ operation_id: record.operation_id,
        idempotency_key: record.idempotency_key, payload_hash })}`;
      const { record_hash: ignored, ...body } = { ...record, source: foreignSource, payload_hash, prepare_id };
      void ignored;
      return { ...body, record_hash: remoteSyncArchiveHttpStableHash(body) };
    };
    const forgeReceipt = (receipt: NonNullable<Awaited<ReturnType<typeof core.receipt>>>) => {
      const { receipt_hash: ignoredHash, receipt_id: ignoredId, ...body } = { ...receipt, source: foreignSource };
      void ignoredHash; void ignoredId;
      const receipt_hash = remoteSyncArchiveHttpStableHash(body);
      return { ...body, receipt_hash, receipt_id: `remote_archive_receipt:${receipt_hash}` };
    };
    const service = {
      prepare: async (value: Parameters<typeof core.prepare>[0]) => core.prepare(value),
      commit: async (value: Parameters<typeof core.commit>[0]) => core.commit(value),
      status: async () => ({ operation_id: input.operation_id, state: "prepared" as const, record: forgeRecord(prepared.record) }),
      receipt: async () => forgeReceipt((await core.commit({ claim: prepared.claim })).receipt)
    };
    app = await createServer({ repository, storage: new MemoryArtifactStorage(), remoteSyncArchive: service });
    const sourceQuery = new URLSearchParams({ actor_id: "actor_archive", commit_sha: "commit-http", client_id: "client-http", change_key: "change-http" });
    const status = await app.inject({ method: "GET",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/archive/status?operation_id=${encodeURIComponent(input.operation_id)}&${sourceQuery}`,
      headers: { authorization: "Bearer archive-token" } });
    const receipt = await app.inject({ method: "GET",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/archive/${encodeURIComponent(input.operation_id)}/receipt?${sourceQuery}`,
      headers: { authorization: "Bearer archive-token" } });
    for (const response of [status, receipt]) {
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe("REMOTE_UNAVAILABLE");
      expect(response.body).not.toContain("victim-client");
    }
  });
});
