import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";
import { isProxy, isUint8Array } from "node:util/types";

import {
  closePrivateDirectoryAuthority,
  consolidatePrivateDirectoryAuthority,
  listControlledEntries,
  prepareNewLeaf,
  publishControlledFile,
  validatePrivateDirectoryAuthority,
  verifyExistingConsolidated,
} from "../private-directory-authority/index.js";
import type { PrivateDirectoryAuthority } from "../private-directory-authority/types.js";
import type {
  RemoteContentUploadCas,
  RemoteContentUploadCasObject,
  RemoteContentUploadCasOptions,
  RemoteContentUploadCasSealedAttempt,
} from "./ports.js";

const HASH = /^sha256:([a-f0-9]{64})$/u;
const ATTEMPT = /^attempt_[a-f0-9]{32}$/u;
const MAX_BYTES = 512 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const LEAVES = ["attempts", "cas"] as const;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const initializationByRoot = new Map<string, Promise<void>>();
const authorityByRoot = new Map<string, { readonly authority: PrivateDirectoryAuthority; refs: number }>();
const authorityLoadByRoot = new Map<string, Promise<PrivateDirectoryAuthority>>();
const attemptsByRoot = new Map<string, Map<string, AttemptState>>();

function rootKey(root: string): string {
  // Windows paths are case-insensitive.  Use one process-wide key so two
  // adapters opened through differently-cased aliases share both the
  // initialization barrier and active-attempt registry.
  return process.platform === "win32" ? root.toLowerCase() : root;
}

function hashHex(value: string): string {
  const match = HASH.exec(value);
  if (match?.[1] === undefined) throw new Error("REMOTE_CONTENT_UPLOAD_HASH_MISMATCH");
  return match[1];
}

function projectToken(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 160 || value.includes("\0")) {
    throw new Error("REMOTE_CONTENT_UPLOAD_INPUT_INVALID");
  }
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}

function code(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
}

function safeRoot(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.includes("\0")) {
    throw new Error("REMOTE_CONTENT_UPLOAD_STORAGE_INVALID");
  }
  const root = resolve(value);
  if (root === parse(root).root) throw new Error("REMOTE_CONTENT_UPLOAD_STORAGE_INVALID");
  return root;
}

function safeBytes(value: unknown): Uint8Array {
  if (!isUint8Array(value) || isProxy(value) || !Buffer.isBuffer(value) && Object.getPrototypeOf(value) !== Uint8Array.prototype ||
      typedArrayByteLength === undefined) {
    throw new Error("REMOTE_CONTENT_UPLOAD_STREAM_INVALID");
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype) {
      throw new Error("REMOTE_CONTENT_UPLOAD_STREAM_INVALID");
    }
    const length = Reflect.apply(typedArrayByteLength, value, []) as number;
    if (!Number.isSafeInteger(length) || length === 0 || length > CHUNK_BYTES) {
      throw new Error("REMOTE_CONTENT_UPLOAD_STREAM_INVALID");
    }
    const owned = new Uint8Array(length);
    Reflect.apply(Uint8Array.prototype.set, owned, [value]);
    return owned;
  } catch {
    throw new Error("REMOTE_CONTENT_UPLOAD_STREAM_INVALID");
  }
}

interface AttemptState {
  readonly attempt_id: string;
  readonly project_id: string;
  readonly path: string;
  readonly handle: Awaited<ReturnType<typeof open>>;
  bytes: number;
  sealed: RemoteContentUploadCasSealedAttempt | null;
}

async function hashFile(path: string, expectedBytes: number): Promise<Omit<RemoteContentUploadCasObject, "project_id">> {
  const metadata = await lstat(path, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n || metadata.size !== BigInt(expectedBytes)) {
    throw new Error("REMOTE_CONTENT_UPLOAD_STORAGE_INVALID");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.size !== BigInt(expectedBytes) ||
        opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new Error("REMOTE_CONTENT_UPLOAD_STORAGE_INVALID");
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, Math.max(1, expectedBytes)));
    let offset = 0;
    while (offset < expectedBytes) {
      const result = await handle.read(buffer, 0, Math.min(buffer.length, expectedBytes - offset), offset);
      if (result.bytesRead <= 0) throw new Error("REMOTE_CONTENT_UPLOAD_STORAGE_INVALID");
      digest.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    const extra = await handle.read(Buffer.allocUnsafe(1), 0, 1, offset);
    if (extra.bytesRead !== 0) throw new Error("REMOTE_CONTENT_UPLOAD_STORAGE_INVALID");
    return Object.freeze({ sha256: `sha256:${digest.digest("hex")}`, bytes: offset });
  } finally {
    await handle.close();
  }
}

