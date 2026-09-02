#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import process from "node:process";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { replaceStoppedSqlite } from "./replace-stopped-sqlite.mjs";

function fail(message) {
  throw new Error(message);
}

function validateStoppedCheck(value) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((part) => typeof part !== "string" || part.length === 0) ||
    !isAbsolute(value[0]) ||
    resolve(value[0]) !== value[0]
  ) {
    fail("Stopped-state check must be argv with a normalized absolute executable");
  }
  return [...value];
}

export function createStoppedStateProbe(commandValue, { run = spawnSync } = {}) {
  const command = validateStoppedCheck(commandValue);
  return () => {
    const result = run(command[0], command.slice(1), {
      encoding: "utf8",
      shell: false,
    });
    if (
      result.error ||
      result.signal ||
      !Number.isInteger(result.status) ||
      result.status !== 0
    ) {
      fail("Unable to prove the self-host service is stopped");
    }
  };
}

export function readStoppedStateCheck(pathValue) {
  if (typeof pathValue !== "string" || !isAbsolute(pathValue)) {
    fail("Stopped-state check file must be an absolute path");
  }
  const path = resolve(pathValue);
  if (path !== pathValue) fail("Stopped-state check file must be normalized");
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    fail("Stopped-state check file must exist");
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size <= 0 ||
    metadata.size > 64 * 1024 ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o777) !== 0o600 ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid()) ||
    realpathSync(path) !== path
  ) {
    fail("Stopped-state check file must be an owner-only 0600 regular file");
  }
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("Stopped-state check file must be valid JSON");
  }
  return validateStoppedCheck(value);
}

export function restoreStoppedSelfHostSqlite(
  {
    sqlitePath,
    candidatePath,
    verificationReportPath,
    rollbackPath,
  },
  { stoppedStateProbe, openHandleProbe } = {},
) {
  if (typeof stoppedStateProbe !== "function") {
    fail("An explicit stopped-state probe is required");
  }
  return replaceStoppedSqlite({
    activePath: sqlitePath,
    candidatePath,
    verificationReportPath,
    rollbackPath,
    serviceStateProbe: stoppedStateProbe,
    ...(openHandleProbe ? { openHandleProbe } : {}),
  });
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      !["--candidate", "--report", "--rollback", "--stopped-check"].includes(key) ||
      !value
    ) {
      fail(
        "Usage: restore-stopped-sqlite.mjs --candidate PATH --report PATH --rollback NEW_PATH --stopped-check FILE",
      );
    }
    if (values[key]) fail(`Duplicate argument: ${key}`);
    values[key] = value;
  }
  if (Object.keys(values).length !== 4) {
    fail("Candidate, report, rollback, and stopped-state check paths are required");
  }
  return values;
}

const isCli =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  process.umask(0o077);
  try {
    const values = parseArguments(process.argv.slice(2));
    const stoppedStateProbe = createStoppedStateProbe(
      readStoppedStateCheck(values["--stopped-check"]),
    );
    const result = restoreStoppedSelfHostSqlite(
      {
        sqlitePath: process.env.FITNESS_SQLITE_PATH,
        candidatePath: values["--candidate"],
        verificationReportPath: values["--report"],
        rollbackPath: values["--rollback"],
      },
      { stoppedStateProbe },
    );
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    process.stderr.write(`Stopped SQLite restore failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
