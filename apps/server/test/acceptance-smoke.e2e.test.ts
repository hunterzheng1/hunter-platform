import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/app.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";
import {
  MemoryBranchSnapshotPort,
  createBranchSnapshotModule,
  type BranchSnapshotSeed
} from "../src/branch-snapshots/index.js";
import { createBranchVersionQueryAdapter } from "../src/branch-version-query/index.js";

/**
 * 阶段 14 端到端冒烟验收（有界范围）：
 * 真实 HTTP 路由 + 真实快照模块 + 真实适配器 + 内存存储，验证
 * 「分支文件清单 / 文件内容」两条平台信息链路的完整闭环。
 * 整体验收（真实 pg、真实 CLI push、owner 签字）不在本套件宣称范围内。
 */

const digest = (value: string): string =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

function seed(overrides: Partial<BranchSnapshotSeed> = {}): BranchSnapshotSeed {
  const content = "# agent\n";
  const files = overrides.files ?? [{
    path: "AGENTS.md", content_kind: "instruction" as const, size: Buffer.byteLength(content),
    content_hash: digest(content), media_type: "text/markdown" as const, content
  }];
  const refs = files.map((file) => ({
    path: file.path, content_kind: file.content_kind, size: file.size,
    content_hash: file.content_hash, media_type: file.media_type,
    ...(file.action === undefined ? {} : { action: file.action })
  }));
  const base: BranchSnapshotSeed = {
    schema_version: 1,
    project_id: "",
    branch_name: "main",
    commit_sha: "a".repeat(40),
    project_version: "pv_0001",
    artifact_id: "art_0001",
    manifest_hash: digest(JSON.stringify(refs)),
    file_count: files.length,
    changed_file_count: files.length,
    uploaded_at: "2026-08-13T08:00:00.000Z",
    diff_ref: "diff_main_0001",
    files,
    changed_paths: files.map((file) => file.path)
  };
  return { ...base, ...overrides, files, manifest_hash: overrides.manifest_hash ?? digest(JSON.stringify(refs)) };
}

describe("stage 14 acceptance smoke: platform information end-to-end", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  let projectId: string;

  beforeEach(async () => {
    const repository = new MemoryRepository();
    await repository.createActorWithToken({ actorId: "actor_smoke", token: "smoke-token" });
    const resolved = await repository.resolveProject({
      actorId: "actor_smoke",
      localProjectKey: "local-smoke",
      displayName: "Smoke",
      requestedProjectId: null
    });
    projectId = resolved.project.projectId;

    const older = seed({ project_id: projectId, uploaded_at: "2026-08-12T08:00:00.000Z" });
    const newer = seed({
      project_id: projectId,
      commit_sha: "b".repeat(40),
      project_version: "pv_0002",
      artifact_id: "art_0002",
      diff_ref: "diff_main_0002",
      uploaded_at: "2026-08-13T08:00:00.000Z"
    });
    const port = MemoryBranchSnapshotPort.fromSnapshots([older, newer]);
    const snapshotModule = createBranchSnapshotModule({
      repository_port: port,
      blob_read_port: port,
      cursor_verifier_port: port,
      restore_conflict_port: port
    });

    app = await createServer({
      repository,
      storage: new MemoryArtifactStorage(),
      platformInformation: {
        branchVersion: createBranchVersionQueryAdapter(snapshotModule)
      }
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("walks snapshot files and file content over real HTTP", async () => {
    const auth = { authorization: "Bearer smoke-token" };

    // 1. 分支文件列表 → 快照带 bf_ 定位符
    const branches = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/information/branch_files?limit=10`,
      headers: auth
    });
    expect(branches.statusCode).toBe(200);
    const snapshotItems = branches.json().items as Array<{ snapshot_version: string; detail_id?: string }>;
    const latest = snapshotItems.find((item) => item.snapshot_version === "pv_0002");
    expect(latest?.detail_id).toBe("bf_main~pv_0002");

    // 2. files 子路由 → 文件带 bff_ 内容定位符
    const files = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/information/branch_files/${encodeURIComponent("bf_main~pv_0002")}/files`,
      headers: auth
    });
    expect(files.statusCode).toBe(200);
    expect(files.json().items).toEqual([{
      path: "AGENTS.md",
      size: Buffer.byteLength("# agent\n"),
      content_hash: digest("# agent\n"),
      detail_id: "bff_main~pv_0002~AGENTS.md"
    }]);

    // 3. 文件内容详情 → 精确字节
    const content = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/information/branch_files/${encodeURIComponent("bff_main~pv_0002~AGENTS.md")}`,
      headers: auth
    });
    expect(content.statusCode).toBe(200);
    expect(content.json().detail).toMatchObject({
      detail_kind: "branch_file",
      content: "# agent\n",
      content_hash: digest("# agent\n")
    });

    // 4. 未知定位符 → 404；非 bff_ 形态 → 503 语义（fail closed，绝不 200）
    const unknown = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/information/branch_files/${encodeURIComponent("bff_main~pv_9999~AGENTS.md")}`,
      headers: auth
    });
    expect(unknown.statusCode).toBe(404);
    const garbage = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/information/branch_files/not-a-locator`,
      headers: auth
    });
    expect(garbage.statusCode).toBe(503);
  });
});
