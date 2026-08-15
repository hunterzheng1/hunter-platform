import { isProxy } from "node:util/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  remoteSyncArchiveHttpErrorCodeSchema,
  validateRemoteSyncArchiveCommitHttpRequest,
  validateRemoteSyncArchiveCommitHttpResponse,
  validateRemoteSyncArchiveLookupHttpRequest,
  validateRemoteSyncArchivePrepareHttpRequest,
  validateRemoteSyncArchivePrepareHttpResponse,
  validateRemoteSyncArchiveReceiptHttpResponse,
  validateRemoteSyncArchiveStatusHttpResponse,
  type RemoteSyncArchiveCommitHttpRequest,
  type RemoteSyncArchiveLookupHttpRequest,
  type RemoteSyncArchivePrepareHttpRequest,
  type RemoteSyncArchiveSourceHttp,
} from "@hunter-harness/contracts";

import type { Actor, ProjectKeyScope, ServerRepository } from "../repositories/interfaces.js";
import { ServerDomainError } from "../repositories/interfaces.js";
import type { RemoteSyncArchiveHttpServicePort } from "./ports.js";

export interface RemoteSyncArchiveHttpRoutesOptions {
  readonly repository: ServerRepository;
  readonly service?: RemoteSyncArchiveHttpServicePort;
  readonly authenticated: (
    request: FastifyRequest,
    repository: ServerRepository,
    scope?: ProjectKeyScope
  ) => Promise<{ readonly actor: Actor; readonly requestId: string }>;
}

type Methods = {
  readonly prepare: RemoteSyncArchiveHttpServicePort["prepare"];
  readonly commit: RemoteSyncArchiveHttpServicePort["commit"];
  readonly status: RemoteSyncArchiveHttpServicePort["status"];
  readonly receipt: RemoteSyncArchiveHttpServicePort["receipt"];
};

function fail(status: number, code: string, message: string): never {
  throw new ServerDomainError(status, code, message);
}

function resolveService(value: RemoteSyncArchiveHttpServicePort | undefined): Methods | null {
  if (value === undefined || isProxy(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = ["prepare", "commit", "status", "receipt"] as const;
    const methods = {} as { -readonly [K in keyof Methods]: Methods[K] };
    for (const name of names) {
      const descriptor = descriptors[name];
      if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "function" || isProxy(descriptor.value)) return null;
      (methods as unknown as Record<string, unknown>)[name] = descriptor.value;
    }
    return methods as Methods;
  } catch {
    return null;
  }
}

function pathParams(request: FastifyRequest): { project_id: string; branch_name: string } {
  const raw = request.params as Record<string, unknown>;
  const project = raw.projectId;
  const branch = raw.branchName;
  if (typeof project !== "string" || !/^prj_[A-Za-z0-9_-]{1,156}$/u.test(project) ||
      typeof branch !== "string" || branch.length < 1 || branch.length > 160 || branch.trim() !== branch ||
      [...branch].some((character) => { const point = character.codePointAt(0) ?? 0; return point <= 31 || point === 127 || character === "/" || character === "\\"; })) {
    fail(400, "VALIDATION_FAILED", "remote archive project or branch is invalid");
  }
  return { project_id: project, branch_name: branch };
}

async function bindProject(repository: ServerRepository, actorId: string, projectId: string): Promise<void> {
  try {
    await repository.getProject(actorId, projectId);
  } catch (error) {
    if (error instanceof ServerDomainError && error.status < 500) fail(403, "PROJECT_INFORMATION_FORBIDDEN", "project is not accessible");
    fail(503, "REMOTE_UNAVAILABLE", "project authority is unavailable");
  }
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return typeof value === "string" ? value : undefined;
}

function requiredHeader(request: FastifyRequest, name: string): string {
  const value = header(request, name);
  if (value === undefined || value.length === 0) fail(400, "REMOTE_ARCHIVE_INPUT_INVALID", `${name} is required`);
  return value;
}

function bodyRecord(request: FastifyRequest): Record<string, unknown> {
  const value = request.body;
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) {
    fail(400, "REMOTE_ARCHIVE_INPUT_INVALID", "remote archive body is invalid");
  }
  return value as Record<string, unknown>;
}

function sourceFor(path: { project_id: string; branch_name: string }, actorId: string, raw: unknown): RemoteSyncArchiveSourceHttp {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || isProxy(raw)) fail(403, "PROJECT_INFORMATION_FORBIDDEN", "remote archive source is outside the project");
  const source = raw as Record<string, unknown>;
  if (source.project_id !== path.project_id || source.branch_name !== path.branch_name || source.actor_id !== actorId) {
    fail(403, "PROJECT_INFORMATION_FORBIDDEN", "remote archive source is outside the project");
  }
  return source as RemoteSyncArchiveSourceHttp;
}

