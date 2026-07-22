import type { FastifyInstance, FastifyRequest } from "fastify";

import type { LocalAuthenticator, LocalPrincipal } from "../auth/local-authenticator.js";

export type AuthenticatedRequest = FastifyRequest & { hunterPrincipal?: LocalPrincipal };
type LimitedRequest = AuthenticatedRequest & { hunterConcurrencySlot?: boolean };

export function installSecurityHooks(app: FastifyInstance, input: { readonly authenticator: LocalAuthenticator; readonly allowedHosts: readonly string[]; readonly allowedOrigins: readonly string[]; readonly limits?: { readonly maxConcurrentRequests?: number; readonly maxRequestsPerWindow?: number; readonly rateWindowMs?: number } | undefined }): void {
  const maxConcurrent = input.limits?.maxConcurrentRequests ?? 32;
  const maxRate = input.limits?.maxRequestsPerWindow ?? 120;
  const rateWindowMs = input.limits?.rateWindowMs ?? 60_000;
  let activeRequests = 0;
  const rates: Record<string, { count: number; resetAt: number }> = {};
  const release = (request: FastifyRequest) => {
    const limited = request as LimitedRequest;
    if (limited.hunterConcurrencySlot === true) {
      limited.hunterConcurrencySlot = false;
      activeRequests -= 1;
    }
  };
  app.addHook("onRequest", async (request, reply) => {
    if (activeRequests >= maxConcurrent) return await reply.code(503).send({ code: "REQUEST_CONCURRENCY_LIMIT" });
    activeRequests += 1;
    (request as LimitedRequest).hunterConcurrencySlot = true;
  });
  app.addHook("onResponse", async (request) => release(request));
  app.addHook("onError", async (request) => release(request));
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cache-control", "no-store");
    return payload;
  });
  app.addHook("preValidation", async (request, reply) => {
    const host = request.headers.host;
    if (host === undefined || !input.allowedHosts.includes(host)) return await reply.code(400).send({ code: "HOST_INVALID" });
    if (request.url === "/health") return;
    const origin = request.headers.origin;
    if (origin === undefined || !input.allowedOrigins.includes(origin)) return await reply.code(403).send({ code: "ORIGIN_INVALID" });
    const authorization = request.headers.authorization;
    if (authorization === undefined || !authorization.startsWith("Bearer ")) return await reply.code(401).send({ code: "AUTH_REQUIRED" });
    let principal: LocalPrincipal;
    try {
      principal = input.authenticator.authenticate(authorization.slice(7));
    } catch {
      return await reply.code(401).send({ code: "AUTH_INVALID" });
    }
    (request as AuthenticatedRequest).hunterPrincipal = principal;
    const timestamp = Date.now();
    const currentRate = rates[principal.principalId];
    const rate = currentRate === undefined || currentRate.resetAt <= timestamp ? { count: 0, resetAt: timestamp + rateWindowMs } : currentRate;
    rate.count += 1;
    rates[principal.principalId] = rate;
    if (rate.count > maxRate) return await reply.code(429).send({ code: "RATE_LIMITED" });
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      if (request.headers["content-type"]?.split(";")[0] !== "application/json") return await reply.code(415).send({ code: "CONTENT_TYPE_INVALID" });
      if (request.headers["x-csrf-token"] !== principal.csrf) return await reply.code(403).send({ code: "CSRF_INVALID" });
    }
  });
}

export function requirePrincipal(request: FastifyRequest): LocalPrincipal {
  const principal = (request as AuthenticatedRequest).hunterPrincipal;
  if (principal === undefined) throw new Error("AUTH_CONTEXT_MISSING");
  return principal;
}
