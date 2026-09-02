import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

register("./helpers/typescript-alias-loader.mjs", import.meta.url);

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), "open-fitness-analysis-view-"));
const databasePath = join(temporaryRoot, "fitness.sqlite");
const apiToken = "analysis-view-test-token";
const initialized = spawnSync(
  process.execPath,
  [
    join(repositoryRoot, "scripts", "init-local-sqlite.mjs"),
    "--path",
    databasePath,
    "--goal",
    "Analysis view bounds",
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

process.env.FITNESS_SQLITE_PATH = databasePath;
process.env.FITNESS_API_TOKEN = apiToken;

const analysisRoute = await import(
  new URL("../app/api/fitness/analysis/route.ts", import.meta.url)
);
const { closeLocalDbForTests } = await import(
  new URL("../db/local-sqlite.ts", import.meta.url)
);

function analysisRequest(view) {
  return new Request(
    `http://127.0.0.1/api/fitness/analysis?from=2099-01-01&to=2099-01-01&view=${view}`,
    { headers: { authorization: `Bearer ${apiToken}` } },
  );
}

after(async () => {
  await closeLocalDbForTests();
  if (existsSync(`${databasePath}-shm`)) unlinkSync(`${databasePath}-shm`);
  if (existsSync(`${databasePath}-wal`)) unlinkSync(`${databasePath}-wal`);
  if (existsSync(databasePath)) unlinkSync(databasePath);
  rmdirSync(temporaryRoot);
});

test("analysis API owns lean and full view semantics", async () => {
  const database = new DatabaseSync(databasePath);
  try {
    database.prepare(`
      INSERT INTO corrections (
        correction_id, effective_date, target_scope, target_key, field_name,
        original_value, corrected_value, reason, source, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "CORRECTION|CALENDAR|IN-RANGE",
      "2099-01-01",
      "calendar_day",
      "2099-01-01",
      "note",
      null,
      "Synthetic correction",
      "Synthetic calendar-day correction",
      "test",
      "2099-01-01T08:00:00.000Z",
    );
  } finally {
    database.close();
  }

  const leanResponse = await analysisRoute.GET(analysisRequest("default"));
  const lean = await leanResponse.json();
  assert.equal(leanResponse.status, 200);
  assert.equal(lean.evidenceBase, undefined);
  assert.equal(lean.dataPolicies, undefined);
  assert.equal(lean.operatingConstraintHistory, undefined);
  assert.ok(Array.isArray(lean.bodyMeasurements));
  assert.deepEqual(
    lean.corrections.map((correction) => [
      correction.targetScope,
      correction.targetKey,
    ]),
    [["calendar_day", "2099-01-01"]],
  );
  assert.equal(lean.corrections[0].originalValue, undefined);

  const fullResponse = await analysisRoute.GET(analysisRequest("full"));
  const full = await fullResponse.json();
  assert.equal(fullResponse.status, 200);
  assert.ok(Array.isArray(full.evidenceBase));
  assert.ok(Array.isArray(full.dataPolicies));
  assert.ok(Array.isArray(full.operatingConstraintHistory));
  assert.deepEqual(
    full.corrections.map((correction) => correction.correctionId),
    ["CORRECTION|CALENDAR|IN-RANGE"],
  );
  assert.equal(full.corrections[0].originalValue, null);

  const invalidResponse = await analysisRoute.GET(analysisRequest("wide"));
  const invalid = await invalidResponse.json();
  assert.equal(invalidResponse.status, 400);
  assert.equal(invalid.errorCode, "INVALID_ANALYSIS_VIEW");
});

test("analysis rejects an oversized collection instead of silently truncating", async () => {
  const database = new DatabaseSync(databasePath);
  try {
    const insert = database.prepare(`
      INSERT INTO body_measurements (
        measurement_id, measured_at, local_date, source_device, source_file,
        weight_kg
      ) VALUES (?, ?, '2099-01-01', 'Synthetic device', 'Synthetic source', 70)
    `);
    database.exec("BEGIN");
    for (let index = 0; index < 201; index += 1) {
      insert.run(
        `MEASURE|BOUND|${index}`,
        new Date(Date.UTC(2099, 0, 1, 0, 0, index)).toISOString(),
      );
    }
    database.exec("COMMIT");
  } finally {
    database.close();
  }

  const response = await analysisRoute.GET(analysisRequest("default"));
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.errorCode, "ANALYSIS_RESULT_TOO_LARGE");
  assert.equal(body.facts.collection, "bodyMeasurements");
  assert.equal(body.facts.maximum, 200);
  assert.equal(body.facts.actual, 201);
});
