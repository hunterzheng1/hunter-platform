import {
  PLATFORM_INFORMATION_HTTP_OPERATIONS,
  canonicalJson,
  platformInformationExportCreateHttpRequestSchema,
  normalizePlatformInformationListHttpQuery,
  platformInformationPageSchema,
  verifyPlatformInformationExportResult,
  platformInformationPreviewRestoreHttpRequestSchema,
  platformInformationRetryExtractionHttpRequestSchema,
  platformInformationViewSchema,
  validatePlatformInformationConfirmRestoreHttpRequest
} from "@hunter-harness/contracts";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { BranchVersionQueryAdapter } from "../branch-version-query/index.js";
import type { BranchMonitorQueryAdapter } from "../branch-monitor-query/index.js";
import type { ChangeRecordsQueryAdapter } from "../change-records-query/index.js";
import type { ProjectKnowledgeQueryAdapter } from "../project-knowledge-query/index.js";
import type { ProjectMaterialsQueryAdapter } from "../project-materials/query-adapter.js";
import type {
  PlatformInformationExportModule,
  PlatformInformationExportRecordPort,
  PlatformInformationExportDownloadPort,
} from "../platform-information-export/index.js";
import type { Actor, ProjectKeyScope, ServerRepository } from "../repositories/interfaces.js";
import { ServerDomainError } from "../repositories/interfaces.js";

type PlatformInformationView = z.infer<typeof platformInformationViewSchema>;
type BackendUnavailableCode = "PLATFORM_INFORMATION_UNAVAILABLE" |
  "PLATFORM_INFORMATION_EXPORT_UNAVAILABLE" |
  "PLATFORM_INFORMATION_EXPORT_DOWNLOAD_UNAVAILABLE";

export interface PlatformInformationAdapters {
  readonly branchMonitor?: BranchMonitorQueryAdapter;
  readonly branchVersion?: BranchVersionQueryAdapter;
  readonly projectMaterials?: ProjectMaterialsQueryAdapter;
  readonly projectKnowledge?: ProjectKnowledgeQueryAdapter;
  readonly changeRecords?: ChangeRecordsQueryAdapter;
  readonly export_module?: PlatformInformationExportModule;
  readonly export_records?: PlatformInformationExportRecordPort;
  readonly export_download?: PlatformInformationExportDownloadPort;
  /** Production lifecycle owner for the export CAS, GC worker, and DB singleton lease. */
  readonly export_close?: () => Promise<void>;
}

export interface PlatformInformationRoutesOptions {
  readonly repository: ServerRepository;
  readonly adapters?: PlatformInformationAdapters;
  readonly authenticated: (
    request: FastifyRequest,
    repository: ServerRepository,
    projectScope?: ProjectKeyScope
  ) => Promise<{ actor: Actor; requestId: string }>;
}

function requireBranchMonitorAdapter(
  adapter: BranchMonitorQueryAdapter | undefined
): BranchMonitorQueryAdapter {
  if (adapter === undefined) unavailable("Stage 12 monitor verifier is not configured");
  return adapter;
}
function requireAdapter<T>(adapter: T | undefined, name: string): T {
  if (adapter === undefined) unavailable(`${name} adapter is not configured`);
  return adapter;
}

const rawListQuerySchema = z.object({
  limit: z.union([z.string().regex(/^\d{1,3}$/u), z.number().int()]).optional(),
  cursor: z.string().optional()
}).strict();
const projectIdSchema = z.string().regex(/^prj_[A-Za-z0-9_-]{1,156}$/u);

const policies = Object.freeze({
  branch_monitor: Object.freeze({
    scope: "platform:read" as const,
    content_types: Object.freeze(["run_event"] as const),
    sort: "last_event_at_desc_run_id_asc" as const
  }),
  branch_files: Object.freeze({
    scope: "files:read" as const,
    content_types: Object.freeze(["branch_file"] as const),
    sort: "uploaded_at_desc_snapshot_version_asc" as const
  }),
  project_materials: Object.freeze({
    scope: "files:read" as const,
    content_types: Object.freeze(["config", "rule", "architecture", "instruction"] as const),
    sort: "category_asc_path_asc_version_desc" as const
  }),
  project_knowledge: Object.freeze({
    scope: "knowledge:read" as const,
    content_types: Object.freeze(["knowledge_entry"] as const),
    sort: "extracted_at_desc_knowledge_id_asc" as const
  }),
  change_records: Object.freeze({
    scope: "files:read" as const,
    content_types: Object.freeze([
      "change_document", "archive_package", "project_content_candidate"
    ] as const),
    sort: "archived_at_desc_change_key_asc" as const
  }),
  version_records: Object.freeze({
    scope: "files:read" as const,
    content_types: Object.freeze(["branch_file"] as const),
    sort: "uploaded_at_desc_snapshot_version_asc" as const
  })
});

