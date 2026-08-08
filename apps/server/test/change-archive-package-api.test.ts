import { canonicalJson, fileOperationSchema } from "@hunter-harness/contracts";
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

class TrackingSemanticStore extends SemanticMemoryStore {
  rebuildCalls = 0;

  override async rebuild(build: Parameters<SemanticMemoryStore["rebuild"]>[0]): Promise<void> {
    this.rebuildCalls += 1;
    await super.rebuild(build);
  }
}

class MissingBlobStorage extends MemoryArtifactStorage {
  missingHash: string | null = null;

  override async hasBlob(contentSha256: string): Promise<boolean> {
    if (contentSha256 === this.missingHash) return false;
    return super.hasBlob(contentSha256);
  }
}

class InterleavingFinalizeRepository extends MemoryRepository {
  finalizeCalls = 0;
  private resolveSecondFinalize: (() => void) | null = null;
  private readonly secondFinalize = new Promise<void>((resolve) => {
    this.resolveSecondFinalize = resolve;
  });

  override async finalizeSessionAutoApprove(
    session: Parameters<MemoryRepository["finalizeSessionAutoApprove"]>[0]
  ): ReturnType<MemoryRepository["finalizeSessionAutoApprove"]> {
    this.finalizeCalls += 1;
    if (this.finalizeCalls === 1) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 50);
        void this.secondFinalize.then(() => {
          clearTimeout(timeout);
          resolve();
        });
      });
      return super.finalizeSessionAutoApprove(session);
    }
    const result = await super.finalizeSessionAutoApprove(session);
    this.resolveSecondFinalize?.();
    return result;
  }
}

class FailOnceFinalizeRepository extends MemoryRepository {
  private failed = false;

  override async finalizeSessionAutoApprove(
    session: Parameters<MemoryRepository["finalizeSessionAutoApprove"]>[0]
  ): ReturnType<MemoryRepository["finalizeSessionAutoApprove"]> {
    if (!this.failed) {
      this.failed = true;
      throw new Error("simulated finalize failure");
    }
    return super.finalizeSessionAutoApprove(session);
  }
}

class FailOnceBlobPutStorage extends MemoryArtifactStorage {
  failHash: string | null = null;
  private failed = false;

  override async putBlob(contentSha256: string, content: Uint8Array): Promise<void> {
    if (!this.failed && contentSha256 === this.failHash) {
      this.failed = true;
      throw new Error("simulated blob write failure");
    }
    await super.putBlob(contentSha256, content);
  }
}

class FaultyBlobReadStorage extends MemoryArtifactStorage {
  failure: { hash: string; mode: "read" | "hash" } | null = null;

  override async getBlob(contentSha256: string): Promise<Uint8Array> {
    if (this.failure?.hash === contentSha256) {
      if (this.failure.mode === "read") throw new Error("simulated blob read failure");
      return Buffer.from("valid UTF-8 with the wrong hash", "utf8");
    }
    return super.getBlob(contentSha256);
  }
}

class AdvanceGenerationOnRebuildStore extends SemanticMemoryStore {
  onFirstRebuild: (() => Promise<void>) | null = null;
  readonly rebuiltArtifacts: string[] = [];
  private advanced = false;

