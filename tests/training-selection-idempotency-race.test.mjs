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
  join(tmpdir(), "open-fitness-training-selection-race-"),
);
const databasePath = join(temporaryRoot, "fitness.sqlite");
const apiToken = "training-selection-idempotency-race-token";

const initialized = spawnSync(
  process.execPath,
  [
    join(repositoryRoot, "scripts", "init-local-sqlite.mjs"),
    "--path",
    databasePath,
    "--goal",
    "Training selection idempotency race",
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

const cycle = JSON.stringify({
  version: 2,
  phases: [
    {
      id: "push",
      label: "Push",
      kind: "training",
      routine: [
        {
          id: "press",
          label: "Press",
          preferredExercise: "Synthetic Press",
          alternatives: [
            "Synthetic Incline Press",
            "Synthetic Decline Press",
          ],
        },
      ],
    },
  ],
});
const fixture = new DatabaseSync(databasePath);
fixture
  .prepare(
    `UPDATE profile
        SET training_cycle = 'Push', training_cycle_config = ?`,
  )
  .run(cycle);
fixture.exec(`
  CREATE TABLE test_profile_updates (id INTEGER PRIMARY KEY);
  CREATE TRIGGER test_count_profile_updates
  AFTER UPDATE ON profile
  BEGIN
    INSERT INTO test_profile_updates (id) VALUES (NULL);
  END;
`);
fixture.close();

process.env.FITNESS_SQLITE_PATH = databasePath;
process.env.FITNESS_API_TOKEN = apiToken;

const selectionRoute = await import(
  new URL("../app/api/fitness/training-selections/route.ts", import.meta.url)
);
const { closeLocalDbForTests, getLocalClient } = await import(
  new URL("../db/local-sqlite.ts", import.meta.url)
);

function selectionRequest(requestId, body) {
  return new Request("http://127.0.0.1/api/fitness/training-selections", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
      "x-idempotency-key": requestId,
    },
    body: JSON.stringify(body),
  });
}

async function callSelection(requestId, body) {
  const response = await selectionRoute.POST(
    selectionRequest(requestId, body),
  );
  return { response, body: await response.json() };
}

async function runAtSameTransactionStart(operations) {
  const client = getLocalClient();
  const originalTransaction = client.transaction;
  let arrivals = 0;
  let releaseFirst;
  const secondArrived = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let releaseSecond;
  const firstCommitted = new Promise((resolve) => {
    releaseSecond = resolve;
  });
  client.transaction = async function (...args) {
    const arrival = arrivals;
    arrivals += 1;
    if (arrival === 0) {
      await secondArrived;
      const transaction = await originalTransaction.apply(client, args);
      const originalCommit = transaction.commit;
      transaction.commit = async function (...commitArgs) {
        await originalCommit.apply(transaction, commitArgs);
        releaseSecond();
      };
      return transaction;
    }
    releaseFirst();
    await firstCommitted;
    return originalTransaction.apply(client, args);
  };
  try {
    const results = await Promise.all(
      operations.map((operation) => operation()),
    );
    assert.equal(arrivals, operations.length);
    return results;
  } finally {
    client.transaction = originalTransaction;
  }
}

async function runAfterDelayedIdempotencyMiss(
  delayedOperation,
  winnerOperation,
) {
  const client = getLocalClient();
  const originalExecute = client.execute;
  let delayed = false;
  let releaseMiss;
  const winnerFinished = new Promise((resolve) => {
    releaseMiss = resolve;
  });
  let confirmMiss;
  const missFinished = new Promise((resolve) => {
    confirmMiss = resolve;
  });
  client.execute = async function (...args) {
    const result = await originalExecute.apply(client, args);
    const statement = args[0];
    const sql = typeof statement === "string" ? statement : statement?.sql;
    if (!delayed && typeof sql === "string" && /\baudit_log\b/i.test(sql)) {
      delayed = true;
      confirmMiss();
      await winnerFinished;
    }
    return result;
  };
  const delayedResult = delayedOperation();
  try {
    await missFinished;
    const winnerResult = await winnerOperation();
    releaseMiss();
    const replayOrConflict = await delayedResult;
    assert.equal(delayed, true);
    return [winnerResult, replayOrConflict];
  } finally {
    releaseMiss();
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

function storedSelections(venue) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT selection_id AS selectionId, exercise
           FROM training_exercise_selections
          WHERE phase_id = 'push' AND slot_id = 'press'
            AND scope = 'venue' AND scope_value = ?`,
      )
      .all(venue);
  } finally {
    database.close();
  }
}

function storedTemplateState() {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare(
        `SELECT profile_id AS profileId, updated_at AS updatedAt,
                training_cycle_config AS trainingCycleConfig
           FROM profile
          LIMIT 1`,
      )
      .get();
    assert.ok(row);
    const config = JSON.parse(row.trainingCycleConfig);
    return {
      profileId: row.profileId,
      updatedAt: row.updatedAt,
      preferredExercise: config.phases[0].routine[0].preferredExercise,
    };
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

test("concurrent identical training selections create once and replay once", async () => {
  const requestId = "training-selection-concurrent-identical";
  const payload = {
    phaseId: "push",
    slotId: "press",
    exercise: "Synthetic Press",
    scope: "venue",
    venue: "Identical Race Gym",
  };

  const results = await runAfterDelayedIdempotencyMiss(
    () => callSelection(requestId, payload),
    () => callSelection(requestId, payload),
  );

  assert.deepEqual(
    results.map(({ response }) => response.status).sort(),
    [200, 201],
  );
  assert.deepEqual(
    results.map(({ body }) => body.replay).sort(),
    [false, true],
  );
  assert.deepEqual(results[0].body.selection, results[1].body.selection);
  assert.deepEqual(
    storedSelections("identical race gym").map((row) => ({ ...row })),
    [
      {
        selectionId: results[0].body.selection.selectionId,
        exercise: payload.exercise,
      },
    ],
  );
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM audit_log
        WHERE request_id = ? AND entity_type = 'training_exercise_selection'`,
      requestId,
    ),
    1,
  );
});

