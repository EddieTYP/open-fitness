#!/usr/bin/env node

import { once } from "node:events";
import { cpSync, lstatSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

function requireDirectory(path, label) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    throw new Error(`${label} is unavailable; run npm run build first`);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
}

function requireFile(path, label) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    throw new Error(`${label} is unavailable; run npm run build first`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
}

try {
  const repositoryRoot = resolve(".");
  const publicSource = join(repositoryRoot, "public");
  const staticSource = join(repositoryRoot, ".next", "static");
  const standaloneRoot = join(repositoryRoot, ".next", "standalone");
  const serverPath = join(standaloneRoot, "server.js");

  requireDirectory(publicSource, "Public assets");
  requireDirectory(staticSource, "Next static assets");
  requireDirectory(standaloneRoot, "Standalone build");
  requireFile(serverPath, "Standalone server");

  mkdirSync(join(standaloneRoot, ".next"), { recursive: true });
  cpSync(publicSource, join(standaloneRoot, "public"), {
    recursive: true,
    force: true,
  });
  cpSync(staticSource, join(standaloneRoot, ".next", "static"), {
    recursive: true,
    force: true,
  });

  const childEnvironment = { ...process.env, HOSTNAME: "127.0.0.1" };
  const ownerPasswordHash = childEnvironment.FITNESS_OWNER_PASSWORD_HASH;
  if (ownerPasswordHash?.startsWith("scrypt\\$")) {
    childEnvironment.FITNESS_OWNER_PASSWORD_HASH = ownerPasswordHash.replaceAll(
      "\\$",
      "$",
    );
  }

  const child = spawn(process.execPath, [serverPath], {
    cwd: standaloneRoot,
    env: childEnvironment,
    stdio: "inherit",
  });
  let stoppingSignal;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      stoppingSignal = signal;
      child.kill(signal);
    });
  }
  const [code] = await once(child, "exit");
  if (stoppingSignal) process.kill(process.pid, stoppingSignal);
  else process.exitCode = code ?? 1;
} catch (error) {
  const message = error instanceof Error ? error.message : "Unable to start";
  process.stderr.write(`Open Fitness startup failed: ${message}\n`);
  process.exitCode = 1;
}
