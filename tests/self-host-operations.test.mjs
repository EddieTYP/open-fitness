import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  activateSelfHostRelease,
  createShellFalseCommandAdapter,
  readSelfHostCommandAdapter,
  waitForExpectedHealth,
} from "../scripts/activate-self-host-release.mjs";
import {
  createStoppedStateProbe,
  readStoppedStateCheck,
  restoreStoppedSelfHostSqlite,
} from "../scripts/restore-stopped-sqlite.mjs";
import { assertNoOpenHandles } from "../scripts/replace-stopped-sqlite.mjs";
import {
  createSqliteBackup,
  inspectSqliteDatabase,
  runLocalMigrations,
  verifySqliteBackup,
} from "../scripts/sqlite-storage.mjs";
import {
  EDWARD_FITNESS_DATABASE_NAME,
  EDWARD_FITNESS_TIMEZONE,
} from "../db/schema-identity.mjs";

const migrationsDirectory = new URL("../drizzle/", import.meta.url);
const migrationJournal = JSON.parse(
  readFileSync(new URL("meta/_journal.json", migrationsDirectory), "utf8"),
);

function temporaryRoot(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function createFixture(path, version) {
  const database = new DatabaseSync(path);
  for (const entry of migrationJournal.entries) {
    if (entry.idx > version) break;
    const migration = readFileSync(
      new URL(`${entry.tag}.sql`, migrationsDirectory),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) database.exec(statement);
    }
  }
  database
    .prepare(
      `INSERT INTO schema_metadata (
        schema_version, database_name, canonical_master, timezone,
        source_workbook_sha256
      ) VALUES (?, ?, 1, ?, '')`,
    )
    .run(version, EDWARD_FITNESS_DATABASE_NAME, EDWARD_FITNESS_TIMEZONE);
  database
    .prepare(
      `INSERT INTO profile (
        profile_id, primary_goal, training_cycle, timezone, updated_at
      ) VALUES ('owner', 'self-host fixture', 'test', ?,
        '2026-08-16T00:00:00+08:00')`,
    )
    .run(EDWARD_FITNESS_TIMEZONE);
  database.close();
}

function profileGoal(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database
      .prepare("SELECT primary_goal AS value FROM profile WHERE profile_id = 'owner'")
      .get().value;
  } finally {
    database.close();
  }
}

function createReleaseTree(root) {
  const appRoot = join(root, "app");
  const releases = join(appRoot, "releases");
  const previousId = "1".repeat(40);
  const releaseId = "2".repeat(40);
  const previous = join(releases, previousId);
  const release = join(releases, releaseId);
  mkdirSync(previous, { recursive: true, mode: 0o700 });
  mkdirSync(release, { mode: 0o700 });
  mkdirSync(join(previous, "scripts"), { mode: 0o700 });
  mkdirSync(join(release, "scripts"), { mode: 0o700 });
  writeFileSync(join(previous, "package.json"), "{}\n", { mode: 0o600 });
  writeFileSync(join(release, "package.json"), "{}\n", { mode: 0o600 });
  const previousActivationScript = join(
    previous,
    "scripts",
    "activate-self-host-release.mjs",
  );
  const activationScript = join(
    release,
    "scripts",
    "activate-self-host-release.mjs",
  );
  writeFileSync(previousActivationScript, "// previous fixture\n", { mode: 0o600 });
  writeFileSync(activationScript, "// candidate fixture\n", { mode: 0o600 });
  cpSync(migrationsDirectory, join(release, "drizzle"), { recursive: true });
  symlinkSync(previous, join(appRoot, "current"), "dir");
  return {
    activationScript,
    appRoot,
    previous,
    previousActivationScript,
    previousId,
    release,
    releaseId,
  };
}

