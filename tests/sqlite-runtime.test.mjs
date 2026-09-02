import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import {
  EDWARD_FITNESS_DATABASE_NAME,
  EDWARD_FITNESS_TIMEZONE,
  OPEN_FITNESS_DATABASE_NAME,
} from "../db/schema-identity.mjs";

const adapterUrl = new URL("../db/local-sqlite.ts", import.meta.url);
const migrationJournal = JSON.parse(
  readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
);
let importSequence = 0;

const contractRows = sqliteTable("local_runtime_contract_rows", {
  id: integer("id").primaryKey(),
  label: text("label").notNull().unique(),
});

function temporaryRoot() {
  return mkdtempSync(join(tmpdir(), "edward-fitness-local-runtime-"));
}

function createAppSchema(path) {
  const database = new DatabaseSync(path);
  for (const entry of migrationJournal.entries) {
    const migration = readFileSync(
      new URL(`../drizzle/${entry.tag}.sql`, import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim() !== "") database.exec(statement);
    }
  }
  database.exec(`
    CREATE TABLE local_runtime_contract_rows (
      id INTEGER PRIMARY KEY,
      label TEXT NOT NULL UNIQUE
    );
    CREATE TABLE local_runtime_contract_parents (
      id INTEGER PRIMARY KEY
    );
    CREATE TABLE local_runtime_contract_children (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER NOT NULL REFERENCES local_runtime_contract_parents(id)
    );
  `);
  return database;
}

function insertSchemaMetadata(database, schemaVersion = 8, overrides = {}) {
  database
    .prepare(
      `INSERT INTO schema_metadata (
        schema_version,
        database_name,
        canonical_master,
        timezone
      ) VALUES (?, ?, ?, ?)`,
    )
    .run(
      schemaVersion,
      overrides.databaseName ?? EDWARD_FITNESS_DATABASE_NAME,
      overrides.canonicalMaster ?? 1,
      overrides.timezone ?? EDWARD_FITNESS_TIMEZONE,
    );
}

