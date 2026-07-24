import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadStorageMigrations,
  runStorageMigrations,
  storageMigrationChecksum,
  validateStorageHealth,
  type StorageMigration,
} from "./migration-runner.js";
import { SqliteOperationJournal } from "./sqlite-operation-journal.js";

const databases = new Set<DatabaseSync>();
const temporaryDirectories = new Set<string>();

function database(): DatabaseSync {
  const result = new DatabaseSync(":memory:");
  databases.add(result);
  return result;
}

function migration(
  version: number,
  name: string,
  sql: string,
): StorageMigration {
  return { version, name, sql };
}

afterEach(() => {
  for (const candidate of databases) candidate.close();
  databases.clear();
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

describe("runStorageMigrations", () => {
  it("computes the same checksum for LF and CRLF checkouts", () => {
    const lf = migration(
      1,
      "portable",
      "CREATE TABLE portable(id INTEGER);\nSELECT 1;\n",
    );
    const crlf = migration(
      1,
      "portable",
      "CREATE TABLE portable(id INTEGER);\r\nSELECT 1;\r\n",
    );

    expect(storageMigrationChecksum(crlf)).toBe(
      storageMigrationChecksum(lf),
    );
  });

  it("applies contiguous migrations once and records deterministic checksums", () => {
    const db = database();
    const migrations = [
      migration(
        1,
        "create-counter",
        "CREATE TABLE counter(value INTEGER NOT NULL); INSERT INTO counter VALUES (1);",
      ),
      migration(
        2,
        "add-counter-audit",
        "CREATE TABLE counter_audit(id INTEGER PRIMARY KEY);",
      ),
    ];

    expect(
      runStorageMigrations(db, migrations, {
        now: () => new Date("2026-07-24T09:30:00.000Z"),
      }),
    ).toMatchObject({
      schemaVersion: 2,
      appliedVersions: [1, 2],
      recoveredMigration: null,
    });
    expect(
      runStorageMigrations(db, migrations, {
        now: () => new Date("2026-07-24T09:31:00.000Z"),
      }),
    ).toMatchObject({
      schemaVersion: 2,
      appliedVersions: [],
      recoveredMigration: null,
    });
    expect(
      db.prepare("SELECT value FROM counter ORDER BY value").all(),
    ).toEqual([{ value: 1 }]);
    expect(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'counter_audit'",
      ).get(),
    ).toEqual({ name: "counter_audit" });
    const rows = db
      .prepare(
        "SELECT version, name, checksum, applied_at FROM storage_migrations ORDER BY version",
      )
      .all() as unknown as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      {
        version: 1,
        name: "create-counter",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/u),
        applied_at: "2026-07-24T09:30:00.000Z",
      },
      {
        version: 2,
        name: "add-counter-audit",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/u),
        applied_at: "2026-07-24T09:30:00.000Z",
      },
    ]);
  });

  it("rejects a non-contiguous migration definition before changing storage", () => {
    const db = database();

    expect(() =>
      runStorageMigrations(db, [
        migration(1, "first", "CREATE TABLE first_table(id INTEGER);"),
        migration(3, "third", "CREATE TABLE third_table(id INTEGER);"),
      ])
    ).toThrowError("MIGRATION_SEQUENCE_INVALID");
    expect(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'first_table'",
      ).get(),
    ).toBeUndefined();
  });

  it("rejects a non-empty unversioned schema before bootstrapping migrations", () => {
    const db = database();
    db.exec(`
      CREATE TABLE events(
        position INTEGER PRIMARY KEY,
        project_id TEXT NOT NULL
      );
    `);

    expect(() =>
      runStorageMigrations(db, loadStorageMigrations())
    ).toThrowError("UNVERSIONED_STORAGE_NOT_EMPTY");
    expect(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'storage_migrations'",
      ).get(),
    ).toBeUndefined();
    expect(
      db.prepare(
        `SELECT name
           FROM sqlite_master
          WHERE type = 'index' AND name = 'events_project_position'`,
      ).get(),
    ).toBeUndefined();
  });

  it("rejects structural drift in an already versioned schema", () => {
    const db = database();
    const migrations = loadStorageMigrations();
    runStorageMigrations(db, migrations);
    db.exec("DROP INDEX events_project_position");

    expect(() =>
      runStorageMigrations(db, migrations)
    ).toThrowError("STORAGE_SCHEMA_FINGERPRINT_MISMATCH");
  });

  it("preserves quoted literal whitespace in the schema fingerprint", () => {
    const db = database();
    const migrations = [
      migration(
        1,
        "literal-default",
        "CREATE TABLE settings(value TEXT DEFAULT 'a  b');",
      ),
    ];
    runStorageMigrations(db, migrations);
    db.exec(`
      ALTER TABLE settings RENAME TO old_settings;
      CREATE TABLE settings(value TEXT DEFAULT 'a b');
      DROP TABLE old_settings;
    `);

    expect(() =>
      runStorageMigrations(db, migrations)
    ).toThrowError("STORAGE_SCHEMA_FINGERPRINT_MISMATCH");
  });

  it("fails closed when an applied migration checksum or name drifts", () => {
    const db = database();
    runStorageMigrations(db, [
      migration(1, "stable", "CREATE TABLE stable_table(id INTEGER);"),
    ]);

    expect(() =>
      runStorageMigrations(db, [
        migration(1, "changed", "CREATE TABLE changed_table(id INTEGER);"),
      ])
    ).toThrowError("MIGRATION_CHECKSUM_MISMATCH");
    expect(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'changed_table'",
      ).get(),
    ).toBeUndefined();
  });

  it("rejects an applied future schema and a gap in the durable ledger", () => {
    const future = database();
    runStorageMigrations(future, [
      migration(1, "known", "CREATE TABLE known_table(id INTEGER);"),
    ]);
    future.prepare(
      `INSERT INTO storage_migrations(version, name, checksum, applied_at)
       VALUES (2, 'future', ?, ?)`,
    ).run("f".repeat(64), "2026-07-24T09:30:00.000Z");
    future.prepare(
      `UPDATE storage_metadata
          SET metadata_value = '2'
        WHERE metadata_key = 'schema_version'`,
    ).run();

    expect(() =>
      runStorageMigrations(future, [
        migration(1, "known", "CREATE TABLE known_table(id INTEGER);"),
      ])
    ).toThrowError("STORAGE_SCHEMA_VERSION_UNSUPPORTED");

    const gap = database();
    runStorageMigrations(gap, [
      migration(1, "known", "CREATE TABLE known_table(id INTEGER);"),
    ]);
    gap.prepare("UPDATE storage_migrations SET version = 2 WHERE version = 1")
      .run();
    expect(() =>
      runStorageMigrations(gap, [
        migration(1, "known", "CREATE TABLE known_table(id INTEGER);"),
      ])
    ).toThrowError("MIGRATION_LEDGER_GAP");
  });

  it("checks existing foreign key integrity before applying a pending migration", () => {
    const db = database();
    const first = migration(
      1,
      "relations",
      `CREATE TABLE parent(id INTEGER PRIMARY KEY);
       CREATE TABLE child(
         id INTEGER PRIMARY KEY,
         parent_id INTEGER NOT NULL REFERENCES parent(id)
       );`,
    );
    const second = migration(
      2,
      "next",
      "CREATE TABLE next_table(id INTEGER PRIMARY KEY);",
    );
    runStorageMigrations(db, [first]);
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("INSERT INTO child(id, parent_id) VALUES (1, 999)").run();
    db.exec("PRAGMA foreign_keys = ON");

    expect(() =>
      runStorageMigrations(db, [first, second])
    ).toThrowError("STORAGE_FOREIGN_KEY_CHECK_FAILED");
    expect(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'next_table'",
      ).get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT version FROM storage_migrations ORDER BY version").all(),
    ).toEqual([{ version: 1 }]);
  });

  it("rolls back a failed migration without recording its version", () => {
    const db = database();
    const migrations = [
      migration(1, "base", "CREATE TABLE base_table(id INTEGER);"),
      migration(
        2,
        "broken",
        "CREATE TABLE should_rollback(id INTEGER); SELECT * FROM missing_table;",
      ),
    ];

    expect(() => runStorageMigrations(db, migrations)).toThrowError(
      /no such table: missing_table/u,
    );
    expect(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'",
      ).get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT version FROM storage_migrations ORDER BY version").all(),
    ).toEqual([{ version: 1 }]);
    expect(
      db.prepare("SELECT * FROM storage_migration_state").all(),
    ).toEqual([]);
  });

  it("rejects transaction control inside migration SQL without committing partial state", () => {
    const db = database();
    const escaping = migration(
      1,
      "escaping",
      "CREATE TABLE escaped(id INTEGER); COMMIT;",
    );

    expect(() => runStorageMigrations(db, [escaping])).toThrowError(
      "MIGRATION_SQL_OPERATION_FORBIDDEN",
    );
    expect(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'escaped'",
      ).get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT version FROM storage_migrations").all(),
    ).toEqual([]);
    expect(
      db.prepare("SELECT * FROM storage_migration_state").all(),
    ).toEqual([]);
    expect(
      db.prepare(
        "SELECT metadata_value FROM storage_metadata WHERE metadata_key = 'schema_version'",
      ).get(),
    ).toBeUndefined();
  });

  it("requires a verified backup receipt before destructive migration SQL", () => {
    const db = database();
    const first = migration(
      1,
      "base",
      "CREATE TABLE counter(value INTEGER NOT NULL); INSERT INTO counter VALUES (1);",
    );
    const destructive = migration(
      2,
      "rewrite-counter",
      "UPDATE counter SET value = value + 1;",
    );
    runStorageMigrations(db, [first]);

    expect(() =>
      runStorageMigrations(db, [first, destructive])
    ).toThrowError("DESTRUCTIVE_MIGRATION_BACKUP_REQUIRED");
    expect(db.prepare("SELECT value FROM counter").get()).toEqual({ value: 1 });
    expect(
      db.prepare("SELECT version FROM storage_migrations ORDER BY version").all(),
    ).toEqual([{ version: 1 }]);

    expect(
      runStorageMigrations(db, [first, destructive], {
        backupReceiptFor: () => ({
          status: "verified",
          sourceSchemaVersion: 1,
          fingerprint: "a".repeat(64),
        }),
      }),
    ).toMatchObject({
      schemaVersion: 2,
      appliedVersions: [2],
    });
    expect(db.prepare("SELECT value FROM counter").get()).toEqual({ value: 2 });
  });

  it("forbids migration SQL from forging runner-owned migration state", () => {
    const db = database();
    const first = migration(
      1,
      "base",
      "CREATE TABLE base_table(id INTEGER PRIMARY KEY);",
    );
    const forging = migration(
      2,
      "forging",
      `CREATE TABLE forged_table(id INTEGER PRIMARY KEY);
       INSERT INTO storage_migrations(version, name, checksum, applied_at)
       VALUES (3, 'forged', '${"f".repeat(64)}', '2026-07-24T09:30:00.000Z');`,
    );
    runStorageMigrations(db, [first]);

    expect(() =>
      runStorageMigrations(db, [first, forging])
    ).toThrowError("MIGRATION_SQL_OPERATION_FORBIDDEN");
    expect(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'forged_table'",
      ).get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT version FROM storage_migrations ORDER BY version").all(),
    ).toEqual([{ version: 1 }]);
    expect(
      db.prepare("SELECT * FROM storage_migration_state").all(),
    ).toEqual([]);
  });

  it("forbids triggers that target runner-owned metadata", () => {
    const db = database();
    const first = migration(
      1,
      "base",
      "CREATE TABLE base_table(id INTEGER PRIMARY KEY);",
    );
    const trigger = migration(
      2,
      "metadata-trigger",
      `CREATE TRIGGER metadata_trigger
       AFTER INSERT ON base_table
       BEGIN
         INSERT INTO storage_metadata(metadata_key, metadata_value, updated_at)
         VALUES ('schema_version', '999', '2026-07-24T09:30:00.000Z');
       END;`,
    );
    runStorageMigrations(db, [first]);

    expect(() =>
      runStorageMigrations(db, [first, trigger])
    ).toThrowError("MIGRATION_SQL_OPERATION_FORBIDDEN");
    expect(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'metadata_trigger'",
      ).get(),
    ).toBeUndefined();
    expect(
      db.prepare(
        "SELECT metadata_value FROM storage_metadata WHERE metadata_key = 'schema_version'",
      ).get(),
    ).toEqual({ metadata_value: "1" });
  });

  it("treats inserts into existing tables as destructive before conflict handling", () => {
    const db = database();
    const first = migration(
      1,
      "base",
      `CREATE TABLE settings(
         setting_key TEXT PRIMARY KEY,
         setting_value TEXT NOT NULL
       );
       INSERT INTO settings(setting_key, setting_value) VALUES ('mode', 'safe');`,
    );
    const replacing = migration(
      2,
      "replace-setting",
      `CREATE TABLE IF NOT EXISTS settings(
         setting_key TEXT PRIMARY KEY,
         setting_value TEXT NOT NULL
       );
       INSERT OR REPLACE INTO settings(setting_key, setting_value)
       VALUES ('mode', 'unsafe');`,
    );
    runStorageMigrations(db, [first]);

    expect(() =>
      runStorageMigrations(db, [first, replacing])
    ).toThrowError("DESTRUCTIVE_MIGRATION_BACKUP_REQUIRED");
    expect(
      db.prepare(
        "SELECT setting_value FROM settings WHERE setting_key = 'mode'",
      ).get(),
    ).toEqual({ setting_value: "safe" });
    expect(
      db.prepare("SELECT version FROM storage_migrations ORDER BY version").all(),
    ).toEqual([{ version: 1 }]);
  });

  it("reconciles a known rolled-back marker and applies the pending migration", () => {
    const db = database();
    const first = migration(
      1,
      "base",
      "CREATE TABLE base_table(id INTEGER);",
    );
    const second = migration(
      2,
      "next",
      "CREATE TABLE next_table(id INTEGER);",
    );
    runStorageMigrations(db, [first]);
    db.prepare(
      `INSERT INTO storage_migration_state(
         singleton, target_version, target_name, target_checksum, started_at
       ) VALUES (1, 2, ?, ?, ?)`,
    ).run(
      second.name,
      "0".repeat(64),
      "2026-07-24T09:30:00.000Z",
    );

    expect(() => runStorageMigrations(db, [first, second])).toThrowError(
      "INTERRUPTED_MIGRATION_REQUIRES_MANUAL_RECOVERY",
    );

    db.prepare("DELETE FROM storage_migration_state").run();
    db.prepare(
      `INSERT INTO storage_migration_state(
         singleton, target_version, target_name, target_checksum, started_at
       ) VALUES (1, 2, ?, ?, ?)`,
    ).run(
      second.name,
      storageMigrationChecksum(second),
      "2026-07-24T09:30:00.000Z",
    );

    expect(runStorageMigrations(db, [first, second])).toMatchObject({
      schemaVersion: 2,
      appliedVersions: [2],
      recoveredMigration: { targetVersion: 2, status: "rolled_back" },
    });
    expect(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'next_table'",
      ).get(),
    ).toEqual({ name: "next_table" });
  });
});

