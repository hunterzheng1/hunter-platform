import {
  knowledgeQueryHttpErrorCodeSchema,
  knowledgeQueryHttpRequestHeadersSchema,
  knowledgeQueryHttpRequestSchema,
  validateKnowledgeQueryHttpResponse,
  KNOWLEDGE_QUERY_HTTP_OPERATIONS,
  type KnowledgeQueryHttpRequest
} from "@hunter-harness/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isProxy } from "node:util/types";
import { z } from "zod";

import type { Actor, ProjectKeyScope, ServerRepository } from "../repositories/interfaces.js";
import { ServerDomainError } from "../repositories/interfaces.js";
import type { KnowledgeQueryHttpServicePort } from "./ports.js";

export interface KnowledgeQueryHttpRoutesOptions {
  readonly repository: ServerRepository;
  readonly service?: KnowledgeQueryHttpServicePort;
  readonly authenticated: (
    request: FastifyRequest,
    repository: ServerRepository,
    projectScope?: ProjectKeyScope
  ) => Promise<{ readonly actor: Actor; readonly requestId: string }>;
}

const projectIdSchema = z.string().regex(/^prj_[A-Za-z0-9_-]{1,124}$/u);

function parseBody(value: unknown): KnowledgeQueryHttpRequest {
  const parsed = knowledgeQueryHttpRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new ServerDomainError(400, "KNOWLEDGE_QUERY_INVALID", "knowledge query request is invalid");
  }
  return parsed.data;
}

function projectParam(request: FastifyRequest): string {
  const value = (request.params as Record<string, unknown>).projectId;
  const parsed = projectIdSchema.safeParse(value);
  if (!parsed.success) throw new ServerDomainError(400, "KNOWLEDGE_QUERY_INVALID", "knowledge project is invalid");
  return parsed.data;
}

function requestIdempotencyKey(request: FastifyRequest): string {
  const parsed = knowledgeQueryHttpRequestHeadersSchema.safeParse({
    "X-Request-Id": request.headers["x-request-id"],
    "Idempotency-Key": request.headers["idempotency-key"]
  });
  if (!parsed.success || parsed.data["Idempotency-Key"] === undefined) {
    throw new ServerDomainError(400, "KNOWLEDGE_QUERY_INVALID", "Idempotency-Key is required and invalid");
  }
  return parsed.data["Idempotency-Key"];
}

async function bindProject(repository: ServerRepository, actorId: string, projectId: string): Promise<void> {
  try {
    await repository.getProject(actorId, projectId);
  } catch (error) {
    if (error instanceof ServerDomainError && error.status < 500) {
      throw new ServerDomainError(403, "PROJECT_INFORMATION_FORBIDDEN", "project information is not accessible");
    }
    throw new ServerDomainError(503, "REMOTE_UNAVAILABLE", "knowledge query authority is unavailable");
  }
}

function serviceUnavailable(): never {
  throw new ServerDomainError(503, "REMOTE_UNAVAILABLE", "knowledge query service is not configured");
}

interface SnapshotBudget {
  nodes: number;
  stringBytes: number;
}

function snapshotServiceValue(
  value: unknown,
  budget: SnapshotBudget,
  depth = 0,
  active = new WeakSet<object>()
): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("invalid service output");
    if (typeof value === "string") {
      if (value.length > 32_768 || value !== value.normalize("NFC")) throw new Error("invalid service output");
      budget.stringBytes += new TextEncoder().encode(value).byteLength;
      if (budget.stringBytes > 256 * 1024) throw new Error("invalid service output");
    }
    return value;
  }
  if (typeof value !== "object" || isProxy(value) || depth > 16 || ++budget.nodes > 10_000 || active.has(value)) {
    throw new Error("invalid service output");
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error("invalid service output");
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (lengthDescriptor === undefined || !("value" in lengthDescriptor) ||
          !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value > 1_024) {
        throw new Error("invalid service output");
      }
      const length = lengthDescriptor.value as number;
      const output: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          throw new Error("invalid service output");
        }
        output.push(snapshotServiceValue(descriptor.value, budget, depth + 1, active));
      }
      const keys = Reflect.ownKeys(value);
      if (keys.length !== length + 1 || keys.some((key) => key !== "length" &&
          (typeof key !== "string" || !/^\d+$/u.test(key) || Number(key) >= length))) {
        throw new Error("invalid service output");
      }
      return output;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("invalid service output");
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new Error("invalid service output");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new Error("invalid service output");
      }
      output[key] = snapshotServiceValue(descriptor.value, budget, depth + 1, active);
    }
    return output;
  } finally {
    active.delete(value);
  }
}

type CapturedServiceResult =
  | { readonly outcome: "new" | "replay"; readonly value: unknown }
  | { readonly outcome: "conflict"; readonly error: { readonly code: "KNOWLEDGE_QUERY_IDEMPOTENCY_CONFLICT"; readonly retryable: boolean } };