function fastifyPath(operation: { readonly path: string; readonly fastify_path?: string }): string {
  return operation.fastify_path ?? operation.path
    .replace("{project_id}", ":projectId")
    .replace("{view}", ":view")
    .replace("{detail_id}", ":detailId");
}

async function bindProject(
  repository: ServerRepository,
  actorId: string,
  projectId: string,
  backendCode: BackendUnavailableCode = "PLATFORM_INFORMATION_UNAVAILABLE"
): Promise<void> {
  try {
    await repository.getProject(actorId, projectId);
  } catch (error) {
    if (!(error instanceof ServerDomainError)) {
      throw new ServerDomainError(503, backendCode, "platform information storage is unavailable");
    }
    throw new ServerDomainError(
      403,
      "PROJECT_INFORMATION_FORBIDDEN",
      "project information is not accessible"
    );
  }
}

function unavailable(message: string): never {
  throw new ServerDomainError(503, "PLATFORM_INFORMATION_UNAVAILABLE", message);
}

async function backendOperation<T>(
  operation: () => Promise<T>,
  code: BackendUnavailableCode,
  message: string
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ServerDomainError) throw error;
    throw new ServerDomainError(503, code, message);
  }
}

function requireProjectId(value: string): string {
  if (!projectIdSchema.safeParse(value).success) {
    throw new ServerDomainError(400, "VALIDATION_FAILED", "project id is invalid");
  }
  return value;
}

function routeFailure(reason: string, operation: "list" | "detail" | "preview" | "retry"): never {
  if (reason.endsWith("_CURSOR_INVALID")) {
    throw new ServerDomainError(400, "PLATFORM_INFORMATION_CURSOR_INVALID", "cursor is invalid");
  }
  if (reason === "PROJECT_KNOWLEDGE_RETRY_JOB_NOT_FOUND") {
    throw new ServerDomainError(404, "KNOWLEDGE_EXTRACTION_JOB_NOT_FOUND", "extraction job was not found");
  }
  if (reason === "PROJECT_KNOWLEDGE_RETRY_GENERATION_CONFLICT") {
    throw new ServerDomainError(409, "KNOWLEDGE_EXTRACTION_GENERATION_CONFLICT", "extraction generation is stale");
  }
  if (reason.endsWith("_NOT_FOUND")) {
    throw new ServerDomainError(404, "PLATFORM_INFORMATION_DETAIL_NOT_FOUND", "detail was not found");
  }
  if (reason === "BRANCH_FILES_RESTORE_PREVIEW_INVALID") {
    throw new ServerDomainError(422, reason, "restore preview request is invalid");
  }
  if (reason === "PROJECT_KNOWLEDGE_RETRY_REQUEST_INVALID") {
    throw new ServerDomainError(422, "KNOWLEDGE_EXTRACTION_RETRY_REQUEST_INVALID", "retry request is invalid");
  }
  if (reason === "PROJECT_KNOWLEDGE_RETRY_AUTHORITY_INVALID") {
    throw new ServerDomainError(503, "KNOWLEDGE_EXTRACTION_RETRY_AUTHORITY_INVALID", "retry authority is unavailable");
  }
  if (reason === "PROJECT_KNOWLEDGE_RETRY_INTENT_INVALID") {
    throw new ServerDomainError(503, "KNOWLEDGE_EXTRACTION_RETRY_INTENT_INVALID", "retry intent is unavailable");
  }
  if (reason.endsWith("_SOURCE_INVALID") || reason.endsWith("_LEGACY_READ_ONLY")) {
    throw new ServerDomainError(503, "PLATFORM_INFORMATION_SOURCE_INVALID", "information source is unavailable");
  }
  if (operation === "preview") {
    throw new ServerDomainError(422, "BRANCH_FILES_RESTORE_PREVIEW_INVALID", "restore preview request is invalid");
  }
  if (operation === "retry") {
    throw new ServerDomainError(422, "KNOWLEDGE_EXTRACTION_RETRY_REQUEST_INVALID", "retry request is invalid");
  }
  throw new ServerDomainError(400, "VALIDATION_FAILED", `${operation} request is invalid`);
}

