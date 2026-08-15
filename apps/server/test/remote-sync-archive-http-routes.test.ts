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
      source: { project_id: projectId, branch_name: "main", actor_id: "actor_archive" },
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
    const prepare = await app.inject({ method: "POST",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/archive/prepare`, headers: base, payload: input });
    expect(prepare.statusCode).toBe(201);
    const prepared = prepare.json();
    expect(prepared.outcome).toBe("new");
    const replay = await app.inject({ method: "POST",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/archive/prepare`, headers: base, payload: input });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ outcome: "replay", claim: null, record: { operation_id: input.operation_id } });
    const commitBody = { claim: prepared.claim, idempotency_key: input.idempotency_key, payload_hash: input.payload_hash };
    const commit = await app.inject({ method: "POST",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/archive/commit`, headers: base, payload: commitBody });
    expect(commit.statusCode).toBe(200);
    expect(commit.json()).toMatchObject({ record: { state: "committed" }, receipt: { operation_id: input.operation_id } });
    const receipt = await app.inject({ method: "GET",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/archive/${encodeURIComponent(input.operation_id)}/receipt`,
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
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/archive/prepare`, headers: {
        authorization: "Bearer archive-token", "content-type": "application/json", "idempotency-key": input.idempotency_key
      }, payload: foreign });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("PROJECT_INFORMATION_FORBIDDEN");
  });
});
