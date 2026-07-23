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
      currentStep: "agent:planning-agent",
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
      currentStep: "agent:planning-agent",
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
