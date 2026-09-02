import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

register("./helpers/typescript-alias-loader.mjs", import.meta.url);

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), "open-fitness-course-race-"));
const databasePath = join(temporaryRoot, "fitness.sqlite");
const apiToken = "training-course-hydration-race-token";

const initialized = spawnSync(
  process.execPath,
  [
    join(repositoryRoot, "scripts", "init-local-sqlite.mjs"),
    "--path",
    databasePath,
    "--goal",
    "Training course hydration race",
    "--cycle",
    "Push",
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
      id: "push",
      label: "Push",
      kind: "training",
      routine: [
        {
          id: "press",
          label: "Press",
          preferredExercise: "Synthetic Press",
          alternatives: [],
          targetSets: 2,
          targetReps: "8",
          targetEffort: "RIR 2-3",
        },
      ],
    },
  ],
});
const fixture = new DatabaseSync(databasePath);
fixture
  .prepare(
    `UPDATE profile
        SET training_cycle = 'Push', training_cycle_config = ?,
            goal_type = 'strength', setup_completed = 1,
            updated_at = '2099-01-01T00:00:00.000Z'`,
  )
  .run(cycle);
fixture
  .prepare(
    `UPDATE training_blocks
        SET goal_type = 'strength', training_cycle_snapshot = ?`,
  )
  .run(cycle);
fixture
  .prepare(
    `INSERT INTO body_measurements (
       measurement_id, measured_at, local_date, source_device, source_file,
       weight_kg
     ) VALUES (
       'MEASUREMENT|COURSE|RACE', '2026-01-01T08:00:00.000Z', '2026-01-01',
       'test', 'test', 80
     )`,
  )
  .run();
fixture.close();

process.env.FITNESS_SQLITE_PATH = databasePath;
process.env.FITNESS_API_TOKEN = apiToken;

const courseRoute = await import(
  new URL("../app/api/fitness/training-course/route.ts", import.meta.url)
);
const { getDashboardData } = await import(
  new URL("../lib/fitness.ts", import.meta.url)
);
const { closeLocalDbForTests, getLocalClient } = await import(
  new URL("../db/local-sqlite.ts", import.meta.url)
);

function courseRequest(requestId, body) {
  return new Request("http://127.0.0.1/api/fitness/training-course", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
      "x-idempotency-key": requestId,
    },
    body: JSON.stringify(body),
  });
}

async function callCourse(requestId, body) {
  const response = await courseRoute.POST(courseRequest(requestId, body));
  return { response, body: await response.json() };
}

async function currentPayload(prescription) {
  const dashboard = await getDashboardData();
  const plan = dashboard.todayPlan;
  assert.ok(
    plan,
    JSON.stringify({ status: dashboard.status, warning: dashboard.warning }),
  );
  assert.equal(plan.phaseId, "push");
  const items = plan.items.filter(
    (item) => item.phaseId === plan.phaseId && item.slotId,
  );
  assert.equal(items.length, 1);
  return {
    scope: "date",
    phaseId: plan.phaseId,
    date: plan.planningDate,
    expectedPlanFingerprint: plan.planFingerprint,
    items: items.map((item) => ({
      slotId: item.slotId,
      exercise: item.exerciseKey,
      prescription,
      loadGuidance: "Synthetic load",
      effort: "RIR 2-3",
    })),
  };
}

async function runAfterNextCommit(afterCommit, operation) {
  const client = getLocalClient();
  const originalTransaction = client.transaction;
  let armed = true;
  client.transaction = async function (...args) {
    const transaction = await originalTransaction.apply(client, args);
    if (armed) {
      const originalCommit = transaction.commit;
      transaction.commit = async function (...commitArgs) {
        await originalCommit.apply(transaction, commitArgs);
        if (armed) {
          armed = false;
          await afterCommit();
        }
      };
    }
    return transaction;
  };
  try {
    return await operation();
  } finally {
    client.transaction = originalTransaction;
  }
}

