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
const temporaryRoot = mkdtempSync(join(tmpdir(), "open-fitness-plan-revise-"));
const databasePath = join(temporaryRoot, "fitness.sqlite");
const apiToken = "plan-revise-consume-race-test-token";
const planId = "PLAN|REVISE|CONSUME|RACE";

const initialized = spawnSync(
  process.execPath,
  [
    join(repositoryRoot, "scripts", "init-local-sqlite.mjs"),
    "--path",
    databasePath,
    "--goal",
    "Plan revise versus consume race contract",
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
      ?, '2000-01-01', 'lunch', 'test', 'high', 'Original planned lunch',
      'pending', 1, 'fixture', '2000-01-01T00:00:00.000Z'
    )`,
  )
  .run(planId);
fixture
  .prepare(
    `INSERT INTO nutrition_meal_plan_items (
      plan_item_id, plan_id, item_ordinal, item_name_snapshot, quantity,
      unit, energy_kcal, protein_g, confidence
    ) VALUES (?, ?, 1, 'Original plan item', 100, 'g', 150, 12, 'high')`,
  )
  .run(`${planId}|V1|ITEM|1`, planId);
fixture.close();

process.env.FITNESS_SQLITE_PATH = databasePath;
process.env.FITNESS_API_TOKEN = apiToken;

const planRoute = await import(
  new URL("../app/api/nutrition/plans/route.ts", import.meta.url)
);
const { closeLocalDbForTests, getLocalClient } = await import(
  new URL("../db/local-sqlite.ts", import.meta.url)
);

function patchRequest(requestId, body) {
  return new Request("http://127.0.0.1/api/nutrition/plans", {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
      "x-idempotency-key": requestId,
    },
    body: JSON.stringify(body),
  });
}

async function callPatch(requestId, body) {
  const response = await planRoute.PATCH(patchRequest(requestId, body));
  return { response, body: await response.json() };
}

async function runFirstTransactionBeforeSecond(firstOperation, secondOperation) {
  const client = getLocalClient();
  const originalTransaction = client.transaction;
  let arrivals = 0;
  let releaseFirstArrival;
  const firstArrived = new Promise((resolve) => {
    releaseFirstArrival = resolve;
  });
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
      releaseFirstArrival();
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
    const firstResult = firstOperation();
    await firstArrived;
    const secondResult = secondOperation();
    const results = await Promise.all([firstResult, secondResult]);
    assert.equal(arrivals, 2);
    return results;
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

function storedPlan() {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT status, current_version_no AS versionNo,
                completed_meal_id AS mealId
           FROM nutrition_meal_plans WHERE plan_id = ?`,
      )
      .get(planId);
  } finally {
    database.close();
  }
}

function storedItems() {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT plan_item_id AS planItemId, item_name_snapshot AS name,
                quantity, unit
           FROM nutrition_meal_plan_items
          WHERE plan_id = ? ORDER BY item_ordinal`,
      )
      .all(planId);
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

test("stale revise loses to consume without replacing plan items", async () => {
  const [consume, revise] = await runFirstTransactionBeforeSecond(
    () =>
      callPatch("plan-consume-winner", {
        action: "consume",
        planId,
        expectedVersionNo: 1,
      }),
    () =>
      callPatch("plan-revise-loser", {
        action: "revise",
        planId,
        expectedVersionNo: 1,
        originalText: "Stale revised lunch",
        items: [
          {
            name: "Stale replacement item",
            quantity: 250,
            unit: "g",
            nutrients: { energyKcal: 400, proteinG: 30 },
          },
        ],
      }),
  );

  assert.equal(consume.response.status, 200);
  assert.equal(consume.body.replay, false);
  assert.equal(consume.body.plan.status, "consumed");
  assert.equal(revise.response.status, 409);
  assert.equal(revise.body.errorCode, "PLAN_VERSION_CONFLICT");
  assert.deepEqual(
    { ...storedPlan() },
    {
      status: "consumed",
      versionNo: 2,
      mealId: consume.body.mealId,
    },
  );
  assert.deepEqual(
    storedItems().map((row) => ({ ...row })),
    [
      {
        planItemId: `${planId}|V1|ITEM|1`,
        name: "Original plan item",
        quantity: 100,
        unit: "g",
      },
    ],
  );
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM audit_log
        WHERE request_id = 'plan-revise-loser'`,
    ),
    0,
  );
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM audit_log
        WHERE request_id = 'plan-consume-winner'
          AND entity_type = 'nutrition_plan'`,
    ),
    1,
  );
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM nutrition_meals
        WHERE source = 'site_planned_meal'`,
    ),
    1,
  );
});