describe("validateStorageHealth", () => {
  it("requires foreign keys, a supported journal mode, integrity, and the exact schema version", () => {
    const db = database();
    const migrations = [
      migration(1, "base", "CREATE TABLE parent(id INTEGER PRIMARY KEY);"),
    ];
    runStorageMigrations(db, migrations);

    expect(validateStorageHealth(db, 1)).toMatchObject({
      schemaVersion: 1,
      foreignKeys: true,
      integrity: "ok",
      journalMode: "memory",
    });

    db.exec("PRAGMA foreign_keys = OFF");
    expect(() => validateStorageHealth(db, 1)).toThrowError(
      "STORAGE_FOREIGN_KEYS_DISABLED",
    );
  });

  it("fails closed when foreign key validation finds an orphan", () => {
    const db = database();
    runStorageMigrations(db, [
      migration(
        1,
        "relations",
        `CREATE TABLE parent(id INTEGER PRIMARY KEY);
         CREATE TABLE child(
           id INTEGER PRIMARY KEY,
           parent_id INTEGER NOT NULL REFERENCES parent(id)
         );`,
      ),
    ]);
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("INSERT INTO child(id, parent_id) VALUES (1, 999)").run();
    db.exec("PRAGMA foreign_keys = ON");

    expect(() => validateStorageHealth(db, 1)).toThrowError(
      "STORAGE_FOREIGN_KEY_CHECK_FAILED",
    );
  });

  it("requires integrity_check to return exactly one ok row", () => {
    const db = database();
    runStorageMigrations(db, [
      migration(1, "base", "CREATE TABLE base_table(id INTEGER);"),
    ]);
    const misleadingIntegrityResult = {
      prepare(statement: string) {
        if (statement === "PRAGMA integrity_check") {
          return {
            get: () => ({ integrity_check: "ok" }),
            all: () => [
              { integrity_check: "ok" },
              { integrity_check: "additional failure" },
            ],
          };
        }
        return db.prepare(statement);
      },
    } as unknown as DatabaseSync;

    expect(() =>
      validateStorageHealth(misleadingIntegrityResult, 1)
    ).toThrowError("STORAGE_INTEGRITY_FAILED");
  });
});

