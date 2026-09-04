import { Buffer } from "node:buffer";

import {
  agentToolMutationSchema,
  generateAgentToolPrefillRequestSchema,
  inspectAgentToolGithubRequestSchema,
  aiProviderReorderRequestSchema,
  canonicalJson,
  fileOperationSchema,
  finalizeProposalSchema,
  knowledgeIngestEntrySchema,
  providerModelSchema,
  publishSkillRequestSchema,
  publishUnifiedSkillRequestSchema,
  publishWorkflowFamilyRequestSchema,
  importWorkflowFamilySourceRequestSchema,
  inspectWorkflowFamilySourceRequestSchema,
  registryAgentSchema,
  registrySlugSchema,
  sensitiveReviewSubmissionSchema,
  skillTargetAgentSchema,
  updateSkillCatalogOrderRequestSchema,
  setDefaultAgentRequestSchema,
  workflowFamilyMutationSchema,
  bindProjectWorkflowFamilyRequestSchema,
  createExternalSkillRequestSchema,
  generateExternalSkillSummaryRequestSchema,
  refreshExternalSkillUpdateHistoryRequestSchema,
  patchExternalSkillRequestSchema,
  SKILL_ERROR_CODE,
  type AiProviderConfig,
  type CodexConnectionState,
  type ExternalSkill,
  type RegistryAgent,
  type FileOperation,
  type FixPlanItem,
  type SourceFile
} from "@hunter-harness/contracts";
import {
  buildAiCheckPrompt,
  buildAgentToolPrefillPrompt,
  buildExternalSkillSummaryRepairPrompt,
  buildExternalSkillSummaryPrompt,
  buildExternalSkillUpdateSummaryPrompt,
  buildReleaseNotePrompt,
  classifyFile,
  decidePush,
  findEntryFile,
  externalSkillSummarySourceHash,
  parseAiCheckResult,
  parseAgentToolPrefill,
  parseExternalSkillSummary,
  parseExternalSkillUpdateSummary,
  parseFrontmatter,
  parseReleaseNote,
  sha256Bytes,
  uuidV7,
  type FindingOverride,
  type LlmClient
} from "@hunter-harness/core";
import type { BootstrapBundle } from "./registry/store.js";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from "fastify";
import { z, ZodError } from "zod";
import multipart from "@fastify/multipart";
import AdmZip from "adm-zip";

import { MemoryAiJobStore, type AiJobStore } from "./ai/ai-job-store.js";
import {
  validateArchivePackage,
  validateCoreV1ArchivePackage,
  type KnowledgePipeline
} from "./knowledge-pipeline/index.js";

/** 06A 队列管线的版本标识（服务端侧提取管线；与 CLI 侧提取器版本独立演进）。
 *
 * v2：提取器在包不含 candidates/knowledge.json 时改为从归档自带的
 * summary-data.json 派生候选。提升版本号会改变 enqueueKnowledgeExtraction 的
 * 幂等键，从而让已入库的归档重新排队提取——这正是 0.2.86 之前上传的那批包
 * （包里没有候选文件，且同 change key 只保存一个不可变包、客户端无法补传）
 * 唯一能拿到知识条目的途径。 */
const KNOWLEDGE_PIPELINE_EXTRACTOR_VERSION = "server-extractor-v2";
const KNOWLEDGE_PIPELINE_PROMPT_VERSION = "server-prompt-v1";
const KNOWLEDGE_PIPELINE_INDEX_SCHEMA_VERSION = "server-knowledge-index-v1";

/**
 * Knowledge Pipeline receipts use their own correlation-id namespace.  HTTP
 * request ids are intentionally excluded: they change on transport retries and
 * are neither archive identity nor job idempotency.  Both archive HTTP adapters
 * derive the same bounded internal id from immutable server-validated facts.
 */
function knowledgeArchiveRequestId(input: {
  project_id: string;
  change_key: string;
  archive_id: string;
  package_sha256: string;
}): string {
  const hash = sha256Bytes(Buffer.from(canonicalJson(input), "utf8"));
  return `archive_request:${hash.slice("sha256:".length)}`;
}

/**
 * 两种归档包形态并存：生产归档器（harness_archive.py）产出 core-v1，
 * 其身份由路由绑定给出；v2 包自带服务端 id，沿用原校验器并保留身份交叉核对。
 * 按 manifest 自称的 schema_version 分派——猜错形态只会 fail closed，不会误判身份。
 */
function validateArchivePackageByProfile(input: {
  packageBytes: Uint8Array;
  manifestBytes: Uint8Array;
  identity: { project_id: string; change_key: string; archive_id: string; project_version: string };
  limits: Parameters<typeof validateArchivePackage>[0]["limits"];
  validatedAt: string;
}) {
  let declaredVersion: unknown;
  try {
    declaredVersion = (JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(input.manifestBytes)
    ) as { schema_version?: unknown }).schema_version;
  } catch {
    declaredVersion = undefined;
  }
  if (declaredVersion === 1) {
    return validateCoreV1ArchivePackage({
      package_bytes: input.packageBytes,
      manifest_bytes: input.manifestBytes,
      identity: input.identity,
      limits: input.limits,
      validated_at: input.validatedAt
    });
  }
  const validated = validateArchivePackage({
    package_bytes: input.packageBytes,
    manifest_bytes: input.manifestBytes,
    limits: input.limits,
    validated_at: input.validatedAt
  });
  if (validated.project_id !== input.identity.project_id ||
      validated.change_key !== input.identity.change_key) {
    return null;
  }
  return validated;
}
import { CodexAppServerService, type CodexAiService } from "./ai/codex-app-server.js";
import { createLlmClient } from "./ai/llm-factory.js";
import { loadAiSecret, writeAiSecret } from "./ai/secret-loader.js";
import { writeAudit } from "./audit/audit.js";
import {
  generateProjectApiKey,
  projectApiKeyHash
} from "./auth/accounts.js";
import { registerAuthRoutes, requireSessionUser } from "./auth/routes.js";
import {
  assertProjectKeyScope,
  authenticateRequest,
  requestProjectKey
} from "./auth/tokens.js";
import {
  archiveRootPrefix,
  buildChangeArchive,
  resolveArchiveContentPath,
  validateArchiveChangeKey
} from "./archive/change-archive.js";
import {
  archivePackageReceipt,
  ingestArchivePackage,
  validateArchivePackage as validateIngestArchivePackage,
  loadSemanticSnapshotFiles,
  rebuildStableSemanticSnapshot
} from "./archive/package-ingest.js";
import { defaultServerConfig, type ServerConfig } from "./config.js";
import { buildDashboardOverview } from "./dashboard/overview.js";
import { isNpmPublishConfigured, loadNpmPublishConfig } from "./npm/config.js";
import {
  createNpmPublishingCredentials,
  FetchNpmCredentialVerifier,
  NpmCredentialError,
  type NpmCredentialPersistence
} from "./npm/credentials.js";
import {
  publishSkillNpmPackage,
  publishWorkflowFamilyNpmPackage,
  type NpmPublisherDeps
} from "./npm/publisher.js";
import { RegistryStore } from "./registry/store.js";
import type { RegistryPersistence } from "./registry/persistence.js";
import type {
  Actor,
  IdempotencyRecord,
  ProjectKeyScope,
  ProjectRecord,
  ServerRepository,
  TransactionRepository
} from "./repositories/interfaces.js";
import { PROJECT_KEY_SCOPES, ServerDomainError } from "./repositories/interfaces.js";
import type { ArtifactStorage } from "./storage/interface.js";
import { buildSemanticIndex } from "./semantic/indexer.js";
import {
  knowledgeContentHash,
  prepareKnowledgeIngestPayload,
  projectPendingKnowledge
} from "./semantic/knowledge-projection.js";
import { MemoryRunStore } from "./runs/memory-store.js";
import { createRunStoreBranchMonitorSource } from "./runs/branch-monitor-source.js";
import type { BranchMonitorCursorPort } from "./runs/branch-monitor-cursor.js";
import {
  createStage12MonitorVerifierAdapter,
  type PlanQualityEventBundleReaderPort
} from "./runs/stage12-monitor-verifier.js";
import { registerRunRoutes } from "./runs/routes.js";
import type { RunStore } from "./runs/store.js";
import {
  createBranchMonitorQueryAdapter,
} from "./branch-monitor-query/index.js";
import {
  registerPlatformInformationRoutes,
  type PlatformInformationAdapters
} from "./platform-information/routes.js";
import {
  registerRemoteSyncHttpRoutes,
  type RemoteSyncHttpServicePort
} from "./remote-sync-http/index.js";
import {
  registerKnowledgeQueryHttpRoutes,
  type KnowledgeQueryHttpServicePort
} from "./knowledge-query-http/index.js";
import { registerRemoteContentUploadHttpRoutes, type RemoteContentUploadHttpServicePort } from "./remote-content-upload-http/index.js";
import type { BranchSnapshotProducer } from "./branch-snapshots/producer.js";
import { SemanticMemoryStore } from "./semantic/memory-store.js";
import {
  SEMANTIC_INDEX_SCHEMA_VERSION,
  type SemanticStore
} from "./semantic/store.js";
import { registerSemanticMcpRoutes } from "./mcp/register.js";
import { randomUUID } from "node:crypto";
import {
  buildInstructionProposal,
  instructionProposalRequestSchema,
  loadServerRecentChanges,
  mergeRecentChanges
} from "./instructions/proposal.js";

export interface CreateServerOptions {
  repository: ServerRepository;
  storage: ArtifactStorage;
  config?: Partial<ServerConfig>;
  logger?: boolean;
  bootstrapBundle?: BootstrapBundle;
  registryPersistence?: RegistryPersistence;
  semanticStore?: SemanticStore;
  runStore?: RunStore;
  /** Stage 13 read-only query adapters. Routes fail closed with 503 when absent. */
  platformInformation?: PlatformInformationAdapters;
  /** Remote Sync HTTP service. Absent deployments fail closed with 503. */
  remoteSync?: RemoteSyncHttpServicePort;
  /** Stage 09 remote knowledge service. Absent deployments fail closed with 503. */
  knowledgeQuery?: KnowledgeQueryHttpServicePort;
  /** Bounded raw archive upload seam. Production main injects it; absent deployments fail closed with 503. */
  remoteContentUpload?: RemoteContentUploadHttpServicePort;
  /** Transaction-bound Remote Sync → Branch Snapshot producer. */
  branchSnapshotProducer?: BranchSnapshotProducer;
  /** 06A knowledge queue pipeline. 归档上传成功后事务入队（best-effort，失败仅告警不阻塞上传）。 */
  knowledgePipeline?: KnowledgePipeline;
  /** Required trust dependencies for Stage 13 branch-monitor reads. Absent means explicit 503. */
  branchMonitorTrust?: {
    readonly eventBundleReader: PlanQualityEventBundleReaderPort;
    readonly cursorPort: BranchMonitorCursorPort;
  };
  // AiJobStore ???PG ??? PgAiJobStore ????? + ?? recoverOrphans??? MemoryAiJobStore ??? fallback?
  aiJobStore?: AiJobStore;
  // AI LlmClient ????? createLlmClient ?? DeepSeek?????? mock?
  aiLlmClientFactory?: (provider: AiProviderConfig, apiKey: string) => LlmClient | null;
  /** Codex 独立 ChatGPT 账号连接；测试可注入内存实现。 */
  codexService?: CodexAiService;
  npmPublisherDeps?: NpmPublisherDeps;
  npmPublishConfig?: ReturnType<typeof loadNpmPublishConfig>;
  npmCredentialPersistence?: NpmCredentialPersistence;
  npmCredentialEncryptionKey?: Uint8Array | null;
  projectKeyEncryptionKey?: Uint8Array | null;
  npmCredentialVerifier?: (token: string, scope: string) => Promise<{ username: string }>;
  /** External Skill ?? fetch ??????? */
  externalFetch?: typeof fetch;
  /** Per-request deadline for external registry/GitHub source reads. */
  externalFetchTimeoutMs?: number;
}

interface MutationResult {
  statusCode: number;
  body: Record<string, unknown>;
}

interface MutationLockInput {
  actorId: string;
  method: string;
  path: string;
  key: string;
}

const resolveSchema = z.object({
  schema_version: z.literal(1),
  local_project_key: z.uuid(),
  display_name: z.string().min(1).max(200),
  requested_project_id: z.string().regex(/^prj_/).nullable(),
  client_id: z.string().regex(/^cli_/),
  recreate: z.boolean().optional()
}).strict();

const createProjectSchema = z.object({
  display_name: z.string().min(1).max(200)
}).strict();

const sessionSchema = z.object({
  schema_version: z.literal(1),
  request_id: z.uuid(),
  client_id: z.string().regex(/^cli_/),
  base_project_version: z.string().regex(/^pv_/).nullable(),
  base_manifest_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  proposal_manifest: z.object({ files: z.array(fileOperationSchema) }).passthrough(),
  artifact_manifest: z.object({
    schema_version: z.literal(1),
    files: z.array(fileOperationSchema)
  }).passthrough(),
  confirmations: z.object({
    project_local_paths: z.array(z.string()).default([])
  }).strict().optional(),
  scan_overrides: z.array(z.object({
    finding_fingerprint: z.string(),
    actor: z.string().min(1),
    reason: z.string().min(1)
  }).strict()).optional()
}).strict();

const blobQuerySchema = z.object({
  content_sha256: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/))
}).strict();

const tagCreateSchema = z.object({
  schema_version: z.literal(1),
  slug: registrySlugSchema,
  label: z.string().min(1).max(80)
}).strict();

const tagUpdateSchema = z.object({
  revision: z.number().int().positive(),
  label: z.string().min(1).max(80).optional(),
  active: z.boolean().optional()
}).strict();

const tagMergeSchema = z.object({
  revision: z.number().int().positive(),
  target_tag_id: z.string().regex(/^tag_/)
}).strict();

const projectWorkflowBindingSchema = bindProjectWorkflowFamilyRequestSchema;

// ?? provider ?? selected model ? request_model?fallback models[0] ? provider.model??test/ai-checks/release-note/fix-suggestions ???Y3 ????
function resolveRequestModel(provider: AiProviderConfig): string {
  return provider.models.find((m) => m.id === provider.selected_model_id)?.request_model
    ?? provider.models[0]?.request_model
    ?? provider.model;
}

const aiProviderCreateSchema = z.object({
  schema_version: z.literal(1),
  provider_id: z.string().min(1),
  label: z.string().min(1).max(120),
  base_url: z.url(),
  model: z.string().min(1),
  enabled: z.boolean(),
  api_key_env: z.string().min(1),
  is_default: z.boolean().optional(),
  daily_request_limit: z.number().int().nonnegative().nullable().optional(),
  daily_token_limit: z.number().int().nonnegative().nullable().optional(),
  models: z.array(providerModelSchema).optional(),
  api_format: z.enum(["openai", "anthropic", "custom"]).optional(),
  note: z.string().optional(),
  website: z.string().optional(),
  selected_model_id: z.string().nullable().optional(),
  sort_order: z.number().int().nonnegative().optional(),
  api_key: z.string().optional()
}).strict();

const aiProviderUpdateSchema = z.object({
  schema_version: z.literal(1),
  revision: z.number().int().positive(),
  label: z.string().min(1).max(120).optional(),
  base_url: z.url().optional(),
  model: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  api_key_env: z.string().min(1).optional(),
  daily_request_limit: z.number().int().nonnegative().nullable().optional(),
  daily_token_limit: z.number().int().nonnegative().nullable().optional(),
  models: z.array(providerModelSchema).optional(),
  api_format: z.enum(["openai", "anthropic", "custom"]).optional(),
  note: z.string().optional(),
  website: z.string().optional(),
  selected_model_id: z.string().nullable().optional(),
  sort_order: z.number().int().nonnegative().optional(),
  api_key: z.string().optional()
}).strict();

function routeRequestId(request: FastifyRequest): string {
  const header = request.headers["x-request-id"];
  if (header === undefined) {
    return uuidV7();
  }
  if (typeof header !== "string" || !z.uuid().safeParse(header).success) {
    throw new ServerDomainError(400, "VALIDATION_FAILED", "X-Request-Id is invalid");
  }
  return header;
}

function mutationBodyHash(body: unknown): string {
  if (body === undefined || body === null) return sha256Bytes("");
  return sha256Bytes(Buffer.isBuffer(body) ? body : canonicalJson(body));
}

function mutationResourcePath(request: FastifyRequest): string {
  const routePath = request.routeOptions.url ?? request.url.split("?")[0] ?? request.url;
  const rawParams = request.params;
  const params = rawParams !== null && typeof rawParams === "object" && !Array.isArray(rawParams)
    ? Object.fromEntries(
      Object.entries(rawParams as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .sort(([left], [right]) => left.localeCompare(right))
    )
    : {};
  const query = [...new URL(request.url, "http://localhost").searchParams.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
    );
  return routePath +
    (Object.keys(params).length === 0 ? "" : "#params=" + canonicalJson(params)) +
    (query.length === 0 ? "" : "#query=" + canonicalJson(query));
}

function operationTarget(operation: FileOperation): string {
  return operation.operation === "rename" ? operation.to_path : operation.path;
}

function operationSource(operation: FileOperation): string {
  return operation.operation === "rename" ? operation.from_path : operation.path;
}

function operationSize(operation: FileOperation): number {
  return "size_bytes" in operation ? operation.size_bytes : 0;
}

function projectLifecycleBody(project: ProjectRecord): Record<string, unknown> {
  return {
    project_id: project.projectId,
    display_name: project.displayName,
    lifecycle_state: project.lifecycleState,
    archived_at: project.archivedAt,
    purge_after: project.purgeAfter,
    purged_at: project.purgedAt
  };
}

// ???????? ? ? RegistryStore.DANGEROUS_PATH / checker DANGEROUS_PATH ????
// ?? ^\\ ????? UNC ?????? store ??????????
const DANGEROUS_PATH = /(^|[/\\])\.\.([/\\]|$)|^\/|^\\|^[a-zA-Z]:/;

// fix-suggestions ???? FixPlan summary?? aiChecks / LLM ????????
// Object.freeze ??????????????????? send ??? summary ???????????
// ????? WRITABLE_APPLIES_TO ? as const ?????????
const emptySummary = Object.freeze({ autoCount: 0, confirmCount: 0, suggestCount: 0, changedFiles: 0, changedLines: 0 });

function normalizeBundleRoot(files: SourceFile[]): SourceFile[] {
  const normalized = files.map((file) => ({ ...file, path: file.path.replaceAll("\\", "/") }));
  if (normalized.some((file) => file.path === "SKILL.md")) return normalized;
  const roots = new Set(normalized.map((file) => file.path.split("/")[0]).filter(Boolean));
  if (roots.size !== 1 || normalized.some((file) => !file.path.includes("/"))) return normalized;
  const root = [...roots][0] as string;
  const stripped = normalized.map((file) => ({ ...file, path: file.path.slice(root.length + 1) }));
  return stripped.some((file) => file.path === "SKILL.md") ? stripped : normalized;
}

function decodeUtf8(buffer: Buffer, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new ServerDomainError(422, SKILL_ERROR_CODE.VALIDATION_FAILED, `binary or invalid UTF-8 skill file is not supported: ${path}`);
  }
}

function resolveUploadFiles(
  collected: ReadonlyArray<{ path: string; buffer: Buffer }>,
  limits: { maxFileBytes: number; maxUploadFiles: number; maxProposalBytes: number },
  tooLargeCode = "PROPOSAL_TOO_LARGE"
): SourceFile[] {
  if (collected.length === 1 && /\.zip$/i.test(collected[0]?.path ?? "")) {
    try {
      const zip = new AdmZip(collected[0]?.buffer ?? Buffer.alloc(0));
      const files: SourceFile[] = [];
      let expandedBytes = 0;
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        if (files.length >= limits.maxUploadFiles) {
          throw new ServerDomainError(413, tooLargeCode, "zip contains too many files");
        }
        if (DANGEROUS_PATH.test(entry.entryName)) {
          throw new ServerDomainError(422, "SKILL_BUNDLE_INVALID", "zip slip detected: " + entry.entryName);
        }
        const expanded = entry.header.size;
        const compressed = entry.header.compressedSize;
        if (expanded > limits.maxFileBytes || expandedBytes + expanded > limits.maxProposalBytes ||
            (expanded > 1024 * 1024 && (compressed === 0 || expanded / compressed > 100))) {
          throw new ServerDomainError(413, tooLargeCode, "zip expanded size or compression ratio exceeds the upload limit");
        }
        const data = entry.getData();
        expandedBytes += data.byteLength;
        if (data.byteLength !== expanded || expandedBytes > limits.maxProposalBytes) {
          throw new ServerDomainError(413, tooLargeCode, "zip expanded size exceeds the upload limit");
        }
        files.push({ path: entry.entryName, content: decodeUtf8(data, entry.entryName) });
      }
      return normalizeBundleRoot(files);
    } catch (error) {
      if (error instanceof ServerDomainError) throw error;
      throw new ServerDomainError(422, "SKILL_BUNDLE_INVALID", "skill ZIP archive is invalid");
    }
  }
  return normalizeBundleRoot(collected.map((c) => ({ path: c.path, content: decodeUtf8(c.buffer, c.path) })));
}