test("concurrent changed training selection body conflicts without a second write", async () => {
  const requestId = "training-selection-concurrent-changed";
  const basePayload = {
    phaseId: "push",
    slotId: "press",
    scope: "venue",
    venue: "Changed Race Gym",
  };
  const results = await runAtSameTransactionStart([
    () =>
      callSelection(requestId, {
        ...basePayload,
        exercise: "Synthetic Press",
      }),
    () =>
      callSelection(requestId, {
        ...basePayload,
        exercise: "Synthetic Incline Press",
      }),
  ]);

  assert.deepEqual(
    results.map(({ response }) => response.status).sort(),
    [201, 409],
  );
  const created = results.find(({ response }) => response.status === 201);
  const conflict = results.find(({ response }) => response.status === 409);
  assert.ok(created);
  assert.ok(conflict);
  assert.equal(created.body.replay, false);
  assert.equal(conflict.body.errorCode, "IDEMPOTENCY_KEY_CONFLICT");
  assert.deepEqual(
    storedSelections("changed race gym").map((row) => ({ ...row })),
    [
      {
        selectionId: created.body.selection.selectionId,
        exercise: created.body.selection.exercise,
      },
    ],
  );
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM audit_log
        WHERE request_id = ? AND entity_type = 'training_exercise_selection'`,
      requestId,
    ),
    1,
  );
});

test("concurrent identical template selections commit once and replay once", async () => {
  const requestId = "training-template-selection-concurrent-identical";
  const before = storedTemplateState();
  const updatesBefore = scalar(
    "SELECT COUNT(*) AS value FROM test_profile_updates",
  );
  const payload = {
    phaseId: "push",
    slotId: "press",
    exercise: "Synthetic Incline Press",
    scope: "template",
    expectedUpdatedAt: before.updatedAt,
  };

  const results = await runAfterDelayedIdempotencyMiss(
    () => callSelection(requestId, payload),
    () => callSelection(requestId, payload),
  );

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
  assert.deepEqual(created.body.profile, replay.body.profile);
  assert.equal(created.body.exercise, payload.exercise);
  assert.equal(replay.body.exercise, payload.exercise);
  assert.notEqual(created.body.profile.updatedAt, before.updatedAt);
  assert.deepEqual(storedTemplateState(), {
    profileId: before.profileId,
    updatedAt: created.body.profile.updatedAt,
    preferredExercise: payload.exercise,
  });
  assert.equal(
    scalar("SELECT COUNT(*) AS value FROM test_profile_updates"),
    updatesBefore + 1,
  );
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM audit_log
        WHERE request_id = ? AND entity_type = 'training_routine_template'`,
      requestId,
    ),
    1,
  );
});

test("concurrent changed template selection body conflicts without a second mutation", async () => {
  const requestId = "training-template-selection-concurrent-changed";
  const before = storedTemplateState();
  const updatesBefore = scalar(
    "SELECT COUNT(*) AS value FROM test_profile_updates",
  );
  const basePayload = {
    phaseId: "push",
    slotId: "press",
    scope: "template",
    expectedUpdatedAt: before.updatedAt,
  };
  const results = await runAfterDelayedIdempotencyMiss(
    () =>
      callSelection(requestId, {
        ...basePayload,
        exercise: "Synthetic Press",
      }),
    () =>
      callSelection(requestId, {
        ...basePayload,
        exercise: "Synthetic Decline Press",
      }),
  );

  assert.deepEqual(
    results.map(({ response }) => response.status).sort(),
    [201, 409],
  );
  const created = results.find(({ response }) => response.status === 201);
  const conflict = results.find(({ response }) => response.status === 409);
  assert.ok(created);
  assert.ok(conflict);
  assert.equal(created.body.replay, false);
  assert.equal(conflict.body.errorCode, "IDEMPOTENCY_KEY_CONFLICT");
  assert.deepEqual(storedTemplateState(), {
    profileId: before.profileId,
    updatedAt: created.body.profile.updatedAt,
    preferredExercise: created.body.exercise,
  });
  assert.equal(
    scalar("SELECT COUNT(*) AS value FROM test_profile_updates"),
    updatesBefore + 1,
  );
  assert.equal(
    scalar(
      `SELECT COUNT(*) AS value FROM audit_log
        WHERE request_id = ? AND entity_type = 'training_routine_template'`,
      requestId,
    ),
    1,
  );
});
