import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

import { createProductionPlatformInformationFromEnvironment } from
  "../src/platform-information/production.js";
import { MemoryRunStore } from "../src/runs/memory-store.js";

describe("production Platform Information cursor secret fallback", () => {
  it("composes all views with ephemeral cursor secrets when only a pool is available", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const query = vi.fn().mockResolvedValue({ rows: [] });
      const pool = { query } as unknown as Pool;
      const adapters = await createProductionPlatformInformationFromEnvironment({
        pool,
        runStore: new MemoryRunStore(),
        environment: {}
      });

      expect(adapters.branchMonitor).toBeDefined();
      expect(adapters.projectMaterials).toBeDefined();
      expect(adapters.projectKnowledge).toBeDefined();
      expect(adapters.changeRecords).toBeDefined();
      expect(warn).toHaveBeenCalledTimes(4);
      expect(String(warn.mock.calls[0]?.[0])).toContain("CURSOR_SECRET");
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps fail-closed behaviour (no adapters, no warning) when neither pool nor secrets exist", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const adapters = await createProductionPlatformInformationFromEnvironment({
        runStore: new MemoryRunStore(),
        environment: {}
      });

      expect(adapters.branchVersion).toBeUndefined();
      expect(adapters.projectMaterials).toBeUndefined();
      expect(adapters.projectKnowledge).toBeUndefined();
      expect(adapters.changeRecords).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("composes branch version view whenever a pool is available (no cursor secret required)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const adapters = await createProductionPlatformInformationFromEnvironment({
      pool: { query } as unknown as Pool,
      runStore: new MemoryRunStore(),
      environment: {}
    });

    expect(adapters.branchVersion).toBeDefined();
    const result = await adapters.branchVersion?.query(JSON.stringify({
      schema_version: 1,
      contract_kind: "query",
      view: "version_records",
      project_id: "prj_versions",
      query_scope: {
        actor_id: "actor_versions",
        accessible_project_ids: ["prj_versions"],
        content_types: ["branch_file"]
      },
      limit: 10,
      cursor: null,
      cursor_verification: "server_port_required",
      sort: "uploaded_at_desc_snapshot_version_asc"
    }));
    // mock pool 无法满足模块游标读取的行形状 → SOURCE_INVALID 恰好证明
    // 组合链已贯通（若组合缺失这里会是 QUERY_INVALID 或 adapter undefined）。
    expect(result).toBeDefined();
    expect(result?.ok).toBe(false);
    expect((result as { ok: false; reason_code: string }).reason_code).toBe("BRANCH_VERSION_SOURCE_INVALID");
  });

  it("reuses the same ephemeral secret within a process and never overrides an explicit secret", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const query = vi.fn().mockResolvedValue({ rows: [] });
      const pool = { query } as unknown as Pool;
      const first = await createProductionPlatformInformationFromEnvironment({
        pool,
        runStore: new MemoryRunStore(),
        environment: { HUNTER_PROJECT_KNOWLEDGE_CURSOR_SECRET: "explicit-knowledge-secret-012345" }
      });
      expect(first.projectKnowledge).toBeDefined();
      // 显式密钥存在时该视图不再产生临时兜底告警
      const knowledgeWarnings = warn.mock.calls.filter((call) =>
        String(call[0]).includes("HUNTER_PROJECT_KNOWLEDGE_CURSOR_SECRET"));
      expect(knowledgeWarnings).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("production Platform Information export lifecycle", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("holds one database-wide export owner and releases it only after CAS close", async () => {
    const parent = await mkdtemp(join(tmpdir(), "hunter-export-production-"));
    roots.push(parent);
    const releaseOwner = vi.fn();
    const releaseRejected = vi.fn();
    const ownerQuery = vi.fn().mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockResolvedValue({ rows: [{ unlocked: true }] });
    const rejectedQuery = vi.fn().mockResolvedValue({ rows: [{ locked: false }] });
    const connect = vi.fn()
      .mockResolvedValueOnce({ query: ownerQuery, release: releaseOwner })
      .mockResolvedValueOnce({ query: rejectedQuery, release: releaseRejected });
    const pool = { connect } as unknown as Pool;
    const options = { pool, runStore: new MemoryRunStore(),
      platformInformationExportRoot: join(parent, "cas") };

    const active = await createProductionPlatformInformationFromEnvironment(options);
    await expect(createProductionPlatformInformationFromEnvironment(options))
      .rejects.toThrow("PLATFORM_INFORMATION_EXPORT_SINGLE_INSTANCE_REQUIRED");
    expect(releaseRejected).toHaveBeenCalledOnce();
    expect(releaseOwner).not.toHaveBeenCalled();

    await active.export_close?.();
    expect(ownerQuery).toHaveBeenLastCalledWith("SELECT pg_advisory_unlock($1,$2)",
      [0x48554e54, 0x45585054]);
    expect(releaseOwner).toHaveBeenCalledOnce();
  });

  it("composes project knowledge independently with its own cursor secret", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as Pool;
    const adapters = await createProductionPlatformInformationFromEnvironment({
      pool,
      runStore: new MemoryRunStore(),
      environment: {
        HUNTER_PROJECT_KNOWLEDGE_CURSOR_SECRET: "knowledge-secret-012345678901234"
      }
    });

    expect(adapters.projectKnowledge).toBeDefined();
    const result = await adapters.projectKnowledge?.queryPage(JSON.stringify({
      schema_version: 1,
      contract_kind: "query",
      view: "project_knowledge",
      project_id: "prj_knowledge",
      query_scope: {
        actor_id: "actor_knowledge",
        accessible_project_ids: ["prj_knowledge"],
        content_types: ["knowledge_entry"]
      },
      limit: 10,
      cursor: null,
      cursor_verification: "server_port_required",
      sort: "extracted_at_desc_knowledge_id_asc"
    }));
    expect(result).toMatchObject({ ok: true, value: { page_state: "empty" } });
    expect(query).toHaveBeenCalledOnce();
  });

  it("composes archive-backed change records without claiming document readiness", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const adapters = await createProductionPlatformInformationFromEnvironment({
      pool: { query } as unknown as Pool,
      runStore: new MemoryRunStore(),
      environment: {
        HUNTER_CHANGE_RECORDS_CURSOR_SECRET: "change-secret-012345678901234567"
      }
    });

    expect(adapters.changeRecords).toBeDefined();
    const result = await adapters.changeRecords?.queryPage(JSON.stringify({
      schema_version: 1,
      contract_kind: "query",
      view: "change_records",
      project_id: "prj_change",
      query_scope: {
        actor_id: "actor_change",
        accessible_project_ids: ["prj_change"],
        content_types: ["change_document", "archive_package", "project_content_candidate"]
      },
      limit: 10,
      cursor: null,
      cursor_verification: "server_port_required",
      sort: "archived_at_desc_change_key_asc"
    }));
    expect(result).toMatchObject({ ok: true, value: { page_state: "empty" } });
    expect(query).toHaveBeenCalledOnce();
  });
});
