import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  REMOTE_CONTENT_UPLOAD_HTTP_MAX_BYTES,
  REMOTE_CONTENT_UPLOAD_HTTP_MAX_CHUNK_BYTES,
  remoteContentUploadHttpErrorCodeSchema,
  validateRemoteContentUploadHttpRequestDescriptor,
  validateRemoteContentUploadHttpResult,
  validateRemoteContentUploadHttpStatus,
  validateRemoteContentUploadHttpStatusDescriptor,
  type RemoteContentUploadHttpRequestHeaders,
  type RemoteContentUploadHttpStatusHeaders,
  type RemoteContentUploadHttpRecord,
  type RemoteContentUploadHttpResult
} from "@hunter-harness/contracts";

import type { Actor, ProjectKeyScope, ServerRepository } from "../repositories/interfaces.js";
import { ServerDomainError } from "../repositories/interfaces.js";
import type { RemoteContentUploadChunk, RemoteContentUploadHttpServicePort } from "./ports.js";

export interface RemoteContentUploadHttpRoutesOptions {
  readonly repository: ServerRepository;
  readonly service?: RemoteContentUploadHttpServicePort;
  readonly authenticated: (
    request: FastifyRequest,
    repository: ServerRepository,
    scope?: ProjectKeyScope
  ) => Promise<{ readonly actor: Actor; readonly requestId: string }>;
}

type ServiceMethod = (input: unknown) => unknown;
type ServiceMethods = {
  readonly stage: ServiceMethod;
  readonly status: ServiceMethod;
};
type ServiceResolution =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "ready"; readonly methods: ServiceMethods };

function fail(status: number, code: string, message: string): never {
  throw new ServerDomainError(status, code, message);
}

/** Inspect only own data descriptors; never execute adapter getters at registration. */
function resolveService(value: RemoteContentUploadHttpServicePort | undefined): ServiceResolution {
  if (value === undefined) return { kind: "absent" };
  try {
    if (isProxy(value)) return { kind: "invalid" };
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return { kind: "invalid" };
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const stage = descriptors.stage;
    const status = descriptors.status;
    if (stage === undefined || !("value" in stage) || typeof stage.value !== "function" || isProxy(stage.value) ||
        status === undefined || !("value" in status) || typeof status.value !== "function" || isProxy(status.value)) {
      return { kind: "invalid" };
    }
    return {
      kind: "ready",
      methods: {
        stage: stage.value as ServiceMethod,
        status: status.value as ServiceMethod
      }
    };
  } catch {
    return { kind: "invalid" };
  }
}

function unavailable(resolution: ServiceResolution): never {
  if (resolution.kind === "absent") {
    fail(503, "REMOTE_UNAVAILABLE", "remote content upload service is not configured");
  }
  fail(503, "REMOTE_UNAVAILABLE", "remote content upload service is unavailable");
}

function pathParams(request: FastifyRequest): { project_id: string; branch_name: string } {
  const raw = request.params as Record<string, unknown>;
  const project = raw.projectId;
  const branch = raw.branchName;
  if (typeof project !== "string" || typeof branch !== "string" || project.length === 0 || project.length > 160 ||
      branch.length === 0 || branch.length > 160 ||
      [...project, ...branch].some((character) => {
        const point = character.codePointAt(0) ?? 0;
        return point <= 0x1f || point === 0x7f || character === "\\" || character === "/";
      }) || project.trim() !== project || branch.trim() !== branch) {
    fail(400, "VALIDATION_FAILED", "project or branch is invalid");
  }
  return { project_id: project, branch_name: branch };
}

function readHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return typeof value === "string" ? value : undefined;
}

function addOptionalHeader(
  output: Record<string, unknown>,
  request: FastifyRequest,
  wireName: string,
  requestName: string
): void {
  const value = readHeader(request, requestName);
  if (value !== undefined) output[wireName] = value;
}

