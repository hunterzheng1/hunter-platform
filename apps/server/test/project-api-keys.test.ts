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
      project_display_name: "demo",
      scopes: ["files:read"]
    });
  });

  it("issues the formal platform:read scope", async () => {
    const { apiKey } = await issueKey(["platform:read"]);
    const info = await app.inject({
      method: "GET",
      url: "/api/v1/auth/key-info",
      headers: { authorization: "Bearer " + apiKey }
    });
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({ project_id: projectId, scopes: ["platform:read"] });
  });

  it("issues archive scopes and enforces read versus write upload access", async () => {
    const readKey = await issueKey(["archive:read"]);
    const readStatus = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/content-upload/status`,
      headers: {
        authorization: "Bearer " + readKey.apiKey,
        "idempotency-key": `sha256:${"a".repeat(64)}`
      }
    });
    expect(readStatus.statusCode).toBe(503);
    expect(readStatus.json().error.code).toBe("REMOTE_UNAVAILABLE");
    const readUpload = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/content-upload`,
      headers: { authorization: "Bearer " + readKey.apiKey }
    });
    expect(readUpload.statusCode).toBe(403);
    expect(readUpload.json().error.code).toBe("PROJECT_KEY_SCOPE");

    const writeKey = await issueKey(["archive:write"]);
    const writeUpload = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/content-upload`,
      headers: {
        authorization: "Bearer " + writeKey.apiKey,
        "content-type": "application/zip"
      }
    });
    expect(writeUpload.statusCode).toBe(503);
    expect(writeUpload.json().error.code).toBe("REMOTE_UNAVAILABLE");
    const writeStatus = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/branches/main/remote-sync/content-upload/status`,
      headers: { authorization: "Bearer " + writeKey.apiKey }
    });
    expect(writeStatus.statusCode).toBe(403);
    expect(writeStatus.json().error.code).toBe("PROJECT_KEY_SCOPE");
  });

  it("allows knowledge:read only for the key's bound project", async () => {
    const { apiKey } = await issueKey(["knowledge:read"]);

    const ownProject = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/semantic/search?q=architecture`,
      headers: { authorization: "Bearer " + apiKey }
    });
    expect(ownProject.statusCode).toBe(200);

    const globalSearch = await app.inject({
      method: "GET",
      url: `/api/v1/semantic/search?q=architecture&project_id=${projectId}`,
      headers: { authorization: "Bearer " + apiKey }
    });
    expect(globalSearch.statusCode).toBe(403);

    const otherProject = await app.inject({
      method: "GET",
      url: "/api/v1/projects/prj_other/semantic/search?q=architecture",
      headers: { authorization: "Bearer " + apiKey }
    });
    expect(otherProject.statusCode).toBe(403);
    expect(otherProject.json().error.code).toBe("PROJECT_KEY_MISMATCH");
  });

  it("lets a push-scoped key read the project it is bound to", async () => {
    // push 流程的第一个调用就是 GET /api/v1/projects/{id}（取 baseline 与版本），
    // 之后才轮到 projects:resolve。该路由此前没声明 scope，project key 走
    // default-deny 被 403，push 在 project_id 都没解析出来时就整体失败——现场
    // 表现是"分支文件里没有 plan/spec"，因为它们全靠这条推送上传。
    const { apiKey } = await issueKey(["push"]);

    const project = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}`,
      headers: { authorization: "Bearer " + apiKey, "x-request-id": uuidV7() }
    });

    expect(project.statusCode).toBe(200);
    expect(project.json().project_id).toBe(projectId);
  });

  it("still denies the project read to a key without push scope", async () => {
    const { apiKey } = await issueKey(["knowledge:read"]);

    const project = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}`,
      headers: { authorization: "Bearer " + apiKey, "x-request-id": uuidV7() }
    });

    expect(project.statusCode).toBe(403);
    expect(project.json().error.code).toBe("PROJECT_KEY_SCOPE");
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


describe("API key reveal（可恢复查看）", () => {
  let repository: MemoryRepository;
  let sessionToken: string;
  let projectId: string;

  async function boot(withKey: boolean) {
    repository = new MemoryRepository();
    const app = await createServer({
      repository,
      storage: new MemoryArtifactStorage(),
      ...(withKey ? { projectKeyEncryptionKey: new Uint8Array(32).fill(7) } : {})
    });
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
    const { uuidV7: uuid } = await import("@hunter-harness/core");
    const resolve = await app.inject({
      method: "POST",
      url: "/api/v1/projects:resolve",
      headers: {
        authorization: "Bearer " + sessionToken,
        "x-request-id": uuid(),
        "idempotency-key": uuid()
      },
      payload: {
        schema_version: 1,
        local_project_key: uuid(),
        display_name: "demo",
        requested_project_id: null,
        client_id: "cli_reveal_test"
      }
    });
    projectId = resolve.json().project_id as string;
    return app;
  }

  it("配置包裹密钥：创建后可再次查看同一明文", async () => {
    const app = await boot(true);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/api-keys`,
      headers: { authorization: "Bearer " + sessionToken },
      payload: { label: "reveal me", scopes: ["push"] }
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { key_id: string; api_key: string; revealable: boolean };
    expect(body.revealable).toBe(true);

    const revealed = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/api-keys/${body.key_id}/reveal`,
      headers: { authorization: "Bearer " + sessionToken }
    });
    expect(revealed.statusCode).toBe(200);
    expect(revealed.json()).toMatchObject({ key_id: body.key_id, api_key: body.api_key });
    const audit = await repository.listAuditEvents();
    const revealEvent = audit.find((event) => event.action === "project_api_key.revealed");
    expect(revealEvent?.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
    );
    await app.close();
  });

  it("未配置包裹密钥：revealable=false 且 reveal 返回 409", async () => {
    const app = await boot(false);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/api-keys`,
      headers: { authorization: "Bearer " + sessionToken },
      payload: { label: "legacy", scopes: ["push"] }
    });
    const body = created.json() as { key_id: string; revealable: boolean };
    expect(body.revealable).toBe(false);

    const revealed = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/api-keys/${body.key_id}/reveal`,
      headers: { authorization: "Bearer " + sessionToken }
    });
    expect(revealed.statusCode).toBe(409);
    expect(revealed.json()).toMatchObject({ error: { code: "KEY_NOT_REVEALABLE" } });
    await app.close();
  });

  it("项目 API key 不能用于揭示（仅登录会话）", async () => {
    const app = await boot(true);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/api-keys`,
      headers: { authorization: "Bearer " + sessionToken },
      payload: { label: "guard", scopes: ["push"] }
    });
    const body = created.json() as { key_id: string; api_key: string };

    const revealed = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/api-keys/${body.key_id}/reveal`,
      headers: { authorization: "Bearer " + body.api_key }
    });
    expect([401, 403]).toContain(revealed.statusCode);
    await app.close();
  });
});
