import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import {
  constants as sqliteConstants,
  DatabaseSync,
} from "node:sqlite";

import { parseStorageMigrationManifest } from "./migration-manifest.js";

export interface StorageMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export interface StorageMigrationBackupReceipt {
  readonly status: "verified";
  readonly sourceSchemaVersion: number;
  readonly fingerprint: string;
}

export interface StorageHealthReceipt {
  readonly schemaVersion: number;
  readonly foreignKeys: true;
  readonly integrity: "ok";
  readonly journalMode: "memory" | "wal";
}

export interface RecoveredMigration {
  readonly targetVersion: number;
  readonly status: "completed" | "rolled_back";
}

export interface StorageMigrationReceipt {
  readonly schemaVersion: number;
  readonly appliedVersions: readonly number[];
  readonly recoveredMigration: RecoveredMigration | null;
  readonly health: StorageHealthReceipt;
}

interface AppliedMigrationRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

interface MigrationStateRow {
  readonly target_version: number;
  readonly target_name: string;
  readonly target_checksum: string;
}

interface MetadataRow {
  readonly metadata_value: string;
}

interface SchemaObjectRow {
  readonly type: string;
  readonly name: string;
  readonly sql: string;
}

const MIGRATION_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const KNOWN_LEGACY_MIGRATION_MARKER = "target_schema_version:1";
const RUNNER_OWNED_TABLES = new Set([
  "storage_metadata",
  "storage_migrations",
  "storage_migration_state",
]);
const LEGACY_V1_OPTIONAL_SCHEMA = new Map([
  [
    "table\0principal_project_authorizations",
    normalizedSchemaSql(`CREATE TABLE principal_project_authorizations (
      principal_id TEXT PRIMARY KEY,
      project_ids_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT`),
  ],
]);

function validateDefinitions(
  migrations: readonly StorageMigration[],
): void {
  if (migrations.length === 0) throw new Error("MIGRATION_SEQUENCE_INVALID");
  for (const [index, migration] of migrations.entries()) {
    if (
      migration.version !== index + 1
      || !MIGRATION_NAME.test(migration.name)
      || migration.sql.trim().length === 0
    ) {
      throw new Error("MIGRATION_SEQUENCE_INVALID");
    }
  }
}

