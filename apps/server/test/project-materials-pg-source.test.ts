import { describe, expect, it } from "vitest";
import type { Pool } from "pg";

import {
  ProjectMaterialsCursorAuthority,
  projectMaterialId,
  type ProjectMaterialsCurrentIdentity
} from "../src/project-materials/cursor-authority.js";
import { PgProjectMaterialsSource } from "../src/project-materials/pg-source.js";

const scope = {
  actor_id: "actor_materials",
  project_id: "prj_materials",
  view: "project_materials" as const,
  sort: "category_asc_path_asc_version_desc" as const
};

const current: ProjectMaterialsCurrentIdentity = {
  project_id: "prj_materials",
  branch_name: "main",
  commit_sha: "a".repeat(40),
  project_version: "pv_0001",
  artifact_id: "art_0001",
  manifest_hash: `sha256:${"b".repeat(64)}`
};

function secretBytes(): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => (index * 17 + 3) & 0xff);
}

describe("ProjectMaterialsCursorAuthority", () => {
  it("issues a fixed opaque cursor that survives restart and binds scope, current identity and full key", async () => {
    const first = new ProjectMaterialsCursorAuthority(secretBytes());
    const token = first.issue({
      ...scope,
      current,
      last_key: {
        category: "architecture_map",
        path: ".harness/codebase/map/STACK.md",
        snapshot_version: "pv_0001"
      }
    });

    expect(token).toMatch(/^[A-Za-z0-9_-]{215}$/u);
    await expect(new ProjectMaterialsCursorAuthority(secretBytes()).verify({
      cursor: token,
      ...scope
    })).resolves.toBe(true);
    expect(first.locate(token, { ...scope, current })).toMatch(/^material_[a-f0-9]{64}$/u);
    expect(() => first.assertPosition(token, {
      ...scope,
      current,
      last_key: {
        category: "architecture_map",
        path: ".harness/codebase/map/STACK.md",
        snapshot_version: "pv_0001"
      }
    })).not.toThrow();
    expect(() => first.assertPosition(token, {
      ...scope,
      current,
      last_key: {
        category: "architecture_map",
        path: ".harness/codebase/map/STRUCTURE.md",
        snapshot_version: "pv_0001"
      }
    })).toThrow("PROJECT_MATERIALS_CURSOR_INVALID");
    await expect(first.verify({ ...scope, cursor: token, actor_id: "actor_foreign" }))
      .resolves.toBe(false);
    expect(() => first.locate(token, {
      ...scope,
      current: { ...current, artifact_id: "art_drift" }
    })).toThrow("PROJECT_MATERIALS_CURSOR_INVALID");
    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    await expect(first.verify({ cursor: tampered, ...scope })).resolves.toBe(false);
  });

  it("rejects accessor and Proxy verification inputs without executing hostile traps", async () => {
    const authority = new ProjectMaterialsCursorAuthority(secretBytes());
    let executions = 0;
    const accessor = Object.defineProperty({ ...scope }, "cursor", {
      enumerable: true,
      get() { executions += 1; return "A".repeat(215); }
    });
    const proxy = new Proxy({ cursor: "A".repeat(215), ...scope }, {
      get() { executions += 1; throw new Error("trap"); },
      getOwnPropertyDescriptor() { executions += 1; throw new Error("trap"); }
    });

    await expect(authority.verify(accessor as Parameters<typeof authority.verify>[0]))
      .resolves.toBe(false);
    await expect(authority.verify(proxy)).resolves.toBe(false);
    expect(executions).toBe(0);
  });

  it("accepts only a copied genuine 32-byte Uint8Array secret with the minimum entropy floor", async () => {
    const original = secretBytes();
    const authority = new ProjectMaterialsCursorAuthority(original);
    const token = authority.issue({
      ...scope,
      current,
      last_key: { category: "rule", path: ".harness/rules/a.md", snapshot_version: "pv_0001" }
    });
    original.fill(0);
    await expect(authority.verify({ cursor: token, ...scope })).resolves.toBe(true);

    let issued = 0;
    for (const invalid of [
      new DataView(secretBytes().buffer),
      new DataView(Uint8Array.from(secretBytes(), (value) => value ^ 0xff).buffer),
      new Uint16Array(16),
      new Uint8Array(31),
      new Uint8Array(33),
      new Uint8Array(32)
    ]) {
      expect(() => {
        const value = new ProjectMaterialsCursorAuthority(invalid as unknown as Uint8Array);
        issued += 1;
        value.issue({
          ...scope, current,
          last_key: { category: "rule", path: ".harness/rules/a.md", snapshot_version: "pv_0001" }
        });
      }).toThrow("PROJECT_MATERIALS_CURSOR_SECRET_INVALID");
    }
    expect(issued).toBe(0);
  });

  it("uses length-prefixed canonical tuples so delimiter-like values cannot collide", () => {
    const leftCurrent = { ...current, project_version: "pv:a", artifact_id: "b" };
    const rightCurrent = { ...current, project_version: "pv", artifact_id: "a:b" };
    const leftKey = { category: "rule" as const, path: ".harness/rules/x:y.md", snapshot_version: "v:z" };
    const rightKey = { category: "rule" as const, path: ".harness/rules/x.md", snapshot_version: "y:v:z" };
    const authority = new ProjectMaterialsCursorAuthority(secretBytes());

    expect(projectMaterialId(leftCurrent, leftKey)).not.toBe(projectMaterialId(rightCurrent, rightKey));
    expect(authority.issue({ ...scope, current: leftCurrent, last_key: leftKey }))
      .not.toBe(authority.issue({ ...scope, current: rightCurrent, last_key: rightKey }));
    expect(() => authority.issue({
      ...scope,
      current: { ...current, project_version: "pv\u001fb" },
      last_key: leftKey
    })).toThrow("PROJECT_MATERIALS_CURSOR_INVALID");
    expect(() => authority.issue({
      ...scope,
      current,
      last_key: { ...leftKey, path: ".harness/rules/\ud800.md" }
    })).toThrow("PROJECT_MATERIALS_CURSOR_INVALID");
  });
});

