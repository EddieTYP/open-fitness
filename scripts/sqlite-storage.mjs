import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { backup, DatabaseSync } from "node:sqlite";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

import {
  isSupportedFitnessDatabaseIdentity,
  OPEN_FITNESS_DATABASE_NAME,
  OPEN_FITNESS_DEFAULT_TIMEZONE,
  OPEN_FITNESS_TABLE_NAMES,
} from "../db/schema-identity.mjs";
import {
  FRESH_INSTALL_DEFAULT_APP_LOCALE,
  isAppLocale,
} from "../lib/i18n/locales.ts";
import { isSupportedTimeZone } from "../lib/timezone.mjs";

const BACKUP_FORMAT = "edward-fitness-sqlite-backup";
const BACKUP_FORMAT_VERSION = 1;
const REPORT_FORMAT = "edward-fitness-sqlite-restore-verification";
const REPORT_FORMAT_VERSION = 1;
const SQLITE_BUSY_TIMEOUT_MS = 5000;
const MANIFEST_MAX_BYTES = 1024 * 1024;
const BREAKPOINT = "--> statement-breakpoint";
const FOREIGN_KEYS_PRAGMA = /^\s*PRAGMA\s+foreign_keys\s*=\s*(?:ON|OFF)\s*;?\s*$/i;
const TABLE_INTRODUCED_VERSION = new Map([
  ["training_schedule_events", 8],
  ["training_exercise_selections", 10],
  ["training_blocks", 15],
  ["training_next_course_overrides", 15],
  ["training_planned_sessions", 16],
]);

const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const defaultApplicationVersion = String(packageMetadata.version ?? "unknown");

function inputPath(value, label) {
  const raw = value instanceof URL ? fileURLToPath(value) : value;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(`${label} is required`);
  }
  const trimmed = raw.trim();
  if (!isAbsolute(trimmed)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return resolve(trimmed);
}

function existingRegularFile(value, label) {
  const path = inputPath(value, label);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`${label} must exist and be a regular file`);
  }
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`${label} must exist and be a non-zero regular file`);
  }
  return { path, stat };
}

