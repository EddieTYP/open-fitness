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
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

register("./helpers/typescript-alias-loader.mjs", import.meta.url);

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), "open-fitness-noop-idempotency-"));
const databasePath = join(temporaryRoot, "fitness.sqlite");
const apiToken = "noop-idempotency-test-token";

const initialized = spawnSync(
  process.execPath,
  [
    join(repositoryRoot, "scripts", "init-local-sqlite.mjs"),
    "--path",
    databasePath,
    "--goal",
    "No-op idempotency contract",
    "--cycle",
    "Leg,Push,Pull,Rest",
    "--timezone",
    "Asia/Hong_Kong",
    "--locale",
    "zh-HK",
  ],
  { encoding: "utf8" },
);
assert.equal(initialized.status, 0, initialized.stderr);

const fixture = new DatabaseSync(databasePath);
fixture.exec(`
  INSERT INTO workout_sessions (
    session_id, source, session_title, session_type, started_at, ended_at,
    duration_seconds, total_sets_reported, started_at_utc, local_date,
    time_precision, voided_at, void_reason, voided_by
  ) VALUES
    (
      'WORKOUT|ACTIVE', 'test', 'Active workout', 'strength',
      '2099-01-01T10:00:00+08:00', '2099-01-01T11:00:00+08:00',
      3600, 0, '2099-01-01T02:00:00.000Z', '2099-01-01', 'exact',
      NULL, NULL, NULL
    ),
    (
      'WORKOUT|VOID', 'test', 'Voided workout', 'strength',
      '2099-01-02T10:00:00+08:00', '2099-01-02T11:00:00+08:00',
      3600, 0, '2099-01-02T02:00:00.000Z', '2099-01-02', 'exact',
      '2099-01-03T00:00:00.000Z', 'fixture', 'fixture'
    );

  INSERT INTO nutrition_meals (
    meal_id, local_date, eaten_at, time_precision, meal_type, context_tag,
    original_meal_type, source, confidence, current_revision_no, created_by
  ) VALUES
    (
      'MEAL|CLASSIFICATION', '2099-01-01', NULL, 'date_only', 'lunch',
      NULL, NULL, 'test', 'high', 1, 'fixture'
    ),
    (
      'MEAL|QUANTITY', '2099-01-02', NULL, 'date_only', 'lunch',
      NULL, NULL, 'test', 'high', 1, 'fixture'
    );

  INSERT INTO nutrition_meal_revisions (
    meal_revision_id, meal_id, revision_no, energy_kcal, protein_g, created_by
  ) VALUES
    ('MEAL|CLASSIFICATION|REV|1', 'MEAL|CLASSIFICATION', 1, 100, 10, 'fixture'),
    ('MEAL|QUANTITY|REV|1', 'MEAL|QUANTITY', 1, 100, 10, 'fixture');

  INSERT INTO nutrition_meal_items (
    meal_item_id, meal_revision_id, item_ordinal, item_name_snapshot,
    quantity, unit, energy_kcal, protein_g, confidence
  ) VALUES
    (
      'MEAL|CLASSIFICATION|REV|1|ITEM|1',
      'MEAL|CLASSIFICATION|REV|1', 1, 'Classification item',
      100, 'g', 100, 10, 'high'
    ),
    (
      'MEAL|QUANTITY|REV|1|ITEM|1',
      'MEAL|QUANTITY|REV|1', 1, 'Quantity item',
      100, 'g', 100, 10, 'high'
    );
`);
fixture.close();

process.env.FITNESS_SQLITE_PATH = databasePath;
process.env.FITNESS_API_TOKEN = apiToken;

const workoutRoute = await import(
  new URL("../app/api/fitness/workout-sessions/route.ts", import.meta.url)
);
const mealRoute = await import(
  new URL("../app/api/nutrition/meals/route.ts", import.meta.url)
);
const { closeLocalDbForTests } = await import(
  new URL("../db/local-sqlite.ts", import.meta.url)
);

