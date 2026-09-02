import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

register("./helpers/typescript-alias-loader.mjs", import.meta.url);

const {
  NutritionMeasureError,
  resolveRegisteredFoodMeasure,
  resolveRelativeNutritionMeasure,
} = await import(new URL("../lib/nutrition-measure.ts", import.meta.url));

test("registered food measures use the immutable version basis", () => {
  assert.deepEqual(
    resolveRegisteredFoodMeasure({
      quantity: 194,
      unit: "g",
      baseQuantity: 1,
      baseUnit: "100g",
    }),
    { quantity: 194, unit: "g", nutrientScale: 1.94 },
  );
  assert.deepEqual(
    resolveRegisteredFoodMeasure({
      quantity: 0.194,
      unit: "kg",
      baseQuantity: 1,
      baseUnit: "100g",
    }),
    { quantity: 0.194, unit: "kg", nutrientScale: 1.94 },
  );
});

test("omitted units preserve the legacy native-basis contract", () => {
  assert.deepEqual(
    resolveRegisteredFoodMeasure({
      quantity: 1.94,
      baseQuantity: 1,
      baseUnit: "100g",
    }),
    { quantity: 1.94, unit: "100g", nutrientScale: 1.94 },
  );
});

test("relative changes convert compatible units and reject incompatible ones", () => {
  assert.deepEqual(
    resolveRelativeNutritionMeasure({
      quantity: 0.2,
      unit: "kg",
      currentQuantity: 100,
      currentUnit: "g",
    }),
    { quantity: 0.2, unit: "kg", nutrientScale: 2 },
  );
  assert.throws(
    () =>
      resolveRegisteredFoodMeasure({
        quantity: 194,
        unit: "ml",
        baseQuantity: 1,
        baseUnit: "100g",
      }),
    NutritionMeasureError,
  );
  assert.throws(
    () =>
      resolveRegisteredFoodMeasure({
        quantity: 100000,
        unit: "kg",
        baseQuantity: 1,
        baseUnit: "100g",
      }),
    (error) =>
      error instanceof NutritionMeasureError &&
      error.errorCode === "NUTRITION_MEASURE_OUT_OF_RANGE",
  );
});

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), "open-fitness-measure-"));
const databasePath = join(temporaryRoot, "fitness.sqlite");
const apiToken = "nutrition-measure-test-token";

