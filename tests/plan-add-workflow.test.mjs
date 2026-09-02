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

register("./helpers/typescript-alias-loader.mjs", import.meta.url);

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), "open-fitness-plan-add-"));
const databasePath = join(temporaryRoot, "fitness.sqlite");
const apiToken = "plan-add-workflow-test-token";

const initialized = spawnSync(
  process.execPath,
  [
    join(repositoryRoot, "scripts", "init-local-sqlite.mjs"),
    "--path",
    databasePath,
    "--goal",
    "Pending meal plan append workflow",
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

process.env.FITNESS_SQLITE_PATH = databasePath;
process.env.FITNESS_API_TOKEN = apiToken;

const planRoute = await import(
  new URL("../app/api/nutrition/plans/route.ts", import.meta.url)
);
const { closeLocalDbForTests } = await import(
  new URL("../db/local-sqlite.ts", import.meta.url)
);

function request(method, requestId, body) {
  return new Request("http://127.0.0.1/api/nutrition/plans", {
    method,
    headers: {
      authorization: `Bearer ${apiToken}`,
      ...(body ? { "content-type": "application/json" } : {}),
      ...(requestId ? { "x-idempotency-key": requestId } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function call(method, requestId, body) {
  const response = await planRoute[method](request(method, requestId, body));
  return { response, body: await response.json() };
}

function item(name, energyKcal, proteinG) {
  return {
    name,
    quantity: 100,
    unit: "g",
    nutrients: { energyKcal, proteinG },
  };
}

after(async () => {
  await closeLocalDbForTests();
  if (existsSync(`${databasePath}-shm`)) unlinkSync(`${databasePath}-shm`);
  if (existsSync(`${databasePath}-wal`)) unlinkSync(`${databasePath}-wal`);
  if (existsSync(databasePath)) unlinkSync(databasePath);
  rmdirSync(temporaryRoot);
});

test("canonical add preserves a unique pending plan or creates the missing meal", async () => {
  const scheduledDate = "2099-08-28";
  const originalItem = item("Synthetic original lunch", 150, 12);
  const addedItem = item("Synthetic added lunch", 220, 18);

  const createdLunch = await call("POST", "plan-add-create-lunch", {
    scheduledDate,
    mealType: "lunch",
    confidence: "high",
    items: [originalItem],
  });
  assert.equal(createdLunch.response.status, 201);

  const listed = await call("GET");
  assert.equal(listed.response.status, 200);
  const matches = listed.body.plans.filter(
    (plan) =>
      plan.scheduledDate === scheduledDate && plan.mealType === "lunch",
  );
  assert.equal(matches.length, 1);

  const current = matches[0];
  const revised = await call("PATCH", "plan-add-append-lunch", {
    action: "revise",
    planId: current.planId,
    expectedVersionNo: current.versionNo,
    items: [...current.items, addedItem],
  });
  assert.equal(revised.response.status, 200);
  assert.equal(revised.body.plan.versionNo, 2);
  assert.deepEqual(
    revised.body.plan.items.map((entry) => entry.name),
    [originalItem.name, addedItem.name],
  );

  const createdDinner = await call("POST", "plan-add-create-dinner", {
    scheduledDate,
    mealType: "dinner",
    confidence: "high",
    items: [item("Synthetic dinner", 300, 25)],
  });
  assert.equal(createdDinner.response.status, 201);
  assert.equal(createdDinner.body.plan.mealType, "dinner");
  assert.equal(createdDinner.body.plan.status, "pending");
});