function uploadHeaders(request: FastifyRequest): Record<string, unknown> {
  const output: Record<string, unknown> = {
    "Content-Type": readHeader(request, "content-type"),
    "Content-Length": readHeader(request, "content-length"),
    "Idempotency-Key": readHeader(request, "idempotency-key"),
    "X-Content-SHA256": readHeader(request, "x-content-sha256"),
    "X-Upload-Expires-In-Ms": readHeader(request, "x-upload-expires-in-ms")
  };
  addOptionalHeader(output, request, "X-Commit-SHA", "x-commit-sha");
  addOptionalHeader(output, request, "X-Client-Id", "x-client-id");
  addOptionalHeader(output, request, "X-Change-Key", "x-change-key");
  return output;
}

function statusHeaders(request: FastifyRequest): Record<string, unknown> {
  const output: Record<string, unknown> = {
    "Idempotency-Key": readHeader(request, "idempotency-key")
  };
  addOptionalHeader(output, request, "X-Commit-SHA", "x-commit-sha");
  addOptionalHeader(output, request, "X-Client-Id", "x-client-id");
  addOptionalHeader(output, request, "X-Change-Key", "x-change-key");
  return output;
}

function rejectUnsupportedRequestFeatures(request: FastifyRequest): void {
  const query = request.url.split("?", 2)[1];
  if (query !== undefined && query !== "") {
    fail(400, "REMOTE_CONTENT_UPLOAD_INPUT_INVALID", "remote content upload does not support query parameters");
  }
  for (const name of [
    "range",
    "content-range",
    "upload-offset",
    "upload-length",
    "tus-resumable",
    "x-upload-offset",
    "x-upload-length"
  ]) {
    if (request.headers[name] !== undefined) {
      fail(400, "REMOTE_CONTENT_UPLOAD_INPUT_INVALID", "remote content upload does not support resume or range headers");
    }
  }
  if (request.headers["content-encoding"] !== undefined) {
    fail(400, "REMOTE_CONTENT_UPLOAD_INPUT_INVALID", "remote content upload does not support content encoding");
  }
}

function rejectOversizedContentLength(request: FastifyRequest): void {
  const value = readHeader(request, "content-length");
  if (value !== undefined && /^[1-9][0-9]+$/u.test(value) &&
      (value.length > 9 || Number(value) > REMOTE_CONTENT_UPLOAD_HTTP_MAX_BYTES)) {
    fail(413, "REMOTE_CONTENT_UPLOAD_TOO_LARGE", "remote content upload exceeds the maximum size");
  }
}

async function bindProject(repository: ServerRepository, actorId: string, projectId: string): Promise<void> {
  try {
    await repository.getProject(actorId, projectId);
  } catch (error) {
    if (error instanceof ServerDomainError && error.status < 500) {
      fail(403, "PROJECT_INFORMATION_FORBIDDEN", "project is not accessible");
    }
    fail(503, "REMOTE_UNAVAILABLE", "project authority is unavailable");
  }
}

function remoteStatus(code: string): number {
  if (code === "AUTH_REQUIRED" || code === "TOKEN_INVALID" || code === "SESSION_INVALID") return 401;
  if (code === "PROJECT_INFORMATION_FORBIDDEN" || code === "PROJECT_KEY_SCOPE" ||
      code === "PROJECT_KEY_MISMATCH" || code === "REMOTE_CONTENT_UPLOAD_SCOPE_MISMATCH") return 403;
  if (code === "REMOTE_CONTENT_UPLOAD_IDEMPOTENCY_CONFLICT") return 409;
  if (code === "REMOTE_CONTENT_UPLOAD_EXPIRED") return 410;
  if (code === "REMOTE_CONTENT_UPLOAD_NOT_FOUND") return 404;
  if (code === "REMOTE_CONTENT_UPLOAD_TOO_LARGE") return 413;
  if (code === "REMOTE_CONTENT_UPLOAD_MEDIA_TYPE_UNSUPPORTED") return 415;
  if (code === "REMOTE_CONTENT_UPLOAD_ABORTED") return 499;
  if (code === "VALIDATION_FAILED" || code === "REMOTE_CONTENT_UPLOAD_INPUT_INVALID" || code === "REMOTE_CONTENT_UPLOAD_STREAM_INVALID" ||
      code === "REMOTE_CONTENT_UPLOAD_HASH_MISMATCH" || code === "REMOTE_CONTENT_UPLOAD_SIZE_MISMATCH") return 400;
  return 503;
}

