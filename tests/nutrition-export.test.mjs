import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";

register("./helpers/typescript-alias-loader.mjs", import.meta.url);
const databasePath = join(mkdtempSync(join(tmpdir(), "fitness-export-")), "fitness.sqlite");
const initialized = spawnSync(process.execPath, ["scripts/init-local-sqlite.mjs", "--path", databasePath, "--goal", "Export fixture", "--cycle", "Push", "--timezone", "America/New_York", "--locale", "en"], { encoding: "utf8" });
assert.equal(initialized.status, 0, initialized.stderr);
process.env.FITNESS_SQLITE_PATH = databasePath;
process.env.FITNESS_API_TOKEN = "full-agent-fixture";
process.env.FITNESS_NUTRITION_EXPORT_TOKEN = "read-only-fixture";
process.env.FITNESS_NUTRITION_EXPORT_SOURCE_ID = "fixture-installation";
const { POST: postMeal } = await import("../app/api/nutrition/meals/route.ts");
const { POST: postEnergy } = await import("../app/api/nutrition/energy/route.ts");
const { GET } = await import("../app/api/nutrition/export/route.ts");
const { nutritionExportPage, shiftExportDate, exportNutrients } = await import("../lib/nutrition-export.ts");
const { getApiActor } = await import("../lib/api-auth.ts");
const { closeLocalDbForTests, getLocalClient } = await import("../db/local-sqlite.ts");
const fixture = new DatabaseSync(databasePath);
after(async () => { fixture.close(); await closeLocalDbForTests(); });
function meal(id, date, value = null, revision = 1) {
  if (revision === 1) fixture.prepare("INSERT INTO nutrition_meals (meal_id,local_date,meal_type,source,confidence,created_by) VALUES (?,?,'lunch','fixture','high','fixture')").run(id, date);
  else fixture.prepare("UPDATE nutrition_meals SET current_revision_no=? WHERE meal_id=?").run(revision, id);
  fixture.prepare("INSERT INTO nutrition_meal_revisions (meal_revision_id,meal_id,revision_no,energy_kcal,protein_g,trans_fat_g,created_by) VALUES (?,?,?,?,0,0,'fixture')").run(`${id}-${revision}`, id, revision, value);
}
meal("a", "2026-03-06", 100);
meal("b", "2026-03-06");
fixture.prepare("INSERT INTO nutrition_meal_items (meal_item_id,meal_revision_id,item_ordinal,item_name_snapshot,energy_kcal,confidence,assumption,quantity,unit) VALUES ('i1','b-1',1,'Known',25,'high','owner text',1,'portion'),('i2','b-1',2,'Unknown',NULL,'low',NULL,NULL,NULL)").run();
meal("void", "2026-03-05", 999);
fixture.prepare("UPDATE nutrition_meals SET voided_at='2026-03-06' WHERE meal_id='void'").run();
const now = new Date("2026-03-09T03:30:00Z"); // March 8 in New York, after DST change.
const page = (query, at = now) => nutritionExportPage(new URLSearchParams(query), "fixture-installation", "read-only-fixture", at);
async function call(query = "", token = "read-only-fixture") {
  const response = await GET(new Request(`http://localhost/api/nutrition/export?${query}`, { headers: token === null ? {} : { authorization: `Bearer ${token}` } }));
  assert.equal(response.headers.get("cache-control"), "no-store");
  return { response, body: await response.json() };
}

test("default covers history incl voided dates through timezone yesterday, whole-date pagination", async () => {
  const first = await page("limit=2");
  assert.equal(first.startDate, "2026-03-05");
  assert.equal(first.endDate, "2026-03-07");
  assert.deepEqual(first.days.map((day) => day.localDate), ["2026-03-05", "2026-03-06"]);
  assert.equal(first.days[0].status, "empty");
  assert.equal(first.days[0].nutrients.energyKcal.knownSum, null);
  assert.deepEqual(first.days[0].meals, []);
  const second = await page(`cursor=${first.nextCursor}`);
  assert.deepEqual(second.days.map((day) => day.localDate), ["2026-03-07"]);
  assert.equal(second.nextCursor, null);
  assert.equal(first.nextCursor, (await page("limit=2")).nextCursor);
});

