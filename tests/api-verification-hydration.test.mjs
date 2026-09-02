import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("idempotent replay accepts only the same canonical body digest", () => {
  const idempotency = source("lib/idempotency.ts");
  assert.match(
    idempotency,
    /existing\.payloadSha256 !== payloadSha256[\s\S]*throw new Error\("Idempotency key conflict"\)[\s\S]*return existing\.entityId/,
  );
  const routeError = source("lib/api-route-error.ts");
  assert.match(
    routeError,
    /message\.includes\("Idempotency key conflict"\)[\s\S]*"IDEMPOTENCY_KEY_CONFLICT"[\s\S]*409/,
  );
});

test("training course initial and replay responses use persisted hydrated records", () => {
  const route = source("app/api/fitness/training-course/route.ts");
  assert.match(
    route,
    /if \(replayedBatchId\) \{[\s\S]*courseRecordsForBatch\([\s\S]*records\.length !== mutation\.items\.length[\s\S]*records,[\s\S]*replay: true/,
  );
  assert.match(
    route,
    /const records = await courseRecordsForBatch\([\s\S]*?overrideBatchId,[\s\S]*?mutation\.scope,[\s\S]*?\);[\s\S]*?recordIds: records\.map[\s\S]*?records,/,
  );
  const postCommitReadback = route.slice(
    route.lastIndexOf("const records = await courseRecordsForBatch("),
    route.lastIndexOf("return Response.json("),
  );
  assert.doesNotMatch(postCommitReadback, /getDashboardData\(/);
  assert.match(
    postCommitReadback,
    /actual\.prescription !== expected\.prescription[\s\S]*actual\.loadGuidance !== expected\.loadGuidance[\s\S]*actual\.effort !== expected\.effort/,
  );
  for (const field of [
    "recordId",
    "overrideBatchId",
    "scope",
    "lifecycle",
    "active",
    "phaseId",
    "trainingBlockId",
    "date",
    "plannedSessionId",
    "sessionIntent",
    "sourceSessionId",
    "slotId",
    "exercise",
    "prescription",
    "loadGuidance",
    "effort",
  ]) {
    assert.match(route, new RegExp(`\\b${field}(?:\\s*:|\\s*,)`), `missing ${field}`);
  }
  assert.match(
    route,
    /desc\(trainingExerciseSelections\.recordedAt\)[\s\S]*desc\(trainingExerciseSelections\.selectionId\)/,
  );
  assert.match(
    route,
    /const overrideBatchId = `TRAINING-COURSE\|\$\{await payloadSha256\(\{[\s\S]*requestId,[\s\S]*entityType,[\s\S]*\}\)\}`/,
  );
  assert.match(
    route,
    /catch \(error\) \{[\s\S]*concurrentReplayBatchId[\s\S]*findIdempotentReplay\([\s\S]*replay: true/,
  );
  const transaction = route.slice(
    route.indexOf("await db.transaction(async (tx) =>"),
    route.indexOf("} catch (error)", route.indexOf("await db.transaction(async (tx) =>")),
  );
  assert.match(
    transaction,
    /planFingerprint = postWritePlanFingerprint\(datePlan, mutation\.items\)/,
  );
  assert.match(
    transaction,
    /operation: "readback"[\s\S]*entityType: resultEntityType\(entityType\)[\s\S]*entityId: planFingerprint[\s\S]*payloadSha256: digest/,
  );
  const replayHelper = route.slice(
    route.indexOf("async function replayedPlanFingerprint("),
    route.indexOf("function postWritePlanFingerprint("),
  );
  assert.match(
    replayHelper,
    /findIdempotentReplay\([\s\S]*resultEntityType\(entityType\)[\s\S]*digest[\s\S]*return fingerprint/,
  );
  assert.equal(
    route.match(/planFingerprint: await replayedPlanFingerprint\(/g)?.length,
    2,
  );
});

test("plan cancellation is compare-and-set and proves cancelled readback", () => {
  const route = source("app/api/nutrition/plans/route.ts");
  assert.match(
    route,
    /db\.transaction\(async \(tx\)[\s\S]*eq\(nutritionMealPlans\.currentVersionNo, expectedVersionNo\)[\s\S]*eq\(nutritionMealPlans\.status, "pending"\)[\s\S]*\.returning\(\)/,
  );
  assert.match(route, /if \(!updated\[0\]\) throw new PlanWriteConflict\(\)/);
  assert.match(
    route,
    /const cancelledPlan = await getNutritionMealPlan\(planId\)[\s\S]*cancelledPlan\.status !== "cancelled"[\s\S]*cancelledPlan\.versionNo !== storedVersionNo/,
  );
  assert.match(
    route,
    /if \(replayedId\) \{[\s\S]*getNutritionMealPlan\(replayedId\)[\s\S]*status !== "cancelled"[\s\S]*plan: replayedPlan/,
  );
});

test("food hydration exposes persisted identity, aliases, category, and revision source", () => {
  const nutrition = source("lib/nutrition.ts");
  for (const selection of [
    "category: nutritionFoods.category",
    "source: nutritionFoods.source",
    "originalLabel: nutritionFoods.originalLabel",
    "sourceNote: nutritionFoodVersions.sourceNote",
    "effectiveFrom: nutritionFoodVersions.effectiveFrom",
  ]) {
    assert.match(nutrition, new RegExp(selection.replaceAll(".", "\\.")));
  }
  assert.match(
    nutrition,
    /nutritionAliasesByFoodId\([\s\S]*nutritionFoodAliases\.alias[\s\S]*aliases: aliases\.get\(row\.foodId\) \?\? \[\]/,
  );

  const itemsRoute = source("app/api/nutrition/items/route.ts");
  const createRoute = itemsRoute.slice(
    itemsRoute.indexOf("export async function POST("),
    itemsRoute.indexOf("export async function PATCH("),
  );
  assert.match(
    createRoute,
    /if \(replayedId\) \{[\s\S]*const replayedItem = await getNutritionFood\(replayedId\)[\s\S]*foodId: replayedId[\s\S]*replay: true[\s\S]*item: replayedItem/,
  );
  assert.match(
    createRoute,
    /foodId,[\s\S]*replay: false,[\s\S]*item: await getNutritionFood\(foodId\)/,
  );
  assert.match(
    itemsRoute,
    /hydrateNutritionFoodRevision\(storedFood, versionNo\)/,
  );
  assert.match(
    itemsRoute,
    /eq\(nutritionFoodVersions\.versionNo, versionNo\)/,
  );
  assert.match(
    itemsRoute,
    /entityId: foodRevisionEntityId\(foodId, versionNo\)/,
  );
  assert.match(itemsRoute, /NUTRITION_FOOD_REPLAY_STALE/);
});
