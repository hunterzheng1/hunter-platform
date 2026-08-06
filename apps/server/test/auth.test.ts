import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/app.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

describe("account login and session tokens (P2 auth)", () => {
  let repository: MemoryRepository;
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    repository = new MemoryRepository();
    await repository.createActorWithToken({ actorId: "actor_owner", token: "api-token" });
    app = await createServer({ repository, storage: new MemoryArtifactStorage() });
  });

  afterEach(async () => {
    await app.close();
  });

  async function register(
    username: string,
    password: string,
    inviteCode?: string
  ): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username,
        password,
        ...(inviteCode === undefined ? {} : { invite_code: inviteCode })
      }
    });
    return { statusCode: response.statusCode, body: response.json() };
  }

  async function login(username: string, password: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username, password }
    });
    return { statusCode: response.statusCode, body: response.json() };
  }

  it("reports whether any users exist", async () => {
    const before = await app.inject({ method: "GET", url: "/api/v1/auth/status" });
    expect(before.json()).toMatchObject({ users_exist: false });

    await register("owner", "super-secret-1");

    const after = await app.inject({ method: "GET", url: "/api/v1/auth/status" });
    expect(after.json()).toMatchObject({ users_exist: true });
  });

  it("lets the first user register without an invite and binds the bootstrap actor", async () => {
    const result = await register("owner", "super-secret-1");
    expect(result.statusCode).toBe(201);
    expect(result.body.user).toMatchObject({
      username: "owner",
      actor_id: "actor_owner"
    });
  });

  it("rejects the second registration without a valid invite", async () => {
    await register("owner", "super-secret-1");

    const noInvite = await register("second", "super-secret-2");
    expect(noInvite.statusCode).toBe(403);
    expect((noInvite.body.error as Record<string, unknown>).code).toBe("INVITE_REQUIRED");

    const badInvite = await register("second", "super-secret-2", "hhi_bogus");
    expect(badInvite.statusCode).toBe(403);
    expect((badInvite.body.error as Record<string, unknown>).code).toBe("INVITE_INVALID");
  });

  it("registers a second user through an invite issued by a logged-in user", async () => {
    await register("owner", "super-secret-1");
    const session = await login("owner", "super-secret-1");
    expect(session.statusCode).toBe(200);
    const token = session.body.token as string;
    expect(token.startsWith("hhs_")).toBe(true);

    const invite = await app.inject({
      method: "POST",
      url: "/api/v1/auth/invites",
      headers: { authorization: "Bearer " + token }
    });
    expect(invite.statusCode).toBe(201);
    const code = invite.json().invite_code as string;
    expect(code.startsWith("hhi_")).toBe(true);

    const second = await register("second", "super-secret-2", code);
    expect(second.statusCode).toBe(201);
    expect((second.body.user as Record<string, unknown>).actor_id).not.toBe("actor_owner");

    // Invite codes are single-use.
    const reuse = await register("third", "super-secret-3", code);
    expect(reuse.statusCode).toBe(403);
  });

  it("rejects wrong credentials", async () => {
    await register("owner", "super-secret-1");
    const wrongPassword = await login("owner", "not-the-password");
    expect(wrongPassword.statusCode).toBe(401);
    const wrongUser = await login("ghost", "super-secret-1");
    expect(wrongUser.statusCode).toBe(401);
  });

  it("accepts session tokens as Bearer auth on protected routes", async () => {
    await register("owner", "super-secret-1");
    const session = await login("owner", "super-secret-1");
    const token = session.body.token as string;

    const projects = await app.inject({
      method: "GET",
      url: "/api/v1/projects?limit=5",
      headers: { authorization: "Bearer " + token }
    });
    expect(projects.statusCode).toBe(200);

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: "Bearer " + token }
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toMatchObject({ username: "owner" });
  });

  it("invalidates the session after logout", async () => {
    await register("owner", "super-secret-1");
    const session = await login("owner", "super-secret-1");
    const token = session.body.token as string;

    const logout = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { authorization: "Bearer " + token }
    });
    expect(logout.statusCode).toBe(200);

    const afterLogout = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: "Bearer " + token }
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it("still accepts legacy API tokens", async () => {
    const projects = await app.inject({
      method: "GET",
      url: "/api/v1/projects?limit=5",
      headers: { authorization: "Bearer api-token" }
    });
    expect(projects.statusCode).toBe(200);
  });

  it("refuses invite issuance for plain API tokens", async () => {
    const invite = await app.inject({
      method: "POST",
      url: "/api/v1/auth/invites",
      headers: { authorization: "Bearer api-token" }
    });
    expect(invite.statusCode).toBe(403);
  });
});
