import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  canonicalExerciseIdentity,
  exerciseMessageKey,
  exerciseText,
} from "../lib/exercise-display.ts";
import { createTranslator } from "../lib/i18n/catalog.ts";
import { getMessages } from "../lib/i18n/messages/index.ts";
import { exerciseMessages } from "../lib/i18n/messages/exercises.ts";
import { APP_LOCALES } from "../lib/i18n/locales.ts";
import { renderUiText } from "../lib/i18n/ui-text.ts";

test("known exercise names resolve in every supported locale", () => {
  const value = exerciseText("Machine Seated Chest Press");
  assert.equal(renderUiText(value, createTranslator(getMessages("zh-HK")), String), "機械坐姿胸推");
  assert.equal(renderUiText(value, createTranslator(getMessages("zh-TW")), String), "機械坐姿胸推");
  assert.equal(renderUiText(value, createTranslator(getMessages("zh-CN")), String), "器械坐姿胸推");
  assert.equal(renderUiText(value, createTranslator(getMessages("en")), String), "Machine Seated Chest Press");
  assert.equal(
    exerciseMessageKey("  MACHINE SEATED CHEST PRESS  "),
    "exercise.name.machineSeatedChestPress",
  );

  const englishKeys = Object.keys(exerciseMessages.en).sort();
  for (const locale of APP_LOCALES) {
    assert.deepEqual(Object.keys(exerciseMessages[locale]).sort(), englishKeys);
  }
  for (const locale of APP_LOCALES) {
    for (const [key, label] of Object.entries(exerciseMessages[locale])) {
      assert.equal(exerciseMessageKey(label), key, `${locale}: ${label}`);
    }
  }
});

test("known exercises use structured locale text while custom names stay verbatim", () => {
  assert.deepEqual(exerciseText("Barbell Back Squat"), {
    kind: "message",
    key: "exercise.name.barbellBackSquat",
  });
  assert.deepEqual(exerciseText("我的復健動作"), {
    kind: "source",
    text: "我的復健動作",
  });
});

test("known exercise identity is stable across supported languages and curated aliases", () => {
  const benchIdentity = canonicalExerciseIdentity("Barbell Bench Press");
  assert.equal(canonicalExerciseIdentity("槓鈴臥推"), benchIdentity);
  assert.equal(canonicalExerciseIdentity("杠铃卧推"), benchIdentity);

  const flyIdentity = canonicalExerciseIdentity("Machine Fly (Pec Dec)");
  assert.equal(canonicalExerciseIdentity("器械飛鳥（胸飛鳥）"), flyIdentity);

  const tricepsIdentity = canonicalExerciseIdentity(
    "Cable Rope Tricep Pushdown / Extension",
  );
  assert.equal(canonicalExerciseIdentity("滑輪繩索三頭下壓"), tricepsIdentity);

  assert.notEqual(
    canonicalExerciseIdentity("我的復健動作 A"),
    canonicalExerciseIdentity("我的復健動作 B"),
  );
});

test("nested exercise text localizes inside a larger translated sentence", () => {
  const value = {
    kind: "message",
    key: "summary",
    params: { exercise: exerciseText("Dumbbell Lateral Raise") },
  };
  assert.equal(
    renderUiText(
      value,
      (key, values) =>
        key === "summary"
          ? `動作：${values.exercise}`
          : createTranslator(exerciseMessages["zh-HK"])(key, values),
      String,
    ),
    "動作：啞鈴側平舉",
  );
});

test("exercise selection keeps canonical values and localizes only presentation", async () => {
  const app = await readFile(
    new URL("../components/FitnessApp.tsx", import.meta.url),
    "utf8",
  );

  assert.match(app, /const exercise = exactCandidate\?\.exercise \?\? query\.trim\(\)/);
  assert.match(app, /setQuery\(candidate\.display\)/);
  assert.match(app, /setSelectedExercise\(candidate\.exercise\)/);
  assert.match(app, /params\.set\("phaseId", item\.phaseId\)/);
  assert.match(app, /params\.set\("slotId", item\.slotId\)/);
  assert.match(app, /candidate\.relevance !== "other"/);
  assert.match(
    app,
    /display: renderUiText\([\s\S]*exerciseText\(candidate\.exercise\)/,
  );
  assert.match(
    app,
    /body: JSON\.stringify\(\{[\s\S]*exercise,[\s\S]*scope: "date",[\s\S]*date: plan\.planningDate/,
  );
  const fitness = await readFile(
    new URL("../lib/fitness.ts", import.meta.url),
    "utf8",
  );
  assert.match(fitness, /canonicalExerciseIdentity\(candidate\) === target/);
  assert.match(fitness, /const key = canonicalExerciseIdentity\(row\.exercise\)/);
  assert.match(fitness, /progressExerciseIdentities[\s\S]*canonicalExerciseIdentity/);
  assert.match(fitness, /exercise: exerciseText\(exercise\),[\s\S]*exerciseKey: exercise,/);
});

test("narrow analysis matches exercise identities across languages", async () => {
  const route = await readFile(
    new URL("../app/api/fitness/analysis/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(route, /canonicalExerciseIdentity/);
  assert.match(
    route,
    /const exerciseIdentity = exercise\s*\?\s*canonicalExerciseIdentity\(exercise\)\s*:\s*null/,
  );
  assert.match(
    route,
    /canonicalExerciseIdentity\(set\.exercise\) === exerciseIdentity/,
  );
  assert.doesNotMatch(route, /set\.exercise === exercise/);
});