function patchRequest(path, requestId, body) {
  return new Request(`http://127.0.0.1${path}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
      "x-idempotency-key": requestId,
    },
    body: JSON.stringify(body),
  });
}

function postRequest(path, requestId, body) {
  return new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
      "x-idempotency-key": requestId,
    },
    body: JSON.stringify(body),
  });
}

async function callPatch(route, path, requestId, body) {
  const response = await route.PATCH(patchRequest(path, requestId, body));
  return { response, body: await response.json() };
}

async function callPost(route, path, requestId, body) {
  const response = await route.POST(postRequest(path, requestId, body));
  return { response, body: await response.json() };
}

function scalar(sql, ...parameters) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(sql).get(...parameters)?.value;
  } finally {
    database.close();
  }
}

function workoutVoidedAt(sessionId) {
  return scalar(
    "SELECT voided_at AS value FROM workout_sessions WHERE session_id = ?",
    sessionId,
  );
}

function mealState(mealId) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT meal_type AS mealType, context_tag AS contextTag,
                original_meal_type AS originalMealType,
                current_revision_no AS revisionNo
           FROM nutrition_meals WHERE meal_id = ?`,
      )
      .get(mealId);
  } finally {
    database.close();
  }
}

function auditCount(requestId, entityType) {
  return scalar(
    `SELECT COUNT(*) AS value FROM audit_log
      WHERE request_id = ? AND entity_type = ?`,
    requestId,
    entityType,
  );
}

after(async () => {
  await closeLocalDbForTests();
  if (existsSync(`${databasePath}-shm`)) unlinkSync(`${databasePath}-shm`);
  if (existsSync(`${databasePath}-wal`)) unlinkSync(`${databasePath}-wal`);
  if (existsSync(databasePath)) unlinkSync(databasePath);
  rmdirSync(temporaryRoot);
});

test("already-restored workout binds the no-op request before later state changes", async () => {
  const requestId = "workout-restored-noop";
  const payload = {
    action: "restore",
    sessionId: "WORKOUT|ACTIVE",
    reason: "Already active",
  };

  const initial = await Promise.all([
    callPatch(
      workoutRoute,
      "/api/fitness/workout-sessions",
      requestId,
      payload,
    ),
    callPatch(
      workoutRoute,
      "/api/fitness/workout-sessions",
      requestId,
      payload,
    ),
  ]);
  assert.deepEqual(
    initial.map(({ response }) => response.status).sort(),
    [200, 200],
  );
  assert.deepEqual(
    initial.map(({ body }) => body.replay).sort(),
    [false, true],
  );
  assert.ok(initial.every(({ body }) => body.noOp === true));
  assert.equal(workoutVoidedAt(payload.sessionId), null);
  assert.equal(auditCount(requestId, "workout_session"), 1);

  const replay = await callPatch(
    workoutRoute,
    "/api/fitness/workout-sessions",
    requestId,
    payload,
  );
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.replay, true);
  assert.equal(auditCount(requestId, "workout_session"), 1);

  const conflict = await callPatch(
    workoutRoute,
    "/api/fitness/workout-sessions",
    requestId,
    { ...payload, reason: "Different canonical body" },
  );
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.errorCode, "IDEMPOTENCY_KEY_CONFLICT");

  const changed = await callPatch(
    workoutRoute,
    "/api/fitness/workout-sessions",
    "workout-restored-later-void",
    { ...payload, action: "void", reason: "Later state change" },
  );
  assert.equal(changed.response.status, 200);
  assert.equal(changed.body.requestId, "workout-restored-later-void");
  assert.equal(changed.body.replay, false);
  const changedVoidedAt = workoutVoidedAt(payload.sessionId);
  assert.equal(typeof changedVoidedAt, "string");

  const replayAfterChange = await callPatch(
    workoutRoute,
    "/api/fitness/workout-sessions",
    requestId,
    payload,
  );
  assert.equal(replayAfterChange.body.replay, true);
  assert.equal(workoutVoidedAt(payload.sessionId), changedVoidedAt);
  assert.equal(auditCount(requestId, "workout_session"), 1);
});

