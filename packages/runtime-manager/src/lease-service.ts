import type { DatabaseSync } from "node:sqlite";

import {
  LeaseSchema,
  LeaseReleaseRequestSchema,
  LeaseRenewRequestSchema,
  type Lease,
  type LeaseBoundary,
  type LeaseReleaseRequest,
  type LeaseRenewRequest,
  type WriterLease,
} from "@hunter/runtime-contracts";
import type {
  CanonicalWorkspaceKey,
} from "@hunter/runtime-contracts";
import type {
  DeviceBindingId,
  NativeSessionId,
  ProjectId,
  WorktreeId,
  WriterLeaseId,
} from "@hunter/domain";
import { WriterLeaseIdSchema } from "@hunter/domain";

interface LeaseRow {
  readonly lease_id: string;
  readonly scope_key: string;
  readonly owner_id: string;
  readonly generation: number;
  readonly expires_at: string;
  readonly receipt_json: string;
}

type WithoutGeneration<T> = T extends unknown ? Omit<T, "generation"> : never;
export type LeaseAcquisition = WithoutGeneration<Lease>;

export function leaseScopeKey(lease: Lease): string {
  switch (lease.kind) {
    case "workspace":
    case "writer":
      return `${lease.projectId}:${lease.repositoryId}:${lease.canonicalWorkspaceKey}`;
    case "controller":
      return `${lease.projectId}:${lease.scope.nativeSessionId}`;
  }
}

