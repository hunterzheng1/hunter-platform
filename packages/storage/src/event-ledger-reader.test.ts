import { DatabaseSync } from "node:sqlite";

import { ProjectIdSchema } from "@hunter/domain";
import { afterEach, describe, expect, it } from "vitest";

import { EventLedgerReader } from "./event-ledger-reader.js";
import { SqliteOperationJournal } from "./sqlite-operation-journal.js";

const projectA = ProjectIdSchema.parse("prj_project001");
const projectB = ProjectIdSchema.parse("prj_project002");

describe("EventLedgerReader", () => {
  let database: DatabaseSync | undefined;
  afterEach(() => database?.close());

  function setup() {
    database = new DatabaseSync(":memory:");
    const journal = new SqliteOperationJournal(database);
    [projectA, projectB, projectA, projectB].forEach((projectId, index) => {
      journal.commitCommand({
        commandId: `cmd_reader_${index}`,
        requestFingerprint: index.toString(16).padStart(64, "0"),
        projectId,
        aggregateId: `reader:${index}`,
        expectedVersion: 0,
        actor: { actorId: "reader-test", correlationId: "reader-test" },
        events: [
          {
            eventId: `evt_reader_${index}`,
            eventType: "ReaderFixtureRecorded",
            eventData: { index },
            schemaVersion: 1,
            occurredAt: `2026-07-22T00:00:0${index}.000Z`,
          },
        ],
        operations: [],
        response: { accepted: true },
      });
    });
    return { database, journal, reader: new EventLedgerReader(database) };
  }

  it("reads position > cursor in global order with Project scope filtered in SQL", () => {
    const { reader } = setup();
    expect(reader.readAfter({ position: 1, authorizedProjectIds: [projectA], limit: 10 })).toEqual({
      status: "ok",
      retentionFloor: 0,
      highWaterPosition: 4,
      events: [expect.objectContaining({ position: 3, projectId: projectA, eventData: { index: 2 } })],
    });
    expect(reader.readAfter({ position: 0, authorizedProjectIds: [projectB], limit: 1 })).toMatchObject({
      status: "ok",
      events: [expect.objectContaining({ position: 2, projectId: projectB })],
    });
  });

  it("reports the durable high-water position even when scope has no events", () => {
    const { reader } = setup();
    expect(reader.readAfter({ position: 4, authorizedProjectIds: [], limit: 10 })).toEqual({
      status: "ok",
      retentionFloor: 0,
      highWaterPosition: 4,
      events: [],
    });
  });

  it("returns resync_required instead of an empty page below the configured retention floor", () => {
    const { reader } = setup();
    reader.setRetentionFloor(2);
    expect(reader.readAfter({ position: 1, authorizedProjectIds: [projectA], limit: 10 })).toEqual({
      status: "resync_required",
      retentionFloor: 2,
      highWaterPosition: 4,
    });
    expect(new EventLedgerReader(database!).retentionFloor()).toBe(2);
  });

  it("tails by rereading newly committed Events from SQLite", async () => {
    const { journal, reader } = setup();
    const abort = new AbortController();
    const stream = reader.tail({
      position: 4,
      authorizedProjectIds: [projectA],
      pollIntervalMs: 1,
      signal: abort.signal,
    });
    const next = stream.next();
    journal.commitCommand({
      commandId: "cmd_reader_tail",
      requestFingerprint: "f".repeat(64),
      projectId: projectA,
      aggregateId: "reader:tail",
      expectedVersion: 0,
      actor: { actorId: "reader-test", correlationId: "reader-test" },
      events: [
        {
          eventId: "evt_reader_tail",
          eventType: "ReaderFixtureRecorded",
          eventData: { index: 4 },
          schemaVersion: 1,
          occurredAt: "2026-07-22T00:00:04.000Z",
        },
      ],
      operations: [],
      response: { accepted: true },
    });
    await expect(next).resolves.toMatchObject({ value: { position: 5, projectId: projectA }, done: false });
    abort.abort();
    await stream.return(undefined);
  });
});
