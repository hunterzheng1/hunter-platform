import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createArchiveManifest,
  historicalKnowledgeEntryFor,
  VerifiedArchiveReceiptSchema,
} from "../packages/knowledge/src/index.js";
import {
  createConsistentBackup,
  loadStorageMigrations,
  restoreConsistentBackup,
  runStorageMigrations,
} from "../packages/storage/src/index.js";

const root = mkdtempSync(join(tmpdir(), "hunter-backup-restore-drill-"));
const sourceRoot = join(root, "source");
const backupRoot = join(root, "backups");
const restoreRoot = join(root, "restored");
const now = "2026-07-24T12:00:00.000Z";
const backupId = "bkp_20260724t120000000z_fedcba9876543210";
const content = "phase-1 verified artifact and evidence";
const contentHash = createHash("sha256").update(content).digest("hex");
const commonLease = {
  schemaVersion: 2,
  projectId: "prj_backup_drill",
  repositoryId: "rep_backup_drill",
  deviceBindingId: "dev_backup_drill",
  canonicalWorkspaceKey: "win32:c:\\hunter\\backup-drill",
  gitHead: "a".repeat(40),
  branch: "codex/backup-drill",
  ownerRunId: "run_backup_drill",
  ownerAttemptId: "att_backup_drill",
  ownerId: "own_backup_drill",
  generation: 1,
  acquiredAt: now,
  expiresAt: "2026-07-24T13:00:00.000Z",
  revokedAt: null,
  revocationReason: null,
};
const archiveManifest = createArchiveManifest({
  schemaVersion: 2,
  projectId: "prj_backup_drill",
  repositories: [{
    repositoryId: "rep_backup_drill",
    deviceBindingId: "dev_backup_drill",
    gitHead: "a".repeat(40),
  }],
  requirementRevisionIds: ["rrv_backup_drill"],
  change: {
    changeId: "chg_backup_drill",
    changeRevisionId: "crv_backup_drill",
  },
  executionPlanId: "epl_backup_drill",
  workflowId: "wfl_backup_drill",
  workflowRevisionId: "wfr_backup_drill",
  runGraph: {
    rootRunId: "run_backup_drill",
    runs: [{
      runId: "run_backup_drill",
      parentRunId: null,
      taskId: null,
      outcome: "succeeded",
      steps: [{
        stepRunId: "spr_backup_drill",
        stepId: "stp_backup_drill",
        attempts: [{
          attemptId: "att_backup_drill",
          agentProfileId: "apr_backup_drill",
          capabilityProbeDigest: "1".repeat(64),
          nativeSessionReferenceHash: "2".repeat(64),
          artifacts: [{
            artifactId: "art_backup_drill",
            contentRef: `cas:sha256:${contentHash}`,
            contentHash,
          }],
          evidence: [{
            evidenceId: "evd_backup_drill",
            contentRef: `cas:sha256:${contentHash}`,
            contentHash,
          }],
        }],
      }],
    }],
  },
  leases: {
    workspace: [{
      ...commonLease,
      kind: "workspace",
      leaseId: "wsl_backup_drill",
      mode: "read_only",
      scope: { workspaceId: "wsp_backup_drill" },
      receiptHash: "3".repeat(64),
    }],
    writer: [{
      ...commonLease,
      kind: "writer",
      leaseId: "wrl_backup_drill",
      mode: "write",
      scope: {
        workspaceId: "wsp_backup_drill",
        worktreeId: "wtr_backup_drill",
      },
      receiptHash: "4".repeat(64),
    }],
    controller: [{
      ...commonLease,
      kind: "controller",
      leaseId: "ctl_backup_drill",
      mode: "write",
      scope: {
        workspaceId: "wsp_backup_drill",
        worktreeId: "wtr_backup_drill",
        nativeSessionId: "ses_backup_drill",
      },
      receiptHash: "5".repeat(64),
    }],
  },
  ledger: { firstPosition: 1, lastPosition: 1 },
  actor: {
    actorId: "backup-restore-drill",
    correlationId: "backup-restore-drill",
  },
  timestamps: { occurredAt: now, archivedAt: now },
  outcome: "succeeded",
});
const archiveReceipt = VerifiedArchiveReceiptSchema.parse({
  receiptSchemaVersion: 1,
  projectId: archiveManifest.projectId,
  runId: archiveManifest.runGraph.rootRunId,
  outcome: archiveManifest.outcome,
  manifestSchemaVersion: archiveManifest.schemaVersion,
  manifestHash: archiveManifest.manifestHash,
  manifestRef: `cas:sha256:${archiveManifest.manifestHash}`,
  verifiedAt: now,
});
const knowledgeEntry = historicalKnowledgeEntryFor(archiveReceipt);

