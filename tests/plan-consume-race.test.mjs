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
const temporaryRoot = mkdtempSync(join(tmpdir(), "open-fitness-plan-consume-"));
const databasePath = join(temporaryRoot, "fitness.sqlite");
const apiToken = "plan-consume-race-test-token";
const planId = "PLAN|CONSUME|RACE";

const initialized = spawnSync(
  process.execPath,
  [
    join(repositoryRoot, "scripts", "init-local-sqlite.mjs"),
    "--path",
    databasePath,
    "--goal",
    "Plan consumption race contract",
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
fixture
  .prepare(
    `INSERT INTO nutrition_meal_plans (
      plan_id, scheduled_date, meal_type, source, confidence, original_text,
      status, current_version_no, created_by, updated_at
    ) VALUES (
      ?, '2000-01-01', 'lunch', 'test', 'high', 'Synthetic planned lunch',
      'pending', 1, 'fixture', '2000-01-01T00:00:00.000Z'
    )`,
  )
  .run(planId);
fixture
  .prepare(
    `INSERT INTO nutrition_meal_plan_items (
      plan_item_id, plan_id, item_ordinal, item_name_snapshot, quantity,
      unit, energy_kcal, protein_g, confidence
    ) VALUES (?, ?, 1, 'Synthetic meal item', 100, 'g', 150, 12, 'high')`,
  )
  .run(`${planId}|V1|ITEM|1`, planId);
fixture.close();

process.env.FITNESS_SQLITE_PATH = databasePath;
process.env.FITNESS_API_TOKEN = apiToken;

const planRoute = await import(
  new URL("../app/api/nutrition/plans/route.ts", import.meta.url)
);
const { closeLocalDbForTests } = await import(
  new URL("../db/local-sqlite.ts", import.meta.url)
);

function consumeRequest(requestId) {
  return new Request("http://127.0.0.1/api/nutrition/plans", {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
      "x-idempotency-key": requestId,
    },
    body: JSON.stringify({
      action: "consume",
      planId,
      expectedVersionNo: 1,
    }),
  });
}

async function callConsume(requestId) {
  const response = await planRoute.PATCH(consumeRequest(requestId));
  return { requestId, response, body: await response.json() };
}

function scalar(sql, ...parameters) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(sql).get(...parameters)?.value;
  } finally {
    database.close();
  }
}

function storedPlan() {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT status, current_version_no AS versionNo,
                completed_meal_id AS mealId, consumed_at AS consumedAt
           FROM nutrition_meal_plans WHERE plan_id = ?`,
      )
      .get(planId);
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

test("concurrent plan consumption commits one meal and rolls back the loser", async () => {
  const results = await Promise.all([
    callConsume("plan-consume-race-a"),
    callConsume("plan-consume-race-b"),
  ]);
  assert.deepEqual(
    results.map((result) => result.response.status).sort(),
    [200, 409],
  );

  const winner = results.find((result) => result.response.status === 200);
  const loser = results.find((result) => result.response.status === 409);
  assert.ok(winner);
  assert.ok(loser);
  assert.equal(loser.body.errorCode, "PLAN_VERSION_CONFLICT");
  assert.equal(winner.body.replay, false);
  assert.equal(winner.body.versionNo, 2);
  assert.equal(winner.body.plan.planId, planId);
  assert.equal(winner.body.plan.status, "consumed");
  assert.equal(winner.body.plan.versionNo, 2);
  assert.equal(winner.body.plan.completedMealId, winner.body.mealId);
  assert.equal(winner.body.plan.items.length, 1);
  assert.equal(winner.body.nutrition.localDate, "2000-01-01");

  const plan = storedPlan();
  assert.equal(plan.status, "consumed");
  assert.equal(plan.versionNo, 2);
  assert.equal(plan.mealId, winner.body.mealId);
  assert.equal(typeof plan.consumedAt, "string");

  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM nutrition_meals
        WHERE source = 'site_planned_meal'`,
    ),
    1,
  );
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM nutrition_meal_revisions AS revision
        JOIN nutrition_meals AS meal ON meal.meal_id = revision.meal_id
        WHERE meal.source = 'site_planned_meal'`,
    ),
    1,
  );
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM nutrition_meal_items AS item
        JOIN nutrition_meal_revisions AS revision
          ON revision.meal_revision_id = item.meal_revision_id
        JOIN nutrition_meals AS meal ON meal.meal_id = revision.meal_id
        WHERE meal.source = 'site_planned_meal'`,
    ),
    1,
  );
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM audit_log
        WHERE operation = 'consume'
          AND entity_type = 'nutrition_plan'
          AND entity_id = ?`,
      planId,
    ),
    1,
  );
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM audit_log
        WHERE operation = 'insert_from_plan'
          AND entity_type = 'nutrition_meal'`,
    ),
    1,
  );
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM audit_log WHERE request_id = ?`,
      loser.requestId,
    ),
    0,
  );
});
