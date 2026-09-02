import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertExpectedNutritionTarget,
  normaliseNutritionTarget,
  nutritionTargetInsertValues,
  nutritionTargetResponse,
  NutritionTargetConflictError,
} from "../lib/nutrition-targets.ts";
import { deriveNutritionFigures } from "../lib/nutrition-state.ts";

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("nutrition targets use strict explicit calorie, protein, and date values", () => {
  assert.deepEqual(
    normaliseNutritionTarget({
      effectiveFrom: "2026-08-16",
      calorieTargetKcal: 2100,
      proteinTargetG: 155.5,
    }),
    {
      effectiveFrom: "2026-08-16",
      calorieTargetKcal: 2100,
      proteinTargetG: 155.5,
    },
  );

  for (const value of [499, 6001, 2000.5, "2000", null]) {
    assert.throws(
      () =>
        normaliseNutritionTarget({
          effectiveFrom: "2026-08-16",
          calorieTargetKcal: value,
          proteinTargetG: 150,
        }),
      /calorieTargetKcal must be an integer from 500 to 6000/,
    );
  }
  for (const value of [0, -1, 501, "150", null]) {
    assert.throws(
      () =>
        normaliseNutritionTarget({
          effectiveFrom: "2026-08-16",
          calorieTargetKcal: 2000,
          proteinTargetG: value,
        }),
      /proteinTargetG must be greater than 0 and at most 500/,
    );
  }
  assert.throws(
    () =>
      normaliseNutritionTarget({
        effectiveFrom: "2026-02-30",
        calorieTargetKcal: 2000,
        proteinTargetG: 150,
      }),
    /effectiveFrom must use YYYY-MM-DD/,
  );
  assert.throws(
    () =>
      normaliseNutritionTarget({
        effectiveFrom: "2026-08-16",
        calorieTargetKcal: 2000,
        proteinTargetG: 150,
        status: "active",
      }),
    /unknown field.*status/,
  );
});

test("new explicit targets preserve unrelated legacy limits", () => {
  const inherited = {
    settingsId: "legacy",
    effectiveFrom: "2026-08-01",
    status: "active",
    calorieTargetKcal: null,
    dailyDeficitKcal: 350,
    activeEnergyCreditRate: 0.75,
    proteinTargetG: 140,
    saturatedFatLimitG: 20,
    sodiumLimitMg: 2300,
    sourceNote: "Legacy rule",
    createdAt: "2026-08-01T00:00:00.000Z",
  };
  const values = nutritionTargetInsertValues(
    {
      mode: "fixed",
      effectiveFrom: "2026-08-16",
      calorieTargetKcal: 2050,
      proteinTargetG: 160,
    },
    inherited,
    "target-1",
  );
  assert.deepEqual(values, {
    settingsId: "target-1",
    effectiveFrom: "2026-08-16",
    status: "active",
    calorieTargetKcal: 2050,
    dailyDeficitKcal: 350,
    activeEnergyCreditRate: 0.75,
    proteinTargetG: 160,
    saturatedFatLimitG: 20,
    sodiumLimitMg: 2300,
    sourceNote: "Explicit daily intake and protein target",
  });
  assert.equal(
    nutritionTargetResponse({ ...inherited, ...values, createdAt: inherited.createdAt })
      .calorieTargetKcal,
    2050,
  );
});

test("formula targets require an explicit prior version and strict values", () => {
  assert.deepEqual(
    normaliseNutritionTarget({
      mode: "formula",
      effectiveFrom: "2026-08-22",
      dailyDeficitKcal: 425,
      activeEnergyCreditRate: 0.75,
      proteinTargetG: 150,
      expectedSettingsId: "target-current",
    }),
    {
      mode: "formula",
      effectiveFrom: "2026-08-22",
      dailyDeficitKcal: 425,
      activeEnergyCreditRate: 0.75,
      proteinTargetG: 150,
      expectedSettingsId: "target-current",
    },
  );
  assert.throws(
    () =>
      normaliseNutritionTarget({
        mode: "formula",
        effectiveFrom: "2026-08-22",
        dailyDeficitKcal: 425,
        activeEnergyCreditRate: 0.75,
        proteinTargetG: 150,
      }),
    /expectedSettingsId is required/,
  );
  for (const value of [-0.1, 1.1, "0.8"]) {
    assert.throws(
      () =>
        normaliseNutritionTarget({
          mode: "formula",
          effectiveFrom: "2026-08-22",
          dailyDeficitKcal: 425,
          activeEnergyCreditRate: value,
          proteinTargetG: 150,
          expectedSettingsId: "target-current",
        }),
      /activeEnergyCreditRate must be from 0 to 1/,
    );
  }
});

test("an explicit calorie target replaces rather than augments the legacy budget", () => {
  const shared = {
    hasMeals: true,
    mealEnergyKnown: true,
    dailyEnergyKcal: 1900,
    bmrKcal: 1800,
    dailyDeficitKcal: 400,
    activeEnergyCreditRate: 0.8,
    activeEnergyKcal: 1000,
    basalEnergyKcal: null,
  };
  assert.equal(
    deriveNutritionFigures({ ...shared, calorieTargetKcal: 2100 }).targetKcal,
    2100,
  );
  assert.equal(
    deriveNutritionFigures({ ...shared, calorieTargetKcal: null }).targetKcal,
    2200,
  );
});