function attemptName(): string {
  return `attempt_${randomBytes(16).toString("hex")}`;
}

async function initializeRoot(root: string): Promise<void> {
  let stagingRoot: string | null = null;
  const setup: PrivateDirectoryAuthority[] = [];
  try {
    // Build in an owner-unique sibling and publish the complete authority
    // with one rename. The per-process barrier around this helper prevents
    // two Windows guardian handoffs from racing on the same canonical root.
    stagingRoot = join(dirname(root), `${basename(root)}.init_${randomBytes(16).toString("hex")}`);
    const rootAuthority = await prepareNewLeaf(dirname(root), basename(stagingRoot));
    setup.push(rootAuthority);
    for (const leaf of LEAVES) setup.push(await prepareNewLeaf(stagingRoot, leaf));
    const stagedAuthority = await consolidatePrivateDirectoryAuthority(rootAuthority, setup.slice(1), LEAVES);
    setup.length = 0;
    try {
      await closePrivateDirectoryAuthority(stagedAuthority);
    } finally {
      await closePrivateDirectoryAuthority(rootAuthority);
    }
    try {
      await rename(stagingRoot, root);
      stagingRoot = null;
    } catch (error) {
      const targetExists = await lstat(root).then(() => true).catch((cause: unknown) => {
        if (code(cause) === "ENOENT") return false;
        throw cause;
      });
      if (!targetExists) throw error;
      const ownedStagingRoot = stagingRoot;
      if (ownedStagingRoot === null) throw error;
      await rm(ownedStagingRoot, { recursive: true, force: true });
      stagingRoot = null;
    }
  } catch (error) {
    await Promise.all(setup.map((item) => closePrivateDirectoryAuthority(item)));
    if (stagingRoot !== null) await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function acquireAuthority(root: string): Promise<PrivateDirectoryAuthority> {
  const key = rootKey(root);
  const cached = authorityByRoot.get(key);
  if (cached !== undefined) {
    cached.refs += 1;
    return cached.authority;
  }
  const loading = authorityLoadByRoot.get(key);
  if (loading !== undefined) {
    const authority = await loading;
    const shared = authorityByRoot.get(key);
    if (shared === undefined || shared.authority !== authority) {
      throw new Error("REMOTE_CONTENT_UPLOAD_STORAGE_UNAVAILABLE");
    }
    shared.refs += 1;
    return authority;
  }
  const created = verifyExistingConsolidated(root, LEAVES);
  authorityLoadByRoot.set(key, created);
  try {
    const authority = await created;
    authorityByRoot.set(key, { authority, refs: 1 });
    return authority;
  } finally {
    if (authorityLoadByRoot.get(key) === created) authorityLoadByRoot.delete(key);
  }
}

async function releaseAuthority(root: string, authority: PrivateDirectoryAuthority): Promise<void> {
  const key = rootKey(root);
  const shared = authorityByRoot.get(key);
  if (shared === undefined || shared.authority !== authority) {
    await closePrivateDirectoryAuthority(authority);
    return;
  }
  shared.refs -= 1;
  if (shared.refs <= 0) {
    authorityByRoot.delete(key);
    attemptsByRoot.delete(key);
    await closePrivateDirectoryAuthority(authority);
  }
}

export async function createRemoteContentUploadLocalCas(
  rawOptions: RemoteContentUploadCasOptions,
): Promise<RemoteContentUploadCas> {
  if (rawOptions === null || typeof rawOptions !== "object" || isProxy(rawOptions)) {
    throw new Error("REMOTE_CONTENT_UPLOAD_STORAGE_INVALID");
  }
  const root = safeRoot(rawOptions.root);
  const key = rootKey(root);
  const existing = await lstat(root).then(() => true).catch((error: unknown) => {
    if (code(error) === "ENOENT") return false;
    throw error;
  });
  if (!existing) {
    const pending = initializationByRoot.get(key);
    if (pending !== undefined) {
      await pending;
    } else {
      const created = initializeRoot(root);
      initializationByRoot.set(key, created);
      try {
        await created;
      } finally {
        if (initializationByRoot.get(key) === created) initializationByRoot.delete(key);
      }
    }
  }
  const authority = await acquireAuthority(root);
  const attempts = attemptsByRoot.get(key) ?? new Map<string, AttemptState>();
  attemptsByRoot.set(key, attempts);
  const ownedAttempts = new Set<string>();
  let closed = false;
  let closing: Promise<void> | null = null;
  const assertLive = (): void => {
    if (closed || !validatePrivateDirectoryAuthority(authority)) {
      throw new Error("REMOTE_CONTENT_UPLOAD_STORAGE_UNAVAILABLE");
    }
  };
  const pathForAttempt = (projectId: string, id: string): string =>
    join(root, "attempts", `${projectToken(projectId)}_${id}.part`);
  const objectPath = (projectId: string, sha256: string): string =>
    join(root, "cas", `${projectToken(projectId)}_${hashHex(sha256)}`);

  const cas: RemoteContentUploadCas = {
    async beginAttempt(input) {
      assertLive();
      const project = projectToken(input.project_id);
      const expectedSha = `sha256:${hashHex(input.expected_sha256)}`;
      if (!Number.isSafeInteger(input.expected_bytes) || input.expected_bytes < 1 || input.expected_bytes > MAX_BYTES) {
        throw new Error("REMOTE_CONTENT_UPLOAD_SIZE_MISMATCH");
      }
      const attempt_id = attemptName();
      const path = pathForAttempt(project, attempt_id);
      const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
      attempts.set(attempt_id, { attempt_id, project_id: input.project_id, path, handle, bytes: 0, sealed: null });
      ownedAttempts.add(attempt_id);
      void expectedSha;
      return Object.freeze({ attempt_id });
    },
    async appendAttempt(attemptId, rawBytes) {
      assertLive();
      if (typeof attemptId !== "string" || !ATTEMPT.test(attemptId)) throw new Error("REMOTE_CONTENT_UPLOAD_INPUT_INVALID");
      const attempt = attempts.get(attemptId);
      if (attempt === undefined || attempt.sealed !== null) throw new Error("REMOTE_CONTENT_UPLOAD_INPUT_INVALID");
      const bytes = safeBytes(rawBytes);
      if (attempt.bytes + bytes.byteLength > MAX_BYTES) throw new Error("REMOTE_CONTENT_UPLOAD_TOO_LARGE");
      const result = await attempt.handle.write(bytes, 0, bytes.byteLength, attempt.bytes);
      if (result.bytesWritten !== bytes.byteLength) throw new Error("REMOTE_CONTENT_UPLOAD_STORAGE_UNAVAILABLE");
      attempt.bytes += result.bytesWritten;
    },
    async abortAttempt(attemptId) {
      assertLive();
      if (typeof attemptId !== "string" || !ATTEMPT.test(attemptId)) return;
      const attempt = attempts.get(attemptId);
      if (attempt === undefined) return;
      attempts.delete(attemptId);
      ownedAttempts.delete(attemptId);
      await attempt.handle.close().catch(() => undefined);
      await rm(attempt.path, { force: true });
    },
    async sealAttempt(attemptId, input) {
      assertLive();
      const attempt = attempts.get(attemptId);
      if (attempt === undefined || attempt.sealed !== null) throw new Error("REMOTE_CONTENT_UPLOAD_INPUT_INVALID");
      const expectedSha = `sha256:${hashHex(input.expected_sha256)}`;
      if (attempt.bytes !== input.expected_bytes) throw new Error("REMOTE_CONTENT_UPLOAD_SIZE_MISMATCH");
      await attempt.handle.sync();
      await attempt.handle.close();
      const actual = await hashFile(attempt.path, input.expected_bytes);
      if (actual.sha256 !== expectedSha || actual.bytes !== input.expected_bytes) {
        await rm(attempt.path, { force: true });
        attempts.delete(attemptId);
        ownedAttempts.delete(attemptId);
        throw new Error("REMOTE_CONTENT_UPLOAD_HASH_MISMATCH");
      }
      attempt.sealed = Object.freeze({ ...actual, project_id: attempt.project_id });
      return attempt.sealed;
    },
    async publishAttempt(attemptId, expected) {
      assertLive();
      const attempt = attempts.get(attemptId);
      if (attempt === undefined || attempt.sealed === null || attempt.project_id !== expected.project_id ||
          attempt.sealed.sha256 !== expected.sha256 ||
          attempt.sealed.bytes !== expected.bytes) throw new Error("REMOTE_CONTENT_UPLOAD_INPUT_INVALID");
      const path = attempt.path;
      const finalName = `${projectToken(expected.project_id)}_${hashHex(expected.sha256)}`;
      const result = await publishControlledFile(authority, {
        controlled_leaf: "cas",
        final_name: finalName,
        expected_sha256: expected.sha256,
        expected_bytes: expected.bytes,
        reader: {
          async read(offset: number, maxBytes: number): Promise<Uint8Array | null> {
            const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
            try {
              const buffer = Buffer.allocUnsafe(Math.min(maxBytes, CHUNK_BYTES));
              const result = await handle.read(buffer, 0, buffer.length, offset);
              return result.bytesRead === 0 ? null : new Uint8Array(buffer.subarray(0, result.bytesRead));
            } finally {
              await handle.close();
            }
          },
        },
      });
      attempts.delete(attemptId);
      ownedAttempts.delete(attemptId);
      await rm(path, { force: true });
      return Object.freeze({ project_id: expected.project_id, sha256: result.sha256 as `sha256:${string}`, bytes: result.bytes });
    },
    async hasObject(input) {
      assertLive();
      const expected = hashHex(input.sha256);
      if (!Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > MAX_BYTES) return false;
      try {
        const actual = await hashFile(objectPath(input.project_id, input.sha256), input.bytes);
        return actual.sha256 === `sha256:${expected}` && actual.bytes === input.bytes;
      } catch (error) {
        if (code(error) === "ENOENT") return false;
        throw error;
      }
    },
    async removeObject(input) {
      assertLive();
      const expected = hashHex(input.sha256);
      const path = objectPath(input.project_id, input.sha256);
      let actual: Omit<RemoteContentUploadCasObject, "project_id">;
      try {
        actual = await hashFile(path, input.bytes);
      } catch (error) {
        if (code(error) === "ENOENT") return;
        throw error;
      }
      if (actual.sha256 !== `sha256:${expected}`) throw new Error("REMOTE_CONTENT_UPLOAD_STORAGE_INVALID");
      await rm(path, { force: true });
    },
    async *readObject(input) {
      assertLive();
      const expected = hashHex(input.sha256);
      const path = objectPath(input.project_id, input.sha256);
      const actual = await hashFile(path, input.bytes);
      if (actual.sha256 !== `sha256:${expected}`) throw new Error("REMOTE_CONTENT_UPLOAD_STORAGE_INVALID");
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        let offset = 0;
        while (offset < input.bytes) {
          assertLive();
          const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, input.bytes - offset));
          const result = await handle.read(buffer, 0, buffer.length, offset);
          if (result.bytesRead <= 0) throw new Error("REMOTE_CONTENT_UPLOAD_STORAGE_INVALID");
          offset += result.bytesRead;
          yield buffer.subarray(0, result.bytesRead);
        }
      } finally {
        await handle.close();
      }
    },
    async cleanupStaleAttempts(input) {
      assertLive();
      const cutoff = Date.parse(input.before);
      if (!Number.isFinite(cutoff)) throw new Error("REMOTE_CONTENT_UPLOAD_INPUT_INVALID");
      const entries = await listControlledEntries(authority, "attempts");
      let removed = 0;
      for (const entry of entries) {
        const match = /^([a-f0-9]{32})_(attempt_[a-f0-9]{32})\.part$/u.exec(entry.name);
        if (entry.kind !== "file" || match?.[2] === undefined || !ATTEMPT.test(match[2]) || attempts.has(match[2])) continue;
        const path = join(root, "attempts", entry.name);
        const metadata = await lstat(path);
        if (metadata.mtimeMs < cutoff) {
          await rm(path, { force: true });
          removed += 1;
        }
      }
      return removed;
    },
    async close() {
      if (closing !== null) return closing;
      closed = true;
      closing = (async () => {
        for (const attemptId of ownedAttempts) {
          const attempt = attempts.get(attemptId);
          if (attempt !== undefined) {
            attempts.delete(attemptId);
            await attempt.handle.close().catch(() => undefined);
          }
        }
        ownedAttempts.clear();
        await releaseAuthority(root, authority);
      })();
      return closing;
    },
  };
  return Object.freeze(cas);
}
