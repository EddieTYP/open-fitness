import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(
  new URL(
    "../agent-plugin/skills/open-fitness/scripts/fitness-mcp.mjs",
    import.meta.url,
  ),
);

function startMcp(baseUrl) {
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      FITNESS_API_BASE_URL: baseUrl,
      FITNESS_API_TOKEN: "agent-scoped-test-token",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
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
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  function notify(method, params = {}) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async function close() {
    child.stdin.end();
    if (child.exitCode === null) await once(child, "exit");
    lines.close();
  }

  return { child, close, notify, request, stderr: () => stderr };
}

function toolPayload(result) {
  return JSON.parse(result.content[0].text);
}

async function readInstructions(mcp) {
  const instructions = toolPayload(
    await mcp.request("tools/call", {
      name: "fitness_read",
      arguments: { resource: "instructions" },
    }),
  );
  assert.equal(instructions.ok, true);
  const listed = await mcp.request("tools/list");
  const operations = listed.tools.find(
    (tool) => tool.name === "fitness_write",
  ).inputSchema.properties.operation.enum;
  for (const operation of operations) {
    const contract = toolPayload(
      await mcp.request("tools/call", {
        name: "fitness_read",
        arguments: { resource: "write_contract", operation },
      }),
    );
    assert.equal(contract.ok, true);
    assert.equal(contract.data.operation, operation);
  }
  return instructions;
}

async function readWriteContract(mcp, operation) {
  const contract = toolPayload(
    await mcp.request("tools/call", {
      name: "fitness_read",
      arguments: { resource: "write_contract", operation },
    }),
  );
  assert.equal(contract.ok, true);
  assert.equal(contract.data.operation, operation);
  return contract;
}

