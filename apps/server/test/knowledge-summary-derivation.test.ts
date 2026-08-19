import { Buffer } from "node:buffer";

import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";

import { createKnowledgeExtractor } from "../src/knowledge-pipeline/extractor.js";
import { MemoryArchiveStore } from "../src/knowledge-pipeline/memory-ports.js";
import { deriveKnowledgeCandidatesFromSummary }
  from "../src/knowledge-pipeline/summary-candidates.js";
import type { KnowledgeCandidate } from "@hunter-harness/contracts";

/**
 * Archives published before the CLI generated `candidates/knowledge.json` carry
 * none, and one immutable package per change key means the client can never add
 * the file afterwards — those archives would stay permanently absent from the
 * knowledge base. Deriving from the summary they already contain is the only
 * route that reaches them, and it needs no re-upload.
 */

const now = "2026-08-18T12:00:00.000Z";

const summary = {
  schemaVersion: 1,
  changeName: "usage-stats-platform-support",
  reviewFindings: [
    {
      id: "F-001", severity: "YELLOW", disposition: "FIXED",
      title: "路径校验漏掉了 UNC 前缀", path: "src/core/a.ts", line: 42
    },
    {
      id: "F-002", severity: "RED", disposition: "DEFERRED",
      title: "并发写未加锁", path: "src/b.ts", line: 7
    },
    { id: "F-003", severity: "OK", disposition: "NOT_APPLICABLE", title: "noise" },
    { id: "F-004", severity: "RED", disposition: "OPEN", title: "未裁决" }
  ],
  knownRisks: [
    { phase: "test", severity: "WARN", message: "apiTest 人工前置未执行" }
  ]
};

function packageBytes(contents: Record<string, unknown>): Uint8Array {
  const zip = new AdmZip();
  for (const [path, value] of Object.entries(contents)) {
    zip.addFile(path, Buffer.from(JSON.stringify(value), "utf8"));
  }
  return new Uint8Array(zip.toBuffer());
}

function storedArchive(overrides: {
  knowledge_candidates?: KnowledgeCandidate[];
  package_bytes?: Uint8Array;
}) {
  return {
    schema_version: 1 as const,
    project_id: "prj_derive",
    change_key: "usage-stats-platform-support",
    archive_id: "arc_derive",
    package_sha256: `sha256:${"b".repeat(64)}`,
    manifest_sha256: `sha256:${"c".repeat(64)}`,
    project_version: "pv_derive",
    package_schema_version: 1,
    archive_schema_version: 1,
    package_bytes: overrides.package_bytes ??
      packageBytes({ "reports/final/summary-data.json": summary }),
    manifest_bytes: new Uint8Array([2]),
    knowledge_candidates: overrides.knowledge_candidates ?? [],
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
}

async function extractFrom(archive: ReturnType<typeof storedArchive>) {
  const store = new MemoryArchiveStore();
  await store.putIfAbsent(archive as never);
  return createKnowledgeExtractor({ archive_store: store }).extract({
    schema_version: 1,
    job: {
      job_id: "job_derive",
      project_id: "prj_derive",
      change_key: "usage-stats-platform-support",
      archive_id: "arc_derive"
    }
  } as never);
}

describe("knowledge candidates derived from an archived summary", () => {
  it("adopts only adjudicated findings and known risks", () => {
    const derived = deriveKnowledgeCandidatesFromSummary({
      summary,
      changeKey: "usage-stats-platform-support",
      archiveId: "arc_derive",
      producerVersion: "1",
      createdAt: now
    });

    // OK severity and an unadjudicated OPEN disposition are both dropped.
    expect(derived.map((item) => item.summary)).toEqual([
      "路径校验漏掉了 UNC 前缀",
      "并发写未加锁",
      "apiTest 人工前置未执行"
    ]);
    expect(derived.map((item) => item.entry_type)).toEqual(["pitfall", "risk", "risk"]);
    expect(derived.map((item) => item.confidence)).toEqual([0.85, 0.95, 0.85]);
  });

  it("reaches an archive whose stored package carries no candidates", async () => {
    const drafts = await extractFrom(storedArchive({ knowledge_candidates: [] }));

    // Everything derived clears the 0.82 auto-promote threshold.
    expect(drafts).toHaveLength(3);
    expect(drafts.map((draft) => draft.entry_type)).toEqual(["pitfall", "risk", "risk"]);
    expect(drafts[0]?.body).toContain("位置：src/core/a.ts:42");
  });

  it("never overrides candidates the package shipped itself", async () => {
    const shipped: KnowledgeCandidate = {
      schema_version: 1,
      candidate_id: "kc_" + "1".repeat(32),
      source_change_key: "usage-stats-platform-support",
      source_refs: ["src/shipped.ts"],
      summary: "包里自带的候选",
      reusability_scope: "src",
      content_hash: `sha256:${"a".repeat(64)}`,
      confidence: 0.95,
      status: "pending",
      entry_type: "decision",
      body: "包里自带的候选",
      keywords: ["shipped"],
      provenance: {
        source_kind: "review",
        source_ref: "archive:arc_derive#F-009",
        producer: "harness-archive",
        producer_version: "1",
        created_at: now
      }
    } as KnowledgeCandidate;

    const drafts = await extractFrom(storedArchive({ knowledge_candidates: [shipped] }));

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.summary).toBe("包里自带的候选");
  });

  it("derives nothing rather than failing when the summary is unusable", async () => {
    const noSummary = await extractFrom(storedArchive({
      package_bytes: packageBytes({ "plans/plan.md": "not the summary" })
    }));
    expect(noSummary).toEqual([]);

    const brokenZip = await extractFrom(storedArchive({
      package_bytes: new Uint8Array([1, 2, 3])
    }));
    expect(brokenZip).toEqual([]);
  });

  it("derives the same candidates on every run of the same package", async () => {
    const archive = storedArchive({ knowledge_candidates: [] });
    const first = await extractFrom(archive);
    const second = await extractFrom(archive);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("matches the identity the CLI generator produces for the same summary", () => {
    // Fixed expectations captured from harness_knowledge_candidates.py, so a
    // drift on either side surfaces here rather than as duplicate knowledge:
    // the same finding must never enter under two different candidate ids.
    const derived = deriveKnowledgeCandidatesFromSummary({
      summary,
      changeKey: "demo-change",
      archiveId: "arc_demo",
      producerVersion: "1",
      createdAt: "2026-08-19T00:00:00.000Z"
    });

    expect(derived[0]?.candidate_id).toBe("kc_9780747f27f98cbdb77181a4d93c17b0");
    expect(derived[1]?.candidate_id).toBe("kc_d2bd59a85762256729191bebda7db303");
    expect(derived[2]?.candidate_id).toBe("kc_9aafd0ddad6b18dd8821b4a2d4633668");
    expect(derived[0]?.keywords).toEqual(["a.ts", "core", "YELLOW", "FIXED"]);
    expect(derived[0]?.source_refs).toEqual(["src/core/a.ts#L42"]);
    expect(derived[2]?.provenance.source_kind).toBe("archive");
  });
});
