#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  createSqliteBackup,
  inspectSqliteDatabase,
  logicalSqliteDigest,
  runLocalMigrations,
  verifySqliteBackup,
} from "./sqlite-storage.mjs";
import {
  assertNoOpenHandles,
  replaceStoppedSqlite,
} from "./replace-stopped-sqlite.mjs";

const RELEASE_ID_PATTERN = /^[0-9a-f]{40}$/;
const ACTIVATION_SCRIPT_NAME = "activate-self-host-release.mjs";
const activationScriptPath = fileURLToPath(import.meta.url);

export const SELF_HOST_PREFLIGHT_COMMANDS = Object.freeze([
  Object.freeze(["npm", "test"]),
  Object.freeze(["npm", "run", "check"]),
  Object.freeze(["npm", "run", "lint"]),
  Object.freeze(["npm", "run", "build"]),
]);

function fail(message) {
  throw new Error(message);
}

function absolutePath(value, label) {
  if (typeof value !== "string" || value.trim() === "" || !isAbsolute(value)) {
    fail(`${label} must be an absolute path`);
  }
  const path = resolve(value);
  if (path !== value) fail(`${label} must be normalized`);
  return path;
}

function requireRealDirectory(value, label, { ownerOnly = false } = {}) {
  const path = absolutePath(value, label);
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    fail(`${label} must exist as a directory`);
  }
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    realpathSync(path) !== path
  ) {
    fail(`${label} must be a real directory`);
  }
  if (
    (typeof process.getuid === "function" && metadata.uid !== process.getuid()) ||
    (metadata.mode & (ownerOnly ? 0o077 : 0o022)) !== 0
  ) {
    fail(`${label} permissions are unsafe`);
  }
  return { path, metadata };
}

function requireRegularFile(value, label, maximumBytes = Infinity) {
  const path = absolutePath(value, label);
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    fail(`${label} must exist as a regular file`);
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size <= 0 ||
    metadata.size > maximumBytes ||
    realpathSync(path) !== path
  ) {
    fail(`${label} must be a real non-empty regular file`);
  }
  return { path, metadata };
}

function validateCommand(value, label) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((part) => typeof part !== "string" || part.length === 0)
  ) {
    fail(`${label} must be a non-empty JSON array of non-empty strings`);
  }
  return [...value];
}

function validateServiceCommand(value, label) {
  const command = validateCommand(value, label);
  if (!isAbsolute(command[0]) || resolve(command[0]) !== command[0]) {
    fail(`${label} executable must be a normalized absolute path`);
  }
  return command;
}

export function createShellFalseCommandAdapter({ spawnProcess = spawn } = {}) {
  return (commandValue, { cwd, env = process.env } = {}) => {
    const command = validateCommand(commandValue, "Command");
    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      const child = spawnProcess(command[0], command.slice(1), {
        cwd,
        env,
        stdio: "inherit",
        shell: false,
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        rejectPromise(error);
      });
      child.once("close", (status, signal) => {
        if (settled) return;
        settled = true;
        if (status === 0 && signal === null) resolvePromise();
        else {
          rejectPromise(
            new Error(
              `Command failed (${command[0]}, status ${status}, signal ${signal ?? "none"})`,
            ),
          );
        }
      });
    });
  };
}

function healthEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("Health URL must be an absolute loopback URL");
  }
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !loopbackHosts.has(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/api/health" ||
    url.search ||
    url.hash
  ) {
    fail("Health URL must be the loopback /api/health endpoint");
  }
  return url.href;
}

function validReadyResponse(payload, expectedReleaseId, expectedSchemaVersion) {
  return (
    payload?.status === "ready" &&
    payload?.ready === true &&
    payload?.releaseId === expectedReleaseId &&
    payload?.schemaVersion === expectedSchemaVersion
  );
}