test("fitness MCP lifts stable API errors without forwarding localized prose", async () => {
  const api = createServer((request, response) => {
    if (request.url === "/api/fitness/snapshot") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          errorCode: "INVALID_SOURCE_DATA",
          facts: { field: "來源名稱" },
          error: "來源資料無效",
        }),
      );
      return;
    }
    if (request.url?.startsWith("/api/fitness/analysis")) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "舊版錯誤訊息" }));
      return;
    }
    response.writeHead(502, { "content-type": "text/plain" });
    response.end("upstream unavailable");
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  const mcp = startMcp(`http://127.0.0.1:${address.port}/`);

  try {
    const stable = await mcp.request("tools/call", {
      name: "fitness_read",
      arguments: { resource: "snapshot" },
    });
    const stablePayload = toolPayload(stable);
    assert.equal(stable.isError, true);
    assert.deepEqual(stablePayload, {
      ok: false,
      errorCode: "INVALID_SOURCE_DATA",
      facts: { field: "來源名稱" },
      status: 400,
      action: "snapshot",
    });
    assert.equal(JSON.stringify(stablePayload).includes("來源資料無效"), false);

    const legacy = await mcp.request("tools/call", {
      name: "fitness_read",
      arguments: { resource: "analysis" },
    });
    const legacyPayload = toolPayload(legacy);
    assert.equal(legacy.isError, true);
    assert.equal(legacyPayload.errorCode, "UPSTREAM_API_ERROR");
    assert.deepEqual(legacyPayload.facts, {});
    assert.equal(JSON.stringify(legacyPayload).includes("舊版錯誤訊息"), false);

    const nonJson = await mcp.request("tools/call", {
      name: "fitness_read",
      arguments: { resource: "revisions" },
    });
    assert.deepEqual(toolPayload(nonJson), {
      ok: false,
      errorCode: "UPSTREAM_NON_JSON_RESPONSE",
      facts: {},
      status: 502,
      action: "revisions",
    });

    const invalid = await mcp.request("tools/call", {
      name: "fitness_write",
      arguments: { operation: "not_a_real_operation", body: {} },
    });
    const invalidPayload = toolPayload(invalid);
    assert.equal(invalidPayload.errorCode, "INVALID_TOOL_ARGUMENTS");
    assert.equal(invalidPayload.facts.reason, "Unknown fitness write operation");
  } finally {
    await mcp.close();
    await new Promise((resolve, reject) =>
      api.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("fitness MCP reports transport failures with a stable envelope", async () => {
  const unavailable = createServer();
  await new Promise((resolve) => unavailable.listen(0, "127.0.0.1", resolve));
  const address = unavailable.address();
  await new Promise((resolve, reject) =>
    unavailable.close((error) => (error ? reject(error) : resolve())),
  );
  const mcp = startMcp(`http://127.0.0.1:${address.port}/`);

  try {
    const failed = await mcp.request("tools/call", {
      name: "fitness_read",
      arguments: { resource: "snapshot" },
    });
    assert.deepEqual(toolPayload(failed), {
      ok: false,
      errorCode: "FITNESS_API_UNAVAILABLE",
      facts: {},
      action: "snapshot",
    });
  } finally {
    await mcp.close();
  }
});

test("fitness MCP exposes two typed tools and protects auth plus idempotency", async () => {
  const received = [];
  let storedMeal = null;
  const api = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const parsed = body ? JSON.parse(body) : null;
      received.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        idempotencyKey: request.headers["x-idempotency-key"],
        body: parsed,
      });
      response.writeHead(request.method === "GET" ? 200 : 201, {
        "content-type": "application/json",
      });
      if (request.method === "GET") {
        response.end(JSON.stringify({ date: "2099-04-05", remainingKcal: 900 }));
        return;
      }
      if (request.url === "/api/nutrition/items") {
        response.end(
          JSON.stringify({
            requestId: request.headers["x-idempotency-key"],
            foodId: "FOOD|1",
            item: {
              foodId: "FOOD|1",
              foodVersionId: "FOOD|1|VERSION|1",
              versionNo: 1,
              displayName: parsed.displayName,
              brand: parsed.brand ?? null,
              category: parsed.category ?? null,
              baseQuantity: parsed.baseQuantity ?? 1,
              defaultUnit: parsed.baseUnit,
              nutrients: parsed.nutrients,
              isActive: true,
              source: "agent",
              originalLabel: parsed.alias ?? parsed.displayName,
              aliases: [parsed.alias ?? parsed.displayName],
              sourceNote: parsed.sourceNote?.trim() ?? null,
              effectiveFrom: "2099-04-05",
            },
          }),
        );
        return;
      }
      if (request.url === "/api/nutrition/meals") {
        const mealId = parsed.mealId ?? "MEAL|1";
        const revisionNo = (parsed.expectedRevisionNo ?? 0) + 1;
        if (parsed.action === "quantity") {
          const targetOrdinal = /\|ITEM\|(\d+)$/.exec(parsed.mealItemId)?.[1];
          storedMeal = {
            ...storedMeal,
            revisionNo,
            items: storedMeal.items.map((item, index) => ({
              ...item,
              mealItemId: `${mealId}|REV|${revisionNo}|ITEM|${index + 1}`,
              ...(String(index + 1) === targetOrdinal
                ? { quantity: parsed.quantity }
                : {}),
            })),
          };
        } else {
          storedMeal = {
            ...parsed,
            mealId,
            revisionNo,
            items: parsed.items.map((item, index) => ({
              ...item,
              mealItemId: `${mealId}|REV|${revisionNo}|ITEM|${index + 1}`,
            })),
          };
        }
        response.end(
          JSON.stringify({
            requestId: request.headers["x-idempotency-key"],
            mealId,
            revisionNo,
            nutrition: { meals: [storedMeal] },
          }),
        );
        return;
      }
      if (request.url === "/api/fitness/training-selections") {
        response.end(
          JSON.stringify({
            requestId: request.headers["x-idempotency-key"],
            selection: {
              selectionId: "SELECTION|1",
              phaseId: parsed.phaseId,
              slotId: parsed.slotId,
              scope: parsed.scope,
              scopeValue: parsed.date ?? parsed.venue,
              exercise: parsed.exercise,
            },
          }),
        );
        return;
      }
      if (request.url === "/api/fitness/training-template") {
        response.end(
          JSON.stringify({
            requestId: request.headers["x-idempotency-key"],
            profileUpdatedAt: "2099-04-10T01:00:01.000Z",
            template: parsed.template,
          }),
        );
        return;
      }
      if (request.url === "/api/fitness/training-course") {
        const overrideBatchId = "OVERRIDE-BATCH|1";
        const records = parsed.items.map((item, index) => ({
          recordId: `OVERRIDE|${index + 1}`,
          overrideBatchId,
          scope: parsed.scope,
          lifecycle: "active",
          active: true,
          phaseId: parsed.phaseId,
          trainingBlockId: parsed.trainingBlockId ?? null,
          date: parsed.date ?? null,
          plannedSessionId: parsed.plannedSessionId ?? null,
          sessionIntent: parsed.sessionIntent ?? "normal",
          sourceSessionId: parsed.sourceSessionId ?? null,
          slotId: item.slotId,
          exercise: item.exercise,
          prescription: item.prescription,
          loadGuidance: item.loadGuidance,
          effort: item.effort,
          consumedBySessionId: null,
          consumedAt: null,
          voidedAt: null,
          recordedAt: "2099-04-05T00:00:00.000Z",
        }));
        response.end(
          JSON.stringify({
            requestId: request.headers["x-idempotency-key"],
            overrideBatchId,
            recordIds: records.map((record) => record.recordId),
            records,
            scope: parsed.scope,
            phaseId: parsed.phaseId,
          }),
        );
        return;
      }
      response.end(JSON.stringify({ error: "unexpected route" }));
    });
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  const mcp = startMcp(`http://127.0.0.1:${address.port}/`);

  try {
    const initialized = await mcp.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    assert.equal(initialized.serverInfo.name, "open-fitness");
    mcp.notify("notifications/initialized");

    const listed = await mcp.request("tools/list");
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      ["fitness_read", "fitness_write"],
    );
    assert.equal(
      listed.tools.find((tool) => tool.name === "fitness_read").annotations
        .readOnlyHint,
      true,
    );
    assert.match(
      listed.tools.find((tool) => tool.name === "fitness_write").inputSchema
        .properties.body.description,
      /write_contract with the same operation/,
    );
    assert.match(
      listed.tools.find((tool) => tool.name === "fitness_write").description,
      /exact operation's bounded write_contract/,
    );
    assert.match(
      listed.tools.find((tool) => tool.name === "fitness_write").description,
      /Retry only an uncertain result.*requestId.*identical body/,
    );
    assert.match(
      listed.tools.find((tool) => tool.name === "fitness_read").inputSchema
        .properties.venue.description,
      /supplied for this request or deliberately configured by the owner/,
    );

    const instructions = await readInstructions(mcp);
    assert.match(
      instructions.data.workflow.join(" "),
      /authenticated Open Fitness API/,
    );
    assert.match(
      instructions.data.workflow.join(" "),
      /Before every fitness_write operation.*write_contract/,
    );
    assert.match(
      instructions.data.workflow.join(" "),
      /Retry at most once only after uncertain.*same requestId and identical body/,
    );
    assert.doesNotMatch(JSON.stringify(instructions), /Hermes|Telegram/);

    const workoutContract = await readWriteContract(mcp, "workout_create");
    assert.match(
      workoutContract.data.rules.join(" "),
      /notesManual.*coachNote.*setTypeManual/,
    );
    assert.match(
      workoutContract.data.rules.join(" "),
      /exercises\[\]\.exerciseName.*setNumber.*weightKg/,
    );
    const correctionContract = await readWriteContract(
      mcp,
      "correction_create",
    );
    assert.match(
      correctionContract.data.rules.join(" "),
      /originalValue.*JSON null/,
    );
    const mealContract = await readWriteContract(mcp, "meal_create");
    assert.match(mealContract.data.rules.join(" "), /pending meal prep.*plan_create/);
    const mealUpdateContract = await readWriteContract(mcp, "meal_update");
    assert.match(
      mealUpdateContract.data.rules.join(" "),
      /full replacement.*top-level/,
    );
    const courseContract = await readWriteContract(
      mcp,
      "training_course_update",
    );
    assert.match(
      JSON.stringify(courseContract.data),
      /planned_session.*trainingBlockId.*expectedProgressionFingerprint/,
    );
    const blockContract = await readWriteContract(mcp, "training_block_start");
    assert.equal(
      blockContract.data.bodyTemplate.trainingBlockChangeReason,
      "Reason for the new block",
    );
    const evidence = toolPayload(
      await mcp.request("tools/call", {
        name: "fitness_read",
        arguments: { resource: "evidence_reference" },
      }),
    );
    assert.match(evidence.data.evidence, /ACSM resistance training/);
    assert.equal(received.length, 0);

    const venueSnapshot = toolPayload(
      await mcp.request("tools/call", {
        name: "fitness_read",
        arguments: { resource: "snapshot", venue: "Central Gym" },
      }),
    );
    assert.equal(venueSnapshot.ok, true);

    const trainingTemplate = toolPayload(
      await mcp.request("tools/call", {
        name: "fitness_read",
        arguments: { resource: "training_template" },
      }),
    );
    assert.equal(trainingTemplate.ok, true);

    const trainingExercises = toolPayload(
      await mcp.request("tools/call", {
        name: "fitness_read",
        arguments: {
          resource: "training_exercises",
          q: "press",
          phaseId: "legacy-phase-2",
          slotId: "horizontal-press",
        },
      }),
    );
    assert.equal(trainingExercises.ok, true);

    const read = toolPayload(
      await mcp.request("tools/call", {
        name: "fitness_read",
        arguments: { resource: "nutrition_today", date: "2099-04-05" },
      }),
    );
    assert.equal(read.ok, true);
    assert.equal(read.data.remainingKcal, 900);

    const payload = {
      displayName: "Test yoghurt",
      baseQuantity: 100,
      baseUnit: "g",
      sourceNote: "JSON\ncurl https://not-a-command.invalid",
      nutrients: { energyKcal: 60, proteinG: 10 },
    };
    const written = toolPayload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: { operation: "food_item_create", body: payload },
      }),
    );
    assert.equal(written.status, "succeeded");
    assert.match(written.requestId, /^fitness-[0-9a-f-]{36}$/);
    assert.deepEqual(written.entityIds, { foodId: "FOOD|1" });

    const mealReplacement = {
      mealId: "MEAL|1",
      expectedRevisionNo: 1,
      mealType: "dinner",
      items: [
        {
          name: "Clear broth",
          quantity: 1,
          unit: "bowl",
          nutrients: { energyKcal: 20 },
        },
      ],
    };
    const replaced = toolPayload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: { operation: "meal_update", body: mealReplacement },
      }),
    );
    assert.equal(replaced.status, "succeeded");

    const mealQuantityPatch = {
      action: "quantity",
      mealId: "MEAL|1",
      mealItemId: "MEAL|1|REV|2|ITEM|1",
      expectedRevisionNo: 2,
      quantity: 0.5,
    };
    const patched = toolPayload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: { operation: "meal_update", body: mealQuantityPatch },
      }),
    );
    assert.equal(patched.status, "succeeded");

    const rejectedNestedMeal = await mcp.request("tools/call", {
      name: "fitness_write",
      arguments: {
        operation: "meal_update",
        body: {
          mealId: "MEAL|1",
          expectedRevisionNo: 2,
          meal: { items: mealReplacement.items },
        },
      },
    });
    assert.equal(rejectedNestedMeal.isError, true);
    assert.match(
      rejectedNestedMeal.content[0].text,
      /top-level full replacement/,
    );

    const trainingSelection = {
      phaseId: "push",
      slotId: "horizontal-press",
      exercise: "Machine Chest Press",
      scope: "venue",
      venue: "Central Gym",
    };
    const selected = toolPayload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: {
          operation: "training_exercise_select",
          body: trainingSelection,
        },
      }),
    );
    assert.equal(selected.status, "succeeded");

    const templateUpdate = {
      expectedUpdatedAt: "2099-04-10T01:00:00.000Z",
      template: {
        version: 2,
        phases: [
          {
            id: "push",
            label: "Push Day",
            kind: "training",
            routine: [],
          },
        ],
      },
    };
    const updatedTemplate = toolPayload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: {
          operation: "training_template_update",
          body: templateUpdate,
        },
      }),
    );
    assert.equal(updatedTemplate.status, "succeeded");

    const courseUpdate = {
      phaseId: "leg",
      scope: "date",
      date: "2099-04-05",
      expectedPlanFingerprint: "plan-fingerprint-1",
      items: [
        {
          slotId: "primary-1",
          exercise: "Back Squat",
          prescription: "3 × 5",
          loadGuidance: "100 kg",
          effort: "RIR 2–3",
        },
      ],
    };
    const updatedCourse = toolPayload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: {
          operation: "training_course_update",
          body: courseUpdate,
        },
      }),
    );
    assert.equal(updatedCourse.status, "succeeded");

    assert.deepEqual(received, [
      {
        method: "GET",
        url: "/api/fitness/snapshot?venue=Central+Gym",
        authorization: "Bearer agent-scoped-test-token",
        idempotencyKey: undefined,
        body: null,
      },
      {
        method: "GET",
        url: "/api/fitness/training-template",
        authorization: "Bearer agent-scoped-test-token",
        idempotencyKey: undefined,
        body: null,
      },
      {
        method: "GET",
        url: "/api/fitness/training-selections?q=press&phaseId=legacy-phase-2&slotId=horizontal-press",
        authorization: "Bearer agent-scoped-test-token",
        idempotencyKey: undefined,
        body: null,
      },
      {
        method: "GET",
        url: "/api/nutrition/today?date=2099-04-05",
        authorization: "Bearer agent-scoped-test-token",
        idempotencyKey: undefined,
        body: null,
      },
      {
        method: "POST",
        url: "/api/nutrition/items",
        authorization: "Bearer agent-scoped-test-token",
        idempotencyKey: written.requestId,
        body: payload,
      },
      {
        method: "POST",
        url: "/api/nutrition/meals",
        authorization: "Bearer agent-scoped-test-token",
        idempotencyKey: replaced.requestId,
        body: mealReplacement,
      },
      {
        method: "PATCH",
        url: "/api/nutrition/meals",
        authorization: "Bearer agent-scoped-test-token",
        idempotencyKey: patched.requestId,
        body: mealQuantityPatch,
      },
      {
        method: "POST",
        url: "/api/fitness/training-selections",
        authorization: "Bearer agent-scoped-test-token",
        idempotencyKey: selected.requestId,
        body: trainingSelection,
      },
      {
        method: "PUT",
        url: "/api/fitness/training-template",
        authorization: "Bearer agent-scoped-test-token",
        idempotencyKey: updatedTemplate.requestId,
        body: templateUpdate,
      },
      {
        method: "POST",
        url: "/api/fitness/training-course",
        authorization: "Bearer agent-scoped-test-token",
        idempotencyKey: updatedCourse.requestId,
        body: courseUpdate,
      },
    ]);

    assert.doesNotMatch(JSON.stringify({ read, written }), /agent-scoped-test-token/);

    const rejected = await mcp.request("tools/call", {
      name: "fitness_read",
      arguments: { resource: "snapshot", url: "https://example.com" },
    });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /Unsupported argument: url/);
    assert.equal(received.length, 10);
  } finally {
    await mcp.close();
    await new Promise((resolve, reject) =>
      api.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("fitness MCP rejects non-loopback API origins before discovery", async () => {
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      FITNESS_API_BASE_URL: "https://example.com/",
      FITNESS_API_TOKEN: "agent-scoped-test-token",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const [code] = await once(child, "exit");
  assert.notEqual(code, 0);
  assert.equal(stdout, "");
  assert.match(stderr, /loopback HTTP or HTTPS/);
  assert.doesNotMatch(stderr, /agent-scoped-test-token/);
});

test("fitness MCP repairs unambiguous correction transport types and leaves ambiguous text for API rejection", async () => {
  const received = [];
  const storedCorrections = [];
  const api = createServer((request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          sessionNotes: [],
          corrections: storedCorrections,
          nutrition: { energyObservations: [] },
        }),
      );
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const parsed = JSON.parse(body);
      received.push(parsed);
      const invalidNumericCorrection =
        parsed.targetScope === "workout_set" &&
        parsed.fieldName === "reps" &&
        (typeof parsed.originalValue !== "number" ||
          typeof parsed.correctedValue !== "number");
      response.writeHead(invalidNumericCorrection ? 400 : 201, {
        "content-type": "application/json",
      });
      const correctionId = `CORRECTION|${received.length}`;
      if (!invalidNumericCorrection) {
        storedCorrections.push({
          ...parsed,
          correctionId,
          originalValue:
            parsed.originalValue === null ? null : String(parsed.originalValue),
          correctedValue:
            parsed.correctedValue === null ? null : String(parsed.correctedValue),
          recordedAt: parsed.recordedAt ?? "2099-04-10T12:00:00.000Z",
        });
      }
      response.end(
        JSON.stringify(
          invalidNumericCorrection
            ? { error: "invalid numeric correction" }
            : {
                correctionId,
                correction: parsed,
                requestId: request.headers["x-idempotency-key"],
              },
        ),
      );
    });
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  const mcp = startMcp(`http://127.0.0.1:${address.port}/`);

  try {
    await readInstructions(mcp);
    const phaseBody = {
      effectiveDate: "2099-04-10",
      targetScope: "workout_session",
      targetKey: "SESSION|SYNTHETIC-1",
      fieldName: "training_phase_id",
      correctedValue: "synthetic-phase-one",
      reason: "Owner confirmed phase",
      source: "owner",
    };
    const phaseResult = toolPayload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: { operation: "correction_create", body: phaseBody },
      }),
    );
    assert.equal(phaseResult.status, "succeeded");

    const repsBody = {
      effectiveDate: "2099-04-10",
      targetScope: "workout_set",
      targetKey: "SET|SYNTHETIC-9",
      fieldName: "reps",
      originalValue: "9",
      correctedValue: "8",
      reason: "Owner corrected reps",
      source: "owner",
    };
    const repsResult = toolPayload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: { operation: "correction_create", body: repsBody },
      }),
    );
    assert.equal(repsResult.status, "succeeded");

    const ambiguousBody = {
      ...repsBody,
      targetKey: "SET|SYNTHETIC-10",
      correctedValue: "8 reps",
    };
    const ambiguousResult = await mcp.request("tools/call", {
      name: "fitness_write",
      arguments: { operation: "correction_create", body: ambiguousBody },
    });
    assert.equal(ambiguousResult.isError, true);

    const genericBody = {
      effectiveDate: "2099-04-10",
      targetScope: "calendar_day",
      targetKey: "2099-04-10",
      fieldName: "reps",
      originalValue: "9",
      correctedValue: "8",
      reason: "Generic correction retains its string contract",
      source: "owner",
    };
    const genericResult = toolPayload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: { operation: "correction_create", body: genericBody },
      }),
    );
    assert.equal(genericResult.status, "succeeded");

    assert.deepEqual(received, [
      { ...phaseBody, originalValue: null },
      { ...repsBody, originalValue: 9, correctedValue: 8 },
      { ...ambiguousBody, originalValue: 9 },
      genericBody,
    ]);
  } finally {
    await mcp.close();
    await new Promise((resolve, reject) =>
      api.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("fitness MCP normalises recoverable one-off meal aliases and rejects ambiguous meal values before the API", async () => {
  const received = [];
  const receivedRoutes = [];
  const api = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const parsed = JSON.parse(body);
      received.push(parsed);
      receivedRoutes.push([request.method, request.url]);
      response.writeHead(201, { "content-type": "application/json" });
      const mealId = parsed.mealId ?? "MEAL|DINNER";
      const revisionNo = (parsed.expectedRevisionNo ?? 0) + 1;
      response.end(
        JSON.stringify({
          mealId,
          revisionNo,
          requestId: request.headers["x-idempotency-key"],
          nutrition: {
            meals: [
              {
                ...parsed,
                mealId,
                revisionNo,
                items: parsed.items.map((item, index) => ({
                  ...item,
                  mealItemId: `${mealId}|REV|${revisionNo}|ITEM|${index + 1}`,
                })),
              },
            ],
          },
        }),
      );
    });
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  const mcp = startMcp(`http://127.0.0.1:${address.port}/`);

  try {
    await readInstructions(mcp);
    const malformedAgentBody = {
      localDate: "2099-04-13",
      mealType: "dinner",
      confidence: "low",
      items: [
        {
          name: "Synthetic shared roast platter",
          amount: 0.25,
          unit: "portion",
          assumption: "Synthetic six-person share; one quarter recorded",
          confidence: "low",
          energyKcal: 480,
          proteinG: 30,
          totalFatG: 24,
          saturatedFatG: 8,
          carbsG: 36,
          sodiumMg: 800,
        },
      ],
    };
    const written = toolPayload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: { operation: "meal_create", body: malformedAgentBody },
      }),
    );
    assert.equal(written.status, "succeeded");
    assert.deepEqual(received, [
      {
        ...malformedAgentBody,
        items: [
          {
            name: "Synthetic shared roast platter",
            quantity: 0.25,
            unit: "portion",
            assumption: "Synthetic six-person share; one quarter recorded",
            confidence: "low",
            nutrients: {
              energyKcal: 480,
              proteinG: 30,
              totalFatG: 24,
              saturatedFatG: 8,
              carbsG: 36,
              sodiumMg: 800,
            },
          },
        ],
      },
    ]);

    const timestampedMinuteBody = {
      confidence: "medium",
      localDate: "2099-04-15",
      eatenAt: "2099-04-15T18:30:00+00:00",
      timePrecision: "minute",
      notes:
        "Synthetic chat fixture: record only the 100 g cooked lean protein portion.",
      source: "chat_estimate",
      items: [
        {
          assumption:
            "Synthetic estimate for 100 g cooked lean protein; preparation details are unknown.",
          name: "Synthetic cooked lean protein",
          quantity: 100,
          unit: "g",
          confidence: "medium",
          nutrients: {
            energyKcal: 200,
            proteinG: 30,
            totalFatG: 8,
            saturatedFatG: 2,
            carbsG: 0,
            sodiumMg: 70,
            cholesterolMg: 60,
          },
        },
      ],
    };
    const timestampedMinute = toolPayload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: { operation: "meal_create", body: timestampedMinuteBody },
      }),
    );
    assert.equal(timestampedMinute.status, "succeeded");
    assert.deepEqual(received[1], {
      ...timestampedMinuteBody,
      timePrecision: "inferred",
    });

    const canonicalExactBody = {
      ...timestampedMinuteBody,
      timePrecision: "exact",
    };
    const canonicalExact = toolPayload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: { operation: "meal_create", body: canonicalExactBody },
      }),
    );
    assert.equal(canonicalExact.status, "succeeded");
    assert.deepEqual(received[2], canonicalExactBody);

    const fullMealUpdateBody = {
      ...timestampedMinuteBody,
      mealId: "MEAL|DINNER",
      expectedRevisionNo: 1,
    };
    const fullMealUpdate = toolPayload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: { operation: "meal_update", body: fullMealUpdateBody },
      }),
    );
    assert.equal(fullMealUpdate.status, "succeeded");
    assert.deepEqual(received[3], {
      ...fullMealUpdateBody,
      timePrecision: "inferred",
    });
    assert.deepEqual(receivedRoutes[3], ["POST", "/api/nutrition/meals"]);

    const conflictingQuantity = await mcp.request("tools/call", {
      name: "fitness_write",
      arguments: {
        operation: "meal_create",
        body: {
          items: [
            {
              name: "Synthetic rice",
              amount: 150,
              quantity: 200,
              unit: "g",
              nutrients: { energyKcal: 260 },
            },
          ],
        },
      },
    });
    assert.equal(conflictingQuantity.isError, true);
    assert.match(
      conflictingQuantity.content[0].text,
      /conflicting amount and quantity/,
    );

    const conflictingEnergy = await mcp.request("tools/call", {
      name: "fitness_write",
      arguments: {
        operation: "meal_create",
        body: {
          items: [
            {
              name: "Synthetic rice",
              energyKcal: 260,
              nutrients: { energyKcal: 300 },
            },
          ],
        },
      },
    });
    assert.equal(conflictingEnergy.isError, true);
    assert.match(conflictingEnergy.content[0].text, /conflicting energyKcal/);

    const missingNutrients = await mcp.request("tools/call", {
      name: "fitness_write",
      arguments: {
        operation: "meal_create",
        body: { items: [{ name: "Synthetic unknown dish" }] },
      },
    });
    assert.equal(missingNutrients.isError, true);
    assert.match(
      missingNutrients.content[0].text,
      /nutrients is required for a one-off item/,
    );

    const minuteWithoutTimestamp = await mcp.request("tools/call", {
      name: "fitness_write",
      arguments: {
        operation: "meal_create",
        body: {
          localDate: "2099-04-15",
          timePrecision: "minute",
          mealType: "dinner",
          items: [
            {
              name: "Synthetic soup",
              quantity: 1,
              unit: "bowl",
              nutrients: { energyKcal: 100 },
            },
          ],
        },
      },
    });
    assert.equal(minuteWithoutTimestamp.isError, true);
    assert.match(
      minuteWithoutTimestamp.content[0].text,
      /timePrecision minute requires eatenAt/,
    );

    const unknownPrecision = await mcp.request("tools/call", {
      name: "fitness_write",
      arguments: {
        operation: "meal_create",
        body: {
          localDate: "2099-04-15",
          eatenAt: "2099-04-15T18:30:00+00:00",
          timePrecision: "second",
          mealType: "dinner",
          items: [
            {
              name: "Synthetic soup",
              quantity: 1,
              unit: "bowl",
              nutrients: { energyKcal: 100 },
            },
          ],
        },
      },
    });
    assert.equal(unknownPrecision.isError, true);
    assert.match(
      unknownPrecision.content[0].text,
      /timePrecision must be exact, inferred, or date_only/,
    );

    for (const body of [
      {
        localDate: "2099-04-15",
        eatenAt: null,
        timePrecision: "inferred",
      },
      {
        localDate: "2099-04-15",
        eatenAt: "2099-04-15T18:30:00+00:00",
        timePrecision: "date_only",
      },
      {
        localDate: "2099-04-15",
        timePrecision: "exact",
      },
    ]) {
      const inconsistentTiming = await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: {
          operation: "meal_create",
          body: {
            ...body,
            mealType: "dinner",
            items: [
              {
                name: "Synthetic soup",
                quantity: 1,
                unit: "bowl",
                nutrients: { energyKcal: 100 },
              },
            ],
          },
        },
      });
      assert.equal(inconsistentTiming.isError, true);
      assert.match(
        inconsistentTiming.content[0].text,
        /timePrecision is inconsistent with eatenAt/,
      );
    }
    assert.equal(received.length, 4);
  } finally {
    await mcp.close();
    await new Promise((resolve, reject) =>
      api.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("fitness MCP repairs readback meal-name aliases and rejects invalid one-off items before the API", async () => {
  const received = [];
  const api = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const parsed = JSON.parse(body);
      received.push(parsed);
      response.writeHead(201, { "content-type": "application/json" });
      const mealId = "MEAL|SYNTHETIC-DINNER";
      response.end(
        JSON.stringify({
          mealId,
          revisionNo: 1,
          requestId: request.headers["x-idempotency-key"],
          nutrition: {
            meals: [
              {
                ...parsed,
                mealId,
                revisionNo: 1,
                items: parsed.items.map((item, index) => ({
                  ...item,
                  mealItemId: `${mealId}|REV|1|ITEM|${index + 1}`,
                })),
              },
            ],
          },
        }),
      );
    });
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  const mcp = startMcp(`http://127.0.0.1:${address.port}/`);

  try {
    await readInstructions(mcp);
    const canonicalBody = {
      localDate: "2099-04-17",
      mealType: "dinner",
      timePrecision: "date_only",
      items: [
        {
          name: "Synthetic canonical dish",
          quantity: 100,
          unit: "g",
          nutrients: { energyKcal: 200 },
        },
      ],
    };
    const canonical = toolPayload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: { operation: "meal_create", body: canonicalBody },
      }),
    );
    assert.equal(canonical.status, "succeeded");
    assert.deepEqual(received[0], canonicalBody);

    const failedRequestShape = {
      localDate: "2099-04-17",
      mealType: "dinner",
      timePrecision: "date_only",
      confidence: "low",
      items: [
        ["Synthetic sweet-and-sour dish", 222, 530],
        ["Synthetic mango prawn salad", 140, 330],
        ["Synthetic seafood rice", 436, 850],
        ["Synthetic noodle dish", 103, 190],
        ["Synthetic roast dish", 300, 840],
      ].map(([itemName, quantity, energyKcal]) => ({
        itemName,
        quantity,
        unit: "g",
        confidence: "low",
        energyKcal,
      })),
    };
    const repaired = toolPayload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: { operation: "meal_create", body: failedRequestShape },
      }),
    );
    assert.equal(repaired.status, "succeeded");
    assert.deepEqual(received[1], {
      ...failedRequestShape,
      items: failedRequestShape.items.map(
        ({ itemName, energyKcal, ...item }) => ({
          ...item,
          name: itemName,
          nutrients: { energyKcal },
        }),
      ),
    });

    const snapshotAlias = toolPayload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: {
          operation: "meal_create",
          body: {
            localDate: "2099-04-18",
            mealType: "lunch",
            timePrecision: "date_only",
            items: [
              {
                itemNameSnapshot: "Synthetic readback dish",
                quantity: 1,
                unit: "serving",
                nutrients: { energyKcal: 300 },
              },
            ],
          },
        },
      }),
    );
    assert.equal(snapshotAlias.status, "succeeded");
    assert.deepEqual(received[2].items, [
      {
        name: "Synthetic readback dish",
        quantity: 1,
        unit: "serving",
        nutrients: { energyKcal: 300 },
      },
    ]);

    for (const [item, expectedReason] of [
      [
        {
          name: "Synthetic canonical dish",
          itemName: "Synthetic conflicting dish",
          nutrients: { energyKcal: 100 },
        },
        /conflicting itemName and name values/,
      ],
      [
        {
          itemName: "Synthetic first alias",
          itemNameSnapshot: "Synthetic second alias",
          nutrients: { energyKcal: 100 },
        },
        /conflicting itemNameSnapshot and name values/,
      ],
      [
        { quantity: 1, nutrients: { energyKcal: 100 } },
        /items\[0\]\.name must be a non-empty string/,
      ],
      [
        {
          name: "Synthetic typed quantity dish",
          quantity: "100",
          nutrients: { energyKcal: 100 },
        },
        /quantity must be a JSON number/,
      ],
      [
        {
          name: "Synthetic excessive-energy dish",
          nutrients: { energyKcal: 50001 },
        },
        /energyKcal must be a JSON number from 0 to 50000/,
      ],
      [
        {
          name: "Synthetic excessive top-level energy dish",
          energyKcal: 50001,
        },
        /energyKcal must be a JSON number from 0 to 50000/,
      ],
    ]) {
      const rejected = await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: {
          operation: "meal_create",
          body: {
            localDate: "2099-04-19",
            mealType: "dinner",
            timePrecision: "date_only",
            items: [item],
          },
        },
      });
      assert.equal(rejected.isError, true);
      assert.match(toolPayload(rejected).facts.reason, expectedReason);
    }
    assert.equal(received.length, 3);
  } finally {
    await mcp.close();
    await new Promise((resolve, reject) =>
      api.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("fitness MCP canonicalises saved-food readback quantities for combos and plans and rejects conflicts", async () => {
  const received = [];
  const api = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const parsed = JSON.parse(body);
      received.push({
        method: request.method,
        url: request.url,
        body: parsed,
      });
      response.writeHead(201, { "content-type": "application/json" });
      if (request.url === "/api/nutrition/plans") {
        const planIds = parsed.scheduledDates.map(
          (_date, index) => `PLAN|SYNTHETIC-LUNCH|${index + 1}`,
        );
        const plans = parsed.scheduledDates.map((scheduledDate, index) => ({
          planId: planIds[index],
          scheduledDate,
          mealType: parsed.mealType,
          status: "pending",
          versionNo: 1,
          completedMealId: null,
          items: parsed.items,
        }));
        response.end(
          JSON.stringify({
            requestId: request.headers["x-idempotency-key"],
            planId: planIds[0],
            planIds,
            versionNo: 1,
            plan: plans[0],
            plans,
          }),
        );
        return;
      }
      response.end(
        JSON.stringify({
          requestId: request.headers["x-idempotency-key"],
          comboId: "COMBO|SYNTHETIC-LUNCH",
          versionNo: 1,
          combo: {
            comboId: "COMBO|SYNTHETIC-LUNCH",
            displayName: parsed.displayName,
            defaultMealType: parsed.defaultMealType,
            contextTag: parsed.contextTag ?? null,
            isActive: true,
            versionNo: 1,
            items: parsed.items.map((item) => ({
              foodId: item.foodId,
              defaultQuantity: item.quantity,
              ...(item.unit === undefined ? {} : { unit: item.unit }),
            })),
          },
        }),
      );
    });
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  const mcp = startMcp(`http://127.0.0.1:${address.port}/`);

  const syntheticComboPayload = {
    defaultMealType: "lunch",
    displayName: "Synthetic grain and protein bowl (5 servings)",
    items: [
      {
        defaultQuantity: 0.4,
        foodId: "FOOD|SYNTHETIC-GRAIN",
        unit: "g",
      },
      {
        defaultQuantity: 0.2,
        foodId: "FOOD|SYNTHETIC-PROTEIN",
      },
    ],
  };

  try {
    await readInstructions(mcp);
    const comboContract = await readWriteContract(mcp, "combo_create");
    const planContract = await readWriteContract(mcp, "plan_create");
    assert.match(
      planContract.data.purpose,
      /pending.*contributes nothing to intake/i,
    );
    assert.match(comboContract.data.purpose, /reusable combination/i);
    assert.match(
      planContract.data.rules.join(" "),
      /multi-day meal prep.*one plan_create.*scheduledDates/i,
    );
    assert.match(
      planContract.data.rules.join(" "),
      /Do not call meal_create.*do not mark.*eaten/i,
    );

    const listed = await mcp.request("tools/list");
    const operations = listed.tools.find(
      (tool) => tool.name === "fitness_write",
    ).inputSchema.properties.operation.enum;
    assert.equal(operations.includes("plan_create"), true);
    assert.equal(operations.includes("meal_plan_create"), false);

    const inventedOperation = await mcp.request("tools/call", {
      name: "fitness_write",
      arguments: {
        operation: "meal_plan_create",
        body: {
          scheduledDates: ["2099-04-17"],
          mealType: "lunch",
          items: syntheticComboPayload.items,
        },
      },
    });
    assert.equal(inventedOperation.isError, true);
    assert.match(
      toolPayload(inventedOperation).facts.reason,
      /Unknown fitness write operation/,
    );
    assert.equal(received.length, 0);

    const created = toolPayload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: {
          operation: "combo_create",
          body: syntheticComboPayload,
        },
      }),
    );
    assert.equal(created.status, "succeeded");
    assert.deepEqual(received, [
      {
        method: "POST",
        url: "/api/nutrition/combos",
        body: {
          ...syntheticComboPayload,
          items: [
            {
              foodId: "FOOD|SYNTHETIC-GRAIN",
              quantity: 0.4,
              unit: "g",
            },
            {
              foodId: "FOOD|SYNTHETIC-PROTEIN",
              quantity: 0.2,
            },
          ],
        },
      },
    ]);

    const planned = toolPayload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: {
          operation: "plan_create",
          body: {
            scheduledDates: [
              "2099-04-17",
              "2099-04-18",
              "2099-04-19",
              "2099-04-20",
              "2099-04-21",
            ],
            mealType: "lunch",
            items: syntheticComboPayload.items,
          },
        },
      }),
    );
    assert.equal(planned.status, "succeeded");
    assert.deepEqual(received[1], {
      method: "POST",
      url: "/api/nutrition/plans",
      body: {
        scheduledDates: [
          "2099-04-17",
          "2099-04-18",
          "2099-04-19",
          "2099-04-20",
          "2099-04-21",
        ],
        mealType: "lunch",
        items: [
          {
            foodId: "FOOD|SYNTHETIC-GRAIN",
            quantity: 0.4,
            unit: "g",
          },
          {
            foodId: "FOOD|SYNTHETIC-PROTEIN",
            quantity: 0.2,
          },
        ],
      },
    });
    assert.deepEqual(
      received.map(({ url }) => url),
      ["/api/nutrition/combos", "/api/nutrition/plans"],
    );
    assert.equal(received.some(({ url }) => url === "/api/nutrition/meals"), false);

    const conflictingQuantity = await mcp.request("tools/call", {
      name: "fitness_write",
      arguments: {
        operation: "combo_create",
        body: {
          displayName: "Conflicting combo",
          items: [
            {
              foodId: "FOOD|1",
              defaultQuantity: 0.4,
              quantity: 0.5,
            },
          ],
        },
      },
    });
    assert.equal(conflictingQuantity.isError, true);
    assert.match(
      conflictingQuantity.content[0].text,
      /conflicting defaultQuantity and quantity values/,
    );
    assert.equal(received.length, 2);
  } finally {
    await mcp.close();
    await new Promise((resolve, reject) =>
      api.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("fitness MCP canonicalises grouped workouts and set aliases before validate or create", async () => {
  const received = [];
  let storedWorkout = null;
  const api = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            data: {
              workoutSessions: [
                {
                  sessionId: "WORKOUT|SYNTHETIC-PUSH",
                  ...storedWorkout,
                },
              ],
            },
          }),
        );
        return;
      }
      const parsed = JSON.parse(body);
      received.push({
        method: request.method,
        url: request.url,
        body: parsed,
      });
      if (!request.url.includes("validateOnly=1")) storedWorkout = parsed;
      response.writeHead(request.url.includes("validateOnly=1") ? 200 : 201, {
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify({
          valid: true,
          sessionId: "WORKOUT|SYNTHETIC-PUSH",
          requestId: request.headers["x-idempotency-key"],
        }),
      );
    });
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  const mcp = startMcp(`http://127.0.0.1:${address.port}/`);

  const syntheticPushSession = {
    burnedCaloriesKcalReported: 300,
    durationSeconds: 3600,
    sets: [
      {
        exercise: "Synthetic Bench Press",
        reps: 10,
        setNoExercise: 1,
        setNoSession: 1,
        weightKgReported: 50,
      },
      {
        exercise: "Synthetic Bench Press",
        notesManual: "Synthetic note for alias normalization.",
        reps: 9,
        setNoExercise: 2,
        setNoSession: 2,
        weightKgReported: 50,
      },
      {
        exercise: "Synthetic Shoulder Press",
        reps: 10,
        setNoExercise: 1,
        setNoSession: 3,
        setType: "warmup",
        weightKgReported: 10,
      },
    ],
    startedAt: "2099-04-15T18:00:00+00:00",
    timePrecision: "minute",
    title: "Synthetic Push Session",
    totalTvlKgReported: 1400,
    trainingPhaseId: "synthetic-phase-push",
    sessionIntent: "normal",
    type: "Strength",
  };

  try {
    await readInstructions(mcp);
    const initialized = await mcp.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    assert.equal(initialized.serverInfo.name, "open-fitness");
    mcp.notify("notifications/initialized");

    for (const operation of ["workout_validate", "workout_create"]) {
      const written = toolPayload(
        await mcp.request("tools/call", {
          name: "fitness_write",
          arguments: { operation, body: syntheticPushSession },
        }),
      );
      assert.equal(
        written.status,
        operation === "workout_validate" ? "validated" : "succeeded",
      );
    }

    const expected = JSON.parse(JSON.stringify(syntheticPushSession));
    expected.sets[1].coachNote = expected.sets[1].notesManual;
    delete expected.sets[1].notesManual;
    expected.sets[2].setTypeManual = expected.sets[2].setType;
    delete expected.sets[2].setType;
    assert.deepEqual(received, [
      {
        method: "POST",
        url: "/api/fitness/workout-sessions?validateOnly=1",
        body: expected,
      },
      {
        method: "POST",
        url: "/api/fitness/workout-sessions",
        body: expected,
      },
    ]);

    const equalAliases = JSON.parse(JSON.stringify(syntheticPushSession));
    equalAliases.sets[1].coachNote = equalAliases.sets[1].notesManual;
    equalAliases.sets[2].setTypeManual = equalAliases.sets[2].setType;
    const equalResult = toolPayload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: { operation: "workout_validate", body: equalAliases },
      }),
    );
    assert.equal(equalResult.status, "validated");
    assert.deepEqual(received[2].body, expected);

    const groupedSession = {
      ...syntheticPushSession,
      endedAt: "2099-04-15T19:00:00+00:00",
      sessionIntent: "deload",
      sessionTitle: syntheticPushSession.title,
      sessionType: syntheticPushSession.type,
      sets: undefined,
      title: undefined,
      totalSetsReported: 2,
      trainingBlockId: "TRAINING-BLOCK|SYNTHETIC|1",
      type: undefined,
      exercises: [
        {
          exerciseName: "Synthetic Bench Press",
          sets: [
            {
              reps: 8,
              setNumber: 1,
              weightKg: 35,
            },
            {
              reps: 8,
              setNumber: 2,
              weightKg: 35,
            },
          ],
        },
      ],
    };
    delete groupedSession.sets;
    const groupedResult = toolPayload(
      await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: { operation: "workout_create", body: groupedSession },
      }),
    );
    assert.equal(groupedResult.status, "succeeded");
    assert.deepEqual(received[3].body, {
      ...syntheticPushSession,
      endedAt: "2099-04-15T19:00:00+00:00",
      sessionIntent: "deload",
      totalSetsReported: 2,
      trainingBlockId: "TRAINING-BLOCK|SYNTHETIC|1",
      sets: [
        {
          exercise: "Synthetic Bench Press",
          reps: 8,
          setNoExercise: 1,
          weightKgReported: 35,
        },
        {
          exercise: "Synthetic Bench Press",
          reps: 8,
          setNoExercise: 2,
          weightKgReported: 35,
        },
      ],
    });

    for (const [alias, canonical] of [
      ["sessionTitle", "title"],
      ["sessionType", "type"],
    ]) {
      const conflicting = {
        ...syntheticPushSession,
        [alias]: `Different ${alias}`,
        [canonical]: `Canonical ${canonical}`,
      };
      const rejected = await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: { operation: "workout_create", body: conflicting },
      });
      assert.equal(rejected.isError, true);
      assert.match(rejected.content[0].text, /has conflicting/);
    }

    for (const [alias, canonical, aliasValue, canonicalValue] of [
      ["notesManual", "coachNote", "owner note", "different note"],
      ["setType", "setTypeManual", "warmup", "working"],
    ]) {
      const conflicting = JSON.parse(JSON.stringify(syntheticPushSession));
      conflicting.sets[0][alias] = aliasValue;
      conflicting.sets[0][canonical] = canonicalValue;
      const rejected = await mcp.request("tools/call", {
        name: "fitness_write",
        arguments: { operation: "workout_create", body: conflicting },
      });
      assert.equal(rejected.isError, true);
      assert.match(rejected.content[0].text, /has conflicting/);
    }
    const mixedShape = {
      ...syntheticPushSession,
      exercises: groupedSession.exercises,
    };
    const rejectedMixed = await mcp.request("tools/call", {
      name: "fitness_write",
      arguments: { operation: "workout_create", body: mixedShape },
    });
    assert.equal(rejectedMixed.isError, true);
    assert.match(rejectedMixed.content[0].text, /cannot contain both sets and exercises/);
    assert.equal(received.length, 4);
  } finally {
    await mcp.close();
    await new Promise((resolve, reject) =>
      api.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("fitness MCP keeps analysis lean by default and offers a non-null full view", async () => {
  const received = [];
  const payload = {
    range: { from: "2099-04-01", to: "2099-04-05", exercise: null },
    trainingSchedule: {
      status: "paused",
      planningDate: "2099-04-05",
      pause: {
        startsOn: "2099-04-05",
        resumeOn: null,
        reason: null,
      },
    },
    profile: {
      profileId: "SYNTHETIC_PROFILE",
      heightCm: 172,
      ownerEmail: null,
    },
    bodyMeasurements: [
      {
        measurementId: "MEASURE|SYNTHETIC-1",
        measuredAt: "2099-04-05T08:00:00+00:00",
        weightKg: 72,
        metabolicAgeYears: 30,
        physiqueRating: 4,
        muscleMassRightArmKg: 3,
        heartRateBpm: null,
        createdAt: "2099-04-05T08:01:00+00:00",
      },
    ],
    workoutSets: [
      {
        setId: "SET|SYNTHETIC-1",
        sessionId: "SESSION|SYNTHETIC-1",
        exercise: "Synthetic Cable Row",
        reps: 10,
        pain010Manual: null,
      },
    ],
    exerciseAliases: [
      {
        sourceExerciseName: "Synthetic Cable Row",
        canonicalName: "Synthetic Cable Row",
      },
      {
        sourceExerciseName: "Synthetic Pulldown",
        canonicalName: "Synthetic Pulldown",
      },
    ],
    evidenceBase: [{ evidenceId: "E01", title: "Reference" }],
    dataPolicies: [{ policyKey: "master_storage", policyValue: "SQLite" }],
    operatingConstraints: [
      {
        constraintId: "CONSTRAINT-01",
        item: "Synthetic Bench Press",
        status: "Resolved",
      },
    ],
    operatingConstraintHistory: [
      {
        constraintId: "CONSTRAINT-01",
        item: "Synthetic Bench Press",
        status: "Paused",
      },
    ],
    corrections: [
      {
        correctionId: "CORRECTION|CONSTRAINT-01",
        targetScope: "operating_constraint",
        targetKey: "CONSTRAINT-01",
        fieldName: "status",
        originalValue: "Paused",
        correctedValue: "Resolved",
      },
      {
        correctionId: "CORRECTION|SET-01",
        targetScope: "workout_set",
        targetKey: "SET|SYNTHETIC-1",
        fieldName: "reps",
        originalValue: "10",
        correctedValue: "12",
      },
    ],
    nutrition: {
      mealItems: [
        {
          mealItemId: "ITEM|1",
          itemNameSnapshot: "Synthetic tofu portion",
          proteinG: 0,
          assumption: null,
          confirmed: false,
        },
      ],
    },
  };
  const api = createServer((request, response) => {
    received.push(request.url);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  const mcp = startMcp(`http://127.0.0.1:${address.port}/`);

  try {
    const lean = toolPayload(
      await mcp.request("tools/call", {
        name: "fitness_read",
        arguments: {
          resource: "analysis",
          from: "2099-04-01",
          to: "2099-04-05",
        },
      }),
    ).data;
    assert.equal(JSON.stringify(lean).includes(":null"), false);
    assert.equal(lean.profile.heightCm, 172);
    assert.equal(lean.trainingSchedule.status, "paused");
    assert.equal(lean.trainingSchedule.pause.startsOn, "2099-04-05");
    assert.equal(lean.profile.profileId, undefined);
    assert.equal(lean.bodyMeasurements[0].metabolicAgeYears, undefined);
    assert.equal(lean.bodyMeasurements[0].measurementId, undefined);
    assert.equal(lean.workoutSets[0].setId, undefined);
    assert.deepEqual(
      lean.exerciseAliases.map((alias) => alias.sourceExerciseName),
      ["Synthetic Cable Row"],
    );
    assert.equal(lean.evidenceBase, undefined);
    assert.equal(lean.dataPolicies, undefined);
    assert.equal(
      lean.operatingConstraints[0].constraintId,
      "CONSTRAINT-01",
    );
    assert.equal(lean.operatingConstraints[0].status, "Resolved");
    assert.equal(lean.operatingConstraintHistory, undefined);
    assert.deepEqual(
      lean.corrections.map((correction) => correction.targetScope),
      ["workout_set"],
    );
    assert.equal(lean.nutrition.mealItems[0].proteinG, 0);
    assert.equal(lean.nutrition.mealItems[0].confirmed, false);

    const full = toolPayload(
      await mcp.request("tools/call", {
        name: "fitness_read",
        arguments: {
          resource: "analysis",
          from: "2099-04-01",
          to: "2099-04-05",
          view: "full",
        },
      }),
    ).data;
    assert.equal(JSON.stringify(full).includes(":null"), false);
    assert.equal(full.profile.profileId, "SYNTHETIC_PROFILE");
    assert.equal(full.bodyMeasurements[0].metabolicAgeYears, 30);
    assert.equal(
      full.bodyMeasurements[0].measurementId,
      "MEASURE|SYNTHETIC-1",
    );
    assert.equal(full.workoutSets[0].setId, "SET|SYNTHETIC-1");
    assert.equal(full.exerciseAliases.length, 2);
    assert.equal(full.evidenceBase[0].evidenceId, "E01");
    assert.equal(full.dataPolicies[0].policyValue, "SQLite");
    assert.equal(
      full.operatingConstraintHistory[0].status,
      "Paused",
    );
    assert.deepEqual(
      full.corrections.map((correction) => correction.targetScope),
      ["operating_constraint", "workout_set"],
    );

    assert.deepEqual(received, [
      "/api/fitness/analysis?from=2099-04-01&to=2099-04-05&view=default",
      "/api/fitness/analysis?from=2099-04-01&to=2099-04-05&view=full",
    ]);
  } finally {
    await mcp.close();
    await new Promise((resolve, reject) =>
      api.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("fitness MCP exposes bounded calibration and rejects malformed formula writes before the API", async () => {
  const received = [];
  const api = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const parsed = body ? JSON.parse(body) : null;
      received.push({
        method: request.method,
        url: request.url,
        body: parsed,
      });
      response.writeHead(request.method === "GET" ? 200 : 201, {
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify(
          request.method === "GET"
            ? { calibration: null }
            : {
                requestId: request.headers["x-idempotency-key"],
                target: {
                  settingsId: "synthetic-calibrated-target",
                  mode: parsed.mode,
                  effectiveFrom: parsed.effectiveFrom,
                  dailyDeficitKcal: parsed.dailyDeficitKcal,
                  activeEnergyCreditRate: parsed.activeEnergyCreditRate,
                  proteinTargetG: parsed.proteinTargetG,
                },
              },
        ),
      );
    });
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  const mcp = startMcp(`http://127.0.0.1:${address.port}/`);

  try {
    await readInstructions(mcp);
    const calibration = await mcp.request("tools/call", {
      name: "fitness_read",
      arguments: {
        resource: "nutrition_calibration",
        asOf: "2099-01-28",
      },
    });
    assert.equal(calibration.isError, undefined);
    assert.equal(received[0].url, "/api/nutrition/calibration?asOf=2099-01-28");

    const malformed = await mcp.request("tools/call", {
      name: "fitness_write",
      arguments: {
        operation: "nutrition_formula_calibrate",
        body: {
          mode: "formula",
          effectiveFrom: "2099-01-29",
          dailyDeficitKcal: 400,
          activeEnergyCreditRate: 0.8,
          proteinTargetG: 150,
        },
      },
    });
    assert.equal(malformed.isError, true);
    assert.match(
      toolPayload(malformed).facts.reason,
      /expectedSettingsId/,
    );
    assert.equal(received.length, 1);

    const written = await mcp.request("tools/call", {
      name: "fitness_write",
      arguments: {
        operation: "nutrition_formula_calibrate",
        requestId: "synthetic-calibration-2099",
        body: {
          mode: "formula",
          effectiveFrom: "2099-01-29",
          dailyDeficitKcal: 400,
          activeEnergyCreditRate: 0.8,
          proteinTargetG: 150,
          expectedSettingsId: "synthetic-current-target",
        },
      },
    });
    assert.equal(written.isError, undefined);
    assert.equal(toolPayload(written).status, "succeeded");
    assert.deepEqual(received[1], {
      method: "POST",
      url: "/api/nutrition/targets",
      body: {
        mode: "formula",
        effectiveFrom: "2099-01-29",
        dailyDeficitKcal: 400,
        activeEnergyCreditRate: 0.8,
        proteinTargetG: 150,
        expectedSettingsId: "synthetic-current-target",
      },
    });
  } finally {
    await mcp.close();
    await new Promise((resolve, reject) =>
      api.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
