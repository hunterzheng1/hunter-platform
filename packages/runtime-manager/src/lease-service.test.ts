import { DatabaseSync } from "node:sqlite";

import {
  LeaseOwnerIdSchema,
  WorkspaceIdSchema,
  WorktreeIdSchema,
  WriterLeaseIdSchema,
} from "@hunter/domain";
import { SqliteOperationJournal } from "@hunter/storage";
import { WriterLeaseSchema } from "@hunter/runtime-contracts";
import { describe, expect, it } from "vitest";

import { LeaseService } from "./lease-service.js";

function writer(owner: string, lease = "wrl_00000001", generation = 1, expiresAt = "2026-07-22T10:05:00.000Z") {
  return WriterLeaseSchema.parse({
    schemaVersion: 1,
    kind: "writer",
    leaseId: WriterLeaseIdSchema.parse(lease),
    ownerId: LeaseOwnerIdSchema.parse(owner),
    generation,
    acquiredAt: "2026-07-22T10:00:00.000Z",
    expiresAt,
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
});