describe("repository storage migrations", () => {
  it("rejects every malformed SQL filename in a migration directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "hunter-migrations-"));
    temporaryDirectories.add(directory);
    writeFileSync(join(directory, "001-core.sql"), "SELECT 1;\n", "utf8");
    writeFileSync(join(directory, "002-next.sql"), "SELECT 2;\n", "utf8");
    writeFileSync(join(directory, "003_bad.sql"), "SELECT 3;\n", "utf8");

    expect(() =>
      loadStorageMigrations({
        directory: pathToFileURL(`${directory}/`),
      })
    ).toThrowError("MIGRATION_MANIFEST_FILENAME_INVALID");
  });

  it("loads ordered SQL files and applies the version 2 project event index", () => {
    const db = database();
    const migrations = loadStorageMigrations();

    expect(migrations.map(({ version, name }) => ({ version, name }))).toEqual([
      { version: 1, name: "core" },
      { version: 2, name: "events-project-position" },
    ]);
    for (const candidate of migrations) {
      expect(candidate.sql).not.toMatch(
        /\b(?:BEGIN|COMMIT)\b|PRAGMA\s+(?:foreign_keys|journal_mode)/iu,
      );
    }
    expect(runStorageMigrations(db, migrations)).toMatchObject({
      schemaVersion: 2,
      appliedVersions: [1, 2],
    });
    expect(
      db.prepare(
        `SELECT name
           FROM sqlite_master
          WHERE type = 'index' AND name = 'events_project_position'`,
      ).get(),
    ).toEqual({ name: "events_project_position" });
  });

  it("adopts an existing schema version 1 database without losing its events", () => {
    const db = database();
    const [core] = loadStorageMigrations();
    expect(core).toBeDefined();
    db.exec(`
      PRAGMA foreign_keys = ON;
      ${core?.sql ?? ""}
      CREATE TABLE storage_metadata (
        metadata_key TEXT PRIMARY KEY,
        metadata_value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE principal_project_authorizations (
        principal_id TEXT PRIMARY KEY,
        project_ids_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO storage_metadata(metadata_key, metadata_value, updated_at)
      VALUES ('schema_version', '1', '2026-07-24T09:30:00.000Z');
      INSERT INTO events(
        event_id, project_id, aggregate_id, aggregate_version, event_type,
        event_data, actor_id, correlation_id, causation_id, schema_version,
        occurred_at, recorded_at
      ) VALUES (
        'evt_legacy01', 'prj_legacy01', 'legacy:aggregate', 1, 'LegacyObserved',
        '{}', 'legacy', 'legacy-correlation', NULL, 1,
        '2026-07-24T09:30:00.000Z', '2026-07-24T09:30:00.000Z'
      );
    `);

    new SqliteOperationJournal(db);

    expect(
      db.prepare("SELECT event_id FROM events WHERE event_id = 'evt_legacy01'")
        .get(),
    ).toEqual({ event_id: "evt_legacy01" });
    expect(
      db.prepare(
        "SELECT version FROM storage_migrations ORDER BY version",
      ).all(),
    ).toEqual([{ version: 1 }, { version: 2 }]);
    expect(
      db.prepare(
        "SELECT metadata_value FROM storage_metadata WHERE metadata_key = 'schema_version'",
      ).get(),
    ).toEqual({ metadata_value: "2" });
  });

  it("rejects an unknown legacy marker before applying a pending migration", () => {
    const db = database();
    const [core] = loadStorageMigrations();
    expect(core).toBeDefined();
    db.exec(`
      PRAGMA foreign_keys = ON;
      ${core?.sql ?? ""}
      CREATE TABLE storage_metadata (
        metadata_key TEXT PRIMARY KEY,
        metadata_value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO storage_metadata(metadata_key, metadata_value, updated_at)
      VALUES ('schema_version', '1', '2026-07-24T09:30:00.000Z');
      INSERT INTO storage_metadata(metadata_key, metadata_value, updated_at)
      VALUES ('migration_in_progress', 'target_schema_version:999', '2026-07-24T09:30:00.000Z');
    `);

    expect(() => new SqliteOperationJournal(db)).toThrowError(
      "INTERRUPTED_MIGRATION_REQUIRES_MANUAL_RECOVERY",
    );
    expect(
      db.prepare(
        `SELECT name
           FROM sqlite_master
          WHERE type = 'index' AND name = 'events_project_position'`,
      ).get(),
    ).toBeUndefined();
    expect(
      db.prepare(
        "SELECT metadata_value FROM storage_metadata WHERE metadata_key = 'migration_in_progress'",
      ).get(),
    ).toEqual({ metadata_value: "target_schema_version:999" });
  });

  it("reconciles the known legacy marker before applying a pending migration", () => {
    const db = database();
    const [core] = loadStorageMigrations();
    expect(core).toBeDefined();
    db.exec(`
      PRAGMA foreign_keys = ON;
      ${core?.sql ?? ""}
      CREATE TABLE storage_metadata (
        metadata_key TEXT PRIMARY KEY,
        metadata_value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO storage_metadata(metadata_key, metadata_value, updated_at)
      VALUES ('schema_version', '1', '2026-07-24T09:30:00.000Z');
      INSERT INTO storage_metadata(metadata_key, metadata_value, updated_at)
      VALUES ('migration_in_progress', 'target_schema_version:1', '2026-07-24T09:30:00.000Z');
    `);

    const journal = new SqliteOperationJournal(db);

    expect(journal.migrationReceipt).toMatchObject({
      schemaVersion: 2,
      appliedVersions: [2],
      recoveredMigration: { targetVersion: 1, status: "rolled_back" },
    });
    expect(
      db.prepare(
        "SELECT metadata_value FROM storage_metadata WHERE metadata_key = 'migration_in_progress'",
      ).get(),
    ).toBeUndefined();
    expect(
      db.prepare(
        `SELECT name
           FROM sqlite_master
          WHERE type = 'index' AND name = 'events_project_position'`,
      ).get(),
    ).toEqual({ name: "events_project_position" });
  });

  it("records a legacy schema version without re-running its migration", () => {
    const db = database();
    db.exec(`
      CREATE TABLE storage_metadata (
        metadata_key TEXT PRIMARY KEY,
        metadata_value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE legacy_counter(value INTEGER NOT NULL);
      INSERT INTO legacy_counter(value) VALUES (1);
      INSERT INTO storage_metadata(metadata_key, metadata_value, updated_at)
      VALUES ('schema_version', '1', '2026-07-24T09:30:00.000Z');
    `);
    const migrations = [
      migration(
        1,
        "legacy-side-effect",
        `CREATE TABLE IF NOT EXISTS legacy_counter(value INTEGER NOT NULL);
         INSERT INTO legacy_counter(value) VALUES (1);`,
      ),
      migration(
        2,
        "next",
        "CREATE TABLE next_table(id INTEGER PRIMARY KEY);",
      ),
    ];

    expect(
      runStorageMigrations(db, migrations, {
        now: () => new Date("2026-07-24T09:31:00.000Z"),
      }),
    ).toMatchObject({
      schemaVersion: 2,
      appliedVersions: [2],
    });
    expect(db.prepare("SELECT value FROM legacy_counter").get()).toEqual({
      value: 1,
    });
    expect(
      db.prepare(
        "SELECT version FROM storage_migrations ORDER BY version",
      ).all(),
    ).toEqual([{ version: 1 }, { version: 2 }]);
  });

  it("rejects legacy version metadata when the version 1 structure is incomplete", () => {
    const db = database();
    db.exec(`
      CREATE TABLE storage_metadata (
        metadata_key TEXT PRIMARY KEY,
        metadata_value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO storage_metadata(metadata_key, metadata_value, updated_at)
      VALUES ('schema_version', '1', '2026-07-24T09:30:00.000Z');
    `);

    expect(() =>
      runStorageMigrations(db, loadStorageMigrations())
    ).toThrowError("LEGACY_SCHEMA_FINGERPRINT_MISMATCH");
    expect(
      db.prepare("SELECT version FROM storage_migrations").all(),
    ).toEqual([]);
    expect(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'",
      ).get(),
    ).toBeUndefined();
  });

  it("rejects a legacy schema with unexpected tables or triggers", () => {
    const db = database();
    const [core] = loadStorageMigrations();
    expect(core).toBeDefined();
    db.exec(`
      PRAGMA foreign_keys = ON;
      ${core?.sql ?? ""}
      CREATE TABLE storage_metadata (
        metadata_key TEXT PRIMARY KEY,
        metadata_value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE unexpected_table(id INTEGER PRIMARY KEY);
      CREATE TRIGGER unexpected_trigger
      AFTER INSERT ON events
      BEGIN
        INSERT INTO unexpected_table(id) VALUES (new.position);
      END;
      INSERT INTO storage_metadata(metadata_key, metadata_value, updated_at)
      VALUES ('schema_version', '1', '2026-07-24T09:30:00.000Z');
    `);

    expect(() =>
      runStorageMigrations(db, loadStorageMigrations())
    ).toThrowError("LEGACY_SCHEMA_FINGERPRINT_MISMATCH");
    expect(
      db.prepare(
        `SELECT name
           FROM sqlite_master
          WHERE type = 'index' AND name = 'events_project_position'`,
      ).get(),
    ).toBeUndefined();
  });

  it("rejects empty or partial ledgers that disagree with schema metadata", () => {
    const first = migration(
      1,
      "first",
      "CREATE TABLE first_table(id INTEGER PRIMARY KEY);",
    );
    const second = migration(
      2,
      "second",
      "CREATE TABLE second_table(id INTEGER PRIMARY KEY);",
    );
    const emptyLedger = database();
    emptyLedger.exec(`
      CREATE TABLE storage_metadata (
        metadata_key TEXT PRIMARY KEY,
        metadata_value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO storage_metadata(metadata_key, metadata_value, updated_at)
      VALUES ('schema_version', '2', '2026-07-24T09:30:00.000Z');
    `);
    expect(() =>
      runStorageMigrations(emptyLedger, [first, second])
    ).toThrowError("MIGRATION_LEDGER_MISMATCH");
    expect(
      emptyLedger.prepare("SELECT version FROM storage_migrations").all(),
    ).toEqual([]);

    const partialLedger = database();
    runStorageMigrations(partialLedger, [first]);
    partialLedger.prepare(
      `UPDATE storage_metadata
          SET metadata_value = '2'
        WHERE metadata_key = 'schema_version'`,
    ).run();
    expect(() =>
      runStorageMigrations(partialLedger, [first, second])
    ).toThrowError("MIGRATION_LEDGER_MISMATCH");
    expect(
      partialLedger.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'second_table'",
      ).get(),
    ).toBeUndefined();
  });

  it("makes journal construction fail closed for a future schema", () => {
    const db = database();
    db.exec(`
      CREATE TABLE storage_metadata (
        metadata_key TEXT PRIMARY KEY,
        metadata_value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO storage_metadata(metadata_key, metadata_value, updated_at)
      VALUES ('schema_version', '999', '2026-07-24T09:30:00.000Z');
    `);

    expect(() => new SqliteOperationJournal(db)).toThrowError(
      "STORAGE_SCHEMA_VERSION_UNSUPPORTED",
    );
    expect(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'",
      ).get(),
    ).toBeUndefined();
  });
});
