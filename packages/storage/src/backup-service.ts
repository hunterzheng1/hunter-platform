import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import {
  KnowledgeEntrySchema,
  VerifiedArchiveReceiptSchema,
  verifyArchiveManifest,
} from "@hunter/knowledge";

import {
  BackupIdSchema,
  createBackupManifest,
  type BackupFileEntry,
  type BackupManifest,
  verifyBackupManifest,
} from "./backup-manifest.js";
import { HunterProjection } from "./hunter-projection.js";
import {
  loadStorageMigrations,
  runStorageMigrations,
  type StorageMigrationBackupReceipt,
  validateStorageBackupSource,
} from "./migration-runner.js";
import { ProjectionRunner } from "./projection-runner.js";

export type BackupFaultPoint =
  | "after_database_snapshot"
  | "after_files_copied"
  | "after_manifest_fsynced";

export interface CreateConsistentBackupInput {
  readonly sourceRoot: string;
  readonly backupRoot: string;
  readonly database: DatabaseSync;
  readonly backupId?: string | undefined;
  readonly now?: (() => Date) | undefined;
  readonly fault?: ((point: BackupFaultPoint) => void) | undefined;
}

export interface CreateConsistentBackupResult {
  readonly backupDirectory: string;
  readonly manifest: BackupManifest;
  readonly migrationReceipt: StorageMigrationBackupReceipt;
}

export interface RestoreConsistentBackupInput {
  readonly backupDirectory: string;
  readonly restoreRoot: string;
}

export interface BackupReconciliationReceipt {
  readonly eventCount: number;
  readonly archiveReferenceCount: number;
  readonly knowledgeReferenceCount: number;
  readonly artifactReferenceCount: number;
  readonly evidenceReferenceCount: number;
  readonly contentReferenceCount: number;
}

export interface RestoreConsistentBackupResult {
  readonly restoreRoot: string;
  readonly manifest: BackupManifest;
  readonly reconciliation: BackupReconciliationReceipt;
}

interface LedgerSummaryRow {
  readonly count: number;
  readonly first_position: number | null;
  readonly last_position: number | null;
}

interface ArchiveReferenceRow {
  readonly project_id: string;
  readonly run_id: string;
  readonly outcome: string;
  readonly first_position: number;
  readonly last_position: number;
  readonly manifest_hash: string;
  readonly manifest_ref: string;
  readonly archive_receipt_json: string;
}

interface KnowledgeReferenceRow {
  readonly project_id: string;
  readonly manifest_hash: string;
  readonly entry_json: string;
}

interface EvidenceReferenceRow {
  readonly evidence_hash: string;
}

interface SourceFile {
  readonly scope: typeof SCOPES[number];
  readonly sourcePath: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly size: number;
  readonly device: number;
  readonly inode: number;
}

const SCOPES = ["content", "projects", "archives"] as const;

function normalizedAbsolute(path: string): string {
  if (!isAbsolute(path)) throw new Error("BACKUP_ROOT_MUST_BE_ABSOLUTE");
  return resolve(path);
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".."
    && !isAbsolute(path));
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function portablePath(path: string): string {
  return path.split(sep).join("/");
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function syncFile(path: string): void {
  const descriptor = openSync(path, "r+");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform !== "win32"
      || !["EACCES", "EINVAL", "EPERM"].includes(code ?? "")
    ) {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function syncDirectoryTree(root: string): void {
  const directories = [root];
  for (let index = 0; index < directories.length; index += 1) {
    const directory = directories[index];
    if (directory === undefined) break;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) directories.push(join(directory, entry.name));
    }
  }
  for (const directory of directories.reverse()) syncDirectory(directory);
}

function generatedBackupId(now: Date): string {
  const timestamp = now.toISOString()
    .replace(/[-:.]/gu, "")
    .replace("T", "t")
    .replace("Z", "z");
  return `bkp_${timestamp}_${randomBytes(8).toString("hex")}`;
}