  override async rebuild(build: Parameters<SemanticMemoryStore["rebuild"]>[0]): Promise<void> {
    this.rebuiltArtifacts.push(build.artifact_id);
    if (!this.advanced && this.onFirstRebuild !== null) {
      this.advanced = true;
      await this.onFirstRebuild();
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

  function cliSummary(
    changeKey: string,
    schemaVersion: "2.2" | "2.3" = "2.3",
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      schemaVersion,
      changeName: changeKey,
      businessGoal: "验证远端归档知识摄取。",
      finalStatus: "OK",
      archiveIntent: "record-only",
      finalCommit: "0123456789abcdef",
      stageStatus: {
        plan: "OK",
        run: "OK",
        test: "OK",
        review: "ADVISORY",
        submit: "OK",
        archive: "OK"
      },
      verification: {
        unitTests: {
          run: 1,
          failures: 0,
          errors: 0,
          skipped: 0,
          passRate: "1/1",
          source: "committed"
        },
        apiTests: {
          status: "OK",
          total: 1,
          passed: 1,
          failed: 0,
          blocked: 0,
          passRate: "1/1"
        },
        browserE2E: {
          status: "NOT_RUN",
          total: 0,
          passed: 0,
          failed: 0,
          skipped: 0,
          retries: 0
        },
        dbCompatibility: "NOT_RUN",
        coverageDisplay: "1/1"
      },
      changedFiles: [],
      artifacts: [],
      archiveManifest: {
        movedFiles: 0,
        generatedFiles: 1,
        totalArchiveFiles: 1,
        checksumStatus: "OK"
      },
      reportPipeline: {
        schema_version: 1,
        generated_at: "2026-08-08T00:00:00.000Z",
        event_count: 1,
        sources: ["events.ndjson"],
        phases: {},
        commands: [],
        verificationChecks: [],
        artifacts: [],
        validationIssues: [],
        sourceConsistency: { ok: true, issues: [] }
      },
      ...extra
    };
  }

  function rewriteFirstRawFilename(zip: Buffer, from: string, to: string): Buffer {
    const source = Buffer.from(from, "utf8");
    const replacement = Buffer.from(to, "utf8");
    expect(replacement.byteLength).toBe(source.byteLength);
    const rewritten = Buffer.from(zip);
    const offset = rewritten.indexOf(source);
    expect(offset).toBeGreaterThanOrEqual(0);
    replacement.copy(rewritten, offset);
    return rewritten;
  }

  async function addProjectFile(
    projectId: string,
    path: string,
    content: Uint8Array
  ): Promise<string | null> {
    const contentSha256 = sha256Bytes(content);
    await storage.putBlob(contentSha256, content);
    const project = await repository.getProject("actor_archive_owner", projectId);
    const files = await repository.listProjectFiles("actor_archive_owner", projectId);
    const session = await repository.createProposalSession({
      actorId: "actor_archive_owner",
      projectId,
      baseProjectVersion: project.latestProjectVersion,
      baseManifestHash: sha256Bytes(canonicalJson(files.map((file) => ({
        path: file.path,
        content_sha256: file.contentSha256
      })))),
      operations: [fileOperationSchema.parse({
        operation: "add",
        path,
        file_kind: "user_editable",
        content_sha256: contentSha256,
        size_bytes: content.byteLength
      })],
      scanOverrides: [],
      status: "open",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxChunkBytes: 1024 * 1024
    });
    return (await repository.finalizeSessionAutoApprove(session)).review.artifactId;
  }

  it("durably stores one verified ZIP, publishes core files, and indexes archive knowledge", async () => {
    const projectId = await resolveProject();
    const changeKey = "chg-archive-package";
    const zip = archiveZip(changeKey, [
      {
        path: "reports/final/summary-data.json",
        role: "summary",
        content: JSON.stringify(cliSummary(changeKey, "2.3", {
          title: "远端归档知识",
          summary: { text: "服务端应保存原始归档并建立知识索引。" },
          decisions: ["查询只访问远端知识库"]
        }))
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

  it("rejects an AWS access key hidden behind recursive JSON Unicode escapes before CAS", async () => {
    const projectId = await resolveProject();
    const changeKey = "chg-json-unicode-secret";
    const awsKey = "AKIA1234567890ABCDEF";
    const escapedKey = "\\u0041\\u004b\\u0049\\u00411234567890ABCDEF";
    const summary = JSON.stringify(cliSummary(changeKey, "2.3", {
      nested: { credentials: [{ value: awsKey }] }
    })).replace(awsKey, escapedKey);
    expect(summary).not.toContain(awsKey);
    const zip = archiveZip(changeKey, [{
      path: "reports/final/summary-data.json",
      role: "summary",
      content: summary
    }]);
    const packageHash = sha256Bytes(zip);

    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/changes/${changeKey}/archive-package`,
      headers: headers(),
      payload: zip
    });

    expect(response.statusCode, response.body).toBe(422);
    expect(response.json()).toMatchObject({
      error: {
        code: "ARCHIVE_PACKAGE_INVALID",
        details: {
          findings: expect.arrayContaining([
            expect.objectContaining({ rule_id: "HH_AWS_ACCESS_KEY" })
          ])
        }
      }
    });
    expect(await storage.hasBlob(packageHash)).toBe(false);
  });

  it("rejects an empty summary object before storing the package", async () => {
    const projectId = await resolveProject();
    const changeKey = "chg-empty-summary";
    const zip = archiveZip(changeKey, [{
      path: "reports/final/summary-data.json",
      role: "summary",
      content: "{}"
    }]);
    const packageHash = sha256Bytes(zip);

    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/changes/${changeKey}/archive-package`,
      headers: headers(),
      payload: zip
    });

    expect(response.statusCode, response.body).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: "ARCHIVE_PACKAGE_INVALID" } });
    expect(await storage.hasBlob(packageHash)).toBe(false);
  });

  it("rejects a test-only summary shape that is not a CLI 2.2 or 2.3 report", async () => {
    const projectId = await resolveProject();
    const changeKey = "chg-fake-summary";
    const zip = archiveZip(changeKey, [{
      path: "reports/final/summary-data.json",
      role: "summary",
      content: JSON.stringify({
        schema_version: 1,
        summary: "这不是 CLI 生成的结构化归档报告。"
      })
    }]);
    const packageHash = sha256Bytes(zip);

    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/changes/${changeKey}/archive-package`,
      headers: headers(),
      payload: zip
    });

    expect(response.statusCode, response.body).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: "ARCHIVE_PACKAGE_INVALID" } });
    expect(await storage.hasBlob(packageHash)).toBe(false);
  });

  it("accepts the compact summary structure emitted by CLI schema 2.2", async () => {
    const projectId = await resolveProject();
    const changeKey = "chg-real-cli-2-2";
    const zip = archiveZip(changeKey, [{
      path: "reports/final/summary-data.json",
      role: "summary",
      content: JSON.stringify({
        schemaVersion: "2.2",
        changeName: changeKey,
        finalStatus: "OK",
        baseCommit: "aaaaaaa",
        finalCommit: "bbbbbbb",
        stageStatus: { run: "OK", archive: "OK" },
        verification: {
          unitTests: {
            run: 2,
            failures: 0,
            errors: 0,
            skipped: 0,
            passRate: "2/2"
          },
          apiTests: {
            status: "NOT_RUN",
            total: 0,
            passed: 0,
            failed: 0,
            blocked: 0
          },
          dbCompatibility: "NOT_RUN",
          coverageDisplay: "not_available"
        }
      })
    }]);

    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/changes/${changeKey}/archive-package`,
      headers: headers(),
      payload: zip
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().knowledge_status).toBe("ready");
  });

