import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectIdSchema } from "@hunter/domain";
import { EventLedgerReader, SqliteOperationJournal } from "@hunter/storage";
import { describe, expect, it } from "vitest";

import { DurableEventStream, refreshEventAuthorization } from "../src/events/durable-event-stream.js";
import { LocalAuthenticator } from "../src/auth/local-authenticator.js";
import { buildApp } from "../src/app.js";

const projectA = ProjectIdSchema.parse("prj_stream0001");
const projectB = ProjectIdSchema.parse("prj_stream0002");

function commit(journal: SqliteOperationJournal, projectId: typeof projectA, index: number) {
  journal.commitCommand({ commandId: `stream:${index}`, requestFingerprint: index.toString(16).padStart(64, "0"), projectId, aggregateId: `stream:${index}`, expectedVersion: 0, actor: { actorId: "stream-test", correlationId: "stream-test" }, events: [{ eventId: `evt_stream_${index}`, eventType: "StreamFixture", eventData: { index }, schemaVersion: 1, occurredAt: `2026-07-22T10:00:0${index}.000Z` }], operations: [], response: {} });
}

describe("DurableEventStream", () => {
  it("replays authorized positions exactly once across database restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "hunter-sse-"));
    const path = join(directory, "events.sqlite");
    const firstDb = new DatabaseSync(path);
    const journal = new SqliteOperationJournal(firstDb);
    commit(journal, projectA, 1);
    commit(journal, projectB, 2);
    firstDb.close();

    const secondDb = new DatabaseSync(path);
    const secondJournal = new SqliteOperationJournal(secondDb);
    commit(secondJournal, projectA, 3);
    const replay = new DurableEventStream(new EventLedgerReader(secondDb)).replay({ headerCursor: "1", authorizedProjectIds: [projectA] });
    expect(replay.status).toBe("ok");
    if (replay.status === "ok") expect(replay.events.map(({ position }) => position)).toEqual([3]);
    secondDb.close();
  });

  it("rejects conflicting, malformed, future, and expired cursors explicitly", () => {
    const database = new DatabaseSync(":memory:");
    const journal = new SqliteOperationJournal(database);
    commit(journal, projectA, 1);
    const reader = new EventLedgerReader(database);
    const stream = new DurableEventStream(reader);
    expect(() => stream.replay({ headerCursor: "0", queryCursor: "1", authorizedProjectIds: [projectA] })).toThrow(/EVENT_CURSOR_CONFLICT/u);
    expect(() => stream.replay({ headerCursor: "bad", authorizedProjectIds: [projectA] })).toThrow(/EVENT_CURSOR_INVALID/u);
    expect(() => stream.replay({ headerCursor: "2", authorizedProjectIds: [projectA] })).toThrow(/EVENT_CURSOR_INVALID/u);
    reader.setRetentionFloor(1);
    expect(stream.replay({ headerCursor: "0", authorizedProjectIds: [projectA] })).toEqual({ status: "resync_required", code: "EVENT_CURSOR_RESYNC_REQUIRED", retentionFloor: 1, highWaterPosition: 1, snapshotUrl: "/events/snapshot" });
    database.close();
  });

  it("formats durable Event Ledger positions as SSE ids without cross-Project leakage", () => {
    const database = new DatabaseSync(":memory:");
    const journal = new SqliteOperationJournal(database);
    commit(journal, projectB, 1);
    commit(journal, projectA, 2);
    const stream = new DurableEventStream(new EventLedgerReader(database));
    const result = stream.replay({ headerCursor: "0", authorizedProjectIds: [projectA] });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const body = stream.format(result.events);
      expect(body).toContain("id: 2");
      expect(body).not.toContain("id: 1");
    }
    database.close();
  });

  it("enforces per-principal and global connection limits with idempotent release", () => {
    const database = new DatabaseSync(":memory:");
    new SqliteOperationJournal(database);
    const stream = new DurableEventStream(new EventLedgerReader(database), { global: 2, perPrincipal: 1 });
    const releaseA = stream.acquire("principal-a");
    expect(() => stream.acquire("principal-a")).toThrow(/SSE_CONNECTION_LIMIT/u);
    const releaseB = stream.acquire("principal-b");
    expect(() => stream.acquire("principal-c")).toThrow(/SSE_CONNECTION_LIMIT/u);
    releaseA();
    releaseA();
    const releaseC = stream.acquire("principal-c");
    releaseB();
    releaseC();
    database.close();
  });

  it("formats keepalives without consuming a durable Event Ledger position", () => {
    const database = new DatabaseSync(":memory:");
    new SqliteOperationJournal(database);
    const stream = new DurableEventStream(new EventLedgerReader(database));
    expect(stream.formatKeepalive()).toBe(": keepalive\n\n");
    expect(stream.formatKeepalive()).not.toMatch(/^id:/mu);
    database.close();
  });

  it("returns a real projection snapshot filtered to authorized Projects", () => {
    const database = new DatabaseSync(":memory:");
    const journal = new SqliteOperationJournal(database);
    commit(journal, projectA, 1);
    commit(journal, projectB, 2);
    const stream = new DurableEventStream(new EventLedgerReader(database), undefined, undefined, (authorizedProjectIds) => ({
      projectionVersion: 7,
      cursor: 2,
      entities: [
        { projectId: projectA, entityId: "visible" },
        { projectId: projectB, entityId: "hidden" },
      ].filter(({ projectId }) => authorizedProjectIds.includes(projectId)),
    }));
    expect(stream.snapshot([projectA])).toEqual({ projectionVersion: 7, cursor: 2, entities: [{ projectId: projectA, entityId: "visible" }] });
    database.close();
  });

  it("serves authenticated replay and scope-filtered snapshot through Fastify routes", async () => {
    const database = new DatabaseSync(":memory:");
    const journal = new SqliteOperationJournal(database);
    commit(journal, projectA, 1);
    commit(journal, projectB, 2);
    const reader = new EventLedgerReader(database);
    const stream = new DurableEventStream(reader, undefined, undefined, (authorizedProjectIds) => ({ projectionVersion: 3, cursor: 2, entities: authorizedProjectIds.map((projectId) => ({ projectId })) }));
    const authenticator = new LocalAuthenticator("stream-endpoint-secret");
    const token = authenticator.issueSession({ principalId: "stream-user", authorizedProjectIds: [projectA], expiresAt: new Date(Date.now() + 60_000), csrf: "stream-csrf" });
    const app = buildApp({ authenticator, allowedHosts: ["hunter-test.localhost"], allowedOrigins: ["app://hunter"], eventStream: stream, services: { listProjects: async () => [], projectForExecutionPlan: () => null, startRun: async () => ({}) } });
    const headers = { host: "hunter-test.localhost", origin: "app://hunter", authorization: `Bearer ${token}` };
    const replay = await app.inject({ method: "GET", url: "/events?once=1", headers });
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toContain("id: 1");
    expect(replay.body).not.toContain("id: 2");
    const snapshot = await app.inject({ method: "GET", url: "/events/snapshot", headers });
    expect(snapshot.json()).toEqual({ projectionVersion: 3, cursor: 2, entities: [{ projectId: projectA }] });
    await app.close();
    database.close();
  });

  it("re-evaluates current Project authorization for every live Event without widening the session capability", () => {
    let currentProjectIds = [projectA, projectB];
    const authenticator = new LocalAuthenticator("stream-dynamic-auth-secret", () => false, () => currentProjectIds);
    const token = authenticator.issueSession({ principalId: "stream-user", authorizedProjectIds: [projectA], expiresAt: new Date(Date.now() + 60_000), csrf: "stream-csrf" });
    expect(refreshEventAuthorization(authenticator, token, projectA)).toBe(true);
    expect(refreshEventAuthorization(authenticator, token, projectB)).toBe(false);
    currentProjectIds = [projectB];
    expect(refreshEventAuthorization(authenticator, token, projectA)).toBe(false);
    expect(refreshEventAuthorization(authenticator, token, projectB)).toBe(false);
  });
});