export async function waitForExpectedHealth(
  healthUrlValue,
  expectedReleaseId,
  expectedSchemaVersion,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = 60_000,
    intervalMs = 500,
  } = {},
) {
  const healthUrl = healthEndpoint(healthUrlValue);
  if (!RELEASE_ID_PATTERN.test(expectedReleaseId ?? "")) {
    fail("Expected release ID must be 40 lowercase hexadecimal characters");
  }
  if (!Number.isSafeInteger(expectedSchemaVersion) || expectedSchemaVersion < 0) {
    fail("Expected schema version must be a non-negative safe integer");
  }
  if (
    typeof fetchImpl !== "function" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 0
  ) {
    fail("Health-check adapter options are invalid");
  }

  const deadline = Date.now() + timeoutMs;
  let lastFailure = "not ready";
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(healthUrl, {
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(2_000, Math.max(1, deadline - Date.now()))),
      });
      const text = await response.text();
      if (text.length > 64 * 1024) fail("Health response is too large");
      const payload = JSON.parse(text);
      if (
        response.status === 200 &&
        validReadyResponse(payload, expectedReleaseId, expectedSchemaVersion)
      ) {
        return true;
      }
      lastFailure = `status ${response.status}, release mismatch, or schema mismatch`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : "health request failed";
    }
    const remaining = deadline - Date.now();
    if (remaining > 0 && intervalMs > 0) {
      await new Promise((resolvePromise) =>
        setTimeout(resolvePromise, Math.min(intervalMs, remaining)),
      );
    }
  }
  fail(`Health acceptance failed for ${expectedReleaseId}: ${lastFailure}`);
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function acquireActivationLock(appRoot) {
  const path = join(appRoot, ".self-host-activate.lock");
  let descriptor;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDWR |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    if (error?.code === "EEXIST") fail("Self-host activation lock is already held");
    throw error;
  }
  const metadata = fstatSync(descriptor);
  if (
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o777) !== 0o600 ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) {
    closeSync(descriptor);
    fail("Self-host activation lock is unsafe");
  }
  fsyncSync(descriptor);
  fsyncDirectory(appRoot);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    closeSync(descriptor);
    try {
      const current = lstatSync(path);
      if (current.dev === metadata.dev && current.ino === metadata.ino) {
        unlinkSync(path);
        fsyncDirectory(appRoot);
      }
    } catch {
      // Never remove a lock path whose identity changed while activation ran.
    }
  };
}

function releaseState(appRoot, releaseId) {
  if (!RELEASE_ID_PATTERN.test(releaseId ?? "")) {
    fail("Release ID must be 40 lowercase hexadecimal characters");
  }
  const releases = join(appRoot, "releases");
  const current = join(appRoot, "current");
  const release = join(releases, releaseId);
  requireRealDirectory(releases, "Self-host releases directory");
  const candidate = requireRealDirectory(release, "Candidate release");
  requireRegularFile(join(release, "package.json"), "Candidate package manifest", 1024 * 1024);

  let currentMetadata;
  try {
    currentMetadata = lstatSync(current);
  } catch {
    fail("Self-host current path must exist as a symlink");
  }
  if (!currentMetadata.isSymbolicLink()) {
    fail("Self-host current path must be a symlink");
  }
  const previous = realpathSync(current);
  const previousId = basename(previous);
  if (
    !RELEASE_ID_PATTERN.test(previousId) ||
    previous !== join(releases, previousId) ||
    previousId === releaseId
  ) {
    fail("Current self-host release identity is invalid");
  }
  requireRealDirectory(previous, "Previous release");
  return {
    releases,
    current,
    release,
    previous,
    previousId,
    candidateIdentity: candidate.metadata,
    currentIdentity: {
      dev: currentMetadata.dev,
      ino: currentMetadata.ino,
      target: readlinkSync(current),
    },
  };
}

function candidateActivationSource(state, scriptPathValue) {
  const expectedScriptPath = join(
    state.release,
    "scripts",
    ACTIVATION_SCRIPT_NAME,
  );
  const script = requireRegularFile(
    scriptPathValue,
    "Running activation script",
    1024 * 1024,
  );
  if (script.path !== expectedScriptPath) {
    fail("Activation must run from the candidate release script");
  }
  const migrations = requireRealDirectory(
    join(state.release, "drizzle"),
    "Candidate migrations directory",
  );
  const journal = requireRegularFile(
    join(migrations.path, "meta", "_journal.json"),
    "Candidate migration journal",
    1024 * 1024,
  );
  return {
    scriptPath: script.path,
    scriptIdentity: script.metadata,
    migrationsDirectory: migrations.path,
    journalPath: journal.path,
    journalIdentity: journal.metadata,
  };
}

function assertIdentity(path, expected, label) {
  const current = lstatSync(path);
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    fail(`${label} identity changed during activation`);
  }
}

function assertCurrentIdentity(state) {
  const metadata = lstatSync(state.current);
  if (
    !metadata.isSymbolicLink() ||
    metadata.dev !== state.currentIdentity.dev ||
    metadata.ino !== state.currentIdentity.ino ||
    readlinkSync(state.current) !== state.currentIdentity.target ||
    realpathSync(state.current) !== state.previous
  ) {
    fail("Current release changed during activation");
  }
}

