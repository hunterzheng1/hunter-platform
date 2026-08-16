import { createHash, randomUUID, type Hash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  open as openFile,
  realpath,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";
import { isProxy, isUint8Array } from "node:util/types";

import {
  PLATFORM_INFORMATION_EXPORT_LIMITS,
  canonicalJson,
  platformInformationExportArtifactReceiptSchema,
  platformInformationExportDownloadRefSchema,
  platformInformationQuerySchema,
  type PlatformInformationExportArtifactReceipt,
  type PlatformInformationExportChunkReaderPort,
} from "@hunter-harness/contracts";

import type {
  PlatformInformationExportArtifactAppendResult,
  PlatformInformationExportArtifactBeginResult,
  PlatformInformationExportArtifactCommitResult,
  PlatformInformationExportArtifactPort,
  PlatformInformationExportDownloadPort,
  PlatformInformationExportArtifactSection,
} from "./ports.js";
import {
  closePrivateDirectoryAuthority,
  consolidatePrivateDirectoryAuthority,
  listControlledEntries,
  publishControlledFile,
  prepareNewLeaf,
  validatePrivateDirectoryAuthority,
  verifyExistingConsolidated,
} from "../private-directory-authority/index.js";
import { killPrivateDirectoryAuthorityGuardianForTest } from
  "../private-directory-authority/module.js";
import type {
  PrivateDirectoryAuthority,
  PrivateDirectoryControlledEntry,
} from "../private-directory-authority/types.js";

const HASH_PATTERN = /^sha256:([a-f0-9]{64})$/u;
const ATTEMPT_PATTERN = /^attempt_[a-f0-9]{32}$/u;
const AUTHORITY_PUBLISH_TEMP_PATTERN = /^\.hunter-publish-v1-[a-f0-9]{16}-[a-f0-9-]{36}\.tmp$/u;
const SECTIONS = ["manifest", "items", "footer"] as const;
const encoder = new TextEncoder();
const CONTROLLED_DIRECTORIES = ["attempts", "cas", "queries", "exports"] as const;

export interface LocalPlatformInformationExportDownloadRef {
  readonly export_id: string;
  readonly project_id: string;
  readonly content_sha: string;
}

interface Attempt {
  readonly attempt_id: string;
  readonly query_key: string;
  readonly directory: string;
  readonly assembled_path: string;
  readonly metadata: {
    readonly export_id: string;
    readonly created_at: string;
    readonly expires_at: string;
  };
  readonly section_lengths: Record<PlatformInformationExportArtifactSection, number>;
  readonly section_hashes: Record<PlatformInformationExportArtifactSection, Hash>;
  total_length: number;
  sealed: boolean;
  failed: boolean;
  busy: boolean;
  content_sha: string | null;
}

export interface LocalPlatformInformationExportArtifactPort
  extends PlatformInformationExportArtifactPort, PlatformInformationExportDownloadPort {
  /** Resolves only a committed download reference and pre-verifies its CAS object. */
  open(download_ref: LocalPlatformInformationExportDownloadRef): Promise<AsyncIterable<Uint8Array>>;
  /** Invalidates the adapter and releases every private-directory guardian. */
  close(): Promise<void>;
}

export interface LocalPlatformInformationExportArtifactOptions {
  readonly root: string;
  readonly now?: () => string;
  readonly lifetime_ms?: number;
  /** Test seam for post-durability cleanup; production uses recursive attempt cleanup. */
  readonly attempt_cleanup?: (directory: string) => void | Promise<void>;
}

const localAuthorityForTest = new WeakMap<object, PrivateDirectoryAuthority>();

/** Internal focused-test seam. */
export function killLocalPlatformInformationExportAuthorityForTest(value: unknown): void {
  if (value === null || typeof value !== "object" || isProxy(value)) return;
  const authority = localAuthorityForTest.get(value);
  if (authority !== undefined) killPrivateDirectoryAuthorityGuardianForTest(authority);
}

function sha256(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function hashHex(value: string): string {
  const match = HASH_PATTERN.exec(value);
  if (match === null) throw new Error("invalid export hash");
  const hex = match[1];
  if (hex === undefined) throw new Error("invalid export hash");
  return hex;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function ownDataSnapshot(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== "object" || isProxy(value)) return null;
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
  if (prototype !== Object.prototype && prototype !== null) return null;
  const actual = Reflect.ownKeys(descriptors);
  if (actual.some((key) => typeof key !== "string") || actual.length !== keys.length ||
      keys.some((key) => !actual.includes(key))) return null;
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) return null;
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(result);
}

function deepDataSnapshot(value: unknown): unknown | null {
  const seen = new WeakSet<object>();
  let remaining = 20_000;
  const visit = (current: unknown, depth: number): { ok: true; value: unknown } | { ok: false } => {
    remaining -= 1;
    if (remaining < 0 || depth > 32) return { ok: false };
    if (current === null || typeof current === "string" || typeof current === "number" ||
        typeof current === "boolean" || typeof current === "undefined") {
      return { ok: true, value: current };
    }
    if (typeof current !== "object" || isProxy(current) || seen.has(current)) return { ok: false };
    seen.add(current);
    let prototype: object | null;
    let descriptors: PropertyDescriptorMap;
    try {
      prototype = Object.getPrototypeOf(current) as object | null;
      descriptors = Object.getOwnPropertyDescriptors(current);
    } catch {
      return { ok: false };
    }
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) return { ok: false };
    if (Array.isArray(current)) {
      if (prototype !== Array.prototype) return { ok: false };
      const length = descriptors.length;
      if (length === undefined || !("value" in length) || typeof length.value !== "number" ||
          !Number.isSafeInteger(length.value) || length.value < 0 || length.value > remaining ||
          keys.length !== length.value + 1) return { ok: false };
      const copy = new Array<unknown>(length.value);
      for (let index = 0; index < length.value; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !("value" in descriptor)) return { ok: false };
        const nested = visit(descriptor.value, depth + 1);
        if (!nested.ok) return nested;
        copy[index] = nested.value;
      }
      return { ok: true, value: Object.freeze(copy) };
    }
    if (prototype !== Object.prototype && prototype !== null || keys.length > remaining) return { ok: false };
    const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) return { ok: false };
      const nested = visit(descriptor.value, depth + 1);
      if (!nested.ok) return nested;
      Object.defineProperty(copy, key, { value: nested.value, enumerable: true });
    }
    return { ok: true, value: Object.freeze(copy) };
  };
  const result = visit(value, 0);
  return result.ok ? result.value : null;
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await openFile(path, "r");
    await handle.sync();
  } catch (error) {
    const code = error instanceof Error && "code" in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    // Windows does not expose directory handles through fs.open. The file and
    // every publish entry are still flushed; Unix must also flush the directory.
    if (process.platform !== "win32" ||
        !["EACCES", "EPERM", "EBUSY", "EISDIR", "EINVAL"].includes(code ?? "")) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

async function writeAll(
  handle: Awaited<ReturnType<typeof openFile>>,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (written.bytesWritten <= 0) throw new Error("export artifact write made no progress");
    offset += written.bytesWritten;
  }
}