function sourceDatabasePath(
  sourceRoot: string,
  database: DatabaseSync,
): string {
  const location = database.location();
  if (location === null) throw new Error("BACKUP_DATABASE_MUST_BE_FILE_BACKED");
  const expected = resolve(sourceRoot, "hunter.sqlite");
  if (resolve(location) !== expected) {
    throw new Error("BACKUP_DATABASE_SOURCE_MISMATCH");
  }
  return expected;
}

function inventoryScopedFiles(
  sourceRoot: string,
  databasePath: string,
): readonly SourceFile[] {
  const databaseMetadata = statSync(databasePath);
  const files: SourceFile[] = [];
  for (const scope of SCOPES) {
    const scopeRoot = join(sourceRoot, scope);
    if (!existsSync(scopeRoot)) continue;
    if (lstatSync(scopeRoot).isSymbolicLink()) {
      throw new Error("BACKUP_SYMLINK_FORBIDDEN");
    }
    const canonicalScopeRoot = realpathSync(scopeRoot);
    const pending = [scopeRoot];
    while (pending.length > 0) {
      const directory = pending.pop();
      if (directory === undefined) break;
      const canonicalDirectory = realpathSync(directory);
      if (!isWithin(canonicalScopeRoot, canonicalDirectory)) {
        throw new Error("BACKUP_SYMLINK_ESCAPE");
      }
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const sourcePath = join(directory, entry.name);
        const metadata = lstatSync(sourcePath);
        if (entry.isSymbolicLink() || metadata.isSymbolicLink()) {
          throw new Error("BACKUP_SYMLINK_FORBIDDEN");
        }
        if (entry.isDirectory()) {
          pending.push(sourcePath);
          continue;
        }
        if (!entry.isFile()) throw new Error("BACKUP_FILE_TYPE_FORBIDDEN");
        const fileMetadata = statSync(sourcePath);
        if (
          fileMetadata.dev === databaseMetadata.dev
          && fileMetadata.ino === databaseMetadata.ino
        ) {
          throw new Error("BACKUP_ACTIVE_DATABASE_LINK_FORBIDDEN");
        }
        const canonicalSource = realpathSync(sourcePath);
        if (!isWithin(canonicalScopeRoot, canonicalSource)) {
          throw new Error("BACKUP_SYMLINK_ESCAPE");
        }
        const relativePath = portablePath(relative(sourceRoot, sourcePath));
        files.push({
          scope,
          sourcePath,
          relativePath,
          sha256: fileSha256(sourcePath),
          size: fileMetadata.size,
          device: fileMetadata.dev,
          inode: fileMetadata.ino,
        });
      }
    }
  }
  return files.sort((left, right) =>
    left.relativePath < right.relativePath
      ? -1
      : left.relativePath > right.relativePath
      ? 1
      : 0
  );
}

function copyScopedFiles(
  inventory: readonly SourceFile[],
  stagingData: string,
): BackupFileEntry[] {
  return inventory.map((file) => {
    const current = statSync(file.sourcePath);
    if (
      current.dev !== file.device
      || current.ino !== file.inode
      || current.size !== file.size
      || fileSha256(file.sourcePath) !== file.sha256
    ) {
      throw new Error("BACKUP_SOURCE_CHANGED_DURING_COPY");
    }
    const target = join(stagingData, ...file.relativePath.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file.sourcePath, target);
    syncFile(target);
    if (
      fileSha256(target) !== file.sha256
      || fileSha256(file.sourcePath) !== file.sha256
    ) {
      throw new Error("BACKUP_SOURCE_CHANGED_DURING_COPY");
    }
    return {
      scope: file.scope,
      relativePath: file.relativePath,
      sha256: file.sha256,
      size: file.size,
    };
  });
}

function ledgerSummary(database: DatabaseSync): LedgerSummaryRow {
  return database.prepare(
    `SELECT COUNT(*) AS count,
            MIN(position) AS first_position,
            MAX(position) AS last_position
       FROM events`,
  ).get() as unknown as LedgerSummaryRow;
}

