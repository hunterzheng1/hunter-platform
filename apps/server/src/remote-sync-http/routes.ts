import {
  remoteSyncContentChunkSchema,
  remoteSyncContentStreamHttpRequestSchema,
  remoteSyncHttpErrorCodeSchema,
  type RemoteSyncContentChunk,
  type RemoteSyncLease,
  type RemoteSyncPreparedPush,
  type RemoteSyncPullReceipt,
  type RemoteSyncPushReceiptHttp,
  type RemoteSyncSourceRef,
  remoteSyncHttpIdempotencyKeySchema,
  remoteSyncLeaseAcquireHttpRequestSchema,
  remoteSyncLeaseHttpResponseSchema,
  remoteSyncLeaseReleaseHttpRequestSchema,
  remoteSyncLeaseReleaseHttpResponseSchema,
  remoteSyncLeaseRenewHttpRequestSchema,
  remoteSyncPullHttpRequestSchema,
  remoteSyncPullHttpResponseSchema,
  remoteSyncPushCommitHttpRequestSchema,
  remoteSyncPushCommitHttpResponseSchema,
  remoteSyncPushPrepareHttpRequestSchema,
  remoteSyncPushPrepareHttpResponseSchema,
  remoteSyncPushReceiptHttpRequestSchema,
  remoteSyncPushReceiptHttpResponseSchema,
  remoteSyncPushStatusHttpRequestSchema,
  remoteSyncPushStatusHttpResponseSchema,
  remoteSyncRemoteSnapshotHttpResponseSchema,
  remoteSyncSourceRefSchema,
  REMOTE_SYNC_HTTP_OPERATIONS,
  remoteSyncHttpMaxChunkBytes,
  remoteSyncHttpMaxFileBytes
} from "@hunter-harness/contracts";
import type {
  RemoteSyncHttpScope
} from "@hunter-harness/contracts";
import { createHash } from "node:crypto";
import { isProxy, isUint8Array } from "node:util/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { Actor, ProjectKeyScope, ServerRepository } from "../repositories/interfaces.js";
import { ServerDomainError } from "../repositories/interfaces.js";
import type {
  RemoteSyncHttpContentStream,
  RemoteSyncHttpServicePort,
  RemoteSyncIdempotencyResult,
} from "./ports.js";

export interface RemoteSyncHttpRoutesOptions {
  readonly repository: ServerRepository;
  readonly service?: RemoteSyncHttpServicePort;
  readonly authenticated: (
    request: FastifyRequest,
    repository: ServerRepository,
    projectScope?: ProjectKeyScope
  ) => Promise<{ actor: Actor; requestId: string }>;
}

const projectIdSchema = z.string().regex(/^prj_[A-Za-z0-9_-]{1,156}$/u);
const branchNameSchema = z.string().min(1).max(160).refine((value) =>
  ![...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f || character === "\\";
  }), "branch name is not canonical");
const prepareIdSchema = z.string().min(1).max(160);

function fastifyPath(path: string): string {
  return path
    .replace("{project_id}", ":projectId")
    .replace("{branch_name}", ":branchName")
    .replace("{lease_id}", ":leaseId")
    .replace("{snapshot_id}", ":snapshotId")
    .replace("{prepare_id}", ":prepareId")
    // find-my-way treats a colon immediately after a parameter as another
    // parameter. Keep the public verb suffix while using an unambiguous
    // separator for Fastify's router.
    .replace(":leaseId:renew", ":leaseId/renew")
    .replace(":leaseId:release", ":leaseId/release")
    // find-my-way also parses a colon after a static segment as a parameter;
    // use slash verbs for the registered Fastify path while preserving the
    // canonical colon form in the shared contract.
    .replace("/push:prepare", "/push/prepare")
    .replace("/push:commit", "/push/commit");
}

function pathParams(request: FastifyRequest): {
  projectId: string;
  branchName: string;
} {
  const raw = request.params as Record<string, unknown>;
  const project = projectIdSchema.safeParse(raw.projectId);
  const branch = branchNameSchema.safeParse(raw.branchName);
  if (!project.success || !branch.success) {
    throw new ServerDomainError(400, "VALIDATION_FAILED", "remote sync project or branch is invalid");
  }
  return { projectId: project.data, branchName: branch.data };
}

function leaseIdFromRequest(request: FastifyRequest, verb: "renew" | "release"): string {
  const params = request.params as Record<string, unknown>;
  if (typeof params.leaseId === "string") return params.leaseId;
  if (typeof params["*"] === "string") {
    const match = new RegExp(`^([^/]+):${verb}$`, "u").exec(params["*"]);
    if (match?.[1] !== undefined) return match[1];
  }
  throw new ServerDomainError(400, "VALIDATION_FAILED", "remote sync lease id is invalid");
}

