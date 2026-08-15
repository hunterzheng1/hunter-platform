import { randomBytes } from "node:crypto";

import {
  remoteArchiveV2PayloadHash,
  remoteArchiveV2StableHash,
  remoteArchiveV2Snapshot,
  sameRemoteArchiveV2Source,
  snapshotRemoteArchiveV2Claim,
  snapshotRemoteArchiveV2Prepare,
  validRemoteArchiveV2Source,
  type RemoteArchiveV2Capability,
  type RemoteArchiveV2Claim,
  type RemoteArchiveV2ErrorCode,
  type RemoteArchiveV2Identities,
  type RemoteArchiveV2OperationId,
  type RemoteArchiveV2PrepareInput,
  type RemoteArchiveV2Receipt,
  type RemoteArchiveV2Record,
  type RemoteArchiveV2Source,
  type RemoteArchiveV2UploadRef,
} from "@hunter-harness/core";

import { PgRemoteSyncArchiveRecordPort, inTransaction } from "./pg-records.js";
import type { RemoteSyncArchivePgOptions, RemoteSyncArchivePgService } from "./ports.js";

export class RemoteSyncArchivePgError extends Error {
  public constructor(public readonly code: RemoteArchiveV2ErrorCode) {
    super(code);
    this.name = "RemoteSyncArchivePgError";
  }
}

function fail(code: RemoteArchiveV2ErrorCode): never { throw new RemoteSyncArchivePgError(code); }

function nowIso(clock: () => string): string {
  const value = clock();
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
      !Number.isFinite(Date.parse(value))) fail("REMOTE_ARCHIVE_RECORD_INVALID");
  return value;
}

function sourceCopy(source: RemoteArchiveV2Source): RemoteArchiveV2Source {
  return {
    project_id: source.project_id,
    branch_name: source.branch_name,
    actor_id: source.actor_id,
    ...(source.commit_sha === undefined ? {} : { commit_sha: source.commit_sha }),
    ...(source.client_id === undefined ? {} : { client_id: source.client_id }),
    ...(source.change_key === undefined ? {} : { change_key: source.change_key }),
  };
}

function identitiesCopy(value: RemoteArchiveV2Identities): RemoteArchiveV2Identities {
  return {
    package_sha256: value.package_sha256,
    package_size_bytes: value.package_size_bytes,
    archive_schema_version: 1,
    trusted_package_receipt_hash: value.trusted_package_receipt_hash,
    local_archive_receipt_hash: value.local_archive_receipt_hash,
    manifest_hash: value.manifest_hash,
    inventory_hash: value.inventory_hash,
    core_v2_projection_hash: value.core_v2_projection_hash,
  };
}

