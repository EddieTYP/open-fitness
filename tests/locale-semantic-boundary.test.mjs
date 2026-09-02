import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MealClassificationValidationError,
  validateMealClassification,
} from "../lib/nutrition-classification.ts";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("post-workout meaning comes from contextTag, not a localized source label", () => {
  for (const originalMealType of [
    "運動後",
    "运动后",
    "Post-workout",
    "Après entraînement",
    null,
  ]) {
    assert.deepEqual(
      validateMealClassification({
        mealType: "other",
        contextTag: "post_workout",
        originalMealType,
      }),
      {
        mealType: "other",
        contextTag: "post_workout",
        originalMealType,
      },
    );
  }
});

test("meal classification still rejects structurally inconsistent values", () => {
  assert.throws(
    () =>
      validateMealClassification({
        mealType: "snack",
        contextTag: "post_workout",
        originalMealType: "Post-workout",
      }),
    MealClassificationValidationError,
  );
  assert.throws(
    () =>
      validateMealClassification({
        mealType: "other",
        contextTag: null,
        originalMealType: "Post-workout",
      }),
    MealClassificationValidationError,
  );
});

test("meal and plan routes share the locale-neutral classification validator", async () => {
  const [mealRoute, planRoute] = await Promise.all([
    source("app/api/nutrition/meals/route.ts"),
    source("app/api/nutrition/plans/route.ts"),
  ]);

  assert.match(mealRoute, /validateMealClassification\(\{/);
  assert.match(planRoute, /validateMealClassification\(\{/);
  assert.match(mealRoute, /INVALID_MEAL_CLASSIFICATION/);
  assert.match(planRoute, /INVALID_MEAL_CLASSIFICATION/);
  assert.doesNotMatch(mealRoute, /originalMealType\s*!==\s*"運動後"/);
  assert.doesNotMatch(planRoute, /originalMealType\s*!==\s*"運動後"/);
});

test("fitness output localizes known exercises without rewriting source records", async () => {
  const [fitness, exerciseDisplay] = await Promise.all([
    source("lib/fitness.ts"),
    source("lib/exercise-display.ts"),
  ]);

  assert.match(fitness, /exercise: exerciseText\(selection\.exercise\)/);
  assert.match(fitness, /exercise: sourceText\(phaseLabel\)/);
  assert.match(fitness, /exercise: exerciseText\(strengthExercise\)/);
  assert.match(fitness, /sourceText\(latestRecovery\.note\)/);
  assert.match(exerciseDisplay, /exerciseMessageKey/);
  assert.match(exerciseDisplay, /sourceText\(value\)/);
  assert.doesNotMatch(exerciseDisplay, /return\s+exerciseMessages\[locale\]\[key\]\s*\|\|/);
});