function bootstrapMigrationLedger(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS storage_metadata (
      metadata_key TEXT PRIMARY KEY,
      metadata_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS storage_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL CHECK (length(checksum) = 64),
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS storage_migration_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      target_version INTEGER NOT NULL CHECK (target_version > 0),
      target_name TEXT NOT NULL,
      target_checksum TEXT NOT NULL CHECK (length(target_checksum) = 64),
      started_at TEXT NOT NULL
    );
  `);
}

function executeAuthorizedMigrationSql(
  database: DatabaseSync,
  sql: string,
  options: {
    readonly destructiveAuthorized?: boolean | undefined;
    readonly protectRunnerTables?: boolean | undefined;
  } = {},
): void {
  const destructiveAuthorized = options.destructiveAuthorized ?? false;
  const protectRunnerTables = options.protectRunnerTables ?? true;
  const existingTables = new Set(
    (database.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table'",
    ).all() as unknown as readonly { readonly name: string }[])
      .map(({ name }) => name),
  );
  const createdTables = new Set<string>();
  let deniedReason:
    | "MIGRATION_SQL_OPERATION_FORBIDDEN"
    | "DESTRUCTIVE_MIGRATION_BACKUP_REQUIRED"
    | null = null;
  database.setAuthorizer((actionCode, arg1, arg2) => {
    if (
      protectRunnerTables
      && (
        (arg1 !== null && RUNNER_OWNED_TABLES.has(arg1))
        || (arg2 !== null && RUNNER_OWNED_TABLES.has(arg2))
      )
    ) {
      deniedReason = "MIGRATION_SQL_OPERATION_FORBIDDEN";
      return sqliteConstants.SQLITE_DENY;
    }
    if (
      actionCode === sqliteConstants.SQLITE_CREATE_TABLE
      && arg1 !== null
      && !existingTables.has(arg1)
    ) {
      createdTables.add(arg1);
    }
    if (
      actionCode === sqliteConstants.SQLITE_TRANSACTION
      || actionCode === sqliteConstants.SQLITE_SAVEPOINT
      || actionCode === sqliteConstants.SQLITE_PRAGMA
      || actionCode === sqliteConstants.SQLITE_ATTACH
      || actionCode === sqliteConstants.SQLITE_DETACH
    ) {
      deniedReason = "MIGRATION_SQL_OPERATION_FORBIDDEN";
      return sqliteConstants.SQLITE_DENY;
    }
    if (
      !destructiveAuthorized
      && (
        (
          (
            actionCode === sqliteConstants.SQLITE_UPDATE
            || actionCode === sqliteConstants.SQLITE_DELETE
            || actionCode === sqliteConstants.SQLITE_INSERT
          )
          && !arg1?.startsWith("sqlite_")
          && (arg1 === null || !createdTables.has(arg1))
        )
        || actionCode === sqliteConstants.SQLITE_ALTER_TABLE
        || actionCode === sqliteConstants.SQLITE_DROP_INDEX
        || actionCode === sqliteConstants.SQLITE_DROP_TABLE
        || actionCode === sqliteConstants.SQLITE_DROP_TRIGGER
        || actionCode === sqliteConstants.SQLITE_DROP_VIEW
        || actionCode === sqliteConstants.SQLITE_DROP_VTABLE
      )
    ) {
      deniedReason = "DESTRUCTIVE_MIGRATION_BACKUP_REQUIRED";
      return sqliteConstants.SQLITE_DENY;
    }
    return sqliteConstants.SQLITE_OK;
  });
  try {
    database.exec(sql);
  } catch (error) {
    if (deniedReason !== null) throw new Error(deniedReason);
    throw error;
  } finally {
    database.setAuthorizer(null);
  }
}

function normalizedSchemaSql(sql: string): string {
  let normalized = "";
  let pendingSpace = false;
  let quote: "'" | "\"" | "`" | "]" | null = null;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index] ?? "";
    const next = sql[index + 1] ?? "";
    if (quote !== null) {
      normalized += character;
      if (character === quote) {
        if (next === quote) {
          normalized += next;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === "-" && next === "-") {
      index += 2;
      while (index < sql.length && !/[\r\n]/u.test(sql[index] ?? "")) {
        index += 1;
      }
      pendingSpace = true;
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (
        index < sql.length - 1
        && !((sql[index] ?? "") === "*" && (sql[index + 1] ?? "") === "/")
      ) {
        index += 1;
      }
      index += 1;
      pendingSpace = true;
      continue;
    }
    if (/\s/u.test(character)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && normalized.length > 0) normalized += " ";
    pendingSpace = false;
    if (
      character === "'"
      || character === "\""
      || character === "`"
      || character === "["
    ) {
      quote = character === "[" ? "]" : character;
    }
    normalized += character;
  }
  return normalized.trim();
}

function schemaObjects(database: DatabaseSync): readonly SchemaObjectRow[] {
  return database.prepare(
    `SELECT type, name, sql
       FROM sqlite_schema
      WHERE sql IS NOT NULL
        AND name NOT LIKE 'sqlite_%'
      ORDER BY type, name`,
  ).all() as unknown as readonly SchemaObjectRow[];
}

function nonRunnerSchemaObjects(
  database: DatabaseSync,
): readonly SchemaObjectRow[] {
  return schemaObjects(database).filter(
    ({ name }) => !RUNNER_OWNED_TABLES.has(name),
  );
}