async function runAtSameTransactionStart(operations) {
  const client = getLocalClient();
  const originalTransaction = client.transaction;
  let arrivals = 0;
  let releaseFirst;
  const secondArrived = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let releaseSecond;
  const firstCommitted = new Promise((resolve) => {
    releaseSecond = resolve;
  });
  client.transaction = async function (...args) {
    const arrival = arrivals;
    arrivals += 1;
    if (arrival === 0) {
      await secondArrived;
      const transaction = await originalTransaction.apply(client, args);
      const originalCommit = transaction.commit;
      transaction.commit = async function (...commitArgs) {
        await originalCommit.apply(transaction, commitArgs);
        releaseSecond();
      };
      return transaction;
    }
    releaseFirst();
    await firstCommitted;
    return originalTransaction.apply(client, args);
  };
  try {
    return await Promise.all(operations.map((operation) => operation()));
  } finally {
    client.transaction = originalTransaction;
  }
}

function scalar(sql, ...parameters) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(sql).get(...parameters)?.value;
  } finally {
    database.close();
  }
}

function execute(sql) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
}

after(async () => {
  await closeLocalDbForTests();
  if (existsSync(`${databasePath}-shm`)) unlinkSync(`${databasePath}-shm`);
  if (existsSync(`${databasePath}-wal`)) unlinkSync(`${databasePath}-wal`);
  if (existsSync(databasePath)) unlinkSync(databasePath);
  rmdirSync(temporaryRoot);
});

test("training course response stays bound to its committed batch after a newer batch", async () => {
  const firstPayload = await currentPayload("2 x 8 first");
  let laterResult;
  const initial = await runAfterNextCommit(
    async () => {
      const laterPayload = await currentPayload("2 x 8 later");
      laterResult = await callCourse("course-later-batch", laterPayload);
    },
    () => callCourse("course-first-batch", firstPayload),
  );

  assert.equal(initial.response.status, 201);
  assert.equal(initial.body.records.length, 1);
  assert.equal(initial.body.records[0].prescription, "2 x 8 first");
  assert.equal(initial.body.records[0].lifecycle, "superseded");
  assert.equal(typeof initial.body.planFingerprint, "string");
  assert.equal(laterResult.response.status, 201);
  assert.equal(laterResult.body.records[0].prescription, "2 x 8 later");
  assert.equal(laterResult.body.records[0].lifecycle, "active");
  const currentDashboard = await getDashboardData();
  assert.equal(
    laterResult.body.planFingerprint,
    currentDashboard.todayPlan.planFingerprint,
  );
  assert.notEqual(
    initial.body.planFingerprint,
    laterResult.body.planFingerprint,
  );
});

