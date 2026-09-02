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
const temporaryRoot = mkdtempSync(join(tmpdir(), "open-fitness-meal-revision-"));
const databasePath = join(temporaryRoot, "fitness.sqlite");
const apiToken = "meal-revision-replay-race-token";
const mealFixtures = [
  ["MEAL|REVISION|HISTORY", 1],
  ["MEAL|REVISION|QUANTITY|SAME", 1],
  ["MEAL|REVISION|PATCH|RACE", 1],
  ["MEAL|REVISION|APPEND|SAME", 1],
  ["MEAL|REVISION|DELETE|SAME", 1],
  ["MEAL|REVISION|DELETE|RACE", 2],
];

const initialized = spawnSync(
  process.execPath,
  [
    join(repositoryRoot, "scripts", "init-local-sqlite.mjs"),
    "--path",
    databasePath,
    "--goal",
    "Meal revision replay and race contract",
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
const insertMeal = fixture.prepare(
  `INSERT INTO nutrition_meals (
    meal_id, local_date, time_precision, meal_type, source, confidence,
    current_revision_no, created_by, updated_at
  ) VALUES (?, ?, 'date_only', 'lunch', 'test', 'high', 1, 'fixture',
    '2000-01-01T00:00:00.000Z')`,
);
const insertRevision = fixture.prepare(
  `INSERT INTO nutrition_meal_revisions (
    meal_revision_id, meal_id, revision_no, original_text, energy_kcal,
    protein_g, created_by
  ) VALUES (?, ?, 1, ?, ?, ?, 'fixture')`,
);
const insertItem = fixture.prepare(
  `INSERT INTO nutrition_meal_items (
    meal_item_id, meal_revision_id, item_ordinal, item_name_snapshot,
    quantity, unit, energy_kcal, protein_g, confidence
  ) VALUES (?, ?, ?, ?, 100, 'g', 100, 10, 'high')`,
);
for (const [index, [mealId, itemCount]] of mealFixtures.entries()) {
  const localDate = `2000-01-${String(index + 1).padStart(2, "0")}`;
  const mealRevisionId = `${mealId}|REV|1`;
  insertMeal.run(mealId, localDate);
  insertRevision.run(
    mealRevisionId,
    mealId,
    `Original meal ${index + 1}`,
    itemCount * 100,
    itemCount * 10,
  );
  for (let itemIndex = 1; itemIndex <= itemCount; itemIndex += 1) {
    insertItem.run(
      `${mealRevisionId}|ITEM|${itemIndex}`,
      mealRevisionId,
      itemIndex,
      `Meal ${index + 1} item ${itemIndex}`,
    );
  }
}
fixture.exec(`
  INSERT INTO nutrition_foods (
    food_id, display_name, normalized_name, default_unit, is_active, source,
    original_label, current_version_no, updated_at
  ) VALUES (
    'FOOD|REVISION|APPEND', 'Append fixture', 'append fixture', 'g', 1,
    'test', 'Append fixture', 1, '2000-01-01T00:00:00.000Z'
  );
  INSERT INTO nutrition_food_versions (
    food_version_id, food_id, version_no, base_quantity, base_unit,
    energy_kcal, protein_g, effective_from
  ) VALUES (
    'FOOD|REVISION|APPEND|V1', 'FOOD|REVISION|APPEND', 1, 100, 'g',
    250, 25, '2000-01-01'
  );
`);
fixture.close();

process.env.FITNESS_SQLITE_PATH = databasePath;
process.env.FITNESS_API_TOKEN = apiToken;

const mealRoute = await import(
  new URL("../app/api/nutrition/meals/route.ts", import.meta.url)
);
const { closeLocalDbForTests } = await import(
  new URL("../db/local-sqlite.ts", import.meta.url)
);

function request(method, requestId, body) {
  return new Request("http://127.0.0.1/api/nutrition/meals", {
    method,
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
      "x-idempotency-key": requestId,
    },
    body: JSON.stringify(body),
  });
}

async function call(method, requestId, body) {
  const response = await mealRoute[method](request(method, requestId, body));
  return { response, body: await response.json() };
}

function readRow(sql, ...parameters) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(sql).get(...parameters);
  } finally {
    database.close();
  }
}

function scalar(sql, ...parameters) {
  return readRow(sql, ...parameters)?.value;
}

function mealState(mealId) {
  return readRow(
    `SELECT meal_type AS mealType, current_revision_no AS revisionNo,
            voided_at AS voidedAt
       FROM nutrition_meals WHERE meal_id = ?`,
    mealId,
  );
}

function mealFromResponse(body, mealId) {
  return body.nutrition.meals.find((meal) => meal.mealId === mealId);
}

function auditCount(requestId, entityType) {
  return scalar(
    `SELECT COUNT(*) AS value FROM audit_log
      WHERE request_id = ? AND entity_type = ?`,
    requestId,
    entityType,
  );
}

