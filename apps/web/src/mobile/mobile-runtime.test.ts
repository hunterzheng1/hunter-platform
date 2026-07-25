// @vitest-environment jsdom
import { webcrypto } from "node:crypto";

import {
  MobileCommandEnvelopeSchema,
  MobileRunProjectionSchema,
} from "@hunter/device-gateway";
import { ProjectIdSchema } from "@hunter/domain";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";

import { CredentialVault } from "./credential-vault.js";
import { DeviceKeyStore } from "./device-key.js";
import { MobileRuntime } from "./mobile-runtime.js";

describe("mobile production runtime", () => {
  it("restores the vault, rotates in place, and signs projection and command traffic", async () => {
    const indexedDB = new IDBFactory();
    const keys = new DeviceKeyStore({
      indexedDB,
      crypto: webcrypto as unknown as Crypto,
    });
    const identity = await keys.createIdentity();
    const vault = new CredentialVault({ indexedDB, keys });
    await vault.bind({
      keyId: identity.keyId,
      refreshCredential: "refresh-mobile-runtime-initial-000001",
    });
    const command = MobileCommandEnvelopeSchema.parse({
      projectId: "prj_mobile00001",
      runId: "run_mobile00001",
      stepRunId: "spr_mobile00001",
      expectedVersion: 2,
      idempotencyKey: "mobile-runtime-pause-0001",
      action: "pause_run",
      payload: {},
    });
    const projection = MobileRunProjectionSchema.parse({
      projectId: command.projectId,
      runId: command.runId,
      projectName: "Runtime project",
      currentStep: "agent",
      attention: "Run is running",
      connection: "online",
      commands: [command],
    });
    const refreshedProjection = MobileRunProjectionSchema.parse({
      ...projection,
      attention: "Run is paused",
      connection: "online",
    });
    let projectionReads = 0;
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/api/v1/mobile/refresh")) {
        expect(JSON.parse(String(init.body))).toMatchObject({
          refreshCredential: "refresh-mobile-runtime-initial-000001",
        });
        return Response.json({
          accessToken: "access-mobile-runtime-memory-only",
          accessExpiresAt: "2026-07-24T00:05:00.000Z",
          refreshCredential: "refresh-mobile-runtime-rotated-000001",
          refreshExpiresAt: "2026-08-20T00:00:00.000Z",
        });
      }
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBe(
        "Bearer access-mobile-runtime-memory-only",
      );
      expect(headers.get("x-device-proof")?.length).toBeGreaterThan(40);
      expect(headers.get("x-device-nonce")).toMatch(/^runtime-nonce-/u);
      if (url.includes("/api/v1/mobile/runs?")) {
        projectionReads += 1;
        return Response.json([
          projectionReads === 1 ? projection : refreshedProjection,
        ]);
      }
      if (url.includes("/api/v1/mobile/events?")) {
        return new Response(
          url.includes("cursor=7")
            ? ""
            : 'id: 7\nevent: FlowEvent\ndata: {"position":7}\n\n',
          { headers: { "content-type": "text/event-stream; charset=utf-8" } },
        );
      }
      if (url.endsWith("/api/v1/mobile/commands")) {
        expect(JSON.parse(String(init.body))).toEqual(command);
        return Response.json({
          status: "accepted",
          receipt: {
            commandId: "ApplyRunControl:mobile-runtime-pause-0001",
            response: { status: "accepted" },
          },
        });
      }
      throw new Error(`unexpected request ${url}`);
    });
    let nonce = 0;
    const runtime = new MobileRuntime({
      apiOrigin: "https://remote.hunter",
      projectIds: [command.projectId],
      vault,
      keys,
      fetch: fetchImpl,
      now: () => new Date("2026-07-24T00:00:00.000Z"),
      nonce: () => `runtime-nonce-${++nonce}`,
    });

    await expect(runtime.connect()).resolves.toEqual({
      state: "connected",
      runs: [projection],
    });
    await expect(runtime.execute(command)).resolves.toMatchObject({
      status: "accepted",
    });
    await expect(runtime.pollEvents()).resolves.toEqual({
      state: "connected",
      runs: [refreshedProjection],
    });
    await expect(runtime.pollEvents()).resolves.toEqual({
      state: "connected",
      runs: [refreshedProjection],
    });
    expect(JSON.stringify(runtime.snapshot())).not.toContain("access-mobile");
    expect(JSON.stringify(runtime.snapshot())).not.toContain("refresh-mobile");
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/v1/mobile/refresh",
      "/api/v1/mobile/runs",
      "/api/v1/mobile/commands",
      "/api/v1/mobile/events",
      "/api/v1/mobile/runs",
      "/api/v1/mobile/events",
    ]);
    expect(requests.at(-1)?.url).toContain("cursor=7");
  });

  it("fails closed without a persisted device binding", async () => {
    const indexedDB = new IDBFactory();
    const keys = new DeviceKeyStore({
      indexedDB,
      crypto: webcrypto as unknown as Crypto,
    });
    const runtime = new MobileRuntime({
      apiOrigin: "https://remote.hunter",
      projectIds: [ProjectIdSchema.parse("prj_mobile00001")],
      vault: new CredentialVault({ indexedDB, keys }),
      keys,
      fetch: vi.fn(),
    });

    await expect(runtime.connect()).resolves.toEqual({ state: "unpaired" });
    await expect(runtime.execute({})).rejects.toThrow("PAIRING_REQUIRED");
  });

  it("keeps a restored device paired but offline when cold-start refresh cannot reach the Host", async () => {
    const indexedDB = new IDBFactory();
    const keys = new DeviceKeyStore({
      indexedDB,
      crypto: webcrypto as unknown as Crypto,
    });
    const identity = await keys.createIdentity();
    const vault = new CredentialVault({ indexedDB, keys });
    await vault.bind({
      keyId: identity.keyId,
      refreshCredential: "refresh-mobile-offline-cold-start-000001",
    });
    const runtime = new MobileRuntime({
      apiOrigin: "https://remote.hunter",
      projectIds: [ProjectIdSchema.parse("prj_mobile00001")],
      vault,
      keys,
      fetch: vi.fn(async () => {
        throw new TypeError("network unavailable");
      }),
      now: () => new Date("2026-07-25T02:00:00.000Z"),
    });

    await expect(runtime.connect()).resolves.toEqual({
      state: "offline",
      runs: [],
    });
    expect(vault.snapshot().state).toBe("paired");
    await expect(runtime.execute({})).rejects.toThrow("PAIRING_REQUIRED");
  });

  it.each([429, 503])(
    "keeps a restored device paired and its outbox reachable after retryable HTTP %i",
    async (status) => {
      const indexedDB = new IDBFactory();
      const keys = new DeviceKeyStore({
        indexedDB,
        crypto: webcrypto as unknown as Crypto,
      });
      const identity = await keys.createIdentity();
      const vault = new CredentialVault({ indexedDB, keys });
      await vault.bind({
        keyId: identity.keyId,
        refreshCredential: `refresh-mobile-retryable-${status}-cold-start-000001`,
      });
      const runtime = new MobileRuntime({
        apiOrigin: "https://remote.hunter",
        projectIds: [ProjectIdSchema.parse("prj_mobile00001")],
        vault,
        keys,
        fetch: vi.fn(async () => Response.json(
          { code: "TEMPORARILY_UNAVAILABLE" },
          { status },
        )),
        now: () => new Date("2026-07-25T02:05:00.000Z"),
      });

      await expect(runtime.connect()).resolves.toEqual({
        state: "offline",
        runs: [],
      });
      expect(vault.snapshot().state).toBe("paired");
    },
  );

  it("rotates and re-signs both command and event requests after access-token expiry", async () => {
    const indexedDB = new IDBFactory();
    const keys = new DeviceKeyStore({
      indexedDB,
      crypto: webcrypto as unknown as Crypto,
    });
    const identity = await keys.createIdentity();
    const vault = new CredentialVault({ indexedDB, keys });
    await vault.bind({
      keyId: identity.keyId,
      refreshCredential: "refresh-mobile-access-expiry-initial-000001",
    });
    const command = MobileCommandEnvelopeSchema.parse({
      projectId: "prj_mobile00001",
      runId: "run_mobile00001",
      stepRunId: "spr_mobile00001",
      expectedVersion: 2,
      idempotencyKey: "mobile-access-expiry-command-0001",
      action: "pause_run",
      payload: {},
    });
    const projection = MobileRunProjectionSchema.parse({
      projectId: command.projectId,
      runId: command.runId,
      projectName: "Access expiry project",
      currentStep: "agent",
      attention: "Run is active",
      connection: "online",
      commands: [command],
    });
    let refreshCount = 0;
    const signedRequests: Array<{
      readonly authorization: string | null;
      readonly nonce: string | null;
      readonly proof: string | null;
    }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.endsWith("/api/v1/mobile/refresh")) {
        refreshCount += 1;
        return Response.json({
          accessToken: `access-mobile-expiry-memory-${refreshCount}`.padEnd(32, "x"),
          accessExpiresAt: "2026-07-25T02:10:00.000Z",
          refreshCredential: `refresh-mobile-expiry-rotated-${refreshCount}`.padEnd(32, "x"),
          refreshExpiresAt: "2026-08-20T00:00:00.000Z",
        });
      }
      const headers = new Headers(init.headers);
      signedRequests.push({
        authorization: headers.get("authorization"),
        nonce: headers.get("x-device-nonce"),
        proof: headers.get("x-device-proof"),
      });
      if (url.includes("/api/v1/mobile/runs?")) {
        return Response.json([projection]);
      }
      const authorization = headers.get("authorization");
      if (url.endsWith("/api/v1/mobile/commands")) {
        if (authorization?.includes("memory-1")) {
          return Response.json({ code: "ACCESS_TOKEN_EXPIRED" }, { status: 401 });
        }
        expect(authorization).toContain("memory-2");
        return Response.json({
          status: "accepted",
          receipt: {
            commandId: "ApplyRunControl:mobile-access-expiry-command-0001",
            response: { status: "accepted" },
          },
        });
      }
      if (url.includes("/api/v1/mobile/events?")) {
        if (authorization?.includes("memory-2")) {
          return Response.json({ code: "ACCESS_TOKEN_EXPIRED" }, { status: 401 });
        }
        expect(authorization).toContain("memory-3");
        return new Response("");
      }
      throw new Error(`unexpected request ${url}`);
    });
    let nonce = 0;
    const runtime = new MobileRuntime({
      apiOrigin: "https://remote.hunter",
      projectIds: [command.projectId],
      vault,
      keys,
      fetch: fetchImpl,
      now: () => new Date("2026-07-25T02:05:00.000Z"),
      nonce: () => `expiry-runtime-nonce-${++nonce}`,
    });

    await expect(runtime.connect()).resolves.toMatchObject({ state: "connected" });
    await expect(runtime.execute(command)).resolves.toMatchObject({ status: "accepted" });
    await expect(runtime.pollEvents()).resolves.toMatchObject({ state: "connected" });
    expect(refreshCount).toBe(3);
    expect(vault.snapshot().state).toBe("paired");
    expect(signedRequests).toHaveLength(5);
    expect(new Set(signedRequests.map(({ nonce: value }) => value)).size).toBe(5);
    expect(new Set(signedRequests.map(({ proof }) => proof)).size).toBe(5);
    expect(signedRequests.every(({ proof }) => (proof?.length ?? 0) > 40)).toBe(true);
  });

  it.each([401, 403])(
    "revokes the local binding when access refresh is terminally rejected with HTTP %i",
    async (terminalStatus) => {
    const indexedDB = new IDBFactory();
    const keys = new DeviceKeyStore({
      indexedDB,
      crypto: webcrypto as unknown as Crypto,
    });
    const identity = await keys.createIdentity();
    const vault = new CredentialVault({ indexedDB, keys });
    await vault.bind({
      keyId: identity.keyId,
      refreshCredential: "refresh-mobile-terminal-expiry-initial-000001",
    });
    let refreshCount = 0;
    const runtime = new MobileRuntime({
      apiOrigin: "https://remote.hunter",
      projectIds: [ProjectIdSchema.parse("prj_mobile00001")],
      vault,
      keys,
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/v1/mobile/refresh")) {
          refreshCount += 1;
          if (refreshCount > 1) {
            return Response.json(
              { code: "REFRESH_REVOKED" },
              { status: terminalStatus },
            );
          }
          return Response.json({
            accessToken: "access-mobile-terminal-expiry-memory-only",
            accessExpiresAt: "2026-07-25T02:10:00.000Z",
            refreshCredential: "refresh-mobile-terminal-expiry-rotated-0001",
            refreshExpiresAt: "2026-08-20T00:00:00.000Z",
          });
        }
        if (url.includes("/api/v1/mobile/runs?")) return Response.json([]);
        if (url.endsWith("/api/v1/mobile/commands")) {
          return Response.json({ code: "ACCESS_TOKEN_EXPIRED" }, { status: 401 });
        }
        throw new Error(`unexpected request ${url}`);
      }),
    });

    await runtime.connect();
    await expect(runtime.execute(MobileCommandEnvelopeSchema.parse({
      projectId: "prj_mobile00001",
      runId: "run_mobile00001",
      stepRunId: "spr_mobile00001",
      expectedVersion: 2,
      idempotencyKey: "mobile-terminal-expiry-command-0001",
      action: "pause_run",
      payload: {},
    }))).rejects.toThrow("PAIRING_REQUIRED");
    expect(runtime.snapshot()).toEqual({ state: "unpaired" });
    expect(vault.snapshot()).toEqual({ state: "unpaired" });
    },
  );

  it("preserves pairing when a refreshed business command is forbidden", async () => {
    const indexedDB = new IDBFactory();
    const keys = new DeviceKeyStore({
      indexedDB,
      crypto: webcrypto as unknown as Crypto,
    });
    const identity = await keys.createIdentity();
    const vault = new CredentialVault({ indexedDB, keys });
    await vault.bind({
      keyId: identity.keyId,
      refreshCredential: "refresh-mobile-business-forbidden-initial-000001",
    });
    const runtime = new MobileRuntime({
      apiOrigin: "https://remote.hunter",
      projectIds: [ProjectIdSchema.parse("prj_mobile00001")],
      vault,
      keys,
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/v1/mobile/refresh")) {
          return Response.json({
            accessToken: "access-mobile-business-forbidden-memory",
            accessExpiresAt: "2026-07-25T02:10:00.000Z",
            refreshCredential: "refresh-mobile-business-forbidden-rotated-0001",
            refreshExpiresAt: "2026-08-20T00:00:00.000Z",
          });
        }
        if (url.includes("/api/v1/mobile/runs?")) return Response.json([]);
        if (url.endsWith("/api/v1/mobile/commands")) {
          return Response.json({ code: "DEVICE_GATE_FORBIDDEN" }, { status: 403 });
        }
        throw new Error(`unexpected request ${url}`);
      }),
    });
    const command = MobileCommandEnvelopeSchema.parse({
      projectId: "prj_mobile00001",
      runId: "run_mobile00001",
      gateId: "gat_mobile00001",
      expectedVersion: 2,
      idempotencyKey: "mobile-business-forbidden-command-0001",
      action: "approve_gate",
      payload: {},
    });

    await runtime.connect();
    await expect(runtime.execute(command)).rejects.toThrow(
      "MOBILE_REQUEST_FAILED_403",
    );
    expect(runtime.snapshot()).toEqual({ state: "connected", runs: [] });
    expect(vault.snapshot().state).toBe("paired");
  });

  it("keeps a retention-gap cursor until snapshot resync succeeds and exposes a timed offline cache", async () => {
    const indexedDB = new IDBFactory();
    const keys = new DeviceKeyStore({
      indexedDB,
      crypto: webcrypto as unknown as Crypto,
    });
    const identity = await keys.createIdentity();
    const vault = new CredentialVault({ indexedDB, keys });
    await vault.bind({
      keyId: identity.keyId,
      refreshCredential: "refresh-mobile-resync-initial-000001",
    });
    const projection = MobileRunProjectionSchema.parse({
      projectId: "prj_mobile00001",
      runId: "run_mobile00001",
      projectName: "Resync project",
      currentStep: "verify",
      attention: "Run is running",
      connection: "online",
      commands: [],
    });
    const refreshed = MobileRunProjectionSchema.parse({
      ...projection,
      attention: "Run needs attention",
    });
    let now = new Date("2026-07-25T01:00:00.000Z");
    let projectionReads = 0;
    const eventUrls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/v1/mobile/refresh")) {
        return Response.json({
          accessToken: "access-mobile-resync-memory-only",
          accessExpiresAt: "2026-07-25T01:05:00.000Z",
          refreshCredential: "refresh-mobile-resync-rotated-000001",
          refreshExpiresAt: "2026-08-20T00:00:00.000Z",
        });
      }
      if (url.includes("/api/v1/mobile/runs?")) {
        projectionReads += 1;
        if (projectionReads === 2) throw new TypeError("network unavailable");
        return Response.json([projectionReads === 1 ? projection : refreshed]);
      }
      if (url.includes("/api/v1/mobile/events?")) {
        eventUrls.push(url);
        if (url.includes("cursor=12")) return new Response("");
        return Response.json({
          status: "resync_required",
          code: "EVENT_CURSOR_GAP",
          retentionFloor: 5,
          highWaterPosition: 12,
          instructions: {
            snapshot: "reload_snapshot",
            rebuild: "replace_projection_from_snapshot",
            resume: "subscribe_after_high_water_position",
          },
        }, { status: 409 });
      }
      throw new Error(`unexpected request ${url}`);
    });
    let nonce = 0;
    const runtime = new MobileRuntime({
      apiOrigin: "https://remote.hunter",
      projectIds: [projection.projectId],
      vault,
      keys,
      fetch: fetchImpl,
      now: () => now,
      nonce: () => `resync-runtime-nonce-${++nonce}`,
    });

    await expect(runtime.connect()).resolves.toEqual({
      state: "connected",
      runs: [projection],
    });
    now = new Date("2026-07-25T01:01:00.000Z");
    await expect(runtime.pollEvents()).resolves.toEqual({
      state: "connected",
      runs: [{
        ...projection,
        connection: "offline",
        cachedAt: "2026-07-25T01:00:00.000Z",
      }],
    });
    await expect(runtime.pollEvents()).resolves.toEqual({
      state: "connected",
      runs: [refreshed],
    });
    await runtime.pollEvents();

    expect(eventUrls[0]).toContain("cursor=0");
    expect(eventUrls[1]).toContain("cursor=0");
    expect(eventUrls[2]).toContain("cursor=12");
  });

  it("bootstraps a non-exportable device key and binds delivered credentials locally", async () => {
    const indexedDB = new IDBFactory();
    const keys = new DeviceKeyStore({
      indexedDB,
      crypto: webcrypto as unknown as Crypto,
    });
    const vault = new CredentialVault({ indexedDB, keys });
    const projection = MobileRunProjectionSchema.parse({
      projectId: "prj_mobile00001",
      runId: "run_mobile00001",
      projectName: "Paired project",
      currentStep: "agent",
      attention: "Run is active",
      connection: "online",
      commands: [],
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.endsWith("/submit")) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body).toMatchObject({
          challenge: "pairing-challenge-mobile-runtime-000000000001",
          deviceName: "My phone",
          publicJwk: expect.objectContaining({ kty: "EC", crv: "P-256" }),
          proof: expect.any(String),
        });
        return Response.json({
          status: "pending_desktop_confirmation",
          pairingId: "pair_0123456789abcdef01234567",
          expiresAt: "2026-07-24T00:05:00.000Z",
        });
      }
      if (url.endsWith("/complete")) {
        expect(JSON.parse(String(init.body))).toMatchObject({
          challenge: "pairing-challenge-mobile-runtime-000000000001",
          timestamp: "2026-07-24T00:00:00.000Z",
          nonce: "pairing-runtime-nonce-1",
          proof: expect.any(String),
        });
        return Response.json({
          accessToken: "access-pairing-runtime-memory-only",
          accessExpiresAt: "2026-07-24T00:05:00.000Z",
          refreshCredential: "refresh-pairing-runtime-persisted-0001",
          refreshExpiresAt: "2026-08-20T00:00:00.000Z",
        });
      }
      if (url.includes("/api/v1/mobile/runs?")) return Response.json([projection]);
      throw new Error(`unexpected request ${url}`);
    });
    let nonce = 0;
    const runtime = new MobileRuntime({
      apiOrigin: "https://remote.hunter",
      projectIds: [ProjectIdSchema.parse("prj_mobile00001")],
      vault,
      keys,
      fetch: fetchImpl,
      now: () => new Date("2026-07-24T00:00:00.000Z"),
      nonce: () => `pairing-runtime-nonce-${++nonce}`,
    });
    const descriptor = {
      pairingId: "pair_0123456789abcdef01234567",
      challenge: "pairing-challenge-mobile-runtime-000000000001",
    };

    const pending = await runtime.beginPairing({
      ...descriptor,
      deviceName: "My phone",
    });
    await expect(runtime.completePairing({
      ...descriptor,
      keyId: pending.keyId,
    })).resolves.toEqual({ state: "connected", runs: [projection] });
    expect(vault.snapshot()).toMatchObject({ state: "paired", keyId: pending.keyId });
    expect(JSON.stringify(runtime.snapshot())).not.toContain("access-pairing");
    expect(JSON.stringify(runtime.snapshot())).not.toContain("refresh-pairing");
  });
});
