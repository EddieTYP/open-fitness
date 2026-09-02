import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EDWARD_FITNESS_DATABASE_NAME,
  EDWARD_FITNESS_TIMEZONE,
} from "../db/schema-identity.mjs";

const storageModuleUrl = new URL("../scripts/sqlite-storage.mjs", import.meta.url);
const replacementModuleUrl = new URL(
  "../scripts/replace-stopped-sqlite.mjs",
  import.meta.url,
);
const backupCliPath = fileURLToPath(
  new URL("../scripts/backup-sqlite.mjs", import.meta.url),
);
const migrationCliPath = fileURLToPath(
  new URL("../scripts/local-db-migrate.mjs", import.meta.url),
);
const verifyCliPath = fileURLToPath(
  new URL("../scripts/verify-sqlite-backup.mjs", import.meta.url),
);
const migrationsDirectory = new URL("../drizzle/", import.meta.url);
const migrationJournal = JSON.parse(
  readFileSync(new URL("meta/_journal.json", migrationsDirectory), "utf8"),
);

function temporaryRoot() {
  return realpathSync(mkdtempSync(join(tmpdir(), "edward-fitness-storage-")));
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function applyMigrationsThrough(database, version) {
  for (const entry of migrationJournal.entries) {
    if (entry.idx > version) break;
    const migration = readFileSync(
      new URL(`${entry.tag}.sql`, migrationsDirectory),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim() !== "") database.exec(statement);
    }
  }
}

function createFixture(path, version) {
  const database = new DatabaseSync(path);
  applyMigrationsThrough(database, version);
  database
    .prepare(
      `INSERT INTO schema_metadata (
        schema_version,
        database_name,
        canonical_master,
        timezone,
        source_workbook_sha256
      ) VALUES (?, ?, 1, ?, '')`,
    )
    .run(version, EDWARD_FITNESS_DATABASE_NAME, EDWARD_FITNESS_TIMEZONE);
  database
    .prepare(
      `INSERT INTO profile (
        profile_id,
        primary_goal,
        training_cycle,
        timezone,
        updated_at
      ) VALUES ('owner', 'contract fixture', 'test', ?, '2026-08-05T00:00:00+08:00')`,
    )
    .run(EDWARD_FITNESS_TIMEZONE);
  assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  return database;
}

async function loadStorageModule() {
  assert.ok(
    existsSync(storageModuleUrl),
    "Missing scripts/sqlite-storage.mjs: implement the shared SQLite storage policy",
  );
  return import(storageModuleUrl.href);
}

function runCli(scriptPath, args, environment = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    env: {
      HOME: process.env.HOME,
      NODE_NO_WARNINGS: "1",
      PATH: process.env.PATH,
      ...environment,
    },
  });
}

function parseCliSuccess(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  return JSON.parse(result.stdout);
}

