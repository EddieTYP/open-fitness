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
const temporaryRoot = mkdtempSync(join(tmpdir(), "open-fitness-food-create-"));
const databasePath = join(temporaryRoot, "fitness.sqlite");
const apiToken = "food-create-race-token";

const initialized = spawnSync(
  process.execPath,
  [
    join(repositoryRoot, "scripts", "init-local-sqlite.mjs"),
    "--path",
    databasePath,
    "--goal",
    "Food creation idempotency race",
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

process.env.FITNESS_SQLITE_PATH = databasePath;
process.env.FITNESS_API_TOKEN = apiToken;

const foodRoute = await import(
  new URL("../app/api/nutrition/items/route.ts", import.meta.url),
);
const { closeLocalDbForTests, getLocalClient } = await import(
  new URL("../db/local-sqlite.ts", import.meta.url),
);

function foodRequest(requestId, body) {
  return new Request("http://127.0.0.1/api/nutrition/items", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
      "x-idempotency-key": requestId,
    },
    body: JSON.stringify(body),
  });
}

async function callFood(requestId, body) {
  const response = await foodRoute.POST(foodRequest(requestId, body));
  return { response, body: await response.json() };
}

async function runAtSameIdempotencyPreflight(operations) {
  const client = getLocalClient();
  const originalExecute = client.execute;
  let arrivals = 0;
  let release;
  const allArrived = new Promise((resolve) => {
    release = resolve;
  });
  client.execute = async function (...args) {
    const result = await originalExecute.apply(client, args);
    const statement = args[0];
    const sql = typeof statement === "string" ? statement : statement?.sql;
    if (
      arrivals < operations.length &&
      typeof sql === "string" &&
      /\baudit_log\b/i.test(sql)
    ) {
      arrivals += 1;
      if (arrivals === operations.length) release();
      await allArrived;
    }
    return result;
  };
  try {
    const results = await Promise.all(
      operations.map((operation) => operation()),
    );
    assert.equal(arrivals, operations.length);
    return results;
  } finally {
    client.execute = originalExecute;
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

function storedFood(foodId) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT f.food_id AS foodId,
                f.display_name AS displayName,
                f.brand,
                f.category,
                f.default_unit AS defaultUnit,
                v.base_quantity AS baseQuantity,
                v.energy_kcal AS energyKcal,
                v.protein_g AS proteinG
           FROM nutrition_foods f
           JOIN nutrition_food_versions v
             ON v.food_id = f.food_id AND v.version_no = 1
          WHERE f.food_id = ?`,
      )
      .get(foodId);
  } finally {
    database.close();
  }
}

function assertSingleMutation(requestId, foodId, displayName) {
  assert.equal(
    scalar(
      "SELECT COUNT(*) AS value FROM nutrition_foods WHERE display_name = ?",
      displayName,
    ),
    1,
  );
  assert.equal(
    scalar(
      "SELECT COUNT(*) AS value FROM nutrition_food_versions WHERE food_id = ?",
      foodId,
    ),
    1,
  );
  assert.equal(
    scalar(
      "SELECT COUNT(*) AS value FROM nutrition_food_aliases WHERE food_id = ?",
      foodId,
    ),
    1,
  );
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM audit_log
        WHERE request_id = ? AND entity_type = 'nutrition_food'`,
      requestId,
    ),
    1,
  );
}

function foodCountByCategory(category) {
  return scalar(
    "SELECT COUNT(*) AS value FROM nutrition_foods WHERE category = ?",
    category,
  );
}

after(async () => {
  await closeLocalDbForTests();
  if (existsSync(`${databasePath}-shm`)) unlinkSync(`${databasePath}-shm`);
  if (existsSync(`${databasePath}-wal`)) unlinkSync(`${databasePath}-wal`);
  if (existsSync(databasePath)) unlinkSync(databasePath);
  rmdirSync(temporaryRoot);
});

test("concurrent identical food creates persist once with a hydrated replay", async () => {
  const requestId = "food-create-concurrent-identical";
  const payload = {
    foodId: "FOOD|CREATE|CONCURRENT|IDENTICAL",
    displayName: "Concurrent Idempotent Food",
    brand: "Race Kitchen",
    category: "food-create-race-identical",
    baseQuantity: 125,
    baseUnit: "g",
    alias: "Concurrent Food Alias",
    sourceNote: "created exactly once",
    nutrients: { energyKcal: 240, proteinG: 18, carbsG: 30 },
  };

  const results = await runAtSameIdempotencyPreflight([
    () => callFood(requestId, payload),
    () => callFood(requestId, payload),
  ]);

  assert.deepEqual(
    results.map(({ response }) => response.status).sort(),
    [200, 201],
  );
  assert.deepEqual(
    results.map(({ body }) => body.replay).sort(),
    [false, true],
  );
  assert.equal(results[0].body.foodId, results[1].body.foodId);
  assert.deepEqual(results[0].body.item, results[1].body.item);

  const foodId = results[0].body.foodId;
  assert.deepEqual(
    { ...storedFood(foodId) },
    {
      foodId,
      displayName: payload.displayName,
      brand: payload.brand,
      category: payload.category,
      defaultUnit: payload.baseUnit,
      baseQuantity: payload.baseQuantity,
      energyKcal: payload.nutrients.energyKcal,
      proteinG: payload.nutrients.proteinG,
    },
  );
  assert.equal(results[0].body.item.versionNo, 1);
  assert.deepEqual(results[0].body.item.aliases, [payload.alias]);
  assertSingleMutation(requestId, foodId, payload.displayName);
  assert.equal(foodCountByCategory(payload.category), 1);
});

test("concurrent different food bodies reserve the request for one mutation", async () => {
  const requestId = "food-create-concurrent-conflict";
  const payload = {
    foodId: "FOOD|CREATE|CONCURRENT|CONFLICT|A",
    displayName: "Concurrent Conflicting Food A",
    brand: "Race Kitchen",
    category: "food-create-race-conflict",
    baseQuantity: 100,
    baseUnit: "g",
    alias: "Concurrent Conflict Alias",
    sourceNote: "one body wins",
    nutrients: { energyKcal: 180, proteinG: 12 },
  };

  const results = await runAtSameIdempotencyPreflight([
    () => callFood(requestId, payload),
    () =>
      callFood(requestId, {
        ...payload,
        foodId: "FOOD|CREATE|CONCURRENT|CONFLICT|B",
        displayName: "Concurrent Conflicting Food B",
        alias: "Concurrent Conflict Alias B",
        nutrients: { ...payload.nutrients, energyKcal: 181 },
      }),
  ]);

  assert.deepEqual(
    results.map(({ response }) => response.status).sort(),
    [201, 409],
  );
  const created = results.find(({ response }) => response.status === 201);
  const conflict = results.find(({ response }) => response.status === 409);
  assert.ok(created);
  assert.ok(conflict);
  assert.equal(created.body.replay, false);
  assert.equal(created.body.item.foodId, created.body.foodId);
  assert.equal(created.body.item.versionNo, 1);
  assert.equal(conflict.body.errorCode, "IDEMPOTENCY_KEY_CONFLICT");
  assertSingleMutation(
    requestId,
    created.body.foodId,
    created.body.item.displayName,
  );
  assert.equal(foodCountByCategory(payload.category), 1);
  assert.equal(
    storedFood(created.body.foodId)?.energyKcal,
    created.body.item.nutrients.energyKcal,
  );
});
