#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

const [target, extra] = process.argv.slice(2);

function valueFor(source, name) {
  const raw = source.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1].trim();
  if (!raw) return null;
  if (
    (raw.startsWith("'") && raw.endsWith("'")) ||
    (raw.startsWith('"') && raw.endsWith('"'))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

let temporaryPath;
try {
  if (!target || extra) throw new Error("Pass exactly one runtime.env path");
  const before = lstatSync(target);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.uid !== process.getuid?.() ||
    (before.mode & 0o777) !== 0o600
  ) {
    throw new Error("runtime.env must be an owner-only regular file");
  }

  const source = readFileSync(target, "utf8");
  const apiToken = valueFor(source, "FITNESS_API_TOKEN");
  const existing = valueFor(source, "FITNESS_HEALTH_SYNC_TOKEN");
  if (!apiToken) throw new Error("FITNESS_API_TOKEN is missing");
  if (existing) {
    if (existing === apiToken) throw new Error("health sync token must be independent");
    process.stdout.write('{"updated":false}\n');
    process.exit(0);
  }

  const token = randomBytes(32).toString("base64url");
  const next = `${source.replace(/\n*$/, "\n")}FITNESS_HEALTH_SYNC_TOKEN='${token}'\n`;
  temporaryPath = `${target}.health-sync-${process.pid}`;
  const descriptor = openSync(temporaryPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, next, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }

  const current = lstatSync(target);
  if (current.dev !== before.dev || current.ino !== before.ino) {
    throw new Error("runtime.env changed during token installation");
  }
  renameSync(temporaryPath, target);
  temporaryPath = undefined;
  process.stdout.write('{"updated":true}\n');
} catch (error) {
  if (temporaryPath) {
    try {
      unlinkSync(temporaryPath);
    } catch {}
  }
  process.stderr.write(
    `${error instanceof Error ? error.message : "Unable to install health sync token"}\n`,
  );
  process.exitCode = 1;
}