function existingDirectory(value, label) {
  const path = inputPath(value, label);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`${label} must exist and be a directory`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} must exist and be a directory`);
  }
  return path;
}

function newOutputPath(value, label) {
  const path = inputPath(value, label);
  existingDirectory(dirname(path), `${label} parent`);
  try {
    lstatSync(path);
    throw new Error(`${label} already exists`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return path;
}

function sameFileIdentity(stat, expected) {
  return stat.isFile() && stat.dev === expected.dev && stat.ino === expected.ino;
}

function removeOwnedPath(owned) {
  if (!owned) return;
  try {
    const stat = lstatSync(owned.path);
    if (sameFileIdentity(stat, owned)) unlinkSync(owned.path);
  } catch {
    // Preserve the original failure and never unlink a path we no longer own.
  }
}

function reserveNewFile(path, label) {
  let descriptor;
  try {
    descriptor = openSync(path, "wx", 0o600);
    fchmodSync(descriptor, 0o600);
    const stat = fstatSync(descriptor);
    return { path, descriptor, dev: stat.dev, ino: stat.ino, closed: false };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (error?.code === "EEXIST") {
      throw new Error(`${label} already exists`);
    }
    throw error;
  }
}

function closeReservedFile(reservation) {
  if (!reservation || reservation.closed) return;
  closeSync(reservation.descriptor);
  reservation.closed = true;
}

function writeReservedJson(reservation, value, label) {
  writeFileSync(reservation.descriptor, `${JSON.stringify(value, null, 2)}\n`);
  fsyncSync(reservation.descriptor);
  let publishedStat;
  try {
    publishedStat = lstatSync(reservation.path);
  } catch {
    throw new Error(`${label} changed during publication`);
  }
  if (!sameFileIdentity(publishedStat, reservation)) {
    throw new Error(`${label} changed during publication`);
  }
  closeReservedFile(reservation);
}

function createPrivateTemporaryOutput(parentPath, label) {
  const temporaryDirectory = mkdtempSync(
    join(parentPath, ".edward-fitness-storage-"),
  );
  chmodSync(temporaryDirectory, 0o700);
  return {
    directory: temporaryDirectory,
    path: join(temporaryDirectory, `${label}.sqlite`),
  };
}

function publishFileNoClobber(sourcePath, outputPath, label) {
  try {
    linkSync(sourcePath, outputPath);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`${label} already exists`);
    }
    throw error;
  }
  const sourceStat = lstatSync(sourcePath);
  const outputStat = lstatSync(outputPath);
  if (!sameFileIdentity(outputStat, sourceStat)) {
    throw new Error(`${label} changed during publication`);
  }
  return { path: outputPath, dev: outputStat.dev, ino: outputStat.ino };
}

function syncFile(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function sortedRecord(record) {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function tableNamesForSchemaVersion(schemaVersion) {
  return OPEN_FITNESS_TABLE_NAMES.filter(
    (tableName) =>
      schemaVersion >= (TABLE_INTRODUCED_VERSION.get(tableName) ?? 0),
  );
}

function canonicalMetadata(database) {
  const tableNames = new Set(
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row.name)),
  );
  if (!tableNames.has("schema_metadata")) {
    throw new Error("SQLite database does not match the Open Fitness table schema");
  }

  const rows = database
    .prepare(
      `SELECT
        schema_version AS schemaVersion,
        database_name AS databaseName,
        canonical_master AS canonicalMaster,
        timezone
      FROM schema_metadata`,
    )
    .all();
  if (rows.length !== 1) {
    throw new Error("SQLite database has invalid schema metadata");
  }
  const metadata = rows[0];
  if (
    typeof metadata.schemaVersion !== "number" ||
    !Number.isSafeInteger(metadata.schemaVersion) ||
    metadata.schemaVersion < 0 ||
    metadata.canonicalMaster !== 1 ||
    !isSupportedFitnessDatabaseIdentity(
      metadata.databaseName,
      metadata.timezone,
    )
  ) {
    throw new Error("SQLite database has invalid schema metadata");
  }
  if (
    tableNamesForSchemaVersion(metadata.schemaVersion).some(
      (name) => !tableNames.has(name),
    )
  ) {
    throw new Error("SQLite database does not match the Open Fitness table schema");
  }
  return {
    schemaVersion: metadata.schemaVersion,
    databaseName: metadata.databaseName,
    canonicalMaster: metadata.canonicalMaster,
    timezone: metadata.timezone,
  };
}

function normalizeSchemaSql(value) {
  if (typeof value !== "string") return null;
  let output = "";
  let pendingWhitespace = false;
  let state = "normal";

  const flushWhitespace = () => {
    if (pendingWhitespace && output.length > 0) output += " ";
    pendingWhitespace = false;
  };

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const next = value[index + 1];

    if (state === "normal") {
      if (/\s/.test(character)) {
        pendingWhitespace = true;
        continue;
      }
      flushWhitespace();
      output += character;
      if (character === "'" || character === '"' || character === "`") {
        state = character;
      } else if (character === "[") {
        state = "]";
      } else if (character === "-" && next === "-") {
        output += next;
        index += 1;
        state = "line-comment";
      } else if (character === "/" && next === "*") {
        output += next;
        index += 1;
        state = "block-comment";
      }
      continue;
    }

    output += character;
    if (state === "line-comment") {
      if (character === "\n") state = "normal";
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        output += next;
        index += 1;
        state = "normal";
      }
      continue;
    }
    if (character !== state) continue;
    if (next === state && state !== "]") {
      output += next;
      index += 1;
    } else {
      state = "normal";
    }
  }
  return output;
}

export function logicalValue(value) {
  if (value === null) return ["null"];
  if (typeof value === "bigint") {
    if (
      value >= BigInt(Number.MIN_SAFE_INTEGER) &&
      value <= BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      return ["number", value.toString()];
    }
    return ["bigint", value.toString()];
  }
  if (typeof value === "number") return ["number", String(value)];
  if (typeof value === "string") return ["string", value];
  if (value instanceof Uint8Array) return ["blob", Buffer.from(value).toString("hex")];
  fail("Unsupported SQLite value in logical digest");
}

export function logicalSqliteDigest(path) {
  const databasePath = existingRegularFile(path, "Logical digest database").path;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const digest = createHash("sha256");
  try {
    const metadata = canonicalMetadata(database);
    database.exec("BEGIN");
    for (const table of tableNamesForSchemaVersion(metadata.schemaVersion).sort()) {
      const columns = database
        .prepare(`PRAGMA table_xinfo(${quoteIdentifier(table)})`)
        .all()
        .filter((column) => Number(column.hidden) === 0)
        .sort((left, right) => Number(left.cid) - Number(right.cid))
        .map((column) => String(column.name));
      const rowStatement = database.prepare(
        `SELECT ${columns.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(table)}`,
      );
      rowStatement.setReadBigInts(true);
      const rows = rowStatement
        .all()
        .map((row) =>
          createHash("sha256")
            .update(JSON.stringify(columns.map((column) => logicalValue(row[column]))))
            .digest("hex"),
        )
        .sort();
      digest.update(
        `${JSON.stringify({ table, columns, rows })}\n`,
        "utf8",
      );
    }
    database.exec("COMMIT");
    return digest.digest("hex");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the digest failure.
    }
    throw error;
  } finally {
    database.close();
  }
}

