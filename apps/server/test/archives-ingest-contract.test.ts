import { createHash } from "node:crypto";

import AdmZip from "adm-zip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/app.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

const sha256 = (value: Uint8Array | string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const canonicalJson = (value: unknown): string => JSON.stringify(sortValue(value));
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, sortValue(item)]));
  }
  return value;
}

function buildZip(changeKey: string): Buffer {
  const zip = new AdmZip();
  const manifest = {
    schema_version: 1,
    operation_id: `archive_operation:${"a".repeat(64)}`,
    change_identity: changeKey,
    source_snapshot_hash: sha256("snapshot"),
    files: [{
      path: "change-context.json",
      content_hash: "",
      size_bytes: 0
    }]
  };
  const contextBytes = Buffer.from(JSON.stringify({ schema_version: 1, change_key: changeKey }));
  manifest.files[0].content_hash = sha256(contextBytes);
  manifest.files[0].size_bytes = contextBytes.byteLength;
  zip.addFile("archive-manifest.json", Buffer.from(JSON.stringify(manifest)));
  zip.addFile("change-context.json", contextBytes);
  return zip.toBuffer();
}

describe("archives:ingest HTTP contract (06B-3 T0-4)", () => {
  const token = "ingest-contract-token";
  let app: Awaited<ReturnType<typeof createServer>>;
  let repository: MemoryRepository;

  let projectId = "prj_ingest";
  const changeKey = "change-ingest-01";
  const archiveId = "arc_ingest_01";
  const requestId = "req-ingest-01";

  function protocolHeaders(zip: Buffer) {
    const packageSha256 = sha256(zip);
    const idempotency = sha256(canonicalJson({
      project_id: projectId,
      change_key: changeKey,
      archive_schema_version: 1,
      package_sha256: packageSha256,
      archive_id: archiveId
    }));
    return {
      authorization: `Bearer ${token}`,
      "content-type": "application/zip",
      "idempotency-key": crypto.randomUUID(),
      "x-archive-request-id": requestId,
      "x-archive-id": archiveId,
      "x-archive-change-key": changeKey,
      "x-archive-schema-version": "1",
      "x-archive-package-sha256": packageSha256,
      "x-archive-idempotency-key": idempotency,
      "x-archive-logical-slot": sha256(canonicalJson({
        project_id: projectId, change_key: changeKey, archive_schema_version: 1
      }))
    };
  }

  beforeEach(async () => {
    repository = new MemoryRepository();
    await repository.createActorWithToken({ actorId: "actor_ingest", token });
    const project = await repository.createProject({ actorId: "actor_ingest", displayName: "ingest" });
    projectId = project.projectId;
    storage = new MemoryArtifactStorage();
    app = await createServer({ repository, storage });
  });

  let storage: MemoryArtifactStorage;

  // 播种一个 artifact 版本锚点（ingest 的 as-of project_version 来源）
  async function seedVersionAnchor(): Promise<void> {
    const { fileOperationSchema } = await import("@hunter-harness/contracts");
    const { sha256Bytes: sb } = await import("@hunter-harness/core");
    const cj = (v: unknown) => JSON.stringify(v);
    const content = new TextEncoder().encode("seed");
    const contentSha = sb(content);
    await storage.putBlob(contentSha, content);
    const project = await repository.getProject("actor_ingest", projectId);
    const session = await repository.createProposalSession({
      actorId: "actor_ingest",
      projectId,
      baseProjectVersion: project.latestProjectVersion,
      baseManifestHash: sb(cj([])),
      operations: [fileOperationSchema.parse({
        operation: "add",
        path: ".harness/seed.json",
        file_kind: "user_editable",
        content_sha256: contentSha,
        size_bytes: content.byteLength
      })],
      scanOverrides: [],
      status: "open",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxChunkBytes: 1024 * 1024
    });
    await repository.finalizeSessionAutoApprove(session);
  }

  afterEach(async () => {
    await app.close();
  });

  it("accepts a conforming package and returns ArchiveSyncReceipt", async () => {
    await seedVersionAnchor();
    const zip = buildZip(changeKey);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/archives:ingest`,
      headers: protocolHeaders(zip),
      payload: zip
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({
      request_id: requestId,
      project_id: projectId,
      archive_id: archiveId,
      change_key: changeKey,
      archive_status: "stored",
      retryable: false
    });
    expect(body.project_version).toMatch(/^pv_/u);
    expect(body.package_sha256).toBe(sha256(zip));
  });

  it("rejects idempotency key that does not match derived identity", async () => {
    const zip = buildZip(changeKey);
    const headers = { ...protocolHeaders(zip), "x-archive-idempotency-key": sha256("forged") };
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/archives:ingest`,
      headers,
      payload: zip
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "ARCHIVE_INGEST_IDENTITY_MISMATCH" } });
  });

  it("rejects package bytes that do not match declared sha256", async () => {
    const zip = buildZip(changeKey);
    const headers = { ...protocolHeaders(zip), "x-archive-package-sha256": sha256("other-bytes") };
    // idempotency 也要与伪造 hash 一致才能走到字节校验
    headers["x-archive-idempotency-key"] = sha256(canonicalJson({
      project_id: projectId,
      change_key: changeKey,
      archive_schema_version: 1,
      package_sha256: sha256("other-bytes"),
      archive_id: archiveId
    }));
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/archives:ingest`,
      headers,
      payload: zip
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: "ARCHIVE_PACKAGE_HASH_MISMATCH" } });
  });

  it("rejects non-zip media type", async () => {
    const zip = buildZip(changeKey);
    const headers = { ...protocolHeaders(zip), "content-type": "application/octet-stream" };
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/archives:ingest`,
      headers,
      payload: zip
    });
    expect(response.statusCode).toBe(415);
  });

  it("missing protocol headers fail closed", async () => {
    const zip = buildZip(changeKey);
    const headers = { ...protocolHeaders(zip) } as Record<string, string>;
    delete headers["x-archive-package-sha256"];
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/archives:ingest`,
      headers,
      payload: zip
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "ARCHIVE_INGEST_INPUT_INVALID" } });
  });
});