function writeManifest(path: string, manifest: BackupManifest): void {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(manifest)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export async function createConsistentBackup(
  input: CreateConsistentBackupInput,
): Promise<CreateConsistentBackupResult> {
  const sourceRoot = normalizedAbsolute(input.sourceRoot);
  const backupRoot = normalizedAbsolute(input.backupRoot);
  if (!samePath(realpathSync(sourceRoot), sourceRoot)) {
    throw new Error("BACKUP_SOURCE_SYMLINK_FORBIDDEN");
  }
  const databasePath = sourceDatabasePath(sourceRoot, input.database);
  if (
    samePath(sourceRoot, backupRoot)
    ||
    SCOPES.some((scope) =>
      isWithin(join(sourceRoot, scope), backupRoot)
    )
  ) {
    throw new Error("BACKUP_DESTINATION_INSIDE_CAPTURE_SCOPE");
  }
  mkdirSync(backupRoot, { recursive: true });
  if (!samePath(realpathSync(backupRoot), backupRoot)) {
    throw new Error("BACKUP_DESTINATION_SYMLINK_FORBIDDEN");
  }
  const createdAt = (input.now ?? (() => new Date()))();
  const parsedBackupId = BackupIdSchema.safeParse(
    input.backupId ?? generatedBackupId(createdAt),
  );
  if (!parsedBackupId.success) throw new Error("BACKUP_ID_INVALID");
  const backupId = parsedBackupId.data;
  const staging = join(backupRoot, `.${backupId}.incomplete`);
  const published = join(backupRoot, backupId);
  if (existsSync(staging) || existsSync(published)) {
    throw new Error("BACKUP_DESTINATION_ALREADY_EXISTS");
  }
  mkdirSync(staging);
  const stagingData = join(staging, "data");
  mkdirSync(stagingData);

  const initialInventory = inventoryScopedFiles(sourceRoot, databasePath);
  const snapshotPath = join(stagingData, "hunter.sqlite");
  await backup(input.database, snapshotPath);
  syncFile(snapshotPath);
  input.fault?.("after_database_snapshot");

  const snapshot = new DatabaseSync(snapshotPath);
  let schemaVersion: number;
  let eventLedger: LedgerSummaryRow;
  try {
    const health = validateStorageBackupSource(
      snapshot,
      loadStorageMigrations(),
    );
    schemaVersion = health.schemaVersion;
    eventLedger = ledgerSummary(snapshot);
  } finally {
    snapshot.close();
  }
  const files: BackupFileEntry[] = [{
    scope: "database",
    relativePath: "hunter.sqlite",
    sha256: fileSha256(snapshotPath),
    size: statSync(snapshotPath).size,
  }, ...copyScopedFiles(initialInventory, stagingData)];
  const finalInventory = inventoryScopedFiles(sourceRoot, databasePath);
  if (JSON.stringify(finalInventory) !== JSON.stringify(initialInventory)) {
    throw new Error("BACKUP_SOURCE_CHANGED_DURING_COPY");
  }
  files.sort((left, right) =>
    left.relativePath < right.relativePath
      ? -1
      : left.relativePath > right.relativePath
      ? 1
      : 0
  );
  input.fault?.("after_files_copied");

  const manifest = createBackupManifest({
    schemaVersion: 1,
    backupId,
    createdAt: createdAt.toISOString(),
    storage: {
      schemaVersion,
      eventLedger: {
        count: eventLedger.count,
        firstPosition: eventLedger.first_position,
        lastPosition: eventLedger.last_position,
      },
    },
    files,
  });
  writeManifest(join(staging, "manifest.json"), manifest);
  syncDirectoryTree(stagingData);
  syncDirectory(staging);
  input.fault?.("after_manifest_fsynced");
  renameSync(staging, published);
  syncDirectory(backupRoot);
  return {
    backupDirectory: published,
    manifest,
    migrationReceipt: {
      status: "verified",
      sourceSchemaVersion: manifest.storage.schemaVersion,
      fingerprint: manifest.manifestHash,
    },
  };
}

function assertSafeBackupFile(
  dataRoot: string,
  relativePath: string,
): string {
  const target = resolve(dataRoot, ...relativePath.split("/"));
  if (!isWithin(dataRoot, target)) throw new Error("BACKUP_PATH_TRAVERSAL");
  let current = target;
  while (current !== dataRoot) {
    if (!existsSync(current)) throw new Error("BACKUP_FILE_MISSING");
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error("BACKUP_SYMLINK_FORBIDDEN");
    }
    current = dirname(current);
  }
  return target;
}

