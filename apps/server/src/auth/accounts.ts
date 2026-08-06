import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions
} from "node:crypto";

import { sha256Bytes } from "@hunter-harness/core";

function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, derived) => {
      if (error !== null) reject(error);
      else resolve(derived);
    });
  });
}

const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1 } as const;

/** Session tokens are `hhs_`-prefixed so auth can route them separately from `hh_` API tokens. */
export const SESSION_TOKEN_PREFIX = "hhs_";
export const INVITE_CODE_PREFIX = "hhi_";

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS)) as Buffer;
  return [
    "scrypt",
    String(SCRYPT_PARAMS.N),
    String(SCRYPT_PARAMS.r),
    String(SCRYPT_PARAMS.p),
    salt.toString("base64url"),
    derived.toString("base64url")
  ].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  const salt = Buffer.from(saltRaw ?? "", "base64url");
  const expected = Buffer.from(hashRaw ?? "", "base64url");
  if (salt.length === 0 || expected.length === 0) return false;
  const derived = (await scrypt(password, salt, expected.length, {
    N: Number(nRaw),
    r: Number(rRaw),
    p: Number(pRaw)
  })) as Buffer;
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export function generateSessionToken(): string {
  return SESSION_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function generateInviteCode(): string {
  return INVITE_CODE_PREFIX + randomBytes(16).toString("base64url");
}

export function sessionTokenHash(token: string): string {
  return sha256Bytes("hunter-harness-session\0" + token);
}

export function inviteCodeHash(code: string): string {
  return sha256Bytes("hunter-harness-invite\0" + code);
}

/** Project-scoped API keys keep the documented `hh_` prefix. */
export const PROJECT_KEY_PREFIX = "hh_";

export function generateProjectApiKey(): string {
  return PROJECT_KEY_PREFIX + randomBytes(24).toString("base64url");
}

export function projectApiKeyHash(key: string): string {
  return sha256Bytes("hunter-harness-project-key\0" + key);
}
