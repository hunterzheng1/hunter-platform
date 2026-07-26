import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { RuntimeProviderIdSchema } from "@hunter/domain";
import {
  HunterProjection,
  ProjectionRunner,
  SqliteOperationJournal,
} from "@hunter/storage";

import { PersistentFakeRuntime } from "./phase1-persistent-fake-runtime.js";
import { runPhase1RestartWorkload } from "./phase1-restart-workload.js";

export async function runPhase1RestartProbe(
  root: string,
  sequence: number,
  observedAt: string,
): Promise<void> {
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new Error("RESTART_PROBE_SEQUENCE_INVALID");
  }
  if (Number.isNaN(Date.parse(observedAt))) {
    throw new Error("RESTART_PROBE_TIME_INVALID");
  }
  const hunterPath = join(root, "hunter.sqlite");
  const providerPath = join(root, "provider.sqlite");
  if (!existsSync(hunterPath) || !existsSync(providerPath)) {
    throw new Error("RESTART_PROBE_STATE_MISSING");
  }
  const database = new DatabaseSync(hunterPath);
  const runtime = new PersistentFakeRuntime(providerPath, {
    providerId: RuntimeProviderIdSchema.parse("rtp_phase1soak001"),
    implementationVersion: "phase1-soak-contract-only",
    observedAt,
  });
  try {
    await runPhase1RestartWorkload({
      database,
      journal: new SqliteOperationJournal(database),
      projection: new ProjectionRunner(database, [new HunterProjection()]),
      runtime,
      sequence,
      observedAt,
    });
    const receiptIds = (
      database.prepare(
        "SELECT operation_id FROM side_effect_receipts ORDER BY operation_id",
      ).all() as unknown as readonly { readonly operation_id: string }[]
    ).map(({ operation_id }) => operation_id);
    const providerIds = runtime.operationIds();
    const completedOutbox = (
      database.prepare(
        "SELECT COUNT(*) AS count FROM outbox WHERE status = 'completed'",
      ).get() as { readonly count: number }
    ).count;
    if (
      JSON.stringify(receiptIds) !== JSON.stringify(providerIds)
      || completedOutbox !== receiptIds.length
    ) {
      throw new Error("RESTART_PROBE_RECONCILIATION_FAILED");
    }
  } finally {
    database.close();
    runtime.close();
  }
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined
  && pathToFileURL(resolve(entrypoint)).href === import.meta.url
) {
  const [root, rawSequence, observedAt] = process.argv.slice(2);
  if (root === undefined || rawSequence === undefined || observedAt === undefined) {
    throw new Error("RESTART_PROBE_ARGUMENTS_REQUIRED");
  }
  await runPhase1RestartProbe(root, Number(rawSequence), observedAt);
}
