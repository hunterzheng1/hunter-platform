import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { NpmPublishConfig } from "./config.js";
import { isNpmPublishConfigured } from "./config.js";
import type { NpmPublishingCredentialRecord } from "../repositories/interfaces.js";

const CIPHER = "aes-256-gcm";
const AAD = Buffer.from("hunter-platform/npm-publishing-credential/v1", "utf8");

export function decodeNpmCredentialEncryptionKey(value: string): Uint8Array {
  const key = Buffer.from(value.trim(), "base64");
  if (key.byteLength !== 32) {
    throw new Error("HUNTER_HARNESS_CREDENTIAL_KEY must decode to exactly 32 bytes");
  }
  return key;
}

export type NpmCredentialState = "not_configured" | "configured" | "ready" | "expired" | "invalid" | "locked";
export type NpmCredentialSource = "none" | "deployment" | "managed";

export interface NpmCredentialStatus {
  scope: string | null;
  source: NpmCredentialSource;
  state: NpmCredentialState;
  username: string | null;
  expires_at: string | null;
  last_verified_at: string | null;
  can_manage: boolean;
}

export type StoredNpmCredential = NpmPublishingCredentialRecord;

export interface NpmCredentialPersistence {
  load(): Promise<StoredNpmCredential | null>;
  save(record: StoredNpmCredential): Promise<void>;
  clear(): Promise<boolean>;
}

export interface NpmCredentialVerifier {
  verify(token: string, scope: string): Promise<{ username: string }>;
}

export interface NpmPublishingCredentials {
  status(): Promise<NpmCredentialStatus>;
  verifyActive(): Promise<NpmCredentialStatus>;
  replace(input: { token: string; expiresAt: string | null; actorId: string }): Promise<NpmCredentialStatus>;
  clear(): Promise<NpmCredentialStatus>;
  resolveForPublish(): Promise<NpmPublishConfig>;
}

export class NpmCredentialError extends Error {
  constructor(
    readonly code: "NPM_CREDENTIAL_INVALID" | "NPM_CREDENTIAL_LOCKED" | "NPM_CREDENTIAL_EXPIRED",
    message: string
  ) {
    super(message);
    this.name = "NpmCredentialError";
  }
}

export class MemoryNpmCredentialPersistence implements NpmCredentialPersistence {
  private record: StoredNpmCredential | null = null;

  async load(): Promise<StoredNpmCredential | null> {
    return this.record === null ? null : structuredClone(this.record);
  }

  async save(record: StoredNpmCredential): Promise<void> {
    this.record = structuredClone(record);
  }

  async clear(): Promise<boolean> {
    const existed = this.record !== null;
    this.record = null;
    return existed;
  }
}

export class FetchNpmCredentialVerifier implements NpmCredentialVerifier {
  constructor(private readonly request: typeof fetch = fetch) {}

