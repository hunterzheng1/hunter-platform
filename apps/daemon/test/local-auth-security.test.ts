import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { ProjectIdSchema } from "@hunter/domain";
import { EventLedgerReader, SqliteOperationJournal } from "@hunter/storage";
import { describe, expect, it } from "vitest";
import {
  LocalCapabilityVerifier,
  createLocalCapability,
  signLocalCapabilityRequest,
} from "../src/auth/local-capability.js";
import {
  DaemonReadinessRecordSchema,
  assertProtectedLoopbackListen,
  readDaemonBootstrapCapability,
  serializeDaemonReadiness,
} from "../src/auth/http-boundary.js";
import { startProtectedBoundaryDaemon } from "../src/auth/protected-boundary-daemon.js";
import { buildApp } from "../src/app.js";
import { LocalAuthenticator } from "../src/auth/local-authenticator.js";
import { DurableEventStream } from "../src/events/durable-event-stream.js";

const host = "127.0.0.1:43123";
const origin = "app://hunter";
const projectId = ProjectIdSchema.parse("prj_localauth01");

function harness(bodyLimit = 64 * 1024) {
  const capability = createLocalCapability(() => Buffer.alloc(32, 7));
  const verifier = new LocalCapabilityVerifier(capability, () => 1_000);
  const authenticator = new LocalAuthenticator("local-auth-tests-secret");
  const app = buildApp({
    authenticator,
    allowedHosts: [host],
    allowedOrigins: [origin],
    bodyLimit,
    localCapability: {
      verifier,
      principal: {
        principalId: "desktop",
        authorizedProjectIds: [projectId],
        expiresAt: "2099-01-01T00:00:00.000Z",
        csrf: "not-exported",
        sessionId: "0".repeat(32),
      },
    },
    services: {
      listProjects: async () => [{ projectId, name: "Hunter" }],
      projectForExecutionPlan: () => null,
      projectForRun: () => null,
      startRun: async () => ({}),
    },
  });
  const signedHeaders = (
    method: string,
    url: string,
    body: unknown,
    overrides: Record<string, string> = {},
  ) => ({
    host,
    origin,
    ...signLocalCapabilityRequest(capability, {
      method,
      url,
      host,
      origin,
      timestamp: 1_000,
      nonce: "nonce-local-auth-0001",
      bodyDigest: createHash("sha256")
        .update(body === undefined ? "" : JSON.stringify(body))
        .digest("hex"),
    }),
    ...overrides,
  });
  return { app, capability, signedHeaders };
}