test("online backup captures committed WAL data without changing the source", async () => {
  const root = temporaryRoot();
  const sourcePath = join(root, "source.sqlite");
  const backupDirectory = join(root, "backups");
  const restorePath = join(root, "restore.sqlite");
  const reportPath = join(root, "restore-report.json");
  mkdirSync(backupDirectory, { mode: 0o700 });
  const source = createFixture(sourcePath, 8);

  try {
    assert.equal(source.prepare("PRAGMA journal_mode = WAL").get().journal_mode, "wal");
    source.exec("PRAGMA wal_autocheckpoint = 0");
    source
      .prepare(
        `INSERT INTO body_measurements (
          measurement_id,
          measured_at,
          source_device,
          source_file,
          weight_kg
        ) VALUES ('wal-row', '2026-08-05T00:00:00+08:00', 'fixture', 'fixture', 70.5)`,
      )
      .run();

    const sourceHashBefore = sha256File(sourcePath);
    const walPath = `${sourcePath}-wal`;
    assert.equal(existsSync(walPath), true);
    const walHashBefore = sha256File(walPath);
    const sourceCountBefore = source
      .prepare("SELECT COUNT(*) AS value FROM body_measurements")
      .get().value;

    const storage = await loadStorageModule();
    const backup = await storage.createSqliteBackup({
      sourcePath,
      backupDirectory,
      label: "contract",
      now: new Date("2026-08-05T00:01:02.003Z"),
      applicationVersion: "test",
    });

    assert.equal(existsSync(backup.backupPath), true);
    assert.equal(existsSync(backup.manifestPath), true);
    assert.equal(lstatSync(backup.backupPath).mode & 0o777, 0o600);
    assert.equal(lstatSync(backup.manifestPath).mode & 0o777, 0o600);
    assert.equal(backup.manifest.database.schemaVersion, 8);
    assert.equal(backup.manifest.database.integrity, "ok");
    assert.equal(backup.manifest.database.foreignKeyViolations, 0);
    assert.equal(backup.manifest.database.rowCounts.body_measurements, 1);
    assert.equal(backup.manifest.database.rowCounts.training_schedule_events, 0);
    assert.equal(sha256File(sourcePath), sourceHashBefore);
    assert.equal(sha256File(walPath), walHashBefore);
    assert.equal(
      source.prepare("SELECT COUNT(*) AS value FROM body_measurements").get().value,
      sourceCountBefore,
    );
    assert.equal(JSON.stringify(backup.manifest).includes(root), false);

    const verification = await storage.verifySqliteBackup({
      backupPath: backup.backupPath,
      manifestPath: backup.manifestPath,
      restorePath,
      reportPath,
      now: new Date("2026-08-05T00:02:03.004Z"),
    });
    assert.equal(verification.report.passed, true);
    assert.equal(existsSync(restorePath), true);
    assert.equal(existsSync(reportPath), true);
    assert.equal(lstatSync(restorePath).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(verification.report).includes(root), false);

    const restored = new DatabaseSync(restorePath, { readOnly: true });
    try {
      assert.equal(
        restored.prepare("SELECT COUNT(*) AS value FROM body_measurements").get().value,
        1,
      );
      assert.equal(
        restored.prepare("SELECT COUNT(*) AS value FROM profile").get().value,
        1,
      );
      assert.doesNotThrow(() =>
        restored.prepare("SELECT COUNT(*) FROM v_data_quality_checks").get(),
      );
    } finally {
      restored.close();
    }

    assert.equal(sha256File(sourcePath), sourceHashBefore);
    assert.equal(
      source.prepare("SELECT COUNT(*) AS value FROM body_measurements").get().value,
      sourceCountBefore,
    );
  } finally {
    source.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("backup supports explicit no-overwrite output paths", async () => {
  const root = temporaryRoot();
  const sourcePath = join(root, "source.sqlite");
  const backupPath = join(root, "staging.sqlite");
  const manifestPath = join(root, "staging.sqlite.source-manifest.json");
  const danglingPath = join(root, "dangling.sqlite");
  const source = createFixture(sourcePath, 8);
  source.close();

  try {
    const storage = await loadStorageModule();
    const result = await storage.createSqliteBackup({
      sourcePath,
      backupPath,
      manifestPath,
      label: "staging",
      applicationVersion: "test",
    });
    assert.equal(result.backupPath, backupPath);
    assert.equal(result.manifestPath, manifestPath);
    assert.equal(lstatSync(backupPath).mode & 0o777, 0o600);
    assert.equal(lstatSync(manifestPath).mode & 0o777, 0o600);
    assert.equal(storage.inspectSqliteDatabase(backupPath).schemaVersion, 8);

    await assert.rejects(
      () => storage.createSqliteBackup({ sourcePath, backupPath, manifestPath }),
      /already exists/,
    );
    await assert.rejects(
      () =>
        storage.createSqliteBackup({
          sourcePath,
          backupPath: join(root, "missing-manifest.sqlite"),
        }),
      /provided together/,
    );
    symlinkSync(join(root, "missing-target.sqlite"), danglingPath);
    await assert.rejects(
      () =>
        storage.createSqliteBackup({
          sourcePath,
          backupPath: danglingPath,
          manifestPath: join(root, "dangling.manifest.json"),
        }),
      /already exists/,
    );
    assert.equal(existsSync(join(root, "dangling.manifest.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backup and restore outputs never overwrite and tampering fails closed", async () => {
  const root = temporaryRoot();
  const sourcePath = join(root, "source.sqlite");
  const backupDirectory = join(root, "backups");
  const restorePath = join(root, "restore.sqlite");
  const reportPath = join(root, "restore-report.json");
  mkdirSync(backupDirectory, { mode: 0o700 });
  const source = createFixture(sourcePath, 8);

  try {
    source.close();
    const storage = await loadStorageModule();
    const options = {
      sourcePath,
      backupDirectory,
      label: "collision",
      now: new Date("2026-08-05T01:02:03.004Z"),
      applicationVersion: "test",
    };
    const backup = await storage.createSqliteBackup(options);
    await assert.rejects(
      () => storage.createSqliteBackup(options),
      /already exists/,
    );

    writeFileSync(backup.backupPath, Buffer.from("tampered"), { flag: "a" });
    await assert.rejects(
      () =>
        storage.verifySqliteBackup({
          backupPath: backup.backupPath,
          manifestPath: backup.manifestPath,
          restorePath,
          reportPath,
        }),
      /SHA-256 does not match/,
    );
    assert.equal(existsSync(restorePath), false);
    assert.equal(existsSync(reportPath), false);
  } finally {
    if (source.isOpen) source.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("backup verification rejects malformed or non-exact manifest metadata", async () => {
  const root = temporaryRoot();
  const sourcePath = join(root, "source.sqlite");
  const backupDirectory = join(root, "backups");
  mkdirSync(backupDirectory, { mode: 0o700 });
  createFixture(sourcePath, 8).close();

  try {
    const storage = await loadStorageModule();
    const backup = await storage.createSqliteBackup({
      sourcePath,
      backupDirectory,
      label: "manifest-contract",
      applicationVersion: "test",
    });
    const original = JSON.parse(readFileSync(backup.manifestPath, "utf8"));
    const mutations = [
      (manifest) => {
        manifest.createdAt = "not-a-timestamp";
      },
      (manifest) => {
        delete manifest.application.version;
      },
      (manifest) => {
        manifest.backup.file = "../outside.sqlite";
      },
      (manifest) => {
        delete manifest.database.schemaIdentitySha256;
      },
      (manifest) => {
        manifest.database.rowCounts.extra_table = 0;
      },
      (manifest) => {
        manifest.unexpected = true;
      },
    ];
    for (const [index, mutate] of mutations.entries()) {
      const manifest = structuredClone(original);
      mutate(manifest);
      const manifestPath = join(root, `malformed-${index}.json`);
      const restorePath = join(root, `restore-${index}.sqlite`);
      const reportPath = join(root, `report-${index}.json`);
      writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
      await assert.rejects(
        () =>
          storage.verifySqliteBackup({
            backupPath: backup.backupPath,
            manifestPath,
            restorePath,
            reportPath,
          }),
        /unsupported or incomplete/,
      );
      assert.equal(existsSync(restorePath), false);
      assert.equal(existsSync(reportPath), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backup publication is race-safe and never follows a swapped output", async () => {
  const root = temporaryRoot();
  const sourcePath = join(root, "source.sqlite");
  createFixture(sourcePath, 8).close();

  try {
    const storage = await loadStorageModule();
    const claimedBackupPath = join(root, "claimed.sqlite");
    const claimedManifestPath = join(root, "claimed.manifest.json");
    const claimedPromise = storage.createSqliteBackup({
      sourcePath,
      backupPath: claimedBackupPath,
      manifestPath: claimedManifestPath,
      applicationVersion: "test",
    });
    writeFileSync(claimedBackupPath, "claimant", { mode: 0o600 });
    await assert.rejects(claimedPromise, /already exists/);
    assert.equal(readFileSync(claimedBackupPath, "utf8"), "claimant");
    assert.equal(existsSync(claimedManifestPath), false);

    const swappedBackupPath = join(root, "swapped.sqlite");
    const swappedManifestPath = join(root, "swapped.manifest.json");
    const victimPath = join(root, "victim.txt");
    writeFileSync(victimPath, "victim", { mode: 0o600 });
    const swappedPromise = storage.createSqliteBackup({
      sourcePath,
      backupPath: swappedBackupPath,
      manifestPath: swappedManifestPath,
      applicationVersion: "test",
    });
    assert.equal(existsSync(swappedManifestPath), true);
    rmSync(swappedManifestPath);
    symlinkSync(victimPath, swappedManifestPath);
    await assert.rejects(swappedPromise, /changed during publication/);
    assert.equal(readFileSync(victimPath, "utf8"), "victim");
    assert.equal(existsSync(swappedBackupPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stopped same-filesystem replacement preserves rollback and installs only a verified candidate", async () => {
  const root = temporaryRoot();
  const activePath = join(root, "fitness.sqlite");
  const backupDirectory = join(root, "backups");
  const candidatePath = join(root, "restore-candidate.sqlite");
  const reportPath = join(root, "restore-report.json");
  const rollbackPath = join(root, "fitness.sqlite.rollback");
  mkdirSync(backupDirectory, { mode: 0o700 });
  createFixture(activePath, 8).close();

  try {
    const storage = await loadStorageModule();
    const backup = await storage.createSqliteBackup({
      sourcePath: activePath,
      backupDirectory,
      label: "pre-mutation",
      now: new Date("2026-08-05T04:05:06.007Z"),
      applicationVersion: "test",
    });
    const originalRows = storage.inspectSqliteDatabase(activePath).rowCounts;
    const verification = await storage.verifySqliteBackup({
      backupPath: backup.backupPath,
      manifestPath: backup.manifestPath,
      restorePath: candidatePath,
      reportPath,
    });
    assert.equal(verification.report.passed, true);

    const mutable = new DatabaseSync(activePath);
    mutable
      .prepare(
        `INSERT INTO body_measurements (
           measurement_id, measured_at, source_device, source_file, weight_kg
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "STAGING-QA|replacement",
        "2026-08-05T12:00:00+08:00",
        "STAGING QA",
        "staging-only",
        70,
      );
    mutable.close();
    const mutatedHash = sha256File(activePath);
    const mutatedRows = storage.inspectSqliteDatabase(activePath).rowCounts;
    assert.equal(
      mutatedRows.body_measurements,
      originalRows.body_measurements + 1,
    );

    const replacement = await import(
      `${replacementModuleUrl.href}?test=${Date.now()}`
    );
    assert.throws(
      () =>
        replacement.replaceStoppedSqlite({
          activePath,
          candidatePath,
          verificationReportPath: reportPath,
          rollbackPath,
        }),
      /explicit stopped-state probe/,
    );
    const heldOpen = new DatabaseSync(activePath, { readOnly: true });
    try {
      assert.throws(
        () =>
          replacement.replaceStoppedSqlite({
            activePath,
            candidatePath,
            verificationReportPath: reportPath,
            rollbackPath,
            serviceStateProbe: () => {},
          }),
        /open process handle/,
      );
    } finally {
      heldOpen.close();
    }

    writeFileSync(`${activePath}-wal`, "sidecar fixture", { mode: 0o600 });
    assert.throws(
      () =>
        replacement.replaceStoppedSqlite({
          activePath,
          candidatePath,
          verificationReportPath: reportPath,
          rollbackPath,
          checkpointActiveWal: false,
          serviceStateProbe: () => {},
        }),
      /sidecar/,
    );
    rmSync(`${activePath}-wal`);

    let stoppedStateProbes = 0;
    assert.throws(
      () =>
        replacement.replaceStoppedSqlite({
          activePath,
          candidatePath,
          verificationReportPath: reportPath,
          rollbackPath,
          serviceStateProbe: () => {
            stoppedStateProbes += 1;
            if (stoppedStateProbes === 3) {
              throw new Error("simulated service restart before swap");
            }
          },
          openHandleProbe: () => {},
        }),
      /simulated service restart before swap/,
    );
    assert.equal(stoppedStateProbes, 3);
    assert.equal(existsSync(candidatePath), true);
    assert.equal(existsSync(rollbackPath), false);

    const result = replacement.replaceStoppedSqlite({
      activePath,
      candidatePath,
      verificationReportPath: reportPath,
      rollbackPath,
      serviceStateProbe: () => {},
    });
    assert.equal(result.replaced, true);
    assert.equal(result.schemaVersion, 8);
    assert.equal(existsSync(candidatePath), false);
    assert.equal(existsSync(rollbackPath), true);
    assert.notEqual(sha256File(activePath), mutatedHash);
    assert.equal(sha256File(rollbackPath), mutatedHash);
    assert.deepEqual(
      storage.inspectSqliteDatabase(activePath).rowCounts,
      originalRows,
    );
    assert.deepEqual(
      storage.inspectSqliteDatabase(rollbackPath).rowCounts,
      mutatedRows,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema SQL identity normalizes only whitespace outside quoted literals", async () => {
  const root = temporaryRoot();
  const compactPath = join(root, "compact.sqlite");
  const formattedPath = join(root, "formatted.sqlite");
  const differentLiteralPath = join(root, "different-literal.sqlite");
  try {
    const compact = createFixture(compactPath, 8);
    compact.exec("CREATE VIEW quote_identity_probe AS SELECT 'a  b' AS value");
    compact.close();

    const formatted = createFixture(formattedPath, 8);
    formatted.exec(
      "CREATE   VIEW quote_identity_probe AS\n  SELECT 'a  b'   AS value",
    );
    formatted.close();

    const differentLiteral = createFixture(differentLiteralPath, 8);
    differentLiteral.exec(
      "CREATE VIEW quote_identity_probe AS SELECT 'a b' AS value",
    );
    differentLiteral.close();

    const storage = await loadStorageModule();
    const compactIdentity = storage.inspectSqliteDatabase(compactPath)
      .schemaIdentitySha256;
    assert.equal(
      storage.inspectSqliteDatabase(formattedPath).schemaIdentitySha256,
      compactIdentity,
    );
    assert.notEqual(
      storage.inspectSqliteDatabase(differentLiteralPath).schemaIdentitySha256,
      compactIdentity,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("logical database digest detects in-place mutation with unchanged row counts", async () => {
  const root = temporaryRoot();
  const databasePath = join(root, "logical-digest.sqlite");
  try {
    const database = createFixture(databasePath, 8);
    database.close();
    const storage = await loadStorageModule();
    const before = storage.logicalSqliteDigest(databasePath);
    assert.deepEqual(storage.logicalValue(42n), ["number", "42"]);
    assert.deepEqual(storage.logicalValue(9_007_199_254_740_992n), [
      "bigint",
      "9007199254740992",
    ]);
    const writer = new DatabaseSync(databasePath);
    writer
      .prepare("UPDATE profile SET primary_goal = ? WHERE profile_id = 'owner'")
      .run("changed fixture");
    writer.close();
    assert.notEqual(storage.logicalSqliteDigest(databasePath), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("logical database digest preserves full SQLite 64-bit integers", async () => {
  const root = temporaryRoot();
  const databasePath = join(root, "logical-bigint.sqlite");
  try {
    const database = createFixture(databasePath, 8);
    database
      .prepare(
        `INSERT INTO workout_sessions (
           session_id, source, session_title, session_type, started_at, ended_at,
           duration_seconds, total_sets_reported, started_at_utc, local_date
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        "bigint-probe",
        "test",
        "BigInt probe",
        "test",
        "2026-08-05T00:00:00.000Z",
        "2026-08-05T00:00:01.000Z",
        9_223_372_036_854_775_807n,
        "2026-08-05T00:00:00.000Z",
        "2026-08-05",
      );
    database.close();
    const storage = await loadStorageModule();
    const before = storage.logicalSqliteDigest(databasePath);
    assert.equal(storage.logicalSqliteDigest(databasePath), before);

    const writer = new DatabaseSync(databasePath);
    writer
      .prepare("UPDATE workout_sessions SET duration_seconds = ? WHERE session_id = ?")
      .run(9_223_372_036_854_775_806n, "bigint-probe");
    writer.close();
    assert.notEqual(storage.logicalSqliteDigest(databasePath), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration checks reject missing indexes, views, triggers, foreign keys, and checks", async () => {
  const root = temporaryRoot();
  const pristinePath = join(root, "pristine-v13.sqlite");
  const fixture = createFixture(pristinePath, 13);
  fixture.close();

  const corruptions = [
    ["missing-index", "DROP INDEX audit_log_request_entity_uq"],
    ["missing-view", "DROP VIEW v_data_quality_checks"],
    ["missing-trigger", "DROP TRIGGER workout_sessions_require_canonical_insert"],
    [
      "changed-foreign-key",
      `PRAGMA writable_schema = ON;
       UPDATE sqlite_master
       SET sql = replace(sql, 'ON DELETE restrict', 'ON DELETE no action')
       WHERE type = 'table' AND name = 'decision_rules';
       PRAGMA writable_schema = OFF;`,
    ],
    [
      "changed-check",
      `PRAGMA writable_schema = ON;
       UPDATE sqlite_master
       SET sql = replace(sql, 'IN (0, 1)', 'IN (0, 1, 2)')
       WHERE type = 'table' AND name = 'schema_metadata';
       PRAGMA writable_schema = OFF;`,
    ],
  ];

  try {
    const storage = await loadStorageModule();
    assert.deepEqual(
      await storage.checkLocalMigrations({
        sourcePath: pristinePath,
        migrationsDirectory,
      }),
      { currentVersion: 13, targetVersion: 16, pendingVersions: [14, 15, 16] },
    );
    for (const [name, sql] of corruptions) {
      const corruptPath = join(root, `${name}.sqlite`);
      cpSync(pristinePath, corruptPath);
      const database = new DatabaseSync(corruptPath);
      database.exec(sql);
      const schemaVersion = database.prepare("PRAGMA schema_version").get().schema_version;
      database.exec(`PRAGMA schema_version = ${Number(schemaVersion) + 1}`);
      database.close();
      await assert.rejects(
        () =>
          storage.checkLocalMigrations({
            sourcePath: corruptPath,
            migrationsDirectory,
          }),
        /declared schema version/,
        name,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local migration backs up version 7, applies pending versions atomically, and is idempotent", async () => {
  const root = temporaryRoot();
  const sourcePath = join(root, "source-v7.sqlite");
  const backupDirectory = join(root, "backups");
  const restorePath = join(root, "pre-migration-restore.sqlite");
  const reportPath = join(root, "pre-migration-report.json");
  mkdirSync(backupDirectory, { mode: 0o700 });
  const source = createFixture(sourcePath, 7);
  source.close();

  try {
    const sourceHashBefore = sha256File(sourcePath);
    const storage = await loadStorageModule();
    const result = await storage.runLocalMigrations({
      sourcePath,
      backupDirectory,
      migrationsDirectory,
      applicationVersion: "test",
      now: new Date("2026-08-05T02:03:04.005Z"),
    });

    assert.equal(result.migrated, true);
    assert.equal(result.fromVersion, 7);
    assert.equal(result.toVersion, 16);
    assert.deepEqual(
      result.appliedVersions,
      [8, 9, 10, 11, 12, 13, 14, 15, 16],
    );
    assert.equal(result.backup.manifest.database.schemaVersion, 7);
    assert.equal(result.backup.manifest.database.rowCounts.profile, 1);
    assert.equal(
      Object.hasOwn(result.backup.manifest.database.rowCounts, "training_schedule_events"),
      false,
    );
    assert.notEqual(sha256File(sourcePath), sourceHashBefore);

    const migrated = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      assert.equal(
        migrated.prepare("SELECT schema_version AS value FROM schema_metadata").get().value,
        16,
      );
      assert.equal(
        migrated
          .prepare(
            "SELECT COUNT(*) AS value FROM sqlite_master WHERE type = 'table' AND name = 'training_schedule_events'",
          )
          .get().value,
        1,
      );
      const foreignKeys = migrated
        .prepare("PRAGMA foreign_key_list(training_schedule_events)")
        .all();
      assert.equal(foreignKeys.some((row) => row.table === "profile"), true);
      assert.equal(migrated.prepare("SELECT COUNT(*) AS value FROM profile").get().value, 1);
      assert.deepEqual(
        {
          goalType: migrated
            .prepare("SELECT goal_type AS value FROM profile")
            .get().value,
          setupCompleted: migrated
            .prepare("SELECT setup_completed AS value FROM profile")
            .get().value,
          preferredLocale: migrated
            .prepare("SELECT preferred_locale AS value FROM profile")
            .get().value,
        },
        { goalType: "general", setupCompleted: 1, preferredLocale: "zh-HK" },
      );
      assert.equal(migrated.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(migrated.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      migrated.close();
    }

    const restored = await storage.verifySqliteBackup({
      backupPath: result.backup.backupPath,
      manifestPath: result.backup.manifestPath,
      restorePath,
      reportPath,
    });
    assert.equal(restored.report.database.schemaVersion, 7);
    const preMigration = new DatabaseSync(restorePath, { readOnly: true });
    try {
      assert.equal(
        preMigration
          .prepare(
            "SELECT COUNT(*) AS value FROM sqlite_master WHERE type = 'table' AND name = 'training_schedule_events'",
          )
          .get().value,
        0,
      );
      assert.equal(preMigration.prepare("SELECT COUNT(*) AS value FROM profile").get().value, 1);
    } finally {
      preMigration.close();
    }

    const backupFilesBefore = new Set(
      readFileSync(result.backup.manifestPath, "utf8") ? [
        result.backup.backupPath,
        result.backup.manifestPath,
      ] : [],
    );
    const second = await storage.runLocalMigrations({
      sourcePath,
      backupDirectory,
      migrationsDirectory,
      applicationVersion: "test",
    });
    assert.equal(second.migrated, false);
    assert.equal(second.fromVersion, 16);
    assert.equal(second.toVersion, 16);
    assert.deepEqual(second.appliedVersions, []);
    assert.equal(second.backup, null);
    assert.equal(backupFilesBefore.size, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("body measurement local dates migrate safely and are enforced", async () => {
  const root = temporaryRoot();
  const sourcePath = join(root, "source-v12.sqlite");
  const backupDirectory = join(root, "backups");
  mkdirSync(backupDirectory, { mode: 0o700 });

  const source = createFixture(sourcePath, 12);
  source.exec(`INSERT INTO body_measurements (
    measurement_id, measured_at, source_device, source_file, weight_kg
  ) VALUES (
    'legacy-body-row',
    '2026-08-05T23:30:00Z',
    'fixture',
    'fixture',
    70.0
  )`);
  source.close();

  try {
    const storage = await loadStorageModule();
    const result = await storage.runLocalMigrations({
      sourcePath,
      backupDirectory,
      migrationsDirectory,
      applicationVersion: "test",
    });
    assert.equal(result.fromVersion, 12);
    assert.equal(result.toVersion, 16);
    assert.deepEqual(result.appliedVersions, [13, 14, 15, 16]);

    const migrated = new DatabaseSync(sourcePath);
    try {
      assert.equal(
        migrated
          .prepare(
            "SELECT local_date AS value FROM body_measurements WHERE measurement_id = 'legacy-body-row'",
          )
          .get().value,
        "2026-08-05",
      );
      assert.equal(
        migrated
          .prepare(
            "SELECT COUNT(*) AS value FROM sqlite_master WHERE type = 'index' AND name = 'idx_body_measurements_local_date'",
          )
          .get().value,
        1,
      );
      assert.equal(
        migrated
          .prepare(
            "SELECT COUNT(*) AS value FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'body_measurements_local_date_%_guard'",
          )
          .get().value,
        2,
      );
      assert.throws(
        () =>
          migrated.exec(`INSERT INTO body_measurements (
            measurement_id, measured_at, source_device, source_file, weight_kg
          ) VALUES (
            'missing-local-date',
            '2026-08-06T00:00:00Z',
            'fixture',
            'fixture',
            70.1
          )`),
        /BODY_MEASUREMENT_LOCAL_DATE_REQUIRED/,
      );
      assert.throws(
        () =>
          migrated.exec(`INSERT INTO body_measurements (
            measurement_id, measured_at, local_date, source_device, source_file, weight_kg
          ) VALUES (
            'invalid-local-date',
            '2026-08-06T00:01:00Z',
            '2026-02-30',
            'fixture',
            'fixture',
            70.2
          )`),
        /BODY_MEASUREMENT_LOCAL_DATE_REQUIRED/,
      );
      migrated.exec(`INSERT INTO body_measurements (
        measurement_id, measured_at, local_date, source_device, source_file, weight_kg
      ) VALUES (
        'valid-local-date',
        '2026-08-06T00:02:00Z',
        '2026-08-06',
        'fixture',
        'fixture',
        70.3
      )`);
      const weightViewSql = migrated
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'v_body_weight_7d_trend'",
        )
        .get().sql;
      assert.match(weightViewSql, /local_date/);
      assert.doesNotMatch(weightViewSql, /measured_at/);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed migration rolls back schema and preserves a verified pre-migration backup", async () => {
  const root = temporaryRoot();
  const sourcePath = join(root, "source-v13.sqlite");
  const backupDirectory = join(root, "backups");
  const fixtureMigrations = join(root, "drizzle");
  const restorePath = join(root, "rollback-restore.sqlite");
  const reportPath = join(root, "rollback-report.json");
  mkdirSync(backupDirectory, { mode: 0o700 });
  cpSync(fileURLToPath(migrationsDirectory), fixtureMigrations, { recursive: true });

  const journalPath = join(fixtureMigrations, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries.push({
    idx: 17,
    version: "6",
    when: 0,
    tag: "0017_broken_fixture",
    breakpoints: true,
  });
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  cpSync(
    join(fixtureMigrations, "meta", "0016_snapshot.json"),
    join(fixtureMigrations, "meta", "0017_snapshot.json"),
  );
  writeFileSync(
    join(fixtureMigrations, "0017_broken_fixture.sql"),
    "CREATE UNIQUE INDEX migration_should_rollback ON body_measurements(source_file);\n",
  );

  const source = createFixture(sourcePath, 13);
  source.exec(`INSERT INTO body_measurements (
    measurement_id, measured_at, local_date, source_device, source_file, weight_kg
  ) VALUES
    ('migration-failure-1', '2026-08-05T00:00:00+08:00', '2026-08-05', 'fixture', 'duplicate-source', 70.0),
    ('migration-failure-2', '2026-08-05T00:01:00+08:00', '2026-08-05', 'fixture', 'duplicate-source', 70.1)`);
  source.close();

  try {
    const storage = await loadStorageModule();
    await assert.rejects(
      () =>
        storage.runLocalMigrations({
          sourcePath,
          backupDirectory,
          migrationsDirectory: fixtureMigrations,
          applicationVersion: "test",
          now: new Date("2026-08-05T03:04:05.006Z"),
        }),
      /UNIQUE constraint failed/,
    );

    const after = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      assert.equal(
        after.prepare("SELECT schema_version AS value FROM schema_metadata").get().value,
        13,
      );
      assert.equal(
        after
          .prepare(
            "SELECT COUNT(*) AS value FROM sqlite_master WHERE type = 'index' AND name = 'migration_should_rollback'",
          )
          .get().value,
        0,
      );
      assert.equal(after.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(after.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      after.close();
    }

    const backupFiles = readdirSync(backupDirectory).sort();
    assert.equal(backupFiles.length, 2);
    const backupPath = join(
      backupDirectory,
      backupFiles.find((name) => name.endsWith(".sqlite")),
    );
    const manifestPath = join(
      backupDirectory,
      backupFiles.find((name) => name.endsWith(".manifest.json")),
    );
    const verification = await storage.verifySqliteBackup({
      backupPath,
      manifestPath,
      restorePath,
      reportPath,
    });
    assert.equal(verification.report.passed, true);
    assert.equal(verification.report.database.schemaVersion, 13);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI wrappers perform check, migration, backup, and verified restore", () => {
  const root = temporaryRoot();
  const sourcePath = join(root, "source-v7.sqlite");
  const backupDirectory = join(root, "backups");
  const restorePath = join(root, "cli-restore.sqlite");
  const reportPath = join(root, "cli-restore-report.json");
  mkdirSync(backupDirectory, { mode: 0o700 });
  const source = createFixture(sourcePath, 7);
  source.close();

  try {
    const environment = {
      FITNESS_BACKUP_DIR: backupDirectory,
      FITNESS_SQLITE_PATH: sourcePath,
    };
    const sourceHashBefore = sha256File(sourcePath);

    const missingMode = runCli(migrationCliPath, [], environment);
    assert.equal(missingMode.status, 1);
    assert.match(missingMode.stderr, /--check\|--apply/);
    assert.equal(sha256File(sourcePath), sourceHashBefore);

    const check = parseCliSuccess(
      runCli(migrationCliPath, ["--check"], environment),
    );
    assert.deepEqual(check, {
      ok: true,
      mode: "check",
      currentVersion: 7,
      targetVersion: 16,
      pendingVersions: [8, 9, 10, 11, 12, 13, 14, 15, 16],
    });
    assert.deepEqual(readdirSync(backupDirectory), []);
    assert.equal(sha256File(sourcePath), sourceHashBefore);

    const applied = parseCliSuccess(
      runCli(migrationCliPath, ["--apply"], environment),
    );
    assert.equal(applied.migrated, true);
    assert.equal(applied.fromVersion, 7);
    assert.equal(applied.toVersion, 16);
    assert.deepEqual(
      applied.appliedVersions,
      [8, 9, 10, 11, 12, 13, 14, 15, 16],
    );
    assert.equal(typeof applied.backupFile, "string");
    assert.equal(typeof applied.manifestFile, "string");
    assert.equal(readdirSync(backupDirectory).length, 2);

    const manual = parseCliSuccess(runCli(backupCliPath, [], environment));
    assert.equal(manual.ok, true);
    assert.equal(manual.schemaVersion, 16);
    assert.equal(manual.sha256.length, 64);
    assert.equal(readdirSync(backupDirectory).length, 4);

    const backupPath = join(backupDirectory, manual.backupFile);
    const manifestPath = join(backupDirectory, manual.manifestFile);
    const verified = parseCliSuccess(
      runCli(verifyCliPath, [backupPath, manifestPath, restorePath, reportPath]),
    );
    assert.equal(verified.ok, true);
    assert.equal(verified.schemaVersion, 16);
    assert.equal(verified.sha256, manual.sha256);
    assert.equal(JSON.parse(readFileSync(reportPath, "utf8")).passed, true);
    assert.equal(JSON.stringify(verified).includes(root), false);

    const filesBeforeNoOp = readdirSync(backupDirectory).sort();
    const noOp = parseCliSuccess(
      runCli(migrationCliPath, ["--apply"], environment),
    );
    assert.equal(noOp.migrated, false);
    assert.deepEqual(noOp.appliedVersions, []);
    assert.deepEqual(readdirSync(backupDirectory).sort(), filesBeforeNoOp);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("storage operations reject unsafe paths before creating outputs", async () => {
  const root = temporaryRoot();
  const sourcePath = join(root, "source.sqlite");
  const sourceLink = join(root, "source-link.sqlite");
  const backupDirectory = join(root, "backups");
  const backupLink = join(root, "backup-link");
  mkdirSync(backupDirectory, { mode: 0o700 });
  const source = createFixture(sourcePath, 8);
  source.close();
  symlinkSync(sourcePath, sourceLink);
  symlinkSync(backupDirectory, backupLink);

  try {
    const storage = await loadStorageModule();
    await assert.rejects(
      () => storage.createSqliteBackup({ sourcePath: sourceLink, backupDirectory }),
      /regular file/,
    );
    await assert.rejects(
      () => storage.createSqliteBackup({ sourcePath, backupDirectory: backupLink }),
      /directory/,
    );
    await assert.rejects(
      () => storage.createSqliteBackup({ sourcePath: "relative.sqlite", backupDirectory }),
      /absolute path/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
