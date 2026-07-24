import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentProfileIdSchema, AttemptIdSchema, ControllerLeaseIdSchema, DeviceBindingIdSchema, DeviceIdSchema, EvidenceIdSchema, LeaseOwnerIdSchema, NativeSessionIdSchema, OperationIdSchema, ProjectIdSchema, RepositoryIdSchema, RunIdSchema, RuntimeProviderIdSchema, WorkspaceIdSchema, WorktreeIdSchema, createProject } from "@hunter/domain";
import { CanonicalWorkspaceKeySchema, ControllerLeaseSchema, ExternalOperationReceiptSchema, LeaseSchema, WorkspaceRefSchema, createExternalOperation, createWorkspacePathBoundary, type ExternalOperationHandler } from "@hunter/runtime-contracts";
import { FakeRuntime } from "@hunter/testkit";
import { afterEach, describe, expect, it } from "vitest";

import { createSqliteApplicationServices } from "../src/services/sqlite-application-services.js";
import { startDaemon } from "../src/main.js";

const temporaryFixtures = new Set<string>();
const passingVerifier = {
  verify: async () => ({
    status: "passed" as const,
    evidence: [{
      kind: "test",
      command: "npm test",
      exitCode: 0,
      proofScope: "hunter_contract_only" as const,
    }],
  }),
};

afterEach(() => {
  for (const fixture of temporaryFixtures) {
    rmSync(fixture, { recursive: true, force: true });
  }
  temporaryFixtures.clear();
});

