import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";

import type { Pool } from "pg";
import {
  canonicalJson,
  type KnowledgeExtractionRetryIntentHashPort,
  type PlatformInformationExportHashPort,
  type PlatformInformationPage,
  type PlatformInformationQuery,
} from "@hunter-harness/contracts";

import { PgBranchSnapshotPort } from "../branch-snapshots/pg.js";
import { createBranchSnapshotModule } from "../branch-snapshots/module.js";
import { createBranchVersionQueryAdapter } from "../branch-version-query/index.js";
import {
  ProjectMaterialsCursorAuthority,
  PgProjectMaterialsSource,
  createProjectMaterialsQueryAdapter
} from "../project-materials/index.js";
import {
  createProjectKnowledgeQueryAdapter,
  PgProjectKnowledgeRetryAuthority,
  PgProjectKnowledgeSource,
  ProjectKnowledgeCursorAuthority
} from "../project-knowledge-query/index.js";
import {
  createLocalPlatformInformationExportArtifactPort,
  createPlatformInformationExportModule,
  PgPlatformInformationExportRecordPort,
  type PlatformInformationExportPageSourcePort,
} from "../platform-information-export/index.js";
import type { PlatformInformationAdapters } from "./routes.js";

export interface ProductionPlatformInformationOptions {
  /** The shared production pool used by branch snapshots and materials. */
  readonly pool?: Pool;
  /** The independent signing secret for project-materials cursors. */
  readonly projectMaterialsCursorSecret?: string;
  /** The independent signing secret for project-knowledge cursors. */
  readonly projectKnowledgeCursorSecret?: string;
}

export interface ProductionPlatformInformationEnvironmentOptions {
  readonly pool?: Pool;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly readSecretFile?: (path: string) => Promise<string>;
  /** Root for the durable export CAS. When absent, export HTTP remains unavailable. */
  readonly platformInformationExportRoot?: string;
  readonly platformInformationExportLifetimeMs?: number;
}

function nodeHashPort(): PlatformInformationExportHashPort {
  return {
    sha256(bytes) {
      return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    },
    create_sha256() {
      const hash = createHash("sha256");
      return {
        update(chunk: Uint8Array) { hash.update(chunk); },
        digest() { return `sha256:${hash.digest("hex")}`; },
      };
    },
  };
}

function nodeKnowledgeRetryHashPort(): KnowledgeExtractionRetryIntentHashPort {
  return {
    sha256(serialized) {
      return `sha256:${createHash("sha256").update(serialized, "utf8").digest("hex")}`;
    }
  };
}

function exportPageSource(adapters: PlatformInformationAdapters): PlatformInformationExportPageSourcePort {
  return {
    async read_page(query: PlatformInformationQuery): Promise<string> {
      let result;
      if (query.view === "project_materials") {
        const adapter = adapters.projectMaterials;
        if (adapter === undefined) throw new Error("PLATFORM_INFORMATION_EXPORT_SOURCE_UNAVAILABLE");
        result = await adapter.query(JSON.stringify(query));
      } else {
        throw new Error("PLATFORM_INFORMATION_EXPORT_SOURCE_UNAVAILABLE");
      }
      if (!result.ok) throw new Error(result.reason_code);
      const page = result.value as PlatformInformationPage;
      const itemsSha = `sha256:${createHash("sha256").update(canonicalJson(page.items)).digest("hex")}`;
      const proofPayload = {
        schema_version: 1,
        source_kind: "platform_information_export_page" as const,
        request: query,
        page,
        items_sha: itemsSha,
      };
      const proofSha = `sha256:${createHash("sha256").update(canonicalJson(proofPayload)).digest("hex")}`;
      return canonicalJson({ ...proofPayload, proof_sha: proofSha });
    },
  };
}

/**
 * Composes only Platform Information views backed by complete production
 * dependencies. Views without a durable source remain absent so their routes
 * fail closed with PLATFORM_INFORMATION_UNAVAILABLE.
 */
