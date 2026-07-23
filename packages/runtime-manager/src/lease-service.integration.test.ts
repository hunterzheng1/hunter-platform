import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import {
  AttemptIdSchema,
  ControllerLeaseIdSchema,
  DeviceBindingIdSchema,
  LeaseOwnerIdSchema,
  NativeSessionIdSchema,
  ProjectIdSchema,
  RepositoryIdSchema,
  RunIdSchema,
  WorkspaceIdSchema,
  WorkspaceLeaseIdSchema,
  WorktreeIdSchema,
  WriterLeaseIdSchema,
} from "@hunter/domain";
import {
  ControllerLeaseSchema,
  WorkspaceLeaseSchema,
  WriterLeaseSchema,
  createWorkspacePathBoundary,
  type CanonicalWorkspaceKey,
  type ControllerLease,
  type WorkspaceLease,
  type WriterLease,
} from "@hunter/runtime-contracts";
import { SqliteOperationJournal } from "@hunter/storage";
import { afterEach, describe, expect, it } from "vitest";

import { LeaseService } from "./lease-service.js";

const projectId = ProjectIdSchema.parse("prj_lease140001");
const repositoryId = RepositoryIdSchema.parse("rep_lease140001");
const deviceBindingId = DeviceBindingIdSchema.parse("dev_lease140001");
const runId = RunIdSchema.parse("run_lease140001");
const attemptId = AttemptIdSchema.parse("att_lease140001");

interface LeaseFixtureInput {
  readonly leaseId: string;
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly worktreeId: string;
  readonly canonicalWorkspaceKey: CanonicalWorkspaceKey;
  readonly generation?: number;
  readonly expiresAt?: string;
}

function common(input: LeaseFixtureInput) {
  return {
    schemaVersion: 2 as const,
    projectId,
    repositoryId,
    deviceBindingId,
    canonicalWorkspaceKey: input.canonicalWorkspaceKey,
    gitHead: "a".repeat(40),
    branch: "codex/task14",
    ownerRunId: runId,
    ownerAttemptId: attemptId,
    ownerId: LeaseOwnerIdSchema.parse(input.ownerId),
    generation: input.generation ?? 1,
    mode: "write" as const,
    acquiredAt: "2026-07-23T14:00:00.000Z",
    expiresAt: input.expiresAt ?? "2026-07-23T14:05:00.000Z",
    revokedAt: null,
    revocationReason: null,
  };
}

function writer(input: LeaseFixtureInput): WriterLease {
  return WriterLeaseSchema.parse({
    ...common(input),
    kind: "writer",
    leaseId: WriterLeaseIdSchema.parse(input.leaseId),
    scope: {
      workspaceId: WorkspaceIdSchema.parse(input.workspaceId),
      worktreeId: WorktreeIdSchema.parse(input.worktreeId),
    },
  });
}

function workspace(input: LeaseFixtureInput): WorkspaceLease {
  return WorkspaceLeaseSchema.parse({
    ...common(input),
    kind: "workspace",
    leaseId: WorkspaceLeaseIdSchema.parse(input.leaseId),
    scope: {
      workspaceId: WorkspaceIdSchema.parse(input.workspaceId),
    },
  });
}

function controller(input: LeaseFixtureInput): ControllerLease {
  return ControllerLeaseSchema.parse({
    ...common(input),
    kind: "controller",
    leaseId: ControllerLeaseIdSchema.parse(input.leaseId),
    scope: {
      workspaceId: WorkspaceIdSchema.parse(input.workspaceId),
      worktreeId: WorktreeIdSchema.parse(input.worktreeId),
      nativeSessionId: NativeSessionIdSchema.parse("ses_lease140001"),
    },
  });
}

function withoutGeneration<T extends { readonly generation: number }>(
  value: T,
): Omit<T, "generation"> {
  const { generation, ...result } = value;
  void generation;
  return result;
}

