import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CALIBRATION_MIN_COMPLETE_DAYS,
  deriveNutritionCalibration,
} from "../lib/nutrition-calibration.ts";

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function completeDay(index) {
  return {
    localDate: `2099-01-${String(index + 1).padStart(2, "0")}`,
    intakeKcal: 2100,
    mealEnergyComplete: true,
    activeEnergyKcal: 700,
    activityFinal: true,
    bmrKcal: 1900,
  };
}

test("calibration returns a bounded aggregate without daily records", () => {
  const days = Array.from(
    { length: CALIBRATION_MIN_COMPLETE_DAYS },
    (_, index) => completeDay(index),
  );
  const weights = [
    { localDate: "2099-01-01", weightKg: 90.2 },
    { localDate: "2099-01-01", weightKg: 90.15 },
    { localDate: "2099-01-02", weightKg: 90.1 },
    { localDate: "2099-01-03", weightKg: 90.0 },
    { localDate: "2099-01-15", weightKg: 89.7 },
    { localDate: "2099-01-16", weightKg: 89.6 },
    { localDate: "2099-01-17", weightKg: 89.5 },
  ];
  const result = deriveNutritionCalibration({
    from: "2099-01-01",
    to: "2099-01-28",
    days,
    weights,
  });

  assert.equal(result.readiness, "ready_for_review");
  assert.equal(result.window.completeDays, 14);
  assert.equal(result.window.weightDays, 6);
  assert.equal(result.observed.averageIntakeKcal, 2100);
  assert.equal(result.observed.averageActiveEnergyKcal, 700);
  assert.equal("days" in result, false);
  assert.equal("weights" in result, false);
});

test("incomplete nutrition or provisional activity is not calibration-ready", () => {
  const days = Array.from({ length: 14 }, (_, index) => completeDay(index));
  days[0] = { ...days[0], mealEnergyComplete: false, intakeKcal: null };
  days[1] = { ...days[1], activityFinal: false };
  const result = deriveNutritionCalibration({
    from: "2099-01-01",
    to: "2099-01-28",
    days,
    weights: [],
  });

  assert.equal(result.readiness, "needs_more_data");
  assert.equal(result.window.completeDays, 12);
  assert.ok(result.reasons.includes("INSUFFICIENT_COMPLETE_DAYS"));
  assert.ok(result.reasons.includes("INSUFFICIENT_WEIGHT_DAYS"));
});

test("calibration endpoint is read-only, bounded, and never auto-applies", () => {
  const route = source("app/api/nutrition/calibration/route.ts");
  assert.match(route, /CALIBRATION_WINDOW_DAYS/);
  assert.match(route, /currentTarget/);
  assert.match(route, /autoApply: false/);
  assert.match(route, /confirmationRequired: true/);
  assert.doesNotMatch(route, /export async function POST/);
  assert.doesNotMatch(route, /insert\(nutritionSettings\)/);
});
