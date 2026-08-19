import { describe, expect, it } from "vitest";

import { knowledgeIngestEntrySchema, type KnowledgeIngestEntry } from "@hunter-harness/contracts";

import { ingestPipelineKnowledge, knowledgeEntryFromResult } from "../src/knowledge-bridge/index.js";
import { knowledgeEntryDocument } from "../src/semantic/knowledge-projection.js";
import type { KnowledgeResult } from "../src/knowledge-pipeline/types.js";

/**
 * The bridge that was missing: knowledge_pipeline_results never reached
 * knowledge_ingest_entries, so project_knowledge stayed empty even once the
 * pipeline produced results. Everything it writes must come from real data —
 * provenance is what makes a knowledge entry trustworthy, so a result that
 * cannot be filled honestly is skipped rather than invented.
 */

const SUMMARY_DOCUMENT = {
  source_path: "reports/final/summary-data.json",
  content_hash: `sha256:${"d".repeat(64)}`,
  content: JSON.stringify({
    changeName: "usage-stats-cli-reporting",
    baseCommit: "54a1f26fb33695d2d0e6c06e9d1743bd17115169",
    finalCommit: "aa1f26fb33695d2d0e6c06e9d1743bd171151690",
    finalStatus: "WARN"
  })
};

function result(overrides: Partial<KnowledgeResult> = {}): KnowledgeResult {
  return {
    schema_version: 1,
    knowledge_id: "kn_3f66a23f5838a9fcd2f39f17152298e6",
    project_id: "prj_bridge",
    content_kind: "knowledge_entry",
    status: "active",
    content_hash: `sha256:${"a".repeat(64)}`,
    display_title: "nonScannablePathPrefixes 把整棵归档树判为不可扫描",
    summary: "nonScannablePathPrefixes 把整棵归档树判为不可扫描",
    reusability_scope: "packages",
    confidence: 0.95,
    source_archive_ids: ["arc_bridge"],
    source_change_keys: ["usage-stats-cli-reporting"],
    source_candidate_ids: ["kc_3f66a23f5838a9fcd2f39f17152298e6"],
    source_refs: ["packages/contracts/src/content-sync.ts#L1051"],
    extractor_version: "server-extractor-v1",
    prompt_version: "server-prompt-v1",
    index_schema_version: "server-knowledge-index-v1",
    generation: 1,
    created_at: "2026-08-18T12:00:00.000Z",
    updated_at: "2026-08-18T12:00:00.000Z",
    entry_type: "pitfall",
    body: "nonScannablePathPrefixes 把整棵归档树判为不可扫描\n位置：packages/contracts/src/content-sync.ts:1051",
    keywords: ["content-sync.ts", "src", "RED", "FIXED"],
    ...overrides
  } as KnowledgeResult;
}

