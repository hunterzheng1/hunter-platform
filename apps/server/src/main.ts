import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Pool } from "pg";

import { createServer } from "./app.js";
import { PgAiJobStore } from "./ai/ai-job-store-pg.js";
import { PostgresRegistryPersistence } from "./registry/persistence.js";
import { runMigrations } from "./repositories/migrate.js";
import { PostgresRepository } from "./repositories/postgres.js";
import { PgSemanticStore } from "./semantic/pg-store.js";
import { PgRunStore } from "./runs/pg-store.js";
import { LocalArtifactStorage } from "./storage/local.js";
import { decodeNpmCredentialEncryptionKey } from "./npm/credentials.js";
import { createProductionPlatformInformationFromEnvironment } from "./platform-information/production.js";
import { createPgKnowledgeQueryHttpService } from "./knowledge-query-http/index.js";
import { createRemoteContentUploadLocalCas, createPgRemoteContentUploadHttpService } from "./remote-content-upload-pg/index.js";
import { createRemoteContentUploadResolver } from "./remote-content-upload-pg/resolver.js";
import { createBranchSnapshotProducer } from "./branch-snapshots/producer.js";
import { createPgRemoteSyncCommitPort, createPgRemoteSyncHttpService } from "./remote-sync-pg/index.js";
import { createPgKnowledgePipelinePorts } from "./knowledge-pipeline/pg.js";
import {
  createKnowledgePipeline,
  createKnowledgeExtractor,
  createKnowledgePipelineWorkerHost,
  startKnowledgePipelineScheduler,
  memoryArchiveValidationEvidence
} from "./knowledge-pipeline/index.js";
import {
  createArchivePackageVerifier,
  createChangeProjectionWorker
} from "./change-projection-worker/index.js";
import type { KnowledgeCommitPort } from "./knowledge-pipeline/ports.js";
import {
  ingestPipelineKnowledge,
  readChangeSummaryDocument
} from "./knowledge-bridge/index.js";
import {
  knowledgeContentHash,
  prepareKnowledgeIngestPayload,
  projectPendingKnowledge
} from "./semantic/knowledge-projection.js";

async function secret(name: string, required: boolean): Promise<string | undefined> {
  const value = process.env[name];
  if (value !== undefined && value.trim() !== "") {
    return value.trim();
  }
  const file = process.env[name + "_FILE"];
  if (file !== undefined && file.trim() !== "") {
    const fileValue = (await readFile(file, "utf8")).trim();
    if (fileValue !== "") return fileValue;
  }
  if (required) {
    throw new Error(name + " is required");
  }
  return undefined;
}

const databaseUrl = await secret("DATABASE_URL", true);
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
const artifactRoot = process.env.ARTIFACT_ROOT ?? "/var/lib/hunter-harness/artifacts";
const pool = new Pool({
  connectionString: databaseUrl,
  ...(process.env.DATABASE_SSL === "require"
    ? { ssl: { rejectUnauthorized: true } }
    : {})
});
await runMigrations(
  pool,
  fileURLToPath(new URL("../migrations", import.meta.url))
);
const repository = new PostgresRepository(pool);
const bootstrapManifest = JSON.parse(
  await readFile(fileURLToPath(new URL("../../../resources/manifest.json", import.meta.url)), "utf8")
) as { registry_version: string; compiler_version: string };
// 新模型：bootstrap skills 从 resources/skills/<name>/ 加载（任务 18 转换后）；
// 此处暂只读 manifest（registry_version/compiler_version），skills 留空，等 resources/skills/ 就绪后扩展。
const bootstrapBundle = {
  registryVersion: bootstrapManifest.registry_version,
  compilerVersion: bootstrapManifest.compiler_version,
  skills: []
};
const bootstrapToken = await secret("HUNTER_HARNESS_BOOTSTRAP_TOKEN", false);
const credentialKeyValue = await secret("HUNTER_HARNESS_CREDENTIAL_KEY", false);
const npmCredentialEncryptionKey = credentialKeyValue === undefined
  ? null
  : decodeNpmCredentialEncryptionKey(credentialKeyValue);
const runStore = new PgRunStore(pool);
const knowledgeQuery = createPgKnowledgeQueryHttpService(pool);
const remoteContentUploadCas = await createRemoteContentUploadLocalCas({
  root: process.env.HUNTER_REMOTE_CONTENT_UPLOAD_ROOT ?? `${artifactRoot}/remote-content-uploads`,
});
const remoteContentUpload = createPgRemoteContentUploadHttpService({ pool, cas: remoteContentUploadCas });
const remoteContentUploadResolver = createRemoteContentUploadResolver({ pool, cas: remoteContentUploadCas });
const remoteSyncCommitPort = createPgRemoteSyncCommitPort({ pool });
const branchSnapshotProducer = createBranchSnapshotProducer({ commit_port: remoteSyncCommitPort });
const remoteSync = createPgRemoteSyncHttpService({
  pool,
  workspaceRoot: join(artifactRoot, "remote-sync-workspaces"),
  branchSnapshotProducer,
  resolveUpload: remoteContentUploadResolver.resolve,
});
const platformInformation = await createProductionPlatformInformationFromEnvironment({
  pool,
  runStore,
  platformInformationExportRoot: process.env.HUNTER_PLATFORM_INFORMATION_EXPORT_ROOT
    ?? `${artifactRoot}/platform-information-exports`,
});

