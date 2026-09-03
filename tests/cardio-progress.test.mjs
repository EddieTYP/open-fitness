import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

register("./helpers/typescript-alias-loader.mjs", import.meta.url);

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), "open-fitness-cardio-progress-"));
const databasePath = join(temporaryRoot, "fitness.sqlite");
const initialized = spawnSync(
  process.execPath,
  [
    join(repositoryRoot, "scripts", "init-local-sqlite.mjs"),
    "--path",
    databasePath,
    "--goal",
    "General fitness",
    "--cycle",
    "Strength / Recovery",
    "--timezone",
    "Asia/Hong_Kong",
    "--locale",
    "zh-HK",
  ],
  { encoding: "utf8" },
);
assert.equal(initialized.status, 0, initialized.stderr);

const fixture = new DatabaseSync(databasePath);
const insertSession = fixture.prepare(
  `INSERT INTO workout_sessions (
     session_id, source, session_title, session_type, started_at,
     started_at_utc, local_date, ended_at, duration_seconds,
     total_sets_reported
   ) VALUES (?, 'synthetic-test', ?, ?, ?, ?, ?, ?, ?, ?)`,
);
insertSession.run(
  "strength-session",
  "Strength",
  "Strength",
  "2026-09-01T18:00:00+08:00",
  "2026-09-01T10:00:00.000Z",
  "2026-09-01",
  "2026-09-01T18:30:00+08:00",
  1800,
  1,
);
insertSession.run(
  "cardio-session-with-distance-set",
  "Indoor walk",
  "Cardio - Indoor Walk",
  "2026-09-02T19:43:00+08:00",
  "2026-09-02T11:43:00.000Z",
  "2026-09-02",
  "2026-09-02T20:18:50+08:00",
  2150,
  1,
);
const insertSet = fixture.prepare(
  `INSERT INTO workout_sets (
     set_id, session_id, exercise, set_no_session, set_no_exercise,
     distance_m, time_seconds, source_file
   ) VALUES (?, ?, ?, 1, 1, ?, ?, 'synthetic-test')`,
);
insertSet.run("strength-set", "strength-session", "Squat", null, null);
insertSet.run(
  "cardio-distance-set",
  "cardio-session-with-distance-set",
  "Indoor walk",
  1780,
  2150,
);
fixture.close();

process.env.FITNESS_SQLITE_PATH = databasePath;
const { getDashboardData } = await import(
  new URL("../lib/fitness.ts", import.meta.url)
);
const { closeLocalDbForTests } = await import(
  new URL("../db/local-sqlite.ts", import.meta.url)
);

after(async () => {
  await closeLocalDbForTests();
  if (existsSync(temporaryRoot)) rmSync(temporaryRoot, { recursive: true });
});

test("cardio sessions with metric sets remain cardio across projections", () => {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT
               strength_sessions AS strengthSessions,
               formal_cardio_sessions AS cardioSessions,
               formal_cardio_minutes AS cardioMinutes
             FROM v_daily_training
             WHERE activity_date = '2026-09-02'`,
          )
          .get(),
      },
      {
        strengthSessions: 0,
        cardioSessions: 1,
        cardioMinutes: 2150 / 60,
      },
    );
    assert.equal(
      database
        .prepare("SELECT session_id AS sessionId FROM v_latest_cardio_session")
        .get().sessionId,
      "cardio-session-with-distance-set",
    );
    assert.equal(
      database
        .prepare("SELECT session_id AS sessionId FROM v_latest_strength_session")
        .get().sessionId,
      "strength-session",
    );
  } finally {
    database.close();
  }
});

test("dashboard exposes cardio-set sessions in the trend and latest-cardio card", async () => {
  const dashboard = await getDashboardData();

  assert.equal(dashboard.latestCardio.title, "Indoor walk");
  assert.equal(dashboard.latestCardio.totalSets, 1);
  assert.deepEqual(dashboard.progress.series.cardio.points, [
    { date: "2026-09-02", value: 35.8 },
  ]);
});
