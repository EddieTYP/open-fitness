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
const temporaryRoot = mkdtempSync(
  join(tmpdir(), "open-fitness-target-race-"),
);
const databasePath = join(temporaryRoot, "fitness.sqlite");
const apiToken = "nutrition-target-idempotency-race-token";

const initialized = spawnSync(
  process.execPath,
  [
    join(repositoryRoot, "scripts", "init-local-sqlite.mjs"),
    "--path",
    databasePath,
    "--goal",
    "Nutrition target idempotency race",
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

const targetRoute = await import(
  new URL("../app/api/nutrition/targets/route.ts", import.meta.url)
);
const { closeLocalDbForTests, getLocalClient } = await import(
  new URL("../db/local-sqlite.ts", import.meta.url)
);

function targetRequest(requestId, body) {
  return new Request("http://127.0.0.1/api/nutrition/targets", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
      "x-idempotency-key": requestId,
    },
    body: JSON.stringify(body),
  });
}

async function callTarget(requestId, body) {
  const response = await targetRoute.POST(targetRequest(requestId, body));
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

after(async () => {
  await closeLocalDbForTests();
  if (existsSync(`${databasePath}-shm`)) unlinkSync(`${databasePath}-shm`);
  if (existsSync(`${databasePath}-wal`)) unlinkSync(`${databasePath}-wal`);
  if (existsSync(databasePath)) unlinkSync(databasePath);
  rmdirSync(temporaryRoot);
});

test("concurrent fixed-target retries persist once and bind the body digest", async () => {
  const requestId = "nutrition-target-concurrent-fixed";
  const payload = {
    mode: "fixed",
    effectiveFrom: "2099-02-01",
    calorieTargetKcal: 2200,
    proteinTargetG: 160,
  };

  const results = await runAtSameIdempotencyPreflight([
    () => callTarget(requestId, payload),
    () => callTarget(requestId, payload),
  ]);

  assert.deepEqual(
    results.map(({ response }) => response.status).sort(),
    [200, 201],
  );
  assert.deepEqual(
    results.map(({ body }) => body.replay).sort(),
    [false, true],
  );
  assert.equal(results[0].body.target.settingsId, results[1].body.target.settingsId);
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM nutrition_settings
        WHERE effective_from = ? AND calorie_target_kcal = ?`,
      payload.effectiveFrom,
      payload.calorieTargetKcal,
    ),
    1,
  );
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM audit_log
        WHERE request_id = ? AND entity_type = 'nutrition_target'`,
      requestId,
    ),
    1,
  );

  const conflict = await callTarget(requestId, {
    ...payload,
    calorieTargetKcal: 2199,
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.errorCode, "IDEMPOTENCY_KEY_CONFLICT");
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM nutrition_settings
        WHERE effective_from = ?`,
      payload.effectiveFrom,
    ),
    1,
  );
});

test("concurrent formula calibration retries create one reviewed target", async () => {
  const baseline = await callTarget("nutrition-target-formula-baseline", {
    mode: "fixed",
    effectiveFrom: "2099-02-02",
    calorieTargetKcal: 2200,
    proteinTargetG: 160,
  });
  assert.equal(baseline.response.status, 201);

  const requestId = "nutrition-target-concurrent-formula";
  const payload = {
    mode: "formula",
    effectiveFrom: "2099-02-03",
    dailyDeficitKcal: 400,
    activeEnergyCreditRate: 0.8,
    proteinTargetG: 165,
    expectedSettingsId: baseline.body.target.settingsId,
  };
  const results = await runAtSameIdempotencyPreflight([
    () => callTarget(requestId, payload),
    () => callTarget(requestId, payload),
  ]);

  assert.deepEqual(
    results.map(({ response }) => response.status).sort(),
    [200, 201],
  );
  assert.deepEqual(
    results.map(({ body }) => body.replay).sort(),
    [false, true],
  );
  assert.equal(results[0].body.target.settingsId, results[1].body.target.settingsId);
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM nutrition_settings
        WHERE effective_from = ? AND calorie_target_kcal IS NULL`,
      payload.effectiveFrom,
    ),
    1,
  );
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM audit_log
        WHERE request_id = ? AND entity_type = 'nutrition_target'`,
      requestId,
    ),
    1,
  );
});