test("package exposes generic restore and activation entrypoints without host defaults", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(
    packageJson.scripts["db:restore:stopped"],
    "node --env-file-if-exists=.env.local scripts/restore-stopped-sqlite.mjs",
  );
  assert.equal(
    packageJson.scripts["self-host:activate"],
    "node --env-file-if-exists=.env.local scripts/activate-self-host-release.mjs",
  );
  const selfHostingGuide = readFileSync(
    new URL("../docs/operations/SELF-HOSTING.md", import.meta.url),
    "utf8",
  );
  assert.match(
    selfHostingGuide,
    /npm --prefix "\$HOME\/\.open-fitness\/app\/releases\/\$NEW_RELEASE" run self-host:activate/,
  );
  assert.doesNotMatch(
    selfHostingGuide,
    /environment is already loaded, `npm run self-host:activate/,
  );
  const restoreSource = readFileSync(
    new URL("../scripts/restore-stopped-sqlite.mjs", import.meta.url),
    "utf8",
  );
  assert.match(restoreSource, /process\.env\.FITNESS_SQLITE_PATH/);
  assert.doesNotMatch(restoreSource, /STAGING_DATABASE|LIVE_SERVICE_LABEL/);
});

test("command adapter always spawns argv directly with shell disabled", async () => {
  const calls = [];
  const run = createShellFalseCommandAdapter({
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    },
  });
  await run(["/usr/bin/service-control", "stop", "name with spaces"], {
    cwd: "/tmp",
    env: { CONTRACT: "true" },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/usr/bin/service-control");
  assert.deepEqual(calls[0].args, ["stop", "name with spaces"]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.cwd, "/tmp");
});

test("health acceptance requires the exact release schema version", async () => {
  const releaseId = "a".repeat(40);
  let requests = 0;
  await waitForExpectedHealth(
    "http://127.0.0.1:3000/api/health",
    releaseId,
    13,
    {
      timeoutMs: 1_000,
      intervalMs: 0,
      fetchImpl: async () => {
        requests += 1;
        return {
          status: 200,
          text: async () =>
            JSON.stringify({
              status: "ready",
              ready: true,
              releaseId,
              schemaVersion: requests === 1 ? 12 : 13,
            }),
        };
      },
    },
  );
  assert.equal(requests, 2);
});

test("open-handle proof skips and rechecks absent SQLite sidecars", () => {
  const root = temporaryRoot("open-fitness-no-sidecars-");
  const sqlite = join(root, "fitness.sqlite");
  const calls = [];
  try {
    createFixture(sqlite, migrationJournal.entries.at(-1).idx);
    assertNoOpenHandles(sqlite, {
      lsofPath: "/test/lsof",
      run(executable, args, options) {
        calls.push({ executable, args, options });
        return { status: 1, signal: null, stdout: "", stderr: "" };
      },
    });
    assert.deepEqual(calls.map((call) => call.args.at(-1)), [sqlite]);
    assert.equal(calls[0].executable, "/test/lsof");
    assert.equal(calls[0].options.shell, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("service adapter config is owner-only JSON with absolute argv executables", () => {
  const root = temporaryRoot("open-fitness-self-host-adapter-");
  const path = join(root, "activation.json");
  try {
    writeFileSync(
      path,
      `${JSON.stringify({
        stop: ["/usr/bin/service-control", "stop"],
        start: ["/usr/bin/service-control", "start", "{releaseId}"],
      })}\n`,
      { mode: 0o600 },
    );
    assert.deepEqual(readSelfHostCommandAdapter(path), {
      stop: ["/usr/bin/service-control", "stop"],
      start: ["/usr/bin/service-control", "start", "{releaseId}"],
    });
    chmodSync(path, 0o644);
    assert.throws(() => readSelfHostCommandAdapter(path), /owner-only 0600/);
    chmodSync(path, 0o600);
    writeFileSync(
      path,
      `${JSON.stringify({ stop: ["service-control"], start: ["/bin/true"] })}\n`,
    );
    assert.throws(() => readSelfHostCommandAdapter(path), /normalized absolute/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore stopped-state adapter is owner-only argv and never invokes a shell", () => {
  const root = temporaryRoot("open-fitness-stopped-check-");
  const path = join(root, "stopped-check.json");
  const calls = [];
  try {
    writeFileSync(path, '["/usr/bin/service-control","is-stopped"]\n', {
      mode: 0o600,
    });
    const command = readStoppedStateCheck(path);
    const probe = createStoppedStateProbe(command, {
      run(executable, args, options) {
        calls.push({ executable, args, options });
        return { status: 0, signal: null, stdout: "", stderr: "" };
      },
    });
    probe();
    assert.equal(calls[0].executable, "/usr/bin/service-control");
    assert.deepEqual(calls[0].args, ["is-stopped"]);
    assert.equal(calls[0].options.shell, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generic stopped restore is pinned to the configured database and re-proves no handles", async () => {
  const root = temporaryRoot("open-fitness-self-host-restore-");
  const data = join(root, "data");
  const backups = join(root, "backups");
  const active = join(data, "fitness.sqlite");
  const candidate = join(data, "verified-candidate.sqlite");
  const report = join(data, "verified-report.json");
  const rollback = join(data, "fitness.sqlite.rollback");
  mkdirSync(data, { mode: 0o700 });
  mkdirSync(backups, { mode: 0o700 });
  createFixture(active, 8);

  try {
    const backup = await createSqliteBackup({
      sourcePath: active,
      backupDirectory: backups,
      label: "self-host-restore",
    });
    await verifySqliteBackup({
      backupPath: backup.backupPath,
      manifestPath: backup.manifestPath,
      restorePath: candidate,
      reportPath: report,
    });
    const writer = new DatabaseSync(active);
    writer
      .prepare("UPDATE profile SET primary_goal = 'changed live value'")
      .run();
    writer.close();

    let stoppedProbes = 0;
    let handleProbes = 0;
    assert.throws(
      () =>
        restoreStoppedSelfHostSqlite(
          {
            sqlitePath: active,
            candidatePath: candidate,
            verificationReportPath: report,
            rollbackPath: rollback,
          },
          {
            stoppedStateProbe() {
              stoppedProbes += 1;
              if (stoppedProbes === 3) throw new Error("stopped state was lost");
            },
            openHandleProbe: () => handleProbes += 1,
          },
        ),
      /stopped state was lost/,
    );
    assert.equal(existsSync(candidate), true);
    assert.equal(existsSync(rollback), false);

    stoppedProbes = 0;
    handleProbes = 0;
    const result = restoreStoppedSelfHostSqlite(
      {
        sqlitePath: active,
        candidatePath: candidate,
        verificationReportPath: report,
        rollbackPath: rollback,
      },
      {
        stoppedStateProbe: () => stoppedProbes += 1,
        openHandleProbe: () => handleProbes += 1,
      },
    );
    assert.equal(result.replaced, true);
    assert.equal(stoppedProbes, 4);
    assert.equal(handleProbes, 4);
    assert.equal(profileGoal(active), "self-host fixture");
    assert.equal(profileGoal(rollback), "changed live value");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("self-host activation completes preflight before backup and live mutation", async () => {
  const root = temporaryRoot("open-fitness-self-host-activate-");
  const { activationScript, appRoot, release, releaseId, previousId } =
    createReleaseTree(root);
  const data = join(root, "data");
  const backups = join(root, "backups");
  const sqlite = join(data, "fitness.sqlite");
  mkdirSync(data, { mode: 0o700 });
  mkdirSync(backups, { mode: 0o700 });
  createFixture(sqlite, migrationJournal.entries.at(-1).idx);
  const events = [];

  try {
    const result = await activateSelfHostRelease(
      {
        appRoot,
        releaseId,
        sqlitePath: sqlite,
        backupDirectory: backups,
        stopCommand: ["/usr/bin/service-control", "stop"],
        startCommand: ["/usr/bin/service-control", "start"],
        healthUrl: "http://127.0.0.1:3000/api/health",
      },
      {
        operationId: "a".repeat(16),
        runningScriptPath: activationScript,
        now: new Date("2026-08-16T00:00:00.000Z"),
        environment: {
          FITNESS_SQLITE_PATH: "must-not-reach-preflight",
          FITNESS_BACKUP_DIR: "must-not-reach-preflight",
          KEEP_FOR_COMMANDS: "true",
        },
        runCommand: async (command, options) => {
          events.push(command.join(" "));
          if (command[0] === "npm") {
            assert.equal(options.env.FITNESS_SQLITE_PATH, undefined);
            assert.equal(options.env.FITNESS_BACKUP_DIR, undefined);
            assert.equal(options.env.KEEP_FOR_COMMANDS, "true");
          }
          if (command[1] === "start") {
            assert.equal(realpathSync(join(appRoot, "current")), release);
          }
        },
        createBackup: async (options) => {
          events.push("backup");
          return createSqliteBackup(options);
        },
        verifyBackup: async (options) => {
          events.push("verify-backup");
          return verifySqliteBackup(options);
        },
        runMigrations: async (options) => {
          events.push("migrate");
          assert.equal(options.migrationsDirectory, join(release, "drizzle"));
          return runLocalMigrations(options);
        },
        proveNoOpenHandles: () => events.push("no-handles"),
        healthCheck: async (_url, expectedReleaseId, expectedSchemaVersion) => {
          events.push(`health ${expectedReleaseId} v${expectedSchemaVersion}`);
          assert.equal(expectedReleaseId, releaseId);
          assert.equal(
            expectedSchemaVersion,
            migrationJournal.entries.at(-1).idx,
          );
          return true;
        },
      },
    );
    assert.equal(result.activated, true);
    assert.equal(result.previousReleaseId, previousId);
    assert.equal(realpathSync(join(appRoot, "current")), release);
    assert.deepEqual(events.slice(0, 8), [
      "npm test",
      "npm run check",
      "npm run lint",
      "npm run build",
      "/usr/bin/service-control stop",
      "no-handles",
      "backup",
      "verify-backup",
    ]);
    assert.ok(events.indexOf("backup") > events.indexOf("no-handles"));
    assert.ok(events.indexOf("migrate") > events.indexOf("/usr/bin/service-control stop"));
    assert.ok(events.indexOf("/usr/bin/service-control start") > events.indexOf("migrate"));
    assert.equal(existsSync(result.rollbackCandidatePath), true);
    assert.equal(existsSync(result.rollbackReportPath), true);
    assert.equal(existsSync(join(appRoot, ".self-host-activate.lock")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed self-host acceptance rolls code and migrated database back together", async () => {
  const root = temporaryRoot("open-fitness-self-host-rollback-");
  const {
    activationScript,
    appRoot,
    previous,
    previousId,
    releaseId,
  } = createReleaseTree(root);
  const data = join(root, "data");
  const backups = join(root, "backups");
  const sqlite = join(data, "fitness.sqlite");
  mkdirSync(data, { mode: 0o700 });
  mkdirSync(backups, { mode: 0o700 });
  createFixture(sqlite, 7);
  const commands = [];
  let stopCalls = 0;

  try {
    await assert.rejects(
      activateSelfHostRelease(
        {
          appRoot,
          releaseId,
          sqlitePath: sqlite,
          backupDirectory: backups,
          stopCommand: ["/usr/bin/service-control", "stop"],
          startCommand: ["/usr/bin/service-control", "start"],
          healthUrl: "http://127.0.0.1:3000/api/health",
        },
        {
          operationId: "b".repeat(16),
          runningScriptPath: activationScript,
          now: new Date("2026-08-16T01:00:00.000Z"),
          runCommand: async (command) => {
            commands.push(command.join(" "));
            if (command[1] === "stop" && ++stopCalls === 1) {
              const writer = new DatabaseSync(sqlite);
              try {
                writer
                  .prepare(
                    "UPDATE profile SET primary_goal = 'last pre-stop write'",
                  )
                  .run();
              } finally {
                writer.close();
              }
            }
          },
          proveNoOpenHandles: () => {},
          healthCheck: async (
            _url,
            expectedReleaseId,
            expectedSchemaVersion,
          ) => {
            if (expectedReleaseId === releaseId) {
              assert.equal(
                expectedSchemaVersion,
                migrationJournal.entries.at(-1).idx,
              );
              throw new Error("new release health failed");
            }
            assert.equal(expectedReleaseId, previousId);
            assert.equal(expectedSchemaVersion, 7);
            return true;
          },
        },
      ),
      /previous code and database were restored.*new release health failed/,
    );
    assert.equal(realpathSync(join(appRoot, "current")), previous);
    assert.equal(inspectSqliteDatabase(sqlite).schemaVersion, 7);
    assert.equal(profileGoal(sqlite), "last pre-stop write");
    const failedDatabase = readdirSync(data).find((name) =>
      name.endsWith(".failed.sqlite"),
    );
    assert.ok(failedDatabase);
    assert.equal(
      inspectSqliteDatabase(join(data, failedDatabase)).schemaVersion,
      migrationJournal.entries.at(-1).idx,
    );
    assert.equal(
      commands.filter((command) => command === "/usr/bin/service-control stop").length,
      2,
    );
    assert.equal(
      commands.filter((command) => command === "/usr/bin/service-control start").length,
      2,
    );
    assert.equal(existsSync(join(appRoot, ".self-host-activate.lock")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed acceptance without a migration preserves the unchanged database file", async () => {
  const root = temporaryRoot("open-fitness-self-host-no-migration-");
  const {
    activationScript,
    appRoot,
    previous,
    previousId,
    releaseId,
  } = createReleaseTree(root);
  const data = join(root, "data");
  const backups = join(root, "backups");
  const sqlite = join(data, "fitness.sqlite");
  mkdirSync(data, { mode: 0o700 });
  mkdirSync(backups, { mode: 0o700 });
  createFixture(sqlite, migrationJournal.entries.at(-1).idx);
  const originalIdentity = lstatSync(sqlite);
  const healthCalls = [];

  try {
    await assert.rejects(
      activateSelfHostRelease(
        {
          appRoot,
          releaseId,
          sqlitePath: sqlite,
          backupDirectory: backups,
          stopCommand: ["/usr/bin/service-control", "stop"],
          startCommand: ["/usr/bin/service-control", "start"],
          healthUrl: "http://127.0.0.1:3000/api/health",
        },
        {
          operationId: "c".repeat(16),
          runningScriptPath: activationScript,
          now: new Date("2026-08-16T02:00:00.000Z"),
          runCommand: async () => {},
          proveNoOpenHandles: () => {},
          healthCheck: async (
            _url,
            expectedReleaseId,
            expectedSchemaVersion,
          ) => {
            healthCalls.push({ expectedReleaseId, expectedSchemaVersion });
            assert.equal(
              expectedSchemaVersion,
              migrationJournal.entries.at(-1).idx,
            );
            if (expectedReleaseId === releaseId) {
              throw new Error("candidate code failed health");
            }
            assert.equal(expectedReleaseId, previousId);
            return true;
          },
        },
      ),
      /previous code and database were restored.*candidate code failed health/,
    );
    const currentIdentity = lstatSync(sqlite);
    assert.equal(currentIdentity.dev, originalIdentity.dev);
    assert.equal(currentIdentity.ino, originalIdentity.ino);
    assert.equal(profileGoal(sqlite), "self-host fixture");
    assert.equal(realpathSync(join(appRoot, "current")), previous);
    assert.deepEqual(healthCalls, [
      {
        expectedReleaseId: releaseId,
        expectedSchemaVersion: migrationJournal.entries.at(-1).idx,
      },
      {
        expectedReleaseId: previousId,
        expectedSchemaVersion: migrationJournal.entries.at(-1).idx,
      },
    ]);
    assert.equal(
      readdirSync(data).some((name) => name.endsWith(".failed.sqlite")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("activation rejects an old checkout script before running candidate work", async () => {
  const root = temporaryRoot("open-fitness-self-host-old-script-");
  const {
    appRoot,
    previousActivationScript,
    releaseId,
  } = createReleaseTree(root);
  const data = join(root, "data");
  const backups = join(root, "backups");
  const sqlite = join(data, "fitness.sqlite");
  mkdirSync(data, { mode: 0o700 });
  mkdirSync(backups, { mode: 0o700 });
  createFixture(sqlite, migrationJournal.entries.at(-1).idx);
  let commandCalls = 0;

  try {
    await assert.rejects(
      activateSelfHostRelease(
        {
          appRoot,
          releaseId,
          sqlitePath: sqlite,
          backupDirectory: backups,
          stopCommand: ["/usr/bin/service-control", "stop"],
          startCommand: ["/usr/bin/service-control", "start"],
          healthUrl: "http://127.0.0.1:3000/api/health",
        },
        {
          runningScriptPath: previousActivationScript,
          runCommand: async () => commandCalls += 1,
        },
      ),
      /must run from the candidate release script/,
    );
    assert.equal(commandCalls, 0);
    assert.equal(
      inspectSqliteDatabase(sqlite).schemaVersion,
      migrationJournal.entries.at(-1).idx,
    );
    assert.equal(existsSync(join(appRoot, ".self-host-activate.lock")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("self-host activation lock rejects a contender before commands or database work", async () => {
  const root = temporaryRoot("open-fitness-self-host-lock-");
  const { appRoot, releaseId } = createReleaseTree(root);
  const data = join(root, "data");
  const backups = join(root, "backups");
  const sqlite = join(data, "fitness.sqlite");
  mkdirSync(data, { mode: 0o700 });
  mkdirSync(backups, { mode: 0o700 });
  createFixture(sqlite, migrationJournal.entries.at(-1).idx);
  const lockPath = join(appRoot, ".self-host-activate.lock");
  writeFileSync(lockPath, "held\n", { mode: 0o600 });
  let commandCalls = 0;

  try {
    await assert.rejects(
      activateSelfHostRelease(
        {
          appRoot,
          releaseId,
          sqlitePath: sqlite,
          backupDirectory: backups,
          stopCommand: ["/usr/bin/service-control", "stop"],
          startCommand: ["/usr/bin/service-control", "start"],
          healthUrl: "http://127.0.0.1:3000/api/health",
        },
        { runCommand: async () => commandCalls += 1 },
      ),
      /activation lock is already held/,
    );
    assert.equal(commandCalls, 0);
    assert.equal(inspectSqliteDatabase(sqlite).schemaVersion, migrationJournal.entries.at(-1).idx);
  } finally {
    if (existsSync(lockPath)) unlinkSync(lockPath);
    rmSync(root, { recursive: true, force: true });
  }
});
