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
const temporaryRoot = mkdtempSync(join(tmpdir(), "open-fitness-food-race-"));
const databasePath = join(temporaryRoot, "fitness.sqlite");
const apiToken = "food-toggle-race-test-token";

const initialized = spawnSync(
  process.execPath,
  [
    join(repositoryRoot, "scripts", "init-local-sqlite.mjs"),
    "--path",
    databasePath,
    "--goal",
    "Food toggle race contract",
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
for (const suffix of ["INVERSE", "READBACK", "IDEMPOTENT"]) {
  const foodId = `FOOD|TOGGLE|${suffix}`;
  const displayName = `Toggle ${suffix.toLowerCase()}`;
  fixture
    .prepare(
      `INSERT INTO nutrition_foods (
        food_id, display_name, normalized_name, default_unit, is_active,
        source, original_label, current_version_no, updated_at
      ) VALUES (?, ?, ?, 'g', 1, 'test', ?, 1, ?)`,
    )
    .run(
      foodId,
      displayName,
      displayName.toLowerCase(),
      displayName,
      `2099-01-01T00:00:00.00${suffix.length % 10}Z`,
    );
  fixture
    .prepare(
      `INSERT INTO nutrition_food_versions (
        food_version_id, food_id, version_no, base_quantity, base_unit,
        energy_kcal, protein_g, source_note, effective_from
      ) VALUES (?, ?, 1, 100, 'g', 100, 10, 'Toggle fixture', '2099-01-01')`,
    )
    .run(`${foodId}|V1`, foodId);
  fixture
    .prepare(
      `INSERT INTO nutrition_food_aliases (
        alias_id, food_id, alias, normalized_alias, source
      ) VALUES (?, ?, ?, ?, 'test')`,
    )
    .run(
      `${foodId}|ALIAS|1`,
      foodId,
      displayName,
      displayName.toLowerCase(),
    );
}
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
    const results = await Promise.all(
      operations.map((operation) => operation()),
    );
    assert.equal(arrivals, operations.length);
    return results;
  } finally {
    client.transaction = originalTransaction;
  }
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
        `SELECT display_name AS displayName, is_active AS isActive,
                current_version_no AS versionNo, updated_at AS updatedAt
           FROM nutrition_foods WHERE food_id = ?`,
      )
      .get(foodId);
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

test("concurrent inverse food toggles commit one authoritative state", async () => {
  const foodId = "FOOD|TOGGLE|INVERSE";
  const requestIds = ["food-inverse-deactivate", "food-inverse-reactivate"];
  const results = await runAtSameTransactionStart([
    () => callPatch(requestIds[0], { foodId, action: "deactivate" }),
    () => callPatch(requestIds[1], { foodId, action: "reactivate" }),
  ]);

  assert.deepEqual(
    results.map(({ response }) => response.status).sort(),
    [200, 409],
  );
  const winner = results.find(({ response }) => response.status === 200);
  const loser = results.find(({ response }) => response.status === 409);
  assert.ok(winner);
  assert.ok(loser);
  assert.equal(winner.body.replay, false);
  assert.equal(winner.body.versionNo, 1);
  assert.equal(winner.body.item.isActive, false);
  assert.equal(loser.body.errorCode, "NUTRITION_FOOD_TOGGLE_CONFLICT");
  assert.deepEqual(
    { ...storedFood(foodId) },
    {
      displayName: "Toggle inverse",
      isActive: 0,
      versionNo: 1,
      updatedAt: "2099-01-01T00:00:00.008Z",
    },
  );
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM audit_log
        WHERE request_id IN (?, ?) AND entity_type = 'nutrition_food'`,
      ...requestIds,
    ),
    1,
  );
});

test("concurrent identical food toggles preserve idempotent replay", async () => {
  const foodId = "FOOD|TOGGLE|IDEMPOTENT";
  const requestId = "food-toggle-concurrent-idempotent";
  const payload = { foodId, action: "deactivate" };
  const results = await runAtSameTransactionStart([
    () => callPatch(requestId, payload),
    () => callPatch(requestId, payload),
  ]);

  assert.deepEqual(
    results.map(({ response }) => response.status),
    [200, 200],
  );
  assert.deepEqual(
    results.map(({ body }) => body.replay).sort(),
    [false, true],
  );
  assert.deepEqual(results[0].body.item, results[1].body.item);
  assert.equal(storedFood(foodId)?.isActive, 0);
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM audit_log
        WHERE request_id = ? AND entity_type = 'nutrition_food'`,
      requestId,
    ),
    1,
  );
});

test("food toggle response survives a revision immediately after commit", async () => {
  const foodId = "FOOD|TOGGLE|READBACK";
  let revision;
  const toggled = await runAfterNextCommit(
    async () => {
      revision = await callPatch("food-toggle-readback-revision", {
        foodId,
        action: "revise",
        displayName: "Toggle readback revised",
      });
    },
    () =>
      callPatch("food-toggle-readback-deactivate", {
        foodId,
        action: "deactivate",
      }),
  );

  assert.equal(toggled.response.status, 200);
  assert.equal(toggled.body.replay, false);
  assert.equal(toggled.body.versionNo, 1);
  assert.equal(toggled.body.item.versionNo, 1);
  assert.equal(toggled.body.item.displayName, "Toggle readback");
  assert.equal(toggled.body.item.isActive, false);

  assert.equal(revision.response.status, 200);
  assert.equal(revision.body.versionNo, 2);
  assert.equal(revision.body.item.displayName, "Toggle readback revised");
  assert.equal(revision.body.item.isActive, false);
  assert.deepEqual(
    {
      displayName: storedFood(foodId)?.displayName,
      isActive: storedFood(foodId)?.isActive,
      versionNo: storedFood(foodId)?.versionNo,
    },
    {
      displayName: "Toggle readback revised",
      isActive: 0,
      versionNo: 2,
    },
  );
});