  it("rejects an empty change-context object before storing the package", async () => {
    const projectId = await resolveProject();
    const changeKey = "chg-empty-context";
    const zip = archiveZip(changeKey, [
      {
        path: "reports/final/summary-data.json",
        role: "summary",
        content: JSON.stringify(cliSummary(changeKey))
      },
      {
        path: "change-context.json",
        role: "change_context",
        content: "{}"
      }
    ]);
    const packageHash = sha256Bytes(zip);

    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/changes/${changeKey}/archive-package`,
      headers: headers(),
      payload: zip
    });

    expect(response.statusCode, response.body).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: "ARCHIVE_PACKAGE_INVALID" } });
    expect(await storage.hasBlob(packageHash)).toBe(false);
  });

  it("rejects traversal hidden only in a ZIP local-header filename", async () => {
    const projectId = await resolveProject();
    const changeKey = "chg-local-header-traversal";
    const ordinary = archiveZip(changeKey, [
      {
        path: "reports/final/summary-data.json",
        role: "summary",
        content: JSON.stringify(cliSummary(changeKey))
      },
      { path: "spec/core.md", role: "spec", content: "# Core\n" }
    ]);
    const zip = rewriteFirstRawFilename(ordinary, "spec/core.md", "../evil/x.md");
    const packageHash = sha256Bytes(zip);

    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/changes/${changeKey}/archive-package`,
      headers: headers(),
      payload: zip
    });

