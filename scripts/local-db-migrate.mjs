import { basename } from "node:path";
import process from "node:process";

import {
  checkLocalMigrations,
  runLocalMigrations,
} from "./sqlite-storage.mjs";

process.umask(0o077);

const migrationsDirectory = new URL("../drizzle/", import.meta.url);
const [mode, ...extra] = process.argv.slice(2);

try {
  if (!["--check", "--apply"].includes(mode) || extra.length) {
    throw new Error(
      "Usage: node scripts/local-db-migrate.mjs --check|--apply",
    );
  }

  if (mode === "--check") {
    const result = await checkLocalMigrations({
      sourcePath: process.env.FITNESS_SQLITE_PATH,
      migrationsDirectory,
    });
    process.stdout.write(
      `${JSON.stringify({ ok: true, mode: "check", ...result })}\n`,
    );
  } else {
    const result = await runLocalMigrations({
      sourcePath: process.env.FITNESS_SQLITE_PATH,
      backupDirectory: process.env.FITNESS_BACKUP_DIR,
      migrationsDirectory,
    });
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        mode: "apply",
        migrated: result.migrated,
        fromVersion: result.fromVersion,
        toVersion: result.toVersion,
        appliedVersions: result.appliedVersions,
        backupFile: result.backup ? basename(result.backup.backupPath) : null,
        manifestFile: result.backup ? basename(result.backup.manifestPath) : null,
      })}\n`,
    );
  }
} catch (error) {
  process.stderr.write(`Local SQLite migration failed: ${error.message}\n`);
  process.exitCode = 1;
}
