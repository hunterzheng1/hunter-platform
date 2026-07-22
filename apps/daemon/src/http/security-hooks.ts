import type { FastifyInstance, FastifyRequest } from "fastify";

import type { LocalAuthenticator, LocalPrincipal } from "../auth/local-authenticator.js";

export type AuthenticatedRequest = FastifyRequest & { hunterPrincipal?: LocalPrincipal };

export function installSecurityHooks(app: FastifyInstance, input: { readonly authenticator: LocalAuthenticator; readonly allowedHosts: readonly string[]; readonly allowedOrigins: readonly string[] }): void {
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
