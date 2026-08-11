import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/app.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

describe("npm publishing credential settings", () => {
  let repository: MemoryRepository;
  let app: Awaited<ReturnType<typeof createServer>>;
  let serverOptions: Parameters<typeof createServer>[0];
  let ownerToken: string;
  let memberToken: string;

  beforeEach(async () => {
    repository = new MemoryRepository();
    await repository.createActorWithToken({ actorId: "actor_owner", token: "owner-api-token" });
    serverOptions = {
      repository,
      storage: new MemoryArtifactStorage(),
      npmPublishConfig: { scope: "@hunter-harness", token: "npm_deployment_secret" },
      npmCredentialEncryptionKey: Buffer.alloc(32, 7),
      npmCredentialVerifier: async (token: string) => {
        if (token !== "npm_managed_secret" && token !== "npm_deployment_secret") {
          throw new Error("registry rejected credential");
        }
        return { username: "hunterzheng" };
      }
    };
    app = await createServer(serverOptions);

    await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { username: "owner", password: "owner-password-1" }
    });
    const ownerLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "owner", password: "owner-password-1" }
    });
    ownerToken = ownerLogin.json().token as string;

    const invite = await app.inject({
      method: "POST",
      url: "/api/v1/auth/invites",
      headers: { authorization: `Bearer ${ownerToken}` }
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: "member",
        password: "member-password-1",
        invite_code: invite.json().invite_code
      }
    });
    const memberLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "member", password: "member-password-1" }
    });
    memberToken = memberLogin.json().token as string;
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns deployment status to the owner without exposing the token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system/npm-publishing",
      headers: { authorization: `Bearer ${ownerToken}` }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      scope: "@hunter-harness",
      source: "deployment",
      state: "configured",
      username: null,
      expires_at: null,
      can_manage: true
    });
    expect(response.body).not.toContain("npm_deployment_secret");
    expect(response.body).not.toContain("token");
  });

  it("rejects members and non-session API tokens", async () => {
    const member = await app.inject({
      method: "GET",
      url: "/api/v1/system/npm-publishing",
      headers: { authorization: `Bearer ${memberToken}` }
    });
    expect(member.statusCode).toBe(403);
    expect(member.json().error.code).toBe("OWNER_REQUIRED");

    const apiToken = await app.inject({
      method: "GET",
      url: "/api/v1/system/npm-publishing",
      headers: { authorization: "Bearer owner-api-token" }
    });
    expect(apiToken.statusCode).toBe(403);
    expect(apiToken.json().error.code).toBe("SESSION_REQUIRED");
  });

  it("prevents members from using the server-wide publishing credential", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/skills/member-cannot-publish/publish",
      headers: {
        authorization: `Bearer ${memberToken}`,
        "idempotency-key": "00000000-0000-4000-8000-000000000008"
      },
      payload: {
        version: "0.1.0",
        sourceAgent: "claude-code",
        draftRevision: 1,
        releaseNote: null
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("OWNER_REQUIRED");
  });

  it("verifies the active deployment credential and returns only its npm identity", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/system/npm-publishing/verify",
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "idempotency-key": "00000000-0000-4000-8000-000000000002"
      },
      payload: { schema_version: 1 }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      scope: "@hunter-harness",
      source: "deployment",
      state: "ready",
      username: "hunterzheng"
    });
    expect(response.body).not.toContain("npm_deployment_secret");
  });

  it("verifies and stores a managed token without returning or auditing plaintext", async () => {
    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/system/npm-publishing/credential",
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "idempotency-key": "00000000-0000-4000-8000-000000000001"
      },
      payload: {
        schema_version: 1,
        token: "npm_managed_secret",
        expires_at: expiresAt
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      scope: "@hunter-harness",
      source: "managed",
      state: "ready",
      username: "hunterzheng",
      expires_at: expiresAt
    });
    expect(response.body).not.toContain("npm_managed_secret");

    const status = await app.inject({
      method: "GET",
      url: "/api/v1/system/npm-publishing",
      headers: { authorization: `Bearer ${ownerToken}` }
    });
    expect(status.json()).toMatchObject({ source: "managed", state: "ready", username: "hunterzheng" });

    const audit = await repository.listAuditEvents({ actorId: "actor_owner", limit: 20 });
    const event = audit.find((item) => item.action === "npm.credential.set");
    expect(event).toBeDefined();
    expect(JSON.stringify(event)).not.toContain("npm_managed_secret");
  });

  it("keeps the active credential and writes a redacted audit when rotation is rejected", async () => {
    const first = await app.inject({
      method: "PUT",
      url: "/api/v1/system/npm-publishing/credential",
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "idempotency-key": "00000000-0000-4000-8000-000000000003"
      },
      payload: { schema_version: 1, token: "npm_managed_secret", expires_at: null }
    });
    expect(first.statusCode).toBe(200);

    const rejected = await app.inject({
      method: "PUT",
      url: "/api/v1/system/npm-publishing/credential",
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "idempotency-key": "00000000-0000-4000-8000-000000000004"
      },
      payload: { schema_version: 1, token: "npm_invalid_replacement", expires_at: null }
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().error.code).toBe("NPM_CREDENTIAL_INVALID");
    expect(rejected.body).not.toContain("npm_invalid_replacement");

    const status = await app.inject({
      method: "GET",
      url: "/api/v1/system/npm-publishing",
      headers: { authorization: `Bearer ${ownerToken}` }
    });
    expect(status.json()).toMatchObject({ source: "managed", state: "ready", username: "hunterzheng" });

    const audit = await repository.listAuditEvents({ actorId: "actor_owner", limit: 20 });
    const event = audit.find((item) => item.action === "npm.credential.rejected");
    expect(event).toMatchObject({ details: { code: "NPM_CREDENTIAL_INVALID" } });
    expect(JSON.stringify(event)).not.toContain("npm_invalid_replacement");
    expect(JSON.stringify(event)).not.toContain("npm_managed_secret");
  });

  it("removes the managed credential and falls back to the deployment secret", async () => {
    const configured = await app.inject({
      method: "PUT",
      url: "/api/v1/system/npm-publishing/credential",
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "idempotency-key": "00000000-0000-4000-8000-000000000005"
      },
      payload: { schema_version: 1, token: "npm_managed_secret", expires_at: null }
    });
    expect(configured.statusCode).toBe(200);

    const removed = await app.inject({
      method: "DELETE",
      url: "/api/v1/system/npm-publishing/credential",
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "idempotency-key": "00000000-0000-4000-8000-000000000006"
      },
      payload: { schema_version: 1 }
    });

    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({
      source: "deployment",
      state: "configured",
      username: null
    });
    const audit = await repository.listAuditEvents({ actorId: "actor_owner", limit: 20 });
    expect(audit.some((item) => item.action === "npm.credential.removed")).toBe(true);
  });

  it("keeps the encrypted managed credential across server restarts", async () => {
    const configured = await app.inject({
      method: "PUT",
      url: "/api/v1/system/npm-publishing/credential",
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "idempotency-key": "00000000-0000-4000-8000-000000000007"
      },
      payload: { schema_version: 1, token: "npm_managed_secret", expires_at: null }
    });
    expect(configured.statusCode).toBe(200);

    await app.close();
    app = await createServer(serverOptions);
    const status = await app.inject({
      method: "GET",
      url: "/api/v1/system/npm-publishing",
      headers: { authorization: `Bearer ${ownerToken}` }
    });

    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ source: "managed", state: "ready", username: "hunterzheng" });
  });
});
