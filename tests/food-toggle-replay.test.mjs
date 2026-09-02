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
const temporaryRoot = mkdtempSync(join(tmpdir(), "open-fitness-food-toggle-"));
const databasePath = join(temporaryRoot, "fitness.sqlite");
const apiToken = "food-toggle-replay-test-token";

const initialized = spawnSync(
  process.execPath,
  [
    join(repositoryRoot, "scripts", "init-local-sqlite.mjs"),
    "--path",
    databasePath,
    "--goal",
    "Food toggle replay contract",
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
    original_label, current_version_no, updated_at
  ) VALUES (
    'FOOD|TOGGLE|A', 'Toggle food', 'toggle food', 'g', 1, 'test',
    'Toggle food', 1, '2099-01-01T00:00:00.000Z'
  );

  INSERT INTO nutrition_food_versions (
    food_version_id, food_id, version_no, base_quantity, base_unit,
    energy_kcal, protein_g, source_note, effective_from
  ) VALUES (
    'FOOD|TOGGLE|A|V1', 'FOOD|TOGGLE|A', 1, 100, 'g', 100, 10,
    'Toggle fixture', '2099-01-01'
  );

  INSERT INTO nutrition_food_aliases (
    alias_id, food_id, alias, normalized_alias, source
  ) VALUES (
    'FOOD|TOGGLE|A|ALIAS|1', 'FOOD|TOGGLE|A', 'Toggle food',
    'toggle food', 'test'
  );
`);
fixture.close();

process.env.FITNESS_SQLITE_PATH = databasePath;
process.env.FITNESS_API_TOKEN = apiToken;

const itemRoute = await import(
  new URL("../app/api/nutrition/items/route.ts", import.meta.url)
);
const { closeLocalDbForTests } = await import(
  new URL("../db/local-sqlite.ts", import.meta.url)
);

function patchRequest(requestId, body) {
  return new Request("http://127.0.0.1/api/nutrition/items", {
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
  const response = await itemRoute.PATCH(patchRequest(requestId, body));
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

function activeState() {
  return scalar(
    "SELECT is_active AS value FROM nutrition_foods WHERE food_id = ?",
    "FOOD|TOGGLE|A",
  );
}

function auditEntityId(requestId) {
  return scalar(
    `SELECT entity_id AS value FROM audit_log
      WHERE request_id = ? AND entity_type = 'nutrition_food'`,
    requestId,
  );
}

function auditCount(requestId) {
  return scalar(
    `SELECT COUNT(*) AS value FROM audit_log
      WHERE request_id = ? AND entity_type = 'nutrition_food'`,
    requestId,
  );
}

after(async () => {
  await closeLocalDbForTests();
  if (existsSync(`${databasePath}-shm`)) unlinkSync(`${databasePath}-shm`);
  if (existsSync(`${databasePath}-wal`)) unlinkSync(`${databasePath}-wal`);
  if (existsSync(databasePath)) unlinkSync(databasePath);
  rmdirSync(temporaryRoot);
});

test("food toggle replay never rebuilds an old receipt from inverse current state", async () => {
  const foodId = "FOOD|TOGGLE|A";
  const deactivateRequestId = "food-toggle-deactivate";
  const deactivatePayload = { foodId, action: "deactivate" };

  const deactivated = await callPatch(deactivateRequestId, deactivatePayload);
  assert.equal(deactivated.response.status, 200);
  assert.equal(deactivated.body.replay, false);
  assert.equal(deactivated.body.versionNo, 1);
  assert.equal(deactivated.body.item.isActive, false);
  assert.equal(
    auditEntityId(deactivateRequestId),
    "FOOD|TOGGLE|A|TOGGLE|1|INACTIVE",
  );

  const immediateReplay = await callPatch(
    deactivateRequestId,
    deactivatePayload,
  );
  assert.equal(immediateReplay.response.status, 200);
  assert.equal(immediateReplay.body.replay, true);
  assert.equal(immediateReplay.body.versionNo, 1);
  assert.equal(immediateReplay.body.item.isActive, false);
  assert.equal(auditCount(deactivateRequestId), 1);

  const reactivated = await callPatch("food-toggle-reactivate", {
    foodId,
    action: "reactivate",
  });
  assert.equal(reactivated.response.status, 200);
  assert.equal(reactivated.body.replay, false);
  assert.equal(reactivated.body.item.isActive, true);
  assert.equal(activeState(), 1);

  const historicReplay = await callPatch(
    deactivateRequestId,
    deactivatePayload,
  );
  assert.equal(historicReplay.response.status, 200);
  assert.equal(historicReplay.body.replay, true);
  assert.equal(historicReplay.body.versionNo, 1);
  assert.equal(historicReplay.body.item.isActive, false);
  assert.equal(activeState(), 1);
  assert.equal(auditCount(deactivateRequestId), 1);

  const differentBody = await callPatch(deactivateRequestId, {
    foodId,
    action: "reactivate",
  });
  assert.equal(differentBody.response.status, 409);
  assert.equal(differentBody.body.errorCode, "IDEMPOTENCY_KEY_CONFLICT");
  assert.equal(activeState(), 1);
  assert.equal(auditCount(deactivateRequestId), 1);

  const revised = await callPatch("food-toggle-later-revision", {
    foodId,
    action: "revise",
    displayName: "Toggle food revised",
  });
  assert.equal(revised.response.status, 200);
  assert.equal(revised.body.versionNo, 2);

  const unreconstructableReplay = await callPatch(
    deactivateRequestId,
    deactivatePayload,
  );
  assert.equal(unreconstructableReplay.response.status, 409);
  assert.equal(
    unreconstructableReplay.body.errorCode,
    "NUTRITION_FOOD_TOGGLE_REPLAY_CONFLICT",
  );
  assert.equal(unreconstructableReplay.body.facts.foodId, foodId);
  assert.equal(unreconstructableReplay.body.replay, undefined);
  assert.equal(activeState(), 1);
  assert.equal(auditCount(deactivateRequestId), 1);
});