export function createProductionPlatformInformation(
  options: ProductionPlatformInformationOptions
): PlatformInformationAdapters {
  // 分支文件 / 版本记录视图：依赖 branch snapshot 存储（Pg），无独立游标密钥
  // （PgBranchSnapshotPort 自带持久化 cursor verifier），pool 存在即可组合。
  let branchVersion: PlatformInformationAdapters["branchVersion"];
  if (options.pool !== undefined) {
    const snapshotPort = new PgBranchSnapshotPort(options.pool);
    const snapshotModule = createBranchSnapshotModule({
      repository_port: snapshotPort,
      blob_read_port: snapshotPort,
      cursor_verifier_port: snapshotPort,
      // 服务端无法感知本机工作区状态，恢复冲突检测诚实返回空集（与集成测试一致）。
      restore_conflict_port: {
        async listConflicts(input) {
          return { actor_id: input.actor_id, identity: input.identity, conflicts: [] };
        }
      }
    });
    branchVersion = createBranchVersionQueryAdapter(snapshotModule);
  }

  let projectMaterials: PlatformInformationAdapters["projectMaterials"];
  if (options.projectMaterialsCursorSecret !== undefined) {
    if (options.pool === undefined) {
      throw new Error("PROJECT_MATERIALS_PRODUCTION_DEPENDENCY_MISSING");
    }
    const cursorAuthority = new ProjectMaterialsCursorAuthority(
      Buffer.from(options.projectMaterialsCursorSecret, "utf8")
    );
    const snapshotPort = new PgBranchSnapshotPort(options.pool);
    const source = new PgProjectMaterialsSource({
      pool: options.pool,
      blob_reader: snapshotPort,
      cursor_authority: cursorAuthority
    });
    projectMaterials = createProjectMaterialsQueryAdapter({
      source,
      cursor_verifier: cursorAuthority
    });
  }

  let projectKnowledge: PlatformInformationAdapters["projectKnowledge"];
  if (options.projectKnowledgeCursorSecret !== undefined) {
    if (options.pool === undefined) {
      throw new Error("PROJECT_KNOWLEDGE_PRODUCTION_DEPENDENCY_MISSING");
    }
    const cursorAuthority = new ProjectKnowledgeCursorAuthority(
      Buffer.from(options.projectKnowledgeCursorSecret, "utf8")
    );
    const source = new PgProjectKnowledgeSource({
      pool: options.pool,
      cursor_authority: cursorAuthority
    });
    const retryAuthority = new PgProjectKnowledgeRetryAuthority(options.pool);
    projectKnowledge = createProjectKnowledgeQueryAdapter({
      source_port: source,
      cursor_verifier: cursorAuthority,
      retry_intent_hash_port: nodeKnowledgeRetryHashPort(),
      retry_authority_port: retryAuthority
    });
  }

  return Object.freeze({
    ...(branchVersion === undefined ? {} : { branchVersion }),
    ...(projectMaterials === undefined ? {} : { projectMaterials }),
    ...(projectKnowledge === undefined ? {} : { projectKnowledge })
  });
}

/**
 * 进程内临时游标密钥（按 env 名缓存，保证同一进程内多次组合共享同一密钥，
 * 游标在进程生命周期内可验签；进程重启后旧游标自然失效——对本机/单实例部署无害）。
 */
const ephemeralCursorSecrets = new Map<string, string>();

/**
 * 解析视图的游标签名密钥：环境变量 → *_FILE → 临时兜底。
 * 兜底仅在 pg pool 可用时启用（没有数据源时维持原有 fail-closed 行为，页面诚实返回 503）。
 */
async function resolveCursorSecret(params: {
  environment: Readonly<Record<string, string | undefined>>;
  envName: string;
  readSecretFile: (path: string) => Promise<string>;
  poolAvailable: boolean;
}): Promise<string | undefined> {
  const { environment, envName, readSecretFile, poolAvailable } = params;
  const direct = environment[envName]?.trim();
  if (direct !== undefined && direct !== "") return direct;

  const secretFile = environment[`${envName}_FILE`]?.trim();
  if (secretFile !== undefined && secretFile !== "") {
    const fileValue = (await readSecretFile(secretFile)).trim();
    if (fileValue === "") {
      throw new Error(`${envName}_FILE is empty`);
    }
    return fileValue;
  }

  if (!poolAvailable) return undefined;
  let ephemeral = ephemeralCursorSecrets.get(envName);
  if (ephemeral === undefined) {
    // 24 字节随机数 base64url 编码后恰为 32 字符（满足 SECRET_BYTES=32），
    // 64 符号字母表保证 ≥16 个不重复字节（MIN_SECRET_DISTINCT_BYTES）。
    ephemeral = randomBytes(24).toString("base64url");
    ephemeralCursorSecrets.set(envName, ephemeral);
    console.warn(
      `[platform-information] ${envName} 未配置，已生成进程内临时游标密钥；` +
      "多实例生产部署请通过环境变量或 *_FILE 显式配置共享密钥。"
    );
  }
  return ephemeral;
}

