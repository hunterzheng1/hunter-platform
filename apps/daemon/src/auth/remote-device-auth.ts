import {
  ProjectIdSchema,
  type ProjectId,
} from "@hunter/domain";
import {
  MobileRunProjectionSchema,
  type DeviceCommandPrincipal,
  type DeviceGateway,
  type MobileRunProjection,
  type PairingService,
  type TokenService,
} from "@hunter/device-gateway";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";
import type { ServerOptions as HttpsServerOptions } from "node:https";

import type { DurableEventStream } from "../events/durable-event-stream.js";
import {
  registerMobileCommandRoutes,
  requireDevicePrincipal,
  type RemoteDeviceRequest,
} from "../routes/mobile-commands.js";

export interface RemoteDeviceAppOptions {
  readonly tokens: TokenService;
  readonly pairing: PairingService;
  readonly gateway: DeviceGateway;
  readonly eventStream: DurableEventStream;
  readonly projections: {
    list(authorizedProjectIds: readonly ProjectId[]): readonly MobileRunProjection[];
  };
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly limits?: {
    readonly maxConcurrentRequests?: number;
    readonly maxRequestsPerWindow?: number;
    readonly rateWindowMs?: number;
    readonly bodyLimit?: number;
    readonly requestTimeoutMs?: number;
  };
  readonly https: HttpsServerOptions;
}

type LimitedRemoteRequest = FastifyRequest & {
  hunterRemoteConcurrencySlot?: boolean;
};

function projectIdFor(request: FastifyRequest): ProjectId | undefined {
  const body = request.body;
  if (body !== null && typeof body === "object" && "projectId" in body) {
    const parsed = ProjectIdSchema.safeParse(body.projectId);
    return parsed.success ? parsed.data : undefined;
  }
  const query = request.query;
  if (query !== null && typeof query === "object" && "projectId" in query) {
    const parsed = ProjectIdSchema.safeParse(query.projectId);
    return parsed.success ? parsed.data : undefined;
  }
  return undefined;
}

function stringHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function authStatus(error: unknown): number {
  if (
    error instanceof Error
    && (
      error.message === "ACCESS_TOKEN_PROJECT_FORBIDDEN"
      || error.message === "DEVICE_PROJECT_FORBIDDEN"
    )
  ) {
    return 403;
  }
  return 401;
}

