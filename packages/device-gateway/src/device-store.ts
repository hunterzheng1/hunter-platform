import type { DatabaseSync } from "node:sqlite";
import type { JsonWebKey } from "node:crypto";

import type { DeviceId, ProjectId } from "@hunter/domain";

import type { MobileScope } from "./mobile-contracts.js";

export interface StoredPairingChallenge {
  readonly pairingId: string;
  readonly challengeHash: string;
  readonly createdByPrincipalId: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
  readonly submittedAt: string | null;
  readonly submittedDeviceName: string | null;
  readonly submittedPublicJwk: JsonWebKey | null;
  readonly submittedPublicKeyThumbprint: string | null;
  readonly confirmedDeviceId: DeviceId | null;
  readonly deliveredAt: string | null;
}

export interface StoredDevice {
  readonly deviceId: DeviceId;
  readonly displayName: string;
  readonly publicJwk: JsonWebKey;
  readonly publicKeyThumbprint: string;
  readonly scopes: readonly MobileScope[];
  readonly projectIds: readonly ProjectId[];
  readonly version: number;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

interface PairingRow {
  readonly pairing_id: string;
  readonly challenge_hash: string;
  readonly created_by_principal_id: string;
  readonly expires_at: string;
  readonly consumed_at: string | null;
  readonly submitted_at: string | null;
  readonly submitted_device_name: string | null;
  readonly submitted_public_jwk_json: string | null;
  readonly submitted_public_key_thumbprint: string | null;
  readonly confirmed_device_id: string | null;
  readonly delivered_at: string | null;
}

interface DeviceRow {
  readonly device_id: string;
  readonly display_name: string;
  readonly public_jwk_json: string;
  readonly public_key_thumbprint: string;
  readonly scopes_json: string;
  readonly project_ids_json: string;
  readonly version: number;
  readonly expires_at: string;
  readonly revoked_at: string | null;
}

export interface ConsumePairingInput {
  readonly pairingId: string;
  readonly challengeHash: string;
  readonly consumedAt: string;
  readonly device: StoredDevice;
}

export interface StoredRefreshFamily {
  readonly familyId: string;
  readonly deviceId: DeviceId;
  readonly refreshHash: string;
  readonly previousRefreshHash: string | null;
  readonly generation: number;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export type RefreshRotationResult =
  | { readonly status: "rotated"; readonly family: StoredRefreshFamily }
  | { readonly status: "reused"; readonly family: StoredRefreshFamily }
  | { readonly status: "revoked"; readonly family: StoredRefreshFamily }
  | { readonly status: "expired"; readonly family: StoredRefreshFamily }
  | { readonly status: "invalid" };

export interface RefreshCredentialMatch {
  readonly family: StoredRefreshFamily;
  readonly state: "current" | "retired";
}

interface RefreshFamilyRow {
  readonly family_id: string;
  readonly device_id: string;
  readonly refresh_hash: string;
  readonly previous_refresh_hash: string | null;
  readonly generation: number;
  readonly expires_at: string;
  readonly revoked_at: string | null;
}

function toPairing(row: PairingRow): StoredPairingChallenge {
  return {
    pairingId: row.pairing_id,
    challengeHash: row.challenge_hash,
    createdByPrincipalId: row.created_by_principal_id,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    submittedAt: row.submitted_at,
    submittedDeviceName: row.submitted_device_name,
    submittedPublicJwk: row.submitted_public_jwk_json === null
      ? null
      : JSON.parse(row.submitted_public_jwk_json) as JsonWebKey,
    submittedPublicKeyThumbprint: row.submitted_public_key_thumbprint,
    confirmedDeviceId: row.confirmed_device_id as DeviceId | null,
    deliveredAt: row.delivered_at,
  };
}

function toDevice(row: DeviceRow): StoredDevice {
  return {
    deviceId: row.device_id as DeviceId,
    displayName: row.display_name,
    publicJwk: JSON.parse(row.public_jwk_json) as JsonWebKey,
    publicKeyThumbprint: row.public_key_thumbprint,
    scopes: JSON.parse(row.scopes_json) as MobileScope[],
    projectIds: JSON.parse(row.project_ids_json) as ProjectId[],
    version: row.version,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

export class DeviceStore {
  public constructor(private readonly database: DatabaseSync) {}

  public createPairingChallenge(input: {
    readonly pairingId: string;
    readonly challengeHash: string;
    readonly createdByPrincipalId: string;
    readonly createdAt: string;
    readonly expiresAt: string;
  }): void {
    this.database
      .prepare(
        `INSERT INTO pairing_challenges(
           pairing_id, challenge_hash, created_by_principal_id, created_at, expires_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.pairingId,
        input.challengeHash,
        input.createdByPrincipalId,
        input.createdAt,
        input.expiresAt,
      );
  }

  public getPairingChallenge(pairingId: string): StoredPairingChallenge | undefined {
    const row = this.database
      .prepare(
        `SELECT pairing_id, challenge_hash, created_by_principal_id,
                expires_at, consumed_at,
                submitted_at, submitted_device_name, submitted_public_jwk_json,
                submitted_public_key_thumbprint, confirmed_device_id, delivered_at
           FROM pairing_challenges
          WHERE pairing_id = ?`,
      )
      .get(pairingId) as unknown as PairingRow | undefined;
    return row === undefined ? undefined : toPairing(row);
  }

  public submitPairingChallenge(input: {
    readonly pairingId: string;
    readonly challengeHash: string;
    readonly submittedAt: string;
    readonly deviceName: string;
    readonly publicJwk: JsonWebKey;
    readonly publicKeyThumbprint: string;
  }): void {
    const result = this.database
      .prepare(
        `UPDATE pairing_challenges
            SET submitted_at = ?,
                submitted_device_name = ?,
                submitted_public_jwk_json = ?,
                submitted_public_key_thumbprint = ?
          WHERE pairing_id = ?
            AND challenge_hash = ?
            AND consumed_at IS NULL
            AND submitted_at IS NULL
            AND expires_at > ?`,
      )
      .run(
        input.submittedAt,
        input.deviceName,
        JSON.stringify(input.publicJwk),
        input.publicKeyThumbprint,
        input.pairingId,
        input.challengeHash,
        input.submittedAt,
      );
    if (result.changes !== 1) throw new Error("PAIRING_SUBMISSION_REJECTED");
  }

  public consumePairingChallenge(input: ConsumePairingInput): StoredDevice {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const pairing = this.getPairingChallenge(input.pairingId);
      if (pairing === undefined || pairing.challengeHash !== input.challengeHash) {
        throw new Error("PAIRING_CHALLENGE_INVALID");
      }
      if (pairing.consumedAt !== null) throw new Error("PAIRING_CHALLENGE_CONSUMED");
      if (Date.parse(pairing.expiresAt) <= Date.parse(input.consumedAt)) {
        throw new Error("PAIRING_CHALLENGE_EXPIRED");
      }

      const updated = this.database
        .prepare(
          `UPDATE pairing_challenges
              SET consumed_at = ?,
                  confirmed_device_name = ?,
                  confirmed_scopes_json = ?,
                  confirmed_project_ids_json = ?,
                  confirmed_device_expires_at = ?,
                  confirmed_device_id = ?
            WHERE pairing_id = ?
              AND consumed_at IS NULL`,
        )
        .run(
          input.consumedAt,
          input.device.displayName,
          JSON.stringify(input.device.scopes),
          JSON.stringify(input.device.projectIds),
          input.device.expiresAt,
          input.device.deviceId,
          input.pairingId,
        );
      if (updated.changes !== 1) throw new Error("PAIRING_CHALLENGE_CONSUMED");

      this.database
        .prepare(
          `INSERT INTO devices(
             device_id, display_name, public_jwk_json, public_key_thumbprint,
             scopes_json, project_ids_json, version, expires_at, revoked_at,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          input.device.deviceId,
          input.device.displayName,
          JSON.stringify(input.device.publicJwk),
          input.device.publicKeyThumbprint,
          JSON.stringify(input.device.scopes),
          JSON.stringify(input.device.projectIds),
          input.device.version,
          input.device.expiresAt,
          input.consumedAt,
          input.consumedAt,
        );
      this.database.exec("COMMIT");
      return input.device;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public deliverPairingCredentials<T>(
    pairingId: string,
    deliveredAt: string,
    issue: (device: StoredDevice) => T,
  ): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const pairing = this.getPairingChallenge(pairingId);
      if (pairing?.confirmedDeviceId === null || pairing?.confirmedDeviceId === undefined) {
        throw new Error("PAIRING_NOT_CONFIRMED");
      }
      if (pairing.deliveredAt !== null) throw new Error("PAIRING_CREDENTIALS_DELIVERED");
      const result = this.database
        .prepare(
          `UPDATE pairing_challenges
              SET delivered_at = ?
            WHERE pairing_id = ?
              AND delivered_at IS NULL
              AND confirmed_device_id = ?`,
        )
        .run(deliveredAt, pairingId, pairing.confirmedDeviceId);
      if (result.changes !== 1) throw new Error("PAIRING_CREDENTIALS_DELIVERED");
      const device = this.getDevice(pairing.confirmedDeviceId);
      if (device === undefined) throw new Error("DEVICE_NOT_FOUND");
      const delivered = issue(device);
      this.database.exec("COMMIT");
      return delivered;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public getDevice(deviceId: DeviceId): StoredDevice | undefined {
    const row = this.database
      .prepare(
        `SELECT device_id, display_name, public_jwk_json, public_key_thumbprint,
                scopes_json, project_ids_json, version, expires_at, revoked_at
           FROM devices
          WHERE device_id = ?`,
      )
      .get(deviceId) as unknown as DeviceRow | undefined;
    return row === undefined ? undefined : toDevice(row);
  }

  public revokeDevice(deviceId: DeviceId, revokedAt: string): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database
        .prepare(
          `UPDATE devices
              SET revoked_at = COALESCE(revoked_at, ?),
                  version = version + CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END,
                  updated_at = ?
            WHERE device_id = ?`,
        )
        .run(revokedAt, revokedAt, deviceId);
      if (result.changes !== 1) throw new Error("DEVICE_NOT_FOUND");
      this.database
        .prepare(
          `UPDATE refresh_families
              SET revoked_at = COALESCE(revoked_at, ?),
                  updated_at = ?
            WHERE device_id = ?`,
        )
        .run(revokedAt, revokedAt, deviceId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public createRefreshFamily(input: StoredRefreshFamily, createdAt: string): void {
    this.database
      .prepare(
        `INSERT INTO refresh_families(
           family_id, device_id, refresh_hash, previous_refresh_hash,
           generation, expires_at, revoked_at, reuse_detected_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        input.familyId,
        input.deviceId,
        input.refreshHash,
        input.previousRefreshHash,
        input.generation,
        input.expiresAt,
        input.revokedAt,
        createdAt,
        createdAt,
      );
  }

  public findRefreshCredential(refreshHash: string): RefreshCredentialMatch | undefined {
    const row = this.database
      .prepare(
        `SELECT family_id, device_id, refresh_hash, previous_refresh_hash,
                generation, expires_at, revoked_at
           FROM refresh_families
          WHERE refresh_hash = ? OR previous_refresh_hash = ?`,
      )
      .get(refreshHash, refreshHash) as unknown as RefreshFamilyRow | undefined;
    const historical = row === undefined
      ? this.database
          .prepare(
            `SELECT family.family_id, family.device_id, family.refresh_hash,
                    family.previous_refresh_hash, family.generation,
                    family.expires_at, family.revoked_at
               FROM refresh_credential_history history
               JOIN refresh_families family ON family.family_id = history.family_id
              WHERE history.refresh_hash = ?`,
          )
          .get(refreshHash) as unknown as RefreshFamilyRow | undefined
      : undefined;
    const matched = row ?? historical;
    if (matched === undefined) return undefined;
    const family: StoredRefreshFamily = {
      familyId: matched.family_id,
      deviceId: matched.device_id as DeviceId,
      refreshHash: matched.refresh_hash,
      previousRefreshHash: matched.previous_refresh_hash,
      generation: matched.generation,
      expiresAt: matched.expires_at,
      revokedAt: matched.revoked_at,
    };
    return {
      family,
      state: row !== undefined && row.refresh_hash === refreshHash ? "current" : "retired",
    };
  }

  public rotateRefreshFamily(input: {
    readonly presentedHash: string;
    readonly replacementHash: string;
    readonly now: string;
  }): RefreshRotationResult {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const match = this.findRefreshCredential(input.presentedHash);
      if (match === undefined) {
        this.database.exec("COMMIT");
        return { status: "invalid" };
      }
      const family = match.family;
      if (family.revokedAt !== null) {
        this.database.exec("COMMIT");
        return { status: "revoked", family };
      }
      if (Date.parse(family.expiresAt) <= Date.parse(input.now)) {
        this.database
          .prepare(
            `UPDATE refresh_families
                SET revoked_at = ?, updated_at = ?
              WHERE family_id = ?`,
          )
          .run(input.now, input.now, family.familyId);
        this.database.exec("COMMIT");
        return { status: "expired", family: { ...family, revokedAt: input.now } };
      }
      if (match.state === "retired") {
        this.database
          .prepare(
            `UPDATE refresh_families
                SET revoked_at = ?, reuse_detected_at = ?, updated_at = ?
              WHERE family_id = ?`,
          )
          .run(input.now, input.now, input.now, family.familyId);
        this.database.exec("COMMIT");
        return { status: "reused", family: { ...family, revokedAt: input.now } };
      }

      this.database
        .prepare(
          `INSERT INTO refresh_credential_history(
             family_id, refresh_hash, generation, retired_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(
          family.familyId,
          input.presentedHash,
          family.generation,
          input.now,
        );
      this.database
        .prepare(
          `UPDATE refresh_families
              SET previous_refresh_hash = refresh_hash,
                  refresh_hash = ?,
                  generation = generation + 1,
                  updated_at = ?
            WHERE family_id = ?
              AND refresh_hash = ?
              AND revoked_at IS NULL`,
        )
        .run(input.replacementHash, input.now, family.familyId, input.presentedHash);
      const rotated: StoredRefreshFamily = {
        ...family,
        previousRefreshHash: input.presentedHash,
        refreshHash: input.replacementHash,
        generation: family.generation + 1,
      };
      this.database.exec("COMMIT");
      return { status: "rotated", family: rotated };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public reserveDeviceProofNonce(input: {
    readonly deviceId: DeviceId;
    readonly tokenJti: string;
    readonly nonce: string;
    readonly observedAt: string;
    readonly expiresAt: string;
  }): boolean {
    this.database
      .prepare("DELETE FROM device_proof_nonces WHERE expires_at <= ?")
      .run(input.observedAt);
    const result = this.database
      .prepare(
        `INSERT OR IGNORE INTO device_proof_nonces(
           device_id, token_jti, nonce, observed_at, expires_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.deviceId, input.tokenJti, input.nonce, input.observedAt, input.expiresAt);
    return result.changes === 1;
  }
}
