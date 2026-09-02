import { basename } from "node:path";
import process from "node:process";

import { verifySqliteBackup } from "./sqlite-storage.mjs";

process.umask(0o077);

const [, , backupPath, manifestPath, restorePath, reportPath, ...extra] =
  process.argv;

try {
  if (!backupPath || !manifestPath || !restorePath || !reportPath || extra.length) {
    throw new Error(
      "Usage: node scripts/verify-sqlite-backup.mjs <backup.sqlite> <manifest.json> <restore.sqlite> <report.json>",
    );
  }
  const result = await verifySqliteBackup({
    backupPath,
    manifestPath,
    restorePath,
    reportPath,
  });
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      backupFile: basename(backupPath),
      restoreFile: basename(result.restorePath),
      reportFile: basename(result.reportPath),
      schemaVersion: result.report.database.schemaVersion,
      sha256: result.report.backup.sha256,
    })}\n`,
  );
} catch (error) {
  process.stderr.write(`SQLite backup verification failed: ${error.message}\n`);
  process.exitCode = 1;
}
