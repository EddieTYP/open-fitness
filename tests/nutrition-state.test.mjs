import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveNutritionDayState,
  deriveNutritionFigures,
  preferredEnergyObservation,
} from "../lib/nutrition-state.ts";

test("an empty day stays unknown instead of becoming zero", () => {
  const state = deriveNutritionDayState({
    hasMeals: false,
    mealEnergyKnown: false,
    activityState: "missing",
  });
  const figures = deriveNutritionFigures({
    hasMeals: false,
    mealEnergyKnown: false,
    dailyEnergyKcal: null,
    bmrKcal: 1906,
    dailyDeficitKcal: 400,
    activeEnergyCreditRate: 0.8,
    activeEnergyKcal: null,
    basalEnergyKcal: null,
  });

  assert.deepEqual(state, {
    intakeState: "no_record",
    settlementState: "unavailable",
  });
  assert.equal(figures.targetKcal, 1506);
  assert.equal(figures.consumedKcal, null);
  assert.equal(figures.remainingKcal, null);
  assert.equal(figures.estimatedBalanceKcal, null);
});

test("intake target and rough energy balance remain distinct", () => {
  const figures = deriveNutritionFigures({
    hasMeals: true,
    mealEnergyKnown: true,
    dailyEnergyKcal: 2294,
    bmrKcal: 1906,
    dailyDeficitKcal: 400,
    activeEnergyCreditRate: 0.8,
    activeEnergyKcal: 650,
    basalEnergyKcal: null,
  });

  assert.equal(figures.targetKcal, 2026);
  assert.equal(figures.targetVarianceKcal, 268);
  assert.equal(figures.remainingKcal, -268);
  assert.equal(figures.estimatedExpenditureKcal, 2556);
  assert.equal(figures.estimatedBalanceKcal, -262);
});

test("a final Active Energy observation beats a newer provisional one", () => {
  const provisional = {
    energyObservationId: "provisional",
    observedAt: "2026-07-31T20:00:00+08:00",
    createdAt: "2026-07-31T20:00:00+08:00",
    status: "provisional",
  };
  const final = {
    energyObservationId: "final",
    observedAt: null,
    createdAt: "2026-08-01T07:40:00+08:00",
    status: "final",
  };

  assert.equal(
    [provisional, final].reduce(
      preferredEnergyObservation,
      null,
    )?.energyObservationId,
    "final",
  );
  assert.equal(
    [final, provisional].reduce(
      preferredEnergyObservation,
      null,
    )?.energyObservationId,
    "final",
  );
});

test("the latest intraday Active Energy observation wins before settlement", () => {
  const earlier = {
    energyObservationId: "earlier",
    observedAt: "2026-08-06T12:00:00+08:00",
    createdAt: "2026-08-06T12:00:01+08:00",
    status: "provisional",
  };
  const later = {
    energyObservationId: "later",
    observedAt: "2026-08-06T15:00:00+08:00",
    createdAt: "2026-08-06T15:00:01+08:00",
    status: "provisional",
  };

  assert.equal(
    [later, earlier].reduce(
      preferredEnergyObservation,
      null,
    )?.energyObservationId,
    "later",
  );
});