function serviceCode(error: unknown): string | null {
  try {
    if (error === null || typeof error !== "object" || isProxy(error)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string") return null;
    return descriptor.value;
  } catch {
    return null;
  }
}

function mapServiceError(error: unknown): never {
  const code = serviceCode(error);
  const parsed = code === null ? null : remoteContentUploadHttpErrorCodeSchema.safeParse(code);
  if (parsed === null || !parsed.success) {
    fail(503, "REMOTE_UNAVAILABLE", "remote content upload service is unavailable");
  }
  fail(remoteStatus(parsed.data), parsed.data, "remote content upload operation failed");
}

/** Reject thenables and Promise instances with own accessors/extra keys before await. */
function nativePromise<T>(value: unknown): Promise<T> | null {
  if (value === null || typeof value !== "object" || isProxy(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Promise.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== 0) return null;
    const then = Object.getOwnPropertyDescriptor(Promise.prototype, "then");
    if (then === undefined || !("value" in then) || typeof then.value !== "function") return null;
    return value as Promise<T>;
  } catch {
    return null;
  }
}

async function callService<T>(method: ServiceMethod, input: unknown): Promise<T> {
  let raw: unknown;
  try {
    raw = Reflect.apply(method, undefined, [input]);
  } catch (error) {
    return mapServiceError(error);
  }
  const promise = nativePromise<T>(raw);
  if (promise === null) fail(503, "REMOTE_UNAVAILABLE", "remote content upload service is unavailable");
  try {
    return await promise;
  } catch (error) {
    return mapServiceError(error);
  }
}

function requestSignal(request: FastifyRequest): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const onClose = (): void => {
    if (!request.raw.complete) abort();
  };
  request.raw.once("aborted", abort);
  request.raw.once("close", onClose);
  return {
    signal: controller.signal,
    cleanup: () => {
      request.raw.removeListener("aborted", abort);
      request.raw.removeListener("close", onClose);
    }
  };
}

async function discardUnreadStream(stream: AsyncIterable<unknown>): Promise<void> {
  try {
    for await (const chunk of stream) { void chunk; /* discard without buffering */ }
  } catch {
    // The request is already being rejected because its staged stream was incomplete.
  }
}

function isBinaryChunk(value: unknown): value is Uint8Array {
  return Buffer.isBuffer(value) || value instanceof Uint8Array;
}

function uploadChunk(bytes: Uint8Array, sequence: number, offset: number, final: boolean): RemoteContentUploadChunk {
  return {
    sequence,
    offset,
    size: bytes.byteLength,
    chunk_hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    final,
    bytes
  };
}

type StreamCompletionTracker = { complete: boolean };

/** Adapt a one-shot raw request stream to the contract's bounded chunk stream. */
async function* boundedChunks(
  stream: AsyncIterable<unknown>,
  expectedSize: number,
  expectedHash: string,
  signal: AbortSignal,
  completion: StreamCompletionTracker
): AsyncIterable<RemoteContentUploadChunk> {
  const digest = createHash("sha256");
  let pending: Uint8Array | null = null;
  let sequence = 0;
  let offset = 0;
  try {
    for await (const incoming of stream) {
      if (signal.aborted) fail(499, "REMOTE_CONTENT_UPLOAD_ABORTED", "remote content upload was aborted");
      if (!isBinaryChunk(incoming) || incoming.byteLength === 0) {
        fail(400, "REMOTE_CONTENT_UPLOAD_STREAM_INVALID", "remote content upload stream is invalid");
      }
      for (let at = 0; at < incoming.byteLength; at += REMOTE_CONTENT_UPLOAD_HTTP_MAX_CHUNK_BYTES) {
        const next = incoming.subarray(at, Math.min(at + REMOTE_CONTENT_UPLOAD_HTTP_MAX_CHUNK_BYTES, incoming.byteLength));
        if (offset + (pending?.byteLength ?? 0) + next.byteLength > expectedSize) {
          fail(400, "REMOTE_CONTENT_UPLOAD_SIZE_MISMATCH", "remote content upload size does not match Content-Length");
        }
        if (pending !== null) {
          digest.update(pending);
          yield uploadChunk(pending, sequence++, offset, false);
          offset += pending.byteLength;
        }
        pending = next;
      }
    }
  } catch (error) {
    if (error instanceof ServerDomainError) throw error;
    fail(400, "REMOTE_CONTENT_UPLOAD_STREAM_INVALID", "remote content upload stream is invalid");
  }
  if (signal.aborted) fail(499, "REMOTE_CONTENT_UPLOAD_ABORTED", "remote content upload was aborted");
  if (pending === null || offset + pending.byteLength !== expectedSize) {
    fail(400, "REMOTE_CONTENT_UPLOAD_SIZE_MISMATCH", "remote content upload size does not match Content-Length");
  }
  digest.update(pending);
  if (`sha256:${digest.digest("hex")}` !== expectedHash) {
    fail(400, "REMOTE_CONTENT_UPLOAD_HASH_MISMATCH", "remote content upload hash does not match X-Content-SHA256");
  }
  completion.complete = true;
  yield uploadChunk(pending, sequence, offset, true);
}