function createFixture(path, marker, metadataOverrides) {
  const database = createAppSchema(path);
  try {
    insertSchemaMetadata(database, 8, metadataOverrides);
    if (marker !== undefined) {
      database
        .prepare(
          "INSERT INTO local_runtime_contract_rows (id, label) VALUES (1, ?)",
        )
        .run(marker);
    }
    assert.equal(
      database.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
  } finally {
    database.close();
  }
}

async function loadAdapter(sqlitePath) {
  if (sqlitePath === undefined) delete process.env.FITNESS_SQLITE_PATH;
  else process.env.FITNESS_SQLITE_PATH = sqlitePath;

  assert.ok(
    existsSync(adapterUrl),
    "Missing db/local-sqlite.ts: implement the native local SQLite adapter before this contract can pass",
  );
  const runtime = await import(`${adapterUrl.href}?contract=${importSequence++}`);
  assert.equal(typeof runtime.getLocalDb, "function");
  assert.equal(
    typeof runtime.closeLocalDbForTests,
    "function",
    "The adapter must export closeLocalDbForTests() so disposable files can be released",
  );
  return runtime;
}

async function close(runtime) {
  await runtime.closeLocalDbForTests();
}

function restoreEnvironment(previous) {
  if (previous === undefined) delete process.env.FITNESS_SQLITE_PATH;
  else process.env.FITNESS_SQLITE_PATH = previous;
}

function errorChainMessage(error) {
  const messages = [];
  const seen = new Set();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\n");
}

function isClosedClientError(error) {
  return /CLIENT_CLOSED|client is closed/i.test(errorChainMessage(error));
}

function isForeignKeyError(error) {
  return /FOREIGN KEY constraint failed/i.test(errorChainMessage(error));
}

test("FITNESS_SQLITE_PATH rejects invalid paths and databases without the Open Fitness schema", async () => {
  const root = temporaryRoot();
  const previousPath = process.env.FITNESS_SQLITE_PATH;
  const previousCwd = process.cwd();
  let runtime;

  try {
    runtime = await loadAdapter(undefined);
    assert.throws(() => runtime.getLocalDb(), /FITNESS_SQLITE_PATH.*required/i);
    await close(runtime);

    process.env.FITNESS_SQLITE_PATH = "";
    assert.throws(() => runtime.getLocalDb(), /FITNESS_SQLITE_PATH.*required/i);
    await close(runtime);

    process.env.FITNESS_SQLITE_PATH = "   ";
    assert.throws(() => runtime.getLocalDb(), /FITNESS_SQLITE_PATH.*required/i);
    await close(runtime);

    process.chdir(root);
    const relativePath = "relative fitness.sqlite";
    process.env.FITNESS_SQLITE_PATH = relativePath;
    assert.throws(() => runtime.getLocalDb(), /FITNESS_SQLITE_PATH.*absolute/i);
    assert.equal(existsSync(join(root, relativePath)), false);
    await close(runtime);

    const missingPath = join(root, "missing fitness.sqlite");
    process.env.FITNESS_SQLITE_PATH = missingPath;
    assert.throws(
      () => runtime.getLocalDb(),
      /FITNESS_SQLITE_PATH.*(?:exist|regular file)/i,
    );
    assert.equal(existsSync(missingPath), false);
    await close(runtime);

    const zeroLengthPath = join(root, "zero length.sqlite");
    writeFileSync(zeroLengthPath, "");
    process.env.FITNESS_SQLITE_PATH = zeroLengthPath;
    assert.throws(
      () => runtime.getLocalDb(),
      /FITNESS_SQLITE_PATH.*zero-length file/i,
    );
    assert.equal(lstatSync(zeroLengthPath).size, 0);
    await close(runtime);

    const corruptPath = join(root, "corrupt.sqlite");
    const corruptBytes = Buffer.from("not-a-sqlite-database", "utf8");
    writeFileSync(corruptPath, corruptBytes);
    process.env.FITNESS_SQLITE_PATH = corruptPath;
    assert.throws(
      () => runtime.getLocalDb(),
      /database|sqlite|integrity/i,
    );
    assert.deepEqual(readFileSync(corruptPath), corruptBytes);
    assert.equal(existsSync(`${corruptPath}-wal`), false);
    assert.equal(existsSync(`${corruptPath}-shm`), false);
    await close(runtime);

    const wrongSchemaPath = join(root, "wrong schema.sqlite");
    const wrongSchemaDatabase = new DatabaseSync(wrongSchemaPath);
    wrongSchemaDatabase.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
    wrongSchemaDatabase.close();
    process.env.FITNESS_SQLITE_PATH = wrongSchemaPath;
    assert.throws(
      () => runtime.getLocalDb(),
      /missing the Open Fitness schema_metadata table/i,
    );
    const unchangedWrongSchema = new DatabaseSync(wrongSchemaPath, {
      readOnly: true,
    });
    try {
      assert.equal(
        String(
          unchangedWrongSchema.prepare("PRAGMA journal_mode").get().journal_mode,
        ).toLowerCase(),
        "delete",
      );
    } finally {
      unchangedWrongSchema.close();
    }
    await close(runtime);

    const markerOnlyPath = join(root, "unrelated marker.sqlite");
    const markerOnlyDatabase = new DatabaseSync(markerOnlyPath);
    markerOnlyDatabase.exec(`
      CREATE TABLE unrelated (id INTEGER PRIMARY KEY);
      CREATE TABLE schema_metadata (schema_version INTEGER NOT NULL);
      INSERT INTO schema_metadata (schema_version) VALUES (8);
    `);
    markerOnlyDatabase.close();
    const markerOnlyBytes = readFileSync(markerOnlyPath);
    process.env.FITNESS_SQLITE_PATH = markerOnlyPath;
    assert.throws(
      () => runtime.getLocalDb(),
      /does not match the Open Fitness table schema/i,
    );
    assert.deepEqual(readFileSync(markerOnlyPath), markerOnlyBytes);
    assert.equal(existsSync(`${markerOnlyPath}-wal`), false);
    assert.equal(existsSync(`${markerOnlyPath}-shm`), false);
    const unchangedMarkerOnly = new DatabaseSync(markerOnlyPath, {
      readOnly: true,
    });
    try {
      assert.equal(
        String(
          unchangedMarkerOnly.prepare("PRAGMA journal_mode").get().journal_mode,
        ).toLowerCase(),
        "delete",
      );
    } finally {
      unchangedMarkerOnly.close();
    }
    await close(runtime);

    const invalidMetadataPath = join(root, "invalid metadata.sqlite");
    const invalidMetadataDatabase = createAppSchema(invalidMetadataPath);
    invalidMetadataDatabase.exec(`
      DROP TABLE schema_metadata;
      CREATE TABLE schema_metadata (
        schema_version TEXT NOT NULL,
        database_name TEXT NOT NULL,
        canonical_master INTEGER NOT NULL,
        timezone TEXT NOT NULL,
        created_at TEXT NOT NULL,
        source_workbook_sha256 TEXT NOT NULL
      );
    `);
    invalidMetadataDatabase
      .prepare(
        `INSERT INTO schema_metadata (
          schema_version,
          database_name,
          canonical_master,
          timezone,
          created_at,
          source_workbook_sha256
        ) VALUES (?, ?, 1, ?, CURRENT_TIMESTAMP, '')`,
      )
      .run(
        "not-a-version",
        EDWARD_FITNESS_DATABASE_NAME,
        EDWARD_FITNESS_TIMEZONE,
      );
    invalidMetadataDatabase.close();
    process.env.FITNESS_SQLITE_PATH = invalidMetadataPath;
    assert.throws(
      () => runtime.getLocalDb(),
      /invalid schema metadata/i,
    );
    const unchangedInvalidMetadata = new DatabaseSync(invalidMetadataPath, {
      readOnly: true,
    });
    try {
      assert.equal(
        String(
          unchangedInvalidMetadata.prepare("PRAGMA journal_mode").get()
            .journal_mode,
        ).toLowerCase(),
        "delete",
      );
    } finally {
      unchangedInvalidMetadata.close();
    }
    await close(runtime);

    const emptyMetadataPath = join(root, "empty metadata.sqlite");
    const emptyMetadataDatabase = createAppSchema(emptyMetadataPath);
    emptyMetadataDatabase.close();
    process.env.FITNESS_SQLITE_PATH = emptyMetadataPath;
    assert.throws(
      () => runtime.getLocalDb(),
      /invalid schema metadata/i,
    );
    const unchangedEmptyMetadata = new DatabaseSync(emptyMetadataPath, {
      readOnly: true,
    });
    try {
      assert.equal(
        String(
          unchangedEmptyMetadata.prepare("PRAGMA journal_mode").get()
            .journal_mode,
        ).toLowerCase(),
        "delete",
      );
    } finally {
      unchangedEmptyMetadata.close();
    }
    await close(runtime);

    const duplicateMetadataPath = join(root, "duplicate metadata.sqlite");
    const duplicateMetadataDatabase = createAppSchema(duplicateMetadataPath);
    insertSchemaMetadata(duplicateMetadataDatabase, 7);
    insertSchemaMetadata(duplicateMetadataDatabase, 8);
    duplicateMetadataDatabase.close();
    process.env.FITNESS_SQLITE_PATH = duplicateMetadataPath;
    assert.throws(
      () => runtime.getLocalDb(),
      /invalid schema metadata/i,
    );
    const unchangedDuplicateMetadata = new DatabaseSync(duplicateMetadataPath, {
      readOnly: true,
    });
    try {
      assert.equal(
        String(
          unchangedDuplicateMetadata.prepare("PRAGMA journal_mode").get()
            .journal_mode,
        ).toLowerCase(),
        "delete",
      );
    } finally {
      unchangedDuplicateMetadata.close();
    }
    await close(runtime);

    const negativeMetadataPath = join(root, "negative metadata.sqlite");
    const negativeMetadataDatabase = createAppSchema(negativeMetadataPath);
    insertSchemaMetadata(negativeMetadataDatabase, -1);
    negativeMetadataDatabase.close();
    process.env.FITNESS_SQLITE_PATH = negativeMetadataPath;
    assert.throws(
      () => runtime.getLocalDb(),
      /invalid schema metadata/i,
    );
    assert.equal(existsSync(`${negativeMetadataPath}-wal`), false);
    assert.equal(existsSync(`${negativeMetadataPath}-shm`), false);
    await close(runtime);

    const wrongIdentityPath = join(root, "wrong identity.sqlite");
    const wrongIdentityDatabase = createAppSchema(wrongIdentityPath);
    insertSchemaMetadata(wrongIdentityDatabase, 7, {
      databaseName: "Unrelated Fitness Database",
    });
    wrongIdentityDatabase.close();
    process.env.FITNESS_SQLITE_PATH = wrongIdentityPath;
    assert.throws(
      () => runtime.getLocalDb(),
      /invalid schema metadata/i,
    );
    assert.equal(existsSync(`${wrongIdentityPath}-wal`), false);
    assert.equal(existsSync(`${wrongIdentityPath}-shm`), false);
    await close(runtime);

    const mismatchedLegacyIdentityPath = join(
      root,
      "mismatched legacy identity.sqlite",
    );
    const mismatchedLegacyIdentityDatabase = createAppSchema(
      mismatchedLegacyIdentityPath,
    );
    insertSchemaMetadata(mismatchedLegacyIdentityDatabase, 7, {
      timezone: "UTC",
    });
    mismatchedLegacyIdentityDatabase.close();
    process.env.FITNESS_SQLITE_PATH = mismatchedLegacyIdentityPath;
    assert.throws(
      () => runtime.getLocalDb(),
      /invalid schema metadata/i,
    );
    await close(runtime);

    const wrongColumnsPath = join(root, "wrong columns.sqlite");
    const wrongColumnsDatabase = createAppSchema(wrongColumnsPath);
    wrongColumnsDatabase.exec(`
      DROP TABLE profile;
      CREATE TABLE profile (profile_id TEXT PRIMARY KEY NOT NULL);
    `);
    insertSchemaMetadata(wrongColumnsDatabase);
    wrongColumnsDatabase.close();
    process.env.FITNESS_SQLITE_PATH = wrongColumnsPath;
    assert.throws(
      () => runtime.getLocalDb(),
      /does not match the Open Fitness column schema/i,
    );
    assert.equal(existsSync(`${wrongColumnsPath}-wal`), false);
    assert.equal(existsSync(`${wrongColumnsPath}-shm`), false);
    await close(runtime);

    const symlinkTargetPath = join(root, "symlink target.sqlite");
    const symlinkPath = join(root, "database symlink.sqlite");
    createFixture(symlinkTargetPath);
    symlinkSync(symlinkTargetPath, symlinkPath);
    process.env.FITNESS_SQLITE_PATH = symlinkPath;
    assert.throws(() => runtime.getLocalDb(), /FITNESS_SQLITE_PATH.*regular file/i);
    await close(runtime);

    const directoryPath = join(root, "not-a-database");
    mkdirSync(directoryPath);
    process.env.FITNESS_SQLITE_PATH = directoryPath;
    assert.throws(() => runtime.getLocalDb(), /FITNESS_SQLITE_PATH.*regular file/i);
    assert.equal(existsSync(directoryPath), true);
  } finally {
    process.chdir(previousCwd);
    if (runtime) await close(runtime);
    restoreEnvironment(previousPath);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the local client opens a spaced file URL with WAL, 5000ms busy timeout, and foreign keys enabled", async () => {
  const root = temporaryRoot();
  const spacedDirectory = join(root, "directory with spaces");
  const databasePath = join(spacedDirectory, "fitness contract.sqlite");
  const previousPath = process.env.FITNESS_SQLITE_PATH;
  let runtime;

  try {
    mkdirSync(spacedDirectory);
    createFixture(databasePath, undefined, {
      databaseName: OPEN_FITNESS_DATABASE_NAME,
      timezone: "America/Los_Angeles",
    });
    runtime = await loadAdapter(databasePath);
    const db = runtime.getLocalDb();
    const status = runtime.getLocalDbRuntimeStatus();

    assert.deepEqual(status, {
      adapter: "libsql-local",
      busyTimeoutMs: 5000,
      journalMode: "WAL",
      schemaVersion: 8,
    });
    assert.equal(JSON.stringify(status).includes(databasePath), false);

    const busyTimeout = await db.values(sql.raw("PRAGMA busy_timeout"));
    assert.equal(Number(busyTimeout[0]?.timeout), 5000);
    await assert.rejects(
      db.run(
        sql.raw(
          "INSERT INTO local_runtime_contract_children (id, parent_id) VALUES (1, 999)",
        ),
      ),
      isForeignKeyError,
    );

    await close(runtime);
    const standardSqlite = new DatabaseSync(databasePath);
    try {
      assert.equal(
        String(
          standardSqlite.prepare("PRAGMA journal_mode").get().journal_mode,
        ).toLowerCase(),
        "wal",
      );
    } finally {
      standardSqlite.close();
    }
  } finally {
    if (runtime) await close(runtime);
    restoreEnvironment(previousPath);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Drizzle libSQL batch commits atomically and remains readable through node:sqlite", async () => {
  const root = temporaryRoot();
  const databasePath = join(root, "atomic contract.sqlite");
  const previousPath = process.env.FITNESS_SQLITE_PATH;
  let runtime;

  try {
    createFixture(databasePath);
    runtime = await loadAdapter(databasePath);
    const db = runtime.getLocalDb();

    await db.batch([
      db.insert(contractRows).values({ id: 1, label: "committed-a" }),
      db.insert(contractRows).values({ id: 2, label: "committed-b" }),
    ]);
    await assert.rejects(
      db.batch([
        db.insert(contractRows).values({ id: 3, label: "must-roll-back" }),
        db.insert(contractRows).values({ id: 4, label: "committed-a" }),
      ]),
      /UNIQUE constraint failed/i,
    );

    await close(runtime);
    const standardSqlite = new DatabaseSync(databasePath);
    try {
      assert.deepEqual(
        standardSqlite
          .prepare("SELECT id, label FROM local_runtime_contract_rows ORDER BY id")
          .all()
          .map((row) => ({ id: Number(row.id), label: String(row.label) })),
        [
          { id: 1, label: "committed-a" },
          { id: 2, label: "committed-b" },
        ],
      );
    } finally {
      standardSqlite.close();
    }
  } finally {
    if (runtime) await close(runtime);
    restoreEnvironment(previousPath);
    rmSync(root, { recursive: true, force: true });
  }
});

test("closeLocalDbForTests resets the singleton and releases disposable files", async () => {
  const root = temporaryRoot();
  const firstPath = join(root, "first contract.sqlite");
  const secondPath = join(root, "second contract.sqlite");
  const previousPath = process.env.FITNESS_SQLITE_PATH;
  let runtime;

  try {
    createFixture(firstPath, "first-database");
    createFixture(secondPath, "second-database");
    runtime = await loadAdapter(firstPath);

    const firstDb = runtime.getLocalDb();
    assert.deepEqual(
      await firstDb.values(
        sql.raw(
          "SELECT label FROM local_runtime_contract_rows ORDER BY id",
        ),
      ),
      [{ label: "first-database" }],
    );

    process.env.FITNESS_SQLITE_PATH = secondPath;
    assert.throws(
      () => runtime.getLocalDb(),
      /Cannot switch FITNESS_SQLITE_PATH while a local DB is open/,
    );
    process.env.FITNESS_SQLITE_PATH = firstPath;
    assert.equal(runtime.getLocalDb(), firstDb);

    await close(runtime);
    await assert.rejects(
      firstDb.values(sql.raw("SELECT 1")),
      isClosedClientError,
    );

    process.env.FITNESS_SQLITE_PATH = secondPath;
    const secondDb = runtime.getLocalDb();
    assert.notEqual(secondDb, firstDb);
    assert.deepEqual(
      await secondDb.values(
        sql.raw(
          "SELECT label FROM local_runtime_contract_rows ORDER BY id",
        ),
      ),
      [{ label: "second-database" }],
    );
    await close(runtime);

    rmSync(root, { recursive: true });
    assert.equal(existsSync(root), false);
  } finally {
    if (runtime) await close(runtime);
    restoreEnvironment(previousPath);
    rmSync(root, { recursive: true, force: true });
  }
});