mkdirSync(join(sourceRoot, "content"), { recursive: true });
mkdirSync(join(sourceRoot, "archives"), { recursive: true });
mkdirSync(
  join(sourceRoot, "projects", "prj_backup_drill", "requirements"),
  { recursive: true },
);
writeFileSync(join(sourceRoot, "content", contentHash), content, "utf8");
writeFileSync(
  join(sourceRoot, "archives", `${archiveManifest.manifestHash}.json`),
  `${JSON.stringify(archiveManifest)}\n`,
  "utf8",
);
writeFileSync(
  join(
    sourceRoot,
    "projects",
    "prj_backup_drill",
    "requirements",
    "rrv_1.md",
  ),
  "# Approved recovery drill fixture\n",
  "utf8",
);

const database = new DatabaseSync(join(sourceRoot, "hunter.sqlite"));
try {
  runStorageMigrations(database, loadStorageMigrations(), {
    now: () => new Date(now),
  });
  database.prepare(
    `INSERT INTO events(
       event_id, project_id, aggregate_id, aggregate_version, event_type,
       event_data, actor_id, correlation_id, causation_id, schema_version,
       occurred_at, recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "evt_backup_drill",
    "prj_backup_drill",
    "project:prj_backup_drill",
    1,
    "ProjectCreated",
    JSON.stringify({
      projectId: "prj_backup_drill",
      name: "Backup drill",
    }),
    "backup-restore-drill",
    "backup-restore-drill",
    null,
    1,
    now,
    now,
  );
  database.prepare(
    `INSERT INTO archive_jobs(
       job_id, project_id, run_id, outcome, status, input_fingerprint,
       first_position, last_position, actor_id, correlation_id,
       occurred_at, manifest_hash, manifest_ref, archive_receipt_json,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "job_backup_drill",
    "prj_backup_drill",
    "run_backup_drill",
    "succeeded",
    "completed",
    "c".repeat(64),
    1,
    1,
    "backup-restore-drill",
    "backup-restore-drill",
    now,
    archiveManifest.manifestHash,
    `cas:sha256:${archiveManifest.manifestHash}`,
    JSON.stringify(archiveReceipt),
    now,
    now,
  );
  database.prepare(
    `INSERT INTO knowledge_entries(
       entry_id, project_id, level, status, source_identity,
       manifest_hash, rebuildable, entry_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    knowledgeEntry.entryId,
    "prj_backup_drill",
    "historical",
    "active",
    "archive\u0000run_backup_drill",
    archiveManifest.manifestHash,
    1,
    JSON.stringify(knowledgeEntry),
    now,
    now,
  );

  const created = await createConsistentBackup({
    sourceRoot,
    backupRoot,
    database,
    backupId,
    now: () => new Date(now),
  });
  const restored = await restoreConsistentBackup({
    backupDirectory: created.backupDirectory,
    restoreRoot,
  });
  const inspection = new DatabaseSync(join(restoreRoot, "hunter.sqlite"), {
    readOnly: true,
  });
  let rebuiltProject = false;
  try {
    rebuiltProject = inspection.prepare(
      `SELECT 1 FROM entity_views
        WHERE projector_name = 'hunter'
          AND entity_type = 'Project'
          AND entity_id = 'prj_backup_drill'`,
    ).get() !== undefined;
  } finally {
    inspection.close();
  }
  if (!rebuiltProject) throw new Error("BACKUP_RESTORE_PROJECTION_MISSING");
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    manifestSchemaVersion: created.manifest.schemaVersion,
    storageSchemaVersion: created.manifest.storage.schemaVersion,
    fileCount: created.manifest.files.length,
    manifestHash: created.manifest.manifestHash,
    isolatedRestore: true,
    projectionsRebuilt: true,
    reconciliation: restored.reconciliation,
  })}\n`);
} finally {
  database.close();
  rmSync(root, { recursive: true, force: true });
}