test("already-voided workout binds the no-op request before later state changes", async () => {
  const requestId = "workout-voided-noop";
  const payload = {
    action: "void",
    sessionId: "WORKOUT|VOID",
    reason: "Already voided",
  };
  const originalVoidedAt = workoutVoidedAt(payload.sessionId);

  const initial = await Promise.all([
    callPatch(
      workoutRoute,
      "/api/fitness/workout-sessions",
      requestId,
      payload,
    ),
    callPatch(
      workoutRoute,
      "/api/fitness/workout-sessions",
      requestId,
      payload,
    ),
  ]);
  assert.deepEqual(
    initial.map(({ response }) => response.status).sort(),
    [200, 200],
  );
  assert.deepEqual(
    initial.map(({ body }) => body.replay).sort(),
    [false, true],
  );
  assert.ok(initial.every(({ body }) => body.noOp === true));
  assert.equal(workoutVoidedAt(payload.sessionId), originalVoidedAt);
  assert.equal(auditCount(requestId, "workout_session"), 1);

  const replay = await callPatch(
    workoutRoute,
    "/api/fitness/workout-sessions",
    requestId,
    payload,
  );
  assert.equal(replay.body.replay, true);
  assert.equal(auditCount(requestId, "workout_session"), 1);

  const conflict = await callPatch(
    workoutRoute,
    "/api/fitness/workout-sessions",
    requestId,
    { ...payload, reason: "Different canonical body" },
  );
  assert.equal(conflict.response.status, 409);

  const changed = await callPatch(
    workoutRoute,
    "/api/fitness/workout-sessions",
    "workout-voided-later-restore",
    { ...payload, action: "restore", reason: "Later state change" },
  );
  assert.equal(changed.response.status, 200);
  assert.equal(changed.body.requestId, "workout-voided-later-restore");
  assert.equal(changed.body.replay, false);
  assert.equal(workoutVoidedAt(payload.sessionId), null);

  const replayAfterChange = await callPatch(
    workoutRoute,
    "/api/fitness/workout-sessions",
    requestId,
    payload,
  );
  assert.equal(replayAfterChange.body.replay, true);
  assert.equal(workoutVoidedAt(payload.sessionId), null);
  assert.equal(auditCount(requestId, "workout_session"), 1);
});

test("unchanged meal classification binds the no-op request before later revisions", async () => {
  const requestId = "meal-classification-noop";
  const payload = {
    action: "classification",
    mealId: "MEAL|CLASSIFICATION",
    expectedRevisionNo: 1,
    mealType: "lunch",
  };

  const initial = await Promise.all([
    callPatch(mealRoute, "/api/nutrition/meals", requestId, payload),
    callPatch(mealRoute, "/api/nutrition/meals", requestId, payload),
  ]);
  assert.deepEqual(
    initial.map(({ response }) => response.status).sort(),
    [200, 200],
  );
  assert.deepEqual(
    initial.map(({ body }) => body.replay).sort(),
    [false, true],
  );
  assert.ok(initial.every(({ body }) => body.unchanged === true));
  assert.equal(mealState(payload.mealId).revisionNo, 1);
  assert.equal(auditCount(requestId, "nutrition_meal"), 1);

  const replay = await callPatch(
    mealRoute,
    "/api/nutrition/meals",
    requestId,
    payload,
  );
  assert.equal(replay.body.replay, true);
  assert.equal(auditCount(requestId, "nutrition_meal"), 1);

  const conflict = await callPatch(
    mealRoute,
    "/api/nutrition/meals",
    requestId,
    { ...payload, contextTag: "different" },
  );
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.errorCode, "IDEMPOTENCY_KEY_CONFLICT");

  const changed = await callPatch(
    mealRoute,
    "/api/nutrition/meals",
    "meal-classification-later-change",
    { ...payload, mealType: "dinner" },
  );
  assert.equal(changed.response.status, 200);
  assert.deepEqual({ ...mealState(payload.mealId) }, {
    mealType: "dinner",
    contextTag: null,
    originalMealType: null,
    revisionNo: 2,
  });

  const replayAfterChange = await callPatch(
    mealRoute,
    "/api/nutrition/meals",
    requestId,
    payload,
  );
  assert.equal(replayAfterChange.body.replay, true);
  assert.equal(replayAfterChange.body.revisionNo, 1);
  assert.equal(
    replayAfterChange.body.nutrition.meals.find(
      (meal) => meal.mealId === payload.mealId,
    ).mealType,
    "lunch",
  );
  assert.equal(mealState(payload.mealId).mealType, "dinner");
  assert.equal(mealState(payload.mealId).revisionNo, 2);
  assert.equal(auditCount(requestId, "nutrition_meal"), 1);
});

