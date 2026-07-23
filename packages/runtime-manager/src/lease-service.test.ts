import { DatabaseSync } from "node:sqlite";

import {
  AttemptIdSchema,
  DeviceBindingIdSchema,
  LeaseOwnerIdSchema,
  ProjectIdSchema,
  RepositoryIdSchema,
  RunIdSchema,
  WorkspaceIdSchema,
  WorktreeIdSchema,
  WriterLeaseIdSchema,
} from "@hunter/domain";
import { SqliteOperationJournal } from "@hunter/storage";
import { CanonicalWorkspaceKeySchema, WriterLeaseSchema } from "@hunter/runtime-contracts";
import { describe, expect, it } from "vitest";

import { LeaseService } from "./lease-service.js";

function writer(owner: string, lease = "wrl_00000001", generation = 1, expiresAt = "2026-07-22T10:05:00.000Z") {
  return WriterLeaseSchema.parse({
    schemaVersion: 2,
    projectId: ProjectIdSchema.parse("prj_00000001"),
    repositoryId: RepositoryIdSchema.parse("rep_00000001"),
    deviceBindingId: DeviceBindingIdSchema.parse("dev_00000001"),
    canonicalWorkspaceKey: CanonicalWorkspaceKeySchema.parse("win32:c:/safe/worktree"),
    gitHead: "a".repeat(40),
    branch: "codex/task14-lease-service",
    ownerRunId: RunIdSchema.parse("run_00000001"),
    ownerAttemptId: AttemptIdSchema.parse("att_00000001"),
    kind: "writer",
    leaseId: WriterLeaseIdSchema.parse(lease),
    ownerId: LeaseOwnerIdSchema.parse(owner),
    generation,
    mode: "write",
    acquiredAt: "2026-07-22T10:00:00.000Z",
    expiresAt,
    revokedAt: null,
    revocationReason: null,
    scope: {
      workspaceId: WorkspaceIdSchema.parse("wsp_00000001"),
      worktreeId: WorktreeIdSchema.parse("wtr_00000001"),
    },
  });
}

describe("LeaseService", () => {
  it("serializes writers, guards owner generations, and recovers expired leases", async () => {
    const database = new DatabaseSync(":memory:");
    new SqliteOperationJournal(database);
    const service = new LeaseService(database, () => new Date("2026-07-22T10:01:00.000Z"));
    const first = await service.acquire(writer("own_00000001"));
    await expect(service.acquire(writer("own_00000002", "wrl_00000002"))).rejects.toThrow(/LEASE_SCOPE_BUSY/u);
    await expect(service.renew({
      leaseId: first.leaseId,
      ownerId: first.ownerId,
      generation: 2,
      expiresAt: "2026-07-22T10:06:00.000Z",
    })).rejects.toThrow(/LEASE_GENERATION_CONFLICT/u);

    const recovered = new LeaseService(database, () => new Date("2026-07-22T10:10:00.000Z"));
    const next = await recovered.acquire(writer("own_00000002", "wrl_00000002", 2, "2026-07-22T10:20:00.000Z"));
    expect(next.generation).toBe(2);
    expect(await recovered.inspect(first.leaseId)).toBeNull();
    database.close();
  });

  it("rejects wrong worktree, canonical path drift, and HEAD drift", () => {
    expect(() => LeaseService.verifyWorkspaceIdentity({
      expectedWorktreeId: WorktreeIdSchema.parse("wtr_00000001"),
      observedWorktreeId: WorktreeIdSchema.parse("wtr_00000002"),
      expectedRealpath: "C:/safe/worktree",
      observedRealpath: "C:/other/worktree",
      baselineRevision: "a".repeat(40),
      observedHead: "b".repeat(40),
    })).toThrow(/WORKTREE_ID_MISMATCH/u);
  });

  it("quarantines a drifted lease durably so it cannot be inspected or renewed", async () => {
    const database = new DatabaseSync(":memory:");
    new SqliteOperationJournal(database);
    const service = new LeaseService(database, () => new Date("2026-07-22T10:01:00.000Z"));
    const acquired = await service.acquire(writer("own_00000001"));

    await service.quarantine(acquired.leaseId, "workspace_identity_or_head_drift");

    await expect(service.inspect(acquired.leaseId)).resolves.toBeNull();
    await expect(service.renew({
      leaseId: acquired.leaseId,
      ownerId: acquired.ownerId,
      generation: acquired.generation,
      expiresAt: "2026-07-22T10:10:00.000Z",
    })).rejects.toThrow(/LEASE_REVOKED/u);
    const stored = JSON.parse((database.prepare(
      "SELECT receipt_json FROM lease_records WHERE lease_id = ?",
    ).get(acquired.leaseId) as { receipt_json: string }).receipt_json) as {
      revokedAt: string | null;
      revocationReason: string | null;
    };
    expect(stored).toMatchObject({
      revokedAt: "2026-07-22T10:01:00.000Z",
      revocationReason: "workspace_identity_or_head_drift",
    });
    database.close();
  });
});