describe("knowledge ingest bridge", () => {
  it("projects a pipeline result into a schema-valid ingest entry", () => {
    const entry = knowledgeEntryFromResult(result(), SUMMARY_DOCUMENT);

    expect(entry).not.toBeNull();
    // The whole point: it must survive the schema the semantic projection applies.
    expect(knowledgeIngestEntrySchema.safeParse(entry).success).toBe(true);

    expect(entry?.id).toBe("kn_3f66a23f5838a9fcd2f39f17152298e6");
    expect(entry?.type).toBe("pitfall");
    expect(entry?.title).toBe("nonScannablePathPrefixes 把整棵归档树判为不可扫描");
    expect(entry?.body).toContain("content-sync.ts:1051");
    expect(entry?.keywords).toEqual(["content-sync.ts", "src", "RED", "FIXED"]);
    expect(entry?.scope.sourceFiles).toEqual(["packages/contracts/src/content-sync.ts#L1051"]);
  });

  it("fills all seven provenance fields from the real summary document", () => {
    const entry = knowledgeEntryFromResult(result(), SUMMARY_DOCUMENT);

    expect(entry?.source).toEqual({
      archive: "arc_bridge",
      summaryData: "reports/final/summary-data.json",
      summarySha256: `sha256:${"d".repeat(64)}`,
      sourceCommit: "aa1f26fb33695d2d0e6c06e9d1743bd171151690",
      baseCommit: "54a1f26fb33695d2d0e6c06e9d1743bd17115169",
      changeName: "usage-stats-cli-reporting",
      finalStatus: "WARN"
    });
  });

  it("survives the semantic projection instead of being silently skipped", () => {
    const entry = knowledgeEntryFromResult(result(), SUMMARY_DOCUMENT);
    if (entry === null) throw new Error("expected an entry");

    const document = knowledgeEntryDocument({
      projectId: entry.projectId,
      entryId: entry.id,
      contentSha256: `sha256:${"e".repeat(64)}`,
      payload: entry as unknown as Record<string, unknown>,
      status: entry.status
    } as never);

    // knowledgeEntryDocument returns null on safeParse failure — the silent
    // half-lit failure mode the spec called out.
    expect(document).not.toBeNull();
    expect(document?.metadata.entry_type).toBe("pitfall");
  });

  it("skips a result that cannot be filled honestly instead of inventing", () => {
    // 没有 entry_type / body 就没有可信的分类与正文；宁可不入库。
    for (const missing of [{ entry_type: undefined }, { body: undefined }]) {
      expect(knowledgeEntryFromResult(result(missing), SUMMARY_DOCUMENT)).toBeNull();
    }
    // 溯源缺失同理——知识条目的可信度正是靠溯源。
    for (const badSummary of [
      { ...SUMMARY_DOCUMENT, content: "{}" },
      { ...SUMMARY_DOCUMENT, content: "not json" },
      { ...SUMMARY_DOCUMENT, content: JSON.stringify({ changeName: "x" }) }
    ]) {
      expect(knowledgeEntryFromResult(result(), badSummary)).toBeNull();
    }
    expect(knowledgeEntryFromResult(result(), null)).toBeNull();
  });

  it("treats absent keywords as none rather than as a reason to skip", () => {
    const entry = knowledgeEntryFromResult(result({ keywords: undefined }), SUMMARY_DOCUMENT);
    expect(entry).not.toBeNull();
    expect(entry?.keywords).toEqual([]);
  });

  it("carries the pipeline confidence through without re-scoring", () => {
    const entry = knowledgeEntryFromResult(result(), SUMMARY_DOCUMENT);
    expect(entry?.confidence?.score).toBe(0.95);
    expect(entry?.lifecycle.createdAt).toBe("2026-08-18T12:00:00.000Z");
  });
});

describe("ingestPipelineKnowledge", () => {
  function repository() {
    const written: Array<{ entryId: string; status: string }> = [];
    return {
      written,
      async upsertKnowledgeEntry(input: { entryId: string; status: string }) {
        written.push({ entryId: input.entryId, status: input.status });
        return "created" as const;
      }
    };
  }

  const helpers = {
    contentHash: () => `sha256:${"f".repeat(64)}`,
    preparePayload: (entry: KnowledgeIngestEntry) => ({
      payload: entry as unknown as Record<string, unknown>,
      status: entry.status
    })
  };

  it("writes every projectable result and counts the rest as skipped", async () => {
    const store = repository();
    const outcome = await ingestPipelineKnowledge({
      repository: store,
      results: [
        result(),
        result({ knowledge_id: "kn_second", content_hash: `sha256:${"b".repeat(64)}` }),
        // 老归档来的结果：没有分类与正文，跳过而不是编造。
        result({ knowledge_id: "kn_bare", entry_type: undefined, body: undefined })
      ],
      summary: SUMMARY_DOCUMENT,
      ...helpers
    });

    expect(outcome).toEqual({ created: 2, updated: 0, duplicate: 0, skipped: 1 });
    expect(store.written.map((row) => row.entryId))
      .toEqual(["kn_3f66a23f5838a9fcd2f39f17152298e6", "kn_second"]);
  });

  it("writes nothing when the change summary is missing", async () => {
    const store = repository();
    const outcome = await ingestPipelineKnowledge({
      repository: store,
      results: [result()],
      summary: null,
      ...helpers
    });

    // 没有溯源就没有可信条目；整批跳过，但计数让降级可见而不是静默。
    expect(outcome).toEqual({ created: 0, updated: 0, duplicate: 0, skipped: 1 });
    expect(store.written).toEqual([]);
  });
});
