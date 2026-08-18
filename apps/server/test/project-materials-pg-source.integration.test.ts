import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PgBranchSnapshotPort } from "../src/branch-snapshots/pg.js";
import {
  ProjectMaterialsCursorAuthority,
  projectMaterialId
} from "../src/project-materials/cursor-authority.js";
import { PgProjectMaterialsSource } from "../src/project-materials/pg-source.js";
import { runMigrations } from "../src/repositories/migrate.js";

const databaseUrl = process.env.HUNTER_HARNESS_TEST_DATABASE_URL;
const postgresDescribe = databaseUrl === undefined ? describe.skip : describe;
const digest = (content: string): string =>
  `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;

postgresDescribe("PgProjectMaterialsSource real PostgreSQL integration", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const namespace = randomBytes(4).toString("hex");
  const actorId = `actor_stage13_materials_${namespace}`;
  const foreignActorId = `actor_stage13_foreign_${namespace}`;
  const projectId = `prj_stage13_materials_${namespace}`;
  const proposalId = `proposal_materials_${namespace}`;
  const identity = {
    project_id: projectId,
    branch_name: "release/current",
    commit_sha: "e".repeat(40),
    project_version: `pv_materials_${namespace}`,
    artifact_id: `art_materials_${namespace}`,
    manifest_hash: `sha256:${"f".repeat(64)}`
  };
  const secret = Uint8Array.from({ length: 32 }, (_, index) => (index * 29 + 11) & 0xff);

  beforeAll(async () => {
    await runMigrations(pool, fileURLToPath(new URL("../migrations", import.meta.url)));
    await pool.query("INSERT INTO actors(actor_id, display_name) VALUES ($1, $1), ($2, $2)", [
      actorId, foreignActorId
    ]);
    await pool.query(
      "INSERT INTO projects(project_id, owner_actor_id, display_name) VALUES ($1, $2, $1)",
      [projectId, actorId]
    );
    await pool.query(
      `INSERT INTO proposals(proposal_id, project_id, created_by, base_manifest_hash, status)
       VALUES ($1, $2, $3, $4, 'approved')`,
      [proposalId, projectId, actorId, `sha256:${"0".repeat(64)}`]
    );
    await pool.query(
      `INSERT INTO artifacts(artifact_id, project_id, project_version, proposal_id, manifest)
       VALUES ($1, $2, $3, $4, '{}'::jsonb)`,
      [identity.artifact_id, projectId, identity.project_version, proposalId]
    );
    const files = [
      [".harness/rules/architecture.md", "rule", "# boundaries\n", "text/markdown"],
      [".harness/codebase/map/STACK.md", "architecture", "# stack\n", "text/markdown"],
      ["AGENTS.md", "instruction", "# agents\n", "text/markdown"],
      [".harness/rules/a:b.md", "rule", "# delimiter left\n", "text/markdown"],
      [".harness/rules/a.md", "rule", "# delimiter right\n", "text/markdown"],
      ["plans/not-material.md", "plan", "# plan\n", "text/markdown"]
    ] as const;
    for (const [, , content] of files) {
      await pool.query(
        `INSERT INTO branch_snapshot_blobs(content_hash, content_bytes, size_bytes)
         VALUES ($1, $2, $3)`,
        [digest(content), Buffer.from(content, "utf8"), Buffer.byteLength(content)]
      );
    }
    await pool.query(
      `INSERT INTO branch_snapshots(project_id, branch_name, commit_sha, project_version,
        artifact_id, manifest_hash, schema_version, file_count, changed_file_count,
        uploaded_at, diff_ref, changed_paths)
       VALUES ($1,$2,$3,$4,$5,$6,1,$7,$7,now(),'diff_materials','[]'::jsonb)`,
      [...Object.values(identity), files.length]
    );
    for (const [path, kind, content, mediaType] of files) {
      await pool.query(
        `INSERT INTO branch_snapshot_files(project_id, branch_name, commit_sha, project_version,
          artifact_id, manifest_hash, path, content_kind, size_bytes, content_hash, media_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [...Object.values(identity), path, kind, Buffer.byteLength(content), digest(content), mediaType]
      );
    }
    // 生产真实形态：remote-sync 的 push:commit 在同一事务里写 versions + branch pointer，
    // 这才是"当前快照"的权威指针。此前本测试直接把 projects.latest_project_version 改成快照的
    // project_version，伪造了一个生产代码从不维护的不变量——两侧 id 由互不知晓的生成器产生
    // （proposal 用 id("pv_")/id("art_") 各自随机；remote-sync 用共享 suffix），永远不可能相等。
    const sourceJson = JSON.stringify({
      schema_version: 1,
      project_id: projectId,
      branch_name: identity.branch_name,
      commit_sha: identity.commit_sha,
      actor_id: actorId
    });
    const snapshotJson = JSON.stringify({
      schema_version: 1,
      project_id: projectId,
      branch_name: identity.branch_name,
      project_version: identity.project_version,
      artifact_id: identity.artifact_id,
      manifest_hash: identity.manifest_hash,
      commit_sha: identity.commit_sha
    });
    await pool.query(
      `INSERT INTO remote_sync_versions(project_id, branch_name, project_version, artifact_id,
         manifest_hash, commit_sha, source_json, payload_hash, idempotency_key, snapshot_json, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb, now())`,
      [projectId, identity.branch_name, identity.project_version, identity.artifact_id,
        identity.manifest_hash, identity.commit_sha, sourceJson,
        `sha256:${"a".repeat(64)}`, `idem_materials_${namespace}`, snapshotJson]
    );
    await pool.query(
      `INSERT INTO remote_sync_branch_pointers(project_id, branch_name, revision, generation,
         project_version, artifact_id, manifest_hash, commit_sha, updated_at)
       VALUES ($1,$2,$3,1,$4,$5,$6,$7, now())`,
      [projectId, identity.branch_name, identity.project_version, identity.project_version,
        identity.artifact_id, identity.manifest_hash, identity.commit_sha]
    );
    // proposal 管道（hunter-harness push）推进的 latest_*，与快照身份来自不同生成器。
    // 视图不得依赖它——种一条真实的 proposal artifact 并让 latest_* 指向它，证明独立性。
    await pool.query(
      `INSERT INTO artifacts(artifact_id, project_id, project_version, proposal_id, manifest)
       VALUES ($1, $2, $3, $4, '{}'::jsonb)`,
      [`art_proposal_${namespace}`, projectId, `pv_proposal_${namespace}`, proposalId]
    );
    await pool.query(
      `UPDATE projects SET latest_project_version = $2, latest_artifact_id = $3
       WHERE project_id = $1`,
      [projectId, `pv_proposal_${namespace}`, `art_proposal_${namespace}`]
    );
  });

  afterAll(async () => {
    await pool.query(
      "UPDATE projects SET latest_project_version = NULL, latest_artifact_id = NULL WHERE project_id = $1",
      [projectId]
    );
    await pool.query("DELETE FROM remote_sync_branch_pointers WHERE project_id = $1", [projectId]);
    await pool.query("DELETE FROM remote_sync_versions WHERE project_id = $1", [projectId]);
    await pool.query("DELETE FROM branch_snapshots WHERE project_id = $1", [projectId]);
    await pool.query("DELETE FROM artifacts WHERE project_id = $1", [projectId]);
    await pool.query("DELETE FROM proposals WHERE project_id = $1", [projectId]);
    await pool.query("DELETE FROM projects WHERE project_id = $1", [projectId]);
    await pool.query("DELETE FROM actors WHERE actor_id IN ($1, $2)", [actorId, foreignActorId]);
    await pool.query(
      "DELETE FROM branch_snapshot_blobs WHERE content_hash = ANY($1::text[])",
      [[
        "# boundaries\n", "# stack\n", "# agents\n", "# delimiter left\n",
        "# delimiter right\n", "# plan\n"
      ].map(digest)]
    );
    await pool.end();
  });

  it("pages current-fence metadata, resumes after restart, and loads only the selected blob", async () => {
    const source = new PgProjectMaterialsSource({
      pool,
      blob_reader: new PgBranchSnapshotPort(pool),
      cursor_authority: new ProjectMaterialsCursorAuthority(secret)
    });
    const request = {
      actor_id: actorId,
      accessible_project_ids: [projectId],
      project_id: projectId,
      content_types: ["config", "rule", "architecture", "instruction"] as const,
      sort: "category_asc_path_asc_version_desc" as const,
      limit: 4
    };
    const first = JSON.parse(await source.list({ ...request, cursor: null })) as {
      items: Array<{ material_id: string; category: string; path: string }>;
      next_cursor: string;
    };
    expect(first.items.map(({ category, path }) => [category, path])).toEqual([
      ["architecture_constraint", ".harness/rules/architecture.md"],
      ["architecture_map", ".harness/codebase/map/STACK.md"],
      ["instruction", "AGENTS.md"],
      ["rule", ".harness/rules/a.md"]
    ]);
    expect(first.next_cursor).toMatch(/^[A-Za-z0-9_-]{215}$/u);

    const restarted = new PgProjectMaterialsSource({
      pool,
      blob_reader: new PgBranchSnapshotPort(pool),
      cursor_authority: new ProjectMaterialsCursorAuthority(secret)
    });
    const second = JSON.parse(await restarted.list({ ...request, cursor: first.next_cursor })) as {
      items: Array<{ material_id: string; category: string }>;
      next_cursor: null;
    };
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.category).toBe("rule");
    expect(second.next_cursor).toBeNull();

    const detail = JSON.parse(await restarted.detail({
      actor_id: actorId,
      accessible_project_ids: [projectId],
      project_id: projectId,
      content_types: request.content_types,
      material_id: first.items[0]?.material_id ?? "missing"
    }) ?? "null") as { content: string; content_hash: string };
    expect(detail).toMatchObject({ content: "# boundaries\n", content_hash: digest("# boundaries\n") });
    const delimiterLeftId = projectMaterialId(identity, {
      category: "rule", path: ".harness/rules/a:b.md"
    });
    const delimiterRightId = projectMaterialId(identity, {
      category: "rule", path: ".harness/rules/a.md"
    });
    expect(delimiterLeftId).not.toBe(delimiterRightId);
    await expect(restarted.detail({
      actor_id: actorId,
      accessible_project_ids: [projectId],
      project_id: projectId,
      content_types: request.content_types,
      material_id: delimiterLeftId
    })).resolves.toContain('"content":"# delimiter left\\n"');
    await expect(restarted.detail({
      actor_id: actorId,
      accessible_project_ids: [projectId],
      project_id: projectId,
      content_types: request.content_types,
      material_id: delimiterRightId
    })).resolves.toContain('"content":"# delimiter right\\n"');
    await expect(restarted.detail({
      actor_id: foreignActorId,
      accessible_project_ids: [projectId],
      project_id: projectId,
      content_types: request.content_types,
      material_id: first.items[0]?.material_id ?? "missing"
    })).resolves.toBeNull();

    // 尚无任何 remote-sync 推送（分支指针缺失）时才是 processing。
    await pool.query("DELETE FROM remote_sync_branch_pointers WHERE project_id = $1", [projectId]);
    await expect(restarted.list({ ...request, cursor: first.next_cursor }))
      .rejects.toThrow("PROJECT_MATERIALS_CURSOR_INVALID");
    await expect(restarted.list({ ...request, cursor: null })).resolves.toContain('"page_state":"processing"');
  });
});
