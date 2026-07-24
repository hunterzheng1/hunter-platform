import Fastify from "fastify";

import type { ProjectId } from "@hunter/domain";

import {
  assertProtectedLoopbackListen,
  readDaemonBootstrapCapability,
  serializeDaemonReadiness,
} from "./http-boundary.js";
import { LocalCapabilityVerifier } from "./local-capability.js";
import { installSecurityHooks } from "../http/security-hooks.js";

export interface ProtectedBoundaryDaemonInput {
  readonly capabilityInput: AsyncIterable<Uint8Array | string>;
  readonly readinessOutput: {
    write(record: string): unknown;
  };
  readonly authorizedProjectIds?: readonly ProjectId[] | undefined;
}

export async function startProtectedBoundaryDaemon(
  input: ProtectedBoundaryDaemonInput,
) {
  const capability = await readDaemonBootstrapCapability(input.capabilityInput);
  const allowedHosts: string[] = [];
  const app = Fastify({
    bodyLimit: 64 * 1024,
    connectionTimeout: 30_000,
    logger: false,
    requestTimeout: 30_000,
  });
  installSecurityHooks(app, {
    allowedHosts,
    allowedOrigins: ["app://hunter"],
    localCapability: {
      verifier: new LocalCapabilityVerifier(capability),
      principal: {
        principalId: "desktop",
        authorizedProjectIds: input.authorizedProjectIds ?? [],
        expiresAt: "9999-12-31T23:59:59.999Z",
        csrf: "local-capability",
        sessionId: "0".repeat(32),
      },
    },
  });
  app.get("/health", async () => ({ status: "ok" }));
  const listenOptions = { host: "127.0.0.1", port: 0 } as const;
  assertProtectedLoopbackListen(listenOptions);
  try {
    await app.listen(listenOptions);
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("DAEMON_LISTEN_ADDRESS_INVALID");
    }
    allowedHosts.push(`127.0.0.1:${address.port}`);
    input.readinessOutput.write(serializeDaemonReadiness({
      schemaVersion: 1,
      kind: "hunterd-ready",
      port: address.port,
    }));
    let closed = false;
    return {
      port: address.port,
      shutdown: async () => {
        if (closed) return;
        closed = true;
        await app.close();
      },
    };
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}
