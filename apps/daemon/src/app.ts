import Fastify, { type FastifyInstance } from "fastify";

import type { LocalAuthenticator } from "./auth/local-authenticator.js";
import { registerDurableEventRoutes, type DurableEventStream } from "./events/durable-event-stream.js";
import { installSecurityHooks } from "./http/security-hooks.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerRunRoutes, type RunRoutesServices } from "./routes/runs.js";

export interface BuildAppOptions {
  readonly authenticator: LocalAuthenticator;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly services: RunRoutesServices;
  readonly bodyLimit?: number;
  readonly eventStream?: DurableEventStream | undefined;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ bodyLimit: options.bodyLimit ?? 64 * 1024, logger: false });
  installSecurityHooks(app, options);
  app.get("/health", async () => ({ status: "ok" }));
  registerProjectRoutes(app);
  registerRunRoutes(app, options.services);
  if (options.eventStream !== undefined) registerDurableEventRoutes(app, options.eventStream);
  return app;
}

export function assertLoopbackListenOptions(options: { readonly host: string; readonly port: number }): void {
  if (options.host !== "127.0.0.1" || options.port !== 0) throw new Error("FOUNDATION_REMOTE_LISTENER_FORBIDDEN");
}
