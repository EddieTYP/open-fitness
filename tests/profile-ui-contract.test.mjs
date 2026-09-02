import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { profileMessages } from "../lib/i18n/messages/profile.ts";
import { APP_LOCALES } from "../lib/i18n/locales.ts";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("profile settings are owner-editable without making the agent mandatory", async () => {
  const [dialog, profileMessages, messageIndex, app, page] = await Promise.all([
    source("components/profile/ProfileSettingsDialog.tsx"),
    source("lib/i18n/messages/profile.ts"),
    source("lib/i18n/messages/index.ts"),
    source("components/FitnessApp.tsx"),
    source("app/page.tsx"),
  ]);

  assert.match(dialog, /fetch\("\/api\/fitness\/profile"/);
  assert.match(dialog, /method: "PATCH"/);
  assert.match(dialog, /expectedUpdatedAt: profile\.updatedAt/);
  assert.match(dialog, /primaryGoal: draft\.primaryGoal\.trim\(\)/);
  assert.match(dialog, /value=\{draft\.primaryGoal\}/);
  assert.match(dialog, /trainingCycleConfig/);
  assert.match(dialog, /currentTrainingBlock/);
  assert.match(dialog, /profile\.block\.current/);
  assert.match(dialog, /loadIncrementKg/);
  assert.match(dialog, /profile\.routine\.loadIncrement/);
  assert.match(dialog, /id: newPhaseId\(\),[\s\S]*?kind/);
  assert.match(dialog, /timezone: draft\.timezone\.trim\(\)/);
  assert.match(dialog, /useI18n\(\)/);
  assert.match(dialog, /validateDraft\(draft, t, includeNutritionTarget\)/);
  assert.match(dialog, /preferredLocale: draft\.preferredLocale/);
  assert.match(dialog, /nutritionTargetChanged/);
  assert.match(dialog, /nutritionTarget: \{/);
  assert.match(dialog, /calorieTargetKcal: Number\(draft\.calorieTargetKcal\)/);
  assert.match(dialog, /proteinTargetG: Number\(draft\.proteinTargetG\)/);
  assert.match(dialog, /effectiveDate/);
  assert.match(dialog, /value=\{draft\.preferredLocale\}/);
  assert.match(dialog, /APP_LOCALES\.map\(\(locale\)/);
  assert.match(dialog, /APP_LOCALE_LABELS\[locale\]/);
  assert.match(
    dialog,
    /const localeChanged = draft\.preferredLocale !== profile\.preferredLocale/,
  );
  assert.match(
    dialog,
    /if \(localeChanged\) \{[\s\S]*?persistDeviceLocale\(result\.profile\.preferredLocale\);[\s\S]*?window\.location\.reload\(\);[\s\S]*?return;/,
  );
  assert.equal(dialog.match(/window\.location\.reload\(\)/g)?.length, 1);
  assert.doesNotMatch(dialog, /result\.(?:message|error)/);
  assert.doesNotMatch(dialog, /[\p{Script=Han}]/u);
  assert.match(profileMessages, /defineMessageSet\(\{/);
  assert.match(profileMessages, /"profile\.field\.locale": "Language"/);
  assert.match(profileMessages, /"zh-HK": \{/);
  assert.match(profileMessages, /"zh-TW": \{/);
  assert.match(profileMessages, /"zh-CN": \{/);
  assert.match(messageIndex, /import \{ profileMessages \}/);
  assert.match(
    messageIndex,
    /messagesForLocale\([\s\S]*?commonMessages[\s\S]*?profileMessages[\s\S]*?\)/,
  );
  assert.match(dialog, /querySelectorAll<HTMLElement>/);
  assert.match(app, /<ProfileSettingsDialog/);
  assert.match(app, /dashboard\.profile\?\.displayName \|\| displayName/);
  assert.match(page, /data\.profile\?\.displayName\?\.trim\(\)/);
});

test("profile settings show the four-locale training safety boundary", async () => {
  const [dialog, styles] = await Promise.all([
    source("components/profile/ProfileSettingsDialog.tsx"),
    source("components/profile/ProfileSettingsDialog.module.css"),
  ]);

  assert.match(dialog, /className=\{styles\.safetyNote\}/);
  assert.match(dialog, /aria-labelledby="profile-safety-heading"/);
  assert.match(dialog, /t\("profile\.safety\.title"\)/);
  assert.match(dialog, /t\("profile\.safety\.body"\)/);
  assert.match(styles, /\.safetyNote\s*\{[\s\S]*font-size: 12px/);
  assert.match(dialog, /const PROJECT_SOURCE_REF = "v0\.1\.0"/);
  assert.match(dialog, /open-fitness\/tree\/\$\{PROJECT_SOURCE_REF\}/);
  assert.match(dialog, /open-fitness\/blob\/\$\{PROJECT_SOURCE_REF\}\/LICENSE/);
  assert.doesNotMatch(dialog, /blob\/main\/LICENSE/);

  for (const locale of APP_LOCALES) {
    assert.ok(profileMessages[locale]["profile.safety.title"].trim());
    assert.ok(profileMessages[locale]["profile.safety.body"].trim());
  }

  assert.match(
    profileMessages.en["profile.safety.body"],
    /not medical care[\s\S]*severe or worsening pain[\s\S]*chest pain[\s\S]*trouble breathing[\s\S]*fainting/i,
  );
  for (const locale of ["zh-HK", "zh-TW", "zh-CN"]) {
    assert.match(profileMessages[locale]["profile.safety.body"], /胸痛/);
    assert.match(
      profileMessages[locale]["profile.safety.body"],
      /呼吸困難|呼吸困难/,
    );
  }
});

test("manual log survives hard reload and visible copy is source-neutral", async () => {
  const [app, page, nutrition] = await Promise.all([
    source("components/FitnessApp.tsx"),
    source("app/page.tsx"),
    source("lib/nutrition.ts"),
  ]);

  assert.match(page, /type InitialTab = "today" \| "log"/);
  assert.match(page, /tabValue === "log"/);
  assert.doesNotMatch(app, /Health Agent|TANITA/);
  assert.doesNotMatch(nutrition, /TANITA BMR|Apple Watch Active Energy/);
});
