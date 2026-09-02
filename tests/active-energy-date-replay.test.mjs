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
const temporaryRoot = mkdtempSync(join(tmpdir(), "open-fitness-energy-date-"));
const databasePath = join(temporaryRoot, "fitness.sqlite");
const apiToken = "active-energy-date-replay-token";

const initialized = spawnSync(
  process.execPath,
  [
    join(repositoryRoot, "scripts", "init-local-sqlite.mjs"),
    "--path",
    databasePath,
    "--goal",
    "Active energy date replay",
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
const { closeLocalDbForTests } = await import(
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

function storedObservation(energyObservationId) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT local_date AS localDate, observed_at AS observedAt,
                active_energy_kcal AS activeEnergyKcal
           FROM nutrition_energy_observations
          WHERE energy_observation_id = ?`,
      )
      .get(energyObservationId);
  } finally {
    database.close();
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

test("omitted active-energy date replays the originally committed local day", async (t) => {
  const firstInstant = Date.parse("2026-08-23T15:30:00.000Z");
  const nextLocalDay = Date.parse("2026-08-23T17:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date"], now: firstInstant });

  const requestId = "active-energy-omitted-date";
  const payload = {
    activeEnergyKcal: 432.5,
    basalEnergyKcal: 1625,
    source: "Active energy omitted-date replay",
    note: "date must come from the committed observation",
  };
  const initial = await callEnergy(requestId, payload);
  assert.equal(initial.response.status, 201);
  assert.equal(initial.body.replay, false);
  assert.equal(initial.body.nutrition.localDate, "2026-08-23");
  assert.equal(initial.body.nutrition.activeEnergy.kcal, 432.5);
  assert.deepEqual(
    { ...storedObservation(initial.body.energyObservationId) },
    {
      localDate: "2026-08-23",
      observedAt: "2026-08-23T15:30:00.000Z",
      activeEnergyKcal: 432.5,
    },
  );

  t.mock.timers.setTime(nextLocalDay);
  const replay = await callEnergy(requestId, payload);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.replay, true);
  assert.equal(
    replay.body.energyObservationId,
    initial.body.energyObservationId,
  );
  assert.equal(replay.body.nutrition.localDate, "2026-08-23");
  assert.deepEqual(replay.body.nutrition, initial.body.nutrition);

  const conflict = await callEnergy(requestId, {
    ...payload,
    activeEnergyKcal: 433.5,
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.errorCode, "IDEMPOTENCY_KEY_CONFLICT");
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM nutrition_energy_observations
        WHERE energy_observation_id = ?`,
      initial.body.energyObservationId,
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