test("reviewed formula targets create a new active formula version", () => {
  const inherited = {
    settingsId: "formula-old",
    effectiveFrom: "2026-08-01",
    status: "provisional",
    calorieTargetKcal: null,
    dailyDeficitKcal: 400,
    activeEnergyCreditRate: 0.8,
    proteinTargetG: 150,
    saturatedFatLimitG: 20,
    sodiumLimitMg: 2300,
    sourceNote: "Initial estimate",
    createdAt: "2026-08-01T00:00:00.000Z",
  };
  assert.deepEqual(
    nutritionTargetInsertValues(
      {
        mode: "formula",
        effectiveFrom: "2026-08-22",
        dailyDeficitKcal: 425,
        activeEnergyCreditRate: 0.75,
        proteinTargetG: 155,
        expectedSettingsId: "formula-old",
      },
      inherited,
      "formula-new",
    ),
    {
      settingsId: "formula-new",
      effectiveFrom: "2026-08-22",
      status: "active",
      calorieTargetKcal: null,
      dailyDeficitKcal: 425,
      activeEnergyCreditRate: 0.75,
      proteinTargetG: 155,
      saturatedFatLimitG: 20,
      sodiumLimitMg: 2300,
      sourceNote:
        "Reviewed BMR, deficit, active-energy credit, and protein targets",
    },
  );
});

test("formula review refuses to overwrite a newer effective target", () => {
  const proposed = normaliseNutritionTarget({
    mode: "formula",
    effectiveFrom: "2099-01-29",
    dailyDeficitKcal: 425,
    activeEnergyCreditRate: 0.75,
    proteinTargetG: 150,
    expectedSettingsId: "formula-old",
  });
  assert.throws(
    () =>
      assertExpectedNutritionTarget(proposed, {
        settingsId: "formula-newer",
        effectiveFrom: "2099-01-28",
        status: "active",
        calorieTargetKcal: null,
        dailyDeficitKcal: 400,
        activeEnergyCreditRate: 0.8,
        proteinTargetG: 150,
        saturatedFatLimitG: null,
        sodiumLimitMg: null,
        sourceNote: "Synthetic newer rule",
        createdAt: "2099-01-28T00:00:00.000Z",
      }),
    NutritionTargetConflictError,
  );
});

test("nutrition target changes invalidate the open Nutrition view", () => {
  const revisionRoute = source("app/api/fitness/revisions/route.ts");
  const nutritionView = source("components/NutritionView.tsx");

  assert.match(
    revisionRoute,
    /'nutrition_target'[\s\S]*?\)\s*THEN audit_id[\s\S]*?AS "nutritionRevision"/,
  );
  assert.match(nutritionView, /revisions\.nutrition/);
  assert.match(nutritionView, /nutritionRevisionRef\.current !== nextRevision/);
});

test("nutrition target basis is locale-neutral and distinguishes fixed targets", () => {
  const nutrition = source("lib/nutrition.ts");
  const nutritionView = source("components/NutritionView.tsx");
  const messages = source("lib/i18n/messages/nutrition.ts");

  assert.match(nutrition, /"fixed_daily_target"/);
  assert.match(nutrition, /"bmr_deficit_plus_active_energy"/);
  assert.doesNotMatch(nutrition, /固定每日攝取目標|基礎攝取：/);
  assert.doesNotMatch(nutrition, /[\u4e00-\u9fff]/);
  assert.match(nutritionView, /data\.budget\.basis === "fixed_daily_target"/);
  assert.match(messages, /"nutrition\.view\.basis\.fixed"/);
  assert.match(messages, /"nutrition\.view\.basis\.formula"/);
  assert.doesNotMatch(messages, /"nutrition\.view\.basis\.summary"/);
});

test("nutrition target API, profile setup, UI, and MCP stay on one contract", () => {
  const route = source("app/api/nutrition/targets/route.ts");
  const profile = source("app/api/fitness/profile/route.ts");
  const dialog = source("components/profile/ProfileSettingsDialog.tsx");
  const mcp = source("agent-plugin/skills/open-fitness/scripts/fitness-mcp.mjs");

  assert.match(route, /export async function GET/);
  assert.match(route, /export async function POST/);
  assert.match(route, /actor: actor\.id/);
  assert.match(route, /entityType: "nutrition_target"/);
  assert.match(route, /findIdempotentReplay/);
  assert.match(route, /NUTRITION_TARGET_CONFLICT/);
  assert.match(route, /assertExpectedNutritionTarget/);
  assert.match(route, /cache-control", "no-store"/);
  assert.match(profile, /!current\.setupCompleted[\s\S]*nutritionTarget is required/);
  assert.match(profile, /db\.transaction[\s\S]*insert\(nutritionSettings\)/);
  assert.match(profile, /lte\(nutritionSettings\.effectiveFrom, effectiveDate\)/);
  assert.match(dialog, /const includeNutritionTarget =/);
  assert.match(dialog, /\.\.\.\(includeNutritionTarget/);
  assert.match(dialog, /nutritionTargetEffectiveFrom/);
  assert.match(mcp, /nutrition_targets:[\s\S]*\/api\/nutrition\/targets/);
  assert.match(mcp, /nutrition_calibration:[\s\S]*\/api\/nutrition\/calibration/);
  assert.match(
    mcp,
    /nutrition_target_set:\s*writeDescriptor\(\s*"POST",\s*"\/api\/nutrition\/targets"/,
  );
  assert.match(
    mcp,
    /nutrition_formula_calibrate:\s*writeDescriptor\(\s*"POST",\s*"\/api\/nutrition\/targets"/,
  );
});