function validateBackupFiles(
  backupDirectory: string,
  manifest: BackupManifest,
): void {
  const dataRoot = join(backupDirectory, "data");
  if (
    !existsSync(dataRoot)
    || lstatSync(dataRoot).isSymbolicLink()
    || !statSync(dataRoot).isDirectory()
  ) {
    throw new Error("BACKUP_DATA_ROOT_INVALID");
  }
  for (const entry of manifest.files) {
    const path = assertSafeBackupFile(dataRoot, entry.relativePath);
    const metadata = statSync(path);
    if (!metadata.isFile()) throw new Error("BACKUP_FILE_TYPE_FORBIDDEN");
    if (metadata.size !== entry.size || fileSha256(path) !== entry.sha256) {
      throw new Error("BACKUP_FILE_HASH_MISMATCH");
    }
  }
}

function reconcileReferences(
  database: DatabaseSync,
  restoreRoot: string,
  manifest: BackupManifest,
): BackupReconciliationReceipt {
  const ledger = ledgerSummary(database);
  const expected = manifest.storage.eventLedger;
  if (
    ledger.count !== expected.count
    || ledger.first_position !== expected.firstPosition
    || ledger.last_position !== expected.lastPosition
  ) {
    throw new Error("BACKUP_EVENT_LEDGER_MISMATCH");
  }
  const eventRows = database.prepare(
    "SELECT event_data FROM events ORDER BY position",
  ).all() as unknown as readonly { readonly event_data: string }[];
  for (const row of eventRows) {
    try {
      JSON.parse(row.event_data);
    } catch {
      throw new Error("BACKUP_EVENT_PAYLOAD_INVALID");
    }
  }

  const contentHashes = new Set(
    manifest.files
      .filter(({ scope }) => scope === "content")
      .map(({ sha256 }) => sha256),
  );
  const archivesByHash = new Map<string, {
    readonly projectId: string;
    readonly runId: string;
    readonly outcome: "succeeded" | "failed" | "canceled";
    readonly schemaVersion: 2;
  }>();
  const contentReferences = new Set<string>();
  const artifactReferences = new Set<string>();
  const evidenceReferences = new Set<string>();

  const evidenceRows = database.prepare(
    "SELECT evidence_hash FROM evidence_records",
  ).all() as unknown as readonly EvidenceReferenceRow[];
  for (const row of evidenceRows) {
    contentReferences.add(row.evidence_hash);
    evidenceReferences.add(row.evidence_hash);
  }
  const archiveRows = database.prepare(
    `SELECT project_id, run_id, outcome, first_position, last_position,
            manifest_hash, manifest_ref, archive_receipt_json
       FROM archive_jobs
      WHERE status = 'completed'`,
  ).all() as unknown as readonly ArchiveReferenceRow[];
  for (const row of archiveRows) {
    const candidates = manifest.files.filter(
      ({ scope, relativePath }) =>
        scope === "archives"
        && relativePath === `archives/${row.manifest_hash}.json`,
    );
    if (
      row.manifest_ref !== `cas:sha256:${row.manifest_hash}`
      || candidates.length !== 1
    ) {
      throw new Error("BACKUP_ORPHAN_ARCHIVE_REFERENCE");
    }
    const archiveEntry = candidates[0];
    if (archiveEntry === undefined) {
      throw new Error("BACKUP_ORPHAN_ARCHIVE_REFERENCE");
    }
    let archive;
    let receipt;
    try {
      archive = verifyArchiveManifest(JSON.parse(readFileSync(
        join(restoreRoot, ...archiveEntry.relativePath.split("/")),
        "utf8",
      )) as unknown);
      receipt = VerifiedArchiveReceiptSchema.parse(
        JSON.parse(row.archive_receipt_json) as unknown,
      );
    } catch {
      throw new Error("BACKUP_ARCHIVE_MANIFEST_INVALID");
    }
    if (
      archive.manifestHash !== row.manifest_hash
      || archive.projectId !== row.project_id
      || archive.runGraph.rootRunId !== row.run_id
      || archive.outcome !== row.outcome
      || archive.ledger.firstPosition !== row.first_position
      || archive.ledger.lastPosition !== row.last_position
      || row.first_position < (ledger.first_position ?? Number.MAX_SAFE_INTEGER)
      || row.last_position > (ledger.last_position ?? 0)
      || receipt.projectId !== row.project_id
      || receipt.runId !== row.run_id
      || receipt.outcome !== row.outcome
      || receipt.manifestHash !== row.manifest_hash
      || receipt.manifestRef !== row.manifest_ref
      || receipt.manifestSchemaVersion !== archive.schemaVersion
    ) {
      throw new Error("BACKUP_ARCHIVE_RECEIPT_MISMATCH");
    }
    archivesByHash.set(archive.manifestHash, {
      projectId: archive.projectId,
      runId: archive.runGraph.rootRunId,
      outcome: archive.outcome,
      schemaVersion: archive.schemaVersion,
    });
    for (const run of archive.runGraph.runs) {
      for (const step of run.steps) {
        for (const attempt of step.attempts) {
          for (const artifact of attempt.artifacts) {
            artifactReferences.add(artifact.contentHash);
            contentReferences.add(artifact.contentHash);
          }
          for (const evidence of attempt.evidence) {
            evidenceReferences.add(evidence.contentHash);
            contentReferences.add(evidence.contentHash);
          }
        }
      }
    }
  }
  for (const hash of contentReferences) {
    if (!contentHashes.has(hash)) {
      throw new Error("BACKUP_ORPHAN_CONTENT_REFERENCE");
    }
  }

  const knowledgeRows = database.prepare(
    `SELECT project_id, manifest_hash, entry_json FROM knowledge_entries
      WHERE manifest_hash IS NOT NULL`,
  ).all() as unknown as readonly KnowledgeReferenceRow[];
  for (const row of knowledgeRows) {
    let entry;
    try {
      entry = KnowledgeEntrySchema.parse(
        JSON.parse(row.entry_json) as unknown,
      );
    } catch {
      throw new Error("BACKUP_KNOWLEDGE_REFERENCE_INVALID");
    }
    const archive = archivesByHash.get(row.manifest_hash);
    if (
      entry.level !== "historical"
      || entry.scope.projectId !== row.project_id
      || entry.source.manifestHash !== row.manifest_hash
      || entry.source.manifestRef !== `cas:sha256:${row.manifest_hash}`
      || archive === undefined
      || entry.source.projectId !== archive.projectId
      || entry.source.runId !== archive.runId
      || entry.source.outcome !== archive.outcome
      || entry.source.manifestSchemaVersion !== archive.schemaVersion
    ) {
      throw new Error("BACKUP_ORPHAN_KNOWLEDGE_REFERENCE");
    }
  }
  return {
    eventCount: ledger.count,
    archiveReferenceCount: archiveRows.length,
    knowledgeReferenceCount: knowledgeRows.length,
    artifactReferenceCount: artifactReferences.size,
    evidenceReferenceCount: evidenceReferences.size,
    contentReferenceCount: contentReferences.size,
  };
}