test("nullable nutrients preserve known item subtotal, explicit zero, all nutrients and metadata", async () => {
  const day = (await page("date=2026-03-06")).days[0];
  assert.deepEqual(day.nutrients.energyKcal, { knownSum: 125, knownValueCount: 2, unknownValueCount: 1, status: "partial" });
  assert.equal(day.nutrients.proteinG.status, "complete");
  assert.equal(day.nutrients.transFatG.knownSum, 0);
  assert.equal(day.nutrients.sodiumMg.status, "unknown");
  for (const key of exportNutrients) {
    assert.ok(key in day.meals[0]);
    assert.ok(key in day.meals[1].items[0]);
  }
  assert.equal(day.meals[0].eatenAt, null);
  assert.equal(day.meals[0].timePrecision, "date_only");
  assert.equal(day.meals[1].items[0].assumption, "owner text");
  assert.equal(day.meals[1].items[0].quantity, 1);
});

test("fingerprints stable across locale/time/order; revisions and voids change payload under stable date ID", async () => {
  const first = (await page("date=2026-03-06")).days[0];
  for (const locale of ["zh-HK", "zh-TW", "zh-CN", "en"]) {
    fixture.prepare("UPDATE profile SET preferred_locale=?").run(locale);
    assert.equal((await page("date=2026-03-06", new Date("2026-04-01Z"))).days[0].fingerprint, first.fingerprint);
  }
  meal("a", "2026-03-06", 101, 2);
  const revised = (await page("date=2026-03-06")).days[0];
  assert.equal(revised.id, first.id);
  assert.notEqual(revised.fingerprint, first.fingerprint);
  assert.equal(revised.meals[0].revisionNo, 2);
  fixture.prepare("UPDATE nutrition_meals SET voided_at='2026-03-08' WHERE meal_id IN ('a','b')").run();
  const cleared = (await page("date=2026-03-06")).days[0];
  assert.equal(cleared.id, first.id);
  assert.equal(cleared.status, "empty");
  assert.deepEqual(cleared.meals, []);
  assert.notEqual(cleared.fingerprint, revised.fingerprint);
});

test("calendar range emits holes and former dates after a supported meal date move", async () => {
  meal("move", "2026-02-01", 0);
  const moved = await postMeal(new Request("http://localhost/api/nutrition/meals", { method: "POST", headers: { authorization: "Bearer full-agent-fixture", "content-type": "application/json", "x-idempotency-key": "fixture-meal-date-move" }, body: JSON.stringify({ mealId: "move", expectedRevisionNo: 1, localDate: "2026-02-02", items: [{ name: "Moved zero", nutrients: { energyKcal: 0 } }] }) }));
  assert.equal(moved.status, 200, JSON.stringify(await moved.json()));
  const result = await page("startDate=2026-02-01&endDate=2026-02-03");
  assert.deepEqual(result.days.map((day) => day.status), ["empty", "recorded", "empty"]);
  assert.equal((await page("")).startDate, "2026-02-02");
  assert.equal(result.days[1].nutrients.energyKcal.knownSum, 0);
});

test("strict queries, future dates and tampered/out-of-context cursors fail", async () => {
  for (const query of ["date=2026-02-30", "date=2026-03-08", "date=2026-03-06&date=2026-03-06", "unknown=1", "startDate=2026-03-05", "startDate=2026-03-07&endDate=2026-03-06", "date=2026-03-06&endDate=2026-03-07", "limit=0", "limit=91", "limit=01", "cursor=bad"]) await assert.rejects(page(query), /Invalid nutrition export query/);
  const { nextCursor } = await page("startDate=2026-03-01&endDate=2026-03-07&limit=1");
  await assert.rejects(page(`cursor=${nextCursor}x`));
  await assert.rejects(page(`cursor=${nextCursor}&limit=1`));
  await assert.rejects(nutritionExportPage(new URLSearchParams({ cursor: nextCursor }), "another-installation", "read-only-fixture", now));
  fixture.prepare("UPDATE profile SET timezone='Asia/Hong_Kong'").run();
  await assert.rejects(page(`cursor=${nextCursor}`));
  fixture.prepare("UPDATE profile SET timezone='America/New_York'").run();
});

