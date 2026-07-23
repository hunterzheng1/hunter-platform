import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
} from "node:crypto";

import {
  DeviceIdSchema,
  ProjectIdSchema,
  type DeviceId,
  type ProjectId,
} from "@hunter/domain";
import { z } from "zod";

import { DeviceStore } from "./device-store.js";
import { MobileScopeSetSchema } from "./mobile-contracts.js";

const AccessClaimsSchema = z.strictObject({
  iss: z.string().url(),
  aud: z.string().trim().min(1).max(200),
  sub: DeviceIdSchema,
  iat: z.number().int().nonnegative(),
  nbf: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  jti: z.string().regex(/^jti_[a-f0-9]{24}$/u),
  scopes: MobileScopeSetSchema,
  projectIds: z.array(ProjectIdSchema).min(1).max(100),
  deviceVersion: z.number().int().positive(),
  cnf: z.strictObject({
    jkt: z.string().min(32).max(100),
  }),
});
export type AccessClaims = z.infer<typeof AccessClaimsSchema>;

export interface TokenServiceOptions {
  readonly store: DeviceStore;
  readonly issuer: string;
  readonly audience: string;
  readonly signingSecretRef: string;
  readonly secretStore: {
    resolveSecret(reference: string): Promise<string>;
  };
  readonly now?: () => Date;
  readonly random?: (size: number) => Buffer;
}

export interface IssuedDeviceCredentials {
  readonly accessToken: string;
  readonly accessExpiresAt: string;
  readonly refreshCredential: string;
  readonly refreshExpiresAt: string;
}

const ProofInputSchema = z.strictObject({
  timestamp: z.string().datetime({ offset: true }),
  nonce: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/u),
  proof: z.string().min(1).max(512),
});
const RefreshInputSchema = ProofInputSchema.extend({
  refreshCredential: z.string().min(32).max(200),
});
const DeviceRequestInputSchema = ProofInputSchema.extend({
  accessToken: z.string().min(32).max(8_192),
  audience: z.string().trim().min(1).max(200),
  projectId: ProjectIdSchema,
  method: z.string().trim().min(1).max(16),
  url: z.string().trim().min(1).max(2_048),
  body: z.unknown(),
});