  async verify(token: string): Promise<{ username: string }> {
    const response = await this.request("https://registry.npmjs.org/-/whoami", {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`
      },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`npm identity verification failed with status ${response.status}`);
    const body = await response.json() as { username?: unknown };
    if (typeof body.username !== "string" || body.username.trim() === "") {
      throw new Error("npm identity verification returned no username");
    }
    return { username: body.username.trim() };
  }
}

export function createNpmPublishingCredentials(input: {
  deploymentConfig: NpmPublishConfig;
  persistence: NpmCredentialPersistence;
  encryptionKey: Uint8Array | null;
  verifier: NpmCredentialVerifier;
  keyId?: string;
  now?: () => Date;
}): NpmPublishingCredentials {
  const now = input.now ?? (() => new Date());
  const key = input.encryptionKey === null ? null : Buffer.from(input.encryptionKey);
  let deploymentVerification: Pick<NpmCredentialStatus, "state" | "username" | "last_verified_at"> | null = null;

  function deploymentStatus(): NpmCredentialStatus {
    const configured = isNpmPublishConfigured(input.deploymentConfig);
    return {
      scope: input.deploymentConfig.scope,
      source: configured ? "deployment" : "none",
      state: configured ? (deploymentVerification?.state ?? "configured") : "not_configured",
      username: configured ? (deploymentVerification?.username ?? null) : null,
      expires_at: null,
      last_verified_at: configured ? (deploymentVerification?.last_verified_at ?? null) : null,
      can_manage: key?.byteLength === 32
    };
  }

  function managedStatus(record: StoredNpmCredential): NpmCredentialStatus {
    const expired = record.expiresAt !== null && Date.parse(record.expiresAt) <= now().getTime();
    return {
      scope: record.scope,
      source: "managed",
      state: key?.byteLength !== 32 ? "locked" : expired ? "expired" : "ready",
      username: record.username,
      expires_at: record.expiresAt,
      last_verified_at: record.lastVerifiedAt,
      can_manage: key?.byteLength === 32
    };
  }

  function requireKey(): Buffer {
    if (key?.byteLength !== 32) {
      throw new NpmCredentialError("NPM_CREDENTIAL_LOCKED", "managed npm credentials are not available");
    }
    return key;
  }

  function encrypt(token: string): Pick<StoredNpmCredential, "ciphertext" | "iv" | "authTag"> {
    const iv = randomBytes(12);
    const cipher = createCipheriv(CIPHER, requireKey(), iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64")
    };
  }

  function decrypt(record: StoredNpmCredential): string {
    try {
      const decipher = createDecipheriv(CIPHER, requireKey(), Buffer.from(record.iv, "base64"));
      decipher.setAAD(AAD);
      decipher.setAuthTag(Buffer.from(record.authTag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, "base64")),
        decipher.final()
      ]).toString("utf8");
    } catch (error) {
      if (error instanceof NpmCredentialError) throw error;
      throw new NpmCredentialError("NPM_CREDENTIAL_LOCKED", "managed npm credential could not be decrypted");
    }
  }

  return {
    async status() {
      const managed = await input.persistence.load();
      return managed === null ? deploymentStatus() : managedStatus(managed);
    },

    async verifyActive() {
      const managed = await input.persistence.load();
      if (managed !== null) {
        if (managed.expiresAt !== null && Date.parse(managed.expiresAt) <= now().getTime()) {
          throw new NpmCredentialError("NPM_CREDENTIAL_EXPIRED", "managed npm credential has expired");
        }
        let identity: { username: string };
        try {
          identity = await input.verifier.verify(decrypt(managed), managed.scope);
        } catch {
          throw new NpmCredentialError("NPM_CREDENTIAL_INVALID", "npm rejected the credential or could not verify it");
        }
        const verified = {
          ...managed,
          username: identity.username,
          lastVerifiedAt: now().toISOString()
        };
        await input.persistence.save(verified);
        return managedStatus(verified);
      }

      if (!isNpmPublishConfigured(input.deploymentConfig)) {
        throw new NpmCredentialError("NPM_CREDENTIAL_INVALID", "npm publishing credential is not configured");
      }
      let identity: { username: string };
      try {
        identity = await input.verifier.verify(input.deploymentConfig.token as string, input.deploymentConfig.scope as string);
      } catch {
        throw new NpmCredentialError("NPM_CREDENTIAL_INVALID", "npm rejected the credential or could not verify it");
      }
      deploymentVerification = {
        state: "ready",
        username: identity.username,
        last_verified_at: now().toISOString()
      };
      return deploymentStatus();
    },

    async replace({ token, expiresAt, actorId }) {
      const normalizedToken = token.trim();
      const scope = input.deploymentConfig.scope?.trim() ?? "";
      if (normalizedToken === "" || scope === "") {
        throw new NpmCredentialError("NPM_CREDENTIAL_INVALID", "npm token and scope are required");
      }
      requireKey();
      if (expiresAt !== null && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now().getTime())) {
        throw new NpmCredentialError("NPM_CREDENTIAL_EXPIRED", "npm credential expiration must be in the future");
      }
      let identity: { username: string };
      try {
        identity = await input.verifier.verify(normalizedToken, scope);
      } catch {
        throw new NpmCredentialError("NPM_CREDENTIAL_INVALID", "npm rejected the credential or could not verify it");
      }
      const timestamp = now().toISOString();
      const encrypted = encrypt(normalizedToken);
      const record: StoredNpmCredential = {
        schemaVersion: 1,
        keyId: input.keyId ?? "primary",
        ...encrypted,
        scope,
        username: identity.username,
        expiresAt,
        lastVerifiedAt: timestamp,
        updatedBy: actorId,
        updatedAt: timestamp
      };
      await input.persistence.save(record);
      return managedStatus(record);
    },

    async clear() {
      await input.persistence.clear();
      return deploymentStatus();
    },

    async resolveForPublish() {
      const managed = await input.persistence.load();
      if (managed === null) return { ...input.deploymentConfig };
      if (managed.expiresAt !== null && Date.parse(managed.expiresAt) <= now().getTime()) {
        throw new NpmCredentialError("NPM_CREDENTIAL_EXPIRED", "managed npm credential has expired");
      }
      const token = decrypt(managed);
      let identity: { username: string };
      try {
        identity = await input.verifier.verify(token, managed.scope);
      } catch {
        throw new NpmCredentialError("NPM_CREDENTIAL_INVALID", "npm rejected the credential or could not verify it");
      }
      await input.persistence.save({
        ...managed,
        username: identity.username,
        lastVerifiedAt: now().toISOString()
      });
      return { scope: managed.scope, token };
    }
  };
}