test("yesterday uses profile calendar across DST and opposite UTC offsets", async () => {
  assert.equal(shiftExportDate("2026-03-09", -1), "2026-03-08");
  assert.equal((await page("date=yesterday")).days[0].localDate, "2026-03-07");
  assert.equal((await page("", new Date("2026-11-02T04:30:00Z"))).endDate, "2026-10-31");
  fixture.prepare("UPDATE profile SET timezone='Pacific/Kiritimati'").run();
  assert.equal((await page("", new Date("2026-03-08T12:00:00Z"))).endDate, "2026-03-08");
  assert.equal((await page("date=yesterday", new Date("2026-03-08T12:00:00Z"))).days[0].localDate, "2026-03-08");
  fixture.prepare("UPDATE profile SET timezone='America/New_York'").run();
});

test("read token confined to export; full token allowed; configuration collisions fail closed", async () => {
  assert.equal((await call("date=2026-03-06")).response.status, 200);
  assert.equal((await call("date=2026-03-06", "full-agent-fixture")).response.status, 200);
  for (const token of [null, "wrong", "health-fixture"]) assert.equal((await call("", token)).response.status, 401);
  assert.equal(await getApiActor(new Request("http://localhost/api/nutrition/meals", { method: "POST", headers: { authorization: "Bearer read-only-fixture" } })), null);
  for (const name of ["FITNESS_API_TOKEN", "FITNESS_HEALTH_SYNC_TOKEN", "FITNESS_SESSION_SECRET", "FITNESS_OWNER_PASSWORD_HASH"]) {
    const old = process.env[name]; process.env[name] = "read-only-fixture";
    assert.equal((await call()).response.status, 500);
    if (old === undefined) delete process.env[name]; else process.env[name] = old;
  }
  delete process.env.FITNESS_NUTRITION_EXPORT_SOURCE_ID;
  assert.equal((await call()).response.status, 500);
  process.env.FITNESS_NUTRITION_EXPORT_SOURCE_ID = "fixture-installation";
  assert.equal((await call("extra=1")).body.errorCode, "INVALID_NUTRITION_EXPORT_QUERY");
});

test("read failures and missing current revisions are errors, never empty clears", async () => {
  const client = getLocalClient(); const original = client.transaction;
  client.transaction = async () => { throw new Error("private database failure"); };
  const failed = await call();
  assert.equal(failed.response.status, 500);
  assert.equal(JSON.stringify(failed.body).includes("private database"), false);
  client.transaction = original;
  fixture.prepare("UPDATE nutrition_meals SET current_revision_no=999 WHERE meal_id='move'").run();
  assert.equal((await call("date=2026-02-02")).response.status, 500);
  fixture.prepare("UPDATE nutrition_meals SET current_revision_no=1 WHERE meal_id='move'").run();
});

