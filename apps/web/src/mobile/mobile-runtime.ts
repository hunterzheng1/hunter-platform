import {
  MobileCommandEnvelopeSchema,
  MobileCommandResultSchema,
  MobileRunProjectionSchema,
  type MobileCommandEnvelope,
  type MobileCommandResult,
  type MobileRunProjection,
} from "@hunter/device-gateway/mobile-contracts";
import { ProjectIdSchema, type ProjectId } from "@hunter/domain/ids";
import { z } from "zod";

import type { CredentialVault } from "./credential-vault.js";
import type { DeviceKeyStore } from "./device-key.js";

const TokenRotationResponseSchema = z.strictObject({
  accessToken: z.string().min(32).max(8_192),
  accessExpiresAt: z.string().datetime({ offset: true }),
  refreshCredential: z.string().min(32).max(200),
  refreshExpiresAt: z.string().datetime({ offset: true }),
});
const EventCursorGapSchema = z.strictObject({
  status: z.literal("resync_required"),
  code: z.literal("EVENT_CURSOR_GAP"),
  retentionFloor: z.number().int().nonnegative(),
  highWaterPosition: z.number().int().nonnegative(),
  instructions: z.strictObject({
    snapshot: z.literal("reload_snapshot"),
    rebuild: z.literal("replace_projection_from_snapshot"),
    resume: z.literal("subscribe_after_high_water_position"),
  }),
});
const PairingDescriptorSchema = z.strictObject({
  pairingId: z.string().regex(/^pair_[a-f0-9]{24}$/u),
  challenge: z.string().min(32).max(100),
});
const BeginPairingSchema = PairingDescriptorSchema.extend({
  deviceName: z.string().trim().min(1).max(120),
});
const CompletePairingSchema = PairingDescriptorSchema.extend({
  keyId: z.string().min(8).max(128),
});
const PairingSubmissionResponseSchema = z.strictObject({
  status: z.literal("pending_desktop_confirmation"),
  pairingId: PairingDescriptorSchema.shape.pairingId,
  expiresAt: z.string().datetime({ offset: true }),
});

export type MobileRuntimeSnapshot =
  | { readonly state: "unpaired" }
  | { readonly state: "connected"; readonly runs: readonly MobileRunProjection[] };

export interface MobileRuntimeOptions {
  readonly apiOrigin: string;
  readonly projectIds: readonly ProjectId[];
  readonly vault: CredentialVault;
  readonly keys: DeviceKeyStore;
  readonly fetch: typeof fetch;
  readonly now?: (() => Date) | undefined;
  readonly nonce?: (() => string) | undefined;
}

function validatedOrigin(candidate: string): string {
  const url = new URL(candidate);
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new Error("MOBILE_API_ORIGIN_INVALID");
  }
  return url.origin;
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

export class MobileRuntime {
  private readonly apiOrigin: string;
  private readonly projectIds: readonly ProjectId[];
  private readonly now: () => Date;
  private readonly nonce: () => string;
  private readonly eventCursors = new Map<ProjectId, number>();
  private accessToken: string | undefined;
  private current: MobileRuntimeSnapshot = { state: "unpaired" };

  public constructor(private readonly options: MobileRuntimeOptions) {
    this.apiOrigin = validatedOrigin(options.apiOrigin);
    this.projectIds = ProjectIdSchema.array().min(1).max(100).parse(options.projectIds);
    this.now = options.now ?? (() => new Date());
    this.nonce = options.nonce ?? (() => `runtime-nonce-${crypto.randomUUID()}`);
  }

  public snapshot(): MobileRuntimeSnapshot {
    return this.current;
  }