export async function createProductionPlatformInformationFromEnvironment(
  options: ProductionPlatformInformationEnvironmentOptions
): Promise<PlatformInformationAdapters> {
  const environment = options.environment ?? process.env;
  const readSecretFile = options.readSecretFile ?? (
    async (path: string): Promise<string> => await readFile(path, "utf8")
  );

  const [projectMaterialsCursorSecret, projectKnowledgeCursorSecret] =
    await Promise.all([
      resolveCursorSecret({
        environment,
        envName: "HUNTER_PROJECT_MATERIALS_CURSOR_SECRET",
        readSecretFile,
        poolAvailable: options.pool !== undefined
      }),
      resolveCursorSecret({
        environment,
        envName: "HUNTER_PROJECT_KNOWLEDGE_CURSOR_SECRET",
        readSecretFile,
        poolAvailable: options.pool !== undefined
      })
    ]);

  const base = createProductionPlatformInformation({
    ...(options.pool === undefined ? {} : { pool: options.pool }),
    ...(projectMaterialsCursorSecret === undefined ? {} : { projectMaterialsCursorSecret }),
    ...(projectKnowledgeCursorSecret === undefined ? {} : { projectKnowledgeCursorSecret })
  });
  if (options.platformInformationExportRoot === undefined) return base;
  if (options.pool === undefined) throw new Error("PLATFORM_INFORMATION_EXPORT_PRODUCTION_DEPENDENCY_MISSING");
  const singleton = await options.pool.connect();
  const locked = await singleton.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock($1,$2) AS locked", [0x48554e54, 0x45585054],
  );
  if (locked.rows[0]?.locked !== true) {
    singleton.release();
    throw new Error("PLATFORM_INFORMATION_EXPORT_SINGLE_INSTANCE_REQUIRED");
  }
  let artifactPort: Awaited<ReturnType<typeof createLocalPlatformInformationExportArtifactPort>>;
  try {
    artifactPort = await createLocalPlatformInformationExportArtifactPort({
      root: options.platformInformationExportRoot,
      ...(options.platformInformationExportLifetimeMs === undefined ? {} : {
        lifetime_ms: options.platformInformationExportLifetimeMs,
      }),
    });
  } catch (error) {
    await singleton.query("SELECT pg_advisory_unlock($1,$2)", [0x48554e54, 0x45585054]).catch(() => undefined);
    singleton.release();
    throw error;
  }
  const exportModule = createPlatformInformationExportModule({
    page_source: exportPageSource(base),
    artifact_port: artifactPort,
    hash_port: nodeHashPort(),
  });
  const exportRecords = new PgPlatformInformationExportRecordPort(options.pool);
  const gcWorkerId = `worker_export_gc_${process.pid}`;
  let gcRunning = false;
  let gcSettlement: Promise<void> = Promise.resolve();
  const collectExpired = async (): Promise<void> => {
    if (gcRunning) return;
    gcRunning = true;
    try {
      let cursor: string | null = null;
      do {
        const now = new Date();
        const claimed = await exportRecords.claimExpired({
          now: now.toISOString(), limit: 100, cursor, worker_id: gcWorkerId,
          lease_until: new Date(now.getTime() + 60_000).toISOString(),
        });
        if (claimed.status === "empty") break;
        const ack = await exportRecords.ackExpired({ batch_id: claimed.batch_id, worker_id: gcWorkerId });
        if (ack.status !== "acked" && ack.status !== "already_acked") break;
        cursor = claimed.next_cursor;
      } while (cursor !== null);
    } finally {
      gcRunning = false;
    }
  };
  const gcTimer = setInterval(() => {
    gcSettlement = collectExpired().catch(() => undefined);
  }, 60_000);
  gcTimer.unref();
  let closePromise: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closePromise !== null) return closePromise;
    clearInterval(gcTimer);
    closePromise = (async () => {
      try {
        await gcSettlement;
        await artifactPort.close();
      } finally {
        await singleton.query("SELECT pg_advisory_unlock($1,$2)",
          [0x48554e54, 0x45585054]).catch(() => undefined);
        singleton.release();
      }
    })();
    return closePromise;
  };
  return Object.freeze({
    ...base,
    export_module: exportModule,
    export_records: exportRecords,
    export_download: artifactPort,
    export_close: close,
  });
}