test("actual write routes reject export token and collisions while independent Health token works", async () => {
  function request(path, token, body) {
    return new Request(`http://localhost/api/nutrition/${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-idempotency-key": "export-scope-fixture" }, body: JSON.stringify(body) });
  }
  const mealBody = { localDate: "2026-01-01", items: [{ name: "Fixture", nutrients: { energyKcal: 10 } }] };
  const energyBody = { mode: "settlement", localDate: "2026-01-01", activeEnergyKcal: 10 };
  assert.equal((await postMeal(request("meals", "read-only-fixture", mealBody))).status, 401);
  assert.equal((await postEnergy(request("energy", "read-only-fixture", energyBody))).status, 401);
  process.env.FITNESS_HEALTH_SYNC_TOKEN = "health-fixture";
  assert.equal((await postEnergy(request("energy", "health-fixture", energyBody))).status, 201);
  const oldError = console.error;
  console.error = () => {};
  try {
    for (const name of ["FITNESS_API_TOKEN", "FITNESS_HEALTH_SYNC_TOKEN"]) {
      const old = process.env[name]; process.env[name] = "read-only-fixture";
      assert.equal((await postMeal(request("meals", "read-only-fixture", mealBody))).status, 500);
      assert.equal((await postEnergy(request("energy", "read-only-fixture", energyBody))).status, 500);
      process.env[name] = old;
    }
  } finally { console.error = oldError; }
});

test("each page retains one read snapshot when a writer revises between meal and item reads", async () => {
  meal("snapshot", "2026-01-02", 10);
  fixture.prepare("INSERT INTO nutrition_meal_items (meal_item_id,meal_revision_id,item_ordinal,item_name_snapshot,energy_kcal,confidence) VALUES ('snapshot-item','snapshot-1',1,'Old item',10,'high')").run();
  const client = getLocalClient(); const original = client.transaction;
  let wrote = false;
  client.transaction = async function (...args) {
    assert.equal(args[0], "read");
    const transaction = await original.apply(client, args);
    const execute = transaction.execute;
    transaction.execute = async function (...statement) {
      const result = await execute.apply(transaction, statement);
      const sql = typeof statement[0] === "string" ? statement[0] : statement[0].sql;
      if (!wrote && sql.includes('from "nutrition_meals" left join')) {
        wrote = true;
        meal("snapshot", "2026-01-02", 20, 2);
        fixture.prepare("INSERT INTO nutrition_meal_items (meal_item_id,meal_revision_id,item_ordinal,item_name_snapshot,energy_kcal,confidence) VALUES ('snapshot-item-new','snapshot-2',1,'New item',20,'high')").run();
      }
      return result;
    };
    return transaction;
  };
  try {
    const during = (await page("date=2026-01-02")).days[0].meals[0];
    assert.equal(wrote, true);
    assert.equal(during.revisionNo, 1);
    assert.equal(during.items[0].itemNameSnapshot, "Old item");
  } finally { client.transaction = original; }
  assert.equal((await page("date=2026-01-02")).days[0].meals[0].revisionNo, 2);
});

test("decimal subtotals match existing three-decimal precision and schema lists every nutrient", async () => {
  meal("decimal1", "2026-01-03", 0.1);
  meal("decimal2", "2026-01-03", 0.2);
  const result = await page("date=2026-01-03");
  assert.equal(result.days[0].nutrients.energyKcal.knownSum, 0.3);
  const { readFileSync } = await import("node:fs");
  const schema = JSON.parse(readFileSync(new URL("../docs/nutrition-export.openapi.json", import.meta.url), "utf8"));
  assert.deepEqual(schema.components.schemas.NutrientValues.required, [...exportNutrients]);
  for (const key of exportNutrients) assert.deepEqual(schema.components.schemas.NutrientValues.properties[key].type, ["number", "null"]);
});

test("plans excluded and large same-date meal counts retain items across parameter chunks", async () => {
  fixture.prepare("INSERT INTO nutrition_meal_plans (plan_id,scheduled_date,meal_type,source,confidence,created_by) VALUES ('export-plan','2026-01-04','lunch','fixture','high','fixture')").run();
  assert.equal((await page("date=2026-01-04")).days[0].status, "empty");
  for (let index = 0; index < 105; index++) {
    const id = `chunk-${index}`;
    meal(id, "2026-01-04", 1);
    fixture.prepare("INSERT INTO nutrition_meal_items (meal_item_id,meal_revision_id,item_ordinal,item_name_snapshot,energy_kcal,confidence) VALUES (?,?,1,'Chunk item',1,'high')").run(`${id}-item`, `${id}-1`);
  }
  const result = await page("date=2026-01-04");
  assert.equal(result.days[0].meals.length, 105);
  assert.equal(result.days[0].nutrients.energyKcal.knownSum, 105);
  assert.ok(result.days[0].meals.every((entry) => entry.items.length === 1));
  const rotated = await nutritionExportPage(new URLSearchParams("date=2026-01-04"), "fixture-installation", "rotated-secret", now);
  assert.equal(rotated.days[0].id, result.days[0].id);
  assert.equal(rotated.days[0].fingerprint, result.days[0].fingerprint);
});