function canonicalRequest(
  actorId: string,
  projectId: string,
  view: PlatformInformationView,
  request: { limit: number; cursor: string | null } | { detail_id: string }
): string {
  const policy = policies[view];
  const queryScope = {
    actor_id: actorId,
    accessible_project_ids: [projectId],
    content_types: [...policy.content_types]
  };
  return "detail_id" in request
    ? JSON.stringify({
        schema_version: 1,
        contract_kind: "detail_request",
        view,
        project_id: projectId,
        query_scope: queryScope,
        detail_id: request.detail_id
      })
    : JSON.stringify({
        schema_version: 1,
        contract_kind: "query",
        view,
        project_id: projectId,
        query_scope: queryScope,
        limit: request.limit,
        cursor: request.cursor,
        cursor_verification: "server_port_required",
        sort: policy.sort
      });
}

function exportQuery(
  actorId: string,
  projectId: string,
  view: PlatformInformationView,
  request: { readonly limit: number; readonly cursor: string | null }
): Record<string, unknown> {
  return JSON.parse(canonicalRequest(actorId, projectId, view, request)) as Record<string, unknown>;
}

function exportQueryHash(query: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(canonicalJson(query)).digest("hex")}`;
}

function idempotencyHeader(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new ServerDomainError(422, "PLATFORM_INFORMATION_EXPORT_IDEMPOTENCY_REQUIRED",
      "Idempotency-Key must be a sha256 identity");
  }
  return value;
}

const maximumExportPages = 10_000;

async function queryPage(
  adapters: PlatformInformationAdapters,
  view: PlatformInformationView,
  serialized: string
) {
  return backendOperation(async () => view === "branch_monitor"
    ? requireBranchMonitorAdapter(adapters.branchMonitor).queryPage(serialized)
    : view === "project_materials"
      ? requireAdapter(adapters.projectMaterials, "project materials").query(serialized)
      : view === "project_knowledge"
        ? requireAdapter(adapters.projectKnowledge, "project knowledge").queryPage(serialized)
        : view === "change_records"
          ? requireAdapter(adapters.changeRecords, "change records").queryPage(serialized)
          : requireAdapter(adapters.branchVersion, "branch version").query(serialized),
  "PLATFORM_INFORMATION_UNAVAILABLE", "platform information source is unavailable");
}

export function registerPlatformInformationRoutes(
  app: FastifyInstance,
  options: PlatformInformationRoutesOptions
): void {
  const { repository, adapters, authenticated } = options;
  const exportClaims = new Map<string, Promise<void>>();

  async function withExportClaim<T>(claimKey: string, operation: () => Promise<T>): Promise<T> {
    const predecessor = exportClaims.get(claimKey) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = predecessor.then(() => gate);
    exportClaims.set(claimKey, tail);
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
      if (exportClaims.get(claimKey) === tail) exportClaims.delete(claimKey);
    }
  }
  if (adapters?.export_close !== undefined) {
    app.addHook("onClose", async () => { await adapters.export_close?.(); });
  }

  app.get(fastifyPath(PLATFORM_INFORMATION_HTTP_OPERATIONS.list), async (request, reply) => {
    const params = request.params as { projectId: string; view: string };
    const projectId = requireProjectId(params.projectId);
    const rawView = params.view;
    const viewResult = platformInformationViewSchema.safeParse(rawView);
    if (!viewResult.success) {
      throw new ServerDomainError(400, "VALIDATION_FAILED", "information view is invalid");
    }
    const view = viewResult.data;
    const { actor, requestId } = await authenticated(request, repository, policies[view].scope);
    await bindProject(repository, actor.actorId, projectId);
    if (adapters === undefined) unavailable("platform information adapters are not configured");

    const raw = rawListQuerySchema.safeParse(request.query);
    const normalized = normalizePlatformInformationListHttpQuery(raw.success ? {
      ...(raw.data.limit === undefined ? {} : { limit: Number(raw.data.limit) }),
      ...(raw.data.cursor === undefined ? {} : { cursor: raw.data.cursor })
    } : request.query);
    if (!normalized.ok) routeFailure(normalized.reason_code, "list");
    const serialized = canonicalRequest(actor.actorId, projectId, view, normalized.value);
    const result = await queryPage(adapters, view, serialized);
    if (!result.ok) routeFailure(result.reason_code, "list");
    if ("mode" in result && result.mode === "legacy_read_only") {
      routeFailure("PLATFORM_INFORMATION_LEGACY_READ_ONLY", "list");
    }
    reply.header(PLATFORM_INFORMATION_HTTP_OPERATIONS.list.request_id_header, requestId);
    return result.value;
  });

  app.get(fastifyPath(PLATFORM_INFORMATION_HTTP_OPERATIONS.export_all), async (request, reply) => {
    const params = request.params as { projectId: string; view: string };
    const projectId = requireProjectId(params.projectId);
    const viewResult = platformInformationViewSchema.safeParse(params.view);
    if (!viewResult.success) {
      throw new ServerDomainError(400, "VALIDATION_FAILED", "information view is invalid");
    }
    const view = viewResult.data;
    const { actor, requestId } = await authenticated(request, repository, "platform:read");
    await bindProject(repository, actor.actorId, projectId);
    if (adapters === undefined) unavailable("platform information adapters are not configured");
    const raw = rawListQuerySchema.safeParse(request.query);
    const normalized = normalizePlatformInformationListHttpQuery(raw.success ? {
      ...(raw.data.limit === undefined ? {} : { limit: Number(raw.data.limit) }),
      ...(raw.data.cursor === undefined ? {} : { cursor: raw.data.cursor })
    } : request.query);
    if (!normalized.ok) routeFailure(normalized.reason_code, "list");

    const sourceCursor = normalized.value.cursor;
    const initialSerialized = canonicalRequest(actor.actorId, projectId, view, normalized.value);
    const expectedQuery = JSON.parse(initialSerialized) as {
      query_scope: { actor_id: string; accessible_project_ids: string[]; content_types: string[] };
      limit: number;
      cursor: string | null;
      cursor_verification: "server_port_required";
      sort: "last_event_at_desc_run_id_asc" | "uploaded_at_desc_snapshot_version_asc" |
        "category_asc_path_asc_version_desc" | "extracted_at_desc_knowledge_id_asc" |
        "archived_at_desc_change_key_asc";
    };
    const pages: Array<{
      request_cursor: string | null;
      response_next_cursor: string | null;
      result_count: number;
    }> = [];
    const seen = new Set<string>(sourceCursor === null ? [] : [sourceCursor]);
    let cursor = sourceCursor;
    let exportedCount = 0;
    for (let pageNumber = 0; pageNumber < maximumExportPages; pageNumber += 1) {
      const serialized = canonicalRequest(actor.actorId, projectId, view, {
        limit: normalized.value.limit,
        cursor
      });
      const result = await queryPage(adapters, view, serialized);
      if (!result.ok) routeFailure(result.reason_code, "list");
      if ("mode" in result && result.mode === "legacy_read_only") {
        routeFailure("PLATFORM_INFORMATION_LEGACY_READ_ONLY", "list");
      }
      const parsedPage = platformInformationPageSchema.safeParse(result.value);
      if (!parsedPage.success) {
        throw new ServerDomainError(503, "PLATFORM_INFORMATION_SOURCE_INVALID", "export source page is invalid");
      }
      const page = parsedPage.data;
      if (page.view !== view || page.project_id !== projectId || page.sort !== policies[view].sort ||
          page.items.length > normalized.value.limit) {
        throw new ServerDomainError(503, "PLATFORM_INFORMATION_SOURCE_INVALID", "export page is outside its trusted range");
      }
      if (page.page_state === "forbidden") {
        throw new ServerDomainError(403, "PROJECT_INFORMATION_FORBIDDEN", "project information is not accessible");
      }
      if (page.page_state === "processing") unavailable("export source is still processing");
      if (page.page_state === "partial_failure" || page.page_state === "failed") {
        throw new ServerDomainError(503, "PLATFORM_INFORMATION_SOURCE_INVALID", "export source is incomplete");
      }
      pages.push({
        request_cursor: cursor,
        response_next_cursor: page.next_cursor,
        result_count: page.items.length
      });
      exportedCount += page.items.length;
      if (page.next_cursor === null) {
        const proof = {
          schema_version: 1 as const,
          contract_kind: "export_all_result" as const,
          view,
          project_id: projectId,
          range: {
            query_scope: expectedQuery.query_scope,
            limit: expectedQuery.limit,
            source_cursor: sourceCursor,
            cursor_verification: expectedQuery.cursor_verification,
            sort: expectedQuery.sort
          },
          pages,
          exported_count: exportedCount,
          completed: true as const
        };
        const verified = verifyPlatformInformationExportResult(JSON.stringify(proof), expectedQuery);
        if (!verified.ok) unavailable("export proof verification failed");
        reply.header(PLATFORM_INFORMATION_HTTP_OPERATIONS.export_all.request_id_header, requestId);
        return verified.value;
      }
      if (page.next_cursor === cursor || seen.has(page.next_cursor)) {
        throw new ServerDomainError(503, "PLATFORM_INFORMATION_SOURCE_INVALID", "export cursor did not progress");
      }
      seen.add(page.next_cursor);
      cursor = page.next_cursor;
    }
    unavailable("export page bound was exceeded");
  });

  /**
   * Durable export creation.  GET :export-all above remains the deprecated,
   * read-only proof operation; this POST is the only operation that creates
   * an artifact and its durable idempotency record.
   */
  app.post(fastifyPath(PLATFORM_INFORMATION_HTTP_OPERATIONS.create_export), async (request, reply) => {
    const params = request.params as { projectId: string; view: string };
    const projectId = requireProjectId(params.projectId);
    const viewResult = platformInformationViewSchema.safeParse(params.view);
    if (!viewResult.success) {
      throw new ServerDomainError(400, "VALIDATION_FAILED", "information view is invalid");
    }
    const view = viewResult.data;
    const { actor, requestId } = await authenticated(request, repository, policies[view].scope);
    await bindProject(repository, actor.actorId, projectId, "PLATFORM_INFORMATION_EXPORT_UNAVAILABLE");
    if (adapters?.export_module === undefined || adapters.export_records === undefined) {
      throw new ServerDomainError(503, "PLATFORM_INFORMATION_EXPORT_UNAVAILABLE",
        "durable platform information export is not configured");
    }
    const exportModule = adapters.export_module;
    const exportRecords = adapters.export_records;
    const body = platformInformationExportCreateHttpRequestSchema.safeParse(request.body);
    if (!body.success) {
      throw new ServerDomainError(400, "VALIDATION_FAILED", "export request is invalid");
    }
    const idempotencyKey = idempotencyHeader(request);
    const query = exportQuery(actor.actorId, projectId, view, body.data);
    const queryHash = exportQueryHash(query);
    const now = new Date().toISOString();
    return withExportClaim(`${actor.actorId}\0${projectId}\0${idempotencyKey}`, async () => {
    const existing = await backendOperation(() => exportRecords.findReadyByIdempotency({
      actor_id: actor.actorId,
      project_id: projectId,
      idempotency_key: idempotencyKey,
      query_hash: queryHash,
      now,
    }), "PLATFORM_INFORMATION_EXPORT_UNAVAILABLE", "platform information export storage is unavailable");
    if (existing.status === "conflict") {
      throw new ServerDomainError(409, "PLATFORM_INFORMATION_EXPORT_IDEMPOTENCY_CONFLICT",
        "Idempotency-Key is already bound to a different query");
    }
    if (existing.status === "expired") {
      throw new ServerDomainError(410, "PLATFORM_INFORMATION_EXPORT_EXPIRED",
        "the idempotent export receipt has expired");
    }
    if (existing.status === "ready") {
      reply.code(200).header(PLATFORM_INFORMATION_HTTP_OPERATIONS.create_export.request_id_header, requestId);
      return existing.record.receipt;
    }
    const generated = await backendOperation(() => exportModule.export_all(query),
      "PLATFORM_INFORMATION_EXPORT_UNAVAILABLE", "platform information export source is unavailable");
    if (!generated.ok) {
      throw new ServerDomainError(503, "PLATFORM_INFORMATION_EXPORT_SOURCE_INVALID",
        `export failed: ${generated.reason_code}`);
    }
    const published = await backendOperation(() => exportRecords.publishReady({
      actor_id: actor.actorId,
      idempotency_key: idempotencyKey,
      query_hash: queryHash,
      receipt: generated.value,
    }), "PLATFORM_INFORMATION_EXPORT_UNAVAILABLE", "platform information export storage is unavailable");
    if (published.status === "conflict") {
      throw new ServerDomainError(409, "PLATFORM_INFORMATION_EXPORT_IDEMPOTENCY_CONFLICT",
        `export publication conflict: ${published.reason_code}`);
    }
    reply.code(published.status === "existing" ? 200 : 201)
      .header(PLATFORM_INFORMATION_HTTP_OPERATIONS.create_export.request_id_header, requestId);
    return published.record.receipt;
    });
  });

  /** Stream a ready artifact after the record Port has applied actor/project/expiry ACL. */
  app.get(fastifyPath(PLATFORM_INFORMATION_HTTP_OPERATIONS.download_export), async (request, reply) => {
    const params = request.params as { projectId: string; view: string; exportId: string };
    const projectId = requireProjectId(params.projectId);
    const viewResult = platformInformationViewSchema.safeParse(params.view);
    if (!viewResult.success || !/^export_[A-Za-z0-9_-]{1,156}$/u.test(params.exportId)) {
      throw new ServerDomainError(400, "VALIDATION_FAILED", "export download request is invalid");
    }
    const view = viewResult.data;
    const { actor, requestId } = await authenticated(request, repository, policies[view].scope);
    await bindProject(repository, actor.actorId, projectId,
      "PLATFORM_INFORMATION_EXPORT_DOWNLOAD_UNAVAILABLE");
    if (adapters?.export_records === undefined || adapters.export_download === undefined) {
      throw new ServerDomainError(503, "PLATFORM_INFORMATION_EXPORT_DOWNLOAD_UNAVAILABLE",
        "platform information export download is not configured");
    }
    const exportRecords = adapters.export_records;
    const result = await backendOperation(() => exportRecords.getReadyForDownload({
      actor_id: actor.actorId,
      project_id: projectId,
      export_id: params.exportId,
      now: new Date().toISOString(),
    }), "PLATFORM_INFORMATION_EXPORT_DOWNLOAD_UNAVAILABLE",
    "platform information export download is unavailable");
    if (result.status === "not_found") {
      throw new ServerDomainError(404, "PLATFORM_INFORMATION_EXPORT_NOT_FOUND", "export not found");
    }
    if (result.status === "expired") {
      throw new ServerDomainError(410, "PLATFORM_INFORMATION_EXPORT_EXPIRED", "export has expired");
    }
    if (result.record.receipt.view !== view) {
      throw new ServerDomainError(404, "PLATFORM_INFORMATION_EXPORT_NOT_FOUND", "export not found");
    }
    let bytes: AsyncIterable<Uint8Array>;
    try {
      bytes = await adapters.export_download.open(result.record.receipt.download_ref);
    } catch {
      throw new ServerDomainError(503, "PLATFORM_INFORMATION_EXPORT_DOWNLOAD_UNAVAILABLE",
        "export download is unavailable");
    }
    reply
      .header("Content-Type", result.record.receipt.artifact.media_type)
      .header("Content-Length", String(result.record.receipt.artifact.byte_count))
      .header("Content-Disposition", `attachment; filename="${result.record.receipt.export_id}.ndjson"`)
      .header("X-Content-SHA256", result.record.receipt.artifact.content_sha)
      .header(PLATFORM_INFORMATION_HTTP_OPERATIONS.download_export.request_id_header, requestId);
    return reply.send(Readable.from(bytes, { objectMode: false }));
  });

  app.get(fastifyPath(PLATFORM_INFORMATION_HTTP_OPERATIONS.detail), async (request, reply) => {
    const params = request.params as {
      projectId: string; view: string; detailId: string;
    };
    const projectId = requireProjectId(params.projectId);
    const { view: rawView, detailId } = params;
    const viewResult = platformInformationViewSchema.safeParse(rawView);
    if (!viewResult.success || detailId.length === 0 || detailId.length > 160) {
      throw new ServerDomainError(400, "VALIDATION_FAILED", "information detail request is invalid");
    }
    const view = viewResult.data;
    const { actor, requestId } = await authenticated(request, repository, policies[view].scope);
    await bindProject(repository, actor.actorId, projectId);
    if (view === "branch_files" || view === "version_records") {
      unavailable("trusted detail locator is not wired");
    }
    if (adapters === undefined) unavailable("platform information adapters are not configured");
    const serialized = canonicalRequest(actor.actorId, projectId, view, { detail_id: detailId });
    const result = view === "branch_monitor"
      ? await requireBranchMonitorAdapter(adapters.branchMonitor).queryDetail(serialized)
      : view === "project_materials"
      ? await requireAdapter(adapters.projectMaterials, "project materials").detail(serialized)
      : view === "project_knowledge"
        ? await requireAdapter(adapters.projectKnowledge, "project knowledge").queryDetail(serialized)
        : await requireAdapter(adapters.changeRecords, "change records").queryDetail(serialized);
    if (!result.ok) routeFailure(result.reason_code, "detail");
    if ("mode" in result && result.mode === "legacy_read_only") {
      routeFailure("PLATFORM_INFORMATION_LEGACY_READ_ONLY", "detail");
    }
    reply.header(PLATFORM_INFORMATION_HTTP_OPERATIONS.detail.request_id_header, requestId);
    return result.value;
  });

  app.post(fastifyPath(PLATFORM_INFORMATION_HTTP_OPERATIONS.preview_restore), async (request, reply) => {
    const projectId = requireProjectId((request.params as { projectId: string }).projectId);
    const { actor, requestId } = await authenticated(request, repository, "files:read");
    await bindProject(repository, actor.actorId, projectId);
    const body = platformInformationPreviewRestoreHttpRequestSchema.safeParse(request.body);
    if (!body.success || body.data.project_id !== projectId) {
      throw new ServerDomainError(422, "BRANCH_FILES_RESTORE_PREVIEW_INVALID", "restore preview request is invalid");
    }
    if (adapters === undefined) unavailable("platform information adapters are not configured");
    const result = await requireAdapter(adapters.branchVersion, "branch version").previewRestore(JSON.stringify({
      actor_id: actor.actorId,
      accessible_project_ids: [projectId],
      client_id: actor.actorId,
      intent: body.data
    }));
    if (!result.ok) routeFailure(result.reason_code, "preview");
    reply.header(PLATFORM_INFORMATION_HTTP_OPERATIONS.preview_restore.request_id_header, requestId);
    return result.value;
  });

  app.post(fastifyPath(PLATFORM_INFORMATION_HTTP_OPERATIONS.confirm_restore), async (request, reply) => {
    const projectId = requireProjectId((request.params as { projectId: string }).projectId);
    const { actor, requestId } = await authenticated(request, repository, "files:read");
    await bindProject(repository, actor.actorId, projectId);
    const validation = validatePlatformInformationConfirmRestoreHttpRequest(
      JSON.stringify(request.body),
      { project_id: projectId, client_id: actor.actorId }
    );
    if (!validation.ok) {
      const status = validation.reason_code === "BRANCH_FILES_PULL_CONFIRMATION_MISMATCH" ? 409 : 422;
      throw new ServerDomainError(status, validation.reason_code, "restore confirmation is invalid");
    }
    reply.header(PLATFORM_INFORMATION_HTTP_OPERATIONS.confirm_restore.request_id_header, requestId);
    return validation.value;
  });

  app.post(fastifyPath(PLATFORM_INFORMATION_HTTP_OPERATIONS.retry_extraction), async (request, reply) => {
    const projectId = requireProjectId((request.params as { projectId: string }).projectId);
    const { actor, requestId } = await authenticated(request, repository, "knowledge:write");
    await bindProject(repository, actor.actorId, projectId);
    const body = platformInformationRetryExtractionHttpRequestSchema.safeParse(request.body);
    if (!body.success) routeFailure("PROJECT_KNOWLEDGE_RETRY_REQUEST_INVALID", "retry");
    if (adapters === undefined) unavailable("platform information adapters are not configured");
    const result = await requireAdapter(adapters.projectKnowledge, "project knowledge").createRetryIntent(JSON.stringify({
      schema_version: 1,
      contract_kind: "knowledge_extraction_retry_request",
      actor_id: actor.actorId,
      project_id: projectId,
      ...body.data
    }));
    if (!result.ok) routeFailure(result.reason_code, "retry");
    reply.header(PLATFORM_INFORMATION_HTTP_OPERATIONS.retry_extraction.request_id_header, requestId);
    return result.value;
  });
}