describe("createSqliteApplicationServices", () => {
  it("composes durable services without direct conclusion-event bypasses", async () => {
    const database = new DatabaseSync(":memory:");
    const services = createSqliteApplicationServices({
      database,
      externalHandler: { execute: async () => { throw new Error("not dispatched"); } },
      installSecret: "composition-secret-for-tests",
      allowedHosts: ["hunter-test.localhost"],
      allowedOrigins: ["app://hunter"],
    });
    expect(services).toMatchObject({ journal: expect.anything(), flowEngine: expect.anything(), operationWorker: expect.anything(), recovery: expect.anything(), eventReader: expect.anything() });
    const source = await readFile(new URL("../src/services/sqlite-application-services.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/StepSucceeded|RunSucceeded/u);
    database.close();
  });

  it("clears the legacy version 1 marker after upgrading storage to version 2", async () => {
    const database = new DatabaseSync(":memory:");
    const services = createSqliteApplicationServices({ database, externalHandler: { execute: async () => { throw new Error("not dispatched"); } }, installSecret: "migration-secret-tests", allowedHosts: ["hunter-test.localhost"], allowedOrigins: ["app://hunter"] });
    database.prepare("INSERT INTO storage_metadata(metadata_key, metadata_value, updated_at) VALUES ('migration_in_progress', 'target_schema_version:1', ?)").run(new Date().toISOString());
    const report = await services.recovery.run();
    expect(report.conclusions).toContainEqual({ kind: "migration", status: "rolled_back", schemaVersion: 2 });
    expect(database.prepare("SELECT metadata_value FROM storage_metadata WHERE metadata_key = 'migration_in_progress'").get()).toBeUndefined();
    database.close();
  });

  it("fails closed for an unknown legacy migration marker", async () => {
    const database = new DatabaseSync(":memory:");
    const services = createSqliteApplicationServices({ database, externalHandler: { execute: async () => { throw new Error("not dispatched"); } }, installSecret: "unknown-migration-marker-tests", allowedHosts: ["hunter-test.localhost"], allowedOrigins: ["app://hunter"] });
    database.prepare("INSERT INTO storage_metadata(metadata_key, metadata_value, updated_at) VALUES ('migration_in_progress', 'target_schema_version:999', ?)").run(new Date().toISOString());

    await expect(services.recovery.run()).rejects.toThrowError(
      "INTERRUPTED_MIGRATION_REQUIRES_MANUAL_RECOVERY",
    );
    expect(database.prepare("SELECT metadata_value FROM storage_metadata WHERE metadata_key = 'migration_in_progress'").get()).toEqual({ metadata_value: "target_schema_version:999" });
    database.close();
  });

  it("revalidates the exact ControllerLease generation after Outbox claim and before dispatch", async () => {
    const database = new DatabaseSync(":memory:");
    let clock = new Date("2026-07-22T10:00:00.000Z");
    const runtime = new FakeRuntime({ providerId: RuntimeProviderIdSchema.parse("rtp_authority01"), implementationVersion: "fake", observedAt: clock.toISOString() });
    const services = createSqliteApplicationServices({ database, externalHandler: runtime, installSecret: "dispatch-authority-tests", allowedHosts: ["hunter-test.localhost"], allowedOrigins: ["app://hunter"], now: () => clock });
    const projectId = ProjectIdSchema.parse("prj_authority01");
    const runId = RunIdSchema.parse("run_authority01");
    const attemptId = AttemptIdSchema.parse("att_authority01");
    const workspaceId = WorkspaceIdSchema.parse("wsp_authority01");
    const worktreeId = WorktreeIdSchema.parse("wtr_authority01");
    const lease = ControllerLeaseSchema.parse({
      schemaVersion: 2,
      projectId,
      repositoryId: RepositoryIdSchema.parse("rep_authority01"),
      deviceBindingId: DeviceBindingIdSchema.parse("dev_authority01"),
      canonicalWorkspaceKey: CanonicalWorkspaceKeySchema.parse("posix:/fixtures/authority"),
      gitHead: "a".repeat(40),
      branch: "codex/task14-authority",
      ownerRunId: runId,
      ownerAttemptId: attemptId,
      kind: "controller",
      leaseId: ControllerLeaseIdSchema.parse("ctl_authority01"),
      ownerId: LeaseOwnerIdSchema.parse("own_authority01"),
      generation: 1,
      mode: "write",
      acquiredAt: clock.toISOString(),
      expiresAt: "2026-07-22T10:00:01.000Z",
      revokedAt: null,
      revocationReason: null,
      scope: { workspaceId, worktreeId, nativeSessionId: NativeSessionIdSchema.parse("ses_authority01") },
    });
    await services.leaseService.acquire(lease);
    const operation = createExternalOperation({ schemaVersion: 1, operationId: OperationIdSchema.parse("opn_authority01"), projectId, runId, attemptId, operationVersion: 2, operationType: "session.interrupt", requestedCapabilities: ["interrupt"], payload: { nativeSessionId: lease.scope.nativeSessionId, reason: "test expiry race", controllerLeaseId: lease.leaseId, controllerLeaseOwnerId: lease.ownerId, controllerLeaseGeneration: lease.generation } });
    services.journal.commitCommand({ commandId: "schedule-authority-test", requestFingerprint: operation.fingerprint, projectId: operation.projectId, aggregateId: "authority:test", expectedVersion: 0, actor: { actorId: "test", correlationId: "authority" }, events: [], operations: [operation], response: {} });
    clock = new Date("2026-07-22T10:00:02.000Z");
    await expect(services.operationWorker.runOnce()).resolves.toBe("needs_attention");
    expect(runtime.nativeEffectCount).toBe(0);
    expect(database.prepare("SELECT status FROM outbox WHERE operation_id = ?").get(operation.operationId)).toEqual({ status: "needs_attention" });
    database.close();
  });

  it("requires durable lease authority for every side-effecting operation kind before dispatch", async () => {
    const database = new DatabaseSync(":memory:");
    const runtime = new FakeRuntime({ providerId: RuntimeProviderIdSchema.parse("rtp_allauthority"), implementationVersion: "fake", observedAt: "2026-07-22T10:00:00.000Z" });
    const services = createSqliteApplicationServices({ database, externalHandler: runtime, installSecret: "all-dispatch-authority-tests", allowedHosts: ["hunter-test.localhost"], allowedOrigins: ["app://hunter"], now: () => new Date("2026-07-22T10:00:00.000Z") });
    const projectId = ProjectIdSchema.parse("prj_allauthority");
    const runId = RunIdSchema.parse("run_allauthority");
    const attemptId = AttemptIdSchema.parse("att_allauthority");
    const workspaceId = WorkspaceIdSchema.parse("wsp_allauthority");
    const nativeSessionId = NativeSessionIdSchema.parse("ses_allauthority");
    const controllerAuthority = {
      controllerLeaseId: ControllerLeaseIdSchema.parse("ctl_allauthority"),
      controllerLeaseOwnerId: LeaseOwnerIdSchema.parse("own_allauthority"),
      controllerLeaseGeneration: 1,
    };
    const variants = [
      { operationType: "workspace.prepare", operationVersion: 1, requestedCapabilities: ["workspace_prepare"], payload: { repositoryId: RepositoryIdSchema.parse("rep_allauthority"), deviceBindingId: DeviceBindingIdSchema.parse("dev_allauthority"), workspaceId, mode: "write", baselineRevision: "a".repeat(40) } },
      { operationType: "workspace.release", operationVersion: 1, requestedCapabilities: ["workspace_prepare"], payload: { workspaceId } },
      { operationType: "session.launch", operationVersion: 1, requestedCapabilities: ["launch"], payload: { agentProfileId: AgentProfileIdSchema.parse("apr_allauthority"), workspaceId } },
      { operationType: "session.observe", operationVersion: 2, requestedCapabilities: ["observe"], payload: { nativeSessionId, ...controllerAuthority } },
      { operationType: "session.send", operationVersion: 2, requestedCapabilities: ["send"], payload: { nativeSessionId, inputEvidenceId: EvidenceIdSchema.parse("evd_allauthority"), ...controllerAuthority } },
      { operationType: "session.interrupt", operationVersion: 2, requestedCapabilities: ["interrupt"], payload: { nativeSessionId, reason: "authority test", ...controllerAuthority } },
      { operationType: "session.resume", operationVersion: 2, requestedCapabilities: ["resume"], payload: { nativeSessionId, ...controllerAuthority } },
      { operationType: "native_surface.open", operationVersion: 1, requestedCapabilities: ["native_surface"], payload: { workspaceId } },
      { operationType: "task_pack.write", operationVersion: 2, requestedCapabilities: ["artifact_export"], payload: { workspaceId, inputEvidenceId: EvidenceIdSchema.parse("evd_allauthority") } },
    ] as const;
    for (const [index, variant] of variants.entries()) {
      const operation = createExternalOperation({
        schemaVersion: 1,
        operationId: OperationIdSchema.parse(`opn_allauthority${index}`),
        projectId,
        runId,
        attemptId,
        ...variant,
      });
      services.journal.commitCommand({
        commandId: `schedule-all-authority-${index}`,
        requestFingerprint: operation.fingerprint,
        projectId,
        aggregateId: `authority:${index}`,
        expectedVersion: 0,
        actor: { actorId: "test", correlationId: "all-authority" },
        events: [],
        operations: [operation],
        response: {},
      });
    }
    for (let index = 0; index < variants.length; index += 1) {
      await expect(services.operationWorker.runOnce()).resolves.toBe("needs_attention");
    }
    expect(runtime.nativeEffectCount).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM outbox WHERE status = 'needs_attention'").get()).toEqual({ count: variants.length });
    database.close();
  });

  it.each([
    ["relative", "."],
    ["absolute outside", "outside"],
    ["lexical-prefix sibling", "repository-copy"],
    ["same-name sibling", "same-name"],
  ])(
    "rejects a provider-reported %s Git workspace outside the persisted available DeviceBinding root",
    async (_label, reportedPathKind) => {
      const fixture = mkdtempSync(join(tmpdir(), "hunter-workspace-scope-"));
      temporaryFixtures.add(fixture);
      const repositoryPath = join(fixture, "repository");
      const outsidePath = join(fixture, "outside");
      const prefixSiblingPath = join(fixture, "repository-copy");
      const sameNameSiblingPath = join(fixture, "other", "repository");
      const initializeRepository = (path: string, branchSuffix: string): string => {
        execFileSync("git", ["init", path], { windowsHide: true });
        execFileSync("git", ["-C", path, "config", "user.email", "hunter@example.invalid"], { windowsHide: true });
        execFileSync("git", ["-C", path, "config", "user.name", "Hunter Test"], { windowsHide: true });
        writeFileSync(join(path, "README.md"), `${branchSuffix}\n`, "utf8");
        execFileSync("git", ["-C", path, "add", "README.md"], { windowsHide: true });
        execFileSync("git", ["-C", path, "commit", "-m", "fixture"], { windowsHide: true });
        return execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim();
      };
      const baseline = initializeRepository(repositoryPath, "authorized");
      initializeRepository(outsidePath, "outside");
      initializeRepository(prefixSiblingPath, "prefix");
      initializeRepository(sameNameSiblingPath, "same-name");
      const reportedWorkspacePath = reportedPathKind === "."
        ? "."
        : reportedPathKind === "outside"
          ? outsidePath
          : reportedPathKind === "repository-copy"
            ? prefixSiblingPath
            : sameNameSiblingPath;
      const suffix = `${reportedPathKind.replaceAll(/[^a-z]/gu, "") || "relative"}01`;
      const projectId = ProjectIdSchema.parse(`prj_scope${suffix}`);
      const repositoryId = RepositoryIdSchema.parse(`rep_scope${suffix}`);
      const deviceBindingId = DeviceBindingIdSchema.parse(`dev_scope${suffix}`);
      const runId = RunIdSchema.parse(`run_scope${suffix}`);
      const attemptId = AttemptIdSchema.parse(`att_scope${suffix}`);
      const workspaceId = WorkspaceIdSchema.parse(`wsp_scope${suffix}`);
      const operationId = OperationIdSchema.parse(`opn_scope${suffix}`);
      const worktreeId = WorktreeIdSchema.parse(`wtr_scope${suffix}`);
      const runtime = new FakeRuntime({
        providerId: RuntimeProviderIdSchema.parse("rtp_scopeboundary"),
        implementationVersion: "fake",
        observedAt: "2026-07-22T10:00:00.000Z",
      });
      const database = new DatabaseSync(":memory:");
      const services = createSqliteApplicationServices({
        database,
        externalHandler: {
          execute: async (operation) => {
            const receipt = await runtime.execute(operation);
            return ExternalOperationReceiptSchema.parse({
              ...receipt,
              workspaceResult: {
                workspaceRef: WorkspaceRefSchema.parse(`fake:${operation.operationId}`),
                worktreeId,
                reportedWorkspacePath,
              },
            });
          },
        },
        installSecret: "workspace-scope-tests",
        allowedHosts: ["hunter-test.localhost"],
        allowedOrigins: ["app://hunter"],
        now: () => new Date("2026-07-22T10:00:00.000Z"),
      });
      const project = createProject({
        projectId,
        name: "Workspace scope",
        repositoryBindings: [{ repositoryId, role: "primary" }],
        deviceBindings: [{
          deviceBindingId,
          deviceId: DeviceIdSchema.parse(`dvc_scope${suffix}`),
          repositoryId,
          localPath: repositoryPath,
          availability: "available",
        }],
      });
      services.journal.commitCommand({
        commandId: `scope-project:${operationId}`,
        requestFingerprint: "f".repeat(64),
        projectId,
        aggregateId: `project:${projectId}`,
        expectedVersion: 0,
        actor: { actorId: "test", correlationId: "workspace-scope" },
        events: [{
          eventId: `evt_${operationId}`,
          eventType: "ProjectCreated",
          eventData: { projectId, project },
          schemaVersion: 1,
          occurredAt: "2026-07-22T10:00:00.000Z",
        }],
        operations: [],
        response: {},
      });
      const operation = createExternalOperation({
        schemaVersion: 1,
        operationId,
        projectId,
        runId,
        attemptId,
        operationVersion: 1,
        operationType: "workspace.prepare",
        requestedCapabilities: ["workspace_prepare"],
        payload: {
          repositoryId,
          deviceBindingId,
          workspaceId,
          mode: "write",
          baselineRevision: baseline,
        },
      });
      await services.acquireWorkspaceLease(operation);
      services.journal.commitCommand({
        commandId: `scope-operation:${operationId}`,
        requestFingerprint: operation.fingerprint,
        projectId,
        aggregateId: `scope:${operationId}`,
        expectedVersion: 0,
        actor: { actorId: "test", correlationId: "workspace-scope" },
        events: [],
        operations: [operation],
        response: {},
      });

      await expect(services.operationWorker.runOnce()).resolves.toBe(
        "needs_attention",
      );
      await expect(services.operationWorker.runOnce()).resolves.toBe("idle");
      expect(runtime.nativeEffectCount).toBe(1);
      expect(database.prepare("SELECT COUNT(*) AS count FROM lease_records WHERE lease_kind = 'writer'").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM side_effect_receipts").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM evidence_records").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'ExternalOperationObserved'").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT status FROM outbox WHERE operation_id = ?").get(operationId)).toEqual({ status: "needs_attention" });
      database.close();
      rmSync(fixture, { recursive: true, force: true });
      temporaryFixtures.delete(fixture);
    },
    20_000,
  );

  it("bootstraps Workspace -> Writer -> Controller leases only from durable worker receipts", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "hunter-lease-bootstrap-"));
    temporaryFixtures.add(fixture);
    const repositoryPath = join(fixture, "repository");
    const worktreePath = join(repositoryPath, ".hunter-worktrees", "bootstrap");
    execFileSync("git", ["init", repositoryPath], { windowsHide: true });
    execFileSync("git", ["-C", repositoryPath, "config", "user.email", "hunter@example.invalid"], { windowsHide: true });
    execFileSync("git", ["-C", repositoryPath, "config", "user.name", "Hunter Test"], { windowsHide: true });
    writeFileSync(join(repositoryPath, "README.md"), "bootstrap\n", "utf8");
    execFileSync("git", ["-C", repositoryPath, "add", "README.md"], { windowsHide: true });
    execFileSync("git", ["-C", repositoryPath, "commit", "-m", "fixture"], { windowsHide: true });
    execFileSync("git", ["-C", repositoryPath, "worktree", "add", "-b", "codex/task14-bootstrap", worktreePath], { windowsHide: true });
    const baseline = execFileSync("git", ["-C", repositoryPath, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim();
    const repositoryId = RepositoryIdSchema.parse("rep_bootstrap001");
    const worktreeBoundary = createWorkspacePathBoundary(new Map([[repositoryId, worktreePath]]));
    const verifiedWorktreePath = worktreeBoundary.verify(repositoryId, worktreePath);
    const worktreeId = WorktreeIdSchema.parse("wtr_bootstrap001");
    const stableNativeSessionId = NativeSessionIdSchema.parse(
      "ses_bootstrap001",
    );
    const runtimes: FakeRuntime[] = [];
    const createHandler = (): ExternalOperationHandler => {
      const runtime = new FakeRuntime({ providerId: RuntimeProviderIdSchema.parse("rtp_bootstrap001"), implementationVersion: "fake", observedAt: "2026-07-22T10:00:00.000Z" });
      runtimes.push(runtime);
      return {
        execute: async (operation) => {
          const receipt = await runtime.execute(operation);
          return ExternalOperationReceiptSchema.parse(
            operation.operationType === "workspace.prepare"
              ? {
                  ...receipt,
                  workspaceResult: {
                    workspaceRef: WorkspaceRefSchema.parse(
                      `fake:${operation.operationId}`,
                    ),
                    worktreeId,
                    reportedWorkspacePath: verifiedWorktreePath,
                  },
                }
              : operation.operationType === "session.launch"
                ? {
                    ...receipt,
                    nativeReferences: [{
                      kind: "session",
                      referenceId: stableNativeSessionId,
                    }],
                  }
              : receipt,
          );
        },
      };
    };
    const databasePath = join(fixture, "hunter.sqlite");
    let database = new DatabaseSync(databasePath);
    let services = createSqliteApplicationServices({
      database,
      externalHandler: createHandler(),
      installSecret: "lease-bootstrap-tests",
      allowedHosts: ["hunter-test.localhost"],
      allowedOrigins: ["app://hunter"],
      now: () => new Date("2026-07-22T10:00:00.000Z"),
    });
    const common = {
      schemaVersion: 1 as const,
      projectId: ProjectIdSchema.parse("prj_bootstrap001"),
      runId: RunIdSchema.parse("run_bootstrap001"),
      attemptId: AttemptIdSchema.parse("att_bootstrap001"),
    };
    const project = createProject({
      projectId: common.projectId,
      name: "Lease bootstrap",
      repositoryBindings: [{ repositoryId, role: "primary" }],
      deviceBindings: [{
        deviceBindingId: DeviceBindingIdSchema.parse("dev_bootstrap001"),
        deviceId: DeviceIdSchema.parse("dvc_bootstrap001"),
        repositoryId,
        localPath: repositoryPath,
        availability: "available",
      }],
    });
    services.journal.commitCommand({
      commandId: "bootstrap:project",
      requestFingerprint: "e".repeat(64),
      projectId: common.projectId,
      aggregateId: `project:${common.projectId}`,
      expectedVersion: 0,
      actor: { actorId: "test", correlationId: "bootstrap" },
      events: [{
        eventId: "evt_bootstrap_project",
        eventType: "ProjectCreated",
        eventData: { projectId: common.projectId, project },
        schemaVersion: 1,
        occurredAt: "2026-07-22T10:00:00.000Z",
      }],
      operations: [],
      response: {},
    });
    const workspaceId = WorkspaceIdSchema.parse("wsp_bootstrap001");
    const prepare = (operationId: string) => createExternalOperation({
      ...common,
      operationId: OperationIdSchema.parse(operationId),
      operationVersion: 1,
      operationType: "workspace.prepare",
      requestedCapabilities: ["workspace_prepare"],
      payload: {
        repositoryId,
        deviceBindingId: DeviceBindingIdSchema.parse("dev_bootstrap001"),
        workspaceId,
        mode: "write",
        baselineRevision: baseline,
      },
    });
    const commit = (operation: ReturnType<typeof prepare>) => services.journal.commitCommand({
      commandId: `bootstrap:${operation.operationId}`,
      requestFingerprint: operation.fingerprint,
      projectId: operation.projectId,
      aggregateId: `bootstrap:${operation.operationId}`,
      expectedVersion: 0,
      actor: { actorId: "test", correlationId: "bootstrap" },
      events: [],
      operations: [operation],
      response: {},
    });

    commit(prepare("opn_bootstrapdeny01"));
    await expect(services.operationWorker.runOnce()).resolves.toBe("needs_attention");
    expect(runtimes[0]!.nativeEffectCount).toBe(0);

    const authorizedPrepare = prepare("opn_bootstrapprepare");
    await services.acquireWorkspaceLease(authorizedPrepare);
    expect((database.prepare("SELECT COUNT(*) AS count FROM lease_records WHERE lease_kind = 'workspace'").get() as { count: number }).count).toBe(1);
    expect((database.prepare("SELECT COUNT(*) AS count FROM lease_records WHERE lease_kind = 'writer'").get() as { count: number }).count).toBe(0);
    commit(authorizedPrepare);
    await expect(services.operationWorker.runOnce()).resolves.toBe("completed");
    expect((database.prepare("SELECT COUNT(*) AS count FROM lease_records WHERE lease_kind = 'writer'").get() as { count: number }).count).toBe(1);
    expect(runtimes[0]!.nativeEffectCount).toBe(1);

    database.close();
    database = new DatabaseSync(databasePath);
    services = createSqliteApplicationServices({
      database,
      externalHandler: createHandler(),
      installSecret: "lease-bootstrap-tests",
      allowedHosts: ["hunter-test.localhost"],
      allowedOrigins: ["app://hunter"],
      now: () => new Date("2026-07-22T10:00:00.000Z"),
    });
    expect(services.operationWorker.resolveReceipt(authorizedPrepare)).toMatchObject({
      operationId: authorizedPrepare.operationId,
      workspaceResult: {
        worktreeId,
        reportedWorkspacePath: verifiedWorktreePath,
      },
    });
    expect((database.prepare("SELECT COUNT(*) AS count FROM lease_records WHERE lease_kind = 'writer'").get() as { count: number }).count).toBe(1);
    expect(runtimes[1]!.nativeEffectCount).toBe(0);

    const preRetryLeases = (database.prepare(
      "SELECT receipt_json FROM lease_records WHERE lease_kind IN ('workspace', 'writer')",
    ).all() as Array<{ receipt_json: string }>).map((row) =>
      LeaseSchema.parse(JSON.parse(row.receipt_json))
    );
    for (const lease of preRetryLeases) {
      await services.leaseService.release({
        leaseId: lease.leaseId,
        ownerId: lease.ownerId,
        generation: lease.generation,
      });
    }
    const retryPrepare = prepare("opn_bootstrapretry01");
    const retryWorkspace = await services.acquireWorkspaceLease(retryPrepare);
    expect(retryWorkspace.generation).toBe(2);
    commit(retryPrepare);
    await expect(services.operationWorker.runOnce()).resolves.toBe("completed");
    const retryWriter = LeaseSchema.parse(JSON.parse((
      database.prepare(
        "SELECT receipt_json FROM lease_records WHERE lease_kind = 'writer'",
      ).get() as { receipt_json: string }
    ).receipt_json));
    expect(retryWriter).toMatchObject({ kind: "writer", generation: 2 });

    const launch = (operationId: string) => createExternalOperation({
      ...common,
      operationId: OperationIdSchema.parse(operationId),
      operationVersion: 1,
      operationType: "session.launch",
      requestedCapabilities: ["launch"],
      payload: {
        agentProfileId: AgentProfileIdSchema.parse("apr_bootstrap001"),
        workspaceId,
      },
    });
    const firstLaunch = launch("opn_bootstraplaunch");
    services.journal.commitCommand({
      commandId: "bootstrap:launch",
      requestFingerprint: firstLaunch.fingerprint,
      projectId: firstLaunch.projectId,
      aggregateId: "bootstrap:launch",
      expectedVersion: 0,
      actor: { actorId: "test", correlationId: "bootstrap" },
      events: [],
      operations: [firstLaunch],
      response: {},
    });
    await expect(services.operationWorker.runOnce()).resolves.toBe("completed");
    let controller = LeaseSchema.parse(JSON.parse((
      database.prepare(
        "SELECT receipt_json FROM lease_records WHERE lease_kind = 'controller'",
      ).get() as { receipt_json: string }
    ).receipt_json));
    expect(controller).toMatchObject({
      kind: "controller",
      generation: 1,
      ownerRunId: common.runId,
      ownerAttemptId: common.attemptId,
      scope: { workspaceId, worktreeId, nativeSessionId: stableNativeSessionId },
    });
    await services.leaseService.release({
      leaseId: controller.leaseId,
      ownerId: controller.ownerId,
      generation: controller.generation,
    });
    const retryLaunch = launch("opn_bootstraplaunch2");
    services.journal.commitCommand({
      commandId: "bootstrap:launch:retry",
      requestFingerprint: retryLaunch.fingerprint,
      projectId: retryLaunch.projectId,
      aggregateId: "bootstrap:launch:retry",
      expectedVersion: 0,
      actor: { actorId: "test", correlationId: "bootstrap" },
      events: [],
      operations: [retryLaunch],
      response: {},
    });
    await expect(services.operationWorker.runOnce()).resolves.toBe("completed");
    const leases = (database.prepare("SELECT receipt_json FROM lease_records ORDER BY lease_kind").all() as Array<{ receipt_json: string }>).map((row) => LeaseSchema.parse(JSON.parse(row.receipt_json)));
    expect(leases.map(({ kind }) => kind).sort()).toEqual(["controller", "workspace", "writer"]);
    controller = leases.find((lease) => lease.kind === "controller")!;
    expect(controller).toMatchObject({
      generation: 2,
      scope: { nativeSessionId: stableNativeSessionId },
    });
    expect(runtimes.map(({ nativeEffectCount }) => nativeEffectCount)).toEqual([
      1,
      3,
    ]);
    database.close();
    rmSync(fixture, { recursive: true, force: true });
    temporaryFixtures.delete(fixture);
  }, 20_000);

  it("persists production Project authorization narrowing across daemon restart without widening token scope", () => {
    const path = join(mkdtempSync(join(tmpdir(), "hunter-authz-registry-")), "authz.sqlite");
    const projectA = ProjectIdSchema.parse("prj_authz000001");
    const projectB = ProjectIdSchema.parse("prj_authz000002");
    let database = new DatabaseSync(path);
    let services = createSqliteApplicationServices({ database, externalHandler: { execute: async () => { throw new Error("not dispatched"); } }, installSecret: "production-authz-tests", allowedHosts: ["hunter-test.localhost"], allowedOrigins: ["app://hunter"] });
    const token = services.authenticator.issueSession({ principalId: "desktop-user", authorizedProjectIds: [projectA], expiresAt: new Date(Date.now() + 60_000), csrf: "authz-csrf" });
    expect(services.authenticator.authenticate(token).authorizedProjectIds).toEqual([projectA]);
    services.setPrincipalProjectAuthorization("desktop-user", [projectA, projectB]);
    expect(services.authenticator.authenticate(token).authorizedProjectIds).toEqual([projectA]);
    services.setPrincipalProjectAuthorization("desktop-user", [projectB]);
    expect(services.authenticator.authenticate(token).authorizedProjectIds).toEqual([]);
    database.close();

    database = new DatabaseSync(path);
    services = createSqliteApplicationServices({ database, externalHandler: { execute: async () => { throw new Error("not dispatched"); } }, installSecret: "production-authz-tests", allowedHosts: ["hunter-test.localhost"], allowedOrigins: ["app://hunter"] });
    expect(services.authenticator.authenticate(token).authorizedProjectIds).toEqual([]);
    database.close();
  });

  it("resolves an OS-owned SecretRef before listen and persists only the reference", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "hunter-secret-ref-"));
    const resolved: string[] = [];
    const daemon = await startDaemon({
      dataDirectory,
      secretRef: "os-credential://hunter/install",
      secretStore: { resolveSecret: async (secretRef) => { resolved.push(secretRef); return "resolved-install-secret-tests"; } },
      externalHandler: { execute: async () => { throw new Error("not dispatched"); } },
      verifier: passingVerifier,
      allowedHost: "hunter-test.localhost",
      allowedOrigin: "app://hunter",
      publishPort: async () => undefined,
    });
    expect(resolved).toEqual(["os-credential://hunter/install"]);
    expect(daemon.port).toBeGreaterThan(0);
    expect(daemon.remote).toEqual({ status: "disabled" });
    const inspection = new DatabaseSync(join(dataDirectory, "hunter.sqlite"));
    expect(inspection.prepare("SELECT metadata_value FROM storage_metadata WHERE metadata_key = 'local_secret_ref'").get()).toEqual({ metadata_value: "os-credential://hunter/install" });
    expect(JSON.stringify(inspection.prepare("SELECT metadata_value FROM storage_metadata").all())).not.toContain("resolved-install-secret-tests");
    inspection.close();
    await daemon.shutdown();
    await daemon.shutdown();
  });

  it("rejects raw secrets and unsupported SecretRef schemes before resolution", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "hunter-invalid-secret-ref-"));
    let resolved = false;
    await expect(startDaemon({
      dataDirectory,
      secretRef: "raw-install-secret",
      secretStore: { resolveSecret: async () => { resolved = true; return "must-not-resolve"; } },
      externalHandler: { execute: async () => { throw new Error("not dispatched"); } },
      verifier: passingVerifier,
      allowedHost: "hunter-test.localhost",
      allowedOrigin: "app://hunter",
      publishPort: async () => undefined,
    })).rejects.toThrow(/SECRET_REF_SCHEME_INVALID/u);
    expect(resolved).toBe(false);
  });

  it("fails a future storage migration before publishing a listener", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "hunter-future-schema-"));
    temporaryFixtures.add(dataDirectory);
    const database = new DatabaseSync(join(dataDirectory, "hunter.sqlite"));
    database.exec(`
      CREATE TABLE storage_metadata (
        metadata_key TEXT PRIMARY KEY,
        metadata_value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO storage_metadata(metadata_key, metadata_value, updated_at)
      VALUES ('schema_version', '999', '2026-07-24T09:30:00.000Z');
    `);
    database.close();
    let published = false;

    await expect(startDaemon({
      dataDirectory,
      secretRef: "os-credential://hunter/install",
      secretStore: {
        resolveSecret: async () => "resolved-install-secret-tests",
      },
      externalHandler: {
        execute: async () => {
          throw new Error("not dispatched");
        },
      },
      verifier: passingVerifier,
      allowedHost: "hunter-test.localhost",
      allowedOrigin: "app://hunter",
      publishPort: async () => {
        published = true;
      },
    })).rejects.toThrowError("STORAGE_SCHEMA_VERSION_UNSUPPORTED");
    expect(published).toBe(false);

    const inspection = new DatabaseSync(
      join(dataDirectory, "hunter.sqlite"),
      { readOnly: true },
    );
    expect(
      inspection.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'",
      ).get(),
    ).toBeUndefined();
    expect(
      inspection.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'storage_migrations'",
      ).get(),
    ).toBeUndefined();
    inspection.close();
  });

  it("routes explicit remote enablement through the guarded TLS listener and OS secret references", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "hunter-remote-composition-"));
    const resolved: string[] = [];
    let caught: unknown;
    try {
      const daemon = await startDaemon({
        dataDirectory,
        secretRef: "os-credential://hunter/install",
        secretStore: {
          resolveSecret: async (secretRef) => {
            resolved.push(secretRef);
            if (secretRef.endsWith("/signing")) return "device-signing-material-at-least-32-bytes";
            return "test-only-nonempty-tls-material";
          },
        },
        externalHandler: { execute: async () => { throw new Error("not dispatched"); } },
        verifier: passingVerifier,
        allowedHost: "hunter-test.localhost",
        allowedOrigin: "app://hunter",
        publishPort: async () => undefined,
        remote: {
          enabled: true,
          host: "127.0.0.1",
          port: 0,
          issuer: "https://remote.hunter",
          allowedHosts: ["remote.hunter"],
          allowedOrigins: ["https://phone.example"],
          signingSecretRef: "os-credential://hunter/device/signing",
          tlsKeyRef: "os-credential://hunter/device/tls-key",
          tlsCertRef: "os-credential://hunter/device/tls-cert",
        },
      });
      await daemon.shutdown();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("REMOTE_LISTENER_REQUIRES_NON_LOOPBACK_HOST");
    expect(resolved).toEqual([
      "os-credential://hunter/install",
      "os-credential://hunter/device/signing",
      "os-credential://hunter/device/tls-key",
      "os-credential://hunter/device/tls-cert",
    ]);
  });
});
