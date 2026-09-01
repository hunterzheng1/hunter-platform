import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { PgSemanticStore } from "../src/semantic/pg-store.js";

describe("PgSemanticStore search scoping", () => {
  it("uses one allowlisted query for multiple accessible projects", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const store = new PgSemanticStore({ query } as unknown as Pool);

    await store.search("needle", ["prj_a", "prj_b"], {
      limit: 20,
      currentSchemaOnly: true,
      kinds: ["knowledge_entry", "knowledge_markdown"]
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("project_id = ANY($2::text[])");
    expect(query.mock.calls[0]?.[0]).toContain("d.kind = ANY($3::text[])");
    expect(query.mock.calls[0]?.[0]).toContain("g.schema_version = $4");
    expect(query.mock.calls[0]?.[0]).toContain(
      "to_tsvector('simple', cjk_bigrams(coalesce(d.title, '') || ' ' || coalesce(d.body, '')))"
    );
    expect(query.mock.calls[0]?.[0]).toContain("@@ plainto_tsquery('simple', cjk_bigrams($1))");
    expect(query.mock.calls[0]?.[1]).toEqual([
      "needle",
      ["prj_a", "prj_b"],
      ["knowledge_entry", "knowledge_markdown"],
      2,
      20
    ]);
  });

  it("does not treat unversioned legacy archive documents as current", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const store = new PgSemanticStore({ query } as unknown as Pool);

    await store.search("legacy", ["prj_a"], { currentSchemaOnly: true });

    expect(query.mock.calls[0]?.[0]).not.toContain("g.schema_version IS NULL OR");
    expect(query.mock.calls[0]?.[0]).toContain(
      "g.schema_version IS NULL AND d.artifact_id = 'ingest'"
    );
  });
});
