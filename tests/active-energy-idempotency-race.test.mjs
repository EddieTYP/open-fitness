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
const temporaryRoot = mkdtempSync(join(tmpdir(), "open-fitness-energy-race-"));
const databasePath = join(temporaryRoot, "fitness.sqlite");
const apiToken = "active-energy-idempotency-race-token";

const initialized = spawnSync(
  process.execPath,
  [
    join(repositoryRoot, "scripts", "init-local-sqlite.mjs"),
    "--path",
    databasePath,
    "--goal",
    "Active energy idempotency race",
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

const energyRoute = await import(
  new URL("../app/api/nutrition/energy/route.ts", import.meta.url)
);
const { closeLocalDbForTests, getLocalClient } = await import(
  new URL("../db/local-sqlite.ts", import.meta.url)
);

function energyRequest(requestId, body) {
  return new Request("http://127.0.0.1/api/nutrition/energy", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
      "x-idempotency-key": requestId,
    },
    body: JSON.stringify(body),
  });
}

async function callEnergy(requestId, body) {
  const response = await energyRoute.POST(energyRequest(requestId, body));
  return { response, body: await response.json() };
}

async function runAtSameIdempotencyPreflight(operations) {
  const client = getLocalClient();
  const originalExecute = client.execute;
  let arrivals = 0;
  let release;
  const bothArrived = new Promise((resolve) => {
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
      await bothArrived;
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

function storedObservation(energyObservationId) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT energy_observation_id AS energyObservationId,
                active_energy_kcal AS activeEnergyKcal,
                basal_energy_kcal AS basalEnergyKcal,
                source, note
           FROM nutrition_energy_observations
          WHERE energy_observation_id = ?`,
      )
      .get(energyObservationId);
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

test("concurrent identical active energy creates persist exactly once", async () => {
  const requestId = "active-energy-concurrent-same-request";
  const payload = {
    localDate: "2026-08-22",
    observedAt: "2026-08-22T12:00:00.000Z",
    activeEnergyKcal: 487.25,
    basalEnergyKcal: 1650,
    status: "final",
    source: "Active energy idempotency race",
    note: "single durable mutation",
  };

  const results = await runAtSameIdempotencyPreflight([
    () => callEnergy(requestId, payload),
    () => callEnergy(requestId, payload),
  ]);

  assert.deepEqual(
    results.map(({ response }) => response.status).sort(),
    [200, 201],
  );
  assert.deepEqual(
    results.map(({ body }) => body.replay).sort(),
    [false, true],
  );
  assert.equal(
    results[0].body.energyObservationId,
    results[1].body.energyObservationId,
  );
  assert.deepEqual(results[0].body.nutrition, results[1].body.nutrition);

  const energyObservationId = results[0].body.energyObservationId;
  assert.deepEqual(
    { ...storedObservation(energyObservationId) },
    {
      energyObservationId,
      activeEnergyKcal: payload.activeEnergyKcal,
      basalEnergyKcal: payload.basalEnergyKcal,
      source: payload.source,
      note: payload.note,
    },
  );
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM nutrition_energy_observations
        WHERE source = ? AND note = ?`,
      payload.source,
      payload.note,
    ),
    1,
  );
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM audit_log
        WHERE request_id = ? AND entity_type = 'nutrition_energy'`,
      requestId,
    ),
    1,
  );
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM audit_log
        WHERE request_id = ?
          AND entity_type = 'nutrition_energy'
          AND entity_id = ?`,
      requestId,
      energyObservationId,
    ),
    1,
  );

  const replay = await callEnergy(requestId, payload);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.replay, true);
  assert.equal(replay.body.energyObservationId, energyObservationId);
  assert.deepEqual(replay.body.nutrition, results[0].body.nutrition);

  const conflict = await callEnergy(requestId, {
    ...payload,
    activeEnergyKcal: payload.activeEnergyKcal + 1,
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.errorCode, "IDEMPOTENCY_KEY_CONFLICT");
  assert.equal(storedObservation(energyObservationId)?.activeEnergyKcal, 487.25);
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM nutrition_energy_observations
        WHERE source = ? AND note = ?`,
      payload.source,
      payload.note,
    ),
    1,
  );
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM audit_log
        WHERE request_id = ? AND entity_type = 'nutrition_energy'`,
      requestId,
    ),
    1,
  );
});
