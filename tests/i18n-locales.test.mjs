import assert from "node:assert/strict";
import test from "node:test";

import {
  APP_LOCALES,
  DEFAULT_APP_LOCALE,
  FRESH_INSTALL_DEFAULT_APP_LOCALE,
  isAppLocale,
  localeFromAcceptLanguage,
  normaliseAppLocale,
  resolveAppLocale,
} from "../lib/i18n/locales.ts";
import { fitnessMessages } from "../lib/i18n/messages/fitness.ts";

test("the four app locales are stable and public fallback is English", () => {
  assert.deepEqual(APP_LOCALES, ["en", "zh-HK", "zh-TW", "zh-CN"]);
  assert.equal(FRESH_INSTALL_DEFAULT_APP_LOCALE, "en");
  assert.equal(DEFAULT_APP_LOCALE, "en");
  assert.equal(isAppLocale("zh-TW"), true);
  assert.equal(isAppLocale("zh"), false);
});

test("planned session modes use compact locale-specific badges", () => {
  assert.equal(fitnessMessages.en["fitness.intent.deload"], "Deload");
  assert.equal(fitnessMessages.en["fitness.intent.test"], "Test");
  assert.equal(fitnessMessages["zh-HK"]["fitness.intent.deload"], "減量課");
  assert.equal(fitnessMessages["zh-HK"]["fitness.intent.test"], "測試課");
  assert.equal(fitnessMessages["zh-TW"]["fitness.intent.deload"], "減量課");
  assert.equal(fitnessMessages["zh-TW"]["fitness.intent.test"], "測試課");
  assert.equal(fitnessMessages["zh-CN"]["fitness.intent.deload"], "减量课");
  assert.equal(fitnessMessages["zh-CN"]["fitness.intent.test"], "测试课");
});

test("standard PPL phase names localize without rewriting custom labels", () => {
  assert.equal(fitnessMessages.en["fitness.phase.lowerBody"], "Leg Day");
  assert.equal(fitnessMessages.en["fitness.phase.push"], "Push Day");
  assert.equal(fitnessMessages.en["fitness.phase.pull"], "Pull Day");
  assert.equal(fitnessMessages["zh-HK"]["fitness.phase.lowerBody"], "下肢訓練");
  assert.equal(fitnessMessages["zh-HK"]["fitness.phase.push"], "推力訓練");
  assert.equal(fitnessMessages["zh-HK"]["fitness.phase.pull"], "拉力訓練");
  assert.equal(fitnessMessages["zh-TW"]["fitness.phase.lowerBody"], "下肢訓練");
  assert.equal(fitnessMessages["zh-CN"]["fitness.phase.lowerBody"], "下肢训练");
});

test("locale normalization understands compatible browser language tags", () => {
  assert.equal(normaliseAppLocale("en-US"), "en");
  assert.equal(normaliseAppLocale("zh-Hant-TW"), "zh-TW");
  assert.equal(normaliseAppLocale("zh-Hans-SG"), "zh-CN");
  assert.equal(normaliseAppLocale("zh-MO"), "zh-HK");
  assert.equal(normaliseAppLocale("fr-FR"), null);
});

test("Accept-Language honours quality and excludes q=0", () => {
  assert.equal(
    localeFromAcceptLanguage("fr-FR, zh-TW;q=0.8, en-US;q=0.9"),
    "en",
  );
  assert.equal(localeFromAcceptLanguage("en;q=0, zh-CN;q=0.7"), "zh-CN");
  assert.equal(localeFromAcceptLanguage("fr-FR"), null);
});

test("locale resolution keeps device, profile, browser and fallback separate", () => {
  assert.equal(
    resolveAppLocale({
      cookieLocale: "en",
      profileLocale: "zh-TW",
      acceptLanguage: "zh-CN",
    }),
    "en",
  );
  assert.equal(
    resolveAppLocale({ profileLocale: "zh-TW", acceptLanguage: "en" }),
    "zh-TW",
  );
  assert.equal(resolveAppLocale({ acceptLanguage: "zh-CN" }), "zh-CN");
  assert.equal(resolveAppLocale({ acceptLanguage: "fr" }), "en");
});