export async function restoreConsistentBackup(
  input: RestoreConsistentBackupInput,
): Promise<RestoreConsistentBackupResult> {
  const backupDirectory = normalizedAbsolute(input.backupDirectory);
  const restoreRoot = normalizedAbsolute(input.restoreRoot);
  if (!samePath(realpathSync(backupDirectory), backupDirectory)) {
    throw new Error("BACKUP_SYMLINK_FORBIDDEN");
  }
  if (basename(backupDirectory).endsWith(".incomplete")) {
    throw new Error("BACKUP_INCOMPLETE");
  }
  if (basename(backupDirectory) === "") throw new Error("BACKUP_PATH_INVALID");
  if (existsSync(restoreRoot)) throw new Error("RESTORE_ROOT_ALREADY_EXISTS");
  const manifestPath = join(backupDirectory, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error("BACKUP_MANIFEST_MISSING");
  if (lstatSync(manifestPath).isSymbolicLink()) {
    throw new Error("BACKUP_SYMLINK_FORBIDDEN");
  }
  const manifest = verifyBackupManifest(
    JSON.parse(readFileSync(manifestPath, "utf8")) as unknown,
  );
  if (basename(backupDirectory) !== manifest.backupId) {
    throw new Error("BACKUP_DIRECTORY_ID_MISMATCH");
  }
  const supportedSchemaVersion = loadStorageMigrations().length;
  if (manifest.storage.schemaVersion > supportedSchemaVersion) {
    throw new Error("BACKUP_STORAGE_VERSION_UNSUPPORTED");
  }
  if (manifest.storage.schemaVersion !== supportedSchemaVersion) {
    throw new Error("BACKUP_STORAGE_MIGRATION_REQUIRED");
  }
  validateBackupFiles(backupDirectory, manifest);

  const restoreParent = dirname(restoreRoot);
  if (
    !existsSync(restoreParent)
    || !samePath(realpathSync(restoreParent), restoreParent)
  ) {
    throw new Error("RESTORE_PARENT_INVALID");
  }
  if (isWithin(backupDirectory, restoreRoot)) {
    throw new Error("RESTORE_ROOT_INSIDE_BACKUP");
  }
  try {
    mkdirSync(restoreRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("RESTORE_ROOT_ALREADY_EXISTS");
    }
    throw error;
  }
  const staging = restoreRoot;
  const incompleteMarker = join(staging, ".restore.incomplete");
  try {
    const markerDescriptor = openSync(incompleteMarker, "wx", 0o600);
    try {
      writeFileSync(
        markerDescriptor,
        `${JSON.stringify({
          schemaVersion: 1,
          backupId: manifest.backupId,
          status: "incomplete",
        })}\n`,
        "utf8",
      );
      fsyncSync(markerDescriptor);
    } finally {
      closeSync(markerDescriptor);
    }
    syncDirectory(staging);
    const dataRoot = join(backupDirectory, "data");
    for (const entry of manifest.files) {
      const source = assertSafeBackupFile(dataRoot, entry.relativePath);
      const target = join(staging, ...entry.relativePath.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      syncFile(target);
      const copied = statSync(target);
      if (
        copied.size !== entry.size
        || fileSha256(target) !== entry.sha256
      ) {
        throw new Error("BACKUP_FILE_HASH_MISMATCH");
      }
    }

    const database = new DatabaseSync(join(staging, "hunter.sqlite"));
    let reconciliation: BackupReconciliationReceipt;
    try {
      const receipt = runStorageMigrations(
        database,
        loadStorageMigrations(),
      );
      if (receipt.schemaVersion !== manifest.storage.schemaVersion) {
        throw new Error("BACKUP_STORAGE_VERSION_MISMATCH");
      }
      new ProjectionRunner(database, [new HunterProjection()])
        .rebuild("hunter");
      reconciliation = reconcileReferences(database, staging, manifest);
    } finally {
      database.close();
    }
    syncDirectoryTree(staging);
    rmSync(incompleteMarker);
    syncDirectory(staging);
    syncDirectory(restoreParent);
    return { restoreRoot, manifest, reconciliation };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
