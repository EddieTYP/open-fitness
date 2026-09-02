import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  OPEN_FITNESS_DATABASE_NAME,
  OPEN_FITNESS_DEFAULT_TIMEZONE,
} from "../db/schema-identity.mjs";
import { FRESH_INSTALL_DEFAULT_APP_LOCALE } from "../lib/i18n/locales.ts";

const initCliPath = fileURLToPath(
  new URL("../scripts/init-local-sqlite.mjs", import.meta.url),
);

function temporaryRoot() {
  return realpathSync(mkdtempSync(join(tmpdir(), "open-fitness-clean-install-")));
}

function runInit(args) {
  return spawnSync(process.execPath, [initCliPath, ...args], {
    encoding: "utf8",
    env: {
      HOME: process.env.HOME,
      NODE_NO_WARNINGS: "1",
      PATH: process.env.PATH,
    },
  });
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("clean install creates one owner profile and no bundled health history", () => {
  const root = temporaryRoot();
  const dataDirectory = join(root, "data");
  const databasePath = join(dataDirectory, "fitness.sqlite");
  mkdirSync(dataDirectory, { mode: 0o700 });

  try {
    const result = runInit([
      "--path",
      databasePath,
      "--profile-id",
      "owner",
      "--goal",
      "General fitness",
      "--cycle",
      "Strength A / Strength B / Recovery",
      "--height-cm",
      "175",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      databaseFile: "fitness.sqlite",
      profileId: "owner",
      schemaVersion: 16,
    });
    assert.equal(lstatSync(databasePath).mode & 0o777, 0o600);

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const metadata = database.prepare("SELECT * FROM schema_metadata").get();
      assert.equal(metadata.schema_version, 16);
      assert.equal(metadata.database_name, OPEN_FITNESS_DATABASE_NAME);
      assert.equal(metadata.timezone, OPEN_FITNESS_DEFAULT_TIMEZONE);

      const storedProfile = database
        .prepare(
          `SELECT
            profile_id AS profileId,
            display_name AS displayName,
            primary_goal AS primaryGoal,
            goal_type AS goalType,
            training_cycle AS trainingCycle,
            height_cm AS heightCm,
            setup_completed AS setupCompleted,
            timezone,
            preferred_locale AS preferredLocale
          FROM profile`,
        )
        .get();
      assert.deepEqual({ ...storedProfile }, {
        profileId: "owner",
        displayName: null,
        primaryGoal: "General fitness",
        goalType: null,
        trainingCycle: "Strength A / Strength B / Recovery",
        heightCm: 175,
        setupCompleted: 0,
        timezone: OPEN_FITNESS_DEFAULT_TIMEZONE,
        preferredLocale: FRESH_INSTALL_DEFAULT_APP_LOCALE,
      });

      const dataTables = database
        .prepare(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'table'
             AND name NOT LIKE 'sqlite_%'
             AND name NOT IN ('profile', 'schema_metadata')
           ORDER BY name`,
        )
        .all();
      for (const { name } of dataTables) {
        const count = database
          .prepare(`SELECT COUNT(*) AS value FROM "${name}"`)
          .get().value;
        assert.equal(
          count,
          name === "training_blocks" ? 1 : 0,
          `${name} should start with only required owner setup state`,
        );
      }
      const initialBlock = database
        .prepare(
          `SELECT profile_id AS profileId, ends_on AS endsOn,
                  change_reason AS changeReason
           FROM training_blocks`,
        )
        .get();
      assert.deepEqual({ ...initialBlock }, {
        profileId: "owner",
        endsOn: null,
        changeReason: "Initial setup",
      });
      assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      database.close();
    }

    const originalHash = sha256(databasePath);
    const repeated = runInit([
      "--path",
      databasePath,
      "--goal",
      "Different goal",
      "--cycle",
      "Different cycle",
    ]);
    assert.notEqual(repeated.status, 0);
    assert.match(repeated.stderr, /already exists/);
    assert.equal(sha256(databasePath), originalHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clean install stores an explicitly selected timezone and locale", () => {
  const root = temporaryRoot();
  const databasePath = join(root, "selected.sqlite");

  try {
    const result = runInit([
      "--path",
      databasePath,
      "--goal",
      "General fitness",
      "--cycle",
      "Strength / Recovery",
      "--timezone",
      "America/Los_Angeles",
      "--locale",
      "zh-TW",
    ]);
    assert.equal(result.status, 0, result.stderr);

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.deepEqual(
        {
          ...database
            .prepare(
              `SELECT
                database_name AS databaseName,
                timezone
              FROM schema_metadata`,
            )
            .get(),
        },
        {
          databaseName: OPEN_FITNESS_DATABASE_NAME,
          timezone: "America/Los_Angeles",
        },
      );
      assert.deepEqual(
        {
          ...database
            .prepare(
              `SELECT
                timezone,
                preferred_locale AS preferredLocale
              FROM profile`,
            )
            .get(),
        },
        {
          timezone: "America/Los_Angeles",
          preferredLocale: "zh-TW",
        },
      );
    } finally {
      database.close();
    }

    const invalidTimezonePath = join(root, "invalid-timezone.sqlite");
    const invalidTimezone = runInit([
      "--path",
      invalidTimezonePath,
      "--goal",
      "General fitness",
      "--cycle",
      "Strength / Recovery",
      "--timezone",
      "Not/A_Zone",
    ]);
    assert.notEqual(invalidTimezone.status, 0);
    assert.match(invalidTimezone.stderr, /valid IANA timezone/i);
    assert.equal(existsSync(invalidTimezonePath), false);

    const invalidLocalePath = join(root, "invalid-locale.sqlite");
    const invalidLocale = runInit([
      "--path",
      invalidLocalePath,
      "--goal",
      "General fitness",
      "--cycle",
      "Strength / Recovery",
      "--locale",
      "en-US",
    ]);
    assert.notEqual(invalidLocale.status, 0);
    assert.match(invalidLocale.stderr, /Preferred locale must be one of/i);
    assert.equal(existsSync(invalidLocalePath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clean install rejects incomplete or invalid profile settings without residue", () => {
  const root = temporaryRoot();
  const missingCyclePath = join(root, "missing-cycle.sqlite");
  const invalidHeightPath = join(root, "invalid-height.sqlite");

  try {
    const missingCycle = runInit([
      "--path",
      missingCyclePath,
      "--goal",
      "General fitness",
    ]);
    assert.notEqual(missingCycle.status, 0);
    assert.match(missingCycle.stderr, /Training cycle is required/);
    assert.equal(existsSync(missingCyclePath), false);

    const invalidHeight = runInit([
      "--path",
      invalidHeightPath,
      "--goal",
      "General fitness",
      "--cycle",
      "Strength / Recovery",
      "--height-cm",
      "0",
    ]);
    assert.notEqual(invalidHeight.status, 0);
    assert.match(invalidHeight.stderr, /Height must be between 50 and 300 cm/);
    assert.equal(existsSync(invalidHeightPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("new-user docs expose a portable runtime and Agent Plugin path", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const environment = readFileSync(
    new URL("../.env.example", import.meta.url),
    "utf8",
  );
  const selfHosting = readFileSync(
    new URL("../docs/operations/SELF-HOSTING.md", import.meta.url),
    "utf8",
  );
  const mcpConfig = JSON.parse(
    readFileSync(new URL("../agent-plugin/mcp.json", import.meta.url), "utf8"),
  );

  assert.equal(
    packageJson.scripts["db:init:local"],
    "node scripts/init-local-sqlite.mjs",
  );
  assert.match(environment, /FITNESS_SQLITE_PATH=\/absolute\/path/);
  assert.match(environment, /FITNESS_OWNER_DISPLAY_NAME=Owner/);
  assert.match(
    environment,
    /FITNESS_RELEASE_ID=REPLACE_WITH_40_CHARACTER_GIT_COMMIT/,
  );
  assert.match(selfHosting, /does not\s+need Hermes/);
  assert.match(selfHosting, /refuses to overwrite an existing path/);
  assert.match(selfHosting, /defaults to English and `UTC`/);
  assert.match(selfHosting, /--timezone "Europe\/London"/);
  assert.match(selfHosting, /--locale "en"/);
  assert.deepEqual(Object.keys(mcpConfig.mcpServers), ["of"]);
  assert.equal(mcpConfig.mcpServers.of.command, "node");
  assert.deepEqual(mcpConfig.mcpServers.of.args, [
    "${PLUGIN_ROOT}/skills/open-fitness/scripts/fitness-mcp.mjs",
  ]);
  assert.equal(mcpConfig.mcpServers.of.cwd, "${PLUGIN_ROOT}");
  assert.equal("env" in mcpConfig.mcpServers.of, false);
});