function totalAuditCount(requestIds, entityType) {
  return requestIds.reduce(
    (total, requestId) => total + auditCount(requestId, entityType),
    0,
  );
}

function revisionCount(mealId) {
  return scalar(
    `SELECT COUNT(*) AS value FROM nutrition_meal_revisions WHERE meal_id = ?`,
    mealId,
  );
}

function revisionItemCount(mealId, revisionNo) {
  return scalar(
    `SELECT COUNT(*) AS value FROM nutrition_meal_items
      WHERE meal_revision_id = ?`,
    `${mealId}|REV|${revisionNo}`,
  );
}

function revisionItemQuantity(mealId, revisionNo, ordinal = 1) {
  return scalar(
    `SELECT quantity AS value FROM nutrition_meal_items
      WHERE meal_revision_id = ? AND item_ordinal = ?`,
    `${mealId}|REV|${revisionNo}`,
    ordinal,
  );
}

after(async () => {
  await closeLocalDbForTests();
  if (existsSync(`${databasePath}-shm`)) unlinkSync(`${databasePath}-shm`);
  if (existsSync(`${databasePath}-wal`)) unlinkSync(`${databasePath}-wal`);
  if (existsSync(databasePath)) unlinkSync(databasePath);
  rmdirSync(temporaryRoot);
});

test("classification replay returns its exact committed revision after a quantity revision", async () => {
  const mealId = "MEAL|REVISION|HISTORY";
  const requestId = "meal-classification-history";
  const payload = {
    action: "classification",
    mealId,
    expectedRevisionNo: 1,
    mealType: "dinner",
  };
  const initial = await call("PATCH", requestId, payload);
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body.replay, false);
  assert.equal(initial.body.revisionNo, 2);
  assert.equal(mealFromResponse(initial.body, mealId).mealType, "dinner");
  assert.equal(mealFromResponse(initial.body, mealId).items[0].quantity, 100);

  const quantity = await call("PATCH", "meal-classification-later-quantity", {
    action: "quantity",
    mealId,
    mealItemId: `${mealId}|REV|2|ITEM|1`,
    expectedRevisionNo: 2,
    quantity: 150,
  });
  assert.equal(quantity.response.status, 200);
  assert.equal(quantity.body.revisionNo, 3);
  assert.equal(revisionItemQuantity(mealId, 3), 150);

  const replay = await call("PATCH", requestId, payload);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.replay, true);
  assert.equal(replay.body.unchanged, false);
  assert.equal(replay.body.revisionNo, 2);
  assert.equal(mealFromResponse(replay.body, mealId).mealType, "dinner");
  assert.equal(mealFromResponse(replay.body, mealId).items[0].quantity, 100);
  assert.equal(mealState(mealId).revisionNo, 3);
  assert.equal(revisionCount(mealId), 3);
  assert.equal(auditCount(requestId, "nutrition_meal"), 1);
  assert.equal(auditCount(requestId, "nutrition_meal_revision"), 1);

  const conflict = await call("PATCH", requestId, {
    ...payload,
    mealType: "breakfast",
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.errorCode, "IDEMPOTENCY_KEY_CONFLICT");
  assert.equal(revisionCount(mealId), 3);
});

