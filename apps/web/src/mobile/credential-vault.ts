import { DeviceKeyStore, openDeviceVault } from "./device-key.js";

interface CredentialRecord {
  readonly slot: "active";
  readonly keyId: string;
  readonly refreshCredential: string;
  readonly updatedAt: string;
}

interface RotationLeaseRecord {
  readonly slot: "refresh-rotation";
  readonly ownerId: string;
  readonly expiresAt: number;
}

export type CredentialVaultSnapshot =
  | { readonly state: "unpaired" }
  | { readonly state: "paired"; readonly keyId: string };

export interface CredentialVaultOptions {
  readonly indexedDB: IDBFactory;
  readonly keys: DeviceKeyStore;
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

export class CredentialVault {
  private current: CredentialVaultSnapshot = { state: "unpaired" };

  public constructor(private readonly options: CredentialVaultOptions) {}

  public snapshot(): CredentialVaultSnapshot {
    return this.current;
  }

  public async restore(): Promise<CredentialVaultSnapshot> {
    const credential = await this.get();
    if (credential === undefined) {
      this.current = { state: "unpaired" };
      return this.current;
    }
    if (!(await this.options.keys.has(credential.keyId))) {
      await this.deleteCredential();
      this.current = { state: "unpaired" };
      return this.current;
    }
    this.current = { state: "paired", keyId: credential.keyId };
    return this.current;
  }

  public async bind(input: {
    readonly keyId: string;
    readonly refreshCredential: string;
  }): Promise<void> {
    if (!(await this.options.keys.has(input.keyId))) throw new Error("DEVICE_KEY_MISSING");
    if ((await this.get()) !== undefined) throw new Error("DEVICE_ALREADY_PAIRED");
    if (input.refreshCredential.length < 32 || input.refreshCredential.length > 200) {
      throw new Error("REFRESH_CREDENTIAL_INVALID");
    }
    await this.put({
      slot: "active",
      keyId: input.keyId,
      refreshCredential: input.refreshCredential,
      updatedAt: new Date().toISOString(),
    });
    this.current = { state: "paired", keyId: input.keyId };
  }

  public async rotate<T extends { readonly refreshCredential: string }>(input: {
    readonly timestamp: string;
    readonly nonce: string;
    readonly transport: (request: {
      readonly refreshCredential: string;
      readonly timestamp: string;
      readonly nonce: string;
      readonly proof: string;
    }) => Promise<T>;
  }): Promise<Omit<T, "refreshCredential">> {
    const ownerId = `rotation_${globalThis.crypto.randomUUID()}`;
    await this.acquireRotationLease(ownerId);
    try {
      const credential = await this.get();
      if (credential === undefined) {
        this.current = { state: "unpaired" };
        throw new Error("PAIRING_REQUIRED");
      }
      let proof: string;
      try {
        const message = [
          "hunter-refresh-proof-v1",
          await this.options.keys.digestHex(credential.refreshCredential),
          input.timestamp,
          input.nonce,
        ].join("\n");
        proof = await this.options.keys.sign(credential.keyId, message);
      } catch (error) {
        if (error instanceof Error && error.message === "DEVICE_KEY_MISSING") {
          await this.deleteCredential();
          this.current = { state: "unpaired" };
          throw new Error("PAIRING_REQUIRED");
        }
        throw error;
      }
      const rotated = await input.transport({
        refreshCredential: credential.refreshCredential,
        timestamp: input.timestamp,
        nonce: input.nonce,
        proof,
      });
      if (rotated.refreshCredential.length < 32 || rotated.refreshCredential.length > 200) {
        throw new Error("REFRESH_CREDENTIAL_INVALID");
      }
      await this.put({
        ...credential,
        refreshCredential: rotated.refreshCredential,
        updatedAt: new Date().toISOString(),
      });
      const { refreshCredential: _storedCredential, ...session } = rotated;
      void _storedCredential;
      return session;
    } finally {
      await this.releaseRotationLease(ownerId);
    }
  }

  public async logout(): Promise<void> {
    const credential = await this.get();
    await this.deleteCredential();
    if (credential !== undefined) await this.options.keys.delete(credential.keyId);
    this.current = { state: "unpaired" };
  }

  public async revoke(): Promise<void> {
    await this.logout();
  }

  private async get(): Promise<CredentialRecord | undefined> {
    const database = await openDeviceVault(this.options.indexedDB);
    try {
      const transaction = database.transaction("credentials", "readonly");
      const result = await requestResult(
        transaction.objectStore("credentials").get("active"),
      );
      await transactionDone(transaction);
      return result as CredentialRecord | undefined;
    } finally {
      database.close();
    }
  }

  private async put(record: CredentialRecord): Promise<void> {
    const database = await openDeviceVault(this.options.indexedDB);
    try {
      const transaction = database.transaction("credentials", "readwrite");
      transaction.objectStore("credentials").put(record);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  private async deleteCredential(): Promise<void> {
    const database = await openDeviceVault(this.options.indexedDB);
    try {
      const transaction = database.transaction("credentials", "readwrite");
      transaction.objectStore("credentials").delete("active");
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  private async acquireRotationLease(ownerId: string): Promise<void> {
    const database = await openDeviceVault(this.options.indexedDB);
    try {
      const transaction = database.transaction("coordination", "readwrite");
      const store = transaction.objectStore("coordination");
      const existing = await requestResult(
        store.get("refresh-rotation"),
      ) as RotationLeaseRecord | undefined;
      const now = Date.now();
      if (existing !== undefined && existing.expiresAt > now) {
        await transactionDone(transaction);
        throw new Error("REFRESH_ROTATION_IN_PROGRESS");
      }
      store.put({
        slot: "refresh-rotation",
        ownerId,
        expiresAt: now + 120_000,
      } satisfies RotationLeaseRecord);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  private async releaseRotationLease(ownerId: string): Promise<void> {
    const database = await openDeviceVault(this.options.indexedDB);
    try {
      const transaction = database.transaction("coordination", "readwrite");
      const store = transaction.objectStore("coordination");
      const existing = await requestResult(
        store.get("refresh-rotation"),
      ) as RotationLeaseRecord | undefined;
      if (existing?.ownerId === ownerId) store.delete("refresh-rotation");
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }
}