const initialized = spawnSync(
  process.execPath,
  [
    join(repositoryRoot, "scripts", "init-local-sqlite.mjs"),
    "--path",
    databasePath,
    "--goal",
    "Nutrition measure contract",
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
  INSERT INTO nutrition_foods (
    food_id, display_name, normalized_name, default_unit, is_active, source,
    current_version_no
  ) VALUES (
    'FOOD|RICE|100G', 'Synthetic rice', 'synthetic rice', '100g', 1, 'test', 1
  );
  INSERT INTO nutrition_food_versions (
    food_version_id, food_id, version_no, base_quantity, base_unit,
    energy_kcal, protein_g, carbs_g, total_fat_g, effective_from
  ) VALUES (
    'FOOD|RICE|100G|V1', 'FOOD|RICE|100G', 1, 1, '100g',
    130, 2.4, 28.7, 0.3, '2099-01-01'
  );
  INSERT INTO nutrition_foods (
    food_id, display_name, normalized_name, default_unit, is_active, source,
    current_version_no
  ) VALUES (
    'FOOD|MILK|100ML', 'Synthetic milk', 'synthetic milk', '100ml', 1, 'test', 1
  );
  INSERT INTO nutrition_food_versions (
    food_version_id, food_id, version_no, base_quantity, base_unit,
    energy_kcal, protein_g, carbs_g, total_fat_g, effective_from
  ) VALUES (
    'FOOD|MILK|100ML|V1', 'FOOD|MILK|100ML', 1, 1, '100ml',
    60, 3, 5, 3, '2099-01-01'
  );
`);
fixture.close();

process.env.FITNESS_SQLITE_PATH = databasePath;
process.env.FITNESS_API_TOKEN = apiToken;

const mealRoute = await import(
  new URL("../app/api/nutrition/meals/route.ts", import.meta.url)
);
const planRoute = await import(
  new URL("../app/api/nutrition/plans/route.ts", import.meta.url)
);
const comboRoute = await import(
  new URL("../app/api/nutrition/combos/route.ts", import.meta.url)
);
const { closeLocalDbForTests } = await import(
  new URL("../db/local-sqlite.ts", import.meta.url)
);
let explicitMealId;
let explicitMealItemId;

after(async () => {
  await closeLocalDbForTests();
  if (existsSync(`${databasePath}-shm`)) unlinkSync(`${databasePath}-shm`);
  if (existsSync(`${databasePath}-wal`)) unlinkSync(`${databasePath}-wal`);
  if (existsSync(databasePath)) unlinkSync(databasePath);
  rmdirSync(temporaryRoot);
});

test("meal API preserves an explicit reported unit and scales nutrients once", async () => {
  const response = await mealRoute.POST(
    new Request("http://127.0.0.1/api/nutrition/meals", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
        "x-idempotency-key": "nutrition-measure-rice-194g",
      },
      body: JSON.stringify({
        localDate: "2099-01-02",
        timePrecision: "date_only",
        mealType: "lunch",
        source: "test",
        confidence: "high",
        items: [
          {
            foodId: "FOOD|RICE|100G",
            quantity: 194,
            unit: "g",
          },
        ],
      }),
    }),
  );
  const body = await response.json();
  assert.equal(response.status, 201);
  const meal = body.nutrition.meals.find((item) => item.mealId === body.mealId);
  explicitMealId = body.mealId;
  explicitMealItemId = meal.items[0].mealItemId;
  assert.equal(meal.items[0].quantity, 194);
  assert.equal(meal.items[0].unit, "g");
  assert.ok(Math.abs(meal.items[0].nutrients.energyKcal - 252.2) < 0.000001);
  assert.ok(Math.abs(meal.nutrients.energyKcal - 252.2) < 0.000001);
});

test("meal quantity and append patches preserve explicit compatible units", async () => {
  const quantityResponse = await mealRoute.PATCH(
    new Request("http://127.0.0.1/api/nutrition/meals", {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
        "x-idempotency-key": "nutrition-measure-rice-quantity-200g",
      },
      body: JSON.stringify({
        action: "quantity",
        mealId: explicitMealId,
        mealItemId: explicitMealItemId,
        expectedRevisionNo: 1,
        quantity: 0.2,
        unit: "kg",
      }),
    }),
  );
  const quantityBody = await quantityResponse.json();
  assert.equal(quantityResponse.status, 200, JSON.stringify(quantityBody));
  const quantityMeal = quantityBody.nutrition.meals.find(
    (candidate) => candidate.mealId === explicitMealId,
  );
  assert.equal(quantityMeal.items[0].quantity, 0.2);
  assert.equal(quantityMeal.items[0].unit, "kg");
  assert.ok(
    Math.abs(quantityMeal.items[0].nutrients.energyKcal - 260) < 0.000001,
  );

  const appendResponse = await mealRoute.PATCH(
    new Request("http://127.0.0.1/api/nutrition/meals", {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
        "x-idempotency-key": "nutrition-measure-milk-append-50ml",
      },
      body: JSON.stringify({
        action: "append_food",
        mealId: explicitMealId,
        foodId: "FOOD|MILK|100ML",
        expectedRevisionNo: 2,
        quantity: 50,
        unit: "ml",
      }),
    }),
  );
  const appendBody = await appendResponse.json();
  assert.equal(appendResponse.status, 200, JSON.stringify(appendBody));
  const appendMeal = appendBody.nutrition.meals.find(
    (candidate) => candidate.mealId === explicitMealId,
  );
  assert.equal(appendMeal.items[1].quantity, 50);
  assert.equal(appendMeal.items[1].unit, "ml");
  assert.ok(
    Math.abs(appendMeal.items[1].nutrients.energyKcal - 30) < 0.000001,
  );
});

test("meal quantity patches reject unknown fields before mutation", async () => {
  const requestId = "nutrition-measure-rice-quantity-units-typo";
  const response = await mealRoute.PATCH(
    new Request("http://127.0.0.1/api/nutrition/meals", {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
        "x-idempotency-key": requestId,
      },
      body: JSON.stringify({
        action: "quantity",
        mealId: explicitMealId,
        mealItemId: explicitMealItemId,
        expectedRevisionNo: 3,
        quantity: 0.2,
        units: "kg",
      }),
    }),
  );
  const body = await response.json();
  assert.equal(response.status, 400, JSON.stringify(body));
  assert.equal(body.errorCode, "INVALID_REQUEST");

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(
      database
        .prepare(
          "SELECT current_revision_no AS revisionNo FROM nutrition_meals WHERE meal_id = ?",
        )
        .get(explicitMealId).revisionNo,
      3,
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM audit_log WHERE request_id = ?")
        .get(requestId).count,
      0,
    );
  } finally {
    database.close();
  }
});

test("meal API rejects incompatible explicit units before mutation", async () => {
  const response = await mealRoute.POST(
    new Request("http://127.0.0.1/api/nutrition/meals", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
        "x-idempotency-key": "nutrition-measure-rice-194ml",
      },
      body: JSON.stringify({
        localDate: "2099-01-03",
        timePrecision: "date_only",
        mealType: "lunch",
        source: "test",
        confidence: "high",
        items: [
          {
            foodId: "FOOD|RICE|100G",
            quantity: 194,
            unit: "ml",
          },
        ],
      }),
    }),
  );
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.errorCode, "INCOMPATIBLE_NUTRITION_UNIT");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM nutrition_meals WHERE local_date = ?",
        )
        .get("2099-01-03").count,
      0,
    );
  } finally {
    database.close();
  }
});

test("meal, plan, and combo APIs reject unknown nested item fields before mutation", async () => {
  const cases = [
    {
      requestId: "nutrition-measure-meal-unknown-item-field",
      route: mealRoute.POST,
      url: "http://127.0.0.1/api/nutrition/meals",
      body: {
        localDate: "2099-01-07",
        timePrecision: "date_only",
        mealType: "lunch",
        items: [{ foodId: "FOOD|RICE|100G", quantity: 0.2, units: "kg" }],
      },
    },
    {
      requestId: "nutrition-measure-plan-unknown-item-field",
      route: planRoute.POST,
      url: "http://127.0.0.1/api/nutrition/plans",
      body: {
        scheduledDate: "2099-01-07",
        mealType: "lunch",
        items: [{ foodId: "FOOD|RICE|100G", quantity: 0.2, units: "kg" }],
      },
    },
    {
      requestId: "nutrition-measure-combo-unknown-item-field",
      route: comboRoute.POST,
      url: "http://127.0.0.1/api/nutrition/combos",
      body: {
        displayName: "Unknown item field combo",
        items: [{ foodId: "FOOD|RICE|100G", quantity: 0.2, units: "kg" }],
      },
    },
  ];

  for (const item of cases) {
    const response = await item.route(
      new Request(item.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiToken}`,
          "content-type": "application/json",
          "x-idempotency-key": item.requestId,
        },
        body: JSON.stringify(item.body),
      }),
    );
    const body = await response.json();
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(body.errorCode, "INVALID_REQUEST");
  }

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM nutrition_meals WHERE local_date = ?",
        )
        .get("2099-01-07").count,
      0,
    );
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM nutrition_meal_plans WHERE scheduled_date = ?",
        )
        .get("2099-01-07").count,
      0,
    );
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM nutrition_combos WHERE display_name = ?",
        )
        .get("Unknown item field combo").count,
      0,
    );
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_log WHERE request_id IN (?, ?, ?)",
        )
        .get(...cases.map((item) => item.requestId)).count,
      0,
    );
  } finally {
    database.close();
  }
});