describe("durable scoped LeaseService", () => {
  let directory: string | undefined;
  let database: DatabaseSync | undefined;
  let databasePath: string | undefined;
  let workspaceKeys:
    | {
        readonly a: CanonicalWorkspaceKey;
        readonly b: CanonicalWorkspaceKey;
      }
    | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
      directory = undefined;
    }
    databasePath = undefined;
    workspaceKeys = undefined;
  });

  function keys() {
    if (workspaceKeys !== undefined) return workspaceKeys;
    directory ??= mkdtempSync(join(tmpdir(), "hunter-lease-service-"));
    const root = join(directory, "repository");
    const worktreeA = join(root, "worktree-a");
    const worktreeB = join(root, "worktree-b");
    mkdirSync(root);
    mkdirSync(worktreeA);
    mkdirSync(worktreeB);
    const boundary = createWorkspacePathBoundary(
      new Map([[repositoryId, root]]),
    );
    workspaceKeys = {
      a: boundary.canonicalKey(boundary.verify(repositoryId, worktreeA)),
      b: boundary.canonicalKey(boundary.verify(repositoryId, worktreeB)),
    };
    return workspaceKeys;
  }

  function openDatabase(): DatabaseSync {
    directory ??= mkdtempSync(join(tmpdir(), "hunter-lease-service-"));
    databasePath ??= join(directory, "hunter.sqlite");
    database = new DatabaseSync(databasePath);
    new SqliteOperationJournal(database);
    return database;
  }

  function restartDatabase(): DatabaseSync {
    database?.close();
    database = undefined;
    return openDatabase();
  }

  function service(
    now = "2026-07-23T14:01:00.000Z",
    restart = false,
  ): LeaseService {
    const activeDatabase = restart
      ? restartDatabase()
      : database ?? openDatabase();
    return new LeaseService(activeDatabase, () => new Date(now));
  }

  it("LEASE-01 allows parallel writers only for distinct verified canonical worktrees", async () => {
    const canonical = keys();
    const leases = service();
    const first = writer({
      leaseId: "wrl_lease140001",
      ownerId: "own_lease140001",
      workspaceId: "wsp_lease140001",
      worktreeId: "wtr_lease140001",
      canonicalWorkspaceKey: canonical.a,
    });
    const second = writer({
      leaseId: "wrl_lease140002",
      ownerId: "own_lease140002",
      workspaceId: "wsp_lease140002",
      worktreeId: "wtr_lease140002",
      canonicalWorkspaceKey: canonical.b,
    });
    await expect(leases.acquire(first)).resolves.toEqual(first);
    await expect(leases.acquire(second)).resolves.toEqual(second);

    const aliasOfFirst = writer({
      leaseId: "wrl_lease140003",
      ownerId: "own_lease140003",
      workspaceId: "wsp_lease140003",
      worktreeId: "wtr_lease140003",
      canonicalWorkspaceKey: canonical.a,
    });
    await expect(leases.acquire(aliasOfFirst)).rejects.toThrow(
      "LEASE_SCOPE_BUSY",
    );
  });

  it("LEASE-02 persists Workspace, Writer, and Controller authority in the one lease_records registry", async () => {
    const canonical = keys();
    const leases = service();
    const input = {
      ownerId: "own_lease140010",
      workspaceId: "wsp_lease140010",
      worktreeId: "wtr_lease140010",
      canonicalWorkspaceKey: canonical.a,
    };
    await leases.acquire(
      workspace({ ...input, leaseId: "wsl_lease140010" }),
    );
    await leases.acquire(writer({ ...input, leaseId: "wrl_lease140010" }));
    await leases.acquire(
      controller({ ...input, leaseId: "ctl_lease140010" }),
    );

    const restarted = service("2026-07-23T14:02:00.000Z", true);
    expect(
      database!
        .prepare(
          "SELECT lease_kind, COUNT(*) AS count FROM lease_records GROUP BY lease_kind ORDER BY lease_kind",
        )
        .all(),
    ).toEqual([
      { lease_kind: "controller", count: 1 },
      { lease_kind: "workspace", count: 1 },
      { lease_kind: "writer", count: 1 },
    ]);
    await expect(
      restarted.acquire(
        controller({
          ...input,
          leaseId: "ctl_lease140011",
          ownerId: "own_lease140011",
        }),
      ),
    ).rejects.toThrow("LEASE_SCOPE_BUSY");
  });

  it("LEASE-03..04 rejects stale generation, fences expiry, and persists release revocation", async () => {
    const canonical = keys();
    const leases = service();
    const acquired = await leases.acquire(
      writer({
        leaseId: "wrl_lease140020",
        ownerId: "own_lease140020",
        workspaceId: "wsp_lease140020",
        worktreeId: "wtr_lease140020",
        canonicalWorkspaceKey: canonical.a,
      }),
    );
    await expect(
      leases.renew({
        leaseId: acquired.leaseId,
        ownerId: acquired.ownerId,
        generation: 2,
        expiresAt: "2026-07-23T14:06:00.000Z",
      }),
    ).rejects.toThrow("LEASE_GENERATION_CONFLICT");
    await expect(
      leases.release({
        leaseId: acquired.leaseId,
        ownerId: acquired.ownerId,
        generation: 2,
      }),
    ).rejects.toThrow("LEASE_GENERATION_CONFLICT");

    const afterExpiry = service("2026-07-23T14:10:00.000Z", true);
    const fenced = WriterLeaseSchema.parse(await afterExpiry.acquire(
      writer({
        leaseId: "wrl_lease140021",
        ownerId: "own_lease140021",
        workspaceId: "wsp_lease140021",
        worktreeId: "wtr_lease140021",
        canonicalWorkspaceKey: canonical.a,
        generation: 2,
        expiresAt: "2026-07-23T14:20:00.000Z",
      }),
    ));
    expect(fenced.generation).toBe(2);
    await afterExpiry.release({
      leaseId: fenced.leaseId,
      ownerId: fenced.ownerId,
      generation: fenced.generation,
    });
    const durable = database!
      .prepare(
        "SELECT receipt_json FROM lease_records WHERE lease_id = ?",
      )
      .get(fenced.leaseId) as { receipt_json: string } | undefined;
    expect(JSON.parse(durable!.receipt_json)).toMatchObject({
      revokedAt: "2026-07-23T14:10:00.000Z",
      revocationReason: "released",
    });
    await expect(afterExpiry.inspect(fenced.leaseId)).resolves.toBeNull();
  });

  it("LEASE-03 derives the next scope generation for external and existing transactions", async () => {
    const canonical = keys();
    const leases = service();
    const firstInput = withoutGeneration(writer({
      leaseId: "wrl_lease140050",
      ownerId: "own_lease140050",
      workspaceId: "wsp_lease140050",
      worktreeId: "wtr_lease140050",
      canonicalWorkspaceKey: canonical.a,
    }));
    const first = WriterLeaseSchema.parse(leases.acquireNext(firstInput));
    expect(first.generation).toBe(1);
    await leases.release({
      leaseId: first.leaseId,
      ownerId: first.ownerId,
      generation: first.generation,
    });

    const releasedRetryInput = withoutGeneration(writer({
      leaseId: "wrl_lease140051",
      ownerId: "own_lease140051",
      workspaceId: "wsp_lease140051",
      worktreeId: "wtr_lease140051",
      canonicalWorkspaceKey: canonical.a,
    }));
    const afterRelease = WriterLeaseSchema.parse(
      leases.acquireNext(releasedRetryInput),
    );
    expect(afterRelease.generation).toBe(2);

    const expiringInput = withoutGeneration(writer({
      leaseId: "wrl_lease140052",
      ownerId: "own_lease140052",
      workspaceId: "wsp_lease140052",
      worktreeId: "wtr_lease140052",
      canonicalWorkspaceKey: canonical.b,
      expiresAt: "2026-07-23T14:05:00.000Z",
    }));
    const expiring = WriterLeaseSchema.parse(leases.acquireNext(expiringInput));
    expect(expiring.generation).toBe(1);
    const afterExpiry = service("2026-07-23T14:10:00.000Z");
    const expiredRetryInput = withoutGeneration(writer({
      leaseId: "wrl_lease140053",
      ownerId: "own_lease140053",
      workspaceId: "wsp_lease140053",
      worktreeId: "wtr_lease140053",
      canonicalWorkspaceKey: canonical.b,
      expiresAt: "2026-07-23T14:20:00.000Z",
    }));
    expect(
      WriterLeaseSchema.parse(afterExpiry.acquireNext(expiredRetryInput))
        .generation,
    ).toBe(2);

    const transactionInput = withoutGeneration(workspace({
        leaseId: "wsl_lease140050",
        ownerId: "own_lease140054",
        workspaceId: "wsp_lease140054",
        worktreeId: "wtr_lease140054",
        canonicalWorkspaceKey: canonical.a,
      }));
    database!.exec("BEGIN IMMEDIATE");
    const inTransaction = afterExpiry.acquireNext(transactionInput, {
      transaction: "existing",
    });
    database!.exec("COMMIT");
    expect(inTransaction.generation).toBe(1);
  });

  it("LEASE-04 never lets a stale renew overwrite a concurrently persisted revocation", async () => {
    const canonical = keys();
    const leases = service();
    const acquired = await leases.acquire(writer({
      leaseId: "wrl_lease140025",
      ownerId: "own_lease140025",
      workspaceId: "wsp_lease140025",
      worktreeId: "wtr_lease140025",
      canonicalWorkspaceKey: canonical.a,
    }));
    const concurrent = new DatabaseSync(databasePath!);
    let revocationInjected = false;
    const injectRevocation = () => {
      if (revocationInjected) return;
      revocationInjected = true;
      const row = concurrent.prepare(
        "SELECT receipt_json FROM lease_records WHERE lease_id = ?",
      ).get(acquired.leaseId) as { receipt_json: string };
      const revoked = {
        ...(JSON.parse(row.receipt_json) as Record<string, unknown>),
        revokedAt: "2026-07-23T14:01:30.000Z",
        revocationReason: "concurrent_release",
      };
      concurrent.prepare(
        "UPDATE lease_records SET receipt_json = ?, updated_at = ? WHERE lease_id = ?",
      ).run(
        JSON.stringify(revoked),
        "2026-07-23T14:01:30.000Z",
        acquired.leaseId,
      );
    };
    const primary = database!;
    const racedDatabase = new Proxy(primary, {
      get(target, property) {
        if (property === "exec") {
          return (sql: string) => {
            if (sql === "BEGIN IMMEDIATE") injectRevocation();
            return target.exec(sql);
          };
        }
        if (property === "prepare") {
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.includes("FROM lease_records WHERE lease_id = ?")) {
              return statement;
            }
            return new Proxy(statement, {
              get(statementTarget, statementProperty) {
                if (statementProperty === "get") {
                  return (...args: SQLInputValue[]) => {
                    const row = statementTarget.get(...args);
                    injectRevocation();
                    return row;
                  };
                }
                const value = Reflect.get(statementTarget, statementProperty);
                return typeof value === "function"
                  ? value.bind(statementTarget)
                  : value;
              },
            });
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DatabaseSync;
    const raced = new LeaseService(
      racedDatabase,
      () => new Date("2026-07-23T14:01:00.000Z"),
    );

    await expect(raced.renew({
      leaseId: acquired.leaseId,
      ownerId: acquired.ownerId,
      generation: acquired.generation,
      expiresAt: "2026-07-23T14:10:00.000Z",
    })).rejects.toThrow("LEASE_REVOKED");
    const durable = concurrent.prepare(
      "SELECT receipt_json FROM lease_records WHERE lease_id = ?",
    ).get(acquired.leaseId) as { receipt_json: string };
    expect(JSON.parse(durable.receipt_json)).toMatchObject({
      revokedAt: "2026-07-23T14:01:30.000Z",
      revocationReason: "concurrent_release",
    });
    concurrent.close();
  });

  it("LEASE-05..06 reopens the file DB and rejects wrong binding/worktree/path/HEAD", async () => {
    const canonical = keys();
    const firstService = service();
    const acquired = WriterLeaseSchema.parse(await firstService.acquire(
      writer({
        leaseId: "wrl_lease140030",
        ownerId: "own_lease140030",
        workspaceId: "wsp_lease140030",
        worktreeId: "wtr_lease140030",
        canonicalWorkspaceKey: canonical.a,
      }),
    ));
    const recovered = service("2026-07-23T14:02:00.000Z", true);

    await expect(
      recovered.recoverWriter(acquired.leaseId, {
        deviceBindingId: DeviceBindingIdSchema.parse("dev_lease140002"),
        worktreeId: acquired.scope.worktreeId,
        canonicalWorkspaceKey: acquired.canonicalWorkspaceKey,
        gitHead: acquired.gitHead,
      }),
    ).rejects.toThrow("DEVICE_BINDING_MISMATCH");
    await expect(
      recovered.recoverWriter(acquired.leaseId, {
        deviceBindingId: acquired.deviceBindingId,
        worktreeId: WorktreeIdSchema.parse("wtr_lease140031"),
        canonicalWorkspaceKey: acquired.canonicalWorkspaceKey,
        gitHead: acquired.gitHead,
      }),
    ).rejects.toThrow("WORKTREE_ID_MISMATCH");
    await expect(
      recovered.recoverWriter(acquired.leaseId, {
        deviceBindingId: acquired.deviceBindingId,
        worktreeId: acquired.scope.worktreeId,
        canonicalWorkspaceKey: canonical.b,
        gitHead: acquired.gitHead,
      }),
    ).rejects.toThrow("WORKSPACE_REALPATH_MISMATCH");
    await expect(
      recovered.recoverWriter(acquired.leaseId, {
        deviceBindingId: acquired.deviceBindingId,
        worktreeId: acquired.scope.worktreeId,
        canonicalWorkspaceKey: acquired.canonicalWorkspaceKey,
        gitHead: "b".repeat(40),
      }),
    ).rejects.toThrow("WORKSPACE_HEAD_DRIFT");
    await expect(
      recovered.recoverWriter(acquired.leaseId, {
        deviceBindingId: acquired.deviceBindingId,
        worktreeId: acquired.scope.worktreeId,
        canonicalWorkspaceKey: acquired.canonicalWorkspaceKey,
        gitHead: acquired.gitHead,
      }),
    ).resolves.toEqual(acquired);
  });

  it.runIf(process.platform === "win32")(
    "LEASE-05 signs and recovers a real Windows workspace path containing spaces",
    async () => {
      directory = mkdtempSync(join(tmpdir(), "hunter lease-service-"));
      const root = join(directory, "Repository With Spaces");
      const worktreePath = join(root, "Worktree With Spaces");
      mkdirSync(worktreePath, { recursive: true });
      const boundary = createWorkspacePathBoundary(
        new Map([[repositoryId, root]]),
      );
      const canonicalWorkspaceKey = boundary.canonicalKey(
        boundary.verify(repositoryId, worktreePath),
      );
      const first = service();
      const acquired = WriterLeaseSchema.parse(await first.acquire(
        writer({
          leaseId: "wrl_lease140040",
          ownerId: "own_lease140040",
          workspaceId: "wsp_lease140040",
          worktreeId: "wtr_lease140040",
          canonicalWorkspaceKey,
        }),
      ));

      const restarted = service("2026-07-23T14:02:00.000Z", true);
      await expect(restarted.recoverWriter(acquired.leaseId, {
        deviceBindingId: acquired.deviceBindingId,
        worktreeId: acquired.scope.worktreeId,
        canonicalWorkspaceKey,
        gitHead: acquired.gitHead,
      })).resolves.toEqual(acquired);
    },
  );
});