describe("protected local daemon channel", () => {
  it("uses a 256-bit per-start capability and a secret-free strict readiness record", () => {
    const first = createLocalCapability();
    const second = createLocalCapability();
    expect(Buffer.from(first, "base64url")).toHaveLength(32);
    expect(first).not.toBe(second);
    expect(DaemonReadinessRecordSchema.parse({
      schemaVersion: 1,
      kind: "hunterd-ready",
      port: 43123,
    })).toEqual({ schemaVersion: 1, kind: "hunterd-ready", port: 43123 });
    expect(() => DaemonReadinessRecordSchema.parse({
      schemaVersion: 1,
      kind: "hunterd-ready",
      port: 43123,
      capability: first,
    })).toThrow();
    expect(serializeDaemonReadiness({
      schemaVersion: 1,
      kind: "hunterd-ready",
      port: 43123,
    })).toBe('{"schemaVersion":1,"kind":"hunterd-ready","port":43123}\n');
  });

  it("accepts exactly one bounded stdin capability line", async () => {
    const capability = createLocalCapability(() => Buffer.alloc(32, 11));
    await expect(
      readDaemonBootstrapCapability(Readable.from([`${capability}\n`])),
    ).resolves.toBe(capability);
    await expect(
      readDaemonBootstrapCapability(Readable.from([`${capability}\nextra\n`])),
    ).rejects.toThrowError("DAEMON_BOOTSTRAP_INVALID");
    await expect(
      readDaemonBootstrapCapability(Readable.from(["x".repeat(129)])),
    ).rejects.toThrowError("DAEMON_BOOTSTRAP_INVALID");
  });

  it("starts two real authenticated loopback listeners with distinct readiness ports", async () => {
    const firstCapability = createLocalCapability();
    const secondCapability = createLocalCapability();
    let firstReadiness = "";
    let secondReadiness = "";
    const [first, second] = await Promise.all([
      startProtectedBoundaryDaemon({
        capabilityInput: Readable.from([`${firstCapability}\n`]),
        readinessOutput: { write: (record) => { firstReadiness += record; } },
      }),
      startProtectedBoundaryDaemon({
        capabilityInput: Readable.from([`${secondCapability}\n`]),
        readinessOutput: { write: (record) => { secondReadiness += record; } },
      }),
    ]);
    try {
      expect(first.port).not.toBe(second.port);
      expect(DaemonReadinessRecordSchema.parse(JSON.parse(firstReadiness))).toMatchObject({
        port: first.port,
      });
      expect(DaemonReadinessRecordSchema.parse(JSON.parse(secondReadiness))).toMatchObject({
        port: second.port,
      });
      expect(`${firstReadiness}${secondReadiness}`).not.toContain(firstCapability);
      expect(`${firstReadiness}${secondReadiness}`).not.toContain(secondCapability);
      const url = "/health";
      const signed = signLocalCapabilityRequest(firstCapability, {
        method: "GET",
        url,
        host: `127.0.0.1:${first.port}`,
        origin,
        timestamp: Date.now(),
        nonce: "nonce-real-boundary-0001",
        bodyDigest: createHash("sha256").update("").digest("hex"),
      });
      const response = await fetch(`http://127.0.0.1:${first.port}${url}`, {
        headers: {
          host: `127.0.0.1:${first.port}`,
          origin,
          ...signed,
        },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok" });
    } finally {
      await Promise.all([first.shutdown(), second.shutdown()]);
    }
  });

  it("rejects missing signature, wrong Host/Origin/port, cookie fallback, and replay", async () => {
    const { app, signedHeaders } = harness();
    const url = "/api/v1/projects";
    expect((await app.inject({ method: "GET", url, headers: { host, origin } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url, headers: { host, origin, cookie: "capability=private" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url, headers: signedHeaders("GET", url, undefined, { host: "127.0.0.1:43124" }) })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url, headers: signedHeaders("GET", url, undefined, { origin: "https://evil.example" }) })).statusCode).toBe(403);
    const headers = signedHeaders("GET", url, undefined);
    expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(401);
    await app.close();
  });

  it("rejects unsigned SSE, malformed JSON, and oversized payloads", async () => {
    const { app, signedHeaders } = harness(64);
    expect((await app.inject({ method: "GET", url: "/events?once=1", headers: { host, origin } })).statusCode).toBe(401);
    const url = "/runs";
    expect((await app.inject({
      method: "POST",
      url,
      headers: { ...signedHeaders("POST", url, { broken: true }), "content-type": "application/json" },
      payload: "{\"broken\":",
    })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await app.inject({
      method: "POST",
      url,
      headers: { ...signedHeaders("POST", url, { value: "x".repeat(100) }), "content-type": "application/json" },
      payload: { value: "x".repeat(100) },
    })).statusCode).toBe(413);
    await app.close();
  });

  it("requires the local capability even for the REST health endpoint", async () => {
    const { app, signedHeaders } = harness();
    expect((await app.inject({
      method: "GET",
      url: "/health",
      headers: { host, origin },
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: "GET",
      url: "/health",
      headers: signedHeaders("GET", "/health", undefined),
    })).statusCode).toBe(200);
    await app.close();
  });

  it("requires and accepts a signed local capability on the real SSE route", async () => {
    const capability = createLocalCapability(() => Buffer.alloc(32, 13));
    const database = new DatabaseSync(":memory:");
    new SqliteOperationJournal(database);
    const app = buildApp({
      authenticator: new LocalAuthenticator("unused-in-local-mode"),
      allowedHosts: [host],
      allowedOrigins: [origin],
      eventStream: new DurableEventStream(new EventLedgerReader(database)),
      localCapability: {
        verifier: new LocalCapabilityVerifier(capability),
        principal: {
          principalId: "desktop",
          authorizedProjectIds: [projectId],
          expiresAt: "2099-01-01T00:00:00.000Z",
          csrf: "not-exported",
          sessionId: "1".repeat(32),
        },
      },
      services: {
        listProjects: async () => [],
        projectForExecutionPlan: () => null,
        projectForRun: () => null,
        startRun: async () => ({}),
      },
    });
    const url = "/events?once=1";
    const headers = {
      host,
      origin,
      ...signLocalCapabilityRequest(capability, {
        method: "GET",
        url,
        host,
        origin,
        timestamp: Date.now(),
        nonce: "nonce-local-sse-000001",
        lastEventId: "0",
        bodyDigest: createHash("sha256").update("").digest("hex"),
      }),
      "last-event-id": "0",
    };
    expect((await app.inject({
      method: "GET",
      url,
      headers: { host, origin },
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: "GET",
      url,
      headers: { ...headers, "last-event-id": "1" },
    })).statusCode).toBe(401);
    const response = await app.inject({ method: "GET", url, headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    await app.close();
    database.close();
  });

  it("forbids non-loopback plaintext and non-random listen requests", () => {
    expect(() => assertProtectedLoopbackListen({ host: "0.0.0.0", port: 0 })).toThrow();
    expect(() => assertProtectedLoopbackListen({ host: "127.0.0.1", port: 43123 })).toThrow();
    expect(() => assertProtectedLoopbackListen({ host: "127.0.0.1", port: 0 })).not.toThrow();
  });
});
