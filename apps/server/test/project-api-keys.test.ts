import { uuidV7 } from "@hunter-harness/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/app.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

describe("project-scoped API keys (P2)", () => {
  let repository: MemoryRepository;
  let app: Awaited<ReturnType<typeof createServer>>;
  let sessionToken: string;
  let projectId: string;

  beforeEach(async () => {
    repository = new MemoryRepository();
    app = await createServer({ repository, storage: new MemoryArtifactStorage() });

    await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { username: "owner", password: "super-secret-1" }
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "owner", password: "super-secret-1" }
    });
    sessionToken = login.json().token as string;

    const resolve = await app.inject({
      method: "POST",
      url: "/api/v1/projects:resolve",
      headers: {
        authorization: "Bearer " + sessionToken,
        "x-request-id": uuidV7(),
        "idempotency-key": uuidV7()
      },
      payload: {
        schema_version: 1,
        local_project_key: uuidV7(),
        display_name: "demo",
        requested_project_id: null,
        client_id: "cli_keys_test"
      }
    });
    expect(resolve.statusCode).toBe(200);
    projectId = resolve.json().project_id as string;
  });

  afterEach(async () => {
    await app.close();
  });

  async function issueKey(scopes: string[]): Promise<{ keyId: string; apiKey: string }> {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/api-keys`,
      headers: { authorization: "Bearer " + sessionToken },
      payload: { label: "test key", scopes }
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    return { keyId: body.key_id as string, apiKey: body.api_key as string };
  }

  it("issues a key with hh_ prefix, plaintext shown once, hash-only listing", async () => {
    const { apiKey } = await issueKey(["push", "files:read"]);
    expect(apiKey.startsWith("hh_")).toBe(true);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/api-keys`,
      headers: { authorization: "Bearer " + sessionToken }
    });
    expect(list.statusCode).toBe(200);
    const items = list.json().items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty("api_key");
    expect(items[0]?.scopes).toEqual(["push", "files:read"]);
  });

  it("authorizes in-scope routes and reports key info", async () => {
    const { apiKey } = await issueKey(["files:read"]);

    const files = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/files`,
      headers: { authorization: "Bearer " + apiKey, "x-request-id": uuidV7() }
    });
    expect(files.statusCode).toBe(200);

    const info = await app.inject({
      method: "GET",
      url: "/api/v1/auth/key-info",
      headers: { authorization: "Bearer " + apiKey }
    });
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({
      kind: "project-key",
      project_id: projectId,
      scopes: ["files:read"]
    });
  });

  it("rejects out-of-scope and unscoped routes", async () => {
    const { apiKey } = await issueKey(["files:read"]);

    const push = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/proposal-sessions`,
      headers: {
        authorization: "Bearer " + apiKey,
        "x-request-id": uuidV7(),
        "idempotency-key": uuidV7()
      },
      payload: {}
    });
    expect(push.statusCode).toBe(403);
    expect(push.json().error.code).toBe("PROJECT_KEY_SCOPE");

    const dashboard = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/overview",
      headers: { authorization: "Bearer " + apiKey, "x-request-id": uuidV7() }
    });
    expect(dashboard.statusCode).toBe(403);
  });

  it("rejects keys used against a different project", async () => {
    const { apiKey } = await issueKey(["files:read"]);
    const other = await app.inject({
      method: "GET",
      url: "/api/v1/projects/prj_other/files",
      headers: { authorization: "Bearer " + apiKey, "x-request-id": uuidV7() }
    });
    expect(other.statusCode).toBe(403);
    expect(other.json().error.code).toBe("PROJECT_KEY_MISMATCH");
  });

  it("revokes keys", async () => {
    const { keyId, apiKey } = await issueKey(["files:read"]);

    const revoke = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}/api-keys/${keyId}`,
      headers: { authorization: "Bearer " + sessionToken }
    });
    expect(revoke.statusCode).toBe(200);

    const afterRevoke = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/files`,
      headers: { authorization: "Bearer " + apiKey, "x-request-id": uuidV7() }
    });
    expect(afterRevoke.statusCode).toBe(401);
  });

  it("requires a login session (not an API token) to manage keys", async () => {
    await repository.createActorWithToken({ actorId: "actor_owner", token: "legacy-token" });
    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/api-keys`,
      headers: { authorization: "Bearer legacy-token" },
      payload: { label: "x", scopes: ["push"] }
    });
    expect(denied.statusCode).toBe(403);
  });
});