test("concurrent identical training course requests create one durable batch", async () => {
  const payload = await currentPayload("2 x 8 concurrent");
  const requestId = "course-concurrent-same-request";
  const results = await runAtSameTransactionStart([
    () => callCourse(requestId, payload),
    () => callCourse(requestId, payload),
  ]);

  assert.deepEqual(
    results.map((result) => result.response.status).sort(),
    [200, 201],
  );
  assert.deepEqual(
    results.map((result) => result.body.replay ?? false).sort(),
    [false, true],
  );
  assert.equal(results[0].body.overrideBatchId, results[1].body.overrideBatchId);
  assert.equal(results[0].body.planFingerprint, results[1].body.planFingerprint);
  assert.deepEqual(
    Object.keys(results[0].body).sort(),
    Object.keys(results[1].body).sort(),
  );
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM audit_log
        WHERE request_id = ? AND entity_type = 'training_course_override'`,
      requestId,
    ),
    1,
  );
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM audit_log
        WHERE request_id = ?
          AND entity_type = 'training_course_override_result'
          AND entity_id = ?`,
      requestId,
      results[0].body.planFingerprint,
    ),
    1,
  );
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM training_exercise_selections
        WHERE override_batch_id = ?`,
      results[0].body.overrideBatchId,
    ),
    1,
  );

  const currentDashboard = await getDashboardData();
  assert.equal(
    results[0].body.planFingerprint,
    currentDashboard.todayPlan.planFingerprint,
  );

  const changedPayload = await currentPayload("2 x 9 conflict");
  const conflict = await callCourse(requestId, changedPayload);
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.errorCode, "IDEMPOTENCY_KEY_CONFLICT");
});

test("concurrent distinct requests cannot both consume one plan fingerprint", async () => {
  const prescription = "2 x 8 distinct request race";
  const seedPayload = await currentPayload(prescription);
  const seed = await callCourse("course-distinct-race-seed", seedPayload);
  assert.equal(seed.response.status, 201);
  const payload = await currentPayload(prescription);
  assert.equal(payload.expectedPlanFingerprint, seed.body.planFingerprint);
  const requestIds = [
    "course-concurrent-distinct-first",
    "course-concurrent-distinct-second",
  ];
  const results = await runAtSameTransactionStart(
    requestIds.map((requestId) => () => callCourse(requestId, payload)),
  );

  assert.deepEqual(
    results.map((result) => result.response.status).sort(),
    [201, 409],
  );
  const success = results.find((result) => result.response.status === 201);
  const conflict = results.find((result) => result.response.status === 409);
  assert.ok(success);
  assert.ok(conflict);
  assert.equal(success.body.replay, false);
  assert.equal(success.body.records.length, 1);
  assert.equal(success.body.records[0].active, true);
  assert.equal(success.body.records[0].lifecycle, "active");
  assert.equal(success.body.planFingerprint, payload.expectedPlanFingerprint);
  assert.equal(conflict.body.errorCode, "TRAINING_COURSE_CONFLICT");
  assert.equal("replay" in conflict.body, false);
  assert.equal("overrideBatchId" in conflict.body, false);
  assert.equal("records" in conflict.body, false);

  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM audit_log
        WHERE request_id IN (?, ?)
          AND entity_type = 'training_course_override'`,
      ...requestIds,
    ),
    1,
  );
  assert.equal(
    scalar(
      `SELECT COUNT(DISTINCT selections.override_batch_id) AS value
         FROM training_exercise_selections AS selections
         JOIN audit_log AS writes
           ON writes.entity_id = selections.override_batch_id
        WHERE writes.request_id IN (?, ?)
          AND writes.entity_type = 'training_course_override'`,
      ...requestIds,
    ),
    1,
  );
  assert.equal(
    scalar(
      `SELECT override_batch_id AS value
         FROM training_exercise_selections
        WHERE phase_id = ? AND scope = 'date' AND scope_value = ?
          AND slot_id = ?
        ORDER BY recorded_at DESC, selection_id DESC
        LIMIT 1`,
      payload.phaseId,
      payload.date,
      payload.items[0].slotId,
    ),
    success.body.overrideBatchId,
  );

  const currentDashboard = await getDashboardData();
  assert.equal(
    success.body.planFingerprint,
    currentDashboard.todayPlan.planFingerprint,
  );
});

test("a failed course transaction leaves its generation available for retry", async () => {
  const payload = await currentPayload("2 x 8 forced rollback");
  const requestId = "course-forced-rollback";
  const beforeRows = scalar(
    `SELECT COUNT(*) AS value FROM training_exercise_selections`,
  );
  execute(`CREATE TRIGGER reject_training_course_test
    BEFORE INSERT ON training_exercise_selections
    WHEN NEW.prescription_override = '2 x 8 forced rollback'
    BEGIN
      SELECT RAISE(ABORT, 'forced training course rollback');
    END`);
  let failed;
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    failed = await callCourse(requestId, payload);
  } finally {
    console.error = originalConsoleError;
    execute(`DROP TRIGGER reject_training_course_test`);
  }

  assert.equal(failed.response.status, 500);
  assert.equal(
    scalar(`SELECT COUNT(*) AS value FROM training_exercise_selections`),
    beforeRows,
  );
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM audit_log WHERE request_id = ?`,
      requestId,
    ),
    0,
  );
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM sqlite_master
        WHERE type = 'trigger' AND name = 'reject_training_course_test'`,
    ),
    0,
  );
  await closeLocalDbForTests();

  const retry = await callCourse(requestId, payload);
  assert.equal(retry.response.status, 201);
  assert.equal(retry.body.replay, false);
  assert.equal(retry.body.records[0].active, true);
});
