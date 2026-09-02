#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import { inspectSqliteDatabase } from "./sqlite-storage.mjs";

const MAX_REPORT_BYTES = 1_000_000;

function fail(message) {
  throw new Error(message);
}

function strictFile(value, label) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    fail(`${label} must be an absolute path`);
  }
  const path = resolve(value);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail(`${label} must exist as a regular file`);
  }
  if (!stat.isFile() || stat.size === 0) {
    fail(`${label} must exist as a non-empty regular file`);
  }
  return { path, stat };
}

function newRollbackPath(value, directory) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    fail("Rollback path must be absolute");
  }
  const path = resolve(value);
  if (dirname(path) !== directory) {
    fail("Rollback path must share the active database directory");
  }
  try {
    lstatSync(path);
    fail("Rollback path must not already exist");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return path;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readVerificationReport(path) {
  const { path: reportPath, stat } = strictFile(path, "Verification report");
  if (stat.size > MAX_REPORT_BYTES) fail("Verification report is too large");
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    fail("Verification report is invalid JSON");
  }
  if (
    report?.format !== "edward-fitness-sqlite-restore-verification" ||
    report?.formatVersion !== 1 ||
    report?.passed !== true ||
    !report.restore ||
    !report.database
  ) {
    fail("Verification report is not a successful restore report");
  }
  return report;
}

function summariesMatch(summary, expected) {
  return (
    summary.schemaVersion === expected.schemaVersion &&
    summary.databaseName === expected.databaseName &&
    summary.canonicalMaster === expected.canonicalMaster &&
    summary.timezone === expected.timezone &&
    summary.integrity === expected.integrity &&
    summary.foreignKeyViolations === expected.foreignKeyViolations &&
    summary.schemaIdentitySha256 === expected.schemaIdentitySha256 &&
    JSON.stringify(summary.rowCounts) === JSON.stringify(expected.rowCounts) &&
    JSON.stringify(summary.representativeQueries) ===
      JSON.stringify(expected.representativeQueries)
  );
}

