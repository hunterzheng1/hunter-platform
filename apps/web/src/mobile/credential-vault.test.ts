// @vitest-environment jsdom
import { webcrypto } from "node:crypto";

import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEVICE_VAULT_DB_NAME,
  DEVICE_VAULT_VERSION,
  DeviceKeyStore,
} from "./device-key.js";
import { CredentialVault } from "./credential-vault.js";

function openDatabase(indexedDB: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DEVICE_VAULT_DB_NAME, DEVICE_VAULT_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function getRecord(
  indexedDB: IDBFactory,
  storeName: string,
  key: IDBValidKey,
): Promise<unknown> {
  return openDatabase(indexedDB).then(
    (database) =>
      new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, "readonly");
        const request = transaction.objectStore(storeName).get(key);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        transaction.oncomplete = () => database.close();
      }),
  );
}

function deleteRecord(
  indexedDB: IDBFactory,
  storeName: string,
  key: IDBValidKey,
): Promise<void> {
  return openDatabase(indexedDB).then(
    (database) =>
      new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, "readwrite");
        transaction.objectStore(storeName).delete(key);
        transaction.onerror = () => reject(transaction.error);
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
      }),
  );
}

describe("origin-scoped device credential vault", () => {
  let indexedDB = new IDBFactory();

  afterEach(() => {
    indexedDB = new IDBFactory();
  });

  it("persists a non-exportable P-256 private CryptoKey and returns only the public JWK", async () => {
    const keys = new DeviceKeyStore({
      indexedDB,
      crypto: webcrypto as unknown as Crypto,
    });
    const identity = await keys.createIdentity();

    expect(identity.publicJwk).toMatchObject({ kty: "EC", crv: "P-256" });
    expect(identity.publicJwk.d).toBeUndefined();
    expect(JSON.stringify(identity)).not.toContain("privateKey");

    const record = (await getRecord(indexedDB, "device-keys", identity.keyId)) as {
      privateKey: CryptoKey;
    };
    expect(record.privateKey.type).toBe("private");
    expect(record.privateKey.extractable).toBe(false);
    await expect(
      webcrypto.subtle.exportKey("jwk", record.privateKey as unknown as webcrypto.CryptoKey),
    ).rejects.toThrow();
  });

  it("keeps refresh credentials out of snapshots and atomically replaces them after transport success", async () => {
    const keys = new DeviceKeyStore({
      indexedDB,
      crypto: webcrypto as unknown as Crypto,
    });
    const identity = await keys.createIdentity();
    const vault = new CredentialVault({ indexedDB, keys });
    await vault.bind({
      keyId: identity.keyId,
      refreshCredential: "refresh-initial-credential-0000000001",
    });

    expect(vault.snapshot()).toEqual({ state: "paired", keyId: identity.keyId });
    expect(JSON.stringify(vault.snapshot())).not.toContain("refresh-initial");

    let transmitted: unknown;
    const session = await vault.rotate({
      timestamp: "2026-07-24T00:00:00.000Z",
      nonce: "vault-refresh-0001",
      transport: async (request) => {
        transmitted = request;
        return {
          accessToken: "access-token-kept-outside-vault-snapshot",
          accessExpiresAt: "2026-07-24T00:05:00.000Z",
          refreshCredential: "refresh-rotated-credential-0000000002",
        };
      },
    });
    expect(session).toEqual({
      accessToken: "access-token-kept-outside-vault-snapshot",
      accessExpiresAt: "2026-07-24T00:05:00.000Z",
    });
    expect(session).not.toHaveProperty("refreshCredential");
    expect(transmitted).toMatchObject({
      refreshCredential: "refresh-initial-credential-0000000001",
      timestamp: "2026-07-24T00:00:00.000Z",
      nonce: "vault-refresh-0001",
    });
    expect((transmitted as { proof: string }).proof.length).toBeGreaterThan(40);

    const stored = (await getRecord(indexedDB, "credentials", "active")) as {
      refreshCredential: string;
    };
    expect(stored.refreshCredential).toBe("refresh-rotated-credential-0000000002");
    expect(JSON.stringify(vault.snapshot())).not.toContain(stored.refreshCredential);
  });

  it("wipes credentials and keys on logout and requires re-pairing after key loss", async () => {
    const keys = new DeviceKeyStore({
      indexedDB,
      crypto: webcrypto as unknown as Crypto,
    });
    const identity = await keys.createIdentity();
    const vault = new CredentialVault({ indexedDB, keys });
    await vault.bind({
      keyId: identity.keyId,
      refreshCredential: "refresh-credential-for-wipe-00000001",
    });

    await deleteRecord(indexedDB, "device-keys", identity.keyId);
    await expect(
      vault.rotate({
        timestamp: "2026-07-24T00:00:00.000Z",
        nonce: "lost-key-refresh-0001",
        transport: async () => {
          throw new Error("transport must not run");
        },
      }),
    ).rejects.toThrow("PAIRING_REQUIRED");
    expect(await getRecord(indexedDB, "credentials", "active")).toBeUndefined();
    expect(vault.snapshot()).toEqual({ state: "unpaired" });

    const replacement = await keys.createIdentity();
    await vault.bind({
      keyId: replacement.keyId,
      refreshCredential: "refresh-credential-for-logout-00001",
    });
    await vault.logout();
    expect(await getRecord(indexedDB, "credentials", "active")).toBeUndefined();
    expect(await getRecord(indexedDB, "device-keys", replacement.keyId)).toBeUndefined();
    expect(vault.snapshot()).toEqual({ state: "unpaired" });
  });

  it("restores paired state after a page reload without exposing the stored credential", async () => {
    const keys = new DeviceKeyStore({
      indexedDB,
      crypto: webcrypto as unknown as Crypto,
    });
    const identity = await keys.createIdentity();
    const first = new CredentialVault({ indexedDB, keys });
    await first.bind({
      keyId: identity.keyId,
      refreshCredential: "refresh-credential-for-reload-000001",
    });

    const reloaded = new CredentialVault({ indexedDB, keys });
    expect(reloaded.snapshot()).toEqual({ state: "unpaired" });
    await expect(reloaded.restore()).resolves.toEqual({
      state: "paired",
      keyId: identity.keyId,
    });
    expect(JSON.stringify(reloaded.snapshot())).not.toContain("refresh-credential");
  });

  it("allows only one origin-wide refresh rotation across independent vault instances", async () => {
    const keys = new DeviceKeyStore({
      indexedDB,
      crypto: webcrypto as unknown as Crypto,
    });
    const identity = await keys.createIdentity();
    const firstVault = new CredentialVault({ indexedDB, keys });
    const secondVault = new CredentialVault({ indexedDB, keys });
    await firstVault.bind({
      keyId: identity.keyId,
      refreshCredential: "refresh-credential-for-singleflight-01",
    });
    await secondVault.restore();
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transportEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const transport = async () => {
      entered?.();
      await blocked;
      return { refreshCredential: "refresh-credential-after-singleflight-1" };
    };
    const first = firstVault.rotate({
      timestamp: "2026-07-24T00:00:00.000Z",
      nonce: "singleflight-refresh-0001",
      transport,
    });
    await transportEntered;
    const second = secondVault.rotate({
      timestamp: "2026-07-24T00:00:00.000Z",
      nonce: "singleflight-refresh-0002",
      transport,
    });
    await expect(second).rejects.toThrow("REFRESH_ROTATION_IN_PROGRESS");
    release?.();
    await first;
  });

  it("rejects rebinding while paired so an old server identity and key cannot be orphaned", async () => {
    const keys = new DeviceKeyStore({
      indexedDB,
      crypto: webcrypto as unknown as Crypto,
    });
    const firstIdentity = await keys.createIdentity();
    const replacement = await keys.createIdentity();
    const vault = new CredentialVault({ indexedDB, keys });
    await vault.bind({
      keyId: firstIdentity.keyId,
      refreshCredential: "refresh-credential-first-binding-0001",
    });

    await expect(vault.bind({
      keyId: replacement.keyId,
      refreshCredential: "refresh-credential-replacement-00001",
    })).rejects.toThrow("DEVICE_ALREADY_PAIRED");

    expect(vault.snapshot()).toEqual({ state: "paired", keyId: firstIdentity.keyId });
    const stored = (await getRecord(indexedDB, "credentials", "active")) as {
      keyId: string;
      refreshCredential: string;
    };
    expect(stored).toMatchObject({
      keyId: firstIdentity.keyId,
      refreshCredential: "refresh-credential-first-binding-0001",
    });
  });
});