function mapError(error: unknown): never {
  let code: unknown;
  try {
    if (error !== null && typeof error === "object" && !isProxy(error)) {
      const descriptor = Object.getOwnPropertyDescriptor(error, "code");
      code = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
    }
  } catch { code = undefined; }
  const parsed = typeof code === "string" ? remoteSyncArchiveHttpErrorCodeSchema.safeParse(code) : null;
  if (parsed === null || !parsed.success) fail(503, "REMOTE_UNAVAILABLE", "remote archive service is unavailable");
  const status = parsed.data === "REMOTE_ARCHIVE_IDEMPOTENCY_CONFLICT" || parsed.data === "REMOTE_ARCHIVE_LEASE_FENCED" ||
    parsed.data === "REMOTE_ARCHIVE_LEASE_SCOPE_MISMATCH" || parsed.data === "REMOTE_ARCHIVE_CAPABILITY_UNAVAILABLE" ||
    parsed.data === "REMOTE_ARCHIVE_COMMIT_AMBIGUOUS" ? 409
    : parsed.data === "REMOTE_ARCHIVE_PREPARE_NOT_FOUND" ? 404
      : parsed.data === "REMOTE_ARCHIVE_PREPARE_EXPIRED" ? 410
        : parsed.data === "REMOTE_ARCHIVE_PAYLOAD_HASH_MISMATCH" ? 422
          : parsed.data === "REMOTE_ARCHIVE_INPUT_INVALID" || parsed.data === "REMOTE_ARCHIVE_RECORD_INVALID" ? 400 : 503;
  fail(status, parsed.data, "remote archive operation failed");
}

function nativePromise<T>(value: unknown): Promise<T> | null {
  if (value === null || typeof value !== "object" || isProxy(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Promise.prototype || Reflect.ownKeys(Object.getOwnPropertyDescriptors(value)).length !== 0) return null;
    return value as Promise<T>;
  } catch { return null; }
}

async function call<T, I>(method: (input: I) => unknown, input: I): Promise<T> {
  let raw: unknown;
  try { raw = Reflect.apply(method, undefined, [input]); } catch (error) { return mapError(error); }
  const promise = nativePromise<T>(raw);
  if (promise === null) fail(503, "REMOTE_UNAVAILABLE", "remote archive service is unavailable");
  try { return await promise; } catch (error) { return mapError(error); }
}

function validate<T>(result: { success: boolean; data?: T }, message: string): T {
  if (!result.success) fail(503, "REMOTE_UNAVAILABLE", message);
  return result.data as T;
}

function fastifyPath(path: string): string {
  return path.replace("{project_id}", ":projectId").replace("{branch_name}", ":branchName")
    .replace("{operation_id}", ":operationId").replace("/archive:prepare", "/archive/prepare")
    .replace("/archive:commit", "/archive/commit");
}

