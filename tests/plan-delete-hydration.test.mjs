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
const temporaryRoot = mkdtempSync(join(tmpdir(), "open-fitness-plan-delete-"));
const databasePath = join(temporaryRoot, "fitness.sqlite");
const apiToken = "plan-delete-hydration-test-token";

const initialized = spawnSync(
  process.execPath,
  [
    join(repositoryRoot, "scripts", "init-local-sqlite.mjs"),
    "--path",
    databasePath,
    "--goal",
    "Plan deletion hydration contract",
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
for (const suffix of ["A", "RACE", "SAME"]) {
  fixture
    .prepare(
      `INSERT INTO nutrition_meal_plans (
        plan_id, scheduled_date, meal_type, source, confidence, status,
        current_version_no, created_by, updated_at
      ) VALUES (?, '2099-01-01', 'lunch', 'test', 'high', 'pending', 1,
        'fixture', '2099-01-01T00:00:00.000Z')`,
    )
    .run(`PLAN|DELETE|${suffix}`);
  fixture
    .prepare(
      `INSERT INTO nutrition_meal_plan_items (
        plan_item_id, plan_id, item_ordinal, item_name_snapshot, quantity,
        unit, energy_kcal, protein_g, confidence
      ) VALUES (?, ?, 1, ?, 100, 'g', 150, 12, 'high')`,
    )
    .run(
      `PLAN|DELETE|${suffix}|V1|ITEM|1`,
      `PLAN|DELETE|${suffix}`,
      `Synthetic planned meal ${suffix}`,
    );
}
fixture.close();

process.env.FITNESS_SQLITE_PATH = databasePath;
process.env.FITNESS_API_TOKEN = apiToken;

const planRoute = await import(
  new URL("../app/api/nutrition/plans/route.ts", import.meta.url)
);
const { closeLocalDbForTests } = await import(
  new URL("../db/local-sqlite.ts", import.meta.url)
);

function deleteRequest(requestId, body) {
  return new Request("http://127.0.0.1/api/nutrition/plans", {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
      "x-idempotency-key": requestId,
    },
    body: JSON.stringify(body),
  });
}

async function callDelete(requestId, body) {
  const response = await planRoute.DELETE(deleteRequest(requestId, body));
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

function planState(planId) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT status, current_version_no AS versionNo,
                cancelled_at AS cancelledAt
           FROM nutrition_meal_plans WHERE plan_id = ?`,
      )
      .get(planId);
  } finally {
    database.close();
  }
}

function auditCount(planId) {
  return scalar(
    `SELECT COUNT(*) AS value FROM audit_log
      WHERE entity_type = 'nutrition_plan' AND entity_id = ?`,
    planId,
  );
}

after(async () => {
  await closeLocalDbForTests();
  if (existsSync(`${databasePath}-shm`)) unlinkSync(`${databasePath}-shm`);
  if (existsSync(`${databasePath}-wal`)) unlinkSync(`${databasePath}-wal`);
  if (existsSync(databasePath)) unlinkSync(databasePath);
  rmdirSync(temporaryRoot);
});

test("plan delete hydrates cancelled state on initial and replay", async () => {
  const requestId = "plan-delete-hydrated-cancel";
  const payload = { planId: "PLAN|DELETE|A", expectedVersionNo: 1 };

  const initial = await callDelete(requestId, payload);
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body.replay, false);
  assert.equal(initial.body.versionNo, 2);
  assert.equal(initial.body.plan.planId, payload.planId);
  assert.equal(initial.body.plan.status, "cancelled");
  assert.equal(initial.body.plan.versionNo, 2);
  assert.equal(initial.body.plan.items.length, 1);
  assert.equal(planState(payload.planId).status, "cancelled");
  assert.equal(auditCount(payload.planId), 1);

  const replay = await callDelete(requestId, payload);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.replay, true);
  assert.equal(replay.body.plan.status, "cancelled");
  assert.equal(replay.body.plan.versionNo, 2);
  assert.equal(auditCount(payload.planId), 1);

  const conflict = await callDelete(requestId, {
    ...payload,
    expectedVersionNo: 2,
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.errorCode, "IDEMPOTENCY_KEY_CONFLICT");
  assert.equal(planState(payload.planId).versionNo, 2);
});

test("concurrent plan cancellation accepts only one affected-row winner", async () => {
  const planId = "PLAN|DELETE|RACE";
  const payload = { planId, expectedVersionNo: 1 };
  const results = await Promise.all([
    callDelete("plan-delete-race-winner-a", payload),
    callDelete("plan-delete-race-winner-b", payload),
  ]);
  assert.deepEqual(
    results.map((result) => result.response.status).sort(),
    [200, 409],
  );
  const winner = results.find((result) => result.response.status === 200);
  assert.equal(winner.body.plan.status, "cancelled");
  assert.equal(winner.body.plan.versionNo, 2);
  const stored = planState(planId);
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.versionNo, 2);
  assert.equal(typeof stored.cancelledAt, "string");
  assert.equal(auditCount(planId), 1);
});

test("concurrent identical plan cancellation resolves as one initial response and one replay", async () => {
  const planId = "PLAN|DELETE|SAME";
  const requestId = "plan-delete-race-same-request";
  const payload = { planId, expectedVersionNo: 1 };
  const results = await Promise.all([
    callDelete(requestId, payload),
    callDelete(requestId, payload),
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
    assert.equal(result.body.plan.status, "cancelled");
    assert.equal(result.body.plan.versionNo, 2);
  }
  assert.equal(planState(planId).versionNo, 2);
  assert.equal(auditCount(planId), 1);
});