function validateNoRunnerOwnedSchemaReferences(
  database: DatabaseSync,
): void {
  const programmableObjects = database.prepare(
    `SELECT sql
       FROM sqlite_schema
      WHERE type IN ('trigger', 'view')
        AND sql IS NOT NULL`,
  ).all() as unknown as readonly { readonly sql: string }[];
  const runnerOwnedReference =
    /\b(?:storage_metadata|storage_migrations|storage_migration_state)\b/iu;
  if (programmableObjects.some(({ sql }) => runnerOwnedReference.test(sql))) {
    throw new Error("MIGRATION_SQL_OPERATION_FORBIDDEN");
  }
}

function validateSchemaFingerprint(
  database: DatabaseSync,
  migrations: readonly StorageMigration[],
  errorCode:
    | "LEGACY_SCHEMA_FINGERPRINT_MISMATCH"
    | "STORAGE_SCHEMA_FINGERPRINT_MISMATCH",
  allowedAdditionalObjects: ReadonlyMap<string, string> = new Map(),
): void {
  const reference = new DatabaseSync(":memory:");
  let expected: readonly SchemaObjectRow[];
  try {
    bootstrapMigrationLedger(reference);
    for (const migration of migrations) {
      executeAuthorizedMigrationSql(reference, migration.sql, {
        destructiveAuthorized: true,
        protectRunnerTables: false,
      });
    }
    expected = schemaObjects(reference);
  } catch {
    throw new Error(errorCode);
  } finally {
    reference.close();
  }
  const actual = new Map(
    schemaObjects(database).map((row) => [
      `${row.type}\0${row.name}`,
      normalizedSchemaSql(row.sql),
    ]),
  );
  const expectedKeys = new Set(
    expected.map(({ type, name }) => `${type}\0${name}`),
  );
  if (
    expected.length === 0
    || expected.some((row) =>
      actual.get(`${row.type}\0${row.name}`)
      !== normalizedSchemaSql(row.sql)
    )
    || [...actual].some(([key, sql]) =>
      !expectedKeys.has(key)
      && allowedAdditionalObjects.get(key) !== sql
    )
  ) {
    throw new Error(errorCode);
  }
}

function validateLegacySchemaV1(
  database: DatabaseSync,
  migration: StorageMigration,
): void {
  validateSchemaFingerprint(
    database,
    [migration],
    "LEGACY_SCHEMA_FINGERPRINT_MISMATCH",
    LEGACY_V1_OPTIONAL_SCHEMA,
  );
}

function appliedMigrations(
  database: DatabaseSync,
): readonly AppliedMigrationRow[] {
  return database
    .prepare(
      "SELECT version, name, checksum FROM storage_migrations ORDER BY version",
    )
    .all() as unknown as readonly AppliedMigrationRow[];
}