function parseBody<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ServerDomainError(400, "VALIDATION_FAILED", message);
  return parsed.data;
}

function idempotencyKey(request: FastifyRequest): string {
  const parsed = remoteSyncHttpIdempotencyKeySchema.safeParse(request.headers["idempotency-key"]);
  if (!parsed.success) {
    throw new ServerDomainError(400, "VALIDATION_FAILED", "Idempotency-Key is required and invalid");
  }
  return parsed.data;
}

function assertMatchingIdempotency(header: string, bodyValue: string): void {
  if (header !== bodyValue) {
    throw new ServerDomainError(409, "SYNC_IDEMPOTENCY_CONFLICT", "Idempotency-Key does not match request body");
  }
}

function sourceFor(
  params: { projectId: string; branchName: string },
  actorId: string,
  candidate?: unknown
): RemoteSyncSourceRef {
  const source = candidate === undefined
    ? { project_id: params.projectId, branch_name: params.branchName, actor_id: actorId }
    : parseBody(remoteSyncSourceRefSchema, candidate, "remote sync source is invalid");
  if (source.project_id !== params.projectId || source.branch_name !== params.branchName ||
      source.actor_id !== actorId) {
    throw new ServerDomainError(403, "PROJECT_INFORMATION_FORBIDDEN", "remote sync source is outside the authenticated project");
  }
  return source;
}

function sourceFromQuery(
  params: { projectId: string; branchName: string },
  actorId: string,
  query: Record<string, unknown>,
): RemoteSyncSourceRef {
  const candidate = {
    project_id: params.projectId,
    branch_name: params.branchName,
    actor_id: actorId,
    ...(query.commit_sha === undefined ? {} : { commit_sha: query.commit_sha }),
    ...(query.client_id === undefined ? {} : { client_id: query.client_id }),
    ...(query.change_key === undefined ? {} : { change_key: query.change_key }),
  };
  return sourceFor(params, actorId, candidate);
}

function assertLeaseScope(
  lease: { project_id: string; branch_name: string; actor_id: string },
  params: { projectId: string; branchName: string },
  actorId: string
): void {
  if (lease.project_id !== params.projectId || lease.branch_name !== params.branchName ||
      lease.actor_id !== actorId) {
    throw new ServerDomainError(403, "PROJECT_INFORMATION_FORBIDDEN", "remote sync lease is outside the authenticated project");
  }
}

function assertServiceSource(value: unknown, expected: RemoteSyncSourceRef): void {
  const parsed = remoteSyncSourceRefSchema.safeParse(value);
  if (!parsed.success || parsed.data.project_id !== expected.project_id ||
      parsed.data.branch_name !== expected.branch_name || parsed.data.actor_id !== expected.actor_id ||
      parsed.data.commit_sha !== expected.commit_sha || parsed.data.client_id !== expected.client_id ||
      parsed.data.change_key !== expected.change_key) {
    throw new ServerDomainError(503, "REMOTE_UNAVAILABLE", "remote sync service returned an out-of-scope source");
  }
}

function assertServiceBaseSource(value: unknown, expected: RemoteSyncSourceRef): void {
  const parsed = remoteSyncSourceRefSchema.safeParse(value);
  if (!parsed.success || parsed.data.project_id !== expected.project_id ||
      parsed.data.branch_name !== expected.branch_name || parsed.data.actor_id !== expected.actor_id) {
    throw new ServerDomainError(503, "REMOTE_UNAVAILABLE", "remote sync service returned an out-of-scope source");
  }
}

async function bindProject(
  repository: ServerRepository,
  actorId: string,
  projectId: string
): Promise<void> {
  try {
    await repository.getProject(actorId, projectId);
  } catch (error) {
    if (error instanceof ServerDomainError && error.status < 500) {
      throw new ServerDomainError(403, "PROJECT_INFORMATION_FORBIDDEN", "project is not accessible");
    }
    throw new ServerDomainError(503, "REMOTE_UNAVAILABLE", "project authority is unavailable");
  }
}

