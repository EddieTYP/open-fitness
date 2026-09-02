import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { nutritionMessages } from "../lib/i18n/messages/nutrition.ts";
import { APP_LOCALES } from "../lib/i18n/locales.ts";

const root = path.resolve(import.meta.dirname, "..");
const nutritionComponents = [
  "components/NutritionView.tsx",
  "components/NutritionTrend.tsx",
  "components/nutrition/NutritionPlans.tsx",
  "components/nutrition/NutritionPreview.tsx",
  "components/nutrition/NutritionQuickRecord.tsx",
];

function source(file) {
  return readFileSync(path.join(root, file), "utf8");
}

test("nutrition catalog has the same keys in every supported locale", () => {
  const englishKeys = Object.keys(nutritionMessages.en).sort();

  for (const locale of APP_LOCALES) {
    assert.deepEqual(Object.keys(nutritionMessages[locale]).sort(), englishKeys);
  }
});

test("nutrition UI uses locale formatters and stable meal classification", () => {
  for (const file of nutritionComponents) {
    const component = source(file);
    assert.match(component, /useI18n\(/, `${file} must use the i18n context`);
    assert.doesNotMatch(component, /toLocaleString\(["']zh-HK["']/);
    assert.doesNotMatch(component, /new Intl\.(?:DateTime|Number)Format\(["']zh-HK["']/);
  }

  for (const file of [
    "components/NutritionView.tsx",
    "components/nutrition/NutritionPlans.tsx",
    "components/nutrition/NutritionQuickRecord.tsx",
  ]) {
    const component = source(file);
    assert.match(component, /contextTag:\s*isPostWorkout\s*\?\s*["']post_workout["']\s*:\s*null|contextTag:\s*["']post_workout["']/);
    assert.doesNotMatch(component, /originalMealType:\s*isPostWorkout/);
  }
});

test("nutrition UI does not render server error messages or localize user-authored text", () => {
  const view = source("components/NutritionView.tsx");
  const quick = source("components/nutrition/NutritionQuickRecord.tsx");
  const plans = source("components/nutrition/NutritionPlans.tsx");

  assert.doesNotMatch(view, /result\.error|data\?\.message|data\.message/);
  assert.doesNotMatch(quick, /issues\[0\]\?\.message/);
  assert.doesNotMatch(plans, /result\.error/);
  assert.doesNotMatch(
    [view, quick, plans].join("\n"),
    /translate(?:Food|Brand|Note|Assumption)|localize(?:Food|Brand|Note|Assumption)/i,
  );
});