test("same-key quantity race commits one revision and replays the other request", async () => {
  const mealId = "MEAL|REVISION|QUANTITY|SAME";
  const requestId = "meal-quantity-same-key";
  const payload = {
    action: "quantity",
    mealId,
    mealItemId: `${mealId}|REV|1|ITEM|1`,
    expectedRevisionNo: 1,
    quantity: 75,
  };
  const results = await Promise.all([
    call("PATCH", requestId, payload),
    call("PATCH", requestId, payload),
  ]);
  assert.deepEqual(
    results.map((result) => result.response.status),
    [200, 200],
  );
  assert.deepEqual(
    results.map((result) => result.body.replay).sort(),
    [false, true],
  );
  for (const result of results) {
    assert.equal(result.body.revisionNo, 2);
    assert.equal(result.body.unchanged, false);
    assert.equal(mealFromResponse(result.body, mealId).items[0].quantity, 75);
  }
  assert.equal(mealState(mealId).revisionNo, 2);
  assert.equal(revisionCount(mealId), 2);
  assert.equal(revisionItemCount(mealId, 2), 1);
  assert.equal(auditCount(requestId, "nutrition_meal"), 1);
  assert.equal(auditCount(requestId, "nutrition_meal_revision"), 1);

  const conflict = await call("PATCH", requestId, {
    ...payload,
    quantity: 76,
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.errorCode, "IDEMPOTENCY_KEY_CONFLICT");
  assert.equal(revisionCount(mealId), 2);
});

test("distinct PATCH writers resolve as one revision and one stable conflict", async () => {
  const mealId = "MEAL|REVISION|PATCH|RACE";
  const requestIds = ["meal-patch-race-class", "meal-patch-race-quantity"];
  const results = await Promise.all([
    call("PATCH", requestIds[0], {
      action: "classification",
      mealId,
      expectedRevisionNo: 1,
      mealType: "dinner",
    }),
    call("PATCH", requestIds[1], {
      action: "quantity",
      mealId,
      mealItemId: `${mealId}|REV|1|ITEM|1`,
      expectedRevisionNo: 1,
      quantity: 80,
    }),
  ]);
  assert.deepEqual(
    results.map((result) => result.response.status).sort(),
    [200, 409],
  );
  const loser = results.find((result) => result.response.status === 409);
  assert.equal(loser.body.errorCode, "MEAL_REVISION_CONFLICT");
  assert.equal(mealState(mealId).revisionNo, 2);
  assert.equal(revisionCount(mealId), 2);
  assert.equal(revisionItemCount(mealId, 2), 1);
  assert.equal(totalAuditCount(requestIds, "nutrition_meal"), 1);
  assert.equal(totalAuditCount(requestIds, "nutrition_meal_revision"), 1);
});

test("same-key append race commits one food addition", async () => {
  const mealId = "MEAL|REVISION|APPEND|SAME";
  const requestId = "meal-append-same-key";
  const payload = {
    action: "append_food",
    mealId,
    foodId: "FOOD|REVISION|APPEND",
    expectedRevisionNo: 1,
    quantity: 50,
  };
  const results = await Promise.all([
    call("PATCH", requestId, payload),
    call("PATCH", requestId, payload),
  ]);
  assert.deepEqual(
    results.map((result) => result.response.status),
    [200, 200],
  );
  assert.deepEqual(
    results.map((result) => result.body.replay).sort(),
    [false, true],
  );
  assert.ok(results.every((result) => result.body.revisionNo === 2));
  assert.equal(mealState(mealId).revisionNo, 2);
  assert.equal(revisionCount(mealId), 2);
  assert.equal(revisionItemCount(mealId, 2), 2);
  assert.equal(auditCount(requestId, "nutrition_meal"), 1);
  assert.equal(auditCount(requestId, "nutrition_meal_revision"), 1);
});

test("DELETE races commit at most one revision with replay or stable conflict", async () => {
  const sameMealId = "MEAL|REVISION|DELETE|SAME";
  const sameRequestId = "meal-delete-same-key";
  const samePayload = {
    mealId: sameMealId,
    deleteMeal: true,
    expectedRevisionNo: 1,
  };
  const sameResults = await Promise.all([
    call("DELETE", sameRequestId, samePayload),
    call("DELETE", sameRequestId, samePayload),
  ]);
  assert.deepEqual(
    sameResults.map((result) => result.response.status),
    [200, 200],
  );
  assert.deepEqual(
    sameResults.map((result) => result.body.replay).sort(),
    [false, true],
  );
  assert.ok(sameResults.every((result) => result.body.revisionNo === 2));
  assert.ok(sameResults.every((result) => result.body.deletedMeal === true));
  assert.equal(mealState(sameMealId).revisionNo, 2);
  assert.equal(typeof mealState(sameMealId).voidedAt, "string");
  assert.equal(revisionCount(sameMealId), 2);
  assert.equal(auditCount(sameRequestId, "nutrition_meal"), 1);
  assert.equal(auditCount(sameRequestId, "nutrition_meal_revision"), 1);

  const sameConflict = await call("DELETE", sameRequestId, {
    ...samePayload,
    expectedRevisionNo: 2,
  });
  assert.equal(sameConflict.response.status, 409);
  assert.equal(sameConflict.body.errorCode, "IDEMPOTENCY_KEY_CONFLICT");

  const raceMealId = "MEAL|REVISION|DELETE|RACE";
  const raceRequestIds = ["meal-delete-race-a", "meal-delete-race-b"];
  const racePayload = {
    mealId: raceMealId,
    mealItemId: `${raceMealId}|REV|1|ITEM|1`,
    expectedRevisionNo: 1,
  };
  const raceResults = await Promise.all([
    call("DELETE", raceRequestIds[0], racePayload),
    call("DELETE", raceRequestIds[1], racePayload),
  ]);
  assert.deepEqual(
    raceResults.map((result) => result.response.status).sort(),
    [200, 409],
  );
  const loser = raceResults.find((result) => result.response.status === 409);
  assert.equal(loser.body.errorCode, "MEAL_REVISION_CONFLICT");
  assert.equal(mealState(raceMealId).revisionNo, 2);
  assert.equal(mealState(raceMealId).voidedAt, null);
  assert.equal(revisionCount(raceMealId), 2);
  assert.equal(revisionItemCount(raceMealId, 2), 1);
  assert.equal(totalAuditCount(raceRequestIds, "nutrition_meal"), 1);
  assert.equal(totalAuditCount(raceRequestIds, "nutrition_meal_revision"), 1);
});
