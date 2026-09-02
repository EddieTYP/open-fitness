import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

register("./helpers/typescript-alias-loader.mjs", import.meta.url);

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), "open-fitness-split-review-"));
const databasePath = join(temporaryRoot, "fitness.sqlite");
const initialized = spawnSync(
  process.execPath,
  [
    join(repositoryRoot, "scripts", "init-local-sqlite.mjs"),
    "--path",
    databasePath,
    "--goal",
    "Synthetic split-session review",
    "--cycle",
    "Pull",
    "--timezone",
    "Asia/Hong_Kong",
    "--locale",
    "zh-HK",
  ],
  { encoding: "utf8" },
);
assert.equal(initialized.status, 0, initialized.stderr);

const cycle = JSON.stringify({
  version: 2,
  phases: [
    {
      id: "pull",
      label: "Pull",
      kind: "training",
      routine: [],
    },
    {
      id: "push",
      label: "Push",
      kind: "training",
      routine: [],
    },
  ],
});
const fixture = new DatabaseSync(databasePath);
fixture
  .prepare(
    `UPDATE profile
        SET training_cycle = 'Pull,Push', training_cycle_config = ?,
            setup_completed = 1`,
  )
  .run(cycle);
fixture
  .prepare(`UPDATE training_blocks SET training_cycle_snapshot = ?`)
  .run(cycle);
const blockId = fixture
  .prepare(`SELECT block_id AS blockId FROM training_blocks LIMIT 1`)
  .get().blockId;

const insertSession = fixture.prepare(
  `INSERT INTO workout_sessions (
     session_id, source, session_intent, training_block_id, training_phase_id,
     session_title, session_type, started_at, started_at_utc, local_date,
     ended_at, time_precision, duration_seconds, total_sets_reported,
     total_tvl_kg_reported, venue_manual
   ) VALUES (?, 'synthetic-test', 'normal', ?, ?, ?, 'Strength', ?, ?, ?, ?,
             'exact', ?, ?, ?, ?)`,
);
const insertSet = fixture.prepare(
  `INSERT INTO workout_sets (
     set_id, session_id, exercise, set_no_session, set_no_exercise,
     weight_kg_reported, reps, source_file, reported_load_x_reps_kg
   ) VALUES (?, ?, ?, ?, 1, ?, ?, 'synthetic-test', ?)`,
);

function addSession({
  id,
  phase,
  title,
  startedAt,
  startedAtUtc,
  endedAt,
  durationSeconds,
  totalSets,
  volume,
  venue,
  sets,
}) {
  insertSession.run(
    id,
    blockId,
    phase,
    title,
    startedAt,
    startedAtUtc,
    startedAt.slice(0, 10),
    endedAt,
    durationSeconds,
    totalSets,
    volume,
    venue,
  );
  sets.forEach((set, index) => {
    insertSet.run(
      `${id}|${index + 1}`,
      id,
      set.exercise,
      index + 1,
      set.weight,
      set.reps,
      set.weight * set.reps,
    );
  });
}

addSession({
  id: "prior-pull",
  phase: "pull",
  title: "Pull Day",
  startedAt: "2026-08-21T18:00:00+08:00",
  startedAtUtc: "2026-08-21T10:00:00.000Z",
  endedAt: "2026-08-21T18:20:00+08:00",
  durationSeconds: 1200,
  totalSets: 5,
  volume: 1800,
  venue: "Company gym",
  sets: [{ exercise: "Pull-up", weight: 0, reps: 8 }],
});
addSession({
  id: "current-pull-first",
  phase: "pull",
  title: "Pull Day first session",
  startedAt: "2026-08-28T13:13:00+08:00",
  startedAtUtc: "2026-08-28T05:13:00.000Z",
  endedAt: "2026-08-28T13:29:00+08:00",
  durationSeconds: 960,
  totalSets: 6,
  volume: 2500,
  venue: "Company gym",
  sets: [
    { exercise: "Pull-up", weight: 0, reps: 10 },
    { exercise: "Lat Pulldown", weight: 60, reps: 8 },
  ],
});
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
  if (existsSync(`${databasePath}-shm`)) unlinkSync(`${databasePath}-shm`);
  if (existsSync(`${databasePath}-wal`)) unlinkSync(`${databasePath}-wal`);
  if (existsSync(databasePath)) unlinkSync(databasePath);
  rmdirSync(temporaryRoot);
});

test("single-session review keeps the compact existing shape", async () => {
  const dashboard = await getDashboardData();
  assert.equal(dashboard.latestStrength.totalSets, 6);
  assert.equal(dashboard.latestStrength.durationMinutes, 16);
  assert.equal(dashboard.latestReview.overview, null);
  assert.deepEqual(dashboard.latestReview.segments, []);
});

