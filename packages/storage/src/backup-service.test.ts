import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  createArchiveManifest,
  historicalKnowledgeEntryFor,
  VerifiedArchiveReceiptSchema,
} from "@hunter/knowledge";

import {
  BackupManifestSchema,
  createBackupManifest,
  verifyBackupManifest,
} from "./backup-manifest.js";
import {
  type BackupFaultPoint,
  createConsistentBackup,
  restoreConsistentBackup,
} from "./backup-service.js";
import {
  loadStorageMigrations,
  runStorageMigrations,
  validateStorageBackupSource,
} from "./migration-runner.js";

const roots = new Set<string>();
const NOW = "2026-07-24T12:00:00.000Z";
const BACKUP_ID = "bkp_20260724t120000000z_0123456789abcdef";

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `hunter-backup-${label}-`));
  roots.add(root);
  return root;
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function write(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function archiveFixture(contentHash: string) {
  const commonLease = {
    schemaVersion: 2,
    projectId: "prj_backup001",
    repositoryId: "rep_backup001",
    deviceBindingId: "dev_backup001",
    canonicalWorkspaceKey: "win32:c:\\hunter\\backup",
    gitHead: "a".repeat(40),
    branch: "codex/backup",
    ownerRunId: "run_backup001",
    ownerAttemptId: "att_backup001",
    ownerId: "own_backup001",
    generation: 1,
    acquiredAt: NOW,
    expiresAt: "2026-07-24T13:00:00.000Z",
    revokedAt: null,
    revocationReason: null,
  };
  const manifest = createArchiveManifest({
    schemaVersion: 2,
    projectId: "prj_backup001",
    repositories: [{
      repositoryId: "rep_backup001",
      deviceBindingId: "dev_backup001",
      gitHead: "a".repeat(40),
    }],
    requirementRevisionIds: ["rrv_backup001"],
    change: {
      changeId: "chg_backup001",
      changeRevisionId: "crv_backup001",
    },
    executionPlanId: "epl_backup001",
    workflowId: "wfl_backup001",
    workflowRevisionId: "wfr_backup001",
    runGraph: {
      rootRunId: "run_backup001",
      runs: [{
        runId: "run_backup001",
        parentRunId: null,
        taskId: null,
        outcome: "succeeded",
        steps: [{
          stepRunId: "spr_backup001",
          stepId: "stp_backup001",
          attempts: [{
            attemptId: "att_backup001",
            agentProfileId: "apr_backup001",
            capabilityProbeDigest: "1".repeat(64),
            nativeSessionReferenceHash: "2".repeat(64),
            artifacts: [{
              artifactId: "art_backup001",
              contentRef: `cas:sha256:${contentHash}`,
              contentHash,
            }],
            evidence: [{
              evidenceId: "evd_backup001",
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
        leaseId: "wsl_backup001",
        mode: "read_only",
        scope: { workspaceId: "wsp_backup001" },
        receiptHash: "3".repeat(64),
      }],
      writer: [{
        ...commonLease,
        kind: "writer",
        leaseId: "wrl_backup001",
        mode: "write",
        scope: {
          workspaceId: "wsp_backup001",
          worktreeId: "wtr_backup001",
        },
        receiptHash: "4".repeat(64),
      }],
      controller: [{
        ...commonLease,
        kind: "controller",
        leaseId: "ctl_backup001",
        mode: "write",
        scope: {
          workspaceId: "wsp_backup001",
          worktreeId: "wtr_backup001",
          nativeSessionId: "ses_backup001",
        },
        receiptHash: "5".repeat(64),
      }],
    },
    ledger: { firstPosition: 1, lastPosition: 1 },
    actor: {
      actorId: "backup-test",
      correlationId: "backup-test",
    },
    timestamps: { occurredAt: NOW, archivedAt: NOW },
    outcome: "succeeded",
  });
  const receipt = VerifiedArchiveReceiptSchema.parse({
    receiptSchemaVersion: 1,
    projectId: manifest.projectId,
    runId: manifest.runGraph.rootRunId,
    outcome: manifest.outcome,
    manifestSchemaVersion: manifest.schemaVersion,
    manifestHash: manifest.manifestHash,
    manifestRef: `cas:sha256:${manifest.manifestHash}`,
    verifiedAt: NOW,
  });
  return {
    manifest,
    receipt,
    knowledge: historicalKnowledgeEntryFor(receipt),
  };
}

function fixture(): {
  readonly root: string;
  readonly database: DatabaseSync;
  readonly databasePath: string;
} {
  const root = temporaryRoot("source");
  const databasePath = join(root, "hunter.sqlite");
  const database = new DatabaseSync(databasePath);
  runStorageMigrations(database, loadStorageMigrations(), {
    now: () => new Date(NOW),
  });
  write(root, "projects/prj_backup/requirements/rrv_1.md", "# Approved\n");
  return { root, database, databasePath };
}

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
  roots.clear();
});

describe("consistent Hunter backup and isolated restore", () => {
  it("publishes a versioned manifest over an online SQLite snapshot and scoped files", async () => {
    const source = fixture();
    const backupRoot = temporaryRoot("destination");
    try {
      source.database.prepare(
        `INSERT INTO events(
           event_id, project_id, aggregate_id, aggregate_version, event_type,
           event_data, actor_id, correlation_id, causation_id, schema_version,
           occurred_at, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "evt_backup_1",
        "prj_backup",
        "project:prj_backup",
        1,
        "ProjectCreated",
        JSON.stringify({ projectId: "prj_backup", name: "Backup" }),
        "backup-test",
        "backup-test",
        null,
        1,
        NOW,
        NOW,
      );

      const result = await createConsistentBackup({
        sourceRoot: source.root,
        backupRoot,
        database: source.database,
        backupId: BACKUP_ID,
        now: () => new Date(NOW),
      });

      expect(result.manifest).toMatchObject({
        schemaVersion: 1,
        backupId: BACKUP_ID,
        createdAt: NOW,
        storage: {
          schemaVersion: 2,
          eventLedger: { count: 1, firstPosition: 1, lastPosition: 1 },
        },
      });
      expect(result.manifest.files.map(({ scope, relativePath }) => [
        scope,
        relativePath,
      ])).toEqual([
        ["database", "hunter.sqlite"],
        ["projects", "projects/prj_backup/requirements/rrv_1.md"],
      ]);
      expect(result.manifest.manifestHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(result.migrationReceipt).toEqual({
        status: "verified",
        sourceSchemaVersion: 2,
        fingerprint: result.manifest.manifestHash,
      });
      expect(existsSync(join(result.backupDirectory, "manifest.json"))).toBe(true);
      expect(readdirSync(backupRoot)).toEqual([BACKUP_ID]);

      const snapshot = new DatabaseSync(
        join(result.backupDirectory, "data", "hunter.sqlite"),
        { readOnly: true },
      );
      try {
        expect(
          snapshot.prepare("SELECT COUNT(*) AS count FROM events").get(),
        ).toEqual({ count: 1 });
      } finally {
        snapshot.close();
      }
    } finally {
      source.database.close();
    }
  });

  it("rejects traversal and future manifest versions before restore", () => {
    expect(() =>
      createBackupManifest({
        schemaVersion: 1,
        backupId: BACKUP_ID,
        createdAt: NOW,
        storage: {
          schemaVersion: 2,
          eventLedger: { count: 0, firstPosition: null, lastPosition: null },
        },
        files: [{
          scope: "projects",
          relativePath: "../private.txt",
          sha256: "0".repeat(64),
          size: 1,
        }],
      })
    ).toThrow();
    expect(() =>
      BackupManifestSchema.parse({
        schemaVersion: 2,
        backupId: BACKUP_ID,
        createdAt: NOW,
        storage: {
          schemaVersion: 2,
          eventLedger: { count: 0, firstPosition: null, lastPosition: null },
        },
        files: [],
        manifestHash: "0".repeat(64),
      })
    ).toThrow();
  });

  it("validates backupId before using it as a filesystem path", async () => {
    const source = fixture();
    const parent = temporaryRoot("destination-parent");
    const backupRoot = join(parent, "backups");
    try {
      await expect(createConsistentBackup({
        sourceRoot: source.root,
        backupRoot,
        database: source.database,
        backupId: "../../../escaped",
        now: () => new Date(NOW),
      })).rejects.toThrow();
      expect(readdirSync(backupRoot)).toEqual([]);
      expect(existsSync(join(parent, "escaped"))).toBe(false);
    } finally {
      source.database.close();
    }
  });

  it("rejects a scoped hard link to the active SQLite database", async () => {
    const source = fixture();
    const backupRoot = temporaryRoot("destination");
    const rawCopy = join(source.root, "projects", "raw-active.sqlite");
    linkSync(source.databasePath, rawCopy);
    try {
      await expect(createConsistentBackup({
        sourceRoot: source.root,
        backupRoot,
        database: source.database,
        backupId: BACKUP_ID,
        now: () => new Date(NOW),
      })).rejects.toThrow("BACKUP_ACTIVE_DATABASE_LINK_FORBIDDEN");
      expect(readdirSync(backupRoot)).toEqual([`.${BACKUP_ID}.incomplete`]);
    } finally {
      source.database.close();
    }
  });

  it("rejects file-scope additions across the SQLite snapshot boundary", async () => {
    const source = fixture();
    const backupRoot = temporaryRoot("destination");
    try {
      await expect(createConsistentBackup({
        sourceRoot: source.root,
        backupRoot,
        database: source.database,
        backupId: BACKUP_ID,
        now: () => new Date(NOW),
        fault: (point) => {
          if (point === "after_database_snapshot") {
            write(
              source.root,
              "projects/prj_backup/requirements/rrv_2.md",
              "# Concurrent revision\n",
            );
          }
        },
      })).rejects.toThrow("BACKUP_SOURCE_CHANGED_DURING_COPY");
      expect(readdirSync(backupRoot)).toEqual([`.${BACKUP_ID}.incomplete`]);
    } finally {
      source.database.close();
    }
  });

  it("rejects a missing or hash-mismatched backup file without creating the restore root", async () => {
    const source = fixture();
    const backupRoot = temporaryRoot("destination");
    const restoreParent = temporaryRoot("restore");
    try {
      const result = await createConsistentBackup({
        sourceRoot: source.root,
        backupRoot,
        database: source.database,
        backupId: BACKUP_ID,
        now: () => new Date(NOW),
      });
      const projectFile = join(
        result.backupDirectory,
        "data",
        "projects",
        "prj_backup",
        "requirements",
        "rrv_1.md",
      );
      writeFileSync(projectFile, "tampered", "utf8");
      const restoreRoot = join(restoreParent, "restored");

      await expect(restoreConsistentBackup({
        backupDirectory: result.backupDirectory,
        restoreRoot,
      })).rejects.toThrow("BACKUP_FILE_HASH_MISMATCH");
      expect(existsSync(restoreRoot)).toBe(false);

      rmSync(projectFile);
      await expect(restoreConsistentBackup({
        backupDirectory: result.backupDirectory,
        restoreRoot,
      })).rejects.toThrow("BACKUP_FILE_MISSING");
      expect(existsSync(restoreRoot)).toBe(false);
    } finally {
      source.database.close();
    }
  });

  it("rejects future storage versions before creating restore staging", async () => {
    const source = fixture();
    const backupRoot = temporaryRoot("destination");
    const restoreParent = temporaryRoot("restore");
    try {
      const result = await createConsistentBackup({
        sourceRoot: source.root,
        backupRoot,
        database: source.database,
        backupId: BACKUP_ID,
        now: () => new Date(NOW),
      });
      const manifest = verifyBackupManifest(JSON.parse(
        readFileSync(join(result.backupDirectory, "manifest.json"), "utf8"),
      ) as unknown);
      const future = createBackupManifest({
        schemaVersion: manifest.schemaVersion,
        backupId: manifest.backupId,
        createdAt: manifest.createdAt,
        storage: { ...manifest.storage, schemaVersion: 999 },
        files: manifest.files,
      });
      writeFileSync(
        join(result.backupDirectory, "manifest.json"),
        `${JSON.stringify(future)}\n`,
        "utf8",
      );
      const restoreRoot = join(restoreParent, "restored");
      await expect(restoreConsistentBackup({
        backupDirectory: result.backupDirectory,
        restoreRoot,
      })).rejects.toThrow("BACKUP_STORAGE_VERSION_UNSUPPORTED");
      expect(existsSync(restoreRoot)).toBe(false);
    } finally {
      source.database.close();
    }
  });

  it("rejects source symlink escape instead of following it", async () => {
    const source = fixture();
    const backupRoot = temporaryRoot("destination");
    const outside = temporaryRoot("outside");
    write(outside, "private.txt", "do not copy");
    const link = join(source.root, "projects", "linked");
    symlinkSync(
      outside,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    try {
      await expect(createConsistentBackup({
        sourceRoot: source.root,
        backupRoot,
        database: source.database,
        backupId: BACKUP_ID,
        now: () => new Date(NOW),
      })).rejects.toThrow("BACKUP_SYMLINK_FORBIDDEN");
      expect(readdirSync(backupRoot)).toEqual([`.${BACKUP_ID}.incomplete`]);
    } finally {
      source.database.close();
    }
  });

  it("rejects a restore-side directory link even when linked bytes match", async () => {
    const source = fixture();
    const backupRoot = temporaryRoot("destination");
    const restoreParent = temporaryRoot("restore");
    const outside = temporaryRoot("outside");
    try {
      const result = await createConsistentBackup({
        sourceRoot: source.root,
        backupRoot,
        database: source.database,
        backupId: BACKUP_ID,
        now: () => new Date(NOW),
      });
      const projects = join(result.backupDirectory, "data", "projects");
      rmSync(projects, { recursive: true });
      write(
        outside,
        "prj_backup/requirements/rrv_1.md",
        "# Approved\n",
      );
      symlinkSync(
        outside,
        projects,
        process.platform === "win32" ? "junction" : "dir",
      );
      await expect(restoreConsistentBackup({
        backupDirectory: result.backupDirectory,
        restoreRoot: join(restoreParent, "restored"),
      })).rejects.toThrow("BACKUP_SYMLINK_FORBIDDEN");
    } finally {
      source.database.close();
    }
  });

  it("rejects orphan Archive/Artifact/Evidence content references", async () => {
    const source = fixture();
    const backupRoot = temporaryRoot("destination");
    const restoreParent = temporaryRoot("restore");
    const missingHash = "a".repeat(64);
    const archive = archiveFixture(missingHash);
    write(
      source.root,
      `archives/${archive.manifest.manifestHash}.json`,
      `${JSON.stringify(archive.manifest)}\n`,
    );
    try {
      source.database.prepare(
        `INSERT INTO events(
           event_id, project_id, aggregate_id, aggregate_version, event_type,
           event_data, actor_id, correlation_id, causation_id, schema_version,
           occurred_at, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "evt_backup_orphan",
        "prj_backup001",
        "run:run_backup001",
        1,
        "RunStarted",
        JSON.stringify({ runId: "run_backup001" }),
        "backup-test",
        "backup-test",
        null,
        1,
        NOW,
        NOW,
      );
      source.database.prepare(
        `INSERT INTO archive_jobs(
           job_id, project_id, run_id, outcome, status, input_fingerprint,
           first_position, last_position, actor_id, correlation_id,
           occurred_at, manifest_hash, manifest_ref, archive_receipt_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "job_backup_orphan",
        "prj_backup001",
        "run_backup001",
        "succeeded",
        "completed",
        "c".repeat(64),
        1,
        1,
        "backup-test",
        "backup-test",
        NOW,
        archive.manifest.manifestHash,
        `cas:sha256:${archive.manifest.manifestHash}`,
        JSON.stringify(archive.receipt),
        NOW,
        NOW,
      );
      const result = await createConsistentBackup({
        sourceRoot: source.root,
        backupRoot,
        database: source.database,
        backupId: BACKUP_ID,
        now: () => new Date(NOW),
      });
      await expect(restoreConsistentBackup({
        backupDirectory: result.backupDirectory,
        restoreRoot: join(restoreParent, "restored"),
      })).rejects.toThrow("BACKUP_ORPHAN_CONTENT_REFERENCE");
    } finally {
      source.database.close();
    }
  });

  it("rejects a canonical Archive manifest renamed away from its hash path", async () => {
    const source = fixture();
    const backupRoot = temporaryRoot("destination");
    const restoreParent = temporaryRoot("restore");
    const content = "renamed archive evidence";
    const contentHash = sha256(content);
    const archive = archiveFixture(contentHash);
    write(source.root, `content/${contentHash}`, content);
    write(
      source.root,
      `archives/${archive.manifest.manifestHash}.json`,
      `${JSON.stringify(archive.manifest)}\n`,
    );
    try {
      source.database.prepare(
        `INSERT INTO events(
           event_id, project_id, aggregate_id, aggregate_version, event_type,
           event_data, actor_id, correlation_id, causation_id, schema_version,
           occurred_at, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "evt_backup_renamed",
        "prj_backup001",
        "run:run_backup001",
        1,
        "RunStarted",
        JSON.stringify({ runId: "run_backup001" }),
        "backup-test",
        "backup-test",
        null,
        1,
        NOW,
        NOW,
      );
      source.database.prepare(
        `INSERT INTO archive_jobs(
           job_id, project_id, run_id, outcome, status, input_fingerprint,
           first_position, last_position, actor_id, correlation_id,
           occurred_at, manifest_hash, manifest_ref, archive_receipt_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "job_backup_renamed",
        "prj_backup001",
        "run_backup001",
        "succeeded",
        "completed",
        "c".repeat(64),
        1,
        1,
        "backup-test",
        "backup-test",
        NOW,
        archive.manifest.manifestHash,
        `cas:sha256:${archive.manifest.manifestHash}`,
        JSON.stringify(archive.receipt),
        NOW,
        NOW,
      );
      const result = await createConsistentBackup({
        sourceRoot: source.root,
        backupRoot,
        database: source.database,
        backupId: BACKUP_ID,
        now: () => new Date(NOW),
      });
      const originalPath =
        `archives/${archive.manifest.manifestHash}.json`;
      const renamedPath =
        `archives/nested/${archive.manifest.manifestHash}.json`;
      mkdirSync(
        join(result.backupDirectory, "data", "archives", "nested"),
        { recursive: true },
      );
      renameSync(
        join(result.backupDirectory, "data", ...originalPath.split("/")),
        join(result.backupDirectory, "data", ...renamedPath.split("/")),
      );
      const files = result.manifest.files.map((entry) =>
        entry.relativePath === originalPath
          ? { ...entry, relativePath: renamedPath }
          : entry
      ).sort((left, right) =>
        left.relativePath < right.relativePath
          ? -1
          : left.relativePath > right.relativePath
          ? 1
          : 0
      );
      const rewritten = createBackupManifest({
        schemaVersion: result.manifest.schemaVersion,
        backupId: result.manifest.backupId,
        createdAt: result.manifest.createdAt,
        storage: result.manifest.storage,
        files,
      });
      writeFileSync(
        join(result.backupDirectory, "manifest.json"),
        `${JSON.stringify(rewritten)}\n`,
        "utf8",
      );
      await expect(restoreConsistentBackup({
        backupDirectory: result.backupDirectory,
        restoreRoot: join(restoreParent, "restored"),
      })).rejects.toThrow("BACKUP_ORPHAN_ARCHIVE_REFERENCE");
    } finally {
      source.database.close();
    }
  });

  it("restores to a new root, rebuilds projections, and never overwrites user data", async () => {
    const source = fixture();
    const backupRoot = temporaryRoot("destination");
    const restoreParent = temporaryRoot("restore");
    try {
      source.database.prepare(
        `INSERT INTO events(
           event_id, project_id, aggregate_id, aggregate_version, event_type,
           event_data, actor_id, correlation_id, causation_id, schema_version,
           occurred_at, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "evt_backup_1",
        "prj_backup",
        "project:prj_backup",
        1,
        "ProjectCreated",
        JSON.stringify({ projectId: "prj_backup", name: "Backup" }),
        "backup-test",
        "backup-test",
        null,
        1,
        NOW,
        NOW,
      );
      const backup = await createConsistentBackup({
        sourceRoot: source.root,
        backupRoot,
        database: source.database,
        backupId: BACKUP_ID,
        now: () => new Date(NOW),
      });
      const restoreRoot = join(restoreParent, "restored");
      const restored = await restoreConsistentBackup({
        backupDirectory: backup.backupDirectory,
        restoreRoot,
      });
      expect(restored.reconciliation).toEqual({
        eventCount: 1,
        archiveReferenceCount: 0,
        knowledgeReferenceCount: 0,
        artifactReferenceCount: 0,
        evidenceReferenceCount: 0,
        contentReferenceCount: 0,
      });
      const restoredDatabase = new DatabaseSync(
        join(restoreRoot, "hunter.sqlite"),
        { readOnly: true },
      );
      try {
        expect(restoredDatabase.prepare(
          `SELECT view_json FROM entity_views
            WHERE projector_name = 'hunter'
              AND entity_type = 'Project'
              AND entity_id = 'prj_backup'`,
        ).get()).toBeDefined();
      } finally {
        restoredDatabase.close();
      }

      write(restoreRoot, "user-owned.txt", "preserve");
      await expect(restoreConsistentBackup({
        backupDirectory: backup.backupDirectory,
        restoreRoot,
      })).rejects.toThrow("RESTORE_ROOT_ALREADY_EXISTS");
      expect(readFileSync(join(restoreRoot, "user-owned.txt"), "utf8"))
        .toBe("preserve");
    } finally {
      source.database.close();
    }
  });

  it("reconciles valid Archive, Knowledge, Artifact, and Evidence references", async () => {
    const source = fixture();
    const backupRoot = temporaryRoot("destination");
    const restoreParent = temporaryRoot("restore");
    const content = "verified evidence";
    const contentHash = sha256(content);
    const archive = archiveFixture(contentHash);
    write(source.root, `content/${contentHash}`, content);
    write(
      source.root,
      `archives/${archive.manifest.manifestHash}.json`,
      `${JSON.stringify(archive.manifest)}\n`,
    );
    try {
      source.database.prepare(
        `INSERT INTO events(
           event_id, project_id, aggregate_id, aggregate_version, event_type,
           event_data, actor_id, correlation_id, causation_id, schema_version,
           occurred_at, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "evt_backup_archive",
        "prj_backup001",
        "run:run_backup001",
        1,
        "RunStarted",
        JSON.stringify({ runId: "run_backup001" }),
        "backup-test",
        "backup-test",
        null,
        1,
        NOW,
        NOW,
      );
      source.database.prepare(
        `INSERT INTO archive_jobs(
           job_id, project_id, run_id, outcome, status, input_fingerprint,
           first_position, last_position, actor_id, correlation_id,
           occurred_at, manifest_hash, manifest_ref, archive_receipt_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "job_backup",
        "prj_backup001",
        "run_backup001",
        "succeeded",
        "completed",
        "c".repeat(64),
        1,
        1,
        "backup-test",
        "backup-test",
        NOW,
        archive.manifest.manifestHash,
        `cas:sha256:${archive.manifest.manifestHash}`,
        JSON.stringify(archive.receipt),
        NOW,
        NOW,
      );
      source.database.prepare(
        `INSERT INTO knowledge_entries(
           entry_id, project_id, level, status, source_identity,
           manifest_hash, rebuildable, entry_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        archive.knowledge.entryId,
        "prj_backup001",
        "historical",
        "active",
        "archive\u0000run_backup001",
        archive.manifest.manifestHash,
        1,
        JSON.stringify(archive.knowledge),
        NOW,
        NOW,
      );
      const backupResult = await createConsistentBackup({
        sourceRoot: source.root,
        backupRoot,
        database: source.database,
        backupId: BACKUP_ID,
        now: () => new Date(NOW),
      });
      const restored = await restoreConsistentBackup({
        backupDirectory: backupResult.backupDirectory,
        restoreRoot: join(restoreParent, "restored"),
      });
      expect(restored.reconciliation).toEqual({
        eventCount: 1,
        archiveReferenceCount: 1,
        knowledgeReferenceCount: 1,
        artifactReferenceCount: 1,
        evidenceReferenceCount: 1,
        contentReferenceCount: 1,
      });
      source.database.prepare(
        "UPDATE knowledge_entries SET entry_json = ? WHERE entry_id = ?",
      ).run(
        JSON.stringify({
          ...archive.knowledge,
          source: {
            ...archive.knowledge.source,
            runId: "run_conflict001",
          },
        }),
        archive.knowledge.entryId,
      );
      const conflictingBackupRoot = temporaryRoot("conflicting-destination");
      const conflictingBackup = await createConsistentBackup({
        sourceRoot: source.root,
        backupRoot: conflictingBackupRoot,
        database: source.database,
        backupId: "bkp_20260724t120000000z_1111111111111111",
        now: () => new Date(NOW),
      });
      await expect(restoreConsistentBackup({
        backupDirectory: conflictingBackup.backupDirectory,
        restoreRoot: join(restoreParent, "conflicting-restored"),
      })).rejects.toThrow("BACKUP_ORPHAN_KNOWLEDGE_REFERENCE");
    } finally {
      source.database.close();
    }
  });

  it.each<BackupFaultPoint>([
    "after_database_snapshot",
    "after_files_copied",
    "after_manifest_fsynced",
  ])("preserves identifiable incomplete staging on crash at %s", async (faultPoint) => {
    const source = fixture();
    const backupRoot = temporaryRoot("destination");
    try {
      await expect(createConsistentBackup({
        sourceRoot: source.root,
        backupRoot,
        database: source.database,
        backupId: BACKUP_ID,
        now: () => new Date(NOW),
        fault: (point) => {
          if (point === faultPoint) {
            throw new Error("SIMULATED_CRASH");
          }
        },
      })).rejects.toThrow("SIMULATED_CRASH");
      const entries = readdirSync(backupRoot);
      expect(entries).toEqual([`.${BACKUP_ID}.incomplete`]);
      expect(entries.some((name) => name === BACKUP_ID)).toBe(false);
    } finally {
      source.database.close();
    }
  });

  it("records content hashes from copied bytes", async () => {
    const source = fixture();
    const backupRoot = temporaryRoot("destination");
    const content = "immutable artifact";
    const digest = sha256(content);
    write(source.root, `content/${digest}`, content);
    try {
      const result = await createConsistentBackup({
        sourceRoot: source.root,
        backupRoot,
        database: source.database,
        backupId: BACKUP_ID,
        now: () => new Date(NOW),
      });
      expect(result.manifest.files).toContainEqual({
        scope: "content",
        relativePath: `content/${digest}`,
        sha256: digest,
        size: Buffer.byteLength(content),
      });
    } finally {
      source.database.close();
    }
  });

  it("issues a pre-migration receipt that authorizes the next destructive migration", async () => {
    const source = fixture();
    const backupRoot = temporaryRoot("destination");
    try {
      source.database.prepare(
        `INSERT INTO events(
           event_id, project_id, aggregate_id, aggregate_version, event_type,
           event_data, actor_id, correlation_id, causation_id, schema_version,
           occurred_at, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "evt_backup_migration",
        "prj_backup",
        "project:prj_backup",
        1,
        "ProjectCreated",
        JSON.stringify({ projectId: "prj_backup" }),
        "before",
        "backup-test",
        null,
        1,
        NOW,
        NOW,
      );
      const migrations = [
        ...loadStorageMigrations(),
        {
          version: 3,
          name: "rewrite-event-actor",
          sql: "UPDATE events SET actor_id = 'after';",
        },
      ];
      expect(
        validateStorageBackupSource(source.database, migrations).schemaVersion,
      ).toBe(2);
      expect(source.database.prepare(
        "SELECT actor_id FROM events WHERE event_id = ?",
      ).get("evt_backup_migration")).toEqual({ actor_id: "before" });
      const result = await createConsistentBackup({
        sourceRoot: source.root,
        backupRoot,
        database: source.database,
        backupId: BACKUP_ID,
        now: () => new Date(NOW),
      });
      const receipt = runStorageMigrations(source.database, migrations, {
        now: () => new Date(NOW),
        backupReceiptFor: () => result.migrationReceipt,
      });
      expect(receipt.schemaVersion).toBe(3);
      expect(source.database.prepare(
        "SELECT actor_id FROM events WHERE event_id = ?",
      ).get("evt_backup_migration")).toEqual({ actor_id: "after" });
    } finally {
      source.database.close();
    }
  });

  it("rejects content whose CAS path does not equal its byte hash", async () => {
    const source = fixture();
    const backupRoot = temporaryRoot("destination");
    write(source.root, `content/${"f".repeat(64)}`, "different bytes");
    try {
      await expect(createConsistentBackup({
        sourceRoot: source.root,
        backupRoot,
        database: source.database,
        backupId: BACKUP_ID,
        now: () => new Date(NOW),
      })).rejects.toThrow();
      expect(readdirSync(backupRoot)).toEqual([`.${BACKUP_ID}.incomplete`]);
    } finally {
      source.database.close();
    }
  });
});
