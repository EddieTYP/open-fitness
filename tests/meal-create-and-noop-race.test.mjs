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
const temporaryRoot = mkdtempSync(join(tmpdir(), "open-fitness-meal-races-"));
const databasePath = join(temporaryRoot, "fitness.sqlite");
const apiToken = "meal-race-test-token";

const initialized = spawnSync(
  process.execPath,
  [
    join(repositoryRoot, "scripts", "init-local-sqlite.mjs"),
    "--path",
    databasePath,
    "--goal",
    "Meal idempotency race contract",
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
  INSERT INTO nutrition_meals (
    meal_id, local_date, time_precision, meal_type, source, confidence,
    current_revision_no, created_by
  ) VALUES
    ('MEAL|RACE|CLASS', '2099-02-01', 'date_only', 'lunch', 'test', 'high', 1, 'fixture'),
    ('MEAL|RACE|QUANTITY', '2099-02-02', 'date_only', 'lunch', 'test', 'high', 1, 'fixture');

  INSERT INTO nutrition_meal_revisions (
    meal_revision_id, meal_id, revision_no, energy_kcal, protein_g, created_by
  ) VALUES
    ('MEAL|RACE|CLASS|REV|1', 'MEAL|RACE|CLASS', 1, 100, 10, 'fixture'),
    ('MEAL|RACE|QUANTITY|REV|1', 'MEAL|RACE|QUANTITY', 1, 100, 10, 'fixture');

  INSERT INTO nutrition_meal_items (
    meal_item_id, meal_revision_id, item_ordinal, item_name_snapshot,
    quantity, unit, energy_kcal, protein_g, confidence
  ) VALUES
    ('MEAL|RACE|CLASS|REV|1|ITEM|1', 'MEAL|RACE|CLASS|REV|1', 1,
      'Classification item', 100, 'g', 100, 10, 'high'),
    ('MEAL|RACE|QUANTITY|REV|1|ITEM|1', 'MEAL|RACE|QUANTITY|REV|1', 1,
      'Quantity item', 100, 'g', 100, 10, 'high');
`);
fixture.close();

process.env.FITNESS_SQLITE_PATH = databasePath;
process.env.FITNESS_API_TOKEN = apiToken;

const mealRoute = await import(
  new URL("../app/api/nutrition/meals/route.ts", import.meta.url),
);
const { closeLocalDbForTests } = await import(
  new URL("../db/local-sqlite.ts", import.meta.url),
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

async function callPost(requestId, body) {
  const response = await mealRoute.POST(request("POST", requestId, body));
  return { response, body: await response.json() };
}

async function callPatch(requestId, body) {
  const response = await mealRoute.PATCH(request("PATCH", requestId, body));
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

function mealCount(mealId) {
  return scalar(
    "SELECT COUNT(*) AS value FROM nutrition_meals WHERE meal_id = ?",
    mealId,
  );
}

function auditCount(requestId) {
  return scalar(
    `SELECT COUNT(*) AS value FROM audit_log
      WHERE request_id = ? AND entity_type = 'nutrition_meal'`,
    requestId,
  );
}

function mealFromNutrition(body, mealId) {
  return body.nutrition.meals.find((meal) => meal.mealId === mealId);
}

function afterTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

after(async () => {
  await closeLocalDbForTests();
  if (existsSync(`${databasePath}-shm`)) unlinkSync(`${databasePath}-shm`);
  if (existsSync(`${databasePath}-wal`)) unlinkSync(`${databasePath}-wal`);
  if (existsSync(databasePath)) unlinkSync(databasePath);
  rmdirSync(temporaryRoot);
});

test("concurrent meal creation reserves one idempotent record", async () => {
  const requestId = "meal-create-race-request";
  const payload = {
    localDate: "2099-02-03",
    timePrecision: "date_only",
    mealType: "lunch",
    source: "test",
    confidence: "high",
    items: [
      {
        name: "Race food",
        quantity: 100,
        unit: "g",
        nutrients: { energyKcal: 100, proteinG: 10 },
      },
    ],
  };

  const results = await Promise.all([
    callPost(requestId, payload),
    callPost(requestId, payload),
  ]);
  assert.deepEqual(
    results.map(({ response }) => response.status).sort(),
    [200, 201],
  );
  const created = results.find(({ response }) => response.status === 201);
  const replay = results.find(({ response }) => response.status === 200);
  assert.ok(created);
  assert.ok(replay);
  assert.equal(created.body.replay, false);
  assert.equal(replay.body.replay, true);
  assert.equal(replay.body.mealId, created.body.mealId);
  assert.equal(mealCount(created.body.mealId), 1);
  assert.equal(auditCount(requestId), 1);

  const conflict = await callPost(requestId, {
    ...payload,
    items: [
      {
        ...payload.items[0],
        quantity: 101,
      },
    ],
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.errorCode, "IDEMPOTENCY_KEY_CONFLICT");
  assert.equal(auditCount(requestId), 1);
});

test("classification no-op is either committed before or rejected by an opposite revision", async () => {
  const noOpRequestId = "meal-classification-noop-race";
  const noOpPayload = {
    action: "classification",
    mealId: "MEAL|RACE|CLASS",
    expectedRevisionNo: 1,
    mealType: "lunch",
  };
  const oppositePayload = { ...noOpPayload, mealType: "dinner" };

  const noOpPromise = callPatch(noOpRequestId, noOpPayload);
  await afterTurn();
  const oppositePromise = callPatch(
    "meal-classification-opposite",
    oppositePayload,
  );
  const [noOp, opposite] = await Promise.all([noOpPromise, oppositePromise]);

  assert.equal(opposite.response.status, 200);
  if (noOp.response.status === 200) {
    assert.equal(noOp.body.unchanged, true);
    assert.equal(noOp.body.revisionNo, 1);
    assert.equal(mealFromNutrition(noOp.body, noOpPayload.mealId).mealType, "lunch");
    const replay = await callPatch(noOpRequestId, noOpPayload);
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.replay, true);
    assert.equal(replay.body.revisionNo, 1);
    assert.equal(mealFromNutrition(replay.body, noOpPayload.mealId).mealType, "lunch");
  } else {
    assert.equal(noOp.body.errorCode, "MEAL_REVISION_CONFLICT");
  }
});

test("quantity no-op is either committed before or rejected by an opposite revision", async () => {
  const noOpRequestId = "meal-quantity-noop-race";
  const noOpPayload = {
    action: "quantity",
    mealId: "MEAL|RACE|QUANTITY",
    mealItemId: "MEAL|RACE|QUANTITY|REV|1|ITEM|1",
    expectedRevisionNo: 1,
    quantity: 100,
  };
  const oppositePayload = { ...noOpPayload, quantity: 80 };

  const noOpPromise = callPatch(noOpRequestId, noOpPayload);
  await afterTurn();
  const oppositePromise = callPatch(
    "meal-quantity-opposite",
    oppositePayload,
  );
  const [noOp, opposite] = await Promise.all([noOpPromise, oppositePromise]);

  assert.equal(opposite.response.status, 200);
  if (noOp.response.status === 200) {
    assert.equal(noOp.body.unchanged, true);
    assert.equal(noOp.body.revisionNo, 1);
    assert.equal(
      mealFromNutrition(noOp.body, noOpPayload.mealId).items[0].quantity,
      100,
    );
    const replay = await callPatch(noOpRequestId, noOpPayload);
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.replay, true);
    assert.equal(replay.body.revisionNo, 1);
    assert.equal(
      mealFromNutrition(replay.body, noOpPayload.mealId).items[0].quantity,
      100,
    );
  } else {
    assert.equal(noOp.body.errorCode, "MEAL_REVISION_CONFLICT");
  }
});
