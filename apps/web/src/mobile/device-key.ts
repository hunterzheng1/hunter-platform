export const DEVICE_VAULT_DB_NAME = "hunter-device-vault";
export const DEVICE_VAULT_VERSION = 3;

interface DeviceKeyRecord {
  readonly keyId: string;
  readonly privateKey: CryptoKey;
  readonly publicJwk: JsonWebKey;
  readonly createdAt: string;
}

export interface PublicDeviceIdentity {
  readonly keyId: string;
  readonly publicJwk: JsonWebKey;
}

export interface DeviceKeyStoreOptions {
  readonly indexedDB: IDBFactory;
  readonly crypto: Crypto;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
    transaction.oncomplete = () => resolve();
  });
}

export function openDeviceVault(indexedDB: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DEVICE_VAULT_DB_NAME, DEVICE_VAULT_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("device-keys")) {
        database.createObjectStore("device-keys", { keyPath: "keyId" });
      }
      if (!database.objectStoreNames.contains("credentials")) {
        database.createObjectStore("credentials", { keyPath: "slot" });
      }
      if (!database.objectStoreNames.contains("command-outbox")) {
        database.createObjectStore("command-outbox", { keyPath: "idempotencyKey" });
      }
      if (!database.objectStoreNames.contains("coordination")) {
        database.createObjectStore("coordination", { keyPath: "slot" });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

export class DeviceKeyStore {
  public constructor(private readonly options: DeviceKeyStoreOptions) {}

  public async createIdentity(): Promise<PublicDeviceIdentity> {
    const pair = (await this.options.crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const publicJwk = await this.options.crypto.subtle.exportKey("jwk", pair.publicKey);
    const record: DeviceKeyRecord = {
      keyId: `key_${this.options.crypto.randomUUID()}`,
      privateKey: pair.privateKey,
      publicJwk,
      createdAt: new Date().toISOString(),
    };
    const database = await openDeviceVault(this.options.indexedDB);
    try {
      const transaction = database.transaction("device-keys", "readwrite");
      transaction.objectStore("device-keys").add(record);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
    return { keyId: record.keyId, publicJwk };
  }

  public async has(keyId: string): Promise<boolean> {
    return (await this.get(keyId)) !== undefined;
  }

  public async sign(keyId: string, message: string): Promise<string> {
    const record = await this.get(keyId);
    if (record === undefined) throw new Error("DEVICE_KEY_MISSING");
    const signature = await this.options.crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      record.privateKey,
      new TextEncoder().encode(message),
    );
    return bytesToBase64Url(new Uint8Array(signature));
  }

  public async delete(keyId: string): Promise<void> {
    const database = await openDeviceVault(this.options.indexedDB);
    try {
      const transaction = database.transaction("device-keys", "readwrite");
      transaction.objectStore("device-keys").delete(keyId);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  public async digestHex(value: string): Promise<string> {
    const digest = await this.options.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    );
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  private async get(keyId: string): Promise<DeviceKeyRecord | undefined> {
    const database = await openDeviceVault(this.options.indexedDB);
    try {
      const transaction = database.transaction("device-keys", "readonly");
      const result = await requestResult(
        transaction.objectStore("device-keys").get(keyId),
      );
      await transactionDone(transaction);
      return result as DeviceKeyRecord | undefined;
    } finally {
      database.close();
    }
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
