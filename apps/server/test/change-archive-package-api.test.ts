import { sha256Bytes, uuidV7 } from "@hunter-harness/core";
import AdmZip from "adm-zip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/app.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { SemanticMemoryStore } from "../src/semantic/memory-store.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

class FailOnceSemanticStore extends SemanticMemoryStore {
  private failed = false;

  override async rebuild(build: Parameters<SemanticMemoryStore["rebuild"]>[0]): Promise<void> {
    if (!this.failed) {
      this.failed = true;
      throw new Error("simulated indexing outage");
    }
    await super.rebuild(build);
  }
}

describe("change archive package API", () => {
  const token = "archive-owner-token";
  let repository: MemoryRepository;
  let storage: MemoryArtifactStorage;
  let semanticStore: SemanticMemoryStore;
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    repository = new MemoryRepository();
    storage = new MemoryArtifactStorage();
    semanticStore = new SemanticMemoryStore();
    await repository.createActorWithToken({ actorId: "actor_archive_owner", token });
    app = await createServer({ repository, storage, semanticStore });
  });

  afterEach(async () => {
    await app.close();
  });

  function headers(contentType = "application/zip"): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      "content-type": contentType,
      "x-request-id": uuidV7(),
      "idempotency-key": uuidV7()
    };
  }

  async function resolveProject(): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects:resolve",
      headers: headers("application/json"),
      payload: {
        schema_version: 1,
        local_project_key: uuidV7(),
        display_name: "归档测试项目",
        requested_project_id: null,
        client_id: "cli_test"
      }
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().project_id as string;
  }

  function archiveZip(
    changeKey: string,
    files: Array<{ path: string; role: string; content: string }>,
    extras: Array<{ path: string; content: string }> = []
  ): Buffer {
    const zip = new AdmZip();
    const declared = files.map((file) => {
      const bytes = Buffer.from(file.content, "utf8");
      zip.addFile(file.path, bytes);
      return {
        path: file.path,
        role: file.role,
        media_type: file.path.endsWith(".json") ? "application/json" : "text/markdown",
        content_sha256: sha256Bytes(bytes),
        size_bytes: bytes.byteLength
      };
    });
    for (const extra of extras) zip.addFile(extra.path, Buffer.from(extra.content, "utf8"));
    zip.addFile("archive-manifest.json", Buffer.from(JSON.stringify({
      schema_version: 1,
      profile: "core-v1",
      change_key: changeKey,
      created_at: "2026-08-08T00:00:00.000Z",
      source: { commit: "0123456789abcdef", tree: null },
      files: declared
    }), "utf8"));
    return zip.toBuffer();
  }

  it("durably stores one verified ZIP, publishes core files, and indexes archive knowledge", async () => {
    const projectId = await resolveProject();
    const changeKey = "chg-archive-package";
    const zip = archiveZip(changeKey, [
      {
        path: "reports/final/summary-data.json",
        role: "summary",
        content: JSON.stringify({
          schema_version: 1,
          change_key: changeKey,
          title: "远端归档知识",
          summary: "服务端应保存原始归档并建立知识索引。",
          decisions: ["查询只访问远端知识库"]
        })
      },
      {
        path: "spec/archive.md",
        role: "spec",
        content: "# 归档设计\n\n原始 ZIP 必须保留在服务端，解包内容用于知识检索。\n"
      },
      {
        path: "plans/archive.md",
        role: "plan",
        content: "# 实施计划\n\n先校验清单，再持久化，最后建立索引。\n"
      },
      {
        path: "archive-meta.md",
        role: "archive_meta",
        content: "# 归档元数据\n\n这是核心归档。\n"
      },
      {
        path: "change-context.json",
        role: "change_context",
        content: JSON.stringify({ change_key: changeKey, branch: "codex/archive" })
      }
    ]);
    const packageHash = sha256Bytes(zip);

    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/changes/${changeKey}/archive-package`,
      headers: headers(),
      payload: zip
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      schema_version: 1,
      project_id: projectId,
      change_key: changeKey,
      package_sha256: packageHash,
      archive_status: "durable",
      knowledge_status: "ready",
      stored_files: 5
    });
    expect(await storage.hasBlob(packageHash)).toBe(true);

    const status = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/changes/${changeKey}/archive-package`,
      headers: headers("application/json")
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      package_sha256: packageHash,
      archive_status: "durable",
      knowledge_status: "ready"
    });

    const download = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/changes/${changeKey}/archive-package/download`,
      headers: headers("application/json")
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toContain("application/zip");
    expect(download.headers["x-content-sha256"]).toBe(packageHash);
    expect(download.rawPayload).toEqual(zip);

    const projectFiles = await repository.listProjectFiles("actor_archive_owner", projectId);
    expect(projectFiles.map((file) => file.path)).toEqual(expect.arrayContaining([
      `.harness/archive/${changeKey}/reports/final/summary-data.json`,
      `.harness/archive/${changeKey}/spec/archive.md`,
      `.harness/archive/${changeKey}/plans/archive.md`,
      `.harness/archive/${changeKey}/archive-meta.md`,
      `.harness/archive/${changeKey}/change-context.json`
    ]));

    const search = await app.inject({
      method: "GET",
      url: `/api/v1/semantic/search?q=${encodeURIComponent("原始 ZIP")}&project_id=${projectId}`,
      headers: headers("application/json")
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ project_id: projectId })
    ]));
  });

  it("rejects traversal, diagnostics, and undeclared files before storing the package", async () => {
    const projectId = await resolveProject();
    const changeKey = "chg-invalid-package";
    const zip = archiveZip(changeKey, [
      { path: "spec/core.md", role: "spec", content: "# 核心设计\n" }
    ], [
      { path: "logs/debug.log", content: "不应上传的日志" }
    ]);
    const packageHash = sha256Bytes(zip);

    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/changes/${changeKey}/archive-package`,
      headers: headers(),
      payload: zip
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: "ARCHIVE_PACKAGE_INVALID" } });
    expect(await storage.hasBlob(packageHash)).toBe(false);
    expect(await repository.listProjectFiles("actor_archive_owner", projectId)).toEqual([]);
  });

  it("keeps the raw ZIP durable and retries indexing after a transient failure", async () => {
    await app.close();
    semanticStore = new FailOnceSemanticStore();
    app = await createServer({ repository, storage, semanticStore });
    const projectId = await resolveProject();
    const changeKey = "chg-index-retry";
    const zip = archiveZip(changeKey, [{
      path: "reports/final/summary-data.json",
      role: "summary",
      content: JSON.stringify({
        schema_version: 1,
        change_key: changeKey,
        summary: "第一次索引失败后使用服务端原包重试。"
      })
    }]);
    const packageHash = sha256Bytes(zip);

    const failed = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/changes/${changeKey}/archive-package`,
      headers: headers(),
      payload: zip
    });
    expect(failed.statusCode, failed.body).toBe(201);
    expect(failed.json()).toMatchObject({
      package_sha256: packageHash,
      archive_status: "durable",
      knowledge_status: "failed"
    });
    expect(await storage.hasBlob(packageHash)).toBe(true);

    const download = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/changes/${changeKey}/archive-package/download`,
      headers: headers("application/json")
    });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload).toEqual(zip);

    const retried = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/changes/${changeKey}/archive-package`,
      headers: headers(),
      payload: zip
    });
    expect(retried.statusCode, retried.body).toBe(201);
    expect(retried.json()).toMatchObject({
      package_sha256: packageHash,
      archive_status: "durable",
      knowledge_status: "ready"
    });
  });
});