async function authenticated(
  request: FastifyRequest,
  repository: ServerRepository,
  projectScope?: ProjectKeyScope
): Promise<{ actor: Actor; requestId: string }> {
  const actor = await authenticateRequest(request, repository);
  if (requestProjectKey(request) !== undefined) {
    // Project API keys are default-deny: only routes that declare a scope accept them.
    if (projectScope === undefined) {
      throw new ServerDomainError(
        403,
        "PROJECT_KEY_SCOPE",
        "project API keys cannot access this endpoint"
      );
    }
    const params = request.params as Record<string, unknown> | null;
    // 路由无 :projectId 参数时，以 key 自身的绑定项目为准（key 即项目绑定，
    // 不存在错配空间）；路由带参数时仍强制与 key 绑定项目一致
    const projectId = typeof params?.projectId === "string" && params.projectId !== ""
      ? params.projectId
      : requestProjectKey(request)?.projectId;
    if (projectId === undefined || projectId === "") {
      throw new ServerDomainError(
        403,
        "PROJECT_KEY_MISMATCH",
        "project API keys require a project-bound route"
      );
    }
    assertProjectKeyScope(request, projectScope, projectId);
  }
  return { actor, requestId: routeRequestId(request) };
}

function requireArchiveChangeKey(changeKey: string): string {
  try {
    return validateArchiveChangeKey(changeKey);
  } catch {
    throw new ServerDomainError(400, "ARCHIVE_CHANGE_KEY_INVALID", "archive change key is invalid");
  }
}

async function ownerAuthenticated(
  request: FastifyRequest,
  repository: ServerRepository,
  ownerActorId: string
): Promise<{ actor: Actor; requestId: string }> {
  const authenticatedRequest = await authenticated(request, repository);
  if (authenticatedRequest.actor.actorId !== ownerActorId) {
    throw new ServerDomainError(403, "OWNER_REQUIRED", "server owner access is required");
  }
  return authenticatedRequest;
}

async function ownerSessionAuthenticated(
  request: FastifyRequest,
  repository: ServerRepository,
  ownerActorId: string
): Promise<{ actor: Actor; requestId: string }> {
  const { user } = await requireSessionUser(request, repository);
  if (user.actorId !== ownerActorId) {
    throw new ServerDomainError(403, "OWNER_REQUIRED", "server owner access is required");
  }
  return { actor: { actorId: user.actorId }, requestId: routeRequestId(request) };
}

async function mutation(
  request: FastifyRequest,
  repository: ServerRepository,
  actor: Actor,
  requestId: string,
  action: (tx: TransactionRepository) => Promise<MutationResult>,
  bodyHashOverride?: string,
  lockInputOverride?: MutationLockInput,
  transactional = false
): Promise<MutationResult> {
  const idempotency = request.headers["idempotency-key"];
  if (typeof idempotency !== "string" || !z.uuid().safeParse(idempotency).success) {
    throw new ServerDomainError(
      400,
      "VALIDATION_FAILED",
      "Idempotency-Key is required and must be a UUID"
    );
  }
  const method = request.method.toUpperCase();
  // Route templates alone collapse different resources (for example two
  // project IDs) into one idempotency scope. Include normalized route params
  // and action-affecting query parameters in the canonical target identity.
  const path = mutationResourcePath(request);
  const bodyHash = bodyHashOverride ?? mutationBodyHash(request.body);
  const idempotencyInput = {
    actorId: actor.actorId,
    method,
    path,
    key: idempotency
  };
  const lockInput = lockInputOverride ?? idempotencyInput;
  const lock = await repository.acquireIdempotencyLock(lockInput);
  try {
    const execute = async (tx: TransactionRepository): Promise<MutationResult> => {
      const existing = await tx.getIdempotency(idempotencyInput);
      if (existing !== null) {
        if (existing.bodyHash !== bodyHash) {
          throw new ServerDomainError(
            409,
            "IDEMPOTENCY_KEY_REUSED",
            "idempotency key was reused with a different request"
          );
        }
        return {
          statusCode: existing.statusCode,
          body: existing.response as Record<string, unknown>
        };
      }
      const result = await action(tx);
      const response = { ...result.body, request_id: requestId };
      const record: IdempotencyRecord = {
        ...idempotencyInput,
        bodyHash,
        statusCode: result.statusCode,
        response
      };
      await tx.putIdempotency(record);
      return { statusCode: result.statusCode, body: response };
    };
    return transactional
      ? await repository.withTransaction(execute)
      : await execute(repository);
  } finally {
    await lock.release();
  }
}

async function transactionalMutation(
  request: FastifyRequest,
  repository: ServerRepository,
  actor: Actor,
  requestId: string,
  action: (tx: TransactionRepository) => Promise<MutationResult>
): Promise<MutationResult> {
  return mutation(request, repository, actor, requestId, action, undefined, undefined, true);
}

async function preparedTransactionalMutation<Prepared>(
  request: FastifyRequest,
  repository: ServerRepository,
  actor: Actor,
  requestId: string,
  prepare: () => Promise<Prepared>,
  action: (prepared: Prepared, tx: TransactionRepository) => Promise<MutationResult>,
  commitScope: (commit: () => Promise<MutationResult>) => Promise<MutationResult>
): Promise<MutationResult> {
  const idempotency = request.headers["idempotency-key"];
  if (typeof idempotency !== "string" || !z.uuid().safeParse(idempotency).success) {
    throw new ServerDomainError(
      400,
      "VALIDATION_FAILED",
      "Idempotency-Key is required and must be a UUID"
    );
  }
  const idempotencyInput = {
    actorId: actor.actorId,
    method: request.method.toUpperCase(),
    path: mutationResourcePath(request),
    key: idempotency
  };
  const bodyHash = mutationBodyHash(request.body);
  const replay = (existing: IdempotencyRecord): MutationResult => {
    if (existing.bodyHash !== bodyHash) {
      throw new ServerDomainError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "idempotency key was reused with a different request"
      );
    }
    return {
      statusCode: existing.statusCode,
      body: existing.response as Record<string, unknown>
    };
  };

  const replayLock = await repository.acquireIdempotencyLock(idempotencyInput);
  try {
    const existing = await repository.getIdempotency(idempotencyInput);
    if (existing !== null) return replay(existing);
  } finally {
    await replayLock.release();
  }

  const prepared = await prepare();
  const commitLock = await repository.acquireIdempotencyLock(idempotencyInput);
  try {
    const existing = await repository.getIdempotency(idempotencyInput);
    if (existing !== null) return replay(existing);
    return commitScope(() => repository.withTransaction(async (tx) => {
      const committed = await tx.getIdempotency(idempotencyInput);
      if (committed !== null) return replay(committed);

      const result = await action(prepared, tx);
      const response = { ...result.body, request_id: requestId };
      await tx.putIdempotency({
        ...idempotencyInput,
        bodyHash,
        statusCode: result.statusCode,
        response
      });
      return { statusCode: result.statusCode, body: response };
    }));
  } finally {
    await commitLock.release();
  }
}

function send(reply: FastifyReply, requestId: string, result: MutationResult) {
  reply.header("X-Request-Id", requestId);
  return reply.code(result.statusCode).send(result.body);
}

