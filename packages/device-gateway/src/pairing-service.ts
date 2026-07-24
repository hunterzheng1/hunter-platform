import {
  createHash,
  createPublicKey,
  randomBytes,
  verify,
  type JsonWebKey,
} from "node:crypto";

import { DeviceIdSchema, ProjectIdSchema } from "@hunter/domain";
import { z } from "zod";

import { DeviceStore, type StoredDevice } from "./device-store.js";
import { MobileScopeSetSchema } from "./mobile-contracts.js";

const DesktopPairingPrincipalSchema = z.strictObject({
  kind: z.literal("authenticated_desktop"),
  principalId: z.string().trim().min(1).max(200),
});
const ConfirmationSchema = z.strictObject({
  desktopPrincipal: DesktopPairingPrincipalSchema,
  pairingId: z.string().regex(/^pair_[a-f0-9]{24}$/u),
  challenge: z.string().min(32).max(100),
  publicJwk: z.record(z.string(), z.unknown()),
  proof: z.string().min(1).max(512),
  deviceName: z.string().trim().min(1).max(120),
  scopes: MobileScopeSetSchema,
  projectIds: z.array(ProjectIdSchema).min(1).max(100),
  deviceExpiresAt: z.string().datetime({ offset: true }),
});
const PairingSubmissionSchema = z.strictObject({
  pairingId: z.string().regex(/^pair_[a-f0-9]{24}$/u),
  challenge: z.string().min(32).max(100),
  publicJwk: z.record(z.string(), z.unknown()),
  proof: z.string().min(1).max(512),
  deviceName: z.string().trim().min(1).max(120),
});
const SubmittedConfirmationSchema = z.strictObject({
  desktopPrincipal: DesktopPairingPrincipalSchema,
  pairingId: z.string().regex(/^pair_[a-f0-9]{24}$/u),
  scopes: MobileScopeSetSchema,
  projectIds: z.array(ProjectIdSchema).min(1).max(100),
  deviceExpiresAt: z.string().datetime({ offset: true }),
});
const CredentialDeliverySchema = z.strictObject({
  pairingId: z.string().regex(/^pair_[a-f0-9]{24}$/u),
  challenge: z.string().min(32).max(100),
  timestamp: z.string().datetime({ offset: true }),
  nonce: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/u),
  proof: z.string().min(1).max(512),
});

export interface PairingServiceOptions {
  readonly store: DeviceStore;
  readonly now?: () => Date;
  readonly random?: (size: number) => Buffer;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function publicKeyThumbprint(jwk: JsonWebKey): string {
  if (
    jwk.kty !== "EC"
    || jwk.crv !== "P-256"
    || typeof jwk.x !== "string"
    || typeof jwk.y !== "string"
    || jwk.d !== undefined
  ) {
    throw new Error("PAIRING_PUBLIC_KEY_INVALID");
  }
  return createHash("sha256")
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
    .digest("base64url");
}

export function createPairingCompletionProofMessage(input: {
  readonly pairingId: string;
  readonly challenge: string;
  readonly timestamp: string;
  readonly nonce: string;
}): string {
  return [
    "hunter-pairing-completion-v1",
    input.pairingId,
    sha256(input.challenge),
    input.timestamp,
    input.nonce,
  ].join("\n");
}

export function createPairingProofMessage(input: {
  readonly pairingId: string;
  readonly challenge: string;
}): string {
  return `hunter-pairing-v1\n${input.pairingId}\n${input.challenge}`;
}

function verifies(
  publicJwk: JsonWebKey,
  message: string,
  proof: string,
): boolean {
  try {
    return verify(
      "sha256",
      Buffer.from(message, "utf8"),
      {
        key: createPublicKey({ key: publicJwk, format: "jwk" }),
        dsaEncoding: "ieee-p1363",
      },
      Buffer.from(proof, "base64url"),
    );
  } catch {
    return false;
  }
}

export class PairingService {
  private readonly now: () => Date;
  private readonly random: (size: number) => Buffer;

  public constructor(private readonly options: PairingServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? randomBytes;
  }

  public createChallenge(principal: unknown): {
    readonly pairingId: string;
    readonly challenge: string;
    readonly expiresAt: string;
  } {
    const parsed = DesktopPairingPrincipalSchema.safeParse(principal);
    if (!parsed.success) throw new Error("DESKTOP_PAIRING_AUTH_REQUIRED");
    const createdAt = this.now();
    const pairingId = `pair_${this.random(12).toString("hex")}`;
    const challenge = this.random(32).toString("base64url");
    const expiresAt = new Date(createdAt.getTime() + 5 * 60_000).toISOString();
    this.options.store.createPairingChallenge({
      pairingId,
      challengeHash: sha256(challenge),
      createdByPrincipalId: parsed.data.principalId,
      createdAt: createdAt.toISOString(),
      expiresAt,
    });
    return { pairingId, challenge, expiresAt };
  }