// 06A 知识队列生产链路：pg 端口 + 管线 + 双 worker + 调度器。
// 生产者入队在归档上传路由（app.ts）；调度器只发现与分派，lease/ack 在 worker 内部。
const knowledgePipelineClock = (): string => new Date().toISOString();
const knowledgePipelinePorts = createPgKnowledgePipelinePorts(pool);
// 入库桥：提取结果落库后，把它们投影成知识条目写入 knowledge_ingest_entries，
// 再排空一次语义投影。此前 knowledge_pipeline_results 没有任何消费方，
// 所以管道即便产出结果，project_knowledge 与 knowledge query 也永远是空的。
// 装饰 commit 端口而不是改管道模块：桥失败不回滚已提交的结果，只告警。
const semanticStore = new PgSemanticStore(pool);

// 收据诚实化（2026-08-30 P0-1）：归档上传 finalize 只能把 knowledgeStatus 置为
// indexing（知识条目由异步 extraction job 产出），job commit/fail 时在这里翻转
// 归档记录的 knowledgeStatus，调用方不再拿到「知识已就绪」的空头收据。
async function flipArchiveKnowledgeStatus(
  projectId: string,
  changeKey: string,
  status: "ready" | "failed",
  lastErrorCode: string | null
): Promise<void> {
  try {
    const owner = await pool.query<{ owner_actor_id: string }>(
      "SELECT owner_actor_id FROM projects WHERE project_id = $1",
      [projectId]
    );
    const ownerId = owner.rows[0]?.owner_actor_id;
    if (ownerId === undefined) return;
    const record = await repository.getChangeArchivePackage(ownerId, projectId, changeKey);
    if (record.knowledgeStatus === "ready" && status === "ready") return;
    await repository.updateChangeArchivePackage({
      actorId: ownerId,
      projectId,
      changeKey,
      artifactId: record.artifactId,
      knowledgeStatus: status,
      failureStage: status === "failed" ? record.failureStage : null,
      lastErrorCode
    });
  } catch (error) {
    console.error("[knowledge-bridge] archive knowledgeStatus flip failed:", error);
  }
}

const knowledgeCommitWithIngest: KnowledgeCommitPort = {
  async commitKnowledgeResults(input) {
    const job = await knowledgePipelinePorts.knowledge_commit.commitKnowledgeResults(input);
    // commit 成功即查询面（knowledge_pipeline_results）就绪——先翻转收据，
    // 桥接投影失败不影响查询可用性
    await flipArchiveKnowledgeStatus(job.project_id, job.change_key, "ready", null);
    try {
      const summary = await readChangeSummaryDocument(pool, job.project_id, job.change_key);
      const outcome = await ingestPipelineKnowledge({
        repository,
        results: input.results,
        summary,
        contentHash: knowledgeContentHash,
        preparePayload: prepareKnowledgeIngestPayload
      });
      if (outcome.created + outcome.updated > 0) {
        await projectPendingKnowledge(repository, semanticStore, job.project_id);
      }
      if (outcome.skipped > 0) {
        console.warn("[knowledge-bridge] skipped %d unprojectable result(s) for %s",
          outcome.skipped, job.change_key);
      }
    } catch (error) {
      console.error("[knowledge-bridge] ingest failed after commit:", error);
    }
    return job;
  }
};
const knowledgePipeline = createKnowledgePipeline({
  archive_store: knowledgePipelinePorts.archive_store,
  archive_validation: memoryArchiveValidationEvidence,
  job_repository: knowledgePipelinePorts.job_repository,
  knowledge_index: knowledgePipelinePorts.knowledge_index,
  knowledge_commit: knowledgeCommitWithIngest,
  clock: knowledgePipelineClock
});
const changeProjectionWorker = createChangeProjectionWorker({
  task_port: knowledgePipelinePorts.job_repository,
  archive_store: knowledgePipelinePorts.archive_store,
  commit_port: knowledgePipelinePorts.change_projection_commit,
  archive_verifier: createArchivePackageVerifier(),
  verification_limits: {
    max_package_bytes: 50 * 1024 * 1024,
    max_file_count: 101,
    max_file_bytes: 10 * 1024 * 1024,
    max_uncompressed_bytes: 50 * 1024 * 1024,
    max_compression_ratio: 100
  },
  clock: knowledgePipelineClock,
  lease_duration_ms: 60_000
});
// fail 桥：知识 job 终态失败时同步翻转归档收据，不让 indexing 永远挂起
const knowledgeWorkerWithStatusBridge = {
  ...knowledgePipeline.worker,
  async failKnowledgeExtraction(input: { job_id: string; generation: number; reason_code: string; retryable: boolean }) {
    const job = await knowledgePipeline.worker.failKnowledgeExtraction(input);
    if (job.status === "failed") {
      await flipArchiveKnowledgeStatus(
        job.project_id, job.change_key, "failed", input.reason_code
      );
    }
    return job;
  }
};
const knowledgeWorkerHost = createKnowledgePipelineWorkerHost({
  change_projection_worker: changeProjectionWorker,
  knowledge_pipeline_worker: knowledgeWorkerWithStatusBridge,
  knowledge_extractor: createKnowledgeExtractor({ archive_store: knowledgePipelinePorts.archive_store })
});
if (bootstrapToken !== undefined && bootstrapToken !== "") {
  await repository.createActorWithToken({
    actorId: process.env.HUNTER_HARNESS_BOOTSTRAP_ACTOR ?? "actor_owner",
    displayName: process.env.HUNTER_HARNESS_BOOTSTRAP_NAME ?? "Owner",
    label: "environment-bootstrap",
    token: bootstrapToken
  });
}

