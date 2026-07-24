import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";

export const LocalCapabilitySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/u);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const NonceSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/u);

const SignedRequestSchema = z.strictObject({
  method: z.string().regex(/^[A-Z]+$/u),
  url: z.string().min(1).max(8_192),
  host: z.string().min(1).max(512),
  origin: z.string().min(1).max(2_048),
  timestamp: z.number().int().nonnegative(),
  nonce: NonceSchema,
  lastEventId: z.string().regex(/^(0|[1-9][0-9]*)$/u).optional(),
  bodyDigest: DigestSchema,
});
export type LocalCapabilitySignedRequest = z.infer<typeof SignedRequestSchema>;

export const LOCAL_CAPABILITY_HEADERS = Object.freeze({
  timestamp: "x-hunter-local-timestamp",
  nonce: "x-hunter-local-nonce",
  bodyDigest: "x-hunter-local-body-sha256",
  signature: "x-hunter-local-signature",
} as const);

function canonicalRequest(input: LocalCapabilitySignedRequest): string {
  return [
    input.method,
    input.url,
    input.host,
    input.origin,
    String(input.timestamp),
    input.nonce,
    input.lastEventId ?? "",
    input.bodyDigest,
  ].join("\n");
}

function signature(capability: string, input: LocalCapabilitySignedRequest): string {
  return createHmac("sha256", Buffer.from(capability, "base64url"))
    .update(canonicalRequest(input))
    .digest("base64url");
}

export function createLocalCapability(
  random: (size: number) => Buffer = randomBytes,
): string {
  return LocalCapabilitySchema.parse(random(32).toString("base64url"));
}

export function digestLocalCapabilityBody(body: unknown): string {
  const encoded = body === undefined ? "" : JSON.stringify(body);
  return createHash("sha256").update(encoded).digest("hex");
}

export function signLocalCapabilityRequest(
  capabilityInput: string,
  requestInput: LocalCapabilitySignedRequest,
): Record<string, string> {
  const capability = LocalCapabilitySchema.parse(capabilityInput);
  const request = SignedRequestSchema.parse(requestInput);
  return {
    [LOCAL_CAPABILITY_HEADERS.timestamp]: String(request.timestamp),
    [LOCAL_CAPABILITY_HEADERS.nonce]: request.nonce,
    [LOCAL_CAPABILITY_HEADERS.bodyDigest]: request.bodyDigest,
    [LOCAL_CAPABILITY_HEADERS.signature]: signature(capability, request),
  };
}

export class LocalCapabilityVerifier {
  private readonly capability: string;
  private readonly consumedNonces = new Map<string, number>();

  constructor(
    capabilityInput: string,
    private readonly now: () => number = Date.now,
    private readonly maxClockSkewMs = 30_000,
  ) {
    this.capability = LocalCapabilitySchema.parse(capabilityInput);
  }

  verify(input: {
    readonly method: string;
    readonly url: string;
    readonly host: string;
    readonly origin: string;
    readonly body: unknown;
    readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  }): void {
    const timestampText = input.headers[LOCAL_CAPABILITY_HEADERS.timestamp];
    const nonce = input.headers[LOCAL_CAPABILITY_HEADERS.nonce];
    const claimedDigest = input.headers[LOCAL_CAPABILITY_HEADERS.bodyDigest];
    const receivedSignature = input.headers[LOCAL_CAPABILITY_HEADERS.signature];
    const lastEventId = input.headers["last-event-id"];
    if (
      typeof timestampText !== "string"
      || typeof nonce !== "string"
      || typeof claimedDigest !== "string"
      || typeof receivedSignature !== "string"
      || (lastEventId !== undefined && typeof lastEventId !== "string")
      || !/^(0|[1-9][0-9]*)$/u.test(timestampText)
    ) {
      throw new Error("LOCAL_CAPABILITY_INVALID");
    }
    const timestamp = Number(timestampText);
    const now = this.now();
    if (
      !Number.isSafeInteger(timestamp)
      || Math.abs(now - timestamp) > this.maxClockSkewMs
      || this.consumedNonces.has(nonce)
    ) {
      throw new Error("LOCAL_CAPABILITY_INVALID");
    }
    const bodyDigest = digestLocalCapabilityBody(input.body);
    if (bodyDigest !== claimedDigest) throw new Error("LOCAL_CAPABILITY_INVALID");
    const request = SignedRequestSchema.parse({
      method: input.method,
      url: input.url,
      host: input.host,
      origin: input.origin,
      timestamp,
      nonce,
      ...(lastEventId === undefined ? {} : { lastEventId }),
      bodyDigest,
    });
    const expected = Buffer.from(signature(this.capability, request));
    const received = Buffer.from(receivedSignature);
    if (
      expected.length !== received.length
      || !timingSafeEqual(expected, received)
    ) {
      throw new Error("LOCAL_CAPABILITY_INVALID");
    }
    this.consumedNonces.set(nonce, timestamp);
    for (const [storedNonce, storedAt] of this.consumedNonces) {
      if (storedAt < now - this.maxClockSkewMs) this.consumedNonces.delete(storedNonce);
    }
  }
}