test("explicit registered-food units require an explicit quantity", async () => {
  const mealResponse = await mealRoute.POST(
    new Request("http://127.0.0.1/api/nutrition/meals", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
        "x-idempotency-key": "nutrition-measure-meal-unit-without-quantity",
      },
      body: JSON.stringify({
        localDate: "2099-01-06",
        timePrecision: "date_only",
        mealType: "lunch",
        source: "test",
        confidence: "high",
        items: [{ foodId: "FOOD|RICE|100G", unit: "g" }],
      }),
    }),
  );
  const mealBody = await mealResponse.json();
  assert.equal(mealResponse.status, 400);
  assert.equal(
    mealBody.errorCode,
    "NUTRITION_QUANTITY_REQUIRED_FOR_UNIT",
  );
  assert.equal(
    mealBody.error,
    "Quantity is required when unit is supplied",
  );

  const planResponse = await planRoute.POST(
    new Request("http://127.0.0.1/api/nutrition/plans", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
        "x-idempotency-key": "nutrition-measure-plan-unit-without-quantity",
      },
      body: JSON.stringify({
        scheduledDate: "2099-01-06",
        mealType: "lunch",
        source: "test",
        confidence: "high",
        items: [{ foodId: "FOOD|RICE|100G", unit: "g" }],
      }),
    }),
  );
  const planBody = await planResponse.json();
  assert.equal(planResponse.status, 400);
  assert.equal(
    planBody.errorCode,
    "NUTRITION_QUANTITY_REQUIRED_FOR_UNIT",
  );
  assert.equal(
    planBody.error,
    "Quantity is required when unit is supplied",
  );

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM nutrition_meals WHERE local_date = ?",
        )
        .get("2099-01-06").count,
      0,
    );
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM nutrition_meal_plans WHERE scheduled_date = ?",
        )
        .get("2099-01-06").count,
      0,
    );
  } finally {
    database.close();
  }
});

