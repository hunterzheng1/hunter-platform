import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ProjectIdSchema } from "../packages/domain/src/index.js";
import {
  HunterProjection,
  ProjectionRunner,
  SqliteOperationJournal,
} from "../packages/storage/src/index.js";

const directory = mkdtempSync(join(tmpdir(), "hunter-rebuild-"));
const database = new DatabaseSync(join(directory, "hunter.sqlite"));

try {
  const projectId = ProjectIdSchema.parse("prj_rebuild001");
  const journal = new SqliteOperationJournal(database);
  const fixtures = [
    ["ProjectCreated", { projectId, name: "Rebuild fixture" }],
    ["RequirementRevisionApproved", { requirementRevisionId: "rrv_rebuild001", status: "approved" }],
    ["RunStarted", { runId: "run_rebuild001", status: "running" }],
  ] as const;
  fixtures.forEach(([eventType, eventData], index) => {
    journal.commitCommand({
      commandId: `cmd_rebuild_${index}`,
      requestFingerprint: (index + 1).toString(16).padStart(64, "0"),
      projectId,
      aggregateId: `rebuild:${index}`,
      expectedVersion: 0,
      actor: { actorId: "verify-rebuild", correlationId: "verify-rebuild" },
      events: [
        {
          eventId: `evt_rebuild_${index}`,
          eventType,
          eventData,
          schemaVersion: 1,
          occurredAt: `2026-07-22T00:00:0${index}.000Z`,
        },
      ],
      operations: [],
      response: { accepted: true },
    });
  });

  const runner = new ProjectionRunner(database, [new HunterProjection()]);
  runner.rebuild("hunter");
  const first = JSON.stringify(runner.snapshot("hunter"));
  runner.rebuild("hunter");
  const second = JSON.stringify(runner.snapshot("hunter"));
  if (first !== second) throw new Error("PROJECTION_REBUILD_NOT_DETERMINISTIC");
  process.stdout.write(
    `${JSON.stringify({ status: "PASS", projector: "hunter", eventCount: fixtures.length })}\n`,
  );
} finally {
  database.close();
  rmSync(directory, { recursive: true, force: true });
}
