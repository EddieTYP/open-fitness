import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createTranslator } from "../lib/i18n/catalog.ts";
import { fitnessMessages } from "../lib/i18n/messages/fitness.ts";
import { APP_LOCALES } from "../lib/i18n/locales.ts";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("fitness shell catalog has matching keys in every supported locale", () => {
  const englishKeys = Object.keys(fitnessMessages.en).sort();

  for (const locale of APP_LOCALES) {
    assert.deepEqual(Object.keys(fitnessMessages[locale]).sort(), englishKeys);
    for (const key of englishKeys) {
      const placeholders = (value) =>
        [...value.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)]
          .map((match) => match[1])
          .sort();
      assert.deepEqual(
        placeholders(fitnessMessages[locale][key]),
        placeholders(fitnessMessages.en[key]),
        `${locale}:${key} must preserve interpolation parameters`,
      );
    }
  }

  assert.equal(
    createTranslator(fitnessMessages.en)("fitness.greeting.named", {
      greeting: "Hello",
      name: "Sam",
    }),
    "Hello, Sam",
  );
  assert.equal(
    createTranslator(fitnessMessages["zh-CN"])("fitness.nav.nutrition"),
    "饮食",
  );
  assert.equal(
    createTranslator(fitnessMessages["zh-TW"])("fitness.schedule.pause"),
    "暫停",
  );
  assert.equal(
    createTranslator(fitnessMessages.en)("fitness.course.subtitle"),
    "Open an exercise for details",
  );
  assert.equal(
    createTranslator(fitnessMessages["zh-HK"])("fitness.course.subtitle"),
    "展開動作睇詳情",
  );
  assert.equal(
    createTranslator(fitnessMessages["zh-TW"])("fitness.course.subtitle"),
    "展開動作查看詳情",
  );
  assert.equal(
    createTranslator(fitnessMessages["zh-CN"])("fitness.course.subtitle"),
    "展开动作查看详情",
  );
  assert.equal(
    createTranslator(fitnessMessages.en)("fitness.course.attention"),
    "Attention:",
  );
  assert.equal(
    createTranslator(fitnessMessages["zh-HK"])("fitness.course.attention"),
    "注意：",
  );
  assert.equal(
    createTranslator(fitnessMessages["zh-TW"])("fitness.course.attention"),
    "注意事項：",
  );
  assert.equal(
    createTranslator(fitnessMessages["zh-CN"])("fitness.course.attention"),
    "注意：",
  );
});

test("every dashboard presentation key exists in the fitness catalog", async () => {
  const english = fitnessMessages.en;
  const files = await Promise.all([
    source("lib/fitness.ts"),
    source("components/FitnessApp.tsx"),
  ]);
  const referenced = new Set(
    files.flatMap((contents) =>
      [...contents.matchAll(/["'](fitness\.[A-Za-z0-9_.]+)["']/g)].map(
        (match) => match[1],
      ),
    ),
  );
  const missing = [...referenced].filter((key) => !Object.hasOwn(english, key));

  assert.deepEqual(missing, []);
});

test("fitness shell resolves structured copy while preserving source-authored content", async () => {
  const [app, schedule, fitness, uiText] = await Promise.all([
    source("components/FitnessApp.tsx"),
    source("components/TrainingScheduleControls.tsx"),
    source("lib/fitness.ts"),
    source("lib/i18n/ui-text.ts"),
  ]);

  assert.match(app, /useI18n\(\)/);
  assert.match(schedule, /useI18n\(\)/);
  assert.match(app, /fitness\.nav\.today/);
  assert.match(app, /fitness\.today\.briefingAria/);
  assert.match(app, /fitness\.progress\.insights/);
  assert.match(schedule, /fitness\.schedule\.pausePlan/);
  assert.doesNotMatch(app, /DateTimeFormat\("zh-HK"/);
  assert.doesNotMatch(app, /toLocale(?:Date|Time)?String\("zh-HK"/);

  assert.match(app, /renderUiText/);
  assert.match(uiText, /function renderUiText/);
  assert.match(uiText, /value\.kind === "source"/);
  assert.match(uiText, /translate\(value\.key, params\)/);
  assert.match(app, /coursePhaseMessageKeys\[item\.phase\]/);
  assert.match(app, /reviewSectionMessageKeys\[section\.title\]/);
  assert.match(fitness, /exercise: exerciseText\(selection\.exercise\)/);
  assert.match(fitness, /sourceText\(latestRecovery\.note\)/);
  assert.match(fitness, /rule: operatingRule/);
  assert.doesNotMatch(fitness, /phase: "熱身"/);
  assert.doesNotMatch(fitness, /phase: "主課"/);
  assert.doesNotMatch(app, /\{dashboard\.message\}/);
  assert.match(app, /fitness\.state\.awaitingFirstRecord/);
  assert.match(app, /fitness\.error\.databaseUnavailable/);
  assert.match(app, /:\s*plan\.phaseLabel/);
});
