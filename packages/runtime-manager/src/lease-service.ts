import type { DatabaseSync } from "node:sqlite";

import {
  LeaseSchema,
  LeaseReleaseRequestSchema,
  LeaseRenewRequestSchema,
  type Lease,
  type LeaseBoundary,
  type LeaseReleaseRequest,
  type LeaseRenewRequest,
} from "@hunter/runtime-contracts";

interface LeaseRow {
  readonly lease_id: string;
  readonly scope_key: string;
  readonly owner_id: string;
  readonly generation: number;
  readonly expires_at: string;
  readonly receipt_json: string;
}

function scopeKey(lease: Lease): string {
  switch (lease.kind) {
    case "workspace": return `${lease.scope.deviceBindingId}:${lease.scope.repositoryId}:${lease.scope.workspaceId}`;
    case "writer": return `${lease.scope.workspaceId}:${lease.scope.worktreeId ?? "primary"}`;
    case "controller": return lease.scope.nativeSessionId;
  }
}

export class LeaseService implements LeaseBoundary {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async acquire(input: Lease): Promise<Lease> {
    const lease = LeaseSchema.parse(input);
    const key = scopeKey(lease);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare(
        "SELECT lease_id, scope_key, owner_id, generation, expires_at, receipt_json FROM lease_records WHERE lease_kind = ? AND scope_key = ?",
      ).get(lease.kind, key) as unknown as LeaseRow | undefined;
      if (existing !== undefined && Date.parse(existing.expires_at) > this.now().getTime()) {
        throw new Error("LEASE_SCOPE_BUSY");
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
      this.database.exec("COMMIT");
      return lease;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public async renew(input: LeaseRenewRequest): Promise<Lease> {
    const request = LeaseRenewRequestSchema.parse(input);
    const row = this.database.prepare(
      "SELECT lease_id, scope_key, owner_id, generation, expires_at, receipt_json FROM lease_records WHERE lease_id = ?",
    ).get(request.leaseId) as unknown as LeaseRow | undefined;
    if (row === undefined) throw new Error("LEASE_NOT_FOUND");
    if (row.owner_id !== request.ownerId) throw new Error("LEASE_OWNER_CONFLICT");
    if (row.generation !== request.generation) throw new Error("LEASE_GENERATION_CONFLICT");
    if (Date.parse(row.expires_at) <= this.now().getTime()) throw new Error("LEASE_EXPIRED");
    const current = LeaseSchema.parse(JSON.parse(row.receipt_json));
    const renewed = LeaseSchema.parse({ ...current, expiresAt: request.expiresAt });
    this.database.prepare(
      "UPDATE lease_records SET expires_at = ?, receipt_json = ?, updated_at = ? WHERE lease_id = ? AND owner_id = ? AND generation = ?",
    ).run(renewed.expiresAt, JSON.stringify(renewed), this.now().toISOString(), renewed.leaseId, renewed.ownerId, renewed.generation);
    return renewed;
  }

  public async release(input: LeaseReleaseRequest): Promise<void> {
    const request = LeaseReleaseRequestSchema.parse(input);
    const result = this.database.prepare(
      "DELETE FROM lease_records WHERE lease_id = ? AND owner_id = ? AND generation = ?",
    ).run(request.leaseId, request.ownerId, request.generation);
    if (result.changes !== 1) throw new Error("LEASE_RELEASE_CONFLICT");
  }

  public async inspect(leaseId: Lease["leaseId"]): Promise<Lease | null> {
    const row = this.database.prepare(
      "SELECT lease_id, scope_key, owner_id, generation, expires_at, receipt_json FROM lease_records WHERE lease_id = ?",
    ).get(leaseId) as unknown as LeaseRow | undefined;
    if (row === undefined || Date.parse(row.expires_at) <= this.now().getTime()) return null;
    return LeaseSchema.parse(JSON.parse(row.receipt_json));
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
    if (input.expectedRealpath.toLocaleLowerCase() !== input.observedRealpath.toLocaleLowerCase()) {
      throw new Error("WORKSPACE_REALPATH_MISMATCH");
    }
    if (input.baselineRevision !== input.observedHead) throw new Error("WORKSPACE_HEAD_DRIFT");
  }
}