const app = await createServer({
  repository,
  storage: new LocalArtifactStorage(artifactRoot),
  bootstrapBundle,
  registryPersistence: new PostgresRegistryPersistence(pool),
  aiJobStore: new PgAiJobStore(pool),
  semanticStore: new PgSemanticStore(pool),
  runStore,
  knowledgeQuery,
  remoteContentUpload,
  remoteSync,
  branchSnapshotProducer,
  platformInformation,
  knowledgePipeline,
  npmCredentialEncryptionKey,
  projectKeyEncryptionKey: npmCredentialEncryptionKey,
  logger: true
});

const knowledgeScheduler = startKnowledgePipelineScheduler({
  host: knowledgeWorkerHost,
  job_repository: knowledgePipelinePorts.job_repository,
  owner_id: `knowledge-scheduler:${randomUUID()}`,
  on_error: (error) => { app.log.error({ error }, "knowledge pipeline scheduler tick failed"); }
});

// Keep private upload attempts and unreferenced CAS objects bounded in the
// production process. The service owns the DB/CAS fences; this loop only
// discovers project scopes and supplies one non-overlapping worker.
let maintenanceBusy = false;
let maintenancePromise: Promise<void> | null = null;
const maintenanceWorkerId = `remote-content-upload-worker:${randomUUID()}`;
const runRemoteContentUploadMaintenance = async (): Promise<void> => {
  if (maintenanceBusy) return;
  maintenanceBusy = true;
  try {
    const now = new Date();
    const nowIso = now.toISOString();
    await remoteContentUpload.cleanupStaleAttempts();
    const projects = await pool.query<{ project_id: string }>(
      `SELECT project_id FROM (
         SELECT project_id FROM remote_content_uploads
         UNION
         SELECT project_id FROM remote_content_upload_cas_objects
       ) projects ORDER BY project_id LIMIT 256`
    );
    for (const row of projects.rows) {
      const batch = await remoteContentUpload.claimGarbage({
        project_id: row.project_id,
        now: nowIso,
        limit: 128,
        worker_id: maintenanceWorkerId,
        lease_until: new Date(now.getTime() + 60_000).toISOString(),
      });
      await remoteContentUpload.acknowledgeGarbage({
        project_id: row.project_id,
        batch_id: batch.batch_id,
        worker_id: maintenanceWorkerId,
        now: nowIso,
      });
    }
  } catch (error) {
    app.log.error({ error }, "remote content upload maintenance failed");
  } finally {
    maintenanceBusy = false;
  }
};
const scheduleRemoteContentUploadMaintenance = (): void => {
  if (maintenancePromise !== null) return;
  maintenancePromise = runRemoteContentUploadMaintenance().finally(() => {
    maintenancePromise = null;
  });
};
const maintenanceTimer = setInterval(scheduleRemoteContentUploadMaintenance, 60_000);
maintenanceTimer.unref?.();
scheduleRemoteContentUploadMaintenance();
const port = Number(process.env.PORT ?? "3001");
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}
await app.listen({
  host: process.env.HOST ?? "0.0.0.0",
  port
});

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting down");
  clearInterval(maintenanceTimer);
  await maintenancePromise?.catch((error) => app.log.error({ error }, "remote content upload maintenance shutdown failed"));
  await knowledgeScheduler.close();
  await app.close();
  await remoteContentUpload.close();
  await remoteSync.close();
  await pool.end();
}
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