function optionalSourceMatches(actual: string | undefined, expected: string | undefined): boolean {
  return actual === expected;
}

function recordMatchesUploadRequest(
  record: RemoteContentUploadHttpRecord,
  path: { project_id: string; branch_name: string },
  actorId: string,
  headers: RemoteContentUploadHttpRequestHeaders
): boolean {
  const expectedExpiry = Number(headers["X-Upload-Expires-In-Ms"]);
  const actualExpiry = Date.parse(record.expires_at) - Date.parse(record.created_at);
  return record.source.project_id === path.project_id && record.source.branch_name === path.branch_name &&
    record.source.actor_id === actorId && record.idempotency_key === headers["Idempotency-Key"] &&
    record.content_sha256 === headers["X-Content-SHA256"] &&
    record.size_bytes === Number(headers["Content-Length"]) &&
    record.upload_ref.sha256 === headers["X-Content-SHA256"] &&
    record.upload_ref.size_bytes === Number(headers["Content-Length"]) &&
    Number.isSafeInteger(actualExpiry) && actualExpiry === expectedExpiry &&
    optionalSourceMatches(record.source.commit_sha, headers["X-Commit-SHA"]) &&
    optionalSourceMatches(record.source.client_id, headers["X-Client-Id"]) &&
    optionalSourceMatches(record.source.change_key, headers["X-Change-Key"]);
}

function recordMatchesStatusRequest(
  record: RemoteContentUploadHttpRecord,
  path: { project_id: string; branch_name: string },
  actorId: string,
  headers: RemoteContentUploadHttpStatusHeaders
): boolean {
  return record.source.project_id === path.project_id && record.source.branch_name === path.branch_name &&
    record.source.actor_id === actorId && record.idempotency_key === headers["Idempotency-Key"] &&
    optionalSourceMatches(record.source.commit_sha, headers["X-Commit-SHA"]) &&
    optionalSourceMatches(record.source.client_id, headers["X-Client-Id"]) &&
    optionalSourceMatches(record.source.change_key, headers["X-Change-Key"]);
}

function assertUploadResultIdentity(
  result: RemoteContentUploadHttpResult,
  path: { project_id: string; branch_name: string },
  actorId: string,
  headers: RemoteContentUploadHttpRequestHeaders
): void {
  if (!recordMatchesUploadRequest(result.record, path, actorId, headers)) {
    fail(503, "REMOTE_UNAVAILABLE", "remote content upload service returned invalid scope");
  }
}

function assertStatusRecordIdentity(
  record: RemoteContentUploadHttpRecord,
  path: { project_id: string; branch_name: string },
  actorId: string,
  headers: RemoteContentUploadHttpStatusHeaders
): void {
  if (!recordMatchesStatusRequest(record, path, actorId, headers)) {
    fail(503, "REMOTE_UNAVAILABLE", "remote content upload service returned invalid scope");
  }
}