function serviceUnavailable(): never {
  throw new ServerDomainError(503, "REMOTE_UNAVAILABLE", "remote sync service is not configured");
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const typedArraySet = Uint8Array.prototype.set;

function ownData(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null || isProxy(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function remoteCode(error: unknown): string | null {
  const code = ownData(error, "code");
  return typeof code === "string" ? code : null;
}

function remoteRetryable(error: unknown): boolean {
  return ownData(error, "retryable") === true;
}

type OperationErrors = Readonly<Record<number, readonly string[]>>;

function mapRemoteError(error: unknown, allowedErrors?: OperationErrors): never {
  if (error instanceof ServerDomainError) throw error;
  const code = remoteCode(error);
  const parsedCode = code === null ? null : remoteSyncHttpErrorCodeSchema.safeParse(code);
  if (parsedCode === null || !parsedCode.success) {
    throw new ServerDomainError(503, "REMOTE_UNAVAILABLE", "remote sync service is unavailable");
  }
  const declared = allowedErrors === undefined ? null : Object.entries(allowedErrors)
    .find(([, codes]) => codes.includes(parsedCode.data));
  if (declared === undefined || (allowedErrors !== undefined && declared === null)) {
    throw new ServerDomainError(503, "REMOTE_UNAVAILABLE", "remote sync service is unavailable");
  }
  // Service messages may contain credentials or SQL.  The HTTP adapter emits
  // only the contract code and a fixed message; operators can correlate the
  // request id in server logs without reflecting backend details to clients.
  throw new ServerDomainError(declared === null ? 503 : Number(declared[0]), parsedCode.data,
    "remote sync operation failed", { retryable: remoteRetryable(error) });
}

function operationErrorCodes(operation: { errors: OperationErrors }): OperationErrors {
  return operation.errors;
}

async function callService<T>(operation: () => Promise<T>, allowedErrors?: OperationErrors): Promise<T> {
  let raw: unknown;
  try {
    raw = operation();
  } catch (error) {
    mapRemoteError(error, allowedErrors);
  }
  if (raw === null || typeof raw !== "object" || isProxy(raw)) {
    throw new ServerDomainError(503, "REMOTE_UNAVAILABLE", "remote sync service returned a non-native promise");
  }
  try {
    if (Object.getPrototypeOf(raw) !== Promise.prototype || Reflect.ownKeys(raw).length !== 0) {
      throw new ServerDomainError(503, "REMOTE_UNAVAILABLE", "remote sync service returned a non-native promise");
    }
    return await (raw as Promise<T>);
  } catch (error) {
    mapRemoteError(error, allowedErrors);
  }
}

function conflictReply(
  reply: FastifyReply,
  requestId: string,
  retryable: boolean
): FastifyReply {
  return reply
    .header("X-Request-Id", requestId)
    .code(409)
    .send({
      error: {
        code: "SYNC_IDEMPOTENCY_CONFLICT",
        message: "Idempotency-Key is already bound to a different request",
        request_id: requestId,
        outcome: "conflict",
        details: { retryable }
      }
    });
}

function snapshotResponse(value: unknown): unknown {
  const seen = new WeakSet<object>();
  let nodes = 0;
  let textBytes = 0;
  let binaryBytes = 0;
  const copy = (input: unknown, depth: number): unknown => {
    if (input === null || typeof input === "boolean" || typeof input === "undefined") return input;
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new Error();
      return input;
    }
    if (typeof input === "string") {
      textBytes += Buffer.byteLength(input, "utf8");
      if (input.length > 11 * 1024 * 1024 || textBytes > 32 * 1024 * 1024) throw new Error();
      return input;
    }
    if (typeof input !== "object" || isProxy(input) || depth > 24 || ++nodes > 500_000) throw new Error();
    if (isUint8Array(input)) {
      if (byteLengthGetter === undefined) throw new Error();
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype) throw new Error();
      const length = Reflect.apply(byteLengthGetter, input, []) as number;
      binaryBytes += length;
      if (!Number.isSafeInteger(length) || length > remoteSyncHttpMaxChunkBytes ||
          binaryBytes > remoteSyncHttpMaxFileBytes) throw new Error();
      const output = new Uint8Array(length);
      Reflect.apply(typedArraySet, output, [input]);
      return output;
    }
    if (seen.has(input)) throw new Error();
    seen.add(input);
    try {
      const array = Array.isArray(input);
      if (Object.getPrototypeOf(input) !== (array ? Array.prototype : Object.prototype)) throw new Error();
      const descriptors = Object.getOwnPropertyDescriptors(input);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key !== "string")) throw new Error();
      if (array) {
        const length = descriptors.length?.value;
        if (!Number.isSafeInteger(length) || Number(length) > 100_000 || keys.length !== Number(length) + 1) throw new Error();
        return Array.from({ length: Number(length) }, (_, index) => {
          const descriptor = descriptors[String(index)];
          if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) throw new Error();
          return copy(descriptor.value, depth + 1);
        });
      }
      const output: Record<string, unknown> = {};
      for (const key of keys as string[]) {
        const descriptor = descriptors[key];
        if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true ||
            descriptor.get !== undefined || descriptor.set !== undefined || key === "__proto__") throw new Error();
        output[key] = copy(descriptor.value, depth + 1);
      }
      return output;
    } finally {
      seen.delete(input);
    }
  };
  return copy(value, 0);
}

