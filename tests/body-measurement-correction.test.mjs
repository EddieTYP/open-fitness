import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

register("./helpers/typescript-alias-loader.mjs", import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "fitness-body-correction-"));
const database = join(temporary, "fitness.sqlite");
const init = spawnSync(process.execPath, [join(root, "scripts/init-local-sqlite.mjs"), "--path", database, "--goal", "Correction tests", "--cycle", "Leg,Push,Pull,Rest", "--timezone", "Asia/Hong_Kong", "--locale", "en"], { encoding: "utf8" });
assert.equal(init.status, 0, init.stderr);
process.env.FITNESS_SQLITE_PATH = database;
process.env.FITNESS_API_TOKEN = "correction-test-token";
const route = await import("../app/api/fitness/body-measurements/route.ts");
const revisionsRoute = await import("../app/api/fitness/revisions/route.ts");
const { closeLocalDbForTests, getLocalClient } = await import("../db/local-sqlite.ts");
after(closeLocalDbForTests);
const headers = { authorization: "Bearer correction-test-token", "content-type": "application/json" };
let counter = 0;
async function call(method, body, key = `body-correction-test-${++counter}`, authenticated = true) {
  const request = new Request("http://localhost/api/fitness/body-measurements", {
    method,
    headers: { ...(authenticated ? headers : {}), ...(key ? { "x-idempotency-key": key } : {}) },
    body: JSON.stringify(body),
  });
  const response = await route[method](request);
  return { status: response.status, body: await response.json() };
}
async function read(id) {
  const response = await route.GET(new Request(`http://localhost/api/fitness/body-measurements?measurementId=${encodeURIComponent(id)}`, { headers }));
  assert.equal(response.status, 200);
  return response.json();
}
async function revisions() {
  const response = await revisionsRoute.GET(new Request("http://localhost/api/fitness/revisions", { headers }));
  assert.equal(response.status, 200);
  return (await response.json()).revisions;
}
async function create() {
  const id = `SYNTHETIC|CORRECTION|${++counter}`;
  const result = await call("POST", { measurementId: id, measuredAt: new Date(Date.UTC(2099, 0, 1, 0, 0, counter)).toISOString(), source: "Synthetic fixture", sourceDevice: "Synthetic scale", weightKg: 85, bodyFatPct: 22, muscleMassKg: 62, bodyWaterPct: 50, bmrKcalPerDay: 1900 });
  assert.equal(result.status, 201, JSON.stringify(result));
  return read(id);
}
function correction(current, values, reason = "Owner correction") {
  return { action: "correct", measurementId: current.measurement.measurementId, expectedRevision: current.revision, reason, values };
}

test("correction replaces supplied values atomically, preserves identity/history and updates derived values and revisions", async () => {
  const initial = await create();
  const before = await revisions();
  const payload = correction(initial, { weightKg: 84, bodyFatPct: 25, muscleMassKg: 61, bmrKcalPerDay: 1800, muscleMassLeftArmKg: 3.1 });
  const result = await call("PATCH", payload, "correct-complete-measurement");
  assert.equal(result.status, 200, JSON.stringify(result));
  const current = await read(payload.measurementId);
  for (const [field, value] of Object.entries(payload.values)) assert.equal(current.measurement[field], value);
  for (const field of ["measurementId", "createdAt", "measuredAt", "localDate", "source", "sourceDevice", "bodyWaterPct"]) assert.equal(current.measurement[field], initial.measurement[field]);
  assert.equal(current.measurement.fatMassKg, 21);
  assert.equal(current.measurement.estimatedFatFreeMassKg, 63);
  assert.equal(current.latestCorrection.reason, payload.reason);
  assert.deepEqual(current.latestCorrection.before.measurement, initial.measurement);
  assert.deepEqual(current.latestCorrection.after.measurement, current.measurement);
  assert.equal(result.body.revision, current.revision);
  assert.notEqual(current.revision, initial.revision);
  const after = await revisions();
  assert.notEqual(after.progress, before.progress);
  assert.notEqual(after.nutrition, before.nutrition);
  const db = new DatabaseSync(database, { readOnly: true });
  assert.equal(db.prepare("SELECT count(*) AS n FROM body_measurements WHERE measurement_id=?").get(payload.measurementId).n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM corrections WHERE target_key=?").get(payload.measurementId).n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM audit_log WHERE request_id=?").get("correct-complete-measurement").n, 1);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  db.close();
});

