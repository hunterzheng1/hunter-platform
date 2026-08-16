import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createKnowledgePipelineWorkerHost,
  type KnowledgeExtractorPort,
  type WorkerHostJob,
  type WorkerHostResult
} from "../src/knowledge-pipeline/worker-host/index.js";
import type { ChangeProjectionWorker, ChangeProjectionWorkerResult } from "../src/change-projection-worker/index.js";
import type { JobReceipt, KnowledgeExtractionJob, KnowledgePipelineWorker } from "../src/knowledge-pipeline/index.js";
import { KnowledgePipelineError } from "../src/knowledge-pipeline/errors.js";

const now = "2026-08-15T01:00:00.000Z";
const hash = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function knowledgeJob(overrides: Partial<KnowledgeExtractionJob> = {}): KnowledgeExtractionJob {
  return {
    schema_version: 1, job_id: "job_knowledge_1", idempotency_key: hash("identity"),
    project_id: "prj_worker", change_key: "change-worker", archive_id: "arc_worker",
    package_sha256: hash("package"), extractor_version: "extractor-v1", prompt_version: "prompt-v1",
    index_schema_version: "index-v1", status: "extracting", attempt: 1, generation: 3,
    input_hash: hash("input"), retryable: true, knowledge_candidates: [], created_at: now, updated_at: now,
    ...overrides
  };
}

function receipt(job: KnowledgeExtractionJob): JobReceipt {
  const result = { ...job };
  delete result.knowledge_candidates;
  return result;
}

function hostJob(worker_kind: WorkerHostJob["worker_kind"], job_id = "job_1"): WorkerHostJob {
  return { schema_version: 1, worker_kind, job_id, owner_id: "worker-a" };
}

function changeWorker(run: (input: { job_id: string; owner_id: string }) => Promise<ChangeProjectionWorkerResult>): ChangeProjectionWorker {
  return { run };
}

function knowledgeWorker(methods: Partial<KnowledgePipelineWorker> = {}): KnowledgePipelineWorker {
  return {
    startKnowledgeExtraction: async (job_id) => knowledgeJob({ job_id }),
    completeKnowledgeExtraction: async (input) => receipt(knowledgeJob({ job_id: input.job_id, status: "ready", retryable: false, output_hash: hash("output"), result_count: 1 })),
    failKnowledgeExtraction: async (input) => receipt(knowledgeJob({ job_id: input.job_id, status: "failed", retryable: true, generation: input.generation, reason_code: input.reason_code })),
    ...methods
  };
}

function readyChange(job_id: string, output_hash = hash("output")): ChangeProjectionWorkerResult {
  return { job_id, status: "ready", retryable: false, output_hash, document_count: 1 };
}