  public async connect(): Promise<MobileRuntimeSnapshot> {
    const restored = await this.options.vault.restore();
    if (restored.state === "unpaired") {
      this.accessToken = undefined;
      this.current = { state: "unpaired" };
      return this.current;
    }
    const timestamp = this.now().toISOString();
    const rotated = await this.options.vault.rotate({
      timestamp,
      nonce: this.nonce(),
      transport: async (request) => {
        const response = await this.options.fetch(
          `${this.apiOrigin}/api/v1/mobile/refresh`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
            credentials: "omit",
            cache: "no-store",
          },
        );
        if (!response.ok) throw new Error(`MOBILE_REFRESH_FAILED_${response.status}`);
        return TokenRotationResponseSchema.parse(await response.json());
      },
    });
    this.accessToken = rotated.accessToken;
    const runs = await this.loadRuns();
    this.current = { state: "connected", runs };
    return this.current;
  }

  public async execute(candidate: unknown): Promise<MobileCommandResult> {
    if (this.current.state !== "connected" || this.accessToken === undefined) {
      throw new Error("PAIRING_REQUIRED");
    }
    const command = MobileCommandEnvelopeSchema.parse(candidate);
    if (!this.projectIds.includes(command.projectId)) {
      throw new Error("DEVICE_PROJECT_FORBIDDEN");
    }
    const response = await this.signedFetch(
      "POST",
      "/api/v1/mobile/commands",
      command,
    );
    return MobileCommandResultSchema.parse(await response.json());
  }

  public async beginPairing(candidate: unknown): Promise<{
    readonly status: "pending_desktop_confirmation";
    readonly pairingId: string;
    readonly expiresAt: string;
    readonly keyId: string;
  }> {
    const input = BeginPairingSchema.parse(candidate);
    if ((await this.options.vault.restore()).state !== "unpaired") {
      throw new Error("DEVICE_ALREADY_PAIRED");
    }
    const identity = await this.options.keys.createIdentity();
    try {
      const proof = await this.options.keys.sign(
        identity.keyId,
        `hunter-pairing-v1\n${input.pairingId}\n${input.challenge}`,
      );
      const response = await this.options.fetch(
        `${this.apiOrigin}/api/v1/mobile/pairings/${encodeURIComponent(input.pairingId)}/submit`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            challenge: input.challenge,
            publicJwk: identity.publicJwk,
            proof,
            deviceName: input.deviceName,
          }),
          credentials: "omit",
          cache: "no-store",
        },
      );
      if (!response.ok) throw new Error(`MOBILE_PAIRING_SUBMIT_FAILED_${response.status}`);
      return {
        ...PairingSubmissionResponseSchema.parse(await response.json()),
        keyId: identity.keyId,
      };
    } catch (error) {
      await this.options.keys.delete(identity.keyId);
      throw error;
    }
  }

  public async completePairing(candidate: unknown): Promise<MobileRuntimeSnapshot> {
    const input = CompletePairingSchema.parse(candidate);
    if ((await this.options.vault.restore()).state !== "unpaired") {
      throw new Error("DEVICE_ALREADY_PAIRED");
    }
    const timestamp = this.now().toISOString();
    const nonce = this.nonce();
    const challengeHash = await this.options.keys.digestHex(input.challenge);
    const proof = await this.options.keys.sign(
      input.keyId,
      [
        "hunter-pairing-completion-v1",
        input.pairingId,
        challengeHash,
        timestamp,
        nonce,
      ].join("\n"),
    );
    const response = await this.options.fetch(
      `${this.apiOrigin}/api/v1/mobile/pairings/${encodeURIComponent(input.pairingId)}/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challenge: input.challenge,
          timestamp,
          nonce,
          proof,
        }),
        credentials: "omit",
        cache: "no-store",
      },
    );
    if (!response.ok) throw new Error(`MOBILE_PAIRING_COMPLETE_FAILED_${response.status}`);
    const credentials = TokenRotationResponseSchema.parse(await response.json());
    await this.options.vault.bind({
      keyId: input.keyId,
      refreshCredential: credentials.refreshCredential,
    });
    this.accessToken = credentials.accessToken;
    this.current = { state: "connected", runs: await this.loadRuns() };
    return this.current;
  }

  public async pollEvents(): Promise<MobileRuntimeSnapshot> {
    if (this.current.state !== "connected" || this.accessToken === undefined) {
      throw new Error("PAIRING_REQUIRED");
    }
    let reload = false;
    for (const projectId of this.projectIds) {
      const cursor = this.eventCursors.get(projectId) ?? 0;
      const path = `/api/v1/mobile/events?projectId=${encodeURIComponent(projectId)}&cursor=${cursor}&once=1`;
      const response = await this.signedFetch("GET", path, undefined, true);
      if (response.status === 409) {
        const gap = EventCursorGapSchema.parse(await response.json());
        this.eventCursors.set(projectId, gap.highWaterPosition);
        reload = true;
        continue;
      }
      const text = await response.text();
      const positions = [...text.matchAll(/^id: ([0-9]+)$/gmu)].map((match) => {
        const position = Number(match[1]);
        if (!Number.isSafeInteger(position)) throw new Error("EVENT_CURSOR_INVALID");
        return position;
      });
      const nextCursor = Math.max(cursor, ...positions);
      if (nextCursor > cursor) {
        this.eventCursors.set(projectId, nextCursor);
        reload = true;
      }
    }
    if (reload) {
      this.current = { state: "connected", runs: await this.loadRuns() };
    }
    return this.current;
  }

  private async loadRuns(): Promise<readonly MobileRunProjection[]> {
    return (
      await Promise.all(this.projectIds.map(async (projectId) => {
        const response = await this.signedFetch(
          "GET",
          `/api/v1/mobile/runs?projectId=${encodeURIComponent(projectId)}`,
        );
        return MobileRunProjectionSchema.array().max(500).parse(await response.json());
      }))
    ).flat();
  }

  private async signedFetch(
    method: "GET" | "POST",
    path: string,
    body?: MobileCommandEnvelope,
    allowConflict = false,
  ): Promise<Response> {
    const accessToken = this.accessToken;
    const binding = this.options.vault.snapshot();
    if (accessToken === undefined || binding.state !== "paired") {
      throw new Error("PAIRING_REQUIRED");
    }
    const timestamp = this.now().toISOString();
    const nonce = this.nonce();
    const proof = await this.options.keys.sign(
      binding.keyId,
      [
        "hunter-device-proof-v1",
        await this.options.keys.digestHex(accessToken),
        timestamp,
        nonce,
        method.toUpperCase(),
        path,
        await this.options.keys.digestHex(canonicalJson(body)),
      ].join("\n"),
    );
    const response = await this.options.fetch(`${this.apiOrigin}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "x-device-timestamp": timestamp,
        "x-device-nonce": nonce,
        "x-device-proof": proof,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: "omit",
      cache: "no-store",
    });
    if (!response.ok && !(allowConflict && response.status === 409)) {
      throw new Error(`MOBILE_REQUEST_FAILED_${response.status}`);
    }
    return response;
  }
}