export class LeaseService implements LeaseBoundary {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async acquire(input: Lease): Promise<Lease> {
    const lease = LeaseSchema.parse(input);
    if (lease.revokedAt !== null) throw new Error("LEASE_REVOKED");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.acquireInTransaction(lease);
      this.database.exec("COMMIT");
      return lease;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public acquireNext(
    input: LeaseAcquisition,
    options: { readonly transaction?: "new" | "existing" } = {},
  ): Lease {
    const template = LeaseSchema.parse({ ...input, generation: 1 });
    const acquire = (): Lease => {
      const key = leaseScopeKey(template);
      const existing = this.database.prepare(
        "SELECT lease_id, scope_key, owner_id, generation, expires_at, receipt_json FROM lease_records WHERE lease_kind = ? AND scope_key = ?",
      ).get(template.kind, key) as unknown as LeaseRow | undefined;
      const lease = LeaseSchema.parse({
        ...template,
        generation: existing === undefined ? 1 : existing.generation + 1,
      });
      return this.acquireInTransaction(lease);
    };

    if (options.transaction === "existing") return acquire();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const lease = acquire();
      this.database.exec("COMMIT");
      return lease;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public async renew(input: LeaseRenewRequest): Promise<Lease> {
    const request = LeaseRenewRequestSchema.parse(input);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(
        "SELECT lease_id, scope_key, owner_id, generation, expires_at, receipt_json FROM lease_records WHERE lease_id = ?",
      ).get(request.leaseId) as unknown as LeaseRow | undefined;
      if (row === undefined) throw new Error("LEASE_NOT_FOUND");
      if (row.owner_id !== request.ownerId) throw new Error("LEASE_OWNER_CONFLICT");
      if (row.generation !== request.generation) throw new Error("LEASE_GENERATION_CONFLICT");
      if (Date.parse(row.expires_at) <= this.now().getTime()) throw new Error("LEASE_EXPIRED");
      const current = LeaseSchema.parse(JSON.parse(row.receipt_json));
      if (current.revokedAt !== null) throw new Error("LEASE_REVOKED");
      const renewed = LeaseSchema.parse({ ...current, expiresAt: request.expiresAt });
      const result = this.database.prepare(
        `UPDATE lease_records
            SET expires_at = ?, receipt_json = ?, updated_at = ?
          WHERE lease_id = ? AND owner_id = ? AND generation = ?
            AND receipt_json = ?`,
      ).run(
        renewed.expiresAt,
        JSON.stringify(renewed),
        this.now().toISOString(),
        renewed.leaseId,
        renewed.ownerId,
        renewed.generation,
        row.receipt_json,
      );
      if (result.changes !== 1) throw new Error("LEASE_RENEW_CONFLICT");
      this.database.exec("COMMIT");
      return renewed;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public acquireInTransaction(input: Lease): Lease {
    const lease = LeaseSchema.parse(input);
    if (lease.revokedAt !== null) throw new Error("LEASE_REVOKED");
    const key = leaseScopeKey(lease);
    const existing = this.database.prepare(
      "SELECT lease_id, scope_key, owner_id, generation, expires_at, receipt_json FROM lease_records WHERE lease_kind = ? AND scope_key = ?",
    ).get(lease.kind, key) as unknown as LeaseRow | undefined;
    if (existing !== undefined) {
      const existingLease = LeaseSchema.parse(JSON.parse(existing.receipt_json));
      if (
        existingLease.revokedAt === null
        && Date.parse(existing.expires_at) > this.now().getTime()
      ) {
        throw new Error("LEASE_SCOPE_BUSY");
      }
    }
    const expectedGeneration = existing === undefined ? 1 : existing.generation + 1;
    if (lease.generation !== expectedGeneration) throw new Error("LEASE_GENERATION_CONFLICT");
    if (existing !== undefined) {
      this.database.prepare("DELETE FROM lease_records WHERE lease_id = ?").run(existing.lease_id);
    }
    this.database.prepare(
      `INSERT INTO lease_records
        (lease_id, lease_kind, scope_key, owner_id, generation, expires_at, receipt_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      lease.leaseId,
      lease.kind,
      key,
      lease.ownerId,
      lease.generation,
      lease.expiresAt,
      JSON.stringify(lease),
      this.now().toISOString(),
    );
    return lease;
  }

  public async release(input: LeaseReleaseRequest): Promise<void> {
    const request = LeaseReleaseRequestSchema.parse(input);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(
        "SELECT lease_id, scope_key, owner_id, generation, expires_at, receipt_json FROM lease_records WHERE lease_id = ?",
      ).get(request.leaseId) as unknown as LeaseRow | undefined;
      if (row === undefined) throw new Error("LEASE_NOT_FOUND");
      if (row.owner_id !== request.ownerId) {
        throw new Error("LEASE_OWNER_CONFLICT");
      }
      if (row.generation !== request.generation) {
        throw new Error("LEASE_GENERATION_CONFLICT");
      }
      const current = LeaseSchema.parse(JSON.parse(row.receipt_json));
      if (current.revokedAt !== null) throw new Error("LEASE_REVOKED");
      const releasedAt = this.now().toISOString();
      const released = LeaseSchema.parse({
        ...current,
        revokedAt: releasedAt,
        revocationReason: "released",
      });
      const result = this.database.prepare(
        `UPDATE lease_records
            SET receipt_json = ?, updated_at = ?
          WHERE lease_id = ? AND owner_id = ? AND generation = ?`,
      ).run(
        JSON.stringify(released),
        releasedAt,
        request.leaseId,
        request.ownerId,
        request.generation,
      );
      if (result.changes !== 1) throw new Error("LEASE_RELEASE_CONFLICT");
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public async quarantine(
    leaseId: Lease["leaseId"],
    reason: string,
  ): Promise<void> {
    if (reason.trim().length === 0 || reason.length > 512) {
      throw new Error("LEASE_QUARANTINE_REASON_INVALID");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(
        "SELECT lease_id, scope_key, owner_id, generation, expires_at, receipt_json FROM lease_records WHERE lease_id = ?",
      ).get(leaseId) as unknown as LeaseRow | undefined;
      if (row === undefined) throw new Error("LEASE_NOT_FOUND");
      const current = LeaseSchema.parse(JSON.parse(row.receipt_json));
      if (current.revokedAt !== null) {
        this.database.exec("COMMIT");
        return;
      }
      const quarantinedAt = this.now().toISOString();
      const quarantined = LeaseSchema.parse({
        ...current,
        revokedAt: quarantinedAt,
        revocationReason: reason,
      });
      const result = this.database.prepare(
        `UPDATE lease_records
            SET receipt_json = ?, updated_at = ?
          WHERE lease_id = ? AND owner_id = ? AND generation = ?
            AND receipt_json = ?`,
      ).run(
        JSON.stringify(quarantined),
        quarantinedAt,
        current.leaseId,
        current.ownerId,
        current.generation,
        row.receipt_json,
      );
      if (result.changes !== 1) throw new Error("LEASE_QUARANTINE_CONFLICT");
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public async inspect(leaseId: Lease["leaseId"]): Promise<Lease | null> {
    const row = this.database.prepare(
      "SELECT lease_id, scope_key, owner_id, generation, expires_at, receipt_json FROM lease_records WHERE lease_id = ?",
    ).get(leaseId) as unknown as LeaseRow | undefined;
    if (row === undefined || Date.parse(row.expires_at) <= this.now().getTime()) return null;
    const lease = LeaseSchema.parse(JSON.parse(row.receipt_json));
    return lease.revokedAt === null ? lease : null;
  }

  public listRecorded(): readonly Lease[] {
    const rows = this.database.prepare(
      "SELECT receipt_json FROM lease_records ORDER BY lease_id",
    ).all() as unknown as Array<{ readonly receipt_json: string }>;
    return rows.map(({ receipt_json }) =>
      LeaseSchema.parse(JSON.parse(receipt_json) as unknown));
  }

  public listActive(): readonly Lease[] {
    const observedAt = this.now().getTime();
    return this.listRecorded().filter(
      (lease) =>
        lease.revokedAt === null && Date.parse(lease.expiresAt) > observedAt,
    );
  }

  public async findActiveController(
    projectId: ProjectId,
    nativeSessionId: NativeSessionId,
  ): Promise<Extract<Lease, { readonly kind: "controller" }> | null> {
    const key = `${projectId}:${nativeSessionId}`;
    const row = this.database.prepare(
      `SELECT lease_id, scope_key, owner_id, generation, expires_at, receipt_json
         FROM lease_records
        WHERE lease_kind = 'controller' AND scope_key = ?`,
    ).get(key) as unknown as LeaseRow | undefined;
    if (row === undefined || Date.parse(row.expires_at) <= this.now().getTime()) {
      return null;
    }
    const lease = LeaseSchema.parse(JSON.parse(row.receipt_json));
    if (
      lease.kind !== "controller"
      || lease.projectId !== projectId
      || lease.scope.nativeSessionId !== nativeSessionId
      || leaseScopeKey(lease) !== row.scope_key
      || lease.revokedAt !== null
    ) {
      return null;
    }
    return lease;
  }

  public async recoverWriter(
    leaseIdInput: WriterLeaseId,
    observed: {
      readonly deviceBindingId: DeviceBindingId;
      readonly worktreeId: WorktreeId;
      readonly canonicalWorkspaceKey: CanonicalWorkspaceKey;
      readonly gitHead: string;
    },
  ): Promise<WriterLease> {
    const leaseId = WriterLeaseIdSchema.parse(leaseIdInput);
    const recovered = await this.recoverLease(leaseId, observed);
    if (recovered.kind !== "writer") throw new Error("LEASE_KIND_MISMATCH");
    return recovered;
  }

  public async recoverLease(
    leaseId: Lease["leaseId"],
    observed: {
      readonly deviceBindingId: DeviceBindingId;
      readonly canonicalWorkspaceKey: CanonicalWorkspaceKey;
      readonly gitHead: string;
      readonly worktreeId?: WorktreeId | undefined;
      readonly nativeSessionId?: NativeSessionId | undefined;
    },
  ): Promise<Lease> {
    const inspected = await this.inspect(leaseId);
    if (inspected === null) throw new Error("LEASE_NOT_ACTIVE");
    if (inspected.deviceBindingId !== observed.deviceBindingId) {
      throw new Error("DEVICE_BINDING_MISMATCH");
    }
    if (inspected.canonicalWorkspaceKey !== observed.canonicalWorkspaceKey) {
      throw new Error("WORKSPACE_REALPATH_MISMATCH");
    }
    if (inspected.gitHead !== observed.gitHead) {
      throw new Error("WORKSPACE_HEAD_DRIFT");
    }
    if (
      (inspected.kind === "writer" || inspected.kind === "controller")
      && inspected.scope.worktreeId !== observed.worktreeId
    ) {
      throw new Error("WORKTREE_ID_MISMATCH");
    }
    if (
      inspected.kind === "controller"
      && inspected.scope.nativeSessionId !== observed.nativeSessionId
    ) {
      throw new Error("NATIVE_SESSION_ID_MISMATCH");
    }
    return inspected;
  }

  public static verifyWorkspaceIdentity(input: {
    readonly expectedWorktreeId: string;
    readonly observedWorktreeId: string;
    readonly expectedRealpath: string;
    readonly observedRealpath: string;
    readonly baselineRevision: string;
    readonly observedHead: string;
  }): void {
    if (input.expectedWorktreeId !== input.observedWorktreeId) throw new Error("WORKTREE_ID_MISMATCH");
    if (input.expectedRealpath !== input.observedRealpath) {
      throw new Error("WORKSPACE_REALPATH_MISMATCH");
    }
    if (input.baselineRevision !== input.observedHead) throw new Error("WORKSPACE_HEAD_DRIFT");
  }
}
