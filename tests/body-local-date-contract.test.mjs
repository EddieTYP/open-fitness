import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("body measurements persist a profile-local calendar date on write", async () => {
  const [schema, route] = await Promise.all([
    source("db/schema.ts"),
    source("app/api/fitness/body-measurements/route.ts"),
  ]);

  assert.match(schema, /localDate: text\("local_date"\)/);
  assert.match(schema, /idx_body_measurements_local_date/);
  assert.match(route, /getProfileTimezone\(\)/);
  assert.match(route, /localDateFromTimestamp\(payload\.measuredAt, timezone\)/);
  assert.match(route, /measuredAt: payload\.measuredAt,\s+localDate,/s);
  assert.ok(
    route.indexOf("if (replayedId)") < route.indexOf("getProfileTimezone()"),
    "idempotent replay must not re-derive the original calendar date",
  );
});

test("body reads use local_date instead of timestamp prefixes", async () => {
  const [logRoute, analysisRoute, fitness, nutrition] = await Promise.all([
    source("app/api/fitness/log/route.ts"),
    source("app/api/fitness/analysis/route.ts"),
    source("lib/fitness.ts"),
    source("lib/nutrition.ts"),
  ]);

  assert.match(logRoute, /eq\(bodyMeasurements\.localDate, date\)/);
  assert.match(
    analysisRoute,
    /localDateRange\(bodyMeasurements\.localDate\)/,
  );
  assert.match(fitness, /localDate: bodyMeasurements\.localDate/);
  assert.match(nutrition, /lte\(bodyMeasurements\.localDate, localDate\)/);
  for (const bodyReader of [logRoute, analysisRoute, fitness, nutrition]) {
    assert.doesNotMatch(
      bodyReader,
      /bodyMeasurements\.measuredAt\}?,?\s*1,?\s*10|measuredAt\.slice\(0,\s*10\)/,
    );
  }
});

test("migration preserves legacy grouping and enforces future local dates", async () => {
  const migration = await source(
    "drizzle/0013_body_measurement_local_date.sql",
  );

  assert.match(migration, /SET `local_date` = substr\(`measured_at`, 1, 10\)/);
  assert.match(migration, /idx_body_measurements_local_date/);
  assert.match(migration, /body_measurements_local_date_insert_guard/);
  assert.match(migration, /body_measurements_local_date_update_guard/);
  assert.match(migration, /BODY_MEASUREMENT_LOCAL_DATE_REQUIRED/);
  assert.match(migration, /SELECT MAX\(local_date\) AS known_date/);
});
