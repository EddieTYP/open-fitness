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
const temporaryRoot = mkdtempSync(join(tmpdir(), "open-fitness-workout-create-race-"));
const databasePath = join(temporaryRoot, "fitness.sqlite");
const apiToken = "workout-create-idempotency-race-token";

const initialized = spawnSync(
  process.execPath,
  [
    join(repositoryRoot, "scripts", "init-local-sqlite.mjs"),
    "--path",
    databasePath,
    "--goal",
    "Workout create idempotency race",
    "--cycle",
    "Push,Pull,Rest",
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

const workoutRoute = await import(
  new URL("../app/api/fitness/workout-sessions/route.ts", import.meta.url),
);
const { closeLocalDbForTests, getLocalClient } = await import(
  new URL("../db/local-sqlite.ts", import.meta.url),
);

function workoutRequest(requestId, body) {
  return new Request("http://127.0.0.1/api/fitness/workout-sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
      "x-idempotency-key": requestId,
    },
    body: JSON.stringify(body),
  });
}

async function callWorkout(requestId, body) {
  const response = await workoutRoute.POST(workoutRequest(requestId, body));
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

function storedWorkout(sessionId) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT session_id AS sessionId, started_at_utc AS startedAtUtc,
                notes_manual AS notesManual, total_sets_reported AS totalSetsReported
           FROM workout_sessions
          WHERE session_id = ?`,
      )
      .get(sessionId);
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

test("concurrent identical workout creates commit once and replay once", async () => {
  const requestId = "workout-create-concurrent-same-request";
  const payload = {
    source: "Workout identical race",
    title: "Concurrent push",
    type: "strength",
    startedAt: "2099-03-01T10:00:00+08:00",
    durationSeconds: 3600,
    notesManual: "one durable workout",
    sets: [
      {
        exercise: "Bench Press",
        weightKgReported: 60,
        reps: 8,
      },
    ],
  };

  const results = await runAtSameIdempotencyPreflight([
    () => callWorkout(requestId, payload),
    () => callWorkout(requestId, payload),
  ]);

  assert.deepEqual(
    results.map(({ response }) => response.status).sort(),
    [200, 201],
  );
  assert.deepEqual(
    results.map(({ body }) => body.replay).sort(),
    [false, true],
  );
  const created = results.find(({ response }) => response.status === 201);
  const replay = results.find(({ response }) => response.status === 200);
  assert.ok(created);
  assert.ok(replay);
  assert.equal(replay.body.sessionId, created.body.sessionId);
  assert.equal(replay.body.setsInserted, 0);
  assert.deepEqual(
    { ...storedWorkout(created.body.sessionId) },
    {
      sessionId: created.body.sessionId,
      startedAtUtc: "2099-03-01T02:00:00.000Z",
      notesManual: payload.notesManual,
      totalSetsReported: 1,
    },
  );
  assert.equal(
    scalar(
      "SELECT COUNT(*) AS value FROM workout_sessions WHERE source = ?",
      payload.source,
    ),
    1,
  );
  assert.equal(
    scalar(
      "SELECT COUNT(*) AS value FROM workout_sets WHERE session_id = ?",
      created.body.sessionId,
    ),
    1,
  );
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM audit_log
        WHERE request_id = ? AND entity_type = 'workout_session'`,
      requestId,
    ),
    1,
  );
  assert.equal(
    scalar(
      `SELECT entity_id AS value FROM audit_log
        WHERE request_id = ? AND entity_type = 'workout_session'`,
      requestId,
    ),
    created.body.sessionId,
  );

  const laterReplay = await callWorkout(requestId, payload);
  assert.equal(laterReplay.response.status, 200);
  assert.equal(laterReplay.body.replay, true);
  assert.equal(laterReplay.body.sessionId, created.body.sessionId);
});

test("concurrent different workout bodies reserve one idempotency result", async () => {
  const requestId = "workout-create-concurrent-different-request";
  const candidates = [
    {
      source: "Workout different-body race",
      title: "Candidate push",
      type: "strength",
      startedAt: "2099-03-02T10:00:00+08:00",
      durationSeconds: 3600,
      notesManual: "candidate A",
      sets: [
        {
          exercise: "Incline Press",
          weightKgReported: 45,
          reps: 10,
        },
      ],
    },
    {
      source: "Workout different-body race",
      title: "Candidate pull",
      type: "strength",
      startedAt: "2099-03-03T10:00:00+08:00",
      durationSeconds: 3600,
      notesManual: "candidate B",
      sets: [
        {
          exercise: "Lat Pulldown",
          weightKgReported: 50,
          reps: 10,
        },
      ],
    },
  ];

  const results = await runAtSameIdempotencyPreflight(
    candidates.map((payload) => () => callWorkout(requestId, payload)),
  );

  assert.deepEqual(
    results.map(({ response }) => response.status).sort(),
    [201, 409],
  );
  const winnerIndex = results.findIndex(({ response }) => response.status === 201);
  const loserIndex = winnerIndex === 0 ? 1 : 0;
  const created = results[winnerIndex];
  const conflict = results[loserIndex];
  assert.equal(created.body.replay, false);
  assert.equal(conflict.body.errorCode, "IDEMPOTENCY_KEY_CONFLICT");
  assert.notEqual(conflict.body.errorCode, "RESOURCE_CONFLICT");
  assert.deepEqual(
    { ...storedWorkout(created.body.sessionId) },
    {
      sessionId: created.body.sessionId,
      startedAtUtc: new Date(candidates[winnerIndex].startedAt).toISOString(),
      notesManual: candidates[winnerIndex].notesManual,
      totalSetsReported: 1,
    },
  );
  assert.equal(
    scalar(
      "SELECT COUNT(*) AS value FROM workout_sessions WHERE source = ?",
      "Workout different-body race",
    ),
    1,
  );
  assert.equal(
    scalar(
      "SELECT COUNT(*) AS value FROM workout_sets WHERE session_id = ?",
      created.body.sessionId,
    ),
    1,
  );
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM audit_log
        WHERE request_id = ? AND entity_type = 'workout_session'`,
      requestId,
    ),
    1,
  );
  assert.equal(
    scalar(
      `SELECT entity_id AS value FROM audit_log
        WHERE request_id = ? AND entity_type = 'workout_session'`,
      requestId,
    ),
    created.body.sessionId,
  );

  const replay = await callWorkout(requestId, candidates[winnerIndex]);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.replay, true);
  assert.equal(replay.body.sessionId, created.body.sessionId);
  const repeatedConflict = await callWorkout(requestId, candidates[loserIndex]);
  assert.equal(repeatedConflict.response.status, 409);
  assert.equal(repeatedConflict.body.errorCode, "IDEMPOTENCY_KEY_CONFLICT");
});
