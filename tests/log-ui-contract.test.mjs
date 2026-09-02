import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createTranslator } from "../lib/i18n/catalog.ts";
import { APP_LOCALES } from "../lib/i18n/locales.ts";
import { logMessages } from "../lib/i18n/messages/log.ts";
import { workoutTypeText } from "../lib/i18n/workout-type.ts";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("daily log is authenticated, date-bounded and newest-first", async () => {
  const route = await source("app/api/fitness/log/route.ts");

  assert.match(route, /getApiActor\(request\)/);
  assert.match(route, /INVALID_LOG_DATE/);
  assert.match(route, /MAX_RECORDS_PER_KIND = 80/);
  assert.match(route, /eq\(workoutSessions\.localDate, date\)/);
  assert.match(route, /eq\(bodyMeasurements\.localDate, date\)/);
  assert.doesNotMatch(route, /substr\(\$\{bodyMeasurements\.measuredAt\}/);
  assert.match(route, /eq\(sessionNotes\.noteType, "Recovery status"\)/);
  assert.match(route, /eq\(nutritionMeals\.localDate, date\)/);
  assert.match(route, /desc\(workoutSessions\.startedAt\)/);
  assert.match(route, /desc\(bodyMeasurements\.measuredAt\)/);
  assert.match(route, /desc\(sessionNotes\.createdAt\)/);
  assert.match(route, /desc\(nutritionMeals\.eatenAt\)/);
  assert.match(route, /cache-control.*no-store/s);
});

test("daily log keeps source text opaque and returns generated copy as descriptors", async () => {
  const [route, view, uiText] = await Promise.all([
    source("app/api/fitness/log/route.ts"),
    source("components/LogView.tsx"),
    source("lib/i18n/ui-text.ts"),
  ]);

  assert.match(route, /title: UiText/);
  assert.match(route, /summary: UiText \| null/);
  assert.match(route, /metrics: UiText\[\]/);
  assert.match(route, /effectiveWorkoutRecords/);
  assert.match(route, /title: sourceText\(workout\.sessionTitle\)/);
  assert.match(route, /intent: workoutSessions\.sessionIntent/);
  assert.match(route, /intent: workout\.intent/);
  assert.match(route, /notes\s*\? sourceText\(notes\)/);
  assert.match(route, /type\s*\? workoutTypeText\(type\)/);
  assert.match(route, /sourceText\(area\)/);
  assert.match(route, /sourceText\(originalText\)/);
  assert.match(route, /notes \? sourceText\(notes\) : null/);
  assert.match(route, /const mealTypeMessageKeys/);
  assert.match(route, /messageText\("log\.record\.duration"/);
  assert.match(route, /messageText\("log\.record\.sets"/);
  assert.match(route, /messageText\("log\.record\.body\.title"\)/);
  assert.match(route, /messageText\("log\.record\.recovery\.pain"/);
  assert.doesNotMatch(
    route,
    /分鐘|身體量度|脂肪|肌肉|恢復記錄|不適|早餐|午餐|晚餐|小食|宵夜|餐點|蛋白質/,
  );

  assert.match(view, /renderUiText/);
  assert.match(uiText, /function renderUiText\(/);
  assert.match(uiText, /value\.kind === "source"/);
  assert.match(uiText, /typeof param === "number"/);
  assert.match(uiText, /renderUiText\(param, translate, formatNumber\)/);
  assert.match(view, /renderUiText\(record\.title, t, formatNumber\)/);
  assert.match(view, /renderUiText\(record\.summary, t, formatNumber\)/);
  assert.match(view, /renderUiText\(item, t, formatNumber\)/);
});

test("daily log localizes only canonical workout types", () => {
  assert.deepEqual(workoutTypeText("Strength"), {
    kind: "message",
    key: "log.form.workout.typeStrength",
  });
  assert.deepEqual(workoutTypeText("Cardio"), {
    kind: "message",
    key: "log.form.workout.typeCardio",
  });
  assert.deepEqual(workoutTypeText("Cardio - Walk"), {
    kind: "message",
    key: "log.record.workoutType.walking",
  });
  assert.deepEqual(workoutTypeText("Cardio - Walking"), {
    kind: "message",
    key: "log.record.workoutType.walking",
  });
  assert.deepEqual(workoutTypeText("Cardio - Stair"), {
    kind: "message",
    key: "log.record.workoutType.stairs",
  });
  assert.deepEqual(workoutTypeText("Synthetic custom conditioning"), {
    kind: "source",
    text: "Synthetic custom conditioning",
  });
});

test("active daily log refreshes external writes without accepting stale responses", async () => {
  const view = await source("components/LogView.tsx");

  assert.match(view, /if \(!active\) return;/);
  assert.match(view, /window\.setInterval\(\(\) => void refreshIfVisible\(\), 10_000\)/);
  assert.match(view, /addEventListener\("focus", refreshIfVisible\)/);
  assert.match(view, /addEventListener\("pageshow", refreshIfVisible\)/);
  assert.match(view, /addEventListener\("visibilitychange", refreshIfVisible\)/);
  assert.match(view, /if \(sequence !== requestSequence\.current\) return;/);
  assert.match(view, /requestSequence\.current \+= 1/);
});

test("daily log descriptor messages have locale and placeholder parity", () => {
  const englishKeys = Object.keys(logMessages.en).sort();
  const placeholders = (value) =>
    [...value.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)]
      .map((match) => match[1])
      .sort();

  for (const locale of APP_LOCALES) {
    assert.deepEqual(Object.keys(logMessages[locale]).sort(), englishKeys);
    for (const key of englishKeys) {
      assert.deepEqual(
        placeholders(logMessages[locale][key]),
        placeholders(logMessages.en[key]),
        `${locale}:${key} must preserve interpolation parameters`,
      );
    }
  }

  assert.equal(
    createTranslator(logMessages.en)("log.record.duration", { value: "1,234" }),
    "1,234 min",
  );
});

test("manual record sheets write all four supported record types safely", async () => {
  const [forms, view, quickRecord, app, styles] = await Promise.all([
    source("components/log/LogForms.tsx"),
    source("components/LogView.tsx"),
    source("components/nutrition/NutritionQuickRecord.tsx"),
    source("components/FitnessApp.tsx"),
    source("app/globals.css"),
  ]);

  assert.match(forms, /"x-idempotency-key": idempotencyKey/);
  assert.match(forms, /\/api\/fitness\/workout-sessions/);
  assert.match(forms, /sets: \[\]/);
  assert.match(forms, /sessionIntent: requiredText\(form, "sessionIntent"\)/);
  assert.match(forms, /<option value="normal">/);
  assert.match(forms, /<option value="deload">/);
  assert.match(forms, /<option value="test">/);
  assert.match(forms, /trainingPhaseId: optionalText\(form, "trainingPhaseId"\)/);
  assert.match(forms, /phase\.kind === "training"/);
  assert.match(forms, /nextPhase\?\.kind === "training"/);
  assert.match(forms, /<option value="">\{t\("log\.form\.workout\.noCycle"\)\}<\/option>/);
  assert.match(forms, /\/api\/fitness\/body-measurements/);
  assert.match(forms, /sourceDevice: "Manual entry"/);
  assert.match(forms, /const measurementId = useRef\(/);
  assert.match(forms, /measurementId: measurementId\.current/);
  assert.doesNotMatch(forms, /measurementId: `MANUAL\|\$\{measuredAt\}\|\$\{crypto\.randomUUID\(\)\}`/);
  assert.match(forms, /\/api\/fitness\/session-notes/);
  assert.match(forms, /noteType: "Recovery status"/);
  assert.match(forms, /\/api\/nutrition\/meals/);
  assert.match(forms, /source: "site_manual"/);
  assert.match(view, /role="dialog"/);
  assert.match(view, /aria-modal="true"/);
  assert.match(view, /window\.confirm\(t\("log\.discard"\)\)/);
  assert.match(view, /querySelectorAll<HTMLElement>/);
  assert.match(view, /restoreTriggerFocus/);
  assert.match(view, /cycle=\{cycle\}/);
  assert.match(view, /nextPhase=\{nextPhase\}/);
  assert.match(view, /record\.intent !== undefined && record\.intent !== "normal"/);
  assert.match(view, /log\.record\.intent\./);
  assert.match(view, /kind\.id !== "meal"/);
  assert.match(quickRecord, /<MealLogForm/);
  assert.match(quickRecord, /nutrition\.quick\.title\.manual/);
  assert.match(app, /labelKey: "fitness\.nav\.log", icon: NotePencil/);
  assert.match(app, /<LogView/);
  assert.match(app, /cycle=\{dashboard\.trainingSchedule\.cycle\}/);
  assert.match(app, /nextPhase=\{dashboard\.trainingSchedule\.nextPhase\}/);
  assert.match(
    styles,
    /\.log-record-metrics span \{[\s\S]*?max-width: 100%[\s\S]*?overflow-wrap: anywhere/,
  );
});
