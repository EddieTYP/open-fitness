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
const temporaryRoot = mkdtempSync(join(tmpdir(), "open-fitness-food-alias-"));
const databasePath = join(temporaryRoot, "fitness.sqlite");
const apiToken = "food-alias-revision-test-token";

const initialized = spawnSync(
  process.execPath,
  [
    join(repositoryRoot, "scripts", "init-local-sqlite.mjs"),
    "--path",
    databasePath,
    "--goal",
    "Food alias revision contract",
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
  ) VALUES
    (
      'FOOD|ALIAS|A', 'Synthetic food A', 'synthetic food a', 'g', 1,
      'test', 'Original label A', 1, '2099-01-01T00:00:00.000Z'
    ),
    (
      'FOOD|ALIAS|B', 'Synthetic food B', 'synthetic food b', 'g', 1,
      'test', 'Other alias', 1, '2099-01-01T00:00:00.000Z'
    );

  INSERT INTO nutrition_food_versions (
    food_version_id, food_id, version_no, base_quantity, base_unit,
    energy_kcal, protein_g, source_note, effective_from
  ) VALUES
    (
      'FOOD|ALIAS|A|V1', 'FOOD|ALIAS|A', 1, 100, 'g', 100, 10,
      'Fixture A', '2099-01-01'
    ),
    (
      'FOOD|ALIAS|B|V1', 'FOOD|ALIAS|B', 1, 100, 'g', 200, 20,
      'Fixture B', '2099-01-01'
    );

  INSERT INTO nutrition_food_aliases (
    alias_id, food_id, alias, normalized_alias, source
  ) VALUES
    (
      'FOOD|ALIAS|A|ALIAS|1', 'FOOD|ALIAS|A', 'Original label A',
      'original label a', 'test'
    ),
    (
      'FOOD|ALIAS|B|ALIAS|1', 'FOOD|ALIAS|B', 'Other alias',
      'other alias', 'test'
    );
`);
fixture.close();

process.env.FITNESS_SQLITE_PATH = databasePath;
process.env.FITNESS_API_TOKEN = apiToken;

const itemRoute = await import(
  new URL("../app/api/nutrition/items/route.ts", import.meta.url)
);
const { closeLocalDbForTests, getLocalClient } = await import(
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

function aliasesFor(foodId) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT alias FROM nutrition_food_aliases
          WHERE food_id = ? ORDER BY created_at, alias_id`,
      )
      .all(foodId)
      .map((row) => row.alias);
  } finally {
    database.close();
  }
}

function versionNo(foodId) {
  return scalar(
    "SELECT current_version_no AS value FROM nutrition_foods WHERE food_id = ?",
    foodId,
  );
}

function auditCount(requestId) {
  return scalar(
    `SELECT COUNT(*) AS value FROM audit_log
      WHERE request_id = ? AND entity_type = 'nutrition_food'`,
    requestId,
  );
}

async function runAfterNextCommit(afterCommit, operation) {
  const client = getLocalClient();
  const originalTransaction = client.transaction;
  let armed = true;
  client.transaction = async function (...args) {
    const transaction = await originalTransaction.apply(client, args);
    if (armed) {
      const originalCommit = transaction.commit;
      transaction.commit = async function (...commitArgs) {
        await originalCommit.apply(transaction, commitArgs);
        if (armed) {
          armed = false;
          await afterCommit();
        }
      };
    }
    return transaction;
  };
  try {
    return await operation();
  } finally {
    client.transaction = originalTransaction;
  }
}

after(async () => {
  await closeLocalDbForTests();
  if (existsSync(`${databasePath}-shm`)) unlinkSync(`${databasePath}-shm`);
  if (existsSync(`${databasePath}-wal`)) unlinkSync(`${databasePath}-wal`);
  if (existsSync(databasePath)) unlinkSync(databasePath);
  rmdirSync(temporaryRoot);
});

