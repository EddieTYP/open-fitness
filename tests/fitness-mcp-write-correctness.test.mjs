import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(
  new URL("../agent-plugin/skills/open-fitness/scripts/fitness-mcp.mjs", import.meta.url),
);
const shortTimeoutFixture = fileURLToPath(
  new URL("./fixtures/short-fetch-timeout.mjs", import.meta.url),
);

const writeOperations = [
  "workout_create",
  "workout_validate",
  "workout_update",
  "body_measurement_create",
  "body_measurement_enrich",
  "session_note_create",
  "correction_create",
  "training_exercise_select",
  "training_course_update",
  "training_block_start",
  "training_template_update",
  "food_item_create",
  "food_item_update",
  "meal_create",
  "meal_update",
  "meal_delete",
  "active_energy_create",
  "nutrition_target_set",
  "nutrition_formula_calibrate",
  "combo_create",
  "combo_update",
  "plan_create",
  "plan_update",
  "plan_delete",
];

function startMcp(baseUrl, options = {}) {
  const imports = options.imports ?? [];
  const child = spawn(
    process.execPath,
    [...imports.map((path) => `--import=${path}`), serverPath],
    {
      env: {
        ...process.env,
        FITNESS_API_BASE_URL: baseUrl,
        FITNESS_API_TOKEN: "write-correctness-test-token",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));

  const pending = new Map();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });

  let nextId = 1;
  function request(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}; stderr=${stderr}`));
      }, 3_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  async function close() {
    child.stdin.end();
    if (child.exitCode === null) await once(child, "exit");
    lines.close();
  }

  return { close, request };
}

function payload(result) {
  assert.equal(result.content.length, 1);
  return JSON.parse(result.content[0].text);
}

async function readCoreInstructions(mcp) {
  const result = payload(
    await mcp.request("tools/call", {
      name: "fitness_read",
      arguments: { resource: "instructions" },
    }),
  );
  assert.equal(result.ok, true);
  return result;
}

async function readWriteContract(mcp, operation) {
  const result = payload(
    await mcp.request("tools/call", {
      name: "fitness_read",
      arguments: { resource: "write_contract", operation },
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.data.operation, operation);
  return result;
}

async function readInstructions(mcp) {
  await readCoreInstructions(mcp);
  for (const operation of writeOperations) {
    await readWriteContract(mcp, operation);
  }
}

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function readJson(request) {
  return new Promise((resolve) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => resolve(body ? JSON.parse(body) : null));
  });
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

test("fitness MCP descriptor table exposes every compatible write operation", async () => {
  const api = await listen((_request, response) => json(response, 500, {}));
  const mcp = startMcp(api.baseUrl);
  try {
    const listed = await mcp.request("tools/list");
    const write = listed.tools.find((tool) => tool.name === "fitness_write");
    const read = listed.tools.find((tool) => tool.name === "fitness_read");
    assert.deepEqual(write.inputSchema.properties.operation.enum, writeOperations);
    assert.equal(read.inputSchema.properties.resource.enum.includes("write_contract"), true);
    assert.deepEqual(read.inputSchema.properties.operation.enum, writeOperations);
    const source = readFileSync(serverPath, "utf8");
    assert.equal(
      source.match(/preflight: noWritePreflight/g)?.length,
      writeOperations.length,
    );
    assert.match(
      source,
      /Write descriptors must declare preflight explicitly/,
    );
  } finally {
    await mcp.close();
    await api.close();
  }
});

test("plans read rejects guessed filters with exact allowed arguments", async () => {
  const seen = [];
  const api = await listen((request, response) => {
    seen.push(request.url);
    json(response, 200, { plans: [] });
  });
  const mcp = startMcp(api.baseUrl);
  try {
    const rejected = payload(
      await mcp.request("tools/call", {
        name: "fitness_read",
        arguments: { resource: "plans", date: "2099-08-28" },
      }),
    );
    assert.equal(rejected.errorCode, "INVALID_TOOL_ARGUMENTS");
    assert.deepEqual(rejected.facts.allowedArguments, ["resource"]);
    assert.match(rejected.facts.reason, /Unsupported argument: date/);
    assert.deepEqual(seen, []);

    const accepted = payload(
      await mcp.request("tools/call", {
        name: "fitness_read",
        arguments: { resource: "plans" },
      }),
    );
    assert.equal(accepted.ok, true);
    assert.deepEqual(seen, ["/api/nutrition/plans"]);

    const contract = await readWriteContract(mcp, "plan_update");
    assert.match(
      contract.data.rules.join(" "),
      /action add.*scheduledDate.*mealType.*preserve.*append/i,
    );
    assert.match(
      contract.data.rules.join(" "),
      /no pending plan matches.*plan_create.*multiple plans.*do not write/i,
    );
  } finally {
    await mcp.close();
    await api.close();
  }
});

test("plan read items round-trip through preserve-and-append revisions", async () => {
  let revisedBody = null;
  const existingPlan = {
    planId: "PLAN|ROUNDTRIP|1",
    scheduledDate: "2099-08-28",
    mealType: "lunch",
    status: "pending",
    versionNo: 1,
    items: [
      {
        planItemId: "PLAN|ROUNDTRIP|1|V1|ITEM|1",
        foodId: "FOOD|1",
        name: "Existing food",
        quantity: 100,
        unit: "g",
        confidence: "high",
        assumption: null,
        nutrients: { energyKcal: 100, proteinG: 10 },
        dataQualityFlags: "estimated",
      },
    ],
  };
  const api = await listen(async (request, response) => {
    if (request.method === "GET") {
      json(response, 200, { plans: [existingPlan] });
      return;
    }
    revisedBody = await readJson(request);
    json(response, 200, {
      planId: existingPlan.planId,
      versionNo: 2,
      requestId: request.headers["x-idempotency-key"],
      replay: false,
      plan: {
        ...existingPlan,
        versionNo: 2,
        items: revisedBody.items,
      },
    });
  });
  const mcp = startMcp(api.baseUrl);
  try {
    await readCoreInstructions(mcp);
    await readWriteContract(mcp, "plan_update");
    const read = payload(
      await mcp.request("tools/call", {
        name: "fitness_read",
        arguments: { resource: "plans" },
      }),
    );
    assert.equal(read.data.plans[0].items[0].dataQualityFlags, "estimated");

    const result = payload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: {
          operation: "plan_update",
          requestId: "plan-preserve-append-roundtrip",
          body: {
            action: "revise",
            planId: existingPlan.planId,
            expectedVersionNo: 1,
            items: [
              ...read.data.plans[0].items,
              { foodId: "FOOD|2", quantity: 1, unit: "serving" },
            ],
          },
        },
      }),
    );
    assert.equal(result.status, "succeeded");
    assert.equal(result.writeVerified, true);
    assert.equal(revisedBody.items.length, 2);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        revisedBody.items[0],
        "dataQualityFlags",
      ),
      false,
    );
  } finally {
    await mcp.close();
    await api.close();
  }
});

test("meal read items round-trip through full replacement updates", async () => {
  let revisedBody = null;
  const existingMeal = {
    mealId: "MEAL|ROUNDTRIP|1",
    localDate: "2099-08-29",
    eatenAt: null,
    timePrecision: "date_only",
    mealType: "lunch",
    revisionNo: 1,
    items: [
      {
        mealItemId: "MEAL|ROUNDTRIP|1|REV|1|ITEM|1",
        foodId: "FOOD|1",
        name: "Existing food",
        quantity: 100,
        unit: "g",
        confidence: "high",
        assumption: null,
        nutrients: { energyKcal: 100, proteinG: 10 },
        dataQualityFlags: "estimated",
      },
    ],
  };
  const api = await listen(async (request, response) => {
    if (request.method === "GET") {
      json(response, 200, {
        localDate: existingMeal.localDate,
        meals: [existingMeal],
      });
      return;
    }
    revisedBody = await readJson(request);
    json(response, 200, {
      mealId: existingMeal.mealId,
      revisionNo: 2,
      requestId: request.headers["x-idempotency-key"],
      replay: false,
      nutrition: {
        meals: [
          {
            ...existingMeal,
            revisionNo: 2,
            items: revisedBody.items,
          },
        ],
      },
    });
  });
  const mcp = startMcp(api.baseUrl);
  try {
    await readCoreInstructions(mcp);
    await readWriteContract(mcp, "meal_update");
    const read = payload(
      await mcp.request("tools/call", {
        name: "fitness_read",
        arguments: {
          resource: "nutrition_today",
          date: existingMeal.localDate,
        },
      }),
    );
    assert.equal(read.data.meals[0].items[0].dataQualityFlags, "estimated");

    const result = payload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: {
          operation: "meal_update",
          requestId: "meal-full-replacement-roundtrip",
          body: {
            mealId: existingMeal.mealId,
            expectedRevisionNo: 1,
            items: read.data.meals[0].items,
          },
        },
      }),
    );
    assert.equal(result.status, "succeeded");
    assert.equal(result.writeVerified, true);
    assert.equal(revisedBody.items.length, 1);
    assert.equal(
      Object.prototype.hasOwnProperty.call(revisedBody.items[0], "mealItemId"),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        revisedBody.items[0],
        "dataQualityFlags",
      ),
      false,
    );
  } finally {
    await mcp.close();
    await api.close();
  }
});

test("body measurement create returns verified bounded comparison facts", async () => {
  const seen = [];
  let mutations = 0;
  const api = await listen(async (request, response) => {
    seen.push(`${request.method} ${request.url}`);
    if (request.method === "POST") {
      mutations += 1;
      await readJson(request);
      json(response, mutations === 1 ? 201 : 200, {
        measurementId: "MEASUREMENT|TANITA|1",
        requestId: request.headers["x-idempotency-key"],
        replay: mutations > 1,
      });
      return;
    }
    json(response, 200, {
      measurement: {
        measurementId: "MEASUREMENT|TANITA|1",
        measuredAt: "2099-08-27T07:42:00+08:00",
        localDate: "2099-08-27",
        source: "TANITA export",
        sourceDevice: "TANITA A",
        weightKg: 85.5,
        bodyFatPct: 22.4,
        muscleMassKg: 63.5,
        bodyWaterPct: 49.8,
        visceralFatRating: 10,
      },
      trend: {
        sourceDevice: "TANITA A",
        previous: {
          measurementId: "MEASUREMENT|TANITA|0",
          measuredAt: "2099-08-26T07:40:00+08:00",
          localDate: "2099-08-26",
          values: { weightKg: 85.9, bodyFatPct: null },
        },
        deltaFromPrevious: { weightKg: -0.4 },
        sevenDay: {
          sampleCount: 5,
          dateRange: { from: "2099-08-21", to: "2099-08-27" },
          sufficient: true,
          averages: { weightKg: 86 },
          firstToLatestChange: { weightKg: -0.9 },
        },
      },
    });
  });
  const mcp = startMcp(api.baseUrl);
  try {
    await readCoreInstructions(mcp);
    const contract = await readWriteContract(mcp, "body_measurement_create");
    assert.deepEqual(contract.data.requiredReads, []);
    assert.match(
      contract.data.rules.join(" "),
      /sevenDay\.sufficient.*true.*trend is not yet sufficient/i,
    );
    const written = payload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: {
          operation: "body_measurement_create",
          requestId: "body-measurement-bounded-trend",
          body: {
            measurementId: "MEASUREMENT|TANITA|1",
            measuredAt: "2099-08-27T07:42:00+08:00",
            source: "TANITA export",
            sourceDevice: "TANITA A",
            weightKg: 85.5,
            bodyFatPct: 22.4,
            muscleMassKg: 63.5,
            bodyWaterPct: 49.8,
            visceralFatRating: 10,
          },
        },
      }),
    );
    assert.equal(written.status, "succeeded");
    assert.equal(written.writeVerified, true);
    assert.equal(written.facts.measurement.weightKg, 85.5);
    assert.equal(written.facts.comparison.deltaFromPrevious.weightKg, -0.4);
    assert.equal(written.facts.comparison.sevenDay.sampleCount, 5);
    assert.equal(
      written.facts.comparison.sevenDay.firstToLatestChange.weightKg,
      -0.9,
    );
    assert.ok(Buffer.byteLength(JSON.stringify(written.facts)) < 8_192);

    const replayed = payload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: {
          operation: "body_measurement_create",
          requestId: "body-measurement-bounded-trend",
          body: {
            measurementId: "MEASUREMENT|TANITA|1",
            measuredAt: "2099-08-27T07:42:00+08:00",
            source: "TANITA export",
            sourceDevice: "TANITA A",
            weightKg: 85.5,
            bodyFatPct: 22.4,
            muscleMassKg: 63.5,
            bodyWaterPct: 49.8,
            visceralFatRating: 10,
          },
        },
      }),
    );
    assert.equal(replayed.status, "succeeded");
    assert.equal(replayed.replay, true);
    assert.deepEqual(replayed.facts, written.facts);
    assert.deepEqual(seen, [
      "POST /api/fitness/body-measurements",
      "GET /api/fitness/body-measurements?measurementId=MEASUREMENT%7CTANITA%7C1",
      "POST /api/fitness/body-measurements",
      "GET /api/fitness/body-measurements?measurementId=MEASUREMENT%7CTANITA%7C1",
    ]);
  } finally {
    await mcp.close();
    await api.close();
  }
});

test("fitness MCP write eligibility survives a connector restart", async () => {
  let mutations = 0;
  let storedNote = null;
  const api = await listen(async (request, response) => {
    if (request.method === "GET") {
      json(response, 200, {
        sessionNotes: [{ noteId: "NOTE|GATED", ...storedNote }],
        nutrition: { energyObservations: [] },
      });
      return;
    }
    mutations += 1;
    storedNote = await readJson(request);
    json(response, 201, {
      noteId: "NOTE|GATED",
      requestId: request.headers["x-idempotency-key"],
    });
  });
  const writeArguments = {
    operation: "session_note_create",
    requestId: "request-restart-0001",
    body: {
      noteDate: "2099-01-01",
      noteType: "observation",
      note: "Restart-safe write.",
    },
  };
  const bootstrapMcp = startMcp(api.baseUrl);
  let bootstrapClosed = false;
  let restartedMcp = null;
  try {
    await readCoreInstructions(bootstrapMcp);
    await readWriteContract(bootstrapMcp, "session_note_create");
    await bootstrapMcp.close();
    bootstrapClosed = true;

    restartedMcp = startMcp(api.baseUrl);
    const succeeded = payload(
      await restartedMcp.request("tools/call", {
        name: "fitness_write",
        arguments: writeArguments,
      }),
    );
    assert.equal(succeeded.status, "succeeded");
    assert.equal(succeeded.writeAttempted, true);
    assert.equal(succeeded.writeVerified, true);
    assert.equal(mutations, 1);
    await restartedMcp.close();
    restartedMcp = null;
  } finally {
    if (!bootstrapClosed) await bootstrapMcp.close();
    if (restartedMcp) await restartedMcp.close();
    await api.close();
  }
});

test("fitness MCP serves bounded canonical write contracts for every operation", async () => {
  const api = await listen((_request, response) => json(response, 500, {}));
  const mcp = startMcp(api.baseUrl);
  try {
    const instructions = await readCoreInstructions(mcp);
    assert.ok(Buffer.byteLength(JSON.stringify(instructions), "utf8") < 6_000);
    assert.deepEqual(instructions.data.references.writeContract, {
      resource: "write_contract",
      requiredArgument: "operation",
    });
    assert.equal(instructions.data.skill, undefined);
    assert.equal(instructions.data.contract, undefined);
    assert.equal(instructions.data.evidence, undefined);

    for (const operation of writeOperations) {
      const contract = await readWriteContract(mcp, operation);
      assert.ok(Buffer.byteLength(JSON.stringify(contract), "utf8") < 4_096);
      assert.equal(typeof contract.data.purpose, "string");
      assert.equal(Array.isArray(contract.data.requiredReads), true);
      assert.equal(typeof contract.data.bodyTemplate, "object");
      assert.equal(Array.isArray(contract.data.rules), true);
    }

    const food = await readWriteContract(mcp, "food_item_create");
    assert.equal(food.data.bodyTemplate.baseUnit, "g");
    assert.equal(food.data.bodyTemplate.defaultUnit, undefined);
    assert.match(food.data.rules.join(" "), /defaultUnit.*read-only/i);

    const plan = await readWriteContract(mcp, "plan_create");
    assert.match(plan.data.purpose, /pending/i);
    assert.match(plan.data.rules.join(" "), /one plan_create.*scheduledDates/i);
    assert.match(plan.data.rules.join(" "), /Do not call meal_create/i);
  } finally {
    await mcp.close();
    await api.close();
  }
});

test("fitness MCP emits a bounded succeeded envelope for one mutation", async () => {
  let mutations = 0;
  let storedNote = null;
  const api = await listen(async (request, response) => {
    if (request.method === "GET") {
      json(response, 200, {
        sessionNotes: [{ noteId: "NOTE|1", ...storedNote }],
        nutrition: { energyObservations: [] },
      });
      return;
    }
    mutations += 1;
    storedNote = await readJson(request);
    json(response, 201, {
      noteId: "NOTE|1",
      requestId: request.headers["x-idempotency-key"],
      replay: false,
      ignoredLargeDomainObject: { text: "not returned" },
    });
  });
  const mcp = startMcp(api.baseUrl);
  try {
    await readInstructions(mcp);
    const result = payload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: {
          operation: "session_note_create",
          requestId: "request-note-0001",
          body: {
            noteDate: "2099-01-01",
            noteType: "observation",
            note: "Felt good.",
          },
        },
      }),
    );
    assert.deepEqual(result, {
      status: "succeeded",
      operation: "session_note_create",
      requestId: "request-note-0001",
      writeAttempted: true,
      writeVerified: true,
      replay: false,
      entityIds: { noteId: "NOTE|1" },
      facts: {},
      errorCode: null,
      retryable: false,
    });
    assert.equal(mutations, 1);
  } finally {
    await mcp.close();
    await api.close();
  }
});

test("workout void and restore receipts verify requestId through route readback", async () => {
  let state = {
    sessionId: "WORKOUT|UPDATE|1",
    voidedAt: null,
    voidReason: null,
  };
  let mutations = 0;
  let reads = 0;
  const api = await listen(async (request, response) => {
    if (request.method === "GET") {
      reads += 1;
      json(response, 200, { session: state, sets: [] });
      return;
    }
    mutations += 1;
    const body = await readJson(request);
    state = {
      ...state,
      voidedAt:
        body.action === "void" ? "2099-01-02T12:00:00.000Z" : null,
      voidReason: body.action === "void" ? body.reason : null,
    };
    json(response, 200, {
      contractVersion: "workout-v1",
      sessionId: state.sessionId,
      action: body.action,
      voidedAt: state.voidedAt,
      requestId: request.headers["x-idempotency-key"],
      replay: false,
    });
  });
  const mcp = startMcp(api.baseUrl);
  try {
    await readInstructions(mcp);
    const voided = payload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: {
          operation: "workout_update",
          requestId: "request-workout-void-0001",
          body: {
            action: "void",
            sessionId: state.sessionId,
            reason: "Correcting duplicate workout",
          },
        },
      }),
    );
    assert.equal(voided.status, "succeeded");
    assert.equal(voided.writeVerified, true);
    assert.equal(voided.requestId, "request-workout-void-0001");
    assert.deepEqual(voided.entityIds, { sessionId: state.sessionId });

    const restored = payload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: {
          operation: "workout_update",
          requestId: "request-workout-restore-0001",
          body: {
            action: "restore",
            sessionId: state.sessionId,
            reason: "Duplicate confirmed",
          },
        },
      }),
    );
    assert.equal(restored.status, "succeeded");
    assert.equal(restored.writeVerified, true);
    assert.equal(restored.requestId, "request-workout-restore-0001");
    assert.deepEqual(restored.entityIds, { sessionId: state.sessionId });
    assert.equal(mutations, 2);
    assert.equal(reads, 2);
  } finally {
    await mcp.close();
    await api.close();
  }
});

test("grouped workout aliases verify through nested workoutSessions[0] readback", async () => {
  const received = [];
  let mutations = 0;
  let reads = 0;
  const api = await listen(async (request, response) => {
    if (request.method === "POST") {
      mutations += 1;
      received.push(await readJson(request));
      json(response, 201, {
        sessionId: "WORKOUT|GROUPED|1",
        setsInserted: 2,
        requestId: request.headers["x-idempotency-key"],
      });
      return;
    }
    reads += 1;
    json(response, 200, {
      data: {
        workoutSessions: [
          {
            sessionId: "WORKOUT|GROUPED|1",
            sessionTitle: "Grouped session",
            sessionType: "Strength",
            startedAt: "2099-01-02T10:00:00Z",
            durationSeconds: 3600,
            sessionIntent: "normal",
            trainingPhaseId: "push",
            timePrecision: "minute",
            sets: [
              {
                exercise: "Bench Press",
                reps: 8,
                setNoExercise: 1,
                weightKgReported: 50,
              },
              {
                exercise: "Bench Press",
                reps: 8,
                setNoExercise: 2,
                weightKgReported: 50,
              },
            ],
          },
        ],
      },
    });
  });
  const mcp = startMcp(api.baseUrl);
  try {
    await readInstructions(mcp);
    const result = payload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: {
          operation: "workout_create",
          body: {
            sessionTitle: "Grouped session",
            sessionType: "Strength",
            startedAt: "2099-01-02T10:00:00Z",
            durationSeconds: 3600,
            sessionIntent: "normal",
            trainingPhaseId: "push",
            timePrecision: "minute",
            exercises: [
              {
                exerciseName: "Bench Press",
                sets: [
                  { reps: 8, setNumber: 1, weightKg: 50 },
                  { reps: 8, setNumber: 2, weightKg: 50 },
                ],
              },
            ],
          },
        },
      }),
    );
    assert.equal(result.status, "succeeded");
    assert.equal(result.writeVerified, true);
    assert.deepEqual(result.entityIds, { sessionId: "WORKOUT|GROUPED|1" });
    assert.equal(mutations, 1);
    assert.equal(reads, 1);
    assert.deepEqual(received[0].sets, [
      {
        exercise: "Bench Press",
        reps: 8,
        setNoExercise: 1,
        weightKgReported: 50,
      },
      {
        exercise: "Bench Press",
        reps: 8,
        setNoExercise: 2,
        weightKgReported: 50,
      },
    ]);
    assert.equal(received[0].title, "Grouped session");
    assert.equal(received[0].type, "Strength");
    assert.equal(received[0].exercises, undefined);
  } finally {
    await mcp.close();
    await api.close();
  }
});

test("400 fails and 409 conflicts without a second mutation", async () => {
  let mutations = 0;
  const api = await listen(async (request, response) => {
    mutations += 1;
    const body = await readJson(request);
    if (body.note === "bad") {
      json(response, 400, {
        errorCode: "INVALID_SESSION_NOTE",
        facts: { field: "note" },
      });
      return;
    }
    json(response, 409, {
      errorCode: "SESSION_NOTE_CONFLICT",
      facts: { noteId: "NOTE|OLD" },
    });
  });
  const mcp = startMcp(api.baseUrl);
  try {
    await readInstructions(mcp);
    const failed = payload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: {
          operation: "session_note_create",
          body: {
            noteDate: "2099-01-01",
            noteType: "observation",
            note: "bad",
          },
        },
      }),
    );
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, "INVALID_SESSION_NOTE");
    assert.equal(failed.writeAttempted, true);
    assert.equal(failed.writeVerified, false);

    const conflict = payload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: {
          operation: "session_note_create",
          body: {
            noteDate: "2099-01-01",
            noteType: "observation",
            note: "conflict",
          },
        },
      }),
    );
    assert.equal(conflict.status, "conflict");
    assert.equal(conflict.errorCode, "SESSION_NOTE_CONFLICT");
    assert.equal(conflict.retryable, false);
    assert.equal(mutations, 2);
  } finally {
    await mcp.close();
    await api.close();
  }
});

test("429 stays uncertain so only the same idempotent request may be retried", async () => {
  let mutations = 0;
  const api = await listen(async (request, response) => {
    mutations += 1;
    await readJson(request);
    json(response, 429, {
      errorCode: "FITNESS_API_RATE_LIMITED",
      facts: { retryAfterSeconds: 1 },
    });
  });
  const mcp = startMcp(api.baseUrl);
  try {
    await readInstructions(mcp);
    const result = payload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: {
          operation: "session_note_create",
          requestId: "rate-limit-request-0001",
          body: {
            noteDate: "2099-01-01",
            noteType: "observation",
            note: "Rate-limited write.",
          },
        },
      }),
    );
    assert.equal(result.status, "uncertain");
    assert.equal(result.errorCode, "FITNESS_API_RATE_LIMITED");
    assert.equal(result.writeAttempted, true);
    assert.equal(result.writeVerified, false);
    assert.equal(result.retryable, true);
    assert.equal(result.requestId, "rate-limit-request-0001");
    assert.equal(mutations, 1);
  } finally {
    await mcp.close();
    await api.close();
  }
});

test("ambiguous transport and readback stay uncertain with one mutation", async () => {
  let droppedMutations = 0;
  const dropped = await listen(async (request) => {
    droppedMutations += 1;
    await readJson(request);
    request.socket.destroy();
  });
  const droppedMcp = startMcp(dropped.baseUrl);
  try {
    await readInstructions(droppedMcp);
    const uncertain = payload(
      await droppedMcp.request("tools/call", {
        name: "fitness_write",
        arguments: {
          operation: "session_note_create",
          body: {
            noteDate: "2099-01-01",
            noteType: "observation",
            note: "transport",
          },
        },
      }),
    );
    assert.equal(uncertain.status, "uncertain");
    assert.equal(uncertain.errorCode, "FITNESS_API_UNAVAILABLE");
    assert.equal(uncertain.retryable, true);
    assert.equal(droppedMutations, 1);
  } finally {
    await droppedMcp.close();
    await dropped.close();
  }

  let mutations = 0;
  let reads = 0;
  const unreadable = await listen(async (request, response) => {
    if (request.method === "POST") {
      mutations += 1;
      await readJson(request);
      json(response, 201, {
        sessionId: "WORKOUT|UNREADABLE",
        requestId: request.headers["x-idempotency-key"],
      });
      return;
    }
    reads += 1;
    json(response, 503, { errorCode: "READBACK_UNAVAILABLE", facts: {} });
  });
  const unreadableMcp = startMcp(unreadable.baseUrl);
  try {
    await readInstructions(unreadableMcp);
    const uncertain = payload(
      await unreadableMcp.request("tools/call", {
        name: "fitness_write",
        arguments: {
          operation: "workout_create",
          body: {
            title: "Unreadable",
            type: "Strength",
            startedAt: "2099-01-02T10:00:00Z",
            durationSeconds: 3600,
            sessionIntent: "normal",
            sets: [],
          },
        },
      }),
    );
    assert.equal(uncertain.status, "uncertain");
    assert.equal(uncertain.errorCode, "READBACK_UNAVAILABLE");
    assert.equal(uncertain.writeAttempted, true);
    assert.equal(uncertain.writeVerified, false);
    assert.equal(uncertain.retryable, true);
    assert.deepEqual(uncertain.facts, { httpStatus: 503 });
    assert.deepEqual(uncertain.entityIds, {
      sessionId: "WORKOUT|UNREADABLE",
    });
    assert.equal(mutations, 1);
    assert.equal(reads, 1);
  } finally {
    await unreadableMcp.close();
    await unreadable.close();
  }
});

test("an explicit mutation timeout is uncertain and never auto-retried", async () => {
  let mutations = 0;
  const api = await listen(async (request, response) => {
    mutations += 1;
    await readJson(request);
    setTimeout(() => {
      json(response, 201, {
        noteId: "NOTE|TOO-LATE",
        requestId: request.headers["x-idempotency-key"],
      });
    }, 1_400);
  });
  const mcp = startMcp(api.baseUrl, { imports: [shortTimeoutFixture] });
  try {
    await readInstructions(mcp);
    const uncertain = payload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: {
          operation: "session_note_create",
          body: {
            noteDate: "2099-01-01",
            noteType: "observation",
            note: "Timeout fixture.",
          },
        },
      }),
    );
    assert.equal(uncertain.status, "uncertain");
    assert.equal(uncertain.errorCode, "FITNESS_API_UNAVAILABLE");
    assert.equal(uncertain.writeAttempted, true);
    assert.equal(uncertain.retryable, true);
    assert.equal(mutations, 1);
  } finally {
    await mcp.close();
    await api.close();
  }
});

test("a mismatched mutation response requestId stays uncertain without readback", async () => {
  let mutations = 0;
  let reads = 0;
  const api = await listen(async (request, response) => {
    if (request.method === "GET") {
      reads += 1;
      json(response, 200, { sessionNotes: [] });
      return;
    }
    mutations += 1;
    await readJson(request);
    json(response, 201, {
      noteId: "NOTE|WRONG-REQUEST",
      requestId: "different-request-id",
    });
  });
  const mcp = startMcp(api.baseUrl);
  try {
    await readInstructions(mcp);
    const uncertain = payload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: {
          operation: "session_note_create",
          requestId: "request-id-match-0001",
          body: {
            noteDate: "2099-01-01",
            noteType: "observation",
            note: "Request ID mismatch.",
          },
        },
      }),
    );
    assert.equal(uncertain.status, "uncertain");
    assert.equal(uncertain.errorCode, "MUTATION_REQUEST_ID_MISMATCH");
    assert.equal(uncertain.writeAttempted, true);
    assert.equal(uncertain.writeVerified, false);
    assert.equal(uncertain.retryable, false);
    assert.equal(mutations, 1);
    assert.equal(reads, 0);
  } finally {
    await mcp.close();
    await api.close();
  }
});

test("active energy uses one exact-date full-analysis readback", async () => {
  let mutations = 0;
  const readUrls = [];
  let storedObservation = null;
  const api = await listen(async (request, response) => {
    if (request.method === "GET") {
      readUrls.push(request.url);
      json(response, 200, {
        sessionNotes: [],
        nutrition: {
          energyObservations: [
            {
              energyObservationId: "ENERGY|1",
              ...storedObservation,
            },
          ],
        },
      });
      return;
    }
    mutations += 1;
    storedObservation = await readJson(request);
    json(response, 201, {
      energyObservationId: "ENERGY|1",
      requestId: request.headers["x-idempotency-key"],
      replay: false,
    });
  });
  const mcp = startMcp(api.baseUrl);
  try {
    await readInstructions(mcp);
    const result = payload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: {
          operation: "active_energy_create",
          requestId: "request-energy-0001",
          body: {
            localDate: "2099-01-05",
            activeEnergyKcal: 500,
            basalEnergyKcal: 1600,
            observedAt: null,
            status: "final",
            source: "Watch",
            note: "Complete day.",
          },
        },
      }),
    );
    assert.equal(result.status, "succeeded");
    assert.equal(result.writeVerified, true);
    assert.deepEqual(result.entityIds, { energyObservationId: "ENERGY|1" });
    assert.equal(mutations, 1);
    assert.deepEqual(readUrls, [
      "/api/fitness/analysis?from=2099-01-05&to=2099-01-05&view=full",
    ]);
  } finally {
    await mcp.close();
    await api.close();
  }
});

test("deterministic readback errors preserve facts without inviting a write retry", async () => {
  for (const readbackFailure of [
    {
      statusCode: 400,
      errorCode: "ANALYSIS_RESULT_TOO_LARGE",
      facts: { collection: "energyObservations", maximum: 200, actual: 201 },
    },
    {
      statusCode: 409,
      errorCode: "READBACK_STATE_CONFLICT",
      facts: { reason: "The requested state is no longer current" },
    },
  ]) {
    let mutations = 0;
    let reads = 0;
    const api = await listen(async (request, response) => {
      if (request.method === "GET") {
        reads += 1;
        json(response, readbackFailure.statusCode, {
          errorCode: readbackFailure.errorCode,
          facts: readbackFailure.facts,
        });
        return;
      }
      mutations += 1;
      await readJson(request);
      json(response, 201, {
        energyObservationId: `ENERGY|READBACK|${readbackFailure.statusCode}`,
        requestId: request.headers["x-idempotency-key"],
        replay: false,
      });
    });
    const mcp = startMcp(api.baseUrl);
    try {
      await readInstructions(mcp);
      const result = payload(
        await mcp.request("tools/call", {
          name: "fitness_write",
          arguments: {
            operation: "active_energy_create",
            requestId: `request-readback-${readbackFailure.statusCode}`,
            body: {
              localDate: "2099-01-05",
              activeEnergyKcal: 500,
              status: "final",
              source: "Watch",
            },
          },
        }),
      );
      assert.equal(result.status, "uncertain");
      assert.equal(result.errorCode, readbackFailure.errorCode);
      assert.equal(result.writeAttempted, true);
      assert.equal(result.writeVerified, false);
      assert.equal(result.retryable, false);
      assert.deepEqual(result.entityIds, {
        energyObservationId: `ENERGY|READBACK|${readbackFailure.statusCode}`,
      });
      assert.deepEqual(result.facts, {
        ...readbackFailure.facts,
        httpStatus: readbackFailure.statusCode,
      });
      assert.equal(mutations, 1);
      assert.equal(reads, 1);
    } finally {
      await mcp.close();
      await api.close();
    }
  }
});

test("same-key replay succeeds while a changed body conflicts without hidden retries", async () => {
  const stored = new Map();
  let mutations = 0;
  let readbacks = 0;
  const api = await listen(async (request, response) => {
    if (request.method === "GET") {
      readbacks += 1;
      json(response, 200, {
        sessionNotes: [...stored.values()].map(({ noteId, body }) => ({
          noteId,
          ...body,
        })),
        nutrition: { energyObservations: [] },
      });
      return;
    }
    mutations += 1;
    const body = await readJson(request);
    const requestId = request.headers["x-idempotency-key"];
    const existing = stored.get(requestId);
    if (existing && JSON.stringify(existing.body) !== JSON.stringify(body)) {
      json(response, 409, {
        errorCode: "IDEMPOTENCY_KEY_REUSED",
        facts: { requestId },
      });
      return;
    }
    const noteId = existing?.noteId ?? "NOTE|REPLAY|1";
    stored.set(requestId, { noteId, body });
    json(response, existing ? 200 : 201, {
      noteId,
      requestId,
      replay: Boolean(existing),
    });
  });
  const mcp = startMcp(api.baseUrl);
  const baseArguments = {
    operation: "session_note_create",
    requestId: "request-replay-0001",
    body: {
      noteDate: "2099-01-04",
      noteType: "observation",
      note: "Replay me.",
    },
  };
  try {
    await readInstructions(mcp);
    const first = payload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: baseArguments,
      }),
    );
    assert.equal(first.status, "succeeded");
    assert.equal(first.replay, false);

    const replayed = payload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: baseArguments,
      }),
    );
    assert.equal(replayed.status, "succeeded");
    assert.equal(replayed.replay, true);

    const conflict = payload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: {
          ...baseArguments,
          body: { ...baseArguments.body, note: "Changed body." },
        },
      }),
    );
    assert.equal(conflict.status, "conflict");
    assert.equal(conflict.errorCode, "IDEMPOTENCY_KEY_REUSED");
    assert.equal(mutations, 3);
    assert.equal(readbacks, 2);
  } finally {
    await mcp.close();
    await api.close();
  }
});

test("missing required input or receipt data never becomes a second write", async () => {
  let mutations = 0;
  const api = await listen(async (request, response) => {
    mutations += 1;
    await readJson(request);
    json(response, 201, {
      requestId: request.headers["x-idempotency-key"],
      replay: false,
    });
  });
  const mcp = startMcp(api.baseUrl);
  try {
    await readInstructions(mcp);
    const invalid = payload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: {
          operation: "session_note_create",
          body: { noteDate: "2099-01-01" },
        },
      }),
    );
    assert.equal(invalid.status, "failed");
    assert.equal(invalid.errorCode, "INVALID_TOOL_ARGUMENTS");
    assert.equal(invalid.writeAttempted, false);
    assert.equal(mutations, 0);

    for (const invalidArguments of [
      {
        operation: "workout_create",
        body: {
          title: "Missing duration and intent",
          type: "Strength",
          startedAt: "2099-01-02T10:00:00Z",
          sets: [],
        },
      },
      {
        operation: "body_measurement_create",
        body: {
          measuredAt: "2099-01-02T10:00:00Z",
          weightKg: 70,
        },
      },
      {
        operation: "plan_delete",
        body: { planId: "PLAN|1" },
      },
      {
        operation: "food_item_update",
        body: { foodId: "FOOD|1" },
      },
      {
        operation: "plan_update",
        body: { planId: "PLAN|1", expectedVersionNo: 1 },
      },
      {
        operation: "meal_update",
        body: {
          action: "quantity",
          mealId: "MEAL|1",
          mealItemId: "MEAL|1|REV|1|ITEM|1",
          expectedRevisionNo: 1,
          quantity: 0.2,
          units: "kg",
        },
      },
      {
        operation: "meal_create",
        body: {
          localDate: "2099-01-02",
          timePrecision: "date_only",
          mealType: "lunch",
          items: [{ foodId: "FOOD|1", quantity: 0.2, units: "kg" }],
        },
      },
      {
        operation: "meal_update",
        body: {
          mealId: "MEAL|1",
          expectedRevisionNo: 1,
          items: [{ foodId: "FOOD|1", quantity: 0.2, units: "kg" }],
        },
      },
      {
        operation: "combo_create",
        body: {
          displayName: "Synthetic combo",
          items: [{ foodId: "FOOD|1", quantity: 0.2, units: "kg" }],
        },
      },
      {
        operation: "combo_update",
        body: {
          action: "revise",
          comboId: "COMBO|1",
          expectedVersionNo: 1,
          items: [{ foodId: "FOOD|1", quantity: 0.2, units: "kg" }],
        },
      },
      {
        operation: "plan_create",
        body: {
          scheduledDate: "2099-01-02",
          mealType: "lunch",
          items: [{ foodId: "FOOD|1", quantity: 0.2, units: "kg" }],
        },
      },
      {
        operation: "plan_update",
        body: {
          action: "revise",
          planId: "PLAN|1",
          expectedVersionNo: 1,
          items: [{ foodId: "FOOD|1", quantity: 0.2, units: "kg" }],
        },
      },
      {
        operation: "meal_create",
        body: {
          localDate: "2099-01-02",
          timePrecision: "date_only",
          mealType: "lunch",
          items: [
            {
              name: "Synthetic food",
              quantity: 1,
              nutrients: { energyKcal: 10, proteing: 2 },
            },
          ],
        },
      },
      {
        operation: "correction_create",
        body: {
          targetScope: "calendar_day",
          targetKey: "2099-01-02",
          fieldName: "note",
          effectiveDate: "2099-01-02",
          reason: "Missing values",
          source: "owner",
        },
      },
    ]) {
      const rejected = payload(
        await mcp.request("tools/call", {
          name: "fitness_write",
          arguments: invalidArguments,
        }),
      );
      assert.equal(rejected.status, "failed");
      assert.equal(rejected.errorCode, "INVALID_TOOL_ARGUMENTS");
      assert.equal(rejected.writeAttempted, false);
    }
    assert.equal(mutations, 0);

    const incomplete = payload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: {
          operation: "session_note_create",
          body: {
            noteDate: "2099-01-01",
            noteType: "observation",
            note: "missing receipt id",
          },
        },
      }),
    );
    assert.equal(incomplete.status, "uncertain");
    assert.equal(incomplete.errorCode, "MUTATION_RESPONSE_INCOMPLETE");
    assert.equal(incomplete.writeAttempted, true);
    assert.equal(incomplete.writeVerified, false);
    assert.equal(mutations, 1);
  } finally {
    await mcp.close();
    await api.close();
  }
});

test("workout validation reports validated without claiming a mutation", async () => {
  let requests = 0;
  const api = await listen(async (request, response) => {
    requests += 1;
    await readJson(request);
    json(response, 200, { valid: true, conflict: null });
  });
  const mcp = startMcp(api.baseUrl);
  try {
    await readInstructions(mcp);
    const validated = payload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: {
          operation: "workout_validate",
          body: {
            title: "Validation only",
            type: "Strength",
            startedAt: "2099-01-02T10:00:00Z",
            durationSeconds: 3600,
            sessionIntent: "normal",
            sets: [],
          },
        },
      }),
    );
    assert.equal(validated.status, "validated");
    assert.equal(validated.writeAttempted, false);
    assert.equal(validated.writeVerified, false);
    assert.equal(validated.errorCode, null);
    assert.equal(requests, 1);
  } finally {
    await mcp.close();
    await api.close();
  }
});

test("hydrated mutation responses authoritatively verify course, plan delete, and food alias writes", async () => {
  const requests = [];
  const api = await listen(async (request, response) => {
    const body = await readJson(request);
    requests.push({ method: request.method, url: request.url, body });
    const requestId = request.headers["x-idempotency-key"];
    if (request.url === "/api/fitness/training-course") {
      const overrideBatchId = "OVERRIDE-BATCH|1";
      const record = {
        recordId: "OVERRIDE|1",
        overrideBatchId,
        scope: "date",
        lifecycle: "active",
        active: true,
        phaseId: body.phaseId,
        trainingBlockId: null,
        date: body.date,
        plannedSessionId: null,
        sessionIntent: "normal",
        sourceSessionId: null,
        slotId: body.items[0].slotId,
        exercise: body.items[0].exercise,
        prescription: body.items[0].prescription,
        loadGuidance: body.items[0].loadGuidance,
        effort: body.items[0].effort,
        consumedBySessionId: null,
        consumedAt: null,
        voidedAt: null,
        recordedAt: "2099-01-03T00:00:00.000Z",
      };
      json(response, 201, {
        requestId,
        replay: false,
        scope: "date",
        phaseId: body.phaseId,
        overrideBatchId,
        recordIds: [record.recordId],
        records: [record],
      });
      return;
    }
    if (request.url === "/api/nutrition/plans") {
      json(response, 200, {
        requestId,
        replay: false,
        planId: body.planId,
        plan: {
          planId: body.planId,
          status: "cancelled",
          versionNo: body.expectedVersionNo + 1,
        },
      });
      return;
    }
    json(response, 200, {
      requestId,
      replay: false,
      foodId: body.foodId,
      versionNo: 2,
      item: {
        foodId: body.foodId,
        foodVersionId: `${body.foodId}|V2`,
        versionNo: 2,
        displayName: "Original food",
        brand: null,
        category: null,
        baseQuantity: 1,
        defaultUnit: "serving",
        nutrients: { energyKcal: 100 },
        isActive: true,
        source: "Agent item creation",
        originalLabel: "Original food",
        aliases: ["alias one"],
        sourceNote: "Revised nutrition data",
        effectiveFrom: "2099-01-03",
      },
    });
  });
  const mcp = startMcp(api.baseUrl);
  try {
    await readInstructions(mcp);
    const course = payload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: {
          operation: "training_course_update",
          body: {
            scope: "date",
            phaseId: "push",
            date: "2099-01-03",
            expectedPlanFingerprint: "fingerprint-1",
            items: [
              {
                slotId: "press-1",
                exercise: "Bench Press",
                prescription: "3 x 8",
                loadGuidance: "50 kg",
                effort: "RIR 2",
              },
            ],
          },
        },
      }),
    );
    assert.equal(course.status, "succeeded");
    assert.deepEqual(course.entityIds, {
      overrideBatchId: "OVERRIDE-BATCH|1",
      recordIds: ["OVERRIDE|1"],
    });

    const plan = payload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: {
          operation: "plan_delete",
          body: { planId: "PLAN|1", expectedVersionNo: 2 },
        },
      }),
    );
    assert.equal(plan.status, "succeeded");
    assert.deepEqual(plan.facts, { versionNo: 3, status: "cancelled" });

    const food = payload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: {
          operation: "food_item_update",
          body: { foodId: "FOOD|1", alias: "ＡＬＩＡＳ　ＯＮＥ" },
        },
      }),
    );
    assert.equal(food.status, "succeeded");
    assert.deepEqual(food.entityIds, { foodId: "FOOD|1" });
    assert.equal(requests.length, 3);
    assert.equal(requests.some((request) => request.method === "GET"), false);
  } finally {
    await mcp.close();
    await api.close();
  }
});

test("missing authoritative hydrated fields stays uncertain after one mutation", async () => {
  let mutations = 0;
  const api = await listen(async (request, response) => {
    mutations += 1;
    const body = await readJson(request);
    const requestId = request.headers["x-idempotency-key"];
    if (request.url === "/api/fitness/training-course") {
      const overrideBatchId = "OVERRIDE-BATCH|INCOMPLETE";
      const records = body.items.map((item) => ({
        recordId: "OVERRIDE|DUPLICATE",
        overrideBatchId,
        scope: body.scope,
        lifecycle: "active",
        active: true,
        phaseId: body.phaseId,
        trainingBlockId: null,
        date: body.date,
        plannedSessionId: null,
        sessionIntent: "normal",
        sourceSessionId: null,
        slotId: item.slotId,
        exercise: item.exercise,
        prescription: item.prescription,
        loadGuidance: item.loadGuidance,
        effort: item.effort,
        consumedBySessionId: null,
        consumedAt: null,
        voidedAt: null,
        recordedAt: "2099-01-03T00:00:00.000Z",
      }));
      json(response, 201, {
        requestId,
        overrideBatchId,
        recordIds: ["OVERRIDE|DUPLICATE", "OVERRIDE|MISSING"],
        records,
        scope: body.scope,
      });
      return;
    }
    if (request.url === "/api/nutrition/plans") {
      json(response, 200, {
        requestId,
        planId: "PLAN|OTHER",
        plan: {
          planId: "PLAN|OTHER",
          status: "cancelled",
          versionNo: body.expectedVersionNo + 1,
        },
      });
      return;
    }
    json(response, 200, {
      requestId,
      foodId: body.foodId,
      item: {
        foodId: body.foodId,
        foodVersionId: `${body.foodId}|V2`,
        versionNo: 2,
        aliases: [],
        originalLabel: "Original food",
        source: "Agent item creation",
        sourceNote: null,
        effectiveFrom: "2099-01-03",
      },
    });
  });
  const mcp = startMcp(api.baseUrl);
  try {
    await readInstructions(mcp);
    const cases = [
      {
        operation: "training_course_update",
        body: {
          scope: "date",
          phaseId: "push",
          date: "2099-01-03",
          expectedPlanFingerprint: "fingerprint-1",
          items: [
            {
              slotId: "press-1",
              exercise: "Bench Press",
              prescription: "3 x 8",
              loadGuidance: "50 kg",
              effort: "RIR 2",
            },
            {
              slotId: "press-2",
              exercise: "Incline Press",
              prescription: "3 x 8",
              loadGuidance: "40 kg",
              effort: "RIR 2",
            },
          ],
        },
      },
      {
        operation: "plan_delete",
        body: { planId: "PLAN|1", expectedVersionNo: 2 },
      },
      {
        operation: "food_item_update",
        body: { foodId: "FOOD|1", category: "Protein" },
      },
    ];
    for (const testCase of cases) {
      const result = payload(
        await mcp.request("tools/call", {
          name: "fitness_write",
          arguments: testCase,
        }),
      );
      assert.equal(result.status, "uncertain");
      assert.equal(result.writeAttempted, true);
      assert.equal(result.writeVerified, false);
    }
    assert.equal(mutations, cases.length);
  } finally {
    await mcp.close();
    await api.close();
  }
});

test("meal delete requires the authoritative revision to advance", async () => {
  let mutations = 0;
  const api = await listen(async (request, response) => {
    mutations += 1;
    const body = await readJson(request);
    json(response, 200, {
      requestId: request.headers["x-idempotency-key"],
      mealId: body.mealId,
      revisionNo: body.expectedRevisionNo,
      deletedMeal: true,
      nutrition: { meals: [] },
    });
  });
  const mcp = startMcp(api.baseUrl);
  try {
    await readInstructions(mcp);
    const result = payload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: {
          operation: "meal_delete",
          requestId: "request-meal-delete-stale-revision-0001",
          body: {
            mealId: "MEAL|DELETE|1",
            expectedRevisionNo: 3,
            deleteMeal: true,
          },
        },
      }),
    );
    assert.equal(result.status, "uncertain");
    assert.equal(result.writeAttempted, true);
    assert.equal(result.writeVerified, false);
    assert.equal(mutations, 1);
  } finally {
    await mcp.close();
    await api.close();
  }
});