function uploadRefCopy(value: RemoteArchiveV2UploadRef): RemoteArchiveV2UploadRef {
  return { ref_id: value.ref_id, sha256: value.sha256, size_bytes: value.size_bytes };
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function recordWithHash(value: Omit<RemoteArchiveV2Record, "record_hash">): RemoteArchiveV2Record {
  const { record_hash: ignored, ...withoutHash } = value as Omit<RemoteArchiveV2Record, "record_hash"> & { readonly record_hash?: unknown };
  void ignored;
  const body = remoteArchiveV2Snapshot(withoutHash) as Omit<RemoteArchiveV2Record, "record_hash">;
  return freezeDeep({ ...body, record_hash: remoteArchiveV2StableHash(body) } as RemoteArchiveV2Record);
}

function prepareId(input: Pick<RemoteArchiveV2PrepareInput, "operation_id" | "idempotency_key" | "payload_hash">): RemoteArchiveV2Record["prepare_id"] {
  return `remote_archive_prepare:${remoteArchiveV2StableHash({
    operation_id: input.operation_id, idempotency_key: input.idempotency_key, payload_hash: input.payload_hash
  })}`;
}

function capability(): RemoteArchiveV2Capability {
  return `remote_archive_capability:${randomBytes(32).toString("base64url")}`;
}

function claimFor(record: RemoteArchiveV2Record, raw: RemoteArchiveV2Capability): RemoteArchiveV2Claim {
  if (record.lease === null) fail("REMOTE_ARCHIVE_CAPABILITY_UNAVAILABLE");
  return freezeDeep({ operation_id: record.operation_id, prepare_id: record.prepare_id, source: sourceCopy(record.source),
    generation: record.generation, fencing_token: record.lease.fencing_token, capability: raw });
}

function receiptFor(record: RemoteArchiveV2Record, storedAt: string): RemoteArchiveV2Receipt {
  const body = {
    schema_version: 2 as const,
    operation_id: record.operation_id,
    prepare_id: record.prepare_id,
    idempotency_key: record.idempotency_key,
    payload_hash: record.payload_hash,
    source: sourceCopy(record.source),
    archive_id: record.archive_id,
    package_sha256: record.identities.package_sha256,
    package_size_bytes: record.identities.package_size_bytes,
    manifest_hash: record.identities.manifest_hash,
    trusted_package_receipt_hash: record.identities.trusted_package_receipt_hash,
    local_archive_receipt_hash: record.identities.local_archive_receipt_hash,
    inventory_hash: record.identities.inventory_hash,
    core_v2_projection_hash: record.identities.core_v2_projection_hash,
    stored_at: storedAt,
  };
  const receiptHash = remoteArchiveV2StableHash(body);
  return freezeDeep({ ...body, receipt_id: `remote_archive_receipt:${receiptHash}`, receipt_hash: receiptHash });
}

export function createPgRemoteSyncArchiveV2(options: RemoteSyncArchivePgOptions): RemoteSyncArchivePgService {
  const records = new PgRemoteSyncArchiveRecordPort(options.pool);
  const clock = options.now ?? (() => new Date().toISOString());
  let closed = false;
  const ensureOpen = (): void => { if (closed) fail("REMOTE_ARCHIVE_CAPABILITY_UNAVAILABLE"); };

  const service: RemoteSyncArchivePgService = {
    async prepare(raw) {
      ensureOpen();
      let input: RemoteArchiveV2PrepareInput;
      try { input = snapshotRemoteArchiveV2Prepare(raw); } catch { fail("REMOTE_ARCHIVE_INPUT_INVALID"); }
      if (remoteArchiveV2PayloadHash(input.metadata) !== input.payload_hash) fail("REMOTE_ARCHIVE_PAYLOAD_HASH_MISMATCH");
      const source = sourceCopy(input.metadata.source);
      const now = nowIso(clock);
      return inTransaction(options.pool, async (client) => {
        await records.lock(client, source.project_id, input.idempotency_key);
        const existing = await records.findByKey(client, source.project_id, input.idempotency_key);
        if (existing !== null) {
          if (existing.operation_id !== input.operation_id || existing.payload_hash !== input.payload_hash ||
              !sameRemoteArchiveV2Source(existing.source, source)) fail("REMOTE_ARCHIVE_IDEMPOTENCY_CONFLICT");
          return freezeDeep({ outcome: "replay" as const, claim: null, record: existing });
        }
        const operation = await records.findById(client, source.project_id, input.operation_id);
        if (operation !== null) fail("REMOTE_ARCHIVE_IDEMPOTENCY_CONFLICT");
        const uploadReady = await records.uploadIsStored(client, {
          project_id: source.project_id, ref_id: input.metadata.upload_ref.ref_id,
          sha256: input.metadata.upload_ref.sha256, size_bytes: input.metadata.upload_ref.size_bytes, now
        });
        if (!uploadReady) fail("REMOTE_ARCHIVE_RECORD_INVALID");
        const rawCapability = capability();
        const created = now;
        const record = recordWithHash({
          schema_version: 2, operation_id: input.operation_id, prepare_id: prepareId(input),
          idempotency_key: input.idempotency_key, payload_hash: input.payload_hash, source,
          archive_id: input.metadata.archive_id, identities: identitiesCopy(input.metadata.identities),
          upload_ref: uploadRefCopy(input.metadata.upload_ref), state: "prepared", generation: 1,
          lease: { project_id: source.project_id, branch_name: source.branch_name, actor_id: source.actor_id,
            capability_hash: remoteArchiveV2StableHash(rawCapability), fencing_token: 1,
            acquired_at: created, expires_at: new Date(Date.parse(created) + input.lease_ttl_ms).toISOString() },
          receipt: null, failure_code: null, created_at: created, updated_at: created
        });
        await records.create(client, record);
        return freezeDeep({ outcome: "new" as const, claim: claimFor(record, rawCapability), record });
      });
    },
    async commit(raw) {
      ensureOpen();
      let claim: RemoteArchiveV2Claim;
      let envelope: unknown;
      try { envelope = remoteArchiveV2Snapshot(raw); } catch { fail("REMOTE_ARCHIVE_INPUT_INVALID"); }
      if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope) ||
          Object.keys(envelope).length !== 1 || !Object.hasOwn(envelope, "claim")) fail("REMOTE_ARCHIVE_INPUT_INVALID");
      try { claim = snapshotRemoteArchiveV2Claim((envelope as { readonly claim: unknown }).claim); } catch { fail("REMOTE_ARCHIVE_INPUT_INVALID"); }
      return inTransaction(options.pool, async (client) => {
        await records.lockOperation(client, claim.source.project_id, claim.operation_id);
        const record = await records.findById(client, claim.source.project_id, claim.operation_id);
        if (record === null) fail("REMOTE_ARCHIVE_PREPARE_NOT_FOUND");
        if (!sameRemoteArchiveV2Source(record.source, claim.source)) fail("REMOTE_ARCHIVE_LEASE_SCOPE_MISMATCH");
        if (record.lease === null || record.lease.fencing_token !== claim.fencing_token ||
            record.lease.capability_hash !== remoteArchiveV2StableHash(claim.capability) ||
            record.prepare_id !== claim.prepare_id) fail("REMOTE_ARCHIVE_LEASE_FENCED");
        if (record.state === "committed") {
          if (record.receipt === null) fail("REMOTE_ARCHIVE_RECORD_INVALID");
          return freezeDeep({ outcome: "replay" as const, record, receipt: record.receipt });
        }
        if (record.state === "failed") fail("REMOTE_ARCHIVE_LEASE_FENCED");
        if (record.state === "prepared" && record.generation !== claim.generation) fail("REMOTE_ARCHIVE_LEASE_FENCED");
        const current = nowIso(clock);
        if (record.state === "prepared" && Date.parse(record.lease.expires_at) <= Date.parse(current)) {
          const failed = recordWithHash({ ...record, state: "failed", generation: record.generation + 1,
            lease: null, receipt: null, failure_code: "REMOTE_ARCHIVE_PREPARE_EXPIRED", updated_at: current });
          await records.replace(client, failed);
          fail("REMOTE_ARCHIVE_PREPARE_EXPIRED");
        }
        const committing = record.state === "committing" ? record : recordWithHash({ ...record,
          state: "committing", generation: record.generation + 1, updated_at: current });
        if (record.state !== "committing") await records.replace(client, committing);
        const storedAt = nowIso(clock);
        const receipt = receiptFor(committing, storedAt);
        const committed = recordWithHash({ ...committing, state: "committed", generation: committing.generation + 1,
          receipt, failure_code: null, updated_at: storedAt });
        await records.replace(client, committed);
        return freezeDeep({ outcome: "new" as const, record: committed, receipt });
      });
    },
    async status(raw) {
      ensureOpen();
      const safe = remoteArchiveV2Snapshot(raw) as { readonly operation_id?: unknown; readonly source?: RemoteArchiveV2Source };
      if (safe === null || typeof safe !== "object" || Array.isArray(safe) || typeof safe.operation_id !== "string" ||
          !safe.operation_id.startsWith("remote_archive_operation:") || safe.source === undefined || !validRemoteArchiveV2Source(safe.source))
        fail("REMOTE_ARCHIVE_INPUT_INVALID");
      const record = await records.findVisible(safe.source.project_id, safe.operation_id, safe.source);
      const operationId = safe.operation_id as RemoteArchiveV2OperationId;
      return freezeDeep(record === null ? { operation_id: operationId, state: "unknown" as const, record: null } :
        { operation_id: record.operation_id, state: record.state, record });
    },
    async receipt(raw) {
      const status = await service.status(raw);
      return status.record?.receipt ?? null;
    },
    async close() { closed = true; }
  };
  return Object.freeze(service);
}
