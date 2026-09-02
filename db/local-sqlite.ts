import { lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import {
  isSupportedFitnessDatabaseIdentity,
  OPEN_FITNESS_COLUMN_SENTINELS,
  OPEN_FITNESS_TABLE_NAMES,
} from "./schema-identity.mjs";

const SQLITE_BUSY_TIMEOUT_MS = 5000;

type RuntimeStatus = {
  adapter: "libsql-local";
  busyTimeoutMs: number;
  journalMode: "WAL";
  schemaVersion: number;
};

function createDrizzleDb(client: Client) {
  return drizzle(client);
}

type LocalDbState = {
  path: string;
  client: Client;
  db: ReturnType<typeof createDrizzleDb>;
  status: RuntimeStatus;
};

let localDbState: LocalDbState | null = null;

function getConfiguredPath(): string {
  const rawPath = process.env.FITNESS_SQLITE_PATH;
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new Error("FITNESS_SQLITE_PATH is required");
  }

  const trimmedPath = rawPath.trim();
  if (!isAbsolute(trimmedPath)) {
    throw new Error("FITNESS_SQLITE_PATH must be an absolute path");
  }

  const normalizedPath = resolve(trimmedPath);
  let fileStat;
  try {
    fileStat = lstatSync(normalizedPath);
  } catch {
    throw new Error("FITNESS_SQLITE_PATH must exist and be a regular file");
  }
  if (!fileStat.isFile()) {
    throw new Error("FITNESS_SQLITE_PATH must be a regular file");
  }
  if (fileStat.size === 0) {
    throw new Error("FITNESS_SQLITE_PATH must not be a zero-length file");
  }

  return normalizedPath;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function validateFitnessSchema(database: DatabaseSync): number {
  const tableNames = new Set(
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row.name)),
  );

  if (!tableNames.has("schema_metadata")) {
    throw new Error(
      "Configured SQLite database is missing the Open Fitness schema_metadata table",
    );
  }
  if (OPEN_FITNESS_TABLE_NAMES.some((name) => !tableNames.has(name))) {
    throw new Error(
      "Configured SQLite database does not match the Open Fitness table schema",
    );
  }

  for (const [tableName, expectedColumns] of Object.entries(
    OPEN_FITNESS_COLUMN_SENTINELS,
  )) {
    const actualColumns = new Set(
      database
        .prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
        .all()
        .map((row) => String(row.name)),
    );
    if (expectedColumns.some((name) => !actualColumns.has(name))) {
      throw new Error(
        "Configured SQLite database does not match the Open Fitness column schema",
      );
    }
  }

  const schemaMetadataRows = database
    .prepare(
      `SELECT
        schema_version AS schemaVersion,
        database_name AS databaseName,
        canonical_master AS canonicalMaster,
        timezone
      FROM schema_metadata`,
    )
    .all();
  if (schemaMetadataRows.length !== 1) {
    throw new Error("Configured SQLite database has invalid schema metadata");
  }

  const metadata = schemaMetadataRows[0];
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
    throw new Error("Configured SQLite database has invalid schema metadata");
  }

  return metadata.schemaVersion;
}

function prepareSqliteFile(path: string): RuntimeStatus {
  const database = new DatabaseSync(path);
  try {
    const integrityRow = database.prepare("PRAGMA integrity_check").get();
    const integrity = String(
      integrityRow?.integrity_check ?? "",
    ).toLowerCase();
    if (integrity !== "ok") {
      throw new Error("Configured SQLite database failed integrity_check");
    }
    const schemaVersion = validateFitnessSchema(database);
    const journalRow = database.prepare("PRAGMA journal_mode = WAL").get();
    const journalMode = String(journalRow?.journal_mode ?? "").toUpperCase();
    if (journalMode !== "WAL") {
      throw new Error("WAL mode was not enabled");
    }
    return {
      adapter: "libsql-local",
      busyTimeoutMs: SQLITE_BUSY_TIMEOUT_MS,
      journalMode: "WAL",
      schemaVersion,
    };
  } finally {
    database.close();
  }
}

function createState(path: string): LocalDbState {
  const status = prepareSqliteFile(path);
  const client = createClient({
    url: pathToFileURL(path).href,
    intMode: "number",
    timeout: SQLITE_BUSY_TIMEOUT_MS,
  });
  return {
    path,
    client,
    db: createDrizzleDb(client),
    status,
  };
}

function getLocalDbState(): LocalDbState {
  const path = getConfiguredPath();
  if (localDbState === null) {
    localDbState = createState(path);
  } else if (localDbState.path !== path) {
    throw new Error("Cannot switch FITNESS_SQLITE_PATH while a local DB is open");
  }
  return localDbState;
}

export function getLocalClient(): Client {
  return getLocalDbState().client;
}

export function getLocalDb() {
  return getLocalDbState().db;
}

export function getLocalDbRuntimeStatus(): RuntimeStatus | null {
  return localDbState ? { ...localDbState.status } : null;
}

export async function closeLocalDbForTests() {
  if (!localDbState) return;
  const state = localDbState;
  localDbState = null;
  state.client.close();
}