export function registerRemoteSyncArchiveHttpRoutes(app: FastifyInstance, options: RemoteSyncArchiveHttpRoutesOptions): void {
  const methods = resolveService(options.service);

  const prepare = async (request: FastifyRequest, reply: FastifyReply) => {
    const { actor, requestId } = await options.authenticated(request, options.repository, "archive:write");
    const path = pathParams(request);
    await bindProject(options.repository, actor.actorId, path.project_id);
    if (methods === null) fail(503, "REMOTE_UNAVAILABLE", options.service === undefined ? "remote archive service is not configured" : "remote archive service is unavailable");
    const body = bodyRecord(request);
    const idem = requiredHeader(request, "idempotency-key");
    const candidate = validate<RemoteSyncArchivePrepareHttpRequest>(validateRemoteSyncArchivePrepareHttpRequest(body), "remote archive request is invalid");
    if (candidate.idempotency_key !== idem) fail(409, "REMOTE_ARCHIVE_IDEMPOTENCY_CONFLICT", "Idempotency-Key does not match request");
    sourceFor(path, actor.actorId, candidate.metadata.source);
    const result = await call(methods.prepare, candidate as unknown as Parameters<typeof methods.prepare>[0]);
    const response = validate(validateRemoteSyncArchivePrepareHttpResponse(result), "remote archive service returned invalid response");
    if (response.record.source.project_id !== path.project_id || response.record.source.branch_name !== path.branch_name || response.record.source.actor_id !== actor.actorId) {
      fail(503, "REMOTE_UNAVAILABLE", "remote archive service returned an out-of-scope record");
    }
    return reply.header("X-Request-Id", requestId).code(response.outcome === "new" ? 201 : 200).send(response);
  };

  const commit = async (request: FastifyRequest, reply: FastifyReply) => {
    const { actor, requestId } = await options.authenticated(request, options.repository, "archive:write");
    const path = pathParams(request);
    await bindProject(options.repository, actor.actorId, path.project_id);
    if (methods === null) fail(503, "REMOTE_UNAVAILABLE", options.service === undefined ? "remote archive service is not configured" : "remote archive service is unavailable");
    const body = bodyRecord(request);
    const idem = requiredHeader(request, "idempotency-key");
    const candidate = validate<RemoteSyncArchiveCommitHttpRequest>(validateRemoteSyncArchiveCommitHttpRequest(body), "remote archive commit request is invalid");
    if (candidate.idempotency_key !== idem) fail(409, "REMOTE_ARCHIVE_IDEMPOTENCY_CONFLICT", "Idempotency-Key does not match request");
    sourceFor(path, actor.actorId, candidate.claim.source);
    // HTTP carries idempotency/payload echoes for transport binding; the Core
    // commit seam consumes the authoritative fenced claim only.
    const result = await call(methods.commit, { claim: candidate.claim } as unknown as Parameters<typeof methods.commit>[0]);
    const response = validate(validateRemoteSyncArchiveCommitHttpResponse(result), "remote archive service returned invalid response");
    if (response.record.source.project_id !== path.project_id || response.record.source.branch_name !== path.branch_name || response.record.source.actor_id !== actor.actorId) {
      fail(503, "REMOTE_UNAVAILABLE", "remote archive service returned an out-of-scope record");
    }
    return reply.header("X-Request-Id", requestId).code(200).send(response);
  };

  const lookupInput = (request: FastifyRequest, actor: Actor, operationIdOverride?: unknown): RemoteSyncArchiveLookupHttpRequest => {
    const path = pathParams(request);
    const query = request.query as Record<string, unknown>;
    const source = {
      project_id: path.project_id, branch_name: path.branch_name, actor_id: actor.actorId,
      ...(typeof query.commit_sha === "string" ? { commit_sha: query.commit_sha } : {}),
      ...(typeof query.client_id === "string" ? { client_id: query.client_id } : {}),
      ...(typeof query.change_key === "string" ? { change_key: query.change_key } : {})
    };
    return validate<RemoteSyncArchiveLookupHttpRequest>(validateRemoteSyncArchiveLookupHttpRequest({ operation_id: operationIdOverride ?? query.operation_id, source }), "remote archive lookup request is invalid");
  };

  const status = async (request: FastifyRequest, reply: FastifyReply) => {
    const { actor, requestId } = await options.authenticated(request, options.repository, "archive:read");
    const path = pathParams(request);
    await bindProject(options.repository, actor.actorId, path.project_id);
    if (methods === null) fail(503, "REMOTE_UNAVAILABLE", options.service === undefined ? "remote archive service is not configured" : "remote archive service is unavailable");
    const input = lookupInput(request, actor);
    const result = await call(methods.status, input as unknown as Parameters<typeof methods.status>[0]);
    const response = validate(validateRemoteSyncArchiveStatusHttpResponse(result), "remote archive service returned invalid status");
    return reply.header("X-Request-Id", requestId).code(200).send(response);
  };

  const receipt = async (request: FastifyRequest, reply: FastifyReply) => {
    const { actor, requestId } = await options.authenticated(request, options.repository, "archive:read");
    const path = pathParams(request);
    await bindProject(options.repository, actor.actorId, path.project_id);
    if (methods === null) fail(503, "REMOTE_UNAVAILABLE", options.service === undefined ? "remote archive service is not configured" : "remote archive service is unavailable");
    const params = request.params as Record<string, unknown>;
    const input = lookupInput(request, actor, params.operationId);
    const value = await call(methods.receipt, input as unknown as Parameters<typeof methods.receipt>[0]);
    const response = validate(validateRemoteSyncArchiveReceiptHttpResponse({ receipt: value }), "remote archive service returned invalid receipt");
    return reply.header("X-Request-Id", requestId).code(200).send(response);
  };

  app.post(fastifyPath("/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/archive:prepare"), prepare);
  app.post(fastifyPath("/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/archive:commit"), commit);
  app.get(fastifyPath("/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/archive/status"), status);
  app.get(fastifyPath("/api/v1/projects/{project_id}/branches/{branch_name}/remote-sync/archive/{operation_id}/receipt"), receipt);
}
