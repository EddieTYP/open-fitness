import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const journal = JSON.parse(
  readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
);

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function applyMigration(database, entry) {
  const sql = source(`drizzle/${entry.tag}.sql`);
  for (const statement of sql
    .split("--> statement-breakpoint")
    .map((value) => value.trim())
    .filter(Boolean)) {
    database.exec(statement);
  }
}

function migratedDatabase(lastIndex = Number.POSITIVE_INFINITY) {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const entry of journal.entries.filter((value) => value.idx <= lastIndex)) {
    applyMigration(database, entry);
  }
  return database;
}

test("migration canonicalises synthetic legacy timestamps without owner data", () => {
  const database = migratedDatabase(6);
  const insertSession = database.prepare(`
    INSERT INTO workout_sessions (
      session_id, source, session_title, session_type, started_at, ended_at,
      duration_seconds, total_sets_reported
    ) VALUES (?, 'Motra', ?, 'Strength', ?, ?, 60, 1)
  `);
  const syntheticId = "SYNTHETIC|2099-01-15T11:00:00Z|A";
  insertSession.run(
    syntheticId,
    "Synthetic strength session",
    "2099-01-15T11:00:00Z",
    "2099-01-15T11:01:00Z",
  );
  const insertSet = database.prepare(`
    INSERT INTO workout_sets (
      set_id, session_id, exercise, set_no_session, set_no_exercise,
      weight_kg_reported, reps, source_file
    ) VALUES (?, ?, 'Synthetic Press', 1, 1, 20, 10, 'synthetic-fixture')
  `);
  insertSet.run("synthetic-set", syntheticId);

  applyMigration(database, journal.entries.find((entry) => entry.idx === 7));

  const rows = database
    .prepare(
      "SELECT session_id, started_at_utc, local_date, voided_at FROM workout_sessions WHERE session_id = ?",
    )
    .all(syntheticId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].started_at_utc, "2099-01-15T11:00:00.000Z");
  assert.equal(rows[0].local_date, "2099-01-15");
  assert.equal(rows[0].voided_at, null);
  assert.equal(
    database
      .prepare(
        "SELECT count(*) AS value FROM audit_log WHERE entity_id = ?",
      )
      .get(syntheticId).value,
    0,
  );
  assert.equal(
    database
      .prepare(
        "SELECT strength_sessions AS value FROM v_daily_training WHERE activity_date = '2099-01-15'",
      )
      .get().value,
    1,
  );
  assert.equal(
    database.prepare("SELECT count(*) AS value FROM v_exercise_session_summary WHERE session_id = ?").get(syntheticId).value,
    1,
  );
  assert.equal(
    database.prepare("SELECT count(*) AS value FROM v_session_volume_reconciliation WHERE session_id = ?").get(syntheticId).value,
    1,
  );
  assert.equal(
    database.prepare("SELECT session_id FROM v_latest_strength_session").get().session_id,
    syntheticId,
  );
  assert.equal(
    database.prepare("SELECT count(*) AS value FROM workout_sets WHERE session_id = ?").get(syntheticId).value,
    1,
  );
  assert.equal(
    database.prepare("SELECT count(*) AS value FROM pragma_foreign_key_check").get().value,
    0,
  );
  assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  database.close();
});

test("workout schema identifies active sessions by canonical instant", () => {
  const database = migratedDatabase();
  assert.equal(
    database
      .prepare(
        "SELECT count(*) AS value FROM workout_sessions WHERE started_at_utc IS NULL OR local_date IS NULL",
      )
      .get().value,
    0,
  );

  const insert = database.prepare(`
    INSERT INTO workout_sessions (
      session_id, source, session_title, session_type, started_at,
      started_at_utc, local_date, ended_at, time_precision,
      duration_seconds, total_sets_reported
    ) VALUES (?, 'test', 'Test', 'Strength', ?, ?, '2031-01-15',
      '2031-01-15T20:00:00+08:00', 'minute', 3600, 1)
  `);
  insert.run(
    "canonical-a",
    "2031-01-15T19:00:00+08:00",
    "2031-01-15T11:00:00.000Z",
  );
  assert.throws(
    () =>
      insert.run(
        "canonical-b",
        "2031-01-15T11:00:00Z",
        "2031-01-15T11:00:00.000Z",
      ),
    /UNIQUE constraint failed/,
  );

  database
    .prepare(
      "UPDATE workout_sessions SET voided_at = '2031-01-16T00:00:00.000Z' WHERE session_id = 'canonical-a'",
    )
    .run();
  insert.run(
    "canonical-b",
    "2031-01-15T11:00:00Z",
    "2031-01-15T11:00:00.000Z",
  );
  assert.equal(
    database
      .prepare(
        "SELECT strength_sessions AS value FROM v_daily_training WHERE activity_date = '2031-01-15'",
      )
      .get().value,
    1,
  );
  database.close();
});