test("food alias revisions persist once, replay safely, and reject another food's alias", async () => {
  const requestId = "food-alias-add-secondary";
  const payload = {
    action: "revise",
    foodId: "FOOD|ALIAS|A",
    alias: "Secondary label A",
    category: "Synthetic category",
    sourceNote: "Alias revision source",
  };

  const initial = await callPatch(requestId, payload);
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body.replay, false);
  assert.equal(initial.body.item.originalLabel, "Original label A");
  assert.equal(initial.body.item.category, "Synthetic category");
  assert.equal(initial.body.item.sourceNote, "Alias revision source");
  assert.equal(initial.body.item.source, "test");
  assert.equal(typeof initial.body.item.effectiveFrom, "string");
  assert.equal(initial.body.item.foodVersionId, "FOOD|ALIAS|A|V2");
  assert.deepEqual(initial.body.item.aliases.toSorted(), [
    "Original label A",
    "Secondary label A",
  ]);
  assert.equal(initial.body.item.versionNo, 2);
  assert.equal(initial.body.versionNo, 2);
  assert.equal(auditCount(requestId), 1);

  const replay = await callPatch(requestId, payload);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.replay, true);
  assert.equal(replay.body.versionNo, 2);
  assert.equal(replay.body.item.versionNo, 2);
  assert.deepEqual(
    replay.body.item.aliases.toSorted(),
    initial.body.item.aliases.toSorted(),
  );
  assert.equal(auditCount(requestId), 1);

  const differentBody = await callPatch(requestId, {
    ...payload,
    alias: "Different alias A",
  });
  assert.equal(differentBody.response.status, 409);
  assert.equal(differentBody.body.errorCode, "IDEMPOTENCY_KEY_CONFLICT");
  assert.equal(versionNo(payload.foodId), 2);

  const duplicate = await callPatch("food-alias-normalized-duplicate", {
    ...payload,
    alias: "secondary label a",
  });
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.body.item.originalLabel, "Original label A");
  assert.deepEqual(aliasesFor(payload.foodId).sort(), [
    "Original label A",
    "Secondary label A",
  ]);
  assert.equal(versionNo(payload.foodId), 3);

  const conflictingRequestId = "food-alias-owned-by-other";
  const conflict = await callPatch(conflictingRequestId, {
    ...payload,
    alias: "Other alias",
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.errorCode, "NUTRITION_FOOD_ALIAS_CONFLICT");
  assert.equal(conflict.body.facts.foodId, "FOOD|ALIAS|B");
  assert.equal(versionNo(payload.foodId), 3);
  assert.equal(auditCount(conflictingRequestId), 0);
  assert.deepEqual(aliasesFor(payload.foodId).sort(), [
    "Original label A",
    "Secondary label A",
  ]);

  const concurrentRequestId = "food-alias-concurrent-replay";
  const concurrentPayload = {
    ...payload,
    alias: "Concurrent label A",
    sourceNote: "Concurrent alias revision",
  };
  const concurrent = await Promise.all([
    callPatch(concurrentRequestId, concurrentPayload),
    callPatch(concurrentRequestId, concurrentPayload),
  ]);
  assert.deepEqual(
    concurrent.map((result) => result.response.status),
    [200, 200],
  );
  assert.deepEqual(
    concurrent.map((result) => result.body.replay).sort(),
    [false, true],
  );
  for (const result of concurrent) {
    assert.equal(result.body.versionNo, 4);
    assert.equal(result.body.item.versionNo, 4);
    assert.ok(result.body.item.aliases.includes("Concurrent label A"));
  }
  assert.equal(versionNo(payload.foodId), 4);
  assert.equal(auditCount(concurrentRequestId), 1);
  assert.deepEqual(aliasesFor(payload.foodId).sort(), [
    "Concurrent label A",
    "Original label A",
    "Secondary label A",
  ]);
});

test("food revision response stays bound to its committed version and stale replay conflicts", async () => {
  const firstRequestId = "food-revision-before-later-commit";
  const firstPayload = {
    action: "revise",
    foodId: "FOOD|ALIAS|A",
    displayName: "Snapshot revision five",
    category: "Snapshot category five",
    sourceNote: "Snapshot source five",
    nutrients: { energyKcal: 505 },
  };
  let laterResult;
  const initial = await runAfterNextCommit(
    async () => {
      laterResult = await callPatch("food-revision-later-commit", {
        ...firstPayload,
        displayName: "Snapshot revision six",
        category: "Snapshot category six",
        sourceNote: "Snapshot source six",
        nutrients: { energyKcal: 606 },
      });
    },
    () => callPatch(firstRequestId, firstPayload),
  );

  assert.equal(initial.response.status, 200);
  assert.equal(initial.body.replay, false);
  assert.equal(initial.body.versionNo, 5);
  assert.equal(initial.body.item.versionNo, 5);
  assert.equal(initial.body.item.displayName, "Snapshot revision five");
  assert.equal(initial.body.item.category, "Snapshot category five");
  assert.equal(initial.body.item.sourceNote, "Snapshot source five");
  assert.equal(initial.body.item.nutrients.energyKcal, 505);

  assert.equal(laterResult.response.status, 200);
  assert.equal(laterResult.body.versionNo, 6);
  assert.equal(laterResult.body.item.displayName, "Snapshot revision six");
  assert.equal(versionNo(firstPayload.foodId), 6);

  const staleReplay = await callPatch(firstRequestId, firstPayload);
  assert.equal(staleReplay.response.status, 409);
  assert.equal(staleReplay.body.errorCode, "NUTRITION_FOOD_REPLAY_STALE");
  assert.equal(staleReplay.body.facts.foodId, firstPayload.foodId);
  assert.equal(staleReplay.body.facts.versionNo, 5);
});
