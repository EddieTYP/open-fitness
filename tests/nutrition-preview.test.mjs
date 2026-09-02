import assert from "node:assert/strict";
import test from "node:test";
import { calculateNutrientPreview } from "../lib/nutrition-preview.ts";

function nutrients(values = {}) {
  return {
    energyKcal: null,
    proteinG: null,
    totalFatG: null,
    saturatedFatG: null,
    transFatG: null,
    carbsG: null,
    sugarG: null,
    fibreG: null,
    sodiumMg: null,
    cholesterolMg: null,
    ...values,
  };
}

test("combo nutrient preview scales and sums each item", () => {
  const preview = calculateNutrientPreview([
    {
      nutrients: nutrients({ energyKcal: 100, proteinG: 10 }),
      multiplier: 1.25,
    },
    {
      nutrients: nutrients({ energyKcal: 50, proteinG: 5 }),
      multiplier: 2,
    },
  ]);

  assert.equal(preview.invalid, false);
  assert.equal(preview.values.energyKcal.value, 225);
  assert.equal(preview.values.proteinG.value, 22.5);
  assert.equal(preview.values.energyKcal.partial, false);
});

test("combo nutrient preview preserves partial and unknown values", () => {
  const preview = calculateNutrientPreview([
    { nutrients: nutrients({ sugarG: 10 }), multiplier: 1 },
    { nutrients: nutrients(), multiplier: 1 },
  ]);

  assert.equal(preview.values.sugarG.value, 10);
  assert.equal(preview.values.sugarG.partial, true);
  assert.equal(preview.values.fibreG.value, null);
  assert.equal(preview.values.fibreG.partial, false);
});

test("combo nutrient preview suppresses totals while a quantity is invalid", () => {
  const preview = calculateNutrientPreview([
    {
      nutrients: nutrients({ energyKcal: 100 }),
      multiplier: null,
    },
  ]);

  assert.equal(preview.invalid, true);
  assert.equal(preview.values.energyKcal.value, null);
});
