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
const temporaryRoot = mkdtempSync(join(tmpdir(), "open-fitness-plan-replay-"));
const databasePath = join(temporaryRoot, "fitness.sqlite");
const apiToken = "plan-historical-replay-test-token";
const planIds = {
  history: "PLAN|REPLAY|HISTORY",
  undoRace: "PLAN|REPLAY|UNDO|RACE",
  undoSame: "PLAN|REPLAY|UNDO|SAME",
};

const initialized = spawnSync(
  process.execPath,
  [
    join(repositoryRoot, "scripts", "init-local-sqlite.mjs"),
    "--path",
    databasePath,
    "--goal",
    "Plan historical replay and undo race contract",
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
for (const [ordinal, planId] of Object.values(planIds).entries()) {
  fixture
    .prepare(
      `INSERT INTO nutrition_meal_plans (
        plan_id, scheduled_date, meal_type, context_tag, original_meal_type,
        source, confidence, original_text, status, current_version_no,
        created_by, updated_at
      ) VALUES (
        ?, '2000-01-01', 'snack', 'post_workout', 'After training',
        'test', 'high', ?, 'pending', 1, 'fixture',
        '2000-01-01T00:00:00.000Z'
      )`,
    )
    .run(planId, `Synthetic planned meal ${ordinal + 1}`);
  fixture
    .prepare(
      `INSERT INTO nutrition_meal_plan_items (
        plan_item_id, plan_id, item_ordinal, item_name_snapshot, quantity,
        unit, energy_kcal, protein_g, carbs_g, total_fat_g, assumption,
        confidence, data_quality_flags
      ) VALUES (?, ?, 1, ?, 125, 'g', 225, 18, 21, 7,
        'fixture assumption', 'high', 'verified')`,
    )
    .run(
      `${planId}|V1|ITEM|1`,
      planId,
      `Synthetic plan item ${ordinal + 1}`,
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

async function callPatch(requestId, body) {
  const response = await planRoute.PATCH(
    new Request("http://127.0.0.1/api/nutrition/plans", {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
        "x-idempotency-key": requestId,
      },
      body: JSON.stringify(body),
    }),
  );
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

function planState(planId) {
  return readRow(
    `SELECT status, current_version_no AS versionNo,
            completed_meal_id AS mealId, consumed_at AS consumedAt
       FROM nutrition_meal_plans WHERE plan_id = ?`,
    planId,
  );
}

function mealState(mealId) {
  return readRow(
    `SELECT current_revision_no AS revisionNo, voided_at AS voidedAt
       FROM nutrition_meals WHERE meal_id = ?`,
    mealId,
  );
}

function requestAuditCount(requestId) {
  return scalar(
    `SELECT COUNT(*) AS value FROM audit_log WHERE request_id = ?`,
    requestId,
  );
}

function mealRevisionCount(mealId) {
  return scalar(
    `SELECT COUNT(*) AS value FROM nutrition_meal_revisions
      WHERE meal_id = ?`,
    mealId,
  );
}

after(async () => {
  await closeLocalDbForTests();
  if (existsSync(`${databasePath}-shm`)) unlinkSync(`${databasePath}-shm`);
  if (existsSync(`${databasePath}-wal`)) unlinkSync(`${databasePath}-wal`);
  if (existsSync(databasePath)) unlinkSync(databasePath);
  rmdirSync(temporaryRoot);
});

test("consume replay returns its immutable original receipt after a later undo", async () => {
  const planId = planIds.history;
  const consumeRequestId = "plan-history-consume-a";
  const consumePayload = { action: "consume", planId, expectedVersionNo: 1 };
  const initial = await callPatch(consumeRequestId, consumePayload);
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body.replay, false);
  assert.equal(initial.body.versionNo, 2);
  assert.equal(initial.body.revisionNo, 1);
  assert.equal(initial.body.plan.status, "consumed");
  assert.equal(initial.body.plan.completedMealId, initial.body.mealId);

  const undo = await callPatch("plan-history-undo-b", {
    action: "undo_consume",
    planId,
    expectedVersionNo: 2,
  });
  assert.equal(undo.response.status, 200);
  assert.equal(undo.body.replay, false);
  assert.equal(undo.body.versionNo, 3);
  assert.equal(undo.body.revisionNo, 2);
  assert.equal(undo.body.plan.status, "pending");
  assert.equal(undo.body.plan.completedMealId, null);

  const countsAfterUndo = {
    audits: scalar(`SELECT COUNT(*) AS value FROM audit_log`),
    meals: scalar(`SELECT COUNT(*) AS value FROM nutrition_meals`),
    revisions: scalar(`SELECT COUNT(*) AS value FROM nutrition_meal_revisions`),
    items: scalar(`SELECT COUNT(*) AS value FROM nutrition_meal_items`),
  };
  const replay = await callPatch(consumeRequestId, consumePayload);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.replay, true);
  assert.equal(replay.body.versionNo, initial.body.versionNo);
  assert.equal(replay.body.mealId, initial.body.mealId);
  assert.equal(replay.body.revisionNo, initial.body.revisionNo);
  assert.deepEqual(replay.body.plan, initial.body.plan);

  assert.deepEqual({ ...planState(planId) }, {
    status: "pending",
    versionNo: 3,
    mealId: null,
    consumedAt: null,
  });
  assert.equal(mealState(initial.body.mealId).revisionNo, 2);
  assert.equal(typeof mealState(initial.body.mealId).voidedAt, "string");
  assert.deepEqual(
    {
      audits: scalar(`SELECT COUNT(*) AS value FROM audit_log`),
      meals: scalar(`SELECT COUNT(*) AS value FROM nutrition_meals`),
      revisions: scalar(
        `SELECT COUNT(*) AS value FROM nutrition_meal_revisions`,
      ),
      items: scalar(`SELECT COUNT(*) AS value FROM nutrition_meal_items`),
    },
    countsAfterUndo,
  );

  const conflict = await callPatch(consumeRequestId, {
    ...consumePayload,
    expectedVersionNo: 2,
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.errorCode, "IDEMPOTENCY_KEY_CONFLICT");
  assert.equal(requestAuditCount(consumeRequestId), 2);
});

test("distinct undo requests race through checked plan and meal CAS", async () => {
  const planId = planIds.undoRace;
  const consumed = await callPatch("plan-undo-race-consume", {
    action: "consume",
    planId,
    expectedVersionNo: 1,
  });
  assert.equal(consumed.response.status, 200);

  const payload = { action: "undo_consume", planId, expectedVersionNo: 2 };
  const results = await Promise.all([
    callPatch("plan-undo-race-a", payload),
    callPatch("plan-undo-race-b", payload),
  ]);
  assert.deepEqual(
    results.map((result) => result.response.status).sort(),
    [200, 409],
  );
  const winner = results.find((result) => result.response.status === 200);
  const loser = results.find((result) => result.response.status === 409);
  assert.ok(winner);
  assert.ok(loser);
  assert.equal(winner.body.replay, false);
  assert.equal(winner.body.plan.status, "pending");
  assert.equal(winner.body.plan.versionNo, 3);
  assert.ok(
    ["PLAN_VERSION_CONFLICT", "PLAN_COMPLETED_MEAL_UNAVAILABLE"].includes(
      loser.body.errorCode,
    ),
  );

  assert.equal(planState(planId).status, "pending");
  assert.equal(planState(planId).versionNo, 3);
  assert.equal(mealRevisionCount(consumed.body.mealId), 2);
  assert.equal(mealState(consumed.body.mealId).revisionNo, 2);
  assert.equal(
    requestAuditCount("plan-undo-race-a") +
      requestAuditCount("plan-undo-race-b"),
    2,
  );
  assert.equal(
    requestAuditCount(
      results[0].response.status === 409
        ? "plan-undo-race-a"
        : "plan-undo-race-b",
    ),
    0,
  );
});

test("same-key undo race performs one mutation and resolves the loser as replay", async () => {
  const planId = planIds.undoSame;
  const consumed = await callPatch("plan-undo-same-consume", {
    action: "consume",
    planId,
    expectedVersionNo: 1,
  });
  assert.equal(consumed.response.status, 200);

  const requestId = "plan-undo-same-request";
  const payload = { action: "undo_consume", planId, expectedVersionNo: 2 };
  const results = await Promise.all([
    callPatch(requestId, payload),
    callPatch(requestId, payload),
  ]);
  assert.deepEqual(
    results.map((result) => result.response.status),
    [200, 200],
  );
  assert.deepEqual(
    results.map((result) => result.body.replay).sort(),
    [false, true],
  );
  assert.deepEqual(results[0].body.plan, results[1].body.plan);
  for (const result of results) {
    assert.equal(result.body.versionNo, 3);
    assert.equal(result.body.mealId, consumed.body.mealId);
    assert.equal(result.body.revisionNo, 2);
    assert.equal(result.body.plan.status, "pending");
    assert.equal(result.body.plan.completedMealId, null);
  }
  assert.equal(requestAuditCount(requestId), 2);
  assert.equal(mealRevisionCount(consumed.body.mealId), 2);

  const replay = await callPatch(requestId, payload);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.replay, true);
  assert.deepEqual(replay.body.plan, results[0].body.plan);
  assert.equal(requestAuditCount(requestId), 2);
  assert.equal(mealRevisionCount(consumed.body.mealId), 2);

  const conflict = await callPatch(requestId, {
    ...payload,
    expectedVersionNo: 3,
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.errorCode, "IDEMPOTENCY_KEY_CONFLICT");
  assert.equal(requestAuditCount(requestId), 2);
});