function removeOwnedSymlink(path, identity) {
  try {
    const metadata = lstatSync(path);
    if (
      metadata.isSymbolicLink() &&
      metadata.dev === identity.dev &&
      metadata.ino === identity.ino &&
      readlinkSync(path) === identity.target
    ) {
      unlinkSync(path);
    }
  } catch {
    // Best effort only for the exact scratch link created by this process.
  }
}

function switchCurrent(appRoot, currentPath, targetPath, operationId) {
  const scratch = join(appRoot, `.current-${operationId}`);
  symlinkSync(targetPath, scratch, "dir");
  const metadata = lstatSync(scratch);
  const identity = {
    dev: metadata.dev,
    ino: metadata.ino,
    target: readlinkSync(scratch),
  };
  try {
    if (realpathSync(scratch) !== targetPath) fail("Release scratch link is invalid");
    renameSync(scratch, currentPath);
    fsyncDirectory(appRoot);
  } finally {
    removeOwnedSymlink(scratch, identity);
  }
  if (realpathSync(currentPath) !== targetPath) {
    fail("Atomic current release switch failed");
  }
}

function operationPaths(sqlitePath, releaseId, operationId) {
  const directory = dirname(sqlitePath);
  const stem = `.open-fitness-${releaseId.slice(0, 12)}-${operationId}`;
  return {
    candidate: join(directory, `${stem}.rollback-candidate.sqlite`),
    report: join(directory, `${stem}.rollback-report.json`),
    failedDatabase: join(directory, `${stem}.failed.sqlite`),
  };
}

function commandForRelease(command, releaseId) {
  return command.map((part) => (part === "{releaseId}" ? releaseId : part));
}

function preflightEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => name !== "NODE_ENV" && !name.startsWith("FITNESS_"),
    ),
  );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function schemaVersion(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function verifiedStoppedSchemaVersion(backup, verification, inspectedVersion) {
  const backupVersion = schemaVersion(
    backup?.manifest?.database?.schemaVersion,
    "Stopped backup schema version",
  );
  const reportVersion = schemaVersion(
    verification?.report?.database?.schemaVersion,
    "Stopped verification schema version",
  );
  if (backupVersion !== inspectedVersion || reportVersion !== inspectedVersion) {
    fail("Stopped rollback snapshot schema version is inconsistent");
  }
  return reportVersion;
}

function validateMigrationResult(migration, stoppedSchemaVersion) {
  if (migration?.migrated !== true && migration?.migrated !== false) {
    fail("Migration result must declare whether the database changed");
  }
  const fromVersion = schemaVersion(
    migration.fromVersion,
    "Migration source schema version",
  );
  const toVersion = schemaVersion(
    migration.toVersion,
    "Migration target schema version",
  );
  if (fromVersion !== stoppedSchemaVersion) {
    fail("Migration source does not match the stopped rollback snapshot");
  }
  if (
    (migration.migrated && toVersion <= fromVersion) ||
    (!migration.migrated && toVersion !== fromVersion)
  ) {
    fail("Migration result is inconsistent with its schema versions");
  }
  return { migrated: migration.migrated, fromVersion, toVersion };
}

export async function activateSelfHostRelease(
  {
    appRoot: appRootValue,
    releaseId,
    sqlitePath: sqlitePathValue,
    backupDirectory: backupDirectoryValue,
    stopCommand: stopCommandValue,
    startCommand: startCommandValue,
    healthUrl: healthUrlValue,
  },
  {
    runCommand = createShellFalseCommandAdapter(),
    healthCheck = waitForExpectedHealth,
    createBackup = createSqliteBackup,
    verifyBackup = verifySqliteBackup,
    runMigrations = runLocalMigrations,
    replaceDatabase = replaceStoppedSqlite,
    proveNoOpenHandles = assertNoOpenHandles,
    inspectDatabase = inspectSqliteDatabase,
    databaseDigest = logicalSqliteDigest,
    environment = process.env,
    operationId = randomUUID().replaceAll("-", ""),
    now = new Date(),
    runningScriptPath = activationScriptPath,
  } = {},
) {
  const appRoot = requireRealDirectory(appRootValue, "Self-host application root").path;
  const sqlite = requireRegularFile(sqlitePathValue, "FITNESS_SQLITE_PATH").path;
  requireRealDirectory(dirname(sqlite), "SQLite directory", { ownerOnly: true });
  const backupDirectory = requireRealDirectory(
    backupDirectoryValue,
    "FITNESS_BACKUP_DIR",
    { ownerOnly: true },
  ).path;
  const stopCommand = validateServiceCommand(stopCommandValue, "Stop command");
  const startCommand = validateServiceCommand(startCommandValue, "Start command");
  const healthUrl = healthEndpoint(healthUrlValue);
  if (!/^[a-z0-9]{16,64}$/.test(operationId)) fail("Activation operation ID is invalid");

  const releaseLock = acquireActivationLock(appRoot);
  let state;
  let source;
  let backup;
  let verification;
  let migration;
  let stoppedSchemaVersion;
  let stoppedDatabaseDigest;
  let stopCompleted = false;
  let stopped = false;
  let migrationAttempted = false;
  let databaseChanged = false;
  let switched = false;
  let startAttempted = false;
  const paths = operationPaths(sqlite, releaseId, operationId);
  try {
    state = releaseState(appRoot, releaseId);
    source = candidateActivationSource(state, runningScriptPath);
    for (const command of SELF_HOST_PREFLIGHT_COMMANDS) {
      await runCommand(command, {
        cwd: state.release,
        env: preflightEnvironment(environment),
      });
    }
    assertIdentity(state.release, state.candidateIdentity, "Candidate release");
    assertIdentity(source.scriptPath, source.scriptIdentity, "Running activation script");
    assertIdentity(source.journalPath, source.journalIdentity, "Candidate migration journal");
    assertCurrentIdentity(state);

    await runCommand(stopCommand, { cwd: appRoot, env: environment });
    stopCompleted = true;
    proveNoOpenHandles(sqlite);
    stopped = true;
    assertCurrentIdentity(state);

    stoppedSchemaVersion = schemaVersion(
      inspectDatabase(sqlite).schemaVersion,
      "Stopped database schema version",
    );
    backup = await createBackup({
      sourcePath: sqlite,
      backupDirectory,
      label: `pre-activation-${releaseId.slice(0, 12)}`,
      now,
    });
    verification = await verifyBackup({
      backupPath: backup.backupPath,
      manifestPath: backup.manifestPath,
      restorePath: paths.candidate,
      reportPath: paths.report,
      now,
    });
    stoppedSchemaVersion = verifiedStoppedSchemaVersion(
      backup,
      verification,
      stoppedSchemaVersion,
    );
    stoppedDatabaseDigest = databaseDigest(verification.restorePath);
    if (databaseDigest(sqlite) !== stoppedDatabaseDigest) {
      fail("Stopped rollback snapshot does not preserve the live database");
    }
    proveNoOpenHandles(sqlite);
    assertCurrentIdentity(state);
    assertIdentity(state.release, state.candidateIdentity, "Candidate release");
    assertIdentity(source.scriptPath, source.scriptIdentity, "Running activation script");
    assertIdentity(source.journalPath, source.journalIdentity, "Candidate migration journal");

    migrationAttempted = true;
    migration = await runMigrations({
      sourcePath: sqlite,
      backupDirectory,
      migrationsDirectory: source.migrationsDirectory,
      now,
    });
    const migrationState = validateMigrationResult(migration, stoppedSchemaVersion);
    databaseChanged = migrationState.migrated;
    proveNoOpenHandles(sqlite);
    assertCurrentIdentity(state);
    assertIdentity(state.release, state.candidateIdentity, "Candidate release");

    try {
      switchCurrent(appRoot, state.current, state.release, operationId);
      switched = true;
    } catch (switchError) {
      try {
        switched = realpathSync(state.current) === state.release;
      } catch {
        // The rollback path below will leave the service stopped.
      }
      throw switchError;
    }
    startAttempted = true;
    await runCommand(commandForRelease(startCommand, releaseId), {
      cwd: appRoot,
      env: environment,
    });
    await healthCheck(healthUrl, releaseId, migrationState.toVersion);
    stopped = false;
    return {
      activated: true,
      releaseId,
      previousReleaseId: state.previousId,
      migrated: migration.migrated,
      fromVersion: migration.fromVersion,
      toVersion: migration.toVersion,
      backupPath: backup.backupPath,
      manifestPath: backup.manifestPath,
      rollbackCandidatePath: verification.restorePath,
      rollbackReportPath: verification.reportPath,
    };
  } catch (error) {
    if (!stopCompleted) throw error;
    if (!Number.isSafeInteger(stoppedSchemaVersion) || stoppedSchemaVersion < 0) {
      throw new AggregateError(
        [error, new Error("The stopped database schema version was not proven")],
        "Self-host activation failed; rollback is incomplete and the service must remain stopped",
      );
    }

    const rollbackErrors = [];
    if (!stopped) {
      try {
        await runCommand(commandForRelease(startCommand, state.previousId), {
          cwd: appRoot,
          env: environment,
        });
        await healthCheck(healthUrl, state.previousId, stoppedSchemaVersion);
      } catch (recoveryError) {
        rollbackErrors.push(recoveryError);
      }
    } else {
      if (startAttempted || switched) {
        try {
          await runCommand(stopCommand, { cwd: appRoot, env: environment });
          proveNoOpenHandles(sqlite);
        } catch (stopError) {
          rollbackErrors.push(stopError);
        }
      } else if (migrationAttempted) {
        try {
          proveNoOpenHandles(sqlite);
        } catch (handleError) {
          rollbackErrors.push(handleError);
        }
      }
      if (rollbackErrors.length === 0 && switched) {
        try {
          switchCurrent(appRoot, state.current, state.previous, `${operationId}-rollback`);
        } catch (switchError) {
          rollbackErrors.push(switchError);
        }
      }
      if (
        rollbackErrors.length === 0 &&
        migrationAttempted &&
        stoppedDatabaseDigest
      ) {
        try {
          databaseChanged = databaseDigest(sqlite) !== stoppedDatabaseDigest;
        } catch {
          // If the possibly migrated database cannot be compared, restore the
          // verified stopped snapshot rather than assuming it is unchanged.
          databaseChanged = true;
        }
      }
      if (rollbackErrors.length === 0 && databaseChanged) {
        try {
          const replacement = await replaceDatabase({
            activePath: sqlite,
            candidatePath: paths.candidate,
            verificationReportPath: paths.report,
            rollbackPath: paths.failedDatabase,
            serviceStateProbe: () => {
              if (!stopped) fail("Self-host service is not stopped");
            },
            openHandleProbe: proveNoOpenHandles,
          });
          if (replacement.schemaVersion !== stoppedSchemaVersion) {
            fail("Database rollback did not restore the stopped schema version");
          }
        } catch (databaseError) {
          rollbackErrors.push(databaseError);
        }
      }
      if (rollbackErrors.length === 0) {
        try {
          await runCommand(commandForRelease(startCommand, state.previousId), {
            cwd: appRoot,
            env: environment,
          });
          await healthCheck(healthUrl, state.previousId, stoppedSchemaVersion);
        } catch (recoveryError) {
          rollbackErrors.push(recoveryError);
        }
      }
    }

    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Self-host activation failed; rollback is incomplete and the service must remain stopped",
      );
    }
    throw new Error(
      `Self-host activation failed; previous code and database were restored: ${errorMessage(error)}`,
      { cause: error },
    );
  } finally {
    releaseLock();
  }
}

