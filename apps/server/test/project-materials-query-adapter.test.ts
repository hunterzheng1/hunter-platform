import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  createProjectMaterialsQueryAdapter,
  type ProjectMaterialsSourcePort
} from "../src/project-materials/query-adapter.js";

const fixtureUrl = new URL("./fixtures/project-materials-v1-current.json", import.meta.url);

async function fixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(fixtureUrl, "utf8")) as Record<string, unknown>;
}

function adapterFor(input: {
  page: unknown;
  detail?: unknown;
  verify?: boolean;
  calls?: unknown[];
}) {
  const source: ProjectMaterialsSourcePort = {
    async list(value) {
      input.calls?.push(value);
      return typeof input.page === "string" ? input.page : JSON.stringify(input.page);
    },
    async detail(value) {
      input.calls?.push(value);
      if (input.detail === null) return null;
      return typeof input.detail === "string" ? input.detail : JSON.stringify(input.detail);
    }
  };
  return createProjectMaterialsQueryAdapter({
    source,
    cursor_verifier: { verify: async (value) => {
      input.calls?.push(value);
      return input.verify ?? true;
    } }
  });
}

describe("Stage 13.4 Project Materials Query Adapter", () => {
  it("projects a bounded source page without loading material bodies", async () => {
    const data = await fixture();
    const calls: unknown[] = [];
    const source: ProjectMaterialsSourcePort = {
      async list(input) { calls.push(input); return JSON.stringify(data.source_page); },
      async detail() { throw new Error("detail must not be called"); }
    };
    const adapter = createProjectMaterialsQueryAdapter({
      source,
      cursor_verifier: { verify: async () => true }
    });

    const result = await adapter.query(JSON.stringify(data.query));

    expect(result.ok).toBe(true);
    if (!result.ok || result.mode !== "current") return;
    expect(result.value.items).toHaveLength(2);
    expect(result.value.items[0]).toMatchObject({
      category: "architecture_constraint",
      blob_ref: { snapshot_version: "pv_0002" }
    });
    expect(result.value.items[1]).toMatchObject({ category: "architecture_map" });
    expect(JSON.stringify(result.value)).not.toContain("Architecture constraints");
    expect(calls).toEqual([expect.objectContaining({ limit: 5, cursor: null })]);
  });

  it("classifies the Stage 07 architecture constraint as canonical rule content", async () => {
    const data = await fixture();
    const page = data.source_page as { items: Array<Record<string, unknown>> };
    expect(page.items[0]).toMatchObject({
      category: "architecture_constraint",
      content_type: "rule",
      path: ".harness/rules/architecture.md"
    });
    const result = await adapterFor({ page }).query(JSON.stringify(data.query));
    expect(result.ok).toBe(true);
  });

  it("binds an incoming opaque cursor to actor, project, view and sort before source access", async () => {
    const data = await fixture();
    const calls: unknown[] = [];
    const query = { ...(data.query as object), cursor: "pmc_0123456789abcdef" };
    const result = await adapterFor({ page: data.source_page, verify: false, calls })
      .query(JSON.stringify(query));

    expect(result).toEqual({ ok: false, reason_code: "PROJECT_MATERIALS_CURSOR_INVALID" });
    expect(calls).toEqual([{
      cursor: "pmc_0123456789abcdef",
      project_id: "prj_alpha",
      actor_id: "actor_alpha",
      view: "project_materials",
      sort: "category_asc_path_asc_version_desc"
    }]);
  });

  it("rejects wrong category/path bindings, Plan shadows and unstable source pages", async () => {
    const data = await fixture();
    const page = data.source_page as { items: Array<Record<string, unknown>> };
    const invalidPages = [
      { ...page, items: [{ ...page.items[0], category: "architecture_map" }] },
      { ...page, items: [{ ...page.items[0], content_type: "plan", category: "plan" }] },
      { ...page, items: [...page.items].reverse() },
      { ...page, items: [...page.items].reverse().map((item, index) => ({
        ...item,
        sort_key: `forged_${index}`
      })) },
      { ...page, items: page.items.map((item) => ({ ...item,
        sort_key: `forged|${String(item.path)}|${String(item.snapshot_version)}` })) },
      { ...page, items: Array.from({ length: 6 }, () => page.items[0]) }
    ];
    for (const invalid of invalidPages) {
      await expect(adapterFor({ page: invalid }).query(JSON.stringify(data.query)))
        .resolves.toEqual({ ok: false, reason_code: "PROJECT_MATERIALS_SOURCE_INVALID" });
    }
  });

  it.each([
    ["empty", [], null, []],
    ["processing", [], null, []],
    ["forbidden", [], null, [{ reason_code: "PROJECT_INFORMATION_FORBIDDEN", retryable: false }]],
    ["partial_failure", null, "pmc_0123456789abcdef",
      [{ reason_code: "PROJECTION_PARTIAL_FAILURE", retryable: true }]]
  ] as const)("preserves the strict %s page state", async (state, replacement, cursor, failures) => {
    const data = await fixture();
    const page = data.source_page as { items: unknown[] };
    const result = await adapterFor({ page: {
      ...page,
      page_state: state,
      items: replacement ?? page.items,
      next_cursor: cursor,
      failures
    } }).query(JSON.stringify(data.query));
    expect(result.ok).toBe(true);
    if (result.ok && result.mode === "current") expect(result.value.page_state).toBe(state);
  });

  it("loads a detail only by bound material identity and exact content hash", async () => {
    const data = await fixture();
    const calls: unknown[] = [];
    const result = await adapterFor({ page: data.source_page, detail: data.source_detail, calls })
      .detail(JSON.stringify(data.detail_request));

    expect(result.ok).toBe(true);
    if (!result.ok || result.mode !== "current") return;
    expect(result.value.detail).toMatchObject({
      detail_kind: "project_material",
      content: expect.stringContaining("Dependencies point inward"),
      content_hash: "sha256:2eb6d308378bcc92621e5396ffc6398ce0eed15c896d60504010f4c25cf78189"
    });
    expect(calls).toEqual([expect.objectContaining({
      actor_id: "actor_alpha",
      project_id: "prj_alpha",
      material_id: "material_constraint"
    })]);
  });

  it("fails closed on foreign detail identity, drifted hash and missing material", async () => {
    const data = await fixture();
    const detail = data.source_detail as Record<string, unknown>;
    for (const invalid of [
      { ...detail, project_id: "prj_foreign" },
      { ...detail, material_id: "material_foreign" },
      { ...detail, content_hash: `sha256:${"f".repeat(64)}` },
      { ...detail, content: `${String(detail.content)}tampered` },
      { ...detail, content: `${String(detail.content)}tampered`,
        content_hash: `sha256:${"e".repeat(64)}`, blob_hash: `sha256:${"e".repeat(64)}` },
      { ...detail, unexpected: true }
    ]) {
      await expect(adapterFor({ page: data.source_page, detail: invalid })
        .detail(JSON.stringify(data.detail_request)))
        .resolves.toEqual({ ok: false, reason_code: "PROJECT_MATERIALS_SOURCE_INVALID" });
    }
    await expect(adapterFor({ page: data.source_page, detail: null })
      .detail(JSON.stringify(data.detail_request)))
      .resolves.toEqual({ ok: false, reason_code: "PROJECT_MATERIALS_NOT_FOUND" });
  });

  it("keeps legacy input read-only without touching the source", async () => {
    const calls: unknown[] = [];
    const legacy = { schemaVersion: 0, projectId: "prj_alpha", page: "files", items: [
      { path: "AGENTS.md", content: "legacy" }
    ] };
    const result = await adapterFor({ page: {}, detail: {}, calls }).query(JSON.stringify(legacy));
    expect(result).toEqual({ ok: true, mode: "legacy_read_only", value: legacy });
    expect(calls).toEqual([]);
  });

  it("rejects object, accessor and Proxy inputs before executing descriptors or traps", async () => {
    const data = await fixture();
    let executions = 0;
    const accessor = Object.defineProperty({}, "schema_version", {
      enumerable: true,
      get() { executions += 1; return 1; }
    });
    const proxy = new Proxy(data.query as object, {
      get() { executions += 1; throw new Error("trap"); },
      ownKeys() { executions += 1; throw new Error("trap"); }
    });
    const adapter = adapterFor({ page: data.source_page });

    await expect(adapter.query(accessor)).resolves.toEqual({
      ok: false, reason_code: "PROJECT_MATERIALS_QUERY_INVALID"
    });
    await expect(adapter.query(proxy)).resolves.toEqual({
      ok: false, reason_code: "PROJECT_MATERIALS_QUERY_INVALID"
    });
    expect(executions).toBe(0);
  });

  it.each([
    ["config", "config", ".harness/project.yaml"],
    ["rule", "rule", ".harness/rules/security.md"],
    ["architecture_map", "architecture", ".harness/codebase/map/STACK.md"],
    ["architecture_constraint", "rule", ".harness/rules/architecture.md"],
    ["instruction", "instruction", "AGENTS.md"]
  ] as const)("accepts the canonical %s material source", async (category, contentType, path) => {
    const data = await fixture();
    const base = (data.source_page as { items: Array<Record<string, unknown>> }).items[0];
    const result = await adapterFor({ page: {
      ...(data.source_page as object),
      items: [{ ...base, material_id: `material_${category}`, category,
        content_type: contentType, path, sort_key: `${category}|${path}|pv_0002` }]
    } }).query(JSON.stringify(data.query));
    expect(result.ok).toBe(true);
  });

  it("requires exact bounded serialized source data and passes frozen authorization inputs", async () => {
    const data = await fixture();
    const seen: unknown[] = [];
    const source = {
      async list(input: unknown) {
        seen.push(input);
        return 42 as unknown as string;
      },
      async detail() { return null; }
    } satisfies ProjectMaterialsSourcePort;
    const adapter = createProjectMaterialsQueryAdapter({
      source,
      cursor_verifier: { verify: () => true }
    });

    await expect(adapter.query(JSON.stringify(data.query))).resolves.toEqual({
      ok: false, reason_code: "PROJECT_MATERIALS_SOURCE_INVALID"
    });
    const input = seen[0] as { accessible_project_ids: string[]; content_types: string[] };
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.accessible_project_ids)).toBe(true);
    expect(Object.isFrozen(input.content_types)).toBe(true);

    await expect(adapterFor({ page: { ...(data.source_page as object), unexpected: true } })
      .query(JSON.stringify(data.query)))
      .resolves.toEqual({ ok: false, reason_code: "PROJECT_MATERIALS_SOURCE_INVALID" });
    await expect(adapterFor({ page: " ".repeat(2_000_001) }).query(JSON.stringify(data.query)))
      .resolves.toEqual({ ok: false, reason_code: "PROJECT_MATERIALS_SOURCE_INVALID" });
  });

  it("fails closed when cursor verification or the readonly source throws", async () => {
    const data = await fixture();
    const query = { ...(data.query as object), cursor: "pmc_0123456789abcdef" };
    const throwingSource: ProjectMaterialsSourcePort = {
      async list() { throw new Error("storage unavailable"); },
      async detail() { throw new Error("storage unavailable"); }
    };
    const cursorAdapter = createProjectMaterialsQueryAdapter({
      source: throwingSource,
      cursor_verifier: { verify: async () => { throw new Error("invalid signature"); } }
    });
    await expect(cursorAdapter.query(JSON.stringify(query))).resolves.toEqual({
      ok: false, reason_code: "PROJECT_MATERIALS_CURSOR_INVALID"
    });

    const sourceAdapter = createProjectMaterialsQueryAdapter({
      source: throwingSource,
      cursor_verifier: { verify: async () => true }
    });
    await expect(sourceAdapter.query(JSON.stringify(data.query))).resolves.toEqual({
      ok: false, reason_code: "PROJECT_MATERIALS_SOURCE_INVALID"
    });
    await expect(sourceAdapter.detail(JSON.stringify(data.detail_request))).resolves.toEqual({
      ok: false, reason_code: "PROJECT_MATERIALS_SOURCE_INVALID"
    });
  });
});
