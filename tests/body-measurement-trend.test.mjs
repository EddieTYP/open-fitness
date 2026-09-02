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
const temporaryRoot = mkdtempSync(join(tmpdir(), "open-fitness-body-trend-"));
const databasePath = join(temporaryRoot, "fitness.sqlite");
const apiToken = "body-measurement-trend-token";

const initialized = spawnSync(
  process.execPath,
  [
    join(repositoryRoot, "scripts", "init-local-sqlite.mjs"),
    "--path",
    databasePath,
    "--goal",
    "Body trend contract",
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
const insert = fixture.prepare(`
  INSERT INTO body_measurements (
    measurement_id, measured_at, local_date, source_device, source_file,
    weight_kg, body_fat_pct, muscle_mass_kg, body_water_pct,
    visceral_fat_rating
  ) VALUES (?, ?, ?, ?, 'Synthetic import', ?, ?, ?, ?, ?)
`);
const rows = [
  ["M|17", "2099-08-17T00:00:00.000Z", "2099-08-17", "TANITA A", 86.4, 23, 63, 49, 11],
  ["M|18", "2099-08-18T00:00:00.000Z", "2099-08-18", "TANITA A", 86.2, 22.9, 63.1, 49.2, 11],
  ["M|19A", "2099-08-19T00:00:00.000Z", "2099-08-19", "TANITA A", 86.1, 22.8, 63.2, 49.3, 11],
  ["M|19B", "2099-08-19T01:00:00.000Z", "2099-08-19", "TANITA A", 86, 22.7, 63.3, 49.4, 11],
  ["M|20OTHER", "2099-08-20T00:00:00.000Z", "2099-08-20", "TANITA B", 70, 10, 55, 60, 5],
  ["M|21", "2099-08-21T00:00:00.000Z", "2099-08-21", "TANITA A", 85.9, null, 63.4, 49.5, 11],
  ["M|23", "2099-08-23T00:00:00.000Z", "2099-08-23", "TANITA A", 85.5, 22.4, 63.5, 49.8, 10],
  ["M|24", "2099-08-24T00:00:00.000Z", "2099-08-24", "TANITA A", 85.4, 22.3, 63.6, 50, 10],
  ["M|OFFSET|PREVIOUS", "2099-08-24T15:00:00.000Z", "2099-08-24", "TANITA OFFSET", 80, 20, 60, 50, 9],
  ["M|OFFSET|ANCHOR", "2099-08-25T00:00:00+08:00", "2099-08-25", "TANITA OFFSET", 79, 19, 61, 51, 9],
  ["M|OFFSET|FUTURE", "2099-08-24T20:00:00.000Z", "2099-08-25", "TANITA OFFSET", 99, 30, 50, 40, 15],
];
for (const row of rows) insert.run(...row);
fixture.close();

process.env.FITNESS_SQLITE_PATH = databasePath;
process.env.FITNESS_API_TOKEN = apiToken;

const route = await import(
  new URL("../app/api/fitness/body-measurements/route.ts", import.meta.url)
);
const { closeLocalDbForTests } = await import(
  new URL("../db/local-sqlite.ts", import.meta.url)
);

async function exactMeasurement(measurementId) {
  const request = new Request(
    `http://127.0.0.1/api/fitness/body-measurements?measurementId=${encodeURIComponent(measurementId)}`,
    { headers: { authorization: `Bearer ${apiToken}` } },
  );
  const response = await route.GET(request);
  return { response, body: await response.json() };
}

after(async () => {
  await closeLocalDbForTests();
  if (existsSync(`${databasePath}-shm`)) unlinkSync(`${databasePath}-shm`);
  if (existsSync(`${databasePath}-wal`)) unlinkSync(`${databasePath}-wal`);
  if (existsSync(databasePath)) unlinkSync(databasePath);
  rmdirSync(temporaryRoot);
});

test("exact measurement returns same-device previous and bounded seven-day trend", async () => {
  const { response, body } = await exactMeasurement("M|23");
  assert.equal(response.status, 200);
  assert.equal(body.measurement.measurementId, "M|23");
  assert.equal(body.trend.sourceDevice, "TANITA A");
  assert.equal(body.trend.previous.measurementId, "M|21");
  assert.equal(body.trend.deltaFromPrevious.weightKg, -0.4);
  assert.equal(body.trend.deltaFromPrevious.bodyFatPct, undefined);
  assert.deepEqual(body.trend.sevenDay.dateRange, {
    from: "2099-08-17",
    to: "2099-08-23",
  });
  assert.equal(body.trend.sevenDay.sampleCount, 5);
  assert.equal(body.trend.sevenDay.sufficient, true);
  assert.equal(body.trend.sevenDay.averages.weightKg, 86);
  assert.equal(body.trend.sevenDay.averages.bodyFatPct, 22.75);
  assert.equal(body.trend.sevenDay.firstToLatestChange.weightKg, -0.9);
});

test("trend anchors backdated reads and keeps only the latest same-day sample", async () => {
  const { body } = await exactMeasurement("M|19B");
  assert.equal(body.trend.previous.measurementId, "M|19A");
  assert.equal(body.trend.sevenDay.sampleCount, 3);
  assert.equal(body.trend.sevenDay.sufficient, true);
  assert.equal(body.trend.sevenDay.averages.weightKg, 86.2);
  assert.equal(body.trend.sevenDay.firstToLatestChange.weightKg, -0.4);
});

test("fewer than three daily samples is explicitly insufficient", async () => {
  const { body } = await exactMeasurement("M|18");
  assert.equal(body.trend.sevenDay.sampleCount, 2);
  assert.equal(body.trend.sevenDay.sufficient, false);
});

test("trend compares mixed-offset timestamps as instants", async () => {
  const { response, body } = await exactMeasurement("M|OFFSET|ANCHOR");
  assert.equal(response.status, 200);
  assert.equal(body.trend.previous.measurementId, "M|OFFSET|PREVIOUS");
  assert.equal(body.trend.deltaFromPrevious.weightKg, -1);
  assert.equal(body.trend.sevenDay.sampleCount, 2);
  assert.equal(body.trend.sevenDay.averages.weightKg, 79.5);
  assert.equal(body.trend.sevenDay.firstToLatestChange.weightKg, -1);
});
