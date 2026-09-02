import { basename } from "node:path";
import process from "node:process";

import { createSqliteBackup } from "./sqlite-storage.mjs";

process.umask(0o077);

try {
  const result = await createSqliteBackup({
    sourcePath: process.env.FITNESS_SQLITE_PATH,
    backupDirectory: process.env.FITNESS_BACKUP_DIR,
    label: "manual",
  });
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      backupFile: basename(result.backupPath),
      manifestFile: basename(result.manifestPath),
      schemaVersion: result.manifest.database.schemaVersion,
      sha256: result.manifest.backup.sha256,
    })}\n`,
  );
} catch (error) {
  process.stderr.write(`SQLite backup failed: ${error.message}\n`);
  process.exitCode = 1;
}
