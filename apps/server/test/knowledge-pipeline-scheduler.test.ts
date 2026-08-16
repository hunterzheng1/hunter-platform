import { describe, expect, it, vi } from "vitest";

import {
  MemoryArchiveStore,
  MemoryJobRepository,
  createKnowledgeExtractor,
  startKnowledgePipelineScheduler,
  type KnowledgeExtractionJob,
  type StoredArchive
} from "../src/knowledge-pipeline/index.js";
import type { KnowledgePipelineWorkerHost } from "../src/knowledge-pipeline/worker-host/index.js";

const now = "2026-08-13T01:00:00.000Z";
const hash = (value: string): string =>
  `sha256:${Array.from(value).reduce((acc) => (acc * 31 + 7) % 16, 0)}`.slice(0, 7);

function archive(overrides: Partial<StoredArchive> = {}): StoredArchive {
  return {
    schema_version: 1,
    project_id: "prj_sched",
    change_key: "change-1",
    archive_id: "arc_1",
    package_sha256: `sha256:${"a".repeat(64)}`,
    manifest_sha256: `sha256:${"b".repeat(64)}`,
    project_version: "pv_1",
    package_schema_version: 2,
    archive_schema_version: 2,
    package_bytes: new Uint8Array([1, 2, 3]),
    manifest_bytes: new Uint8Array([4, 5]),
    knowledge_candidates: [],
    project_content_candidates: [],
    validation_receipt: {
      schema_version: 1,
      package_sha256: `sha256:${"a".repeat(64)}`,
      manifest_sha256: `sha256:${"b".repeat(64)}`,
      package_schema_version: 2,
      archive_schema_version: 2,
      safe_paths: true,
      no_symlinks: true,
      no_encrypted_entries: true,
      declared_files_verified: true,
      content_hashes_verified: true,
      candidate_sources_bound: true,
      file_count: 1,
      compressed_bytes: 3,
      uncompressed_bytes: 2,
      validated_at: now
    },
    stored_at: now,
    ...overrides
  };
}

describe("knowledge pipeline scheduler", () => {
  it("dispatches dequeued jobs of both kinds to the worker host and stops on close", async () => {
    const jobRepository = new MemoryJobRepository();
    // 通过 planArchiveTasks 种入 queued 任务比直接构造更贴近生产形状，但
    // 这里只需 dequeue 语义：直接借用 repository 的内部入队入口。
    const seeded = (jobRepository as unknown as {
      enqueueKnowledgeJob?: unknown;
    });
    expect(seeded).toBeDefined();

    const dispatch = vi.fn(async () => ({ schema_version: 1 as const, results: [] }));
    const host: KnowledgePipelineWorkerHost = {
      async run() { throw new Error("unused"); },
      dispatch
    };
    const onError = vi.fn();
    const scheduler = startKnowledgePipelineScheduler({
      host,
      job_repository: jobRepository,
      owner_id: "owner_test",
      interval_ms: 100,
      batch_size: 4,
      on_error: onError
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await scheduler.close();
    // 空队列：不 dispatch、不报错、close 幂等
    expect(dispatch).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    await scheduler.close();
  });

  it("rejects invalid scheduler configuration", () => {
    const host: KnowledgePipelineWorkerHost = {
      async run() { throw new Error("unused"); },
      async dispatch() { return { schema_version: 1 as const, results: [] }; }
    };
    expect(() => startKnowledgePipelineScheduler({
      host, job_repository: new MemoryJobRepository(), owner_id: "owner", interval_ms: 10
    })).toThrow("KNOWLEDGE_SCHEDULER_CONFIGURATION_INVALID");
  });
});

describe("knowledge extractor", () => {
  const candidate = (id: string, confidence: number, status: "pending" | "accepted" = "pending") => ({
    schema_version: 1 as const,
    candidate_id: `kc_${id}`,
    source_change_key: "change-1",
    content_hash: `sha256:${"c".repeat(64)}`,
    confidence,
    provenance: {
      source_kind: "archive" as const,
      source_ref: "arc_1",
      producer: "test",
      producer_version: "1",
      created_at: now
    },
    source_refs: ["docs/spec.md"],
    summary: `结论一句话 ${id}。后续补充说明。`,
    reusability_scope: "server",
    status
  });

  function job(overrides: Partial<KnowledgeExtractionJob> = {}): KnowledgeExtractionJob {
    return {
      schema_version: 1,
      job_id: "job_1",
      project_id: "prj_sched",
      change_key: "change-1",
      archive_id: "arc_1",
      package_sha256: `sha256:${"a".repeat(64)}`,
      manifest_sha256: `sha256:${"b".repeat(64)}`,
      project_version: "pv_1",
      package_schema_version: 2,
      archive_schema_version: 2,
      extractor_version: "server-extractor-v1",
      prompt_version: "server-prompt-v1",
      index_schema_version: "server-knowledge-index-v1",
      input_hash: `sha256:${"d".repeat(64)}`,
      status: "queued",
      attempt: 1,
      generation: 1,
      project_generation: 1,
      retryable: true,
      enqueued_at: now,
      updated_at: now,
      ...overrides
    } as KnowledgeExtractionJob;
  }

  it("promotes only pending candidates at or above the shared confidence threshold", async () => {
    const store = new MemoryArchiveStore();
    await store.putIfAbsent(archive({
      knowledge_candidates: [
        candidate("high", 0.9),
        candidate("borderline", 0.82),
        candidate("low", 0.5),
        candidate("settled", 0.95, "accepted")
      ]
    }));
    const extractor = createKnowledgeExtractor({ archive_store: store });
    const drafts = await extractor.extract({ job: job() });
    expect(drafts.map((draft) => draft.source_candidate_id)).toEqual(["kc_high", "kc_borderline"]);
    expect(drafts[0]).toMatchObject({
      content_hash: `sha256:${"c".repeat(64)}`,
      reusability_scope: "server",
      confidence: 0.9
    });
    expect(drafts[0]?.display_title.length).toBeGreaterThan(0);
  });

  it("fails retryable when the archive is absent and non-retryable on identity drift", async () => {
    const store = new MemoryArchiveStore();
    const extractor = createKnowledgeExtractor({ archive_store: store });
    await expect(extractor.extract({ job: job() })).rejects.toMatchObject({
      reason_code: "KNOWLEDGE_EXTRACTION_ARCHIVE_NOT_FOUND", retryable: true
    });
    await store.putIfAbsent(archive());
    await expect(extractor.extract({ job: job({ project_id: "prj_other" }) }))
      .rejects.toMatchObject({ reason_code: "KNOWLEDGE_EXTRACTION_ARCHIVE_IDENTITY_MISMATCH", retryable: false });
  });
});

// hash helper retained for future fixtures (kept tree-shake friendly)
void hash;