function hashCredential(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "";
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("DEVICE_PROOF_BODY_INVALID");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function createRefreshProofMessage(input: {
  readonly refreshCredential: string;
  readonly timestamp: string;
  readonly nonce: string;
}): string {
  return [
    "hunter-refresh-proof-v1",
    hashCredential(input.refreshCredential),
    input.timestamp,
    input.nonce,
  ].join("\n");
}

export function createDeviceProofMessage(input: {
  readonly accessToken: string;
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
  readonly timestamp: string;
  readonly nonce: string;
}): string {
  return [
    "hunter-device-proof-v1",
    hashCredential(input.accessToken),
    input.timestamp,
    input.nonce,
    input.method.toUpperCase(),
    input.url,
    hashCredential(canonicalJson(input.body)),
  ].join("\n");
}

function seconds(date: Date): number {
  return Math.floor(date.getTime() / 1_000);
}

export class TokenService {
  private constructor(
    private readonly options: TokenServiceOptions,
    private readonly signingSecret: string,
  ) {}

  public static async create(options: TokenServiceOptions): Promise<TokenService> {
    let issuer: URL;
    try {
      issuer = new URL(options.issuer);
    } catch {
      throw new Error("TOKEN_ISSUER_INVALID");
    }
    if (issuer.protocol !== "https:" || issuer.username !== "" || issuer.password !== "") {
      throw new Error("TOKEN_ISSUER_INVALID");
    }
    if (!/^os-credential:\/\/[A-Za-z0-9._/-]+$/u.test(options.signingSecretRef)) {
      throw new Error("SIGNING_SECRET_REF_INVALID");
    }
    const signingSecret = await options.secretStore.resolveSecret(options.signingSecretRef);
    if (Buffer.byteLength(signingSecret, "utf8") < 32) throw new Error("SIGNING_SECRET_TOO_SHORT");
    return new TokenService(options, signingSecret);
  }

  public issue(deviceId: DeviceId): IssuedDeviceCredentials {
    const now = this.now();
    const device = this.requireActiveDevice(deviceId, now);
    const accessExpiresAt = new Date(now.getTime() + 5 * 60_000);
    const refreshExpiresAt = new Date(
      Math.min(now.getTime() + 30 * 24 * 60 * 60_000, Date.parse(device.expiresAt)),
    );
    const accessToken = this.issueAccessToken(device, now, accessExpiresAt);
    const refreshCredential = this.random(32).toString("base64url");
    this.options.store.createRefreshFamily(
      {
        familyId: `rfm_${this.random(12).toString("hex")}`,
        deviceId: device.deviceId,
        refreshHash: hashCredential(refreshCredential),
        previousRefreshHash: null,
        generation: 0,
        expiresAt: refreshExpiresAt.toISOString(),
        revokedAt: null,
      },
      now.toISOString(),
    );
    return {
      accessToken,
      accessExpiresAt: accessExpiresAt.toISOString(),
      refreshCredential,
      refreshExpiresAt: refreshExpiresAt.toISOString(),
    };
  }

  public rotateRefresh(candidate: unknown): IssuedDeviceCredentials {
    const input = RefreshInputSchema.parse(candidate);
    const now = this.now();
    this.assertFreshTimestamp(input.timestamp, now);
    const presentedHash = hashCredential(input.refreshCredential);
    const existing = this.options.store.findRefreshCredential(presentedHash);
    if (existing === undefined) throw new Error("REFRESH_CREDENTIAL_INVALID");
    const device = this.requireActiveDevice(existing.family.deviceId, now);
    this.assertDeviceSignature(
      device.publicJwk,
      createRefreshProofMessage(input),
      input.proof,
    );

    const replacement = this.random(32).toString("base64url");
    const rotation = this.options.store.rotateRefreshFamily({
      presentedHash,
      replacementHash: hashCredential(replacement),
      now: now.toISOString(),
    });
    if (rotation.status === "invalid") throw new Error("REFRESH_CREDENTIAL_INVALID");
    if (rotation.status === "reused") throw new Error("REFRESH_CREDENTIAL_REUSED");
    if (rotation.status === "revoked") throw new Error("REFRESH_FAMILY_REVOKED");
    if (rotation.status === "expired") throw new Error("REFRESH_CREDENTIAL_EXPIRED");

    const accessExpiresAt = new Date(now.getTime() + 5 * 60_000);
    return {
      accessToken: this.issueAccessToken(device, now, accessExpiresAt),
      accessExpiresAt: accessExpiresAt.toISOString(),
      refreshCredential: replacement,
      refreshExpiresAt: rotation.family.expiresAt,
    };
  }

  public verifyDeviceRequest(candidate: unknown): AccessClaims {
    const input = DeviceRequestInputSchema.parse(candidate);
    const claims = this.verifyAccessToken(input.accessToken, {
      audience: input.audience,
      projectId: input.projectId,
    });
    const now = this.now();
    this.assertFreshTimestamp(input.timestamp, now);
    const device = this.requireActiveDevice(claims.sub, now);
    this.assertDeviceSignature(
      device.publicJwk,
      createDeviceProofMessage(input),
      input.proof,
    );
    const reserved = this.options.store.reserveDeviceProofNonce({
      deviceId: claims.sub,
      tokenJti: claims.jti,
      nonce: input.nonce,
      observedAt: now.toISOString(),
      expiresAt: new Date(claims.exp * 1_000).toISOString(),
    });
    if (!reserved) throw new Error("DEVICE_PROOF_REPLAY");
    return claims;
  }

  public verifyAccessToken(
    accessToken: string,
    input: { readonly audience: string; readonly projectId: ProjectId | string },
  ): AccessClaims {
    const claims = this.parseClaims(accessToken);
    if (claims.iss !== this.options.issuer) throw new Error("ACCESS_TOKEN_ISSUER_INVALID");
    if (claims.aud !== this.options.audience || claims.aud !== input.audience) {
      throw new Error("ACCESS_TOKEN_AUDIENCE_INVALID");
    }
    const now = seconds(this.now());
    if (claims.nbf > now) throw new Error("ACCESS_TOKEN_NOT_YET_VALID");
    if (claims.exp <= now) throw new Error("ACCESS_TOKEN_EXPIRED");
    const projectId = ProjectIdSchema.parse(input.projectId);
    if (!claims.projectIds.includes(projectId)) throw new Error("ACCESS_TOKEN_PROJECT_FORBIDDEN");

    const device = this.options.store.getDevice(claims.sub);
    if (device === undefined) throw new Error("DEVICE_NOT_FOUND");
    if (device.revokedAt !== null) throw new Error("DEVICE_REVOKED");
    if (Date.parse(device.expiresAt) <= this.now().getTime()) throw new Error("DEVICE_EXPIRED");
    if (device.version !== claims.deviceVersion) throw new Error("DEVICE_VERSION_STALE");
    if (device.publicKeyThumbprint !== claims.cnf.jkt) throw new Error("DEVICE_KEY_BINDING_INVALID");
    if (!device.projectIds.includes(projectId)) throw new Error("ACCESS_TOKEN_PROJECT_FORBIDDEN");
    return claims;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private random(size: number): Buffer {
    return this.options.random?.(size) ?? randomBytes(size);
  }

  private requireActiveDevice(deviceId: DeviceId, now: Date) {
    const parsed = DeviceIdSchema.parse(deviceId);
    const device = this.options.store.getDevice(parsed);
    if (device === undefined) throw new Error("DEVICE_NOT_FOUND");
    if (device.revokedAt !== null) throw new Error("DEVICE_REVOKED");
    if (Date.parse(device.expiresAt) <= now.getTime()) throw new Error("DEVICE_EXPIRED");
    return device;
  }

  private issueAccessToken(
    device: ReturnType<TokenService["requireActiveDevice"]>,
    now: Date,
    accessExpiresAt: Date,
  ): string {
    return this.signClaims(
      AccessClaimsSchema.parse({
        iss: this.options.issuer,
        aud: this.options.audience,
        sub: device.deviceId,
        iat: seconds(now),
        nbf: seconds(now),
        exp: seconds(accessExpiresAt),
        jti: `jti_${this.random(12).toString("hex")}`,
        scopes: device.scopes,
        projectIds: device.projectIds,
        deviceVersion: device.version,
        cnf: { jkt: device.publicKeyThumbprint },
      }),
    );
  }

  private assertFreshTimestamp(timestamp: string, now: Date): void {
    const delta = Math.abs(now.getTime() - Date.parse(timestamp));
    if (delta > 60_000) throw new Error("DEVICE_PROOF_STALE");
  }

  private assertDeviceSignature(publicJwk: import("node:crypto").JsonWebKey, message: string, proof: string): void {
    let valid = false;
    try {
      valid = verify(
        "sha256",
        Buffer.from(message, "utf8"),
        {
          key: createPublicKey({ key: publicJwk, format: "jwk" }),
          dsaEncoding: "ieee-p1363",
        },
        Buffer.from(proof, "base64url"),
      );
    } catch {
      valid = false;
    }
    if (!valid) throw new Error("DEVICE_PROOF_INVALID");
  }

  private signClaims(claims: AccessClaims): string {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signingInput = `${header}.${payload}`;
    return `${signingInput}.${this.signature(signingInput)}`;
  }

  private parseClaims(token: string): AccessClaims {
    const [header, payload, signature, extra] = token.split(".");
    if (header === undefined || payload === undefined || signature === undefined || extra !== undefined) {
      throw new Error("ACCESS_TOKEN_INVALID");
    }
    const signingInput = `${header}.${payload}`;
    const expected = Buffer.from(this.signature(signingInput));
    const received = Buffer.from(signature);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      throw new Error("ACCESS_TOKEN_INVALID");
    }
    try {
      const decodedHeader = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as unknown;
      if (
        decodedHeader === null
        || typeof decodedHeader !== "object"
        || (decodedHeader as { alg?: unknown }).alg !== "HS256"
        || (decodedHeader as { typ?: unknown }).typ !== "JWT"
      ) {
        throw new Error("ACCESS_TOKEN_INVALID");
      }
      return AccessClaimsSchema.parse(
        JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
      );
    } catch {
      throw new Error("ACCESS_TOKEN_INVALID");
    }
  }

  private signature(value: string): string {
    return createHmac("sha256", this.signingSecret).update(value).digest("base64url");
  }
}
