import { DatabaseSync } from "node:sqlite";
import { generateKeyPairSync, sign, type JsonWebKey } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SqliteOperationJournal } from "@hunter/storage";
import { afterEach, describe, expect, it } from "vitest";

import { DeviceStore } from "./device-store.js";
import {
  PairingService,
  createPairingCompletionProofMessage,
} from "./pairing-service.js";
import {
  TokenService,
  createDeviceProofMessage,
  createRefreshProofMessage,
} from "./token-service.js";

const desktopPrincipal = {
  kind: "authenticated_desktop" as const,
  principalId: "desktop-owner",
};
const projectId = "prj_mobile00001" as const;

function deviceKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    publicJwk: publicKey.export({ format: "jwk" }) as JsonWebKey,
    signMessage(message: string) {
      return sign(
        "sha256",
        Buffer.from(message, "utf8"),
        { key: privateKey, dsaEncoding: "ieee-p1363" },
      ).toString("base64url");
    },
    prove(pairingId: string, challenge: string) {
      return sign(
        "sha256",
        Buffer.from(`hunter-pairing-v1\n${pairingId}\n${challenge}`, "utf8"),
        { key: privateKey, dsaEncoding: "ieee-p1363" },
      ).toString("base64url");
    },
  };
}

describe("persistent device security schema", () => {
  let database: DatabaseSync | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  it("creates persistent pairing, device, and refresh-family records without raw credential columns", () => {
    database = new DatabaseSync(":memory:");
    new SqliteOperationJournal(database);

    const tables = database
      .prepare(
        `SELECT name
           FROM sqlite_master
          WHERE type = 'table'
            AND name IN ('pairing_challenges', 'devices', 'refresh_families')
          ORDER BY name`,
      )
      .all()
      .map((row) => String((row as { name: unknown }).name));

    expect(tables).toEqual(["devices", "pairing_challenges", "refresh_families"]);

    const columns = tables.flatMap((table) =>
      database!
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => String((row as { name: unknown }).name)),
    );
    expect(columns).toContain("challenge_hash");
    expect(columns).toContain("refresh_hash");
    expect(columns).not.toEqual(
      expect.arrayContaining(["challenge", "access_token", "refresh_token", "private_key", "signing_key"]),
    );
  });
});

