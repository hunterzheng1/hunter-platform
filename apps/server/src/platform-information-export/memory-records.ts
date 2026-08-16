import { createHash, randomBytes } from "node:crypto";
import { isProxy } from "node:util/types";
import { z } from "zod";

import {
  canonicalJson,
  platformInformationExportArtifactReceiptSchema,
  type PlatformInformationExportArtifactReceipt,
} from "@hunter-harness/contracts";

import type { PlatformInformationExportRecordPort } from "./ports.js";
import type {
  PlatformInformationExportRecord,
  PlatformInformationExportRecordAckResult,
  PlatformInformationExportRecordClaimResult,
  PlatformInformationExportRecordDownloadResult,
  PlatformInformationExportRecordFindResult,
  PlatformInformationExportRecordPublishResult,
} from "./types.js";

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const PROJECT_ID_PATTERN = /^prj_[A-Za-z0-9_-]{1,156}$/u;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MAX_EXPIRE_PAGE = 1_000;
const MAX_LEASE_MILLISECONDS = 24 * 60 * 60 * 1_000;
const INPUT_INVALID = "PLATFORM_INFORMATION_EXPORT_RECORD_INPUT_INVALID";
const timestampSchema = z.iso.datetime({ offset: true });

type SnapshotResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

function invalid(): never {
  throw new Error(INPUT_INVALID);
}

function deepDataSnapshot(value: unknown): unknown {
  const seen = new WeakSet<object>();
  let remainingNodes = 100_000;
  let remainingCharacters = 2_000_000;
  const visit = (current: unknown, depth: number): SnapshotResult => {
    remainingNodes -= 1;
    if (remainingNodes < 0 || depth > 32) return { ok: false };
    if (current === null || typeof current === "boolean" || typeof current === "undefined") {
      return { ok: true, value: current };
    }
    if (typeof current === "number") {
      return Number.isFinite(current) ? { ok: true, value: current } : { ok: false };
    }
    if (typeof current === "string") {
      remainingCharacters -= current.length;
      return remainingCharacters >= 0 ? { ok: true, value: current } : { ok: false };
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
      const lengthDescriptor = descriptors.length;
      if (prototype !== Array.prototype || lengthDescriptor === undefined || !("value" in lengthDescriptor) ||
          !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
          lengthDescriptor.value > 10_000 || lengthDescriptor.value > remainingNodes ||
          keys.length !== lengthDescriptor.value + 1) return { ok: false };
      const copy = new Array<unknown>(lengthDescriptor.value as number);
      for (let index = 0; index < copy.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
          return { ok: false };
        }
        const nested = visit(descriptor.value, depth + 1);
        if (!nested.ok) return nested;
        copy[index] = nested.value;
      }
      return { ok: true, value: Object.freeze(copy) };
    }
    if ((prototype !== Object.prototype && prototype !== null) || keys.length > remainingNodes) {
      return { ok: false };
    }
    const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (key === "__proto__" || descriptor === undefined || !("value" in descriptor) ||
          descriptor.enumerable !== true) return { ok: false };
      const nested = visit(descriptor.value, depth + 1);
      if (!nested.ok) return nested;
      Object.defineProperty(copy, key, {
        value: nested.value,
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return { ok: true, value: Object.freeze(copy) };
  };
  const result = visit(value, 0);
  if (!result.ok) invalid();
  return result.value;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  const snapshot = deepDataSnapshot(value);
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) invalid();
  const actual = Object.keys(snapshot);
  if (actual.length < keys.length || keys.some((key) => !Object.hasOwn(snapshot, key)) ||
      actual.some((key) => !keys.includes(key) && !optional.includes(key))) invalid();
  return snapshot as Readonly<Record<string, unknown>>;
}

function identity(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 160) invalid();
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) invalid();
      index += 1;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) invalid();
  }
  return value;
}

function projectIdentity(value: unknown): string {
  if (typeof value !== "string" || !PROJECT_ID_PATTERN.test(value)) invalid();
  return value;
}

function hash(value: unknown): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) invalid();
  return value;
}

