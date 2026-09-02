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
const temporaryRoot = mkdtempSync(join(tmpdir(), "open-fitness-combo-create-"));
const databasePath = join(temporaryRoot, "fitness.sqlite");
const apiToken = "combo-create-idempotency-race-token";
const foodId = "FOOD|COMBO|CREATE|RACE";

const initialized = spawnSync(
  process.execPath,
  [
    join(repositoryRoot, "scripts", "init-local-sqlite.mjs"),
    "--path",
    databasePath,
    "--goal",
    "Nutrition combo creation idempotency race",
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
    '${foodId}', 'Combo race food', 'combo race food', 'g', 1, 'test',
    'Combo race food', 1, '2099-01-01T00:00:00.000Z'
  );

  INSERT INTO nutrition_food_versions (
    food_version_id, food_id, version_no, base_quantity, base_unit,
    energy_kcal, protein_g, source_note, effective_from
  ) VALUES (
    '${foodId}|V1', '${foodId}', 1, 100, 'g', 100, 10,
    'Combo fixture', '2099-01-01'
  );

  INSERT INTO nutrition_food_aliases (
    alias_id, food_id, alias, normalized_alias, source
  ) VALUES (
    '${foodId}|ALIAS|1', '${foodId}', 'Combo race food',
    'combo race food', 'test'
  );
`);
fixture.close();

process.env.FITNESS_SQLITE_PATH = databasePath;
process.env.FITNESS_API_TOKEN = apiToken;

const comboRoute = await import(
  new URL("../app/api/nutrition/combos/route.ts", import.meta.url),
);
const { closeLocalDbForTests, getLocalClient } = await import(
  new URL("../db/local-sqlite.ts", import.meta.url),
);

function comboPayload(displayName) {
  return {
    displayName,
    defaultMealType: "lunch",
    contextTag: "post_workout",
    revisionReason: "combo create race",
    items: [{ foodId, quantity: 100 }],
  };
}

function comboRequest(requestId, payload) {
  return new Request("http://127.0.0.1/api/nutrition/combos", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
      "x-idempotency-key": requestId,
    },
    body: JSON.stringify(payload),
  });
}

async function callCreate(requestId, payload) {
  const response = await comboRoute.POST(comboRequest(requestId, payload));
  return { payload, response, body: await response.json() };
}

async function runAtSameTransactionStart(operations) {
  const client = getLocalClient();
  const originalTransaction = client.transaction;
  let arrivals = 0;
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
    const results = await Promise.all(operations.map((operation) => operation()));
    assert.equal(arrivals, operations.length);
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

function assertSingleComboMutation(requestId, comboId, displayNames) {
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM nutrition_combos
        WHERE display_name IN (?, ?)`,
      displayNames[0],
      displayNames[1] ?? displayNames[0],
    ),
    1,
  );
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM nutrition_combo_versions
        WHERE combo_id = ?`,
      comboId,
    ),
    1,
  );
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM nutrition_combo_items
        WHERE combo_version_id = ?`,
      `${comboId}|V1`,
    ),
    1,
  );
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM audit_log
        WHERE request_id = ? AND entity_type = 'nutrition_combo'`,
      requestId,
    ),
    1,
  );
  assert.equal(
    scalar(
      `SELECT entity_id AS value FROM audit_log
        WHERE request_id = ? AND entity_type = 'nutrition_combo'`,
      requestId,
    ),
    comboId,
  );
}

after(async () => {
  await closeLocalDbForTests();
  if (existsSync(`${databasePath}-shm`)) unlinkSync(`${databasePath}-shm`);
  if (existsSync(`${databasePath}-wal`)) unlinkSync(`${databasePath}-wal`);
  if (existsSync(databasePath)) unlinkSync(databasePath);
  rmdirSync(temporaryRoot);
});

test("concurrent identical combo creates commit once and hydrate the replay", async () => {
  const requestId = "combo-create-concurrent-identical";
  const payload = comboPayload("Concurrent identical combo");
  const results = await runAtSameTransactionStart([
    () => callCreate(requestId, payload),
    () => callCreate(requestId, payload),
  ]);

  assert.deepEqual(
    results.map(({ response }) => response.status).sort(),
    [200, 201],
  );
  assert.deepEqual(
    results.map(({ body }) => body.replay).sort(),
    [false, true],
  );
  assert.equal(results[0].body.comboId, results[1].body.comboId);
  assert.deepEqual(results[0].body.combo, results[1].body.combo);
  assertSingleComboMutation(requestId, results[0].body.comboId, [
    payload.displayName,
  ]);

  const replay = await callCreate(requestId, payload);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.replay, true);
  assert.equal(replay.body.comboId, results[0].body.comboId);
  assert.deepEqual(replay.body.combo, results[0].body.combo);
});

test("concurrent changed combo bodies reserve one mutation and conflict", async () => {
  const requestId = "combo-create-concurrent-changed";
  const payloads = [
    comboPayload("Concurrent changed combo winner"),
    comboPayload("Concurrent changed combo loser"),
  ];
  const results = await runAtSameTransactionStart([
    () => callCreate(requestId, payloads[0]),
    () => callCreate(requestId, payloads[1]),
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
  assert.equal(conflict.body.errorCode, "IDEMPOTENCY_KEY_CONFLICT");
  assert.equal(created.body.combo.displayName, payloads[0].displayName);
  assertSingleComboMutation(requestId, created.body.comboId, [
    payloads[0].displayName,
    payloads[1].displayName,
  ]);

  const replay = await callCreate(requestId, payloads[0]);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.replay, true);
  assert.equal(replay.body.comboId, created.body.comboId);

  const laterConflict = await callCreate(requestId, payloads[1]);
  assert.equal(laterConflict.response.status, 409);
  assert.equal(laterConflict.body.errorCode, "IDEMPOTENCY_KEY_CONFLICT");
  assertSingleComboMutation(requestId, created.body.comboId, [
    payloads[0].displayName,
    payloads[1].displayName,
  ]);
});