describe("knowledge pipeline worker host", () => {
  it("runs bounded batches and preserves result order", async () => {
    let active = 0;
    let peak = 0;
    const host = createKnowledgePipelineWorkerHost({
      change_projection_worker: changeWorker(async ({ job_id }) => {
        active += 1; peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return readyChange(job_id);
      }),
      knowledge_pipeline_worker: knowledgeWorker(), max_concurrency: 2, max_batch_size: 4
    });
    const result = await host.dispatch({ schema_version: 1, jobs: [
      hostJob("change_projection", "job-a"), hostJob("change_projection", "job-b"), hostJob("change_projection", "job-c")
    ] });
    expect(peak).toBe(2);
    expect(result.results.map((item) => item.job_id)).toEqual(["job-a", "job-b", "job-c"]);
    expect(result.results.every((item) => item.status === "ready")).toBe(true);
  });

  it("executes knowledge extraction through the generation-bound worker", async () => {
    const calls: string[] = [];
    const job = knowledgeJob();
    const worker = knowledgeWorker({
      startKnowledgeExtraction: async (job_id) => { calls.push(`start:${job_id}`); return job; },
      completeKnowledgeExtraction: async (input) => {
        calls.push(`complete:${input.generation}`);
        return receipt(knowledgeJob({ status: "ready", retryable: false, generation: input.generation, output_hash: hash("output"), result_count: 1 }));
      }
    });
    const extractor: KnowledgeExtractorPort = { async extract(input) {
      calls.push(`extract:${input.job.generation}`);
      return [{ source_candidate_id: "kc_1", content_hash: hash("content"), display_title: "Reusable conclusion",
        summary: "A bounded reusable summary", reusability_scope: "server indexing",
        source_refs: ["summary/change-summary.json#1"], confidence: 0.9 }];
    } };
    const host = createKnowledgePipelineWorkerHost({
      change_projection_worker: changeWorker(async ({ job_id }) => readyChange(job_id)),
      knowledge_pipeline_worker: worker, knowledge_extractor: extractor
    });
    await expect(host.run(hostJob("knowledge_extraction", job.job_id))).resolves.toMatchObject<Partial<WorkerHostResult>>({
      worker_kind: "knowledge_extraction", job_id: job.job_id, status: "ready", generation: 3
    });
    expect(calls).toEqual(["start:job_knowledge_1", "extract:3", "complete:3"]);
  });

  it("reports extractor unavailability without claiming or mutating a job", async () => {
    let starts = 0;
    const host = createKnowledgePipelineWorkerHost({
      change_projection_worker: changeWorker(async ({ job_id }) => readyChange(job_id)),
      knowledge_pipeline_worker: knowledgeWorker({ startKnowledgeExtraction: async () => { starts += 1; return knowledgeJob(); } })
    });
    await expect(host.run(hostJob("knowledge_extraction", "job-knowledge"))).resolves.toMatchObject({
      status: "failed", retryable: true, reason_code: "KNOWLEDGE_EXTRACTOR_UNAVAILABLE"
    });
    expect(starts).toBe(0);
  });

  it("records extractor failure as a stable retryable outcome without leaking the error", async () => {
    let failed: unknown;
    const host = createKnowledgePipelineWorkerHost({
      change_projection_worker: changeWorker(async ({ job_id }) => readyChange(job_id)),
      knowledge_pipeline_worker: knowledgeWorker({
        startKnowledgeExtraction: async (job_id) => knowledgeJob({ job_id }),
        failKnowledgeExtraction: async (input) => {
          failed = input;
          return receipt(knowledgeJob({ job_id: input.job_id, status: "failed", retryable: true, generation: input.generation, reason_code: input.reason_code }));
        }
      }),
      knowledge_extractor: { async extract() { throw new Error("backend password=secret"); } }
    });
    const result = await host.run(hostJob("knowledge_extraction", "job-knowledge"));
    expect(result).toMatchObject({ status: "failed", retryable: true, reason_code: "KNOWLEDGE_EXTRACTOR_UNAVAILABLE" });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(failed).toMatchObject({ job_id: "job-knowledge", generation: 3,
      reason_code: "KNOWLEDGE_EXTRACTOR_UNAVAILABLE", retryable: true });
  });

  it("preserves durable lease failure and ready replay outcomes from the change worker", async () => {
    let calls = 0;
    const host = createKnowledgePipelineWorkerHost({
      change_projection_worker: changeWorker(async ({ job_id }) => {
        calls += 1;
        if (calls === 1) return { job_id, status: "failed", retryable: true, reason_code: "CHANGE_PROJECTION_LEASE_STALE" };
        if (calls === 2) return { job_id, status: "failed", retryable: true, reason_code: "CHANGE_PROJECTION_LEASE_EXPIRED" };
        return readyChange(job_id);
      }),
      knowledge_pipeline_worker: knowledgeWorker()
    });
    await expect(host.run(hostJob("change_projection", "job-lease"))).resolves.toMatchObject({
      status: "failed", retryable: true, reason_code: "CHANGE_PROJECTION_LEASE_STALE"
    });
    await expect(host.run(hostJob("change_projection", "job-expired"))).resolves.toMatchObject({
      status: "failed", retryable: true, reason_code: "CHANGE_PROJECTION_LEASE_EXPIRED"
    });
    const first = await host.run(hostJob("change_projection", "job-replay"));
    const second = await host.run(hostJob("change_projection", "job-replay"));
    expect(first).toEqual(second);
  });

  it("preserves an allowlisted change-worker lease rejection without exposing its error", async () => {
    const host = createKnowledgePipelineWorkerHost({
      change_projection_worker: changeWorker(async () => {
        throw { reason_code: "CHANGE_PROJECTION_LEASE_STALE", retryable: false };
      }),
      knowledge_pipeline_worker: knowledgeWorker()
    });
    await expect(host.run(hostJob("change_projection", "job-change-rejection"))).resolves.toMatchObject({
      status: "failed", retryable: false, reason_code: "CHANGE_PROJECTION_LEASE_STALE"
    });
  });

  it("marks malformed extractor output non-retryable without publishing it", async () => {
    let failed: unknown;
    const host = createKnowledgePipelineWorkerHost({
      change_projection_worker: changeWorker(async ({ job_id }) => readyChange(job_id)),
      knowledge_pipeline_worker: knowledgeWorker({
        startKnowledgeExtraction: async (job_id) => knowledgeJob({ job_id }),
        failKnowledgeExtraction: async (input) => {
          failed = input;
          return receipt(knowledgeJob({ job_id: input.job_id, status: "failed", retryable: false, generation: input.generation, reason_code: input.reason_code }));
        }
      }),
      knowledge_extractor: {
        async extract() {
          return [{ source_candidate_id: "kc_1", content_hash: "backend-secret", display_title: "x",
            summary: "x", reusability_scope: "x", source_refs: [], confidence: 0.5 }];
        }
      }
    });
    const result = await host.run(hostJob("knowledge_extraction", "job-malformed"));
    expect(result).toMatchObject({ status: "failed", retryable: false, reason_code: "KNOWLEDGE_RESULT_INVALID" });
    expect(JSON.stringify(result)).not.toContain("backend-secret");
    expect(failed).toMatchObject({ reason_code: "KNOWLEDGE_RESULT_INVALID", retryable: false });
  });

  it("rejects a knowledge worker receipt that crosses the requested job identity", async () => {
    let extracted = 0;
    const host = createKnowledgePipelineWorkerHost({
      change_projection_worker: changeWorker(async ({ job_id }) => readyChange(job_id)),
      knowledge_pipeline_worker: knowledgeWorker({
        startKnowledgeExtraction: async () => knowledgeJob({ job_id: "job-other" })
      }),
      knowledge_extractor: {
        async extract() {
          extracted += 1;
          return [];
        }
      }
    });
    await expect(host.run(hostJob("knowledge_extraction", "job-requested"))).resolves.toMatchObject({
      status: "failed", retryable: true, reason_code: "KNOWLEDGE_WORKER_PORT_INVALID"
    });
    expect(extracted).toBe(0);
  });

  it("rejects a foreign immutable identity in a completed receipt", async () => {
    const job = knowledgeJob({ job_id: "job-identity" });
    const host = createKnowledgePipelineWorkerHost({
      change_projection_worker: changeWorker(async ({ job_id }) => readyChange(job_id)),
      knowledge_pipeline_worker: knowledgeWorker({
        startKnowledgeExtraction: async () => job,
        completeKnowledgeExtraction: async (input) => receipt(knowledgeJob({
          ...job,
          job_id: input.job_id,
          project_id: "prj-foreign",
          status: "ready",
          retryable: false,
          output_hash: hash("output"),
          result_count: 0
        }))
      }),
      knowledge_extractor: { async extract() { return []; } }
    });
    await expect(host.run(hostJob("knowledge_extraction", job.job_id))).resolves.toMatchObject({
      status: "failed", retryable: true, reason_code: "KNOWLEDGE_WORKER_PORT_INVALID"
    });
  });

  it("rejects a foreign immutable identity in a failed receipt", async () => {
    const job = knowledgeJob({ job_id: "job-failed-identity" });
    const host = createKnowledgePipelineWorkerHost({
      change_projection_worker: changeWorker(async ({ job_id }) => readyChange(job_id)),
      knowledge_pipeline_worker: knowledgeWorker({
        startKnowledgeExtraction: async () => job,
        failKnowledgeExtraction: async (input) => receipt(knowledgeJob({
          ...job,
          job_id: input.job_id,
          project_id: "prj-foreign",
          status: "failed",
          retryable: true,
          reason_code: input.reason_code,
          generation: input.generation
        }))
      }),
      knowledge_extractor: { async extract() { throw new Error("extractor unavailable"); } }
    });
    await expect(host.run(hostJob("knowledge_extraction", job.job_id))).resolves.toMatchObject({
      status: "failed", retryable: true, reason_code: "KNOWLEDGE_WORKER_PORT_INVALID"
    });
  });

  it("rejects a failed receipt that changes the requested reason or retryability", async () => {
    const job = knowledgeJob({ job_id: "job-failed-reason" });
    const host = createKnowledgePipelineWorkerHost({
      change_projection_worker: changeWorker(async ({ job_id }) => readyChange(job_id)),
      knowledge_pipeline_worker: knowledgeWorker({
        startKnowledgeExtraction: async () => job,
        failKnowledgeExtraction: async (input) => receipt(knowledgeJob({
          ...job,
          job_id: input.job_id,
          status: "failed",
          retryable: false,
          reason_code: "KNOWLEDGE_RESULT_INVALID",
          generation: input.generation
        }))
      }),
      knowledge_extractor: { async extract() { throw new Error("extractor unavailable"); } }
    });
    await expect(host.run(hostJob("knowledge_extraction", job.job_id))).resolves.toMatchObject({
      status: "failed", retryable: true, reason_code: "KNOWLEDGE_WORKER_PORT_INVALID"
    });
  });

  it("rejects a knowledge job whose candidate payload fails the shared strict schema", async () => {
    const job = knowledgeJob({
      job_id: "job-invalid-candidate",
      knowledge_candidates: [{ candidate_id: "kc_invalid" }] as unknown as KnowledgeExtractionJob["knowledge_candidates"]
    });
    let extracted = 0;
    const host = createKnowledgePipelineWorkerHost({
      change_projection_worker: changeWorker(async ({ job_id }) => readyChange(job_id)),
      knowledge_pipeline_worker: knowledgeWorker({ startKnowledgeExtraction: async () => job }),
      knowledge_extractor: { async extract() { extracted += 1; return []; } }
    });
    await expect(host.run(hostJob("knowledge_extraction", job.job_id))).resolves.toMatchObject({
      status: "failed", retryable: true, reason_code: "KNOWLEDGE_WORKER_PORT_INVALID"
    });
    expect(extracted).toBe(0);
  });

  it("does not fail a durable job after complete rejects with a domain or storage error", async () => {
    let failCalls = 0;
    const job = knowledgeJob({ job_id: "job-complete-error" });
    const host = createKnowledgePipelineWorkerHost({
      change_projection_worker: changeWorker(async ({ job_id }) => readyChange(job_id)),
      knowledge_pipeline_worker: knowledgeWorker({
        startKnowledgeExtraction: async () => job,
        completeKnowledgeExtraction: async () => {
          throw new KnowledgePipelineError("KNOWLEDGE_PROJECT_GENERATION_STALE", false);
        },
        failKnowledgeExtraction: async () => {
          failCalls += 1;
          return receipt(knowledgeJob({ ...job, status: "failed", retryable: false, reason_code: "KNOWLEDGE_RESULT_INVALID" }));
        }
      }),
      knowledge_extractor: { async extract() { return []; } }
    });
    await expect(host.run(hostJob("knowledge_extraction", job.job_id))).resolves.toMatchObject({
      status: "failed", retryable: false, reason_code: "KNOWLEDGE_PROJECT_GENERATION_STALE"
    });
    expect(failCalls).toBe(0);
  });

  it("maps unknown complete rejection to a stable port error without leaking or failing", async () => {
    let failCalls = 0;
    const job = knowledgeJob({ job_id: "job-unknown-complete" });
    const host = createKnowledgePipelineWorkerHost({
      change_projection_worker: changeWorker(async ({ job_id }) => readyChange(job_id)),
      knowledge_pipeline_worker: knowledgeWorker({
        startKnowledgeExtraction: async () => job,
        completeKnowledgeExtraction: async () => {
          throw new Error("postgres password=secret");
        },
        failKnowledgeExtraction: async () => {
          failCalls += 1;
          return receipt(knowledgeJob({ ...job, status: "failed", retryable: false, reason_code: "KNOWLEDGE_RESULT_INVALID" }));
        }
      }),
      knowledge_extractor: { async extract() { return []; } }
    });
    const result = await host.run(hostJob("knowledge_extraction", job.job_id));
    expect(result).toMatchObject({ status: "failed", retryable: true, reason_code: "KNOWLEDGE_WORKER_PORT_INVALID" });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(failCalls).toBe(0);
  });

  it("fails closed on hostile worker output and does not expose arbitrary reason text", async () => {
    const hostile = {} as Record<string, unknown>;
    Object.defineProperty(hostile, "job_id", { enumerable: true, get: () => { throw new Error("worker secret"); } });
    Object.defineProperty(hostile, "status", { enumerable: true, value: "ready" });
    Object.defineProperty(hostile, "retryable", { enumerable: true, value: false });
    Object.defineProperty(hostile, "output_hash", { enumerable: true, value: hash("output") });
    Object.defineProperty(hostile, "document_count", { enumerable: true, value: 1 });
    const host = createKnowledgePipelineWorkerHost({
      change_projection_worker: { run: () => Promise.resolve(hostile as never) }, knowledge_pipeline_worker: knowledgeWorker()
    });
    const result = await host.run(hostJob("change_projection", "job-change"));
    expect(result).toMatchObject({ status: "failed", retryable: true, reason_code: "CHANGE_PROJECTION_WORKER_OUTPUT_INVALID" });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("rejects accessors, proxies and thenables before invoking a port", async () => {
    let calls = 0;
    const port = { run: () => { calls += 1; return Promise.resolve(readyChange("job")); } };
    const host = createKnowledgePipelineWorkerHost({ change_projection_worker: port, knowledge_pipeline_worker: knowledgeWorker() });
    const accessor = { schema_version: 1, worker_kind: "change_projection", owner_id: "worker-a" } as Record<string, unknown>;
    Object.defineProperty(accessor, "job_id", { enumerable: true, get: () => { throw new Error("executed"); } });
    await expect(host.run(accessor)).rejects
      .toMatchObject({ reason_code: "WORKER_HOST_INPUT_INVALID" });
    const proxy = new Proxy({}, { get() { throw new Error("executed"); } });
    await expect(host.run(proxy)).rejects.toMatchObject({ reason_code: "WORKER_HOST_INPUT_INVALID" });
    const thenable = { then: () => { throw new Error("then executed"); } };
    const thenableHost = createKnowledgePipelineWorkerHost({
      change_projection_worker: { run: () => thenable as never }, knowledge_pipeline_worker: knowledgeWorker()
    });
    await expect(thenableHost.run(hostJob("change_projection", "job-thenable"))).resolves.toMatchObject({
      status: "failed", reason_code: "CHANGE_PROJECTION_WORKER_OUTPUT_INVALID"
    });
    expect(calls).toBe(0);
  });

  it("keeps candidate processing unavailable until an authoritative port is supplied", async () => {
    const host = createKnowledgePipelineWorkerHost({
      change_projection_worker: changeWorker(async ({ job_id }) => readyChange(job_id)), knowledge_pipeline_worker: knowledgeWorker()
    });
    await expect(host.run(hostJob("project_content_candidate", "job-candidate"))).resolves.toMatchObject({
      status: "failed", retryable: true, reason_code: "PROJECT_CONTENT_CANDIDATE_UNAVAILABLE"
    });
  });

  it("uses a dedicated candidate result shape rather than change-document fields", async () => {
    const host = createKnowledgePipelineWorkerHost({
      change_projection_worker: changeWorker(async ({ job_id }) => readyChange(job_id)),
      knowledge_pipeline_worker: knowledgeWorker(),
      project_content_candidate_worker: {
        async run(input) {
          return { schema_version: 1, job_id: input.job_id, status: "ready", retryable: false, candidate_count: 0 };
        }
      }
    });
    await expect(host.run(hostJob("project_content_candidate", "job-candidate-ready"))).resolves.toMatchObject({
      worker_kind: "project_content_candidate", status: "ready", retryable: false, candidate_count: 0
    });
  });

  it("rejects duplicate work and oversized batches before dispatch", async () => {
    const host = createKnowledgePipelineWorkerHost({
      change_projection_worker: changeWorker(async ({ job_id }) => { await new Promise((resolve) => setTimeout(resolve, 10)); return readyChange(job_id); }),
      knowledge_pipeline_worker: knowledgeWorker(), max_batch_size: 1
    });
    await expect(host.dispatch({ schema_version: 1, jobs: [hostJob("change_projection"), hostJob("change_projection", "job-2")] }))
      .rejects.toMatchObject({ reason_code: "WORKER_HOST_BATCH_LIMIT_EXCEEDED" });
    const running = host.run(hostJob("change_projection", "same-job"));
    await expect(host.run(hostJob("change_projection", "same-job"))).resolves.toMatchObject({
      status: "failed", retryable: true, reason_code: "WORKER_HOST_JOB_ALREADY_RUNNING"
    });
    await running;
  });
});