function databaseSchemaIdentity(database) {
  const catalog = database
    .prepare(
      `SELECT type, name, tbl_name AS tableName, sql
       FROM sqlite_master
       WHERE type IN ('table', 'index', 'view', 'trigger')
         AND name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .all()
    .map((row) => ({
      type: String(row.type),
      name: String(row.name),
      tableName: String(row.tableName),
      sql: normalizeSchemaSql(row.sql),
    }));
  const tableNames = catalog
    .filter((entry) => entry.type === "table")
    .map((entry) => entry.name)
    .sort();
  const tableList = new Map(
    database
      .prepare("PRAGMA table_list")
      .all()
      .filter((row) => !String(row.name).startsWith("sqlite_"))
      .map((row) => [String(row.name), row]),
  );
  const tables = tableNames.map((tableName) => {
    const table = tableList.get(tableName);
    const columns = database
      .prepare(`PRAGMA table_xinfo(${quoteIdentifier(tableName)})`)
      .all()
      .map((row) => ({
        cid: Number(row.cid),
        name: String(row.name),
        type: String(row.type),
        notNull: Number(row.notnull),
        defaultValue: row.dflt_value === null ? null : String(row.dflt_value),
        primaryKey: Number(row.pk),
        hidden: Number(row.hidden),
      }));
    const foreignKeys = database
      .prepare(`PRAGMA foreign_key_list(${quoteIdentifier(tableName)})`)
      .all()
      .map((row) => ({
        id: Number(row.id),
        sequence: Number(row.seq),
        table: String(row.table),
        from: String(row.from),
        to: row.to === null ? null : String(row.to),
        onUpdate: String(row.on_update),
        onDelete: String(row.on_delete),
        match: String(row.match),
      }))
      .sort((left, right) => left.id - right.id || left.sequence - right.sequence);
    const indexes = database
      .prepare(`PRAGMA index_list(${quoteIdentifier(tableName)})`)
      .all()
      .map((row) => {
        const indexName = String(row.name);
        return {
          name: indexName,
          unique: Number(row.unique),
          origin: String(row.origin),
          partial: Number(row.partial),
          columns: database
            .prepare(`PRAGMA index_xinfo(${quoteIdentifier(indexName)})`)
            .all()
            .map((column) => ({
              sequence: Number(column.seqno),
              cid: Number(column.cid),
              name: column.name === null ? null : String(column.name),
              descending: Number(column.desc),
              collation: column.coll === null ? null : String(column.coll),
              key: Number(column.key),
            })),
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
    return {
      name: tableName,
      withoutRowid: Number(table?.wr ?? 0),
      strict: Number(table?.strict ?? 0),
      columns,
      foreignKeys,
      indexes,
    };
  });
  return { catalog, tables };
}

function schemaIdentitySha256(identity) {
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function schemaMatchesIdentity(database, expectedIdentity) {
  if (!expectedIdentity || typeof expectedIdentity !== "object") return false;
  return JSON.stringify(databaseSchemaIdentity(database)) === JSON.stringify(expectedIdentity);
}

function validateSchemaIdentity(database, expectedIdentity) {
  if (!schemaMatchesIdentity(database, expectedIdentity)) {
    throw new Error("SQLite database does not match its declared schema version");
  }
}

function inspectOpenDatabase(
  database,
  expectedSchemaIdentity,
  rowCountSchemaVersion,
) {
  const integrityRows = database.prepare("PRAGMA integrity_check").all();
  if (
    integrityRows.length !== 1 ||
    String(integrityRows[0].integrity_check ?? "").toLowerCase() !== "ok"
  ) {
    throw new Error("SQLite database failed integrity_check");
  }
  const foreignKeyRows = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyRows.length !== 0) {
    throw new Error("SQLite database failed foreign_key_check");
  }

  const metadata = canonicalMetadata(database);
  const schemaIdentity = databaseSchemaIdentity(database);
  if (
    expectedSchemaIdentity &&
    JSON.stringify(schemaIdentity) !== JSON.stringify(expectedSchemaIdentity)
  ) {
    throw new Error("SQLite database does not match its declared schema version");
  }

  const rowCounts = sortedRecord(
    Object.fromEntries(
      tableNamesForSchemaVersion(rowCountSchemaVersion ?? metadata.schemaVersion).map((tableName) => [
        tableName,
        Number(
          database
            .prepare(`SELECT COUNT(*) AS value FROM ${quoteIdentifier(tableName)}`)
            .get().value,
        ),
      ]),
    ),
  );
  const views = new Set(
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'view'")
      .all()
      .map((row) => String(row.name)),
  );
  const representativeQueries = {
    profileRows: rowCounts.profile,
    dataQualityCheckRows: views.has("v_data_quality_checks")
      ? Number(
          database
            .prepare("SELECT COUNT(*) AS value FROM v_data_quality_checks")
            .get().value,
        )
      : null,
  };

  return {
    ...metadata,
    integrity: "ok",
    foreignKeyViolations: 0,
    schemaIdentitySha256: schemaIdentitySha256(schemaIdentity),
    rowCounts,
    representativeQueries,
  };
}

export function inspectSqliteDatabase(pathValue, options = {}) {
  const { path } = existingRegularFile(pathValue, "SQLite database");
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return inspectOpenDatabase(
      database,
      options.expectedSchemaIdentity,
      options.rowCountSchemaVersion,
    );
  } finally {
    database.close();
  }
}

function sameDatabaseSummary(actual, expected) {
  return (
    actual.schemaVersion === expected.schemaVersion &&
    actual.databaseName === expected.databaseName &&
    actual.canonicalMaster === expected.canonicalMaster &&
    actual.timezone === expected.timezone &&
    actual.integrity === expected.integrity &&
    actual.foreignKeyViolations === expected.foreignKeyViolations &&
    actual.schemaIdentitySha256 === expected.schemaIdentitySha256 &&
    JSON.stringify(sortedRecord(actual.rowCounts)) ===
      JSON.stringify(sortedRecord(expected.rowCounts)) &&
    JSON.stringify(actual.representativeQueries) ===
      JSON.stringify(expected.representativeQueries)
  );
}

function timestampForFilename(now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("Backup timestamp must be a valid Date");
  }
  return now.toISOString().replaceAll("-", "").replaceAll(":", "").replace(".", "");
}

function safeLabel(value) {
  const label = value ?? "manual";
  if (typeof label !== "string" || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(label)) {
    throw new Error("Backup label is invalid");
  }
  return label;
}

export async function createSqliteBackup({
  sourcePath: sourceValue,
  backupDirectory: directoryValue,
  backupPath: explicitBackupValue,
  manifestPath: explicitManifestValue,
  label: labelValue = "manual",
  now = new Date(),
  applicationVersion = defaultApplicationVersion,
}) {
  const { path: sourcePath } = existingRegularFile(sourceValue, "SQLite source");
  const sourceSummary = inspectSqliteDatabase(sourcePath);
  const label = safeLabel(labelValue);
  const usesExplicitOutputs =
    explicitBackupValue !== undefined || explicitManifestValue !== undefined;
  if (
    usesExplicitOutputs &&
    (explicitBackupValue === undefined || explicitManifestValue === undefined)
  ) {
    throw new Error("Explicit backup and manifest paths must be provided together");
  }
  let backupPath;
  let manifestPath;
  if (usesExplicitOutputs) {
    backupPath = newOutputPath(explicitBackupValue, "Backup output");
    manifestPath = newOutputPath(explicitManifestValue, "Backup manifest");
  } else {
    const backupDirectory = existingDirectory(directoryValue, "Backup directory");
    const timestamp = timestampForFilename(now);
    const fileStem = `edward-fitness-${timestamp}-v${sourceSummary.schemaVersion}-${label}`;
    backupPath = newOutputPath(
      join(backupDirectory, `${fileStem}.sqlite`),
      "Backup output",
    );
    manifestPath = newOutputPath(
      join(backupDirectory, `${fileStem}.manifest.json`),
      "Backup manifest",
    );
  }
  if (
    new Set([sourcePath, backupPath, manifestPath]).size !== 3
  ) {
    throw new Error("SQLite source and backup outputs must be distinct");
  }

  let backupOwned;
  let manifestReservation;
  let temporaryOutput;
  try {
    manifestReservation = reserveNewFile(manifestPath, "Backup manifest");
    temporaryOutput = createPrivateTemporaryOutput(
      dirname(backupPath),
      "backup",
    );

    const source = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      await backup(source, temporaryOutput.path);
    } finally {
      source.close();
    }
    chmodSync(temporaryOutput.path, 0o600);
    syncFile(temporaryOutput.path);

    const database = inspectSqliteDatabase(temporaryOutput.path);
    const manifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: now.toISOString(),
      application: {
        name: "edward-fitness",
        version: String(applicationVersion),
      },
      backup: {
        file: basename(backupPath),
        sizeBytes: lstatSync(temporaryOutput.path).size,
        sha256: sha256File(temporaryOutput.path),
      },
      database,
    };
    validateBackupManifest(manifest, backupPath);
    backupOwned = publishFileNoClobber(
      temporaryOutput.path,
      backupPath,
      "Backup output",
    );
    writeReservedJson(manifestReservation, manifest, "Backup manifest");
    rmSync(temporaryOutput.directory, { recursive: true, force: true });
    return { backupPath, manifestPath, manifest };
  } catch (error) {
    closeReservedFile(manifestReservation);
    removeOwnedPath(backupOwned);
    removeOwnedPath(manifestReservation);
    if (temporaryOutput) {
      rmSync(temporaryOutput.directory, { recursive: true, force: true });
    }
    throw error;
  }
}

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function isCanonicalTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isSafeManifestFilename(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    basename(value) === value &&
    value !== "." &&
    value !== ".."
  );
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateBackupManifest(manifest, expectedBackupPath) {
  const databaseKeys = [
    "schemaVersion",
    "databaseName",
    "canonicalMaster",
    "timezone",
    "integrity",
    "foreignKeyViolations",
    "schemaIdentitySha256",
    "rowCounts",
    "representativeQueries",
  ];
  if (
    !hasExactKeys(manifest, [
      "format",
      "formatVersion",
      "createdAt",
      "application",
      "backup",
      "database",
    ]) ||
    manifest.format !== BACKUP_FORMAT ||
    manifest.formatVersion !== BACKUP_FORMAT_VERSION ||
    !isCanonicalTimestamp(manifest.createdAt) ||
    !hasExactKeys(manifest.application, ["name", "version"]) ||
    manifest.application.name !== "edward-fitness" ||
    typeof manifest.application.version !== "string" ||
    manifest.application.version.length === 0 ||
    manifest.application.version.length > 128 ||
    !hasExactKeys(manifest.backup, ["file", "sizeBytes", "sha256"]) ||
    !isSafeManifestFilename(manifest.backup.file) ||
    manifest.backup.file !== basename(expectedBackupPath) ||
    !Number.isSafeInteger(manifest.backup.sizeBytes) ||
    manifest.backup.sizeBytes <= 0 ||
    typeof manifest.backup.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.backup.sha256) ||
    !hasExactKeys(manifest.database, databaseKeys) ||
    !isNonNegativeSafeInteger(manifest.database.schemaVersion) ||
    manifest.database.canonicalMaster !== 1 ||
    !isSupportedFitnessDatabaseIdentity(
      manifest.database.databaseName,
      manifest.database.timezone,
    ) ||
    manifest.database.integrity !== "ok" ||
    manifest.database.foreignKeyViolations !== 0 ||
    typeof manifest.database.schemaIdentitySha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.database.schemaIdentitySha256) ||
    !hasExactKeys(
      manifest.database.rowCounts,
      tableNamesForSchemaVersion(manifest.database.schemaVersion),
    ) ||
    Object.values(manifest.database.rowCounts).some(
      (value) => !isNonNegativeSafeInteger(value),
    ) ||
    !hasExactKeys(manifest.database.representativeQueries, [
      "profileRows",
      "dataQualityCheckRows",
    ]) ||
    !isNonNegativeSafeInteger(
      manifest.database.representativeQueries.profileRows,
    ) ||
    !(
      manifest.database.representativeQueries.dataQualityCheckRows === null ||
      isNonNegativeSafeInteger(
        manifest.database.representativeQueries.dataQualityCheckRows,
      )
    )
  ) {
    throw new Error("Backup manifest is unsupported or incomplete");
  }
}

function readBackupManifest(pathValue, expectedBackupPath) {
  const { path, stat } = existingRegularFile(pathValue, "Backup manifest");
  if (stat.size > MANIFEST_MAX_BYTES) {
    throw new Error("Backup manifest is too large");
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Backup manifest is malformed");
  }
  validateBackupManifest(manifest, expectedBackupPath);
  return { path, manifest };
}

export async function verifySqliteBackup({
  backupPath: backupValue,
  manifestPath: manifestValue,
  restorePath: restoreValue,
  reportPath: reportValue,
  now = new Date(),
}) {
  const { path: backupPath } = existingRegularFile(backupValue, "SQLite backup");
  const { manifest } = readBackupManifest(manifestValue, backupPath);
  const restorePath = newOutputPath(restoreValue, "Restore output");
  const reportPath = newOutputPath(reportValue, "Verification report");
  if (
    new Set([backupPath, restorePath, reportPath, inputPath(manifestValue, "Backup manifest")])
      .size !== 4
  ) {
    throw new Error("Backup, manifest, restore, and report paths must be distinct");
  }
  const backupSha256 = sha256File(backupPath);
  if (backupSha256 !== manifest.backup.sha256) {
    throw new Error("Backup SHA-256 does not match the manifest");
  }
  if (lstatSync(backupPath).size !== manifest.backup.sizeBytes) {
    throw new Error("Backup size does not match the manifest");
  }
  const backupDatabase = inspectSqliteDatabase(backupPath);
  if (!sameDatabaseSummary(backupDatabase, manifest.database)) {
    throw new Error("Backup database does not match the manifest");
  }

  let restoreOwned;
  let reportReservation;
  let temporaryOutput;
  try {
    reportReservation = reserveNewFile(reportPath, "Verification report");
    temporaryOutput = createPrivateTemporaryOutput(
      dirname(restorePath),
      "restore",
    );

    const source = new DatabaseSync(backupPath, { readOnly: true });
    try {
      await backup(source, temporaryOutput.path);
    } finally {
      source.close();
    }
    chmodSync(temporaryOutput.path, 0o600);
    syncFile(temporaryOutput.path);
    const restoredDatabase = inspectSqliteDatabase(temporaryOutput.path);
    if (!sameDatabaseSummary(restoredDatabase, manifest.database)) {
      throw new Error("Restored database does not match the backup manifest");
    }

    const report = {
      format: REPORT_FORMAT,
      formatVersion: REPORT_FORMAT_VERSION,
      verifiedAt: now.toISOString(),
      backup: {
        file: basename(backupPath),
        manifestFile: basename(inputPath(manifestValue, "Backup manifest")),
        sha256: backupSha256,
      },
      restore: {
        file: basename(restorePath),
        sha256: sha256File(temporaryOutput.path),
      },
      database: restoredDatabase,
      passed: true,
    };
    restoreOwned = publishFileNoClobber(
      temporaryOutput.path,
      restorePath,
      "Restore output",
    );
    writeReservedJson(reportReservation, report, "Verification report");
    rmSync(temporaryOutput.directory, { recursive: true, force: true });
    return { restorePath, reportPath, report };
  } catch (error) {
    closeReservedFile(reportReservation);
    removeOwnedPath(restoreOwned);
    removeOwnedPath(reportReservation);
    if (temporaryOutput) {
      rmSync(temporaryOutput.directory, { recursive: true, force: true });
    }
    throw error;
  }
}

function parseJsonFile(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${label} is malformed`);
  }
}

