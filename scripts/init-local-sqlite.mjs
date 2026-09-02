#!/usr/bin/env node

import { basename } from "node:path";

import { initializeLocalDatabase } from "./sqlite-storage.mjs";

process.umask(0o077);

const optionNames = new Set([
  "--path",
  "--profile-id",
  "--goal",
  "--cycle",
  "--timezone",
  "--locale",
  "--height-cm",
  "--owner-email",
]);

function parseOptions(argv) {
  if (argv.length === 0 || argv.length % 2 !== 0) {
    throw new Error(
      "Usage: init-local-sqlite.mjs --path ABSOLUTE_PATH --goal TEXT --cycle TEXT [--profile-id ID] [--timezone IANA_ZONE] [--locale LOCALE] [--height-cm NUMBER] [--owner-email EMAIL]",
    );
  }
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!optionNames.has(name) || options.has(name) || value.startsWith("--")) {
      throw new Error("Initialization options are invalid");
    }
    options.set(name, value);
  }
  return options;
}

try {
  const options = parseOptions(process.argv.slice(2));
  const result = initializeLocalDatabase({
    outputPath: options.get("--path"),
    migrationsDirectory: new URL("../drizzle/", import.meta.url),
    profileId: options.get("--profile-id") ?? "owner",
    primaryGoal: options.get("--goal"),
    trainingCycle: options.get("--cycle"),
    timezone: options.get("--timezone"),
    preferredLocale: options.get("--locale"),
    heightCm: options.has("--height-cm")
      ? Number(options.get("--height-cm"))
      : undefined,
    ownerEmail: options.get("--owner-email"),
  });
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      databaseFile: basename(result.outputPath),
      profileId: result.profileId,
      schemaVersion: result.database.schemaVersion,
    })}\n`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : "Initialization failed";
  process.stderr.write(`Local SQLite initialization failed: ${message}\n`);
  process.exitCode = 1;
}
