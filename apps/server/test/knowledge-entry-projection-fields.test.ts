import { describe, expect, it } from "vitest";

import { createKnowledgeExtractor } from "../src/knowledge-pipeline/extractor.js";
import { MemoryArchiveStore } from "../src/knowledge-pipeline/memory-ports.js";
import type { KnowledgeCandidate } from "@hunter-harness/contracts";

/**
 * entry_type / body / keywords must survive the whole chain candidate → draft →
 * result. They are the fields knowledgeIngestEntrySchema requires and that
 * reusability_scope cannot supply; dropping them anywhere makes the ingest
 * bridge fall back to invention, and the semantic projection silently skips
 * entries whose payload does not parse.
 */

const now = "2026-08-18T12:00:00.000Z";

function candidate(overrides: Partial<KnowledgeCandidate> = {}): KnowledgeCandidate {
  return {
    schema_version: 1,
    candidate_id: "kc_3f66a23f5838a9fcd2f39f17152298e6",
    source_change_key: "usage-stats-cli-reporting",
    source_refs: ["packages/contracts/src/content-sync.ts#L1051"],
    summary: "nonScannablePathPrefixes 把整棵归档树判为不可扫描",
    reusability_scope: "packages",
    content_hash: `sha256:${"a".repeat(64)}`,
    confidence: 0.95,
    status: "pending",
    entry_type: "pitfall",
    body: "nonScannablePathPrefixes 把整棵归档树判为不可扫描\n位置：packages/contracts/src/content-sync.ts:1051",
    keywords: ["content-sync.ts", "src", "RED", "FIXED"],
    provenance: {
      source_kind: "review",
      source_ref: "archive:usage-stats-cli-reporting#F-001",
      producer: "harness-archive",
      producer_version: "2.3",
      created_at: now
    },
    ...overrides
  } as KnowledgeCandidate;
}

async function extractFrom(candidates: KnowledgeCandidate[]) {
  const store = new MemoryArchiveStore();
  const archive = {
    schema_version: 1 as const,
    project_id: "prj_bridge",
    change_key: "usage-stats-cli-reporting",
    archive_id: "arc_bridge",
    package_sha256: `sha256:${"b".repeat(64)}`,
    manifest_sha256: `sha256:${"c".repeat(64)}`,
    project_version: "pv_bridge",
    package_schema_version: 1,
    archive_schema_version: 1,
    package_bytes: new Uint8Array([1]),
    manifest_bytes: new Uint8Array([2]),
    knowledge_candidates: candidates,
    project_content_candidates: [],
    validation_receipt: {
      schema_version: 1 as const,
      package_sha256: `sha256:${"b".repeat(64)}`,
      manifest_sha256: `sha256:${"c".repeat(64)}`,
      package_schema_version: 1,
      archive_schema_version: 1,
      safe_paths: true,
      no_symlinks: true,
      no_encrypted_entries: true,
      declared_files_verified: true,
      content_hashes_verified: true,
      candidate_sources_bound: true,
      file_count: 1,
      compressed_bytes: 1,
      uncompressed_bytes: 1,
      validated_at: now
    },
    stored_at: now
  };
  await store.putIfAbsent(archive as never);
  const extractor = createKnowledgeExtractor({ archive_store: store });
  return extractor.extract({
    schema_version: 1,
    job: {
      job_id: "job_bridge",
      project_id: "prj_bridge",
      change_key: "usage-stats-cli-reporting",
      archive_id: "arc_bridge"
    }
  } as never);
}

describe("knowledge entry projection fields survive extraction", () => {
  it("carries entry_type / body / keywords into the draft", async () => {
    const [draft] = await extractFrom([candidate()]);

    expect(draft).toBeDefined();
    expect(draft?.entry_type).toBe("pitfall");
    expect(draft?.body).toContain("nonScannablePathPrefixes");
    expect(draft?.keywords).toEqual(["content-sync.ts", "src", "RED", "FIXED"]);
  });

  it("leaves them absent for archives built before the generator existed", async () => {
    const legacy = candidate();
    delete (legacy as { entry_type?: unknown }).entry_type;
    delete (legacy as { body?: unknown }).body;
    delete (legacy as { keywords?: unknown }).keywords;

    const [draft] = await extractFrom([legacy]);

    // Degrade, do not invent: the bridge decides what to do with a bare draft.
    expect(draft).toBeDefined();
    expect(draft?.entry_type).toBeUndefined();
    expect(draft?.body).toBeUndefined();
    expect(draft?.keywords).toBeUndefined();
    expect(draft?.summary).toBe(legacy.summary);
  });
});