async function assertRegularPrivateFile(path: string, expectedSize?: number): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error("export CAS object is not a private regular file");
  }
  if (expectedSize !== undefined && metadata.size !== expectedSize) {
    throw new Error("export CAS object size mismatch");
  }
  const actual = await realpath(path);
  if (!samePath(actual, path)) throw new Error("export CAS object resolves elsewhere");
}

async function digestFile(path: string, expectedSize: number): Promise<string> {
  await assertRegularPrivateFile(path, expectedSize);
  const before = await lstat(path);
  const handle = await openFile(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== expectedSize ||
        opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("export CAS object changed while opening");
    }
    const hash = createHash("sha256");
    const buffer = new Uint8Array(PLATFORM_INFORMATION_EXPORT_LIMITS.chunk_bytes);
    let offset = 0;
    while (offset < expectedSize) {
      const read = await handle.read(buffer, 0, Math.min(buffer.byteLength, expectedSize - offset), offset);
      if (read.bytesRead <= 0) throw new Error("export CAS object is truncated");
      hash.update(buffer.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    const extra = await handle.read(new Uint8Array(1), 0, 1, offset);
    if (extra.bytesRead !== 0) throw new Error("export CAS object grew while reading");
    return `sha256:${hash.digest("hex")}`;
  } finally {
    await handle.close();
  }
}

async function readReceipt(
  path: string,
  expected?: PrivateDirectoryControlledEntry,
): Promise<PlatformInformationExportArtifactReceipt | null> {
  let before: BigIntStats;
  try {
    await assertRegularPrivateFile(path);
    before = await lstat(path, { bigint: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (before.size > BigInt(PLATFORM_INFORMATION_EXPORT_LIMITS.receipt_bytes)) {
    throw new Error("stored export receipt is too large");
  }
  if (expected !== undefined && (expected.kind !== "file" || BigInt(expected.size) !== before.size ||
      expected.identity.device !== String(before.dev) || expected.identity.file !== String(before.ino))) {
    throw new Error("stored export receipt changed after enumeration");
  }
  const handle = await openFile(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let serialized: string;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.size !== before.size ||
        opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("stored export receipt changed while opening");
    }
    serialized = await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error("stored export receipt is invalid");
  }
  const parsed = platformInformationExportArtifactReceiptSchema.safeParse(raw);
  if (!parsed.success || serialized !== canonicalJson(parsed.data)) {
    throw new Error("stored export receipt is invalid");
  }
  return parsed.data;
}

export async function createLocalPlatformInformationExportArtifactPort(
  rawOptions: LocalPlatformInformationExportArtifactOptions,
): Promise<LocalPlatformInformationExportArtifactPort> {
  const optionKeys = (() => {
    if (rawOptions === null || typeof rawOptions !== "object" || isProxy(rawOptions)) return null;
    let descriptors: PropertyDescriptorMap;
    try { descriptors = Object.getOwnPropertyDescriptors(rawOptions); } catch { return null; }
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string") ||
        keys.some((key) => !["root", "now", "lifetime_ms", "attempt_cleanup"].includes(key as string))) return null;
    return keys as string[];
  })();
  if (optionKeys === null || !optionKeys.includes("root")) {
    throw new Error("invalid export CAS options");
  }
  const options = ownDataSnapshot(rawOptions, optionKeys);
  if (options === null || typeof options.root !== "string" ||
      (Object.hasOwn(options, "now") &&
       (typeof options.now !== "function" || isProxy(options.now))) ||
      (Object.hasOwn(options, "lifetime_ms") && typeof options.lifetime_ms !== "number") ||
      (Object.hasOwn(options, "attempt_cleanup") &&
       (typeof options.attempt_cleanup !== "function" || isProxy(options.attempt_cleanup)))) {
    throw new Error("invalid export CAS options");
  }
  if (typeof options.root !== "string" || options.root.length === 0) {
    throw new Error("export CAS root is required");
  }
  const now = (options.now as (() => string) | undefined) ?? (() => new Date().toISOString());
  const lifetimeMs = (options.lifetime_ms as number | undefined) ?? 24 * 60 * 60 * 1_000;
  const attemptCleanup = (options.attempt_cleanup as ((directory: string) => void | Promise<void>) | undefined)
    ?? ((directory: string) => rm(directory, { recursive: true, force: true }));
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0) throw new Error("invalid export lifetime");
  const root = resolve(options.root);
  if (samePath(root, parse(root).root)) throw new Error("export CAS root cannot be a volume root");
  let existingRoot = true;
  try {
    await lstat(root);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    existingRoot = false;
  }
  const attemptsRoot = join(root, "attempts");
  const casRoot = join(root, "cas");
  const queriesRoot = join(root, "queries");
  const exportsRoot = join(root, "exports");
  const setupAuthorities: PrivateDirectoryAuthority[] = [];
  let authority: PrivateDirectoryAuthority;
  let parentAuthority: PrivateDirectoryAuthority | null = null;
  try {
    if (existingRoot) {
      authority = await verifyExistingConsolidated(root, CONTROLLED_DIRECTORIES);
    } else {
      const rootAuthority = await prepareNewLeaf(dirname(root), basename(root));
      setupAuthorities.push(rootAuthority);
      for (const leaf of CONTROLLED_DIRECTORIES) {
        setupAuthorities.push(await prepareNewLeaf(root, leaf));
      }
      authority = await consolidatePrivateDirectoryAuthority(
        rootAuthority,
        setupAuthorities.slice(1),
        CONTROLLED_DIRECTORIES,
      );
      parentAuthority = rootAuthority;
      setupAuthorities.length = 0;
    }
  } catch (error) {
    await Promise.all(setupAuthorities.splice(0).map(closePrivateDirectoryAuthority));
    if (!existingRoot) {
      try { await rm(root, { recursive: true, force: true }); } catch { /* best-effort setup cleanup */ }
    }
    throw error;
  }

  const attempts = new Map<string, Attempt>();
  const metadataByQuery = new Map<string, Attempt["metadata"]>();
  const completedAttempts = new Map<string, {
    readonly query_key: string;
    readonly canonical_receipt: string;
    readonly receipt: PlatformInformationExportArtifactReceipt;
  }>();
  const commitTails = new Map<string, Promise<void>>();
  let closing = false;
  let closePromise: Promise<void> | null = null;
  let activeOperations = 0;
  let operationsDrained: (() => void) | null = null;
  function assertAuthorityAlive(): void {
    if (!validatePrivateDirectoryAuthority(authority) ||
        (parentAuthority !== null && !validatePrivateDirectoryAuthority(parentAuthority))) {
      throw new Error("export CAS private directory authority is unavailable");
    }
  }

  function assertAuthority(): void {
    if (closing) throw new Error("export CAS private directory authority is unavailable");
    assertAuthorityAlive();
  }

  function enterOperation(): () => void {
    assertAuthority();
    activeOperations += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      activeOperations -= 1;
      if (activeOperations === 0) {
        const resolveDrained = operationsDrained;
        operationsDrained = null;
        resolveDrained?.();
      }
    };
  }

  async function waitForOperationsToDrain(): Promise<void> {
    if (activeOperations === 0) return;
    await new Promise<void>((resolveDrained) => { operationsDrained = resolveDrained; });
  }

  async function runCommitExclusive<T>(queryKey: string, operation: () => Promise<T>): Promise<T> {
    const predecessor = commitTails.get(queryKey) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const tail = predecessor.then(() => gate);
    commitTails.set(queryKey, tail);
    await predecessor;
    try {
      assertAuthorityAlive();
      return await operation();
    } finally {
      release();
      if (commitTails.get(queryKey) === tail) commitTails.delete(queryKey);
    }
  }

  function queryReceiptPath(queryKey: string): string {
    return join(queriesRoot, `${hashHex(queryKey)}.json`);
  }

  function exportReceiptPath(exportId: string): string {
    return join(exportsRoot, `${sha256(`export-id\0${exportId}`).slice("sha256:".length)}.json`);
  }

  function artifactPath(contentSha: string): string {
    const hex = hashHex(contentSha);
    return join(casRoot, `${hex}.jsonl`);
  }

  async function scanDurableReceipts(
    leaf: "queries" | "exports",
  ): Promise<ReadonlyMap<string, PlatformInformationExportArtifactReceipt>> {
    assertAuthorityAlive();
    const entries = await listControlledEntries(authority, leaf);
    const receipts = new Map<string, PlatformInformationExportArtifactReceipt>();
    for (const entry of entries) {
      assertAuthorityAlive();
      if (entry.name === ".hunter-private-directory-authority-v1" ||
          AUTHORITY_PUBLISH_TEMP_PATTERN.test(entry.name)) {
        if (entry.kind !== "file") throw new Error("stored export receipt authority is invalid");
        continue;
      }
      if (entry.kind !== "file" || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) {
        throw new Error("stored export receipt authority is invalid");
      }
      const receipt = await readReceipt(join(leaf === "queries" ? queriesRoot : exportsRoot, entry.name), entry);
      if (receipt === null) throw new Error("stored export receipt disappeared after enumeration");
      if (leaf === "exports" && basename(exportReceiptPath(receipt.export_id)) !== entry.name) {
        throw new Error("stored export receipt is bound to a different export path");
      }
      receipts.set(entry.name, receipt);
    }
    return receipts;
  }

  async function readDurableReceipt(
    leaf: "queries" | "exports",
    path: string,
  ): Promise<PlatformInformationExportArtifactReceipt | null> {
    return (await scanDurableReceipts(leaf)).get(basename(path)) ?? null;
  }

  async function hasAnyDurableReadyReference(contentSha: string): Promise<boolean> {
    for (const leaf of ["queries", "exports"] as const) {
      for (const receipt of (await scanDurableReceipts(leaf)).values()) {
        if (receipt.artifact.content_sha === contentSha) return true;
      }
    }
    return false;
  }

  async function publishReceipt(
    controlledLeaf: "queries" | "exports",
    finalName: string,
    path: string,
    bytes: Uint8Array,
  ): Promise<PlatformInformationExportArtifactReceipt> {
    assertAuthorityAlive();
    const expectedSha = sha256(bytes);
    const reader = Object.freeze({
      async read(offset: number, maxBytes: number): Promise<Uint8Array | null> {
        assertAuthorityAlive();
        if (offset === bytes.byteLength) return null;
        return bytes.slice(offset, Math.min(bytes.byteLength, offset + maxBytes));
      },
    });
    await publishControlledFile(authority, {
      controlled_leaf: controlledLeaf,
      final_name: finalName,
      expected_sha256: expectedSha,
      expected_bytes: bytes.byteLength,
      reader,
    });
    assertAuthorityAlive();
    const existing = await readReceipt(path);
    if (existing === null) throw new Error("stored export receipt disappeared");
    return existing;
  }

  async function publishArtifact(input: {
    readonly source: string;
    readonly final_name: string;
    readonly expected_size: number;
    readonly expected_hash: string;
  }): Promise<void> {
    assertAuthorityAlive();
    const before = await lstat(input.source);
    if (!before.isFile() || before.nlink !== 1 || before.size !== input.expected_size) {
      throw new Error("staging artifact is invalid");
    }
    const handle = await openFile(input.source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.size !== before.size ||
          opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Error("staging artifact changed while opening");
      }
      const reader = Object.freeze({
        async read(offset: number, maxBytes: number): Promise<Uint8Array | null> {
          assertAuthorityAlive();
          const current = await handle.stat();
          if (!current.isFile() || current.nlink !== 1 || current.size !== opened.size ||
              current.dev !== opened.dev || current.ino !== opened.ino) {
            throw new Error("staging artifact changed during publication");
          }
          if (offset === input.expected_size) return null;
          const buffer = new Uint8Array(Math.min(maxBytes, input.expected_size - offset));
          const read = await handle.read(buffer, 0, buffer.byteLength, offset);
          if (read.bytesRead <= 0) throw new Error("staging artifact is truncated");
          return buffer.slice(0, read.bytesRead);
        },
      });
      const result = await publishControlledFile(authority, {
        controlled_leaf: "cas",
        final_name: input.final_name,
        expected_sha256: input.expected_hash,
        expected_bytes: input.expected_size,
        reader,
      });
      if (result.outcome === "existing_different") {
        throw new Error("stored export CAS object is corrupt");
      }
    } finally {
      await handle.close();
    }
  }

  function requiredAttempt(attemptId: string): Attempt {
    if (!ATTEMPT_PATTERN.test(attemptId)) throw new Error("invalid export attempt id");
    const attempt = attempts.get(attemptId);
    if (attempt === undefined) throw new Error("unknown export attempt");
    return attempt;
  }

  async function readStaged(attemptId: string, offset: number): Promise<Uint8Array | null> {
    assertAuthority();
    const attempt = requiredAttempt(attemptId);
    if (!attempt.sealed || attempt.failed) throw new Error("staging artifact is not sealed");
    if (offset === attempt.total_length) return null;
    await assertRegularPrivateFile(attempt.assembled_path, attempt.total_length);
    const handle = await openFile(attempt.assembled_path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const buffer = new Uint8Array(Math.min(
        PLATFORM_INFORMATION_EXPORT_LIMITS.chunk_bytes,
        attempt.total_length - offset,
      ));
      const read = await handle.read(buffer, 0, buffer.byteLength, offset);
      if (read.bytesRead <= 0) throw new Error("staging artifact is truncated");
      return buffer.slice(0, read.bytesRead);
    } finally {
      await handle.close();
    }
  }

  const port: LocalPlatformInformationExportArtifactPort = {
    async begin(rawInput): Promise<PlatformInformationExportArtifactBeginResult> {
      const leaveOperation = enterOperation();
      try {
      const input = ownDataSnapshot(rawInput, ["query_key", "query"]);
      if (input === null || typeof input.query_key !== "string" ||
          input.query === null || typeof input.query !== "object") {
        throw new Error("invalid export begin input");
      }
      hashHex(input.query_key);
      const querySnapshot = deepDataSnapshot(input.query);
      const parsedQuery = platformInformationQuerySchema.safeParse(querySnapshot);
      if (!parsedQuery.success || sha256(encoder.encode(canonicalJson(parsedQuery.data))) !== input.query_key) {
        throw new Error("invalid export begin input");
      }
      let metadata = metadataByQuery.get(input.query_key);
      if (metadata === undefined) {
        const exportId = `export_${hashHex(input.query_key).slice(0, 32)}`;
        const queryPath = queryReceiptPath(input.query_key);
        let prior = await readDurableReceipt("queries", queryPath);
        if (prior !== null && prior.export_id !== exportId) {
          throw new Error("stored query receipt is bound to a different export");
        }
        if (prior === null) {
          prior = await readDurableReceipt("exports", exportReceiptPath(exportId));
          if (prior !== null && prior.export_id !== exportId) {
            throw new Error("stored export receipt is bound to a different export");
          }
        }
        if (prior !== null) {
          metadata = {
            export_id: prior.export_id,
            created_at: prior.created_at,
            expires_at: prior.expires_at,
          };
        } else {
          const created_at = now();
          const parsedCreatedAt = Date.parse(created_at);
          if (!Number.isFinite(parsedCreatedAt)) throw new Error("invalid export clock");
          metadata = {
            export_id: exportId,
            created_at,
            expires_at: new Date(parsedCreatedAt + lifetimeMs).toISOString(),
          };
        }
        metadataByQuery.set(input.query_key, metadata);
      }
      const attempt_id = `attempt_${randomUUID().replaceAll("-", "")}`;
      const directory = join(attemptsRoot, attempt_id);
      assertAuthorityAlive();
      await mkdir(directory, { recursive: false, mode: 0o700 });
      try {
        for (const section of SECTIONS) {
          assertAuthorityAlive();
          const handle = await openFile(join(directory, `${section}.part`), "wx", 0o600);
          try { await handle.sync(); } finally { await handle.close(); }
        }
        await syncDirectory(directory);
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
      const attempt: Attempt = {
        attempt_id,
        query_key: input.query_key,
        directory,
        assembled_path: join(directory, "artifact.sealed"),
        metadata,
        section_lengths: { manifest: 0, items: 0, footer: 0 },
        section_hashes: {
          manifest: createHash("sha256"),
          items: createHash("sha256"),
          footer: createHash("sha256"),
        },
        total_length: 0,
        sealed: false,
        failed: false,
        busy: false,
        content_sha: null,
      };
      attempts.set(attempt_id, attempt);
      let offset = 0;
      return Object.freeze({
        attempt_id,
        ...metadata,
        staged_reader: Object.freeze<PlatformInformationExportChunkReaderPort>({
           async read() {
             const leaveRead = enterOperation();
             try {
               const chunk = await readStaged(attempt_id, offset);
               if (chunk !== null) offset += chunk.byteLength;
               return chunk;
             } finally {
               leaveRead();
             }
           },
         }),
       });
      } finally {
        leaveOperation();
      }
    },

    async append(rawInput): Promise<PlatformInformationExportArtifactAppendResult> {
      const leaveOperation = enterOperation();
      try {
      const input = ownDataSnapshot(rawInput, ["attempt_id", "section", "chunk", "seal"]);
      if (input === null || typeof input.attempt_id !== "string" ||
          !SECTIONS.includes(input.section as PlatformInformationExportArtifactSection) ||
          typeof input.seal !== "boolean" || input.chunk === null ||
          typeof input.chunk !== "object" || isProxy(input.chunk) || !isUint8Array(input.chunk)) {
        throw new Error("invalid export append input");
      }
      const attempt = requiredAttempt(input.attempt_id);
      if (attempt.busy || attempt.sealed || attempt.failed) throw new Error("invalid export append state");
      let chunk: Uint8Array;
      try { chunk = new Uint8Array(input.chunk as Uint8Array); } catch {
        throw new Error("invalid export append chunk");
      }
      if (chunk.byteLength < 1 || chunk.byteLength > PLATFORM_INFORMATION_EXPORT_LIMITS.chunk_bytes ||
          attempt.total_length + chunk.byteLength > PLATFORM_INFORMATION_EXPORT_LIMITS.artifact_bytes ||
          (input.seal && input.section !== "footer")) {
        throw new Error("invalid export append");
      }
      attempt.busy = true;
      try {
        const section = input.section as PlatformInformationExportArtifactSection;
        const path = join(attempt.directory, `${section}.part`);
        assertAuthorityAlive();
        await assertRegularPrivateFile(path, attempt.section_lengths[section]);
        const before = await lstat(path);
        const handle = await openFile(
          path,
          constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0),
        );
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.nlink !== 1 ||
              opened.size !== attempt.section_lengths[section] ||
              opened.dev !== before.dev || opened.ino !== before.ino) {
            throw new Error("export section changed while opening");
          }
          await writeAll(handle, chunk);
          await handle.sync();
        } finally {
          await handle.close();
        }
        attempt.section_hashes[section].update(chunk);
        attempt.section_lengths[section] += chunk.byteLength;
        attempt.total_length += chunk.byteLength;
        if (!input.seal) return { sealed: false, content_sha: null, byte_count: null };
        if (attempt.section_lengths.manifest === 0 || attempt.section_lengths.footer === 0) {
          throw new Error("sealed export requires manifest and footer");
        }
        assertAuthorityAlive();
        const assembled = await openFile(attempt.assembled_path, "wx", 0o600);
        const digest = createHash("sha256");
        let byteCount = 0;
        try {
          for (const current of SECTIONS) {
            if (attempt.section_lengths[current] === 0) continue;
            const sourcePath = join(attempt.directory, `${current}.part`);
            assertAuthorityAlive();
            await assertRegularPrivateFile(sourcePath, attempt.section_lengths[current]);
            const source = await openFile(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
            const sectionDigest = createHash("sha256");
            try {
              const buffer = new Uint8Array(PLATFORM_INFORMATION_EXPORT_LIMITS.chunk_bytes);
              let sourceOffset = 0;
              while (sourceOffset < attempt.section_lengths[current]) {
                const read = await source.read(
                  buffer,
                  0,
                  Math.min(buffer.byteLength, attempt.section_lengths[current] - sourceOffset),
                  sourceOffset,
                );
                if (read.bytesRead <= 0) throw new Error("export section is truncated");
                const bytes = buffer.subarray(0, read.bytesRead);
                await writeAll(assembled, bytes);
                digest.update(bytes);
                sectionDigest.update(bytes);
                byteCount += read.bytesRead;
                sourceOffset += read.bytesRead;
              }
            } finally {
              await source.close();
            }
            if (sectionDigest.digest("hex") !== attempt.section_hashes[current].digest("hex")) {
              throw new Error("export section hash mismatch");
            }
          }
          await assembled.sync();
        } finally {
          await assembled.close();
        }
        if (byteCount !== attempt.total_length) throw new Error("export assembly length mismatch");
        await syncDirectory(attempt.directory);
        attempt.content_sha = `sha256:${digest.digest("hex")}`;
        attempt.sealed = true;
        return { sealed: true, content_sha: attempt.content_sha, byte_count: byteCount };
      } catch (error) {
        attempt.failed = true;
        throw error;
      } finally {
        attempt.busy = false;
      }
      } finally {
        leaveOperation();
      }
    },

    async commit(rawInput): Promise<PlatformInformationExportArtifactCommitResult> {
      const leaveOperation = enterOperation();
      try {
      const input = ownDataSnapshot(rawInput, ["attempt_id", "query_key", "serialized_receipt"]);
      if (input === null || typeof input.attempt_id !== "string" ||
          typeof input.query_key !== "string" || typeof input.serialized_receipt !== "string") {
        throw new Error("invalid export commit input");
      }
      const attemptId = input.attempt_id;
      const queryKey = input.query_key;
      const serializedReceipt = input.serialized_receipt;
      hashHex(queryKey);
      return await runCommitExclusive(queryKey, async () => {
      let rawReceipt: unknown;
      try { rawReceipt = JSON.parse(serializedReceipt) as unknown; } catch {
        throw new Error("invalid export receipt");
      }
      const parsed = platformInformationExportArtifactReceiptSchema.safeParse(rawReceipt);
      if (!parsed.success) {
        throw new Error("invalid export receipt");
      }
      const canonicalReceipt = canonicalJson(parsed.data);
      const completed = completedAttempts.get(attemptId);
      if (completed !== undefined) {
        if (completed.query_key !== queryKey || completed.canonical_receipt !== canonicalReceipt) {
          throw new Error("completed export attempt does not match retry");
        }
        return { ok: true, receipt: completed.receipt };
      }
      const attempt = requiredAttempt(attemptId);
      if (!attempt.sealed || attempt.failed || attempt.busy || attempt.query_key !== queryKey ||
          attempt.content_sha === null) throw new Error("unsealed or mismatched export attempt");
      if (parsed.data.export_id !== attempt.metadata.export_id) throw new Error("invalid export receipt");
      const casPath = artifactPath(parsed.data.artifact.content_sha);
      let stagedExists = true;
      let actualHash: string;
      try {
        assertAuthorityAlive();
        actualHash = await digestFile(attempt.assembled_path, parsed.data.artifact.byte_count);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        stagedExists = false;
        assertAuthorityAlive();
        actualHash = await digestFile(casPath, parsed.data.artifact.byte_count);
      }
      if (actualHash !== parsed.data.artifact.content_sha || actualHash !== attempt.content_sha ||
          parsed.data.download_ref.content_sha !== actualHash) {
        throw new Error("commit receipt does not match staged artifact");
      }

      const queryPath = queryReceiptPath(queryKey);
      const prior = await readDurableReceipt("queries", queryPath);
      const priorExport = await readDurableReceipt("exports", exportReceiptPath(parsed.data.export_id));
      if (prior !== null && canonicalJson(prior) !== canonicalReceipt) {
        return { ok: false, reason_code: "different_output" };
      }
      if (priorExport !== null && canonicalJson(priorExport) !== canonicalReceipt) {
        throw new Error("export identifier already references different output");
      }
      const hasReadyReference = await hasAnyDurableReadyReference(actualHash);
      if (stagedExists) {
        if (hasReadyReference) {
          assertAuthorityAlive();
          const storedHash = await digestFile(casPath, parsed.data.artifact.byte_count);
          if (storedHash !== actualHash) throw new Error("stored export CAS object is corrupt");
        } else {
          await publishArtifact({
            source: attempt.assembled_path,
            final_name: basename(casPath),
            expected_size: parsed.data.artifact.byte_count,
            expected_hash: actualHash,
          });
        }
      } else {
        assertAuthorityAlive();
        const storedHash = await digestFile(casPath, parsed.data.artifact.byte_count);
        if (storedHash !== actualHash) throw new Error("stored export CAS object is corrupt");
      }
      const receiptBytes = encoder.encode(canonicalReceipt);
      if (prior === null) {
        const winner = await publishReceipt("queries", basename(queryPath), queryPath, receiptBytes);
        if (canonicalJson(winner) !== canonicalReceipt) {
          return { ok: false, reason_code: "different_output" };
        }
      }
      const exportPath = exportReceiptPath(parsed.data.export_id);
      const exportWinner = await publishReceipt("exports", basename(exportPath), exportPath, receiptBytes);
      if (canonicalJson(exportWinner) !== canonicalReceipt) {
        throw new Error("export identifier already references different output");
      }
      completedAttempts.set(attempt.attempt_id, {
        query_key: queryKey,
        canonical_receipt: canonicalReceipt,
        receipt: parsed.data,
      });
      if (completedAttempts.size > 1_024) {
        const oldest = completedAttempts.keys().next().value as string | undefined;
        if (oldest !== undefined) completedAttempts.delete(oldest);
      }
      attempts.delete(attempt.attempt_id);
      try { await attemptCleanup(attempt.directory); } catch { /* durable success; orphan collector retries */ }
      return { ok: true, receipt: parsed.data };
      });
      } finally {
        leaveOperation();
      }
    },

    async abort(rawInput): Promise<void> {
      const leaveOperation = enterOperation();
      try {
      const input = ownDataSnapshot(rawInput, ["attempt_id"]);
      if (input === null || typeof input.attempt_id !== "string" || !ATTEMPT_PATTERN.test(input.attempt_id)) {
        throw new Error("invalid export abort input");
      }
      const attempt = attempts.get(input.attempt_id);
      if (attempt === undefined) return;
      if (attempt.busy) throw new Error("export attempt is busy");
      attempts.delete(input.attempt_id);
      assertAuthorityAlive();
      await rm(attempt.directory, { recursive: true, force: true });
      } finally {
        leaveOperation();
      }
    },

    async open(rawDownloadRef): Promise<AsyncIterable<Uint8Array>> {
      const leaveOperation = enterOperation();
      try {
      const snapshot = ownDataSnapshot(rawDownloadRef, ["export_id", "project_id", "content_sha"]);
      if (snapshot === null) throw new Error("invalid export download reference");
      const parsedRef = platformInformationExportDownloadRefSchema.safeParse(snapshot);
      if (!parsedRef.success) throw new Error("invalid export download reference");
      assertAuthorityAlive();
      const receipt = await readDurableReceipt("exports", exportReceiptPath(parsedRef.data.export_id));
      if (receipt === null || canonicalJson(receipt.download_ref) !== canonicalJson(parsedRef.data)) {
        throw new Error("export artifact not found");
      }
      const path = artifactPath(receipt.artifact.content_sha);
      const expectedSize = receipt.artifact.byte_count;
      const expectedHash = receipt.artifact.content_sha;
      assertAuthorityAlive();
      await assertRegularPrivateFile(path, expectedSize);

       return Object.freeze({
         async *[Symbol.asyncIterator]() {
           const leaveIteration = enterOperation();
            try {
            assertAuthorityAlive();
            await assertRegularPrivateFile(path, expectedSize);
           assertAuthorityAlive();
           const before = await lstat(path);
           assertAuthorityAlive();
           const handle = await openFile(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
           try {
             assertAuthorityAlive();
             const opened = await handle.stat();
            if (!opened.isFile() || opened.nlink !== 1 || opened.size !== expectedSize ||
                opened.dev !== before.dev || opened.ino !== before.ino) {
              throw new Error("stored export CAS object changed while opening");
            }
            const hash = createHash("sha256");
            const verifyBuffer = new Uint8Array(PLATFORM_INFORMATION_EXPORT_LIMITS.chunk_bytes);
             let offset = 0;
             while (offset < expectedSize) {
               assertAuthorityAlive();
               const read = await handle.read(
                verifyBuffer,
                0,
                Math.min(verifyBuffer.byteLength, expectedSize - offset),
                offset,
              );
              if (read.bytesRead <= 0) throw new Error("stored export CAS object is truncated");
               hash.update(verifyBuffer.subarray(0, read.bytesRead));
               offset += read.bytesRead;
             }
             assertAuthorityAlive();
             const extra = await handle.read(new Uint8Array(1), 0, 1, offset);
            if (extra.bytesRead !== 0 || `sha256:${hash.digest("hex")}` !== expectedHash) {
              throw new Error("stored export CAS object is corrupt");
            }
             offset = 0;
             while (offset < expectedSize) {
               assertAuthorityAlive();
               const buffer = new Uint8Array(Math.min(
                PLATFORM_INFORMATION_EXPORT_LIMITS.chunk_bytes,
                expectedSize - offset,
              ));
              const read = await handle.read(buffer, 0, buffer.byteLength, offset);
              if (read.bytesRead <= 0) throw new Error("stored export CAS object is truncated");
               const chunk = buffer.slice(0, read.bytesRead);
               offset += read.bytesRead;
               assertAuthorityAlive();
               yield chunk;
            }
           } finally {
             await handle.close();
           }
           } finally {
             leaveIteration();
           }
         },
       });
      } finally {
        leaveOperation();
      }
    },

    close(): Promise<void> {
      if (closePromise !== null) return closePromise;
      closing = true;
      closePromise = (async () => {
        await waitForOperationsToDrain();
        await Promise.allSettled([...commitTails.values()]);
        const attemptDirectories = [...attempts.values()].map((attempt) => attempt.directory);
        attempts.clear();
        try {
          await Promise.allSettled(attemptDirectories.map((directory) =>
            rm(directory, { recursive: true, force: true })));
        } finally {
          await closePrivateDirectoryAuthority(authority);
          if (parentAuthority !== null) await closePrivateDirectoryAuthority(parentAuthority);
        }
      })();
      return closePromise;
    },
  };
  localAuthorityForTest.set(port, authority);
  return Object.freeze(port);
}
