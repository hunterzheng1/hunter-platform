import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/app.js";
import { projectApiKeyHash } from "../src/auth/accounts.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

/**
 * 项目绑定 API key 访问无 :projectId 路径参数的路由（projects:resolve）时，
 * 以 key 自身的绑定项目为准——此前一律 PROJECT_KEY_MISMATCH（kb-sdd update 阻断）。
 */
describe("project-bound API key on unbound routes", () => {
  const rawKey = "pk_test_resolve_key_01";
  let app: Awaited<ReturnType<typeof createServer>>;
  let repository: MemoryRepository;
  let projectId: string;

  beforeEach(async () => {
    repository = new MemoryRepository();
    await repository.createActorWithToken({ actorId: "actor_pk", token: "actor-token" });
    const project = await repository.createProject({ actorId: "actor_pk", displayName: "pk-project" });
    projectId = project.projectId;
    await repository.createProjectApiKey({
      keyId: "key_01",
      keyHash: projectApiKeyHash(rawKey),
      projectId,
      actorId: "actor_pk",
      label: "env-key",
      scopes: ["push"]
    });
    app = await createServer({ repository, storage: new MemoryArtifactStorage() });
  });

  afterEach(async () => {
    await app.close();
  });

  it("resolve with project key succeeds (key binding is the project)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects:resolve",
      headers: {
        authorization: `Bearer ${rawKey}`,
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID()
      },
      payload: {
        schema_version: 1,
        local_project_key: crypto.randomUUID(),
        display_name: "kb-sdd",
        requested_project_id: projectId,
        client_id: "cli_test01"
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ project_id: projectId });
  });

  it("resolve with project key of another project still binds to the key's project", async () => {
    // 指定了别的 requested_project_id 也不能越出 key 的绑定项目
    const other = await repository.createProject({ actorId: "actor_pk", displayName: "other" });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects:resolve",
      headers: {
        authorization: `Bearer ${rawKey}`,
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID()
      },
      payload: {
        schema_version: 1,
        local_project_key: crypto.randomUUID(),
        display_name: "kb-sdd",
        requested_project_id: other.projectId,
        client_id: "cli_test01"
      }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "PROJECT_KEY_MISMATCH" } });
  });
});