function timestamp(value: unknown): { readonly source: string; readonly milliseconds: number } {
  if (typeof value !== "string" || value.length > 40 || !timestampSchema.safeParse(value).success) invalid();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) invalid();
  return { source: value, milliseconds };
}

function freezeRecord(value: unknown): PlatformInformationExportRecord {
  const record = exactRecord(value, ["actor_id", "idempotency_key", "query_hash", "receipt"]);
  const actorId = identity(record.actor_id);
  const idempotencyKey = hash(record.idempotency_key);
  const queryHash = hash(record.query_hash);
  const rawReceipt = exactRecord(record.receipt, ["schema_version", "contract_kind", "export_id",
    "project_id", "view", "range", "m4_proof", "proof_sha", "artifact", "download_ref", "status",
    "created_at", "expires_at"]);
  identity(rawReceipt.export_id);
  const rawDownload = exactRecord(rawReceipt.download_ref, ["export_id", "project_id", "content_sha"]);
  identity(rawDownload.export_id);
  const parsed = platformInformationExportArtifactReceiptSchema.safeParse(rawReceipt);
  if (!parsed.success || parsed.data.range.query_scope.actor_id !== actorId) invalid();
  const expectedQueryHash = `sha256:${createHash("sha256").update(canonicalJson({
    schema_version: 1,
    contract_kind: "query",
    view: parsed.data.view,
    project_id: parsed.data.project_id,
    query_scope: parsed.data.range.query_scope,
    limit: parsed.data.range.limit,
    cursor: parsed.data.range.source_cursor,
    cursor_verification: parsed.data.range.cursor_verification,
    sort: parsed.data.range.sort,
  })).digest("hex")}`;
  if (queryHash !== expectedQueryHash) invalid();
  const receipt = deepDataSnapshot(parsed.data) as PlatformInformationExportArtifactReceipt;
  return Object.freeze({
    actor_id: actorId,
    idempotency_key: idempotencyKey,
    query_hash: queryHash,
    receipt,
  });
}

function frozen<const T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

interface StoredRecord {
  readonly record: PlatformInformationExportRecord;
  readonly key: string;
  readonly created_ms: number;
  readonly expires_ms: number;
  gc_acknowledged: boolean;
  active_batch_id: string | null;
}

interface ClaimBatch {
  readonly batch_id: string;
  readonly worker_id: string;
  readonly lease_ms: number;
  readonly records: readonly StoredRecord[];
  readonly request_key: string;
  readonly refs: readonly PlatformInformationExportArtifactReceipt["download_ref"][];
  readonly next_cursor: string | null;
  acked: boolean;
}

interface CursorCapability {
  readonly now_ms: number;
  readonly expires_ms: number;
  readonly export_id: string;
}

export interface MemoryPlatformInformationExportRecordPort
  extends PlatformInformationExportRecordPort {
  readonly metrics: { stored_records: number };
  /** Test-only equivalent of the future PostgreSQL project FK cascade. */
  purgeProjectForTest(project_id: string): number;
}