function adoptLegacyMigrationLedger(
  database: DatabaseSync,
  migrations: readonly StorageMigration[],
  adoptedAt: string,
): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    const insert = database.prepare(
      `INSERT INTO storage_migrations(version, name, checksum, applied_at)
       VALUES (?, ?, ?, ?)`,
    );
    for (const migration of migrations) {
      insert.run(
        migration.version,
        migration.name,
        storageMigrationChecksum(migration),
        adoptedAt,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function validateAppliedLedger(
  rows: readonly AppliedMigrationRow[],
  migrations: readonly StorageMigration[],
): void {
  for (const [index, row] of rows.entries()) {
    if (row.version !== index + 1) throw new Error("MIGRATION_LEDGER_GAP");
  }
  if (rows.length > migrations.length) {
    throw new Error("STORAGE_SCHEMA_VERSION_UNSUPPORTED");
  }
  for (const row of rows) {
    const migration = migrations[row.version - 1];
    if (
      migration === undefined
      || row.name !== migration.name
      || row.checksum !== storageMigrationChecksum(migration)
    ) {
      throw new Error("MIGRATION_CHECKSUM_MISMATCH");
    }
  }
}

function databaseSchemaVersion(
  database: DatabaseSync,
): number | null {
  const row = database.prepare(
    `SELECT metadata_value
       FROM storage_metadata
      WHERE metadata_key = 'schema_version'`,
  ).get() as MetadataRow | undefined;
  if (row === undefined) return null;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(row.metadata_value)) {
    throw new Error("STORAGE_SCHEMA_VERSION_UNSUPPORTED");
  }
  return Number(row.metadata_value);
}

function hasTable(database: DatabaseSync, name: string): boolean {
  return database.prepare(
    `SELECT 1
       FROM sqlite_schema
      WHERE type = 'table' AND name = ?`,
  ).get(name) !== undefined;
}

function legacyMigrationMarker(database: DatabaseSync): string | null {
  if (!hasTable(database, "storage_metadata")) return null;
  const row = database.prepare(
    `SELECT metadata_value
       FROM storage_metadata
      WHERE metadata_key = 'migration_in_progress'`,
  ).get() as MetadataRow | undefined;
  return row?.metadata_value ?? null;
}

function clearKnownLegacyMigrationMarker(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(
      `DELETE FROM storage_metadata
        WHERE metadata_key = 'migration_in_progress'
          AND metadata_value = ?`,
    ).run(KNOWN_LEGACY_MIGRATION_MARKER);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function reconcileInterruptedMigration(
  database: DatabaseSync,
  migrations: readonly StorageMigration[],
  applied: readonly AppliedMigrationRow[],
): RecoveredMigration | null {
  const marker = database.prepare(
    `SELECT target_version, target_name, target_checksum
       FROM storage_migration_state
      WHERE singleton = 1`,
  ).get() as MigrationStateRow | undefined;
  if (marker === undefined) return null;
  const migration = migrations[marker.target_version - 1];
  if (
    migration === undefined
    || migration.name !== marker.target_name
    || storageMigrationChecksum(migration) !== marker.target_checksum
  ) {
    throw new Error("INTERRUPTED_MIGRATION_REQUIRES_MANUAL_RECOVERY");
  }
  const appliedRow = applied[marker.target_version - 1];
  const status = appliedRow === undefined
    ? "rolled_back"
    : appliedRow.version === marker.target_version
      && appliedRow.name === marker.target_name
      && appliedRow.checksum === marker.target_checksum
    ? "completed"
    : null;
  if (
    status === null
    || (status === "rolled_back" && marker.target_version !== applied.length + 1)
  ) {
    throw new Error("INTERRUPTED_MIGRATION_REQUIRES_MANUAL_RECOVERY");
  }
  database.prepare(
    "DELETE FROM storage_migration_state WHERE singleton = 1",
  ).run();
  return { targetVersion: marker.target_version, status };
}

function applyMigration(
  database: DatabaseSync,
  migration: StorageMigration,
  appliedAt: string,
  backupReceipt: StorageMigrationBackupReceipt | null,
): void {
  const checksum = storageMigrationChecksum(migration);
  database.prepare(
    `INSERT INTO storage_migration_state(
       singleton, target_version, target_name, target_checksum, started_at
     ) VALUES (1, ?, ?, ?, ?)`,
  ).run(migration.version, migration.name, checksum, appliedAt);
  database.exec("BEGIN IMMEDIATE");
  try {
    const destructiveAuthorized = backupReceipt?.status === "verified"
      && backupReceipt.sourceSchemaVersion === migration.version - 1
      && /^[a-f0-9]{64}$/u.test(backupReceipt.fingerprint);
    executeAuthorizedMigrationSql(
      database,
      migration.sql,
      { destructiveAuthorized },
    );
    validateNoRunnerOwnedSchemaReferences(database);
    database.prepare(
      `INSERT INTO storage_migrations(version, name, checksum, applied_at)
       VALUES (?, ?, ?, ?)`,
    ).run(migration.version, migration.name, checksum, appliedAt);
    database.prepare(
      `INSERT INTO storage_metadata(metadata_key, metadata_value, updated_at)
       VALUES ('schema_version', ?, ?)
       ON CONFLICT(metadata_key) DO UPDATE SET
         metadata_value = excluded.metadata_value,
         updated_at = excluded.updated_at`,
    ).run(String(migration.version), appliedAt);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    database.prepare(
      "DELETE FROM storage_migration_state WHERE singleton = 1",
    ).run();
    throw error;
  }
  database.prepare(
    "DELETE FROM storage_migration_state WHERE singleton = 1",
  ).run();
}

export function storageMigrationChecksum(
  migration: StorageMigration,
): string {
  return createHash("sha256")
    .update(String(migration.version))
    .update("\0")
    .update(migration.name)
    .update("\0")
    .update(migration.sql.replace(/\r\n?/gu, "\n"))
    .digest("hex");
}

export function loadStorageMigrations(
  options: {
    readonly directory?: URL | undefined;
  } = {},
): readonly StorageMigration[] {
  const candidates = options.directory === undefined
    ? [
        new URL("./migrations/", import.meta.url),
        new URL("../src/migrations/", import.meta.url),
      ]
    : [options.directory];
  const directory = candidates.find((candidate) => existsSync(candidate));
  if (directory === undefined) {
    throw new Error("STORAGE_MIGRATION_DIRECTORY_NOT_FOUND");
  }
  const entries = readdirSync(directory, { withFileTypes: true });
  const migrations = parseStorageMigrationManifest(
    entries.map((entry) => ({
      filename: entry.name,
      kind: entry.isFile() ? "file" : "other",
    })),
  )
    .map((entry) => {
      return {
        version: entry.version,
        name: entry.name,
        sql: readFileSync(new URL(entry.filename, directory), "utf8"),
      };
    });
  validateDefinitions(migrations);
  return migrations;
}

export function validateStorageHealth(
  database: DatabaseSync,
  expectedSchemaVersion: number,
): StorageHealthReceipt {
  const schemaVersion = databaseSchemaVersion(database);
  if (schemaVersion !== expectedSchemaVersion) {
    throw new Error("STORAGE_SCHEMA_VERSION_UNSUPPORTED");
  }
  const foreignKeys = database.prepare("PRAGMA foreign_keys").get() as {
    readonly foreign_keys?: number;
  };
  if (foreignKeys.foreign_keys !== 1) {
    throw new Error("STORAGE_FOREIGN_KEYS_DISABLED");
  }
  validateStorageIntegrity(database);
  const journal = database.prepare("PRAGMA journal_mode").get() as {
    readonly journal_mode?: string;
  };
  const journalMode = journal.journal_mode?.toLowerCase();
  if (journalMode !== "wal" && journalMode !== "memory") {
    throw new Error("STORAGE_WAL_DISABLED");
  }
  return {
    schemaVersion,
    foreignKeys: true,
    integrity: "ok",
    journalMode,
  };
}

function validateStorageIntegrity(database: DatabaseSync): void {
  const integrity = database.prepare("PRAGMA integrity_check").all() as unknown as
    readonly { readonly integrity_check?: string }[];
  if (
    integrity.length !== 1
    || integrity[0]?.integrity_check !== "ok"
  ) {
    throw new Error("STORAGE_INTEGRITY_FAILED");
  }
  const foreignKeyViolations = database
    .prepare("PRAGMA foreign_key_check")
    .all();
  if (foreignKeyViolations.length !== 0) {
    throw new Error("STORAGE_FOREIGN_KEY_CHECK_FAILED");
  }
}

export function runStorageMigrations(
  database: DatabaseSync,
  migrations: readonly StorageMigration[],
  options: {
    readonly now?: (() => Date) | undefined;
    readonly backupReceiptFor?:
      | ((
          migration: StorageMigration,
        ) => StorageMigrationBackupReceipt | null)
      | undefined;
  } = {},
): StorageMigrationReceipt {
  validateDefinitions(migrations);
  database.exec("PRAGMA foreign_keys = ON");
  validateStorageIntegrity(database);
  const preexistingSchemaVersion = hasTable(database, "storage_metadata")
    ? databaseSchemaVersion(database)
    : null;
  if (
    preexistingSchemaVersion !== null
    && preexistingSchemaVersion > migrations.length
  ) {
    throw new Error("STORAGE_SCHEMA_VERSION_UNSUPPORTED");
  }
  const legacyMarker = legacyMigrationMarker(database);
  if (
    legacyMarker !== null
    && legacyMarker !== KNOWN_LEGACY_MIGRATION_MARKER
  ) {
    throw new Error("INTERRUPTED_MIGRATION_REQUIRES_MANUAL_RECOVERY");
  }
  if (
    (preexistingSchemaVersion === null || preexistingSchemaVersion === 0)
    && nonRunnerSchemaObjects(database).length > 0
  ) {
    throw new Error("UNVERSIONED_STORAGE_NOT_EMPTY");
  }
  bootstrapMigrationLedger(database);
  let applied = appliedMigrations(database);
  validateAppliedLedger(applied, migrations);
  const recordedSchemaVersion = databaseSchemaVersion(database);
  if (
    recordedSchemaVersion !== null
    && recordedSchemaVersion > migrations.length
  ) {
    throw new Error("STORAGE_SCHEMA_VERSION_UNSUPPORTED");
  }
  const now = options.now ?? (() => new Date());
  let adoptedLegacy = false;
  if (
    applied.length === 0
    && recordedSchemaVersion !== null
    && recordedSchemaVersion > 0
  ) {
    if (recordedSchemaVersion !== 1) {
      throw new Error("MIGRATION_LEDGER_MISMATCH");
    }
    const legacyMigration = migrations[0];
    if (legacyMigration === undefined) {
      throw new Error("MIGRATION_LEDGER_MISMATCH");
    }
    validateLegacySchemaV1(database, legacyMigration);
    adoptLegacyMigrationLedger(
      database,
      migrations.slice(0, recordedSchemaVersion),
      now().toISOString(),
    );
    applied = appliedMigrations(database);
    validateAppliedLedger(applied, migrations);
    adoptedLegacy = true;
  } else if (
    applied.length > 0
    && recordedSchemaVersion !== applied.length
  ) {
    throw new Error("MIGRATION_LEDGER_MISMATCH");
  }
  if (!adoptedLegacy) {
    validateSchemaFingerprint(
      database,
      migrations.slice(0, applied.length),
      "STORAGE_SCHEMA_FINGERPRINT_MISMATCH",
    );
  }
  let recoveredMigration = reconcileInterruptedMigration(
    database,
    migrations,
    applied,
  );
  if (legacyMarker !== null) {
    if (recoveredMigration !== null) {
      throw new Error("INTERRUPTED_MIGRATION_REQUIRES_MANUAL_RECOVERY");
    }
    clearKnownLegacyMigrationMarker(database);
    recoveredMigration = { targetVersion: 1, status: "rolled_back" };
  }
  const appliedVersions: number[] = [];
  for (const migration of migrations.slice(applied.length)) {
    applyMigration(
      database,
      migration,
      now().toISOString(),
      options.backupReceiptFor?.(migration) ?? null,
    );
    appliedVersions.push(migration.version);
  }
  applied = appliedMigrations(database);
  validateAppliedLedger(applied, migrations);
  const schemaVersion = migrations.length;
  validateSchemaFingerprint(
    database,
    migrations,
    "STORAGE_SCHEMA_FINGERPRINT_MISMATCH",
  );
  return {
    schemaVersion,
    appliedVersions,
    recoveredMigration,
    health: validateStorageHealth(database, schemaVersion),
  };
}