export function readSelfHostCommandAdapter(pathValue) {
  const { path, metadata } = requireRegularFile(
    pathValue,
    "Self-host command adapter",
    64 * 1024,
  );
  if (
    metadata.nlink !== 1 ||
    (metadata.mode & 0o777) !== 0o600 ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) {
    fail("Self-host command adapter must be an owner-only 0600 file");
  }
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("Self-host command adapter must be valid JSON");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "start,stop"
  ) {
    fail("Self-host command adapter must contain only start and stop arrays");
  }
  return {
    stop: validateServiceCommand(value.stop, "Stop command"),
    start: validateServiceCommand(value.start, "Start command"),
  };
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      !["--app-root", "--release", "--adapter", "--health-url"].includes(key) ||
      !value
    ) {
      fail(
        "Usage: activate-self-host-release.mjs --app-root PATH --release ID --adapter FILE --health-url URL",
      );
    }
    if (values[key]) fail(`Duplicate argument: ${key}`);
    values[key] = value;
  }
  if (Object.keys(values).length !== 4) fail("All activation arguments are required");
  return values;
}

const isCli =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  process.umask(0o077);
  try {
    const values = parseArguments(process.argv.slice(2));
    const adapter = readSelfHostCommandAdapter(values["--adapter"]);
    const result = await activateSelfHostRelease({
      appRoot: values["--app-root"],
      releaseId: values["--release"],
      sqlitePath: process.env.FITNESS_SQLITE_PATH,
      backupDirectory: process.env.FITNESS_BACKUP_DIR,
      stopCommand: adapter.stop,
      startCommand: adapter.start,
      healthUrl: values["--health-url"],
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    process.stderr.write(`Self-host activation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