test("training plan migration assigns legacy workouts to one normal block", () => {
  const database = migratedDatabase(14);
  database
    .prepare(
      `INSERT INTO profile (
        profile_id, primary_goal, goal_type, training_cycle,
        training_cycle_config, timezone, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "synthetic-owner",
      "Synthetic general fitness",
      "strength",
      "Leg / Push / Pull",
      JSON.stringify({ version: 1, phases: [] }),
      "UTC",
      "2099-04-01T00:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO workout_sessions (
        session_id, source, training_phase_id, session_title, session_type,
        started_at, started_at_utc, local_date, ended_at, time_precision,
        duration_seconds, total_sets_reported
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
    )
    .run(
      "synthetic-session",
      "synthetic",
      "leg",
      "Synthetic Leg",
      "Strength",
      "2099-04-01T10:00:00.000Z",
      "2099-04-01T10:00:00.000Z",
      "2099-04-01",
      "2099-04-01T11:00:00.000Z",
      "exact",
      3600,
      1,
    );
  database
    .prepare(
      `INSERT INTO workout_sets (
        set_id, session_id, exercise, set_no_session, set_no_exercise,
        weight_kg_reported, reps, source_file
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)` ,
    )
    .run(
      "synthetic-set",
      "synthetic-session",
      "Synthetic Squat",
      1,
      1,
      50,
      10,
      "synthetic",
    );

  applyMigration(database, journal.entries.find((entry) => entry.idx === 15));

  const block = database
    .prepare(
      `SELECT block_id AS blockId, profile_id AS profileId, ends_on AS endsOn
       FROM training_blocks`,
    )
    .get();
  assert.equal(block.profileId, "synthetic-owner");
  assert.equal(block.endsOn, null);
  assert.deepEqual(
    {
      ...database
        .prepare(
          `SELECT session_intent AS sessionIntent,
                  training_block_id AS trainingBlockId
           FROM workout_sessions WHERE session_id = 'synthetic-session'`,
        )
        .get(),
    },
    { sessionIntent: "normal", trainingBlockId: block.blockId },
  );
  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS value FROM workout_sets WHERE session_id = 'synthetic-session'",
      )
      .get().value,
    1,
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});

test("workout API rejects guessing and exposes a recoverable write contract", () => {
  const route = source("app/api/fitness/workout-sessions/route.ts");
  const normaliser = source("lib/workout-records.ts");

  assert.match(normaliser, /assertKnownFields\(payload, WORKOUT_INPUT_FIELDS/);
  assert.match(normaliser, /assertKnownFields\(set, WORKOUT_SET_INPUT_FIELDS/);
  assert.match(normaliser, /startedAtUtc: start\.toISOString\(\)/);
  assert.match(normaliser, /timePrecision !== "minute"/);
  assert.match(normaliser, /sets.*is required and must be an array/);
  assert.match(normaliser, /must be a finite JSON number/);
  assert.match(normaliser, /setNoSession.*must equal/);
  assert.match(normaliser, /setNoExercise.*must equal/);
  assert.match(normaliser, /Every POST requires x-idempotency-key/);
  const workoutFields = normaliser.match(
    /WORKOUT_INPUT_FIELDS = \[([\s\S]*?)\] as const/,
  )?.[1];
  assert.ok(workoutFields);
  assert.doesNotMatch(workoutFields, /sessionTitle|sessionType/);

  assert.match(route, /requiredIdempotencyKey\(request\)/);
  assert.match(route, /findIdempotentReplay/);
  assert.match(route, /validateOnlyValue === "1"/);
  assert.match(route, /payloadSha256\(workout\)/);
  assert.match(route, /WorkoutValidationError/);
  assert.match(route, /export async function PATCH/);
  assert.match(route, /action !== "void" && action !== "restore"/);
  assert.match(route, /GET\(request: Request\)/);
  assert.match(route, /sessionId: workout\.sessionId/);
  assert.match(normaliser, /"trainingPhaseId"/);
  assert.match(normaliser, /"trainingBlockId"/);
  assert.match(normaliser, /"endedAt"/);
  assert.match(normaliser, /"totalSetsReported"/);
  assert.match(normaliser, /"sessionIntent"/);
  assert.match(normaliser, /sessionIntent: "normal"/);
  assert.match(normaliser, /lowercase stable identifier/);
  assert.match(route, /trainingPhaseId: workout\.trainingPhaseId/);
  assert.match(route, /trainingBlockId: activeBlock\.blockId/);
  assert.match(route, /must identify the active training block/);
  assert.match(normaliser, /must equal startedAt plus durationSeconds/);
  assert.match(normaliser, /must equal canonical set count/);
  assert.match(route, /workout\.sessionIntent === "normal"/);
  assert.match(route, /consumedBySessionId: workout\.sessionId/);
  assert.match(route, /inferSessionTrainingPhaseId/);
  assert.match(route, /must identify a phase in the current training cycle/);
});

test("MCP deterministically canonicalises grouped workout sets", () => {
  const connector = source("agent-plugin/skills/open-fitness/scripts/fitness-mcp.mjs");
  assert.match(connector, /cannot contain both sets and exercises/);
  assert.match(connector, /\["weightKg", "weightKgReported"\]/);
  assert.match(connector, /\["setNumber", "setNoExercise"\]/);
  assert.match(connector, /exerciseName/);
  assert.match(connector, /\{ \.\.\.rawSet, exercise \}/);
  assert.match(connector, /delete normalised\.exercises/);
  assert.match(connector, /has conflicting exercise/);
  assert.match(connector, /\["sessionTitle", "title"\]/);
  assert.match(connector, /\["sessionType", "type"\]/);
});

test("default analysis, dashboard and migration exclude voided workouts", () => {
  const analysis = source("app/api/fitness/analysis/route.ts");
  const dashboard = source("lib/fitness.ts");
  const migration = source("drizzle/0007_empty_obadiah_stane.sql");

  assert.match(analysis, /localDateRange\(workoutSessions\.localDate\)/);
  assert.match(analysis, /isNull\(workoutSessions\.voidedAt\)/);
  assert.match(dashboard, /isNull\(workoutSessions\.voidedAt\)/);
  assert.match(migration, /started_at_utc.*strftime/s);
  assert.doesNotMatch(migration, /production probe|PROBE4|MOTRA\|2026/i);
  assert.match(migration, /WHERE voided_at IS NULL/);
  assert.match(migration, /workout_sessions_started_at_utc_active_uq/);
});