function captureServiceResult(value: unknown): CapturedServiceResult | null {
  try {
    const snapshot = snapshotServiceValue(value, { nodes: 0, stringBytes: 0 });
    if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
    const result = snapshot as Record<string, unknown>;
    const keys = Object.keys(result);
    if (result.outcome === "new" || result.outcome === "replay") {
      if (keys.length !== 2 || !keys.includes("outcome") || !keys.includes("value")) return null;
      return { outcome: result.outcome, value: result.value };
    }
    if (result.outcome !== "conflict" || keys.length !== 2 || !keys.includes("outcome") || !keys.includes("error")) {
      return null;
    }
    const error = result.error;
    if (error === null || typeof error !== "object" || Array.isArray(error)) return null;
    const errorRecord = error as Record<string, unknown>;
    if (Object.keys(errorRecord).length !== 2 || errorRecord.code !== "KNOWLEDGE_QUERY_IDEMPOTENCY_CONFLICT" ||
        typeof errorRecord.retryable !== "boolean") return null;
    return {
      outcome: "conflict",
      error: errorRecord as {
        readonly code: "KNOWLEDGE_QUERY_IDEMPOTENCY_CONFLICT";
        readonly retryable: boolean;
      }
    };
  } catch {
    return null;
  }
}

function serviceCode(error: unknown): string | null {
  try {
    if (typeof error !== "object" || error === null || isProxy(error)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
    return typeof descriptor.value === "string" ? descriptor.value : null;
  } catch {
    return null;
  }
}

function mapServiceError(error: unknown): never {
  const code = serviceCode(error);
  const parsed = code === null ? null : knowledgeQueryHttpErrorCodeSchema.safeParse(code);
  if (parsed === null || !parsed.success) {
    throw new ServerDomainError(503, "REMOTE_UNAVAILABLE", "knowledge query service is unavailable");
  }
  const status = parsed.data === "AUTH_REQUIRED" || parsed.data === "TOKEN_INVALID" || parsed.data === "SESSION_INVALID" ? 401
    : parsed.data === "PROJECT_INFORMATION_FORBIDDEN" || parsed.data === "PROJECT_KEY_SCOPE" || parsed.data === "PROJECT_KEY_MISMATCH" ? 403
      : parsed.data === "KNOWLEDGE_QUERY_ABORTED" ? 499
    : parsed.data === "KNOWLEDGE_QUERY_IDEMPOTENCY_CONFLICT" || parsed.data === "KNOWLEDGE_QUERY_SNAPSHOT_STALE" ? 409
      : parsed.data === "KNOWLEDGE_QUERY_INVALID" ? 400
        : parsed.data === "KNOWLEDGE_QUERY_RECEIPT_INVALID" ? 422 : 503;
  throw new ServerDomainError(status, parsed.data, "knowledge query operation failed");
}

async function callService<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    mapServiceError(error);
  }
}

function conflictReply(reply: FastifyReply, requestId: string, retryable: boolean): FastifyReply {
  return reply.header("X-Request-Id", requestId).code(409).send({
    error: {
      code: "KNOWLEDGE_QUERY_IDEMPOTENCY_CONFLICT",
      message: "Idempotency-Key is already bound to a different query",
      request_id: requestId,
      outcome: "conflict",
      details: { retryable }
    }
  });
}

export function registerKnowledgeQueryHttpRoutes(
  app: FastifyInstance,
  options: KnowledgeQueryHttpRoutesOptions
): void {
  app.post(KNOWLEDGE_QUERY_HTTP_OPERATIONS.query.path
    .replace("{project_id}", ":projectId"), async (request, reply) => {
    const projectId = projectParam(request);
    const { actor, requestId } = await options.authenticated(request, options.repository, "knowledge:read");
    await bindProject(options.repository, actor.actorId, projectId);
    const body = parseBody(request.body);
    if (body.project_id !== projectId) {
      throw new ServerDomainError(403, "PROJECT_INFORMATION_FORBIDDEN", "knowledge query project is outside the authenticated project");
    }
    const idempotencyKey = requestIdempotencyKey(request);
    const service = options.service;
    if (service === undefined) serviceUnavailable();
    const rawResult = await callService(() => service.execute({
      request: body,
      actor_id: actor.actorId,
      idempotency_key: idempotencyKey
    }));
    const result = captureServiceResult(rawResult);
    if (result === null) {
      throw new ServerDomainError(503, "REMOTE_UNAVAILABLE", "knowledge query service returned an invalid outcome");
    }
    if (result.outcome === "conflict") return conflictReply(reply, requestId, result.error.retryable);
    let verified: ReturnType<typeof validateKnowledgeQueryHttpResponse>;
    try {
      verified = validateKnowledgeQueryHttpResponse(result.value, body);
    } catch {
      throw new ServerDomainError(503, "REMOTE_UNAVAILABLE", "knowledge query service returned an invalid response");
    }
    if (!verified.success) {
      throw new ServerDomainError(503, "REMOTE_UNAVAILABLE", "knowledge query service returned an invalid response");
    }
    return reply.header("X-Request-Id", requestId)
      .code(result.outcome === "new" ? 201 : 200)
      .send(verified.data);
  });
}