    expect(response.statusCode, response.body).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: "ARCHIVE_PACKAGE_INVALID" } });
    expect(await storage.hasBlob(packageHash)).toBe(false);
  });

  it("rejects a ZIP directory entry instead of filtering it out", async () => {
    const projectId = await resolveProject();
    const changeKey = "chg-directory-entry";
    const zip = archiveZip(changeKey, [{
      path: "reports/final/summary-data.json",
      role: "summary",
      content: JSON.stringify(cliSummary(changeKey))
    }], [{ path: "spec/", content: "" }]);
    const packageHash = sha256Bytes(zip);

    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/changes/${changeKey}/archive-package`,
      headers: headers(),
      payload: zip
    });

    expect(response.statusCode, response.body).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: "ARCHIVE_PACKAGE_INVALID" } });
    expect(await storage.hasBlob(packageHash)).toBe(false);
  });

  it("marks indexing failed without rebuilding when a referenced semantic blob is missing", async () => {
    await app.close();
    const faultyStorage = new MissingBlobStorage();
    const trackingStore = new TrackingSemanticStore();
    storage = faultyStorage;
    semanticStore = trackingStore;
    app = await createServer({ repository, storage, semanticStore });
    const projectId = await resolveProject();
    const firstChange = "chg-complete-snapshot";
    const firstZip = archiveZip(firstChange, [{
      path: "reports/final/summary-data.json",
      role: "summary",
      content: JSON.stringify(cliSummary(firstChange, "2.3", {
        summary: { text: "完整旧索引必须保留。" }
      }))
    }]);
    const first = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/changes/${firstChange}/archive-package`,
      headers: headers(),
      payload: firstZip
    });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().knowledge_status).toBe("ready");
    expect(trackingStore.rebuildCalls).toBe(1);
    const firstArtifactId = first.json().artifact_id as string;
    const firstSummary = (await repository.listProjectFiles("actor_archive_owner", projectId))
      .find((file) => file.path.endsWith(`/${firstChange}/reports/final/summary-data.json`));
    expect(firstSummary).toBeDefined();
    faultyStorage.missingHash = firstSummary?.contentSha256 ?? null;

    const secondChange = "chg-incomplete-snapshot";
    const secondZip = archiveZip(secondChange, [{
      path: "reports/final/summary-data.json",
      role: "summary",
      content: JSON.stringify(cliSummary(secondChange))
    }]);
    const second = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/changes/${secondChange}/archive-package`,
      headers: headers(),
      payload: secondZip
    });

    expect(second.statusCode, second.body).toBe(201);
    expect(second.json()).toMatchObject({
      archive_status: "durable",
      knowledge_status: "failed"
    });
    expect(trackingStore.rebuildCalls).toBe(1);
    expect(await trackingStore.latestArtifactId(projectId)).toBe(firstArtifactId);
    expect((await trackingStore.search("完整旧索引", projectId)).length).toBeGreaterThan(0);
  });

  it.each(["read", "hash", "utf8"] as const)(
    "keeps the old index when a referenced semantic blob fails %s validation",
    async (mode) => {
      await app.close();
      const faultyStorage = new FaultyBlobReadStorage();
      const trackingStore = new TrackingSemanticStore();
      storage = faultyStorage;
      semanticStore = trackingStore;
      app = await createServer({ repository, storage, semanticStore });
      const projectId = await resolveProject();
      const firstChange = `chg-semantic-${mode}-base`;
      const first = await app.inject({
        method: "PUT",
        url: `/api/v1/projects/${projectId}/changes/${firstChange}/archive-package`,
        headers: headers(),
        payload: archiveZip(firstChange, [{
          path: "reports/final/summary-data.json",
          role: "summary",
          content: JSON.stringify(cliSummary(firstChange, "2.3", {
            summary: { text: `旧索引-${mode}` }
          }))
        }])
      });
      expect(first.statusCode, first.body).toBe(201);
      expect(first.json().knowledge_status).toBe("ready");
      const firstArtifactId = first.json().artifact_id as string;

      if (mode === "utf8") {
        await addProjectFile(projectId, "AGENTS.md", Uint8Array.from([0xff, 0xfe]));
      } else {
        const firstSummary = (await repository.listProjectFiles("actor_archive_owner", projectId))
          .find((file) => file.path.endsWith(
            `/${firstChange}/reports/final/summary-data.json`
          ));
        expect(firstSummary).toBeDefined();
        faultyStorage.failure = {
          hash: firstSummary?.contentSha256 ?? "",
          mode
        };
      }

      const secondChange = `chg-semantic-${mode}-failure`;
      const second = await app.inject({
        method: "PUT",
        url: `/api/v1/projects/${projectId}/changes/${secondChange}/archive-package`,
        headers: headers(),
        payload: archiveZip(secondChange, [{
          path: "reports/final/summary-data.json",
          role: "summary",
          content: JSON.stringify(cliSummary(secondChange))
        }])
      });

      expect(second.statusCode, second.body).toBe(201);
      expect(second.json().knowledge_status).toBe("failed");
      expect(trackingStore.rebuildCalls).toBe(1);
      expect(await trackingStore.latestArtifactId(projectId)).toBe(firstArtifactId);
      expect((await trackingStore.search(`旧索引-${mode}`, projectId)).length).toBeGreaterThan(0);
    }
  );

  it("rejects a conflicting package before writing its hash to CAS", async () => {
    const projectId = await resolveProject();
    const changeKey = "chg-pre-cas-conflict";
    const firstZip = archiveZip(changeKey, [{
      path: "reports/final/summary-data.json",
      role: "summary",
      content: JSON.stringify(cliSummary(changeKey, "2.3", {
        summary: { text: "first" }
      }))
    }]);
    const first = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/changes/${changeKey}/archive-package`,
      headers: headers(),
      payload: firstZip
    });
    expect(first.statusCode, first.body).toBe(201);

    const conflictingZip = archiveZip(changeKey, [{
      path: "reports/final/summary-data.json",
      role: "summary",
      content: JSON.stringify(cliSummary(changeKey, "2.3", {
        summary: { text: "conflicting" }
      }))
    }]);
    const conflictingHash = sha256Bytes(conflictingZip);
    expect(conflictingHash).not.toBe(sha256Bytes(firstZip));

    const conflict = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/changes/${changeKey}/archive-package`,
      headers: headers(),
      payload: conflictingZip
    });

    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: "ARCHIVE_ALREADY_EXISTS" } });
    expect(await storage.hasBlob(conflictingHash)).toBe(false);
  });

  it("serializes different archive changes for one project through finalization and rebuild", async () => {
    await app.close();
    const interleavingRepository = new InterleavingFinalizeRepository();
    repository = interleavingRepository;
    await repository.createActorWithToken({ actorId: "actor_archive_owner", token });
    app = await createServer({ repository, storage, semanticStore });
    const projectId = await resolveProject();
    const changes = ["chg-project-lock-a", "chg-project-lock-b"] as const;
    const uploads = changes.map((changeKey) => app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/changes/${changeKey}/archive-package`,
      headers: headers(),
      payload: archiveZip(changeKey, [{
        path: "reports/final/summary-data.json",
        role: "summary",
        content: JSON.stringify(cliSummary(changeKey))
      }])
    }));

    const responses = await Promise.all(uploads);

    expect(responses.map((response) => response.statusCode), responses.map((response) => response.body))
      .toEqual([201, 201]);
    expect(responses.map((response) => response.json().knowledge_status)).toEqual(["ready", "ready"]);
    expect(interleavingRepository.finalizeCalls).toBe(2);
    const latest = await repository.getLatestArtifact("actor_archive_owner", projectId);
    expect(latest).not.toBeNull();
    expect(await semanticStore.latestArtifactId(projectId)).toBe(latest?.artifactId);
  });

  it("returns ready for both concurrent uploads of the same package hash", async () => {
    await app.close();
    const interleavingRepository = new InterleavingFinalizeRepository();
    repository = interleavingRepository;
    await repository.createActorWithToken({ actorId: "actor_archive_owner", token });
    app = await createServer({ repository, storage, semanticStore });
    const projectId = await resolveProject();
    const changeKey = "chg-same-hash-concurrent";
    const zip = archiveZip(changeKey, [{
      path: "reports/final/summary-data.json",
      role: "summary",
      content: JSON.stringify(cliSummary(changeKey))
    }]);

    const responses = await Promise.all([1, 2].map(() => app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/changes/${changeKey}/archive-package`,
      headers: headers(),
      payload: zip
    })));

    expect(responses.map((response) => response.statusCode), responses.map((response) => response.body))
      .toEqual([201, 201]);
    expect(responses.map((response) => response.json().knowledge_status)).toEqual(["ready", "ready"]);
    expect(new Set(responses.map((response) => response.json().archive_id)).size).toBe(1);
    expect(new Set(responses.map((response) => response.json().artifact_id)).size).toBe(1);
    expect(interleavingRepository.finalizeCalls).toBe(1);
    expect((await repository.listArtifacts({
      actorId: "actor_archive_owner",
      projectId,
      limit: 10,
      cursor: null
    })).items).toHaveLength(1);
  });

  it("retries a failed archive against the current stable project artifact", async () => {
    await app.close();
    const failOnceStore = new FailOnceSemanticStore();
    semanticStore = failOnceStore;
    app = await createServer({ repository, storage, semanticStore });
    const projectId = await resolveProject();
    const firstChange = "chg-old-archive-artifact";
    const firstZip = archiveZip(firstChange, [{
      path: "reports/final/summary-data.json",
      role: "summary",
      content: JSON.stringify(cliSummary(firstChange))
    }]);
    const failed = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/changes/${firstChange}/archive-package`,
      headers: headers(),
      payload: firstZip
    });
    expect(failed.statusCode, failed.body).toBe(201);
    expect(failed.json().knowledge_status).toBe("failed");
    const originalArchiveArtifact = failed.json().artifact_id as string;

    const secondChange = "chg-current-project-artifact";
    const second = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/changes/${secondChange}/archive-package`,
      headers: headers(),
      payload: archiveZip(secondChange, [{
        path: "reports/final/summary-data.json",
        role: "summary",
        content: JSON.stringify(cliSummary(secondChange))
      }])
    });
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().knowledge_status).toBe("ready");
    const currentProjectArtifact = second.json().artifact_id as string;
    expect(currentProjectArtifact).not.toBe(originalArchiveArtifact);

    const retried = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/changes/${firstChange}/archive-package`,
      headers: headers(),
      payload: firstZip
    });

    expect(retried.statusCode, retried.body).toBe(201);
    expect(retried.json()).toMatchObject({
      artifact_id: originalArchiveArtifact,
      knowledge_status: "ready"
    });
    expect((await repository.getLatestArtifact("actor_archive_owner", projectId))?.artifactId)
      .toBe(currentProjectArtifact);
    expect(await semanticStore.latestArtifactId(projectId)).toBe(currentProjectArtifact);
  });

  it("rebuilds again when the project generation advances during semantic publication", async () => {
    await app.close();
    const racingStore = new AdvanceGenerationOnRebuildStore();
    semanticStore = racingStore;
    app = await createServer({ repository, storage, semanticStore });
    const projectId = await resolveProject();
    let advancedArtifactId: string | null = null;
    racingStore.onFirstRebuild = async () => {
      advancedArtifactId = await addProjectFile(
        projectId,
        "AGENTS.md",
        Buffer.from("# New generation\n\nnew-generation-marker\n", "utf8")
      );
    };
    const changeKey = "chg-rebuild-generation-race";
    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/changes/${changeKey}/archive-package`,
      headers: headers(),
      payload: archiveZip(changeKey, [{
        path: "reports/final/summary-data.json",
        role: "summary",
        content: JSON.stringify(cliSummary(changeKey))
      }])
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().knowledge_status).toBe("ready");
    expect(advancedArtifactId).not.toBeNull();
    expect(response.json().artifact_id).not.toBe(advancedArtifactId);
    expect(racingStore.rebuiltArtifacts).toEqual([
      response.json().artifact_id,
      advancedArtifactId
    ]);
    expect((await repository.getLatestArtifact("actor_archive_owner", projectId))?.artifactId)
      .toBe(advancedArtifactId);
    expect(await racingStore.latestArtifactId(projectId)).toBe(advancedArtifactId);
    expect((await racingStore.search("new-generation-marker", projectId)).length)
      .toBeGreaterThan(0);
  });

  it("marks an existing archive record failed when finalization throws and retries it", async () => {
    await app.close();
    const failingRepository = new FailOnceFinalizeRepository();
    const trackingStore = new TrackingSemanticStore();
    repository = failingRepository;
    semanticStore = trackingStore;
    await repository.createActorWithToken({ actorId: "actor_archive_owner", token });
    app = await createServer({ repository, storage, semanticStore });
    const projectId = await resolveProject();
    const changeKey = "chg-finalize-failure";
    const zip = archiveZip(changeKey, [{
      path: "reports/final/summary-data.json",
      role: "summary",
      content: JSON.stringify(cliSummary(changeKey))
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
      artifact_id: null,
      archive_status: "durable",
      knowledge_status: "failed"
    });
    expect(await storage.hasBlob(packageHash)).toBe(true);
    expect(trackingStore.rebuildCalls).toBe(0);
    const status = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/changes/${changeKey}/archive-package`,
      headers: headers("application/json")
    });
    expect(status.statusCode, status.body).toBe(200);
    expect(status.json().knowledge_status).toBe("failed");

    const retried = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/changes/${changeKey}/archive-package`,
      headers: headers(),
      payload: zip
    });
    expect(retried.statusCode, retried.body).toBe(201);
    expect(retried.json()).toMatchObject({
      package_sha256: packageHash,
      knowledge_status: "ready"
    });
  });

  it("marks an archive failed when a core blob write throws and retries the same package", async () => {
    await app.close();
    const failingStorage = new FailOnceBlobPutStorage();
    const trackingStore = new TrackingSemanticStore();
    storage = failingStorage;
    semanticStore = trackingStore;
    app = await createServer({ repository, storage, semanticStore });
    const projectId = await resolveProject();
    const changeKey = "chg-core-storage-failure";
    const summary = JSON.stringify(cliSummary(changeKey));
    failingStorage.failHash = sha256Bytes(Buffer.from(summary, "utf8"));
    const zip = archiveZip(changeKey, [{
      path: "reports/final/summary-data.json",
      role: "summary",
      content: summary
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
      artifact_id: null,
      archive_status: "durable",
      knowledge_status: "failed"
    });
    expect(await storage.hasBlob(packageHash)).toBe(true);
    expect(trackingStore.rebuildCalls).toBe(0);

    const retried = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/changes/${changeKey}/archive-package`,
      headers: headers(),
      payload: zip
    });
    expect(retried.statusCode, retried.body).toBe(201);
    expect(retried.json()).toMatchObject({
      package_sha256: packageHash,
      knowledge_status: "ready"
    });
  });

  it("does not create a durable record when raw package CAS fails and releases the project lock", async () => {
    await app.close();
    const failingStorage = new FailOnceBlobPutStorage();
    storage = failingStorage;
    app = await createServer({ repository, storage, semanticStore });
    const projectId = await resolveProject();
    const changeKey = "chg-raw-cas-failure";
    const zip = archiveZip(changeKey, [{
      path: "reports/final/summary-data.json",
      role: "summary",
      content: JSON.stringify(cliSummary(changeKey))
    }]);
    const packageHash = sha256Bytes(zip);
    failingStorage.failHash = packageHash;

    const failed = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/changes/${changeKey}/archive-package`,
      headers: headers(),
      payload: zip
    });

    expect(failed.statusCode, failed.body).toBe(500);
    expect(await storage.hasBlob(packageHash)).toBe(false);
    const absent = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/changes/${changeKey}/archive-package`,
      headers: headers("application/json")
    });
    expect(absent.statusCode, absent.body).toBe(404);

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

  it("keeps the raw ZIP durable and retries indexing after a transient failure", async () => {
    await app.close();
    semanticStore = new FailOnceSemanticStore();
    app = await createServer({ repository, storage, semanticStore });
    const projectId = await resolveProject();
    const changeKey = "chg-index-retry";
    const zip = archiveZip(changeKey, [{
      path: "reports/final/summary-data.json",
      role: "summary",
      content: JSON.stringify(cliSummary(changeKey, "2.2", {
        summary: { text: "第一次索引失败后使用服务端原包重试。" }
      }))
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
