import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AttemptIdSchema, ControllerLeaseIdSchema, LeaseOwnerIdSchema, NativeSessionIdSchema, OperationIdSchema, ProjectIdSchema, RunIdSchema, RuntimeProviderIdSchema } from "@hunter/domain";
import { ControllerLeaseSchema, createExternalOperation } from "@hunter/runtime-contracts";
import { FakeRuntime } from "@hunter/testkit";
import { describe, expect, it } from "vitest";

import { createSqliteApplicationServices } from "../src/services/sqlite-application-services.js";
import { startDaemon } from "../src/main.js";

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

  it("transactionally clears the one known interrupted migration marker before serving", async () => {
    const database = new DatabaseSync(":memory:");
    const services = createSqliteApplicationServices({ database, externalHandler: { execute: async () => { throw new Error("not dispatched"); } }, installSecret: "migration-secret-tests", allowedHosts: ["hunter-test.localhost"], allowedOrigins: ["app://hunter"] });
    database.prepare("INSERT INTO storage_metadata(metadata_key, metadata_value, updated_at) VALUES ('migration_in_progress', 'target_schema_version:1', ?)").run(new Date().toISOString());
    const report = await services.recovery.run();
    expect(report.conclusions).toContainEqual({ kind: "migration", status: "rolled_back", schemaVersion: 1 });
    expect(database.prepare("SELECT metadata_value FROM storage_metadata WHERE metadata_key = 'migration_in_progress'").get()).toBeUndefined();
    database.close();
  });

  it("revalidates the exact ControllerLease generation after Outbox claim and before dispatch", async () => {
    const database = new DatabaseSync(":memory:");
    let clock = new Date("2026-07-22T10:00:00.000Z");
    const runtime = new FakeRuntime({ providerId: RuntimeProviderIdSchema.parse("rtp_authority01"), implementationVersion: "fake", observedAt: clock.toISOString() });
    const services = createSqliteApplicationServices({ database, externalHandler: runtime, installSecret: "dispatch-authority-tests", allowedHosts: ["hunter-test.localhost"], allowedOrigins: ["app://hunter"], now: () => clock });
    const lease = ControllerLeaseSchema.parse({ schemaVersion: 1, kind: "controller", leaseId: ControllerLeaseIdSchema.parse("ctl_authority01"), ownerId: LeaseOwnerIdSchema.parse("own_authority01"), generation: 1, acquiredAt: clock.toISOString(), expiresAt: "2026-07-22T10:00:01.000Z", scope: { nativeSessionId: NativeSessionIdSchema.parse("ses_authority01") } });
    await services.leaseService.acquire(lease);
    const operation = createExternalOperation({ schemaVersion: 1, operationId: OperationIdSchema.parse("opn_authority01"), projectId: ProjectIdSchema.parse("prj_authority01"), runId: RunIdSchema.parse("run_authority01"), attemptId: AttemptIdSchema.parse("att_authority01"), operationVersion: 2, operationType: "session.interrupt", requestedCapabilities: ["interrupt"], payload: { nativeSessionId: lease.scope.nativeSessionId, reason: "test expiry race", controllerLeaseId: lease.leaseId, controllerLeaseOwnerId: lease.ownerId, controllerLeaseGeneration: lease.generation } });
    services.journal.commitCommand({ commandId: "schedule-authority-test", requestFingerprint: operation.fingerprint, projectId: operation.projectId, aggregateId: "authority:test", expectedVersion: 0, actor: { actorId: "test", correlationId: "authority" }, events: [], operations: [operation], response: {} });
    clock = new Date("2026-07-22T10:00:02.000Z");
    await expect(services.operationWorker.runOnce()).resolves.toBe("needs_attention");
    expect(runtime.nativeEffectCount).toBe(0);
    expect(database.prepare("SELECT status FROM outbox WHERE operation_id = ?").get(operation.operationId)).toEqual({ status: "needs_attention" });
    database.close();
  });

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
      allowedHost: "hunter-test.localhost",
      allowedOrigin: "app://hunter",
      publishPort: async () => undefined,
    });
    expect(resolved).toEqual(["os-credential://hunter/install"]);
    expect(daemon.port).toBeGreaterThan(0);
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
      allowedHost: "hunter-test.localhost",
      allowedOrigin: "app://hunter",
      publishPort: async () => undefined,
    })).rejects.toThrow(/SECRET_REF_SCHEME_INVALID/u);
    expect(resolved).toBe(false);
  });
});