function assertNoSidecars(path, label) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      lstatSync(`${path}${suffix}`);
      fail(`${label} has an active SQLite sidecar`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function checkpointStoppedWal(path) {
  for (const suffix of ["-wal", "-shm"]) {
    try {
      const stat = lstatSync(`${path}${suffix}`);
      if (!stat.isFile()) fail("Active SQLite sidecars must be regular files");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  try {
    lstatSync(`${path}-journal`);
    fail("Active database has an unexpected rollback journal");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (Number(checkpoint?.busy ?? 0) !== 0) {
      fail("Active WAL checkpoint is busy");
    }
    const journal = database.prepare("PRAGMA journal_mode = DELETE").get();
    if (String(journal?.journal_mode ?? "").toLowerCase() !== "delete") {
      fail("Active database did not leave WAL mode cleanly");
    }
  } finally {
    database.close();
  }
  assertNoSidecars(path, "Active database after checkpoint");
}

function removeEmptyCandidateSidecars(path) {
  let walStat = null;
  try {
    walStat = lstatSync(`${path}-wal`);
    if (!walStat.isFile() || walStat.size !== 0) {
      fail("Restore candidate WAL must be an empty regular file");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  let shmStat = null;
  try {
    shmStat = lstatSync(`${path}-shm`);
    if (!shmStat.isFile()) fail("Restore candidate SHM must be a regular file");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    lstatSync(`${path}-journal`);
    fail("Restore candidate has an unexpected rollback journal");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (shmStat && !walStat) {
    fail("Restore candidate SHM is not paired with an empty WAL");
  }
  if (shmStat) unlinkSync(`${path}-shm`);
  if (walStat) unlinkSync(`${path}-wal`);
  if (shmStat || walStat) fsyncDirectory(dirname(path));
  assertNoSidecars(path, "Restore candidate after empty-sidecar cleanup");
}

export function assertNoOpenHandles(
  path,
  { run = spawnSync, lsofPath = "/usr/sbin/lsof" } = {},
) {
  const targets = [
    { path, required: true },
    { path: `${path}-wal`, required: false },
    { path: `${path}-shm`, required: false },
    { path: `${path}-journal`, required: false },
  ];
  const absentSidecars = [];
  for (const target of targets) {
    try {
      lstatSync(target.path);
    } catch (error) {
      if (error?.code !== "ENOENT" || target.required) {
        fail("Unable to verify active database process handles");
      }
      absentSidecars.push(target.path);
      continue;
    }
    const result = run(lsofPath, ["-Fn", target.path], {
      encoding: "utf8",
      shell: false,
    });
    const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    if (result.status === 0 && stdout) {
      fail("Active database still has an open process handle");
    }
    if (
      result.error ||
      result.signal ||
      (result.status === 1 && stderr) ||
      (result.status !== 0 && result.status !== 1)
    ) {
      fail("Unable to verify active database process handles");
    }
  }
  for (const sidecar of absentSidecars) {
    try {
      lstatSync(sidecar);
      fail("Active SQLite sidecar appeared during process-handle verification");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function replaceStoppedSqlite({
  activePath,
  candidatePath,
  verificationReportPath,
  rollbackPath,
  checkpointActiveWal = true,
  serviceStateProbe,
  openHandleProbe = assertNoOpenHandles,
}) {
  if (typeof serviceStateProbe !== "function") {
    fail("An explicit stopped-state probe is required");
  }
  if (typeof openHandleProbe !== "function") {
    fail("An open-handle probe is required");
  }
  const active = strictFile(activePath, "Active database");
  const candidate = strictFile(candidatePath, "Restore candidate");
  if (dirname(active.path) !== dirname(candidate.path)) {
    fail("Restore candidate must share the active database directory");
  }
  if (active.stat.dev !== candidate.stat.dev || active.stat.ino === candidate.stat.ino) {
    fail("Restore candidate must be a distinct file on the same filesystem");
  }
  const rollback = newRollbackPath(rollbackPath, dirname(active.path));
  const assertStoppedContract = () => {
    serviceStateProbe();
    openHandleProbe(active.path);
  };
  const assertFileIdentity = (file, expected, label) => {
    const current = lstatSync(file);
    if (
      !current.isFile() ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino ||
      current.size !== expected.size
    ) {
      fail(`${label} identity changed before replacement`);
    }
  };
  assertStoppedContract();
  removeEmptyCandidateSidecars(candidate.path);

  const report = readVerificationReport(verificationReportPath);
  const candidateHash = sha256File(candidate.path);
  if (
    report.restore.file !== basename(candidate.path) ||
    report.restore.sha256 !== candidateHash
  ) {
    fail("Restore candidate does not match the verification report");
  }
  const candidateSummary = inspectSqliteDatabase(candidate.path);
  if (!summariesMatch(candidateSummary, report.database)) {
    fail("Restore candidate database summary does not match the verification report");
  }

  assertStoppedContract();
  if (checkpointActiveWal) {
    checkpointStoppedWal(active.path);
  } else {
    assertNoSidecars(active.path, "Active database");
  }
  const activeIdentity = lstatSync(active.path);
  const candidateIdentity = lstatSync(candidate.path);
  const activeHashBefore = sha256File(active.path);
  let rollbackLinked = false;
  let rollbackIdentity = null;
  let candidateMoved = false;
  try {
    assertStoppedContract();
    assertFileIdentity(active.path, activeIdentity, "Active database");
    assertFileIdentity(candidate.path, candidateIdentity, "Restore candidate");
    linkSync(active.path, rollback);
    rollbackLinked = true;
    rollbackIdentity = lstatSync(rollback);
    fsyncDirectory(dirname(active.path));
    assertStoppedContract();
    assertFileIdentity(active.path, activeIdentity, "Active database");
    assertFileIdentity(candidate.path, candidateIdentity, "Restore candidate");
    renameSync(candidate.path, active.path);
    candidateMoved = true;
    chmodSync(active.path, 0o600);
    fsyncDirectory(dirname(active.path));

    const installedHash = sha256File(active.path);
    const installedSummary = inspectSqliteDatabase(active.path);
    if (installedHash !== candidateHash || !summariesMatch(installedSummary, report.database)) {
      fail("Installed database failed post-replacement verification");
    }
    if (sha256File(rollback) !== activeHashBefore) {
      fail("Rollback database does not preserve the previous active file");
    }
    return {
      replaced: true,
      schemaVersion: installedSummary.schemaVersion,
      activeSha256: installedHash,
      rollbackSha256: activeHashBefore,
      rollbackFile: basename(rollback),
    };
  } catch (error) {
    if (candidateMoved) {
      try {
        renameSync(rollback, active.path);
        fsyncDirectory(dirname(active.path));
        rollbackLinked = false;
      } catch {
        // Preserve the original failure; operator must use the documented rollback file.
      }
    } else if (rollbackLinked && existsSync(rollback)) {
      try {
        const current = lstatSync(rollback);
        if (
          rollbackIdentity &&
          current.dev === rollbackIdentity.dev &&
          current.ino === rollbackIdentity.ino
        ) {
          unlinkSync(rollback);
        }
      } catch {
        // Best-effort cleanup only for the hard link created by this call.
      }
    }
    throw error;
  }
}