test("stale correction is rejected, identical retry is replayed, and later corrections do not change the original receipt", async () => {
  const initial = await create();
  const first = correction(initial, { weightKg: 80 });
  const firstResult = await call("PATCH", first, "replay-original-correction");
  assert.equal(firstResult.status, 200);
  const stale = await call("PATCH", correction(initial, { weightKg: 79 }));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.errorCode, "BODY_MEASUREMENT_REVISION_CONFLICT");
  const replay = await call("PATCH", first, "replay-original-correction");
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replay, true);
  const second = await call("PATCH", correction(await read(initial.measurement.measurementId), { bodyFatPct: null }));
  assert.equal(second.status, 200);
  assert.equal(second.body.measurement.fatMassKg, null);
  assert.equal(second.body.measurement.estimatedFatFreeMassKg, null);
  const oldReplay = await call("PATCH", first, "replay-original-correction");
  assert.deepEqual(oldReplay.body.measurement, firstResult.body.measurement);
  assert.equal(oldReplay.body.revision, firstResult.body.revision);
  assert.equal((await read(initial.measurement.measurementId)).measurement.bodyFatPct, null);
  const reused = await call("PATCH", { ...first, values: { weightKg: 79 } }, "replay-original-correction");
  assert.equal(reused.status, 409);
  assert.equal(reused.body.errorCode, "IDEMPOTENCY_KEY_CONFLICT");
});

test("invalid fields, missing idempotency, immutable fields and coercible strings cannot mutate a measurement", async () => {
  const initial = await create();
  for (const values of [{}, { weightKg: null }, { weightKg: "84" }, { weightKg: true }, { bodyFatPct: 101 }, { measuredAt: "2099-02-01T00:00:00Z" }, { fatMassKg: 22 }, { sourceDevice: "other" }, { bmrKcal: 1700 }]) {
    const result = await call("PATCH", correction(initial, values));
    assert.equal(result.status, 400, JSON.stringify(values));
  }
  assert.equal((await call("PATCH", { ...correction(initial, { weightKg: 84 }), unexpected: true })).status, 400);
  assert.equal((await call("PATCH", correction(initial, { weightKg: 84 }, " "))).status, 400);
  assert.equal((await call("PATCH", correction(initial, { weightKg: 84 }), "")).status, 400);
  assert.equal((await call("PATCH", correction(initial, { weightKg: 84 }), "no-auth-test", false)).status, 401);
  const missing = await call("PATCH", { ...correction(initial, { weightKg: 84 }), measurementId: "MISSING" });
  assert.equal(missing.status, 404);
  assert.deepEqual((await read(initial.measurement.measurementId)).measurement, initial.measurement);
});

test("enrichment remains fill-only and invalidates an earlier correction snapshot", async () => {
  const initial = await create();
  const enrich = await call("PATCH", { measurementId: initial.measurement.measurementId, expectedCreatedAt: initial.measurement.createdAt, values: { muscleQuality: 75 } });
  assert.equal(enrich.status, 200);
  const overwrite = await call("PATCH", { measurementId: initial.measurement.measurementId, expectedCreatedAt: initial.measurement.createdAt, values: { muscleQuality: 76 } });
  assert.equal(overwrite.status, 409);
  assert.equal((await call("PATCH", correction(initial, { weightKg: 84 }))).status, 409);
  const updated = await call("PATCH", correction(await read(initial.measurement.measurementId), { muscleQuality: 76 }));
  assert.equal(updated.status, 200);
  assert.equal(updated.body.measurement.muscleQuality, 76);
});

test("two concurrent corrections from one revision cannot overwrite one another", async () => {
  const initial = await create();
  const results = await Promise.all([
    call("PATCH", correction(initial, { weightKg: 81 }), "concurrent-correction-one"),
    call("PATCH", correction(initial, { weightKg: 82 }), "concurrent-correction-two"),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const current = await read(initial.measurement.measurementId);
  assert.equal(current.measurement.weightKg, results.find((result) => result.status === 200).body.measurement.weightKg);
});


test("failed audit storage rolls back both the overwrite and its correction snapshot", async () => {
  const initial = await create();
  const db = getLocalClient();
  await db.execute("CREATE TRIGGER fail_correction_audit BEFORE INSERT ON audit_log WHEN NEW.operation = 'correct' BEGIN SELECT RAISE(ABORT, 'Synthetic audit failure'); END");
  try {
    const failed = await call("PATCH", correction(initial, { weightKg: 75 }), "rollback-correction-test");
    assert.equal(failed.status, 500);
    const current = await read(initial.measurement.measurementId);
    assert.deepEqual(current.measurement, initial.measurement);
    assert.equal(current.revision, initial.revision);
    assert.equal(current.latestCorrection, null);
    assert.equal((await db.execute({ sql: "SELECT count(*) AS n FROM audit_log WHERE request_id=?", args: ["rollback-correction-test"] })).rows[0].n, 0);
  } finally {
    await db.execute("DROP TRIGGER fail_correction_audit");
  }
});

test("restoring prior values creates another history entry and does not revive an old revision", async () => {
  const initial = await create();
  await call("PATCH", correction(initial, { weightKg: 75 }));
  const changed = await read(initial.measurement.measurementId);
  const restored = await call("PATCH", correction(changed, { weightKg: initial.measurement.weightKg }, "Restore earlier value"));
  assert.equal(restored.status, 200);
  assert.equal(restored.body.measurement.weightKg, initial.measurement.weightKg);
  assert.notEqual(restored.body.revision, initial.revision);
  assert.equal((await call("PATCH", correction(initial, { weightKg: 74 }))).status, 409);
});