test("same-day matching sessions form one review and compare with the prior day", async () => {
  const database = new DatabaseSync(databasePath);
  try {
    const session = {
      id: "current-pull-second",
      phase: "pull",
      title: "Pull Day second session",
      startedAt: "2026-08-28T19:09:00+08:00",
      startedAtUtc: "2026-08-28T11:09:00.000Z",
      endedAt: "2026-08-28T19:25:00+08:00",
      durationSeconds: 960,
      totalSets: 7,
      volume: 2700,
      venue: "Wong Tai Sin",
      sets: [
        { exercise: "Seated Row", weight: 80, reps: 8 },
        { exercise: "Face Pull", weight: 25, reps: 12 },
      ],
    };
    database
      .prepare(
        `INSERT INTO workout_sessions (
           session_id, source, session_intent, training_block_id,
           training_phase_id, session_title, session_type, started_at,
           started_at_utc, local_date, ended_at, time_precision,
           duration_seconds, total_sets_reported, total_tvl_kg_reported,
           venue_manual
         ) VALUES (?, 'synthetic-test', 'normal', ?, ?, ?, 'Strength', ?, ?, ?,
                   ?, 'exact', ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        blockId,
        session.phase,
        session.title,
        session.startedAt,
        session.startedAtUtc,
        session.startedAt.slice(0, 10),
        session.endedAt,
        session.durationSeconds,
        session.totalSets,
        session.volume,
        session.venue,
      );
    session.sets.forEach((set, index) => {
      database
        .prepare(
          `INSERT INTO workout_sets (
             set_id, session_id, exercise, set_no_session, set_no_exercise,
             weight_kg_reported, reps, source_file, reported_load_x_reps_kg
           ) VALUES (?, ?, ?, ?, 1, ?, ?, 'synthetic-test', ?)`,
        )
        .run(
          `${session.id}|${index + 1}`,
          session.id,
          set.exercise,
          index + 1,
          set.weight,
          set.reps,
          set.weight * set.reps,
        );
    });
  } finally {
    database.close();
  }

  await closeLocalDbForTests();
  const dashboard = await getDashboardData();
  assert.equal(dashboard.latestStrength.title, "Pull");
  assert.equal(dashboard.latestStrength.durationMinutes, 32);
  assert.equal(dashboard.latestStrength.totalSets, 13);
  assert.equal(dashboard.latestStrength.totalVolumeKg, 5200);
  assert.equal(dashboard.latestReview.summary.key, "fitness.review.summary.multiSession");
  assert.deepEqual(dashboard.latestReview.summary.params, {
    exerciseCount: 4,
    setCount: 13,
  });
  assert.equal(dashboard.latestReview.overview.key, "fitness.review.multi.overview");
  assert.deepEqual(dashboard.latestReview.overview.params, {
    minutes: 32,
    sessionCount: 2,
    venueCount: 2,
  });
  assert.equal(dashboard.todayPlan.briefing[0].params.minutes, 32);
  assert.deepEqual(
    dashboard.latestReview.segments.map((segment) => ({
      id: segment.sessionId,
      venue: segment.venue.kind === "source" ? segment.venue.text : null,
      minutes: segment.durationMinutes,
      sets: segment.totalSets,
    })),
    [
      {
        id: "current-pull-first",
        venue: "Company gym",
        minutes: 16,
        sets: 6,
      },
      {
        id: "current-pull-second",
        venue: "Wong Tai Sin",
        minutes: 16,
        sets: 7,
      },
    ],
  );
  const assessment = dashboard.latestReview.sections.find(
    (section) => section.title === "assessment",
  );
  assert.equal(
    assessment.lines[1].key,
    "fitness.review.compare.bodyweightMore",
  );
});

test("a different phase on the same date is not merged", async () => {
  const database = new DatabaseSync(databasePath);
  try {
    database
      .prepare(
        `INSERT INTO workout_sessions (
           session_id, source, session_intent, training_block_id,
           training_phase_id, session_title, session_type, started_at,
           started_at_utc, local_date, ended_at, time_precision,
           duration_seconds, total_sets_reported, total_tvl_kg_reported,
           venue_manual
         ) VALUES (
           'current-push', 'synthetic-test', 'normal', ?, 'push', 'Push extra',
           'Strength', '2026-08-28T20:30:00+08:00',
           '2026-08-28T12:30:00.000Z', '2026-08-28',
           '2026-08-28T20:40:00+08:00', 'exact', 600, 2, 500, 'Home'
         )`,
      )
      .run(blockId);
    database
      .prepare(
        `INSERT INTO workout_sets (
           set_id, session_id, exercise, set_no_session, set_no_exercise,
           weight_kg_reported, reps, source_file, reported_load_x_reps_kg
         ) VALUES (
           'current-push|1', 'current-push', 'Synthetic Press', 1, 1,
           40, 8, 'synthetic-test', 320
         )`,
      )
      .run();
  } finally {
    database.close();
  }

  await closeLocalDbForTests();
  const dashboard = await getDashboardData();
  assert.equal(dashboard.latestStrength.title, "Push extra");
  assert.equal(dashboard.latestStrength.totalSets, 2);
  assert.equal(dashboard.latestReview.overview, null);
  assert.deepEqual(dashboard.latestReview.segments, []);
});