export function buildRemoteDeviceApp(options: RemoteDeviceAppOptions): FastifyInstance {
  if (options.https === undefined) throw new Error("REMOTE_HTTPS_REQUIRED");
  const baseOptions = {
    bodyLimit: options.limits?.bodyLimit ?? 64 * 1024,
    requestTimeout: options.limits?.requestTimeoutMs ?? 30_000,
    connectionTimeout: options.limits?.requestTimeoutMs ?? 30_000,
    logger: false,
  };
  const app = Fastify({
    ...baseOptions,
    https: options.https,
  }) as unknown as FastifyInstance;
  const maxConcurrent = options.limits?.maxConcurrentRequests ?? 16;
  const maxRate = options.limits?.maxRequestsPerWindow ?? 60;
  const rateWindowMs = options.limits?.rateWindowMs ?? 60_000;
  let concurrent = 0;
  const rateByDevice = new Map<string, { count: number; resetAt: number }>();
  const refreshRateByAddress = new Map<string, { count: number; resetAt: number }>();
  const preAuthRateByAddress = new Map<string, { count: number; resetAt: number }>();
  const consumeRate = (
    rates: Map<string, { count: number; resetAt: number }>,
    key: string,
  ): boolean => {
    const now = Date.now();
    for (const [candidate, window] of rates) {
      if (window.resetAt <= now) rates.delete(candidate);
    }
    if (!rates.has(key) && rates.size >= 4_096) {
      const oldest = rates.keys().next().value as string | undefined;
      if (oldest !== undefined) rates.delete(oldest);
    }
    const prior = rates.get(key);
    const rate = prior === undefined || prior.resetAt <= now
      ? { count: 0, resetAt: now + rateWindowMs }
      : prior;
    rate.count += 1;
    rates.set(key, rate);
    return rate.count <= maxRate;
  };
  const release = (request: FastifyRequest) => {
    const limited = request as LimitedRemoteRequest;
    if (limited.hunterRemoteConcurrencySlot === true) {
      limited.hunterRemoteConcurrencySlot = false;
      concurrent = Math.max(0, concurrent - 1);
    }
  };
  const pairingRoute = (url: string) =>
    /^\/api\/v1\/mobile\/pairings\/pair_[a-f0-9]{24}\/(?:submit|complete)$/u.test(
      url,
    );
  const knownRemoteRoute = (url: string) =>
    url === "/api/v1/mobile/commands"
    || url === "/api/v1/mobile/refresh"
    || pairingRoute(url)
    || url.startsWith("/api/v1/mobile/runs?")
    || url.startsWith("/api/v1/mobile/events?")
    || url === "/api/v1/mobile/events";

  app.addHook("onRequest", async (request, reply) => {
    if (concurrent >= maxConcurrent) {
      return await reply.code(503).send({ code: "REMOTE_CONCURRENCY_LIMIT" });
    }
    concurrent += 1;
    (request as LimitedRemoteRequest).hunterRemoteConcurrencySlot = true;
  });
  app.addHook("onResponse", async (request) => release(request));
  app.addHook("onError", async (request) => release(request));
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header(
      "content-security-policy",
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cache-control", "no-store");
    const origin = request.headers.origin;
    if (typeof origin === "string" && options.allowedOrigins.includes(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("vary", "Origin");
    }
    return payload;
  });
  app.addHook("preValidation", async (request, reply) => {
    if (!knownRemoteRoute(request.url)) {
      return await reply.code(404).send({ code: "REMOTE_ROUTE_NOT_FOUND" });
    }
    const host = request.headers.host;
    if (host === undefined || !options.allowedHosts.includes(host)) {
      return await reply.code(400).send({ code: "HOST_INVALID" });
    }
    const origin = request.headers.origin;
    if (origin === undefined || !options.allowedOrigins.includes(origin)) {
      return await reply.code(403).send({ code: "ORIGIN_INVALID" });
    }
    if (request.method === "OPTIONS") {
      const requestedMethod = stringHeader(request, "access-control-request-method");
      const requestedHeaders = stringHeader(
        request,
        "access-control-request-headers",
      )?.split(",").map((header) => header.trim().toLowerCase()).filter(Boolean) ?? [];
      const allowedHeaders = new Set([
        "authorization",
        "content-type",
        "x-device-timestamp",
        "x-device-nonce",
        "x-device-proof",
      ]);
      if (
        requestedMethod === undefined
        || !["GET", "POST"].includes(requestedMethod.toUpperCase())
        || requestedHeaders.some((header) => !allowedHeaders.has(header))
      ) {
        return await reply.code(400).send({ code: "CORS_PREFLIGHT_INVALID" });
      }
      return await reply
        .headers({
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": [...allowedHeaders].join(", "),
          "access-control-max-age": "300",
        })
        .code(204)
        .send();
    }
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(request.method)
      && request.headers["content-type"]?.split(";")[0] !== "application/json"
    ) {
      return await reply.code(415).send({ code: "CONTENT_TYPE_INVALID" });
    }
    const preAuthenticatedRequest =
      request.url === "/api/v1/mobile/refresh" || pairingRoute(request.url);
    const sourceRates = preAuthenticatedRequest
      ? refreshRateByAddress
      : preAuthRateByAddress;
    if (!consumeRate(sourceRates, request.ip)) {
      return await reply.code(429).send({ code: "REMOTE_RATE_LIMIT" });
    }
    if (preAuthenticatedRequest) {
      return;
    }
    const projectId = projectIdFor(request);
    if (projectId === undefined) {
      return await reply.code(400).send({ code: "PROJECT_ID_REQUIRED" });
    }
    const authorization = request.headers.authorization;
    const timestamp = stringHeader(request, "x-device-timestamp");
    const nonce = stringHeader(request, "x-device-nonce");
    const proof = stringHeader(request, "x-device-proof");
    if (
      authorization === undefined
      || !authorization.startsWith("Bearer ")
      || timestamp === undefined
      || nonce === undefined
      || proof === undefined
    ) {
      return await reply.code(401).send({ code: "DEVICE_AUTH_REQUIRED" });
    }
    try {
      const claims = options.tokens.verifyDeviceRequest({
        accessToken: authorization.slice(7),
        audience: "hunter-mobile",
        projectId,
        method: request.method,
        url: request.url,
        body: request.body,
        timestamp,
        nonce,
        proof,
      });
      const principal: DeviceCommandPrincipal = {
        deviceId: claims.sub,
        scopes: claims.scopes,
        projectIds: claims.projectIds,
      };
      (request as RemoteDeviceRequest).hunterDevicePrincipal = principal;
      if (!consumeRate(rateByDevice, principal.deviceId)) {
        return await reply.code(429).send({ code: "REMOTE_RATE_LIMIT" });
      }
    } catch (error) {
      return await reply.code(authStatus(error)).send({
        code: authStatus(error) === 403 ? "DEVICE_PROJECT_FORBIDDEN" : "DEVICE_AUTH_INVALID",
      });
    }
  });

  app.post("/api/v1/mobile/refresh", async (request, reply) => {
    try {
      return options.tokens.rotateRefresh(request.body);
    } catch {
      return await reply.code(401).send({ code: "REFRESH_AUTH_INVALID" });
    }
  });
  app.post("/api/v1/mobile/pairings/:pairingId/submit", async (request, reply) => {
    try {
      return options.pairing.submitPairing({
        ...(request.body as Record<string, unknown>),
        pairingId: (request.params as { pairingId?: unknown }).pairingId,
      });
    } catch (error) {
      return await reply.code(400).send({
        code: error instanceof Error ? error.message : "PAIRING_SUBMISSION_REJECTED",
      });
    }
  });
  app.post("/api/v1/mobile/pairings/:pairingId/complete", async (request, reply) => {
    try {
      return options.pairing.deliverCredentials(
        {
          ...(request.body as Record<string, unknown>),
          pairingId: (request.params as { pairingId?: unknown }).pairingId,
        },
        (device) => options.tokens.issue(device.deviceId),
      );
    } catch (error) {
      const code = error instanceof Error ? error.message : "PAIRING_COMPLETION_REJECTED";
      return await reply
        .code(code === "PAIRING_NOT_CONFIRMED" ? 409 : 400)
        .send({ code });
    }
  });
  registerMobileCommandRoutes(app, options.gateway);
  app.get("/api/v1/mobile/runs", async (request, reply) => {
    const principal = requireDevicePrincipal(request);
    const projectId = projectIdFor(request);
    if (projectId === undefined || !principal.projectIds.includes(projectId)) {
      return await reply.code(403).send({ code: "DEVICE_PROJECT_FORBIDDEN" });
    }
    if (!principal.scopes.includes("runs:read")) {
      return await reply.code(403).send({ code: "DEVICE_SCOPE_FORBIDDEN" });
    }
    return MobileRunProjectionSchema.array().max(500).parse(
      options.projections.list([projectId]),
    );
  });
  app.get("/api/v1/mobile/events", async (request, reply) => {
    const principal = requireDevicePrincipal(request);
    const query = request.query as {
      readonly projectId?: string | undefined;
      readonly cursor?: string | undefined;
      readonly once?: string | undefined;
    };
    const projectId = ProjectIdSchema.parse(query.projectId);
    if (!principal.projectIds.includes(projectId)) {
      return await reply.code(403).send({ code: "DEVICE_PROJECT_FORBIDDEN" });
    }
    let streamStarted = false;
    try {
      const replay = options.eventStream.replay({
        headerCursor: stringHeader(request, "last-event-id"),
        queryCursor: query.cursor,
        authorizedProjectIds: [projectId],
      });
      if (replay.status === "resync_required") {
        return await reply.code(409).send(replay);
      }
      reply.header("content-type", "text/event-stream; charset=utf-8");
      if (query.once === "1") return options.eventStream.format(replay.events);

      const releaseStream = options.eventStream.acquire(`device:${principal.deviceId}`);
      const abort = new AbortController();
      request.raw.once("close", () => abort.abort());
      let keepalive: ReturnType<typeof setInterval> | undefined;
      try {
        reply.hijack();
        streamStarted = true;
        reply.raw.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
          "referrer-policy": "no-referrer",
        });
        reply.raw.write(options.eventStream.format(replay.events));
        const accessToken = request.headers.authorization?.slice(7);
        keepalive = setInterval(() => {
          try {
            if (accessToken === undefined) throw new Error("DEVICE_AUTH_REQUIRED");
            options.tokens.verifyAccessToken(accessToken, {
              audience: "hunter-mobile",
              projectId,
            });
            if (!reply.raw.writableEnded) {
              reply.raw.write(options.eventStream.formatKeepalive());
            }
          } catch {
            abort.abort();
          }
        }, options.eventStream.keepaliveIntervalMs);
        keepalive.unref();
        const position = replay.events.at(-1)?.position
          ?? (query.cursor === undefined ? 0 : Number(query.cursor));
        for await (const event of options.eventStream.readerTail({
          position,
          authorizedProjectIds: [projectId],
          signal: abort.signal,
        })) {
          if (event.projectId !== projectId) continue;
          reply.raw.write(options.eventStream.format([event]));
        }
      } finally {
        if (keepalive !== undefined) clearInterval(keepalive);
        releaseStream();
        if (!reply.raw.writableEnded) reply.raw.end();
      }
      return;
    } catch (error) {
      if (streamStarted) return;
      const code = error instanceof Error ? error.message : "EVENT_CURSOR_INVALID";
      return await reply
        .code(code === "SSE_CONNECTION_LIMIT" ? 429 : 400)
        .send({ code });
    }
  });
  return app;
}
