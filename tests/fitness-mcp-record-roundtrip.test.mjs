import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

register("./helpers/typescript-alias-loader.mjs", import.meta.url);

test("MCP canonical measurements and one-off meal revisions round-trip through real API and disposable SQLite", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const temporary = mkdtempSync(join(tmpdir(), "fitness-record-roundtrip-"));
  const database = join(temporary, "fitness.sqlite");
  const initialized = spawnSync(process.execPath, [join(root, "scripts/init-local-sqlite.mjs"), "--path", database, "--goal", "Synthetic roundtrip", "--cycle", "Leg / Push / Pull / Rest", "--timezone", "Asia/Hong_Kong", "--locale", "en"], { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  process.env.FITNESS_SQLITE_PATH = database;
  process.env.FITNESS_API_TOKEN = "synthetic-record-roundtrip-token";
  const measurementRoute = await import("../app/api/fitness/body-measurements/route.ts");
  const mealRoute = await import("../app/api/nutrition/meals/route.ts");
  const todayRoute = await import("../app/api/nutrition/today/route.ts");
  const workoutRoute = await import("../app/api/fitness/workout-sessions/route.ts");
  const snapshotRoute = await import("../app/api/fitness/snapshot/route.ts");
  const { inferNextCyclePhase } = await import("../lib/training-cycle.ts");
  const { closeLocalDbForTests } = await import("../db/local-sqlite.ts");
  const seen = [];
  const server = createServer(async (incoming, outgoing) => {
    try {
      let body = "";
      for await (const chunk of incoming) body += chunk;
      const url = new URL(incoming.url, "http://127.0.0.1");
      seen.push(`${incoming.method} ${url.pathname}`);
      const route = url.pathname === "/api/fitness/workout-sessions" ? workoutRoute : url.pathname === "/api/fitness/snapshot" ? snapshotRoute : url.pathname === "/api/fitness/body-measurements" ? measurementRoute : url.pathname === "/api/nutrition/meals" ? mealRoute : todayRoute;
      const request = new Request(url, { method: incoming.method, headers: incoming.headers, ...(body ? { body } : {}) });
      const response = await route[incoming.method](request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(await response.text());
    } catch (error) {
      outgoing.writeHead(500);
      outgoing.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const child = spawn(process.execPath, [join(root, "agent-plugin/skills/open-fitness/scripts/fitness-mcp.mjs")], {
    env: { ...process.env, FITNESS_API_BASE_URL: `http://127.0.0.1:${server.address().port}` },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout });
  let id = 0;
  async function call(name, args) {
    const reply = once(lines, "line", { signal: AbortSignal.timeout(10000) });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } })}\n`);
    const result = JSON.parse((await reply)[0]);
    assert.ok(result.result, JSON.stringify(result));
    return JSON.parse(result.result.content[0].text);
  }
  const read = (args) => call("fitness_read", args);
  const write = (operation, requestId, body) => call("fitness_write", { operation, requestId, body });
  try {
    await read({ resource: "instructions" });
    await read({ resource: "write_contract", operation: "workout_create" });
    const snapshot = await read({ resource: "snapshot" });
    const cycle = snapshot.data.dashboard.trainingSchedule.cycle;
    const trainingCycleConfig = { version: 2, phases: cycle.map((phase) => ({ id: phase.id, label: phase.raw, kind: phase.kind, routine: [] })) };
    const baseWorkout = { title: "腿日", type: "Strength", startedAt: "2000-01-01T10:00:00+08:00", durationSeconds: 60, sessionIntent: "normal", sets: [{ exercise: "Squat", reps: 5, setNoExercise: 1 }] };
    const beforeMissing = seen.length;
    const missing = await write("workout_create", "missing-phase", baseWorkout);
    assert.equal(missing.status, "failed");
    assert.equal(missing.writeAttempted, false);
    assert.equal(seen.length, beforeMissing);
    for (const [index, title] of ["腿日", "腿部訓練", "腿部训练", "Leg Day"].entries()) {
      const savedWorkout = await write("workout_create", `phase-locale-${index}`, { ...baseWorkout, title, startedAt: `2000-01-0${index + 1}T10:00:00+08:00`, trainingPhaseId: cycle[0].id });
      assert.equal(savedWorkout.status, "succeeded", JSON.stringify(savedWorkout));
      const exactWorkout = await read({ resource: "workout", sessionId: savedWorkout.entityIds.sessionId });
      assert.equal(savedWorkout.facts.cycleLinked, true);
      assert.equal(exactWorkout.data.session.trainingPhaseId, cycle[0].id);
      assert.equal(exactWorkout.data.session.sessionTitle, title);
      assert.equal(inferNextCyclePhase({ trainingCycleConfig, latestCompletedTitle: title, latestCompletedPhaseId: exactWorkout.data.session.trainingPhaseId, latestCompletedSessionType: "Strength", latestCompletedDate: exactWorkout.data.session.localDate, planningDate: "2000-01-10", completionNotes: [] }).id, cycle[1].id);
    }
    await read({ resource: "write_contract", operation: "body_measurement_create" });
    const measurement = {
      measurementId: "SYNTHETIC|scale|roundtrip", measuredAt: "2099-01-01T08:01:30.124+08:00", source: "Synthetic export", sourceDevice: "Synthetic scale", weightKg: 80,
      bmi: 25, bodyFatPct: 20, muscleMassKg: 60, bodyWaterPct: 50, visceralFatRating: 10, boneMassKg: 3, metabolicAgeYears: 30, physiqueRating: 6,
      bmrKcalPerDay: 1800, muscleQuality: 70,
      muscleMassLeftArmKg: 3, muscleMassRightArmKg: 3, muscleMassLeftLegKg: 10, muscleMassRightLegKg: 10, muscleMassTrunkKg: 34,
      muscleQualityLeftArm: 60, muscleQualityRightArm: 60, muscleQualityLeftLeg: 80, muscleQualityRightLeg: 80, muscleQualityTrunk: null,
      bodyFatLeftArmPct: 17, bodyFatRightArmPct: 17, bodyFatLeftLegPct: 22, bodyFatRightLegPct: 22, bodyFatTrunkPct: 21,
    };
    const saved = await write("body_measurement_create", "synthetic-measurement-create", measurement);
    assert.equal(saved.status, "succeeded", JSON.stringify(saved));
    const exact = await read({ resource: "body_measurement", measurementId: measurement.measurementId });
    for (const [field, value] of Object.entries(measurement)) assert.deepEqual(exact.data.measurement[field], value, field);
    const replay = await write("body_measurement_create", "synthetic-measurement-create", measurement);
    assert.equal(replay.status, "succeeded");
    assert.equal(replay.replay, true);

    await read({ resource: "write_contract", operation: "body_measurement_update" });
    const correction = {
      action: "correct", measurementId: measurement.measurementId,
      expectedRevision: exact.data.revision, reason: "Owner supplied corrected export",
      values: { weightKg: 79, bodyFatPct: 21, muscleMassKg: 59, bmrKcalPerDay: 1775, muscleMassLeftArmKg: 2.9, muscleQualityLeftArm: 61, bodyFatLeftArmPct: 18 },
    };
    const correctionStart = seen.length;
    const corrected = await write("body_measurement_update", "synthetic-measurement-correct", correction);
    assert.equal(corrected.status, "succeeded", JSON.stringify(corrected));
    assert.equal(seen.slice(correctionStart).filter((entry) => entry.startsWith("PATCH ")).length, 1);
    const afterCorrection = await read({ resource: "body_measurement", measurementId: measurement.measurementId });
    for (const [field, value] of Object.entries(correction.values)) assert.equal(afterCorrection.data.measurement[field], value);
    assert.equal(afterCorrection.data.measurement.measuredAt, measurement.measuredAt);
    assert.equal(afterCorrection.data.measurement.bodyWaterPct, measurement.bodyWaterPct);
    assert.equal(afterCorrection.data.measurement.fatMassKg, 16.59);
    assert.equal(afterCorrection.data.measurement.estimatedFatFreeMassKg, 62.41);
    const correctionReplay = await write("body_measurement_update", "synthetic-measurement-correct", correction);
    assert.equal(correctionReplay.status, "succeeded", JSON.stringify(correctionReplay));
    assert.equal(correctionReplay.replay, true);
    const staleCorrection = await write("body_measurement_update", "synthetic-measurement-stale", { ...correction, values: { weightKg: 78 } });
    assert.equal(staleCorrection.status, "conflict", JSON.stringify(staleCorrection));
    const clearOptional = await write("body_measurement_update", "synthetic-measurement-clear", { ...correction, expectedRevision: afterCorrection.data.revision, values: { bodyFatPct: null } });
    assert.equal(clearOptional.status, "succeeded", JSON.stringify(clearOptional));
    const superseded = await write("body_measurement_update", "synthetic-measurement-correct", correction);
    assert.equal(superseded.status, "uncertain", JSON.stringify(superseded));
    const invalidStart = seen.length;
    const invalidCorrection = await write("body_measurement_update", "synthetic-measurement-invalid", { ...correction, values: { weightKg: "78" } });
    assert.equal(invalidCorrection.status, "failed", JSON.stringify(invalidCorrection));
    assert.equal(seen.length, invalidStart);

    await read({ resource: "write_contract", operation: "meal_create" });
    const firstItem = { name: "Synthetic bun", quantity: 1, unit: "piece", nutrients: { energyKcal: 180, proteinG: 7 } };
    const meal = await write("meal_create", "synthetic-meal-create", { localDate: "2099-01-01", mealType: "breakfast", eatenAt: null, timePrecision: "date_only", items: [firstItem] });
    assert.equal(meal.status, "succeeded", JSON.stringify(meal));
    await read({ resource: "write_contract", operation: "meal_update" });
    const day = await read({ resource: "nutrition_today", date: "2099-01-01" });
    const existing = day.data.nutrition.meals.find((entry) => entry.mealId === meal.entityIds.mealId);
    const revision = { mealId: existing.mealId, expectedRevisionNo: existing.revisionNo, items: [...existing.items, { name: "Synthetic chicken estimate", quantity: 79, unit: "g", confidence: "low", nutrients: { energyKcal: 140, proteinG: 18 } }] };
    const before = seen.length;
    const revised = await write("meal_update", "synthetic-meal-revise", revision);
    assert.equal(revised.status, "succeeded", JSON.stringify(revised));
    assert.equal(seen.slice(before).filter((entry) => entry.startsWith("POST ") || entry.startsWith("PATCH ")).length, 1);
    const mealReplay = await write("meal_update", "synthetic-meal-revise", revision);
    assert.equal(mealReplay.status, "succeeded", JSON.stringify(mealReplay));
    assert.equal(mealReplay.replay, true);
    const updated = await read({ resource: "nutrition_today", date: "2099-01-01" });
    assert.equal(updated.data.nutrition.meals.length, 1);
    assert.equal(updated.data.nutrition.meals[0].revisionNo, existing.revisionNo + 1);
    assert.equal(updated.data.nutrition.meals[0].items.length, 2);
    assert.equal(updated.data.nutrition.meals[0].items[0].nutrients.energyKcal, 180);
    assert.equal(updated.data.nutrition.meals[0].items[1].quantity, 79);
  } finally {
    child.stdin.end();
    if (child.exitCode === null) await once(child, "exit");
    lines.close();
    await new Promise((resolve) => server.close(resolve));
    await closeLocalDbForTests();
    if (existsSync(`${database}-shm`)) unlinkSync(`${database}-shm`);
    if (existsSync(`${database}-wal`)) unlinkSync(`${database}-wal`);
    unlinkSync(database);
    rmdirSync(temporary);
  }
});