export function createMemoryPlatformInformationExportRecordPort():
MemoryPlatformInformationExportRecordPort {
  const byKey = new Map<string, StoredRecord>();
  const byExport = new Map<string, StoredRecord>();
  const batches = new Map<string, ClaimBatch>();
  const cursorByToken = new Map<string, CursorCapability>();
  const tokenByCapability = new Map<string, string>();
  const metrics = { stored_records: 0 };

  const keyFor = (actorId: string, projectId: string, idempotencyKey: string): string =>
    `${actorId}\0${projectId}\0${idempotencyKey}`;

  function cursorFor(capability: CursorCapability): string {
    const key = canonicalJson(capability);
    const prior = tokenByCapability.get(key);
    if (prior !== undefined) return prior;
    let token: string;
    do token = randomBytes(32).toString("base64url");
    while (cursorByToken.has(token));
    cursorByToken.set(token, Object.freeze({ ...capability }));
    tokenByCapability.set(key, token);
    return token;
  }

  const port: MemoryPlatformInformationExportRecordPort = {
    metrics,
    async findReadyByIdempotency(rawInput): Promise<PlatformInformationExportRecordFindResult> {
      const input = exactRecord(rawInput, ["actor_id", "project_id", "idempotency_key", "query_hash", "now"]);
      const actorId = identity(input.actor_id);
      const projectId = projectIdentity(input.project_id);
      const idempotencyKey = hash(input.idempotency_key);
      const queryHash = hash(input.query_hash);
      const now = timestamp(input.now);
      const stored = byKey.get(keyFor(actorId, projectId, idempotencyKey));
      if (stored === undefined) return frozen({ status: "not_found" });
      if (stored.record.query_hash !== queryHash) {
        return frozen({ status: "conflict", reason_code: "different_query" });
      }
      if (stored.expires_ms <= now.milliseconds || stored.gc_acknowledged) {
        return frozen({ status: "expired" });
      }
      return frozen({ status: "ready", record: stored.record });
    },
    async publishReady(rawRecord): Promise<PlatformInformationExportRecordPublishResult> {
      const record = freezeRecord(rawRecord);
      const created = timestamp(record.receipt.created_at);
      const expires = timestamp(record.receipt.expires_at);
      if (created.milliseconds >= expires.milliseconds) invalid();
      const key = keyFor(record.actor_id, record.receipt.project_id, record.idempotency_key);
      const prior = byKey.get(key);
      if (prior !== undefined) {
        if (prior.record.query_hash !== record.query_hash) {
          return frozen({ status: "conflict", reason_code: "different_query" });
        }
        if (canonicalJson(prior.record) !== canonicalJson(record)) {
          return frozen({ status: "conflict", reason_code: "different_record" });
        }
        return frozen({ status: "existing", record: prior.record });
      }
      const priorExport = byExport.get(record.receipt.export_id);
      if (priorExport !== undefined && canonicalJson(priorExport.record) !== canonicalJson(record)) {
        return frozen({ status: "conflict", reason_code: "different_record" });
      }
      const stored: StoredRecord = {
        record,
        key,
        created_ms: created.milliseconds,
        expires_ms: expires.milliseconds,
        gc_acknowledged: false,
        active_batch_id: null,
      };
      byKey.set(key, stored);
      byExport.set(record.receipt.export_id, stored);
      metrics.stored_records = byExport.size;
      return frozen({ status: "published", record });
    },
    async getReadyForDownload(rawInput): Promise<PlatformInformationExportRecordDownloadResult> {
      const input = exactRecord(rawInput, ["actor_id", "project_id", "export_id", "now"]);
      const actorId = identity(input.actor_id);
      const projectId = projectIdentity(input.project_id);
      const exportId = identity(input.export_id);
      const now = timestamp(input.now);
      const stored = byExport.get(exportId);
      if (stored === undefined || stored.record.actor_id !== actorId ||
          stored.record.receipt.project_id !== projectId) return frozen({ status: "not_found" });
      if (stored.gc_acknowledged || stored.expires_ms <= now.milliseconds) return frozen({ status: "expired" });
      return frozen({ status: "ready", record: stored.record });
    },
    async claimExpired(rawInput): Promise<PlatformInformationExportRecordClaimResult> {
      const input = exactRecord(rawInput,
        ["now", "limit", "worker_id", "lease_until"], ["cursor"]);
      const now = timestamp(input.now);
      const lease = timestamp(input.lease_until);
      const workerId = identity(input.worker_id);
      if (!Number.isSafeInteger(input.limit) || (input.limit as number) < 1 ||
          (input.limit as number) > MAX_EXPIRE_PAGE || lease.milliseconds <= now.milliseconds ||
          lease.milliseconds - now.milliseconds > MAX_LEASE_MILLISECONDS) invalid();
      const cursorValue = input.cursor;
      if (!(cursorValue === undefined || cursorValue === null ||
          typeof cursorValue === "string" && CURSOR_PATTERN.test(cursorValue))) invalid();
      const requestKey = canonicalJson({
        now_ms: now.milliseconds,
        limit: input.limit,
        cursor: cursorValue ?? null,
        worker_id: workerId,
        lease_ms: lease.milliseconds,
      });
      const replay = [...batches.values()].find((batch) => !batch.acked &&
        batch.request_key === requestKey && batch.lease_ms > now.milliseconds &&
        batch.records.every((stored) => stored.active_batch_id === batch.batch_id));
      if (replay !== undefined) {
        return frozen({ status: "claimed", batch_id: replay.batch_id,
          refs: replay.refs, next_cursor: replay.next_cursor });
      }
      let cursorCapability: CursorCapability | null = null;
      if (typeof cursorValue === "string") {
        cursorCapability = cursorByToken.get(cursorValue) ?? null;
        if (cursorCapability === null || cursorCapability.now_ms !== now.milliseconds) invalid();
      }
      const eligible = [...byExport.values()]
        .filter((stored) => {
          const active = stored.active_batch_id === null ? undefined : batches.get(stored.active_batch_id);
          const available = active === undefined || active.acked || active.lease_ms <= now.milliseconds;
          return !stored.gc_acknowledged && available && stored.expires_ms <= now.milliseconds &&
            (cursorCapability === null || stored.expires_ms > cursorCapability.expires_ms ||
              stored.expires_ms === cursorCapability.expires_ms &&
              compareUtf8(stored.record.receipt.export_id, cursorCapability.export_id) > 0);
        })
        .sort((left, right) => left.expires_ms - right.expires_ms ||
          compareUtf8(left.record.receipt.export_id, right.record.receipt.export_id));
      const selected = eligible.slice(0, input.limit as number);
      if (selected.length === 0) {
        return frozen({ status: "empty", refs: Object.freeze([]), next_cursor: null });
      }
      const last = selected.at(-1);
      const nextCursor = eligible.length > selected.length && last !== undefined
        ? cursorFor({
            now_ms: now.milliseconds,
            expires_ms: last.expires_ms,
            export_id: last.record.receipt.export_id,
          })
        : null;
      const refs = Object.freeze(selected.map((stored) => stored.record.receipt.download_ref));
      const batchId = `batch_${batches.size + 1}`;
      const batch: ClaimBatch = {
        batch_id: batchId,
        worker_id: workerId,
        lease_ms: lease.milliseconds,
        records: Object.freeze([...selected]),
        request_key: requestKey,
        refs,
        next_cursor: nextCursor,
        acked: false,
      };
      batches.set(batchId, batch);
      selected.forEach((stored) => { stored.active_batch_id = batchId; });
      return frozen({
        status: "claimed", batch_id: batchId,
        refs, next_cursor: nextCursor,
      });
    },
    async ackExpired(rawInput): Promise<PlatformInformationExportRecordAckResult> {
      const input = exactRecord(rawInput, ["batch_id", "worker_id"]);
      const batchId = identity(input.batch_id);
      const workerId = identity(input.worker_id);
      const batch = batches.get(batchId);
      if (batch === undefined) return frozen({ status: "not_found" });
      if (batch.worker_id !== workerId) return frozen({ status: "not_owner" });
      if (batch.acked) return frozen({ status: "already_acked" });
      if (batch.records.some((stored) => stored.active_batch_id !== batchId)) {
        return frozen({ status: "lease_lost" });
      }
      batch.records.forEach((stored) => {
        stored.gc_acknowledged = true;
        stored.active_batch_id = null;
      });
      batch.acked = true;
      return frozen({ status: "acked" });
    },
    async hasLiveReference(rawInput): Promise<boolean> {
      const input = exactRecord(rawInput, ["content_hash", "now"]);
      const contentHash = hash(input.content_hash);
      const now = timestamp(input.now);
      return [...byExport.values()].some((stored) => !stored.gc_acknowledged &&
        stored.expires_ms > now.milliseconds &&
        stored.record.receipt.artifact.content_sha === contentHash);
    },
    purgeProjectForTest(rawProjectId): number {
      const projectId = projectIdentity(rawProjectId);
      let purged = 0;
      for (const [exportId, stored] of byExport) {
        if (stored.record.receipt.project_id !== projectId) continue;
        byExport.delete(exportId);
        byKey.delete(stored.key);
        purged += 1;
      }
      metrics.stored_records = byExport.size;
      return purged;
    },
  };
  return port;
}