describe("persistent pairing", () => {
  const directories: string[] = [];
  let database: DatabaseSync | undefined;
  let now = new Date("2026-07-24T00:00:00.000Z");

  afterEach(() => {
    database?.close();
    database = undefined;
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
    now = new Date("2026-07-24T00:00:00.000Z");
  });

  function open(path = ":memory:") {
    database = new DatabaseSync(path);
    new SqliteOperationJournal(database);
    return new PairingService({
      store: new DeviceStore(database),
      now: () => now,
    });
  }

  it("creates a five-minute challenge only for an authenticated desktop action", () => {
    const service = open();

    expect(() =>
      service.createChallenge({
        kind: "remote_device",
        principalId: "not-desktop",
      } as never),
    ).toThrowError("DESKTOP_PAIRING_AUTH_REQUIRED");

    const challenge = service.createChallenge(desktopPrincipal);
    expect(challenge.expiresAt).toBe("2026-07-24T00:05:00.000Z");

    const row = database!
      .prepare("SELECT challenge_hash, expires_at, consumed_at FROM pairing_challenges WHERE pairing_id = ?")
      .get(challenge.pairingId) as {
      challenge_hash: string;
      expires_at: string;
      consumed_at: string | null;
    };
    expect(row.challenge_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(row.challenge_hash).not.toContain(challenge.challenge);
    expect(row).toMatchObject({ expires_at: challenge.expiresAt, consumed_at: null });
  });

  it("survives restart, verifies the P-256 proof, and consumes a challenge only once", () => {
    const directory = mkdtempSync(join(tmpdir(), "hunter-device-security-"));
    directories.push(directory);
    const path = join(directory, "hunter.sqlite");
    const first = open(path);
    const challenge = first.createChallenge(desktopPrincipal);
    database!.close();
    database = undefined;

    const second = open(path);
    const key = deviceKey();
    const issued = second.confirmPairing({
      desktopPrincipal,
      pairingId: challenge.pairingId,
      challenge: challenge.challenge,
      publicJwk: key.publicJwk,
      proof: key.prove(challenge.pairingId, challenge.challenge),
      deviceName: "Hunter Pocket",
      scopes: ["runs:read", "gates:approve"],
      projectIds: [projectId],
      deviceExpiresAt: "2026-08-20T00:00:00.000Z",
    });

    expect(issued).toMatchObject({
      displayName: "Hunter Pocket",
      scopes: ["runs:read", "gates:approve"],
      projectIds: [projectId],
      version: 1,
    });
    expect(() =>
      second.confirmPairing({
        desktopPrincipal,
        pairingId: challenge.pairingId,
        challenge: challenge.challenge,
        publicJwk: key.publicJwk,
        proof: key.prove(challenge.pairingId, challenge.challenge),
        deviceName: "Replay",
        scopes: ["runs:read"],
        projectIds: [projectId],
        deviceExpiresAt: "2026-08-20T00:00:00.000Z",
      }),
    ).toThrowError("PAIRING_CHALLENGE_CONSUMED");
  });

  it("rejects an invalid proof and treats the exact five-minute boundary as expired", () => {
    const service = open();
    const challenge = service.createChallenge(desktopPrincipal);
    const key = deviceKey();

    expect(() =>
      service.confirmPairing({
        desktopPrincipal,
        pairingId: challenge.pairingId,
        challenge: challenge.challenge,
        publicJwk: key.publicJwk,
        proof: "invalid-proof",
        deviceName: "Hunter Pocket",
        scopes: ["runs:read"],
        projectIds: [projectId],
        deviceExpiresAt: "2026-08-20T00:00:00.000Z",
      }),
    ).toThrowError("PAIRING_PROOF_INVALID");

    now = new Date(challenge.expiresAt);
    expect(() =>
      service.confirmPairing({
        desktopPrincipal,
        pairingId: challenge.pairingId,
        challenge: challenge.challenge,
        publicJwk: key.publicJwk,
        proof: key.prove(challenge.pairingId, challenge.challenge),
        deviceName: "Hunter Pocket",
        scopes: ["runs:read"],
        projectIds: [projectId],
        deviceExpiresAt: "2026-08-20T00:00:00.000Z",
      }),
    ).toThrowError("PAIRING_CHALLENGE_EXPIRED");
  });

  it("stages a device proof, requires desktop confirmation, and claims credential delivery once", () => {
    const service = open();
    const challenge = service.createChallenge(desktopPrincipal);
    const key = deviceKey();

    const submission = {
      pairingId: challenge.pairingId,
      challenge: challenge.challenge,
      publicJwk: key.publicJwk,
      proof: key.prove(challenge.pairingId, challenge.challenge),
      deviceName: "Hunter Pocket",
    };
    expect(service.submitPairing(submission)).toEqual({
      status: "pending_desktop_confirmation",
      pairingId: challenge.pairingId,
      expiresAt: challenge.expiresAt,
    });
    expect(service.submitPairing(submission)).toEqual({
      status: "pending_desktop_confirmation",
      pairingId: challenge.pairingId,
      expiresAt: challenge.expiresAt,
    });
    expect(() => service.confirmSubmittedPairing({
      desktopPrincipal: {
        kind: "authenticated_desktop",
        principalId: "different-desktop",
      },
      pairingId: challenge.pairingId,
      scopes: ["runs:read"],
      projectIds: [projectId],
      deviceExpiresAt: "2026-08-20T00:00:00.000Z",
    })).toThrowError("PAIRING_DESKTOP_PRINCIPAL_MISMATCH");
    const device = service.confirmSubmittedPairing({
      desktopPrincipal,
      pairingId: challenge.pairingId,
      scopes: ["runs:read", "runs:control"],
      projectIds: [projectId],
      deviceExpiresAt: "2026-08-20T00:00:00.000Z",
    });
    expect(device.displayName).toBe("Hunter Pocket");

    const timestamp = now.toISOString();
    const nonce = "pairing-completion-nonce-0001";
    const proof = key.signMessage(createPairingCompletionProofMessage({
      pairingId: challenge.pairingId,
      challenge: challenge.challenge,
      timestamp,
      nonce,
    }));
    const delivery = {
      pairingId: challenge.pairingId,
      challenge: challenge.challenge,
      timestamp,
      nonce,
      proof,
    };
    expect(() => service.deliverCredentials(delivery, () => {
      throw new Error("fault injected before credential commit");
    })).toThrowError("fault injected before credential commit");
    expect(service.claimCredentialDelivery(delivery)).toMatchObject({
      deviceId: device.deviceId,
    });
    expect(() => service.claimCredentialDelivery({
      pairingId: challenge.pairingId,
      challenge: challenge.challenge,
      timestamp,
      nonce: "pairing-completion-nonce-0002",
      proof: key.signMessage(createPairingCompletionProofMessage({
        pairingId: challenge.pairingId,
        challenge: challenge.challenge,
        timestamp,
        nonce: "pairing-completion-nonce-0002",
      })),
    })).toThrowError("PAIRING_CREDENTIALS_DELIVERED");
  });
});

describe("device-bound access tokens", () => {
  let database: DatabaseSync | undefined;
  let now = new Date("2026-07-24T00:00:00.000Z");

  afterEach(() => {
    database?.close();
    database = undefined;
    now = new Date("2026-07-24T00:00:00.000Z");
  });

  async function setup() {
    database = new DatabaseSync(":memory:");
    new SqliteOperationJournal(database);
    const store = new DeviceStore(database);
    const pairing = new PairingService({ store, now: () => now });
    const challenge = pairing.createChallenge(desktopPrincipal);
    const key = deviceKey();
    const device = pairing.confirmPairing({
      desktopPrincipal,
      pairingId: challenge.pairingId,
      challenge: challenge.challenge,
      publicJwk: key.publicJwk,
      proof: key.prove(challenge.pairingId, challenge.challenge),
      deviceName: "Hunter Pocket",
      scopes: ["runs:read", "gates:approve"],
      projectIds: [projectId],
      deviceExpiresAt: "2026-08-20T00:00:00.000Z",
    });
    const resolvedRefs: string[] = [];
    const tokens = await TokenService.create({
      store,
      issuer: "https://hunter.local/device",
      audience: "hunter-mobile",
      signingSecretRef: "os-credential://hunter/device-signing",
      secretStore: {
        resolveSecret: async (reference) => {
          resolvedRefs.push(reference);
          return "test-only-device-signing-material-32-bytes";
        },
      },
      now: () => now,
    });
    return { store, tokens, device, key, resolvedRefs };
  }

  it("rejects a non-HTTPS token issuer before resolving signing material", async () => {
    database = new DatabaseSync(":memory:");
    new SqliteOperationJournal(database);
    let resolved = false;
    const resolveSecret = async () => {
      resolved = true;
      return "test-only-device-signing-material-32-bytes";
    };

    await expect(TokenService.create({
      store: new DeviceStore(database),
      issuer: "http://hunter.invalid/device",
      audience: "hunter-mobile",
      signingSecretRef: "os-credential://hunter/device-signing",
      secretStore: { resolveSecret },
    })).rejects.toThrowError("TOKEN_ISSUER_INVALID");
    expect(resolved).toBe(false);
  });

  it("issues a five-minute access token with complete constrained claims through a secret reference", async () => {
    const { tokens, device, resolvedRefs } = await setup();
    const issued = tokens.issue(device.deviceId);
    const claims = tokens.verifyAccessToken(issued.accessToken, {
      audience: "hunter-mobile",
      projectId,
    });

    expect(resolvedRefs).toEqual(["os-credential://hunter/device-signing"]);
    expect(issued.accessExpiresAt).toBe("2026-07-24T00:05:00.000Z");
    expect(issued.refreshExpiresAt).toBe("2026-08-20T00:00:00.000Z");
    expect(claims).toMatchObject({
      iss: "https://hunter.local/device",
      aud: "hunter-mobile",
      sub: device.deviceId,
      iat: 1_784_851_200,
      nbf: 1_784_851_200,
      exp: 1_784_851_500,
      scopes: ["runs:read", "gates:approve"],
      projectIds: [projectId],
      deviceVersion: 1,
      cnf: { jkt: device.publicKeyThumbprint },
    });
    expect(claims.jti).toMatch(/^jti_[a-f0-9]{24}$/u);

    const persisted = JSON.stringify(
      database!
        .prepare("SELECT refresh_hash, previous_refresh_hash FROM refresh_families")
        .all(),
    );
    expect(persisted).not.toContain(issued.accessToken);
    expect(persisted).not.toContain(issued.refreshCredential);
    expect(persisted).not.toContain("test-only-device-signing-material-32-bytes");
  });

  it("rejects exact-boundary expiry, wrong audience, cross-Project use, and a revoked device", async () => {
    const { tokens, store, device } = await setup();
    const issued = tokens.issue(device.deviceId);

    expect(() =>
      tokens.verifyAccessToken(issued.accessToken, {
        audience: "other-mobile",
        projectId,
      }),
    ).toThrowError("ACCESS_TOKEN_AUDIENCE_INVALID");
    expect(() =>
      tokens.verifyAccessToken(issued.accessToken, {
        audience: "hunter-mobile",
        projectId: "prj_mobile00002",
      }),
    ).toThrowError("ACCESS_TOKEN_PROJECT_FORBIDDEN");

    now = new Date("2026-07-24T00:05:00.000Z");
    expect(() =>
      tokens.verifyAccessToken(issued.accessToken, {
        audience: "hunter-mobile",
        projectId,
      }),
    ).toThrowError("ACCESS_TOKEN_EXPIRED");

    now = new Date("2026-07-24T00:01:00.000Z");
    store.revokeDevice(device.deviceId, now.toISOString());
    expect(() =>
      tokens.verifyAccessToken(issued.accessToken, {
        audience: "hunter-mobile",
        projectId,
      }),
    ).toThrowError("DEVICE_REVOKED");
  });

  it("rolls back the device version and every refresh family when revocation is interrupted", async () => {
    const { tokens, store, device } = await setup();
    tokens.issue(device.deviceId);
    database!.exec(`
      CREATE TEMP TRIGGER fail_refresh_family_revoke
      BEFORE UPDATE OF revoked_at ON refresh_families
      BEGIN
        SELECT RAISE(ABORT, 'fault injected after device update');
      END;
    `);

    expect(() =>
      store.revokeDevice(device.deviceId, "2026-07-24T00:01:00.000Z"),
    ).toThrow(/fault injected/u);

    expect(
      database!
        .prepare("SELECT version, revoked_at FROM devices WHERE device_id = ?")
        .get(device.deviceId),
    ).toEqual({ version: 1, revoked_at: null });
    expect(
      database!
        .prepare("SELECT revoked_at FROM refresh_families WHERE device_id = ?")
        .get(device.deviceId),
    ).toEqual({ revoked_at: null });
  });

  it("rotates refresh credentials and revokes the family when an old credential is reused", async () => {
    const { tokens, device, key } = await setup();
    const first = tokens.issue(device.deviceId);
    const timestamp = now.toISOString();
    const rotated = tokens.rotateRefresh({
      refreshCredential: first.refreshCredential,
      timestamp,
      nonce: "refresh-nonce-0001",
      proof: key.signMessage(
        createRefreshProofMessage({
          refreshCredential: first.refreshCredential,
          timestamp,
          nonce: "refresh-nonce-0001",
        }),
      ),
    });
    expect(rotated.refreshCredential).not.toBe(first.refreshCredential);

    expect(() =>
      tokens.rotateRefresh({
        refreshCredential: first.refreshCredential,
        timestamp,
        nonce: "refresh-nonce-0002",
        proof: key.signMessage(
          createRefreshProofMessage({
            refreshCredential: first.refreshCredential,
            timestamp,
            nonce: "refresh-nonce-0002",
          }),
        ),
      }),
    ).toThrowError("REFRESH_CREDENTIAL_REUSED");

    expect(() =>
      tokens.rotateRefresh({
        refreshCredential: rotated.refreshCredential,
        timestamp,
        nonce: "refresh-nonce-0003",
        proof: key.signMessage(
          createRefreshProofMessage({
            refreshCredential: rotated.refreshCredential,
            timestamp,
            nonce: "refresh-nonce-0003",
          }),
        ),
      }),
    ).toThrowError("REFRESH_FAMILY_REVOKED");
  });

  it("detects reuse of any prior refresh generation, not only the immediately previous one", async () => {
    const { tokens, device, key } = await setup();
    const timestamp = now.toISOString();
    const first = tokens.issue(device.deviceId);
    const rotate = (refreshCredential: string, nonce: string) =>
      tokens.rotateRefresh({
        refreshCredential,
        timestamp,
        nonce,
        proof: key.signMessage(
          createRefreshProofMessage({ refreshCredential, timestamp, nonce }),
        ),
      });
    const second = rotate(first.refreshCredential, "refresh-history-0001");
    const third = rotate(second.refreshCredential, "refresh-history-0002");

    expect(() =>
      rotate(first.refreshCredential, "refresh-history-replay-0003"),
    ).toThrowError("REFRESH_CREDENTIAL_REUSED");
    expect(() =>
      rotate(third.refreshCredential, "refresh-history-current-0004"),
    ).toThrowError("REFRESH_FAMILY_REVOKED");
  });

  it("rejects a copied refresh credential signed by another browser key", async () => {
    const { tokens, device, key } = await setup();
    const copiedKey = deviceKey();
    const first = tokens.issue(device.deviceId);
    const timestamp = now.toISOString();
    const input = {
      refreshCredential: first.refreshCredential,
      timestamp,
      nonce: "copied-refresh-0001",
    };

    expect(() =>
      tokens.rotateRefresh({
        ...input,
        proof: copiedKey.signMessage(createRefreshProofMessage(input)),
      }),
    ).toThrowError("DEVICE_PROOF_INVALID");

    expect(
      tokens.rotateRefresh({
        ...input,
        proof: key.signMessage(createRefreshProofMessage(input)),
      }).refreshCredential,
    ).not.toBe(first.refreshCredential);
  });

  it("requires a fresh device-key proof for every access-token request", async () => {
    const { tokens, device, key } = await setup();
    const copiedKey = deviceKey();
    const issued = tokens.issue(device.deviceId);
    const request = {
      accessToken: issued.accessToken,
      audience: "hunter-mobile",
      projectId,
      method: "POST",
      url: "/api/mobile/commands",
      body: { action: "pause_run" },
      timestamp: now.toISOString(),
      nonce: "request-nonce-0001",
    };
    const message = createDeviceProofMessage(request);

    expect(() =>
      tokens.verifyDeviceRequest({
        ...request,
        proof: copiedKey.signMessage(message),
      }),
    ).toThrowError("DEVICE_PROOF_INVALID");

    expect(
      tokens.verifyDeviceRequest({
        ...request,
        proof: key.signMessage(message),
      }).sub,
    ).toBe(device.deviceId);

    expect(() =>
      tokens.verifyDeviceRequest({
        ...request,
        proof: key.signMessage(message),
      }),
    ).toThrowError("DEVICE_PROOF_REPLAY");
  });
});