test("unchanged meal quantity binds the no-op request before later revisions", async () => {
  const requestId = "meal-quantity-noop";
  const payload = {
    action: "quantity",
    mealId: "MEAL|QUANTITY",
    mealItemId: "MEAL|QUANTITY|REV|1|ITEM|1",
    expectedRevisionNo: 1,
    quantity: 100,
  };

  const initial = await Promise.all([
    callPatch(mealRoute, "/api/nutrition/meals", requestId, payload),
    callPatch(mealRoute, "/api/nutrition/meals", requestId, payload),
  ]);
  assert.deepEqual(
    initial.map(({ response }) => response.status).sort(),
    [200, 200],
  );
  assert.deepEqual(
    initial.map(({ body }) => body.replay).sort(),
    [false, true],
  );
  assert.ok(initial.every(({ body }) => body.unchanged === true));
  assert.equal(mealState(payload.mealId).revisionNo, 1);
  assert.equal(auditCount(requestId, "nutrition_meal"), 1);

  const replay = await callPatch(
    mealRoute,
    "/api/nutrition/meals",
    requestId,
    payload,
  );
  assert.equal(replay.body.replay, true);
  assert.equal(auditCount(requestId, "nutrition_meal"), 1);

  const conflict = await callPatch(
    mealRoute,
    "/api/nutrition/meals",
    requestId,
    { ...payload, quantity: 99 },
  );
  assert.equal(conflict.response.status, 409);

  const changed = await callPatch(
    mealRoute,
    "/api/nutrition/meals",
    "meal-quantity-later-change",
    { ...payload, quantity: 80 },
  );
  assert.equal(changed.response.status, 200);
  assert.equal(mealState(payload.mealId).revisionNo, 2);

  const replayAfterChange = await callPatch(
    mealRoute,
    "/api/nutrition/meals",
    requestId,
    payload,
  );
  assert.equal(replayAfterChange.body.replay, true);
  assert.equal(replayAfterChange.body.revisionNo, 1);
  assert.equal(
    replayAfterChange.body.nutrition.meals.find(
      (meal) => meal.mealId === payload.mealId,
    ).items[0].quantity,
    100,
  );
  assert.equal(mealState(payload.mealId).revisionNo, 2);
  assert.equal(auditCount(requestId, "nutrition_meal"), 1);
});

test("meal create replay reads its original revision after a later update", async () => {
  const requestId = "meal-create-historical-replay";
  const payload = {
    mealId: "MEAL|HISTORICAL",
    localDate: "2099-01-03",
    timePrecision: "date_only",
    mealType: "lunch",
    source: "test",
    confidence: "high",
    items: [
      {
        name: "Historical food",
        quantity: 100,
        unit: "g",
        nutrients: { energyKcal: 100, proteinG: 10 },
      },
    ],
  };
  const created = await callPost(
    mealRoute,
    "/api/nutrition/meals",
    requestId,
    payload,
  );
  assert.equal(created.response.status, 201);
  assert.equal(created.body.revisionNo, 1);

  const changed = await callPatch(
    mealRoute,
    "/api/nutrition/meals",
    "meal-create-historical-later-change",
    {
      action: "classification",
      mealId: payload.mealId,
      expectedRevisionNo: 1,
      mealType: "dinner",
    },
  );
  assert.equal(changed.response.status, 200);
  assert.equal(changed.body.revisionNo, 2);

  const replay = await callPost(
    mealRoute,
    "/api/nutrition/meals",
    requestId,
    payload,
  );
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.revisionNo, 1);
  assert.equal(replay.body.mealType, "lunch");
  const historical = replay.body.nutrition.meals.find(
    (meal) => meal.mealId === payload.mealId,
  );
  assert.equal(historical.revisionNo, 1);
  assert.equal(historical.mealType, "lunch");
  assert.equal(historical.items[0].name, "Historical food");
});