export async function createServer(options: CreateServerOptions): Promise<FastifyInstance> {
  const config = { ...defaultServerConfig, ...options.config };
  const ownerActorId = process.env.HUNTER_HARNESS_BOOTSTRAP_ACTOR ?? "actor_owner";
  const { repository, storage } = options;
  const deploymentNpmConfig = options.npmPublishConfig ?? loadNpmPublishConfig();
  const defaultNpmVerifier = new FetchNpmCredentialVerifier();
  const npmCredentials = createNpmPublishingCredentials({
    deploymentConfig: deploymentNpmConfig,
    persistence: options.npmCredentialPersistence ?? {
      load: () => repository.getNpmPublishingCredential(),
      save: (record) => repository.saveNpmPublishingCredential(record),
      clear: () => repository.clearNpmPublishingCredential()
    },
    encryptionKey: options.npmCredentialEncryptionKey ?? null,
    verifier: {
      verify: options.npmCredentialVerifier ?? ((token) => defaultNpmVerifier.verify(token))
    }
  });
  const resolveNpmPublishConfig = async (required: boolean) => {
    let npmConfig;
    try {
      npmConfig = await npmCredentials.resolveForPublish();
    } catch (error) {
      if (error instanceof NpmCredentialError) {
        throw new ServerDomainError(503, error.code, error.message);
      }
      throw error;
    }
    if (required && !isNpmPublishConfigured(npmConfig)) {
      throw new ServerDomainError(
        503,
        "NPM_PUBLISH_NOT_CONFIGURED",
        "npm publishing is not configured; add a token in Publishing settings or configure a deployment secret"
      );
    }
    return npmConfig;
  };
  const registry = new RegistryStore(storage, options.registryPersistence);
  await registry.initialize(options.bootstrapBundle);
  registry.setExternalFetcherDeps({
    ...(options.externalFetch !== undefined ? { fetch: options.externalFetch } : {}),
    githubToken: config.githubToken,
    ...(options.externalFetchTimeoutMs === undefined ? {} : { timeoutMs: options.externalFetchTimeoutMs })
  });
  // AiJobStore ???�3.2??PG ??? PgAiJobStore ???????? MemoryAiJobStore ??? fallback?
  const aiJobStore = options.aiJobStore ?? new MemoryAiJobStore();
  const semanticStore = options.semanticStore ?? new SemanticMemoryStore();
  const runStore = options.runStore ?? new MemoryRunStore();
  const branchMonitor = options.branchMonitorTrust === undefined
    ? undefined
    : createBranchMonitorQueryAdapter({
        source_port: createRunStoreBranchMonitorSource(runStore, options.branchMonitorTrust.cursorPort),
        stage12_verifier_port: createStage12MonitorVerifierAdapter({
          eventBundleReader: options.branchMonitorTrust.eventBundleReader,
          runStore
        }),
        cursor_verifier: options.branchMonitorTrust.cursorPort
      });
  const codexService = options.codexService ?? new CodexAppServerService(config.codexHome);
  // R3???????? running/pending job?PG ??? failed ?? partial unique index?memory no-op??
  await aiJobStore.recoverOrphans();
  // AI LlmClient ???�12.9??? defaultProvider ??? provider + secret file key ?? DeepSeek ????
  // ???/? key/??? ? null?????? AI_NOT_CONFIGURED??key ??????? store/log/???
  const llmFactory = options.aiLlmClientFactory ?? createLlmClient;
  const resolveLlmClient = async (providerId: string | null): Promise<{
    client: LlmClient;
    provider: AiProviderConfig;
  } | null> => {
    const provider = providerId === null
      ? registry.getDefaultProvider()
      : registry.getProvider(providerId) ?? null;
    if (provider === null || (providerId === null && !provider.enabled)) return null;
    const secret = await loadAiSecret(config.aiSecretFile, provider.provider_id);
    if (secret === null) return null;
    const merged: AiProviderConfig = {
      ...provider,
      base_url: secret.baseUrl ?? provider.base_url,
      model: secret.model ?? provider.model
    };
    const client = llmFactory(merged, secret.apiKey);
    if (client === null) {
      // api_format=anthropic|custom ?? client ?? ? 422 ADAPTER_NOT_IMPLEMENTED??????? AI_NOT_CONFIGURED?
      throw new ServerDomainError(422, "ADAPTER_NOT_IMPLEMENTED", "ai provider api_format not supported", {
        provider_id: provider.provider_id, api_format: provider.api_format
      });
    }
    return { client, provider };
  };
  type ResolvedAgentClient = {
    client: LlmClient;
    provider: AiProviderConfig | null;
    model: string;
    source: "provider" | "codex";
  };
  const resolveCodexLlmClient = async (): Promise<ResolvedAgentClient | null> => {
    if (!registry.isCodexEnabled()) return null;
    const connection = await codexService.getConnection();
    if (connection.status !== "connected") return null;
    const preferred = registry.getCodexSelectedModel();
    const model = connection.models.some((item) => item.id === preferred)
      ? preferred
      : connection.models.find((item) => item.is_default)?.id ?? connection.models[0]?.id ?? null;
    if (model === null) return null;
    const client = await codexService.getLlmClient(model);
    return client === null ? null : { client, provider: null, model, source: "codex" };
  };
  const resolveProviderLlmClient = async (): Promise<ResolvedAgentClient | null> => {
    const fallback = await resolveLlmClient(null);
    return fallback === null ? null : {
      ...fallback,
      model: resolveRequestModel(fallback.provider),
      source: "provider"
    };
  };
  const resolveAgentLlmClient = async (agent: RegistryAgent): Promise<ResolvedAgentClient | null> => {
    void agent;
    // 所有平台 AI 功能共用一个明确的默认来源。连接或保存密钥只表示“可用”，
    // enabled 才表示“正在使用”，避免不同 Agent 暗中选择不同后端。
    return registry.isCodexEnabled()
      ? await resolveCodexLlmClient()
      : await resolveProviderLlmClient();
  };
  const resolvedBackendId = (resolved: ResolvedAgentClient): string =>
    resolved.provider?.provider_id ?? "codex-account";
  const checkAgentQuota = (resolved: ResolvedAgentClient): void => {
    if (resolved.provider !== null) {
      registry.checkQuota({ provider_id: resolved.provider.provider_id, requests: 1, tokens: 0 });
    }
  };
  const recordAgentUsage = async (
    resolved: ResolvedAgentClient,
    usage: Awaited<ReturnType<LlmClient["analyze"]>>["usage"]
  ): Promise<void> => {
    if (resolved.provider === null) return;
    await registry.recordUsage({
      provider_id: resolved.provider.provider_id,
      model: resolved.model,
      requests: usage?.requests ?? 1,
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
      cache_hit_tokens: usage?.cache_hit_tokens ?? 0,
      cache_create_tokens: usage?.cache_create_tokens ?? 0
    });
  };
  const summarizeExternalSkillUpdate = async (
    skill: ExternalSkill,
    appliedAt: string,
    required: boolean
  ): Promise<ExternalSkill> => {
    const record = skill.updateHistory.find((item) => item.applied_at === appliedAt);
    if (record === undefined || record.releases.length === 0) return skill;
    const resolved = await resolveAgentLlmClient("generic");
    if (resolved === null) {
      if (required) throw new ServerDomainError(422, "AI_NOT_CONFIGURED", "no API provider or Codex account is available");
      return skill;
    }
    const prompt = buildExternalSkillUpdateSummaryPrompt({
      name: skill.snapshot.name,
      fromVersion: record.from_version,
      toVersion: record.to_version,
      releases: record.releases.map((release) => ({ version: release.version, changes: release.changes }))
    });
    checkAgentQuota(resolved);
    let response: Awaited<ReturnType<LlmClient["analyze"]>>;
    try {
      response = await resolved.client.analyze(prompt);
    } catch {
      throw new ServerDomainError(502, "AI_GENERATION_FAILED", "external skill update summary generation failed");
    }
    await recordAgentUsage(resolved, response.usage);
    let changes = parseExternalSkillUpdateSummary(response.content);
    if (changes === null) {
      checkAgentQuota(resolved);
      const repaired = await resolved.client.analyze({
        system: prompt.system + "\n上一次响应不符合结构要求。请只返回合法 JSON，并移除所有版本号前缀。",
        user: [prompt.user, "<invalid_response>", response.content.slice(0, 12_000), "</invalid_response>"].join("\n")
      });
      await recordAgentUsage(resolved, repaired.usage);
      changes = parseExternalSkillUpdateSummary(repaired.content);
    }
    if (changes === null) {
      throw new ServerDomainError(502, "AI_PARSE_FAILED", "external skill update summary was not valid Chinese content");
    }
    return registry.updateExternalSkillHistorySummary(skill.id, appliedAt, changes, skill.revision);
  };
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: config.maxProposalBytes
  });
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body)
  );
  app.addContentTypeParser(
    ["application/zip", "application/x-zip-compressed"],
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body)
  );
  await app.register(multipart, {
    preservePath: true,
    limits: { fileSize: config.maxFileBytes, files: config.maxUploadFiles }
  });
  if (options.branchSnapshotProducer !== undefined) {
    app.decorate("branchSnapshotProducer", options.branchSnapshotProducer);
  }

  const semanticRefreshes = new Map<string, Promise<void>>();
  const ensureSemanticIndexCurrent = async (actorId: string, projectId: string): Promise<void> => {
    const latest = await repository.getLatestArtifact(actorId, projectId);
    if (latest === null) return;
    if (await semanticStore.latestArtifactId(projectId) === latest.artifactId &&
        await semanticStore.indexSchemaVersion(projectId) === SEMANTIC_INDEX_SCHEMA_VERSION) {
      return;
    }
    const active = semanticRefreshes.get(projectId);
    if (active !== undefined) return active;
    const refresh = rebuildStableSemanticSnapshot({
      actorId,
      projectId,
      repository,
      storage,
      semanticStore
    }).then(() => undefined).finally(() => {
      if (semanticRefreshes.get(projectId) === refresh) semanticRefreshes.delete(projectId);
    });
    semanticRefreshes.set(projectId, refresh);
    return refresh;
  };
  const queuedSemanticRefreshes = new Map<string, string>();
  let activeSemanticRefreshes = 0;
  const drainSemanticRefreshQueue = (): void => {
    while (activeSemanticRefreshes < 2 && queuedSemanticRefreshes.size > 0) {
      const next = queuedSemanticRefreshes.entries().next().value as
        | [string, string]
        | undefined;
      if (next === undefined) return;
      const [projectId, actorId] = next;
      queuedSemanticRefreshes.delete(projectId);
      activeSemanticRefreshes += 1;
      void ensureSemanticIndexCurrent(actorId, projectId)
        .catch((error: unknown) => {
          app.log.warn({ error, projectId }, "background semantic index refresh failed");
        })
        .finally(() => {
          activeSemanticRefreshes -= 1;
          drainSemanticRefreshQueue();
        });
    }
  };
  const scheduleSemanticIndexesCurrent = (actorId: string, projectIds: readonly string[]): void => {
    for (const projectId of projectIds) {
      if (!semanticRefreshes.has(projectId) && !queuedSemanticRefreshes.has(projectId)) {
        queuedSemanticRefreshes.set(projectId, actorId);
      }
    }
    drainSemanticRefreshQueue();
  };
  const accessibleSemanticProjectIds = async (actorId: string): Promise<string[]> => {
    const projectIds: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await repository.listProjects({ actorId, limit: 100, cursor });
      projectIds.push(...page.items.map((project) => project.projectId));
      cursor = page.nextCursor;
    } while (cursor !== null);
    return projectIds;
  };

  app.setErrorHandler((error, request, reply) => {
    let status = 500;
    let code = "INTERNAL_ERROR";
    let message = "Internal server error.";
    let details: Record<string, unknown> = {};
    if (error instanceof ServerDomainError) {
      ({ status, code, message, details } = error);
    } else if (error instanceof ZodError) {
      status = 400;
      code = "VALIDATION_FAILED";
      message = "Request schema validation failed.";
      details = { issues: error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code
      })) };
    } else if (typeof error === "object" && error !== null &&
        "statusCode" in error && error.statusCode === 413) {
      status = 413;
      const route = request.routeOptions.url;
      code = route === "/api/v1/skills/draft"
        ? "SKILL_UPLOAD_TOO_LARGE"
        : route === "/api/v1/projects/:projectId/changes/:changeKey/archive-package"
          ? "ARCHIVE_PACKAGE_TOO_LARGE"
          : route === "/api/v1/projects/:projectId/branches/:branchName/remote-sync/file-upload"
            ? "REMOTE_CONTENT_UPLOAD_TOO_LARGE"
          : "PROPOSAL_TOO_LARGE";
      message = "Request body exceeds the configured limit.";
    }
    let requestId: string;
    try {
      requestId = routeRequestId(request);
    } catch {
      requestId = uuidV7();
    }
    reply.header("X-Request-Id", requestId).code(status).send({
      error: { code, message, request_id: requestId, details }
    });
  });

  const quarantineProjectBlobs = async (candidates: string[]): Promise<{
    candidates: number;
    quarantined: number;
    referenced: number;
    failed: number;
  }> => {
    const hashes = [...new Set(candidates)];
    const registryReferences = registry.referencedBlobHashes();
    let quarantined = 0;
    let referenced = 0;
    let failed = 0;
    for (const hash of hashes) {
      try {
        if (registryReferences.has(hash) || await repository.isBlobReferenced(hash)) {
          referenced += 1;
          continue;
        }
        if (await storage.quarantineBlob(hash, new Date().toISOString())) quarantined += 1;
      } catch (error) {
        failed += 1;
        app.log.error({ error, contentSha256: hash }, "project blob quarantine failed");
      }
    }
    return { candidates: hashes.length, quarantined, referenced, failed };
  };

  const sweepQuarantinedProjectBlobs = async (): Promise<void> => {
    const registryReferences = registry.referencedBlobHashes();
    const cutoff = Date.now() - config.projectBlobGcGraceMs;
    for (const blob of await storage.listQuarantinedBlobs()) {
      const quarantinedAt = Date.parse(blob.quarantinedAt);
      if (!Number.isFinite(quarantinedAt) || quarantinedAt > cutoff) continue;
      try {
        if (registryReferences.has(blob.contentSha256) ||
            await repository.isBlobReferenced(blob.contentSha256)) {
          await storage.restoreQuarantinedBlob(blob.contentSha256);
        } else {
          await storage.deleteQuarantinedBlob(blob.contentSha256);
        }
      } catch (error) {
        app.log.error({ error, contentSha256: blob.contentSha256 }, "project blob sweep failed");
      }
    }
  };

  app.get("/health", async () => ({ status: "ok" }));

  // P2 auth: username/password login -> hhs_ session token (Bearer-compatible).
  registerAuthRoutes(app, {
    repository,
    ownerActorId,
    projectKeyEncryptionKey: options.projectKeyEncryptionKey ?? null
  });

  app.get("/api/v1/system/npm-publishing", async (request, reply) => {
    const { requestId } = await ownerSessionAuthenticated(request, repository, ownerActorId);
    const status = await npmCredentials.status();
    reply.header("X-Request-Id", requestId);
    return {
      ...status,
      request_id: requestId
    };
  });

  app.put("/api/v1/system/npm-publishing/credential", async (request, reply) => {
    const { actor, requestId } = await ownerSessionAuthenticated(request, repository, ownerActorId);
    const body = z.object({
      schema_version: z.literal(1),
      token: z.string().min(1).max(2048),
      expires_at: z.iso.datetime().nullable()
    }).strict().parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      let status;
      try {
        status = await npmCredentials.replace({
          token: body.token,
          expiresAt: body.expires_at,
          actorId: actor.actorId
        });
      } catch (error) {
        if (error instanceof NpmCredentialError) {
          await writeAudit(repository, {
            actorId: actor.actorId,
            projectId: null,
            action: "npm.credential.rejected",
            targetId: deploymentNpmConfig.scope ?? "npm",
            requestId,
            details: { code: error.code }
          });
          throw new ServerDomainError(
            error.code === "NPM_CREDENTIAL_LOCKED" ? 503 : 422,
            error.code,
            error.message
          );
        }
        throw error;
      }
      await writeAudit(repository, {
        actorId: actor.actorId,
        projectId: null,
        action: "npm.credential.set",
        targetId: status.scope ?? "npm",
        requestId,
        details: {
          scope: status.scope,
          source: status.source,
          username: status.username,
          expires_at: status.expires_at
        }
      });
      return { statusCode: 200, body: { ...status } };
    });
    return send(reply, requestId, result);
  });

  app.post("/api/v1/system/npm-publishing/verify", async (request, reply) => {
    const { actor, requestId } = await ownerSessionAuthenticated(request, repository, ownerActorId);
    z.object({ schema_version: z.literal(1) }).strict().parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      let status;
      try {
        status = await npmCredentials.verifyActive();
      } catch (error) {
        if (error instanceof NpmCredentialError) {
          throw new ServerDomainError(
            error.code === "NPM_CREDENTIAL_LOCKED" ? 503 : 422,
            error.code,
            error.message
          );
        }
        throw error;
      }
      await writeAudit(repository, {
        actorId: actor.actorId,
        projectId: null,
        action: "npm.credential.verified",
        targetId: status.scope ?? "npm",
        requestId,
        details: { scope: status.scope, source: status.source, username: status.username }
      });
      return { statusCode: 200, body: { ...status } };
    });
    return send(reply, requestId, result);
  });

  app.delete("/api/v1/system/npm-publishing/credential", async (request, reply) => {
    const { actor, requestId } = await ownerSessionAuthenticated(request, repository, ownerActorId);
    z.object({ schema_version: z.literal(1) }).strict().parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const status = await npmCredentials.clear();
      await writeAudit(repository, {
        actorId: actor.actorId,
        projectId: null,
        action: "npm.credential.removed",
        targetId: status.scope ?? "npm",
        requestId,
        details: { fallback_source: status.source }
      });
      return { statusCode: 200, body: { ...status } };
    });
    return send(reply, requestId, result);
  });

  app.get("/api/v1/dashboard/overview", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const query = z.object({ days: z.coerce.number().int().min(7).max(30).default(7) }).strict().parse(request.query);
    const overview = await buildDashboardOverview({
      repository,
      registry,
      runStore,
      semanticStore,
      actorId: actor.actorId,
      days: query.days
    });
    reply.header("X-Request-Id", requestId);
    return { ...overview, request_id: requestId };
  });

  app.post("/api/v1/projects:resolve", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository, "push");
    const body = resolveSchema.parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const resolved = await repository.resolveProject({
        actorId: actor.actorId,
        localProjectKey: body.local_project_key,
        displayName: body.display_name,
        requestedProjectId: body.requested_project_id,
        ...(body.recreate === undefined ? {} : { recreate: body.recreate })
      });
      // 项目绑定 key：resolve 结果必须是 key 的绑定项目（不得借 resolve 越权到他项目）
      const projectKey = requestProjectKey(request);
      if (projectKey !== undefined && resolved.project.projectId !== projectKey.projectId) {
        throw new ServerDomainError(403, "PROJECT_KEY_MISMATCH",
          "API key is bound to another project");
      }
      await writeAudit(repository, {
        actorId: actor.actorId,
        projectId: resolved.project.projectId,
        action: "project.resolved",
        targetId: resolved.project.projectId,
        requestId,
        details: { binding_status: resolved.bindingStatus }
      });
      return {
        statusCode: 200,
        body: {
          schema_version: 1,
          project_id: resolved.project.projectId,
          binding_status: resolved.bindingStatus,
          project_version: resolved.project.latestProjectVersion,
          baseline_manifest: {
            schema_version: 1,
            project_id: resolved.project.projectId,
            complete_project_version: resolved.project.latestProjectVersion,
            artifact_manifest_hash: null,
            files: {}
          }
        }
      };
    });
    return send(reply, requestId, result);
  });

  // push 流程的第一个调用就是这条（取 baseline 与最新版本），之后才是
  // projects:resolve（同样声明 "push"）。此前这里没声明 scope，project key 走
  // default-deny 被 403，push 在 project_id 尚未解析时就整体失败——现场表现是
  // 平台上"分支文件里没有 plan/spec"，因为它们全靠这条推送上传。
  app.get("/api/v1/projects/:projectId", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository, "push");
    const { projectId } = request.params as { projectId: string };
    const project = await repository.getProject(actor.actorId, projectId);
    reply.header("X-Request-Id", requestId);
    return {
      schema_version: 1,
      project_id: project.projectId,
      display_name: project.displayName,
      role: "owner",
      latest_project_version: project.latestProjectVersion,
      latest_artifact_id: project.latestArtifactId,
      lifecycle_state: project.lifecycleState,
      current_files_version: project.currentFilesVersion,
      current_file_count: project.currentFileCount,
      updated_at: project.updatedAt,
      created_at: project.createdAt,
      request_id: requestId
    };
  });

  app.get("/api/v1/projects", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const query = request.query as Record<string, string | undefined>;
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ServerDomainError(400, "VALIDATION_FAILED", "limit must be between 1 and 100");
    }
    const state = query.state ?? "active";
    if (state !== "active" && state !== "archived") {
      throw new ServerDomainError(400, "VALIDATION_FAILED", "state must be active or archived");
    }
    const listed = await repository.listProjects({
      actorId: actor.actorId,
      limit,
      cursor: query.cursor ?? null,
      state
    });
    reply.header("X-Request-Id", requestId);
    return {
      items: listed.items.map((project) => ({
        project_id: project.projectId,
        display_name: project.displayName,
        role: "owner",
        latest_project_version: project.latestProjectVersion,
        latest_artifact_id: project.latestArtifactId,
        lifecycle_state: project.lifecycleState,
        archived_at: project.archivedAt,
        purge_after: project.purgeAfter,
        current_files_version: project.currentFilesVersion ?? project.latestProjectVersion,
        current_file_count: project.currentFileCount,
        local_project_key: project.localProjectKey,
        updated_at: project.updatedAt,
        created_at: project.createdAt
      })),
      page: { next_cursor: listed.nextCursor, limit },
      request_id: requestId
    };
  });

  app.post("/api/v1/projects", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const body = createProjectSchema.parse(request.body);
    const query = request.query as Record<string, string | undefined>;
    const withKey = query.withKey === "true" || query.withKey === "1";
    const result = await mutation(request, repository, actor, requestId, async () => {
      const project = await repository.createProject({
        actorId: actor.actorId,
        displayName: body.display_name
      });
      await writeAudit(repository, {
        actorId: actor.actorId,
        projectId: project.projectId,
        action: "project.created",
        targetId: project.projectId,
        requestId,
        details: { with_key: withKey }
      });
      const summary = {
        project_id: project.projectId,
        display_name: project.displayName,
        role: "owner" as const,
        latest_project_version: project.latestProjectVersion,
        latest_artifact_id: project.latestArtifactId,
        lifecycle_state: project.lifecycleState,
        current_files_version: project.currentFilesVersion,
        current_file_count: project.currentFileCount,
        updated_at: project.updatedAt,
        created_at: project.createdAt
      };
      if (!withKey) {
        return { statusCode: 201, body: { project: summary } };
      }
      const plaintext = generateProjectApiKey();
      const key = await repository.createProjectApiKey({
        keyId: "key_" + randomUUID().replaceAll("-", ""),
        keyHash: projectApiKeyHash(plaintext),
        projectId: project.projectId,
        actorId: actor.actorId,
        label: "initial",
        scopes: [...PROJECT_KEY_SCOPES]
      });
      return {
        statusCode: 201,
        body: {
          project: summary,
          api_key: plaintext,
          key_id: key.keyId
        }
      };
    });
    return send(reply, requestId, result);
  });

  app.delete("/api/v1/projects/:projectId", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId } = request.params as { projectId: string };
    const result = await mutation(request, repository, actor, requestId, async () => {
      const project = await repository.archiveProject(actor.actorId, projectId, new Date().toISOString());
      await writeAudit(repository, {
        actorId: actor.actorId,
        projectId,
        action: "project.archived",
        targetId: projectId,
        requestId,
        details: { purge_after: project.purgeAfter }
      });
      return { statusCode: 200, body: projectLifecycleBody(project) };
    });
    return send(reply, requestId, result);
  });

  app.post("/api/v1/projects/:projectId/restore", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId } = request.params as { projectId: string };
    const result = await mutation(request, repository, actor, requestId, async () => {
      const project = await repository.restoreProject(actor.actorId, projectId);
      await writeAudit(repository, {
        actorId: actor.actorId,
        projectId,
        action: "project.restored",
        targetId: projectId,
        requestId,
        details: {}
      });
      return { statusCode: 200, body: projectLifecycleBody(project) };
    });
    return send(reply, requestId, result);
  });

  app.delete("/api/v1/projects/:projectId/purge", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId } = request.params as { projectId: string };
    const result = await mutation(request, repository, actor, requestId, async () => {
      const blobCandidates = await repository.listProjectBlobHashes(actor.actorId, projectId);
      const project = await repository.purgeProject(actor.actorId, projectId, new Date().toISOString());
      try {
        await semanticStore.deleteProject(projectId);
      } catch (error) {
        request.log.error({ error, projectId }, "purged project semantic cleanup failed");
      }
      const blobCleanup = await quarantineProjectBlobs(blobCandidates);
      await writeAudit(repository, {
        actorId: actor.actorId,
        projectId,
        action: "project.purged",
        targetId: projectId,
        requestId,
        details: {
          blob_candidates: blobCleanup.candidates,
          blobs_quarantined: blobCleanup.quarantined,
          blobs_still_referenced: blobCleanup.referenced,
          blob_quarantine_failures: blobCleanup.failed,
          blob_gc_grace_ms: config.projectBlobGcGraceMs
        }
      });
      return { statusCode: 200, body: projectLifecycleBody(project) };
    });
    return send(reply, requestId, result);
  });

  app.get("/api/v1/projects/:projectId/files", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository, "files:read");
    const { projectId } = request.params as { projectId: string };
    const project = await repository.getProject(actor.actorId, projectId);
    const files = await repository.listProjectFiles(actor.actorId, projectId);
    reply.header("X-Request-Id", requestId);
    return {
      project_id: projectId,
      project_version: project.currentFilesVersion ?? project.latestProjectVersion,
      total: files.length,
      items: files.map((file) => ({
        path: file.path,
        file_kind: file.fileKind,
        content_sha256: file.contentSha256,
        size_bytes: file.sizeBytes,
        project_version: file.projectVersion,
        updated_at: file.updatedAt
      })),
      request_id: requestId
    };
  });

  app.get("/api/v1/projects/:projectId/files/content", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository, "files:read");
    const { projectId } = request.params as { projectId: string };
    const query = request.query as Record<string, string | undefined>;
    if (query.path === undefined || query.path.length === 0) {
      throw new ServerDomainError(400, "VALIDATION_FAILED", "path is required");
    }
    const file = await repository.getProjectFile(actor.actorId, projectId, query.path);
    const bytes = await storage.getBlob(file.contentSha256);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ServerDomainError(422, "PROJECT_FILE_INVALID", "project file is not UTF-8 text");
    }
    reply.header("X-Request-Id", requestId);
    reply.header("ETag", file.contentSha256);
    return {
      project_id: projectId,
      path: file.path,
      file_kind: file.fileKind,
      content_sha256: file.contentSha256,
      size_bytes: file.sizeBytes,
      project_version: file.projectVersion,
      updated_at: file.updatedAt,
      content,
      request_id: requestId
    };
  });

  app.post("/api/v1/projects/:projectId/proposal-sessions", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository, "push");
    const { projectId } = request.params as { projectId: string };
    const body = sessionSchema.parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const project = await repository.getProject(actor.actorId, projectId);
      if (body.base_project_version !== project.latestProjectVersion) {
        throw new ServerDomainError(409, "PROJECT_VERSION_CONFLICT", "base project version is stale", {
          latest_project_version: project.latestProjectVersion
        });
      }
      if (canonicalJson(body.proposal_manifest.files) !==
          canonicalJson(body.artifact_manifest.files)) {
        throw new ServerDomainError(400, "VALIDATION_FAILED", "proposal manifests disagree");
      }
      const confirmed = new Set(body.confirmations?.project_local_paths ?? []);
      let total = 0;
      for (const operation of body.proposal_manifest.files) {
        const target = operationTarget(operation);
        const targetPolicy = classifyFile(target);
        const sourcePolicy = classifyFile(operationSource(operation));
        if (operation.file_kind !== targetPolicy.file_kind ||
            !decidePush(targetPolicy, confirmed.has(target)).include ||
            !decidePush(sourcePolicy, confirmed.has(operationSource(operation))).include) {
          throw new ServerDomainError(
            422,
            "POLICY_PATH_FORBIDDEN",
            "proposal contains a forbidden path",
            { path: target }
          );
        }
        const size = operationSize(operation);
        if (size > config.maxFileBytes) {
          throw new ServerDomainError(413, "FILE_TOO_LARGE", "proposal file exceeds size limit", {
            path: target
          });
        }
        total += size;
      }
      if (total > config.maxProposalBytes) {
        throw new ServerDomainError(413, "PROPOSAL_TOO_LARGE", "proposal exceeds size limit");
      }
      const session = await repository.createProposalSession({
        projectId,
        actorId: actor.actorId,
        baseProjectVersion: body.base_project_version,
        baseManifestHash: body.base_manifest_hash,
        operations: body.proposal_manifest.files,
        scanOverrides: (body.scan_overrides ?? []) as FindingOverride[],
        status: "open",
        expiresAt: new Date(Date.now() + config.sessionTtlMs).toISOString(),
        maxChunkBytes: config.maxChunkBytes
      });
      const hashes = [...new Set(body.proposal_manifest.files.flatMap((operation) =>
        operation.operation === "delete" ? [] : [operation.content_sha256]
      ))];
      const missing = [];
      for (const hash of hashes) {
        if (hash === sha256Bytes(new Uint8Array())) {
          await storage.putBlob(hash, new Uint8Array());
        }
        if (!await storage.hasBlob(hash)) {
          missing.push(hash);
        }
      }
      return {
        statusCode: 201,
        body: {
          session_id: session.sessionId,
          expires_at: session.expiresAt,
          missing_blobs: missing,
          max_chunk_bytes: session.maxChunkBytes
        }
      };
    });
    return send(reply, requestId, result);
  });

  app.post("/api/v1/proposal-sessions/:sessionId/blobs:query", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository, "push");
    const { sessionId } = request.params as { sessionId: string };
    const body = blobQuerySchema.parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const session = await repository.getProposalSession(actor.actorId, sessionId);
      const declared = new Set(session.operations.flatMap((operation) =>
        operation.operation === "delete" ? [] : [operation.content_sha256]
      ));
      const present: string[] = [];
      const missing: string[] = [];
      for (const hash of body.content_sha256) {
        if (!declared.has(hash)) {
          throw new ServerDomainError(409, "BLOB_NOT_DECLARED", "blob is not declared");
        }
        (await storage.hasBlob(hash) ? present : missing).push(hash);
      }
      return { statusCode: 200, body: { present, missing } };
    });
    return send(reply, requestId, result);
  });

  app.put("/api/v1/proposal-sessions/:sessionId/blobs/:hash", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository, "push");
    const { sessionId, hash } = request.params as { sessionId: string; hash: string };
    const result = await mutation(request, repository, actor, requestId, async () => {
      const session = await repository.getProposalSession(actor.actorId, sessionId);
      const operation = session.operations.find((item) =>
        item.operation !== "delete" && item.content_sha256 === hash
      );
      if (operation === undefined) {
        throw new ServerDomainError(409, "BLOB_NOT_DECLARED", "blob is not declared");
      }
      const content = request.body;
      if (!Buffer.isBuffer(content)) {
        throw new ServerDomainError(400, "VALIDATION_FAILED", "blob body is required");
      }
      if (content.byteLength > session.maxChunkBytes) {
        throw new ServerDomainError(413, "FILE_TOO_LARGE", "chunk exceeds size limit");
      }
      if (request.headers["x-chunk-sha256"] !== sha256Bytes(content)) {
        throw new ServerDomainError(
          422,
          "UPLOAD_CHUNK_HASH_MISMATCH",
          "upload chunk integrity check failed"
        );
      }
      if (operationSize(operation) === 0 && content.byteLength === 0 &&
          request.headers["content-range"] === "bytes */0") {
        await storage.putBlob(hash, content);
        return {
          statusCode: 201,
          body: { received_ranges: [], verified: true }
        };
      }
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
        String(request.headers["content-range"] ?? "")
      );
      if (range === null) {
        throw new ServerDomainError(400, "VALIDATION_FAILED", "Content-Range is invalid");
      }
      const start = Number(range[1]);
      const end = Number(range[2]);
      const total = Number(range[3]);
      if (end - start + 1 !== content.byteLength || total !== operationSize(operation)) {
        throw new ServerDomainError(422, "UPLOAD_RANGE_INVALID", "upload range is invalid");
      }
      const written = await storage.writeSessionChunk({
        sessionId,
        contentSha256: hash,
        start,
        total,
        chunk: content
      });
      return {
        statusCode: written.complete ? 201 : 202,
        body: {
          received_ranges: written.receivedRanges,
          verified: written.complete
        }
      };
    });
    return send(reply, requestId, result);
  });

  app.post(
    "/api/v1/proposal-sessions/:sessionId(^ups_[^:]+):finalize",
    async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository, "push");
    const { sessionId } = request.params as { sessionId: string };
    const body = finalizeProposalSchema.parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const session = await repository.getProposalSession(actor.actorId, sessionId);
      if (body.manifest_sha256 !== sha256Bytes(canonicalJson(session.operations))) {
        throw new ServerDomainError(422, "ARTIFACT_HASH_MISMATCH", "proposal manifest hash mismatch");
      }
      const project = await repository.getProject(actor.actorId, session.projectId);
      if (project.latestArtifactId !== null &&
          body.base_artifact_id !== project.latestArtifactId) {
        throw new ServerDomainError(
          409,
          "STALE_PUSH",
          "server already has a newer artifact; sync before pushing",
          { latest_artifact_id: project.latestArtifactId }
        );
      }
      const files: Record<string, string> = {};
      for (const operation of session.operations) {
        if (operation.operation === "delete") {
          continue;
        }
        if (!await storage.hasBlob(operation.content_sha256)) {
          throw new ServerDomainError(409, "UPLOAD_INCOMPLETE", "required blob is missing");
        }
        const bytes = await storage.getBlob(operation.content_sha256);
        if (bytes.byteLength !== operation.size_bytes ||
            sha256Bytes(bytes) !== operation.content_sha256) {
          throw new ServerDomainError(422, "ARTIFACT_HASH_MISMATCH", "blob integrity check failed");
        }
        try {
          files[operationTarget(operation)] = new TextDecoder("utf-8", {
            fatal: true
          }).decode(bytes);
        } catch {
          throw new ServerDomainError(422, "POLICY_PATH_FORBIDDEN", "artifact must be UTF-8 text");
        }
      }
      const { proposal, review } = await repository.finalizeSessionAutoApprove(session);
      await storage.deleteSession(sessionId);
      await writeAudit(repository, {
        actorId: actor.actorId,
        projectId: proposal.projectId,
        action: "proposal.finalized",
        targetId: proposal.proposalId,
        requestId,
        details: {
          item_count: proposal.items.length,
          artifact_id: review.artifactId,
          ...(body.sensitive_scan_skip === true
            ? { sensitive_scan_skip_deprecated_noop: true }
            : {})
        }
      });
      if (review.artifactId !== null) {
        try {
          const semanticFiles = await loadSemanticSnapshotFiles({
            actorId: actor.actorId,
            projectId: proposal.projectId,
            repository,
            storage
          });
          await semanticStore.rebuild(buildSemanticIndex({
            projectId: proposal.projectId,
            artifactId: review.artifactId,
            files: semanticFiles
          }), {
            expectedArtifactId: review.artifactId,
            isCurrent: async () =>
              (await repository.getLatestArtifact(actor.actorId, proposal.projectId))?.artifactId ===
                review.artifactId
          });
        } catch (error) {
          request.log.error({ error, projectId: proposal.projectId }, "semantic index rebuild failed");
        }
      }
      return {
        statusCode: 201,
        body: {
          proposal_id: proposal.proposalId,
          status: "approved" as const,
          artifact_id: review.artifactId,
          received_files: proposal.items.length
        }
      };
    });
    return send(reply, requestId, result);
    }
  );

  app.get("/api/v1/projects/:projectId/proposals", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId } = request.params as { projectId: string };
    const query = request.query as Record<string, string | undefined>;
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ServerDomainError(400, "VALIDATION_FAILED", "limit must be between 1 and 100");
    }
    const listed = await repository.listProposals({
      actorId: actor.actorId,
      projectId,
      limit,
      cursor: query.cursor ?? null,
      status: query.status ?? null
    });
    reply.header("X-Request-Id", requestId);
    return {
      items: listed.items.map((proposal) => ({
        proposal_id: proposal.proposalId,
        status: proposal.status,
        created_at: proposal.createdAt,
        changed_item_count: proposal.items.length,
        risk_count: 0,
        base_project_version: proposal.baseProjectVersion,
        created_by: proposal.createdBy
      })),
      page: { next_cursor: listed.nextCursor, limit },
      request_id: requestId
    };
  });

  app.get("/api/v1/projects/:projectId/artifacts", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId } = request.params as { projectId: string };
    const query = request.query as Record<string, string | undefined>;
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ServerDomainError(400, "VALIDATION_FAILED", "limit must be between 1 and 100");
    }
    const listed = await repository.listArtifacts({
      actorId: actor.actorId,
      projectId,
      limit,
      cursor: query.cursor ?? null
    });
    reply.header("X-Request-Id", requestId);
    return {
      items: listed.items.map((artifact) => ({
        artifact_id: artifact.artifactId,
        project_id: artifact.projectId,
        project_version: artifact.projectVersion,
        base_project_version: artifact.baseProjectVersion,
        proposal_id: artifact.proposalId,
        changed_item_count: artifact.manifest.files.length,
        manifest_sha256: artifact.manifest.manifest_sha256,
        created_at: artifact.createdAt
      })),
      page: { next_cursor: listed.nextCursor, limit },
      request_id: requestId
    };
  });

  app.get("/api/v1/proposals/:proposalId", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { proposalId } = request.params as { proposalId: string };
    const proposal = await repository.getProposal(actor.actorId, proposalId);
    reply.header("X-Request-Id", requestId);
    return {
      schema_version: 1,
      proposal_id: proposal.proposalId,
      project_id: proposal.projectId,
      status: proposal.status,
      created_by: proposal.createdBy,
      created_at: proposal.createdAt,
      items: proposal.items.map((item) => ({
        item_id: item.itemId,
        operation: item.operation
      })),
      scan_summary: { redacted: true },
      review_history: proposal.reviewHistory.map((review) => ({
        review_id: review.reviewId,
        decision: review.decision,
        created_at: review.createdAt,
        artifact_id: review.artifactId
      })),
      request_id: requestId
    };
  });

  app.get("/api/v1/projects/:projectId/update-manifest", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository, "files:read");
    const { projectId } = request.params as { projectId: string };
    await repository.getProject(actor.actorId, projectId);
    const query = request.query as Record<string, string | undefined>;
    const baseProjectVersion = query.base_project_version === undefined ||
      query.base_project_version === ""
      ? null
      : query.base_project_version;
    const artifact = await repository.getNextArtifact(
      actor.actorId,
      projectId,
      baseProjectVersion
    );
    reply.header("X-Request-Id", requestId);
    return {
      schema_version: 1,
      project_id: projectId,
      observed_project_version: artifact?.projectVersion ?? null,
      artifact_id: artifact?.artifactId ?? null,
      artifact_manifest_url: artifact === null
        ? null
        : "/api/v1/artifacts/" + artifact.artifactId + "/manifest",
      delta_available: artifact !== null,
      request_id: requestId
    };
  });

  app.get("/api/v1/artifacts/:artifactId/manifest", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository, "files:read");
    const { artifactId } = request.params as { artifactId: string };
    const artifact = await repository.getArtifact(actor.actorId, artifactId);
    reply.header("X-Request-Id", requestId);
    reply.header("ETag", artifact.manifest.manifest_sha256);
    return artifact.manifest;
  });

  app.get("/api/v1/artifacts/:artifactId/blobs/:hash", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository, "files:read");
    const { artifactId, hash } = request.params as { artifactId: string; hash: string };
    const artifact = await repository.getArtifact(actor.actorId, artifactId);
    if (!artifact.manifest.files.some((operation) =>
      operation.operation !== "delete" && operation.content_sha256 === hash
    )) {
      throw new ServerDomainError(404, "ARTIFACT_NOT_FOUND", "artifact blob not found");
    }
    const bytes = await storage.getBlob(hash);
    let start = 0;
    let end = bytes.byteLength - 1;
    let statusCode = 200;
    const range = request.headers.range;
    if (range !== undefined) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (match === null) {
        throw new ServerDomainError(416, "RANGE_INVALID", "Range header is invalid");
      }
      start = Number(match[1]);
      end = match[2] === "" ? end : Number(match[2]);
      if (start > end || end >= bytes.byteLength) {
        throw new ServerDomainError(416, "RANGE_INVALID", "Range is outside the blob");
      }
      statusCode = 206;
      reply.header("Content-Range", `bytes ${start}-${end}/${bytes.byteLength}`);
    }
    const content = Buffer.from(bytes.slice(start, end + 1));
    reply
      .header("Content-Type", "application/octet-stream")
      .header("Content-Length", String(content.byteLength))
      .header("X-Content-SHA256", hash)
      .header("ETag", hash)
      .header("X-Request-Id", requestId)
      .code(statusCode);
    return content;
  });

  app.get("/api/v1/skills", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const query = request.query as Record<string, string | undefined>;
    reply.header("X-Request-Id", requestId);
    return {
      items: registry.listSkills({
        search: query.search,
        tag: query.tag,
        agent: query.agent,
        status: query.status
      }),
      page: { next_cursor: null },
      request_id: requestId
    };
  });

  app.get("/api/v1/skills/:slug", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const { slug } = request.params as { slug: string };
    reply.header("X-Request-Id", requestId);
    const npmStatus = await npmCredentials.status();
    return {
      ...registry.getSkill(slug),
      npm_publish_available: npmStatus.state === "configured" || npmStatus.state === "ready",
      request_id: requestId
    };
  });

  app.get("/api/v1/skills/:slug/adapter-preview/:agent", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const { slug, agent: agentValue } = request.params as { slug: string; agent: string };
    const preview = registry.adapterPreview(slug, registryAgentSchema.parse(agentValue));
    reply.header("X-Request-Id", requestId);
    return { ...preview, request_id: requestId };
  });
  app.get("/api/v1/skill-artifacts", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    reply.header("X-Request-Id", requestId);
    return { items: registry.listArtifacts(), request_id: requestId };
  });

  app.get("/api/v1/skills/:slug/versions", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const { slug } = request.params as { slug: string };
    // agent ??????? ? ??????????? agent ???store.listVersions ????
    // ?? #1 ???????? registry.listVersions(slug) ?? ?agent= query???????????
    const query = request.query as Record<string, string | undefined>;
    const agentResult = registryAgentSchema.safeParse(query.agent);
    if (query.agent !== undefined && !agentResult.success) {
      throw new ServerDomainError(422, "VALIDATION_FAILED", "agent query param must be a valid registry agent");
    }
    const agent = agentResult.success ? agentResult.data : undefined;
    reply.header("X-Request-Id", requestId);
    return { items: registry.listVersions(slug, agent), request_id: requestId };
  });

  app.get("/api/v1/skills/:slug/artifacts/:agent/download", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { slug, agent: agentValue } = request.params as { slug: string; agent: string };
    const agent = registryAgentSchema.parse(agentValue);
    const artifact = registry.latestArtifact(slug, agent);
    const bytes = await registry.artifactBytes(artifact);
    await writeAudit(repository, {
      actorId: actor.actorId,
      projectId: null,
      action: "skill.artifact.downloaded",
      targetId: artifact.artifact_id,
      requestId,
      details: { skill_slug: slug, version: artifact.version, agent }
    });
    reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", `attachment; filename="${slug}-${artifact.version}-${agent}.zip"`)
      .header("X-Content-SHA256", artifact.content_sha256)
      .header("ETag", artifact.content_sha256)
      .header("X-Request-Id", requestId);
    return Buffer.from(bytes);
  });

  app.post("/api/v1/skills/draft", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const query = request.query as Record<string, string | undefined>;
    const registryAgentResult = registryAgentSchema.safeParse(query.agent);
    if (!registryAgentResult.success) {
      throw new ServerDomainError(422, "VALIDATION_FAILED", "agent query param must be a valid registry agent");
    }
    const agentResult = skillTargetAgentSchema.safeParse(registryAgentResult.data);
    if (!agentResult.success) {
      throw new ServerDomainError(422, "SKILL_BUNDLE_INVALID", "agent query param must be an active Skill target agent");
    }
    const agent = agentResult.data;
    const collected: Array<{ path: string; buffer: Buffer }> = [];
    let collectedBytes = 0;
    let sensitiveReview: unknown;
    for await (const part of request.parts()) {
      if (part.type === "file") {
        const buffer = await part.toBuffer();
        collectedBytes += buffer.byteLength;
        if (collectedBytes > config.maxProposalBytes) {
          throw new ServerDomainError(413, "SKILL_UPLOAD_TOO_LARGE", "skill upload exceeds the total size limit");
        }
        collected.push({ path: part.filename ?? "file", buffer });
      } else if (part.fieldname === "sensitive_review") {
        const raw = String(part.value);
        if (Buffer.byteLength(raw, "utf8") > 16_384) {
          throw new ServerDomainError(413, "SKILL_UPLOAD_TOO_LARGE", "sensitive review payload is too large");
        }
        try {
          sensitiveReview = JSON.parse(raw);
        } catch {
          throw new ServerDomainError(422, "VALIDATION_FAILED", "sensitive_review must be valid JSON");
        }
      }
    }
    const files = resolveUploadFiles(collected, config, "SKILL_UPLOAD_TOO_LARGE");
    const review = sensitiveReview === undefined
      ? undefined
      : sensitiveReviewSubmissionSchema.parse(sensitiveReview);
    // agent ?? bodyHash?? Idempotency-Key ? agent ??? IDEMPOTENCY_KEY_REUSED ??????
    const bodyHash = sha256Bytes(canonicalJson({ agent, files: files.map((f) => ({ path: f.path, content: f.content })) }));
    const result = await mutation(request, repository, actor, requestId, async () => {
      const draft = await registry.uploadDraft({
        files,
        actorId: actor.actorId,
        agent,
        ...(review === undefined ? {} : { review })
      });
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null,
        action: draft.revision === 1 ? "skill.draft.created" : "skill.draft.updated",
        targetId: draft.slug, requestId,
        details: { slug: draft.slug, agent, draft_version: draft.draftVersion, revision: draft.revision }
      });
      return { statusCode: 201, body: draft };
    }, bodyHash);
    return send(reply, requestId, result);
  });

  app.get("/api/v1/skills/:slug/draft/:agent", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const { slug, agent: agentValue } = request.params as { slug: string; agent: string };
    const agentResult = registryAgentSchema.safeParse(agentValue);
    if (!agentResult.success) {
      throw new ServerDomainError(422, "VALIDATION_FAILED", "agent path param must be a valid registry agent");
    }
    const draft = registry.getDraft(slug, agentResult.data);
    if (draft === undefined) throw new ServerDomainError(404, SKILL_ERROR_CODE.DRAFT_NOT_FOUND, "skill draft not found", { slug, agent: agentResult.data });
    reply.header("X-Request-Id", requestId);
    return { ...draft, request_id: requestId };
  });

  app.delete("/api/v1/skills/:slug/draft/:agent", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { slug, agent: agentValue } = request.params as { slug: string; agent: string };
    const agentResult = registryAgentSchema.safeParse(agentValue);
    if (!agentResult.success) {
      throw new ServerDomainError(422, "VALIDATION_FAILED", "agent path param must be a valid registry agent");
    }
    const agent = agentResult.data;
    const result = await mutation(request, repository, actor, requestId, async () => {
      const body = z.object({ revision: z.number().int().positive() }).strict().parse(request.body);
      await registry.deleteDraft(slug, agent, body.revision);
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "skill.draft.discarded",
        targetId: slug, requestId, details: { slug, agent }
      });
      return { statusCode: 200, body: { slug, agent, discarded: true } };
    });
    return send(reply, requestId, result);
  });

  app.post("/api/v1/skills/:slug/draft/:agent/checks", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { slug, agent: agentValue } = request.params as { slug: string; agent: string };
    const agentResult = registryAgentSchema.safeParse(agentValue);
    if (!agentResult.success) {
      throw new ServerDomainError(422, "VALIDATION_FAILED", "agent path param must be a valid registry agent");
    }
    const agent = agentResult.data;
    const result = await mutation(request, repository, actor, requestId, async () => {
      const checks = await registry.runChecks({ slug, agent, checkedAt: new Date().toISOString() });
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "skill.draft.checked",
        targetId: slug, requestId, details: { slug, agent, red: checks.summary.red }
      });
      return { statusCode: 200, body: checks };
    });
    return send(reply, requestId, result);
  });

  app.post("/api/v1/skills/:slug/publish", async (request, reply) => {
    const { actor, requestId } = await ownerAuthenticated(request, repository, ownerActorId);
    const { slug } = request.params as { slug: string };
    const npmConfig = await resolveNpmPublishConfig(true);
    const rawBody = request.body as { sourceAgent?: unknown };
    const registrySourceAgentResult = registryAgentSchema.safeParse(rawBody.sourceAgent);
    if (!registrySourceAgentResult.success) {
      throw new ServerDomainError(400, "VALIDATION_FAILED", "sourceAgent must be a valid registry agent");
    }
    if (!skillTargetAgentSchema.safeParse(registrySourceAgentResult.data).success) {
      throw new ServerDomainError(422, "SKILL_BUNDLE_INVALID", "sourceAgent must be an active Skill target agent");
    }
    const body = publishUnifiedSkillRequestSchema.parse(rawBody);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const published = await registry.publishUnified({
        slug,
        version: body.version,
        sourceAgent: body.sourceAgent,
        draftRevision: body.draftRevision,
        releaseNote: body.releaseNote ?? null,
        actorId: actor.actorId
      }, npmConfig, async (input) => publishSkillNpmPackage(input, npmConfig, options.npmPublisherDeps ?? {}));
      await writeAudit(repository, {
        actorId: actor.actorId,
        projectId: null,
        action: "skill.published",
        targetId: slug,
        requestId,
        details: {
          slug,
          version: published.release.version,
          sourceAgent: body.sourceAgent,
          draftRevision: body.draftRevision,
          npmPackage: published.npmRelease.packageName,
          npmStatus: published.npmRelease.status,
          tarballHash: published.npmRelease.tarballHash
        }
      });
      return { statusCode: 200, body: published };
    });
    return send(reply, requestId, result);
  });

  app.post("/api/v1/skills/:slug/draft/:agent/publish", async (request, reply) => {
    const { actor, requestId } = await ownerAuthenticated(request, repository, ownerActorId);
    const { slug, agent: agentValue } = request.params as { slug: string; agent: string };
    const agentResult = registryAgentSchema.safeParse(agentValue);
    if (!agentResult.success) {
      throw new ServerDomainError(422, "VALIDATION_FAILED", "agent path param must be a valid registry agent");
    }
    const agent = agentResult.data;
    reply.header("Deprecation", "true");
    const result = await mutation(request, repository, actor, requestId, async () => {
      const body = publishSkillRequestSchema.parse(request.body);
      const npmConfig = await resolveNpmPublishConfig(false);
      if (isNpmPublishConfigured(npmConfig)) {
        const draft = registry.getDraft(slug, agent);
        if (draft === undefined) {
          throw new ServerDomainError(404, SKILL_ERROR_CODE.DRAFT_NOT_FOUND, "skill draft not found", { slug, agent });
        }
        await registry.publishUnified({
          slug,
          version: body.version,
          sourceAgent: agent,
          draftRevision: draft.revision,
          releaseNote: body.releaseNote ?? null,
          actorId: actor.actorId
        }, npmConfig, async (input) => publishSkillNpmPackage(input, npmConfig, options.npmPublisherDeps ?? {}));
        const projected = registry.listVersions(slug, agent)
          .find((version) => version.version === body.version);
        if (projected === undefined) throw new Error("unified publish did not create the requested compatibility projection");
        await writeAudit(repository, {
          actorId: actor.actorId, projectId: null, action: "skill.published",
          targetId: slug, requestId, details: { slug, agent, version: projected.version, lifecycle: "unified" }
        });
        return { statusCode: 200, body: projected };
      }
      // R3 ????publish???? persist(tx)?+ writeAudit(tx) ?? withTransaction?
      // audit ? registry_state ???? R3??memory fallback withTransaction no-op?????????
      // PG ?? ? registry_state/audit ??? + version ????in-memory ???? design �3.5 ?????? registry_state ????
      const version = await repository.withTransaction(async (tx) => {
        const v = await registry.publish({
          slug, agent, version: body.version, releaseNote: body.releaseNote ?? null, actorId: actor.actorId
        }, tx);
        await writeAudit(tx, {
          actorId: actor.actorId, projectId: null, action: "skill.published",
          targetId: slug, requestId, details: { slug, agent, version: v.version }
        });
        return v;
      });
      return { statusCode: 200, body: version };
    });
    return send(reply, requestId, result);
  });

  app.post("/api/v1/skills/:slug/npm-release", async (request, reply) => {
    const { actor, requestId } = await ownerAuthenticated(request, repository, ownerActorId);
    const { slug } = request.params as { slug: string };
    const npmConfig = await resolveNpmPublishConfig(true);
    reply.header("Deprecation", "true");
    const result = await mutation(request, repository, actor, requestId, async () => {
      const release = await registry.releaseSkillToNpm(
        slug,
        npmConfig,
        async (input) => publishSkillNpmPackage(input, npmConfig, options.npmPublisherDeps ?? {})
      );
      await writeAudit(repository, {
        actorId: actor.actorId,
        projectId: null,
        action: "skill.npm-released",
        targetId: slug,
        requestId,
        details: {
          slug,
          version: release.version,
          packageName: release.packageName,
          status: release.status
        }
      });
      if (release.status === "conflict") {
        throw new ServerDomainError(
          409,
          "NPM_PUBLISH_CONFLICT",
          release.error ?? "npm registry already has this package version",
          { release }
        );
      }
      if (release.status === "failed") {
        throw new ServerDomainError(
          502,
          "NPM_PUBLISH_FAILED",
          release.error ?? "npm publish failed",
          { release }
        );
      }
      return { statusCode: 200, body: { slug, release } };
    });
    return send(reply, requestId, result);
  });

  app.post("/api/v1/workflow-families/:slug/npm-release", async (request, reply) => {
    const { actor, requestId } = await ownerAuthenticated(request, repository, ownerActorId);
    const { slug } = request.params as { slug: string };
    const npmConfig = await resolveNpmPublishConfig(true);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const release = await registry.releaseFamilyToNpm(
        slug,
        npmConfig,
        async (input) => publishWorkflowFamilyNpmPackage(input, npmConfig, options.npmPublisherDeps ?? {})
      );
      await writeAudit(repository, {
        actorId: actor.actorId,
        projectId: null,
        action: "workflow.family.npm-released",
        targetId: slug,
        requestId,
        details: {
          slug,
          version: release.version,
          packageName: release.packageName,
          status: release.status
        }
      });
      if (release.status === "conflict") {
        throw new ServerDomainError(
          409,
          "NPM_PUBLISH_CONFLICT",
          release.error ?? "npm registry already has this package version",
          { release }
        );
      }
      return { statusCode: 200, body: { slug, release } };
    });
    return send(reply, requestId, result);
  });

  app.get("/api/v1/skills/:slug/draft/:agent/diff", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const { slug, agent: agentValue } = request.params as { slug: string; agent: string };
    const agentResult = registryAgentSchema.safeParse(agentValue);
    if (!agentResult.success) {
      throw new ServerDomainError(422, "VALIDATION_FAILED", "agent path param must be a valid registry agent");
    }
    const diff = registry.diffDraft(slug, agentResult.data);
    reply.header("X-Request-Id", requestId);
    return { items: diff, request_id: requestId };
  });

  // ???? agent?�3.4??mutation ??? ? setDefaultAgent??? enabled + revision ???? + ?? agents?? audit?
  // 422 AGENT_NOT_ENABLED / 409 REVISION_CONFLICT / 404 SKILL_NOT_FOUND ? store ?? ServerDomainError?????????
  app.patch("/api/v1/skills/:slug/default-agent", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { slug } = request.params as { slug: string };
    const body = setDefaultAgentRequestSchema.parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const detail = await registry.setDefaultAgent(slug, body.defaultAgent, body.revision);
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "skill.default-agent.changed",
        targetId: slug, requestId,
        details: { slug, defaultAgent: body.defaultAgent, revision: detail.revision }
      });
      return { statusCode: 200, body: detail };
    });
    return send(reply, requestId, result);
  });

  app.delete("/api/v1/skills/:slug", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { slug } = request.params as { slug: string };
    const result = await mutation(request, repository, actor, requestId, async () => {
      await registry.deleteSkill({ slug, actorId: actor.actorId });
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "skill.deleted",
        targetId: slug, requestId, details: { slug }
      });
      return { statusCode: 200, body: { slug, deleted: true } };
    });
    return send(reply, requestId, result);
  });

  app.get("/api/v1/tags", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    reply.header("X-Request-Id", requestId);
    return { items: registry.listTags(), request_id: requestId };
  });

  app.post("/api/v1/tags", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const body = tagCreateSchema.parse(request.body);
    const result = await registry.withRegistryMutation(() =>
      mutation(request, repository, actor, requestId, async () => {
        const tag = registry.createTag(body);
        await registry.persist();
        await writeAudit(repository, {
          actorId: actor.actorId, projectId: null, action: "tag.created",
          targetId: tag.tag_id, requestId, details: { slug: tag.slug }
        });
        return { statusCode: 201, body: tag };
      })
    );
    return send(reply, requestId, result);
  });

  app.patch("/api/v1/tags/:tagId", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { tagId } = request.params as { tagId: string };
    const body = tagUpdateSchema.parse(request.body);
    const result = await registry.withRegistryMutation(() =>
      mutation(request, repository, actor, requestId, async () => {
        const tag = registry.updateTag(tagId, body);
        await registry.persist();
        await writeAudit(repository, {
          actorId: actor.actorId, projectId: null, action: "tag.updated",
          targetId: tagId, requestId, details: { revision: tag.revision }
        });
        return { statusCode: 200, body: tag };
      })
    );
    return send(reply, requestId, result);
  });

  app.post("/api/v1/tags/:tagId/merge", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { tagId } = request.params as { tagId: string };
    const body = tagMergeSchema.parse(request.body);
    const result = await registry.withRegistryMutation(() =>
      mutation(request, repository, actor, requestId, async () => {
        const source = registry.mergeTag(tagId, body.target_tag_id, body.revision);
        await registry.persist();
        await writeAudit(repository, {
          actorId: actor.actorId, projectId: null, action: "tag.merged",
          targetId: tagId, requestId, details: { target_tag_id: body.target_tag_id }
        });
        return { statusCode: 200, body: { ...source, merged_into: body.target_tag_id } };
      })
    );
    return send(reply, requestId, result);
  });

  for (const method of ["PUT", "DELETE"] as const) {
    app.route({
      method,
      url: "/api/v1/skills/:slug/tags/:tagId",
      handler: async (request, reply) => {
        const { actor, requestId } = await authenticated(request, repository);
        const { slug, tagId } = request.params as { slug: string; tagId: string };
        const result = await registry.withRegistryMutation(() =>
          mutation(request, repository, actor, requestId, async () => {
            const skill = registry.bindTag(slug, tagId, method === "DELETE");
            await registry.persist();
            await writeAudit(repository, {
              actorId: actor.actorId, projectId: null,
              action: method === "DELETE" ? "skill.tag.removed" : "skill.tag.bound",
              targetId: skill.skill_id, requestId, details: { tag_id: tagId }
            });
            return { statusCode: 200, body: skill };
          })
        );
        return send(reply, requestId, result);
      }
    });
  }

  app.get("/api/v1/workflow-families", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    reply.header("X-Request-Id", requestId);
    return { items: registry.listWorkflowFamilies(), request_id: requestId };
  });

  app.get("/api/v1/agent-tools", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    reply.header("X-Request-Id", requestId);
    return { items: registry.listAgentTools(), request_id: requestId };
  });

  app.post("/api/v1/agent-tools", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const body = agentToolMutationSchema.extend({ schema_version: z.literal(1) }).strict().parse(request.body);
    const result = await registry.withFeatureMutation(() =>
      transactionalMutation(request, repository, actor, requestId, async (tx) => {
        const tool = await registry.createAgentTool({
        slug: body.slug,
        displayName: body.displayName,
        description: body.description,
        category: body.category,
        status: body.status,
        source: body.source,
        homepage: body.homepage ?? null,
        packageName: body.packageName ?? null,
        installCommand: body.installCommand ?? null,
        tags: body.tags,
          relatedWorkflowFamilies: body.relatedWorkflowFamilies
        }, tx);
        await writeAudit(tx, {
          actorId: actor.actorId,
          projectId: null,
          action: "agent-tool.created",
          targetId: tool.tool_id,
          requestId,
          details: { slug: tool.slug, category: tool.category, source: tool.source }
        });
        return { statusCode: 201, body: tool };
      })
    );
    return send(reply, requestId, result);
  });

  app.post("/api/v1/agent-tools/import/inspect", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const body = inspectAgentToolGithubRequestSchema.parse(request.body);
    const inspection = await registry.inspectAgentToolGithub(body.github_url);
    reply.header("X-Request-Id", requestId);
    return { ...inspection, request_id: requestId };
  });

  app.post("/api/v1/agent-tools/import/ai-prefill", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const body = generateAgentToolPrefillRequestSchema.parse(request.body);
    const resolved = await resolveAgentLlmClient("generic");
    if (resolved === null) {
      throw new ServerDomainError(422, "AI_NOT_CONFIGURED", "no API provider or Codex account is available");
    }
    checkAgentQuota(resolved);
    const prompt = buildAgentToolPrefillPrompt(body.inspection);
    let response: Awaited<ReturnType<LlmClient["analyze"]>>;
    try {
      response = await resolved.client.analyze(prompt);
    } catch {
      throw new ServerDomainError(502, "AI_GENERATION_FAILED", "agent registration draft generation failed");
    }
    await recordAgentUsage(resolved, response.usage);
    let draft = parseAgentToolPrefill(response.content);
    if (draft === null) {
      checkAgentQuota(resolved);
      let repaired: Awaited<ReturnType<LlmClient["analyze"]>>;
      try {
        repaired = await resolved.client.analyze({
          system: prompt.system + "\n上一次响应不符合结构或中文描述要求。请严格修正，只返回合法 JSON。",
          user: [prompt.user, "<invalid_response>", response.content.slice(0, 12_000), "</invalid_response>"].join("\n")
        });
      } catch {
        throw new ServerDomainError(502, "AI_GENERATION_FAILED", "agent registration draft repair failed");
      }
      await recordAgentUsage(resolved, repaired.usage);
      draft = parseAgentToolPrefill(repaired.content);
    }
    if (draft === null) {
      throw new ServerDomainError(502, "AI_PARSE_FAILED", "agent registration draft was not valid structured Chinese content");
    }
    reply.header("X-Request-Id", requestId);
    return {
      ...draft,
      // 来源由仓库读取结果确定，不允许模型改写或跳转到其他地址。
      source: body.inspection.source
    };
  });

  app.get("/api/v1/agent-tools/:slug", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const { slug } = request.params as { slug: string };
    reply.header("X-Request-Id", requestId);
    return { ...registry.getAgentTool(slug), request_id: requestId };
  });

  app.post("/api/v1/workflow-families/import/inspect", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const body = inspectWorkflowFamilySourceRequestSchema.parse(request.body);
    const inspection = await registry.inspectWorkflowFamilySource(body.source);
    reply.header("X-Request-Id", requestId);
    return { ...inspection, request_id: requestId };
  });

  app.post("/api/v1/workflow-families/import", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const body = importWorkflowFamilySourceRequestSchema.parse(request.body);
    const result = await preparedTransactionalMutation(
      request,
      repository,
      actor,
      requestId,
      () => registry.prepareWorkflowFamilySourceImport(body),
      async (prepared, tx) => {
        const imported = await registry.commitWorkflowFamilySourceImport(prepared, tx);
        await writeAudit(tx, {
          actorId: actor.actorId,
          projectId: null,
          action: "workflow.family.imported",
          targetId: imported.family.family_id,
          requestId,
          details: {
            slug: imported.family.slug,
            source: imported.family.source,
            profiles: imported.family.required_profiles
          }
        });
        return { statusCode: 201, body: imported };
      },
      (commit) => registry.withFeatureMutation(commit)
    );
    return send(reply, requestId, result);
  });

  app.post("/api/v1/workflow-families", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const body = workflowFamilyMutationSchema.extend({ schema_version: z.literal(1) }).strict().parse(request.body);
    const result = await registry.withFeatureMutation(() =>
      transactionalMutation(request, repository, actor, requestId, async (tx) => {
        const family = registry.createWorkflowFamily({
        slug: body.slug,
        displayName: body.displayName,
        description: body.description,
        tags: body.tags,
        required_profiles: body.required_profiles,
          ...(body.source === undefined ? {} : { source: body.source })
        });
        await registry.persist(tx);
        await writeAudit(tx, {
          actorId: actor.actorId, projectId: null, action: "workflow.family.created",
          targetId: family.family_id, requestId, details: { slug: family.slug }
        });
        return { statusCode: 201, body: family };
      })
    );
    return send(reply, requestId, result);
  });

  app.post("/api/v1/workflow-families/:slug/sync", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { slug } = request.params as { slug: string };
    const family = registry.getWorkflowFamily(slug);
    const result = await preparedTransactionalMutation(
      request,
      repository,
      actor,
      requestId,
      () => registry.prepareWorkflowFamilySourceSync(slug),
      async (prepared, tx) => {
        const synced = await registry.commitWorkflowFamilySourceSync(prepared, tx);
        await writeAudit(tx, {
          actorId: actor.actorId,
          projectId: null,
          action: "workflow.family.synced",
          targetId: family.family_id,
          requestId,
          details: { slug, ...synced }
        });
        return { statusCode: 200, body: synced };
      },
      (commit) => registry.withFeatureMutation(commit)
    );
    return send(reply, requestId, result);
  });

  app.get("/api/v1/workflow-families/:slug", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const { slug } = request.params as { slug: string };
    reply.header("X-Request-Id", requestId);
    return { ...registry.getWorkflowFamily(slug), request_id: requestId };
  });

  app.get("/api/v1/projects/:projectId/workflow-binding", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId } = request.params as { projectId: string };
    await repository.getProject(actor.actorId, projectId);
    reply.header("X-Request-Id", requestId);
    return { binding: registry.getProjectBinding(projectId), request_id: requestId };
  });

  // P3: server-side knowledge ingest — idempotent batch upsert with content-hash
  // dedupe; projection into the semantic index runs asynchronously (outbox drain).
  app.post("/api/v1/projects/:projectId/knowledge/ingest", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository, "knowledge:write");
    const { projectId } = request.params as { projectId: string };
    await repository.getProject(actor.actorId, projectId);
    const body = z.object({
      schema_version: z.literal(1),
      entries: z.array(knowledgeIngestEntrySchema).min(1).max(200)
    }).strict().parse(request.body);
    const counts = { created: 0, updated: 0, duplicate: 0 };
    for (const entry of body.entries) {
      // Hash the inbound entry (pre-adjudication) so confidence timestamps do not break dedupe.
      const contentSha256 = knowledgeContentHash(entry);
      const prepared = prepareKnowledgeIngestPayload(entry);
      const outcome = await repository.upsertKnowledgeEntry({
        projectId,
        entryId: entry.id,
        contentSha256,
        payload: prepared.payload,
        status: prepared.status
      });
      counts[outcome] += 1;
    }
    // Fire-and-forget outbox drain; ingest durability does not depend on it.
    void projectPendingKnowledge(repository, semanticStore, projectId).catch((error) => {
      app.log.error({ error, projectId }, "knowledge projection failed");
    });
    reply.header("X-Request-Id", requestId);
    return reply.code(202).send({
      accepted: body.entries.length,
      created: counts.created,
      updated: counts.updated,
      duplicates: counts.duplicate,
      request_id: requestId
    });
  });

  // Raw ingested entries (candidate review works on these, not the projection).
  app.get("/api/v1/projects/:projectId/knowledge/entries", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId } = request.params as { projectId: string };
    await repository.getProject(actor.actorId, projectId);
    const query = z.object({
      status: z.string().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50)
    }).strict().parse(request.query);
    const items = await repository.listKnowledgeEntries({
      projectId,
      ...(query.status === undefined ? {} : { status: query.status }),
      limit: query.limit
    });
    const pending = await repository.listUnprojectedKnowledge(projectId, 500);
    reply.header("X-Request-Id", requestId);
    return {
      items: items.map((item) => ({
        entry_id: item.entryId,
        status: item.status,
        content_sha256: item.contentSha256,
        payload: item.payload,
        updated_at: item.updatedAt,
        projected_at: item.projectedAt
      })),
      projected_pending: pending.length,
      request_id: requestId
    };
  });

  app.get("/api/v1/projects/:projectId/knowledge/projection-status", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId } = request.params as { projectId: string };
    await repository.getProject(actor.actorId, projectId);
    const pending = await repository.listUnprojectedKnowledge(projectId, 500);
    reply.header("X-Request-Id", requestId);
    // P0-1 查询面自查：ingest 回执与真实查询面之间的缺口需要可诊断——
    // fence 代数、job 状态计数、结果条目数一并给出（有 pipeline 时）。
    const pipeline = options.knowledgePipeline === undefined
      ? undefined
      : await options.knowledgePipeline.pipelineStatus(projectId);
    return {
      pending_count: pending.length,
      pending_capped: pending.length >= 500,
      ...(pipeline === undefined ? {} : { pipeline }),
      request_id: requestId
    };
  });

  // Candidate adjudication: approve -> active, reject -> deprecated (server-side judge).
  app.post("/api/v1/projects/:projectId/knowledge/entries/:entryId/status", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId, entryId } = request.params as { projectId: string; entryId: string };
    await repository.getProject(actor.actorId, projectId);
    const body = z.object({
      status: z.enum(["candidate", "active", "stale", "superseded", "deprecated", "conflicted"])
    }).strict().parse(request.body);
    const updated = await repository.updateKnowledgeStatus(projectId, entryId, body.status);
    if (updated === null) {
      throw new ServerDomainError(404, "KNOWLEDGE_ENTRY_NOT_FOUND", "knowledge entry not found");
    }
    void projectPendingKnowledge(repository, semanticStore, projectId).catch((error) => {
      app.log.error({ error, projectId }, "knowledge projection failed");
    });
    reply.header("X-Request-Id", requestId);
    return {
      entry_id: updated.entryId,
      status: updated.status,
      updated_at: updated.updatedAt,
      request_id: requestId
    };
  });

  app.get("/api/v1/projects/:projectId/semantic/overview", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId } = request.params as { projectId: string };
    await repository.getProject(actor.actorId, projectId);
    await ensureSemanticIndexCurrent(actor.actorId, projectId);
    reply.header("X-Request-Id", requestId);
    return { ...(await semanticStore.overview(projectId)), request_id: requestId };
  });

  app.get("/api/v1/projects/:projectId/semantic/knowledge", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId } = request.params as { projectId: string };
    await repository.getProject(actor.actorId, projectId);
    await ensureSemanticIndexCurrent(actor.actorId, projectId);
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      cursor: z.string().min(1).optional(),
      include_body: z.enum(["0", "1"]).optional()
    }).strict().parse(request.query);
    const all = await semanticStore.listByKinds(projectId, ["knowledge_entry", "knowledge_markdown"]);
    const offset = query.cursor === undefined
      ? 0
      : Number.parseInt(Buffer.from(query.cursor, "base64url").toString("utf8"), 10);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new ServerDomainError(400, "INVALID_CURSOR", "cursor is invalid");
    }
    const page = all.slice(offset, offset + query.limit);
    const includeBody = query.include_body === "1";
    const items = page.map((document) => includeBody
      ? document
      : { ...document, body: "" });
    const nextOffset = offset + page.length;
    reply.header("X-Request-Id", requestId);
    return {
      items,
      total: all.length,
      next_cursor: nextOffset < all.length
        ? Buffer.from(String(nextOffset)).toString("base64url")
        : null,
      request_id: requestId
    };
  });

  app.post("/api/v1/projects/:projectId/semantic/knowledge/:documentId/deprecate", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId, documentId } = request.params as { projectId: string; documentId: string };
    await repository.getProject(actor.actorId, projectId);
    const document = await semanticStore.getDocument(projectId, documentId);
    if (document === null || document.kind !== "knowledge_entry") {
      throw new ServerDomainError(404, "KNOWLEDGE_DOCUMENT_NOT_FOUND", "knowledge document not found");
    }
    const entryId = typeof document.metadata.entry_id === "string" ? document.metadata.entry_id : null;
    if (entryId === null) {
      throw new ServerDomainError(422, "KNOWLEDGE_ENTRY_MISSING", "document is not backed by an ingest entry");
    }
    const updated = await repository.updateKnowledgeStatus(projectId, entryId, "deprecated");
    if (updated === null) {
      throw new ServerDomainError(404, "KNOWLEDGE_ENTRY_NOT_FOUND", "knowledge entry not found");
    }
    await projectPendingKnowledge(repository, semanticStore, projectId);
    reply.header("X-Request-Id", requestId);
    return {
      document_id: documentId,
      entry_id: entryId,
      status: "deprecated",
      request_id: requestId
    };
  });

  app.post("/api/v1/projects/:projectId/semantic/knowledge/:documentId/revive", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId, documentId } = request.params as { projectId: string; documentId: string };
    await repository.getProject(actor.actorId, projectId);
    const document = await semanticStore.getDocument(projectId, documentId);
    if (document === null || document.kind !== "knowledge_entry") {
      throw new ServerDomainError(404, "KNOWLEDGE_DOCUMENT_NOT_FOUND", "knowledge document not found");
    }
    const entryId = typeof document.metadata.entry_id === "string" ? document.metadata.entry_id : null;
    if (entryId === null) {
      throw new ServerDomainError(422, "KNOWLEDGE_ENTRY_MISSING", "document is not backed by an ingest entry");
    }
    const updated = await repository.updateKnowledgeStatus(projectId, entryId, "active");
    if (updated === null) {
      throw new ServerDomainError(404, "KNOWLEDGE_ENTRY_NOT_FOUND", "knowledge entry not found");
    }
    // Revive explicitly overwrites sticky deprecated on the next content upsert.
    await repository.upsertKnowledgeEntry({
      projectId,
      entryId,
      contentSha256: updated.contentSha256,
      payload: { ...updated.payload, status: "active" },
      status: "active",
      allowDeprecatedOverwrite: true
    });
    await projectPendingKnowledge(repository, semanticStore, projectId);
    reply.header("X-Request-Id", requestId);
    return {
      document_id: documentId,
      entry_id: entryId,
      status: "active",
      request_id: requestId
    };
  });

  app.post(
    "/api/v1/projects/:projectId/instruction-proposals",
    async (request, reply) => {
      const { actor, requestId } = await authenticated(request, repository, "push");
      const { projectId } = request.params as { projectId: string };
      const project = await repository.getProject(actor.actorId, projectId);
      const body = instructionProposalRequestSchema.parse(request.body);
      const serverRecentChanges = await loadServerRecentChanges({
        actorId: actor.actorId,
        projectId,
        repository,
        storage
      });
      const result = await mutation(request, repository, actor, requestId, async () => {
        const proposal = buildInstructionProposal({
          projectId,
          projectName: project.displayName,
          request: {
            ...body,
            recent_changes: mergeRecentChanges(serverRecentChanges, body.recent_changes)
          }
        });
        await writeAudit(repository, {
          actorId: actor.actorId,
          projectId,
          action: "instructions.proposed",
          targetId: proposal.proposal_id,
          requestId,
          details: {
            finding_count: proposal.findings.length,
            file_count: proposal.files.length,
            rule_candidate_count: proposal.rule_candidates.length,
            language: proposal.language
          }
        });
        return { statusCode: 201, body: { ...proposal } };
      });
      return send(reply, requestId, result);
    }
  );

  app.put(
    "/api/v1/projects/:projectId/changes/:changeKey/archive-package",
    async (request, reply) => {
      const { actor, requestId } = await authenticated(request, repository, "push");
      const { projectId, changeKey } = request.params as { projectId: string; changeKey: string };
      requireArchiveChangeKey(changeKey);
      const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/zip" || !Buffer.isBuffer(request.body)) {
        throw new ServerDomainError(
          415,
          "ARCHIVE_MEDIA_TYPE_UNSUPPORTED",
          "archive upload must use application/zip"
        );
      }
      const result = await mutation(request, repository, actor, requestId, async () => {
        let receipt = await ingestArchivePackage({
          actorId: actor.actorId,
          projectId,
          changeKey,
          bytes: request.body as Buffer,
          repository,
          storage,
          semanticStore,
          limits: {
            maxFileBytes: config.maxFileBytes,
            maxUploadFiles: config.maxUploadFiles,
            maxPackageBytes: config.maxProposalBytes,
            maxUncompressedBytes: config.maxProposalBytes
          },
          sessionTtlMs: config.sessionTtlMs,
          maxChunkBytes: config.maxChunkBytes,
          projectLockHeld: true
        });
        // 06A 知识队列入队（best-effort）：失败只告警，旧 in-process 投影仍是当前主路径。
        // 这条路由收的是生产归档器（harness_archive.py）产出的 core-v1 包。此前它被
        // v2 校验器在第一道闸就拒掉，错误又被这里的 catch 咽成一条 warn，于是队列
        // 从未收到过任何作业——change_documents 与 results 长期为空的真正原因。
        // 现在把入队结果显式带回收据：客户端能看到知识提取是否真的进了队列，而不是
        // 只看到旧的 in-process 语义投影状态。
        let knowledgeEnqueue: { status: "enqueued" | "skipped" | "failed"; reason_code?: string } = {
          status: "skipped",
          reason_code: "KNOWLEDGE_PIPELINE_DISABLED"
        };
        if (options.knowledgePipeline !== undefined) {
          try {
            const manifestEntry = new AdmZip(request.body as Buffer).getEntry("archive-manifest.json");
            const projectVersion =
              (await repository.getProject(actor.actorId, projectId)).latestProjectVersion;
            if (manifestEntry === null) {
              knowledgeEnqueue = { status: "skipped", reason_code: "ARCHIVE_MANIFEST_MISSING" };
            } else if (projectVersion === null) {
              // 宁可不入队，也不为了凑一个 NOT NULL 列去编造 as-of 版本。
              knowledgeEnqueue = { status: "skipped", reason_code: "PROJECT_VERSION_MISSING" };
              request.log.warn(
                { project_id: projectId, change_key: changeKey },
                "knowledge enqueue skipped: project has no version to file the archive against");
            } else {
              const validated = validateArchivePackageByProfile({
                packageBytes: new Uint8Array(request.body as Buffer),
                manifestBytes: new Uint8Array(manifestEntry.getData()),
                identity: {
                  project_id: projectId,
                  change_key: changeKey,
                  // 服务端在同一个请求里铸出的真实 id，不依赖客户端 manifest 自称。
                  archive_id: receipt.archive_id,
                  project_version: projectVersion
                },
                limits: {
                  max_package_bytes: config.maxProposalBytes,
                  max_file_count: config.maxUploadFiles + 1,
                  max_file_bytes: config.maxFileBytes,
                  max_uncompressed_bytes: config.maxProposalBytes,
                  max_compression_ratio: 100
                },
                validatedAt: new Date().toISOString()
              });
              if (validated === null) {
                knowledgeEnqueue = { status: "skipped", reason_code: "ARCHIVE_IDENTITY_MISMATCH" };
                request.log.warn({ project_id: projectId, change_key: changeKey },
                  "archive manifest identity differs from route binding; knowledge enqueue skipped");
              } else {
                await options.knowledgePipeline.acceptArchive({
                  schema_version: 1,
                  request_id: knowledgeArchiveRequestId({
                    project_id: validated.project_id,
                    change_key: validated.change_key,
                    archive_id: validated.archive_id,
                    package_sha256: validated.package_sha256
                  }),
                  validated_package: validated,
                  extractor_version: KNOWLEDGE_PIPELINE_EXTRACTOR_VERSION,
                  prompt_version: KNOWLEDGE_PIPELINE_PROMPT_VERSION,
                  index_schema_version: KNOWLEDGE_PIPELINE_INDEX_SCHEMA_VERSION
                });
                knowledgeEnqueue = { status: "enqueued" };
              }
            }
          } catch (error) {
            const reasonCode = error instanceof Error && /^[A-Z][A-Z0-9_]{0,127}$/u.test(error.message)
              ? error.message
              : "KNOWLEDGE_ENQUEUE_FAILED";
            knowledgeEnqueue = {
              status: "failed",
              reason_code: reasonCode
            };
            // The ZIP and legacy semantic projection are durable, but the requested
            // knowledge extraction was not admitted. Do not leave a permanently
            // misleading `indexing` receipt for clients or the query projection.
            const archiveRecord = await repository.getChangeArchivePackage(
              actor.actorId, projectId, changeKey
            );
            receipt = archivePackageReceipt(await repository.updateChangeArchivePackage({
              actorId: actor.actorId,
              projectId,
              changeKey,
              artifactId: archiveRecord.artifactId,
              knowledgeStatus: "failed",
              failureStage: "knowledge_enqueue",
              lastErrorCode: reasonCode
            }));
            request.log.warn({ err: error, reason_code: reasonCode },
              "knowledge queue enqueue failed; archive receipt marked failed");
          }
        }
        await writeAudit(repository, {
          actorId: actor.actorId,
          projectId,
          action: "change_archive.uploaded",
          targetId: receipt.archive_id,
          requestId,
          details: {
            change_key: changeKey,
            package_sha256: receipt.package_sha256,
            stored_files: receipt.stored_files,
            knowledge_status: receipt.knowledge_status,
            knowledge_enqueue: knowledgeEnqueue
          }
        });
        return { statusCode: 201, body: { ...receipt, knowledge_enqueue: knowledgeEnqueue } };
      }, undefined, {
        actorId: "internal:archive-package",
        method: "ARCHIVE",
        path: "/internal/archive-package/project",
        key: projectId
      });
      return send(reply, requestId, result);
    }
  );

  // 只读预检：跑与 PUT 完全相同的包校验（含 summary CLI schema 2.2/2.3），
  // 但不落盘、不入队、不写审计。配合 422 details 里的字段级 issues，CLI 可以
  // 在正式上传前以最低成本定位并修掉 schema 违规，而不必用 probe-* change key
  // 污染正式收据。
  app.post(
    "/api/v1/projects/:projectId/changes/:changeKey/archive-package/validate",
    async (request, reply) => {
      const { actor, requestId } = await authenticated(request, repository, "push");
      const { projectId, changeKey } = request.params as { projectId: string; changeKey: string };
      requireArchiveChangeKey(changeKey);
      const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/zip" || !Buffer.isBuffer(request.body)) {
        throw new ServerDomainError(
          415,
          "ARCHIVE_MEDIA_TYPE_UNSUPPORTED",
          "archive upload must use application/zip"
        );
      }
      // 不存在的项目与 PUT 一样先 404，避免 validate 变成项目枚举探针。
      await repository.getProject(actor.actorId, projectId);
      const validated = validateIngestArchivePackage(changeKey, request.body as Buffer, {
        maxFileBytes: config.maxFileBytes,
        maxUploadFiles: config.maxUploadFiles,
        maxPackageBytes: config.maxProposalBytes,
        maxUncompressedBytes: config.maxProposalBytes
      });
      return send(reply, requestId, {
        statusCode: 200,
        body: {
          schema_version: 1,
          ok: true,
          project_id: projectId,
          change_key: changeKey,
          package_sha256: validated.packageSha256,
          manifest_sha256: validated.manifestSha256,
          file_count: validated.files.length,
          request_id: requestId
        }
      });
    }
  );

  app.get(
    "/api/v1/projects/:projectId/changes/:changeKey/archive-package",
    async (request, reply) => {
      const { actor, requestId } = await authenticated(request, repository, "files:read");
      const { projectId, changeKey } = request.params as { projectId: string; changeKey: string };
      requireArchiveChangeKey(changeKey);
      const record = await repository.getChangeArchivePackage(actor.actorId, projectId, changeKey);
      reply.header("X-Request-Id", requestId);
      return { ...archivePackageReceipt(record), request_id: requestId };
    }
  );

  app.get(
    "/api/v1/projects/:projectId/changes/:changeKey/archive-package/download",
    async (request, reply) => {
      const { actor, requestId } = await authenticated(request, repository, "files:read");
      const { projectId, changeKey } = request.params as { projectId: string; changeKey: string };
      requireArchiveChangeKey(changeKey);
      const record = await repository.getChangeArchivePackage(actor.actorId, projectId, changeKey);
      const bytes = await storage.getBlob(record.packageSha256);
      if (sha256Bytes(bytes) !== record.packageSha256) {
        throw new ServerDomainError(500, "ARCHIVE_STORAGE_CORRUPT", "stored archive hash mismatch");
      }
      reply.header("X-Request-Id", requestId);
      reply.header("X-Content-SHA256", record.packageSha256);
      reply.header("Content-Type", "application/zip");
      reply.header(
        "Content-Disposition",
        `attachment; filename="${encodeURIComponent(changeKey)}.zip"`
      );
      return reply.send(Buffer.from(bytes));
    }
  );

  // 06B-3 T0-4 冻结的 canonical Archive publish seam（stage 02 ArchiveSyncReceipt）。
  // legacy /archive-package 保持旧语义；本路由不复用其收据形状，不反向冒充。
  app.post(
    "/api/v1/projects/:projectId/archives:ingest",
    async (request, reply) => {
      const { actor, requestId } = await authenticated(request, repository, "archive:write");
      const { projectId } = request.params as { projectId: string };
      const protocolHeader = (name: string): string => {
        const value = request.headers[name];
        if (typeof value !== "string" || value.trim() === "" || value.length > 240) {
          throw new ServerDomainError(400, "ARCHIVE_INGEST_INPUT_INVALID", `missing or invalid ${name}`);
        }
        return value;
      };
      const archiveRequestId = protocolHeader("x-archive-request-id");
      const archiveId = protocolHeader("x-archive-id");
      const changeKey = protocolHeader("x-archive-change-key");
      requireArchiveChangeKey(changeKey);
      const schemaVersion = protocolHeader("x-archive-schema-version");
      if (schemaVersion !== "1") {
        throw new ServerDomainError(400, "ARCHIVE_INGEST_INPUT_INVALID", "archive_schema_version must be 1");
      }
      const packageSha256 = protocolHeader("x-archive-package-sha256");
      if (!/^sha256:[a-f0-9]{64}$/u.test(packageSha256)) {
        throw new ServerDomainError(400, "ARCHIVE_INGEST_INPUT_INVALID", "package_sha256 must be sha256 hex");
      }
      const protocolIdempotency = protocolHeader("x-archive-idempotency-key");
      // 传输绑定：服务端自行推导 idempotency 并与协议头比对，拒绝冒充
      const derivedIdempotency = sha256Bytes(Buffer.from(canonicalJson({
        project_id: projectId,
        change_key: changeKey,
        archive_schema_version: 1,
        package_sha256: packageSha256,
        archive_id: archiveId
      }), "utf8"));
      if (derivedIdempotency !== protocolIdempotency) {
        throw new ServerDomainError(409, "ARCHIVE_INGEST_IDENTITY_MISMATCH",
          "idempotency key does not match derived identity");
      }
      const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/zip" || !Buffer.isBuffer(request.body)) {
        throw new ServerDomainError(415, "ARCHIVE_MEDIA_TYPE_UNSUPPORTED",
          "archives:ingest must use application/zip");
      }
      const bytes = request.body as Buffer;
      if (sha256Bytes(bytes) !== packageSha256) {
        throw new ServerDomainError(422, "ARCHIVE_PACKAGE_HASH_MISMATCH",
          "package bytes do not match declared package_sha256");
      }
      const result = await mutation(request, repository, actor, requestId, async () => {
        // v2 包的耐久存储：blob + 归档行（幂等）。不走 legacy 内容验证管道
        // （那是 core-v1 manifest/role 格式，v2 验证职责在客户端 outbox/verifier）。
        // knowledge 索引是后台职责（06B-3：嵌套失败不回滚 receipt）。
        await storage.putBlob(packageSha256, bytes);
        const stored = await repository.putChangeArchivePackage({
          actorId: actor.actorId,
          projectId,
          changeKey,
          packageSha256,
          manifestSha256: sha256Bytes(canonicalJson({ archive_id: archiveId, package_sha256: packageSha256 })),
          coreContentSha256: [packageSha256],
          storedFiles: 1
        });
        const project = await repository.getProject(actor.actorId, projectId);
        if (project.latestProjectVersion === null) {
          throw new ServerDomainError(409, "ARCHIVE_VERSION_UNAVAILABLE",
            "project has no artifact version anchor yet");
        }
        const syncReceipt = {
          schema_version: 1 as const,
          request_id: archiveRequestId,
          idempotency_key: derivedIdempotency,
          project_id: projectId,
          archive_id: archiveId,
          change_key: changeKey,
          package_sha256: packageSha256,
          archive_status: "stored" as const,
          // as-of 版本语义：项目当前 artifact 版本（ingest 本身不制造新版本）
          project_version: project.latestProjectVersion,
          stored_at: stored.record.updatedAt,
          retryable: false as const
        };
        return { statusCode: 201, body: syncReceipt };
      }, undefined, {
        actorId: "internal:archives-ingest",
        method: "ARCHIVE",
        path: "/internal/archives-ingest/project",
        key: `${projectId}:${derivedIdempotency.slice(7, 39)}`
      });
      // mutation 框架会用传输 request_id 覆写 body.request_id；协议 request_id
      // 是 06B-3 adapter 的绑定字段，必须恢复（含幂等 replay 路径）
      result.body = { ...result.body, request_id: archiveRequestId };
      // 06B-3 补齐：耐久存储后 best-effort 入队变更投影/知识提取任务（对齐 legacy
      // /archive-package 语义）。嵌套失败只告警不回滚 receipt；manifest 身份与
      // 路由绑定不一致时跳过，避免把任务挂到错误项目。
      if (options.knowledgePipeline !== undefined) {
        try {
          const manifestEntry = new AdmZip(request.body as Buffer).getEntry("archive-manifest.json");
          // 本路由已在 ARCHIVE_VERSION_UNAVAILABLE 处 409，这里的 null 分支实际
          // 不可达，保留只为让 as-of 版本的来源在两条路由上写法一致。
          const projectVersion =
            (await repository.getProject(actor.actorId, projectId)).latestProjectVersion;
          if (manifestEntry === null) {
            // 不是归档包形态，没有可入队的东西。
          } else if (projectVersion === null) {
            request.log.warn(
              { project_id: projectId, change_key: changeKey },
              "knowledge enqueue skipped: project has no version to file the archive against");
          } else {
            // 身份由路由绑定给出（core-v1 manifest 不含服务端 id）；manifest 自称的
            // change_key 与路由不一致时由校验器 fail closed。
            const validated = validateArchivePackageByProfile({
              packageBytes: new Uint8Array(request.body as Buffer),
              manifestBytes: new Uint8Array(manifestEntry.getData()),
              identity: {
                project_id: projectId,
                change_key: changeKey,
                archive_id: archiveId,
                project_version: projectVersion
              },
              limits: {
                max_package_bytes: config.maxProposalBytes,
                max_file_count: config.maxUploadFiles + 1,
                max_file_bytes: config.maxFileBytes,
                max_uncompressed_bytes: config.maxProposalBytes,
                max_compression_ratio: 100
              },
              validatedAt: new Date().toISOString()
            });
            if (validated === null) {
              request.log.warn(
                { project_id: projectId, change_key: changeKey },
                "archives:ingest manifest identity differs from route binding; knowledge enqueue skipped"
              );
            } else {
              await options.knowledgePipeline.acceptArchive({
                schema_version: 1,
                request_id: knowledgeArchiveRequestId({
                  project_id: validated.project_id,
                  change_key: validated.change_key,
                  archive_id: validated.archive_id,
                  package_sha256: validated.package_sha256
                }),
                validated_package: validated,
                extractor_version: KNOWLEDGE_PIPELINE_EXTRACTOR_VERSION,
                prompt_version: KNOWLEDGE_PIPELINE_PROMPT_VERSION,
                index_schema_version: KNOWLEDGE_PIPELINE_INDEX_SCHEMA_VERSION
              });
            }
          }
        } catch (error) {
          request.log.warn({ err: error },
            "knowledge queue enqueue failed after archives:ingest; receipt remains authoritative");
        }
      }
      return send(reply, requestId, result);
    }
  );

  app.get("/api/v1/projects/:projectId/changes/:changeKey/archive", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository, "files:read");
    const { projectId, changeKey } = request.params as { projectId: string; changeKey: string };
    requireArchiveChangeKey(changeKey);
    await repository.getProject(actor.actorId, projectId);
    const files = await repository.listProjectFiles(actor.actorId, projectId);
    const prefix = archiveRootPrefix(changeKey);
    const archive = buildChangeArchive({
      changeKey,
      files: files
        .filter((file) => file.path.startsWith(prefix))
        .map((file) => ({
          path: file.path,
          sizeBytes: file.sizeBytes,
          updatedAt: file.updatedAt
        }))
    });
    reply.header("X-Request-Id", requestId);
    return { ...archive, request_id: requestId };
  });

  app.get("/api/v1/projects/:projectId/changes/:changeKey/archive/content", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository, "files:read");
    const { projectId, changeKey } = request.params as { projectId: string; changeKey: string };
    requireArchiveChangeKey(changeKey);
    await repository.getProject(actor.actorId, projectId);
    const query = z.object({
      path: z.string().min(1)
    }).strict().parse(request.query);
    let absolutePath: string;
    try {
      absolutePath = resolveArchiveContentPath(changeKey, query.path);
    } catch {
      throw new ServerDomainError(400, "ARCHIVE_PATH_INVALID", "archive path is invalid");
    }
    const file = await repository.getProjectFile(actor.actorId, projectId, absolutePath);
    const bytes = await storage.getBlob(file.contentSha256);
    if (bytes.byteLength !== file.sizeBytes || sha256Bytes(bytes) !== file.contentSha256) {
      throw new ServerDomainError(
        500,
        "ARCHIVE_STORAGE_CORRUPT",
        "stored archive content does not match its repository metadata"
      );
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ServerDomainError(422, "PROJECT_FILE_INVALID", "archive file is not UTF-8 text");
    }
    reply.header("X-Request-Id", requestId);
    return {
      changeKey,
      path: query.path.replaceAll("\\", "/").replace(/^\/+/, "").startsWith(".harness/")
        ? query.path
        : query.path,
      sizeBytes: file.sizeBytes,
      content,
      request_id: requestId
    };
  });

  app.get("/api/v1/projects/:projectId/semantic/rules", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId } = request.params as { projectId: string };
    await repository.getProject(actor.actorId, projectId);
    await ensureSemanticIndexCurrent(actor.actorId, projectId);
    reply.header("X-Request-Id", requestId);
    return {
      items: await semanticStore.listByKinds(projectId, ["rule"]),
      request_id: requestId
    };
  });

  app.get("/api/v1/projects/:projectId/semantic/architecture", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId } = request.params as { projectId: string };
    await repository.getProject(actor.actorId, projectId);
    await ensureSemanticIndexCurrent(actor.actorId, projectId);
    reply.header("X-Request-Id", requestId);
    return {
      items: await semanticStore.listByKinds(projectId, ["architecture_document"]),
      request_id: requestId
    };
  });

  app.get("/api/v1/projects/:projectId/semantic/changes", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId } = request.params as { projectId: string };
    await repository.getProject(actor.actorId, projectId);
    await ensureSemanticIndexCurrent(actor.actorId, projectId);
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      cursor: z.string().min(1).optional()
    }).strict().parse(request.query);
    const offset = query.cursor === undefined
      ? 0
      : Number.parseInt(Buffer.from(query.cursor, "base64url").toString("utf8"), 10);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new ServerDomainError(400, "INVALID_CURSOR", "cursor is invalid");
    }
    const page = await semanticStore.listByKindsPage(
      projectId,
      ["archive_record", "change_document"],
      { limit: query.limit, offset, order: "change-history" }
    );
    const archiveKeys = new Map<string, string>();
    for (const document of page.items) {
      if (document.kind !== "archive_record") continue;
      const pathMatch = /^\.harness\/archive\/([^/]+)\/reports\/final\/summary-data\.json$/u
        .exec(document.source_path);
      const changeKey = typeof document.metadata.source_archive === "string"
        ? document.metadata.source_archive
        : pathMatch?.[1];
      if (changeKey !== undefined) archiveKeys.set(document.document_id, changeKey);
    }
    const archives = await repository.getChangeArchivePackages(
      actor.actorId,
      projectId,
      [...new Set(archiveKeys.values())]
    );
    const archivesByKey = new Map(archives.map((archive) => [archive.changeKey, archive]));
    const items = page.items.map((document) => {
      const changeKey = archiveKeys.get(document.document_id);
      const archive = changeKey === undefined ? undefined : archivesByKey.get(changeKey);
      if (changeKey === undefined || archive === undefined) return document;
      return {
        ...document,
        metadata: {
          ...document.metadata,
          source_archive: changeKey,
          archive_id: archive.archiveId,
          archive_status: archive.archiveStatus,
          knowledge_status: archive.knowledgeStatus,
          package_sha256: archive.packageSha256,
          manifest_sha256: archive.manifestSha256,
          archive_uploaded_at: archive.createdAt,
          archive_updated_at: archive.updatedAt
        }
      };
    });
    const nextOffset = offset + items.length;
    reply.header("X-Request-Id", requestId);
    return {
      items,
      total: page.total,
      next_cursor: nextOffset < page.total
        ? Buffer.from(String(nextOffset)).toString("base64url")
        : null,
      request_id: requestId
    };
  });

  app.get("/api/v1/projects/:projectId/semantic/graph", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId } = request.params as { projectId: string };
    await repository.getProject(actor.actorId, projectId);
    await ensureSemanticIndexCurrent(actor.actorId, projectId);
    const query = request.query as Record<string, string | undefined>;
    const focusDocumentId = query.focus_document_id?.trim() || undefined;
    const graph = await semanticStore.graph(projectId, focusDocumentId);
    const overview = await semanticStore.overview(projectId);
    reply.header("X-Request-Id", requestId);
    return {
      ...graph,
      focus_document_id: focusDocumentId ?? null,
      relation_status: graph.edges.length === 0 ? "no_relations" : "ready",
      indexed_documents: overview.counts.documents,
      request_id: requestId
    };
  });

  app.get("/api/v1/semantic/search", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const query = request.query as Record<string, string | undefined>;
    const q = query.q?.trim() ?? "";
    if (q.length === 0) {
      throw new ServerDomainError(400, "VALIDATION_FAILED", "q is required");
    }
    const projectId = query.project_id;
    let items;
    if (projectId !== undefined) {
      await repository.getProject(actor.actorId, projectId);
      await ensureSemanticIndexCurrent(actor.actorId, projectId);
      items = await semanticStore.search(q, projectId);
    } else {
      const accessible = await accessibleSemanticProjectIds(actor.actorId);
      // 全局搜索只需一次带 ACL allowlist 的存储查询。旧 schema 在后台
      // 按固定并发迁移，完成前不会把旧分类文档混入搜索结果。
      scheduleSemanticIndexesCurrent(actor.actorId, accessible);
      items = await semanticStore.search(q, accessible, {
        limit: 100,
        currentSchemaOnly: true
      });
    }
    reply.header("X-Request-Id", requestId);
    return {
      items: items.map((document) => ({ document, project_id: document.project_id })),
      request_id: requestId
    };
  });

  app.get("/api/v1/skill-catalog/order", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    reply.header("X-Request-Id", requestId);
    return { ...registry.getSkillCatalogOrder(), request_id: requestId };
  });

  app.put("/api/v1/skill-catalog/order", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const body = updateSkillCatalogOrderRequestSchema.parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const order = await registry.updateSkillCatalogOrder(body);
      await writeAudit(repository, {
        actorId: actor.actorId,
        projectId: null,
        action: "skill_catalog.reordered",
        targetId: "skill-catalog",
        requestId,
        details: { revision: order.revision, item_count: order.items.length }
      });
      return { statusCode: 200, body: order };
    });
    return send(reply, requestId, result);
  });
  app.addHook("onClose", async () => codexService.close());

  app.get("/api/v1/projects/:projectId/semantic/search", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository, "knowledge:read");
    const { projectId } = request.params as { projectId: string };
    await repository.getProject(actor.actorId, projectId);
    await ensureSemanticIndexCurrent(actor.actorId, projectId);
    const query = request.query as Record<string, string | undefined>;
    const q = query.q?.trim() ?? "";
    if (q.length === 0) {
      throw new ServerDomainError(400, "VALIDATION_FAILED", "q is required");
    }
    const items = await semanticStore.search(q, projectId);
    reply.header("X-Request-Id", requestId);
    return {
      items: items.map((document) => ({ document, project_id: document.project_id })),
      request_id: requestId
    };
  });

  app.put("/api/v1/projects/:projectId/workflow-binding", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId } = request.params as { projectId: string };
    await repository.getProject(actor.actorId, projectId);
    const body = projectWorkflowBindingSchema.parse(request.body);
    const result = await registry.withRegistryMutation(() =>
      mutation(request, repository, actor, requestId, async () => {
        const binding = registry.bindProjectWorkflowFamily({
          projectId,
          familySlug: body.family_slug,
          profile: body.profile,
          version: body.version ?? null,
          revision: body.revision
        });
        await registry.persist();
        await writeAudit(repository, {
          actorId: actor.actorId, projectId, action: "project.workflow.bound",
          targetId: projectId, requestId,
          details: { family_slug: binding.family_slug, profile: binding.profile, revision: binding.revision }
        });
        return { statusCode: 200, body: binding };
      })
    );
    return send(reply, requestId, result);
  });

  app.post("/api/v1/workflow-families/:slug/draft/profiles/:profile", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { slug, profile } = request.params as { slug: string; profile: string };
    const collected: Array<{ path: string; buffer: Buffer }> = [];
    for await (const part of request.parts()) {
      if (part.type !== "file") continue;
      collected.push({ path: part.filename ?? "file", buffer: await part.toBuffer() });
    }
    const files = resolveUploadFiles(collected, config);
    const bodyHash = sha256Bytes(canonicalJson(files.map((f) => ({ path: f.path, content: f.content }))));
    const result = await mutation(request, repository, actor, requestId, async () => {
      const draft = await registry.uploadWorkflowFamilyProfileDraft({
        slug, profile, files, actorId: actor.actorId
      });
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null,
        action: draft.revision === 1 ? "workflow.family.draft.created" : "workflow.family.draft.updated",
        targetId: slug, requestId,
        details: { slug, profile, revision: draft.revision }
      });
      return { statusCode: 201, body: draft };
    }, bodyHash);
    return send(reply, requestId, result);
  });

  app.get("/api/v1/workflow-families/:slug/draft", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const { slug } = request.params as { slug: string };
    const draft = registry.getWorkflowFamilyDraft(slug);
    reply.header("X-Request-Id", requestId);
    return { ...draft, request_id: requestId };
  });

  app.delete("/api/v1/workflow-families/:slug/draft", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { slug } = request.params as { slug: string };
    const result = await mutation(request, repository, actor, requestId, async () => {
      const body = z.object({ revision: z.number().int().positive() }).strict().parse(request.body);
      await registry.discardWorkflowFamilyDraft(slug, body.revision);
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "workflow.family.draft.discarded",
        targetId: slug, requestId, details: { slug }
      });
      return { statusCode: 200, body: { slug, discarded: true } };
    });
    return send(reply, requestId, result);
  });

  app.post("/api/v1/workflow-families/:slug/draft/checks", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { slug } = request.params as { slug: string };
    const result = await mutation(request, repository, actor, requestId, async () => {
      const checks = await registry.runWorkflowFamilyChecks({ slug, checkedAt: new Date().toISOString() });
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "workflow.family.draft.checked",
        targetId: slug, requestId, details: { slug, red: checks.summary.red }
      });
      return { statusCode: 200, body: checks };
    });
    return send(reply, requestId, result);
  });

  app.post("/api/v1/workflow-families/:slug/publish", async (request, reply) => {
    const { actor, requestId } = await ownerAuthenticated(request, repository, ownerActorId);
    const { slug } = request.params as { slug: string };
    const body = publishWorkflowFamilyRequestSchema.parse(request.body);
    const result = await registry.withFeatureMutation(() =>
      transactionalMutation(request, repository, actor, requestId, async (tx) => {
        const published = await registry.publishWorkflowFamily(slug, {
          version: body.version,
          releaseNote: body.releaseNote ?? null,
          actorId: actor.actorId,
          tx
        });
        const version = registry.summarizeWorkflowFamilyVersion(published);
        await writeAudit(tx, {
          actorId: actor.actorId, projectId: null, action: "workflow.family.published",
          targetId: slug, requestId, details: { slug, version: version.version }
        });
        return { statusCode: 200, body: version };
      })
    );
    return send(reply, requestId, result);
  });

  app.get("/api/v1/workflow-families/:slug/draft/diff", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const { slug } = request.params as { slug: string };
    const query = z.object({ profile: registrySlugSchema.optional() }).strict().parse(request.query);
    const diff = registry.diffWorkflowFamilyDraft(slug, query.profile);
    reply.header("X-Request-Id", requestId);
    return { items: diff, request_id: requestId };
  });

  app.get("/api/v1/workflow-families/:slug/versions", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const { slug } = request.params as { slug: string };
    const versions = registry.listWorkflowFamilyVersionSummaries(slug);
    reply.header("X-Request-Id", requestId);
    return { items: versions, request_id: requestId };
  });

  app.get("/api/v1/workflow-families/:slug/artifacts/:profile/download", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { slug, profile } = request.params as { slug: string; profile: string };
    const query = z.object({ version: z.string().optional() }).strict().parse(request.query);
    const bytes = await registry.getWorkflowFamilyProfileArtifactBytes(slug, profile, query.version);
    const family = registry.getWorkflowFamily(slug);
    const version = query.version ?? family.latest_version ?? "draft";
    const hash = sha256Bytes(bytes);
    await writeAudit(repository, {
      actorId: actor.actorId,
      projectId: null,
      action: "workflow.family.artifact.downloaded",
      targetId: slug,
      requestId,
      details: { slug, profile, version }
    });
    reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", `attachment; filename="${slug}-${profile}-${version}.zip"`)
      .header("X-Content-SHA256", hash)
      .header("ETag", hash)
      .header("X-Request-Id", requestId);
    return Buffer.from(bytes);
  });

  // ---- AI ?? + AI ???�12.9 / �6.2?----

  const loadCodexConnection = async (): Promise<CodexConnectionState> => {
    const connection = await codexService.getConnection();
    let selectedModel = registry.getCodexSelectedModel();
    if (connection.status === "connected") {
      if (!connection.models.some((item) => item.id === selectedModel)) {
        selectedModel = connection.models.find((item) => item.is_default)?.id
          ?? connection.models[0]?.id
          ?? null;
      }
    }
    return {
      ...connection,
      enabled: connection.status === "connected" && registry.isCodexEnabled(),
      selected_model: selectedModel
    };
  };

  app.get("/api/v1/ai-config/providers", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const providers = registry.listProviders();
    const defaultProvider = registry.getDefaultProvider();
    const items = await Promise.all(providers.map(async (p) => ({
      ...p,
      key_set: (await loadAiSecret(config.aiSecretFile, p.provider_id)) !== null
    })));
    reply.header("X-Request-Id", requestId);
    return {
      items,
      default_provider: defaultProvider?.provider_id ?? null,
      request_id: requestId
    };
  });

  app.get("/api/v1/ai-config/codex", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const state = await loadCodexConnection();
    reply.header("X-Request-Id", requestId);
    return { ...state, request_id: requestId };
  });

  app.post("/api/v1/ai-config/codex/login", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    z.object({ schema_version: z.literal(1) }).strict().parse(request.body);
    let login;
    try {
      login = await codexService.startDeviceLogin();
    } catch {
      throw new ServerDomainError(503, "CODEX_UNAVAILABLE", "Codex account authorization is unavailable");
    }
    await writeAudit(repository, {
      actorId: actor.actorId, projectId: null, action: "ai.codex.login-started",
      targetId: "codex", requestId, details: { auth_mode: "chatgpt" }
    });
    // 设备码属于短时授权凭据，不写入幂等响应存储或审计详情。
    reply.header("X-Request-Id", requestId);
    return { ...login, request_id: requestId };
  });

  app.post("/api/v1/ai-config/codex/login/cancel", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const body = z.object({ schema_version: z.literal(1), login_id: z.string().min(1) }).strict().parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      await codexService.cancelLogin(body.login_id);
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "ai.codex.login-cancelled",
        targetId: "codex", requestId, details: {}
      });
      return { statusCode: 200, body: { cancelled: true } };
    });
    return send(reply, requestId, result);
  });

  app.patch("/api/v1/ai-config/codex", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const body = z.object({
      schema_version: z.literal(1),
      selected_model: z.string().min(1).nullable().optional(),
      enabled: z.boolean().optional()
    }).strict().refine((value) => value.selected_model !== undefined || value.enabled !== undefined, {
      message: "selected_model or enabled is required"
    }).parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const current = await loadCodexConnection();
      if ((body.selected_model !== undefined || body.enabled === true) && current.status !== "connected") {
        throw new ServerDomainError(409, "CODEX_NOT_CONNECTED", "Codex ChatGPT account is not connected");
      }
      if (body.selected_model !== undefined && body.selected_model !== null && !current.models.some((item) => item.id === body.selected_model)) {
        throw new ServerDomainError(422, "CODEX_MODEL_NOT_AVAILABLE", "selected Codex model is not available for this account", {
          selected_model: body.selected_model
        });
      }
      await registry.updateCodexConfig({
        ...(body.selected_model === undefined ? {} : { selected_model: body.selected_model }),
        ...(body.enabled === undefined ? {} : { enabled: body.enabled })
      });
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "ai.codex.updated",
        targetId: "codex", requestId,
        details: {
          ...(body.selected_model === undefined ? {} : { selected_model: body.selected_model }),
          ...(body.enabled === undefined ? {} : { enabled: body.enabled })
        }
      });
      return { statusCode: 200, body: await loadCodexConnection() };
    });
    return send(reply, requestId, result);
  });

  app.delete("/api/v1/ai-config/codex", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const result = await mutation(request, repository, actor, requestId, async () => {
      await codexService.logout();
      await registry.updateCodexConfig({ selected_model: null, enabled: false });
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "ai.codex.disconnected",
        targetId: "codex", requestId, details: {}
      });
      return { statusCode: 200, body: { disconnected: true } };
    });
    return send(reply, requestId, result);
  });

  app.post("/api/v1/ai-config/codex/test", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    z.object({ schema_version: z.literal(1) }).strict().parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const connection = await loadCodexConnection();
      if (connection.status !== "connected" || connection.selected_model === null) {
        throw new ServerDomainError(409, "CODEX_NOT_CONNECTED", "Codex ChatGPT account is not connected");
      }
      const client = await codexService.getLlmClient(connection.selected_model);
      if (client === null) {
        throw new ServerDomainError(503, "CODEX_UNAVAILABLE", "Codex model is unavailable");
      }
      try {
        await client.analyze({ system: "只回复 ok", user: "连接测试" });
      } catch {
        return { statusCode: 200, body: { ok: false, model: connection.selected_model } };
      }
      return { statusCode: 200, body: { ok: true, model: connection.selected_model } };
    });
    return send(reply, requestId, result);
  });

  app.post("/api/v1/ai-config/providers", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const body = aiProviderCreateSchema.parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const provider = await registry.upsertProvider({
        provider_id: body.provider_id,
        label: body.label,
        base_url: body.base_url,
        model: body.model,
        enabled: body.enabled,
        api_key_env: body.api_key_env,
        ...(body.is_default === undefined ? {} : { is_default: body.is_default }),
        ...(body.daily_request_limit === undefined ? {} : { daily_request_limit: body.daily_request_limit }),
        ...(body.daily_token_limit === undefined ? {} : { daily_token_limit: body.daily_token_limit }),
        ...(body.models === undefined ? {} : { models: body.models }),
        ...(body.api_format === undefined ? {} : { api_format: body.api_format }),
        ...(body.note === undefined ? {} : { note: body.note }),
        ...(body.website === undefined ? {} : { website: body.website }),
        ...(body.selected_model_id === undefined ? {} : { selected_model_id: body.selected_model_id }),
        ...(body.sort_order === undefined ? {} : { sort_order: body.sort_order })
      });
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "ai.provider.created",
        targetId: provider.provider_id, requestId,
        details: { provider_id: provider.provider_id, label: provider.label, revision: provider.revision }
      });
      if (body.api_key !== undefined && body.api_key !== "") {
        await writeAiSecret(config.aiSecretFile, body.provider_id, { apiKey: body.api_key });
        await writeAudit(repository, {
          actorId: actor.actorId, projectId: null, action: "ai.provider.key-set",
          targetId: provider.provider_id, requestId,
          details: { provider_id: provider.provider_id }
        });
      }
      return { statusCode: 201, body: provider };
    });
    return send(reply, requestId, result);
  });

  app.patch("/api/v1/ai-config/providers/:providerId", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { providerId } = request.params as { providerId: string };
    const body = aiProviderUpdateSchema.parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const patch: Partial<Pick<AiProviderConfig, "label" | "base_url" | "model" | "enabled" | "api_key_env" | "daily_request_limit" | "daily_token_limit" | "models" | "api_format" | "note" | "website" | "selected_model_id" | "sort_order">> = {};
      if (body.label !== undefined) patch.label = body.label;
      if (body.base_url !== undefined) patch.base_url = body.base_url;
      if (body.model !== undefined) patch.model = body.model;
      if (body.enabled !== undefined) patch.enabled = body.enabled;
      if (body.api_key_env !== undefined) patch.api_key_env = body.api_key_env;
      if (body.daily_request_limit !== undefined) patch.daily_request_limit = body.daily_request_limit;
      if (body.daily_token_limit !== undefined) patch.daily_token_limit = body.daily_token_limit;
      if (body.models !== undefined) patch.models = body.models;
      if (body.api_format !== undefined) patch.api_format = body.api_format;
      if (body.note !== undefined) patch.note = body.note;
      if (body.website !== undefined) patch.website = body.website;
      if (body.selected_model_id !== undefined) patch.selected_model_id = body.selected_model_id;
      if (body.sort_order !== undefined) patch.sort_order = body.sort_order;
      const enabledBefore = body.enabled === true
        ? registry.listProviders().filter((item) => item.enabled && item.provider_id !== providerId).map((item) => item.provider_id)
        : [];
      let provider: AiProviderConfig;
      try {
        provider = await registry.updateProvider(providerId, body.revision, patch);
      } catch (err) {
        // UI tabs can issue rapid sequential PATCH requests while holding a stale revision.
        // Treat AI provider config updates as last-write-wins: on optimistic-lock conflict,
        // retry once with the server's current revision so older browser bundles are also safe.
        if (err instanceof ServerDomainError && err.code === SKILL_ERROR_CODE.REVISION_CONFLICT) {
          const current = registry.listProviders().find((p) => p.provider_id === providerId);
          if (current === undefined) throw err;
          provider = await registry.updateProvider(providerId, current.revision, patch);
        } else {
          throw err;
        }
      }
      // enabled ?????enabled=true ?? provider true??? false????????API-04?
      const exclusiveDisabled = enabledBefore;
      provider = registry.getProvider(providerId) ?? provider;
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "ai.provider.updated",
        targetId: providerId, requestId,
        details: { provider_id: provider.provider_id, revision: provider.revision, exclusive_disabled: exclusiveDisabled }
      });
      if (body.api_key !== undefined && body.api_key !== "") {
        await writeAiSecret(config.aiSecretFile, providerId, { apiKey: body.api_key });
        await writeAudit(repository, {
          actorId: actor.actorId, projectId: null, action: "ai.provider.key-set",
          targetId: providerId, requestId,
          details: { provider_id: providerId }
        });
      }
      return { statusCode: 200, body: provider };
    });
    return send(reply, requestId, result);
  });

  app.delete("/api/v1/ai-config/providers/:providerId", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { providerId } = request.params as { providerId: string };
    const result = await mutation(request, repository, actor, requestId, async () => {
      await registry.deleteProvider(providerId);
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "ai.provider.deleted",
        targetId: providerId, requestId, details: { provider_id: providerId }
      });
      return { statusCode: 200, body: { provider_id: providerId, deleted: true } };
    });
    return send(reply, requestId, result);
  });

  app.post("/api/v1/ai-config/providers/:providerId/test", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { providerId } = request.params as { providerId: string };
    const result = await mutation(request, repository, actor, requestId, async () => {
      const resolved = await resolveLlmClient(providerId);
      if (resolved === null) {
        throw new ServerDomainError(422, "AI_NOT_CONFIGURED", "ai provider not configured or missing secret", { provider_id: providerId });
      }
      const requestModel = resolveRequestModel(resolved.provider);
      try {
        const res = await resolved.client.analyze({ system: "Reply with the single word: ok", user: "ping" });
        await registry.recordUsage({
          provider_id: providerId,
          model: requestModel,
          requests: res.usage?.requests ?? 1,
          input_tokens: res.usage?.input_tokens ?? 0,
          output_tokens: res.usage?.output_tokens ?? 0,
          cache_hit_tokens: res.usage?.cache_hit_tokens ?? 0,
          cache_create_tokens: res.usage?.cache_create_tokens ?? 0
        });
        return { statusCode: 200, body: { provider_id: providerId, ok: true, model: requestModel } };
      } catch (err) {
        return { statusCode: 200, body: { provider_id: providerId, ok: false, error: err instanceof Error ? err.message : "unknown" } };
      }
    });
    return send(reply, requestId, result);
  });

  // ?? provider API key ? secret file??? DB/??/??????? + ?? key-set ????
  app.post("/api/v1/ai-config/providers/:providerId/key", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { providerId } = request.params as { providerId: string };
    const body = z.object({
      api_key: z.string().min(1),
      base_url: z.string().optional(),
      model: z.string().optional()
    }).parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const provider = registry.listProviders().find((p) => p.provider_id === providerId);
      if (provider === undefined) {
        throw new ServerDomainError(404, "PROVIDER_NOT_FOUND", "ai provider not found", { provider_id: providerId });
      }
      await writeAiSecret(config.aiSecretFile, providerId, {
        apiKey: body.api_key,
        ...(body.base_url !== undefined ? { baseUrl: body.base_url } : {}),
        ...(body.model !== undefined ? { model: body.model } : {})
      });
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "ai.provider.key-set",
        targetId: providerId, requestId,
        details: { provider_id: providerId }
      });
      return { statusCode: 200, body: { provider_id: providerId, key_set: true } };
    });
    return send(reply, requestId, result);
  });

  app.get("/api/v1/ai-config/usage", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const usage = registry.getUsage();
    reply.header("X-Request-Id", requestId);
    return { usage, request_id: requestId };
  });

  // ???? providers?body {schema_version:1, provider_ids} ?????????/?? 422 VALIDATION_FAILED?store.reorderProviders ????
  app.post("/api/v1/ai-config/providers/reorder", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const body = aiProviderReorderRequestSchema.parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      await registry.reorderProviders(body.provider_ids);
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "ai.provider.reordered",
        targetId: body.provider_ids[0] ?? "", requestId, details: { provider_ids: body.provider_ids }
      });
      return { statusCode: 200, body: { provider_ids: body.provider_ids } };
    });
    return send(reply, requestId, result);
  });

  // ?? AI ???�3.3??POST ???? job ?? jobId + status:pending????? GET /ai-jobs/:id?
  // mutation ???? job?Idempotency-Key ??? POST ??? jobId??job ????????
  // ??????? draft + resolveLlmClient + checkQuota ????? 429 ?? LLM?INT-002??
  // job ???buildAiCheckPrompt ? analyze ? recordUsage ? parseAiCheckResult ? setDraftAiChecks + audit?
  // LLM ?? ? job.failed?draft.aiChecks ?? degraded????? failed ???INT-003??
  app.post("/api/v1/skills/:slug/draft/:agent/ai-checks", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { slug, agent: agentValue } = request.params as { slug: string; agent: string };
    const agentResult = registryAgentSchema.safeParse(agentValue);
    if (!agentResult.success) {
      throw new ServerDomainError(422, "VALIDATION_FAILED", "agent path param must be a valid registry agent");
    }
    const agent = agentResult.data;
    const result = await mutation(request, repository, actor, requestId, async () => {
      const draft = registry.getDraft(slug, agent);
      if (draft === undefined) {
        throw new ServerDomainError(404, SKILL_ERROR_CODE.DRAFT_NOT_FOUND, "skill draft not found", { slug, agent });
      }
      const resolved = await resolveAgentLlmClient(agent);
      if (resolved === null) {
        throw new ServerDomainError(422, "AI_NOT_CONFIGURED", "no default ai provider configured or missing secret");
      }
      // ?????INT-002???? daily_limit ? 429 ?? LLM?
      checkAgentQuota(resolved);
      // AiJobStore.startJob(slug,agent,fn) dedup?? slug+agent active job ??? jobId?? R2??
      const job = await aiJobStore.startJob(slug, agent, async () => {
        const entry = findEntryFile(draft.sourceFiles, agent);
        const meta = parseFrontmatter(entry.content);
        const prompt = buildAiCheckPrompt({ meta, sourceFiles: draft.sourceFiles });
        const checkedAt = new Date().toISOString();
        const res = await resolved.client.analyze(prompt);
        await recordAgentUsage(resolved, res.usage);
        const aiChecks = parseAiCheckResult(res.content);
        await registry.setDraftAiChecks({ slug, agent, aiChecks, checkedAt });
        await writeAudit(repository, {
          actorId: actor.actorId, projectId: null, action: "skill.draft.ai-checked",
          targetId: slug, requestId, details: { slug, agent, red: aiChecks.summary.red }
        });
        return aiChecks;
      });
      return { statusCode: 200, body: { jobId: job.jobId, status: "pending" } };
    });
    return send(reply, requestId, result);
  });

  // ?? job ???�3.3??completed ? result???/??? 404 JOB_NOT_FOUND?
  app.get("/api/v1/ai-jobs/:jobId", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const { jobId } = request.params as { jobId: string };
    const job = await aiJobStore.getJob(jobId);
    if (job === undefined) {
      throw new ServerDomainError(404, "JOB_NOT_FOUND", "ai job not found or expired", { jobId });
    }
    return send(reply, requestId, {
      statusCode: 200,
      body: {
        jobId: job.jobId,
        slug: job.slug,
        agent: job.agent,
        status: job.status,
        result: job.result,
        error: job.error,
        createdAt: job.createdAt,
        expiresAt: job.expiresAt
      }
    });
  });

  // AI ?????????�5.3??? diffDraft + ir ? LLM ?? releaseNote ? ??? draft.releaseNote + audit?
  // ??? = mutation?? Idempotency-Key+lock?? ai-checks ??????? LLM ????
  // ?? LLM ??? mutation ??????? 60s??????Idempotency-Key ??????draft ?????????
  //    ?????"? analyze ?? mutation ???"???????review YELLOW #1????????
  // ???? AI_TIMEOUT/AI_PARSE_FAILED?200 degraded:true?? 500???????????????
  app.post("/api/v1/skills/:slug/draft/:agent/release-note:generate", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { slug, agent: agentValue } = request.params as { slug: string; agent: string };
    const agentResult = registryAgentSchema.safeParse(agentValue);
    if (!agentResult.success) {
      throw new ServerDomainError(422, "VALIDATION_FAILED", "agent path param must be a valid registry agent");
    }
    const agent = agentResult.data;
    const result = await mutation(request, repository, actor, requestId, async () => {
      const draft = registry.getDraft(slug, agent);
      if (draft === undefined) {
        throw new ServerDomainError(404, SKILL_ERROR_CODE.DRAFT_NOT_FOUND, "skill draft not found", { slug, agent });
      }
      const resolved = await resolveAgentLlmClient(agent);
      if (resolved === null) {
        throw new ServerDomainError(422, "AI_NOT_CONFIGURED", "no default ai provider configured or missing secret");
      }
      const diff = registry.diffDraft(slug, agent);
      const entry = findEntryFile(draft.sourceFiles, agent);
      const meta = parseFrontmatter(entry.content);
      const prompt = buildReleaseNotePrompt({ meta, diff });
      const generatedAt = new Date().toISOString();
      try {
        const res = await resolved.client.analyze(prompt);
        await recordAgentUsage(resolved, res.usage);
        const releaseNote = parseReleaseNote(res.content);
        if (releaseNote === null) {
          // LLM ???/???? ? ?? AI_PARSE_FAILED?? 500??????????????
          await writeAudit(repository, {
            actorId: actor.actorId, projectId: null, action: "skill.draft.release-note.generated",
            targetId: slug, requestId, details: { slug, agent, degraded: true, reason: "AI_PARSE_FAILED" }
          });
          return { statusCode: 200, body: { releaseNote: null, degraded: true, reason: "AI_PARSE_FAILED", generatedAt } };
        }
        await registry.setDraftReleaseNote({ slug, agent, releaseNote, generatedAt });
        await writeAudit(repository, {
          actorId: actor.actorId, projectId: null, action: "skill.draft.release-note.generated",
          targetId: slug, requestId, details: { slug, agent, degraded: false }
        });
        return { statusCode: 200, body: { releaseNote, generatedAt } };
      } catch (err) {
        // LLM ??/??? ? ?? AI_TIMEOUT?? 500???????err.message ?? audit ?????? key ???
        await writeAudit(repository, {
          actorId: actor.actorId, projectId: null, action: "skill.draft.release-note.generated",
          targetId: slug, requestId, details: { slug, agent, degraded: true, reason: "AI_TIMEOUT", error: err instanceof Error ? err.message : "unknown" }
        });
        return { statusCode: 200, body: { releaseNote: null, degraded: true, reason: "AI_TIMEOUT", generatedAt } };
      }
    });
    return send(reply, requestId, result);
  });

  // 兼容旧客户端的建议读取端点。建议已在 ai-checks 的同一次模型响应中生成并持久化，
  // 这里仅把 draft.aiChecks 快照映射为 FixPlan，不再调用模型。
  app.post("/api/v1/skills/:slug/draft/:agent/fix-suggestions", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const { slug, agent: agentValue } = request.params as { slug: string; agent: string };
    const agentResult = registryAgentSchema.safeParse(agentValue);
    if (!agentResult.success) {
      throw new ServerDomainError(422, "VALIDATION_FAILED", "agent path param must be a valid registry agent");
    }
    const agent = agentResult.data;
    const body = (request.body ?? {}) as { checkIds?: string[] | null };
    const checkIds = body.checkIds ?? null;
    const draft = registry.getDraft(slug, agent);
    if (draft === undefined) {
      throw new ServerDomainError(404, SKILL_ERROR_CODE.DRAFT_NOT_FOUND, "skill draft not found", { slug, agent });
    }
    if (draft.aiChecks === null) {
      // ? aiChecks ? ? FixPlan????? ai-checks?????? 422?
      return send(reply, requestId, { statusCode: 200, body: { items: [], mergedFiles: [], summary: emptySummary } });
    }
    const suggestedItems = draft.aiChecks.items.filter((item) =>
      item.status !== "green" &&
      item.suggestion !== null &&
      item.suggestion !== undefined &&
      (checkIds === null || checkIds.includes(item.id))
    );
    const items: FixPlanItem[] = suggestedItems.map((check) => {
      const suggestion = check.suggestion;
      if (suggestion === null || suggestion === undefined) {
        throw new Error("filtered AI suggestion is unexpectedly missing");
      }
      return {
        checkId: check.id,
        action: "suggest",
        label: check.label,
        affectedPaths: check.filePath === null ? [] : [check.filePath],
        riskDelta: null,
        message: check.message,
        suggestedContent: suggestion.suggestedContent,
        explanation: suggestion.explanation,
        appliesTo: suggestion.appliesTo,
        generatedAt: suggestion.generatedAt ?? draft.aiChecks?.checkedAt ?? null,
        applicationState: suggestion.applicationState,
        appliedAt: suggestion.appliedAt
      };
    });
    return send(reply, requestId, {
      statusCode: 200,
      body: { items, mergedFiles: [], summary: { ...emptySummary, suggestCount: items.length } }
    });
  });

  // AI ???????�6.3 ?4?/�3.6??mutation ??? ? applyFixSuggestion????+? ir/examples+scanSensitive+? aiChecks+revision+1?? audit?
  // appliesTo ?????? store ????examples/allowed_capabilities/instructions/description?tags/null/?? ? 422 SKILL_VALIDATION_FAILED??
  app.post("/api/v1/skills/:slug/draft/:agent/apply-fix-suggestion", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { slug, agent: agentValue } = request.params as { slug: string; agent: string };
    const agentResult = registryAgentSchema.safeParse(agentValue);
    if (!agentResult.success) {
      throw new ServerDomainError(422, "VALIDATION_FAILED", "agent path param must be a valid registry agent");
    }
    const agent = agentResult.data;
    const body = z.object({
      checkId: z.string().min(1),
      suggestedContent: z.string(),
      appliesTo: z.string().nullable()
    }).strict().parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const draft = await registry.applyFixSuggestion({
        slug,
        agent,
        checkId: body.checkId,
        suggestedContent: body.suggestedContent,
        appliesTo: body.appliesTo,
        actorId: actor.actorId
      });
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "skill.draft.fix-suggestion.applied",
        targetId: slug, requestId, details: { slug, agent, checkId: body.checkId, appliesTo: body.appliesTo }
      });
      return { statusCode: 200, body: draft };
    });
    return send(reply, requestId, result);
  });

  app.post("/api/v1/skills/:slug/draft/:agent/fix-preview", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const { slug, agent: agentValue } = request.params as { slug: string; agent: string };
    const agentResult = registryAgentSchema.safeParse(agentValue);
    if (!agentResult.success) {
      throw new ServerDomainError(422, "VALIDATION_FAILED", "agent path param must be a valid registry agent");
    }
    const agent = agentResult.data;
    const { checkIds } = (request.body ?? {}) as { checkIds?: string[] | null };
    const plan = await registry.buildDraftFix(slug, agent, checkIds ?? null);
    return send(reply, requestId, { statusCode: 200, body: { items: plan.items, mergedFiles: plan.mergedFiles, summary: plan.summary } });
  });

  app.post("/api/v1/skills/:slug/draft/:agent/apply-fix", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { slug, agent: agentValue } = request.params as { slug: string; agent: string };
    const agentResult = registryAgentSchema.safeParse(agentValue);
    if (!agentResult.success) {
      throw new ServerDomainError(422, "VALIDATION_FAILED", "agent path param must be a valid registry agent");
    }
    const agent = agentResult.data;
    const { checkIds } = (request.body ?? {}) as { checkIds?: string[] | null };
    const result = await mutation(request, repository, actor, requestId, async () => {
      const draft = await registry.applyDraftFix(slug, agent, checkIds ?? null);
      await writeAudit(repository, {
        actorId: actor.actorId, projectId: null, action: "skill.draft.fix-applied",
        targetId: slug, requestId, details: { slug, agent, checkIds: checkIds ?? "all" }
      });
      return { statusCode: 200, body: draft };
    });
    return send(reply, requestId, result);
  });

  app.get("/api/v1/external-skills", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const query = request.query as Record<string, string | undefined>;
    reply.header("X-Request-Id", requestId);
    return {
      items: registry.listExternalSkills({
        ...(query.search !== undefined ? { search: query.search } : {}),
        ...(query.source_type !== undefined ? { sourceType: query.source_type } : {})
      }),
      request_id: requestId
    };
  });

  app.get("/api/v1/external-skills/:id", async (request, reply) => {
    const { requestId } = await authenticated(request, repository);
    const { id } = request.params as { id: string };
    reply.header("X-Request-Id", requestId);
    return { ...registry.getExternalSkill(id), request_id: requestId };
  });

  app.post("/api/v1/external-skills", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const body = createExternalSkillRequestSchema.parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const skill = await registry.createExternalSkill({
        source: body.source,
        tags: body.tags,
        ...(body.curationNote === undefined ? {} : { curationNote: body.curationNote })
      });
      await writeAudit(repository, {
        actorId: actor.actorId,
        projectId: null,
        action: "external_skill.created",
        targetId: skill.id,
        requestId,
        details: { source: skill.source }
      });
      return { statusCode: 201, body: skill };
    });
    return send(reply, requestId, result);
  });

  app.patch("/api/v1/external-skills/:id", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { id } = request.params as { id: string };
    const body = patchExternalSkillRequestSchema.parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const skill = await registry.patchExternalSkill({
        id,
        revision: body.revision,
        ...(body.curationNote !== undefined ? { curationNote: body.curationNote } : {}),
        ...(body.tags !== undefined ? { tags: body.tags } : {}),
        ...(body.acknowledgeUpdate !== undefined ? { acknowledgeUpdate: body.acknowledgeUpdate } : {})
      });
      await writeAudit(repository, {
        actorId: actor.actorId,
        projectId: null,
        action: "external_skill.updated",
        targetId: skill.id,
        requestId,
        details: { revision: skill.revision }
      });
      return { statusCode: 200, body: skill };
    });
    return send(reply, requestId, result);
  });

  app.post("/api/v1/external-skills/:id/refresh", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { id } = request.params as { id: string };
    const result = await mutation(request, repository, actor, requestId, async () => {
      const before = registry.getExternalSkill(id);
      let skill = await registry.refreshExternalSkill(id);
      const latestUpdate = skill.updateHistory.find((record) =>
        !before.updateHistory.some((previous) => previous.applied_at === record.applied_at)
      );
      if (latestUpdate !== undefined) {
        skill = await summarizeExternalSkillUpdate(skill, latestUpdate.applied_at, false);
      }
      await writeAudit(repository, {
        actorId: actor.actorId,
        projectId: null,
        action: "external_skill.refreshed",
        targetId: skill.id,
        requestId,
        details: {
          previous_version: before.snapshot.version,
          version: skill.snapshot.version,
          update_available: skill.updateAvailable
        }
      });
      return { statusCode: 200, body: skill };
    });
    return send(reply, requestId, result);
  });

  app.post("/api/v1/external-skills/:id/check-upstream", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { id } = request.params as { id: string };
    const result = await mutation(request, repository, actor, requestId, async () => {
      const skill = await registry.checkExternalSkill(id);
      await writeAudit(repository, {
        actorId: actor.actorId,
        projectId: null,
        action: "external_skill.upstream.checked",
        targetId: skill.id,
        requestId,
        details: { update_available: skill.updateAvailable, available_version: skill.availableVersion }
      });
      return { statusCode: 200, body: skill };
    });
    return send(reply, requestId, result);
  });

  app.post("/api/v1/external-skills/:id/update-history/refresh", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { id } = request.params as { id: string };
    const body = refreshExternalSkillUpdateHistoryRequestSchema.parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const refreshed = await registry.refreshExternalSkillUpdateHistory(id, body.applied_at);
      const skill = await summarizeExternalSkillUpdate(refreshed, body.applied_at, true);
      await writeAudit(repository, {
        actorId: actor.actorId,
        projectId: null,
        action: "external_skill.update_history.refreshed",
        targetId: skill.id,
        requestId,
        details: { applied_at: body.applied_at }
      });
      return { statusCode: 200, body: skill };
    });
    return send(reply, requestId, result);
  });

  app.post("/api/v1/external-skills/:id/summary", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { id } = request.params as { id: string };
    const body = generateExternalSkillSummaryRequestSchema.parse(request.body);
    const result = await mutation(request, repository, actor, requestId, async () => {
      const before = registry.getExternalSkill(id);
      if (before.revision !== body.revision) {
        throw new ServerDomainError(409, "REVISION_CONFLICT", "external skill revision conflict", {
          expected: before.revision,
          provided: body.revision
        });
      }
      const sourceHash = externalSkillSummarySourceHash(before.snapshot);
      if (!body.force && before.aiSummary?.source_sha256 === sourceHash) {
        return { statusCode: 200, body: before };
      }
      const resolved = await resolveAgentLlmClient("generic");
      if (resolved === null) {
        throw new ServerDomainError(422, "AI_NOT_CONFIGURED", "no API provider or Codex account is available");
      }
      checkAgentQuota(resolved);
      const prompt = buildExternalSkillSummaryPrompt({
        name: before.snapshot.name,
        sourceRef: before.source.ref,
        description: before.snapshot.description,
        readme: before.snapshot.readme
      });
      let response: Awaited<ReturnType<LlmClient["analyze"]>>;
      try {
        response = await resolved.client.analyze(prompt);
      } catch {
        throw new ServerDomainError(502, "AI_GENERATION_FAILED", "ai summary generation failed");
      }
      await recordAgentUsage(resolved, response.usage);
      let content = parseExternalSkillSummary(response.content);
      if (content === null) {
        checkAgentQuota(resolved);
        const repairPrompt = buildExternalSkillSummaryRepairPrompt(response.content);
        let repairedResponse: Awaited<ReturnType<LlmClient["analyze"]>>;
        try {
          repairedResponse = await resolved.client.analyze(repairPrompt);
        } catch {
          throw new ServerDomainError(502, "AI_GENERATION_FAILED", "ai summary repair failed");
        }
        await recordAgentUsage(resolved, repairedResponse.usage);
        content = parseExternalSkillSummary(repairedResponse.content);
      }
      if (content === null) {
        throw new ServerDomainError(502, "AI_PARSE_FAILED", "ai summary response was not valid structured content");
      }
      const skill = await registry.setExternalSkillAiSummary({
        id,
        revision: body.revision,
        summary: {
          ...content,
          source_sha256: sourceHash,
          source_version: before.snapshot.version,
          provider_id: resolvedBackendId(resolved),
          model: resolved.model,
          generated_at: new Date().toISOString()
        }
      });
      await writeAudit(repository, {
        actorId: actor.actorId,
        projectId: null,
        action: "external_skill.ai-summary.generated",
        targetId: skill.id,
        requestId,
        details: {
          provider_id: resolvedBackendId(resolved),
          model: resolved.model,
          source_sha256: sourceHash
        }
      });
      return { statusCode: 200, body: skill };
    });
    return send(reply, requestId, result);
  });

  app.delete("/api/v1/external-skills/:id", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { id } = request.params as { id: string };
    const result = await mutation(request, repository, actor, requestId, async () => {
      const deleted = await registry.deleteExternalSkill(id);
      await writeAudit(repository, {
        actorId: actor.actorId,
        projectId: null,
        action: "external_skill.deleted",
        targetId: id,
        requestId,
        details: {}
      });
      return { statusCode: 200, body: deleted };
    });
    return send(reply, requestId, result);
  });

  registerSemanticMcpRoutes(app, {
    repository,
    semanticStore,
    ensureProjectCurrent: ensureSemanticIndexCurrent,
    scheduleProjectsCurrent: scheduleSemanticIndexesCurrent
  });

  registerRunRoutes(app, { repository, runStore, authenticated });
  registerPlatformInformationRoutes(app, {
    repository,
    authenticated,
    ...(options.platformInformation === undefined && branchMonitor === undefined
      ? {}
      : { adapters: {
          ...(options.platformInformation ?? {}),
          ...(branchMonitor === undefined ? {} : { branchMonitor })
      } })
  });
  registerRemoteSyncHttpRoutes(app, {
    repository,
    authenticated,
    ...(options.remoteSync === undefined ? {} : { service: options.remoteSync })
  });
  registerKnowledgeQueryHttpRoutes(app, {
    repository,
    authenticated,
    ...(options.knowledgeQuery === undefined ? {} : { service: options.knowledgeQuery })
  });
  registerRemoteContentUploadHttpRoutes(app, { repository, authenticated,
    ...(options.remoteContentUpload === undefined ? {} : { service: options.remoteContentUpload }) });

  const cleanupExpiredProjects = async (): Promise<void> => {
    const now = new Date().toISOString();
    while (true) {
      const purged = await repository.purgeExpiredProjects(now);
      for (const result of purged) {
        const project = result.project;
        try {
          await semanticStore.deleteProject(project.projectId);
        } catch (error) {
          app.log.error({ error, projectId: project.projectId }, "auto-purged project semantic cleanup failed");
        }
        const blobCleanup = await quarantineProjectBlobs(result.contentSha256);
        try {
          await writeAudit(repository, {
            actorId: project.ownerActorId,
            projectId: project.projectId,
            action: "project.auto-purged",
            targetId: project.projectId,
            requestId: uuidV7(),
            details: {
              purged_at: project.purgedAt,
              blob_candidates: blobCleanup.candidates,
              blobs_quarantined: blobCleanup.quarantined,
              blobs_still_referenced: blobCleanup.referenced,
              blob_quarantine_failures: blobCleanup.failed,
              blob_gc_grace_ms: config.projectBlobGcGraceMs
            }
          });
        } catch (error) {
          app.log.error({ error, projectId: project.projectId }, "auto-purge audit write failed");
        }
      }
      if (purged.length < 100) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };

  await cleanupExpiredProjects();
  await sweepQuarantinedProjectBlobs();

  let externalRefreshTimer: ReturnType<typeof setInterval> | null = null;
  if (config.externalSkillRefreshIntervalMs > 0) {
    externalRefreshTimer = setInterval(() => {
      void registry.refreshAllExternalSkills().catch((error: unknown) => {
        app.log.error({ err: error }, "external skill upstream refresh failed");
      });
    }, config.externalSkillRefreshIntervalMs);
    externalRefreshTimer.unref?.();
  }
  let projectCleanupTimer: ReturnType<typeof setInterval> | null = null;
  if (config.projectCleanupIntervalMs > 0) {
    projectCleanupTimer = setInterval(() => {
      void cleanupExpiredProjects().then(sweepQuarantinedProjectBlobs).catch((error: unknown) => {
        app.log.error({ err: error }, "project recycle-bin cleanup failed");
      });
    }, config.projectCleanupIntervalMs);
    projectCleanupTimer.unref?.();
  }
  app.addHook("onClose", async () => {
    if (externalRefreshTimer !== null) clearInterval(externalRefreshTimer);
    if (projectCleanupTimer !== null) clearInterval(projectCleanupTimer);
  });

  await app.ready();
  return app;
}