function result(rows: readonly Record<string, unknown>[]) {
  return { rows: [...rows], rowCount: rows.length };
}

describe("PgProjectMaterialsSource", () => {
  it("returns a formal processing page when the project fence has no matching immutable snapshot", async () => {
    const queries: string[] = [];
    const pool = {
      async query(text: string) {
        queries.push(text);
        return result([{
          current_project_version: "pv_0001", current_artifact_id: "art_0001",
          project_id: null
        }]);
      }
    } as unknown as Pool;
    const source = new PgProjectMaterialsSource({
      pool,
      blob_reader: { async readBlob() { throw new Error("blob must not be read"); } },
      cursor_authority: new ProjectMaterialsCursorAuthority(secretBytes())
    });

    await expect(source.list({
      actor_id: scope.actor_id,
      accessible_project_ids: [scope.project_id],
      project_id: scope.project_id,
      content_types: ["config", "rule", "architecture", "instruction"],
      sort: scope.sort,
      limit: 10,
      cursor: null
    })).resolves.toBe(JSON.stringify({
      schema_version: 1,
      project_id: scope.project_id,
      page_state: "processing",
      items: [],
      next_cursor: null,
      failures: []
    }));
    expect(queries).toHaveLength(1);
  });

  it("fails closed at the storage boundary on control characters and lone surrogates", async () => {
    for (const branchName of ["main\u001fartifact", "main\ud800"] as const) {
      let queries = 0;
      const source = new PgProjectMaterialsSource({
        pool: { async query() {
          queries += 1;
          return result([{
            ...current,
            branch_name: branchName,
            current_project_version: current.project_version,
            current_artifact_id: current.artifact_id
          }]);
        } } as unknown as Pool,
        blob_reader: { async readBlob() { throw new Error("blob must not be read"); } },
        cursor_authority: new ProjectMaterialsCursorAuthority(secretBytes())
      });
      await expect(source.list({
        actor_id: scope.actor_id,
        accessible_project_ids: [scope.project_id],
        project_id: scope.project_id,
        content_types: ["config", "rule", "architecture", "instruction"],
        sort: scope.sort,
        limit: 10,
        cursor: null
      })).rejects.toThrow("PROJECT_MATERIALS_SNAPSHOT_INVALID");
      expect(queries).toBe(1);
    }
  });

  it("filters and paginates metadata in SQL without selecting or reading blob bodies", async () => {
    const queries: string[] = [];
    let blobReads = 0;
    const pool = {
      async query(text: string) {
        queries.push(text);
        if (queries.length === 1) return result([{
          ...current,
          current_project_version: current.project_version,
          current_artifact_id: current.artifact_id
        }]);
        return result([
          {
            category: "architecture_constraint",
            path: ".harness/rules/architecture.md",
            content_kind: "rule",
            size_bytes: 10,
            content_hash: `sha256:${"c".repeat(64)}`,
            media_type: "text/markdown"
          },
          {
            category: "architecture_map",
            path: ".harness/codebase/map/STACK.md",
            content_kind: "architecture",
            size_bytes: 12,
            content_hash: `sha256:${"d".repeat(64)}`,
            media_type: "text/markdown"
          }
        ]);
      }
    } as unknown as Pool;
    const source = new PgProjectMaterialsSource({
      pool,
      blob_reader: { async readBlob() { blobReads += 1; return null; } },
      cursor_authority: new ProjectMaterialsCursorAuthority(secretBytes())
    });

    const page = JSON.parse(await source.list({
      actor_id: scope.actor_id,
      accessible_project_ids: [scope.project_id],
      project_id: scope.project_id,
      content_types: ["config", "rule", "architecture", "instruction"],
      sort: scope.sort,
      limit: 1,
      cursor: null
    })) as Record<string, unknown>;

    expect(page).toMatchObject({
      page_state: "ready",
      items: [{
        material_id: projectMaterialId(current, {
          category: "architecture_constraint", path: ".harness/rules/architecture.md"
        }),
        content_type: "rule",
        category: "architecture_constraint",
        path: ".harness/rules/architecture.md",
        snapshot_version: "pv_0001",
        source_branch_name: "main",
        source_commit_sha: "a".repeat(40),
        sort_key: "architecture_constraint|.harness/rules/architecture.md|pv_0001"
      }]
    });
    expect(page.next_cursor).toMatch(/^[A-Za-z0-9_-]{215}$/u);
    expect(queries[1]).toContain("content_kind");
    expect(queries[1]).not.toContain("content_bytes");
    expect(queries[1]).not.toContain("body");
    expect(blobReads).toBe(0);
  });

  it("rebuilds a material locator at the current fence and reads one exact UTF-8 blob", async () => {
    const content = "# constraints\n";
    const contentHash = "sha256:60975c934d1aa972b178f7da844aed85e9455e0e85f5c1241ad1232c3f629cd4";
    const queries: string[] = [];
    const pool = {
      async query(text: string) {
        queries.push(text);
        if (queries.length === 1) return result([{
          ...current,
          current_project_version: current.project_version,
          current_artifact_id: current.artifact_id
        }]);
        return result([{
          category: "architecture_constraint",
          path: ".harness/rules/architecture.md",
          content_kind: "rule",
          size_bytes: Buffer.byteLength(content),
          content_hash: contentHash,
          media_type: "text/markdown"
        }]);
      }
    } as unknown as Pool;
    const source = new PgProjectMaterialsSource({
      pool,
      blob_reader: { async readBlob(hash) {
        expect(hash).toBe(contentHash);
        return Buffer.from(content, "utf8");
      } },
      cursor_authority: new ProjectMaterialsCursorAuthority(secretBytes())
    });

    const serialized = await source.detail({
      actor_id: scope.actor_id,
      accessible_project_ids: [scope.project_id],
      project_id: scope.project_id,
      content_types: ["config", "rule", "architecture", "instruction"],
      material_id: projectMaterialId(current, {
        category: "architecture_constraint", path: ".harness/rules/architecture.md"
      })
    });

    expect(JSON.parse(serialized ?? "null")).toEqual({
      schema_version: 1,
      project_id: "prj_materials",
      material_id: projectMaterialId(current, {
        category: "architecture_constraint", path: ".harness/rules/architecture.md"
      }),
      content_type: "rule",
      category: "architecture_constraint",
      path: ".harness/rules/architecture.md",
      blob_hash: contentHash,
      snapshot_version: "pv_0001",
      source_branch_name: "main",
      source_commit_sha: "a".repeat(40),
      content,
      content_hash: contentHash,
      media_type: "text/markdown"
    });
    expect(queries[1]).not.toContain("content_bytes");
  });
});