export function loadMigrationPlan(migrationsValue) {
  const migrationsDirectory = existingDirectory(
    migrationsValue,
    "Migrations directory",
  );
  const journalPath = join(migrationsDirectory, "meta", "_journal.json");
  existingRegularFile(journalPath, "Migration journal");
  const journal = parseJsonFile(journalPath, "Migration journal");
  if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
    throw new Error("Migration journal has no entries");
  }

  const schemaDatabase = new DatabaseSync(":memory:");
  let entries;
  try {
    entries = journal.entries.map((entry, position) => {
      if (
        !Number.isSafeInteger(entry?.idx) ||
        entry.idx !== position ||
        typeof entry.tag !== "string" ||
        !entry.tag.startsWith(`${String(entry.idx).padStart(4, "0")}_`)
      ) {
        throw new Error("Migration journal is not contiguous or well formed");
      }
      const sqlPath = join(migrationsDirectory, `${entry.tag}.sql`);
      const snapshotPath = join(
        migrationsDirectory,
        "meta",
        `${String(entry.idx).padStart(4, "0")}_snapshot.json`,
      );
      existingRegularFile(sqlPath, "Migration SQL");
      existingRegularFile(snapshotPath, "Migration snapshot");
      const sql = readFileSync(sqlPath, "utf8");
      const snapshot = parseJsonFile(snapshotPath, "Migration snapshot");
      if (!snapshot?.tables || typeof snapshot.tables !== "object") {
        throw new Error("Migration snapshot is malformed");
      }
      for (const statement of migrationStatements(sql)) {
        schemaDatabase.exec(statement);
      }
      return {
        idx: entry.idx,
        tag: entry.tag,
        sql,
        snapshot,
        schemaIdentity: databaseSchemaIdentity(schemaDatabase),
      };
    });
  } finally {
    schemaDatabase.close();
  }

  return {
    latestVersion: entries.at(-1).idx,
    entries,
  };
}