  public confirmPairing(candidate: unknown): StoredDevice {
    const input = ConfirmationSchema.parse(candidate);
    const now = this.now();
    if (Date.parse(input.deviceExpiresAt) <= now.getTime()) {
      throw new Error("DEVICE_EXPIRY_INVALID");
    }
    const pairing = this.options.store.getPairingChallenge(input.pairingId);
    if (pairing === undefined || pairing.challengeHash !== sha256(input.challenge)) {
      throw new Error("PAIRING_CHALLENGE_INVALID");
    }
    if (pairing.createdByPrincipalId !== input.desktopPrincipal.principalId) {
      throw new Error("PAIRING_DESKTOP_PRINCIPAL_MISMATCH");
    }
    if (pairing.consumedAt !== null) throw new Error("PAIRING_CHALLENGE_CONSUMED");
    if (Date.parse(pairing.expiresAt) <= now.getTime()) throw new Error("PAIRING_CHALLENGE_EXPIRED");

    const jwk = input.publicJwk as JsonWebKey;
    const thumbprint = publicKeyThumbprint(jwk);
    const valid = verifies(
      jwk,
      createPairingProofMessage(input),
      input.proof,
    );
    if (!valid) throw new Error("PAIRING_PROOF_INVALID");

    const device: StoredDevice = {
      deviceId: DeviceIdSchema.parse(`dvc_${this.random(12).toString("hex")}`),
      displayName: input.deviceName,
      publicJwk: jwk,
      publicKeyThumbprint: thumbprint,
      scopes: input.scopes,
      projectIds: input.projectIds,
      version: 1,
      expiresAt: input.deviceExpiresAt,
      revokedAt: null,
    };
    return this.options.store.consumePairingChallenge({
      pairingId: input.pairingId,
      challengeHash: pairing.challengeHash,
      consumedAt: now.toISOString(),
      device,
    });
  }

  public submitPairing(candidate: unknown): {
    readonly status: "pending_desktop_confirmation";
    readonly pairingId: string;
    readonly expiresAt: string;
  } {
    const input = PairingSubmissionSchema.parse(candidate);
    const now = this.now();
    const pairing = this.options.store.getPairingChallenge(input.pairingId);
    if (pairing === undefined || pairing.challengeHash !== sha256(input.challenge)) {
      throw new Error("PAIRING_CHALLENGE_INVALID");
    }
    if (pairing.consumedAt !== null) throw new Error("PAIRING_CHALLENGE_CONSUMED");
    if (Date.parse(pairing.expiresAt) <= now.getTime()) {
      throw new Error("PAIRING_CHALLENGE_EXPIRED");
    }
    const jwk = input.publicJwk as JsonWebKey;
    const thumbprint = publicKeyThumbprint(jwk);
    if (!verifies(
      jwk,
      createPairingProofMessage(input),
      input.proof,
    )) {
      throw new Error("PAIRING_PROOF_INVALID");
    }
    if (pairing.submittedAt !== null) {
      if (
        pairing.submittedPublicKeyThumbprint !== thumbprint
        || pairing.submittedDeviceName !== input.deviceName
      ) {
        throw new Error("PAIRING_SUBMISSION_REJECTED");
      }
      return {
        status: "pending_desktop_confirmation",
        pairingId: input.pairingId,
        expiresAt: pairing.expiresAt,
      };
    }
    this.options.store.submitPairingChallenge({
      pairingId: input.pairingId,
      challengeHash: pairing.challengeHash,
      submittedAt: now.toISOString(),
      deviceName: input.deviceName,
      publicJwk: jwk,
      publicKeyThumbprint: thumbprint,
    });
    return {
      status: "pending_desktop_confirmation",
      pairingId: input.pairingId,
      expiresAt: pairing.expiresAt,
    };
  }

  public confirmSubmittedPairing(candidate: unknown): StoredDevice {
    const input = SubmittedConfirmationSchema.parse(candidate);
    const now = this.now();
    if (Date.parse(input.deviceExpiresAt) <= now.getTime()) {
      throw new Error("DEVICE_EXPIRY_INVALID");
    }
    const pairing = this.options.store.getPairingChallenge(input.pairingId);
    if (
      pairing === undefined
      || pairing.submittedAt === null
      || pairing.submittedDeviceName === null
      || pairing.submittedPublicJwk === null
      || pairing.submittedPublicKeyThumbprint === null
    ) {
      throw new Error("PAIRING_SUBMISSION_REQUIRED");
    }
    if (pairing.createdByPrincipalId !== input.desktopPrincipal.principalId) {
      throw new Error("PAIRING_DESKTOP_PRINCIPAL_MISMATCH");
    }
    const device: StoredDevice = {
      deviceId: DeviceIdSchema.parse(`dvc_${this.random(12).toString("hex")}`),
      displayName: pairing.submittedDeviceName,
      publicJwk: pairing.submittedPublicJwk,
      publicKeyThumbprint: pairing.submittedPublicKeyThumbprint,
      scopes: input.scopes,
      projectIds: input.projectIds,
      version: 1,
      expiresAt: input.deviceExpiresAt,
      revokedAt: null,
    };
    return this.options.store.consumePairingChallenge({
      pairingId: input.pairingId,
      challengeHash: pairing.challengeHash,
      consumedAt: now.toISOString(),
      device,
    });
  }

  public claimCredentialDelivery(candidate: unknown): StoredDevice {
    return this.deliverCredentials(candidate, (device) => device);
  }

  public deliverCredentials<T>(
    candidate: unknown,
    issue: (device: StoredDevice) => T,
  ): T {
    const input = CredentialDeliverySchema.parse(candidate);
    const now = this.now();
    if (Math.abs(now.getTime() - Date.parse(input.timestamp)) > 60_000) {
      throw new Error("PAIRING_PROOF_STALE");
    }
    const pairing = this.options.store.getPairingChallenge(input.pairingId);
    if (
      pairing === undefined
      || pairing.challengeHash !== sha256(input.challenge)
      || pairing.confirmedDeviceId === null
    ) {
      throw new Error("PAIRING_NOT_CONFIRMED");
    }
    const device = this.options.store.getDevice(pairing.confirmedDeviceId);
    if (device === undefined) throw new Error("DEVICE_NOT_FOUND");
    if (!verifies(device.publicJwk, createPairingCompletionProofMessage(input), input.proof)) {
      throw new Error("PAIRING_PROOF_INVALID");
    }
    return this.options.store.deliverPairingCredentials(
      input.pairingId,
      now.toISOString(),
      issue,
    );
  }
}