function validateResponse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  code = "REMOTE_UNAVAILABLE"
): T {
  let snapshot: unknown;
  try { snapshot = snapshotResponse(value); } catch {
    throw new ServerDomainError(503, code, "remote sync service returned an invalid response");
  }
  const parsed = schema.safeParse(snapshot);
  if (!parsed.success) {
    throw new ServerDomainError(503, code, "remote sync service returned an invalid response");
  }
  return parsed.data;
}

const serviceResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.enum(["new", "replay"]), value: z.unknown() }).strict(),
  z.object({
    outcome: z.literal("conflict"),
    error: z.object({ code: z.literal("SYNC_IDEMPOTENCY_CONFLICT"), retryable: z.boolean() }).strict(),
  }).strict(),
]);

function validateServiceResult<T>(value: unknown): RemoteSyncIdempotencyResult<T> {
  return validateResponse(serviceResultSchema, value) as RemoteSyncIdempotencyResult<T>;
}

const nativeAsyncGeneratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf((async function* () {})())) as object;

function validateContentStreamEnvelope(value: unknown): RemoteSyncHttpContentStream {
  if (value === null || typeof value !== "object" || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ServerDomainError(503, "REMOTE_UNAVAILABLE", "remote content stream metadata is invalid");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const expectedKeys = ["snapshot_id", "revision", "content_sha256", "size", "stream"];
  if (keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key)) ||
      expectedKeys.some((key) => {
        const descriptor = descriptors[key];
        return descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true;
      })) {
    throw new ServerDomainError(503, "REMOTE_UNAVAILABLE", "remote content stream metadata is invalid");
  }
  const stream = descriptors.stream?.value;
  const streamPrototype = stream !== null && typeof stream === "object" && !isProxy(stream)
    ? Object.getPrototypeOf(stream)
    : null;
  if (stream === null || typeof stream !== "object" || isProxy(stream) || Reflect.ownKeys(stream).length !== 0 ||
      streamPrototype === null || Object.getPrototypeOf(streamPrototype) !== nativeAsyncGeneratorPrototype) {
    throw new ServerDomainError(503, "REMOTE_UNAVAILABLE", "remote content stream is unavailable");
  }
  const metadata = validateResponse(z.object({
    snapshot_id: z.string().min(1).max(160),
    revision: z.string().min(1).max(160),
    content_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict(), {
    snapshot_id: descriptors.snapshot_id?.value,
    revision: descriptors.revision?.value,
    content_sha256: descriptors.content_sha256?.value,
    size: descriptors.size?.value,
  });
  return { ...metadata, stream: stream as AsyncIterable<RemoteSyncContentChunk> };
}

function sendLeaseResult(
  reply: FastifyReply,
  requestId: string,
  result: { outcome: "new" | "replay"; value: unknown } | { outcome: "conflict"; error: { retryable: boolean } },
  created: boolean
): FastifyReply {
  if (result.outcome === "conflict") return conflictReply(reply, requestId, result.error.retryable);
  const body = validateResponse(remoteSyncLeaseHttpResponseSchema, {
    lease: result.value,
    outcome: result.outcome
  });
  return reply
    .header("X-Request-Id", requestId)
    .code(created && result.outcome === "new" ? 201 : 200)
    .send(body);
}

function sendReleaseResult(
  reply: FastifyReply,
  requestId: string,
  result: { outcome: "new" | "replay"; value: unknown } | { outcome: "conflict"; error: { retryable: boolean } }
): FastifyReply {
  if (result.outcome === "conflict") return conflictReply(reply, requestId, result.error.retryable);
  const body = validateResponse(remoteSyncLeaseReleaseHttpResponseSchema, { outcome: result.outcome });
  return reply.header("X-Request-Id", requestId).code(200).send(body);
}

function sendResultUnion<T>(
  reply: FastifyReply,
  requestId: string,
  result: { outcome: "new" | "replay"; value: T } | { outcome: "conflict"; error: { retryable: boolean } },
  schema: z.ZodTypeAny,
  created: boolean
): FastifyReply {
  if (result.outcome === "conflict") return conflictReply(reply, requestId, result.error.retryable);
  const body = validateResponse(schema, { outcome: result.outcome, value: result.value });
  return reply
    .header("X-Request-Id", requestId)
    .code(created && result.outcome === "new" ? 201 : 200)
    .send(body);
}

async function readBoundedContent(
  stream: AsyncIterable<RemoteSyncContentChunk>,
  expectedSize: number,
  expectedHash: string,
  requestedChunkSize: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > remoteSyncHttpMaxFileBytes) {
    throw new ServerDomainError(413, "SYNC_STREAM_TOO_LARGE", "remote content exceeds the per-file limit");
  }
  const digest = createHash("sha256");
  const chunks: Uint8Array[] = [];
  let sequence = 0;
  let offset = 0;
  let ended = false;
  const maximumChunks = expectedSize === 0 ? 1 : Math.ceil(expectedSize / requestedChunkSize);
  try {
    for await (const raw of stream) {
      if (sequence >= maximumChunks) {
        throw new ServerDomainError(400, "SYNC_STREAM_INVALID", "remote content stream has too many chunks");
      }
      const chunk = validateResponse(remoteSyncContentChunkSchema, raw, "SYNC_STREAM_INVALID");
      if (chunk.bytes === undefined || chunk.bytes.byteLength > remoteSyncHttpMaxChunkBytes ||
          chunk.bytes.byteLength > requestedChunkSize ||
          (chunk.bytes.byteLength === 0 && !(expectedSize === 0 && sequence === 0 && chunk.final)) ||
          chunk.size !== chunk.bytes.byteLength || chunk.sequence !== sequence ||
          chunk.offset !== offset || chunk.chunk_hash !== `sha256:${createHash("sha256").update(chunk.bytes).digest("hex")}` ||
          ended || offset + chunk.bytes.byteLength > expectedSize) {
        throw new ServerDomainError(400, "SYNC_STREAM_INVALID", "remote content stream is invalid");
      }
      if (offset + chunk.bytes.byteLength > remoteSyncHttpMaxFileBytes) {
        throw new ServerDomainError(413, "SYNC_STREAM_TOO_LARGE", "remote content exceeds the per-file limit");
      }
      chunks.push(new Uint8Array(chunk.bytes));
      digest.update(chunk.bytes);
      sequence += 1;
      offset += chunk.bytes.byteLength;
      if (chunk.final) ended = true;
    }
  } catch (error) {
    if (error instanceof ServerDomainError) throw error;
    const code = remoteCode(error);
    if (code === "SYNC_STREAM_ABORTED") {
      throw new ServerDomainError(499, code, "remote content stream was aborted");
    }
    throw new ServerDomainError(503, "REMOTE_UNAVAILABLE", "remote content stream is unavailable");
  }
  if (!ended || offset !== expectedSize || `sha256:${digest.digest("hex")}` !== expectedHash) {
    throw new ServerDomainError(400, "SYNC_STREAM_INVALID", "remote content stream is incomplete");
  }
  const output = new Uint8Array(expectedSize);
  let cursor = 0;
  for (const chunk of chunks) {
    output.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return output;
}

export function registerRemoteSyncHttpRoutes(
  app: FastifyInstance,
  options: RemoteSyncHttpRoutesOptions
): void {
  const { repository, service, authenticated } = options;

  app.post(fastifyPath(REMOTE_SYNC_HTTP_OPERATIONS.acquire_lease.path), async (request, reply) => {
    const params = pathParams(request);
    const { actor, requestId } = await authenticated(request, repository, "files:write");
    await bindProject(repository, actor.actorId, params.projectId);
    const body = parseBody(remoteSyncLeaseAcquireHttpRequestSchema, request.body, "remote sync lease request is invalid");
    const source = sourceFor(params, actor.actorId, body.source);
    const idem = idempotencyKey(request);
    if (service === undefined) serviceUnavailable();
    const result = validateServiceResult<RemoteSyncLease>(await callService(() => service.acquireLease({ source, ttl_ms: body.ttl_ms, idempotency_key: idem }), operationErrorCodes(REMOTE_SYNC_HTTP_OPERATIONS.acquire_lease)));
    if (result.outcome !== "conflict") assertLeaseScope(result.value, params, actor.actorId);
    return sendLeaseResult(reply, requestId, result, true);
  });

  const renewLeaseRoute = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = pathParams(request);
    const { actor, requestId } = await authenticated(request, repository, "files:write");
    await bindProject(repository, actor.actorId, params.projectId);
    const body = parseBody(remoteSyncLeaseRenewHttpRequestSchema, request.body, "remote sync lease renewal is invalid");
    if (leaseIdFromRequest(request, "renew") !== body.lease.lease_id) {
      throw new ServerDomainError(403, "PROJECT_INFORMATION_FORBIDDEN", "remote sync lease is outside the requested branch");
    }
    assertLeaseScope(body.lease, params, actor.actorId);
    const idem = idempotencyKey(request);
    if (service === undefined) serviceUnavailable();
    const result = validateServiceResult<RemoteSyncLease>(await callService(() => service.renewLease({ lease: body.lease, ttl_ms: body.ttl_ms, idempotency_key: idem }), operationErrorCodes(REMOTE_SYNC_HTTP_OPERATIONS.renew_lease)));
    if (result.outcome !== "conflict") assertLeaseScope(result.value, params, actor.actorId);
    return sendLeaseResult(reply, requestId, result, false);
  };

  app.post(fastifyPath(REMOTE_SYNC_HTTP_OPERATIONS.renew_lease.path), renewLeaseRoute);

  const releaseLeaseRoute = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = pathParams(request);
    const { actor, requestId } = await authenticated(request, repository, "files:write");
    await bindProject(repository, actor.actorId, params.projectId);
    const body = parseBody(remoteSyncLeaseReleaseHttpRequestSchema, request.body, "remote sync lease release is invalid");
    if (leaseIdFromRequest(request, "release") !== body.lease.lease_id) {
      throw new ServerDomainError(403, "PROJECT_INFORMATION_FORBIDDEN", "remote sync lease is outside the requested branch");
    }
    assertLeaseScope(body.lease, params, actor.actorId);
    const idem = idempotencyKey(request);
    if (service === undefined) serviceUnavailable();
    const result = validateServiceResult<undefined>(await callService(() => service.releaseLease({ lease: body.lease, idempotency_key: idem }), operationErrorCodes(REMOTE_SYNC_HTTP_OPERATIONS.release_lease)));
    return sendReleaseResult(reply, requestId, result);
  };

  app.post(fastifyPath(REMOTE_SYNC_HTTP_OPERATIONS.release_lease.path), releaseLeaseRoute);
  // Fastify cannot parse a colon immediately following a dynamic parameter;
  // this wildcard alias keeps the canonical v1 URLs working as well as the
  // slash-shaped paths used by the router above.
  const leaseVerbAliasPath = "/api/v1/projects/:projectId/branches/:branchName/remote-sync/leases/*";
  app.post(leaseVerbAliasPath, async (request, reply) => {
    const raw = (request.params as Record<string, unknown>)["*"];
    if (typeof raw !== "string") throw new ServerDomainError(400, "VALIDATION_FAILED", "remote sync lease verb is invalid");
    if (raw.endsWith(":renew")) return renewLeaseRoute(request, reply);
    if (raw.endsWith(":release")) return releaseLeaseRoute(request, reply);
    throw new ServerDomainError(400, "VALIDATION_FAILED", "remote sync lease verb is invalid");
  });

  app.get(fastifyPath(REMOTE_SYNC_HTTP_OPERATIONS.snapshot.path), async (request, reply) => {
    const params = pathParams(request);
    const { actor, requestId } = await authenticated(request, repository, "files:read");
    await bindProject(repository, actor.actorId, params.projectId);
    const query = parseBody(z.object({ expected_revision: z.string().min(1).max(160).optional() }).strict(), request.query,
      "remote sync snapshot query is invalid");
    const source = sourceFor(params, actor.actorId);
    if (service === undefined) serviceUnavailable();
    const snapshot = validateResponse(remoteSyncRemoteSnapshotHttpResponseSchema, await callService(() => service.readRemoteSnapshot({
      source,
      ...(query.expected_revision === undefined ? {} : { expected_revision: query.expected_revision })
    }), operationErrorCodes(REMOTE_SYNC_HTTP_OPERATIONS.snapshot)));
    assertServiceSource(snapshot.source, source);
    reply.header("X-Request-Id", requestId);
    return reply.code(200).send(snapshot);
  });

  app.get(fastifyPath(REMOTE_SYNC_HTTP_OPERATIONS.content_stream.path), async (request, reply) => {
    const params = pathParams(request);
    const snapshotId = parseBody(z.string().min(1).max(160), (request.params as Record<string, unknown>).snapshotId,
      "remote sync snapshot id is invalid");
    const { actor, requestId } = await authenticated(request, repository, "files:read");
    await bindProject(repository, actor.actorId, params.projectId);
    const query = request.query as Record<string, unknown>;
    const source = sourceFor(params, actor.actorId);
    const rawChunkSize = query.chunk_size;
    const normalizedChunkSize = typeof rawChunkSize === "string" && /^\d+$/u.test(rawChunkSize)
      ? Number(rawChunkSize)
      : rawChunkSize;
    const body = parseBody(remoteSyncContentStreamHttpRequestSchema, {
      source,
      path: query.path,
      snapshot_id: snapshotId,
      expected_revision: query.expected_revision,
      ...(normalizedChunkSize === undefined ? {} : { chunk_size: normalizedChunkSize })
    }, "remote sync content stream query is invalid");
    if (service === undefined) serviceUnavailable();
    const content = validateContentStreamEnvelope(await callService(() => service.openContentStream({
      source,
      path: body.path,
      snapshot_id: body.snapshot_id,
      expected_revision: body.expected_revision,
      chunk_size: body.chunk_size
    }), operationErrorCodes(REMOTE_SYNC_HTTP_OPERATIONS.content_stream)));
    if (content.snapshot_id !== body.snapshot_id || content.revision !== body.expected_revision ||
        !Number.isSafeInteger(content.size) || content.size < 0 ||
        content.size > remoteSyncHttpMaxFileBytes ||
        !/^sha256:[a-f0-9]{64}$/u.test(content.content_sha256)) {
      if (Number.isSafeInteger(content.size) && content.size > remoteSyncHttpMaxFileBytes) {
        throw new ServerDomainError(413, "SYNC_STREAM_TOO_LARGE", "remote content exceeds the per-file limit");
      }
      throw new ServerDomainError(503, "REMOTE_UNAVAILABLE", "remote content stream metadata is invalid");
    }
    const bytes = await readBoundedContent(content.stream, content.size, content.content_sha256, body.chunk_size);
    reply
      .header("X-Request-Id", requestId)
      .header("Content-Type", "application/octet-stream")
      .header("X-Content-SHA256", content.content_sha256)
      .header("X-Remote-Snapshot-Id", content.snapshot_id)
      .header("X-Remote-Revision", content.revision);
    return reply.code(200).send(bytes);
  });

  const preparePushRoute = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = pathParams(request);
    const { actor, requestId } = await authenticated(request, repository, "files:write");
    await bindProject(repository, actor.actorId, params.projectId);
    const body = parseBody(remoteSyncPushPrepareHttpRequestSchema, request.body, "remote sync push prepare request is invalid");
    const source = sourceFor(params, actor.actorId, body.source);
    assertLeaseScope(body.lease, params, actor.actorId);
    const idem = idempotencyKey(request);
    assertMatchingIdempotency(idem, body.idempotency_key);
    if (service === undefined) serviceUnavailable();
    const result = validateServiceResult<RemoteSyncPreparedPush>(await callService(() => service.preparePush({ ...body, source }), operationErrorCodes(REMOTE_SYNC_HTTP_OPERATIONS.prepare_push)));
    if (result.outcome !== "conflict") assertServiceSource(result.value.source, source);
    return sendResultUnion(reply, requestId, result, remoteSyncPushPrepareHttpResponseSchema, true);
  };
  app.post(fastifyPath(REMOTE_SYNC_HTTP_OPERATIONS.prepare_push.path), preparePushRoute);

  const commitPushRoute = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = pathParams(request);
    const { actor, requestId } = await authenticated(request, repository, "files:write");
    await bindProject(repository, actor.actorId, params.projectId);
    const body = parseBody(remoteSyncPushCommitHttpRequestSchema, request.body, "remote sync push commit request is invalid");
    const routeLeaseId = (request.params as Record<string, unknown>).leaseId;
    if (params.branchName !== body.lease.branch_name ||
        (routeLeaseId !== undefined && routeLeaseId !== body.lease.lease_id)) {
      throw new ServerDomainError(403, "PROJECT_INFORMATION_FORBIDDEN", "remote sync commit lease is outside the requested branch");
    }
    assertLeaseScope(body.lease, params, actor.actorId);
    const idem = idempotencyKey(request);
    assertMatchingIdempotency(idem, body.idempotency_key);
    if (service === undefined) serviceUnavailable();
    const result = validateServiceResult<RemoteSyncPushReceiptHttp>(await callService(() => service.commitPush(body), operationErrorCodes(REMOTE_SYNC_HTTP_OPERATIONS.commit_push)));
    if (result.outcome !== "conflict") {
      assertServiceBaseSource(result.value.source, {
        project_id: params.projectId,
        branch_name: params.branchName,
        actor_id: actor.actorId
      });
    }
    return sendResultUnion(reply, requestId, result, remoteSyncPushCommitHttpResponseSchema, false);
  };
  app.post(fastifyPath(REMOTE_SYNC_HTTP_OPERATIONS.commit_push.path), commitPushRoute);
  const pushVerbAliasPath = "/api/v1/projects/:projectId/branches/:branchName/remote-sync/push*";
  app.post(pushVerbAliasPath, async (request, reply) => {
    const raw = (request.params as Record<string, unknown>)["*"];
    if (raw === ":prepare") return preparePushRoute(request, reply);
    if (raw === ":commit") return commitPushRoute(request, reply);
    throw new ServerDomainError(400, "VALIDATION_FAILED", "remote sync push verb is invalid");
  });

  app.get(fastifyPath(REMOTE_SYNC_HTTP_OPERATIONS.push_status.path), async (request, reply) => {
    const params = pathParams(request);
    const { actor, requestId } = await authenticated(request, repository, "files:write");
    await bindProject(repository, actor.actorId, params.projectId);
    const rawQuery = request.query as Record<string, unknown>;
    const source = sourceFromQuery(params, actor.actorId, rawQuery);
    const query = parseBody(remoteSyncPushStatusHttpRequestSchema, {
      source,
      idempotency_key: rawQuery.idempotency_key
    }, "remote sync push status query is invalid");
    if (service === undefined) serviceUnavailable();
    const status = await callService(() => service.getPushStatus(query), operationErrorCodes(REMOTE_SYNC_HTTP_OPERATIONS.push_status));
    if (status === null) throw new ServerDomainError(404, "SYNC_PREPARE_NOT_FOUND", "push prepare was not found");
    const body = validateResponse(remoteSyncPushStatusHttpResponseSchema, {
      ...validateResponse(remoteSyncPushStatusHttpResponseSchema, status),
      idempotency_key: query.idempotency_key
    });
    assertServiceSource(body.source, source);
    reply.header("X-Request-Id", requestId);
    return reply.code(200).send(body);
  });

  app.get(fastifyPath(REMOTE_SYNC_HTTP_OPERATIONS.push_receipt.path), async (request, reply) => {
    const params = pathParams(request);
    const { actor, requestId } = await authenticated(request, repository, "files:write");
    await bindProject(repository, actor.actorId, params.projectId);
    const prepareId = parseBody(prepareIdSchema, (request.params as Record<string, unknown>).prepareId,
      "remote sync push receipt id is invalid");
    const source = sourceFromQuery(params, actor.actorId, request.query as Record<string, unknown>);
    parseBody(remoteSyncPushReceiptHttpRequestSchema, { source, prepare_id: prepareId },
      "remote sync push receipt request is invalid");
    if (service === undefined) serviceUnavailable();
    const receipt = await callService(() => service.getPushReceipt({ source, prepare_id: prepareId }), operationErrorCodes(REMOTE_SYNC_HTTP_OPERATIONS.push_receipt));
    if (receipt === null) throw new ServerDomainError(404, "SYNC_PREPARE_NOT_FOUND", "push prepare was not found");
    const body = validateResponse(remoteSyncPushReceiptHttpResponseSchema, { outcome: "replay", value: receipt });
    if (body.outcome === "conflict") {
      throw new ServerDomainError(503, "REMOTE_UNAVAILABLE", "remote sync service returned an invalid receipt");
    }
    assertServiceSource(body.value.source, source);
    reply.header("X-Request-Id", requestId);
    return reply.code(200).send(body);
  });

  app.post(fastifyPath(REMOTE_SYNC_HTTP_OPERATIONS.pull.path), async (request, reply) => {
    const params = pathParams(request);
    const { actor, requestId } = await authenticated(request, repository, "files:read");
    await bindProject(repository, actor.actorId, params.projectId);
    const body = parseBody(remoteSyncPullHttpRequestSchema, request.body, "remote sync pull request is invalid");
    const source = sourceFor(params, actor.actorId, body.source);
    if (body.actor_id !== actor.actorId) {
      throw new ServerDomainError(403, "PROJECT_INFORMATION_FORBIDDEN", "remote sync actor is outside the authenticated project");
    }
    const idem = idempotencyKey(request);
    assertMatchingIdempotency(idem, body.idempotency_key);
    if (service === undefined) serviceUnavailable();
    const result = validateServiceResult<RemoteSyncPullReceipt>(await callService(() => service.pull({
      source,
      actor_id: actor.actorId,
      idempotency_key: body.idempotency_key,
      ...(body.payload_hash === undefined ? {} : { payload_hash: body.payload_hash })
    }), operationErrorCodes(REMOTE_SYNC_HTTP_OPERATIONS.pull)));
    if (result.outcome !== "conflict") assertServiceSource(result.value.source, source);
    return sendResultUnion(reply, requestId, result, remoteSyncPullHttpResponseSchema, true);
  });
}

export type { RemoteSyncHttpScope };