export function registerRemoteContentUploadHttpRoutes(
  app: FastifyInstance,
  options: RemoteContentUploadHttpRoutesOptions
): void {
  const resolution = resolveService(options.service);

  app.register(async (child) => {
    // Keep the parent application/zip Buffer parser for legacy archive-package;
    // this encapsulated parser leaves the new route's body as a raw stream.
    child.removeContentTypeParser("application/zip");
    child.addContentTypeParser("application/zip", (_request, payload, done) => done(null, payload));

    child.post(
      "/api/v1/projects/:projectId/branches/:branchName/remote-sync/content-upload",
      { bodyLimit: REMOTE_CONTENT_UPLOAD_HTTP_MAX_BYTES },
      async (request, reply) => {
        const { actor, requestId } = await options.authenticated(request, options.repository, "archive:write");
        const path = pathParams(request);
        await bindProject(options.repository, actor.actorId, path.project_id);
        rejectUnsupportedRequestFeatures(request);
        rejectOversizedContentLength(request);
        if (readHeader(request, "content-type") !== "application/zip") {
          fail(415, "REMOTE_CONTENT_UPLOAD_MEDIA_TYPE_UNSUPPORTED", "remote content upload requires application/zip");
        }
        if (resolution.kind !== "ready") unavailable(resolution);

        const descriptor = {
          schema_version: 1 as const,
          path,
          auth: { actor_id: actor.actorId },
          headers: uploadHeaders(request),
          body_stream: {
            kind: "single_binary_stream" as const,
            media_type: "application/zip" as const,
            content_encoding: "identity" as const,
            content_length_bytes: Number(readHeader(request, "content-length")),
            content_sha256: readHeader(request, "x-content-sha256"),
            max_chunk_bytes: REMOTE_CONTENT_UPLOAD_HTTP_MAX_CHUNK_BYTES
          }
        };
        const valid = validateRemoteContentUploadHttpRequestDescriptor(descriptor);
        if (!valid.success) fail(400, "REMOTE_CONTENT_UPLOAD_INPUT_INVALID", "remote content upload request is invalid");

        const lifecycle = requestSignal(request);
        try {
          const completion: StreamCompletionTracker = { complete: false };
          const result = await callService<RemoteContentUploadHttpResult>(resolution.methods.stage, {
            descriptor: valid.data,
            chunks: boundedChunks(
              request.body as AsyncIterable<unknown>,
              valid.data.body_stream.content_length_bytes,
              valid.data.body_stream.content_sha256,
              lifecycle.signal,
              completion
            ),
            signal: lifecycle.signal
          });
          if (!completion.complete) {
            await discardUnreadStream(request.body as AsyncIterable<unknown>);
            fail(503, "REMOTE_UNAVAILABLE", "remote content upload stream is invalid");
          }
          const parsed = validateRemoteContentUploadHttpResult(result);
          if (!parsed.success) fail(503, "REMOTE_UNAVAILABLE", "remote content upload service returned invalid output");
          assertUploadResultIdentity(parsed.data, path, actor.actorId, valid.data.headers);
          return reply.header("X-Request-Id", requestId)
            .code(parsed.data.outcome === "new" ? 201 : 200)
            .send(parsed.data);
        } finally {
          lifecycle.cleanup();
        }
      }
    );

    child.get(
      "/api/v1/projects/:projectId/branches/:branchName/remote-sync/content-upload/status",
      async (request, reply) => {
        const { actor, requestId } = await options.authenticated(request, options.repository, "archive:read");
        const path = pathParams(request);
        await bindProject(options.repository, actor.actorId, path.project_id);
        rejectUnsupportedRequestFeatures(request);
        if (resolution.kind !== "ready") unavailable(resolution);
        const descriptor = {
          schema_version: 1 as const,
          path,
          auth: { actor_id: actor.actorId },
          headers: statusHeaders(request)
        };
        const valid = validateRemoteContentUploadHttpStatusDescriptor(descriptor);
        if (!valid.success) fail(400, "REMOTE_CONTENT_UPLOAD_INPUT_INVALID", "remote content upload status request is invalid");

        const lifecycle = requestSignal(request);
        try {
          const result = await callService(resolution.methods.status, {
            descriptor: valid.data,
            signal: lifecycle.signal
          });
          const parsed = validateRemoteContentUploadHttpStatus(result);
          if (!parsed.success) fail(503, "REMOTE_UNAVAILABLE", "remote content upload service returned invalid output");
          if (parsed.data.record !== null) {
            assertStatusRecordIdentity(parsed.data.record, path, actor.actorId, valid.data.headers);
          }
          return reply.header("X-Request-Id", requestId).code(200).send(parsed.data);
        } finally {
          lifecycle.cleanup();
        }
      }
    );
  });
}