function initializationText(value, label, maximumLength) {
  if (typeof value !== "string") {
    throw new Error(`${label} is required`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw new Error(`${label} must contain 1 to ${maximumLength} characters`);
  }
  return normalized;
}

export function initializeLocalDatabase({
  outputPath: outputValue,
  migrationsDirectory,
  profileId: profileIdValue = "owner",
  primaryGoal: primaryGoalValue,
  trainingCycle: trainingCycleValue,
  timezone: timezoneValue = OPEN_FITNESS_DEFAULT_TIMEZONE,
  preferredLocale: preferredLocaleValue = FRESH_INSTALL_DEFAULT_APP_LOCALE,
  heightCm: heightCmValue,
  ownerEmail: ownerEmailValue,
  now = new Date(),
}) {
  const outputPath = newOutputPath(outputValue, "SQLite output");
  const plan = loadMigrationPlan(migrationsDirectory);
  const profileId = initializationText(profileIdValue, "Profile ID", 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profileId)) {
    throw new Error(
      "Profile ID may contain only letters, numbers, dot, underscore, and hyphen",
    );
  }
  const primaryGoal = initializationText(
    primaryGoalValue,
    "Primary goal",
    512,
  );
  const trainingCycle = initializationText(
    trainingCycleValue,
    "Training cycle",
    512,
  );
  const timezone = initializationText(timezoneValue, "Timezone", 255);
  if (!isSupportedTimeZone(timezone)) {
    throw new Error("Timezone must be a valid IANA timezone");
  }
  const preferredLocale = initializationText(
    preferredLocaleValue,
    "Preferred locale",
    32,
  );
  if (!isAppLocale(preferredLocale)) {
    throw new Error("Preferred locale must be one of en, zh-HK, zh-TW, zh-CN");
  }
  const heightCm =
    heightCmValue === undefined || heightCmValue === null
      ? null
      : Number(heightCmValue);
  if (
    heightCm !== null &&
    (!Number.isFinite(heightCm) || heightCm < 50 || heightCm > 300)
  ) {
    throw new Error("Height must be between 50 and 300 cm");
  }
  const ownerEmail =
    ownerEmailValue === undefined || ownerEmailValue === null
      ? null
      : initializationText(ownerEmailValue, "Owner email", 320);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("Initialization timestamp must be a valid Date");
  }

  let outputReservation;
  let database;
  try {
    outputReservation = reserveNewFile(outputPath, "SQLite output");
    closeReservedFile(outputReservation);
    database = new DatabaseSync(outputPath);
    database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec("BEGIN IMMEDIATE");

    for (const entry of plan.entries) {
      for (const statement of migrationStatements(entry.sql)) {
        database.exec(statement);
      }
    }

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
      .run(
        plan.latestVersion,
        OPEN_FITNESS_DATABASE_NAME,
        timezone,
      );
    database
      .prepare(
        `INSERT INTO profile (
          profile_id,
          primary_goal,
          training_cycle,
          height_cm,
          timezone,
          preferred_locale,
          owner_email,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        profileId,
        primaryGoal,
        trainingCycle,
        heightCm,
        timezone,
        preferredLocale,
        ownerEmail,
        now.toISOString(),
      );
    database
      .prepare(
        `INSERT INTO training_blocks (
          block_id,
          profile_id,
          goal_type,
          primary_goal,
          training_cycle_snapshot,
          starts_on,
          change_reason,
          created_by
        ) VALUES (?, ?, 'general', ?, ?, ?, 'Initial setup', 'system')`,
      )
      .run(
        `TRAINING-BLOCK|${profileId}|initial`,
        profileId,
        primaryGoal,
        JSON.stringify({ legacyCycle: trainingCycle }),
        now.toISOString().slice(0, 10),
      );

    validateSchemaIdentity(database, plan.entries.at(-1).schemaIdentity);
    if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
      throw new Error("Initialized database failed foreign_key_check");
    }
    database.exec("COMMIT");
    database.close();
    database = undefined;
    chmodSync(outputPath, 0o600);
    syncFile(outputPath);

    const summary = inspectSqliteDatabase(outputPath, {
      expectedSchemaIdentity: plan.entries.at(-1).schemaIdentity,
    });
    return { outputPath, profileId, database: summary };
  } catch (error) {
    if (database) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the initialization failure.
      }
      database.close();
    }
    removeOwnedPath(outputReservation);
    throw error;
  }
}

function migrationStatements(sql) {
  return sql
    .split(BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "" && !FOREIGN_KEYS_PRAGMA.test(statement));
}

export async function checkLocalMigrations({
  sourcePath,
  migrationsDirectory,
}) {
  const plan = loadMigrationPlan(migrationsDirectory);
  const database = inspectSqliteDatabase(sourcePath);
  if (database.schemaVersion > plan.latestVersion) {
    throw new Error("SQLite schema version is newer than this application build");
  }
  const currentEntry = plan.entries[database.schemaVersion];
  if (!currentEntry) {
    throw new Error("SQLite schema version is not represented by the migration journal");
  }
  inspectSqliteDatabase(sourcePath, {
    expectedSchemaIdentity: currentEntry.schemaIdentity,
  });
  return {
    currentVersion: database.schemaVersion,
    targetVersion: plan.latestVersion,
    pendingVersions: plan.entries
      .filter((entry) => entry.idx > database.schemaVersion)
      .map((entry) => entry.idx),
  };
}

export async function runLocalMigrations({
  sourcePath: sourceValue,
  backupDirectory: backupDirectoryValue,
  migrationsDirectory,
  now = new Date(),
  applicationVersion = defaultApplicationVersion,
}) {
  const { path: sourcePath } = existingRegularFile(sourceValue, "SQLite source");
  const plan = loadMigrationPlan(migrationsDirectory);
  const check = await checkLocalMigrations({ sourcePath, migrationsDirectory });
  if (check.pendingVersions.length === 0) {
    return {
      migrated: false,
      fromVersion: check.currentVersion,
      toVersion: check.targetVersion,
      appliedVersions: [],
      backup: null,
    };
  }

  const backupDirectory = existingDirectory(
    backupDirectoryValue,
    "Backup directory",
  );
  const backupResult = await createSqliteBackup({
    sourcePath,
    backupDirectory,
    label: `pre-migration-v${check.currentVersion}-to-v${check.targetVersion}`,
    now,
    applicationVersion,
  });

  const database = new DatabaseSync(sourcePath);
  let transactionOpen = false;
  try {
    database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec("BEGIN IMMEDIATE");
    transactionOpen = true;

    for (const version of check.pendingVersions) {
      const entry = plan.entries[version];
      for (const statement of migrationStatements(entry.sql)) {
        database.exec(statement);
      }
      const update = database
        .prepare("UPDATE schema_metadata SET schema_version = ?")
        .run(version);
      if (update.changes !== 1) {
        throw new Error("Migration could not advance schema metadata");
      }
      const metadata = canonicalMetadata(database);
      if (metadata.schemaVersion !== version) {
        throw new Error("Migration schema metadata did not advance correctly");
      }
      validateSchemaIdentity(database, entry.schemaIdentity);
    }

    if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
      throw new Error("Migrated database failed foreign_key_check");
    }
    const integrityRows = database.prepare("PRAGMA integrity_check").all();
    if (
      integrityRows.length !== 1 ||
      String(integrityRows[0].integrity_check ?? "").toLowerCase() !== "ok"
    ) {
      throw new Error("Migrated database failed integrity_check");
    }
    database.exec("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the migration failure; the pre-migration backup remains available.
      }
    }
    throw error;
  } finally {
    try {
      database.exec("PRAGMA foreign_keys = ON");
    } finally {
      database.close();
    }
  }

  const finalEntry = plan.entries[plan.latestVersion];
  const finalDatabase = inspectSqliteDatabase(sourcePath, {
    expectedSchemaIdentity: finalEntry.schemaIdentity,
  });
  if (finalDatabase.schemaVersion !== plan.latestVersion) {
    throw new Error("Migrated database did not reach the target schema version");
  }

  return {
    migrated: true,
    fromVersion: check.currentVersion,
    toVersion: plan.latestVersion,
    appliedVersions: check.pendingVersions,
    backup: backupResult,
  };
}
