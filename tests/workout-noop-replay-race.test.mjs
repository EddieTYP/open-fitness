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
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

register("./helpers/typescript-alias-loader.mjs", import.meta.url);

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), "open-fitness-workout-noop-race-"));
const databasePath = join(temporaryRoot, "fitness.sqlite");
const apiToken = "workout-noop-replay-race-test-token";

const initialized = spawnSync(
  process.execPath,
  [
    join(repositoryRoot, "scripts", "init-local-sqlite.mjs"),
    "--path",
    databasePath,
    "--goal",
    "Workout no-op replay race contract",
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
  INSERT INTO workout_sessions (
    session_id, source, session_title, session_type, started_at, ended_at,
    duration_seconds, total_sets_reported, started_at_utc, local_date,
    time_precision, voided_at, void_reason, voided_by
  ) VALUES
    (
      'WORKOUT|RACE|VOID', 'test', 'Voided workout', 'strength',
      '2099-02-01T10:00:00+08:00', '2099-02-01T11:00:00+08:00',
      3600, 0, '2099-02-01T02:00:00.000Z', '2099-02-01', 'exact',
      '2099-02-02T00:00:00.000Z', 'fixture', 'fixture'
    ),
    (
      'WORKOUT|RACE|ACTIVE', 'test', 'Active workout', 'strength',
      '2099-02-03T10:00:00+08:00', '2099-02-03T11:00:00+08:00',
      3600, 0, '2099-02-03T02:00:00.000Z', '2099-02-03', 'exact',
      NULL, NULL, NULL
    );
`);
fixture.close();

process.env.FITNESS_SQLITE_PATH = databasePath;
process.env.FITNESS_API_TOKEN = apiToken;

const workoutRoute = await import(
  new URL("../app/api/fitness/workout-sessions/route.ts", import.meta.url),
);
const { closeLocalDbForTests } = await import(
  new URL("../db/local-sqlite.ts", import.meta.url),
);

function patchRequest(requestId, body) {
  return new Request("http://127.0.0.1/api/fitness/workout-sessions", {
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
  const response = await workoutRoute.PATCH(patchRequest(requestId, body));
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

function workoutVoidedAt(sessionId) {
  return scalar(
    "SELECT voided_at AS value FROM workout_sessions WHERE session_id = ?",
    sessionId,
  );
}

function auditCount(requestId) {
  return scalar(
    `SELECT COUNT(*) AS value FROM audit_log
      WHERE request_id = ? AND entity_type = 'workout_session'`,
    requestId,
  );
}

after(async () => {
  await closeLocalDbForTests();
  if (existsSync(`${databasePath}-shm`)) unlinkSync(`${databasePath}-shm`);
  if (existsSync(`${databasePath}-wal`)) unlinkSync(`${databasePath}-wal`);
  if (existsSync(databasePath)) unlinkSync(databasePath);
  rmdirSync(temporaryRoot);
});

test("workout no-op receipts survive concurrent claim and later opposite action", async () => {
  const voidPayload = {
    action: "void",
    sessionId: "WORKOUT|RACE|VOID",
    reason: "Already voided",
  };
  const originalVoidedAt = workoutVoidedAt(voidPayload.sessionId);
  const voidRequestId = "workout-noop-race-void";

  const voidClaims = await Promise.all([
    callPatch(voidRequestId, voidPayload),
    callPatch(voidRequestId, voidPayload),
  ]);
  assert.deepEqual(
    voidClaims.map(({ response }) => response.status).sort(),
    [200, 200],
  );
  assert.deepEqual(
    voidClaims.map(({ body }) => body.replay).sort(),
    [false, true],
  );
  assert.ok(voidClaims.every(({ body }) => body.noOp === true));
  assert.ok(voidClaims.every(({ body }) => body.voidedAt === originalVoidedAt));
  assert.equal(workoutVoidedAt(voidPayload.sessionId), originalVoidedAt);
  assert.equal(auditCount(voidRequestId), 1);

  const restored = await callPatch("workout-noop-race-restore", {
    ...voidPayload,
    action: "restore",
    reason: "Later opposite action",
  });
  assert.equal(restored.response.status, 200);
  assert.equal(restored.body.replay, false);
  assert.equal(restored.body.voidedAt, null);
  assert.equal(workoutVoidedAt(voidPayload.sessionId), null);

  const historicVoidReplay = await callPatch(voidRequestId, voidPayload);
  assert.equal(historicVoidReplay.response.status, 200);
  assert.equal(historicVoidReplay.body.replay, true);
  assert.equal(historicVoidReplay.body.noOp, true);
  assert.equal(historicVoidReplay.body.voidedAt, originalVoidedAt);
  assert.equal(workoutVoidedAt(voidPayload.sessionId), null);

  const voidConflict = await callPatch(voidRequestId, {
    ...voidPayload,
    reason: "Different body",
  });
  assert.equal(voidConflict.response.status, 409);
  assert.equal(voidConflict.body.errorCode, "IDEMPOTENCY_KEY_CONFLICT");

  const restorePayload = {
    action: "restore",
    sessionId: "WORKOUT|RACE|ACTIVE",
    reason: "Already active",
  };
  const restoreRequestId = "workout-noop-race-restore-noop";
  const restoreClaims = await Promise.all([
    callPatch(restoreRequestId, restorePayload),
    callPatch(restoreRequestId, restorePayload),
  ]);
  assert.deepEqual(
    restoreClaims.map(({ response }) => response.status).sort(),
    [200, 200],
  );
  assert.deepEqual(
    restoreClaims.map(({ body }) => body.replay).sort(),
    [false, true],
  );
  assert.ok(restoreClaims.every(({ body }) => body.noOp === true));
  assert.ok(restoreClaims.every(({ body }) => body.voidedAt === null));
  assert.equal(workoutVoidedAt(restorePayload.sessionId), null);
  assert.equal(auditCount(restoreRequestId), 1);

  const laterVoided = await callPatch("workout-noop-race-later-void", {
    ...restorePayload,
    action: "void",
    reason: "Later opposite action",
  });
  assert.equal(laterVoided.response.status, 200);
  assert.equal(typeof laterVoided.body.voidedAt, "string");
  const laterVoidedAt = workoutVoidedAt(restorePayload.sessionId);
  assert.equal(laterVoidedAt, laterVoided.body.voidedAt);

  const historicRestoreReplay = await callPatch(
    restoreRequestId,
    restorePayload,
  );
  assert.equal(historicRestoreReplay.response.status, 200);
  assert.equal(historicRestoreReplay.body.replay, true);
  assert.equal(historicRestoreReplay.body.noOp, true);
  assert.equal(historicRestoreReplay.body.voidedAt, null);
  assert.equal(workoutVoidedAt(restorePayload.sessionId), laterVoidedAt);
});
