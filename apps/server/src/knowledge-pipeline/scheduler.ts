import type { JobRepository } from "./ports.js";
import type { KnowledgePipelineWorkerHost, WorkerKind } from "./worker-host/index.js";

export interface KnowledgePipelineScheduler {
  /** 停止后续 tick 并等待在途批次结束（幂等）。 */
  close(): Promise<void>;
}

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_SIZE = 8;

/**
 * 知识队列生产调度器：周期性 dequeue 两个队列（变更投影 + 知识提取），
 * 批量交给 worker host；claim/lease/commit/fail 语义全部在 worker 内部，
 * 调度器只做"发现 + 分派"，不重试、不猜状态（fail closed）。
 */
export function startKnowledgePipelineScheduler(dependencies: {
  host: KnowledgePipelineWorkerHost;
  job_repository: JobRepository;
  owner_id: string;
  interval_ms?: number;
  batch_size?: number;
  on_error?: (error: unknown) => void;
}): KnowledgePipelineScheduler {
  const intervalMs = dependencies.interval_ms ?? DEFAULT_INTERVAL_MS;
  const batchSize = dependencies.batch_size ?? DEFAULT_BATCH_SIZE;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 600_000 ||
      !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 64) {
    throw new Error("KNOWLEDGE_SCHEDULER_CONFIGURATION_INVALID");
  }
  const onError = dependencies.on_error ?? ((error: unknown) => {
    console.error("[knowledge-scheduler] tick failed:", error);
  });

  let closed = false;
  let inFlight: Promise<void> = Promise.resolve();

  async function dequeue(kind: WorkerKind): Promise<Array<{ job_id: string }>> {
    const jobs = kind === "change_projection"
      ? await dependencies.job_repository.listQueuedChangeProjectionJobs(batchSize)
      : await dependencies.job_repository.listQueuedKnowledgeJobs(batchSize);
    return jobs.map((job) => ({ job_id: job.job_id }));
  }

  async function tick(): Promise<void> {
    const jobs = [
      ...(await dequeue("change_projection")).map((job) => ({
        schema_version: 1 as const,
        worker_kind: "change_projection" as const,
        job_id: job.job_id,
        owner_id: dependencies.owner_id
      })),
      ...(await dequeue("knowledge_extraction")).map((job) => ({
        schema_version: 1 as const,
        worker_kind: "knowledge_extraction" as const,
        job_id: job.job_id,
        owner_id: dependencies.owner_id
      }))
    ];
    if (jobs.length === 0) return;
    await dependencies.host.dispatch({ schema_version: 1, jobs });
  }

  function scheduleNext(): void {
    inFlight = inFlight.then(async () => {
      if (closed) return;
      try {
        await tick();
      } catch (error) {
        onError(error);
      }
    });
  }

  const timer = setInterval(scheduleNext, intervalMs);
  timer.unref?.();

  return Object.freeze({
    async close(): Promise<void> {
      closed = true;
      clearInterval(timer);
      await inFlight;
    }
  });
}
