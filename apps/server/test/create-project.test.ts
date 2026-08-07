import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { uuidV7 } from "@hunter-harness/core";

import { createServer } from "../src/app.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

describe("POST /api/v1/projects (S2)", () => {
  let repository: MemoryRepository;
  let app: Awaited<ReturnType<typeof createServer>>;
  let sessionToken: string;

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
  });

  afterEach(async () => {
    await app.close();
  });

  it("creates a project for the authenticated user", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: {
        authorization: "Bearer " + sessionToken,
        "idempotency-key": uuidV7()
      },
      payload: { display_name: "Payments gateway" }
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      project: {
        display_name: "Payments gateway",
        role: "owner",
        lifecycle_state: "active"
      }
    });
    expect(String(response.json().project.project_id)).toMatch(/^prj_/);
  });

  it("rejects unauthenticated create", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { "idempotency-key": uuidV7() },
      payload: { display_name: "Nope" }
    });
    expect(response.statusCode).toBe(401);
  });

  it("returns a one-time api key when withKey=true", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects?withKey=true",
      headers: {
        authorization: "Bearer " + sessionToken,
        "idempotency-key": uuidV7()
      },
      payload: { display_name: "With Key" }
    });
    expect(response.statusCode).toBe(201);
    expect(String(response.json().api_key)).toMatch(/^hh_/);
    expect(response.json().key_id).toMatch(/^key_/);
  });
});
