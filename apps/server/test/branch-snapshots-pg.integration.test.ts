import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createBranchSnapshotModule,
  type BranchSnapshotSeed,
  type SnapshotIdentity
} from "../src/branch-snapshots/index.js";
import { PgBranchSnapshotPort } from "../src/branch-snapshots/pg.js";
import { runMigrations } from "../src/repositories/migrate.js";

const databaseUrl = process.env.HUNTER_HARNESS_TEST_DATABASE_URL;
const postgresDescribe = databaseUrl === undefined ? describe.skip : describe;
const digest = (value: string): string =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

function seed(overrides: Partial<BranchSnapshotSeed> = {}): BranchSnapshotSeed {
  const content = overrides.files?.[0]?.content ?? "# shared blob\n";
  const value: BranchSnapshotSeed = {
    schema_version: 1,
    project_id: "prj_stage02_pg",
    branch_name: "main",
    commit_sha: "a".repeat(40),
    project_version: "pv_0002",
    artifact_id: "art_main_0002",
    manifest_hash: "",
    file_count: 1,
    changed_file_count: 1,
    uploaded_at: "2026-08-13T08:00:00.000Z",
    diff_ref: "diff_main_0002",
    files: [{
      path: "AGENTS.md",
      content_kind: "instruction",
      size: Buffer.byteLength(content),
      content_hash: digest(content),
      media_type: "text/markdown",
      content
    }],
    changed_paths: ["AGENTS.md"],
    ...overrides
  };
  const refs = value.files.map((file) => ({
    path: file.path, content_kind: file.content_kind, size: file.size,
    content_hash: file.content_hash, media_type: file.media_type,
    ...(file.action === undefined ? {} : { action: file.action })
  }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { ...value, manifest_hash: overrides.manifest_hash ?? digest(JSON.stringify(refs)) };
}

function identity(value: BranchSnapshotSeed): SnapshotIdentity {
  return {
    project_id: value.project_id,
    branch_name: value.branch_name,
    commit_sha: value.commit_sha,
    project_version: value.project_version,
    artifact_id: value.artifact_id,
    manifest_hash: value.manifest_hash
  };
}

postgresDescribe("PgBranchSnapshotPort integration", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const owner = "actor_stage02_pg";
  const project = "prj_stage02_pg";

  beforeAll(async () => {
    await runMigrations(pool, fileURLToPath(new URL("../migrations", import.meta.url)));
    await pool.query(`TRUNCATE TABLE branch_snapshot_cursors, branch_snapshot_files,
      branch_snapshots, branch_snapshot_blobs, projects, actors CASCADE`);
    await pool.query("INSERT INTO actors(actor_id, display_name) VALUES ($1, $1), ($2, $2)", [
      owner, "actor_stage02_other"
    ]);
    await pool.query(
      "INSERT INTO projects(project_id, owner_actor_id, display_name) VALUES ($1, $2, $1)",
      [project, owner]
    );
  });

  afterAll(async () => { await pool.end(); });

  it("persists immutable metadata and deduplicated blobs across adapter instances", async () => {
    const first = seed();
    const second = seed({
      branch_name: "feature/a", commit_sha: "b".repeat(40),
      project_version: "pv_0003", artifact_id: "art_feature_0003"
    });
    const writer = new PgBranchSnapshotPort(pool);
    await writer.persistSnapshot({ actor_id: owner, seed: first });
    await writer.persistSnapshot({ actor_id: owner, seed: second });

    const counts = await pool.query(`SELECT
      (SELECT count(*)::int FROM branch_snapshots) AS snapshots,
      (SELECT count(*)::int FROM branch_snapshot_files) AS refs,
      (SELECT count(*)::int FROM branch_snapshot_blobs) AS blobs`);
    expect(counts.rows[0]).toMatchObject({ snapshots: 2, refs: 2, blobs: 1 });

    const reader = new PgBranchSnapshotPort(pool);
    const module = createBranchSnapshotModule({
      repository_port: reader, blob_read_port: reader, cursor_verifier_port: reader,
      restore_conflict_port: { async listConflicts(input) {
        return { actor_id: input.actor_id, identity: input.identity, conflicts: [] };
      } }
    });
    await expect(module.getSnapshotFile({
      schema_version: 1, actor_id: owner, project_id: project,
      accessible_project_ids: [project], identity: identity(first), path: "AGENTS.md"
    })).resolves.toMatchObject({ content: "# shared blob\n" });
  });

  it("uses durable scoped cursor state for stable project and branch pagination", async () => {
    const third = seed({
      project_version: "pv_0001", artifact_id: "art_main_0001",
      commit_sha: "c".repeat(40), uploaded_at: "2026-08-12T08:00:00.000Z"
    });
    await new PgBranchSnapshotPort(pool).persistSnapshot({ actor_id: owner, seed: third });
    const port = new PgBranchSnapshotPort(pool);
    const module = createBranchSnapshotModule({
      repository_port: port, blob_read_port: port, cursor_verifier_port: port,
      restore_conflict_port: { async listConflicts(input) {
        return { actor_id: input.actor_id, identity: input.identity, conflicts: [] };
      } }
    });
    const request = {
      schema_version: 1 as const, actor_id: owner, project_id: project,
      accessible_project_ids: [project], branch_name: "main", limit: 1
    };
    const first = await module.listSnapshotVersions({ ...request, cursor: null });
    expect(first.items.map((item) => item.project_version)).toEqual(["pv_0002"]);
    expect(first.next_cursor).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(await port.issue({
      actor_id: owner, project_id: project, query_kind: "versions", branch_name: "main", offset: 1
    })).toBe(first.next_cursor);
    const next = await createBranchSnapshotModule({
      repository_port: new PgBranchSnapshotPort(pool),
      blob_read_port: new PgBranchSnapshotPort(pool),
      cursor_verifier_port: new PgBranchSnapshotPort(pool),
      restore_conflict_port: { async listConflicts(input) {
        return { actor_id: input.actor_id, identity: input.identity, conflicts: [] };
      } }
    }).listSnapshotVersions({ ...request, cursor: first.next_cursor });
    expect(next.items.map((item) => item.project_version)).toEqual(["pv_0001"]);
    await expect(module.listSnapshotVersions({
      ...request, branch_name: "other", cursor: first.next_cursor
    })).rejects.toThrow("BRANCH_SNAPSHOT_CURSOR_INVALID");

    const projectFirst = await module.listProjectSnapshotVersions({
      schema_version: 1, actor_id: owner, project_id: project,
      accessible_project_ids: [project], cursor: null, limit: 1
    });
    expect(projectFirst.items).toHaveLength(1);
    expect(projectFirst.next_cursor).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const projectNext = await module.listProjectSnapshotVersions({
      schema_version: 1, actor_id: owner, project_id: project,
      accessible_project_ids: [project], cursor: projectFirst.next_cursor, limit: 1
    });
    expect(projectNext.items).toHaveLength(1);
    expect(projectNext.items[0]?.artifact_id).not.toBe(projectFirst.items[0]?.artifact_id);

    const branches = await module.listBranches({
      schema_version: 1, actor_id: owner, project_id: project,
      accessible_project_ids: [project], cursor: null, limit: 10
    });
    expect(branches.items.map((item) => [item.branch_name, item.project_version]))
      .toEqual([["main", "pv_0002"], ["feature/a", "pv_0003"]]);

    const main = seed();
    const filesFirst = await module.listSnapshotFiles({
      schema_version: 1, actor_id: owner, project_id: project,
      accessible_project_ids: [project], identity: identity(main), cursor: null, limit: 1
    });
    expect(filesFirst.items).toHaveLength(1);
    expect(filesFirst.next_cursor).toBeNull();
  });

  it("canonicalizes cursor capabilities independent of key order and verifies file identity across instances", async () => {
    const firstContent = "# first\n";
    const secondContent = "# second\n";
    const main = seed({
      branch_name: "file-cursor", project_version: "pv_file_cursor",
      artifact_id: "art_file_cursor", commit_sha: "f".repeat(40),
      file_count: 2, changed_file_count: 2,
      changed_paths: ["AGENTS.md", "README.md"],
      files: [
        { path: "AGENTS.md", content_kind: "instruction", size: Buffer.byteLength(firstContent),
          content_hash: digest(firstContent), media_type: "text/markdown", content: firstContent },
        { path: "README.md", content_kind: "branch_file", size: Buffer.byteLength(secondContent),
          content_hash: digest(secondContent), media_type: "text/markdown", content: secondContent }
      ]
    });
    const port = new PgBranchSnapshotPort(pool);
    await port.persistSnapshot({ actor_id: owner, seed: main });
    const module = createBranchSnapshotModule({
      repository_port: port, blob_read_port: port, cursor_verifier_port: port,
      restore_conflict_port: { async listConflicts(input) {
        return { actor_id: input.actor_id, identity: input.identity, conflicts: [] };
      } }
    });
    const pageRequest = {
      schema_version: 1 as const, actor_id: owner, project_id: project,
      accessible_project_ids: [project], identity: identity(main), limit: 1
    };
    const fileFirst = await module.listSnapshotFiles({ ...pageRequest, cursor: null });
    expect(fileFirst.items.map((file) => file.path)).toEqual(["AGENTS.md"]);
    const nextPort = new PgBranchSnapshotPort(pool);
    const fileNext = await createBranchSnapshotModule({
      repository_port: nextPort, blob_read_port: nextPort, cursor_verifier_port: nextPort,
      restore_conflict_port: { async listConflicts(input) {
        return { actor_id: input.actor_id, identity: input.identity, conflicts: [] };
      } }
    }).listSnapshotFiles({ ...pageRequest, cursor: fileFirst.next_cursor });
    expect(fileNext.items.map((file) => file.path)).toEqual(["README.md"]);
    expect(fileNext.next_cursor).toBeNull();

    const canonical = {
      actor_id: owner, project_id: project, query_kind: "files" as const,
      identity: identity(main), offset: 1
    };
    const reordered = {
      offset: 1, identity: {
        manifest_hash: main.manifest_hash, artifact_id: main.artifact_id,
        project_version: main.project_version, commit_sha: main.commit_sha,
        branch_name: main.branch_name, project_id: main.project_id
      }, query_kind: "files" as const, project_id: project, actor_id: owner
    };
    const token = await port.issue(canonical);
    expect(await new PgBranchSnapshotPort(pool).issue(reordered)).toBe(token);
    await expect(new PgBranchSnapshotPort(pool).verify(token, {
      identity: identity(main), query_kind: "files", project_id: project, actor_id: owner
    })).resolves.toBe(1);
    const rows = await pool.query(
      "SELECT count(*)::int AS count FROM branch_snapshot_cursors WHERE token = $1", [token]
    );
    expect(rows.rows[0]?.count).toBe(1);
  });

  it("finishes all validation before COMMIT and performs no fallible query after commit", async () => {
    let committed = false;
    const instrumentedPool = {
      query: (...args: Parameters<Pool["query"]>) => {
        if (committed) throw new Error("QUERY_AFTER_COMMIT");
        return (pool.query as (...queryArgs: Parameters<Pool["query"]>) => ReturnType<Pool["query"]>)(...args);
      },
      async connect() {
        const client = await pool.connect();
        const wrapped = Object.create(client) as PoolClient;
        wrapped.query = (async (...args: Parameters<PoolClient["query"]>) => {
          const text = args[0];
          if (committed) throw new Error("QUERY_AFTER_COMMIT");
          const result = await (client.query as (...queryArgs: Parameters<PoolClient["query"]>) =>
            ReturnType<PoolClient["query"]>)(...args);
          if (text === "COMMIT") committed = true;
          return result;
        }) as PoolClient["query"];
        wrapped.release = client.release.bind(client);
        return wrapped;
      }
    } as unknown as Pool;
    const value = seed({
      branch_name: "post-commit", project_version: "pv_post_commit",
      artifact_id: "art_post_commit", commit_sha: "e".repeat(40)
    });
    await expect(new PgBranchSnapshotPort(instrumentedPool).persistSnapshot({
      actor_id: owner, seed: value
    })).resolves.toMatchObject(identity(value));
  });

  it("rejects actor/allowlist drift and conflicting immutable identities atomically", async () => {
    const port = new PgBranchSnapshotPort(pool);
    await expect(port.listProjectVersions({
      actor_id: "actor_stage02_other", allowed_project_ids: [project], project_id: project,
      cursor_offset: 0, limit: 10
    })).rejects.toThrow("BRANCH_SNAPSHOT_FORBIDDEN");
    await expect(port.listProjectVersions({
      actor_id: owner, allowed_project_ids: [], project_id: project,
      cursor_offset: 0, limit: 10
    })).rejects.toThrow("BRANCH_SNAPSHOT_FORBIDDEN");
    await expect(port.issue({
      actor_id: "actor_stage02_other", project_id: project,
      query_kind: "project_versions", offset: 1
    })).rejects.toThrow("BRANCH_SNAPSHOT_FORBIDDEN");

    const before = await pool.query("SELECT count(*)::int AS count FROM branch_snapshot_blobs");
    const conflict = seed({ artifact_id: "art_conflict", commit_sha: "d".repeat(40) });
    await expect(port.persistSnapshot({ actor_id: owner, seed: conflict }))
      .rejects.toThrow("BRANCH_SNAPSHOT_IDENTITY_CONFLICT");
    const after = await pool.query("SELECT count(*)::int AS count FROM branch_snapshot_blobs");
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});