test("plan API applies the same explicit-unit contract", async () => {
  const response = await planRoute.POST(
    new Request("http://127.0.0.1/api/nutrition/plans", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
        "x-idempotency-key": "nutrition-measure-plan-194g",
      },
      body: JSON.stringify({
        scheduledDate: "2099-01-04",
        mealType: "lunch",
        source: "test",
        confidence: "high",
        items: [
          {
            foodId: "FOOD|RICE|100G",
            quantity: 194,
            unit: "g",
          },
        ],
      }),
    }),
  );
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.plans[0].items[0].quantity, 194);
  assert.equal(body.plans[0].items[0].unit, "g");
  assert.ok(
    Math.abs(body.plans[0].items[0].nutrients.energyKcal - 252.2) <
      0.000001,
  );
});

test("combo save, compatible food revision, and meal expansion preserve the measure", async () => {
  const createdResponse = await comboRoute.POST(
    new Request("http://127.0.0.1/api/nutrition/combos", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
        "x-idempotency-key": "nutrition-measure-combo-194g",
      },
      body: JSON.stringify({
        displayName: "Synthetic rice serving",
        defaultMealType: "lunch",
        items: [
          {
            foodId: "FOOD|RICE|100G",
            quantity: 194,
            unit: "g",
          },
        ],
      }),
    }),
  );
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 201);
  assert.equal(created.combo.items[0].defaultQuantity, 194);
  assert.equal(created.combo.items[0].unitAtSave, "g");
  assert.ok(
    Math.abs(created.combo.items[0].nutrients.energyKcal - 252.2) <
      0.000001,
  );

  await closeLocalDbForTests();
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      INSERT INTO nutrition_food_versions (
        food_version_id, food_id, version_no, base_quantity, base_unit,
        energy_kcal, protein_g, carbs_g, total_fat_g, effective_from
      ) VALUES (
        'FOOD|RICE|100G|V2', 'FOOD|RICE|100G', 2, 100, 'g',
        130, 2.4, 28.7, 0.3, '2099-01-05'
      );
      UPDATE nutrition_foods
      SET current_version_no = 2, default_unit = 'g'
      WHERE food_id = 'FOOD|RICE|100G';
    `);
  } finally {
    database.close();
  }

  const listedResponse = await comboRoute.GET(
    new Request("http://127.0.0.1/api/nutrition/combos", {
      headers: { authorization: `Bearer ${apiToken}` },
    }),
  );
  const listed = await listedResponse.json();
  assert.equal(listedResponse.status, 200);
  const combo = listed.combos.find(
    (candidate) => candidate.comboId === created.comboId,
  );
  assert.equal(combo.isUsable, true);
  assert.equal(combo.items[0].unitCompatible, true);
  assert.ok(
    Math.abs(combo.items[0].nutrients.energyKcal - 252.2) < 0.000001,
  );

  const mealResponse = await mealRoute.POST(
    new Request("http://127.0.0.1/api/nutrition/meals", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
        "x-idempotency-key": "nutrition-measure-combo-meal",
      },
      body: JSON.stringify({
        localDate: "2099-01-05",
        timePrecision: "date_only",
        source: "test",
        confidence: "high",
        combo: {
          comboId: created.comboId,
          expectedVersionNo: 1,
        },
      }),
    }),
  );
  const mealBody = await mealResponse.json();
  assert.equal(mealResponse.status, 201);
  const expandedMeal = mealBody.nutrition.meals.find(
    (candidate) => candidate.mealId === mealBody.mealId,
  );
  assert.equal(expandedMeal.items[0].quantity, 194);
  assert.equal(expandedMeal.items[0].unit, "g");
  assert.ok(
    Math.abs(expandedMeal.items[0].nutrients.energyKcal - 252.2) <
      0.000001,
  );
});
